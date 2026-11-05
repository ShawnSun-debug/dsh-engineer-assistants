
import test from 'node:test'
import assert from 'node:assert/strict'
import { createDelegateTool } from '../lib/delegate.js'
import { readReviewRoute } from '../lib/worker.js'
import {
  assertReviewShape, blockMessage, buildReviewPrompt, isReviewDispatch,
  parseReviewText, reviewCard, shouldBlock, ReviewShapeError, CHECKED,
} from '../lib/review.js'

const EXEC = () => ({ agent: {}, signal: new AbortController().signal })

const cfg = (provider = 'p', model = 'm') => ({
  workerProvider: { get: () => provider },
  workerModel: { get: () => model },
  workerReasoningEffort: { get: () => '' },
  enabled: { get: () => true },
})

const completeCard = {"goal":"给 4 个测试补用例","doneDefinition":"4 个新用例","files":["test/a.test.mjs"],"deps":[],"verify":"node --test","fallback":"删除新增用例","items":4}

function harness({ reviewer, started = [] } = {}) {
  const tool = createDelegateTool({
    defineTool: (d) => d,
    subagents: {
      resolveMaxDepth: () => 3,
      startActivation: async (spec) => { started.push(spec); return { childId: 'child-1' } },
    },
    config: cfg(),
    reviewer,
  })
  return { tool, started }
}

const REVIEW_BLOCK = {
  verdict: 'BLOCK',
  target: 'verify',
  fix: '把验收命令写成 node --test test/card.test.mjs',
  failureMode: '第 3 步没有可执行验收命令，worker 无法自己判断做完了没有',
  checked: ['验收命令'],
}

test('shape: PASS must list checked; BLOCK/IMPROVE must carry target, fix and failureMode', () => {
  assert.throws(() => assertReviewShape({ verdict: 'PASS' }), ReviewShapeError)
  assert.throws(() => assertReviewShape({ verdict: 'MAYBE', checked: ['x'] }), ReviewShapeError)
  assert.throws(() => assertReviewShape({ verdict: 'BLOCK', target: 't', fix: 'f', checked: ['x'] }), /failureMode/)
  assert.doesNotThrow(() => assertReviewShape({ verdict: 'PASS', checked: ['完成定义'] }))
  assert.deepEqual(CHECKED.length, 4)
})

test('parseReviewText survives a code fence and surrounding prose', () => {
  const wrapped = '这是我的评审：\n' + String.fromCharCode(96, 96, 96) + 'json\n' + JSON.stringify(REVIEW_BLOCK) + '\n' + String.fromCharCode(96, 96, 96)
  assert.equal(parseReviewText(wrapped).verdict, 'BLOCK')
  assert.throws(() => parseReviewText('nothing here'), ReviewShapeError)
  assert.throws(() => parseReviewText(''), ReviewShapeError)
})

test('reviewCard refuses to run without a run function and validates what comes back', async () => {
  await assert.rejects(() => reviewCard(completeCard, {}), TypeError)
  const ok = await reviewCard(completeCard, { run: async () => JSON.stringify(REVIEW_BLOCK) })
  assert.equal(ok.verdict, 'BLOCK')
  await assert.rejects(() => reviewCard(completeCard, { run: async () => 'garbage' }), ReviewShapeError)
})

test('the review prompt carries the card and never the conversation', () => {
  const prompt = buildReviewPrompt(completeCard)
  assert.match(prompt, /doneDefinition/)
  assert.match(prompt, /strict JSON/)
  assert.equal(prompt.includes('conversation history'), false)
})

test('only a BLOCK on the high tier blocks', () => {
  assert.equal(shouldBlock({ verdict: 'BLOCK' }, 'high'), true)
  assert.equal(shouldBlock({ verdict: 'BLOCK' }, 'low'), false)
  assert.equal(shouldBlock({ verdict: 'PASS' }, 'high'), false)
  assert.match(blockMessage(completeCard, REVIEW_BLOCK), /没有可执行验收命令/)
})

test('delegate: a high-risk card is blocked before any worker starts', async () => {
  const { tool, started } = harness({ reviewer: async () => JSON.stringify(REVIEW_BLOCK) })
  await assert.rejects(
    () => tool.execute({ prompt: 'x', description: 'd', goal: '重构 gate.js' }, EXEC()),
    /Dispatch refused by review/,
  )
  assert.equal(started.length, 0)
})

test('delegate: a complete low-risk card skips review and starts the worker', async () => {
  let reviewed = 0
  const { tool, started } = harness({ reviewer: async () => { reviewed += 1; return JSON.stringify(REVIEW_BLOCK) } })
  const out = await tool.execute(
    { prompt: 'x', description: 'd', ...completeCard },
    EXEC(),
  )
  assert.equal(out.kind, 'activation')
  assert.equal(reviewed, 0)
  assert.equal(started.length, 1)
})

test('delegate: a review dispatch never triggers another review', async () => {
  let reviewed = 0
  const { tool, started } = harness({ reviewer: async () => { reviewed += 1; return JSON.stringify(REVIEW_BLOCK) } })
  await tool.execute({ prompt: 'x', description: 'review', review: true }, EXEC())
  assert.equal(reviewed, 0)
  assert.equal(started.length, 1)
  assert.equal(isReviewDispatch({ review: true }), true)
  assert.equal(isReviewDispatch({}), false)
})

test('delegate: an irreversible dispatch is reviewed even with a complete card', async () => {
  let reviewed = 0
  const { tool, started } = harness({ reviewer: async () => { reviewed += 1; return JSON.stringify(REVIEW_BLOCK) } })
  await assert.rejects(
    () => tool.execute({ prompt: 'x', description: 'd', ...completeCard, irreversible: true }, EXEC()),
    /Dispatch refused by review/,
  )
  assert.equal(reviewed, 1)
  assert.equal(started.length, 0)
})

test('review route falls back to the worker route, and a full override wins', () => {
  const base = { workerProvider: { get: () => 'wp' }, workerModel: { get: () => 'wm' }, workerReasoningEffort: { get: () => '' } }
  assert.deepEqual(readReviewRoute(base), { provider: 'wp', model: 'wm' })
  assert.deepEqual(
    readReviewRoute({ ...base, reviewProvider: { get: () => 'rp' }, reviewModel: { get: () => 'rm' }, reviewReasoningEffort: { get: () => 'high' } }),
    { provider: 'rp', model: 'rm', reasoningEffort: 'high' },
  )
  // 半套覆盖不拼混合路由，整体回落到 worker
  assert.deepEqual(readReviewRoute({ ...base, reviewProvider: { get: () => 'rp' } }), { provider: 'wp', model: 'wm' })
})
