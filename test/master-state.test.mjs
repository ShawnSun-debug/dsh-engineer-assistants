import assert from 'node:assert/strict'
import test from 'node:test'
import { WORKER_STATES, initialMasterState, reduceMasterState } from '../lib/master-state.js'

/**
 * S2 of the master spec: the status index is a pure fold over the session log.
 * Every event here is synthetic but shaped exactly like the host's SessionEvent
 * (`{ type, data }`, see @deepseek-ai/dsh-session types.d.ts), so the reducer is
 * tested without a session, a projection registry or a model call.
 */
const MAIN = { id: 's-main', createdAt: 1 }
const WORKER = { id: 'w-1', createdAt: 2, origin: 'subagent', delegationDepth: 1 }

const makeEvent = (type, data = {}) => ({ type, data, seq: 0, time: 0 })
const fold = (events, header = MAIN) => events.reduce(reduceMasterState, initialMasterState(header))
const row = (state) => state.workers[0]

const turnStart = () => makeEvent('turn/start', { turn: 1 })
const turnEnd = (reason) => makeEvent('turn/end', { turn: 1, reason })
const call = (name) => makeEvent('tool/call', { callId: 'c1', name, arguments: '{}' })
const result = () => makeEvent('tool/result', { message: { role: 'tool', toolCallId: 'c1' } })
const human = (text) => makeEvent('user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } })
const notice = (text) =>
  makeEvent('user/message', { content: [{ type: 'text', text }], source: { kind: 'orchestrator-supervision' } })
const title = (text) => makeEvent('session/title', { title: text, messageSeqs: [], source: { kind: 'user' } })

test('the state machine has exactly the six fixed values', () => {
  assert.deepEqual(WORKER_STATES, ['Working', 'Needs input', 'Idle', 'Completed', 'Failed', 'Stopped'])
})

test('an empty log is one idle worker row with no summary', () => {
  assert.deepEqual(initialMasterState(MAIN), {
    workers: [{ id: 's-main', role: 'main', state: 'Idle', summary: '' }],
  })
  assert.deepEqual(row(initialMasterState(WORKER)), { id: 'w-1', role: 'worker', state: 'Idle', summary: '' })
})

test('a dialog session reports its own history even when inherited', () => {
  // init ignores the inherited prefix: the fold below still starts idle.
  assert.equal(row(initialMasterState(WORKER, 12)).state, 'Idle')
})

test('turn/start is Working and tool activity keeps it Working', () => {
  assert.equal(row(fold([turnStart()])).state, 'Working')
  assert.equal(row(fold([turnStart(), call('read'), result()])).state, 'Working')
  assert.equal(row(fold([turnStart(), call('pwsh')])).state, 'Working')
})

test('a pending human question is Needs input until its result lands', () => {
  for (const name of ['ask_user_question', 'request_user_input', 'pick_files', 'exit_plan_mode']) {
    const asked = fold([turnStart(), call(name)])
    assert.equal(row(asked).state, 'Needs input', name)
    assert.equal(row(fold([turnStart(), call(name), result()])).state, 'Working', name)
  }
})

test("another tool's result in the same step does not clear a pending question", () => {
  // The model may call ask_user_question and another tool in one step; the other
  // result must not turn Needs input back into Working before the answer lands.
  const asked = fold([turnStart(), call('ask_user_question')])
  assert.equal(asked.pending, 'c1', 'the blocking call is remembered by id')
  const unrelated = makeEvent('tool/result', { message: { role: 'tool', toolCallId: 'c2' } })
  assert.equal(row(reduceMasterState(asked, unrelated)).state, 'Needs input')
  assert.equal(row(reduceMasterState(asked, result())).state, 'Working')
})

test('a restored Needs-input row without a call id still clears on any result', () => {
  // Older checkpoints did not record the id; refusing every result would leave the row
  // stuck forever, so an untracked wait keeps the previous behaviour.
  const restored = { workers: [{ id: 'w-1', role: 'worker', state: 'Needs input', summary: '' }] }
  assert.equal(row(reduceMasterState(restored, result())).state, 'Working')
})

test('turn/end maps the recorded reason onto the six states', () => {
  assert.equal(row(fold([turnStart(), turnEnd({ kind: 'completed' })])).state, 'Idle')
  assert.equal(row(fold([turnStart(), turnEnd({ kind: 'aborted', reason: { kind: 'user' } })])).state, 'Stopped')
  assert.equal(row(fold([turnStart(), turnEnd({ kind: 'interrupted' })])).state, 'Stopped')
  assert.equal(row(fold([turnStart(), turnEnd({ kind: 'blocked' })])).state, 'Idle')
  assert.equal(row(fold([turnStart(), turnEnd({ kind: 'max-tokens' })])).state, 'Idle')
  assert.equal(row(fold([turnStart(), turnEnd({ kind: 'forked' })])).state, 'Idle')
  assert.equal(row(fold([turnStart(), turnEnd({ kind: 'plugin-specific-variant' })])).state, 'Idle')
  assert.equal(
    row(fold([turnStart(), turnEnd({ kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } })])).state,
    'Failed',
  )
})

test('a finished turn means Completed for a worker and Idle for a dialog', () => {
  const done = turnEnd({ kind: 'completed' })
  assert.equal(row(fold([turnStart(), done])).state, 'Idle')
  assert.equal(row(fold([turnStart(), done], WORKER)).state, 'Completed')
  // A resumed worker is working again.
  assert.equal(row(fold([turnStart(), done, turnStart()], WORKER)).state, 'Working')
})

test('a question left pending is closed by the turn ending', () => {
  const asked = [turnStart(), call('ask_user_question')]
  assert.equal(row(fold([...asked, turnEnd({ kind: 'aborted', reason: { kind: 'user' } })])).state, 'Stopped')
  assert.equal(row(fold([...asked, turnEnd({ kind: 'error', error: { message: 'x', code: 'UNKNOWN' } })])).state, 'Failed')
})

test('events the unit does not own return the same reference', () => {
  const state = fold([turnStart()])
  const ignored = [
    makeEvent('step/start', { turn: 1, step: 1 }),
    makeEvent('step/end', { turn: 1, step: 1 }),
    makeEvent('assistant/message', { turn: 1, step: 1 }),
    makeEvent('request/header', { header: {} }),
    makeEvent('system/message', { turn: 1, step: 1 }),
    makeEvent('developer/message', { turn: 1, step: 1 }),
    makeEvent('session/end-seed', {}),
    makeEvent('tool/call', { callId: 'c2', name: 'read', arguments: '{}' }),
    makeEvent('tool/result', { message: { role: 'tool', toolCallId: 'c2' } }),
  ]
  for (const event of ignored) assert.equal(reduceMasterState(state, event), state, event.type)
  // The same events on an idle row are equally inert.
  const idle = initialMasterState(MAIN)
  for (const event of ignored) assert.equal(reduceMasterState(idle, event), idle, event.type)
})

test('an unchanged fold on a title with the same text keeps the reference', () => {
  const state = fold([title('Fix login retry')])
  assert.equal(reduceMasterState(state, title('Fix login retry')), state)
})

test('the summary comes from the title event, latest wins', () => {
  assert.equal(row(fold([title('Fix login retry')])).summary, 'Fix login retry')
  assert.equal(row(fold([title('First'), title('Second')])).summary, 'Second')
})

test('before any title, the first human message is the one-line fallback', () => {
  assert.equal(row(fold([human('  add\n retry   to the login  form  ')])).summary, 'add retry to the login form')
  assert.equal(row(fold([human('first'), human('second')])).summary, 'first')
})

test('a long human message is truncated, never dumped into the row', () => {
  const summary = row(fold([human('x'.repeat(400))])).summary
  assert.equal(summary.length, 120)
  assert.equal(summary.endsWith('\u2026'), true)
})

test('a synthetic injected message is never the summary', () => {
  const state = fold([notice('\u3010supervision\u3011 worker is slow')])
  assert.equal(row(state).summary, '')
  assert.equal(row(fold([notice('injected'), human('the real ask')])).summary, 'the real ask')
})

test('a title replaces the fallback and a later message never overwrites it', () => {
  assert.equal(row(fold([human('the first ask'), title('Fix login retry')])).summary, 'Fix login retry')
  assert.equal(row(fold([human('the first ask'), title('Fix login retry'), human('more detail')])).summary, 'Fix login retry')
})

test('a title is collapsed to one line and bounded', () => {
  assert.equal(row(fold([title('  two\n lines ')])).summary, 'two lines')
  assert.equal(row(fold([title('y'.repeat(300))])).summary.length, 120)
})

test('a human message moves the row to Working', () => {
  assert.equal(row(fold([turnStart(), turnEnd({ kind: 'completed' }), human('next')])).state, 'Working')
})
