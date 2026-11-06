import assert from 'node:assert/strict'
import test from 'node:test'
import { CHANGE_KINDS, classifyChanges, diffSummaries, isSubstantial } from '../lib/secretary-diff.js'

/**
 * 输入是 `summarizeForDiff` 的结构：会话六态、步骤进度、worker 名字与六态、产出路径。
 * 每个用例只改一个字段，让「命中的是哪一类」没有第二种解释。
 */
function summary(overrides = {}) {
  return {
    state: 'Working',
    step: { index: 1, total: 3 },
    workers: [{ name: 'worker-a', state: 'Working' }],
    artifacts: [],
    ...overrides,
  }
}

test('CHANGE_KINDS names the five substantial kinds in report order', () => {
  assert.deepEqual(CHANGE_KINDS, ['state-flip', 'step-advance', 'blocked', 'deliverable', 'timeout'])
})

test('five changes, five kinds: each fires on its own example', () => {
  const base = summary()
  const cases = [
    ['state-flip', summary({ state: 'Idle' })],
    ['step-advance', summary({ step: { index: 2, total: 3 } })],
    ['blocked', summary({ workers: [{ name: 'worker-a', state: 'Working' }, { name: 'worker-b', state: 'Needs input' }] })],
    ['deliverable', summary({ artifacts: ['D:/out/a.png'] })],
    ['timeout', summary({ workers: [{ name: 'worker-a', state: 'Working' }, { name: 'worker-c', state: 'Failed' }] })],
  ]
  for (const [kind, next] of cases) {
    assert.deepEqual(classifyChanges(base, next, CHANGE_KINDS), [kind], kind)
    assert.equal(isSubstantial(base, next, CHANGE_KINDS), true, kind)
  }
})

test('a kind that is switched off is filtered out, and the order stays CHANGE_KINDS order', () => {
  const next = summary({ state: 'Idle', step: { index: 2, total: 3 } })
  assert.deepEqual(classifyChanges(summary(), next, CHANGE_KINDS), ['state-flip', 'step-advance'])
  // 只开了一项：另一项直接消失，不是降级成一个布尔。
  assert.deepEqual(classifyChanges(summary(), next, ['step-advance']), ['step-advance'])
  assert.deepEqual(classifyChanges(summary(), next, ['state-flip']), ['state-flip'])
  // 传进来的顺序不影响返回值：结果永远按 CHANGE_KINDS 排。
  assert.deepEqual(classifyChanges(summary(), next, ['step-advance', 'state-flip']), ['state-flip', 'step-advance'])
  // 全关 + 未知名字 = 不冒泡。
  assert.deepEqual(classifyChanges(summary(), next, []), [])
  assert.deepEqual(classifyChanges(summary(), next, ['nope']), [])
})

test('the first report of a session is compared against the projection baseline', () => {
  // 基线就是投影的初始态：Idle、没有步骤、没有 worker、没有产出。第一份报告里凡是
  // 已经超出这条基线的，都算首次出现，所以五类可以同时命中。
  const first = summary({
    workers: [
      { name: 'worker-a', state: 'Working' },
      { name: 'worker-b', state: 'Needs input' },
      { name: 'worker-c', state: 'Failed' },
    ],
    artifacts: ['D:/out/a.png'],
  })
  assert.deepEqual(classifyChanges(null, first, CHANGE_KINDS), CHANGE_KINDS)
  assert.equal(isSubstantial(null, first, CHANGE_KINDS), true)

  // 一份连基线都没越过的首报不算实质变化：不打扰。
  const quiet = { state: 'Idle', step: { index: null, total: null }, workers: [], artifacts: [] }
  assert.deepEqual(classifyChanges(null, quiet, CHANGE_KINDS), [])
  assert.equal(isSubstantial(null, quiet, CHANGE_KINDS), false)
})

test('no change means false, so a quiet beat writes the file and says nothing', () => {
  const base = summary()
  assert.deepEqual(classifyChanges(base, base, CHANGE_KINDS), [])
  assert.equal(isSubstantial(base, base, CHANGE_KINDS), false)
  // 同一份摘要重新拼一遍（不是同一个对象）也不算变化。
  assert.equal(isSubstantial(base, summary(), CHANGE_KINDS), false)
})

test('diffSummaries sorts the same facts into the three report groups', () => {
  const prev = summary()
  const next = summary({
    state: 'Needs input',
    step: { index: 2, total: 3 },
    workers: [{ name: 'worker-a', state: 'Completed' }, { name: 'worker-b', state: 'Needs input' }],
    artifacts: ['D:/out/a.png'],
  })
  const diff = diffSummaries(prev, next)
  assert.deepEqual(Object.keys(diff).sort(), ['blocked', 'completed', 'flipped'])
  // 进度：步骤推进、产出落地、worker 完成。
  assert.ok(diff.completed.some((line) => line.includes('第 2 步')), JSON.stringify(diff))
  assert.ok(diff.completed.some((line) => line.includes('D:/out/a.png')), JSON.stringify(diff))
  assert.ok(diff.completed.some((line) => line.includes('worker-a')), JSON.stringify(diff))
  // 卡住与异常归一组。
  assert.deepEqual(diff.blocked, ['worker-b：等确认', '会话进入 Needs input'])
  // 只有会话状态翻转在 flipped 里：worker-a 的变化已经作为「完成」记进进度。
  assert.deepEqual(diff.flipped, ['会话：Working → Needs input'])
})

test('diffSummaries on a first report lists every non-empty item as first appearance', () => {
  const first = summary({
    workers: [{ name: 'worker-a', state: 'Working' }, { name: 'worker-b', state: 'Needs input' }],
    artifacts: ['D:/out/a.png'],
  })
  const diff = diffSummaries(null, first)
  assert.deepEqual(diff.flipped, ['会话：Idle → Working'])
  assert.ok(diff.completed.some((line) => line.includes('worker-a')), JSON.stringify(diff))
  assert.ok(diff.completed.some((line) => line.includes('D:/out/a.png')), JSON.stringify(diff))
  assert.ok(diff.completed.some((line) => line.includes('第 1 步')), JSON.stringify(diff))
  assert.deepEqual(diff.blocked, ['worker-b：等确认'])

  // 空输入同样有答案：三组全空，不抛错。
  assert.deepEqual(diffSummaries(null, null), { completed: [], blocked: [], flipped: [] })
})
