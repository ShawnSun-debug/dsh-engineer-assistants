/**
 * 冒泡投递（秘书 spec 票 05）。
 *
 * 秘书只在该打扰的时候说一句话：实质变化命中时，把一条短消息投进用户当前会话。
 * 这个模块只做三件事——挑接收方、把命中的类别拼成一句话、把投递失败变成返回值。
 * 真正的跨会话语义（running 走 inject、idle 走 followup，随后 flush）在
 * lib/master-messaging.js 的 `deliverMessage` 里；这里不复制它，`messaging` 由
 * 调用方注入一个 `deliver(target, text)` 的薄适配器。
 *
 * 不读时钟、不写文件、不认识宿主，也不抛错：投递失败只影响「这一拍没说话」，
 * 已经落盘的报告不受影响。
 *
 * @module
 */

/** 一条冒泡的上限：通知不是报告，超过就截断。 */
const MAX_BUBBLE_CHARS = 300

/** 五类变化说成人话；认不出的名字直接忽略，不当成「全部打开」。 */
const KIND_LABELS = Object.freeze({
  'state-flip': '状态翻转',
  'step-advance': '步骤推进',
  blocked: '阻塞待拍板',
  deliverable: '产出落地',
  timeout: '超时异常',
})

function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function countOf(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}

function messageOf(error) {
  if (error instanceof Error) return error.message || error.name
  return String(error)
}

/** 按字截断：一条冒泡永远一行、永远不超过上限。 */
function clamp(text) {
  const chars = [...text]
  if (chars.length <= MAX_BUBBLE_CHARS) return text
  return `${chars.slice(0, MAX_BUBBLE_CHARS - 1).join('')}…`
}

/** 一句话关键信息：会话状态、步骤、第一个产出，能读到哪个写哪个。 */
function keyLineOf(summary) {
  const source = asObject(summary)
  const parts = []
  const state = textOf(source.state)
  if (state !== '') parts.push(state)
  const step = asObject(source.step)
  const index = countOf(step.index)
  const total = countOf(step.total)
  if (index !== null) parts.push(total !== null ? `第 ${index} 步 / 共 ${total} 步` : `第 ${index} 步`)
  if (Array.isArray(source.artifacts) && source.artifacts.length > 0) {
    const first = textOf(source.artifacts[0])
    if (first !== '') parts.push(first)
  }
  return parts.join('，')
}

/**
 * 挑冒泡的接收方。
 *
 * 只有「已经声明的 Master 会话」算接收方：registry 优先（运行时登记表），其次是
 * config 里同一个值的另一种读法。拿不到就返回 null——不退回触发会话，也不拿名单里
 * 第一个 orchestrator 顶替，猜错接收方比不说更糟。
 *
 * `triggerSessionId` 只在签名里出现，故意不参与判断。
 */
export function pickTarget({ registry, config } = {}) {
  const reg = asObject(registry)
  const cfg = asObject(config)
  const declared = textOf(reg.masterSessionId) || textOf(cfg.secretaryMasterSessionId) || textOf(cfg.masterSessionId)
  return declared === '' ? null : declared
}

/**
 * 把命中的类别与一句关键信息拼成一条冒泡。
 *
 * `changes` 是 {@link import('./secretary-diff.js').classifyChanges} 的返回值；
 * `summary` 是 secretary-report 的 `summarizeForDiff`。认不出的类别忽略，长文本截断，
 * 任何残缺输入都降级成一句话而不是抛错。
 */
export function bubbleText({ changes, summary } = {}) {
  const kinds = Array.isArray(changes) ? changes.map(textOf).filter((kind) => kind !== '') : []
  const labels = kinds.map((kind) => KIND_LABELS[kind]).filter((label) => label !== undefined)
  const head = labels.length === 0 ? '暂无可报的变化' : labels.join('、')
  const key = keyLineOf(summary)
  return clamp(key === '' ? `秘书：${head}` : `秘书：${head}｜${key}`)
}

/**
 * 投递一条冒泡。
 *
 * @param messaging - 注入的投递器：`deliver(target, text)`，返回的 `{ delivered: false, reason }`
 *   会被原样采信（例如目标会话已被删除）。
 * @param target - {@link pickTarget} 的结果；null/空串直接算未投递，一次都不调用投递器。
 * @param text - {@link bubbleText} 的结果。
 * @returns `{ delivered: true }` 或 `{ delivered: false, reason }`；异常一律变成 reason。
 */
export async function deliver({ messaging, target, text } = {}) {
  const to = textOf(target)
  if (to === '') return { delivered: false, reason: 'no-target' }
  const send = asObject(messaging).deliver
  if (typeof send !== 'function') return { delivered: false, reason: 'no-messaging' }

  try {
    const result = await send(to, text)
    if (result !== null && typeof result === 'object' && result.delivered === false) {
      const reason = textOf(result.reason)
      return { delivered: false, reason: reason === '' ? 'refused' : reason }
    }
    return { delivered: true }
  } catch (error) {
    return { delivered: false, reason: messageOf(error) }
  }
}
