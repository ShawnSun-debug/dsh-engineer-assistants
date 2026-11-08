/**
 * 汇报（engineer-assistants 1.0.0 票 10）。
 *
 * 一句话：每三分钟把「谁在跑、谁卡住、刚完成什么、花了多少、下一步建议」讲成人话，
 * 最近一份随右栏端点的同一次查询交出去；两小时封顶。
 *
 * 五条规矩：
 *
 * - **五项必含。** 少一项的播报等于让用户自己去猜；模板固定顺序，缺项写成「无」。
 * - **每项一句人话。** 确定性模板生成，不用模型；多行的日志摘要压成一行，否则一项会变成
 *   好几行、后面的行还没有标签。
 * - **没变化才用一行。** 只有整份快照都空时才说「无变化」——「有在跑的、但还没完成任何东西」
 *   不是无变化。
 * - **封顶就停。** 两小时之后不再产生新播报。
 * - **只留最近一份。** 三分钟一份、跑满两小时会攒出四十份，而右栏同一时刻只画一份；
 *   上一份在下一拍被替换掉，内存里不累积。
 *
 * 归档路径助手（`archivePath` / `summaryPath`）留给兄弟模块与测试；票 21 之后这条节拍
 * 只把最近一份交给右栏，不自己写盘。时间一律用**本地时间**——用 UTC 会让傍晚的汇报落到
 * 第二天目录里。
 *
 * @module
 */

import { join } from 'node:path'
import { isTerminal, normalizeAssignments } from './assignments.js'
import { createBeat } from './secretary-beat.js'

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
  for (const item of reportItemsOf(snapshot)) {
    lines.push(`- **${item.label}**：${item.text}`)
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

/** 缺项的写法：不写零、不猜数，直接说这一项没有来源。 */
export const COST_MISSING = '未提供（没有可读的用量统计）'

/** 卡住理由的中文写法；认不出的理由原样保留，不吞掉事实。 */
const STUCK_LABELS = Object.freeze({ idle: '空转', retrying: '重试中', 'waiting-approval': '等批准' })

/** 终态的中文写法。 */
const FINISHED_LABELS = Object.freeze({ done: '完成', failed: '失败', cancelled: '取消' })

/** 一行里最多列几个 id；再多只报个数，否则一项会撑成好几行。 */
const IDS_SHOWN = 5

function idsText(ids) {
  const shown = ids.slice(0, IDS_SHOWN).join('、')
  return ids.length > IDS_SHOWN ? `${shown} 等 ${ids.length} 个` : shown
}

/** 监工的红点图 `{ id: [reason...] }` 读成一行行事实；空理由、空 id 都不算数。 */
function attentionRowsOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  const rows = []
  for (const [rawId, rawReasons] of Object.entries(value)) {
    const id = readText(rawId)
    if (id === '') continue
    const reasons = (Array.isArray(rawReasons) ? rawReasons : [])
      .map((reason) => readText(reason))
      .filter((reason) => reason !== '')
    if (reasons.length > 0) rows.push({ id, reasons })
  }
  return rows.sort((left, right) => left.id.localeCompare(right.id))
}

/**
 * 五项快照：事实只从登记表与监工来。
 *
 * 为什么不用别的量顶替：
 * - 在跑 = 登记表里 running/reserved 的行；没有写入方时这里就是空的，不拿会话数猜。
 * - 卡住 = 监工 activeAll() 此刻仍亮着红点的 id；理由原样翻译，不新增第三套词表。
 * - 刚完成 = 登记表的终态行。登记表没有结束时间戳，所以只说「已结束」，不编「刚刚」。
 * - 花费 = 仓库里没有可读的用量统计，就写缺项 COST_MISSING——一个 0 会读成「没花钱」。
 * - 下一步 = 确定性规则，同一份快照永远给出同一句建议。
 */
export function snapshotOf({ assignments, attention } = {}) {
  const rows = Object.values(normalizeAssignments(assignments)).sort(
    (left, right) => left.startedAt - right.startedAt || left.sessionId.localeCompare(right.sessionId),
  )
  const running = rows.filter((row) => row.status === 'running' || row.status === 'reserved')
  const finished = rows.filter((row) => isTerminal(row.status))
  const stuck = attentionRowsOf(attention)
  const stuckList = stuck
    .slice(0, IDS_SHOWN)
    .map((row) => `${row.id}：${row.reasons.map((reason) => STUCK_LABELS[reason] ?? reason).join('、')}`)
    .join('；')
  const finishedList = finished
    .slice(0, IDS_SHOWN)
    .map((row) => `${row.sessionId} ${FINISHED_LABELS[row.status] ?? row.status}`)
    .join('、')

  return {
    running: running.length === 0 ? '' : `${running.length} 个在跑（${idsText(running.map((row) => row.sessionId))}）`,
    stuck:
      stuck.length === 0
        ? ''
        : `${stuck.length} 个卡住（${stuckList}${stuck.length > IDS_SHOWN ? ` 等 ${stuck.length} 个` : ''}）`,
    finished:
      finished.length === 0
        ? ''
        : `已结束 ${finished.length} 个（${finishedList}${finished.length > IDS_SHOWN ? ` 等 ${finished.length} 个` : ''}）`,
    cost: COST_MISSING,
    next:
      stuck.length > 0
        ? `先处理 ${stuck.length} 个卡住的 worker（${idsText(stuck.map((row) => row.id))}）`
        : running.length > 0
          ? `还有 ${running.length} 个 worker 在跑，等它们结束`
          : finished.length > 0
            ? `确认刚结束的 ${finished.length} 个 worker 的产出，再派下一批`
            : '没有在跑的 worker，可以派下一批',
  }
}

/**
 * 五项各一行：键、标签、文本。渲染与端点共用这一份，客户端不必再维护第二张键表；
 * 缺项在这里落成「无」，永远不会是一行没有标签的空行。
 */
export function reportItemsOf(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object') throw new TypeError('reportItemsOf: a snapshot is required')
  return REQUIRED_ITEMS.map((key) => ({ key, label: ITEM_LABELS[key], text: describeItem(snapshot[key], EMPTY, key) }))
}

/**
 * 一份可画的报告：第几次、何时、全文、五项。
 *
 * `at` 统一成毫秒数字交给端点（客户端不解析 Date）；文本与 stamp 仍按本地时间写。
 */
export function composeReport({ seq, at, snapshot } = {}) {
  if (!Number.isInteger(seq) || seq < 1) throw new TypeError('composeReport: seq must be a positive integer')
  const { day, time } = stampOf(at)
  const { text, oneLine } = renderReport({ snapshot, at })
  return {
    seq,
    at: at instanceof Date ? at.getTime() : typeof at === 'number' ? at : new Date(at).getTime(),
    stamp: `${day} ${time.replace('-', ':')}`,
    text,
    oneLine,
    items: reportItemsOf(snapshot),
  }
}

/**
 * 汇报的节拍。时钟、定时器、事实来源全部注入；生产接线在 lib/index.js，测试用手推时钟。
 *
 * 只保留最近一份；上限由 createBeat 判定（到点自停，不再 tick），`start()` 幂等
 * （重复启动不叠第二块表）。
 */
export function createReporter({
  assignments,
  attention,
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
  onReport,
  onError,
  beatSeconds = CADENCE_MS / 1000,
  maxRunSeconds = CAP_MS / 1000,
} = {}) {
  const read = (value) => (typeof value === 'function' ? value() : value)
  let latest = null
  let produced = 0
  const beat = createBeat({
    now,
    schedule,
    cancel,
    beatSeconds,
    maxRunSeconds,
    onTick: (info) => {
      const at = Number.isFinite(info?.elapsedMs) ? info.startedAt + info.elapsedMs : Date.now()
      // 先算再记数：读事实就抛的那一拍没有报告，序号也不该被它占掉。
      const report = composeReport({
        seq: produced + 1,
        at,
        snapshot: snapshotOf({ assignments: read(assignments), attention: read(attention) }),
      })
      produced += 1
      latest = report
      if (typeof onReport === 'function') onReport(latest)
    },
    onError: (error) => {
      if (typeof onError === 'function') onError(error)
    },
  })
  return {
    start: () => beat.start(),
    stop: (reason) => beat.stop(reason),
    status: () => beat.status(),
    latest: () => latest,
    count: () => produced,
  }
}
