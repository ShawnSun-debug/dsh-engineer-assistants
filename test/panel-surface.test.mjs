import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_TIMEOUT_MS } from '../lib/danger.js'
import { STUCK_REASONS } from '../lib/inspector.js'
import {
  ATTENTION_REASONS,
  badgeOf,
  confirmationCardsOf,
  navigationTargetOf,
} from '../lib/panel-surface.js'

const live = (sessionId, extra = {}) => ({ sessionId, presetId: 'implementer', category: 'code', status: 'running', startedAt: 1000, ...extra })
const modelOf = (...workers) => ({ fixed: [], workers, tabs: [], activeTab: null })

test('the badge speaks the inspector vocabulary, not a second one', () => {
  // 红点的原因就是监工的卡点判据。抄一份的结果是 waitng/waiting 差一个字母，红点永不亮还不报错。
  assert.deepEqual([...ATTENTION_REASONS], [...STUCK_REASONS])
  assert.deepEqual([...ATTENTION_REASONS], ['idle', 'retrying', 'waiting-approval'])
})

test('the badge counts workers that need a person, once each', () => {
  const model = modelOf(live('w1'), live('w2'), live('w3'))
  const badge = badgeOf({
    model,
    attention: {
      // 两个原因都命中同一个 worker，也只能算一次。
      w1: ['idle', 'waiting-approval'],
      w2: ['waiting-approval'],
      // 已经结束的 worker 不在列表里，红点不该为它亮。
      w9: ['idle'],
      // 未知原因不是「需要人」的理由。
      w3: ['slow'],
    },
  })
  assert.equal(badge.count, 2, 'w1 and w2 need a person; w9 is gone and w3 only says "slow"')
  assert.deepEqual(badge.sessionIds, ['w1', 'w2'])
  assert.deepEqual(badge.byReason, { idle: 1, retrying: 0, 'waiting-approval': 2 })
})

test('a duplicate row for one worker does not double the badge', () => {
  // 登记表按 id 存在，但面板行是从表里摊出来的；同一行被摊两次不该让红点变成 2。
  const model = { fixed: [], workers: [live('w1'), live('w1'), null, live('w2')], tabs: [], activeTab: null }
  const badge = badgeOf({ model, attention: { w1: ['idle'] } })
  assert.equal(badge.count, 1)
  assert.deepEqual(badge.sessionIds, ['w1'])
})

test('no attention means no badge, not an undefined badge', () => {
  const badge = badgeOf({ model: modelOf(live('w1')) })
  assert.equal(badge.count, 0)
  assert.deepEqual(badge.sessionIds, [])
  assert.deepEqual(badge.byReason, { idle: 0, retrying: 0, 'waiting-approval': 0 })
  // 空数组、重复原因、空 id 都不会让计数漂移。
  const messy = badgeOf({ model: modelOf(live('w1')), attention: { '': ['idle'], w1: ['idle', 'idle'] } })
  assert.equal(messy.count, 1)
  assert.deepEqual(messy.byReason, { idle: 1, retrying: 0, 'waiting-approval': 0 })
})

test('the badge refuses a non-model and a non-object attention map', () => {
  assert.throws(() => badgeOf({ model: null }), /panel model is required/)
  assert.throws(() => badgeOf({ model: {} }), /panel model is required/)
  assert.throws(() => badgeOf({ model: modelOf(), attention: 'w1' }), /attention must be an object/)
})

test('a session id is a usable target when nothing resolves it to an address', () => {
  // 宿主的 SessionTarget 就是 SessionId | SubagentAddress：裸 id 合法，不是「不行」。
  assert.deepEqual(navigationTargetOf({ sessionId: 'abc' }), { kind: 'session', target: 'abc' })
  assert.deepEqual(navigationTargetOf({ sessionId: 'abc', addressOf: () => undefined }), { kind: 'session', target: 'abc' })
})

test('a resolved subagent address is preferred, because it survives a rebuild', () => {
  // 宿主 SubagentAddress 的真实形状：parentSessionId + childSessionId + mode。
  const address = { parentSessionId: 'p-1', childSessionId: 'abc', mode: 'continuable' }
  assert.deepEqual(navigationTargetOf({ sessionId: 'abc', addressOf: () => address }), { kind: 'subagent', target: address })
})

test('a resolver result with no child session is not an address', () => {
  // 自定义解析器返回 ''、0、false、{}、[] 都会交出一个永远打不开的目标；{} 和 [] 是 truthy，
  // 所以这里不能靠真值判。
  for (const bad of ['', 0, false, {}, [], { parentSessionId: 'p', mode: 'continuable' }]) {
    assert.deepEqual(
      navigationTargetOf({ sessionId: 'abc', addressOf: () => bad }),
      { kind: 'session', target: 'abc' },
      `must not treat ${JSON.stringify(bad)} as an address`,
    )
  }
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

test('the same confirmation repeated does not restart its clock, whichever order it arrives', () => {
  const same = plan('rm -rf build', 'clean the tree')
  // 先早后晚：数组顺序与时间顺序一致，看不出「取最早」还是「取第一个」。
  const ordered = confirmationCardsOf({ now: 1_000, timeoutMs: 600, pending: [{ plan: same, requestedAt: 500 }, { plan: same, requestedAt: 900 }] })
  assert.equal(ordered.length, 1, 'one thing, one card')
  assert.equal(ordered[0].requestedAt, 500)
  assert.equal(ordered[0].expiresAt, 1_100)

  // 先晚后早：只有真的比较过时间才会选 500。实现若写成「先到先得」，这条会红。
  const reversed = confirmationCardsOf({ now: 1_000, timeoutMs: 600, pending: [{ plan: same, requestedAt: 900 }, { plan: same, requestedAt: 500 }] })
  assert.equal(reversed.length, 1)
  assert.equal(reversed[0].requestedAt, 500, 'the earliest request wins regardless of array order')
  assert.equal(reversed[0].expiresAt, 1_100)
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

test('the deadline is inclusive: at expiresAt the card is already expired', () => {
  const one = (now) =>
    confirmationCardsOf({ now, timeoutMs: 1_000, pending: [{ plan: plan('rm -rf /', 'nope'), requestedAt: 1_000 }] })[0]
  assert.equal(one(1_999).expired, false)
  assert.equal(one(1_999).remainingMs, 1)
  assert.equal(one(2_000).expired, true, 'now === expiresAt counts as expired')
  assert.equal(one(2_000).remainingMs, 0)
  assert.equal(one(5_000).remainingMs, 0, 'a past deadline reads zero, never a negative countdown')
})

test('a bare plan starts its clock at now', () => {
  const cards = confirmationCardsOf({ now: 7_000, timeoutMs: 1_000, pending: [plan('rm x', 'y')] })
  assert.equal(cards[0].requestedAt, 7_000)
  assert.equal(cards[0].expiresAt, 8_000)
})

test('a plan that happens to carry a plan field is still a plan, not an envelope', () => {
  const cards = confirmationCardsOf({
    now: 1_000,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    // 只要自己能说清命令或类别，它就是 plan 本身。
    pending: [{ plan: 'x', command: 'rm -rf y', categories: ['files'] }],
  })
  assert.equal(cards.length, 1)
  assert.equal(cards[0].command, 'rm -rf y')
  assert.deepEqual(cards[0].categories, ['files'])
})

test('an entry that describes no confirmation produces no card', () => {
  const cards = confirmationCardsOf({
    now: 1_000,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    pending: [null, [], 'x', 7, {}, { plan: {} }, { plan: null }, { command: '   ' }],
  })
  assert.deepEqual(cards, [], 'nothing to confirm means no card, not a card with an empty command')
})

test('the cards refuse a non-finite requestedAt instead of silently moving it', () => {
  // 静默改成 now 会让「最早的那次」算错，也就把「重复不续期」这条保证悄悄破坏掉。
  for (const bad of [new Date(500), '500', Number.NaN, Number.POSITIVE_INFINITY, null]) {
    assert.throws(
      () => confirmationCardsOf({ now: 1_000, timeoutMs: 600, pending: [{ plan: plan('a', 'b'), requestedAt: bad }] }),
      /requestedAt must be a finite number/,
      `must refuse ${String(bad)}`,
    )
  }
})

test('the cards refuse nonsense inputs rather than inventing a clock', () => {
  assert.throws(() => confirmationCardsOf({ now: 1, timeoutMs: 10 }), /pending must be an array/)
  assert.throws(() => confirmationCardsOf({ pending: [], timeoutMs: 10 }), /now must be a finite number/)
  assert.throws(() => confirmationCardsOf({ pending: [], now: 1, timeoutMs: 0 }), /positive integer/)
  // 空数组是合法输入：没有待确认的事，就没有卡。
  assert.deepEqual(confirmationCardsOf({ pending: [], now: 1, timeoutMs: 10 }), [])
})
