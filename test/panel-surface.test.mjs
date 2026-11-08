import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_TIMEOUT_MS } from '../lib/danger.js'
import { FIXED_SECTIONS, buildPanelModel } from '../lib/panel-model.js'
import { STUCK_REASONS } from '../lib/inspector.js'
import {
  ATTENTION_REASONS,
  SUBAGENT_CHAT_ADDRESS,
  SUBAGENT_CHAT_MODES,
  badgeOf,
  confirmationCardsOf,
  PANEL_ACTIONS,
  navigationTargetOf,
  panelActionsOf,
  parseWorkerChatAddress,
  workerChatAddressOf,
  workerChatTabsOf,
  workerOpenStepsOf,
} from '../lib/panel-surface.js'

const live = (sessionId, extra = {}) => ({ sessionId, presetId: 'implementer', category: 'code', status: 'running', startedAt: 1000, ...extra })
const modelOf = (...workers) => ({ fixed: [], workers })

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
  const model = { fixed: [], workers: [live('w1'), live('w1'), null, live('w2')] }
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

test('an intent-only confirmation still produces a card', () => {
  // classifyDanger({command:'', intent:'强推 main'}) 会给出非空类别、空命令。按命令判空会把它
  // 静默丢掉——而这恰恰是最需要确认的那一类。
  const cards = confirmationCardsOf({
    now: 1_000,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    pending: [{ command: '', intent: '强推 main', categories: ['history-rewrite'] }],
  })
  assert.equal(cards.length, 1, 'no command, but a category and an intent: still a confirmation')
  assert.equal(cards[0].command, '')
  assert.deepEqual(cards[0].categories, ['history-rewrite'])
  assert.equal(cards[0].intent, '强推 main')
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
// 与宿主 dsh-client-ui-subagent 的 parseSubagentChatAddress 逐条对齐的本地副本：
// 它认不出来的地址，点 worker 会静默无反应，所以这里按宿主的规则反向校验。
function parseLikeHost(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'dsh-resource:' || url.hostname.toLowerCase() !== 'subagentchat') return undefined
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length !== 2 || parts[0] !== 'session') return undefined
  const parentSessionId = url.searchParams.get('parent')
  const mode = url.searchParams.get('mode')
  if (parentSessionId === null || parentSessionId === '' || !SUBAGENT_CHAT_MODES.includes(mode)) return undefined
  return { parentSessionId, childSessionId: decodeURIComponent(parts[1]), mode }
}

const address = (childSessionId, extra = {}) => ({ parentSessionId: 'p-1', childSessionId, mode: 'continuable', ...extra })

test('a worker chat address round-trips through the host parser rules', () => {
  assert.equal(SUBAGENT_CHAT_ADDRESS, 'dsh-resource://subagentchat/session/')
  const built = workerChatAddressOf({ address: address('child-1') })
  assert.deepEqual(parseLikeHost(built), { parentSessionId: 'p-1', childSessionId: 'child-1', mode: 'continuable' })
  // 三种 mode 宿主都认。
  for (const mode of SUBAGENT_CHAT_MODES) {
    assert.equal(parseLikeHost(workerChatAddressOf({ address: address('c', { mode }) })).mode, mode)
  }
})

test('an id that needs escaping survives the trip', () => {
  const odd = 'session/a b?c&d'
  const parsed = parseLikeHost(workerChatAddressOf({ address: address(odd) }))
  assert.equal(parsed.childSessionId, odd, 'the child id must survive encoding intact')
})

test('a worker chat address is refused rather than built wrong', () => {
  assert.throws(() => workerChatAddressOf({}), /subagent address is required/)
  // 与 navigationTargetOf 用同一把尺子：缺 parent 或缺 mode 都不是地址。
  assert.throws(() => workerChatAddressOf({ address: { childSessionId: 'c', mode: 'continuable' } }), /subagent address is required/)
  assert.throws(() => workerChatAddressOf({ address: { parentSessionId: 'p', childSessionId: 'c' } }), /subagent address is required/)
  assert.throws(() => workerChatAddressOf({ address: { parentSessionId: 'p', childSessionId: '   ', mode: 'continuable' } }), /subagent address is required/)
  // 宿主只认三种 mode：别的一律打不开，宁可抛错也不拼一个点了没反应的地址。
  assert.throws(() => workerChatAddressOf({ address: address('c', { mode: 'once' }) }), /mode must be one of/)
})
const buildLike = ({ master = { sessionId: null }, workers = [], fixed = ['master', 'inspector', 'reporter'] } = {}) => ({
  fixed: fixed.map((id) => ({ id, title: id })),
  master,
  workers,
})

const kindsOf = (result) => [...result.fixed, ...result.workers].map((row) => row.action.kind)
const masterOf = (sessionId) => ({ sessionId })

test('the four action kinds are the whole vocabulary, and every action uses it', () => {
  assert.deepEqual([...PANEL_ACTIONS], ['open-session', 'open-worker', 'designate-master', 'show-section'])
  const mixed = panelActionsOf({
    model: buildLike({ master: masterOf('m-1'), workers: [live('w1'), live('w2')] }),
    addressOf: (id) => (id === 'w1' ? address('w1') : undefined),
  })
  for (const kind of kindsOf(mixed)) assert.ok(PANEL_ACTIONS.includes(kind), `"${kind}" is in the table`)
})

test('the three fixed entries act differently on purpose', () => {
  const designated = panelActionsOf({ model: buildLike({ master: masterOf('m-1') }) })
  assert.deepEqual(designated.fixed, [
    { id: 'master', action: { kind: 'open-session', sessionId: 'm-1' } },
    { id: 'inspector', action: { kind: 'show-section', section: 'inspector' } },
    { id: 'reporter', action: { kind: 'show-section', section: 'reporter' } },
  ])
  // 没指定时不是「点了没反应」，而是明确告诉客户端去指定。
  const unset = panelActionsOf({ model: buildLike({ master: masterOf(null) }) })
  assert.deepEqual(unset.fixed[0].action, { kind: 'designate-master' })
})

test('a fixed entry the module has never heard of is an error, not a section', () => {
  // 否则任意 id 都会变成一段 show-section，包括空串。
  for (const bad of ['', 'overview', 'worker']) {
    assert.throws(() => panelActionsOf({ model: buildLike({ fixed: ['master', bad] }) }), /is not a fixed entry/)
  }
  assert.throws(() => panelActionsOf({ model: { fixed: [], master: masterOf(null) } }), /panel model is required/)
})

test('a worker carries the address built from the resolver, not from the row', () => {
  // resolver 故意返回与行 id 不同的 child：照行 id 拼地址的实现会在这里露馅。
  const model = buildLike({ workers: [live('w1')] })
  const { workers } = panelActionsOf({ model, addressOf: () => address('the-real-child') })
  assert.equal(workers[0].sessionId, 'w1')
  assert.equal(workers[0].action.kind, 'open-worker')
  assert.deepEqual(parseLikeHost(workers[0].action.address), {
    parentSessionId: 'p-1',
    childSessionId: 'the-real-child',
    mode: 'continuable',
  })
})

test('the resolver is asked about the row it belongs to', () => {
  const asked = []
  const model = buildLike({ workers: [live('w1'), live('w2')] })
  panelActionsOf({ model, addressOf: (id) => { asked.push(id); return address(id) } })
  assert.deepEqual(asked, ['w1', 'w2'], 'called once per worker, with that worker id')
})

test('a mode other than continuable reaches the address unchanged', () => {
  const model = buildLike({ workers: [live('w1')] })
  const oneShot = panelActionsOf({ model, addressOf: () => address('c', { mode: 'one-shot' }) })
  assert.equal(parseLikeHost(oneShot.workers[0].action.address).mode, 'one-shot', 'mode must not be forced to continuable')
  const unknown = panelActionsOf({ model, addressOf: () => address('c', { mode: 'unknown' }) })
  assert.equal(parseLikeHost(unknown.workers[0].action.address).mode, 'unknown')
})

test('a worker with no usable address is still openable, resolved again at click time', () => {
  const model = buildLike({ workers: [live('w1'), live('w2'), live('w3')] })
  const messy = (id) => {
    if (id === 'w1') throw new Error('sessions domain not ready')
    // 宿主类型之外的 mode：拼地址会抛，但不能让它带走整张表。
    if (id === 'w2') return { parentSessionId: 'p-1', childSessionId: 'w2', mode: 'fork' }
    // 异步解析器不是地址。
    if (id === 'w3') return Promise.resolve(address('w3'))
    return undefined
  }
  const { workers, fixed } = panelActionsOf({ model, addressOf: messy })
  // 三种情况都退回「只有 sessionId」的 open-worker：能不能开成，点击时再判。
  assert.deepEqual(workers.map((row) => row.action), [
    { kind: 'open-worker', sessionId: 'w1' },
    { kind: 'open-worker', sessionId: 'w2' },
    { kind: 'open-worker', sessionId: 'w3' },
  ])
  assert.equal(fixed.length, 3, 'one bad address must not take the fixed entries down with it')
})

test('duplicate rows for one worker give one action', () => {
  const model = buildLike({ workers: [live('w1'), live('w1'), null, { sessionId: '   ' }] })
  assert.deepEqual(panelActionsOf({ model }).workers.map((row) => row.sessionId), ['w1'])
})

test('it composes with the real panel model, including the master trap', () => {
  const empty = {}
  // 没有 master、没有 worker：三个入口都在，worker 列表空。
  const bare = panelActionsOf({ model: buildPanelModel({ assignments: empty, parentId: 'p' }) })
  assert.deepEqual(bare.fixed.map((row) => row.action.kind), ['designate-master', 'show-section', 'show-section'])
  assert.deepEqual(bare.workers, [])

  // 传了生效的 master id：master 变成可以打开的会话。
  const withMaster = panelActionsOf({ model: buildPanelModel({ assignments: empty, parentId: 'p', masterSessionId: 'orchestrator-master' }) })
  assert.deepEqual(withMaster.fixed[0].action, { kind: 'open-session', sessionId: 'orchestrator-master' })

  // 陷阱本身也钉住：只传原始配置（没指定）时，即使 master 实际上是活的，这里也只能说「未指定」。
  // 所以接线时必须自己合成 config || (masterSessionEnabled ? MASTER_SESSION_ID : '')。
  const rawConfig = panelActionsOf({ model: buildPanelModel({ assignments: empty, parentId: 'p', masterSessionId: '' }) })
  assert.deepEqual(rawConfig.fixed[0].action, { kind: 'designate-master' })

  // 固定入口就是模型里那三个，不多不少。
  assert.deepEqual(buildPanelModel({ assignments: empty, parentId: 'p' }).fixed.map((row) => row.id), [...FIXED_SECTIONS])
})
test('the badge needs workers only; the action table needs the fixed entries too', () => {
  const workersOnly = { workers: [live('w1')] }
  // 红点只数 worker：模型里没写 fixed 不该让它炸（这是 requireModel 收紧后的回归点）。
  assert.equal(badgeOf({ model: workersOnly, attention: { w1: ['idle'] } }).count, 1)
  // 动作表要遍历固定入口，缺 fixed 就说不清「传错了东西」，必须报错。
  assert.throws(() => panelActionsOf({ model: workersOnly }), /no fixed array/)
})

test('the address parser is the host parser: a round trip returns the address it came from', () => {
  // 页签里存的 contentId 就是这个地址；反查必须读得回原样，否则 worker 结束时找不到自己的页签。
  for (const mode of SUBAGENT_CHAT_MODES) {
    const original = address('child 1/2', { mode, parentSessionId: 'p-1' })
    assert.deepEqual(parseWorkerChatAddress(workerChatAddressOf({ address: original })), original)
  }
})

test('the parser refuses every shape the host would refuse', () => {
  const parse = parseWorkerChatAddress
  const cases = [
    '', // 不是 URL
    'dsh-resource://subagentchat/session/c', // 没有 parent 与 mode
    'dsh-resource://subagentchat/session/c?parent=p&mode=once', // 宿主只认三种 mode
    'dsh-resource://subagentchat/session/c?mode=continuable', // 没有 parent
    'dsh-resource://subagentchat/session/c?parent=&mode=continuable', // parent 空
    'dsh-resource://subagentchat/c?parent=p&mode=continuable', // 路径少了 session
    'dsh-resource://subagentchat/session/a/b?parent=p&mode=continuable', // 路径多一段
    'https://subagentchat/session/c?parent=p&mode=continuable', // 换了协议
    'dsh-resource://elsewhere/session/c?parent=p&mode=continuable', // 换了 host
    'dsh-resource://subagentchat/session/%E0%A4%A?parent=p&mode=continuable', // 编码是坏的
    42,
    null,
    undefined,
    {},
    [],
  ]
  for (const value of cases) {
    assert.equal(parse(value), undefined, `must not read ${JSON.stringify(value)} as an address`)
  }
})

test('a blank child is not an address, deliberately stricter than the host', () => {
  // 宿主到这里就返回了；空白 id 指不到任何会话，按 usableAddress 那把尺子判掉。
  assert.equal(parseWorkerChatAddress('dsh-resource://subagentchat/session/%20%20?parent=p&mode=continuable'), undefined)
})

test('the open-tab lookup finds one worker across sessions, by parsing rather than by string match', () => {
  const tabs = [
    { sessionId: 's-1', tabId: 't1', kind: 'subagentchat', contentId: workerChatAddressOf({ address: address('w1') }) },
    // 同一个 worker，换过一个 parent 与 mode：地址字符串不相等，但它还是这个 worker 的页签。
    { sessionId: 's-2', tabId: 't2', kind: 'subagentchat', contentId: workerChatAddressOf({ address: address('w1', { parentSessionId: 'p-9', mode: 'one-shot' }) }) },
    { sessionId: 's-1', tabId: 't3', kind: 'subagentchat', contentId: workerChatAddressOf({ address: address('w2') }) },
    { sessionId: 's-1', tabId: 't4', kind: 'files', contentId: 'dsh-resource://files/session/x' },
    { sessionId: 's-1', tabId: '', kind: 'subagentchat', contentId: workerChatAddressOf({ address: address('w1') }) },
    { sessionId: 's-1', kind: 'subagentchat', contentId: workerChatAddressOf({ address: address('w1') }) },
    null,
    'garbage',
  ]
  assert.deepEqual(workerChatTabsOf({ tabs, sessionId: 'w1' }), [
    { sessionId: 's-1', tabId: 't1' },
    { sessionId: 's-2', tabId: 't2' },
  ])
  // 别把 worker 自己的 id 和别人的搞混：w2 只拿到属于它的那张。
  assert.deepEqual(workerChatTabsOf({ tabs, sessionId: 'w2' }), [{ sessionId: 's-1', tabId: 't3' }])
})

test('one worker with no open tab gives an empty list, not an undefined answer', () => {
  assert.deepEqual(workerChatTabsOf({ tabs: [], sessionId: 'w1' }), [])
  const unrelated = [{ sessionId: 's-1', tabId: 't1', kind: 'subagentchat', contentId: workerChatAddressOf({ address: address('other') }) }]
  assert.deepEqual(workerChatTabsOf({ tabs: unrelated, sessionId: 'w1' }), [])
})

test('a duplicated inventory row does not turn into two close actions', () => {
  const row = { sessionId: 's-1', tabId: 't1', kind: 'subagentchat', contentId: workerChatAddressOf({ address: address('w1') }) }
  assert.deepEqual(workerChatTabsOf({ tabs: [row, { ...row }], sessionId: 'w1' }), [{ sessionId: 's-1', tabId: 't1' }])
})

test('the lookup refuses nonsense instead of inventing tabs', () => {
  assert.throws(() => workerChatTabsOf({ sessionId: 'w1' }), /tabs must be an array/)
  assert.throws(() => workerChatTabsOf({ tabs: null, sessionId: 'w1' }), /tabs must be an array/)
  assert.throws(() => workerChatTabsOf({ tabs: [], sessionId: '  ' }), /session id is required/)
})

test('a click resolves both steps at click time: the resource to try, then the session to fall back to', () => {
  const addr = address('w1')
  const steps = workerOpenStepsOf({ sessionId: 'w1', addressOf: () => addr })
  // 先试右栏：地址、页签类型、新开一格全是点击时才知道的东西。
  assert.equal(steps.resource.address, workerChatAddressOf({ address: addr }))
  assert.equal(steps.resource.kind, 'subagentchat')
  assert.equal(steps.resource.preferNewPane, true)
  // 退路是地址本身，不是裸 id：裸 id 对「列表里还没有」的子会话会抛 unknown session。
  assert.deepEqual(steps.session, addr)
})

test('with no resolvable address the click still has a target, and no resource', () => {
  for (const resolver of [undefined, () => undefined, () => ({}), () => { throw new Error('sessions is down') }]) {
    const steps = workerOpenStepsOf({ sessionId: 'w1', addressOf: resolver })
    assert.equal(steps.resource, undefined)
    assert.equal(steps.session, 'w1', 'a bare id is a legal SessionTarget')
  }
})

test('an address whose mode the chat view cannot open keeps the session fallback', () => {
  // usableAddress 只要求 mode 非空，所以这种地址还是会走到这里；右栏开不了（workerChatAddressOf 会抛），
  // 但地址本身仍指得到那条子会话，退回主栏时要递它。
  const odd = address('w1', { mode: 'once' })
  const steps = workerOpenStepsOf({ sessionId: 'w1', addressOf: () => odd })
  assert.equal(steps.resource, undefined)
  assert.deepEqual(steps.session, odd)
})

test('a blank worker id is refused rather than planned', () => {
  assert.throws(() => workerOpenStepsOf({ sessionId: ' ' }), /session id is required/)
})
