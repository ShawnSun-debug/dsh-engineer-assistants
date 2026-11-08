import assert from 'node:assert/strict'
import test from 'node:test'

import { assignSession, finishSession, reserveChildId } from '../lib/assignments.js'
import {
  FIXED_SECTIONS,
  buildPanelModel,
  closeTab,
  endWorker,
  openTab,
} from '../lib/panel-model.js'

const parent = 'session-master-1'

function registry() {
  let rows = reserveChildId({}, { id: 'later', parentId: parent, now: 3000 })
  rows = assignSession(rows, { sessionId: 'later', kind: 'worker', parentId: parent, presetId: 'reviewer', status: 'running', startedAt: 3000 })
  rows = reserveChildId(rows, { id: 'earlier', parentId: parent, now: 1000 })
  rows = assignSession(rows, { sessionId: 'earlier', kind: 'worker', parentId: parent, presetId: 'implementer', status: 'running', startedAt: 1000 })
  rows = reserveChildId(rows, { id: 'reserved-one', parentId: parent, now: 2000 })
  rows = finishSession(rows, { sessionId: 'later', status: 'done' })
  return rows
}

test('the model is two-part: three fixed assistants, then live workers by startedAt', () => {
  const model = buildPanelModel({ assignments: registry(), parentId: parent })
  // 三个常驻助手：master、监工、汇报。它们不是 worker，不随 worker 增减而变。
  assert.deepEqual([...FIXED_SECTIONS], ['master', 'inspector', 'reporter'])
  assert.deepEqual(model.fixed.map((row) => row.id), ['master', 'inspector', 'reporter'])
  assert.deepEqual(model.workers.map((row) => row.sessionId), ['earlier', 'reserved-one'], 'finished workers drop off, the rest sort by start')
  assert.deepEqual(model.tabs, [])
  assert.equal(model.activeTab, null)
})

test('an empty registry still shows the three fixed entries', () => {
  const model = buildPanelModel({ assignments: {}, parentId: parent })
  assert.deepEqual(model.fixed.map((row) => row.id), ['master', 'inspector', 'reporter'])
  assert.deepEqual(model.workers, [])
  assert.equal(model.activeTab, null)
})

test('opening a tab occupies it; opening another switches the active one', () => {
  let model = buildPanelModel({ assignments: registry(), parentId: parent })
  model = openTab(model, 'earlier')
  assert.deepEqual(model.tabs.map((row) => row.sessionId), ['earlier'])
  assert.equal(model.activeTab, 'earlier')
  model = openTab(model, 'reserved-one')
  assert.deepEqual(model.tabs.map((row) => row.sessionId), ['earlier', 'reserved-one'])
  assert.equal(model.activeTab, 'reserved-one')
  // 重复打开只是切过去，不会多一个页签。
  model = openTab(model, 'earlier')
  assert.equal(model.tabs.length, 2)
  assert.equal(model.activeTab, 'earlier')
})

test('a tab for a worker that is not in the list cannot be opened', () => {
  const model = buildPanelModel({ assignments: registry(), parentId: parent })
  assert.equal(openTab(model, 'later'), model, 'a finished worker has no row to open')
  assert.equal(openTab(model, 'ghost'), model)
})

test('closing a tab keeps the worker in the list', () => {
  let model = openTab(buildPanelModel({ assignments: registry(), parentId: parent }), 'earlier')
  model = closeTab(model, 'earlier')
  assert.deepEqual(model.tabs, [])
  assert.equal(model.activeTab, null)
  assert.deepEqual(model.workers.map((row) => row.sessionId), ['earlier', 'reserved-one'])
  assert.equal(closeTab(model, 'earlier'), model, 'closing twice is a no-op')
})

test('a worker ending removes its row and closes its tab', () => {
  let model = openTab(buildPanelModel({ assignments: registry(), parentId: parent }), 'earlier')
  model = endWorker(model, 'earlier')
  assert.deepEqual(model.workers.map((row) => row.sessionId), ['reserved-one'])
  assert.deepEqual(model.tabs, [])
  assert.equal(model.activeTab, null)
  assert.equal(endWorker(model, 'earlier'), model, 'ending twice is a no-op')
})

test('the model only lists the given parent', () => {
  let rows = registry()
  rows = reserveChildId(rows, { id: 'other', parentId: 'someone-else', now: 500 })
  rows = assignSession(rows, { sessionId: 'other', kind: 'worker', parentId: 'someone-else', status: 'running', startedAt: 500 })
  const model = buildPanelModel({ assignments: rows, parentId: parent })
  assert.equal(model.workers.some((row) => row.sessionId === 'other'), false)
})

test('tabs are rebuilt from the registry, so a stale tab does not survive', () => {
  const model = buildPanelModel({ assignments: registry(), parentId: parent, openTabs: ['earlier', 'gone'] })
  assert.deepEqual(model.tabs.map((row) => row.sessionId), ['earlier'])
})

test('bad input is refused', () => {
  assert.throws(() => buildPanelModel({ assignments: null }), /assignments must be an object/)
  const model = buildPanelModel({ assignments: registry(), parentId: parent })
  assert.throws(() => openTab(model, ''), /session id is required/)
  assert.throws(() => closeTab(model, ''), /session id is required/)
  assert.throws(() => endWorker(model, ''), /session id is required/)
})
test('only worker rows reach the list, not the inspector or reporter under the same parent', () => {
  let rows = reserveChildId({}, { id: 'w1', parentId: parent, now: 1000 })
  rows = assignSession(rows, { sessionId: 'w1', kind: 'worker', parentId: parent, status: 'running', startedAt: 1000 })
  rows = reserveChildId(rows, { id: 'watch-1', parentId: parent, kind: 'inspector', now: 2000 })
  rows = assignSession(rows, { sessionId: 'watch-1', kind: 'inspector', parentId: parent, status: 'running', startedAt: 2000 })
  rows = reserveChildId(rows, { id: 'report-1', parentId: parent, kind: 'reporter', now: 3000 })
  rows = assignSession(rows, { sessionId: 'report-1', kind: 'reporter', parentId: parent, status: 'running', startedAt: 3000 })
  const model = buildPanelModel({ assignments: rows, parentId: parent })
  // 下段是 worker 列表：巡检行和汇报行都挂在同一个 parent 下面，但它们不是 worker。
  // 两种都放进来，「只留 worker」才不会被一个 !== 'inspector' 蒙混过去。
  assert.deepEqual(model.workers.map((row) => row.sessionId), ['w1'])
})

test('a retried worker carries its retry count, and a fresh one reads zero', () => {
  let rows = reserveChildId({}, { id: 'w1', parentId: parent, now: 1000 })
  rows = assignSession(rows, { sessionId: 'w1', kind: 'worker', parentId: parent, status: 'running', startedAt: 1000, retries: 1 })
  assert.equal(buildPanelModel({ assignments: rows, parentId: parent }).workers[0].retries, 1)

  const fresh = reserveChildId({}, { id: 'w2', parentId: parent, now: 1000 })
  // 没有重试记录读作 0，不是 undefined：面板不该显示「undefined 次」。
  assert.equal(buildPanelModel({ assignments: fresh, parentId: parent }).workers[0].retries, 0)
})

test('the retry count is normalised, not passed straight through', () => {
  // 登记表之外的输入也可能到这里，所以行上只留「正整数次重试」这一种形状。
  const row = (sessionId, startedAt, retries) => ({ sessionId, kind: 'worker', parentId: parent, status: 'running', startedAt, retries })
  const rows = {
    a: row('a', 1, -1),
    b: row('b', 2, '3'),
    c: row('c', 3, 2.5),
    d: row('d', 4, 2),
  }
  const model = buildPanelModel({ assignments: rows, parentId: parent })
  assert.deepEqual(model.workers.map((item) => item.retries), [0, 0, 0, 2], 'only a positive integer survives')
})
test('the master entry carries the configured session id, and still takes its place without one', () => {
  const assigned = buildPanelModel({ assignments: {}, parentId: parent, masterSessionId: 'orchestrator-master' })
  assert.equal(assigned.fixed.find((row) => row.id === 'master').sessionId, 'orchestrator-master')
  // 没配也要占位：整项消失会让人以为这套没有 master。
  const unset = buildPanelModel({ assignments: {}, parentId: parent })
  assert.equal(unset.fixed.length, 3)
  assert.equal(unset.fixed.find((row) => row.id === 'master').sessionId, null)
  // 监工与汇报不是会话，没有 sessionId。
  assert.equal(assigned.fixed.find((row) => row.id === 'inspector').sessionId, null)
  assert.equal(assigned.fixed.find((row) => row.id === 'reporter').sessionId, null)
})
