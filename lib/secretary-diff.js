/**
 * 实质变化判定（秘书 spec 票 05）。
 *
 * 每份报告都和上一份比一次，但只有五类变化值得打断用户：会话六态翻转、步骤推进、
 * 阻塞待拍板、产出落地、超时异常；其余变化只落盘、不冒泡。
 *
 * 纯逻辑：不读时钟、不写文件、不认识宿主。比较对象是 secretary-report 的
 * `summarizeForDiff` 压出来的结构（状态 / 步骤 / worker 名字与状态 / 产出路径），
 * 所以同一份摘要喂进来永远得到同一个答案。
 *
 * 读法：
 * - 第一份报告没有「上一份」，基线就是投影的初始态：Idle、没有步骤、没有 worker、
 *   没有产出。凡是已经越过这条基线的事实都算首次出现。
 * - 「新出现」一律按名字比：上一份里没有这个名字，或同名 worker 的状态不同。
 * - 失败不重复记进三组：{@link classifyChanges} 的 `timeout` 才是它的门，报告里
 *   worker 表与「耗时与异常」段仍然看得到它。
 *
 * @module
 */
import { WORKER_STATE, WORKER_STATES } from './master-state.js'
import { CHANGE_KINDS } from './secretary-constants.js'

/** 五种实质变化（类别名单一真源在 secretary-constants.js），顺序即报告与冒泡的顺序。 */
export { CHANGE_KINDS }

/** 投影的初始态：第一份报告的上一份就是这个样子。 */
const BASELINE_STATE = WORKER_STATE.idle
const NEEDS_INPUT = WORKER_STATE.needsInput
const COMPLETED = WORKER_STATE.completed
const FAILED = WORKER_STATE.failed
const UNNAMED_WORKER = '未命名 worker'

/** 把一个值当对象用；数组、null、标量都退化成空对象。 */
function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function countOf(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

/** 六态之一；缺失或写错都按投影的初始态 Idle 处理，差异比较才有稳定值。 */
function stateOf(value) {
  return WORKER_STATES.includes(value) ? value : BASELINE_STATE
}

/** 摘要归一：任何残缺输入都折成可比较的形状，不抛错。 */
function normalize(summary) {
  const source = asObject(summary)
  const step = asObject(source.step)
  const workers = []
  if (Array.isArray(source.workers)) {
    for (const raw of source.workers) {
      const worker = asObject(raw)
      workers.push({ name: textOf(worker.name) || UNNAMED_WORKER, state: stateOf(worker.state) })
    }
  }
  const artifacts = []
  if (Array.isArray(source.artifacts)) {
    for (const raw of source.artifacts) {
      const text = textOf(raw)
      if (text !== '') artifacts.push(text)
    }
  }
  return {
    state: stateOf(source.state),
    index: countOf(step.index),
    total: countOf(step.total),
    workers,
    artifacts,
  }
}

function namesToStates(workers) {
  const states = new Map()
  for (const worker of workers) states.set(worker.name, worker.state)
  return states
}

function stepLine(step) {
  return step.total > 0 ? `进度：第 ${step.index} 步 / 共 ${step.total} 步` : `进度：第 ${step.index} 步`
}

/**
 * 把两份摘要的差异分成人读的三组。
 *
 * 入参是 `summarizeForDiff` 的输出；`previous` 缺失时按基线比较。返回
 * `{ completed, blocked, flipped }`，每项是可直接进报告的短句，顺序稳定。
 */
export function diffSummaries(previous, next) {
  const before = normalize(previous)
  const after = normalize(next)
  const completed = []
  const blocked = []
  const flipped = []

  if (after.index > before.index) completed.push(stepLine(after))

  const delivered = new Set(before.artifacts)
  for (const artifact of after.artifacts) {
    if (!delivered.has(artifact)) completed.push(`产出：${artifact}`)
  }

  const knownStates = namesToStates(before.workers)
  for (const worker of after.workers) {
    const was = knownStates.get(worker.name)
    if (was === undefined) {
      // 首次出现的 worker 只归档一次：卡住归 blocked，其余（含 Working）算进展。
      if (worker.state === NEEDS_INPUT) blocked.push(`${worker.name}：等确认`)
      else if (worker.state !== FAILED) completed.push(`${worker.name}：首次出现（${worker.state}）`)
      continue
    }
    if (was === worker.state) continue
    if (worker.state === COMPLETED) completed.push(`${worker.name}：完成`)
    else if (worker.state === NEEDS_INPUT) blocked.push(`${worker.name}：等确认`)
    else flipped.push(`${worker.name}：${was} → ${worker.state}`)
  }

  if (after.state === NEEDS_INPUT && before.state !== NEEDS_INPUT) blocked.push(`会话进入 ${NEEDS_INPUT}`)
  if (after.state !== before.state) flipped.push(`会话：${before.state} → ${after.state}`)

  return { completed, blocked, flipped }
}

/** 开着的类别。传进来不是数组就算全开：拼错参数不该悄悄关掉全部提醒。 */
function enabledKinds(enabled) {
  if (!Array.isArray(enabled)) return new Set(CHANGE_KINDS)
  return new Set(enabled.filter((kind) => typeof kind === 'string'))
}

/**
 * 命中哪几类实质变化，按 {@link CHANGE_KINDS} 的顺序返回；`enabled` 里关掉的
 * 类别直接消失，而不是降级成一个布尔。
 */
export function classifyChanges(previous, next, enabled) {
  const before = normalize(previous)
  const after = normalize(next)
  const gates = enabledKinds(enabled)
  const knownStates = namesToStates(before.workers)

  const gatesOfKind = {
    'state-flip': () => after.state !== before.state,
    'step-advance': () => after.index > before.index,
    blocked: () =>
      (after.state === NEEDS_INPUT && before.state !== NEEDS_INPUT) ||
      after.workers.some((worker) => worker.state === NEEDS_INPUT && knownStates.get(worker.name) !== NEEDS_INPUT),
    deliverable: () => {
      const delivered = new Set(before.artifacts)
      return after.artifacts.some((artifact) => !delivered.has(artifact))
    },
    timeout: () => after.workers.some((worker) => worker.state === FAILED && knownStates.get(worker.name) !== FAILED),
  }

  return CHANGE_KINDS.filter((kind) => gates.has(kind) && gatesOfKind[kind]())
}

/** 这一拍值不值得打扰用户：命中任意一类算实质变化。 */
export function isSubstantial(previous, next, enabled) {
  return classifyChanges(previous, next, enabled).length > 0
}
