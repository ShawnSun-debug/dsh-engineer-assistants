import assert from 'node:assert/strict'
import test from 'node:test'
import { createDispatchTool } from '../lib/dispatch.js'

/**
 * 这一条用宿主真实的 defineTool 编译工具定义。
 * 仓库不保证每台机器都能解析宿主的包（CI 上是跳过的），但只要能解析，
 * 就必须证明合并后的参数表与 output 契约真的能被宿主接受——
 * 假宿主（返回 spec 原样）永远看不到 output.render 是必填的。
 */
let defineTool
try {
  ;({ defineTool } = await import('@deepseek-ai/dsh-tools'))
} catch {
  defineTool = undefined
}

const config = {
  enabled: { get: () => true },
  workerProvider: { get: () => 'provider' },
  workerModel: { get: () => 'model' },
  workerReasoningEffort: { get: () => '' },
}

const subagents = {
  resolveMaxDepth: () => 3,
  startActivation: async () => ({ childId: 'child-1', result: Promise.resolve({}) }),
}

test('the real host defineTool accepts the merged dispatch definition', { skip: defineTool === undefined }, () => {
  const tool = createDispatchTool({ defineTool, subagents, config, allowedTools: [] })

  assert.equal(tool.name, 'dispatch')
  assert.equal(typeof tool.output.render, 'function')

  // Both shapes are described, and no shape-specific key is globally required:
  // the host compiles one shared required list, so requiring any of them would
  // reject the other shape at argument validation.
  for (const key of ['goal', 'verify', 'files', 'items', 'stages', 'maxConcurrency', 'prompt', 'description']) {
    assert.ok(tool.parameters.properties[key], key)
  }
  assert.equal(tool.parameters.required, undefined)

  assert.deepEqual(tool.output.render({}, { kind: 'activation', subagentId: 'child-1' }), [
    { type: 'text', text: 'started subagent child-1' },
  ])
  assert.deepEqual(tool.output.render({}, { kind: 'orchestration', agentsStarted: 2 }), [
    { type: 'text', text: 'started 2 worker(s)' },
  ])
})

test('the merged schema still refuses a single dispatch without a prompt', { skip: defineTool === undefined }, async () => {
  const tool = createDispatchTool({ defineTool, subagents, config, allowedTools: [] })
  const exec = { agent: { id: 'parent-1', ctx: { tools: { get: () => ({}) } } }, signal: new AbortController().signal }
  await assert.rejects(() => tool.execute({ goal: '读 retry.js' }, exec), /invalid arguments/)
})
