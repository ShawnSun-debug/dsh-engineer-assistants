/**
 * 汇报（engineer-assistants 1.0.0 票 10）。
 *
 * 一句话：每三分钟把「谁在跑、谁卡住、刚完成什么、花了多少、下一步建议」讲成人话，
 * 播报到 reporter 会话，同时归档成文件；两小时封顶。
 *
 * 四条规矩：
 *
 * - **五项必含。** 少一项的播报等于让用户自己去猜；模板固定顺序，缺项写成「无」。
 * - **每项一句人话。** 确定性模板生成，不用模型；多行的日志摘要压成一行，否则一项会变成
 *   好几行、后面的行还没有标签。
 * - **没变化才用一行。** 只有整份快照都空时才说「无变化」——「有在跑的、但还没完成任何东西」
 *   不是无变化。
 * - **封顶就停。** 两小时之后不再产生新播报。
 *
 * 归档路径：`<master cwd>/.scratch/engineer-assistants/reports/<YYYY-MM-DD>/<HH-mm>.md`，
 * 与兄弟模块一致用**本地时间**——用 UTC 会让傍晚的汇报落到第二天目录里。
 *
 * @module
 */

import { join } from 'node:path'

/** 节拍：三分钟。 */
export const CADENCE_MS = 3 * 60 * 1000

/** 封顶：两小时。 */
export const CAP_MS = 2 * 60 * 60 * 1000

/** 五项必含内容。 */
export const REQUIRED_ITEMS = Object.freeze(['running', 'stuck', 'finished', 'cost', 'next'])

/** 五项的中文标签（顺序与 REQUIRED_ITEMS 一致）。 */
export const ITEM_LABELS = Object.freeze({
  running: '在跑',
  stuck: '卡住 / 等批准',
  finished: '刚完成的产出与验证',
  cost: '花费',
  next: '建议下一步',
})

const EMPTY = '无'

function readText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function pad(value) {
  return String(value).padStart(2, '0')
}

/**
 * 接受 Date / 毫秒时间戳 / ISO 字符串；本地时间，与兄弟归档模块一致。
 *
 * 先验类型再构造：`new Date(null)` 和 `new Date(true)` 不会报错，它们给出 epoch，
 * 于是每一份 `at: null` 的汇报都会归档到同一个 `1970-01-01/08-00.md` 上互相覆盖。
 */
export function stampOf(at) {
  const acceptable =
    at instanceof Date || (typeof at === 'number' && Number.isFinite(at)) || (typeof at === 'string' && at.trim() !== '')
  if (!acceptable) {
    throw new TypeError('stampOf: a valid Date, epoch ms or ISO string is required')
  }
  const date = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('stampOf: a valid Date, epoch ms or ISO string is required')
  }
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const time = `${pad(date.getHours())}-${pad(date.getMinutes())}`
  return { day, time }
}

function reportsDir(cwd) {
  const base = readText(cwd)
  if (base === '') throw new TypeError('a master cwd is required')
  return join(base, '.scratch', 'engineer-assistants', 'reports')
}

/** 归档路径（只算，不写）。 */
export function archivePath({ cwd, at } = {}) {
  const { day, time } = stampOf(at)
  return join(reportsDir(cwd), day, `${time}.md`)
}

/** 汇总文件路径。 */
export function summaryPath({ cwd } = {}) {
  return join(reportsDir(cwd), '_summary.md')
}

/** 这一轮要不要播报：按节拍，且没到封顶。 */
export function reportDue({ startedAt, now, lastReportAt } = {}) {
  if (!Number.isFinite(startedAt) || !Number.isFinite(now)) {
    throw new TypeError('reportDue: startedAt and now must be finite numbers')
  }
  if (now - startedAt >= CAP_MS) return { due: false, reason: 'capped' }
  if (!Number.isFinite(lastReportAt)) return { due: true, reason: 'first' }
  if (now - lastReportAt < CADENCE_MS) return { due: false, reason: 'cadence' }
  return { due: true, reason: 'cadence' }
}

/** 能数「个」的项：花费是金额，一个数字在那里不是个数。 */
const COUNTED_ITEMS = Object.freeze(['running', 'stuck', 'finished', 'next'])

/** 一项的文本：一行、非空。多行详情压成一行；数字只有数得清的东西才加「个」。 */
function describeItem(value, fallback, key = '') {
  const counted = COUNTED_ITEMS.includes(key)
  if (typeof value === 'string') {
    const collapsed = value.replace(/\s+/g, ' ').trim()
    return collapsed === '' ? fallback : collapsed
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    if (value === 0) return fallback
    return counted ? `${value} 个` : String(value)
  }
  if (value !== null && typeof value === 'object') {
    const detail = typeof value.detail === 'string' ? value.detail.replace(/\s+/g, ' ').trim() : ''
    if (detail !== '') return detail
    if (Number.isInteger(value.count) && value.count > 0) {
      return counted ? `${value.count} 个` : String(value.count)
    }
  }
  return fallback
}

/** 整份快照是否真的什么都没有。 */
function isEmptySnapshot(snapshot) {
  return REQUIRED_ITEMS.every((key) => describeItem(snapshot[key], '', key) === '')
}

/**
 * 渲染一次播报。`snapshot` 形如 `{ running, stuck, finished, cost, next, unchanged }`；
 * `unchanged` 为真、或整份快照为空时才输出一行。
 */
export function renderReport({ snapshot, at } = {}) {
  if (snapshot === null || typeof snapshot !== 'object') throw new TypeError('renderReport: a snapshot is required')
  const { day, time } = stampOf(at)
  const stamp = `${day} ${time.replace('-', ':')}`
  const head = `# 汇报 ${stamp}`

  if (snapshot.unchanged === true || isEmptySnapshot(snapshot)) {
    return { oneLine: true, text: `${head}\n${stamp}：无变化。` }
  }

  const lines = [head, '']
  for (const key of REQUIRED_ITEMS) {
    lines.push(`- **${ITEM_LABELS[key]}**：${describeItem(snapshot[key], EMPTY, key)}`)
  }
  return { oneLine: false, text: lines.join('\n') }
}

/** `_summary.md` 里追加的一行：日期、时间、一行结论。 */
export function summaryLine({ snapshot, at } = {}) {
  const { day, time } = stampOf(at)
  const stamp = `${day} ${time.replace('-', ':')}`
  if (snapshot?.unchanged === true || isEmptySnapshot(snapshot ?? {})) return `- ${stamp} · 无变化`
  // 「还没完成任何东西」不等于「无变化」：取第一项有内容的。
  for (const key of ['finished', 'running', 'stuck', 'next', 'cost']) {
    const text = describeItem(snapshot?.[key], '', key)
    if (text !== '') return `- ${stamp} · ${text}`
  }
  return `- ${stamp} · 无变化`
}
