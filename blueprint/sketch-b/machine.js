export const PHASES = { PLAN: 'plan', REVIEW: 'review', DISPATCH: 'dispatch', SETTLE: 'settle', BLOCKED: 'blocked' }

export const EVENTS = ['planned', 'reviewed', 'dispatched', 'worker-done', 'settled', 'blocked']

export const TRANSITIONS = Object.freeze({
  plan: { planned: 'review' },
  review: { reviewed: 'dispatch', blocked: 'plan' },
  dispatch: { dispatched: 'dispatch', 'worker-done': 'settle' },
  settle: { settled: 'done' },
})

/** 非法转移直接抛错，不静默留在原状态。 */
export function transition(state, event) {
  throw new Error('not implemented')
}

/** 一次派发 = 一条事件日志；state 是投影，可断电重放。 */
export function replay(log, initial = { phase: 'plan' }) {
  throw new Error('not implemented')
}

export function isTerminal(phase) {
  throw new Error('not implemented')
}