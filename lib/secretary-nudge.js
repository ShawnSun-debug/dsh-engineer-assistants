/**
 * 催办草稿（秘书 spec 票 08）。
 *
 * 卡点出现时，秘书不直接发消息，而是先攒一条草稿：正文由固定模板生成、不调模型，
 * 状态只有 pending / sent / discarded 三种，只有用户确认（confirmDraft）并且真正投递
 * 成功之后才允许离开 pending。这个模块只负责草稿本身——存哪、怎么去重、正文怎么写、
 * 什么样的卡点值得催；投递语义在 lib/secretary-deliver.js，宿主接线在 lib/index.js。
 *
 * 三个不变式：
 *
 * 1. **草稿不是消息。** 生成草稿只写内存，一次都不碰 agents / sessions / messaging；
 *    投递只发生在确认那一刻，失败就把原因交回调用方，草稿保持 pending。
 * 2. **去重按「同会话 + 同原因」的 pending 草稿。** 视图每十秒重读一次，同一个卡点
 *    不能被读成十条草稿；已经 sent / discarded 的不挡新草稿，因为那是一段新卡点。
 * 3. **正文有上限。** 一条催办不超过 {@link DRAFT_MAX_CHARS} 字；超了按字截断加省略号，
 *    不把一整段错误原样糊进去。
 *
 * 纯逻辑：不调模型、不读时钟（时间由调用方以 now 传入）、不认识宿主。
 *
 * @module
 */

import { WORKER_STATE } from './master-state.js'
import { DRAFT_STATUSES } from './secretary-constants.js'

/** 草稿的三种状态（名单真源在 secretary-constants.js），顺序即生命周期。 */
export { DRAFT_STATUSES }

/** 一条催办正文的上限（字，不是字节）。 */
export const DRAFT_MAX_CHARS = 300

/** 会生成草稿的三类卡点。 */
export const DRAFT_REASONS = Object.freeze(['needs-input', 'error', 'conflict'])

/** 拿一个值当对象用；数组、null、标量都退化成空对象。 */
function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 正文原样保留换行，只做长度与空值处理。 */
function rawTextOf(value) {
  return typeof value === 'string' ? value : ''
}

function numberOf(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** 按字截断：上限含省略号本身。 */
function clampText(text) {
  const chars = [...text]
  if (chars.length <= DRAFT_MAX_CHARS) return text
  return chars.slice(0, DRAFT_MAX_CHARS - 1).join('') + '…'
}

/** 压成一行：错误摘要进模板前不能把段落撑破。 */
function oneLine(value) {
  return rawTextOf(value).replace(/\s+/g, ' ').trim()
}

/**
 * 固定模板的催办正文：说明卡在哪 + 建议用户确认什么。
 *
 * 认不出的 reason 也仍然给一句话，不抛错——模板措辞可以改，payload 的字段名不行。
 */
export function nudgeTextOf(input = {}) {
  const source = asObject(input)
  const title = textOf(source.title) || textOf(source.sessionId) || '未命名会话'
  const reason = textOf(source.reason)
  const detail = oneLine(source.detail)
  if (reason === 'needs-input') {
    return clampText(
      `秘书催办：会话「${title}」正在等你确认。\n请打开该会话，确认下一步或补上缺的信息，再回到秘书视图点「确认发送」；这条消息会发给 Master 会话。`,
    )
  }
  if (reason === 'error') {
    return clampText(
      `秘书催办：会话「${title}」运行出错${detail === '' ? '' : '（' + detail + '）'}。\n请先看这条错误，确认是重试、改需求还是收尾，再回到秘书视图点「确认发送」。`,
    )
  }
  if (reason === 'conflict') {
    return clampText(
      `秘书催办：会话「${title}」同时登记为 Master 和跟踪对象，登记表已忽略后者。\n请到设置页把它从跟踪名单移除，或换一个 Master，再点「确认发送」。`,
    )
  }
  return clampText(`秘书催办：会话「${title}」需要你看一下。\n请确认下一步，再点「确认发送」。`)
}

/** 草稿 id：会话 + 原因 + 创建时刻，同一毫秒内重复时补序号，永远可稳定复现。 */
function draftIdOf(sessionId, reason, createdAt, used) {
  const base = `draft-${sessionId}-${reason}-${createdAt}`
  if (!used(base)) return base
  let index = 1
  while (used(`${base}-${index}`)) index += 1
  return `${base}-${index}`
}

/**
 * 插件实例内存里的草稿表。
 *
 * add 只落内存并做去重；decide 只允许 pending 迁移一次。迁移被拒（草稿已经不在
 * pending）时，如果调用方给了 `warn`，就记一条 warn：投递已经发生、状态却没记下来，
 * 这是调用方必须知道的不一致，不能悄悄当成功。
 *
 * 返回的草稿对象就是表里那一个，调用方不要改字段，要用就用 composeDraft 复制一份。
 *
 * @param options - 可选 `{ warn }`；warn 是日志函数，缺省时迁移失败只在返回值上体现。
 */
export function createDraftStore(options = {}) {
  const owner = asObject(options)
  const warn = typeof owner.warn === 'function' ? owner.warn : null
  const complain = (message) => {
    if (warn === null) return
    try {
      warn(message)
    } catch {
      // 记日志失败不能反过来改变草稿的状态迁移结果。
    }
  }
  const drafts = new Map()
  return {
    /** 同会话 + 同原因的 pending 草稿存在就复用它，否则新建一条 pending 草稿。 */
    add(input = {}) {
      const source = asObject(input)
      const sessionId = textOf(source.sessionId)
      const reason = textOf(source.reason)
      if (sessionId === '' || reason === '') return undefined
      for (const draft of drafts.values()) {
        if (draft.status === 'pending' && draft.sessionId === sessionId && draft.reason === reason) return draft
      }
      const createdAt = numberOf(source.createdAt) ?? Date.now()
      const text = clampText(rawTextOf(source.text))
      if (text === '') return undefined
      const id = draftIdOf(sessionId, reason, createdAt, (candidate) => drafts.has(candidate))
      const draft = { id, sessionId, reason, text, status: 'pending', createdAt, sentAt: null }
      drafts.set(id, draft)
      return draft
    },
    /** 全部草稿（含已决），顺序是插入顺序；视图自己按 createdAt 排。 */
    list() {
      return [...drafts.values()]
    },
    get(id) {
      return typeof id === 'string' && id !== '' ? drafts.get(id) : undefined
    },
    /** 只有 pending 能迁移；sent 才记 sentAt。已决的草稿再 decide 返回 undefined，并留一条 warn。 */
    decide(id, status, at) {
      const draft = this.get(id)
      if (draft === undefined) return undefined
      if (draft.status !== 'pending' || !DRAFT_STATUSES.includes(status)) {
        complain(`orchestrator: secretary: draft ${id} is ${draft.status}; the ${status} transition was not recorded`)
        return undefined
      }
      if (status === 'pending') return draft
      draft.status = status
      if (status === 'sent') draft.sentAt = numberOf(at) ?? Date.now()
      return draft
    },
  }
}

/**
 * 把这一拍看到的卡点变成草稿，返回这次涉及的草稿（新生成的和复用的）。
 *
 * 触发条件就是票面两种：被跟踪会话处于 Needs input，或 registry.conflict 非空。一个会话
 * 可能同时命中两种原因，那是两条不同的草稿——催的内容不一样。
 */
export function applyDraftTriggers(input = {}) {
  const source = asObject(input)
  const store = source.store
  if (store === undefined || store === null || typeof store.add !== 'function') return []
  const now = numberOf(source.now) ?? Date.now()
  const touched = []
  const add = (sessionId, reason, title, detail) => {
    const draft = store.add({ sessionId, reason, text: nudgeTextOf({ title, reason, detail }), createdAt: now })
    if (draft !== undefined) touched.push(draft)
    return draft
  }

  for (const raw of Array.isArray(source.orchestrators) ? source.orchestrators : []) {
    const row = asObject(raw)
    const sessionId = textOf(row.sessionId)
    if (sessionId === '') continue
    const title = textOf(row.title) || sessionId
    if (row.state === WORKER_STATE.needsInput) add(sessionId, 'needs-input', title, '')
  }

  const conflict = asObject(source.conflict)
  const conflicting = Array.isArray(conflict.conflictingOrchestratorIds)
    ? textOf(conflict.conflictingOrchestratorIds[0])
    : ''
  const blocked = conflicting || textOf(conflict.masterSessionId)
  if (blocked !== '') add(blocked, 'conflict', blocked, '')

  return touched
}
