import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { allowGuard } from '../lib/gate.js'
import { MAX_MESSAGE_BYTES, MAX_MESSAGE_QUEUE, checkInbound, composeMessage, deliverMessage } from '../lib/master-messaging.js'
import { MEMORY_DOMAIN_NAME, MEMORY_INDEX_SECTION, MEMORY_SECTION_ORDER } from '../lib/memory.js'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MASTER_SESSION_ID } from '../lib/master-session.js'
import { createDraftStore } from '../lib/secretary-nudge.js'

/**
 * `lib/index.js` is the DSH plugin entry, and it imports three packages the host
 * supplies at runtime (this repo installs none of them). They play no part in the
 * `agent/created` hook under test, so stand-ins let the real `apply` run and the
 * real hook fire. The hook itself, `installGate` and `isDelegatedChild` are the
 * production code; only the outer framework objects are fake.
 */
const dataUrl = (source) => 'data:text/javascript,' + encodeURIComponent(source)

const STUBS = {
  '@deepseek-ai/schemastery': `
    function chain() {
      // The shape is recorded rather than enforced: no host package is installed, so the
      // tests can only read what the plugin declared (default, bounds, volatility).
      const node = { defaultValue: undefined, minValue: undefined, maxValue: undefined, volatileFlag: false }
      node.default = (value) => {
        node.defaultValue = value
        return node
      }
      node.volatile = () => {
        node.volatileFlag = true
        return node
      }
      node.min = (value) => {
        node.minValue = value
        return node
      }
      node.max = (value) => {
        node.maxValue = value
        return node
      }
      node.step = () => node
      node.description = () => node
      node.describe = () => node
      return node
    }
    const z = {
      boolean: () => chain(),
      string: () => chain(),
      number: () => chain(),
      array: (item) => Object.assign(chain(), { item }),
      object: (shape) => Object.assign(chain(), { shape }),
    }
    export default z
  `,
  '@deepseek-ai/dsh-tools': `
    export function defineTool(spec) { return spec }
  `,
  zod: `
    const chain = () => {
      const node = {}
      node.default = () => chain()
      node.min = () => node
      node.max = () => node
      node.int = () => node
      node.nonnegative = () => node
      node.strict = () => node
      node.optional = () => node
      return node
    }
    const z = {
      object: () => chain(),
      enum: () => ({}),
      boolean: () => ({}),
      string: () => chain(),
      number: () => chain(),
      array: () => chain(),
    }
    export { z }
    export default z
  `,
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = STUBS[specifier]
    if (stub !== undefined) return { url: dataUrl(stub), shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

const mod = await import(new URL('../lib/index.js', import.meta.url).href)

/**
 * Every tool a host could register: the file/search/shell/web tools a main agent must not
 * touch, the native delegation tools, an MCP tool, and the `run_code` transport. The gate
 * hides all of them except the ones the whitelist names (and never `run_code`, which
 * `tools.restrict` refuses).
 */
const HOST_TOOLS = [
  'apply_patch',
  'bash',
  'create_goal',
  'decompress',
  'edit',
  'glob',
  'grep',
  'list_agents',
  'mcp__demo__ping',
  'ops_bash',
  'ops_read_files',
  'pwsh',
  'ralph',
  'read',
  'read_image',
  'run_code',
  'schedule_create',
  'search_context',
  'subagent',
  'update_goal',
  'web_fetch',
  'web_search',
  'workflow',
  ...mod.DEFAULT_ALLOWED_TOOLS,
]

/** What a whitelist hides out of `HOST_TOOLS`: everything it does not name, transport aside. */
function hiddenOf(allowed) {
  return HOST_TOOLS.filter((name) => name !== 'run_code' && !allowed.includes(name))
}

/** A minimal ctx: only the members `apply` touches, each recording what it got.
 *  `enabled` and the live `allowedTools` are mutable so a test can flip the switch or the
 *  whitelist after installation, the way a panel write does.
 */
function fakeCtx({
  enabled = true,
  allowed,
  agents,
  sessions,
  stateOf,
  catalogNames = HOST_TOOLS,
  memoryEnabled = false,
  panelEnabled = false,
  masterEnabled = false,
  secretaryEnabled = false,
  secretaryOrchestrators = [],
  storageDomain,
} = {}) {
  const state = { enabled, allowed, memoryEnabled, panelEnabled, masterEnabled, secretaryEnabled, secretaryOrchestrators }
  const projections = []
  const tools = []
  const handlers = new Map()
  // The options each subscription was made with: a lifecycle edge of a child is dispatched
  // with the child's parent as carrier, so the retry listener has to be registered global.
  const handlerOptions = new Map()
  const effects = []
  const sections = []
  const logs = { info: [], warn: [] }
  const emitted = []
  // The live tool catalog the plugin publishes, as a writable volatile reference.
  let catalog = []
  const catalogRef = {
    get: () => catalog,
    [Symbol.for('cosmokit.volatile.write')]: (next) => {
      catalog = next
    },
  }
  // The provided services, keyed by service name. `provide` is what the real
  // ctx exposes; the master panel endpoint is registered through it.
  const services = new Map()
  // The paths every optional host service is resolved through in production:
  // optionalService() tries ctx.get(name) before the direct property.
  const getCalls = []
  const ctx = {
    sessionProjections: {
      // A real registration is a thenable that resolves to a handle; the master
      // panel endpoint awaits exactly that handle and calls stateOf on it.
      register: (projection) => {
        projections.push(projection)
        const handle = { stateOf: (session) => stateOf?.(session) }
        const ready = Promise.resolve(handle)
        return Object.assign(() => {}, {
          then: (onFulfilled, onRejected) => ready.then(onFulfilled, onRejected),
          catch: (onRejected) => ready.catch(onRejected),
          finally: (onFinally) => ready.finally(onFinally),
          stateOf: handle.stateOf,
        })
      },
      stateOf,
    },
    provide(name, value) {
      services.set(name, value)
      return () => services.delete(name)
    },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
      // The context-global view the catalog reads: names plus an empty visible map.
      view: () => ({ knownNames: new Set(catalogNames), visible: new Map() }),
    },
    get(name) {
      getCalls.push(name)
      return name in ctx ? ctx[name] : undefined
    },
    subagents: {},
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
    storageDomain,
    agents: agents ?? { get: () => undefined },
    sessions: sessions ?? { get: () => undefined, list: () => [], flush: async () => true },
    effect(fn, label) {
      const dispose = fn()
      effects.push({ label, dispose })
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    on(event, handler, options) {
      handlers.set(event, handler)
      handlerOptions.set(event, options)
    },
    logger: {
      info: (message) => logs.info.push(message),
      warn: (message) => logs.warn.push(message),
    },
    emit: (event, ...args) => emitted.push([event, ...args]),
  }
  const config = {
    enabled: { get: () => state.enabled },
    allowedTools: { get: () => state.allowed },
    workerProvider: { get: () => '' },
    workerModel: { get: () => '' },
    workerReasoningEffort: { get: () => '' },
    superviseEnabled: { get: () => true },
    superviseIntervalSeconds: { get: () => 600 },
    superviseMaxNoticesPerChild: { get: () => 3 },
    superviseNotifyOnNoProgress: { get: () => false },
    masterMemoryEnabled: { get: () => state.memoryEnabled },
    masterPanelEnabled: { get: () => state.panelEnabled },
    masterSessionEnabled: { get: () => state.masterEnabled },
    secretaryEnabled: { get: () => state.secretaryEnabled },
    secretaryMasterSessionId: { get: () => 'master-1' },
    secretaryOrchestrators: { get: () => state.secretaryOrchestrators },
    toolCatalog: catalogRef,
  }
  return {
    ctx,
    config,
    state,
    projections,
    tools,
    handlers,
    handlerOptions,
    effects,
    sections,
    storageDomain,
    services,
    getCalls,
    logs,
    emitted,
    catalogNames,
    catalog: () => catalog,
    // The Loader commits a volatile field from the profile's raw value on every settings
    // write, which for an unset key means the empty array. Tests replay that.
    resetCatalog: () => {
      catalog = []
    },
  }
}

/** A stand-in agent with its own tool registry, so gate side effects are observable. */
function fakeAgent({ id = 'agent-1', depth, header = {}, hidden = [] } = {}) {
  const restricted = []
  const guards = []
  const registered = []
  // 当前生效的遮罩（安装时加入、disposer 执行时移除）：restricted 是历史，判断"现在被藏
  // 起来了什么"必须看这一个，否则取消再认领之后历史里的 read 会一直留在数组里。
  const masked = new Set()
  const agent = {
    id,
    options: { provider: 'p', model: 'm', ...(depth === undefined ? {} : { subagentDepth: depth }) },
    session: { header },
    ctx: {
      tools: {
        restrict({ deny }) {
          restricted.push(deny[0])
          masked.add(deny[0])
          return () => masked.delete(deny[0])
        },
        guard(fn) {
          guards.push(fn)
        },
        register(tool) {
          registered.push(tool)
          return () => {}
        },
        // The per-scope view: a hidden name is what a preset tool filter would return.
        get(name) {
          return hidden.includes(name) ? undefined : {}
        },
      },
    },
  }
  return { agent, restricted, guards, registered, masked: () => [...masked] }
}

/** Start the plugin and hand back its `agent/created` handler. */
function start(options) {
  const harness = fakeCtx(options)
  mod.apply(harness.ctx, harness.config)
  const created = harness.handlers.get('agent/created')
  assert.equal(typeof created, 'function', 'apply must subscribe to agent/created')
  return { ...harness, created }
}

/**
 * Unload the plugin the way cordis does it (fiber.d.ts): every disposer runs in
 * reverse registration order, and the unload waits for each one.
 */
async function unload(harness) {
  for (const entry of [...harness.effects].reverse()) {
    if (typeof entry.dispose === 'function') await entry.dispose()
  }
}

test('a child with a persisted delegation depth is never gated', () => {
  // Regression: a cold-resumed child was gated as a main agent, losing every working
  // tool and keeping only the dispatch entry. Its depth lives in the session header.
  for (const { agent, restricted, guards } of [
    fakeAgent({ header: { delegationDepth: 1 } }),
    fakeAgent({ header: {} , depth: 1 }),
  ]) {
    const { created } = start()
    created({ agent, source: 'resume' })
    assert.deepEqual(restricted, [], 'restrict must not run for a child')
    assert.equal(guards.length, 0, 'no guard may be registered for a child')
  }
})

test('a delegated child gets a short role-neutral description, never the main-agent rule', () => {
  // Workers inherit the global table, so without a scoped shadow they would read the
  // main-agent rule and could take it as a ban on their own tools.
  const { created } = start()
  const { agent, registered } = fakeAgent({ header: { delegationDepth: 1 } })
  created({ agent, source: 'resume' })
  assert.deepEqual(registered.map((tool) => tool.name).sort(), ['dispatch'])
  for (const tool of registered) {
    assert.equal(/main[- ]agent/i.test(tool.description), false, tool.name)
    assert.equal(tool.description.includes('Main-agent rule:'), false, tool.name)
    assert.equal(tool.description.includes('runs ONLY in a worker'), false, tool.name)
    assert.equal(tool.description.includes(mod.DEFAULT_ALLOWED_TOOLS[0]), false, tool.name)
    assert.ok(tool.description.length < 400, tool.name)
  }
})

test('a child a preset hid delegation from gets no shadow that would defeat the filter', () => {
  const { created } = start()
  const { agent, registered } = fakeAgent({ header: { delegationDepth: 1 }, hidden: ['dispatch'] })
  created({ agent, source: 'resume' })
  assert.deepEqual(registered.map((tool) => tool.name), [])
})

test('a main agent gets the full rule and no scoped shadows', () => {
  const { created, tools } = start()
  const { agent, registered } = fakeAgent()
  created({ agent, source: 'create' })
  assert.deepEqual(registered, [], 'the global pair is enough for a main agent')
  const dispatch = tools.find((tool) => tool.name === 'dispatch')
  assert.match(dispatch.description, /Main-agent rule: the main agent plans only/)
})

test('a panel refresh still re-masks main agents and leaves a child shadow in place', () => {
  const main = maskAgent()
  const child = maskAgent({ id: 'child-1', depth: 1 })
  const childShadows = []
  child.agent.ctx.tools.register = (tool) => {
    childShadows.push(tool.name)
    return () => {}
  }
  const roots = () => [main.agent, child.agent]
  const { handlers, created, state } = start({ agents: { get: () => undefined, roots } })
  created({ agent: main.agent, source: 'create' })
  created({ agent: child.agent, source: 'startup' })
  assert.deepEqual(childShadows, ['dispatch'])
  state.allowed = [...mod.DEFAULT_ALLOWED_TOOLS, 'read']
  handlers.get('loader/volatile-update')()
  assert.equal(main.mask.has('read'), false, 'the main mask follows the panel write')
  assert.deepEqual(childShadows, ['dispatch'], 'a refresh must not register anything else')
})

test('a main agent is masked and guarded, and only the shipped whitelist passes', () => {
  const { created } = start()
  const { agent, restricted, guards } = fakeAgent()
  created({ agent, source: 'create' })
  // Whitelist-driven: every catalog name the shipped list does not cover is hidden, and
  // `run_code` is never among them because `tools.restrict` refuses to hide the transport.
  assert.deepEqual(restricted, hiddenOf(mod.DEFAULT_ALLOWED_TOOLS))
  assert.equal(restricted.includes('run_code'), false)
  assert.equal(guards.length, 1)
  for (const name of mod.DEFAULT_ALLOWED_TOOLS) assert.equal(guards[0]({ name }), undefined, name)
  assert.match(guards[0]({ name: 'edit' }), /"edit" is not available to the main agent/)
  assert.match(guards[0]({ name: 'subagent' }), /"subagent" is not available to the main agent/)
})

test('the shipped whitelist is eleven planning tools, and every other name is refused', () => {
  // The main agent keeps the one delegation entry, the session read-only tools and
  // `compress`: the capabilities that make planning and review possible without touching
  // the repo.
  const shipped = mod.DEFAULT_ALLOWED_TOOLS
  assert.equal(shipped.length, 11)
  for (const name of [
    'dispatch',
    'send_message',
    'interrupt_agent',
    'todo_write',
    'ask_user_question',
    'compress',
    'session_search',
    'session_trace',
    'session_event_search',
    'session_event_read',
    'session_event_trace',
  ]) {
    assert.equal(shipped.includes(name), true, name)
    assert.equal(allowGuard(shipped)({ name }), undefined, name)
  }
  for (const name of [
    'read',
    'edit',
    'write',
    'apply_patch',
    'grep',
    'glob',
    'bash',
    'pwsh',
    'ops_bash',
    'web_fetch',
    'web_search',
    'subagent',
    'workflow',
    'ralph',
    'decompress',
    'search_context',
    'acp_status',
    'mcp_custom_tool',
  ]) {
    assert.equal(shipped.includes(name), false, name)
    assert.match(allowGuard(shipped)({ name }), /is not available to the main agent/, name)
  }

  const { created } = start()
  const { agent, restricted, guards } = fakeAgent()
  created({ agent, source: 'create' })
  assert.equal(restricted.includes('compress'), false, 'compress is whitelisted, so not hidden')
  assert.equal(guards[0]({ name: 'compress' }), undefined, 'compress must pass the guard')
  for (const name of ['ops_bash', 'read', 'decompress']) {
    assert.match(guards[0]({ name }), /is not available to the main agent/, name)
  }
  assert.equal(guards[0]({ name: 'dispatch' }), undefined)
})

test('a resumed agent with a parentSession but no depth is gated and warns', () => {
  const { created, logs } = start()
  const { agent, restricted, guards } = fakeAgent({ id: 'cold-child', header: { parentSession: 'root-session' } })
  created({ agent, source: 'resume' })
  assert.deepEqual(restricted, hiddenOf(mod.DEFAULT_ALLOWED_TOOLS))
  assert.equal(guards.length, 1)
  assert.equal(logs.warn.length, 1)
  assert.match(logs.warn[0], /cold-child/)
  assert.match(logs.warn[0], /parentSession but no delegation depth/)
  // The warning must not leak the conversation itself.
  assert.equal(logs.warn[0].includes('root-session'), false)
})

test('the warning fires only for a resume that fell through the depth test', () => {
  // A normal creation is not a resume, and a resumed child does have a depth.
  const fresh = start()
  fresh.created({ agent: fakeAgent({ header: { parentSession: 'root' } }).agent, source: 'create' })
  assert.equal(fresh.logs.warn.length, 0)

  const resumedChild = start()
  resumedChild.created({ agent: fakeAgent({ header: { parentSession: 'root', delegationDepth: 1 } }).agent, source: 'resume' })
  assert.equal(resumedChild.logs.warn.length, 0)
})

test('the switch being off still installs the guard and stays quiet', () => {
  // The gate is installed even while dispatch mode is off, so flipping the switch on
  // in an open conversation takes effect without a restart; the info log follows the switch.
  const { created, logs } = start({ enabled: false })
  const { agent, restricted, guards } = fakeAgent()
  created({ agent, source: 'create' })
  assert.deepEqual(restricted, [])
  assert.equal(guards.length, 1)
  assert.equal(logs.info.length, 0)
  assert.equal(logs.warn.length, 0)
})

test('a whitelist written in the panel reaches an open conversation, live', () => {
  // The whitelist is read per call, so a panel write lands in a conversation that was
  // already open: checking `read` lets it through at once, unchecking `dispatch` blocks it.
  const { created, state } = start()
  const { agent, guards } = fakeAgent()
  created({ agent, source: 'create' })
  assert.match(guards[0]({ name: 'read' }), /not available to the main agent/)
  assert.equal(guards[0]({ name: 'dispatch' }), undefined)

  state.allowed = [...mod.DEFAULT_ALLOWED_TOOLS, 'read']
  assert.equal(guards[0]({ name: 'read' }), undefined)

  state.allowed = mod.DEFAULT_ALLOWED_TOOLS.filter((name) => name !== 'dispatch')
  assert.match(guards[0]({ name: 'dispatch' }), /"dispatch" is not available to the main agent/)
  assert.equal(guards[0]({ name: 'compress' }), undefined)

  // Unchecking every box disables every tool: an empty whitelist is not "use the default".
  state.allowed = []
  for (const name of ['dispatch', 'send_message', 'compress', 'read']) {
    assert.match(guards[0]({ name }), /is not available to the main agent/, name)
  }
})

test('the whitelist clause follows the live config without re-registering', () => {
  // The description is a getter, so the same registered tool renders the new list: a
  // settings change reaches the prompt without a restart or a new session.
  const { tools, state } = start()
  const dispatch = tools.find((tool) => tool.name === 'dispatch')
  const allowedOf = (tool) =>
    /Allowed for the main agent \(whitelist-driven; every other tool is blocked\): ([^.]+)\./.exec(tool.description)?.[1]
  assert.equal(allowedOf(dispatch), mod.DEFAULT_ALLOWED_TOOLS.join(', '))

  state.allowed = ['dispatch', 'read']
  assert.equal(allowedOf(dispatch), 'dispatch, read')

  // The rule has a second sentence for the case where the panel unchecks everything.
  state.allowed = []
  assert.match(dispatch.description, /No tools are currently allowed for the main agent\./)
  assert.equal(allowedOf(dispatch), undefined)
})

/** Only the members supervision adapters use, with recording friendly defaults. */
function fakeSupervisionHost({ parents = new Map(), sessions = new Map(), stateOf, flush } = {}) {
  const logs = []
  const ctx = {
    agents: { get: (id) => parents.get(id) },
    sessions: {
      get: (id) => sessions.get(id),
      flush: flush ?? (async () => true),
    },
    sessionProjections: { stateOf },
    logger: { warn: (message) => logs.push(message) },
  }
  return { ctx, logs, parents, sessions }
}

test('apply installs a 5000 ms supervision timer and clears it when the effect unloads', () => {
  const timers = []
  const cleared = []
  const realSet = globalThis.setInterval
  const realClear = globalThis.clearInterval
  globalThis.setInterval = (fn, ms) => {
    const handle = { fn, ms, unref() {} }
    timers.push(handle)
    return handle
  }
  globalThis.clearInterval = (handle) => cleared.push(handle)
  try {
    const harness = start()
    // The scan period is fixed: a tick only compares clocks unless a child is due.
    assert.equal(timers.length, 1)
    assert.equal(timers[0].ms, 5000)
    const timerEffect = harness.effects.find(({ label }) => label === 'orchestrator: supervision timer')
    assert.ok(timerEffect, 'the timer must be owned by an effect')
    timerEffect.dispose()
    assert.deepEqual(cleared, [timers[0]])
  } finally {
    globalThis.setInterval = realSet
    globalThis.clearInterval = realClear
  }
})

test('onStarted tracks the child and forgets it once the receipt settles', async () => {
  const tracked = []
  const forgotten = []
  const hooks = mod.createSupervisionHooks({
    track: (entry) => tracked.push(entry),
    forget: (childId) => forgotten.push(childId),
  })

  const result = Promise.resolve('done')
  hooks.onStarted({ id: 'parent-1' }, { childId: 'child-1', result }, { description: '慢活' })
  assert.equal(tracked.length, 1)
  assert.equal(tracked[0].childId, 'child-1')
  assert.equal(tracked[0].parentId, 'parent-1')
  assert.equal(tracked[0].label, '慢活')
  assert.ok(tracked[0].startedAt > 0)
  await result
  await Promise.resolve()
  assert.deepEqual(forgotten, ['child-1'])

  // A rejected receipt is handled silently, never as an unhandled rejection.
  const failed = Promise.reject(new Error('boom'))
  hooks.onStarted({ id: 'parent-1' }, { childId: 'child-2', result: failed }, { description: '失败' })
  await failed.catch(() => {})
  await Promise.resolve()
  assert.deepEqual(forgotten, ['child-1', 'child-2'])
})

/** The supervisor surface the hooks touch, with real add/remove semantics. */
function recordingSupervisor() {
  const entries = new Map()
  const tracked = []
  return {
    entries,
    tracked,
    track: (entry) => {
      tracked.push(entry)
      entries.set(entry.childId, entry)
    },
    forget: (childId) => entries.delete(childId),
    has: (childId) => entries.has(childId),
  }
}

test('a cold-resumed worker is tracked again with the log head as its baseline', async () => {
  // Regression: interrupt settles the receipt, the receipt forgets the child, and the
  // send_message cold resume created it again without registering it — supervision was
  // silently lost for the rest of that worker's life.
  const registry = recordingSupervisor()
  const hooks = mod.createSupervisionHooks(registry, { headSeq: (childId) => (childId === 'child-1' ? 42 : 0) })
  let settle
  const result = new Promise((resolve) => {
    settle = resolve
  })
  hooks.onStarted({ id: 'parent-1' }, { childId: 'child-1', result }, { description: '慢活' })
  assert.equal(registry.entries.size, 1)

  settle('done')
  await result
  await Promise.resolve()
  assert.equal(registry.entries.size, 0, 'the settled receipt releases the child')

  hooks.onResumed({ id: 'child-1', session: { header: { parentSession: 'parent-1', delegationDepth: 1 } } })
  const entry = registry.entries.get('child-1')
  assert.ok(entry, 'the resumed worker must be supervised again')
  assert.equal(entry.parentId, 'parent-1', 'the dispatch record names the real parent')
  assert.equal(entry.label, '慢活', 'the task description survives the interrupt')
  assert.equal(entry.resumed, true)
  assert.equal(entry.sinceSeq, 42, 'pre-interrupt history is not reported as new')
  assert.ok(entry.startedAt > 0)
})

test('a resumed agent this plugin never dispatched stays unsupervised', () => {
  const registry = recordingSupervisor()
  const hooks = mod.createSupervisionHooks(registry, { headSeq: () => 7 })
  // The host's own subagent tool also creates delegated children; they never entered
  // supervision, so a resume of one must not start a notice timer on it.
  hooks.onResumed({ id: 'host-child', session: { header: { parentSession: 'parent-1', delegationDepth: 1 } } })
  assert.equal(registry.entries.size, 0)
  assert.equal(registry.tracked.length, 0)
})

test('a repeated resume event does not restart the clock', () => {
  const registry = recordingSupervisor()
  const hooks = mod.createSupervisionHooks(registry, { headSeq: () => 5 })
  hooks.onStarted({ id: 'p' }, { childId: 'c', result: null }, { description: 'job' })
  registry.forget('c')
  hooks.onResumed({ id: 'c' })
  const first = registry.entries.get('c')
  const count = registry.tracked.length

  hooks.onResumed({ id: 'c' })
  assert.equal(registry.tracked.length, count, 'no second registration')
  assert.equal(registry.entries.get('c'), first, 'the deadline and budget are untouched')
})

test('an unreadable log head falls back to the zero baseline and still tracks', () => {
  const registry = recordingSupervisor()
  const hooks = mod.createSupervisionHooks(registry, {
    headSeq: () => {
      throw new Error('session log unavailable')
    },
  })
  hooks.onStarted({ id: 'p' }, { childId: 'c', result: null }, { description: 'job' })
  registry.forget('c')
  assert.doesNotThrow(() => hooks.onResumed({ id: 'c' }))
  assert.equal(registry.entries.get('c').sinceSeq, 0)
})

test('the dispatch memory is bounded, so a very old worker is not re-armed', async () => {
  const registry = recordingSupervisor()
  const hooks = mod.createSupervisionHooks(registry, { headSeq: () => 0 })
  const total = 129
  for (let index = 0; index < total; index += 1) {
    hooks.onStarted({ id: 'p' }, { childId: `child-${index}`, result: null }, { description: 'job' })
  }
  // Every registration is released, as a batch of finished receipts would leave them.
  registry.entries.clear()
  // The oldest dispatch record is evicted; the newest is still remembered.
  hooks.onResumed({ id: 'child-0' })
  assert.equal(registry.entries.has('child-0'), false)
  hooks.onResumed({ id: `child-${total - 1}` })
  assert.equal(registry.entries.has(`child-${total - 1}`), true)
})

test('headSeq reads the highest seq in the child log, and 0 when it cannot', () => {
  const parent = { id: 'p', session: { id: 's' } }
  const child = { id: 'c', log: [{ seq: 3, type: 'x' }, { seq: 9, type: 'y' }, { type: 'no-seq' }] }
  const host = fakeSupervisionHost({
    parents: new Map([['p', parent]]),
    sessions: new Map([['c', child]]),
  })
  const supervision = mod.createSupervision({ ctx: host.ctx, config: {} })
  assert.equal(supervision.headSeq('c'), 9)
  // The baseline is a cold-resume detail; an unreadable log must never throw into the hook.
  assert.equal(supervision.headSeq('gone'), 0)
  assert.doesNotThrow(() => supervision.headSeq(undefined))
})

test('hasPendingNotice recognises its own source and tolerates a broken projection', () => {
  const parent = { id: 'p', session: { id: 's' } }
  const broken = fakeSupervisionHost({ parents: new Map([['p', parent]]) })
  const first = mod.createSupervision({ ctx: broken.ctx, config: {} })
  // The inbox state shape is not a public API: a failure is false, not a throw.
  assert.equal(first.hasPendingNotice('p'), false)
  assert.equal(first.hasPendingNotice('p'), false)
  assert.equal(broken.logs.filter((message) => /cannot read the parent inbox/.test(message)).length, 1)

  const good = fakeSupervisionHost({
    parents: new Map([['p', parent]]),
    stateOf: () => ({ 'next-turn': [{ source: { kind: mod.SUPERVISE_SOURCE_KIND } }], 'next-step': [] }),
  })
  const second = mod.createSupervision({ ctx: good.ctx, config: {} })
  assert.equal(second.hasPendingNotice('p'), true)

  const unrelated = fakeSupervisionHost({
    parents: new Map([['p', parent]]),
    stateOf: () => ({ 'next-turn': [{ source: { kind: 'schedule' } }], 'next-step': [] }),
  })
  assert.equal(mod.createSupervision({ ctx: unrelated.ctx, config: {} }).hasPendingNotice('p'), false)
})

test('deliver refuses an unknown parent and degrades safely when the llm import fails', async () => {
  const unknown = fakeSupervisionHost()
  const missing = mod.createSupervision({ ctx: unknown.ctx, config: {} })
  assert.equal(await missing.deliver('gone', 'text', ['child']), 'parent-gone')

  const parent = { id: 'p', session: {}, followup() {} }
  const host = fakeSupervisionHost({ parents: new Map([['p', parent]]) })
  let loads = 0
  const broken = mod.createSupervision({
    ctx: host.ctx,
    config: {},
    loadLlm: async () => {
      loads += 1
      throw new Error('package unavailable')
    },
  })
  // A missing host package must not throw, must not be retried every tick, and must
  // not consume the child's notice budget (the supervisor warns and reschedules).
  assert.equal(await broken.deliver('p', 'text', ['child']), 'unavailable')
  assert.equal(await broken.deliver('p', 'text', ['child']), 'unavailable')
  assert.equal(loads, 1)
  assert.equal(host.logs.filter((message) => /cannot load @deepseek-ai\/dsh-llm/.test(message)).length, 1)
})

test('deliver queues exactly one notice with followup, never steer', async () => {
  const calls = { followup: [], steer: 0, flush: [] }
  const parent = {
    id: 'p',
    session: { id: 'parent-session' },
    followup: (message) => calls.followup.push(message),
    steer: () => {
      calls.steer += 1
    },
  }
  const host = fakeSupervisionHost({
    parents: new Map([['p', parent]]),
    flush: async (session) => {
      calls.flush.push(session)
      return true
    },
  })
  const { deliver } = mod.createSupervision({
    ctx: host.ctx,
    config: {},
    loadLlm: async () => ({ createUserMessage: (input) => input }),
  })
  assert.equal(await deliver('p', '巡检正文', ['child-1', 'child-2']), 'queued')
  assert.equal(calls.followup.length, 1)
  assert.equal(calls.steer, 0)
  assert.equal(calls.followup[0].content[0].text, '巡检正文')
  assert.deepEqual(calls.followup[0].source, {
    kind: mod.SUPERVISE_SOURCE_KIND,
    form: 'notice',
    summary: '巡检正文',
    senderSessionId: 'child-1',
  })
  assert.equal(calls.flush.length, 1)
})

/**
 * An agent whose deny mask is a real set with real disposers. `lifts` counts released
 * handles, so a refresh that leaks (or double-disposes) one is visible here.
 */
function maskAgent({ id = 'agent-1', globals = HOST_TOOLS, depth, header = {} } = {}) {
  const mask = new Set()
  const counts = { restrict: 0, lift: 0 }
  let guard
  return {
    mask,
    counts,
    getGuard: () => guard,
    agent: {
      id,
      options: { provider: 'p', model: 'm', ...(depth === undefined ? {} : { subagentDepth: depth }) },
      session: { header },
      ctx: {
        tools: {
          restrict({ deny }) {
            const [tool] = deny
            if (!globals.includes(tool)) throw new Error('tools.restrict() names unknown global tool "' + tool + '"')
            counts.restrict += 1
            mask.add(tool)
            let live = true
            return () => {
              if (!live) throw new Error('a restriction was disposed twice')
              live = false
              counts.lift += 1
              mask.delete(tool)
            }
          },
          guard(fn) {
            guard = fn
          },
        },
      },
    },
  }
}

test('a panel write re-applies the mask on every live main agent, in the open session', () => {
  const main = maskAgent()
  const child = maskAgent({ id: 'child-1', depth: 1 })
  const { handlers, created, state } = start({ agents: { get: () => undefined, roots: () => [main.agent, child.agent] } })
  created({ agent: main.agent, source: 'create' })
  assert.equal(main.mask.has('read'), true)
  assert.equal(child.mask.size, 0, 'a child is never gated')

  // The panel checks `read`: allowedTools gains it, then the loader announces the write.
  state.allowed = [...mod.DEFAULT_ALLOWED_TOOLS, 'read']
  const volatile = handlers.get('loader/volatile-update')
  assert.equal(typeof volatile, 'function', 'apply must subscribe to loader/volatile-update')
  volatile()
  assert.equal(main.mask.has('read'), false, 'the next request sees the table without read')
  assert.equal(main.mask.has('ops_bash'), true, 'every other name stays hidden')
  assert.equal(child.mask.size, 0, 'a refresh must not touch a child')

  // Unchecking it again hides it again.
  state.allowed = mod.DEFAULT_ALLOWED_TOOLS
  volatile()
  assert.equal(main.mask.has('read'), true)
})

test('the enable switch flips every restriction in the open session through the same event', () => {
  const main = maskAgent()
  const { handlers, created, state } = start({ agents: { get: () => undefined, roots: () => [main.agent] } })
  created({ agent: main.agent, source: 'create' })
  const volatile = handlers.get('loader/volatile-update')
  assert.equal(main.mask.size, hiddenOf(mod.DEFAULT_ALLOWED_TOOLS).length)

  state.enabled = false
  volatile()
  assert.equal(main.mask.size, 0, 'off lifts every restriction')
  assert.equal(main.getGuard()({ name: 'edit' }), undefined, 'and lets every call through')

  state.enabled = true
  volatile()
  assert.equal(main.mask.size, hiddenOf(mod.DEFAULT_ALLOWED_TOOLS).length, 'on restores the table')
  assert.match(main.getGuard()({ name: 'edit' }), /not available to the main agent/)
})

test('a disposed agent releases its mask and is not refreshed afterwards', () => {
  const main = maskAgent()
  const roots = [main.agent]
  const { handlers, created, state } = start({ agents: { get: () => undefined, roots: () => roots } })
  created({ agent: main.agent, source: 'create' })
  const volatile = handlers.get('loader/volatile-update')
  const disposed = handlers.get('agent/disposed')
  assert.equal(typeof disposed, 'function', 'apply must subscribe to agent/disposed')

  disposed({ agent: main.agent })
  assert.equal(main.mask.size, 0, 'the mask is lifted when the agent goes away')
  assert.equal(main.counts.lift, hiddenOf(mod.DEFAULT_ALLOWED_TOOLS).length)

  // A later write with the agent gone has nothing to reinstall.
  roots.length = 0
  state.allowed = [...mod.DEFAULT_ALLOWED_TOOLS, 'read']
  volatile()
  assert.equal(main.mask.size, 0)
})

test('an agent created before the plugin mounted is gated on the first panel write', () => {
  // The registry is the source of truth, so a missed creation hook self-heals.
  const main = maskAgent({ id: 'pre-existing' })
  const { handlers, state } = start({ agents: { get: () => undefined, roots: () => [main.agent] } })
  const volatile = handlers.get('loader/volatile-update')
  assert.equal(main.mask.size, 0)
  state.allowed = [...mod.DEFAULT_ALLOWED_TOOLS, 'read']
  volatile()
  assert.equal(main.mask.has('edit'), true)
  assert.equal(main.mask.has('read'), false)
})

test('a refresh without agents.roots, or a broken registry, is not fatal', () => {
  const { handlers } = start()
  const volatile = handlers.get('loader/volatile-update')
  assert.doesNotThrow(() => volatile())

  const broken = start({ agents: { get: () => undefined, roots: () => { throw new Error('registry gone') } } })
  assert.doesNotThrow(() => broken.handlers.get('loader/volatile-update')())
  assert.match(broken.logs.warn.join('\n'), /cannot enumerate live agents/)
})

// ---- Automatic retry of a child that died without a closing message ---------------------

test('onStarted hands the dispatched child to the retry policy, and only for a real dispatch', () => {
  const tracked = []
  const retry = {
    track: (childId, record) => {
      tracked.push({ childId, ...record })
      return true
    },
  }
  const hooks = mod.createSupervisionHooks({ track() {}, forget() {} }, { retry })
  const result = Promise.resolve('done')
  hooks.onStarted({ id: 'parent-1' }, { childId: 'child-1', result }, { description: '慢活' })
  assert.deepEqual(tracked, [{ childId: 'child-1', parentId: 'parent-1', label: '慢活' }])
  // An event without the two ids is not a dispatch: nothing can be retried later.
  hooks.onStarted({}, { childId: 'child-2', result })
  hooks.onStarted({ id: 'parent-1' }, { result })
  assert.equal(tracked.length, 1)
})

test('a retry bookkeeping failure never breaks the dispatch', () => {
  const tracked = []
  const hooks = mod.createSupervisionHooks(
    { track: (entry) => tracked.push(entry), forget() {} },
    {
      retry: {
        track: () => {
          throw new Error('the policy is broken')
        },
      },
    },
  )
  assert.doesNotThrow(() => hooks.onStarted({ id: 'parent-1' }, { childId: 'child-1' }, {}))
  assert.equal(tracked.length, 1)
})

test('apply listens for the settlement edge globally, so a child-scoped emission reaches it', () => {
  const harness = start()
  const listener = harness.handlers.get('subagent/end')
  assert.equal(typeof listener, 'function', 'apply must subscribe to subagent/end')
  // The host dispatches this edge with the child's parent as carrier: a scoped listener is
  // filtered out, so the option is what makes the retry possible at all.
  assert.deepEqual(harness.handlerOptions.get('subagent/end'), { global: true })
  // A malformed event is ignored rather than thrown into the emitter.
  assert.doesNotThrow(() => listener(undefined))
  assert.doesNotThrow(() => listener({ id: '' }))
})

test('the retry prompt goes through the host protocol entry, as a queued turn of the child', async () => {
  const calls = []
  const parent = { id: 'parent-1' }
  const deliverPrompt = mod.deliverRetryPrompt
  const host = {
    agents: { get: (id) => (id === 'parent-1' ? parent : undefined) },
    subagents: {
      [Symbol.for('dsh.subagent.deliverPrompt')]: async (...args) => {
        calls.push(args)
        return true
      },
    },
  }
  assert.equal(await deliverPrompt(host, 'parent-1', 'child-1', '继续'), true)
  assert.equal(calls.length, 1)
  const [sender, childId, content, source, signal, delivery] = calls[0]
  assert.equal(sender, parent, 'the live parent is the sender the host requires')
  assert.equal(childId, 'child-1')
  assert.deepEqual(content, [{ type: 'text', text: '继续' }])
  assert.deepEqual(source, { kind: 'orchestrator-retry', form: 'notice', summary: '继续' })
  assert.equal(delivery, 'queue', 'a retry is a new turn, not a steer into a dead one')
  assert.equal(typeof signal?.aborted, 'boolean')
})

test('the retry prompt refuses a host without the entry, and a parent that is gone', async () => {
  const parent = { id: 'parent-1' }
  await assert.rejects(
    mod.deliverRetryPrompt({ agents: { get: () => parent }, subagents: {} }, 'parent-1', 'child-1', '继续'),
    /does not expose dsh\.subagent\.deliverPrompt/,
  )
  const withEntry = {
    agents: { get: () => undefined },
    subagents: { [Symbol.for('dsh.subagent.deliverPrompt')]: async () => true },
  }
  await assert.rejects(mod.deliverRetryPrompt(withEntry, 'parent-1', 'child-1', '继续'), /is not live/)
})

test('the retry notice has its own source kind, so it cannot mask a supervision notice', async () => {
  const queued = []
  const parent = { id: 'p', session: { id: 'parent-session' }, followup: (message) => queued.push(message) }
  const host = fakeSupervisionHost({ parents: new Map([['p', parent]]) })
  const supervision = mod.createSupervision({
    ctx: host.ctx,
    config: {},
    loadLlm: async () => ({ createUserMessage: (input) => input }),
  })
  assert.equal(await supervision.deliverRetry('p', '重试正文', ['child-1']), 'queued')
  assert.equal(queued.length, 1)
  assert.equal(queued[0].content[0].text, '重试正文')
  assert.deepEqual(queued[0].source, {
    kind: 'orchestrator-retry',
    form: 'notice',
    summary: '重试正文',
    senderSessionId: 'child-1',
  })
  // The supervision notice keeps the kind `hasPendingNotice` looks for.
  assert.equal(await supervision.deliver('p', '巡检正文', ['child-1']), 'queued')
  assert.deepEqual(queued[1].source, {
    kind: mod.SUPERVISE_SOURCE_KIND,
    form: 'notice',
    summary: '巡检正文',
    senderSessionId: 'child-1',
  })
})

// ---- Live tool catalog -----------------------------------------------------------------

test('the plugin publishes the tool catalog at start and refreshes it on tools/change', async () => {
  const harness = start({ catalogNames: ['read', 'delegate'] })
  const change = harness.handlers.get('tools/change')
  assert.equal(typeof change, 'function', 'apply must subscribe to tools/change')
  // The first read runs during apply, so a panel opened before any change has a catalog.
  assert.deepEqual(harness.catalog(), ['delegate', 'read'])
  assert.deepEqual(harness.emitted[0], ['settings/document-updated', 'orchestrator', 1])
  assert.equal(harness.logs.warn.length, 0)

  // An unchanged burst publishes nothing: no write, no announcement and no gate refresh.
  change()
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(harness.emitted.length, 1)

  // A plugin registering a tool moves the catalog, with no plugin reload and no restart.
  harness.catalogNames.push('mcp__demo__ping')
  change()
  change()
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.deepEqual(harness.catalog(), ['delegate', 'mcp__demo__ping', 'read'])
  assert.equal(harness.emitted.length, 2)
  assert.deepEqual(harness.emitted[1], ['settings/document-updated', 'orchestrator', 2])
})

test('the write that empties the published catalog repairs it in the same event', () => {
  // A volatile field is re-committed from the profile's raw value on every settings write,
  // so a panel write lands with toolCatalog already empty. The write has announced
  // loader/volatile-update by then, so the repair rides that event: no timer, no polling.
  const harness = start({ catalogNames: ['read', 'delegate'] })
  assert.deepEqual(harness.catalog(), ['delegate', 'read'])

  harness.resetCatalog()
  assert.deepEqual(harness.catalog(), [], 'the loader wiped the field')
  harness.handlers.get('loader/volatile-update')()
  assert.deepEqual(harness.catalog(), ['delegate', 'read'], 'the catalog is back before the write returns')

  // The repair is not a one-off: every write repeats the same commit.
  harness.resetCatalog()
  harness.handlers.get('loader/volatile-update')()
  assert.deepEqual(harness.catalog(), ['delegate', 'read'])
  // And the panel is told to re-read, so its rows do not stay on the empty snapshot.
  assert.deepEqual(harness.emitted.at(-1), ['settings/document-updated', 'orchestrator', 3])
})

test('the published catalog includes tools a scope registers for a root agent', async () => {
  const scoped = {
    id: 'root',
    ctx: { tools: { view: () => ({ knownNames: new Set(['subagent']), visible: new Map() }) } },
  }
  const harness = start({
    catalogNames: ['read'],
    agents: { get: () => undefined, roots: () => [scoped] },
  })
  assert.deepEqual(harness.catalog(), ['read', 'subagent'])
})

// ---- Master memory (ticket 01): opt-in domain plus compact index injection ----

/** A domain handle the plugin can open, backed by a Map so writes are observable. */
function fakeMemoryDomain(seed = []) {
  const rows = new Map(seed)
  const opens = []
  let closes = 0
  const domain = {
    name: 'orchestrator_memory',
    table(name) {
      return {
        tableName: name,
        get: (key) => rows.get(key),
        entries: () => rows.entries(),
        keys: () => rows.keys(),
        get size() {
          return rows.size
        },
        async put(key, value) {
          rows.set(key, value)
        },
        async delete(key) {
          return rows.delete(key)
        },
        async deleteMany(keys) {
          let removed = 0
          for (const key of keys) if (rows.delete(key)) removed += 1
          return removed
        },
      }
    },
    async close() {
      closes += 1
    },
  }
  const storageDomain = {
    opens,
    async open(spec) {
      opens.push(spec)
      return domain
    },
  }
  return { storageDomain, rows, opens, closes: () => closes }
}

const memoryRecord = (id, text, updatedAt = 1) => ({ id, text, tags: [], createdAt: updatedAt, updatedAt })
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test('the master memory switch is off by default: no domain opens and no section is injected', async () => {
  const memory = fakeMemoryDomain()
  const harness = start({ storageDomain: memory.storageDomain })
  await settle()
  assert.equal(memory.opens.length, 0)
  assert.equal(harness.sections.length, 0)

  // A config that lacks the key at all is the same answer: the feature stays off.
  delete harness.config.masterMemoryEnabled
  assert.equal(await mod.attachMasterMemory(harness.ctx, harness.config), undefined)
  await settle()
  assert.equal(memory.opens.length, 0)
  assert.equal(harness.sections.length, 0)
})

test('the master memory switch opens the domain and injects a labelled live index', async () => {
  const memory = fakeMemoryDomain([['mem-1', memoryRecord('mem-1', '用户偏好：worker 用简体中文')]])
  const harness = start({ memoryEnabled: true, storageDomain: memory.storageDomain })
  await settle()

  assert.equal(memory.opens.length, 1)
  assert.equal(memory.opens[0].name, MEMORY_DOMAIN_NAME)
  assert.equal(harness.sections.length, 1)
  const [section] = harness.sections
  assert.equal(section.name, MEMORY_INDEX_SECTION)
  assert.equal(section.order, MEMORY_SECTION_ORDER)
  const text = section.text()
  assert.match(text, /AI 记忆/)
  assert.match(text, /非用户指令/)
  assert.match(text, /worker 用简体中文/)

  // The callback reads the domain at assembly time, not at registration time.
  memory.rows.set('mem-2', memoryRecord('mem-2', '新沉淀的事实', 2))
  assert.match(section.text(), /新沉淀的事实/)

  // Unload closes the domain the plugin opened.
  const owned = harness.effects.find(({ label }) => label === 'orchestrator: master memory domain')
  assert.ok(owned, 'the opened domain is owned by an effect')
  owned.dispose()
  await settle()
  assert.equal(memory.closes(), 1)
})

test('the master status projection is registered host-only and folds a worker row', () => {
  const { projections } = start()
  const master = projections.find((projection) => projection.key === 'orchestrator-master')
  assert.ok(master, 'the master projection must be registered')
  assert.equal(master.wire, undefined, 'a host-only unit declares no client view')
  assert.equal(master.stateVersion, 1)

  const init = master.init({ id: 'w-1', origin: 'subagent', delegationDepth: 1 }, 0)
  assert.deepEqual(init.workers, [{ id: 'w-1', role: 'worker', state: 'Idle', summary: '' }])

  const working = master.apply(init, { type: 'turn/start', data: { turn: 1 } })
  assert.equal(working.workers[0].state, 'Working')

  // An event the unit does not own keeps the reference, so no downstream work runs.
  assert.equal(master.apply(working, { type: 'step/start', data: { turn: 1, step: 1 } }), working)

  const done = master.apply(working, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.deepEqual(done.workers[0], { id: 'w-1', role: 'worker', state: 'Completed', summary: '' })
})

test('the master panel endpoint is provided and folds live sessions behind its switch', async () => {
  const session = { header: { id: 'w-2' } }
  const harness = start({
    panelEnabled: true,
    sessions: { get: () => undefined, list: () => [session], flush: async () => true },
    stateOf: (target) => ({
      workers: [{ id: target.header.id, role: 'worker', state: 'Working', summary: 'panel' }],
    }),
  })
  const service = harness.services.get('orchestratorMaster')
  assert.ok(service, 'the read-only endpoint service is provided')
  assert.equal(typeof service.masterState, 'function')

  const on = await service.masterState()
  assert.equal(on.enabled, true)
  assert.equal(on.byState.Working, 1)
  assert.deepEqual(on.workers, [{ id: 'w-2', role: 'worker', state: 'Working', summary: 'panel' }])

  // The switch is read per call: no reload, and no worker data leave the host.
  harness.state.panelEnabled = false
  const off = await service.masterState()
  assert.equal(off.enabled, false)
  assert.equal(off.byState.Working, 0)
  assert.deepEqual(off.workers, [])
})

test('a host without a usable storage domain degrades explicitly and injects nothing', async () => {
  const missing = start({ memoryEnabled: true })
  await settle()
  assert.equal(missing.sections.length, 0, 'no domain, no injected section')
  assert.match(missing.logs.warn.join('\n'), /storageDomain|storage-domain/)

  const broken = fakeMemoryDomain()
  broken.storageDomain.open = async () => {
    throw new Error('backend-not-found')
  }
  const failed = start({ memoryEnabled: true, storageDomain: broken.storageDomain })
  await settle()
  assert.equal(failed.sections.length, 1, 'the section registration survives, it is empty')
  assert.equal(failed.sections[0].text(), '')
  assert.match(failed.logs.warn.join('\n'), /backend-not-found/)
})

// ---- Persistent master session (ticket 05): opt-in lifecycle ----------------------------

/**
 * A fake `ctx.agents` registry. The plugin only reads `get`, `resume` and `create`,
 * and every call is recorded so the discovery order is inspectable.
 */
function fakeAgentRegistry({ resume, create } = {}) {
  const calls = []
  const live = new Map()
  const remember = (handle) => {
    if (handle?.agent !== undefined) live.set(handle.agent.id, handle.agent)
    return handle
  }
  return {
    calls,
    get: (id) => live.get(id),
    async resume(options) {
      calls.push(['resume', options])
      return remember(await resume(options))
    },
    async create(options) {
      calls.push(['create', options])
      return remember(await create(options))
    },
  }
}

const fakeMasterAgent = (id = MASTER_SESSION_ID) => ({ id, session: { id } })

test('the master session switch is off by default: no session is found, created or owned', async () => {
  const agents = fakeAgentRegistry({
    resume: async () => {
      throw new Error('must not be called while the switch is off')
    },
    create: async () => {
      throw new Error('must not be called while the switch is off')
    },
  })
  const sessions = { get: () => undefined, list: () => [], flush: async () => true }
  const harness = start({ agents, sessions })
  await settle()

  assert.equal(agents.calls.length, 0)
  assert.equal(
    harness.effects.some(({ label }) => label.startsWith('orchestrator: master session')),
    false,
    'an off switch owns nothing',
  )
})

test('the master session switch resumes the fixed root session and owns a flush-then-dispose cleanup', async () => {
  const order = []
  const agent = fakeMasterAgent()
  const agents = fakeAgentRegistry({
    resume: async () => ({ agent, dispose: async () => order.push('dispose') }),
    create: async () => {
      throw new Error('a found session must not be replaced')
    },
  })
  const sessions = {
    get: () => undefined,
    list: () => [],
    async flush(session) {
      order.push('flush')
      assert.equal(session, agent.session)
      return true
    },
  }
  const harness = start({ masterEnabled: true, agents, sessions })
  await settle()

  assert.deepEqual(agents.calls.map(([name]) => name), ['resume'])
  assert.equal(agents.calls[0][1].resumeSessionId, MASTER_SESSION_ID)

  // The found session is checkpointed at start, so its file exists before any turn.
  assert.deepEqual(order, ['flush'])

  assert.ok(harness.getCalls.includes('agents'), 'the registry is read through ctx.get, the production path')
  assert.ok(harness.getCalls.includes('sessions'), 'the session service is read through ctx.get too')

  // The two lifecycle effects, in registration order. cordis runs disposers in
  // reverse, so this is what an unload actually executes.
  const lifecycle = harness.effects.filter(({ label }) => label.startsWith('orchestrator: master session'))
  assert.deepEqual(
    lifecycle.map(({ label }) => label),
    ['orchestrator: master session shutdown', 'orchestrator: master session'],
    'the shutdown marker is registered before the session it protects',
  )
  for (const entry of [...lifecycle].reverse()) await entry.dispose()
  assert.deepEqual(order, ['flush', 'flush', 'dispose'], 'the reversed disposers flush before they dispose')
})

test('unloading the whole plugin flushes the master before any teardown runs', async () => {
  const order = []
  const agent = fakeMasterAgent()
  const agents = fakeAgentRegistry({
    resume: async () => ({ agent, dispose: async () => order.push('dispose') }),
    create: async () => {
      throw new Error('a found session must not be replaced')
    },
  })
  const sessions = {
    get: () => undefined,
    list: () => [],
    async flush() {
      order.push('flush')
      return true
    },
  }
  const harness = start({ masterEnabled: true, agents, sessions })
  await settle()
  await unload(harness)
  assert.deepEqual(order, ['flush', 'flush', 'dispose'], 'flush-then-dispose survives a whole-plugin unload')
})

test('a master that cannot start is reported and never breaks the rest of the plugin', async () => {
  const agents = fakeAgentRegistry({
    resume: async () => {
      throw new Error('session not found')
    },
    create: async () => {
      throw new Error('the persistence backend is read-only')
    },
  })
  const sessions = { get: () => undefined, list: () => [], flush: async () => true }
  const harness = start({ masterEnabled: true, agents, sessions })
  await settle()

  assert.equal(
    harness.effects.some(({ label }) => label === 'orchestrator: master session'),
    false,
    'a failed start owns no lifecycle',
  )
  assert.ok(
    harness.tools.some(({ name }) => name === 'dispatch'),
    'the dispatch entry survives a broken master',
  )
  assert.match(harness.logs.warn.join('\n'), /master/)
})

test('a host without the agent registry degrades with a warning instead of throwing', async () => {
  const harness = start({ masterEnabled: true, agents: {} })
  await settle()
  assert.ok(harness.logs.warn.length > 0)
  assert.match(harness.logs.warn.join('\n'), /master/i)
})

// ---- Cross-session messaging (ticket 06): switch read, protocol exported, no tool ------

test('the messaging switch is read live with the module constants as its ceiling', () => {
  // apply registers nothing for messaging: the ticket asks for the protocol, so the
  // switch is read wherever a delivery starts, not captured at load time.
  let enabled = false
  let policy = 'accept'
  const config = {
    masterMessagingEnabled: { get: () => enabled },
    masterInboundPolicy: { get: () => policy },
  }

  assert.deepEqual(mod.masterMessagingSettings(config), {
    enabled: false,
    policy: 'accept',
    maxBytes: MAX_MESSAGE_BYTES,
    maxQueue: MAX_MESSAGE_QUEUE,
  })

  enabled = true
  policy = 'hold'
  assert.deepEqual(mod.masterMessagingSettings(config), {
    enabled: true,
    policy: 'hold',
    maxBytes: MAX_MESSAGE_BYTES,
    maxQueue: MAX_MESSAGE_QUEUE,
  })
})

test('the messaging protocol is exported from the plugin entry and registers no tool', () => {
  assert.equal(mod.composeMessage, composeMessage)
  assert.equal(mod.checkInbound, checkInbound)
  assert.equal(mod.deliverMessage, deliverMessage)

  const harness = start({})
  const names = harness.tools.map(({ name }) => name)
  assert.equal(
    names.some((name) => /messag/i.test(name)),
    false,
    'a message entry tool is out of scope for ticket 06 and must not appear meanwhile',
  )
})

test('a switch-off host refuses a message without touching any agent', async () => {
  const settings = mod.masterMessagingSettings({
    masterMessagingEnabled: { get: () => false },
    masterInboundPolicy: { get: () => 'accept' },
  })
  let looked = 0
  const result = await deliverMessage(
    { agents: { get: () => { looked += 1; return undefined } }, sessions: { flush: async () => true }, queue: undefined },
    { toSessionId: 'worker-1', text: 'x' },
    { ...settings, loadLlm: async () => ({ createUserMessage: (input) => input }) },
  )
  assert.deepEqual(result, { decision: 'refuse', reason: 'disabled' })
  assert.equal(looked, 0)
})

// ---- Secretary registry (secretary spec, ticket 01): declaration only -----------------

test('the secretary keys are declared with their defaults and are all volatile', () => {
  // This ticket adds the storage face of lib/secretary-registry.js: six config keys the
  // settings card will write. Nothing reads them yet, so what can be pinned is the
  // declaration itself — the default, the bounds the spec fixes, and the volatile flag
  // that lets a settings write reach the running plugin without editing the profile file.
  const { shape } = mod.Config
  assert.ok(shape, 'Config must expose the keys it declares')

  const defaults = {
    secretaryMasterSessionId: '',
    secretaryBeatSeconds: 180,
    secretaryMaxRunSeconds: 7200,
    secretaryPromptText: '',
  }
  for (const [key, value] of Object.entries(defaults)) {
    assert.ok(shape[key], `Config must declare ${key}`)
    assert.deepEqual(shape[key].defaultValue, value, `${key} default`)
    assert.equal(shape[key].volatileFlag, true, `${key} must be volatile`)
  }

  assert.deepEqual(shape.secretaryOrchestrators.defaultValue, [])
  assert.equal(shape.secretaryOrchestrators.volatileFlag, true, 'secretaryOrchestrators must be volatile')

  assert.deepEqual(shape.secretaryNotifyOn.defaultValue, [
    'state-flip',
    'step-advance',
    'blocked',
    'deliverable',
    'timeout',
  ])
  assert.equal(shape.secretaryNotifyOn.volatileFlag, true, 'secretaryNotifyOn must be volatile')

  // The spec fixes the cadence window: 3 minutes by default, capped at 2 hours.
  assert.equal(shape.secretaryBeatSeconds.minValue, 10)
  assert.equal(shape.secretaryBeatSeconds.maxValue, 86400)
  assert.equal(shape.secretaryMaxRunSeconds.minValue, 60)
  assert.equal(shape.secretaryMaxRunSeconds.maxValue, 86400)
})

test('one tracked row stores a session id and three optional fields', () => {
  const { shape } = mod.Config
  const fields = shape.secretaryOrchestrators.item.shape
  assert.ok(fields, 'a stored row must declare its fields')
  assert.ok(fields.sessionId, 'a row must declare sessionId')
  assert.equal(fields.workspace?.defaultValue, '')
  assert.equal(fields.title?.defaultValue, '')
  assert.equal(fields.trackedAt?.defaultValue, 0)
})

test('applying with no secretary key at all is still a clean start', () => {
  // The keys are storage for later tickets, so an older profile has none of them: the
  // plugin must load and register its ordinary units without a complaint.
  const harness = start()
  assert.ok(harness.projections.some(({ key }) => key === 'orchestrator'))
  assert.ok(harness.tools.some(({ name }) => name === 'dispatch'))
  assert.equal(harness.logs.warn.length, 0)
})

// ---- Secretary trigger (secretary spec, ticket 03): opt-in watch + planning report ------

/** 会话日志里的一条 dispatch 工具调用，形状与宿主的 `tool/call` 事件一致。 */
function dispatchEvent(args, { callId = 'call-1', time = 1000 } = {}) {
  return { type: 'tool/call', time, data: { turn: 1, step: 1, callId, name: 'dispatch', arguments: JSON.stringify(args) } }
}

const trackedOrchestrator = { sessionId: 'orch-1', workspace: 'w', title: '日报', trackedAt: 1 }
const planDir = (dir) => join(dir, '.scratch', 'master-secretary', 'reports', 'orch-1')

test('the secretary watch switch is off by default and volatile', () => {
  const { shape } = mod.Config
  assert.ok(shape.secretaryEnabled, 'Config must declare the watch switch')
  assert.equal(shape.secretaryEnabled.defaultValue, false, 'a watch nothing registered is the safe default')
  assert.equal(shape.secretaryEnabled.volatileFlag, true, 'a settings write must reach the running plugin')
})

test('an off switch registers no secretary effect and subscribes to no session event', () => {
  const off = start()
  // 最老的 profile 里这三把键一个都不存在：加载结果必须与「声明了但关着」一模一样，
  // 这样「关闭时行为与今天完全一致」就不是一句话，而是一次逐项比较。
  const older = fakeCtx()
  delete older.config.secretaryEnabled
  delete older.config.secretaryMasterSessionId
  delete older.config.secretaryOrchestrators
  mod.apply(older.ctx, older.config)

  assert.deepEqual(
    off.effects.map(({ label }) => label),
    older.effects.map(({ label }) => label),
    'an off switch adds no effect at all',
  )
  assert.deepEqual([...off.handlers.keys()], [...older.handlers.keys()], 'and no extra subscription')
  assert.deepEqual(
    off.tools.map(({ name }) => name),
    older.tools.map(({ name }) => name),
    'and no extra tool',
  )
  assert.equal(
    off.effects.some(({ label }) => label.startsWith('orchestrator: secretary')),
    false,
    'an off switch owns nothing',
  )
  assert.equal(off.handlers.has('session/event'), false, 'no session listener may exist while the switch is off')
  assert.equal(
    off.tools.some(({ name }) => /secretary/i.test(name)),
    false,
    'this ticket adds no tool',
  )
})

test('a tracked dispatch writes one planning report, and a repeat dispatch does not rewrite it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'secretary-plan-'))
  try {
    const harness = start({ secretaryEnabled: true, secretaryOrchestrators: [trackedOrchestrator] })
    const listener = harness.handlers.get('session/event')
    assert.equal(typeof listener, 'function', 'the watch subscribes to session/event')
    assert.ok(
      harness.effects.some(({ label }) => label === 'orchestrator: secretary watch'),
      'the listener is owned by an effect, so an unload removes it',
    )

    const session = { id: 'orch-1', header: { cwd: dir } }
    await listener(
      session,
      dispatchEvent({ description: '修登录', prompt: '让重试可用', verify: 'node --test', doneDefinition: '测试全绿' }),
    )

    // 票 04 的归档约定：与节拍报告同一套 `<HH-mm>.md`，不再另写 .plan.json。
    const files = await readdir(planDir(dir))
    assert.equal(files.length, 1)
    assert.match(files[0], /^\d{2}-\d{2}\.md$/)
    const written = await readFile(join(planDir(dir), files[0]), 'utf8')
    assert.match(written, /^# 秘书规划$/m)
    assert.match(written, /- 时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
    assert.match(written, /- 会话：orch-1/)
    assert.match(written, /## 步骤\n\n1\. 修登录 — 让重试可用/)
    assert.match(written, /## 验收点\n\n- 测试全绿\n- node --test/)
    assert.match(written, /## 触发依据\n\n- 来源：dispatch/)
    assert.match(written, /- 调用：call-1/)

    // 同一会话第二次 dispatch：不再起表，第一份文件原样留着。
    await listener(session, dispatchEvent({ description: '第二份' }, { callId: 'call-2', time: 2000 }))
    assert.equal(await readFile(join(planDir(dir), files[0]), 'utf8'), written)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an untracked session writes nothing, and registering it takes effect on the next dispatch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'secretary-untracked-'))
  try {
    const harness = start({ secretaryEnabled: true })
    const listener = harness.handlers.get('session/event')
    const session = { id: 'orch-1', header: { cwd: dir } }

    await listener(session, dispatchEvent({ description: '未登记' }))
    await assert.rejects(readdir(join(dir, '.scratch')), { code: 'ENOENT' })

    // 非 dispatch 的工具调用也不算出发。
    harness.state.secretaryOrchestrators.push(trackedOrchestrator)
    await listener(session, { type: 'tool/call', time: 1, data: { callId: 'c', name: 'read', arguments: '{}' } })
    await assert.rejects(readdir(join(dir, '.scratch')), { code: 'ENOENT' })

    // 登记表是 volatile 的，下一次 dispatch 就用新名单。
    await listener(session, dispatchEvent({ description: '修登录' }))
    assert.equal((await readdir(planDir(dir))).length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---- Secretary view endpoint (secretary spec, ticket 06): read-only five-segment payload -----

test('the secretary endpoint is provided only while its switch is on', async () => {
  // 关闭：一个服务都不注册（master 面板的端点与这把开关无关，仍在）。
  const off = start()
  assert.deepEqual([...off.services.keys()], ['orchestratorMaster'])
  assert.equal(off.services.has('orchestratorSecretary'), false, 'a closed switch registers no secretary service')

  const session = { id: 'orch-1', title: '修登录', header: { id: 'orch-1' } }
  const harness = start({
    secretaryEnabled: true,
    secretaryOrchestrators: [{ sessionId: 'orch-1', workspace: '', title: '', trackedAt: 1 }],
    sessions: { get: () => undefined, list: () => [session], flush: async () => true },
    agents: { get: (id) => (id === 'orch-1' ? { id } : undefined) },
    stateOf: () => ({ workers: [{ id: 'orch-1', role: 'main', state: 'Working', summary: '在写报告' }] }),
  })
  const service = harness.services.get('orchestratorSecretary')
  assert.ok(service, 'the open switch provides the read-only endpoint')
  assert.equal(typeof service.secretaryState, 'function')

  const payload = await service.secretaryState()
  assert.deepEqual(Object.keys(payload), ['enabled', 'registry', 'orchestrators', 'reports', 'drafts', 'policy'])
  assert.equal(payload.enabled, true)
  assert.equal(payload.registry.masterSessionId, 'master-1')
  // No workspace on the ledger row and no session to resolve one from: the row says so instead
  // of the view silently listing no reports forever.
  assert.deepEqual(
    payload.registry.orchestrators,
    [{ sessionId: 'orch-1', workspace: '', workspaceMissing: true, title: '', trackedAt: 1 }],
  )
  // The stored list the settings edits address by index, unnormalized.
  assert.deepEqual(payload.registry.raw, [{ sessionId: 'orch-1' }])
  assert.equal(payload.orchestrators.length, 1)
  assert.equal(payload.orchestrators[0].sessionId, 'orch-1')
  assert.equal(payload.orchestrators[0].title, '修登录', 'an empty ledger title falls back to the session title')
  assert.equal(payload.orchestrators[0].live, true)
  assert.equal(payload.orchestrators[0].state, 'Working')
  // No beat has started yet, so the row carries the zeroed beat shape; step and
  // lastError are not part of the contract while they have no data source.
  assert.deepEqual(payload.orchestrators[0].beats, { count: 0, startedAt: null, capped: false, stoppedReason: null })
  assert.equal('step' in payload.orchestrators[0], false)
  assert.equal('lastError' in payload.orchestrators[0], false)
  assert.deepEqual(payload.reports, [], 'a workspace that was never written lists no report')
  assert.deepEqual(payload.drafts, [], 'ticket 08 owns the drafts')
  assert.equal(payload.policy.beatSeconds, 180)
  assert.equal(payload.policy.maxRunSeconds, 7200)
  // Only the four fields the endpoint really reads: a report root and a view limit were never
  // config keys, and showing them in the settings tab was a lie about what can be changed.
  assert.deepEqual(Object.keys(payload.policy), ['beatSeconds', 'maxRunSeconds', 'notifyOn', 'promptText'])

  // 开关是 volatile 的：关掉之后同一个服务返回稳定空结构，不读任何会话。
  harness.state.secretaryEnabled = false
  const closed = await service.secretaryState()
  assert.equal(closed.enabled, false)
  assert.deepEqual(closed.orchestrators, [])
  assert.deepEqual(closed.registry.orchestrators, [])
})

test('a row registered without a workspace reads its reports from the session cwd (why: the history stayed blank forever)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'secretary-noworkspace-'))
  try {
    await mkdir(planDir(dir), { recursive: true })
    const reportPath = join(planDir(dir), '05-07.md')
    await writeFile(reportPath, '# 秘书汇报\n\n- 类型：增量\n')
    // The settings page registers a session id and nothing else, so the ledger row's workspace is
    // the empty string. The report is really under that session's header.cwd.
    const session = { id: 'orch-1', title: '修登录', header: { id: 'orch-1', cwd: dir } }
    const harness = start({
      secretaryEnabled: true,
      secretaryOrchestrators: [{ sessionId: 'orch-1', workspace: '', title: '', trackedAt: 1 }],
      sessions: {
        get: (id) => (id === 'orch-1' ? session : undefined),
        list: () => [session],
        flush: async () => true,
      },
      stateOf: () => ({ workers: [{ id: 'orch-1', role: 'main', state: 'Working', summary: '在写报告' }] }),
    })
    const payload = await harness.services.get('orchestratorSecretary').secretaryState()
    assert.deepEqual(payload.registry.orchestrators, [
      { sessionId: 'orch-1', workspace: dir, workspaceMissing: false, title: '', trackedAt: 1 },
    ])
    assert.equal(payload.reports.length, 1, 'the archived report is listed once the workspace is known')
    assert.equal(payload.reports[0].path, reportPath)
    assert.equal(payload.reports[0].kind, 'delta')

    // A session the host cannot resolve is flagged, not pointed at a guessed directory: the
    // report root of an empty or borrowed workspace is never read.
    const other = start({
      secretaryEnabled: true,
      secretaryOrchestrators: [{ sessionId: 'orch-1', workspace: '', title: '', trackedAt: 1 }],
      sessions: {
        get: () => undefined,
        list: () => [{ id: 'orch-1', title: '修登录', header: { id: 'orch-1' } }],
        flush: async () => true,
      },
    })
    const flagged = await other.services.get('orchestratorSecretary').secretaryState()
    assert.deepEqual(flagged.registry.orchestrators[0], {
      sessionId: 'orch-1',
      workspace: '',
      workspaceMissing: true,
      title: '',
      trackedAt: 1,
    })
    assert.deepEqual(flagged.reports, [], 'nothing is listed for a row with no workspace')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the mounted secretary drafts a nudge for a Needs input session, dedupes it, and sends only on confirm (why: reads no longer draft)', async () => {
  const session = { id: 'orch-1', title: '修登录', header: { id: 'orch-1' } }
  const harness = start({
    secretaryEnabled: true,
    secretaryOrchestrators: [{ sessionId: 'orch-1', workspace: '', title: '', trackedAt: 1 }],
    sessions: { get: () => undefined, list: () => [session], flush: async () => true },
    stateOf: () => ({ workers: [{ id: 'orch-1', role: 'main', state: 'Needs input', summary: '等你拍板' }] }),
  })
  const service = harness.services.get('orchestratorSecretary')
  assert.equal(typeof service.confirmDraft, 'function')
  assert.equal(typeof service.discardDraft, 'function')

  const first = await service.secretaryState()
  assert.equal(first.drafts.length, 1)
  assert.equal(first.drafts[0].status, 'pending')
  assert.equal(first.drafts[0].sessionId, 'orch-1')
  assert.equal(first.drafts[0].reason, 'needs-input')
  // The view re-reads on a timer; the same blocker stays one draft.
  assert.equal((await service.secretaryState()).drafts.length, 1)

  // No live master agent in this fake host, so the send fails loudly and the draft stays pending.
  const failed = await service.confirmDraft(first.drafts[0].id)
  assert.equal(failed.delivered, false)
  assert.match(failed.reason, /no live agent for session master-1/)
  assert.equal((await service.secretaryState()).drafts[0].status, 'pending')

  const discarded = await service.discardDraft(first.drafts[0].id)
  assert.equal(discarded.draft.status, 'discarded')
  const after = await service.secretaryState()
  assert.equal(after.drafts.find((draft) => draft.id === first.drafts[0].id).status, 'discarded')
  // Reading no longer drafts: a decided draft stays decided until the next beat tick
  // drafts the still-existing blocker again (covered in test/secretary-runtime.test.mjs).
  assert.equal(after.drafts.filter((draft) => draft.status === 'pending').length, 0)
  const decided = await service.confirmDraft(first.drafts[0].id)
  assert.equal(decided.reason, 'draft-decided')
})

test('the view read is a pure snapshot: two reads never draft a nudge (why: the client polls every ten seconds)', async () => {
  // A store with a trigger ready to fire (Needs input) but no beat and no mount
  // initialization: the read function must not create the draft itself.
  const stateOf = () => ({ workers: [{ id: 'orch-1', role: 'main', state: 'Needs input', summary: '等你拍板' }] })
  const harness = fakeCtx({
    secretaryEnabled: true,
    secretaryOrchestrators: [{ sessionId: 'orch-1', workspace: '', title: '修登录', trackedAt: 1 }],
    sessions: {
      get: () => undefined,
      list: () => [{ id: 'orch-1', title: '修登录', header: { id: 'orch-1' } }],
      flush: async () => true,
    },
    stateOf,
  })
  const drafts = createDraftStore()
  const read = mod.createSecretaryViewRead({
    ctx: harness.ctx,
    config: harness.config,
    registration: Promise.resolve({ stateOf }),
    drafts,
  })

  const first = await read()
  const second = await read()
  assert.deepEqual(first.drafts, [])
  assert.deepEqual(second.drafts, [])
  assert.equal(drafts.list().length, 0, 'the read path must not write into the draft store')
  assert.equal(first.orchestrators[0].state, 'Needs input', 'and it still reports the state it read')
})

test('the secretary endpoint lists the archived reports of a registered workspace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'secretary-view-'))
  try {
    const session = { id: 'orch-1', title: '修登录', header: { id: 'orch-1', cwd: dir } }
    const harness = start({
      secretaryEnabled: true,
      secretaryOrchestrators: [{ sessionId: 'orch-1', workspace: dir, title: '', trackedAt: 1 }],
      sessions: { get: () => undefined, list: () => [session], flush: async () => true },
      stateOf: () => ({ workers: [{ id: 'orch-1', role: 'main', state: 'Completed', summary: '做完了' }] }),
    })
    const service = harness.services.get('orchestratorSecretary')
    assert.deepEqual((await service.secretaryState()).reports, [], 'no archive yet is an empty list, not an error')

    // 票 03 的 watch 写规划首报；端点从票 04 的归档目录把它读回来。
    const listener = harness.handlers.get('session/event')
    await listener(session, dispatchEvent({ description: '修登录', prompt: '让重试可用' }))

    const payload = await service.secretaryState()
    assert.equal(payload.reports.length, 1)
    assert.equal(payload.reports[0].sessionId, 'orch-1')
    assert.equal(payload.reports[0].kind, 'plan')
    assert.match(payload.reports[0].path, /\.scratch[\\/]master-secretary[\\/]reports[\\/]orch-1[\\/]\d{2}-\d{2}\.md$/)
    // Ticket 08: the report's diff is the structured shape (here all three groups empty).
    assert.deepEqual(payload.reports[0].changes, { completed: [], blocked: [], flipped: [] })
    assert.equal(payload.reports[0].error, null)
    assert.ok(payload.reports[0].bytes > 0)
    assert.deepEqual(payload.orchestrators[0].lastReport, {
      path: payload.reports[0].path,
      at: payload.reports[0].at,
      kind: 'plan',
    })
    assert.equal(payload.orchestrators[0].live, false, 'no live agent means not live, not an error')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 调度指挥（草图 B）：authority 认领与默认闸门的互换。默认配置（开关关闭、指定为空）下
// 这些分支一条都不走，所以上面既有的 gate 断言一条都不用改。
// ---------------------------------------------------------------------------

/** 被指定为 Master 的根 agent：fakeCtx 的 secretaryMasterSessionId 恒为 master-1。 */
function masterAgent(options = {}) {
  return fakeAgent({ id: 'master-1', ...options })
}

test('with the secretary switch off the master session gets the default gate, exactly as today', () => {
  const { created, logs, handlers } = start()
  const { agent, restricted, guards } = masterAgent()
  created({ agent, source: 'create' })
  assert.deepEqual(restricted, hiddenOf(mod.DEFAULT_ALLOWED_TOOLS))
  assert.equal(guards.length, 1)
  assert.match(guards[0]({ name: 'read' }), /is not available to the main agent/)
  assert.equal(logs.info.some((line) => line.includes('dispatch-command')), false)
  // A settings write while the switch is off must not claim anything either.
  handlers.get('loader/volatile-update')()
  assert.deepEqual(restricted, hiddenOf(mod.DEFAULT_ALLOWED_TOOLS))
})

test('an unset master id designates nobody, even with the secretary switch on', () => {
  const harness = start({ secretaryEnabled: true })
  harness.config.secretaryMasterSessionId = { get: () => '' }
  const { agent, restricted, guards } = masterAgent()
  harness.created({ agent, source: 'create' })
  assert.deepEqual(restricted, hiddenOf(mod.DEFAULT_ALLOWED_TOOLS))
  assert.equal(guards.length, 1)
  assert.equal(harness.logs.info.some((line) => line.includes('dispatch-command')), false)
})

test('a session that is not the master keeps the default gate while the switch is on', () => {
  const harness = start({ secretaryEnabled: true })
  const { agent, restricted, guards } = fakeAgent({ id: 'someone-else' })
  harness.created({ agent, source: 'create' })
  assert.deepEqual(restricted, hiddenOf(mod.DEFAULT_ALLOWED_TOOLS))
  assert.equal(guards.length, 1)
  assert.equal(harness.logs.info.some((line) => line.includes('dispatch-command')), false)
})

test('the designated master is handed to the authority: no default gate, reads stay open', () => {
  const harness = start({ secretaryEnabled: true })
  const { agent, restricted, guards } = masterAgent()
  harness.created({ agent, source: 'create' })
  // The default list is gone: the mask is now "catalog minus the allow list".
  assert.equal(restricted.includes('read'), false, 'a read must stay reachable for the master')
  assert.equal(restricted.includes('edit'), true, 'a writer is still hidden')
  assert.equal(restricted.includes('write'), true)
  assert.equal(guards.length, 1, 'exactly one guard is installed for the master')
  assert.match(harness.logs.info.join('\n'), /dispatch-command authority installed/)
  assert.equal(guards[0]({ name: 'read', arguments: {} }), undefined)
  assert.match(guards[0]({ name: 'edit', arguments: {} }), /not available to the dispatch-command agent/)
})

test('cancelling the switch or re-designating the master reinstates the default gate', () => {
  const agent = masterAgent()
  const harness = start({
    secretaryEnabled: true,
    agents: { get: () => undefined, roots: () => [agent.agent] },
  })
  harness.created({ agent: agent.agent, source: 'create' })
  assert.equal(agent.masked().includes('read'), false, 'the authority mask leaves reads open')

  // 开关关闭 = 取消调度指挥；交还时必须把默认闸门装回去，不能让它裸奔。
  harness.state.secretaryEnabled = false
  harness.handlers.get('loader/volatile-update')()
  assert.ok(agent.masked().includes('read'), 'the default gate is back once the switch is off')

  // 再打开是新的认领；换个指定则把旧 master 交还，同一条交还路径。
  harness.state.secretaryEnabled = true
  harness.handlers.get('loader/volatile-update')()
  assert.equal(agent.masked().includes('read'), false, 'the authority claims it again')
  harness.config.secretaryMasterSessionId = { get: () => 'someone-else' }
  harness.handlers.get('loader/volatile-update')()
  assert.ok(agent.masked().includes('read'), 're-designating the master returns the default gate')
})

test('a disposed master is released without a fresh default gate on a dead agent', () => {
  const harness = start({ secretaryEnabled: true })
  const { agent, restricted } = masterAgent()
  harness.created({ agent, source: 'create' })
  const before = restricted.length
  harness.handlers.get('agent/disposed')({ agent })
  assert.equal(restricted.length, before, 'a disposed agent must not be gated again')
})

test('the secretary payload carries the authority refusals as policy.violations', async () => {
  const harness = start({ secretaryEnabled: true })
  const service = harness.services.get('orchestratorSecretary')
  const clean = await service.secretaryState()
  assert.equal('violations' in clean.policy, false, 'no record, no extra key: the payload is what it was')
  assert.deepEqual(Object.keys(clean.policy), ['beatSeconds', 'maxRunSeconds', 'notifyOn', 'promptText'])

  const { agent, guards } = masterAgent()
  harness.created({ agent, source: 'create' })
  assert.match(guards[0]({ name: 'pwsh', arguments: {} }), /not available to the dispatch-command agent/)

  const payload = await service.secretaryState()
  assert.equal(payload.policy.violations.length, 1)
  assert.deepEqual(Object.keys(payload.policy.violations[0]).sort(), ['action', 'agentId', 'at', 'reason'])
  assert.equal(payload.policy.violations[0].action, 'pwsh')
  assert.equal(payload.policy.violations[0].agentId, 'master-1')
})

