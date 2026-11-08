/**
 * 面板表面（engineer-assistants 1.0.0 票 12）。
 *
 * 一句话：把面板模型与宿主事实翻成界面真要的那几样——红点数字、切进某个 worker 的导航目标、
 * 主对话里那张危险确认卡。
 *
 * 五条规矩：
 *
 * - **只算，不画。** 不 import React、不碰 ctx、不读时钟。输出是纯数据，宿主接入留在 client 侧。
 *   时间由调用方给（`now`），否则这里就没法测。
 * - **只出事实，不出口播。** 卡片不带中文文案——文案是 client 的多语言表的事。
 * - **红点的词表跟着监工走。** 卡点原因直接复用 `inspector.js` 的 `STUCK_REASONS`，不另定一套：
 *   自己造一套的结果是监工说 `waiting-approval`、这里认 `awaiting-approval`，红点永远不亮，
 *   而且不会报错。
 * - **确认卡的键只有一个来源。** 去重直接用 `danger.js` 的 `dangerKey`——另算一遍，
 *   「同一件事」就会跟闸门的判定分叉。
 * - **不给错的输入编一个看起来对的答案。** 时间不是有限数就抛，解析不出来就退，空确认就不出卡。
 *
 * @module
 */

import { dangerKey } from './danger.js'
import { STUCK_REASONS } from './inspector.js'

/**
 * 需要用户介入的原因——就是监工的三种卡点判据。
 *
 * 与 `STUCK_REASONS` 是同一份（spec 第 7 节：监工的提醒通道之一就是右栏页签红点），
 * 所以这里直接引用而不是抄一份。
 */
export const ATTENTION_REASONS = STUCK_REASONS

function readText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 面板模型的形状检查：没有 workers 数组就不是面板模型。 */
function requireModel(model, fn) {
  if (model === null || typeof model !== 'object' || !Array.isArray(model.workers)) {
    throw new TypeError(`${fn}: a panel model is required`)
  }
}

/**
 * 红点：列表里需要人介入的 worker 数。
 *
 * `attention` 形如 `{ [sessionId]: ['idle', 'retrying', 'waiting-approval'] }`，由巡检与
 * 申请派发两处各自填。未知原因忽略、重复原因去重、同一个 id 出现多行只算一次、不在列表里的
 * id 不算（它已经结束了，红点不该为它亮）。
 */
export function badgeOf({ model, attention = {} } = {}) {
  requireModel(model, 'badgeOf')
  if (attention === null || typeof attention !== 'object') {
    throw new TypeError('badgeOf: attention must be an object')
  }

  const reasons = new Map()
  for (const [rawId, list] of Object.entries(attention)) {
    const id = readText(rawId)
    if (id === '') continue
    const kept = (Array.isArray(list) ? list : []).filter((reason) => ATTENTION_REASONS.includes(reason))
    if (kept.length > 0) reasons.set(id, [...new Set(kept)])
  }

  const seen = new Set()
  const sessionIds = []
  for (const row of model.workers) {
    if (row === null || typeof row !== 'object') continue
    const id = readText(row.sessionId)
    if (id === '' || seen.has(id) || !reasons.has(id)) continue
    seen.add(id)
    sessionIds.push(id)
  }

  const byReason = {}
  for (const reason of ATTENTION_REASONS) {
    byReason[reason] = sessionIds.filter((id) => reasons.get(id).includes(reason)).length
  }
  return { count: sessionIds.length, sessionIds, byReason }
}

/**
 * 一个值是不是真能当 subagent 地址用。
 *
 * 按宿主 `SubagentAddress` 的**完整形状**判：`{ parentSessionId, childSessionId, mode }`，
 * 前两个是非空字符串、`mode` 是非空字符串（具体认哪几种由用它的地方各自判）。
 *
 * 两处用它的地方必须用同一把尺子——否则会出现「能导航但拼不出地址」或反过来。也不能按真值
 * 判：`{}` 和 `[]` 都是 truthy，靠真值会把它们当地址交出去。
 */
function usableAddress(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return readText(value.parentSessionId) !== '' && readText(value.childSessionId) !== '' && readText(value.mode) !== ''
}

/**
 * 「切进 worker 说话」的导航目标。
 *
 * 返回的是**信封** `{ kind, target }`：真正交给 `uiWorkspace.openSession` 的是 `target`，
 * 它的类型是宿主的 `SessionTarget = SessionId | SubagentAddress`——**裸会话 id 本身就是
 * 合法目标**。优先用 subagent 地址，是因为地址在会话重建后仍然指向同一条子代理，
 * 但宿主只解析「已经被发现」的地址，解析不到就退 id，不是 id 不能用。
 *
 * `addressOf` 由调用方注入（宿主是 `ctx.sessions.subagentAddress`）；它抛错时退回 id：
 * 一个坏掉的 sessions 域不该让 worker 点不动。
 */
export function navigationTargetOf({ sessionId, addressOf } = {}) {
  const id = readText(sessionId)
  if (id === '') throw new TypeError('navigationTargetOf: a session id is required')
  if (typeof addressOf !== 'function') return { kind: 'session', target: id }

  let address
  try {
    address = addressOf(id)
  } catch {
    return { kind: 'session', target: id }
  }
  if (!usableAddress(address)) return { kind: 'session', target: id }
  return { kind: 'subagent', target: address }
}

/** 一项待确认的东西到底是不是 plan。plan 至少得说得清命令或类别。 */
function planOf(entry) {
  if (entry === null || typeof entry !== 'object') return undefined
  const looksLikePlan = (value) =>
    value !== null && typeof value === 'object' && (typeof value.command === 'string' || Array.isArray(value.categories))
  if (looksLikePlan(entry)) return entry
  return looksLikePlan(entry.plan) ? entry.plan : undefined
}

/**
 * 主对话里的危险确认卡。
 *
 * `pending` 是闸门还没拿到答复的东西，每项 `{ plan, requestedAt }`（也接受裸 plan，此时按
 * `now` 起算）。同一件事只出一张卡，保留**最早**的那次请求——后来的重复请求不该把倒计时
 * 续上。`requestedAt` 给了就必须是有限数：编不出来就别编，否则「最早的那次」会算错。
 *
 * 过期边界是**含等号**：`now >= expiresAt` 即过期，此时 `remainingMs` 归零、不留负数。
 */
export function confirmationCardsOf({ pending, now, timeoutMs } = {}) {
  if (!Array.isArray(pending)) throw new TypeError('confirmationCardsOf: pending must be an array')
  if (!Number.isFinite(now)) throw new TypeError('confirmationCardsOf: now must be a finite number')
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('confirmationCardsOf: timeoutMs must be a positive integer')
  }

  const cards = new Map()
  for (const entry of pending) {
    const plan = planOf(entry)
    if (plan === undefined) continue

    const categories = Array.isArray(plan.categories) ? plan.categories.map(readText).filter((item) => item !== '') : []
    const command = readText(plan.command)
    const intent = readText(plan.intent)
    // 既没命令也没类别的东西不是一次确认，不出卡。
    if (command === '' && categories.length === 0) continue

    let requestedAt = now
    if (entry.requestedAt !== undefined) {
      if (!Number.isFinite(entry.requestedAt)) {
        throw new TypeError('confirmationCardsOf: requestedAt must be a finite number')
      }
      requestedAt = entry.requestedAt
    }

    const key = dangerKey({ categories, command, intent })
    const previous = cards.get(key)
    if (previous !== undefined && previous.requestedAt <= requestedAt) continue

    const expiresAt = requestedAt + timeoutMs
    cards.set(key, {
      key,
      categories: [...categories].sort(),
      command,
      intent,
      requestedAt,
      expiresAt,
      remainingMs: Math.max(0, expiresAt - now),
      expired: now >= expiresAt,
    })
  }

  return [...cards.values()].sort((a, b) => a.requestedAt - b.requestedAt || a.key.localeCompare(b.key))
}
/**
 * 宿主 SidebarChat 的资源前缀（`dsh-client-ui-subagent/lib/client.js:708`）。
 *
 * worker 的完整会话不需要我们自己画：宿主已经有一个能渲染完整会话（自带输入框）的页签类型，
 * 只认这一种地址。我们拼出地址交给 `ctx.sidebarRight.openResource`，页签与视图都由宿主负责。
 */
export const SUBAGENT_CHAT_ADDRESS = 'dsh-resource://subagentchat/session/'

/** 宿主认的三种 mode（`parseSubagentChatAddress`，同文件 :738）。 */
export const SUBAGENT_CHAT_MODES = Object.freeze(['one-shot', 'continuable', 'unknown'])

/**
 * 把一个 subagent 地址变成宿主 SidebarChat 的资源地址。
 *
 * 规则逐条对齐宿主的 `parseSubagentChatAddress`：协议 `dsh-resource:`、hostname
 * `subagentchat`、路径恰好 `session/<childId>`、查询串必须带非空 `parent` 且 `mode` 在三种之内。
 * 拼错任何一条，宿主就认不出来，点 worker 会静默什么都不发生——所以这里是纯函数、有测试。
 */
export function workerChatAddressOf({ address } = {}) {
  if (!usableAddress(address)) throw new TypeError('workerChatAddressOf: a subagent address is required')
  const parent = readText(address.parentSessionId)
  const mode = readText(address.mode)
  if (!SUBAGENT_CHAT_MODES.includes(mode)) {
    throw new TypeError(`workerChatAddressOf: mode must be one of ${SUBAGENT_CHAT_MODES.join(', ')}`)
  }
  const child = readText(address.childSessionId)
  const query = new URLSearchParams({ parent, mode })
  return `${SUBAGENT_CHAT_ADDRESS}${encodeURIComponent(child)}?${query}`
}
/** 面板上可以做的事，就这四种。 */
export const PANEL_ACTIONS = Object.freeze(['open-session', 'open-resource', 'designate-master', 'show-section'])

/**
 * 点一下面板入口该发生什么。
 *
 * 返回值是纯数据，client 侧按 `kind` 分派：
 *
 * - `open-session` —— 在主栏打开一个会话（`uiWorkspace.openSession`）。master 走这条。
 * - `open-resource` —— 在右栏打开宿主的 SidebarChat 页签（`sidebarRight.openResource`）。worker 走这条。
 * - `designate-master` —— master 还没指定：去设置里指定或一键生成，而不是点一个空目标。
 * - `show-section` —— 监工与汇报不是会话，是面板里的一段；点了切到那段。
 *
 * worker 解析不出 subagent 地址时**退回主栏打开**：宿主只解析「已被发现」的地址，冷恢复或
 * 刚派发的瞬间可能还没有；这时点不动比开在主栏更糟——人已经点了，得给他看见东西。
 */
export function panelActionsOf({ model, addressOf } = {}) {
  requireModel(model, 'panelActionsOf')
  const master = model.master !== null && typeof model.master === 'object' ? model.master : { sessionId: null }

  const fixed = (Array.isArray(model.fixed) ? model.fixed : []).map((row) => {
    const id = readText(row?.id)
    if (id === 'master') {
      const sessionId = readText(master.sessionId)
      return { id, action: sessionId === '' ? { kind: 'designate-master' } : { kind: 'open-session', sessionId } }
    }
    return { id, action: { kind: 'show-section', section: id } }
  })

  const workers = (Array.isArray(model.workers) ? model.workers : [])
    .filter((row) => row !== null && typeof row === 'object' && readText(row.sessionId) !== '')
    .map((row) => {
      const sessionId = readText(row.sessionId)
      let address
      try {
        address = typeof addressOf === 'function' ? addressOf(sessionId) : undefined
      } catch {
        address = undefined
      }
      if (usableAddress(address)) {
        return { sessionId, action: { kind: 'open-resource', address: workerChatAddressOf({ address }) } }
      }
      return { sessionId, action: { kind: 'open-session', sessionId } }
    })

  return { fixed, workers }
}
