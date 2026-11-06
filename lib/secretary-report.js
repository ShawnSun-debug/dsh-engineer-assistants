/**
 * 报告拼装（秘书 spec 票 04）。
 *
 * 报告由代码按固定模板拼成 Markdown，不调用模型：节拍每三分钟写一份，模板必须稳定、
 * 可断言，缺数据也不能塌。六个小节永远出现，缺的写「无」或「未提供」，读报告的人
 * 不用猜哪一段是漏了还是本来就没有。
 *
 * 纯逻辑：不读时钟、不写文件、不认识宿主。时间由调用方以 `at` 传入，所以同一份输入
 * 在任何机器上都拼出同一份文本。
 *
 * 三个导出：
 * - `renderReport(input)` → 增量/超时报告全文（给归档与冒泡用）。
 * - `renderPlanReport(input)` → 规划首报全文。它没有 worker 六态表，取而代之的是
 *   步骤、验收点、触发依据与预计耗时；缺字段保留标题写「未提供」，不抛。
 * - `summarizeForDiff(input)` → 下一轮比较用的结构化摘要（状态 / 步骤 / worker 名字与
 *   状态 / 产出）。差异计算不在这里：这里只把「这一份说了什么」压成可比较的形状。
 *
 * @module
 */
import { WORKER_STATE, WORKER_STATES } from './master-state.js'
import { REPORT_KINDS } from './secretary-constants.js'

/** 三种报告（名单真源在 secretary-constants.js）：首报、节拍增量、超时截断，顺序即文档顺序。 */
export { REPORT_KINDS }

/** 头部里 kind 的中文标签。 */
const KIND_LABELS = Object.freeze({ plan: '规划', delta: '增量', limit: '超时截断' })

const UNNAMED_SESSION = '未命名会话'
const UNNAMED_WORKER = '未命名 worker'
const NO_SUMMARY = '暂无摘要'
const NO_ACTIVITY = '—'

/** 把一个值当对象用；null 与非对象都退化成空对象，调用方不必逐层判空。 */
function asObject(value) {
  return value !== null && typeof value === 'object' ? value : {}
}

/** 压成一行：多行摘要、换行、连续空白都不该把模板撑破。 */
function oneLine(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 第一个非空的文本字段；用于 name/title/id 这类「任一即可」的身份字段。 */
function firstText(source, keys) {
  for (const key of keys) {
    const text = oneLine(source[key])
    if (text !== '') return text
  }
  return ''
}

/** 非负整数；负数、小数、NaN、字符串一律当没有。 */
function readCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}

/** 一个可用的时间；坏输入直接抛，而不是悄悄用当前时间冒充。 */
function readDate(fn, value) {
  let time = Number.NaN
  if (value instanceof Date) time = value.getTime()
  else if (typeof value === 'number') time = value
  else if (typeof value === 'string' && value.trim() !== '') time = new Date(value).getTime()
  if (!Number.isFinite(time)) {
    throw new TypeError(`${fn}: at must be a valid date (Date, epoch ms or ISO string)`)
  }
  return new Date(time)
}

/** kind 必须是三种之一：拼错一个标签比直接报错更难发现。 */
function readKind(value) {
  if (typeof value !== 'string' || !REPORT_KINDS.includes(value)) {
    throw new TypeError(`renderReport: kind must be one of ${REPORT_KINDS.join(', ')}`)
  }
  return value
}

/** 本地时间戳，精确到分钟：报告文件按分钟分，头部与文件名用同一粒度。 */
function pad(value) {
  return String(value).padStart(2, '0')
}

function formatStamp(date) {
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  ].join(' ')
}

/** 已跑时长：秒级足够，报告不是秒表。 */
function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  if (hours > 0) return `${hours} 小时 ${pad(minutes)} 分`
  if (minutes > 0) return `${minutes} 分 ${pad(seconds)} 秒`
  return `${seconds} 秒`
}

/** 会话名：字符串或对象都接；标题、会话名、id 依次兜底。 */
function readSessionName(session) {
  if (typeof session === 'string') return oneLine(session) || UNNAMED_SESSION
  return firstText(asObject(session), ['name', 'title', 'conversation', 'id']) || UNNAMED_SESSION
}

/** 六态之一是唯一合法状态；缺失或写错都按投影的初始态 Idle 处理，差异比较才有稳定值。 */
function readState(orchestrator) {
  return WORKER_STATES.includes(orchestrator.state) ? orchestrator.state : WORKER_STATE.idle
}

/**
 * 当前步骤与总步骤。支持 `step: { index, total }` 与 `step: 2, totalSteps: 5` 两种
 * 写法：首报来自编排参数，增量来自投影，两边形状不必一致。缺的填 null。
 */
function readStep(orchestrator) {
  let index = null
  let total = readCount(orchestrator.totalSteps)
  const step = orchestrator.step
  if (step !== null && typeof step === 'object' && !Array.isArray(step)) {
    index = readCount(step.index)
    total = readCount(step.total) ?? total
  } else {
    index = readCount(step)
  }
  return { index, total }
}

function renderStep(step) {
  if (step.index !== null && step.total !== null) return `第 ${step.index} 步 / 共 ${step.total} 步`
  if (step.index !== null) return `第 ${step.index} 步`
  if (step.total !== null) return `共 ${step.total} 步`
  return '未提供'
}

/** worker 行：名字 / 六态 / 在做的事。空字段不留洞，用「未命名」「—」占位。 */
function readWorkers(list) {
  if (!Array.isArray(list)) return []
  const workers = []
  for (const raw of list) {
    if (typeof raw === 'string') {
      const name = oneLine(raw) || UNNAMED_WORKER
      workers.push({ name, state: WORKER_STATE.idle, activity: NO_ACTIVITY })
      continue
    }
    const worker = asObject(raw)
    const name = firstText(worker, ['name', 'title', 'id']) || UNNAMED_WORKER
    const state = WORKER_STATES.includes(worker.state) ? worker.state : WORKER_STATE.idle
    const activity = firstText(worker, ['activity', 'summary', 'detail']) || NO_ACTIVITY
    workers.push({ name, state, activity })
  }
  return workers
}

/** 差异条目：字符串原样；对象优先拼「名字：从 → 到」，否则退回名字或说明。 */
function diffText(raw) {
  if (typeof raw === 'string') return oneLine(raw)
  const entry = asObject(raw)
  if (Object.keys(entry).length === 0) return ''
  const name = firstText(entry, ['name', 'title', 'id'])
  const from = firstText(entry, ['from'])
  const to = firstText(entry, ['to'])
  if (name !== '' && from !== '' && to !== '') return `${name}：${from} → ${to}`
  if (name !== '') return name
  return firstText(entry, ['text', 'summary', 'detail'])
}

function readDiffGroup(value) {
  if (!Array.isArray(value)) return []
  const items = []
  for (const raw of value) {
    const text = diffText(raw)
    if (text !== '') items.push(text)
  }
  return items
}

function readDiff(diff) {
  const source = asObject(diff)
  return {
    completed: readDiffGroup(source.completed),
    blocked: readDiffGroup(source.blocked),
    flipped: readDiffGroup(source.flipped),
  }
}

/** 产出：一串路径或链接；对象取 path/url/title/label。 */
function artifactText(raw) {
  if (typeof raw === 'string') return oneLine(raw)
  return firstText(asObject(raw), ['path', 'url', 'title', 'label'])
}

function readArtifacts(list) {
  if (!Array.isArray(list)) return []
  const artifacts = []
  for (const raw of list) {
    const text = artifactText(raw)
    if (text !== '') artifacts.push(text)
  }
  return artifacts
}

function errorText(raw) {
  if (raw instanceof Error) return oneLine(raw.message) || oneLine(raw.name)
  if (typeof raw === 'string') return oneLine(raw)
  return firstText(asObject(raw), ['message', 'text', 'summary'])
}

function readErrors(value) {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
  const errors = []
  for (const raw of list) {
    const text = errorText(raw)
    if (text !== '') errors.push(text)
  }
  return errors
}

/**
 * 耗时与异常。`elapsedMs` 优先；没有就接受 `elapsedSeconds`，再没有就从
 * `startedAt` 与 `at` 现算；都缺则由模板写「未提供」。
 */
function readTiming(timing, at) {
  const source = asObject(timing)
  let elapsedMs = readCount(source.elapsedMs)
  if (elapsedMs === null) {
    const seconds = readCount(source.elapsedSeconds)
    if (seconds !== null) elapsedMs = seconds * 1000
  }
  if (elapsedMs === null) {
    const startedAt = typeof source.startedAt === 'number' ? source.startedAt : Number.NaN
    if (Number.isFinite(startedAt)) {
      const elapsed = at.getTime() - startedAt
      if (elapsed >= 0) elapsedMs = elapsed
    }
  }
  return {
    elapsedMs,
    retries: readCount(source.retries),
    errors: readErrors(source.errors),
  }
}

/** 表格单元格：竖线转义，否则一行 worker 就能把整张表拆散。 */
function cell(text) {
  return oneLine(text).replace(/\|/g, '\\|')
}

/**
 * 拼一份报告。
 *
 * 入参（都走默认值，缺了也不抛，除了 kind/at）：
 * - `kind`：REPORT_KINDS 之一。
 * - `at`：Date / epoch ms / ISO 字符串。
 * - `session`：{ name, title, conversation, id } 或一个名字字符串。
 * - `orchestrator`：六态投影 { state, summary, step, totalSteps, workers }。
 * - `diff`：{ completed, blocked, flipped }，条目可以是字符串或 { name, from, to }。
 * - `artifacts`：路径/链接数组，或 { path, url, title, label } 数组。
 * - `timing`：{ elapsedMs | elapsedSeconds | startedAt, retries, errors }。
 *
 * 输出固定六段：状态、步骤、worker、差异、产出、耗时与异常，顺序不变。
 */
export function renderReport(input) {
  const data = asObject(input)
  const at = readDate('renderReport', data.at)
  const kind = readKind(data.kind)
  const orchestrator = asObject(data.orchestrator)
  const state = readState(orchestrator)
  const summary = oneLine(orchestrator.summary) || NO_SUMMARY
  const step = readStep(orchestrator)
  const workers = readWorkers(orchestrator.workers)
  const diff = readDiff(data.diff)
  const artifacts = readArtifacts(data.artifacts)
  const timing = readTiming(data.timing, at)

  const lines = [
    '# 秘书汇报',
    '',
    `- 时间：${formatStamp(at)}`,
    `- 会话：${readSessionName(data.session)}`,
    `- 类型：${KIND_LABELS[kind]}`,
    '',
    '## 状态',
    '',
    `${state} — ${summary}`,
    '',
    '## 步骤',
    '',
    renderStep(step),
    '',
    '## worker',
    '',
  ]

  if (workers.length === 0) {
    lines.push('无')
  } else {
    lines.push('| 名字 | 状态 | 在做的事 |', '| --- | --- | --- |')
    for (const worker of workers) {
      lines.push(`| ${cell(worker.name)} | ${cell(worker.state)} | ${cell(worker.activity)} |`)
    }
  }

  lines.push('', '## 差异', '')
  const groups = [
    ['新完成', diff.completed],
    ['新卡住', diff.blocked],
    ['状态翻转', diff.flipped],
  ]
  for (const [title, items] of groups) {
    lines.push(`### ${title}`, '')
    if (items.length === 0) lines.push('无')
    else for (const item of items) lines.push(`- ${item}`)
    lines.push('')
  }

  lines.push('## 产出', '')
  if (artifacts.length === 0) lines.push('无')
  else for (const artifact of artifacts) lines.push(`- ${artifact}`)
  lines.push('')

  lines.push('## 耗时与异常', '')
  lines.push(`- 已跑时长：${timing.elapsedMs === null ? '未提供' : formatDuration(timing.elapsedMs)}`)
  lines.push(`- 重试次数：${timing.retries === null ? '未提供' : timing.retries}`)
  if (timing.errors.length === 0) {
    lines.push('- 错误：无')
  } else {
    lines.push('- 错误：')
    for (const error of timing.errors) lines.push(`  - ${error}`)
  }

  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}

/** 规划的步骤行：`1. 名字 — 说明`，编号以 step.index 为准，缺了按位置补。 */
function readPlanSteps(list) {
  if (!Array.isArray(list)) return []
  const steps = []
  for (const [position, raw] of list.entries()) {
    if (typeof raw === 'string') {
      const text = oneLine(raw)
      if (text !== '') steps.push(`${position + 1}. ${text}`)
      continue
    }
    const step = asObject(raw)
    const index = readCount(step.index) ?? position + 1
    const name = firstText(step, ['name', 'title', 'label'])
    const detail = firstText(step, ['detail', 'description', 'task', 'prompt'])
    const body = name !== '' && detail !== '' ? `${name} — ${detail}` : name || detail
    if (body !== '') steps.push(`${index}. ${body}`)
  }
  return steps
}

/** 验收点：一行一条；字符串原样，对象取能当文字用的那个字段。 */
function readPlanAcceptance(list) {
  if (!Array.isArray(list)) return []
  const items = []
  for (const raw of list) {
    const text = typeof raw === 'string' ? oneLine(raw) : firstText(asObject(raw), ['text', 'title', 'label', 'path'])
    if (text !== '') items.push(text)
  }
  return items
}

/** 触发依据：来源 / 工具 / 会话 / 调用。一样都读不出来就当没有。 */
function readTriggerLines(trigger) {
  const source = asObject(trigger)
  const kind = firstText(source, ['kind', 'source'])
  const tool = firstText(source, ['tool'])
  const sessionId = firstText(source, ['sessionId', 'session'])
  const callId = firstText(source, ['callId', 'call'])
  if (kind === '' && tool === '' && sessionId === '' && callId === '') return []
  return [
    `- 来源：${kind || '未提供'}`,
    `- 工具：${tool || '未提供'}`,
    `- 会话：${sessionId || '未提供'}`,
    `- 调用：${callId || '未提供'}`,
  ]
}

/** 规划里的 worker：计划阶段的六态还不适用，状态照实写（通常是 planned）。 */
function readPlanWorkers(list) {
  if (!Array.isArray(list)) return []
  const workers = []
  for (const raw of list) {
    if (typeof raw === 'string') {
      const name = oneLine(raw)
      if (name !== '') workers.push({ name, state: 'planned', task: NO_ACTIVITY })
      continue
    }
    const worker = asObject(raw)
    const name = firstText(worker, ['name', 'title', 'id'])
    const state = firstText(worker, ['state'])
    const task = firstText(worker, ['task', 'activity', 'summary', 'detail'])
    if (name === '' && task === '') continue
    workers.push({ name: name || UNNAMED_WORKER, state: state || '未提供', task: task || NO_ACTIVITY })
  }
  return workers
}

/** 预计耗时：优先用调用方给的标签（带基线说明），只有秒数就自己说清楚这是估的。 */
function readPlanEstimate(estimate) {
  const source = asObject(estimate)
  const label = firstText(source, ['label', 'text'])
  if (label !== '') return label
  const seconds = readCount(source.seconds)
  if (seconds !== null) return `约 ${formatDuration(seconds * 1000)}（基线粗估，非实测）`
  return ''
}

/**
 * 拼一份规划首报。
 *
 * 入参：`at`（必填，与 renderReport 同一规则）、`session`、`plan`
 * （secretary-watch 的 `buildPlanReport` 输出：steps / acceptance / trigger /
 * workers / estimate）。六段固定为状态、步骤、验收点、触发依据、worker、预计耗时，
 * 顺序不变；缺的段写「未提供」，不抛错。
 */
export function renderPlanReport(input) {
  const data = asObject(input)
  const at = readDate('renderPlanReport', data.at)
  const plan = asObject(data.plan)
  const state = firstText(plan, ['state'])
  const steps = readPlanSteps(plan.steps)
  const acceptance = readPlanAcceptance(plan.acceptance)
  const trigger = readTriggerLines(plan.trigger)
  const workers = readPlanWorkers(plan.workers)
  const estimate = readPlanEstimate(plan.estimate)

  const lines = [
    '# 秘书规划',
    '',
    `- 时间：${formatStamp(at)}`,
    `- 会话：${readSessionName(data.session)}`,
    `- 类型：${KIND_LABELS.plan}`,
    '',
    '## 状态',
    '',
    state === '' ? '未提供' : state,
    '',
    '## 步骤',
    '',
    ...(steps.length === 0 ? ['未提供'] : steps),
    '',
    '## 验收点',
    '',
    ...(acceptance.length === 0 ? ['未提供'] : acceptance.map((item) => `- ${item}`)),
    '',
    '## 触发依据',
    '',
    ...(trigger.length === 0 ? ['未提供'] : trigger),
    '',
    '## worker',
    '',
  ]

  if (workers.length === 0) {
    lines.push('未提供')
  } else {
    lines.push('| 名字 | 状态 | 在做的事 |', '| --- | --- | --- |')
    for (const worker of workers) {
      lines.push(`| ${cell(worker.name)} | ${cell(worker.state)} | ${cell(worker.task)} |`)
    }
  }

  lines.push('', '## 预计耗时', '', estimate === '' ? '未提供' : estimate)

  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}

/**
 * 把同一次拼装的输入压成下一轮差异比较的结构化摘要。
 *
 * 只保留会参与比较的字段：状态、步骤、worker 的名字与状态、产出路径。这里不判断
 * 差异，比较由调用方做——同一份摘要喂给任何比较实现都得到同样的输入。
 */
export function summarizeForDiff(input) {
  const data = asObject(input)
  const orchestrator = asObject(data.orchestrator)
  return {
    state: readState(orchestrator),
    step: readStep(orchestrator),
    workers: readWorkers(orchestrator.workers).map((worker) => ({
      name: worker.name,
      state: worker.state,
    })),
    artifacts: readArtifacts(data.artifacts),
  }
}
