import assert from 'node:assert/strict'
import test from 'node:test'

import { assignSession, finishSession, reserveChildId } from '../lib/assignments.js'
import { MAX_FINISHED_LINES, SUMMARY_MARKER, buildSummary, contextSegment, injectSegment } from '../lib/master-context.js'

const parent = 'session-master-1'
const NOW = 10_000_000

function withRows() {
  let rows = reserveChildId({}, { id: 'w1', parentId: parent, now: NOW - 12 * 60000 })
  rows = assignSession(rows, {
    sessionId: 'w1', kind: 'worker', parentId: parent, presetId: 'implementer', category: 'code', cwd: 'D:/work', status: 'running',
  })
  rows = reserveChildId(rows, { id: 'w2', parentId: parent, now: NOW - 3 * 60000 })
  rows = assignSession(rows, { sessionId: 'w2', kind: 'worker', parentId: parent, presetId: 'reviewer', category: 'non-code' })
  rows = finishSession(rows, { sessionId: 'w2', status: 'done' })
  rows = reserveChildId(rows, { id: 'w3', parentId: parent, now: NOW })
  return rows
}

test('the summary separates running, reserved and finished', () => {
  const summary = buildSummary({ assignments: withRows(), now: NOW })
  assert.deepEqual(summary.sections, { running: 1, reserved: 1, stuck: 0, finished: 1 })
  assert.match(summary.text, /Running:/)
  assert.match(summary.text, /Reserved \(not started yet\):/)
  assert.match(summary.text, /w3 \(no preset, worker\) · reserved/, 'a reservation must not read as running')
  assert.match(summary.text, /w1 \(implementer, worker\) · running 12 min · cwd D:\/work/)
  assert.match(summary.text, /Finished \(done \/ failed \/ cancelled\):/)
})

test('only the given parent is described', () => {
  let rows = withRows()
  rows = reserveChildId(rows, { id: 'other', parentId: 'someone-else', now: NOW })
  const summary = buildSummary({ assignments: rows, now: NOW, parentId: parent })
  assert.equal(summary.text.includes('other'), false)
  assert.equal(summary.sections.running + summary.sections.reserved + summary.sections.finished, 3)
})

test('accepted workers drop out of the segment', () => {
  const rows = withRows()
  const before = buildSummary({ assignments: rows, now: NOW })
  const after = buildSummary({ assignments: rows, now: NOW, acceptedIds: ['w2'] })
  assert.equal(before.sections.finished, 1)
  assert.equal(after.sections.finished, 0)
  assert.equal(after.text.includes('w2'), false)
})

test('stuck workers are listed once, under Stuck', () => {
  const summary = buildSummary({ assignments: withRows(), now: NOW, stuckIds: ['w1'] })
  const occurrences = summary.text.split('\n').filter((line) => line.includes('w1 ')).length
  assert.equal(occurrences, 1, 'one worker, one line')
  assert.match(summary.text, /w1 .*STUCK/)
  assert.deepEqual(summary.sections, { running: 0, reserved: 1, stuck: 1, finished: 1 })
})

test('the finished tail is capped instead of growing with every dispatch', () => {
  let rows = {}
  const total = MAX_FINISHED_LINES + 4
  for (let i = 0; i < total; i += 1) {
    const id = 'f' + i
    rows = reserveChildId(rows, { id, parentId: parent, now: NOW - 60000 })
    rows = assignSession(rows, { sessionId: id, kind: 'worker', parentId: parent, status: 'running' })
    rows = finishSession(rows, { sessionId: id, status: 'done' })
  }
  const summary = buildSummary({ assignments: rows, now: NOW })
  const finishedLines = summary.text.split('\n').filter((line) => line.startsWith('- f'))
  assert.equal(finishedLines.length, MAX_FINISHED_LINES)
  assert.match(summary.text, /and 4 more finished worker/)
})

test('an empty registry produces an empty segment, not a heading', () => {
  const summary = buildSummary({ assignments: {}, now: NOW })
  assert.deepEqual(summary, { text: '', empty: true, sections: { running: 0, reserved: 0, stuck: 0, finished: 0 } })
  assert.equal(contextSegment(summary), '')
})

test('normalisation protects the compaction path from a hostile row', () => {
  const row = { sessionId: 'x', kind: 'worker', parentId: parent, status: 'running' }
  Object.defineProperty(row, 'cwd', { get() { throw new Error('boom') } })
  const summary = buildSummary({ assignments: { x: row }, now: NOW })
  assert.match(summary.text, /x \(no preset, worker\)/)
})

test('injection replaces only its own block and keeps what follows', () => {
  const block = buildSummary({ assignments: withRows(), now: NOW }).text
  const memory = 'intro line\n\n' + block + '\n\n## plan\n- keep this line'
  const replaced = injectSegment({ memory, segment: buildSummary({ assignments: withRows(), now: NOW + 60000 }).text })
  assert.equal(replaced.split(SUMMARY_MARKER).length - 1, 1, 'no duplicate blocks')
  assert.match(replaced, /^intro line/)
  assert.match(replaced, /## plan\n- keep this line$/, 'text after the block must survive')
  assert.match(replaced, /running 13 min/)
})

test('removing the block leaves the rest intact', () => {
  const block = buildSummary({ assignments: withRows(), now: NOW }).text
  const memory = 'intro\n\n' + block + '\n\n## plan\n- keep'
  const cleared = injectSegment({ memory, segment: '' })
  assert.equal(cleared.includes(SUMMARY_MARKER), false)
  assert.equal(cleared.includes('- keep'), true)
  assert.equal(injectSegment({ memory: '', segment: '' }), '')
})

test('a different state renders differently (it is rebuilt, not remembered)', () => {
  const rows = withRows()
  const finishedNow = finishSession(rows, { sessionId: 'w1', status: 'done' })
  const before = buildSummary({ assignments: rows, now: NOW })
  const after = buildSummary({ assignments: finishedNow, now: NOW })
  assert.deepEqual(before.sections.running, 1)
  assert.deepEqual(after.sections.running, 0)
  assert.match(after.text, /w1 .*done/)
})

test('bad input is refused instead of guessed', () => {
  assert.throws(() => buildSummary({ assignments: null, now: NOW }), /assignments must be an object/)
  assert.throws(() => buildSummary({ assignments: {}, now: Number.NaN }), /now must be a finite number/)
  assert.throws(() => contextSegment(null), /a summary is required/)
})
