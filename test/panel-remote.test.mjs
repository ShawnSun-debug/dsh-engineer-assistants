import assert from 'node:assert/strict'
import test from 'node:test'

import { assignSession, reserveChildId } from '../lib/assignments.js'
import { FIXED_SECTIONS } from '../lib/panel-model.js'
import {
  PANEL_ENDPOINT,
  PANEL_ENDED_LIMIT,
  PANEL_METHOD,
  PANEL_SERVICE_KEY,
  PanelRemote,
  panelPayloadOf,
} from '../lib/panel-remote.js'

const parent = 'session-master-1'
const address = (childSessionId, extra = {}) => ({ parentSessionId: parent, childSessionId, mode: 'continuable', ...extra })

function registry() {
  let rows = reserveChildId({}, { id: 'w1', parentId: parent, now: 1000 })
  rows = assignSession(rows, { sessionId: 'w1', kind: 'worker', parentId: parent, presetId: 'implementer', status: 'running', startedAt: 1000 })
  rows = reserveChildId(rows, { id: 'w2', parentId: parent, now: 2000 })
  rows = assignSession(rows, { sessionId: 'w2', kind: 'worker', parentId: parent, presetId: 'reviewer', status: 'running', startedAt: 2000 })
  return rows
}

test('one call carries both halves: what the dock shows, and what each row does', async () => {
  const remote = new PanelRemote({
    assignments: registry(),
    parentId: parent,
    masterSessionId: 'orchestrator-master',
    addressOf: (id) => (id === 'w1' ? address('w1') : undefined),
  })
  const payload = await remote.panelState()

  assert.deepEqual(payload.model.fixed.map((row) => row.id), [...FIXED_SECTIONS])
  assert.equal(payload.model.master.sessionId, 'orchestrator-master')
  assert.deepEqual(payload.model.workers.map((row) => row.sessionId), ['w1', 'w2'])

  // 动作表跟着同一份模型走：master 打开会话，两个 worker 都是 open-worker，只有 w1 带地址。
  const master = payload.actions.fixed.find((row) => row.id === 'master')
  assert.equal(master.action.kind, 'open-session')
  assert.equal(master.action.sessionId, 'orchestrator-master')
  const [first, second] = payload.actions.workers
  assert.deepEqual(first.action.kind, 'open-worker')
  assert.equal(typeof first.action.address, 'string', 'a resolvable worker carries its dock address')
  assert.equal(second.action.address, undefined, 'one that does not resolve is still clickable')
})

test('the endpoint reads its dependencies per call, not once at construction', async () => {
  let rows = registry()
  let master = ''
  const remote = new PanelRemote({ assignments: () => rows, parentId: parent, masterSessionId: () => master })

  const first = await remote.panelState()
  assert.deepEqual(first.model.workers.map((row) => row.sessionId), ['w1', 'w2'])
  assert.equal(first.actions.fixed.find((row) => row.id === 'master').action.kind, 'designate-master')

  // 指定了 master、又派进来一个 worker：下一次调用就该看见，不需要重建服务。
  master = 'orchestrator-master'
  rows = reserveChildId(rows, { id: 'w3', parentId: parent, now: 3000 })
  const second = await remote.panelState()
  assert.equal(second.model.workers.length, 3)
  assert.equal(second.actions.fixed.find((row) => row.id === 'master').action.kind, 'open-session')
})

test('a panel with no worker still answers with the three fixed entries', async () => {
  // 票 15 之前登记表没有写入方，这就是接线上端点后真正会看到的东西：三个入口、零个 worker。
  const remote = new PanelRemote({ assignments: () => ({}) })
  const payload = await remote.panelState()
  assert.deepEqual(payload.model.fixed.map((row) => row.id), [...FIXED_SECTIONS])
  assert.deepEqual(payload.model.workers, [])
  assert.equal(payload.model.master.sessionId, null)
  assert.deepEqual(payload.actions.workers, [])
})

test('a missing registry is a wiring error, not an empty panel', async () => {
  // 票 15 接线时漏传登记表，若在这里兜底成 {}，客户端会拿到「三个入口、零个 worker」，
  // 和「还没有 worker」长得一模一样，日志里也没有一行。缺件就抛，让人当场看见。
  await assert.rejects(() => new PanelRemote({}).panelState(), /assignments must be an object/)
  await assert.rejects(
    () => new PanelRemote({ parentId: 'p', masterSessionId: 'm', addressOf: () => undefined }).panelState(),
    /assignments must be an object/,
  )
})

test('a broken registry surfaces as an error instead of an empty panel', async () => {
  // 接线错误不该被伪装成「还没有 worker」：那会把配置问题读成正常状态。
  for (const bad of [null, 'rows']) {
    const remote = new PanelRemote({ assignments: bad })
    await assert.rejects(() => remote.panelState(), /assignments must be an object/)
  }
})

test('the endpoint name is one namespace and one method, and the marker says the same', () => {
  assert.equal(PANEL_SERVICE_KEY, 'orchestratorPanel')
  assert.equal(PANEL_METHOD, 'panelState')
  assert.equal(PANEL_ENDPOINT, 'orchestratorPanel/panelState')

  const marker = Object.getOwnPropertyDescriptor(PanelRemote.prototype, '@deepseek-ai/dsh-typert-protocol/remote-methods')
  assert.ok(marker !== undefined, 'the Gateway reads its remote methods from this prototype marker')
  // 版本号必须钉住：remoteMethods() 对任何 version !== 1 的标记都抛，端点会在网关发现阶段
  // 直接消失，而这里只断 methods 的话，改成 2 照样全绿。
  assert.equal(marker.value.version, 1)
  assert.deepEqual(marker.value.methods.map((entry) => entry.method), [PANEL_METHOD])
  assert.equal(marker.value.methods[0].invocation.kind, 'direct')

  const remote = new PanelRemote({})
  assert.equal(remote.typertRemote.service, remote, 'the Gateway matches the service by identity')
  assert.equal(remote.typertRemote.serviceKey, PANEL_SERVICE_KEY)
  assert.equal(remote.typertRemote.namespace, PANEL_SERVICE_KEY)
})

test('the method takes no arguments, because SRC reflection reads its parameter list', () => {
  assert.equal(PanelRemote.prototype.panelState.length, 0)
})

test('the payload function is usable without the Service, for tests and other callers', () => {
  const payload = panelPayloadOf({ assignments: registry(), parentId: parent })
  assert.deepEqual(payload.model.workers.map((row) => row.sessionId), ['w1', 'w2'])
  assert.deepEqual(payload.actions.workers.map((row) => row.action.kind), ['open-worker', 'open-worker'])
})

test('the payload carries the end-of-worker record the client sweeps on', async () => {
  // 浏览器自己判不出「谁结束了」：开着的页签会把自己那个子会话 retain 住。所以这条是服务端职责。
  const remote = new PanelRemote({
    assignments: () => ({}),
    ended: () => ['w-1', '  w-2  ', '', 'w-1', 42, null],
  })
  const payload = await remote.panelState()
  assert.deepEqual(payload.ended, ['w-1', 'w-2'], 'blank, non-string and duplicate ids are dropped')
})

test('the end-of-worker record is a ring: the oldest ids fall off', async () => {
  const many = []
  for (let index = 0; index < PANEL_ENDED_LIMIT + 7; index += 1) many.push('w-' + index)
  const remote = new PanelRemote({ assignments: () => ({}), ended: () => many })
  const payload = await remote.panelState()
  assert.equal(payload.ended.length, PANEL_ENDED_LIMIT)
  assert.equal(payload.ended[payload.ended.length - 1], 'w-' + (many.length - 1), 'the newest survive')
  assert.equal(payload.ended.includes('w-0'), false, 'the oldest are dropped')
})

test('no end-of-worker record reads as an empty list, never undefined', async () => {
  for (const ended of [undefined, null, 'nope', 7, {}]) {
    const payload = await panelPayloadOf({ assignments: {}, ended })
    assert.deepEqual(payload.ended, [], JSON.stringify(ended))
  }
})
