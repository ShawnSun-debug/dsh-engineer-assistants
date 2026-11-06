import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import {
  DEFAULT_REPORTS_ROOT,
  SECRETARY_ENDPOINT,
  SECRETARY_METHOD,
  SECRETARY_SERVICE_KEY,
  SecretaryRemote,
  VIEW_REPORT_LIMIT,
  collectOrchestratorRows,
  composeViewState,
  emptyViewState,
  listReportRows,
  notifyOnFrom,
} from '../lib/secretary-panel.js'
import { applyDraftTriggers, createDraftStore } from '../lib/secretary-nudge.js'
import { renderPlanReport, renderReport } from '../lib/secretary-report.js'

// Four fields, all of them read from config by the endpoint. The report root and the view limit
// are constants of the reader, not policy: a field the endpoint never sends would be a lie in the
// settings tab, and neither of them can be changed from there.
const EMPTY_POLICY = {
  beatSeconds: 180,
  maxRunSeconds: 7200,
  notifyOn: { state: true, step: true, block: true, deliverable: true, timeout: true },
  promptText: '',
}

const ORCHESTRATOR = {
  sessionId: 'orch-1',
  title: '日报',
  workspace: 'w',
  live: true,
  state: 'Working',
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

  // step / lastError are gone on purpose: with no data source they were always null
  // and made the view's branches unreachable. They return with a ticket that has one.
  assert.deepEqual(Object.keys(payload.orchestrators[0]), [
    'sessionId',
    'title',
    'workspace',
    'live',
    'state',
    'workers',
    'beats',
    'lastReport',
  ])
  assert.deepEqual(Object.keys(payload.orchestrators[0].workers[0]), ['id', 'state', 'summary'])
  assert.deepEqual(Object.keys(payload.orchestrators[0].beats), ['count', 'startedAt', 'capped', 'stoppedReason'])
  assert.equal('step' in payload.orchestrators[0], false)
  assert.equal('lastError' in payload.orchestrators[0], false)
  assert.deepEqual(payload.orchestrators[0], ORCHESTRATOR)

  assert.deepEqual(Object.keys(payload.reports[0]), ['sessionId', 'at', 'kind', 'path', 'bytes', 'changes', 'error'])
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

  assert.deepEqual(Object.keys(payload.policy), ['beatSeconds', 'maxRunSeconds', 'notifyOn', 'promptText'])
  assert.deepEqual(payload.policy, {
    beatSeconds: 300,
    maxRunSeconds: 900,
    notifyOn: { state: false, step: false, block: false, deliverable: false, timeout: false },
    promptText: '口径',
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

test('the policy segment carries the four real fields and nothing else', () => {
  assert.deepEqual(emptyViewState().policy, EMPTY_POLICY)
  assert.deepEqual(Object.keys(EMPTY_POLICY), ['beatSeconds', 'maxRunSeconds', 'notifyOn', 'promptText'])
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
  assert.equal(DEFAULT_REPORTS_ROOT, '.scratch/master-secretary/reports')
  assert.equal(VIEW_REPORT_LIMIT, 50)
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

test('the Remote exposes the read method plus the two draft transitions (why: ticket 08 adds confirm and discard)', () => {
  const service = new SecretaryRemote({ enabled: () => false, read: async () => ({}) })
  assert.equal(SECRETARY_SERVICE_KEY, 'orchestratorSecretary')
  assert.equal(SECRETARY_METHOD, 'secretaryState')
  assert.equal(SECRETARY_ENDPOINT, 'orchestratorSecretary/secretaryState')
  assert.equal(service.secretaryState.length, 0, 'SRC reflection reads a zero-parameter method')
  // SRC reflection reads the parameter names from the method source, so both writes take
  // exactly one plain parameter named draftId.
  assert.equal(service.confirmDraft.length, 1)
  assert.equal(service.discardDraft.length, 1)
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
  assert.deepEqual(marker.methods, [
    { method: 'secretaryState', invocation: { kind: 'direct' } },
    { method: 'confirmDraft', invocation: { kind: 'direct' } },
    { method: 'discardDraft', invocation: { kind: 'direct' } },
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

test('the switch off returns the empty payload and reads neither the host nor the archive', async () => {
  // 会记录调用次数的假 fs：开关关闭时它必须一次都没被叫到。
  const calls = []
  const fakeFs = {
    async readdir(path) {
      calls.push(['readdir', path])
      return []
    },
    async stat(path) {
      calls.push(['stat', path])
      return { size: 0, mtimeMs: 0 }
    },
    async readFile(path) {
      calls.push(['readFile', path])
      return '# 秘书规划\n'
    },
  }
  let reads = 0
  const service = new SecretaryRemote({
    enabled: () => false,
    read: async () => {
      reads += 1
      return { reports: await listReportRows({ fs: fakeFs, workspaces: ['w'] }) }
    },
  })

  assert.deepEqual(await service.secretaryState(), emptyViewState())
  assert.equal(reads, 0, 'the switch off never calls read')
  assert.deepEqual(calls, [], 'and therefore touches no directory')
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

test('a reports directory that was never written is an empty list, not a failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'secretary-panel-'))
  try {
    assert.deepEqual(await listReportRows({ fs: fsp, workspaces: [join(dir, 'never-written')] }), [])
    assert.deepEqual(await listReportRows({ fs: fsp, workspaces: [] }), [])
    assert.deepEqual(await listReportRows({ fs: fsp, workspaces: ['', '  '] }), [])
    assert.deepEqual(await listReportRows({ fs: fsp }), [])
    assert.deepEqual(await listReportRows({}), [])

    // 目录存在但一份报告都没有，同样是空数组。
    await mkdir(join(dir, ...DEFAULT_REPORTS_ROOT.split('/')), { recursive: true })
    assert.deepEqual(await listReportRows({ fs: fsp, workspaces: [dir] }), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('archived reports are listed newest first with what the history tab renders (why: the report sections are the groups now)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'secretary-reports-'))
  try {
    const root = join(dir, '.scratch', 'master-secretary', 'reports')
    const conversation = join(root, 'orch-1')
    await mkdir(conversation, { recursive: true })

    const planPath = join(conversation, '12-00.md')
    await writeFile(
      planPath,
      renderPlanReport({
        at: Date.UTC(2026, 0, 2, 3, 0),
        session: 'orch-1',
        plan: { steps: [{ index: 1, name: '修登录', detail: '让重试可用' }] },
      }),
      'utf8',
    )
    const deltaPath = join(conversation, '12-03.md')
    const deltaText = renderReport({
      kind: 'delta',
      at: Date.UTC(2026, 0, 2, 3, 3),
      session: 'orch-1',
      orchestrator: { state: 'Working', summary: '在写报告' },
      diff: { completed: [{ name: 'w-1', from: 'Working', to: 'Completed' }], blocked: ['w-2 等回话'], flipped: [] },
    })
    await writeFile(deltaPath, deltaText, 'utf8')
    const summaryPath = join(root, '_summary.md')
    await writeFile(summaryPath, '# 秘书汇总\n\n- 会话数：1\n', 'utf8')

    // mtime 决定顺序，写成确定值，测试不依赖文件系统的写入时刻。
    await utimes(planPath, new Date(Date.UTC(2026, 0, 2, 3, 0)), new Date(Date.UTC(2026, 0, 2, 3, 0)))
    await utimes(deltaPath, new Date(Date.UTC(2026, 0, 2, 3, 3)), new Date(Date.UTC(2026, 0, 2, 3, 3)))
    await utimes(summaryPath, new Date(Date.UTC(2026, 0, 1, 0, 0)), new Date(Date.UTC(2026, 0, 1, 0, 0)))

    const rows = await listReportRows({ fs: fsp, workspaces: [dir] })
    assert.deepEqual(
      rows.map((row) => [row.sessionId, row.kind]),
      [
        ['orch-1', 'delta'],
        ['orch-1', 'plan'],
        ['', 'summary'],
      ],
    )
    assert.equal(rows[0].path, deltaPath)
    assert.equal(rows[0].at, Date.UTC(2026, 0, 2, 3, 3))
    // Why changed (ticket 08): the report's ### 新完成 / ### 新卡住 / ### 状态翻转 sections
    // are the grouping now, so the endpoint hands over the same three arrays
    // lib/secretary-diff.js returns instead of one flat sentence list.
    assert.deepEqual(rows[0].changes, {
      completed: ['w-1：Working → Completed'],
      blocked: ['w-2 等回话'],
      flipped: [],
    })
    assert.equal(rows[0].bytes, (await readFile(deltaPath)).length)
    assert.equal(rows[0].error, null)
    // 规划首报没有差异段，所以三组都是空的——不是"没有变化"的编造值。
    assert.deepEqual(rows[1].changes, { completed: [], blocked: [], flipped: [] })
    assert.deepEqual(rows[2].changes, { completed: [], blocked: [], flipped: [] })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a report written before the sectioned diff keeps its flat list (why: older archives have no ### groups)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'secretary-legacy-'))
  try {
    const conversation = join(dir, '.scratch', 'master-secretary', 'reports', 'orch-1')
    await mkdir(conversation, { recursive: true })
    const legacy = [
      '# 秘书汇报',
      '',
      '- 时间：2026-01-02 03:03',
      '- 会话：orch-1',
      '- 类型：增量',
      '',
      '## 差异',
      '',
      '- w-1：Working → Completed',
      '- w-2 等回话',
      '',
      '## 产出',
      '',
      '无',
      '',
    ].join('\n')
    await writeFile(join(conversation, '12-03.md'), legacy, 'utf8')
    const rows = await listReportRows({ fs: fsp, workspaces: [dir] })
    assert.equal(rows.length, 1)
    // The endpoint cannot tell which group an unlabeled bullet belongs to, so it keeps the
    // old flat shape for the view's fallback instead of mislabeling it under "completed".
    assert.deepEqual(rows[0].changes, ['w-1：Working → Completed', 'w-2 等回话'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the report list is capped by VIEW_REPORT_LIMIT', async () => {
  const root = join('w', '.scratch', 'master-secretary', 'reports')
  const entries = Array.from({ length: VIEW_REPORT_LIMIT + 10 }, (_, index) => ({
    name: String(index).padStart(2, '0') + '-00.md',
    isDirectory: () => false,
  }))
  const io = {
    async readdir(path) {
      return path === root ? entries : []
    },
    async stat(path) {
      return { size: 3, mtimeMs: Number(basename(path).slice(0, 2)) * 1000 }
    },
    async readFile() {
      return '# 秘书规划\n'
    },
  }
  const rows = await listReportRows({ fs: io, workspaces: ['w'] })
  assert.equal(rows.length, VIEW_REPORT_LIMIT)
  assert.equal(rows[0].at, (VIEW_REPORT_LIMIT + 9) * 1000, 'newest first')
  assert.equal(rows[rows.length - 1].at, 10 * 1000)
})

test('a report that cannot be read keeps its row with the failure, it is not hidden', async () => {
  const io = {
    async readdir(path) {
      if (path.endsWith('reports')) return [{ name: 'orch-1', isDirectory: () => true }]
      return [{ name: '12-00.md', isDirectory: () => false }]
    },
    async stat() {
      return { size: 10, mtimeMs: 5 }
    },
    async readFile() {
      throw new Error('EACCES')
    },
  }
  const rows = await listReportRows({ fs: io, workspaces: ['w'] })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].sessionId, 'orch-1')
  assert.equal(rows[0].kind, 'unknown')
  assert.equal(rows[0].error, 'EACCES')

  // 一个在两次调用之间消失的文件不是一行历史。
  const vanishing = {
    async readdir() {
      return [{ name: '12-00.md', isDirectory: () => false }]
    },
    async stat() {
      throw new Error('ENOENT')
    },
    async readFile() {
      return ''
    },
  }
  assert.deepEqual(await listReportRows({ fs: vanishing, workspaces: ['w'] }), [])
})
