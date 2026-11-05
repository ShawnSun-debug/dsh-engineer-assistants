
import test from 'node:test'
import assert from 'node:assert/strict'
import { createDispatchTool, DISPATCH_TOOL } from '../lib/dispatch.js'

const EXEC = () => ({ agent: {}, signal: new AbortController().signal })
const cfg = () => ({
  workerProvider: { get: () => 'p' },
  workerModel: { get: () => 'm' },
  workerReasoningEffort: { get: () => '' },
  enabled: { get: () => true },
})
const card = {
  goal: '读 retry.js 并总结重试窗口', doneDefinition: '给出常量值', files: [],
  deps: [], verify: '引用行号', fallback: '报告未找到',
}
const BLOCK = {
  verdict: 'BLOCK', target: 'verify', fix: '写成 node --test',
  failureMode: '没有可执行验收命令', checked: ['验收命令'],
}

function harness({ reviewer, started = [] } = {}) {
  const tool = createDispatchTool({
    defineTool: (d) => d,
    subagents: {
      resolveMaxDepth: () => 3,
      startActivation: async (spec) => { started.push(spec); return { childId: 'child-1', result: Promise.resolve({}) } },
    },
    config: cfg(),
    reviewer,
  })
  return { tool, started }
}

test('dispatch is one entry point carrying both shapes', () => {
  const { tool } = harness()
  assert.equal(tool.name, DISPATCH_TOOL)
  assert.equal(tool.name, 'dispatch')
  for (const key of ['goal', 'verify', 'files', 'items', 'stages', 'maxConcurrency']) {
    assert.ok(tool.parameters[key], key)
  }
  assert.equal('required' in tool.parameters.items, false)
  // prompt/description belong to the single-task shape; a batch call must not be
  // rejected by the host's schema for omitting them.
  assert.equal('required' in tool.parameters.prompt, false)
  assert.equal('required' in tool.parameters.description, false)
  assert.match(tool.description, /only dispatch entry/)
})

test('no items and no stages means a single dispatch', async () => {
  const { tool, started } = harness({ reviewer: async () => JSON.stringify(BLOCK) })
  const out = await tool.execute({ prompt: 'x', description: 'd', ...card }, EXEC())
  assert.equal(out.kind, 'activation')
  assert.equal(started.length, 1)
})

test('items plus stages is the batch path, and a blocked card starts nothing', async () => {
  const { tool, started } = harness({ reviewer: async () => JSON.stringify(BLOCK) })
  await assert.rejects(
    () => tool.execute({ items: [1, 2], stages: [{ name: 's', prompt: 'p' }], goal: '批量改写' }, EXEC()),
    /Dispatch refused by review/,
  )
  assert.equal(started.length, 0)
})

test('a review dispatch never triggers the gate on either path', async () => {
  let reviewed = 0
  const { tool, started } = harness({ reviewer: async () => { reviewed += 1; return JSON.stringify(BLOCK) } })
  await tool.execute({ prompt: 'x', description: 'review', review: true }, EXEC())
  assert.equal(reviewed, 0)
  assert.equal(started.length, 1)
})
