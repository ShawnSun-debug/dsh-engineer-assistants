import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SecretaryRemote,
  collectCandidateSessions,
  createMasterSession,
  readSessionTitles,
  titleOf,
} from '../lib/secretary-panel.js'

/**
 * 会话选择器的后端（票：会话选择器）。
 *
 * 这里断言的是三件真实的事：标题从宿主真实来源读、候选会话按三级数据源降级、
 * 新建 Master 会话走 agents.create 并把 id 写回配置。假宿主只提供这些服务，测试
 * 记录每一次调用，所以"没读会话正文"也是被证明的，不是自称的。
 */

const PICKER_KEYS = [
  'sessionId',
  'title',
  'titleMissing',
  'cwd',
  'live',
  'running',
  'updatedAt',
  'parentSession',
  'delegationDepth',
  'isMaster',
  'isOrchestrator',
]

// ---- 1. 标题来源 -------------------------------------------------------------

test('titleOf reads the live title service instead of fields the Session does not have', async () => {
  // 旧实现读 session.title / session.header.title：宿主两个字段都不存在，所以恒为空串。
  // 真标题在 ctx.sessionTitle.get(session) 返回的快照里。
  const session = { id: 's-1', header: { id: 's-1' } }
  const sessionTitle = { get: (target) => (target.id === 's-1' ? { title: '真标题', eventSeq: 3 } : undefined) }
  assert.equal(await titleOf(session, { sessionTitle }), '真标题')
  assert.equal(await titleOf({ id: 's-2' }, { sessionTitle }), '', 'no snapshot is no title')
})

test('titleOf falls back to one readTitleSnapshots batch when the live service cannot answer', async () => {
  const calls = []
  const sessionQuery = {
    async readTitleSnapshots(ids) {
      calls.push([...ids])
      return ids.map((sessionId) => ({
        sessionId,
        status: 'fulfilled',
        value: { session: { id: sessionId }, title: { title: '冷读标题' } },
      }))
    },
  }
  assert.equal(await titleOf({ id: 'cold-1', header: { id: 'cold-1' } }, { sessionQuery }), '冷读标题')
  assert.deepEqual(calls, [['cold-1']], 'the batch API is called with the ids, not one call per field read')
})

test('titleOf answers the empty string when no source can name the session', async () => {
  assert.equal(await titleOf({ id: 's-1' }, {}), '')
  assert.equal(await titleOf({ id: 's-1' }, { sessionQuery: null }), '')
  // A rejected observation and a throwing read are both "no title", never an exception.
  const rejected = {
    async readTitleSnapshots(ids) {
      return ids.map((sessionId) => ({ sessionId, status: 'rejected', reason: new Error('unreadable') }))
    },
  }
  assert.equal(await titleOf({ id: 's-1' }, { sessionQuery: rejected }), '')
  const throwing = {
    async readTitleSnapshots() {
      throw new Error('boom')
    },
  }
  assert.equal(await titleOf({ id: 's-1' }, { sessionQuery: throwing }), '')
})

test('readSessionTitles asks the live service first and batches only the rest', async () => {
  const calls = []
  const sessionTitle = { get: (session) => (session.id === 'live-1' ? { title: '活的' } : undefined) }
  const sessionQuery = {
    async readTitleSnapshots(ids) {
      calls.push([...ids])
      return ids.map((id) => ({ sessionId: id, status: 'fulfilled', value: { title: { title: '冷-' + id } } }))
    },
  }
  const titles = await readSessionTitles([{ id: 'live-1' }, { id: 'cold-1' }, { id: 'cold-2' }], {
    sessionTitle,
    sessionQuery,
  })
  assert.deepEqual(calls, [['cold-1', 'cold-2']])
  assert.equal(titles.get('live-1'), '活的')
  assert.equal(titles.get('cold-2'), '冷-cold-2')
})

// ---- 2. 候选会话：三级数据源 ---------------------------------------------------

test('level one takes updatedAt, running, cwd and live from sessionController.list', async () => {
  const controller = {
    async list() {
      return {
        items: [
          { sessionId: 'a', updatedAt: 300, running: true, agentAvailable: true, cwd: 'D:\\a', parentSessionId: 'p-1' },
          { sessionId: 'b', updatedAt: 500, running: false, agentAvailable: false },
        ],
      }
    },
  }
  const titleCalls = []
  const sessionQuery = {
    async readTitleSnapshots(ids) {
      titleCalls.push([...ids])
      return ids.map((sessionId) => ({ sessionId, status: 'fulfilled', value: { title: { title: 'T-' + sessionId } } }))
    },
  }
  const rows = await collectCandidateSessions({
    registry: { masterSessionId: 'a', orchestrators: [{ sessionId: 'b', workspace: '', title: '', trackedAt: 1 }] },
    sessionController: controller,
    sessionQuery,
  })

  assert.deepEqual(
    rows.map((row) => row.sessionId),
    ['b', 'a'],
    'updatedAt descending',
  )
  assert.deepEqual(rows[0], {
    sessionId: 'b',
    title: 'T-b',
    titleMissing: false,
    cwd: null,
    live: false,
    running: false,
    updatedAt: 500,
    parentSession: null,
    delegationDepth: 0,
    isMaster: false,
    isOrchestrator: true,
  })
  assert.deepEqual(rows[1], {
    sessionId: 'a',
    title: 'T-a',
    titleMissing: false,
    cwd: 'D:\\a',
    live: true,
    running: true,
    updatedAt: 300,
    parentSession: 'p-1',
    delegationDepth: 0,
    isMaster: true,
    isOrchestrator: false,
  })
  assert.deepEqual(titleCalls, [['a', 'b']], 'one batch title read for the whole list')
})

test('level two falls back to sessionQuery.listSessions, its title snapshots and the agent status', async () => {
  const sessionQuery = {
    async listSessions() {
      return [
        { header: { id: 'q-1', createdAt: 700, cwd: 'D:\\q', parentSession: 'root-1', delegationDepth: 2 }, live: true },
        { header: { id: 'q-2', createdAt: 800 }, live: false },
      ]
    },
    async readTitleSnapshots(ids) {
      return ids.map((sessionId) =>
        sessionId === 'q-1'
          ? { sessionId, status: 'fulfilled', value: { title: { title: '查询标题' } } }
          : { sessionId, status: 'rejected', reason: new Error('no title in the log') },
      )
    },
  }
  const agents = { get: (sessionId) => (sessionId === 'q-1' ? { status: 'running' } : undefined) }

  const rows = await collectCandidateSessions({
    registry: { masterSessionId: '', orchestrators: [] },
    sessionQuery,
    agents,
  })

  assert.deepEqual(
    rows.map((row) => [row.sessionId, row.title, row.titleMissing, row.live, row.running, row.updatedAt]),
    [
      ['q-2', '', true, false, false, 800],
      ['q-1', '查询标题', false, true, true, 700],
    ],
  )
  assert.equal(rows[1].cwd, 'D:\\q')
  assert.equal(rows[1].parentSession, 'root-1')
  assert.equal(rows[1].delegationDepth, 2)
})

test('level three falls back to the live session registry and header.createdAt', async () => {
  const sessions = {
    list: () => [
      { id: 's-1', header: { id: 's-1', createdAt: 100, cwd: 'D:\\s1' } },
      { id: 's-2', header: { id: 's-2', createdAt: 200 } },
    ],
  }
  const agents = { get: (sessionId) => (sessionId === 's-2' ? { id: 's-2', status: 'idle' } : undefined) }
  const sessionTitle = { get: (session) => (session.id === 's-1' ? { title: '标题一' } : undefined) }

  const rows = await collectCandidateSessions({
    registry: { masterSessionId: 's-2', orchestrators: [{ sessionId: 's-1', workspace: '', title: '', trackedAt: 1 }] },
    sessions,
    agents,
    sessionTitle,
  })

  assert.deepEqual(
    rows.map((row) => [row.sessionId, row.title, row.updatedAt, row.live, row.running, row.isMaster, row.isOrchestrator]),
    [
      ['s-2', '', 200, true, true, true, false],
      ['s-1', '标题一', 100, true, false, false, true],
    ],
  )
  assert.equal(rows[0].titleMissing, true)
  assert.equal(rows[1].cwd, 'D:\\s1')
})

test('no data source at all is an empty list, never an exception', async () => {
  assert.deepEqual(await collectCandidateSessions({}), [])
  assert.deepEqual(await collectCandidateSessions(), [])
  const broken = {
    async list() {
      throw new Error('no controller')
    },
  }
  assert.deepEqual(await collectCandidateSessions({ sessionController: broken }), [])
})

test('the picker sees metadata only: a conversation is never read', async () => {
  let eventReads = 0
  const sessionQuery = {
    async listSessions() {
      return [{ header: { id: 'q-1', createdAt: 5 }, live: true }]
    },
    async readTitleSnapshots(ids) {
      return ids.map((sessionId) => ({ sessionId, status: 'fulfilled', value: { title: { title: '密' } } }))
    },
    async readSession() {
      eventReads += 1
      throw new Error('the picker must not read a conversation')
    },
    async readSurface() {
      eventReads += 1
      throw new Error('the picker must not read a surface')
    },
    async listEvents() {
      eventReads += 1
      throw new Error('the picker must not list events')
    },
  }
  const rows = await collectCandidateSessions({ sessionQuery })
  assert.equal(eventReads, 0)
  assert.deepEqual(Object.keys(rows[0]).sort(), [...PICKER_KEYS].sort(), 'exactly the contract metadata fields')
  assert.equal(JSON.stringify(rows).includes('the picker must not'), false, 'no inward error text leaks outward')
})

// ---- 3. 新建 Master 会话 ------------------------------------------------------

test('createMasterSession creates a workspace-free session through agents.create and records the id', async () => {
  const created = []
  const writes = []
  const agents = {
    get: () => undefined,
    async create(options) {
      created.push(options)
      return { agent: { id: options.sessionId } }
    },
  }
  const result = await createMasterSession({ agents, writeMasterSessionId: (id) => writes.push(id) })
  assert.deepEqual(result, { ok: true, sessionId: 'orchestrator-master' })
  // 与 master-session.js 同一条路径：只有 sessionId，没有 meta，所以没有 cwd。
  assert.deepEqual(created, [{ sessionId: 'orchestrator-master' }])
  assert.equal(Object.hasOwn(created[0], 'meta'), false)
  assert.deepEqual(writes, ['orchestrator-master'], 'the new id is written to secretaryMasterSessionId')
})

test('the fixed id is only the default: a custom id is honoured', async () => {
  const created = []
  const agents = {
    get: () => undefined,
    async create(options) {
      created.push(options)
      return { agent: { id: options.sessionId } }
    },
  }
  const result = await createMasterSession({ agents, writeMasterSessionId: () => {}, sessionId: 'my-master' })
  assert.deepEqual(result, { ok: true, sessionId: 'my-master' })
  assert.deepEqual(created, [{ sessionId: 'my-master' }])
})

test('a failing create is reported, never swallowed, and the config is left alone', async () => {
  const writes = []
  const agents = {
    get: () => undefined,
    async create() {
      throw new Error('session id already exists')
    },
  }
  const result = await createMasterSession({ agents, writeMasterSessionId: (id) => writes.push(id) })
  assert.equal(result.ok, false)
  assert.match(result.error, /session id already exists/)
  assert.deepEqual(writes, [])

  const unavailable = await createMasterSession({ agents: {}, writeMasterSessionId: () => {} })
  assert.equal(unavailable.ok, false)
  assert.match(unavailable.error, /agents\.create/)
})

test('an id the host already holds is a conflict, not a second master', async () => {
  let created = 0
  const agents = {
    get: (id) => (id === 'orchestrator-master' ? { id } : undefined),
    async create() {
      created += 1
      return { agent: {} }
    },
  }
  const result = await createMasterSession({ agents, writeMasterSessionId: () => {} })
  assert.equal(result.ok, false)
  assert.match(result.error, /already exists/)
  assert.equal(created, 0, 'the host is not asked to mint a second session under that id')
})

test('a created session whose config write failed is reported truthfully', async () => {
  const agents = {
    get: () => undefined,
    async create(options) {
      return { agent: { id: options.sessionId } }
    },
  }
  const result = await createMasterSession({
    agents,
    writeMasterSessionId: async () => {
      throw new Error('config is read-only')
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.sessionId, 'orchestrator-master', 'the session really exists, so the caller is told its id')
  assert.match(result.error, /config is read-only/)
})

// ---- 4. Remote 接线 ------------------------------------------------------------

test('the Remote answers the candidate list from the injected host services', async () => {
  const service = new SecretaryRemote({
    enabled: () => true,
    registry: { masterSessionId: 'a', orchestrators: [] },
    sessionController: {
      async list() {
        return { items: [{ sessionId: 'a', updatedAt: 9, running: false, agentAvailable: true }] }
      },
    },
    sessionQuery: {
      async readTitleSnapshots(ids) {
        return ids.map((sessionId) => ({ sessionId, status: 'fulfilled', value: { title: { title: '甲' } } }))
      },
    },
  })
  const rows = await service.listCandidateSessions()
  assert.deepEqual(rows.map((row) => [row.sessionId, row.title, row.isMaster]), [['a', '甲', true]])
})

test('the Remote answers an empty list while the secretary is off', async () => {
  const service = new SecretaryRemote({ enabled: () => false })
  assert.deepEqual(await service.listCandidateSessions(), [])
  assert.equal((await service.createMasterSession()).ok, false)
})

test('the Remote creates a master session through the same path', async () => {
  const calls = []
  const service = new SecretaryRemote({
    enabled: () => true,
    agents: {
      get: () => undefined,
      async create(options) {
        calls.push(options)
        return { agent: { id: options.sessionId } }
      },
    },
    writeMasterSessionId: async (id) => calls.push(['write', id]),
  })
  assert.deepEqual(await service.createMasterSession(), { ok: true, sessionId: 'orchestrator-master' })
  assert.deepEqual(calls, [{ sessionId: 'orchestrator-master' }, ['write', 'orchestrator-master']])
})
