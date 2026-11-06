/**
 * 秘书触发侦测与规划首报（秘书 spec 票 03）。
 *
 * 纯逻辑：不 import 宿主，不读时钟、不碰文件、不认识 ctx。事件取自会话日志
 * （`{ seq, time, type, data }`），登记表取自 lib/secretary-registry.js，产出交给
 * 后续的报告拼装与归档（票 04）——所以这里只给结构化输入，不拼文案。
 *
 * 三条规则：
 *
 * - **只认一种出发信号。** 被跟踪会话里出现 `tool/call` 且工具名为 `dispatch`
 *   （ADR 0006 之后的唯一派发入口）。未登记会话的 dispatch 一律不读、不算；
 *   别的工具、工具结果、用户消息都不是出发。
 * - **一个会话只起一次表。** 事件流会越来越长，同一条 dispatch 会被再次找到，
 *   所以「已经起过表」的会话 id 记在 {@link createTriggerState} 里，重复命中不再
 *   产第二份规划。
 * - **规划必须自带五要素。** 步骤、预估耗时、验收点、触发依据、已派 worker。
 *   能从 dispatch 参数读出来的就照实读；读不出来就写明「未声明」，不编。
 *
 * @module
 */

import { isTracked } from './secretary-registry.js'

/** 唯一的派发工具名。 */
const DISPATCH_TOOL = 'dispatch'

/**
 * 「预估耗时」的粗估基线：每个 worker 每个阶段按 10 分钟算。
 *
 * 这是一个**写在标签里的假设**，不是测量值：dispatch 参数里没有时长字段，宿主的
 * 会话日志也不记录预计用时。报告把 `basis` 与标签一起交出去，读的人一眼能看出这是
 * 估的；真要精确值，只能等票 05 的节拍按真实经过时间校正。
 */
export const STAGE_BASELINE_SECONDS = 600

/** 一个字符串字段：不是字符串就是空串，去掉首尾空白。 */
function readText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 一个对象字段：数组、null、标量都不算。 */
function readObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

/** 一个时间戳：有限、非负的数字，否则 0（与 secretary-registry 的读法一致）。 */
function readTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/** 折成一行，去掉换行与多余空白。 */
function oneLine(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 折成一行的展示文本：字符串原样折，别的 JSON 化（序列化不了就空串）。 */
function oneLineOf(value) {
  if (typeof value === 'string') return oneLine(value)
  try {
    const json = JSON.stringify(value)
    return typeof json === 'string' ? oneLine(json) : ''
  } catch {
    return ''
  }
}

/** 秒数说成人话。 */
function durationLabel(seconds) {
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`
}

/**
 * 一条事件是不是 dispatch 工具调用。
 *
 * 形状以 master-state.js 折叠 `tool/call` 的方式为准：类型是 `tool/call`，工具名在
 * `event.data.name`。名字两端空白仍算同一个工具；非字符串的 name（旧事件、残缺事件）
 * 一律不算。
 *
 * @param event - 任意值；不是事件对象就是 false，不抛错。
 * @returns 是否是一次 dispatch 调用。
 */
export function isDispatchCall(event) {
  const record = readObject(event)
  if (record === undefined || record.type !== 'tool/call') return false
  const data = readObject(record.data)
  if (data === undefined) return false
  return readText(data.name) === DISPATCH_TOOL
}

/** 把一条 dispatch 调用折成稳定形状，方便调用方与测试只依赖这几个字段。 */
function callOf(event) {
  const data = readObject(readObject(event)?.data) ?? {}
  return {
    callId: readText(data.callId),
    name: DISPATCH_TOOL,
    // 模型产出的原始 JSON 字符串，不解析：解析是 buildPlanReport 的事。
    arguments: typeof data.arguments === 'string' ? data.arguments : '',
  }
}

/**
 * 事件流里的一条：可以是 `{ sessionId, event }` 信封，也可以是自带 `sessionId`
 * 的裸事件（会话日志本身不带 id，id 在 Session 上，两种写法都有人用）。
 */
function pairOf(entry) {
  const record = readObject(entry)
  if (record === undefined) return undefined
  const inner = readObject(record.event)
  return { sessionId: readText(record.sessionId), event: inner ?? record }
}

/**
 * 在事件流里找**已跟踪会话**的第一条 dispatch 调用。
 *
 * @param events - `Array<{ sessionId, event } | event & { sessionId }>`；不是数组就是 null。
 * @param registry - 秘书登记表（secretaryMasterSessionId / secretaryOrchestrators）。
 * @returns `{ sessionId, at, call }`，或 null（没有已跟踪会话出发）。
 */
export function detectTrigger(events, registry) {
  if (!Array.isArray(events)) return null
  for (const entry of events) {
    const pair = pairOf(entry)
    if (pair === undefined || pair.sessionId === '') continue
    // 先做便宜的形状判断：这条监听每个事件都会被叫到，登记表只该在真命中时读。
    if (!isDispatchCall(pair.event)) continue
    // 未登记 = 不读、不报、不碰（spec 用户故事 2）。
    if (!isTracked(registry, pair.sessionId)) continue
    return { sessionId: pair.sessionId, at: readTimestamp(pair.event?.time), call: callOf(pair.event) }
  }
  return null
}

/**
 * 已经起过表的会话。
 *
 * 事件流只会变长，所以同一条 dispatch 会被反复找到；判断「是不是第一次」必须由调用方
 * 保存状态。`mark` 第一次返回 true，之后返回 false；空 id 永远不会被记住，也不会让
 * 整件事抛错。
 *
 * @returns `{ seen: Set, mark(sessionId), has(sessionId) }`
 */
export function createTriggerState() {
  const seen = new Set()
  return {
    seen,
    mark(sessionId) {
      const id = readText(sessionId)
      if (id === '') return false
      if (seen.has(id)) return false
      seen.add(id)
      return true
    },
    has(sessionId) {
      const id = readText(sessionId)
      return id !== '' && seen.has(id)
    },
  }
}

/** dispatch 参数：模型给的是原始 JSON 字符串，解析不出对象就当没给。 */
function planArguments(text) {
  const raw = readText(text)
  if (raw === '') return undefined
  try {
    return readObject(JSON.parse(raw))
  } catch {
    return undefined
  }
}

/** 预估耗时：有可估的规模就按基线粗估，否则明说未声明。 */
function estimateOf(workerCount, stageCount) {
  if (workerCount <= 0 || stageCount <= 0) {
    return { seconds: null, label: '未声明：派发参数里读不出可估的规模', basis: 'undisclosed' }
  }
  const seconds = workerCount * stageCount * STAGE_BASELINE_SECONDS
  const perStage = Math.round(STAGE_BASELINE_SECONDS / 60)
  return {
    seconds,
    label: `粗估约 ${durationLabel(seconds)}（按每 worker 每阶段 ${perStage} 分钟基线，非实测）`,
    basis: 'baseline',
  }
}

/**
 * 从 dispatch 参数推出步骤、预估与「即将派出」的 worker。
 *
 * 批量派发（有 items/stages）是一个 item 一个 worker、按 stages 顺序推进，所以步骤
 * 是阶段表；单任务是任务卡自己。批量没有任务卡，验收点就是空的——不编一个。
 */
function planOf(args, callId) {
  if (args === undefined) {
    return { steps: [], estimate: estimateOf(0, 0), acceptance: [], workers: [] }
  }

  const items = Array.isArray(args.items) ? args.items : []
  const stages = Array.isArray(args.stages) ? args.stages : []

  if (items.length === 0 && stages.length === 0) {
    const name = readText(args.description)
    const detail = oneLine(readText(args.prompt))
    const steps = name === '' && detail === '' ? [] : [{ index: 1, name: name === '' ? DISPATCH_TOOL : name, detail }]
    const acceptance = [readText(args.doneDefinition), readText(args.verify)].filter((text) => text !== '')
    const task = name === '' ? detail : name
    return {
      steps,
      estimate: estimateOf(1, 1),
      acceptance,
      workers: task === '' ? [] : [{ id: readText(callId), role: '', state: 'planned', task }],
    }
  }

  const steps = stages.map((stage, index) => {
    const record = readObject(stage) ?? {}
    return {
      index: index + 1,
      name: readText(record.name) || `阶段 ${index + 1}`,
      detail: oneLine(readText(record.prompt)),
    }
  })
  const workers = items.map((item, index) => ({
    id: `item-${index + 1}`,
    role: '',
    // 计划里的 worker 还不是会话，六态都不适用，所以用 plan 自己的词。
    state: 'planned',
    task: oneLineOf(item),
  }))
  return {
    steps,
    estimate: estimateOf(Math.max(items.length, 1), Math.max(stages.length, 1)),
    acceptance: [],
    workers,
  }
}

/** 会话的 id / 标题 / 工作区：Session 本身或它的 header 都认。 */
function sessionOf(session) {
  const record = readObject(session) ?? {}
  const header = readObject(record.header) ?? {}
  return {
    id: readText(record.id) || readText(header.id),
    title: readText(record.title) || readText(header.title),
    workspace: readText(record.workspace) || readText(record.cwd) || readText(header.cwd),
  }
}

/** 调用方手里已有的 worker 行（六态投影的行）：只取报告的四个字段。 */
function workerRows(workers) {
  if (!Array.isArray(workers)) return []
  const rows = []
  for (const [index, worker] of workers.entries()) {
    const record = readObject(worker)
    if (record === undefined) continue
    rows.push({
      id: readText(record.id) || `worker-${index + 1}`,
      role: readText(record.role),
      state: readText(record.state) || 'unknown',
      task: oneLine(readText(record.summary) || readText(record.task)),
    })
  }
  return rows
}

/**
 * 规划首报的结构化输入（交给 secretary-report 渲染）。
 *
 * 五要素都在返回值里，顺序固定：`steps`（步骤）、`estimate`（预估耗时）、
 * `acceptance`（验收点）、`trigger`（触发依据）、`workers`（已派 worker）。
 * `workers` 优先用调用方给的、已经存在的 worker 行；没有就用 dispatch 参数里「即将
 * 派出」的那些，并把 `state` 标成 `planned`，免得把计划当成事实。
 *
 * @param {object} input
 * @param session - 被跟踪的会话（Session 或 `{ id, title, header: { cwd } }`）。
 * @param trigger - {@link detectTrigger} 的返回值。
 * @param workers - 可选的已有 worker 行（`{ id, role, state, summary }`）。
 * @param now - 报告时刻（毫秒）。
 * @returns 规划报告输入对象；任何残缺输入都降级成空要素，不抛错。
 */
export function buildPlanReport({ session, trigger, workers, now } = {}) {
  const who = sessionOf(session)
  const call = readObject(trigger?.call) ?? {}
  const callId = readText(call.callId)
  const plan = planOf(planArguments(call.arguments), callId)
  const live = workerRows(workers)

  return {
    kind: 'plan',
    sessionId: who.id,
    title: who.title,
    workspace: who.workspace,
    at: readTimestamp(now),
    // 1 步骤
    steps: plan.steps,
    // 2 预估耗时
    estimate: plan.estimate,
    // 3 验收点
    acceptance: plan.acceptance,
    // 4 触发依据
    trigger: {
      kind: 'dispatch',
      tool: DISPATCH_TOOL,
      sessionId: readText(trigger?.sessionId) || who.id,
      at: readTimestamp(trigger?.at),
      callId,
    },
    // 5 已派 worker
    workers: live.length > 0 ? live : plan.workers,
  }
}
