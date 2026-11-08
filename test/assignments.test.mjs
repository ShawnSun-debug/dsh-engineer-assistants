import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CATEGORIES,
  KINDS,
  STATUSES,
  assignSession,
  childrenOf,
  findAssignment,
  finishSession,
  isTerminal,
  normalizeAssignments,
  reserveChildId,
} from '../lib/assignments.js'

const parent = 'session-master-1'
const reserved = (overrides = {}) => reserveChildId({}, { id: 'child-1', parentId: parent, now: 1000, ...overrides })

test('normalize: any input yields a readable table', () => {
  assert.deepEqual(normalizeAssignments(undefined), {})
  assert.deepEqual(normalizeAssignments(null), {})
  assert.deepEqual(normalizeAssignments('nope'), {})
  assert.deepEqual(normalizeAssignments(42), {})
  assert.deepEqual(normalizeAssignments({}), {})
})

test('normalize: drops rows with no id or an unknown kind, keeps the rest', () => {
  const table = normalizeAssignments({
    good: { sessionId: 'good', kind: 'worker', parentId: parent, status: 'running', category: 'code' },
    noKind: { sessionId: 'noKind', parentId: parent },
    badKind: { sessionId: 'badKind', kind: 'orchestrator', parentId: parent },
  })
  assert.deepEqual(Object.keys(table), ['good'])
  assert.equal(table.good.category, 'code')
  assert.equal(table.good.startedAt, 0)
})

test('normalize: accepts the array shape and keeps the first row of a duplicate id', () => {
  const table = normalizeAssignments([
    { sessionId: 'dup', kind: 'worker', parentId: parent, status: 'reserved', startedAt: 1 },
    { sessionId: 'dup', kind: 'worker', parentId: parent, status: 'done', startedAt: 2 },
  ])
  assert.equal(Object.keys(table).length, 1)
  assert.equal(table.dup.status, 'reserved')
  assert.equal(table.dup.startedAt, 1)
})

test('normalize: a throwing enumerable getter on a keyed row cannot break the table', () => {
  const row = { kind: 'worker', parentId: parent }
  Object.defineProperty(row, 'cwd', { get() { throw new Error('boom') }, enumerable: true })
  const table = normalizeAssignments({ x: row })
  assert.equal(table.x.cwd, '')
  assert.equal(table.x.sessionId, 'x')
})

test('normalize: ids that collide with Object.prototype stay ordinary keys', () => {
  // 对象字面量里的 __proto__ 会设原型而不是键，所以用 JSON 造一条真的 __proto__ 自有键。
  const table = normalizeAssignments(JSON.parse(`{
    "__proto__": { "kind": "worker", "parentId": "${parent}" },
    "constructor": { "kind": "worker", "parentId": "${parent}" }
  }`))
  assert.equal(Object.getPrototypeOf(table), Object.prototype)
  assert.equal(Object.keys(table).length, 2)
  assert.equal(typeof table.constructor, 'object')
})

test('reserve: writes a reserved row and keeps the id for later', () => {
  assert.deepEqual(reserved()['child-1'], {
    sessionId: 'child-1',
    kind: 'worker',
    parentId: parent,
    presetId: '',
    category: '',
    cwd: '',
    startedAt: 1000,
    status: 'reserved',
    retries: 0,
  })
})

test('reserve: the same parent reserving the same id again changes nothing', () => {
  const table = reserved()
  const again = reserveChildId(table, { id: 'child-1', parentId: parent, now: 2000 })
  assert.deepEqual(again, normalizeAssignments(table))
  assert.equal(again['child-1'].startedAt, 1000)
})

test('reserve: a second parent claiming the same id is refused', () => {
  assert.throws(
    () => reserveChildId(reserved(), { id: 'child-1', parentId: 'other-parent' }),
    /already reserved by parent/,
  )
})

test('reserve: an id that already finished is refused, so no session spawns without a row', () => {
  const finished = finishSession(reserved(), { sessionId: 'child-1', status: 'done' })
  assert.throws(
    () => reserveChildId(finished, { id: 'child-1', parentId: parent }),
    /already finished as "done"/,
  )
})

test('reserve: a kind that disagrees with the existing row is refused', () => {
  assert.throws(
    () => reserveChildId(reserved(), { id: 'child-1', parentId: parent, kind: 'inspector' }),
    /is a worker, not a inspector/,
  )
})

test('reserve: an unknown kind is refused instead of being downgraded', () => {
  assert.throws(() => reserveChildId({}, { id: 'x', parentId: parent, kind: 'orchestrator' }), /kind must be one of/)
})

test('reserve: a missing id or parent is a programming error', () => {
  assert.throws(() => reserveChildId({}, { parentId: parent }), /session id must be a non-empty string/)
  assert.throws(() => reserveChildId({}, { id: 'x' }), /session id must be a non-empty string/)
})

test('reserve: fields supplied at reservation are kept, not discarded', () => {
  const row = reserved({ presetId: 'implementer', category: 'code', cwd: 'D:/work', startedAt: 900 })['child-1']
  assert.equal(row.presetId, 'implementer')
  assert.equal(row.category, 'code')
  assert.equal(row.cwd, 'D:/work')
  assert.equal(row.startedAt, 900)
})

test('assign: rewrites the same id in place rather than adding a row', () => {
  const table = assignSession(reserved(), {
    sessionId: 'child-1',
    kind: 'worker',
    parentId: parent,
    presetId: 'implementer',
    category: 'code',
    cwd: 'D:/work',
    startedAt: 1500,
    status: 'running',
  })
  assert.equal(Object.keys(table).length, 1)
  assert.deepEqual(table['child-1'], {
    sessionId: 'child-1',
    kind: 'worker',
    parentId: parent,
    presetId: 'implementer',
    category: 'code',
    cwd: 'D:/work',
    startedAt: 1500,
    status: 'running',
    retries: 0,
  })
})

test('assign: a partial write keeps what the reservation already had', () => {
  const start = reserveChildId({}, {
    id: 'child-1', parentId: parent, now: 1000, presetId: 'implementer', category: 'code', cwd: 'D:/work',
  })
  const row = assignSession(start, { sessionId: 'child-1', kind: 'worker', startedAt: 1500 })['child-1']
  assert.equal(row.parentId, parent)
  assert.equal(row.presetId, 'implementer')
  assert.equal(row.category, 'code')
  assert.equal(row.cwd, 'D:/work')
  assert.deepEqual(childrenOf(assignSession(start, { sessionId: 'child-1', kind: 'worker', startedAt: 1500 }), parent)
    .map((child) => child.sessionId), ['child-1'])
})

test('assign: an unknown kind, category or status is refused', () => {
  const base = { sessionId: 'child-1', kind: 'worker', parentId: parent }
  assert.throws(() => assignSession({}, { ...base, kind: 'orchestrator' }), /kind must be one of/)
  assert.throws(() => assignSession({}, { ...base, category: 'ops' }), /category must be one of/)
  assert.throws(() => assignSession({}, { ...base, status: 'nearly' }), /status must be one of/)
})

test('assign: a finished row cannot be reopened', () => {
  const finished = finishSession(reserved(), { sessionId: 'child-1', status: 'done' })
  assert.throws(
    () => assignSession(finished, { sessionId: 'child-1', kind: 'worker', parentId: parent }),
    /already finished/,
  )
})

test('assign: only finish writes a terminal status', () => {
  const running = assignSession(reserved(), { sessionId: 'child-1', kind: 'worker', parentId: parent })
  assert.throws(
    () => assignSession(running, { sessionId: 'child-1', kind: 'worker', status: 'failed' }),
    /belongs to finishSession/,
  )
})

test('assign: a running session cannot go back to reserved', () => {
  const running = assignSession(reserved(), { sessionId: 'child-1', kind: 'worker', parentId: parent })
  assert.throws(
    () => assignSession(running, { sessionId: 'child-1', kind: 'worker', status: 'reserved' }),
    /cannot go back from running to reserved/,
  )
})

test('finish: sets a terminal status once and stays put afterwards', () => {
  const running = assignSession(reserved(), { sessionId: 'child-1', kind: 'worker', parentId: parent })
  const done = finishSession(running, { sessionId: 'child-1', status: 'failed' })
  assert.equal(done['child-1'].status, 'failed')
  assert.equal(isTerminal(done['child-1'].status), true)
  assert.deepEqual(finishSession(done, { sessionId: 'child-1', status: 'done' }), done)
})

test('finish: an unregistered session is left alone, a non-terminal status is refused', () => {
  const table = reserved()
  assert.deepEqual(finishSession(table, { sessionId: 'nobody', status: 'done' }), normalizeAssignments(table))
  assert.throws(() => finishSession(table, { sessionId: 'child-1', status: 'running' }), /terminal/)
})

test('cold recovery: what was written reads back after a serialize round trip', () => {
  const table = finishSession(
    assignSession(reserved(), {
      sessionId: 'child-1',
      kind: 'worker',
      parentId: parent,
      presetId: 'implementer',
      category: 'code',
      cwd: 'D:/work',
      startedAt: 1500,
    }),
    { sessionId: 'child-1', status: 'done' },
  )
  const revived = normalizeAssignments(JSON.parse(JSON.stringify(table)))
  assert.deepEqual(revived, table)
  assert.equal(findAssignment(revived, 'child-1').presetId, 'implementer')
})

test('childrenOf: sorts by startedAt and ignores other parents', () => {
  let table = reserveChildId({}, { id: 'b', parentId: parent, now: 300 })
  table = reserveChildId(table, { id: 'a', parentId: parent, now: 100 })
  table = reserveChildId(table, { id: 'c', parentId: 'someone-else', now: 200 })
  assert.deepEqual(childrenOf(table, parent).map((row) => row.sessionId), ['a', 'b'])
  assert.deepEqual(childrenOf(table, ''), [])
})

test('the exported vocabularies stay in sync with the spec', () => {
  assert.deepEqual([...KINDS], ['master', 'worker', 'inspector', 'reporter'])
  assert.deepEqual([...CATEGORIES], ['code', 'maybe-code', 'non-code'])
  assert.deepEqual([...STATUSES], ['reserved', 'running', 'done', 'failed', 'cancelled'])
})
