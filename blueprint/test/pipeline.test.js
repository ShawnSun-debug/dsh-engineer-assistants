import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeCard, missingFields, riskTier } from '../sketch-a/card.js'
import { assertReviewShape, reviewCard, shouldBlock, ReviewShapeError } from '../sketch-a/review.js'
import { runPipeline, nextPhase, TRANSITIONS } from '../sketch-a/pipeline.js'

const golden = JSON.parse(readFileSync(new URL('./fixtures/golden-cards.json', import.meta.url), 'utf8'))

test('golden cards: tier matches the expected risk tier', () => {
  for (const row of golden) {
    const card = normalizeCard(row.card)
    assert.equal(riskTier(card, { irreversible: Boolean(row.card.irreversible) }), row.expectedTier, row.id + ' ' + row.why)
  }
  assert.equal(golden.length, 10)
})

test('normalizeCard keeps known fields, defaults items, drops unknowns', () => {
  const c = normalizeCard({ goal: '  x  ', files: ['a'], drop: 1 })
  assert.equal(c.goal, 'x')
  assert.equal(c.items, 1)
  assert.equal('drop' in c, false)
})

test('missingFields reports every absent required field', () => {
  assert.deepEqual(missingFields({}), ['goal', 'doneDefinition', 'files', 'deps', 'verify', 'fallback'])
  assert.deepEqual(missingFields({ goal: 'x' }).length, 5)
})

test('nextPhase is table driven and rejects illegal moves', () => {
  assert.equal(nextPhase('plan', 'planned'), 'review')
  assert.equal(nextPhase('review', 'blocked'), 'plan')
  assert.throws(() => nextPhase('plan', 'settled'), /illegal transition/)
  assert.ok(Object.isFrozen(TRANSITIONS))
})

test('PASS must list checked; BLOCK must carry failureMode', () => {
  assert.throws(() => assertReviewShape({ verdict: 'PASS' }), ReviewShapeError)
  assert.throws(() => assertReviewShape({ verdict: 'BLOCK', target: 't', fix: 'f', checked: ['a'] }), /failureMode/)
  assert.doesNotThrow(() => assertReviewShape({ verdict: 'PASS', checked: ['完成定义'] }))
})

test('reviewCard parses JSON and refuses non-JSON', async () => {
  const ok = await reviewCard('w', normalizeCard(golden[0].card), {
    complete: async () => JSON.stringify({ verdict: 'PASS', checked: ['完成定义'] }),
  })
  assert.equal(ok.verdict, 'PASS')
  await assert.rejects(reviewCard('w', normalizeCard(golden[0].card), { complete: async () => 'not json' }), ReviewShapeError)
})

test('shouldBlock only blocks BLOCK on the high tier', () => {
  assert.equal(shouldBlock({ verdict: 'BLOCK' }, 'high'), true)
  assert.equal(shouldBlock({ verdict: 'BLOCK' }, 'low'), false)
  assert.equal(shouldBlock({ verdict: 'PASS' }, 'high'), false)
})

test('runPipeline: BLOCK returns from the review phase and never dispatches', async () => {
  const calls = []
  const res = await runPipeline({
    dispatch: async () => { calls.push('dispatch'); return { dispatchId: 'd1' } },
    settle: async () => { calls.push('settle') },
    review: { route: 'w', complete: async () => JSON.stringify({ verdict: 'BLOCK', target: 'verify', fix: 'add node --test', failureMode: '第 3 步没有可执行验收命令' , checked: ['验收命令'] }) },
  }, golden[1].card)
  assert.equal(res.phase, 'review')
  assert.equal(res.failureMode, '第 3 步没有可执行验收命令')
  assert.deepEqual(calls, [])
})

test('runPipeline: high tier PASS reaches settle; low tier skips review', async () => {
  const calls = []
  const deps = {
    dispatch: async () => { calls.push('dispatch'); return { dispatchId: 'd2' } },
    settle: async () => { calls.push('settle') },
    review: { route: 'w', complete: async () => JSON.stringify({ verdict: 'PASS', checked: ['完成定义'] }) },
  }
  const high = await runPipeline(deps, { ...golden[1].card, verify: 'node --test' })
  assert.equal(high.phase, 'done')
  assert.deepEqual(calls, ['dispatch', 'settle'])

  calls.length = 0
  let reviewed = 0
  const low = await runPipeline({ ...deps, review: { route: 'w', complete: async () => { reviewed += 1; return '{}' } } }, golden[0].card)
  assert.equal(low.verdict, 'skipped')
  assert.equal(reviewed, 0)
  assert.deepEqual(calls, ['dispatch', 'settle'])
})