import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_MAX_CONCURRENCY, runBatch } from '../lib/dispatch-batch.js'

const stages = [{ name: 'plan', prompt: 'p1' }, { name: 'work', prompt: 'p2' }, { name: 'ship', prompt: 'p3' }]
const items = ['a', 'b', 'c', 'd', 'e', 'f']

test('a batch runs every stage of every item, keeping the stage index', async () => {
  const seen = []
  const result = await runBatch({
    items: items.slice(0, 3),
    stages,
    runStage: ({ item, stage }) => {
      seen.push(item + ':' + stage.name)
      return stage.name
    },
  })
  assert.equal(result.ok, true)
  assert.equal(seen.length, 9)
  assert.deepEqual(result.results[0].stages.map((row) => [row.stageIndex, row.name]), [[0, 'plan'], [1, 'work'], [2, 'ship']])
})

test('the concurrency cap is a hard cap, not a hint', async () => {
  let live = 0
  let peak = 0
  const result = await runBatch({
    items,
    stages: stages.slice(0, 1),
    maxConcurrency: 2,
    runStage: async () => {
      live += 1
      peak = Math.max(peak, live)
      await new Promise((resolve) => setTimeout(resolve, 5))
      live -= 1
    },
  })
  assert.equal(peak, 2)
  assert.equal(result.peakConcurrency, 2)
})

test('the default cap is four', async () => {
  assert.equal(DEFAULT_MAX_CONCURRENCY, 4)
  let live = 0
  let peak = 0
  await runBatch({
    items,
    stages: stages.slice(0, 1),
    runStage: async () => {
      live += 1
      peak = Math.max(peak, live)
      await new Promise((resolve) => setTimeout(resolve, 5))
      live -= 1
    },
  })
  assert.equal(peak, 4)
})

test('an async stage rejection stops that item and leaves the others running', async () => {
  const ran = []
  const result = await runBatch({
    items: ['bad', 'good'],
    stages,
    maxConcurrency: 2,
    runStage: async ({ item, stage }) => {
      ran.push(item + ':' + stage.name)
      await new Promise((resolve) => setTimeout(resolve, 1))
      if (item === 'bad' && stage.name === 'work') throw new Error('boom')
      return 'ok'
    },
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.failures[0].failure.stageIndex, 1)
  assert.deepEqual(result.results[0].stages.map((row) => row.name), ['plan', 'work'])
  assert.equal(ran.includes('bad:ship'), false, 'a failed item must not start its next stage')
  assert.equal(result.results[1].ok, true)
})

test('a start hook that fails fails only that item, and the batch still reports the rest', async () => {
  const started = []
  const result = await runBatch({
    items: ['no-row', 'fine'],
    stages: stages.slice(0, 1),
    onItemStart: (item) => {
      started.push(item)
      if (item === 'no-row') throw new Error('registry write failed')
      return 'worker-' + item
    },
    runStage: () => 'ok',
  })
  assert.equal(result.ok, false)
  assert.equal(result.failures.length, 1)
  assert.deepEqual(result.failures[0].failure, {
    stageIndex: -1,
    stage: 'start',
    error: 'registry write failed',
    cause: { name: 'Error', message: 'registry write failed', code: undefined },
  })
  assert.equal(result.failures[0].stages.length, 0, 'a refused item runs no stage')
  assert.equal(result.results[1].ok, true)
  assert.deepEqual(started.sort(), ['fine', 'no-row'])
})

test('a structured throw keeps something readable instead of [object Object]', async () => {
  const result = await runBatch({
    items: ['x'],
    stages: stages.slice(0, 1),
    runStage: () => {
      throw { code: 'E42' }
    },
  })
  assert.equal(result.failures[0].failure.error, '{"code":"E42"}')
})

test('partial failure is aggregated, not thrown', async () => {
  const result = await runBatch({
    items: ['x', 'y'],
    stages: stages.slice(0, 1),
    runStage: ({ item }) => {
      throw new Error(item === 'x' ? 'first' : 'second')
    },
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.failures.map((row) => row.failure.error), ['first', 'second'])
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(result)))
})

test('each item gets exactly one start hook, before its first stage', async () => {
  const order = []
  const result = await runBatch({
    items: ['a', 'b'],
    stages: stages.slice(0, 1),
    onItemStart: (item, index) => {
      order.push(`start:${item}:${index}`)
      return 'worker-' + item
    },
    runStage: ({ item }) => {
      order.push('stage:' + item)
      return 'ok'
    },
  })
  assert.equal(order.filter((entry) => entry.startsWith('start:')).length, 2, 'one start hook per item')
  assert.deepEqual(order.slice(0, 2).sort(), ['start:a:0', 'start:b:1'])
  assert.deepEqual(result.results.map((row) => row.handle), ['worker-a', 'worker-b'])
})

test('both arrays are required; only an empty array is a no-op', async () => {
  await assert.rejects(() => runBatch({ stages, runStage: () => {} }), /items must be an array/)
  await assert.rejects(() => runBatch({ items: null, stages, runStage: () => {} }), /items must be an array/)
  await assert.rejects(() => runBatch({ items: [], stages: [], runStage: () => {} }), /at least one stage/)
  await assert.rejects(() => runBatch({ items: [], runStage: () => {} }), /stages must be an array/)
  await assert.rejects(() => runBatch({ items: [], stages, maxConcurrency: 0 }), /positive integer/)
  await assert.rejects(() => runBatch({ items: [], stages }), /runStage must be a function/)
})

test('an empty item list is a no-op, not an error', async () => {
  const result = await runBatch({ items: [], stages, runStage: () => 'never' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.results, [])
  assert.equal(result.peakConcurrency, 0)
})
test('a circular or BigInt throw cannot break the batch report', async () => {
  const circular = new Error('request failed')
  circular.request = circular
  const result = await runBatch({
    items: ['a', 'b'],
    stages: stages.slice(0, 1),
    runStage: ({ item }) => {
      if (item === 'a') throw circular
      throw 10n
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.failures[0].failure.cause.name, 'Error')
  assert.equal(result.failures[1].failure.error, '10')
  assert.doesNotThrow(() => JSON.stringify(result), 'the report must stay serializable')
})

test('an error whose name or message is a circular object still leaves a serializable report', async () => {
  const circular = {}
  circular.self = circular
  const weird = new Error('ok')
  weird.message = circular
  Object.defineProperty(weird, 'name', { value: circular, configurable: true })
  const result = await runBatch({
    items: ['a'],
    stages: stages.slice(0, 1),
    runStage: () => {
      throw weird
    },
  })
  assert.equal(result.failures[0].failure.cause.name, 'Error')
  assert.equal(result.failures[0].failure.cause.message, 'unprintable error')
  assert.doesNotThrow(() => JSON.stringify(result))
})

test('a throw whose message getter explodes is contained to its item', async () => {
  const nasty = {}
  Object.defineProperty(nasty, 'message', {
    get() {
      throw new Error('getter exploded')
    },
  })
  const result = await runBatch({
    items: ['a', 'b'],
    stages: stages.slice(0, 1),
    runStage: ({ item }) => {
      if (item === 'a') throw nasty
      return 'ok'
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.results[1].ok, true)
  assert.doesNotThrow(() => JSON.stringify(result))
})
