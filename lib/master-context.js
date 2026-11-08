/**
 * master 上下文与记忆注入（engineer-assistants 1.0.0 票 13）。
 *
 * 一句话：主对话被压缩之后，把登记表里的**事实**重新拼成一小段注入记忆域，
 * 保证「谁是我派出去的、谁卡住了、谁结束了」不随对话一起被压掉。
 *
 * 五条规矩：
 *
 * - **只写登记表真有的字段。** 登记表记的是 status，不记「验收过没有」；把每一行都叫
 *   「未验收」等于在主对话里制造一个不存在的事实，它会去追已经验收过的 worker。
 * - **有上限。** 登记表只增不减，摘要每行一个 worker；不封顶的文字会随派发次数线性增长，
 *   而记忆域有硬上限。已结束的只留最近几条，其余折成一句计数。
 * - **只写一个 parent 的孩子。** 两级派发下同一张表里有多个 parent，主对话不该声称自己派了
 *   别人的 worker。
 * - **状态原样照抄。** `reserved`（预占未成）与 `running` 是两件事，不能都写成「running 0 min」。
 * - **注入只替换自己那一段。** 从标记行到下一个标题为止；块后面别人的内容一个字都不能少。
 *
 * @module
 */

import { normalizeAssignments } from './assignments.js'

/** 记忆域里这一段的标记行。 */
export const SUMMARY_MARKER = '## dispatched workers'

/** 已结束的 worker 最多列几条，其余折成计数。 */
export const MAX_FINISHED_LINES = 6

const LIVE = Object.freeze(['reserved', 'running'])

function readText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function minutesBetween(startedAt, now) {
  if (!Number.isFinite(startedAt) || startedAt <= 0 || !Number.isFinite(now)) return undefined
  return Math.max(0, Math.round((now - startedAt) / 60000))
}

function describeWorker(row, { now, stuck }) {
  const parts = [`${row.sessionId} (${readText(row.presetId) || 'no preset'}, ${readText(row.kind) || 'worker'})`]
  // 状态原样照抄：reserved 是「预占了但还没起来」，不能冒充 running。
  if (row.status === 'running') {
    const age = minutesBetween(row.startedAt, now)
    parts.push(age === undefined ? 'running' : `running ${age} min`)
  } else {
    parts.push(row.status)
  }
  if (stuck) parts.push('STUCK')
  const cwd = readText(row.cwd)
  if (cwd !== '') parts.push('cwd ' + cwd)
  return '- ' + parts.join(' · ')
}

/**
 * 拼摘要。`parentId` 给了就只写这个 parent 的孩子；`acceptedIds` 是调用方掌握的、已经验收过的
 * 会话（登记表不记这件事）。
 */
export function buildSummary({ assignments, now, stuckIds = [], parentId, acceptedIds = [] } = {}) {
  if (assignments === null || typeof assignments !== 'object') {
    throw new TypeError('buildSummary: assignments must be an object')
  }
  if (!Number.isFinite(now)) throw new TypeError('buildSummary: now must be a finite number')

  const stuck = new Set((Array.isArray(stuckIds) ? stuckIds : []).filter((id) => typeof id === 'string'))
  const accepted = new Set((Array.isArray(acceptedIds) ? acceptedIds : []).filter((id) => typeof id === 'string'))
  const scope = readText(parentId)

  const rows = Object.values(normalizeAssignments(assignments))
    .filter((row) => scope === '' || row.parentId === scope)
    .filter((row) => !accepted.has(row.sessionId))

  // 卡住的只出现在 Stuck 段：同一个 worker 出现两行，读的人会以为有两个。
  const stuckRows = rows.filter((row) => stuck.has(row.sessionId))
  const running = rows.filter((row) => row.status === 'running' && !stuck.has(row.sessionId))
  const reserved = rows.filter((row) => row.status === 'reserved' && !stuck.has(row.sessionId))
  const finished = rows.filter((row) => !LIVE.includes(row.status) && !stuck.has(row.sessionId))

  const sections = { running: running.length, reserved: reserved.length, stuck: stuckRows.length, finished: finished.length }
  if (rows.length === 0) return { text: '', empty: true, sections }

  const lines = [SUMMARY_MARKER]
  if (running.length > 0) {
    lines.push('Running:')
    for (const row of running) lines.push(describeWorker(row, { now, stuck: false }))
  }
  if (reserved.length > 0) {
    lines.push('Reserved (not started yet):')
    for (const row of reserved) lines.push(describeWorker(row, { now, stuck: false }))
  }
  if (stuckRows.length > 0) {
    lines.push('Stuck:')
    for (const row of stuckRows) lines.push(describeWorker(row, { now, stuck: true }))
  }
  if (finished.length > 0) {
    lines.push('Finished (done / failed / cancelled):')
    const shown = finished.slice(-MAX_FINISHED_LINES)
    for (const row of shown) lines.push(describeWorker(row, { now, stuck: false }))
    if (finished.length > shown.length) lines.push(`- … and ${finished.length - shown.length} more finished worker(s)`)
  }
  return { text: lines.join('\n'), empty: false, sections }
}

/** 要注入记忆域的那一段：空表返回空串。 */
export function contextSegment(summary) {
  if (summary === null || typeof summary !== 'object') throw new TypeError('contextSegment: a summary is required')
  return summary.empty === true ? '' : summary.text
}

/**
 * 把段落并进记忆文本。只替换「标记行到下一个标题行」这一段，块后面的内容原样保留；
 * 空段落则把这一段摘掉。
 */
export function injectSegment({ memory = '', segment, marker = SUMMARY_MARKER } = {}) {
  const text = typeof memory === 'string' ? memory : ''
  const block = typeof segment === 'string' ? segment.trim() : ''
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === marker)
  let end = -1
  if (start !== -1) {
    end = start + 1
    while (end < lines.length && !/^\s*$/.test(lines[end]) && !lines[end].startsWith('#')) end += 1
  }
  const before = start === -1 ? lines : lines.slice(0, start)
  const after = start === -1 ? [] : lines.slice(end)
  const next = [...before, ...(block === '' ? [] : block.split(/\r?\n/)), ...after]
  return next.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
