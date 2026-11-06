import assert from 'node:assert/strict'
import test from 'node:test'
import { LIMITS, ORCHESTRATE_TOOL } from '../lib/api.js'
import {
  buildStagePrompt,
  collectText,
  createOrchestrateTool,
  parseOrchestrateArgs,
  readStageOutput,
  runOrchestration,
} from '../lib/orchestrate.js'
import { mainAgentRule } from '../lib/rules.js'

const ROUTE = { provider: 'nexus-deepseek', model: 'deepseek-v4.1-flash' }
const cfg = (provider = ROUTE.provider, model = ROUTE.model, effort = '') => ({
  workerProvider: { get: () => provider },
  workerModel: { get: () => model },
  workerReasoningEffort: { get: () => effort },
})
const exec = (signal = new AbortController().signal) => ({ agent: { id: 'main' }, signal })
const tool = (config = cfg(), subagents = { resolveMaxDepth: () => 3, startActivation: async () => ({}) }) =>
  createOrchestrateTool({ defineTool: (definition) => definition, subagents, config })
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitUntil(predicate, timeoutMs = 1500) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition')
    await delay(5)
  }
}

/** Parse the item/stage numbers out of the activation label the tool builds. */
const itemOf = (spec) => Number(/item (\d+)\//.exec(spec.label)[1]) - 1
const stageOf = (spec) => Number(/stage (\d+)\//.exec(spec.label)[1]) - 1

/**
 * A subagent service whose handler runs one worker. `result` is a promise, as in
 * the host contract, so the tool's own maxConcurrency is what bounds live workers.
 */
function trackedSubagents(handler) {
  const calls = []
  const disposed = []
  let active = 0
  let maxActive = 0
  const subagents = {
    resolveMaxDepth: () => 3,
    async startActivation(spec) {
      const index = calls.length
      calls.push(spec)
      const result = (async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        try {
          return await handler(spec, index)
        } finally {
          active -= 1
        }
      })()
      return {
        childId: `child-${index + 1}`,
        result,
        dispose: async () => {
          disposed.push(index)
        },
      }
    },
  }
  return { subagents, calls, disposed, maxActive: () => maxActive }
}

const textResult = (text) => ({ output: [{ type: 'text', text }], stopReason: 'completed' })

test('the tool is named orchestrate, takes optional route overrides and defaults maxConcurrency to 4', () => {
  const definition = tool()
  assert.equal(definition.name, ORCHESTRATE_TOOL)
  assert.equal(definition.isConcurrencySafe(), true)
  assert.deepEqual(Object.keys(definition.parameters).sort(), [
    'cwd',
    'items',
    'maxConcurrency',
    'model',
    'provider',
    'reasoning_effort',
    'stages',
  ])
  for (const key of ['provider', 'model', 'reasoning_effort']) {
    assert.equal('required' in definition.parameters[key], false)
  }
  for (const key of ['provider', 'model']) {
    assert.match(definition.parameters[key].description, /only when the user explicitly names/)
  }
  assert.match(definition.parameters.reasoning_effort.description, /set it only when the user names it/)
  assert.deepEqual(parseOrchestrateArgs({ items: [1], stages: [{ name: 's', prompt: 'p' }] }), {
    cwd: undefined,
    items: [1],
    stages: [{ name: 's', prompt: 'p' }],
    maxConcurrency: 4,
  })
  assert.equal(parseOrchestrateArgs({ cwd: '  work  ', items: [1], stages: [{ name: 's', prompt: 'p' }] }).cwd, 'work')
  assert.equal(LIMITS.items.max, 64)
  assert.equal(LIMITS.stages.max, 8)
})

test('every worker uses the configured route, caller delivery and the stage outputSchema', async () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
  const { subagents, calls } = trackedSubagents(async () => textResult('done'))
  const definition = tool(cfg(), subagents)
  await definition.execute(
    {
      cwd: 'work',
      items: [{ id: 1 }, { id: 2 }],
      stages: [
        { name: 'first', prompt: 'do it' },
        { name: 'second', prompt: 'check it', schema },
      ],
    },
    exec(),
  )
  assert.equal(calls.length, 4)
  for (const spec of calls) {
    assert.equal(spec.provider, 'spawn')
    assert.equal(spec.delivery, 'caller')
    assert.deepEqual(spec.request.agentOptions, ROUTE)
    assert.deepEqual(spec.request.parent, { id: 'main' })
    assert.equal(spec.request.cwd, 'work')
    assert.equal(spec.request.maxDepth, 3)
    assert.equal(JSON.stringify(spec.request).includes('"provider":"nexus-deepseek"'), true)
    if (stageOf(spec) === 1) assert.deepEqual(spec.request.outputSchema, schema)
    else assert.equal('outputSchema' in spec.request, false)
  }
})

test('an unconfigured worker route fails before any worker starts', async () => {
  const { subagents, calls } = trackedSubagents(async () => textResult('x'))
  await assert.rejects(
    () => tool(cfg('', 'm'), subagents).execute({ items: [1], stages: [{ name: 's', prompt: 'p' }] }, exec()),
    /worker route is not configured/,
  )
  assert.equal(calls.length, 0)
})

test('invalid arguments and stage schemas fail globally before any worker starts', async () => {
  const stage = { name: 's', prompt: 'p' }
  const cases = [
    [{ stages: [stage] }, /"items" must be a JSON array/],
    [{ items: [], stages: [stage] }, /must contain 1\.\.64 entries/],
    [{ items: Array.from({ length: 65 }, (_, i) => i), stages: [stage] }, /must contain 1\.\.64 entries/],
    [{ items: [() => 1], stages: [stage] }, /item 1 is not a lossless JSON value/],
    [{ items: [1], stages: [] }, /must contain 1\.\.8 stages/],
    [{ items: [1], stages: Array.from({ length: 9 }, (_, i) => ({ name: `s${i}`, prompt: 'p' })) }, /must contain 1\.\.8 stages/],
    [{ items: [1], stages: [{ name: '', prompt: 'p' }] }, /stage 1 requires a non-empty "name"/],
    [{ items: [1], stages: [{ name: 's' }] }, /stage 1 requires a non-empty "prompt"/],
    [{ items: [1], stages: [stage], maxConcurrency: 0 }, /maxConcurrency.*1\.\.16/],
    [{ items: [1], stages: [stage], maxConcurrency: 17 }, /maxConcurrency.*1\.\.16/],
    [{ items: [1], stages: [stage], maxConcurrency: 2.5 }, /maxConcurrency.*integer/],
    [{ items: [1], stages: [stage], cwd: 7 }, /"cwd" must be a string/],
    [{ items: [1], stages: [stage], cwd: '' }, /"cwd" must be a non-empty string/],
    [{ items: [1], stages: [stage], cwd: '   ' }, /"cwd" must be a non-empty string/],
    [{ items: [1], stages: [stage], cwd: '\t\n' }, /"cwd" must be a non-empty string/],
    [{ items: [1], stages: [stage], extra: true }, /arguments has unknown field "extra"/],
    [{ items: [1], stages: [{ ...stage, provider: 'nexus-deepseek' }] }, /stage 1 has unknown field "provider"/],
    [{ items: [1], stages: [{ ...stage, model: 'deepseek-v4.1-flash' }] }, /stage 1 has unknown field "model"/],
    [{ items: [1], stages: [{ ...stage, schema: { type: 'array' } }] }, /unsupported stage schema.*must be "object"/],
    [{ items: [1], stages: [{ ...stage, schema: { type: 'object', nope: true } }] }, /nope is not a supported keyword/],
  ]
  for (const [args, pattern] of cases) {
    const { subagents, calls } = trackedSubagents(async () => textResult('x'))
    await assert.rejects(() => tool(cfg(), subagents).execute(args, exec()), pattern)
    assert.equal(calls.length, 0, JSON.stringify(args))
  }
})

test('24 items fan out within maxConcurrency and keep result order', async () => {
  const { subagents, calls, maxActive } = trackedSubagents(async (spec) => {
    await delay(10)
    return textResult(`item-${itemOf(spec) + 1}`)
  })
  const items = Array.from({ length: 24 }, (_, index) => ({ n: index }))
  const result = await tool(cfg(), subagents).execute(
    { items, stages: [{ name: 'one', prompt: 'p' }], maxConcurrency: 3 },
    exec(),
  )
  assert.equal(calls.length, 24)
  assert.equal(result.kind, 'orchestration')
  assert.equal(result.agentsStarted, 24)
  assert.equal(result.errors.length, 0)
  assert.equal(result.results.length, 24)
  result.results.forEach((entry, index) => {
    assert.equal(entry.index, index)
    assert.equal(entry.output, `item-${index + 1}`)
    assert.equal(entry.stopReason, 'completed')
  })
  assert.equal(maxActive() <= 3, true, `max active ${maxActive()}`)
  assert.equal(maxActive() >= 2, true, 'workers should overlap')
})

test('a pipeline has no global barrier and feeds the previous stage output forward', async () => {
  const events = []
  let releaseSlow
  const slowGate = new Promise((resolve) => {
    releaseSlow = resolve
  })
  const { subagents, calls } = trackedSubagents(async (spec) => {
    const item = itemOf(spec)
    const stage = stageOf(spec)
    if (item === 0 && stage === 0) {
      events.push('slow-start')
      await slowGate
      events.push('slow-end')
      return textResult('slow')
    }
    if (item === 1 && stage === 1) {
      events.push('fast-stage2')
      releaseSlow()
      return textResult('fast')
    }
    return textResult(`i${item}s${stage}`)
  })

  const running = tool(cfg(), subagents).execute(
    {
      items: [{ id: 'a' }, { id: 'b' }],
      stages: [
        { name: 'extract', prompt: 'Extract.' },
        { name: 'verify', prompt: 'Verify.' },
      ],
      maxConcurrency: 4,
    },
    exec(),
  )

  let barrier = false
  try {
    await waitUntil(() => events.includes('fast-stage2'))
  } catch {
    barrier = true
  } finally {
    releaseSlow()
  }
  const result = await running
  assert.equal(barrier, false, 'item 2 stage 2 must start before item 1 stage 1 finishes')
  assert.equal(events.indexOf('fast-stage2') < events.indexOf('slow-end'), true)

  const stage2 = calls.find((spec) => itemOf(spec) === 1 && stageOf(spec) === 1)
  assert.match(stage2.request.prompt[0].text, /Verify\./)
  assert.match(stage2.request.prompt[0].text, /"id":"b"/)
  assert.match(stage2.request.prompt[0].text, /Previous stage "extract" output \(JSON\):/)
  assert.match(stage2.request.prompt[0].text, /"i1s0"/)
  assert.equal(result.results[1].output, 'fast')
})

test('a structured result is used as-is and validated', async () => {
  const schema = { type: 'object', properties: { answer: { type: 'integer' } }, required: ['answer'], additionalProperties: false }
  const { subagents, calls } = trackedSubagents(async () => ({
    output: [],
    stopReason: 'completed',
    structured: { answer: 42 },
  }))
  const result = await tool(cfg(), subagents).execute(
    { items: [1], stages: [{ name: 's', prompt: 'p', schema }] },
    exec(),
  )
  assert.deepEqual(result.results[0].output, { answer: 42 })
  assert.equal(calls[0].request.outputSchema, schema)
})

test('text that is strictly JSON falls back when there is no structured result', async () => {
  const schema = { type: 'object', properties: { answer: { type: 'integer' } }, required: ['answer'], additionalProperties: false }
  const { subagents } = trackedSubagents(async () => textResult('{"answer":7}'))
  const result = await tool(cfg(), subagents).execute(
    { items: [1], stages: [{ name: 's', prompt: 'p', schema }] },
    exec(),
  )
  assert.deepEqual(result.results[0].output, { answer: 7 })
})

test('a run marked error with no structured result still recovers strict JSON text', async () => {
  const schema = { type: 'object', properties: { answer: { type: 'integer' } }, required: ['answer'], additionalProperties: false }
  const { subagents } = trackedSubagents(async () => ({
    output: [{ type: 'text', text: '{"ans' }, { type: 'text', text: 'wer":7}' }],
    stopReason: 'error',
  }))
  const result = await tool(cfg(), subagents).execute(
    { items: [1], stages: [{ name: 's', prompt: 'p', schema }] },
    exec(),
  )
  assert.equal(result.errors.length, 0)
  assert.deepEqual(result.results[0].output, { answer: 7 })
  assert.equal(typeof result.results[0].output, 'object')
})

test('an error run with unusable text still fails that item and never echoes the text', async () => {
  const schema = { type: 'object', properties: { answer: { type: 'integer' } }, required: ['answer'], additionalProperties: false }
  const cases = [
    ['ANSWER: 7', /not strictly JSON/],
    ['{"answer":', /not strictly JSON/],
    ['```json\n{"answer":7}\n```', /not strictly JSON/],
    ['{"answer":"seven"}', /text result does not match the stage schema/],
    ['{"nope":1}', /text result does not match the stage schema/],
  ]
  for (const [text, pattern] of cases) {
    const { subagents } = trackedSubagents(async () => ({ output: [{ type: 'text', text }], stopReason: 'error' }))
    const result = await tool(cfg(), subagents).execute(
      { items: [1], stages: [{ name: 's', prompt: 'p', schema }] },
      exec(),
    )
    assert.equal(result.results[0], null, text)
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0].message, pattern)
    assert.equal(result.errors[0].message.includes(text), false, 'the worker text must not leak into the error')
  }
})

test('aborted, max-tokens and refusal never recover JSON text, even with a schema', async () => {
  const schema = { type: 'object', properties: { answer: { type: 'integer' } }, required: ['answer'], additionalProperties: false }
  for (const stopReason of ['aborted', 'max-tokens', 'refusal', 'timeout', undefined]) {
    for (const structured of [false, true]) {
      const { subagents } = trackedSubagents(async () => ({
        output: [{ type: 'text', text: '{"answer":7}' }],
        stopReason,
        ...(structured ? { structured: { answer: 7 } } : {}),
      }))
      const result = await tool(cfg(), subagents).execute(
        { items: [1], stages: [{ name: 's', prompt: 'p', schema }] },
        exec(),
      )
      assert.equal(result.results[0], null, `${stopReason} structured=${structured}`)
      assert.match(result.errors[0].message, /stopped with reason/)
    }
  }
})

test('an invalid structured result fails even when the text would parse, whatever the stop reason', async () => {
  const schema = { type: 'object', properties: { answer: { type: 'integer' } }, required: ['answer'], additionalProperties: false }
  for (const stopReason of ['completed', 'error']) {
    const { subagents } = trackedSubagents(async () => ({
      output: [{ type: 'text', text: '{"answer":7}' }],
      stopReason,
      structured: { answer: 'bad' },
    }))
    const result = await tool(cfg(), subagents).execute(
      { items: [1], stages: [{ name: 's', prompt: 'p', schema }] },
      exec(),
    )
    assert.equal(result.results[0], null, stopReason)
    assert.match(result.errors[0].message, /structured result does not match the stage schema/)
  }
})

test('a structured result is authoritative even when the text would also parse', async () => {
  const schema = { type: 'object', properties: { answer: { type: 'integer' } }, required: ['answer'], additionalProperties: false }
  const { subagents } = trackedSubagents(async () => ({
    output: [{ type: 'text', text: '{"answer":7}' }],
    stopReason: 'completed',
    structured: { answer: 'bad' },
  }))
  const result = await tool(cfg(), subagents).execute(
    { items: [1], stages: [{ name: 's', prompt: 'p', schema }] },
    exec(),
  )
  assert.equal(result.results[0], null)
  assert.match(result.errors[0].message, /structured result does not match the stage schema/)
})

test('a non-JSON fallback or a schema mismatch fails that item', async () => {
  const schema = { type: 'object', properties: { answer: { type: 'integer' } }, required: ['answer'], additionalProperties: false }
  const notJson = trackedSubagents(async () => textResult('not json'))
  let result = await tool(cfg(), notJson.subagents).execute(
    { items: [1], stages: [{ name: 's', prompt: 'p', schema }] },
    exec(),
  )
  assert.equal(result.results[0], null)
  assert.match(result.errors[0].message, /not strictly JSON/)

  const mismatch = trackedSubagents(async () => textResult('{"answer":"x"}'))
  result = await tool(cfg(), mismatch.subagents).execute(
    { items: [1], stages: [{ name: 's', prompt: 'p', schema }] },
    exec(),
  )
  assert.equal(result.results[0], null)
  assert.match(result.errors[0].message, /text result does not match the stage schema/)
})

test('one failing item is isolated, later stages for it are skipped and order is kept', async () => {
  const { subagents, calls } = trackedSubagents(async (spec) => {
    if (itemOf(spec) === 1 && stageOf(spec) === 1) return { output: [], stopReason: 'error' }
    return textResult(`i${itemOf(spec)}s${stageOf(spec)}`)
  })
  const result = await tool(cfg(), subagents).execute(
    {
      items: ['a', 'b', 'c'],
      stages: [
        { name: 'first', prompt: 'p1' },
        { name: 'second', prompt: 'p2' },
        { name: 'third', prompt: 'p3' },
      ],
      maxConcurrency: 4,
    },
    exec(),
  )
  assert.equal(result.results[0].output, 'i0s2')
  assert.equal(result.results[1], null)
  assert.equal(result.results[2].output, 'i2s2')
  assert.deepEqual(result.errors, [
    { index: 1, stage: 'second', message: 'worker stopped with reason "error" before finishing the stage' },
  ])
  // Item 1 stops after the failing stage: 3 first + 3 second + 2 third calls.
  assert.equal(calls.length, 8)
  assert.equal(calls.filter((spec) => itemOf(spec) === 1).length, 2)
  assert.equal(result.agentsStarted, 8)
})

test('a worker that fails to start is isolated like any other item failure', async () => {
  let starts = 0
  const subagents = {
    resolveMaxDepth: () => 3,
    async startActivation() {
      const index = starts
      starts += 1
      if (index === 1) throw new Error('spawn failed')
      return { childId: `child-${index}`, result: Promise.resolve(textResult('ok')), dispose: async () => {} }
    },
  }
  const result = await tool(cfg(), subagents).execute(
    { items: ['a', 'b', 'c'], stages: [{ name: 's', prompt: 'p' }], maxConcurrency: 1 },
    exec(),
  )
  assert.equal(result.results[0].output, 'ok')
  assert.equal(result.results[1], null)
  assert.equal(result.results[2].output, 'ok')
  assert.deepEqual(result.errors, [{ index: 1, stage: 's', message: 'spawn failed' }])
  assert.equal(result.agentsStarted, 2)
})

test('aborting stops new dispatch, clears running workers and rejects the call', async () => {
  const ac = new AbortController()
  const reason = new Error('stop now')
  const calls = []
  const disposed = []
  const subagents = {
    resolveMaxDepth: () => 3,
    async startActivation(spec) {
      const index = calls.length
      calls.push(spec)
      let settle
      const result = new Promise((resolve) => {
        settle = resolve
      })
      return {
        childId: `child-${index}`,
        result,
        dispose: async () => {
          disposed.push(index)
          settle({ output: [], stopReason: 'aborted' })
        },
      }
    },
  }
  const running = tool(cfg(), subagents).execute(
    { items: ['a', 'b', 'c'], stages: [{ name: 's', prompt: 'p' }], maxConcurrency: 1 },
    { agent: { id: 'main' }, signal: ac.signal },
  )
  await waitUntil(() => calls.length === 1)
  ac.abort(reason)
  await assert.rejects(() => running, (error) => error === reason)
  assert.equal(calls.length, 1, 'queued items must not start after the abort')
  assert.deepEqual(disposed, [0], 'the running worker must be disposed')
})

test('aborting rejects immediately while startActivation is still pending', async () => {
  const ac = new AbortController()
  const reason = new Error('stop now')
  const calls = []
  let releaseStart
  const subagents = {
    resolveMaxDepth: () => 3,
    startActivation(spec) {
      calls.push(spec)
      return new Promise((resolve) => {
        releaseStart = () => resolve({ childId: 'late', result: new Promise(() => {}), dispose: async () => {} })
      })
    },
  }
  const running = tool(cfg(), subagents).execute(
    { items: ['a'], stages: [{ name: 's', prompt: 'p' }] },
    { agent: { id: 'main' }, signal: ac.signal },
  )
  await waitUntil(() => calls.length === 1)
  ac.abort(reason)
  try {
    const outcome = await Promise.race([
      running.then(() => 'resolved', (error) => error),
      delay(200).then(() => 'still-pending'),
    ])
    assert.equal(outcome, reason, 'abort must not wait for a hanging startActivation')
  } finally {
    releaseStart()
  }
  assert.equal(calls.length, 1)
})

test('a handle that resolves after the abort is disposed and never dispatched', async () => {
  const ac = new AbortController()
  const calls = []
  const disposed = []
  let releaseStart
  const subagents = {
    resolveMaxDepth: () => 3,
    startActivation(spec) {
      calls.push(spec)
      return new Promise((resolve) => {
        releaseStart = () =>
          resolve({
            childId: 'late',
            // A late handle must not leave this rejection unhandled.
            result: Promise.reject(new Error('late worker failure')),
            dispose: async () => {
              disposed.push('late')
            },
          })
      })
    },
  }
  const running = tool(cfg(), subagents).execute(
    { items: ['a'], stages: [{ name: 's', prompt: 'p' }] },
    { agent: { id: 'main' }, signal: ac.signal },
  )
  await waitUntil(() => calls.length === 1)
  ac.abort(new Error('stop'))
  await assert.rejects(() => running, /stop/)
  assert.deepEqual(disposed, [], 'a start that is still pending has nothing to dispose')
  releaseStart()
  await waitUntil(() => disposed.length === 1)
  await delay(20)
  assert.equal(calls.length, 1, 'a late handle must not dispatch a new worker')
  assert.deepEqual(disposed, ['late'], 'the late handle is disposed exactly once')
})

test('a worker stopping with reason "aborted" is an item failure, not a call abort', async () => {
  const { subagents } = trackedSubagents(async (spec) =>
    itemOf(spec) === 0 ? { output: [], stopReason: 'aborted' } : textResult('fine'),
  )
  const result = await tool(cfg(), subagents).execute(
    { items: ['a', 'b'], stages: [{ name: 's', prompt: 'p' }] },
    exec(),
  )
  assert.equal(result.results[0], null)
  assert.equal(result.results[1].output, 'fine')
  assert.match(result.errors[0].message, /stopped with reason "aborted"/)
})

test('an oversized serialized result is an explicit error, never truncated', async () => {
  const { subagents } = trackedSubagents(async () => textResult('x'.repeat(LIMITS.serializedResultChars + 10)))
  await assert.rejects(
    () => tool(cfg(), subagents).execute({ items: [1], stages: [{ name: 's', prompt: 'p' }] }, exec()),
    /character limit/,
  )
})

test('execute refuses a missing agent or signal before starting a worker', async () => {
  const { subagents, calls } = trackedSubagents(async () => textResult('x'))
  await assert.rejects(
    () => tool(cfg(), subagents).execute({ items: [1], stages: [{ name: 's', prompt: 'p' }] }, { signal: new AbortController().signal }),
    /requires a calling agent/,
  )
  await assert.rejects(
    () => tool(cfg(), subagents).execute({ items: [1], stages: [{ name: 's', prompt: 'p' }] }, { agent: {} }),
    /requires a cancellation signal/,
  )
  assert.equal(calls.length, 0)
})

test('stage prompts carry the instruction, the original item and the previous output', () => {
  const first = buildStagePrompt({
    stage: { name: 'extract', prompt: 'Extract facts.' },
    stageIndex: 0,
    stageCount: 2,
    item: { id: 'a', nested: [1, 2] },
    itemIndex: 0,
    itemCount: 2,
  })
  assert.match(first, /^Extract facts\./)
  assert.match(first, /Stage "extract" \(1 of 2\) for item 1 of 2\./)
  assert.match(first, /Original item \(JSON\):\n\{"id":"a","nested":\[1,2\]\}/)
  assert.match(first, /first stage/)
  assert.equal(first.includes('Previous stage'), false)

  const second = buildStagePrompt({
    stage: { name: 'verify', prompt: 'Verify facts.' },
    stageIndex: 1,
    stageCount: 2,
    item: { id: 'a' },
    itemIndex: 0,
    itemCount: 2,
    previous: { stageName: 'extract', output: { facts: ['x'] } },
  })
  assert.match(second, /Previous stage "extract" output \(JSON\):\n\{"facts":\["x"\]\}/)
  assert.match(second, /Continue from that output/)

  // A schema stage asks for structured_output first and JSON-only text otherwise.
  assert.equal(first.includes('structured_output'), false)
  assert.equal(second.includes('structured_output'), false)
  const structured = buildStagePrompt({
    stage: { name: 'classify', prompt: 'Classify.', schema: { type: 'object' } },
    stageIndex: 0,
    stageCount: 1,
    item: { id: 'a' },
    itemIndex: 0,
    itemCount: 1,
  })
  assert.match(structured, /Prefer the structured_output tool/)
  assert.match(structured, /reply with only the JSON object that matches the stage schema/)
  assert.match(structured, /No explanation, no markdown, no code fences\.$/)
})

test('readStageOutput handles text, a missing result, an empty result and text parts', () => {
  assert.equal(readStageOutput({}, { output: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], stopReason: 'completed' }), 'ab')
  assert.equal(collectText('plain'), 'plain')
  assert.equal(collectText([{ type: 'text', text: 'x' }, { type: 'image' }]), 'x')
  assert.throws(() => readStageOutput({}, undefined), /no result/)
  assert.throws(() => readStageOutput({}, { output: [], stopReason: 'error' }), /stopped with reason "error"/)
})

test('runOrchestration can be driven directly with a plan', async () => {
  const { subagents } = trackedSubagents(async () => textResult('direct'))
  const result = await runOrchestration({
    plan: { cwd: undefined, items: [1], stages: [{ name: 's', prompt: 'p' }], maxConcurrency: 1 },
    parent: { id: 'main' },
    route: ROUTE,
    maxDepth: 2,
    subagents,
    signal: new AbortController().signal,
  })
  assert.deepEqual(result, {
    kind: 'orchestration',
    agentsStarted: 1,
    results: [{ index: 0, output: 'direct', stopReason: 'completed' }],
    errors: [],
  })
})

test('an explicit provider and model apply to every worker of the call and skip the configured route', async () => {
  // An empty configured route would throw if it were read, so the override must short-circuit it.
  const { subagents, calls } = trackedSubagents(async () => textResult('done'))
  const result = await tool(cfg('', ''), subagents).execute(
    {
      provider: 'nexus-claude',
      model: 'claude-opus-5.5',
      items: [{ id: 1 }, { id: 2 }],
      stages: [{ name: 'one', prompt: 'p' }],
    },
    exec(),
  )
  assert.equal(calls.length, 2)
  for (const spec of calls) {
    assert.deepEqual(spec.request.agentOptions, { provider: 'nexus-claude', model: 'claude-opus-5.5' })
  }
  assert.equal(result.agentsStarted, 2)
  assert.equal(result.errors.length, 0)
})

test('provider and model must be given together, and no worker starts', async () => {
  for (const args of [
    { provider: 'nexus-claude' },
    { model: 'claude-opus-5.5' },
    { provider: 'nexus-claude', model: '  ' },
    { reasoning_effort: 'high' },
  ]) {
    const { subagents, calls } = trackedSubagents(async () => textResult('x'))
    await assert.rejects(
      () =>
        tool(cfg('nexus-deepseek', 'deepseek-v4.1-flash'), subagents).execute(
          { items: [1], stages: [{ name: 's', prompt: 'p' }], ...args },
          exec(),
        ),
      /"provider" and "model" must be given together/,
    )
    assert.equal(calls.length, 0, JSON.stringify(args))
  }
})

test('a non-string override field is refused instead of coerced', async () => {
  const { subagents, calls } = trackedSubagents(async () => textResult('x'))
  await assert.rejects(
    () =>
      tool(cfg(), subagents).execute(
        { items: [1], stages: [{ name: 's', prompt: 'p' }], provider: 7, model: 'm' },
        exec(),
      ),
    /"provider" must be a string/,
  )
  assert.equal(calls.length, 0)
})

test('reasoning_effort passes through with the override for every worker', async () => {
  const { subagents, calls } = trackedSubagents(async () => textResult('x'))
  await tool(cfg('', ''), subagents).execute(
    {
      provider: 'nexus-claude',
      model: 'claude-opus-5.5',
      reasoning_effort: 'high',
      items: [1],
      stages: [{ name: 's', prompt: 'p' }],
    },
    exec(),
  )
  assert.deepEqual(calls[0].request.agentOptions, {
    provider: 'nexus-claude',
    model: 'claude-opus-5.5',
    reasoningEffort: 'high',
  })
})

test('the description keeps the main-agent rule and the whitelist, and states the explicit-request condition', () => {
  // The rule names exactly what the gate lets through: the whitelist, and nothing else.
  const allowed = ['delegate', 'orchestrate', 'todo_write']
  const definition = createOrchestrateTool({
    defineTool: (d) => d,
    subagents: {},
    config: cfg(),
    allowedTools: allowed,
  })
  assert.equal(definition.description.startsWith(mainAgentRule(allowed, ORCHESTRATE_TOOL)), true)
  assert.match(
    definition.description,
    /Allowed for the main agent \(whitelist-driven; every other tool is blocked\): delegate, orchestrate, todo_write\./,
  )
  assert.match(definition.description, /the main agent plans only/)
  assert.match(definition.description, /runs ONLY in a worker/i)
  assert.match(definition.description, /workers are not gated/i)
  assert.match(definition.description, /not even once/)
  assert.match(definition.description, /never re-check on a new session or after compression/i)
  assert.match(definition.description, /only when the current message explicitly names them for this dispatch/i)
  assert.match(definition.description, /A named model is for this dispatch only/i)
  assert.match(definition.description, /never reuse one from earlier turns, dispatch or summary/i)
  assert.match(definition.description, /never assume an unstated default/i)
  assert.match(definition.description, /if unsure, ask/i)
  assert.match(definition.description, /compress is available to the main agent/)
  assert.match(definition.description, /independent delegations start in the same message/i)
  // The same one-line reminder belongs on both route parameters, where a model would be typed.
  for (const param of ['provider', 'model']) {
    const description = definition.parameters[param].description
    assert.match(description, /this one dispatch only/i, param)
    assert.match(description, /never reuse a model from earlier turns or a summary/i, param)
  }
  assert.equal(definition.description.includes('takes no provider or model parameters'), false)
})

test('the worker variant drops the main-agent rule and keeps the same contract', () => {
  // A delegated child reads the global description too; its scoped shadow must not
  // repeat a rule about a role it does not have.
  const definition = createOrchestrateTool({
    defineTool: (x) => x,
    subagents: {},
    config: cfg(),
    allowedTools: ['delegate', 'orchestrate'],
    forWorker: true,
  })
  assert.equal(/main[- ]agent/i.test(definition.description), false)
  assert.equal(definition.description.includes('Main-agent rule:'), false)
  assert.equal(definition.description.includes('runs ONLY in a worker'), false)
  assert.equal(definition.description.includes('delegate, orchestrate'), false)
  assert.ok(definition.description.length < 400)
  assert.match(definition.description, /one worker per item/)
  assert.match(definition.description, /configured route/)
  // The parameters and the execution path are shared with the main-agent variant.
  assert.equal(definition.name, ORCHESTRATE_TOOL)
  assert.equal(definition.parameters.items.required, true)
  assert.match(definition.parameters.provider.description, /only when the user explicitly names/)
})
