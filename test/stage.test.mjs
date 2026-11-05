import assert from 'node:assert/strict'
import test from 'node:test'
import { initialState, reduceStage } from '../lib/stage.js'

const fold = (events, inherited = 0) => events.reduce(reduceStage, initialState(inherited))
const call = (name) => ({ type: 'tool/call', data: { name } })
const mode = (active) => ({ type: 'plan/mode', data: { active } })
const turn = { type: 'turn/start', data: {} }

test('a new session starts idle and a first turn means clarifying', () => {
  assert.equal(fold([]).stage, 'idle')
  assert.equal(fold([turn]).stage, 'clarify')
})

test('entering plan mode, then submitting a plan, reaches awaiting', () => {
  assert.equal(fold([turn, mode(true)]).stage, 'planning')
  assert.equal(fold([turn, mode(true), call('exit_plan_mode')]).stage, 'awaiting')
})

test('approval (plan mode off while awaiting) reaches executing', () => {
  const s = fold([turn, mode(true), call('exit_plan_mode'), mode(false)])
  assert.deepEqual(s, { stage: 'executing', plan: false })
})

test('exit_plan_mode outside plan mode does not claim a review', () => {
  assert.equal(fold([turn, call('exit_plan_mode')]).stage, 'clarify')
})

test('delegating while planning or awaiting is not execution', () => {
  assert.equal(fold([turn, mode(true), call('subagent')]).stage, 'planning')
  assert.equal(fold([turn, mode(true), call('orchestrate')]).stage, 'planning')
  assert.equal(fold([turn, mode(true), call('dispatch')]).stage, 'planning')
  assert.equal(fold([turn, mode(true), call('exit_plan_mode'), call('workflow')]).stage, 'awaiting')
})

test('delegating after approval, or with no plan mode at all, is execution', () => {
  assert.equal(fold([turn, call('subagent')]).stage, 'executing')
  assert.equal(fold([turn, call('orchestrate')]).stage, 'executing')
  assert.equal(fold([turn, call('dispatch')]).stage, 'executing')
  assert.equal(fold([turn, mode(true), call('exit_plan_mode'), mode(false), call('subagent_fork')]).stage, 'executing')
})

test('todo_write moves a conversation to planning but never pulls execution back', () => {
  assert.equal(fold([turn, call('todo_write')]).stage, 'planning')
  assert.equal(fold([turn, call('subagent'), call('todo_write')]).stage, 'executing')
})

test('leaving plan mode by hand mid-planning returns to conversation', () => {
  assert.deepEqual(fold([turn, mode(true), mode(false)]), { stage: 'clarify', plan: false })
})

test('re-entering plan mode after execution plans again', () => {
  assert.equal(fold([turn, call('subagent'), mode(true)]).stage, 'planning')
})

test('a forked session reports na and ignores everything', () => {
  assert.equal(fold([turn, mode(true), call('exit_plan_mode')], 12).stage, 'na')
})

test('a supervision notice starting a new turn never resets the stage', () => {
  const notice = {
    type: 'user/message',
    data: { content: [{ type: 'text', text: '【插件巡检…】' }], source: { kind: 'orchestrator-supervision', form: 'notice' } },
  }
  // The notice wakes the parent after `delegate` already returned, so it arrives in
  // executing (or awaiting review); its new turn must not fall back to clarify/planning.
  assert.equal(fold([turn, call('subagent'), notice, turn]).stage, 'executing')
  assert.equal(fold([turn, mode(true), call('exit_plan_mode'), notice, turn]).stage, 'awaiting')
})

test('PTC dispatch start counts like a direct call; unrelated events are ignored', () => {
  assert.equal(fold([turn, { type: 'tool/ptc-dispatch-start', data: { name: 'subagent' } }]).stage, 'executing')
  assert.equal(fold([turn, { type: 'assistant/message', data: {} }, call('read')]).stage, 'clarify')
})
