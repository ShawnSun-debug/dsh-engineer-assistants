import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

/**
 * 宿主在运行时提供的三个包，仓库不安装。它们在本次接线检查里不参与断言，
 * 用替身让真正的 apply 跑起来（与 test/index.test.mjs 同一套办法）。
 */
const dataUrl = (source) => 'data:text/javascript,' + encodeURIComponent(source)
const STUBS = {
  '@deepseek-ai/schemastery': `
    function chain() {
      const node = {}
      node.default = () => chain()
      node.volatile = () => chain()
      node.min = () => chain()
      node.max = () => chain()
      node.step = () => chain()
      node.description = () => chain()
      return node
    }
    const z = { boolean: () => chain(), string: () => chain(), number: () => chain(), array: () => chain(), object: () => chain() }
    export default z
  `,
  '@deepseek-ai/dsh-tools': `export function defineTool(spec) { return spec }`,
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
 * 端到端接线检查：不经过 delegate/dispatch 的工厂函数，而是**真正启动插件**
 * （mod.apply），从注册表里取出主代理能拿到的那一个工具，调用它。
 *
 * 这条用例存在的理由：票 02 的评审器在 index.js 里（spawn → result → collectText → dispose），
 * 单测全部注入假评审者，绕过了这段接线。这里用假宿主把它跑一遍。
 */

const BLOCK = {
  verdict: 'BLOCK', target: 'verify', fix: '写成 node --test',
  failureMode: '没有可执行验收命令', checked: ['验收命令'],
}
const PASS = { verdict: 'PASS', checked: ['完成定义'] }
const card = {
  goal: '读 retry.js 并总结重试窗口', doneDefinition: '给出常量值', files: [],
  deps: [], verify: '引用行号', fallback: '报告未找到',
}

function boot({ reviewText, started = [] }) {
  let lastReview = ''
  const tools = []
  const handlers = new Map()
  const ctx = {
    sessionProjections: { register: () => () => {}, stateOf: () => ({}) },
    tools: {
      register(tool) { tools.push(tool); return () => {} },
      view: () => ({ knownNames: new Set(['read']), visible: new Map() }),
    },
    subagents: {
      resolveMaxDepth: () => 3,
      async startActivation(spec) {
        started.push(spec)
        return {
          childId: 'child-' + started.length,
          result: Promise.resolve({ output: [{ type: 'text', text: reviewText }] }),
          dispose: async () => {},
        }
      },
    },
    agents: { get: () => undefined },
    sessions: { get: () => undefined, flush: async () => true },
    effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d() } },
    on(event, handler) { handlers.set(event, handler) },
    logger: { info: () => {}, warn: () => {} },
    emit: () => {},
  }
  const config = {
    enabled: { get: () => true },
    allowedTools: { get: () => mod.DEFAULT_ALLOWED_TOOLS },
    workerProvider: { get: () => 'worker-provider' },
    workerModel: { get: () => 'worker-model' },
    workerReasoningEffort: { get: () => '' },
    reviewProvider: { get: () => '' },
    reviewModel: { get: () => '' },
    reviewReasoningEffort: { get: () => '' },
    superviseEnabled: { get: () => false },
    superviseIntervalSeconds: { get: () => 600 },
    superviseMaxNoticesPerChild: { get: () => 3 },
    superviseNotifyOnNoProgress: { get: () => false },
    toolCatalog: { get: () => [], [Symbol.for('cosmokit.volatile.write')]: () => {} },
    lastReview: {
      get: () => lastReview,
      [Symbol.for('cosmokit.volatile.write')]: (value) => {
        lastReview = value
      },
    },
  }
  mod.apply(ctx, config)
  const dispatch = tools.find((tool) => tool.name === 'dispatch')
  assert.ok(dispatch, 'the plugin must register exactly one dispatch entry')
  return { dispatch, started, lastReview: () => lastReview }
}

const EXEC = () => ({ agent: { id: 'parent-1', ctx: { tools: { get: () => ({}) } } }, signal: new AbortController().signal })

test('the registered tool carries a real schema with both shapes', () => {
  const { dispatch } = boot({ reviewText: JSON.stringify(PASS) })
  assert.equal(dispatch.name, 'dispatch')
  for (const key of ['goal', 'doneDefinition', 'files', 'deps', 'verify', 'fallback', 'items', 'stages', 'maxConcurrency']) {
    assert.ok(dispatch.parameters[key], key)
  }
  assert.match(dispatch.description, /Main-agent rule/)
  assert.match(dispatch.description, /only dispatch entry/)
})

test('end to end: a BLOCK from the plugin-owned reviewer stops the dispatch after ONE spawn', async () => {
  const { dispatch, started } = boot({ reviewText: JSON.stringify(BLOCK) })
  await assert.rejects(() => dispatch.execute({ prompt: 'x', description: 'd', goal: '重构 gate.js' }, EXEC()), /Dispatch refused by review/)
  assert.equal(started.length, 1, 'only the review worker may start')
  const prompt = started[0].request.prompt[0].text
  assert.match(prompt, /You review a task card/)
  assert.match(prompt, /重构 gate.js/)
  assert.equal(started[0].request.agentOptions.provider, 'worker-provider')
  assert.equal(started[0].request.agentOptions.model, 'worker-model')
})

test('end to end: a PASS lets the real worker start, on the same route', async () => {
  const { dispatch, started } = boot({ reviewText: JSON.stringify(PASS) })
  const out = await dispatch.execute({ prompt: 'x', description: 'd', goal: '重构 gate.js' }, EXEC())
  assert.equal(out.kind, 'activation')
  assert.equal(started.length, 2, 'review first, then the worker')
  const workerPrompt = started[1].request.prompt[0].text
  assert.match(workerPrompt, /用中文回复/)
})

test('end to end: a complete low-risk card spawns one worker and no reviewer', async () => {
  const { dispatch, started } = boot({ reviewText: JSON.stringify(BLOCK) })
  const out = await dispatch.execute({ prompt: 'x', description: 'd', ...card }, EXEC())
  assert.equal(out.kind, 'activation')
  assert.equal(started.length, 1)
  assert.equal(/You review a task card/.test(started[0].request.prompt[0].text), false)
})

test('the panel gets the last verdict, and a low-risk dispatch leaves it untouched', async () => {
  const blocked = boot({ reviewText: JSON.stringify(BLOCK) })
  await assert.rejects(() => blocked.dispatch.execute({ prompt: 'x', description: 'd', goal: '重构 gate.js' }, EXEC()))
  const row = JSON.parse(blocked.lastReview())
  assert.equal(row.verdict, 'BLOCK')
  assert.equal(row.target, 'verify')

  const plain = boot({ reviewText: JSON.stringify(BLOCK) })
  await plain.dispatch.execute({ prompt: 'x', description: 'd', ...card }, EXEC())
  assert.equal(plain.lastReview(), '', 'no review ran, so nothing is published')
})

test('a reviewer that answers garbage is published as INVALID, and still blocks nothing silently', async () => {
  const { dispatch, lastReview } = boot({ reviewText: 'I think this is fine' })
  await assert.rejects(() => dispatch.execute({ prompt: 'x', description: 'd', goal: '重构 gate.js' }, EXEC()), /review/)
  assert.equal(JSON.parse(lastReview()).verdict, 'INVALID')
})
