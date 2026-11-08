/**
 * 申请再派发（engineer-assistants 1.0.0 票 07）。
 *
 * 一句话：worker 干到一半发现「还得再派一个」，可以把请求抛回 master，**阻塞等批准**；
 * 批准由 master 代为派发，超时自动驳回。
 *
 * 三条规矩：
 *
 * - **能不能申请，由预设仓储说了算。** 这里不复制一份名单：`lib/presets.js` 的
 *   `mayRequestDispatch` 既认内置四套，也认得用户的覆盖（覆盖可以收回这个权限）。
 *   两份名单各说各话，迟早一边放行一边拒绝。
 * - **深度上限 2。** worker 自己是第 1 层，它申请出来的是第 2 层，再往下不存在；
 *   返回值里给 `childDepth`，master 照着派才不会把层数算回 1。
 * - **超时必须真的发生。** 计时器不能用 unref()：调用方正被这次等待阻塞着，进程不该因为
 *   「计时器不算活跃句柄」就提前退出，把驳回通知一起带走。
 *
 * 本模块不碰宿主：审批通道 `ask` 与超时回调由调用方注入。
 *
 * @module
 */

import { mayRequestDispatch } from './presets.js'

/** 允许申请再派发的预设（内置默认，真实判定走预设仓储）。 */
export const DISPATCH_PRESETS = Object.freeze(['implementer', 'debugger', 'refactorer', 'operator'])

/** 派发深度上限：worker 是第 1 层，最多再往下 1 层。 */
export const MAX_DEPTH = 2

/** 默认等待时间：十分钟。 */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/** 超时哨兵：与 true/false 区分开，避免和「用户点了拒绝」混为一谈。 */
const TIMEOUT = Symbol('request-dispatch timeout')

function readText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 审批答复：布尔或 `{ approved: boolean }` 都认，其它一律按拒绝。 */
function readApproval(answer) {
  if (answer === true) return true
  if (answer !== null && typeof answer === 'object' && answer.approved === true) return true
  return false
}

/** 校验一次申请；不合格直接抛错，让 worker 当场知道这条路走不通。 */
export function planRequest({ presetId, depth, request, presets } = {}) {
  const preset = readText(presetId)
  if (!mayRequestDispatch(presets ?? {}, preset)) {
    throw new Error(
      `request_dispatch: preset "${preset || '(none)'}" is not allowed to request a dispatch (only ${DISPATCH_PRESETS.join('/')})`,
    )
  }
  if (!Number.isInteger(depth) || depth < 1) {
    throw new TypeError(`request_dispatch: depth must be a positive integer (got ${String(depth)})`)
  }
  if (depth >= MAX_DEPTH) {
    throw new Error(`request_dispatch: depth ${depth} already at the limit of ${MAX_DEPTH}`)
  }
  const text = readText(request)
  if (text === '') throw new TypeError('request_dispatch: the request must be a non-empty string')
  return Object.freeze({ presetId: preset, depth, childDepth: depth + 1, request: text })
}

/**
 * 发起一次申请并等待结果。
 *
 * `ask(plan) => Promise<boolean | {approved}>` 是 master 侧的审批通道；`onTimeout(plan)`
 * 把「等了十分钟没人批」告诉用户，返回值里的 `notified` 说明这条通知是否真的发出去了。
 * reason 是 approved / declined / timeout。
 */
export async function requestDispatch({
  presetId,
  depth,
  request,
  presets,
  ask,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onTimeout,
} = {}) {
  const plan = planRequest({ presetId, depth, request, presets })
  if (typeof ask !== 'function') throw new TypeError('request_dispatch: no approval channel was installed')
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('request_dispatch: timeoutMs must be a positive integer')
  }

  let timer
  const timeout = new Promise((resolve) => {
    // 不 unref：调用方正被这次等待阻塞，进程提前退出等于把驳回悄悄吞掉。
    timer = setTimeout(() => resolve(TIMEOUT), timeoutMs)
  })

  let answer
  try {
    answer = await Promise.race([Promise.resolve(ask(plan)), timeout])
  } catch {
    // 通道抛错按拒绝处理，绝不当成批准。
    answer = false
  } finally {
    clearTimeout(timer)
  }

  if (answer === TIMEOUT) {
    let notified = false
    if (typeof onTimeout === 'function') {
      try {
        // 通知可能是异步的：不 await 会变成 verdict 之后的 unhandledRejection。
        await Promise.resolve(onTimeout(plan))
        notified = true
      } catch {
        notified = false
      }
    }
    return { approved: false, reason: 'timeout', request: plan, notified }
  }
  return readApproval(answer)
    ? { approved: true, reason: 'approved', request: plan, notified: false }
    : { approved: false, reason: 'declined', request: plan, notified: false }
}
