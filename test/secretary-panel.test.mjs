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
import { renderPlanReport, renderReport } from '../lib/secretary-report.js'

const EMPTY_POLICY = {
  beatSeconds: 180,
  maxRunSeconds: 7200,
  notifyOn: { state: true, step: true, block: true, deliverable: true, timeout: true },
  promptText: '',
  reportsRoot: '.scratch/master-secretary/reports',
  viewReportLimit: 50,
}

const ORCHESTRATOR = {
  sessionId: 'orch-1',
  title: '日报',
  workspace: 'w',
  live: true,
  state: 'Working',
  step: { index: 2, total: 5, done: false },
  workers: [{ id: 'w-1', state: 'Working', summary: '写报告' }],
  beats: { count: 2, startedAt: 1000, capped: false, stoppedReason: null },
  lastReport: { path: '/r/12-03.md', at: 90, kind: 'delta' },
  lastError: null,
}

const REPORT = {
  sessionId: 'orch-1',
  at: 90,
  kind: 'delta',
  path: '/r/12-03.md',
  bytes: 120,
  changes: ['w-1：Working → Completed'],
  error: null,
}

const DRAFT = {
  id: 'd-1',
  createdAt: 80,
  orchestratorId: 'orch-1',
  targetSessionId: 'orch-1',
  targetTitle: '日报',
  reason: 'blocked',
  text: '需要你拍板',
  status: 'pending',
  decidedAt: null,
  error: null,
}

test('the payload carries five segments with exactly the contract field names', () => {
  const payload = composeViewState({
    enabled: true,
    registry: { masterSessionId: 'm-1', orchestrators: [{ sessionId: 'orch-1', workspace: 'w', title: '日报', trackedAt: 7 }] },
    orchestrators: [ORCHESTRATOR],
    reports: [REPORT],
    drafts: [DRAFT],
    policy: { beatSeconds: 300, maxRunSeconds: 900, notifyOn: notifyOnFrom([]), promptText: '口径', reportsRoot: '.scratch/x', viewReportLimit: 7 },
  })

  assert.deepEqual(Object.keys(payload), ['enabled', 'registry', 'orchestrators', 'reports', 'drafts', 'policy'])
  assert.equal(payload.enabled, true)

  assert.deepEqual(Object.keys(payload.registry), ['masterSessionId', 'orchestrators', 'conflict'])
  assert.deepEqual(Object.keys(payload.registry.orchestrators[0]), ['sessionId', 'workspace', 'title', 'trackedAt'])
  assert.deepEqual(payload.registry.orchestrators[0], { sessionId: 'orch-1', workspace: 'w', title: '日报', trackedAt: 7 })

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
    'lastError',
  ])
  assert.deepEqual(Object.keys(payload.orchestrators[0].workers[0]), ['id', 'state', 'summary'])
  assert.deepEqual(Object.keys(payload.orchestrators[0].beats), ['count', 'startedAt', 'capped', 'stoppedReason'])
  assert.deepEqual(Object.keys(payload.orchestrators[0].step), ['index', 'total', 'done'])
  assert.deepEqual(payload.orchestrators[0], ORCHESTRATOR)

  assert.deepEqual(Object.keys(payload.reports[0]), ['sessionId', 'at', 'kind', 'path', 'bytes', 'changes', 'error'])
  assert.deepEqual(payload.reports[0], REPORT)

  assert.deepEqual(Object.keys(payload.drafts[0]), [
    'id',
    'createdAt',
    'orchestratorId',
    'targetSessionId',
    'targetTitle',
    'reason',
    'text',
    'status',
    'decidedAt',
    'error',
  ])
  assert.deepEqual(payload.drafts[0], DRAFT)

  assert.deepEqual(Object.keys(payload.policy), [
    'beatSeconds',
    'maxRunSeconds',
    'notifyOn',
    'promptText',
    'reportsRoot',
    'viewReportLimit',
  ])
  assert.deepEqual(payload.policy, {
    beatSeconds: 300,
    maxRunSeconds: 900,
    notifyOn: { state: false, step: false, block: false, deliverable: false, timeout: false },
    promptText: '口径',
    reportsRoot: '.scratch/x',
    viewReportLimit: 7,
  })
})

test('the empty payload is the stable five-segment shape the view can always render', () => {
  const empty = emptyViewState()
  assert.deepEqual(empty, {
    enabled: false,
    registry: { masterSessionId: '', orchestrators: [], conflict: null },
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
  assert.deepEqual(payload.registry, { masterSessionId: '', orchestrators: [], conflict: null })
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

test('the policy segment falls back to the documented defaults and honours what it is given', () => {
  assert.deepEqual(emptyViewState().policy, EMPTY_POLICY)
  assert.equal(VIEW_REPORT_LIMIT, EMPTY_POLICY.viewReportLimit)
  assert.equal(DEFAULT_REPORTS_ROOT, EMPTY_POLICY.reportsRoot)
  assert.deepEqual(notifyOnFrom(['state-flip', 'blocked', 'later-additions']), {
    state: true,
    step: false,
    block: true,
    deliverable: false,
    timeout: false,
  })
  const custom = composeViewState({ policy: { beatSeconds: 300, maxRunSeconds: 900 } }).policy
  assert.equal(custom.beatSeconds, 300)
  assert.equal(custom.maxRunSeconds, 900)
  assert.deepEqual(custom.notifyOn, EMPTY_POLICY.notifyOn, 'a missing switch list defaults to all five on')
  assert.equal(custom.reportsRoot, DEFAULT_REPORTS_ROOT)
  assert.equal(custom.viewReportLimit, VIEW_REPORT_LIMIT)
})

test('reports and drafts arrive newest first and the report list stops at the policy limit', () => {
  const reports = Array.from({ length: 4 }, (_, index) => ({
    sessionId: 'orch-1',
    at: index,
    kind: 'delta',
    path: '/r/' + index + '.md',
    bytes: 1,
    changes: [],
    error: null,
  })).concat([{ sessionId: 'orch-1', at: 99, kind: 'delta', path: '', bytes: 0, changes: [], error: null }])
  const payload = composeViewState({
    reports,
    // 没有路径的行是垃圾行，不是一条历史。
    policy: { viewReportLimit: 2 },
    drafts: [
      { id: 'old', createdAt: 1 },
      { id: 'new', createdAt: 5 },
    ],
  })
  assert.deepEqual(payload.reports.map((row) => row.at), [3, 2])
  assert.deepEqual(payload.drafts.map((row) => row.id), ['new', 'old'])
})

test('composing never writes into the input it was handed', () => {
  const input = {
    enabled: true,
    registry: { masterSessionId: 'm-1', orchestrators: [{ sessionId: 'orch-1', workspace: 'w', title: '日报', trackedAt: 7 }] },
    orchestrators: [{ ...ORCHESTRATOR, workers: [...ORCHESTRATOR.workers] }],
    reports: [{ ...REPORT, changes: [...REPORT.changes] }],
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
    step: null,
    workers: [
      { id: 'child-1', state: 'Needs input', summary: '摘要-child-1' },
      { id: 'child-2', state: 'Completed', summary: '摘要-child-2' },
    ],
    beats: { count: 0, startedAt: null, capped: false, stoppedReason: null },
    lastReport: { path: '/r/12-03.md', at: 90, kind: 'delta' },
    lastError: null,
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
    lastError: null,
  })
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

test('the Remote exposes one zero-argument direct method at the expected endpoint', () => {
  const service = new SecretaryRemote({ enabled: () => false, read: async () => ({}) })
  assert.equal(SECRETARY_SERVICE_KEY, 'orchestratorSecretary')
  assert.equal(SECRETARY_METHOD, 'secretaryState')
  assert.equal(SECRETARY_ENDPOINT, 'orchestratorSecretary/secretaryState')
  assert.equal(service.secretaryState.length, 0, 'SRC reflection reads a zero-parameter method')
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
  assert.deepEqual(marker.methods, [{ method: 'secretaryState', invocation: { kind: 'direct' } }])
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

test('archived reports are listed newest first with what the history tab renders', async () => {
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
    assert.deepEqual(rows[0].changes, ['w-1：Working → Completed', 'w-2 等回话'])
    assert.equal(rows[0].bytes, (await readFile(deltaPath)).length)
    assert.equal(rows[0].error, null)
    // 规划首报没有差异段，所以 changes 为空——不是"没有变化"的编造值。
    assert.deepEqual(rows[1].changes, [])
    assert.deepEqual(rows[2].changes, [])
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
