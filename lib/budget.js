/**
 * 预算与失败重试（engineer-assistants 1.0.0 票 14）。
 *
 * 一句话：每个 worker 有分钟数与 token 的上限，**超了只报告、不自动砍**；失败由宿主自动重试
 * 一次，仍失败就同时报给 master 与 inspector，重试次数回到登记行（`assignments` 的
 * `retries` 字段）。
 *
 * 三条规矩：
 *
 * - **软预算。** 超限的含义是「该问人了」，不是「该杀进程」。
 * - **重试有上限。** 只重试一次；第二次失败直接上报。
 * - **次数要落地。** `retryDecision` 给出的 `retries` 就是要写回登记行的值，且永不超过上限。
 *
 * 预算可以只给一维：缺的那一维按 `DEFAULT_BUDGET` 补，而不是变成无限——「只设了分钟数」
 * 不该等于「token 随便花」。
 *
 * @module
 */

/** 默认软预算：30 分钟 / 20 万 token。 */
export const DEFAULT_BUDGET = Object.freeze({ minutes: 30, tokens: 200_000 })

/** 本模块的重试上限。与旧的 `lib/retry.js` 策略（2 次）不是同一套，名字分开避免误用。 */
export const BUDGET_MAX_RETRIES = 1

function readNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative finite number (got ${String(value)})`)
  }
  return value
}

function readLimit(value, label, fallback) {
  if (value === undefined) return fallback
  return readNumber(value, label)
}

/** 把一份用量与预算对照，返回是否超限、超在哪一项、以及一句能直接发给人看的话。 */
export function evaluateBudget({ budget = DEFAULT_BUDGET, usage, workerId } = {}) {
  if (usage === null || typeof usage !== 'object') {
    throw new TypeError('evaluateBudget: usage must be an object')
  }
  if (budget === null || typeof budget !== 'object') {
    throw new TypeError('evaluateBudget: budget must be an object')
  }
  const minutes = readNumber(usage.minutes ?? 0, 'usage.minutes')
  const tokens = readNumber(usage.tokens ?? 0, 'usage.tokens')
  // 只给一维时另一维用默认值补齐：缺键不等于无限。
  const maxMinutes = readLimit(budget.minutes, 'budget.minutes', DEFAULT_BUDGET.minutes)
  const maxTokens = readLimit(budget.tokens, 'budget.tokens', DEFAULT_BUDGET.tokens)

  const reasons = []
  if (minutes > maxMinutes) reasons.push(`ran ${minutes} min (limit ${maxMinutes})`)
  if (tokens > maxTokens) reasons.push(`used ${tokens} tokens (limit ${maxTokens})`)

  const who = typeof workerId === 'string' && workerId !== '' ? `worker "${workerId}" ` : 'worker '
  return {
    exceeded: reasons.length > 0,
    reasons,
    message: reasons.length === 0 ? '' : `${who}over budget: ${reasons.join('; ')}. Continue or stop?`,
    usage: { minutes, tokens },
    budget: { minutes: maxMinutes, tokens: maxTokens },
  }
}

/**
 * 一次失败之后要不要重试。`attempt` 是已经失败的次数（第一次失败传 1）。
 * 返回要写回登记行的 `retries` 与「这次之后还余不余」。
 */
export function retryDecision({ attempt, maxRetries = BUDGET_MAX_RETRIES } = {}) {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new TypeError(`retryDecision: attempt must be a positive integer (got ${String(attempt)})`)
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new TypeError('retryDecision: maxRetries must be a non-negative integer')
  }
  const retries = Math.min(attempt, maxRetries)
  return { retry: attempt <= maxRetries, retries, attempt, maxRetries }
}

/**
 * 二次失败要发给 master 与 inspector 的那句话。校验与 `retryDecision` 同源：
 * 次数是给人看的，不能出现 `undefined` 或 `1.5 attempts`。
 */
export function describeFailure({ workerId, attempt = 1, error, retries } = {}) {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new TypeError(`describeFailure: attempt must be a positive integer (got ${String(attempt)})`)
  }
  // 第 N 次失败之前已经重试过 N-1 次：「失败之后重试了几次」与「总共试了几次」是两件事。
  const usedRetries = retries === undefined ? attempt - 1 : retries
  if (!Number.isInteger(usedRetries) || usedRetries < 0) {
    throw new TypeError(`describeFailure: retries must be a non-negative integer (got ${String(usedRetries)})`)
  }
  // N 次尝试最多用过 N-1 次重试：相等也说明这两个数是拼出来的。
  if (usedRetries > attempt - 1) {
    throw new TypeError(`describeFailure: retries (${usedRetries}) cannot reach attempts (${attempt})`)
  }
  const id = typeof workerId === 'string' && workerId !== '' ? workerId : 'unknown worker'
  const cause = error instanceof Error ? error.message : String(error ?? 'no error recorded')
  return `worker "${id}" failed after ${usedRetries} retr${usedRetries === 1 ? 'y' : 'ies'} (${attempt} attempt${attempt === 1 ? '' : 's'}): ${cause}`
}
