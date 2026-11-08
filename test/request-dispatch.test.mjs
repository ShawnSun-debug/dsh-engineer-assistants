import assert from 'node:assert/strict'
import test from 'node:test'

import { overridePresets } from '../lib/presets.js'
import {
  DEFAULT_TIMEOUT_MS,
  DISPATCH_PRESETS,
  MAX_DEPTH,
  planRequest,
  requestDispatch,
} from '../lib/request-dispatch.js'

const base = { presetId: 'implementer', depth: 1, request: 'verify the migrations on a scratch database' }

test('the four coding presets may ask, the rest may not', () => {
  assert.deepEqual([...DISPATCH_PRESETS], ['implementer', 'debugger', 'refactorer', 'operator'])
  for (const presetId of ['researcher', 'scout', 'reviewer', 'writer', 'synthesizer', 'ghost', '']) {
    assert.throws(() => planRequest({ ...base, presetId }), /is not allowed to request a dispatch/)
  }
  for (const presetId of DISPATCH_PRESETS) {
    assert.equal(planRequest({ ...base, presetId }).presetId, presetId)
  }
})

test('the verdict comes from the preset store, so an override can revoke it', () => {
  const presets = overridePresets({}, 'implementer', { mayRequestDispatch: false })
  assert.throws(() => planRequest({ ...base, presets }), /is not allowed to request a dispatch/)
  // 没被收回的预设照旧可以。
  assert.doesNotThrow(() => planRequest({ ...base, presetId: 'debugger', presets }))
})

test('the depth limit is two, and the child depth is stated', () => {
  assert.equal(MAX_DEPTH, 2)
  assert.equal(planRequest({ ...base, depth: 1 }).childDepth, 2)
  assert.throws(() => planRequest({ ...base, depth: 2 }), /already at the limit of 2/)
  assert.throws(() => planRequest({ ...base, depth: 0 }), /depth must be a positive integer/)
  assert.throws(() => planRequest({ ...base, depth: 1.5 }), /depth must be a positive integer/)
})

test('an empty request is refused', () => {
  assert.throws(() => planRequest({ ...base, request: '  ' }), /the request must be a non-empty string/)
})

test('an approved request carries a literal plan', async () => {
  const result = await requestDispatch({ ...base, ask: () => true })
  assert.deepEqual(result, {
    approved: true,
    reason: 'approved',
    request: { presetId: 'implementer', depth: 1, childDepth: 2, request: base.request },
    notified: false,
  })
})

test('a richer approval is still an approval', async () => {
  assert.equal((await requestDispatch({ ...base, ask: () => ({ approved: true }) })).approved, true)
  assert.equal((await requestDispatch({ ...base, ask: () => 1 })).approved, false)
  assert.equal((await requestDispatch({ ...base, ask: () => 'yes' })).approved, false)
})

test('a declined request carries the same literal plan', async () => {
  const result = await requestDispatch({ ...base, ask: () => false })
  assert.deepEqual(result, {
    approved: false,
    reason: 'declined',
    request: { presetId: 'implementer', depth: 1, childDepth: 2, request: base.request },
    notified: false,
  })
})

test('silence for the whole window rejects, and says whether the user was told', async () => {
  const started = Date.now()
  const told = await requestDispatch({
    ...base,
    ask: () => new Promise(() => {}),
    timeoutMs: 30,
    onTimeout: () => { throw new Error('notification failed') },
  })
  assert.equal(told.reason, 'timeout')
  assert.equal(told.notified, false)

  const silent = await requestDispatch({ ...base, ask: () => new Promise(() => {}), timeoutMs: 20 })
  assert.equal(silent.notified, false)
  assert.ok(Date.now() - started < 3000)
})

test('an asynchronous notifier is awaited', async () => {
  const seen = []
  const result = await requestDispatch({
    ...base,
    ask: () => new Promise(() => {}),
    timeoutMs: 20,
    onTimeout: async (plan) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      seen.push(plan.presetId)
    },
  })
  assert.equal(result.notified, true)
  assert.deepEqual(seen, ['implementer'])
})

test('an answer that arrives after the deadline does not flip the verdict', async () => {
  let resolveLate
  const result = await requestDispatch({
    ...base,
    ask: () => new Promise((resolve) => { resolveLate = resolve }),
    timeoutMs: 20,
  })
  assert.equal(result.reason, 'timeout')
  resolveLate(true)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(result.approved, false)
})

test('the default window is ten minutes', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 600000)
})

test('a broken approval channel is refused before waiting', async () => {
  await assert.rejects(() => requestDispatch({ ...base }), /no approval channel/)
  await assert.rejects(() => requestDispatch({ ...base, ask: () => true, timeoutMs: 0 }), /timeoutMs must be a positive integer/)
})

test('an ask that rejects is a decline, never an approval', async () => {
  const result = await requestDispatch({ ...base, ask: () => Promise.reject(new Error('channel down')) })
  assert.equal(result.approved, false)
  assert.equal(result.reason, 'declined')
})
