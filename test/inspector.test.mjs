import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_IDLE_MS,
  REMINDER_CHANNELS,
  STUCK_REASONS,
  createInspector,
  judgeStuck,
} from '../lib/inspector.js'

const NOW = 10_000_000

test('the three criteria are exactly the spec ones, over the spec channels', () => {
  assert.deepEqual([...STUCK_REASONS], ['idle', 'retrying', 'waiting-approval'])
  assert.deepEqual([...REMINDER_CHANNELS], ['master-message', 'panel-dot', 'notification'])
  assert.equal(DEFAULT_IDLE_MS, 300000)
})

test('idle is "more than five minutes", not "five minutes"', () => {
  const boundary = judgeStuck({ lastToolAt: NOW - DEFAULT_IDLE_MS, now: NOW })
  assert.equal(boundary.stuck, false, 'exactly at the threshold is not stuck')
  const over = judgeStuck({ lastToolAt: NOW - DEFAULT_IDLE_MS - 1, now: NOW })
  assert.equal(over.stuck, true)
  assert.equal(over.reasons[0].reason, 'idle')
})

test('retrying and waiting for approval are judged on their own', () => {
  assert.deepEqual(judgeStuck({ now: NOW, retrying: true }).reasons.map((row) => row.reason), ['retrying'])
  assert.deepEqual(judgeStuck({ now: NOW, waitingApproval: true }).reasons.map((row) => row.reason), ['waiting-approval'])
  const all = judgeStuck({ lastToolAt: 0, now: NOW, retrying: true, waitingApproval: true })
  assert.deepEqual(all.reasons.map((row) => row.reason), ['idle', 'retrying', 'waiting-approval'])
})

test('a healthy worker produces nothing', () => {
  assert.deepEqual(judgeStuck({ lastToolAt: NOW - 1000, now: NOW }), { stuck: false, reasons: [] })
})

test('judging without an observation does not guess', () => {
  assert.equal(judgeStuck({ now: NOW }).stuck, false, 'no lastToolAt means no idle claim')
  assert.throws(() => judgeStuck({ now: Number.NaN }), /now must be a finite number/)
  assert.throws(() => judgeStuck({ now: NOW, idleMs: -1 }), /non-negative number/)
})

test('the same stuck condition is reported once, not every tick', () => {
  const inspector = createInspector({ now: () => NOW })
  const observation = { workerId: 'w1', lastToolAt: NOW - DEFAULT_IDLE_MS - 1 }

  const first = inspector.observe(observation)
  assert.deepEqual(first.reasons, ['idle'])
  assert.deepEqual(first.channels, [...REMINDER_CHANNELS])
  assert.equal(inspector.observe(observation), null, 'the second tick is silent')
})

test('a partial observation does not re-arm a reason it did not observe', () => {
  const inspector = createInspector({ now: () => NOW })
  const observation = { workerId: 'w1', lastToolAt: NOW - DEFAULT_IDLE_MS - 1 }
  assert.notEqual(inspector.observe(observation), null)
  // 只带「重试状态」的观察：它没带 idle 信号，所以 idle 不该被当成「已消失」。
  for (let tick = 0; tick < 5; tick += 1) {
    assert.equal(inspector.observe({ workerId: 'w1', retrying: false }), null)
    assert.equal(inspector.observe(observation), null, 'still the same ongoing condition')
  }
  assert.deepEqual(inspector.activeReasons('w1'), ['idle'])
})

test('a reason that actually clears and returns is a new event', () => {
  const inspector = createInspector({ now: () => NOW })
  const idle = { workerId: 'w1', lastToolAt: NOW - DEFAULT_IDLE_MS - 1 }
  assert.notEqual(inspector.observe(idle), null)
  // 工具又动了（这一 tick 真的观察到了 lastToolAt）→ 条件消失。
  assert.equal(inspector.observe({ workerId: 'w1', lastToolAt: NOW }), null)
  assert.deepEqual(inspector.activeReasons('w1'), [])
  assert.deepEqual(inspector.observe(idle).reasons, ['idle'])
})

test('waiting for approval is not repeated while it is still true', () => {
  const inspector = createInspector({ now: () => NOW })
  const waiting = { workerId: 'w1', lastToolAt: NOW, waitingApproval: true }
  assert.notEqual(inspector.observe(waiting), null)
  for (let tick = 0; tick < 5; tick += 1) {
    assert.equal(inspector.observe({ workerId: 'w1', lastToolAt: NOW }), null, 'activity ticks carry no approval signal')
    assert.equal(inspector.observe(waiting), null)
  }
})

test('two reasons at once produce one reminder that names both', () => {
  const inspector = createInspector({ now: () => NOW })
  const reminder = inspector.observe({ workerId: 'w1', lastToolAt: 0, retrying: true })
  assert.deepEqual(reminder.reasons, ['idle', 'retrying'])
  assert.equal(reminder.details.length, 2)
  assert.deepEqual(inspector.activeReasons('w1'), ['idle', 'retrying'])
})

test('ending a worker silences it even if it was never observed', () => {
  const inspector = createInspector({ now: () => NOW })
  inspector.end('never-seen')
  assert.equal(inspector.observe({ workerId: 'never-seen', lastToolAt: 0 }), null)
  assert.deepEqual(inspector.activeReasons('never-seen'), [])
})

test('after the worker ends, nothing more is reported', () => {
  const inspector = createInspector({ now: () => NOW })
  const idle = { workerId: 'w1', lastToolAt: 0 }
  assert.notEqual(inspector.observe(idle), null)
  inspector.end('w1')
  assert.equal(inspector.observe(idle), null)
  assert.deepEqual(inspector.activeReasons('w1'), [])
  assert.doesNotThrow(() => inspector.end('w1'))
})

test('workers are tracked independently', () => {
  const inspector = createInspector({ now: () => NOW })
  assert.notEqual(inspector.observe({ workerId: 'a', lastToolAt: 0 }), null)
  assert.equal(inspector.observe({ workerId: 'b', lastToolAt: NOW }), null)
  inspector.end('a')
  assert.notEqual(inspector.observe({ workerId: 'b', lastToolAt: 0 }), null)
})

test('an observation without a worker id is a programming error', () => {
  const inspector = createInspector({ now: () => NOW })
  assert.throws(() => inspector.observe({ lastToolAt: 0 }), /workerId is required/)
  assert.throws(() => inspector.end(''), /workerId is required/)
})

test('the module exposes no way to change, stop or send to a worker', () => {
  const inspector = createInspector({ now: () => NOW })
  for (const forbidden of ['interrupt', 'stop', 'send', 'restart', 'kill', 'notify']) {
    assert.equal(typeof inspector[forbidden], 'undefined', `inspector must not expose ${forbidden}`)
  }
})
