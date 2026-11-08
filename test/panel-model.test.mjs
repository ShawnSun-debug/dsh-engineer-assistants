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

test('the model is two-part: two fixed entries, then live workers by startedAt', () => {
  const model = buildPanelModel({ assignments: registry(), parentId: parent })
  assert.deepEqual([...FIXED_SECTIONS], ['inspector', 'reporter'])
  assert.deepEqual(model.fixed.map((row) => row.id), ['inspector', 'reporter'])
  assert.deepEqual(model.workers.map((row) => row.sessionId), ['earlier', 'reserved-one'], 'finished workers drop off, the rest sort by start')
  assert.deepEqual(model.tabs, [])
  assert.equal(model.activeTab, null)
})

test('an empty registry still shows the two fixed entries', () => {
  const model = buildPanelModel({ assignments: {}, parentId: parent })
  assert.deepEqual(model.fixed.map((row) => row.id), ['inspector', 'reporter'])
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
