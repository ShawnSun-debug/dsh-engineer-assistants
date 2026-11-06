import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addOrchestrator,
  clearMaster,
  isMaster,
  isTracked,
  normalizeRegistry,
  removeOrchestrator,
  setMaster,
} from '../lib/secretary-registry.js'

/**
 * 秘书登记表（秘书 spec 票 01）是纯数据：哪些会话允许被读取，哪一个就是
 * Master/秘书。存储面是插件的 Config（secretaryMasterSessionId /
 * secretaryOrchestrators），函数本身不认识宿主、不读时钟、不抛数据错误。
 *
 * 这里固定三条规则：
 *
 * - 归一化**永不抛错**：存档里的脏数据（缺字段、重复、非数组、会抛的 getter）
 *   一律降级成可用的登记表，而不是让设置页或会话加载失败。
 * - **互斥**：一个会话要么是 Master、要么是 orchestrator。setMaster 把已登记的
 *   会话挪进 Master 槽（后来者胜），addOrchestrator 拒绝 Master 会话（要降到
 *   orchestrator 得先 clearMaster）；归一化遇到冲突时留下 Master、丢掉那一行。
 * - **不可变**：每个函数都返回新数据，入参连一个字段都不改，所以面板可以先比较
 *   "是不是同一个对象"再决定要不要重绘。
 */

const empty = { masterSessionId: '', orchestrators: [] }

test('normalizeRegistry turns every kind of garbage into the empty registry', () => {
  for (const raw of [undefined, null, 0, 42, 'nonsense', true, [], () => {}]) {
    assert.deepEqual(normalizeRegistry(raw), empty, `input ${String(raw)}`)
  }
  assert.deepEqual(normalizeRegistry({ masterSessionId: 42, orchestrators: 'nope' }), empty)
  assert.deepEqual(normalizeRegistry({ masterSessionId: null, orchestrators: {} }), empty)
  assert.deepEqual(normalizeRegistry({ masterSessionId: {}, orchestrators: null }), empty)
  assert.deepEqual(normalizeRegistry({ orchestrators: [{ sessionId: 's-1' }] }).masterSessionId, '')
})

test('normalizeRegistry keeps only readable entries and fills every missing field', () => {
  const registry = normalizeRegistry({
    masterSessionId: 'master-1',
    orchestrators: [
      { sessionId: 's-1', workspace: '/w', title: '日报', trackedAt: 1700 },
      { sessionId: 's-2' },
      { sessionId: '' },
      { sessionId: '   ' },
      { sessionId: 7 },
      { sessionId: null },
      null,
      's-3',
      [],
      { workspace: '/w' },
    ],
  })
  assert.equal(registry.masterSessionId, 'master-1')
  assert.deepEqual(registry.orchestrators, [
    { sessionId: 's-1', workspace: '/w', title: '日报', trackedAt: 1700 },
    { sessionId: 's-2', workspace: '', title: '', trackedAt: 0 },
  ])
})

test('normalizeRegistry repairs a broken field instead of dropping the row', () => {
  const registry = normalizeRegistry({
    orchestrators: [
      { sessionId: ' s-1 ', workspace: 7, title: null, trackedAt: 'soon' },
      { sessionId: 's-2', workspace: '  /w  ', title: '  标题  ', trackedAt: -5 },
      { sessionId: 's-3', trackedAt: Number.NaN },
      { sessionId: 's-4', trackedAt: Number.POSITIVE_INFINITY },
    ],
  })
  assert.deepEqual(registry.orchestrators, [
    { sessionId: 's-1', workspace: '', title: '', trackedAt: 0 },
    { sessionId: 's-2', workspace: '/w', title: '标题', trackedAt: 0 },
    { sessionId: 's-3', workspace: '', title: '', trackedAt: 0 },
    { sessionId: 's-4', workspace: '', title: '', trackedAt: 0 },
  ])
})

test('normalizeRegistry de-duplicates by session id and lets the Master win the exclusion', () => {
  const registry = normalizeRegistry({
    masterSessionId: 's-2',
    orchestrators: [
      { sessionId: 's-1', title: 'first' },
      { sessionId: 's-1', title: 'second' },
      { sessionId: 's-2', title: 'the master itself' },
      { sessionId: 's-3' },
    ],
  })
  assert.equal(registry.masterSessionId, 's-2')
  assert.deepEqual(
    registry.orchestrators.map((row) => [row.sessionId, row.title]),
    [
      ['s-1', 'first'],
      ['s-3', ''],
    ],
  )
  assert.equal(isTracked(registry, 's-2'), false, 'the Master is never also an orchestrator')
})

test('normalizeRegistry never throws on hostile stored data', () => {
  const hostile = {
    get masterSessionId() {
      throw new Error('boom')
    },
    get orchestrators() {
      throw new Error('boom')
    },
  }
  assert.deepEqual(normalizeRegistry(hostile), empty)

  const registry = normalizeRegistry({
    orchestrators: [
      {
        get sessionId() {
          throw new Error('boom')
        },
      },
      {
        sessionId: 's-1',
        get workspace() {
          throw new Error('boom')
        },
      },
    ],
  })
  assert.deepEqual(registry.orchestrators, [{ sessionId: 's-1', workspace: '', title: '', trackedAt: 0 }])
})

test('every function returns new data and leaves the input untouched', () => {
  const entry = { sessionId: 's-1', workspace: '/w', title: 't', trackedAt: 5 }
  const raw = { masterSessionId: '', orchestrators: [entry] }
  const snapshot = JSON.parse(JSON.stringify(raw))

  const normalized = normalizeRegistry(raw)
  assert.notEqual(normalized, raw)
  assert.notEqual(normalized.orchestrators, raw.orchestrators)
  assert.notEqual(normalized.orchestrators[0], entry)

  const added = addOrchestrator(raw, { sessionId: 's-2' })
  const removed = removeOrchestrator(raw, 's-1')
  const mastered = setMaster(raw, 's-1')
  const cleared = clearMaster({ masterSessionId: 's-1', orchestrators: [] })

  assert.deepEqual(raw, snapshot, 'the input registry is not modified')
  assert.equal(entry.title, 't', 'the input row is not modified')
  assert.equal(added.orchestrators.length, 2)
  assert.equal(removed.orchestrators.length, 0)
  assert.equal(mastered.masterSessionId, 's-1')
  assert.equal(cleared.masterSessionId, '')
  assert.equal(raw.orchestrators.length, 1)

  // A caller that mutates what came back cannot reach the value it passed in.
  normalized.orchestrators.push({ sessionId: 's-9', workspace: '', title: '', trackedAt: 0 })
  normalized.orchestrators[0].title = 'changed'
  assert.equal(raw.orchestrators.length, 1)
  assert.equal(raw.orchestrators[0].title, 't')
})

test('isTracked and isMaster answer from the data and never throw on garbage', () => {
  const registry = normalizeRegistry({
    masterSessionId: 'master-1',
    orchestrators: [{ sessionId: 's-1' }, { sessionId: 'master-1' }],
  })
  assert.equal(isTracked(registry, 's-1'), true)
  assert.equal(isTracked(registry, 'master-1'), false)
  assert.equal(isMaster(registry, 'master-1'), true)
  assert.equal(isMaster(registry, 's-1'), false)

  for (const bad of [undefined, null, '', '   ', 42]) {
    assert.equal(isTracked(registry, bad), false, `tracked ${String(bad)}`)
    assert.equal(isMaster(registry, bad), false, `master ${String(bad)}`)
  }
  for (const bad of [undefined, null, 'nonsense', 42]) {
    assert.equal(isTracked(bad, 's-1'), false)
    assert.equal(isMaster(bad, 's-1'), false)
  }
})

test('setMaster moves a tracked session into the Master slot, so one session is never both', () => {
  const registry = normalizeRegistry({
    orchestrators: [{ sessionId: 's-1', title: 'a' }, { sessionId: 's-2' }],
  })
  const next = setMaster(registry, 's-1')
  assert.equal(next.masterSessionId, 's-1')
  assert.deepEqual(
    next.orchestrators.map((row) => row.sessionId),
    ['s-2'],
  )
  assert.equal(isMaster(next, 's-1'), true)
  assert.equal(isTracked(next, 's-1'), false)

  // The old registry keeps its own answer: the move happened in the new value only.
  assert.equal(registry.masterSessionId, '')
  assert.equal(isTracked(registry, 's-1'), true)

  // Setting the same Master again is the same registry, so a panel redraw costs nothing.
  assert.equal(setMaster(next, 's-1'), next)
})

test('setMaster rejects an id that is not a session id', () => {
  for (const bad of [undefined, null, 42, {}, '', '   ']) {
    assert.throws(() => setMaster(empty, bad), TypeError, `id ${String(bad)}`)
  }
})

test('addOrchestrator appends a row, fills the defaults and is idempotent', () => {
  const registry = { masterSessionId: '', orchestrators: [] }
  const one = addOrchestrator(registry, { sessionId: 's-1' })
  assert.deepEqual(one.orchestrators, [{ sessionId: 's-1', workspace: '', title: '', trackedAt: 0 }])
  assert.equal(registry.orchestrators.length, 0, 'the input registry stays empty')

  // Tracking an id that is already tracked changes nothing, not even the identity.
  assert.equal(addOrchestrator(one, { sessionId: 's-1', title: 'later' }), one)

  const two = addOrchestrator(one, { sessionId: 's-2', workspace: '/w', title: 't', trackedAt: 9 })
  assert.deepEqual(two.orchestrators, [
    { sessionId: 's-1', workspace: '', title: '', trackedAt: 0 },
    { sessionId: 's-2', workspace: '/w', title: 't', trackedAt: 9 },
  ])
  assert.equal(two.masterSessionId, '')
})

test('addOrchestrator refuses the Master session and requires a real id', () => {
  const registry = setMaster(empty, 'master-1')
  assert.throws(() => addOrchestrator(registry, { sessionId: 'master-1' }), /Master/)
  assert.equal(registry.orchestrators.length, 0, 'the refusal adds nothing')

  assert.throws(() => addOrchestrator(empty, null), TypeError)
  assert.throws(() => addOrchestrator(empty, 's-1'), TypeError)
  assert.throws(() => addOrchestrator(empty, {}), TypeError)
  assert.throws(() => addOrchestrator(empty, { sessionId: 42 }), TypeError)
})

test('clearMaster and removeOrchestrator undo one thing and leave the rest', () => {
  const registry = normalizeRegistry({
    masterSessionId: 'master-1',
    orchestrators: [{ sessionId: 's-1' }, { sessionId: 's-2' }],
  })

  const cleared = clearMaster(registry)
  assert.equal(cleared.masterSessionId, '')
  assert.deepEqual(cleared.orchestrators, registry.orchestrators)
  assert.equal(clearMaster(cleared), cleared, 'clearing twice is the same registry')

  const removed = removeOrchestrator(registry, 's-1')
  assert.deepEqual(
    removed.orchestrators.map((row) => row.sessionId),
    ['s-2'],
  )
  assert.equal(removed.masterSessionId, 'master-1')
  assert.equal(removeOrchestrator(registry, 's-9'), registry, 'removing an unknown id changes nothing')
})

test('removeOrchestrator requires a real id', () => {
  for (const bad of [undefined, null, 42, '', '   ']) {
    assert.throws(() => removeOrchestrator(empty, bad), TypeError, `id ${String(bad)}`)
  }
})

test('a full round trip survives the serialized config shape', () => {
  // The stored value is what a JSON config holds: two strings and an array of rows.
  const stored = JSON.parse(
    JSON.stringify(
      addOrchestrator(
        setMaster(addOrchestrator(empty, { sessionId: 's-1', workspace: '/w', title: '日报', trackedAt: 3 }), 'master-1'),
        { sessionId: 's-2', workspace: '/w', title: '验收', trackedAt: 4 },
      ),
    ),
  )
  const registry = normalizeRegistry(stored)
  assert.deepEqual(registry, {
    masterSessionId: 'master-1',
    orchestrators: [
      { sessionId: 's-1', workspace: '/w', title: '日报', trackedAt: 3 },
      { sessionId: 's-2', workspace: '/w', title: '验收', trackedAt: 4 },
    ],
  })
  assert.equal(isMaster(registry, 'master-1'), true)
  assert.equal(isTracked(registry, 's-2'), true)
})
