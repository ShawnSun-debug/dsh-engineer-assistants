import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PROMPT_SECTION_ORDER,
  PROMPT_SECTION_PREFIX,
  TOOL_FAMILIES,
  applyPresetForAgent,
  buildPresetPlan,
  expandToolName,
  presetGuard,
  sectionSessionId,
} from '../lib/presets-apply.js'

const REGISTERED = new Set([
  'read', 'write', 'edit', 'glob', 'grep', 'web_search', 'web_fetch', 'todo_write',
  'terminal_open', 'terminal_close', 'terminal_send', 'terminal_read', 'terminal_list', 'terminal_signal',
  'bash', 'pwsh', 'run_code',
])

const reviewerPreset = {
  id: 'reviewer',
  category: 'non-code',
  modelTier: 'cheap',
  prompt: 'Propose changes only.',
  tools: { allow: ['read', 'glob', 'grep'], deny: ['write', 'edit', 'terminal'] },
}

const managed = () => true

function workerAgent() {
  const calls = []
  const disposed = []
  const guardFns = []
  const sections = new Map()
  const effects = []
  const tools = {
    restrict(input) {
      if (!Array.isArray(input?.deny) || input.deny.length !== 1) throw new Error('restrict takes one name')
      const name = input.deny[0]
      if (!REGISTERED.has(name)) throw new Error(`unknown tool "${name}"`)
      calls.push(['restrict', name])
      return () => disposed.push('restrict:' + name)
    },
    guard(fn) {
      if (typeof fn !== 'function') throw new Error('guard takes a predicate')
      guardFns.push(fn)
      calls.push(['guard'])
      return () => disposed.push('guard')
    },
  }
  const systemPrompt = {
    section(definition) {
      if (typeof definition?.name !== 'string' || definition.name === '') throw new Error('section needs a name')
      if (!Number.isFinite(definition.order)) throw new Error('section order must be finite')
      if (typeof definition.text !== 'function') throw new Error('section text must be a function')
      if (definition.interpolate !== false) throw new Error('a user-edited prompt must not be interpolated')
      if (sections.has(definition.name)) throw new Error(`duplicate section "${definition.name}"`)
      sections.set(definition.name, definition)
      calls.push(['section', definition.name, definition.order])
      return () => {
        sections.delete(definition.name)
        disposed.push('section')
      }
    },
  }
  const ctx = {
    tools,
    systemPrompt,
    effect(fn) {
      effects.push(fn)
      return () => {}
    },
  }
  return { agent: { id: 'worker-1', options: { subagentDepth: 1 }, ctx }, calls, disposed, guardFns, sections, effects }
}

const row = { kind: 'worker', presetId: 'reviewer', category: 'non-code' }

test('the terminal abstraction expands to the host shell family', () => {
  const expanded = expandToolName('terminal')
  assert.deepEqual(expanded, [...TOOL_FAMILIES.terminal])
  assert.ok(expanded.includes('terminal_send'))
  assert.deepEqual(expandToolName('read'), ['read'])
  assert.throws(() => expandToolName(''), /non-empty string/)
})

test('a plan carries both the abstract names and the expanded ones', () => {
  const plan = buildPresetPlan(reviewerPreset)
  assert.deepEqual([...plan.deny], ['write', 'edit', 'terminal'])
  assert.ok(plan.denyNames.includes('terminal_send'))
  assert.equal(Object.isFrozen(plan), true)
  assert.throws(() => buildPresetPlan({ id: 'x', tools: { allow: 'read' } }), /must be an array/)
})

test('the guard refuses a tool outside the preset but lets the PTC transport through', () => {
  const guard = presetGuard(buildPresetPlan(reviewerPreset))
  assert.equal(guard({ name: 'read' }), undefined)
  assert.match(guard({ name: 'write' }), /not available to this worker/)
  assert.match(guard({ name: 'terminal_send' }), /not available to this worker/)
  assert.equal(guard({ name: 'run_code', arguments: { code: 'return 1' } }), undefined)
  const refused = guard({ name: 'run_code', arguments: { code: 'return process.env' } })
  assert.match(refused, /would reach the Node\.js or host runtime \("process"\)/)
  assert.doesNotMatch(refused, /main agent only plans/, 'a worker must not be told to dispatch')
  const escalated = guard({ name: 'run_code', arguments: { code: 'return 1', sandbox_permissions: 'workspace-write' } })
  assert.match(escalated, /asks for sandbox escalation/)
  assert.doesNotMatch(escalated, /would reach the Node\.js or host runtime/)
})

test('applying to a worker restricts the expanded family, installs the guard and the section', () => {
  const { agent, calls } = workerAgent()
  const result = applyPresetForAgent({ agent, assignment: row, preset: reviewerPreset, isWorker: managed })
  const restricted = calls.filter((call) => call[0] === 'restrict').map((call) => call[1])
  assert.deepEqual(restricted, ['write', 'edit', ...TOOL_FAMILIES.terminal])
  assert.equal(calls.filter((call) => call[0] === 'guard').length, 1)
  assert.deepEqual(calls.at(-1), ['section', PROMPT_SECTION_PREFIX + 'worker-1', PROMPT_SECTION_ORDER])
  assert.deepEqual(result.applied, ['restrict:write', 'restrict:edit', 'restrict:terminal', 'guard', 'section'])
  assert.deepEqual(result.skipped.at(-1), { capability: 'definitions', reason: 'no surface installer' })
})

test('the visible surface keeps the PTC transport', () => {
  const { agent } = workerAgent()
  const installed = []
  const result = applyPresetForAgent({
    agent,
    assignment: row,
    preset: reviewerPreset,
    isWorker: managed,
    surface: { install: (visible) => { installed.push(visible); return () => {} } },
  })
  assert.ok(installed[0].allow.includes('run_code'), 'run_code must stay visible or the worker cannot act')
  assert.ok(installed[0].allow.includes('read'))
  assert.ok(result.applied.includes('definitions'))
})

test('an installer that returns no disposer is not counted as applied', () => {
  const { agent } = workerAgent()
  const result = applyPresetForAgent({
    agent,
    assignment: row,
    preset: reviewerPreset,
    isWorker: managed,
    surface: { install: () => undefined },
  })
  assert.equal(result.applied.includes('definitions'), false)
  assert.deepEqual(result.skipped.find((row) => row.capability === 'definitions'), {
    capability: 'definitions',
    reason: 'the surface installer returned no disposer',
  })
})

test('the default treats nobody as a worker, so a plain subagent spawn is untouched', () => {
  const { agent, calls } = workerAgent()
  const result = applyPresetForAgent({ agent, assignment: undefined, preset: reviewerPreset })
  assert.deepEqual(calls, [])
  assert.deepEqual(result.skipped, [{ capability: 'preset', reason: 'not a worker' }])
})

test('a managed worker with no assignment row refuses to start', () => {
  const { agent } = workerAgent()
  assert.throws(
    () => applyPresetForAgent({ agent, assignment: undefined, preset: reviewerPreset, isWorker: managed }),
    /no assignment row for session "worker-1"; refusing to start/,
  )
})

test('a preset that disagrees with the row is refused', () => {
  const { agent } = workerAgent()
  assert.throws(
    () => applyPresetForAgent({ agent, assignment: { kind: 'worker', presetId: 'implementer' }, preset: reviewerPreset, isWorker: managed }),
    /assigned preset "implementer" but "reviewer" was supplied/,
  )
})

test('a restriction the host refuses everywhere is fatal and lifts what was applied', () => {
  const { agent, disposed } = workerAgent()
  assert.throws(
    () => applyPresetForAgent({
      agent,
      assignment: row,
      isWorker: managed,
      preset: { ...reviewerPreset, tools: { allow: ['read'], deny: ['write', 'not_a_tool'] } },
    }),
    /cannot restrict "not_a_tool"/,
  )
  assert.deepEqual(disposed, ['restrict:write'])
})

test('the section text is scoped to the session that owns it', () => {
  const { agent, sections } = workerAgent()
  applyPresetForAgent({ agent, assignment: row, preset: reviewerPreset, isWorker: managed })
  const section = sections.get(PROMPT_SECTION_PREFIX + 'worker-1')
  assert.equal(section.text({ sessionId: 'worker-1' }), 'Propose changes only.')
  assert.equal(section.text({ sessionId: 'worker-2' }), '')
  assert.equal(sectionSessionId({ agent: { options: { sessionId: 'worker-1' } } }), 'worker-1')
  assert.equal(sectionSessionId({}), '')
})

test('re-applying lifts the previous section instead of colliding', () => {
  const { agent, sections, effects } = workerAgent()
  applyPresetForAgent({ agent, assignment: row, preset: reviewerPreset, isWorker: managed })
  assert.doesNotThrow(() => applyPresetForAgent({ agent, assignment: row, preset: reviewerPreset, isWorker: managed }))
  assert.equal(sections.size, 1)
  // 会话销毁时清掉本地登记：每次装上段落都登记一次 effect，且调用不能抛。
  assert.ok(effects.length >= 1)
  assert.doesNotThrow(() => effects[effects.length - 1]())
})

test('a host without systemPrompt still gets the restriction and the guard', () => {
  const { agent } = workerAgent()
  agent.ctx.systemPrompt = undefined
  const result = applyPresetForAgent({ agent, assignment: row, preset: reviewerPreset, isWorker: managed })
  assert.ok(result.applied.includes('guard'))
  assert.deepEqual(result.skipped.find((entry) => entry.capability === 'section'), { capability: 'section', reason: 'unavailable' })
})

test('dispose lifts every step exactly once, even when called twice', () => {
  const { agent, disposed } = workerAgent()
  const result = applyPresetForAgent({ agent, assignment: row, preset: reviewerPreset, isWorker: managed })
  result.dispose()
  result.dispose()
  assert.equal(disposed.filter((entry) => entry === 'guard').length, 1)
  assert.equal(disposed.filter((entry) => entry === 'section').length, 1)
})

test('create and resume run the same sequence', () => {
  const created = workerAgent()
  const createdResult = applyPresetForAgent({ agent: created.agent, assignment: row, preset: reviewerPreset, isWorker: managed, source: 'create' })
  const resumed = workerAgent()
  const resumedResult = applyPresetForAgent({ agent: resumed.agent, assignment: row, preset: reviewerPreset, isWorker: managed, source: 'resume' })
  assert.deepEqual(created.calls, resumed.calls)
  assert.equal(createdResult.source, 'create')
  assert.equal(resumedResult.source, 'resume')
})
