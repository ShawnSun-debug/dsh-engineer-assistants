import assert from 'node:assert/strict'
import test from 'node:test'
import { DELEGATE_TOOL, buildActivation, createDelegateTool, languageNote, readRoute } from '../lib/delegate.js'
import { mainAgentRule } from '../lib/rules.js'

const cfg = (provider, model, effort = '') => ({
  workerProvider: { get: () => provider },
  workerModel: { get: () => model },
  workerReasoningEffort: { get: () => effort },
})

test('readRoute returns provider and model, and omits an empty effort', () => {
  assert.deepEqual(readRoute(cfg('nexus-deepseek', 'deepseek-v4.1-flash')), {
    provider: 'nexus-deepseek',
    model: 'deepseek-v4.1-flash',
  })
})

test('readRoute carries a named effort and trims whitespace', () => {
  assert.deepEqual(readRoute(cfg(' nexus-claude ', ' claude-opus-5.5 ', ' high ')), {
    provider: 'nexus-claude',
    model: 'claude-opus-5.5',
    reasoningEffort: 'high',
  })
})

test('readRoute refuses an unconfigured route instead of inheriting the parent silently', () => {
  assert.throws(() => readRoute(cfg('', 'm')), /worker route is not configured/)
  assert.throws(() => readRoute(cfg('p', '  ')), /worker route is not configured/)
})

test('buildActivation shapes the spawn request with the route and parent delivery', () => {
  const parent = { id: 'main' }
  const signal = new AbortController().signal
  const route = { provider: 'p', model: 'm', reasoningEffort: 'high' }
  const spec = buildActivation({ args: { description: 'fix parser', prompt: 'do it' }, parent, route, maxDepth: 2, signal })
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.label, 'fix parser')
  assert.equal(spec.delivery, 'parent')
  assert.equal(spec.signal, signal)
  assert.deepEqual(spec.request.prompt, [{ type: 'text', text: languageNote('do it') + 'do it' }])
  assert.equal(spec.request.parent, parent)
  assert.deepEqual(spec.request.agentOptions, route)
  assert.equal(spec.request.maxDepth, 2)
  assert.equal('cwd' in spec.request, false)
})

test('buildActivation passes cwd through and leaves out an undefined depth', () => {
  const spec = buildActivation({ args: { description: 'd', prompt: 'p', cwd: 'sub' }, parent: {}, route: {}, maxDepth: undefined })
  assert.equal(spec.request.cwd, 'sub')
  assert.equal('maxDepth' in spec.request, false)
})

test('the worker header asks for a final summary instead of a send_message report', () => {
  const header = languageNote('把这段代码重构一下')
  assert.match(header, /^用中文回复。/)
  assert.match(header, /完成任务时直接在回复中输出最终总结并结束本回合/)
  assert.match(header, /禁止调用 send_message 向父代理发送完成汇报/)
  assert.match(header, /主代理会自动接收你的收尾消息/)
  // The wording no longer depends on the request, so any prompt gets the same header.
  assert.equal(languageNote('do it'), header)
})

test('the tool is concurrency-safe, named delegate, and takes optional route overrides', () => {
  const tool = createDelegateTool({ defineTool: (d) => d, subagents: {}, config: cfg('p', 'm') })
  assert.equal(tool.name, DELEGATE_TOOL)
  assert.equal(tool.isConcurrencySafe(), true)
  assert.deepEqual(Object.keys(tool.parameters).sort(), [
    'cwd',
    'deps',
    'description',
    'doneDefinition',
    'fallback',
    'files',
    'goal',
    'irreversible',
    'model',
    'prompt',
    'provider',
    'reasoning_effort',
    'review',
    'verify',
  ])
  // The author dialect spells requiredness per property, not as a `required` array.
  assert.equal(tool.parameters.prompt.required, true)
  assert.equal(tool.parameters.description.required, true)
  assert.equal('required' in tool.parameters.cwd, false)
  for (const key of ['provider', 'model', 'reasoning_effort']) {
    assert.equal('required' in tool.parameters[key], false)
  }
  for (const key of ['provider', 'model']) {
    assert.match(tool.parameters[key].description, /only when the user explicitly names/)
  }
  assert.match(tool.parameters.reasoning_effort.description, /set it only when the user names it/)
})

test('execute rejects a missing prompt or description before touching the route', async () => {
  const tool = createDelegateTool({ defineTool: (d) => d, subagents: {}, config: cfg('p', 'm') })
  await assert.rejects(() => tool.execute({ description: 'x' }, { agent: {} }), /non-empty prompt/)
  await assert.rejects(() => tool.execute({ prompt: 'x' }, { agent: {} }), /non-empty description/)
})

test('execute reads the route per call, so a changed route applies to the next delegation', async () => {
  const seen = []
  let route = ['nexus-deepseek', 'deepseek-v4.1-flash']
  const config = {
    workerProvider: { get: () => route[0] },
    workerModel: { get: () => route[1] },
    workerReasoningEffort: { get: () => '' },
  }
  const subagents = {
    resolveMaxDepth: () => 2,
    startActivation: async (spec) => {
      seen.push(spec.request.agentOptions)
      return { childId: 'child-' + seen.length }
    },
  }
  const tool = createDelegateTool({ defineTool: (d) => d, subagents, config })
  const exec = { agent: { id: 'main' }, signal: new AbortController().signal }
  const first = await tool.execute({ description: 'a', prompt: 'x' }, exec)
  route = ['nexus-claude', 'claude-opus-5.5']
  await tool.execute({ description: 'b', prompt: 'y' }, exec)
  assert.deepEqual(first, { kind: 'activation', subagentId: 'child-1' })
  assert.equal(seen[0].model, 'deepseek-v4.1-flash')
  assert.equal(seen[1].model, 'claude-opus-5.5')
})

test('execute fails loudly without a calling agent and does not start anything', async () => {
  let started = false
  const subagents = { resolveMaxDepth: () => 1, startActivation: async () => { started = true } }
  const tool = createDelegateTool({ defineTool: (d) => d, subagents, config: cfg('p', 'm') })
  await assert.rejects(() => tool.execute({ description: 'a', prompt: 'x' }, { signal: new AbortController().signal }), /requires a calling agent/)
  assert.equal(started, false)
})

test('an aborted signal stops execute before a worker is started', async () => {
  let started = false
  const subagents = { resolveMaxDepth: () => 1, startActivation: async () => { started = true } }
  const tool = createDelegateTool({ defineTool: (d) => d, subagents, config: cfg('p', 'm') })
  const ac = new AbortController()
  ac.abort()
  await assert.rejects(() => tool.execute({ description: 'a', prompt: 'x' }, { agent: {}, signal: ac.signal }))
  assert.equal(started, false)
})

test('a successful start reports the child and leaves the returned result unchanged', async () => {
  const seen = []
  const started = { childId: 'child-9', result: Promise.resolve('done') }
  const subagents = { resolveMaxDepth: () => 1, startActivation: async () => started }
  const tool = createDelegateTool({
    defineTool: (d) => d,
    subagents,
    config: cfg('p', 'm'),
    onStarted(parent, child, args) {
      seen.push({ parent, child, args })
    },
  })
  const exec = { agent: { id: 'main' }, signal: new AbortController().signal }
  const value = await tool.execute({ description: 'a', prompt: 'x' }, exec)
  assert.deepEqual(value, { kind: 'activation', subagentId: 'child-9' })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].parent, exec.agent)
  assert.equal(seen[0].child, started)
  assert.equal(seen[0].args.description, 'a')
})

test('a broken onStarted cannot affect dispatch or its result', async () => {
  const subagents = { resolveMaxDepth: () => 1, startActivation: async () => ({ childId: 'child-1' }) }
  const exec = { agent: { id: 'main' }, signal: new AbortController().signal }

  const throwing = createDelegateTool({
    defineTool: (d) => d,
    subagents,
    config: cfg('p', 'm'),
    onStarted() {
      throw new Error('supervision is broken')
    },
  })
  assert.deepEqual(await throwing.execute({ description: 'a', prompt: 'x' }, exec), {
    kind: 'activation',
    subagentId: 'child-1',
  })

  // An async callback that rejects is also swallowed, so it cannot surface later.
  const rejecting = createDelegateTool({
    defineTool: (d) => d,
    subagents,
    config: cfg('p', 'm'),
    onStarted: async () => {
      throw new Error('async supervision is broken')
    },
  })
  assert.deepEqual(await rejecting.execute({ description: 'a', prompt: 'x' }, exec), {
    kind: 'activation',
    subagentId: 'child-1',
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
})

const exec = () => ({ agent: { id: 'main' }, signal: new AbortController().signal })

/** A delegate tool whose subagent service records the route every worker starts on. */
function recordingTool(config) {
  const seen = []
  const subagents = {
    resolveMaxDepth: () => 1,
    startActivation: async (spec) => {
      seen.push(spec.request.agentOptions)
      return { childId: 'child-' + seen.length }
    },
  }
  return { seen, tool: createDelegateTool({ defineTool: (d) => d, subagents, config }) }
}

test('without an override the configured route is used unchanged', async () => {
  const { seen, tool } = recordingTool(cfg('nexus-deepseek', 'deepseek-v4.1-flash', 'high'))
  await tool.execute({ description: 'a', prompt: 'x' }, exec())
  assert.deepEqual(seen, [
    { provider: 'nexus-deepseek', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
  ])
})

test('an explicit provider and model replace the configured route for that worker', async () => {
  // An empty configured route would throw if it were read, so the override must short-circuit it.
  const { seen, tool } = recordingTool(cfg('', ''))
  await tool.execute(
    { description: 'a', prompt: 'x', provider: 'nexus-claude', model: 'claude-opus-5.5' },
    exec(),
  )
  assert.deepEqual(seen, [{ provider: 'nexus-claude', model: 'claude-opus-5.5' }])
})

test('provider and model must be given together, and nothing starts', async () => {
  const { seen, tool } = recordingTool(cfg('nexus-deepseek', 'deepseek-v4.1-flash'))
  for (const args of [
    { provider: 'nexus-claude' },
    { model: 'claude-opus-5.5' },
    { provider: 'nexus-claude', model: '  ' },
    { reasoning_effort: 'high' },
  ]) {
    await assert.rejects(
      () => tool.execute({ description: 'a', prompt: 'x', ...args }, exec()),
      /"provider" and "model" must be given together/,
    )
    assert.equal(seen.length, 0, JSON.stringify(args))
  }
})

test('a non-string override field is refused instead of coerced', async () => {
  const { seen, tool } = recordingTool(cfg('p', 'm'))
  await assert.rejects(
    () => tool.execute({ description: 'a', prompt: 'x', provider: 7, model: 'm' }, exec()),
    /"provider" must be a string/,
  )
  assert.equal(seen.length, 0)
})

test('reasoning_effort passes through with the override and is trimmed', async () => {
  const { seen, tool } = recordingTool(cfg('', ''))
  await tool.execute(
    {
      description: 'a',
      prompt: 'x',
      provider: ' nexus-claude ',
      model: ' claude-opus-5.5 ',
      reasoning_effort: ' high ',
    },
    exec(),
  )
  assert.deepEqual(seen, [
    { provider: 'nexus-claude', model: 'claude-opus-5.5', reasoningEffort: 'high' },
  ])
})

test('the description keeps the main-agent rule and the whitelist, and states the explicit-request condition', () => {
  // The rule names exactly what the gate lets through, so the test drives it with a
  // whitelist rather than a deny list: every other tool is blocked by not being named.
  const allowed = ['delegate', 'orchestrate', 'todo_write']
  const tool = createDelegateTool({
    defineTool: (d) => d,
    subagents: {},
    config: cfg('p', 'm'),
    allowedTools: allowed,
  })
  assert.equal(tool.description.startsWith(mainAgentRule(allowed)), true)
  assert.match(
    tool.description,
    /Allowed for the main agent \(whitelist-driven; every other tool is blocked\): delegate, orchestrate, todo_write\./,
  )
  assert.match(tool.description, /the main agent plans only/)
  assert.match(tool.description, /runs ONLY in a worker/i)
  assert.match(tool.description, /workers are not gated/i)
  assert.match(tool.description, /not even once/)
  assert.match(tool.description, /never re-check on a new session or after compression/i)
  assert.match(tool.description, /only when the current message explicitly names them for this dispatch/i)
  assert.match(tool.description, /A named model is for this dispatch only/i)
  assert.match(tool.description, /never reuse one from earlier turns, dispatch or summary/i)
  assert.match(tool.description, /never assume an unstated default/i)
  assert.match(tool.description, /if unsure, ask/i)
  assert.match(tool.parameters.provider.description, /Never choose one on your own initiative/i)
  assert.match(tool.description, /compress is available to the main agent/)
  assert.match(tool.description, /runtime notifies you when it finishes/i)
  assert.match(
    tool.description,
    /do not instruct the worker to send a message back or report results via send_message/i,
  )
  assert.match(tool.description, /its closing message is delivered automatically when it ends/i)
  assert.match(tool.description, /independent delegations start in the same message/i)
  assert.doesNotMatch(tool.description, /如无并行必要则让子代理汇报完结果后再进行后续操作/)
  assert.match(tool.description, /when parallel work is unnecessary, wait for the subagent to finish before proceeding/i)
  assert.match(tool.description, /do not repeatedly check its status or start duplicate workers/i)
  assert.match(tool.description, /disconnects quickly three times within 2 minutes \(two automatic retries\)/)
  assert.ok(tool.description.includes('【插件重试｜子代理 <id>】它在 2 分钟内连续 3 次快速断联（failed before it finished / It left no closing message），插件已停止自动重试'))
  assert.match(tool.description, /只提供通知中的A\/B选项并等待用户答复，不要建议继续唤醒旧子代理/)
  assert.match(tool.description, /未经用户选择A，不要另派子代理重复工作/)
  assert.match(tool.description, /结果为空时不要立即重复派遣，先确认插件状态/)
  // The same one-line reminder belongs on both route parameters, where a model would be typed.
  for (const param of ['provider', 'model']) {
    const description = tool.parameters[param].description
    assert.match(description, /this one dispatch only/i, param)
    assert.match(description, /never reuse a model from earlier turns or a summary/i, param)
  }
})

test('the worker variant drops the main-agent rule and keeps the same contract', async () => {
  // A delegated child reads the global description too; its scoped shadow must not
  // repeat a rule about a role it does not have.
  const allowed = ['delegate', 'orchestrate']
  const seen = []
  const subagents = {
    resolveMaxDepth: () => 1,
    startActivation: async (spec) => {
      seen.push(spec.request.agentOptions)
      return { childId: 'child-1' }
    },
  }
  const tool = createDelegateTool({
    defineTool: (definition) => definition,
    subagents,
    config: cfg('p', 'm'),
    allowedTools: allowed,
    forWorker: true,
  })
  assert.equal(/main[- ]agent/i.test(tool.description), false)
  assert.equal(tool.description.includes('Main-agent rule:'), false)
  assert.equal(tool.description.includes('runs ONLY in a worker'), false)
  assert.equal(tool.description.includes('delegate, orchestrate'), false)
  assert.ok(tool.description.length < 400)
  assert.match(tool.description, /self-contained task/)
  assert.match(tool.description, /configured worker route/)
  // The parameters and the execution path are shared with the main-agent variant.
  for (const key of ['provider', 'model']) {
    assert.match(tool.parameters[key].description, /only when the user explicitly names/)
  }
  assert.deepEqual(await tool.execute({ description: 'a', prompt: 'x' }, exec()), {
    kind: 'activation',
    subagentId: 'child-1',
  })
  assert.deepEqual(seen, [{ provider: 'p', model: 'm' }])
})
