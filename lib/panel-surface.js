/**
 * 面板表面（engineer-assistants 1.0.0 票 12）。
 *
 * 一句话：把面板模型与宿主事实翻成界面真要的那几样——红点数字、切进某个 worker 的导航目标、
 * 主对话里那张危险确认卡。
 *
 * 四条规矩：
 *
 * - **只算，不画。** 不 import React、不碰 ctx、不读时钟。输出是纯数据，宿主接入留在 client 侧。
 *   时钟由调用方给（`now`），否则这里就没法测。
 * - **只出事实，不出口播。** 卡片不带中文文案——文案是 client 的多语言表的事，混进来就会
 *   出现一个模块带两套语言表的下场。
 * - **红点只点数得清的东西。** 只有真需要人的 worker 才进红点；同一个 worker 因两个原因各
 *   触发一次也只算一次。不在列表里的 id 一律忽略（它已经结束了，红点不该为它亮）。
 * - **确认卡的键只有一个来源。** 去重直接用 `danger.js` 的 `dangerKey`——另算一遍，
 *   「同一件事」就会跟闸门的判定分叉。
 *
 * @module
 */

import { dangerKey } from './danger.js'

/** 需要用户介入的原因。 */
export const ATTENTION_REASONS = Object.freeze(['stuck', 'awaiting-approval'])

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
 * `attention` 形如 `{ [sessionId]: ['stuck', 'awaiting-approval'] }`，由巡检与申请派发两处
 * 各自填。未知原因忽略、重复原因去重、不在列表里的 id 不算。
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

  const sessionIds = model.workers.filter((row) => reasons.has(row.sessionId)).map((row) => row.sessionId)
  const byReason = {}
  for (const reason of ATTENTION_REASONS) {
    byReason[reason] = sessionIds.filter((id) => reasons.get(id).includes(reason)).length
  }
  return { count: sessionIds.length, sessionIds, byReason }
}

/**
 * 「切进 worker 说话」要交给 `uiWorkspace.openSession` 的那个值。
 *
 * 会话 id 本身就是合法目标；只有当宿主能把它解析成 subagent 地址时才优先用地址——地址在
 * 会话重建后仍然稳定，裸 id 不行。`addressOf` 由调用方注入（宿主是
 * `ctx.sessions.subagentAddress`）；解析失败退回 id，因为「点一个 worker」不该因为解析
 * 出错就点不动。
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
  if (address === null || address === undefined) return { kind: 'session', target: id }
  return { kind: 'subagent', target: address }
}

/**
 * 主对话里的危险确认卡。
 *
 * `pending` 是闸门还没拿到答复的东西，每项 `{ plan, requestedAt }`（也接受裸 plan，
 * 此时按 `now` 起算）。同一件事只出一张卡，保留**最早**的那次请求——后来的重复请求
 * 不该把倒计时续上。`label` 之类文案不在这里产出。
 */
export function confirmationCardsOf({ pending, now, timeoutMs } = {}) {
  if (!Array.isArray(pending)) throw new TypeError('confirmationCardsOf: pending must be an array')
  if (!Number.isFinite(now)) throw new TypeError('confirmationCardsOf: now must be a finite number')
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('confirmationCardsOf: timeoutMs must be a positive integer')
  }

  const cards = new Map()
  for (const entry of pending) {
    const plan = entry !== null && typeof entry === 'object' && 'plan' in entry ? entry.plan : entry
    if (plan === null || typeof plan !== 'object') continue

    const categories = Array.isArray(plan.categories) ? plan.categories.map(readText).filter((item) => item !== '') : []
    const command = readText(plan.command)
    const intent = readText(plan.intent)
    const key = dangerKey({ categories, command, intent })
    const requestedAt = Number.isFinite(entry?.requestedAt) ? entry.requestedAt : now

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
