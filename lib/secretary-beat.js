/**
 * The secretary's beat: a slow, self-limiting timer.
 *
 * Why this exists: the secretary reports on a registered orchestrator session every
 * few minutes, but a run can be stuck for hours. An endless `setInterval` would keep
 * writing reports for a run that is already dead, so the cadence is bounded — it
 * stops at the run cap or on a stop signal, and never fires after that.
 *
 * Dependency-free and pure: the clock, the timer and the tick handler are all
 * injected, so the whole cadence is asserted by pushing virtual time forward in a
 * test rather than waiting three minutes per tick. Nothing here imports a host
 * module or calls `setInterval`; wiring this into the plugin is the host adapter's
 * job.
 */

/** One tick every three minutes unless configured otherwise. */
export const DEFAULT_BEAT_SECONDS = 180

/** A run is reported for at most two hours, so a stuck run cannot write forever. */
export const DEFAULT_MAX_RUN_SECONDS = 7200

/** `stop()` without a reason records this one. */
const DEFAULT_STOP_REASON = 'stopped'

/** Why the beat stopped itself: the run hit its cap. */
const MAX_RUN_REASON = 'max-run'

/** Seconds to milliseconds, rejecting junk in favour of the documented default. */
function toMs(value, fallbackSeconds) {
  const seconds = Number(value)
  const usable = Number.isFinite(seconds) && seconds > 0 ? seconds : fallbackSeconds
  return Math.max(1, Math.round(usable * 1000))
}

function asFunction(value, fallback) {
  return typeof value === 'function' ? value : fallback
}

function stopReasonOf(reason) {
  return typeof reason === 'string' && reason !== '' ? reason : DEFAULT_STOP_REASON
}

/**
 * Build one beat.
 *
 * - `now()`: milliseconds since the epoch; called once at `start()` and on each tick.
 * - `schedule(fn, ms)` / `cancel(handle)`: the timer pair (default
 *   `setTimeout` / `clearTimeout`). One timer is armed at a time.
 * - `onTick({ tickIndex, startedAt, elapsedMs })`: `tickIndex` counts from 1 within
 *   the current run. A throw is reported to `onError` and the beat continues.
 * - `onError(error)`: optional; a throwing handler is swallowed too.
 * - `beatSeconds` / `maxRunSeconds`: seconds, positive; junk falls back to the
 *   defaults.
 *
 * The cap is checked when a tick falls due: if that tick would be at or past
 * `maxRunSeconds`, it does not fire, the beat stops itself with reason
 * `'max-run'`, and no timer is re-armed. `stop(reason)` cancels immediately and
 * keeps the first reason it was given; calling it again changes nothing.
 * `start()` is idempotent while running and starts a fresh run once stopped
 * (tick count and timestamps reset).
 */
export function createBeat(options = {}) {
  const opts = options !== null && typeof options === 'object' ? options : {}
  const beatMs = toMs(opts.beatSeconds, DEFAULT_BEAT_SECONDS)
  const maxMs = toMs(opts.maxRunSeconds, DEFAULT_MAX_RUN_SECONDS)
  const now = asFunction(opts.now, Date.now)
  const schedule = asFunction(opts.schedule, setTimeout)
  const cancel = asFunction(opts.cancel, clearTimeout)
  const onTick = asFunction(opts.onTick, () => {})
  const onError = asFunction(opts.onError, null)

  let running = false
  let startedAt = null
  let tickIndex = 0
  let stopReason = null
  let handle = null
  // Bumped on every state change, so a timer that was cancelled but still fires
  // cannot tick into a run it no longer belongs to.
  let generation = 0

  const readNow = () => {
    try {
      const value = Number(now())
      return Number.isFinite(value) ? value : Date.now()
    } catch {
      return Date.now()
    }
  }

  const reportError = (error) => {
    if (onError === null) return
    try {
      onError(error)
    } catch {
      // An error handler must not break the beat either.
    }
  }

  function stop(reason) {
    // Idempotent: a second call must not overwrite the first reason, and a beat
    // that never started has nothing to cancel.
    if (!running) return
    running = false
    generation += 1
    stopReason = stopReasonOf(reason)
    const pending = handle
    handle = null
    if (pending === null) return
    try {
      cancel(pending)
    } catch {
      // A timer the host already dropped cannot be cancelled again; the
      // generation check keeps it from ticking anyway.
    }
  }

  const arm = () => {
    const token = generation
    handle = schedule(() => {
      handle = null
      if (!running || token !== generation) return
      const elapsedMs = Math.max(0, readNow() - startedAt)
      if (elapsedMs >= maxMs) {
        stop(MAX_RUN_REASON)
        return
      }
      tickIndex += 1
      try {
        onTick({ tickIndex, startedAt, elapsedMs })
      } catch (error) {
        reportError(error)
      }
      // A handler may stop the beat; re-arming then would leak a timer.
      if (!running) return
      arm()
    }, beatMs)
  }

  function start() {
    // Idempotent while running: a second call must not arm a second timer.
    if (running) return
    running = true
    generation += 1
    startedAt = readNow()
    tickIndex = 0
    stopReason = null
    arm()
  }

  function status() {
    return { running, startedAt, tickIndex, stopReason }
  }

  return { start, stop, status }
}
