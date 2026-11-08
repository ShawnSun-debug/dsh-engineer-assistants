import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_TIMEOUT_MS } from '../lib/danger.js'
import {
  ATTENTION_REASONS,
  badgeOf,
  confirmationCardsOf,
  navigationTargetOf,
} from '../lib/panel-surface.js'

const live = (sessionId, extra = {}) => ({ sessionId, presetId: 'implementer', category: 'code', status: 'running', startedAt: 1000, ...extra })
const modelOf = (...workers) => ({ fixed: [], workers, tabs: [], activeTab: null })

test('the attention reasons are the two that actually need a person', () => {
  assert.deepEqual([...ATTENTION_REASONS], ['stuck', 'awaiting-approval'])
})

test('the badge counts workers that need a person, once each', () => {
  const model = modelOf(live('w1'), live('w2'), live('w3'))
  const badge = badgeOf({
    model,
    attention: {
      // 两个原因都命中同一个 worker，也只能算一次。
      w1: ['stuck', 'awaiting-approval'],
      w2: ['awaiting-approval'],
      // 已经结束的 worker 不在列表里，红点不该为它亮。
      w9: ['stuck'],
      // 未知原因不是「需要人」的理由。
      w3: ['slow'],
    },
  })
  assert.equal(badge.count, 2, 'w1 and w2 need a person; w9 is gone and w3 only says "slow"')
  assert.deepEqual(badge.sessionIds, ['w1', 'w2'])
  assert.deepEqual(badge.byReason, { stuck: 1, 'awaiting-approval': 2 })
})

test('no attention means no badge, not an undefined badge', () => {
  const badge = badgeOf({ model: modelOf(live('w1')) })
  assert.equal(badge.count, 0)
  assert.deepEqual(badge.sessionIds, [])
  assert.deepEqual(badge.byReason, { stuck: 0, 'awaiting-approval': 0 })
  // 空数组、重复原因、空 id 都不会让计数漂移。
  const messy = badgeOf({ model: modelOf(live('w1')), attention: { '': ['stuck'], w1: ['stuck', 'stuck'] } })
  assert.equal(messy.count, 1)
  assert.deepEqual(messy.byReason, { stuck: 1, 'awaiting-approval': 0 })
})

test('the badge refuses a non-model and a non-object attention map', () => {
  assert.throws(() => badgeOf({ model: null }), /panel model is required/)
  assert.throws(() => badgeOf({ model: {} }), /panel model is required/)
  assert.throws(() => badgeOf({ model: modelOf(), attention: 'w1' }), /attention must be an object/)
})

test('a session id is a usable target when nothing resolves it to an address', () => {
  assert.deepEqual(navigationTargetOf({ sessionId: 'abc' }), { kind: 'session', target: 'abc' })
  assert.deepEqual(navigationTargetOf({ sessionId: 'abc', addressOf: () => undefined }), { kind: 'session', target: 'abc' })
})

test('a resolved subagent address is preferred, because it survives a rebuild', () => {
  const address = { agentId: 'a-1', depth: 1 }
  assert.deepEqual(navigationTargetOf({ sessionId: 'abc', addressOf: () => address }), { kind: 'subagent', target: address })
})

test('a resolver that throws must not stop the user from opening the worker', () => {
  const addressOf = () => {
    throw new Error('sessions domain is not ready')
  }
  assert.deepEqual(navigationTargetOf({ sessionId: 'abc', addressOf }), { kind: 'session', target: 'abc' })
  assert.throws(() => navigationTargetOf({ sessionId: '' }), /session id is required/)
})

const plan = (command, intent, categories = ['shell']) => ({ danger: true, categories, command, intent })

test('two different confirmations are two cards, oldest first', () => {
  const now = 1_000
  const cards = confirmationCardsOf({
    now,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    pending: [
      { plan: plan('rm -rf build', 'clean the tree'), requestedAt: 400 },
      { plan: plan('git push --force', 'rewrite history'), requestedAt: 200 },
    ],
  })
  assert.equal(cards.length, 2)
  assert.deepEqual(cards.map((card) => card.requestedAt), [200, 400])
  assert.equal(cards[0].command, 'git push --force')
  assert.deepEqual(cards[0].categories, ['shell'])
  assert.equal(cards[0].expiresAt, 200 + DEFAULT_TIMEOUT_MS)
  assert.equal(cards[0].expired, false)
})

test('the same confirmation repeated does not restart its clock', () => {
  const now = 1_000
  const same = plan('rm -rf build', 'clean the tree')
  const cards = confirmationCardsOf({
    now,
    timeoutMs: 600,
    pending: [{ plan: same, requestedAt: 500 }, { plan: same, requestedAt: 900 }],
  })
  assert.equal(cards.length, 1, 'one thing, one card')
  assert.equal(cards[0].requestedAt, 500, 'the earliest request owns the clock')
  assert.equal(cards[0].expiresAt, 1_100, 'the later repeat did not push the deadline out')
})

test('the key follows dangerKey, so category order and intent both matter', () => {
  const now = 1_000
  const cards = confirmationCardsOf({
    now,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    pending: [
      { plan: plan('curl x', 'read it', ['network', 'shell']), requestedAt: 100 },
      // 类别顺序不同，同一件事：不该多出一张卡。
      { plan: plan('curl x', 'read it', ['shell', 'network']), requestedAt: 200 },
      // 同一命令换个意图，是另一件事：dangerKey 里意图是键的一部分。
      { plan: plan('curl x', 'post it', ['network', 'shell']), requestedAt: 300 },
    ],
  })
  assert.equal(cards.length, 2, 'same categories in another order collapse; a different intent does not')
  assert.deepEqual(cards.map((card) => card.intent), ['read it', 'post it'])
})

test('an expired confirmation says so and stops counting down', () => {
  const cards = confirmationCardsOf({
    now: 5_000,
    timeoutMs: 1_000,
    pending: [{ plan: plan('rm -rf /', 'nope'), requestedAt: 1_000 }],
  })
  assert.equal(cards[0].expired, true)
  assert.equal(cards[0].remainingMs, 0, 'a past deadline reads zero, never a negative countdown')
  const live2 = confirmationCardsOf({
    now: 1_500,
    timeoutMs: 1_000,
    pending: [{ plan: plan('rm -rf /', 'nope'), requestedAt: 1_000 }],
  })
  assert.equal(live2[0].expired, false)
  assert.equal(live2[0].remainingMs, 500)
})

test('a bare plan starts its clock at now', () => {
  const cards = confirmationCardsOf({ now: 7_000, timeoutMs: 1_000, pending: [plan('rm x', 'y')] })
  assert.equal(cards[0].requestedAt, 7_000)
  assert.equal(cards[0].expiresAt, 8_000)
})

test('the cards refuse nonsense inputs rather than inventing a clock', () => {
  assert.throws(() => confirmationCardsOf({ now: 1, timeoutMs: 10 }), /pending must be an array/)
  assert.throws(() => confirmationCardsOf({ pending: [], timeoutMs: 10 }), /now must be a finite number/)
  assert.throws(() => confirmationCardsOf({ pending: [], now: 1, timeoutMs: 0 }), /positive integer/)
  // 空数组是合法输入：没有待确认的事，就没有卡。
  assert.deepEqual(confirmationCardsOf({ pending: [], now: 1, timeoutMs: 10 }), [])
})
