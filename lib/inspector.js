/**
 * 监工（engineer-assistants 1.0.0 票 09）。
 *
 * 一句话：只读地盯着 worker 的关键事件，按三条判据认出「卡住了」，然后交出一条提醒。
 * **不读模型、不改任何东西、不中断任何会话**——它连宿主都只读。
 *
 * 三条判据（spec 第 7 节）：`idle`（超过 5 分钟没有工具调用）、`retrying`（出错重试中）、
 * `waiting-approval`（在等批准）。
 *
 * 四条规矩：
 *
 * - **边界是「超过」，不是「达到」。** 正好 5 分钟不算卡住。
 * - **只有真的消失才算消失。** 一条观察可能只带部分信号（这一 tick 只看到「有没有工具调用」），
 *   缺信号不等于「这条理由没了」。把缺失当消失，会让同一个卡点每两 tick 重复提醒一次。
 * - **结束即静音，哪怕这个 worker 从没被观察过。** `end` 先立墓碑：之后任何观察都返回空。
 * - **只有一条投递路径。** 提醒从 `observe` 返回，模块自己不调任何发送函数——两条路径会让
 *   接线方重复发同一件事。
 *
 * @module
 */

/** 默认的「无工具调用」阈值：5 分钟。 */
export const DEFAULT_IDLE_MS = 5 * 60 * 1000

/** 三条判据。 */
export const STUCK_REASONS = Object.freeze(['idle', 'retrying', 'waiting-approval'])

/** 三条提醒通道（spec 第 7 节）。 */
export const REMINDER_CHANNELS = Object.freeze(['master-message', 'panel-dot', 'notification'])

/** 这条观察里是否真的带了该判据的信号。缺信号 ≠ 条件消失。 */
function hasSignal(observation, reason) {
  if (reason === 'idle') return Number.isFinite(observation.lastToolAt)
  if (reason === 'retrying') return typeof observation.retrying === 'boolean'
  if (reason === 'waiting-approval') return typeof observation.waitingApproval === 'boolean'
  return false
}

/**
 * 判据：给一份观察，回答「卡没卡、卡在哪」。
 * `lastToolAt` 缺省时不算 idle——没观测到就不猜。
 */
export function judgeStuck({
  lastToolAt,
  now,
  retrying = false,
  waitingApproval = false,
  idleMs = DEFAULT_IDLE_MS,
} = {}) {
  if (!Number.isFinite(now)) throw new TypeError('judgeStuck: now must be a finite number')
  if (!Number.isFinite(idleMs) || idleMs < 0) throw new TypeError('judgeStuck: idleMs must be a non-negative number')

  const reasons = []
  if (Number.isFinite(lastToolAt) && now - lastToolAt > idleMs) {
    reasons.push({ reason: 'idle', detail: `no tool call for ${Math.round((now - lastToolAt) / 60000)} min` })
  }
  if (retrying === true) reasons.push({ reason: 'retrying', detail: 'the worker is retrying after an error' })
  if (waitingApproval === true) reasons.push({ reason: 'waiting-approval', detail: 'the worker is waiting for an approval' })

  return { stuck: reasons.length > 0, reasons }
}

/**
 * 监工实例。`observe` 喂一次观察；有新情况时返回提醒，否则返回 null。
 * 返回的提醒由调用方送到三条通道——模块不自己发。
 */
export function createInspector({ idleMs = DEFAULT_IDLE_MS, now = () => Date.now() } = {}) {
  /** workerId -> { active: Set<reason>, ended: boolean }。墓碑保留到进程结束（数量以 worker 数为界）。 */
  const workers = new Map()

  const stateOf = (workerId) => {
    let state = workers.get(workerId)
    if (state === undefined) {
      state = { active: new Set(), ended: false }
      workers.set(workerId, state)
    }
    return state
  }

  return {
    observe(observation = {}) {
      const workerId = typeof observation.workerId === 'string' ? observation.workerId.trim() : ''
      if (workerId === '') throw new TypeError('inspector.observe: a workerId is required')
      const state = stateOf(workerId)
      if (state.ended) return null

      const verdict = judgeStuck({ ...observation, now: observation.now ?? now(), idleMs })
      const current = new Set(verdict.reasons.map((row) => row.reason))

      // 只清「这一 tick 真的观察到该信号、且条件不再成立」的理由。
      for (const reason of [...state.active]) {
        if (current.has(reason)) continue
        if (!hasSignal(observation, reason)) continue
        state.active.delete(reason)
      }

      const fresh = verdict.reasons.filter((row) => !state.active.has(row.reason))
      if (fresh.length === 0) return null
      for (const row of fresh) state.active.add(row.reason)

      return {
        workerId,
        reasons: fresh.map((row) => row.reason),
        details: fresh.map((row) => row.detail),
        channels: [...REMINDER_CHANNELS],
        at: observation.now ?? now(),
      }
    },

    /** worker 结束：先把墓碑立起来，再从没观察过也不会漏。 */
    end(workerId) {
      const id = typeof workerId === 'string' ? workerId.trim() : ''
      if (id === '') throw new TypeError('inspector.end: a workerId is required')
      const state = stateOf(id)
      state.ended = true
      state.active.clear()
    },

    /** 当前仍然「已知卡着」的理由（给面板红点用）。 */
    activeReasons(workerId) {
      const state = workers.get(workerId)
      if (state === undefined || state.ended) return []
      return [...state.active]
    },
  }
}
