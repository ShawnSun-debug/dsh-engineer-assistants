import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

/**
 * 常驻口径注入（秘书 spec 票 09）。
 *
 * 实现就在 `lib/index.js`（本票只动这个入口与测试），所以这里跑真实的 `apply`，
 * 只把宿主框架换成记录用的假对象：`systemPrompt.section` 记录每一次注册与它的
 * disposer，配置是可变引用，于是「改文本不重新注册」「取消指定即摘掉」都能直接观察。
 *
 * `lib/index.js` 依赖三个宿主在运行时提供的包，本仓库一个都不装：用 data: URL 的
 * 替身让真实入口能加载。占位不参与本票任何断言。
 */
const dataUrl = (source) => 'data:text/javascript,' + encodeURIComponent(source)

const STUBS = {
  '@deepseek-ai/schemastery': `
    function chain() {
      const node = { defaultValue: undefined, minValue: undefined, maxValue: undefined, volatileFlag: false }
      node.default = (value) => { node.defaultValue = value; return node }
      node.volatile = () => { node.volatileFlag = true; return node }
      node.min = (value) => { node.minValue = value; return node }
      node.max = (value) => { node.maxValue = value; return node }
      node.step = () => node
      node.description = () => node
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
 * A minimal ctx for `apply`: only the members it touches. `systemPrompt.section`
 * records every registration together with its disposer, and the config refs read
 * the mutable `state`, so one test can change a setting and replay the loader's
 * `loader/volatile-update` the way a settings write does.
 */
function fakeCtx({ enabled = false, masterSessionId = '', promptText = '' } = {}) {
  const state = { enabled, masterSessionId, promptText }
  const services = new Map()
  const sections = []
  let sectionCalls = 0
  let disposals = 0
  const handlers = new Map()
  const effects = []
  const logs = { info: [], warn: [] }
  const emitted = []
  let catalog = []
  const catalogRef = {
    get: () => catalog,
    [Symbol.for('cosmokit.volatile.write')]: (next) => {
      catalog = next
    },
  }
  const ctx = {
    sessionProjections: {
      register: () => () => {},
    },
    provide(name, value) {
      services.set(name, value)
      return () => services.delete(name)
    },
    tools: {
      register: () => () => {},
      view: () => ({ knownNames: new Set(['read']), visible: new Map() }),
    },
    get(name) {
      return name in ctx ? ctx[name] : undefined
    },
    subagents: {},
    systemPrompt: {
      section(section) {
        sectionCalls += 1
        const record = { ...section, disposed: false }
        sections.push(record)
        return () => {
          disposals += 1
          record.disposed = true
        }
      },
    },
    agents: { get: () => undefined },
    sessions: { get: () => undefined, list: () => [], flush: async () => true },
    effect(fn, label) {
      const dispose = fn()
      effects.push({ label, dispose })
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    on(event, handler, options) {
      handlers.set(event, { handler, options })
    },
    logger: {
      info: (message) => logs.info.push(message),
      warn: (message) => logs.warn.push(message),
    },
    emit: (event, ...args) => emitted.push([event, ...args]),
  }
  const config = {
    enabled: { get: () => true },
    deniedTools: { get: () => [] },
    allowedTools: { get: () => [] },
    workerProvider: { get: () => '' },
    workerModel: { get: () => '' },
    workerReasoningEffort: { get: () => '' },
    superviseEnabled: { get: () => true },
    superviseIntervalSeconds: { get: () => 600 },
    superviseMaxNoticesPerChild: { get: () => 3 },
    superviseNotifyOnNoProgress: { get: () => false },
    masterMemoryEnabled: { get: () => false },
    masterPanelEnabled: { get: () => false },
    masterSessionEnabled: { get: () => false },
    secretaryEnabled: { get: () => state.enabled },
    secretaryMasterSessionId: { get: () => state.masterSessionId },
    secretaryPromptText: { get: () => state.promptText },
    secretaryOrchestrators: { get: () => [] },
    toolCatalog: catalogRef,
  }
  return {
    ctx,
    config,
    state,
    sections,
    services,
    effects,
    handlers,
    logs,
    emitted,
    sectionCalls: () => sectionCalls,
    disposals: () => disposals,
  }
}

/** Start the real plugin entry and hand the harness back. */
function start(options) {
  const harness = fakeCtx(options)
  mod.apply(harness.ctx, harness.config)
  return harness
}

/** Replay the loader's volatile-write event the way a settings write dispatches it. */
function writeSettings(harness) {
  const entry = harness.handlers.get('loader/volatile-update')
  assert.equal(typeof entry?.handler, 'function', 'apply must subscribe to loader/volatile-update')
  entry.handler()
}

test('an unassigned master registers no section at all', () => {
  const harness = start({ enabled: true, masterSessionId: '', promptText: '只汇报' })
  assert.equal(harness.sectionCalls(), 0, 'no master means no section')
  assert.equal(harness.sections.length, 0)
  assert.equal(harness.effects.some(({ label }) => label === 'orchestrator: secretary persona'), false)
})

test('an assigned master gets the section with the ticket name, order and no interpolation', () => {
  const harness = start({ enabled: true, masterSessionId: 'master-1', promptText: '只汇报，不代做决定' })
  assert.equal(harness.sectionCalls(), 1)
  const [section] = harness.sections
  assert.equal(section.name, 'orchestrator:secretary')
  assert.equal(section.order, 491)
  assert.equal(section.interpolate, false, 'author text must not be parsed as prompt variables')
  assert.equal(typeof section.text, 'function', 'the text is a provider, not a snapshot')

  // The master session reads the configured text; another session reads the empty string.
  assert.equal(section.text({ agent: { id: 'master-1' }, scope: { id: 'master-1' } }), '只汇报，不代做决定')
  assert.equal(section.text({ agent: { id: 'worker-1' }, scope: { id: 'worker-1' } }), '')
  assert.equal(section.text({ scope: { id: 'worker-1' } }), '')
  // No session identity at all: inject nothing and say why. A global fallback would
  // put the secretary prompt into every child's system prompt (ticket 09's semantics).
  assert.equal(section.text(), '')
  assert.equal(section.text({}), '')
  assert.ok(
    harness.logs.warn.some((message) => /cannot tell which session/.test(message)),
    'the missing identity is warned about instead of silently widening the injection',
  )
})

test('an edited text is read at the next assembly without registering again', () => {
  const harness = start({ enabled: true, masterSessionId: 'master-1', promptText: '旧口径' })
  const [section] = harness.sections
  assert.equal(section.text({ agent: { id: 'master-1' } }), '旧口径')

  harness.state.promptText = '新口径'
  assert.equal(harness.sections.length, 1, 'editing the text must not register a second section')
  assert.equal(section.text({ agent: { id: 'master-1' } }), '新口径')

  // An empty setting falls back to the built-in prompt instead of injecting nothing.
  harness.state.promptText = ''
  assert.equal(mod.personaTextOf(harness.config), mod.DEFAULT_SECRETARY_PROMPT)
  assert.equal(section.text({ agent: { id: 'master-1' } }), mod.DEFAULT_SECRETARY_PROMPT)
})

test('cancelling the assignment disposes the section and it stops injecting', () => {
  const harness = start({ enabled: true, masterSessionId: 'master-1', promptText: '只汇报' })
  const [section] = harness.sections

  harness.state.masterSessionId = ''
  writeSettings(harness)

  assert.equal(section.disposed, true, 'the held disposer must run')
  assert.equal(harness.disposals(), 1)
  assert.equal(section.text({ agent: { id: 'master-1' } }), '', 'a disposed section injects nothing')
  assert.equal(section.text({}), '', 'not even the identity-less fallback survives')

  // A repeat write is idempotent: the disposer is not run twice.
  writeSettings(harness)
  assert.equal(harness.disposals(), 1)
})

test('the switch stays zero-registration while off, and follows the next settings write', () => {
  const harness = start({ enabled: false, masterSessionId: 'master-1', promptText: '只汇报' })
  assert.equal(harness.sectionCalls(), 0, 'a closed switch registers no section')
  assert.equal(harness.effects.some(({ label }) => label === 'orchestrator: secretary persona'), false)

  // Turning it on is a volatile write: the next assembly is injected, no reload needed.
  harness.state.enabled = true
  writeSettings(harness)
  assert.equal(harness.sectionCalls(), 1)
  assert.equal(harness.sections[0].text({ agent: { id: 'master-1' } }), '只汇报')

  // Turning it off again removes it through the same path.
  harness.state.enabled = false
  writeSettings(harness)
  assert.equal(harness.sections[0].disposed, true)
  assert.equal(harness.sections[0].text({ agent: { id: 'master-1' } }), '')
})

test('the section is owned by a plugin effect, so an unload removes it', () => {
  const harness = start({ enabled: true, masterSessionId: 'master-1', promptText: '只汇报' })
  const owned = harness.effects.find(({ label }) => label === 'orchestrator: secretary persona')
  assert.ok(owned, 'the disposer is held by ctx.effect')

  owned.dispose()
  assert.equal(harness.sections[0].disposed, true)
})

test('personaTextOf trims only for the emptiness test and keeps the author text', () => {
  assert.equal(mod.personaTextOf({}), mod.DEFAULT_SECRETARY_PROMPT)
  assert.equal(mod.personaTextOf({ secretaryPromptText: { get: () => '   ' } }), mod.DEFAULT_SECRETARY_PROMPT)
  assert.equal(mod.personaTextOf({ secretaryPromptText: { get: () => '自定义口径' } }), '自定义口径')
})

test('the settings endpoint shows the text that is actually injected', async () => {
  const harness = start({ enabled: true, masterSessionId: 'master-1', promptText: '' })
  const service = harness.services.get('orchestratorSecretary')
  assert.ok(service, 'the open switch provides the secretary endpoint')
  const payload = await service.secretaryState()
  assert.equal(payload.policy.promptText, mod.DEFAULT_SECRETARY_PROMPT)

  harness.state.promptText = '作者口径'
  assert.equal((await service.secretaryState()).policy.promptText, '作者口径')
})

test('a host without systemPrompt degrades with one warning instead of throwing', () => {
  const harness = fakeCtx({ enabled: true, masterSessionId: 'master-1', promptText: '只汇报' })
  delete harness.ctx.systemPrompt
  assert.doesNotThrow(() => mod.apply(harness.ctx, harness.config))
  assert.equal(harness.sections.length, 0)
  assert.match(harness.logs.warn.join('\n'), /systemPrompt/)
})
