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
 * 宿主的 `SubagentAddress` 是 `{ parentSessionId, childSessionId, mode }`；没有
 * `childSessionId` 的「地址」打不开任何东西，所以这里按最小可用条件判，而不是按真值判——
 * `{}` 和 `[]` 都是 truthy，靠真值判会把它们当成地址交出去。
 */
function usableAddress(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && readText(value.childSessionId) !== ''
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
