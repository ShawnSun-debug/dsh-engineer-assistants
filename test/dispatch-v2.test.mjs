import assert from 'node:assert/strict'
import test from 'node:test'

import { MAX_FILES_FOR_LIGHT, executeDispatch, planDispatch } from '../lib/dispatch-tool.js'

const presets = {
  implementer: { id: 'implementer', category: 'code', tools: { allow: [], deny: [] }, modelTier: 'strong' },
  researcher: { id: 'researcher', category: 'non-code', tools: { allow: [], deny: [] }, modelTier: 'cheap' },
}

const base = {
  goal: 'rename the columns',
  prompt: 'Do the thing and prove it.',
  cwd: 'D:/work',
  presetId: 'implementer',
}

/** deps that record the call order and behave like the host. */
function harness(overrides = {}) {
  const order = []
  const deps = {
    presets,
    reserve: (plan) => {
      order.push(['reserve', plan.presetId])
      return 'worker-1'
    },
    spawn: (plan, id) => {
      order.push(['spawn', id])
      return id
    },
    release: (id) => {
      order.push(['release', id])
    },
    ...overrides,
  }
  return { deps, order }
}

test('a plan carries the task card and the resolved category', () => {
  const plan = planDispatch(base, { presets })
  assert.equal(plan.category, 'code')
  assert.equal(plan.cwd, 'D:/work')
  assert.deepEqual(plan.warnings, [])
})

test('cwd is required every time: there is no default directory to guess', () => {
  assert.throws(() => planDispatch({ ...base, cwd: undefined }, { presets }), /cwd must be a non-empty string/)
  assert.throws(() => planDispatch({ ...base, cwd: '   ' }, { presets }), /cwd must be a non-empty string/)
})

test('goal, prompt and presetId are required too', () => {
  assert.throws(() => planDispatch({ ...base, goal: '' }, { presets }), /goal must be a non-empty string/)
  assert.throws(() => planDispatch({ ...base, prompt: '' }, { presets }), /prompt must be a non-empty string/)
  assert.throws(() => planDispatch({ ...base, presetId: '' }, { presets }), /presetId must be a non-empty string/)
})

test('an unknown preset is refused, including names inherited from Object.prototype', () => {
  assert.throws(() => planDispatch({ ...base, presetId: 'ghost' }, { presets }), /unknown preset "ghost"/)
  assert.throws(() => planDispatch({ ...base, presetId: 'constructor' }, { presets }), /unknown preset "constructor"/)
  assert.throws(() => planDispatch({ ...base, presetId: 'toString' }, { presets }), /unknown preset "toString"/)
})

test('a category that disagrees with the preset is a warning, not a refusal', () => {
  const plan = planDispatch({ ...base, category: 'non-code' }, { presets })
  assert.equal(plan.category, 'non-code')
  assert.equal(plan.warnings.length, 1)
  assert.match(plan.warnings[0], /differs from the "implementer" default "code"/)
})

test('category and verify are type-checked instead of silently dropped', () => {
  assert.throws(() => planDispatch({ ...base, category: 'ops' }, { presets }), /category must be one of/)
  assert.throws(() => planDispatch({ ...base, category: 42 }, { presets }), /category must be one of/)
  assert.throws(() => planDispatch({ ...base, verify: ['npm test'] }, { presets }), /verify must be a string/)
})

test('lightness: an explicit answer wins, otherwise the file count decides', () => {
  assert.equal(planDispatch({ ...base, light: true }, { presets }).light, true)
  assert.equal(planDispatch({ ...base, light: false, files: ['a', 'b'] }, { presets }).light, false)
  assert.equal(planDispatch({ ...base, files: ['a', 'b'] }, { presets }).light, true)
  assert.equal(planDispatch({ ...base, files: ['a', 'b', 'c'] }, { presets }).light, true)
  assert.equal(planDispatch({ ...base, files: ['a', 'b', 'c', 'd'] }, { presets }).light, false)
  assert.equal(planDispatch(base, { presets }).light, false, 'no file estimate means the heavy path')
  assert.equal(MAX_FILES_FOR_LIGHT, 3)
})

test('a light dispatch reserves the row before spawning', async () => {
  const { deps, order } = harness()
  const result = await executeDispatch({ args: { ...base, light: true }, deps })
  assert.deepEqual(order, [['reserve', 'implementer'], ['spawn', 'worker-1']])
  assert.deepEqual(result, {
    kind: 'activation',
    workerId: 'worker-1',
    presetId: 'implementer',
    category: 'code',
    light: true,
    warnings: [],
  })
})

test('a dispatch with no reservation hook refuses to spawn an unregistered worker', async () => {
  let spawned = 0
  await assert.rejects(
    () => executeDispatch({
      args: { ...base, light: true },
      deps: { presets, spawn: () => { spawned += 1; return 'w' } },
    }),
    /no reservation hook/,
  )
  assert.equal(spawned, 0)
})

test('a heavy dispatch asks once and proceeds only on approval', async () => {
  let asked = 0
  const { deps } = harness({
    confirm: () => {
      asked += 1
      return true
    },
  })
  const result = await executeDispatch({ args: base, deps })
  assert.equal(asked, 1)
  assert.equal(result.workerId, 'worker-1')
})

test('a declined heavy dispatch reserves and spawns nothing', async () => {
  const { deps, order } = harness({ confirm: () => false })
  await assert.rejects(() => executeDispatch({ args: base, deps }), /did not approve/)
  assert.deepEqual(order, [])
})

test('a heavy dispatch with no confirmation channel is refused', async () => {
  await assert.rejects(
    () => executeDispatch({ args: base, deps: harness().deps }),
    /needs a confirmation channel/,
  )
})

test('a failed spawn names the reserved worker so the row can be cleaned up', async () => {
  const { deps } = harness({
    spawn: () => {
      throw new Error('host refused')
    },
  })
  await assert.rejects(() => executeDispatch({ args: { ...base, light: true }, deps }), /reserved worker "worker-1": host refused/)
})

test('a host that picks its own id is reconciled, or the dispatch refuses', async () => {
  const seen = []
  const { deps } = harness({
    spawn: () => 'host-chosen-2',
    reassign: (from, to) => seen.push([from, to]),
  })
  const result = await executeDispatch({ args: { ...base, light: true }, deps })
  assert.deepEqual(seen, [['worker-1', 'host-chosen-2']])
  assert.equal(result.workerId, 'host-chosen-2')

  const bare = harness({ spawn: () => 'host-chosen-3' })
  await assert.rejects(
    () => executeDispatch({ args: { ...base, light: true }, deps: bare.deps }),
    /no reassign hook/,
  )
})

test('spawn must hand back an id, or nothing is claimed to be running', async () => {
  const { deps } = harness({ spawn: () => '' })
  await assert.rejects(
    () => executeDispatch({ args: { ...base, light: true }, deps }),
    /spawn returned no worker id for the reserved worker "worker-1"/,
  )
})
test('a dispatch with no release hook refuses before reserving anything', async () => {
  const { deps, order } = harness({ release: undefined })
  await assert.rejects(
    () => executeDispatch({ args: { ...base, light: true }, deps }),
    /no release hook/,
  )
  assert.deepEqual(order, [])
})

test('a failed spawn releases the reservation instead of leaving a phantom worker', async () => {
  const { deps, order } = harness({
    spawn: () => {
      throw new Error('host refused')
    },
  })
  await assert.rejects(() => executeDispatch({ args: { ...base, light: true }, deps }), /reserved worker "worker-1": host refused/)
  assert.deepEqual(order, [['reserve', 'implementer'], ['release', 'worker-1']])
})

test('a host-chosen id that cannot be reconciled is released and names both ids', async () => {
  const { deps, order } = harness({
    spawn: () => 'host-chosen-4',
    reassign: () => {
      throw new Error('config write failed')
    },
  })
  await assert.rejects(
    () => executeDispatch({ args: { ...base, light: true }, deps }),
    /worker "host-chosen-4" is running but the registry row "worker-1" could not be moved \(config write failed\)/,
  )
  assert.deepEqual(order.at(-1), ['release', 'worker-1'])
})

test('a host-chosen id with no reassign hook is released too', async () => {
  const { deps, order } = harness({ spawn: () => 'host-chosen-5' })
  await assert.rejects(() => executeDispatch({ args: { ...base, light: true }, deps }), /no reassign hook/)
  assert.deepEqual(order.at(-1), ['release', 'worker-1'])
})

test('a failing release hook is appended to the original error, not swapped in', async () => {
  const { deps } = harness({
    spawn: () => '',
    release: () => {
      throw new Error('storage offline')
    },
  })
  await assert.rejects(
    () => executeDispatch({ args: { ...base, light: true }, deps }),
    (error) => {
      assert.match(error.message, /spawn returned no worker id for the reserved worker "worker-1"/)
      assert.match(error.message, /additionally the reserved row "worker-1" could not be released \(storage offline\)/)
      return true
    },
  )
})

test('light must be a boolean, not a truthy string or zero', () => {
  assert.throws(() => planDispatch({ ...base, light: 'false', files: ['a', 'b'] }, { presets }), /light must be a boolean/)
  assert.throws(() => planDispatch({ ...base, light: 0, files: ['a', 'b'] }, { presets }), /light must be a boolean/)
})
test('a release that fails does not replace the original error', async () => {
  const { deps } = harness({
    spawn: () => 'host-9',
    reassign: () => {
      throw new Error('config write failed')
    },
    release: () => {
      throw new Error('storage offline')
    },
  })
  await assert.rejects(
    () => executeDispatch({ args: { ...base, light: true }, deps }),
    (error) => {
      assert.match(error.message, /worker "host-9" is running but the registry row "worker-1" could not be moved \(config write failed\)/)
      assert.match(error.message, /additionally the reserved row "worker-1" could not be released \(storage offline\)/)
      return true
    },
  )
})
test('a release that fails with an empty message still reports the phantom row', async () => {
  const { deps } = harness({
    spawn: 'host-10' === 'never' ? () => 'x' : () => 'host-10',
    reassign: () => {
      throw new Error('config write failed')
    },
    release: () => {
      throw new Error('')
    },
  })
  await assert.rejects(
    () => executeDispatch({ args: { ...base, light: true }, deps }),
    /additionally the reserved row "worker-1" could not be released \(\)/,
  )
})
