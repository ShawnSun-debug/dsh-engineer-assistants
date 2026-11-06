import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_BEAT_SECONDS, DEFAULT_MAX_RUN_SECONDS, createBeat } from '../lib/secretary-beat.js'

const MINUTE = 60_000

/**
 * A hand-driven clock and timer pair. Nothing here touches real time: `advance`
 * moves the virtual clock and runs every timer that falls due, earliest first, so a
 * nine-minute cadence is asserted in microseconds.
 */
function fakeTimer(startAt = 1_000_000) {
  let current = startAt
  let nextId = 1
  const pending = new Map()

  return {
    now: () => current,
    schedule(fn, ms) {
      const id = nextId
      nextId += 1
      pending.set(id, { id, fn, dueAt: current + ms })
      return id
    },
    cancel(id) {
      pending.delete(id)
    },
    advance(ms) {
      const target = current + ms
      for (;;) {
        let due
        for (const timer of pending.values()) {
          if (timer.dueAt <= target && (due === undefined || timer.dueAt < due.dueAt)) due = timer
        }
        if (due === undefined) break
        pending.delete(due.id)
        current = due.dueAt
        due.fn()
      }
      current = target
    },
    pendingCount: () => pending.size,
    pendingDelays: () => [...pending.values()].map((timer) => timer.dueAt - current),
  }
}

function harness({ beatSeconds, maxRunSeconds, onTick, onError } = {}) {
  const timer = fakeTimer()
  const ticks = []
  const errors = []
  const beat = createBeat({
    now: timer.now,
    schedule: timer.schedule,
    cancel: timer.cancel,
    onTick: onTick ?? ((info) => ticks.push(info)),
    onError: onError ?? ((error) => errors.push(error.message)),
    ...(beatSeconds === undefined ? {} : { beatSeconds }),
    ...(maxRunSeconds === undefined ? {} : { maxRunSeconds }),
  })
  return { beat, timer, ticks, errors }
}

test('the defaults are a three-minute beat under a two-hour cap', () => {
  assert.equal(DEFAULT_BEAT_SECONDS, 180)
  assert.equal(DEFAULT_MAX_RUN_SECONDS, 7200)

  const { beat, timer } = harness()
  assert.deepEqual(beat.status(), { running: false, startedAt: null, tickIndex: 0, stopReason: null })
  beat.start()
  assert.deepEqual(timer.pendingDelays(), [180 * 1000])
  assert.equal(beat.status().startedAt, timer.now())
})

test('advancing nine minutes produces three ticks numbered from one', () => {
  const { beat, timer, ticks } = harness()
  const startedAt = timer.now()
  beat.start()
  timer.advance(9 * MINUTE)

  assert.deepEqual(ticks.map((tick) => tick.tickIndex), [1, 2, 3])
  assert.deepEqual(ticks.map((tick) => tick.elapsedMs), [3 * MINUTE, 6 * MINUTE, 9 * MINUTE])
  assert.deepEqual(ticks.map((tick) => tick.startedAt), [startedAt, startedAt, startedAt])
  assert.equal(beat.status().tickIndex, 3)
  assert.equal(beat.status().running, true)
})

test('reaching the run limit stops the beat and no further tick fires', () => {
  const { beat, timer, ticks } = harness({ maxRunSeconds: 600 })
  beat.start()
  // 180s, 360s and 540s are inside the 600s cap; the 720s callback is past it.
  timer.advance(12 * MINUTE)

  assert.equal(ticks.length, 3)
  assert.equal(beat.status().running, false)
  assert.equal(beat.status().stopReason, 'max-run')
  assert.equal(timer.pendingCount(), 0)

  timer.advance(30 * MINUTE)
  assert.equal(ticks.length, 3)
})

test('stop cancels the timer and keeps the first reason', () => {
  const { beat, timer, ticks } = harness()
  beat.start()
  timer.advance(MINUTE)
  beat.stop('user-stop')

  assert.deepEqual(beat.status(), {
    running: false,
    startedAt: timer.now() - MINUTE,
    tickIndex: 0,
    stopReason: 'user-stop',
  })
  assert.equal(timer.pendingCount(), 0)

  timer.advance(30 * MINUTE)
  assert.equal(ticks.length, 0)

  beat.stop('max-run')
  assert.equal(beat.status().stopReason, 'user-stop')
})

test('starting twice does not arm two timers', () => {
  const { beat, timer, ticks } = harness()
  beat.start()
  beat.start()
  assert.equal(timer.pendingCount(), 1)

  timer.advance(3 * MINUTE)
  assert.deepEqual(ticks.map((tick) => tick.tickIndex), [1])
  timer.advance(3 * MINUTE)
  assert.deepEqual(ticks.map((tick) => tick.tickIndex), [1, 2])
})

test('a throwing tick does not stop the beat', () => {
  const attempts = []
  const { beat, timer, errors } = harness({
    onTick: (info) => {
      attempts.push(info.tickIndex)
      throw new Error(`tick ${info.tickIndex} failed`)
    },
  })
  beat.start()
  timer.advance(9 * MINUTE)

  assert.deepEqual(attempts, [1, 2, 3])
  assert.deepEqual(errors, ['tick 1 failed', 'tick 2 failed', 'tick 3 failed'])
  assert.equal(beat.status().running, true)
  assert.equal(beat.status().tickIndex, 3)
})

test('a tick that stops the beat leaves no timer behind', () => {
  const { beat, timer, ticks } = harness({
    onTick: (info) => {
      ticks.push(info)
      beat.stop('finished')
    },
  })
  beat.start()
  timer.advance(9 * MINUTE)

  assert.equal(ticks.length, 1)
  assert.equal(beat.status().stopReason, 'finished')
  assert.equal(timer.pendingCount(), 0)
})
