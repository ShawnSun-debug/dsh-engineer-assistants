
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { createSettlements } from '../lib/settle.js'

// 宿主的三个运行时包，仓库不安装；只为让真正的 lib/index.js 能加载。
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
const { createSupervisionHooks } = await import(new URL('../lib/index.js', import.meta.url).href)

test('settling records the outcome once and never twice', () => {
  const ledger = createSettlements({ now: () => 1000 })
  const first = ledger.settle('child-1', { ok: true })
  assert.equal(first.changed, true)
  assert.deepEqual(first.row, { dispatchId: 'child-1', ok: true, reason: '', at: 1000 })

  const second = ledger.settle('child-1', { ok: false, reason: 'late' })
  assert.equal(second.changed, false, 'an idempotent settle must not change the verdict')
  assert.equal(second.row.ok, true)
  assert.equal(ledger.size, 1)
})

test('a failure settles with its reason, and a blank id settles nothing', () => {
  const ledger = createSettlements()
  const row = ledger.settle('child-2', { ok: false, reason: 'failed before it finished' }).row
  assert.equal(row.ok, false)
  assert.equal(row.reason, 'failed before it finished')
  assert.equal(ledger.settle('', { ok: false }).changed, false)
  assert.equal(ledger.settle(undefined).changed, false)
  assert.equal(ledger.size, 1)
})

test('the ledger is bounded', () => {
  const ledger = createSettlements({ max: 3 })
  for (const id of ['a', 'b', 'c', 'd']) ledger.settle(id)
  assert.equal(ledger.size, 3)
  assert.equal(ledger.has('a'), false, 'the oldest row is dropped')
  assert.equal(ledger.has('d'), true)
})

test('the supervision hook settles on success and on failure', async () => {
  const settled = []
  const forgotten = []
  const supervisor = { track: () => {}, forget: (id) => forgotten.push(id) }
  const settlements = createSettlements()
  const hooks = createSupervisionHooks(supervisor, { settlements })
  const base = { id: 'parent-1' }

  const ok = {}
  ok.result = Promise.resolve({ stopReason: 'completed' })
  hooks.onStarted(base, { childId: 'good-1', ...ok }, { description: 'd' })

  const bad = {}
  bad.result = Promise.reject(new Error('failed before it finished'))
  bad.result.catch(() => {})
  hooks.onStarted(base, { childId: 'bad-1', ...bad }, { description: 'd' })

  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(settlements.get('good-1')?.ok, true)
  assert.deepEqual(settlements.get('bad-1')?.ok, false)
  assert.match(settlements.get('bad-1')?.reason ?? '', /failed before it finished/)
  assert.deepEqual(forgotten.sort(), ['bad-1', 'good-1'])
})
