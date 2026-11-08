import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SECRETARY_ENDPOINT,
  SECRETARY_METHOD,
  SECRETARY_SERVICE_KEY,
  SecretaryRemote,
  VIEW_REPORT_LIMIT,
  collectOrchestratorRows,
  composeViewState,
  emptyViewState,
  notifyOnFrom,
} from '../lib/secretary-panel.js'
import { applyDraftTriggers, createDraftStore } from '../lib/secretary-nudge.js'

// Four config fields plus the three model routes, all read by the endpoint. The view limit is a
// constant of the reader, not policy: a field the endpoint never sends would be a lie in the
// settings tab, and it cannot be changed from there. Every route string is
// empty here because empty is "not set" — a default model name would be a decision nobody made.
const EMPTY_ROUTES = {
  main: { provider: '', model: '', effort: '' },
  worker: { provider: '', model: '', effort: '' },
  review: { provider: '', model: '', effort: '' },
}
const EMPTY_POLICY = {
  beatSeconds: 180,
  maxRunSeconds: 7200,
  notifyOn: { state: true, step: true, block: true, deliverable: true, timeout: true },
  promptText: '',
  routes: EMPTY_ROUTES,
}

const ORCHESTRATOR = {
  sessionId: 'orch-1',
  title: '日报',
  workspace: 'w',
  live: true,
  state: 'Working',
  step: { index: 2, total: 5 },
  workers: [{ id: 'w-1', state: 'Working', summary: '写报告' }],
  beats: { count: 2, startedAt: 1000, capped: false, stoppedReason: null },
  lastReport: { path: '/r/12-03.md', at: 90, kind: 'delta' },
}

// The diff is the three groups lib/secretary-diff.js produces, not a flat list of
// sentences the view has to reverse-engineer. Why changed with ticket 08: the view now
// reads completed/blocked/flipped directly.
const REPORT = {
  sessionId: 'orch-1',
  at: 90,
  kind: 'delta',
  path: '/r/12-03.md',
  bytes: 120,
  // The body now reaches the view (why: the timeline unfolds it inline instead of
  // sending the reader to the archive); the fixture keeps a head line so the contract
  // test pins that it survives both composition paths.
  content: '# 秘书汇报\n\n- 会话：orch-1\n',
  contentTruncated: false,
  changes: { completed: ['w-1：Working → Completed'], blocked: [], flipped: [] },
  error: null,
}

// Ticket 08's draft shape: the stuck session, why it is stuck, the generated body and
// the confirm transition. Why changed: the store keys drafts by id and only records
// sentAt when confirmDraft actually delivered the text.
const DRAFT = {
  id: 'd-1',
  sessionId: 'orch-1',
  reason: 'needs-input',
  text: '需要你拍板',
  status: 'pending',
  createdAt: 80,
  sentAt: null,
}

test('the payload carries five segments with exactly the contract field names (why: ticket 08 grouped the diff and reshaped the draft row)', () => {
  const payload = composeViewState({
    enabled: true,
    registry: { masterSessionId: 'm-1', orchestrators: [{ sessionId: 'orch-1', workspace: 'w', title: '日报', trackedAt: 7 }] },
    orchestrators: [ORCHESTRATOR],
    reports: [REPORT],
    drafts: [DRAFT],
    policy: { beatSeconds: 300, maxRunSeconds: 900, notifyOn: notifyOnFrom([]), promptText: '口径' },
  })

  assert.deepEqual(Object.keys(payload), ['enabled', 'registry', 'orchestrators', 'reports', 'drafts', 'policy'])
  assert.equal(payload.enabled, true)

  assert.deepEqual(Object.keys(payload.registry), ['masterSessionId', 'orchestrators', 'raw', 'conflict'])
  assert.deepEqual(Object.keys(payload.registry.orchestrators[0]), [
    'sessionId',
    'workspace',
    'workspaceMissing',
    'title',
    'trackedAt',
  ])
  assert.deepEqual(payload.registry.orchestrators[0], {
    sessionId: 'orch-1',
    workspace: 'w',
    workspaceMissing: false,
    title: '日报',
    trackedAt: 7,
  })
  // The stored list, ids only and in storage order: the view edits by this index.
  assert.deepEqual(payload.registry.raw, [{ sessionId: 'orch-1' }])

  // Step is part of the row contract since the todos projection became a real source.
  // Why changed: the old assertion was `'step' in payload.orchestrators[0] === false` —
  // the six-state projection had no step and an always-null field made the view's step
  // branch unreachable. Now step is always present: { index, total } from the caller's
  // todos read, null when that read has no list. lastError still has no source, so it
  // stays absent (an always-null field is still a lie).
  assert.deepEqual(Object.keys(payload.orchestrators[0]), [
    'sessionId',
    'title',
    'workspace',
    'live',
    'state',
    'step',
    'workers',
    'beats',
    'lastReport',
  ])
  assert.deepEqual(Object.keys(payload.orchestrators[0].workers[0]), ['id', 'state', 'summary'])
  assert.deepEqual(Object.keys(payload.orchestrators[0].beats), ['count', 'startedAt', 'capped', 'stoppedReason'])
  assert.equal('step' in payload.orchestrators[0], true, 'the key is always present')
  assert.deepEqual(payload.orchestrators[0].step, { index: 2, total: 5 }, 'one shape: { index, total }')
  assert.equal('lastError' in payload.orchestrators[0], false, 'lastError still has no source')
  assert.deepEqual(payload.orchestrators[0], ORCHESTRATOR)

  assert.deepEqual(Object.keys(payload.reports[0]), [
    'sessionId',
    'at',
    'kind',
    'path',
    'bytes',
    'content',
    'contentTruncated',
    'changes',
    'error',
  ])
  assert.deepEqual(payload.reports[0], REPORT)

  assert.deepEqual(Object.keys(payload.drafts[0]), [
    'id',
    'sessionId',
    'reason',
    'text',
    'status',
    'createdAt',
    'sentAt',
  ])
  assert.deepEqual(payload.drafts[0], DRAFT)

  assert.deepEqual(Object.keys(payload.policy), ['beatSeconds', 'maxRunSeconds', 'notifyOn', 'promptText', 'routes'])
  assert.deepEqual(payload.policy, {
    beatSeconds: 300,
    maxRunSeconds: 900,
    notifyOn: { state: false, step: false, block: false, deliverable: false, timeout: false },
    promptText: '口径',
    routes: EMPTY_ROUTES,
  })
})

test('the empty payload is the stable five-segment shape the view can always render', () => {
  const empty = emptyViewState()
  assert.deepEqual(empty, {
    enabled: false,
    registry: { masterSessionId: '', orchestrators: [], raw: [], conflict: null },
    orchestrators: [],
    reports: [],
    drafts: [],
    policy: EMPTY_POLICY,
  })
  // 视图可以留一份旧 payload 与新 payload 比较，所以两次调用不能共用对象。
  assert.notEqual(emptyViewState().registry, empty.registry)
  assert.notEqual(emptyViewState().policy.notifyOn, empty.policy.notifyOn)
})

test('nothing registered is an empty orchestrators array, never an error', () => {
  const payload = composeViewState({ enabled: true, registry: { masterSessionId: '', orchestrators: [] } })
  assert.deepEqual(payload.orchestrators, [])
  assert.deepEqual(payload.registry, { masterSessionId: '', orchestrators: [], raw: [], conflict: null })
  assert.deepEqual(payload.reports, [])
  assert.deepEqual(payload.drafts, [])
  assert.deepEqual(payload.policy, EMPTY_POLICY)

  // 缺失段、坏段、垃圾入参都降级，不抛。
  assert.deepEqual(composeViewState({}).orchestrators, [])
  assert.deepEqual(composeViewState(undefined).orchestrators, [])
  assert.deepEqual(composeViewState({ registry: 'nope', orchestrators: 'nope' }).orchestrators, [])
  assert.deepEqual(collectOrchestratorRows({ registry: { masterSessionId: '', orchestrators: [] }, sessions: [] }), [])
})

test('a session registered as both master and orchestrator is reported as a conflict', () => {
  const payload = composeViewState({
    enabled: true,
    registry: {
      masterSessionId: 'x',
      orchestrators: [{ sessionId: 'x', workspace: '', title: '', trackedAt: 1 }, { sessionId: 'y', trackedAt: 2 }],
    },
  })
  // 登记表规则：Master 胜出，那一行从归一化的 orchestrators 里消失。
  assert.deepEqual(payload.registry.orchestrators.map((row) => row.sessionId), ['y'])
  assert.deepEqual(payload.registry.conflict, { masterSessionId: 'x', conflictingOrchestratorIds: ['x'] })
})

test('the policy segment carries the four config fields and the three routes, and nothing else', () => {
  assert.deepEqual(emptyViewState().policy, EMPTY_POLICY)
  assert.deepEqual(Object.keys(EMPTY_POLICY), ['beatSeconds', 'maxRunSeconds', 'notifyOn', 'promptText', 'routes'])
  assert.deepEqual(notifyOnFrom(['state-flip', 'blocked', 'later-additions']), {
    state: true,
    step: false,
    block: true,
    deliverable: false,
    timeout: false,
  })
  const custom = composeViewState({
    policy: { beatSeconds: 300, maxRunSeconds: 900, reportsRoot: '.scratch/x', viewReportLimit: 7 },
  }).policy
  assert.equal(custom.beatSeconds, 300)
  assert.equal(custom.maxRunSeconds, 900)
  assert.deepEqual(custom.notifyOn, EMPTY_POLICY.notifyOn, 'a missing switch list defaults to all five on')
  // Input that still names them cannot bring them back: they are not policy.
  assert.equal('reportsRoot' in custom, false)
  assert.equal('viewReportLimit' in custom, false)
  // The reader's own constants stay constants.
})

test('the policy segment hands over the three model routes as three string fields each', () => {
  const routes = composeViewState({
    policy: {
      routes: {
        main: { provider: 'anthropic', model: 'claude-sonnet', effort: 'high' },
        worker: { provider: 'openai', model: 'gpt-5', effort: '' },
        review: { provider: 'mine', model: 'small', effort: 'low' },
      },
    },
  }).policy.routes

  assert.deepEqual(routes, {
    main: { provider: 'anthropic', model: 'claude-sonnet', effort: 'high' },
    worker: { provider: 'openai', model: 'gpt-5', effort: '' },
    review: { provider: 'mine', model: 'small', effort: 'low' },
  })
  for (const segment of Object.values(routes)) {
    assert.deepEqual(Object.keys(segment), ['provider', 'model', 'effort'])
    for (const value of Object.values(segment)) assert.equal(typeof value, 'string')
  }
  // 空串就是「未设」：main 跟宿主默认、worker 未配置、review 跟 worker。这里不编默认值。
  assert.deepEqual(composeViewState({}).policy.routes, EMPTY_ROUTES)
})

test('junk route input degrades to three all-empty segments while the other policy fields survive', () => {
  const junk = [
    { main: 42, worker: { provider: { nested: true }, model: ['x'], effort: true }, review: 'nope' },
    { provider: 'flat' }, // 段名写在 routes 上，而不在段里
    [],
    'routes',
    null,
  ]
  for (const routes of junk) {
    const policy = composeViewState({ policy: { routes, beatSeconds: 300, promptText: '口径' } }).policy
    assert.deepEqual(policy.routes, EMPTY_ROUTES, 'routes=' + JSON.stringify(routes))
    assert.equal(policy.beatSeconds, 300)
    assert.equal(policy.promptText, '口径')
  }

  // 段内只坏一个字段：其余字段照常，坏的那个补空串——不整段丢弃，也不猜值。
  assert.deepEqual(
    composeViewState({ policy: { routes: { main: { provider: 'p', model: 7 } } } }).policy.routes.main,
    { provider: 'p', model: '', effort: '' },
  )
})

test('reports and drafts arrive newest first and the report list stops at the reader limit', () => {
  const reports = Array.from({ length: 60 }, (_, index) => ({
    sessionId: 'orch-1',
    at: index,
    kind: 'delta',
    path: '/r/' + index + '.md',
    bytes: 1,
    changes: [],
    error: null,
  })).concat([
    // 没有路径的行是垃圾行，不是一条历史。
    { sessionId: 'orch-1', at: 99, kind: 'delta', path: '', bytes: 0, changes: [], error: null },
  ])
  const payload = composeViewState({
    reports,
    drafts: [
      { id: 'old', createdAt: 1 },
      { id: 'new', createdAt: 5 },
    ],
  })
  // The cap is VIEW_REPORT_LIMIT, a constant of the reader; it used to be read from a policy field
  // the endpoint never sent, and the settings tab showed it as if it were configurable.
  assert.equal(payload.reports.length, VIEW_REPORT_LIMIT)
  assert.deepEqual(payload.reports.slice(0, 3).map((row) => row.at), [59, 58, 57])
  assert.equal(payload.reports.some((row) => row.path === ''), false, 'a row with no path is not history')
  assert.deepEqual(payload.drafts.map((row) => row.id), ['new', 'old'])
})

test('the raw list keeps storage order while the normalized one drops rows, and an unbound row resolves its workspace', () => {
  const payload = composeViewState({
    enabled: true,
    registry: {
      masterSessionId: 'x',
      orchestrators: [
        { sessionId: 'x', workspace: '', title: '主', trackedAt: 1 },
        { sessionId: 'y', workspace: 'w2', title: '同名', trackedAt: 2 },
        { sessionId: 'y', workspace: 'w2', title: '同名', trackedAt: 3 },
        { sessionId: 'z', workspace: '', title: '无', trackedAt: 4 },
      ],
    },
    // The session's own directory, the same answer the read function gives in lib/index.js.
    workspaceOf: (sessionId) => (sessionId === 'z' ? 'w3' : ''),
  })
  // Normalized: the Master row is gone and the second y is deduped.
  assert.deepEqual(
    payload.registry.orchestrators.map((row) => [row.sessionId, row.workspace, row.workspaceMissing]),
    [
      ['y', 'w2', false],
      ['z', 'w3', false],
    ],
  )
  // Raw keeps storage order and length, so index 0 is still the Master row and 2 the duplicate.
  assert.deepEqual(payload.registry.raw, [
    { sessionId: 'x' },
    { sessionId: 'y' },
    { sessionId: 'y' },
    { sessionId: 'z' },
  ])

  // A resolver that throws is no answer, not a crash.
  const broken = composeViewState({
    registry: { masterSessionId: '', orchestrators: [{ sessionId: 'z', workspace: '', title: '', trackedAt: 1 }] },
    workspaceOf: () => {
      throw new Error('no such session')
    },
  })
  assert.deepEqual(
    [broken.registry.orchestrators[0].workspace, broken.registry.orchestrators[0].workspaceMissing],
    ['', true],
  )
  assert.deepEqual(broken.registry.raw, [{ sessionId: 'z' }])
})

test('composing never writes into the input it was handed', () => {
  const input = {
    enabled: true,
    registry: { masterSessionId: 'm-1', orchestrators: [{ sessionId: 'orch-1', workspace: 'w', title: '日报', trackedAt: 7 }] },
    orchestrators: [{ ...ORCHESTRATOR, workers: [...ORCHESTRATOR.workers] }],
    reports: [
      {
        ...REPORT,
        changes: {
          completed: [...REPORT.changes.completed],
          blocked: [...REPORT.changes.blocked],
          flipped: [...REPORT.changes.flipped],
        },
      },
    ],
    drafts: [{ ...DRAFT }],
    policy: { beatSeconds: 300 },
  }
  const before = JSON.stringify(input)
  const first = composeViewState(input)
  const second = composeViewState(input)
  assert.equal(JSON.stringify(input), before, 'the endpoint must not modify what it read')
  assert.notEqual(first.orchestrators[0], second.orchestrators[0])
})

test('orchestrator rows fold the ledger, the six-state projection and the archive index', () => {
  const sessions = [
    { id: 'orch-1', header: { id: 'orch-1', cwd: 'w' } },
    { id: 'child-1', header: { id: 'child-1', parentSession: 'orch-1' } },
    { id: 'child-2', header: { id: 'child-2', parentSession: 'orch-1' } },
  ]
  const stateOf = (session) => ({
    workers: [
      {
        id: session.id,
        role: session.id === 'orch-1' ? 'main' : 'worker',
        state: session.id === 'orch-1' ? 'Working' : session.id === 'child-1' ? 'Needs input' : 'Completed',
        summary: '摘要-' + session.id,
      },
    ],
  })
  const rows = collectOrchestratorRows({
    registry: {
      masterSessionId: '',
      orchestrators: [
        { sessionId: 'orch-1', workspace: '', title: '日报', trackedAt: 1 },
        { sessionId: 'gone', workspace: 'w2', title: '旧会话', trackedAt: 2 },
      ],
    },
    sessions,
    stateOf,
    isLive: (sessionId) => sessionId === 'orch-1',
    reports: [
      { sessionId: 'orch-1', at: 90, kind: 'delta', path: '/r/12-03.md' },
      { sessionId: 'orch-1', at: 60, kind: 'plan', path: '/r/12-00.md' },
      { sessionId: 'other', at: 95, kind: 'plan', path: '/r/x.md' },
    ],
  })

  assert.deepEqual(rows[0], {
    sessionId: 'orch-1',
    title: '日报',
    workspace: 'w',
    live: true,
    state: 'Working',
    // No stepOf adapter was passed: the field is present and null, never missing.
    step: null,
    workers: [
      { id: 'child-1', state: 'Needs input', summary: '摘要-child-1' },
      { id: 'child-2', state: 'Completed', summary: '摘要-child-2' },
    ],
    beats: { count: 0, startedAt: null, capped: false, stoppedReason: null },
    lastReport: { path: '/r/12-03.md', at: 90, kind: 'delta' },
  })
  // 会话已经没了：行还在（标题取登记行），live false，历史保留。
  assert.deepEqual(rows[1], {
    sessionId: 'gone',
    title: '旧会话',
    workspace: 'w2',
    live: false,
    state: 'Idle',
    step: null,
    workers: [],
    beats: { count: 0, startedAt: null, capped: false, stoppedReason: null },
    lastReport: null,
  })
})

test('an orchestrator row carries the real beat status: count follows ticks and capped means the cap was hit', () => {
  const registry = { orchestrators: [{ sessionId: 'orch-1', workspace: 'w', title: '日报', trackedAt: 1 }] }
  const getStatus = collectOrchestratorRows({
    registry,
    sessions: [{ id: 'orch-1' }],
    beatStatus: () => ({ running: true, startedAt: 500, tickIndex: 3, stopReason: null }),
  })
  assert.deepEqual(getStatus[0].beats, { count: 3, startedAt: 500, capped: false, stoppedReason: null })

  const capped = collectOrchestratorRows({
    registry,
    sessions: [{ id: 'orch-1' }],
    beatStatus: () => ({ running: false, startedAt: 500, tickIndex: 4, stopReason: 'max-run' }),
  })
  assert.deepEqual(capped[0].beats, { count: 4, startedAt: 500, capped: true, stoppedReason: 'max-run' })

  // A beat stopped because the run finished is not capped; an adapter that throws is
  // the zeroed shape, not a broken endpoint.
  const finished = collectOrchestratorRows({
    registry,
    sessions: [{ id: 'orch-1' }],
    beatStatus: () => ({ running: false, startedAt: 500, tickIndex: 2, stopReason: 'finished' }),
  })
  assert.equal(finished[0].beats.capped, false)
  assert.equal(finished[0].beats.stoppedReason, 'finished')
  const throwing = collectOrchestratorRows({ registry, sessions: [{ id: 'orch-1' }], beatStatus: () => { throw new Error('boom') } })
  assert.deepEqual(throwing[0].beats, { count: 0, startedAt: null, capped: false, stoppedReason: null })
})

test('the step reaches the row from the caller\'s todos read, and null — not a missing key — when there is none (why: the panel showed 未提供)', () => {
  const registry = { orchestrators: [{ sessionId: 'orch-1', workspace: 'w', title: '日报', trackedAt: 1 }] }
  const session = { id: 'orch-1', header: { id: 'orch-1' } }

  // With todos: the row carries the one shape the client reads, { index, total }.
  const withTodos = collectOrchestratorRows({ registry, sessions: [session], stepOf: () => ({ index: 2, total: 5 }) })
  assert.deepEqual(withTodos[0].step, { index: 2, total: 5 })

  // Without todos: null, and the key is present. A missing key would read as undefined in
  // the client and blur "no todos this turn" with "this endpoint predates steps".
  const withoutTodos = collectOrchestratorRows({ registry, sessions: [session], stepOf: () => null })
  assert.equal('step' in withoutTodos[0], true)
  assert.equal(withoutTodos[0].step, null)

  // No adapter, a throwing adapter or junk from the adapter all degrade to null.
  assert.equal(collectOrchestratorRows({ registry, sessions: [session] })[0].step, null)
  const throwing = collectOrchestratorRows({
    registry,
    sessions: [session],
    stepOf: () => {
      throw new Error('boom')
    },
  })
  assert.equal(throwing[0].step, null)
  assert.equal(collectOrchestratorRows({ registry, sessions: [session], stepOf: () => ({ index: 'x', total: 5 }) })[0].step, null)
  assert.equal(collectOrchestratorRows({ registry, sessions: [session], stepOf: () => 3 })[0].step, null)

  // The adapter is handed the Session, not the id: it is the same object the projection reads.
  let seen
  collectOrchestratorRows({
    registry,
    sessions: [session],
    stepOf: (value) => {
      seen = value
      return null
    },
  })
  assert.equal(seen, session)
})

test('composeViewState normalizes the step to { index, total } or null, never a second shape', () => {
  const payload = composeViewState({
    enabled: true,
    registry: { orchestrators: [{ sessionId: 'orch-1' }] },
    orchestrators: [{ sessionId: 'orch-1', step: { index: 1, total: 4 } }],
  })
  assert.deepEqual(payload.orchestrators[0].step, { index: 1, total: 4 })

  // index 0 is a real answer (nothing done yet), not "no data".
  const zero = composeViewState({ enabled: true, orchestrators: [{ sessionId: 'x', step: { index: 0, total: 3 } }] })
  assert.deepEqual(zero.orchestrators[0].step, { index: 0, total: 3 })

  // The client also tolerates totalSteps and a bare number, but the endpoint emits one shape:
  // anything else becomes null here instead of being silently translated into a second one.
  const otherShape = composeViewState({ enabled: true, orchestrators: [{ sessionId: 'x', step: 3, totalSteps: 5 }] })
  assert.equal(otherShape.orchestrators[0].step, null)

  const missing = composeViewState({ enabled: true, orchestrators: [{ sessionId: 'x' }] })
  assert.equal('step' in missing.orchestrators[0], true)
  assert.equal(missing.orchestrators[0].step, null)
})

test('a broken projection or agent registry degrades to Idle and live false instead of throwing', () => {
  const throwing = () => {
    throw new Error('no projection')
  }
  const rows = collectOrchestratorRows({
    registry: { orchestrators: [{ sessionId: 'orch-1', workspace: 'w', title: '日报', trackedAt: 1 }] },
    sessions: [{ id: 'orch-1' }, { id: 'child-1', header: { parentSession: 'orch-1' } }],
    stateOf: throwing,
    isLive: throwing,
  })
  assert.equal(rows[0].state, 'Idle')
  assert.equal(rows[0].live, false)
  assert.deepEqual(rows[0].workers, [])

  // 没有任何适配器也一样：空会话列表就是空的 orchestrators。
  assert.deepEqual(collectOrchestratorRows({ registry: { orchestrators: [] } }), [])
  assert.equal(collectOrchestratorRows({}).length, 0)
})

test('the Remote exposes the read method, the two draft transitions and the session picker (why: the picker adds a read and a creation)', () => {
  const service = new SecretaryRemote({ enabled: () => false, read: async () => ({}) })
  assert.equal(SECRETARY_SERVICE_KEY, 'orchestratorSecretary')
  assert.equal(SECRETARY_METHOD, 'secretaryState')
  assert.equal(SECRETARY_ENDPOINT, 'orchestratorSecretary/secretaryState')
  assert.equal(service.secretaryState.length, 0, 'SRC reflection reads a zero-parameter method')
  // SRC reflection reads the parameter names from the method source, so both writes take
  // exactly one plain parameter named draftId.
  assert.equal(service.confirmDraft.length, 1)
  assert.equal(service.discardDraft.length, 1)
  // 会话选择器：读方法零参数；新建方法一个可选 id（缺省由服务端补），SRC 只能看到名字。
  assert.equal(service.listCandidateSessions.length, 0)
  assert.equal(service.createMasterSession.length, 1)
  assert.deepEqual(service.typertRemote, {
    service,
    serviceKey: SECRETARY_SERVICE_KEY,
    namespace: SECRETARY_SERVICE_KEY,
  })
  const marker = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(service),
    '@deepseek-ai/dsh-typert-protocol/remote-methods',
  )?.value
  assert.equal(marker.version, 1)
  // Why changed: the session picker adds two endpoints, so the marker carries five methods.
  // The old three-method list asserted the picker out of existence.
  assert.deepEqual(marker.methods, [
    { method: 'secretaryState', invocation: { kind: 'direct' } },
    { method: 'confirmDraft', invocation: { kind: 'direct' } },
    { method: 'discardDraft', invocation: { kind: 'direct' } },
    { method: 'listCandidateSessions', invocation: { kind: 'direct' } },
    { method: 'createMasterSession', invocation: { kind: 'direct' } },
  ])
})

/** Every own path whose value is undefined; a JSON round trip drops those keys silently. */
function undefinedPaths(value, path = []) {
  if (value === undefined) return [path.join('.') || '<root>']
  if (value === null || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap((item, index) => undefinedPaths(item, [...path, String(index)]))
  return Object.keys(value).flatMap((key) => undefinedPaths(value[key], [...path, key]))
}

/** A messaging adapter that answers one fixed outcome. */
function fakeMessaging(outcome = { delivered: true }) {
  return {
    async deliver() {
      return outcome
    },
  }
}

/** A store with one pending Needs-input draft plus the Remote that transitions it. */
function draftFixture(messaging) {
  const store = createDraftStore()
  applyDraftTriggers({ store, orchestrators: [{ sessionId: 's-1', title: '构建', state: 'Needs input' }], now: 1000 })
  const service = new SecretaryRemote({
    enabled: () => true,
    read: async () => ({ drafts: store.list() }),
    drafts: store,
    masterSessionId: 'master-1',
    messaging,
  })
  return { store, service, draft: store.list()[0] }
}

test('both draft transitions answer values that survive a JSON round trip unchanged (why: src-json results cross the wire as raw JSON)', async () => {
  const sent = draftFixture(fakeMessaging())
  const confirmed = await sent.service.confirmDraft(sent.draft.id)
  assert.equal(confirmed.delivered, true)
  assert.equal(confirmed.draft.status, 'sent')

  const refused = draftFixture(fakeMessaging({ delivered: false, reason: 'no live agent' }))
  const failed = await refused.service.confirmDraft(refused.draft.id)
  assert.equal(failed.delivered, false)
  assert.equal(failed.reason, 'no live agent')

  const missing = draftFixture(fakeMessaging())
  const unknown = await missing.service.confirmDraft('draft-missing')
  assert.equal(unknown.reason, 'draft-missing')

  const discardedFixture = draftFixture(fakeMessaging())
  const discarded = await discardedFixture.service.discardDraft(discardedFixture.draft.id)
  assert.equal(discarded.draft.status, 'discarded')

  const decidedFixture = draftFixture(fakeMessaging())
  await decidedFixture.service.discardDraft(decidedFixture.draft.id)
  const decided = await decidedFixture.service.discardDraft(decidedFixture.draft.id)
  assert.equal(decided.reason, 'draft-decided')
  const unknownDiscard = await decidedFixture.service.discardDraft('draft-missing')
  assert.equal(unknownDiscard.reason, 'draft-missing')

  const off = new SecretaryRemote({ enabled: () => false })
  const disabledConfirm = await off.confirmDraft('anything')
  const disabledDiscard = await off.discardDraft('anything')

  const answers = { confirmed, failed, unknown, discarded, decided, unknownDiscard, disabledConfirm, disabledDiscard }
  for (const [name, value] of Object.entries(answers)) {
    assert.deepEqual(JSON.parse(JSON.stringify(value)), value, name + ' keeps every field through JSON')
    assert.deepEqual(undefinedPaths(value), [], name + ' carries no undefined-valued key')
  }
})

test('the switch off returns the empty payload and reads neither the host nor any archive', async () => {
  // 开关关闭时 read 一次都不该被叫；票 15 之后也确实没有任何归档可读。
  let reads = 0
  const service = new SecretaryRemote({
    enabled: () => false,
    read: async () => {
      reads += 1
      return { reports: [] }
    },
  })

  assert.deepEqual(await service.secretaryState(), emptyViewState())
  assert.equal(reads, 0, 'the switch off never calls read')
})

test('the switch on calls read exactly once and composes its four segments', async () => {
  let reads = 0
  const service = new SecretaryRemote({
    enabled: () => true,
    read: async () => {
      reads += 1
      return {
        registry: { masterSessionId: 'm-1', orchestrators: [{ sessionId: 'orch-1', workspace: 'w', title: '日报', trackedAt: 1 }] },
        orchestrators: [ORCHESTRATOR],
        reports: [REPORT],
        drafts: [],
        policy: { beatSeconds: 300 },
      }
    },
  })
  const payload = await service.secretaryState()
  assert.equal(reads, 1, 'one snapshot per call, no second read')
  assert.equal(payload.enabled, true)
  assert.equal(payload.policy.beatSeconds, 300)
  assert.deepEqual(payload.orchestrators[0], ORCHESTRATOR)
  assert.deepEqual(payload.reports[0], REPORT)
  assert.deepEqual(payload.drafts, [])
})

test('a failing read reaches the caller instead of faking an empty view', async () => {
  const service = new SecretaryRemote({
    enabled: () => true,
    read: async () => {
      throw new Error('registry unreadable')
    },
  })
  await assert.rejects(() => service.secretaryState(), /registry unreadable/)

  const missing = new SecretaryRemote({ enabled: () => true })
  await assert.rejects(() => missing.secretaryState(), /no read function/)
})
