import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BUILTIN_PRESETS,
  MODEL_TIERS,
  TOOL_NAMES,
  builtinPresetIds,
  deletePreset,
  getPreset,
  listPresets,
  mayRequestDispatch,
  normalizePresets,
  overridePresets,
} from '../lib/presets.js'

const byId = (presets, id) => getPreset(presets, id)

test('ten built-in presets, one per role named in the spec', () => {
  assert.deepEqual(builtinPresetIds(), [
    'researcher', 'scout', 'implementer', 'verifier', 'reviewer',
    'debugger', 'refactorer', 'writer', 'operator', 'synthesizer',
  ])
  assert.equal(BUILTIN_PRESETS.length, 10)
})

test('the reviewer cannot write or run commands', () => {
  const reviewer = byId({}, 'reviewer')
  assert.deepEqual(reviewer.tools.allow, ['read', 'glob', 'grep'])
  for (const forbidden of ['write', 'edit', 'terminal']) {
    assert.ok(reviewer.tools.deny.includes(forbidden), `reviewer must deny ${forbidden}`)
    assert.ok(!reviewer.tools.allow.includes(forbidden), `reviewer must not allow ${forbidden}`)
  }
})

test('only the four coding presets may request a re-dispatch', () => {
  const allowed = builtinPresetIds().filter((id) => mayRequestDispatch({}, id))
  assert.deepEqual(allowed, ['implementer', 'debugger', 'refactorer', 'operator'])
})

test('every built-in uses a known category, tier and tool name', () => {
  for (const preset of BUILTIN_PRESETS) {
    assert.ok(['code', 'maybe-code', 'non-code'].includes(preset.category), preset.id)
    assert.ok(MODEL_TIERS.includes(preset.modelTier), preset.id)
    for (const name of [...preset.tools.allow, ...preset.tools.deny]) {
      assert.ok(TOOL_NAMES.includes(name), `${preset.id} references unknown tool ${name}`)
    }
  }
})

test('an override replaces only the fields it names', () => {
  const before = byId({}, 'implementer')
  const after = byId(overridePresets({}, 'implementer', { prompt: 'custom' }), 'implementer')
  assert.equal(after.prompt, 'custom')
  assert.deepEqual(after.tools, before.tools)
  assert.equal(after.modelTier, before.modelTier)
  assert.equal(after.category, before.category)
  assert.equal(after.builtin, true)
})

test('a tools override is field-wise: allow alone leaves deny alone', () => {
  const after = byId(overridePresets({}, 'verifier', { tools: { allow: ['read'] } }), 'verifier')
  assert.deepEqual(after.tools.allow, ['read'])
  assert.deepEqual(after.tools.deny, ['write', 'edit'])
})

test('an unknown tool name is refused', () => {
  assert.throws(
    () => overridePresets({}, 'implementer', { tools: { allow: ['rm_rf'] } }),
    /unknown tool "rm_rf"/,
  )
})

test('an unknown model tier or category is refused', () => {
  assert.throws(() => overridePresets({}, 'implementer', { modelTier: 'ultra' }), /modelTier must be one of/)
  assert.throws(() => overridePresets({}, 'implementer', { category: 'ops' }), /category must be one of/)
})

test('overriding an unknown preset is an error, not a silent create', () => {
  assert.throws(() => overridePresets({}, 'ghost', { prompt: 'x' }), /no preset "ghost"/)
})

test('built-ins cannot be deleted, custom ones can', () => {
  assert.throws(() => deletePreset({}, 'researcher'), /built in; override it instead/)
  const custom = normalizePresets({ presets: [{ id: 'mine', label: 'Mine', tools: { allow: ['read'] } }] })
  assert.ok(custom.mine)
  assert.equal(deletePreset(custom, 'mine').mine, undefined)
  assert.ok(deletePreset(custom, 'nobody').mine, 'deleting an unknown id leaves the table alone')
})

test('normalize keeps a stored override and drops a broken row', () => {
  const table = normalizePresets({
    presets: [
      { id: 'implementer', prompt: 'stored prompt' },
      { id: 'broken', modelTier: 'ultra' },
    ],
  })
  assert.equal(table.implementer.prompt, 'stored prompt')
  assert.equal(table.implementer.builtin, true)
  assert.equal(table.broken, undefined)
})

test('an unknown stored id becomes a custom preset with safe defaults', () => {
  const table = normalizePresets({ presets: [{ id: 'mine', prompt: 'do it' }] })
  assert.deepEqual(table.mine, {
    id: 'mine',
    label: 'mine',
    category: 'non-code',
    modelTier: 'cheap',
    mayRequestDispatch: false,
    tools: { allow: [], deny: [] },
    prompt: 'do it',
    builtin: false,
  })
})

test('listPresets puts built-ins first and sorts by id inside each group', () => {
  const listed = listPresets({ presets: [{ id: 'aaa', prompt: 'x' }] })
  assert.equal(listed[0].builtin, true)
  assert.equal(listed[listed.length - 1].id, 'aaa')
  const builtinIds = listed.filter((preset) => preset.builtin).map((preset) => preset.id)
  assert.deepEqual(builtinIds, [...builtinIds].sort())
})

test('normalize never mutates its input and always returns a table', () => {
  const raw = { presets: [{ id: 'implementer', prompt: 'kept' }] }
  const snapshot = JSON.stringify(raw)
  normalizePresets(raw)
  assert.equal(JSON.stringify(raw), snapshot)
  assert.deepEqual(normalizePresets(undefined).researcher.id, 'researcher')
  assert.deepEqual(normalizePresets('nope').reviewer.id, 'reviewer')
})

test('mayRequestDispatch is false for an unknown preset', () => {
  assert.equal(mayRequestDispatch({}, 'ghost'), false)
})
test('returned tool arrays are copies, not the shared built-in data', () => {
  const table = normalizePresets({})
  const builtin = BUILTIN_PRESETS.find((preset) => preset.id === 'researcher')
  assert.notEqual(table.researcher.tools.allow, builtin.tools.allow)
  table.researcher.tools.allow.push('write')
  assert.equal(builtin.tools.allow.includes('write'), false, 'mutating the table must not touch the built-in')
  assert.equal(normalizePresets({}).researcher.tools.allow.includes('write'), false)
})

test('the built-in data itself is frozen', () => {
  const builtin = BUILTIN_PRESETS.find((preset) => preset.id === 'reviewer')
  assert.throws(() => { builtin.tools.allow.push('write') }, TypeError)
  assert.throws(() => { builtin.tools.deny.length = 0 }, TypeError)
})

test('an override cannot turn the reviewer into a writing role', () => {
  assert.throws(
    () => overridePresets({}, 'reviewer', { tools: { allow: ['read', 'write'], deny: [] } }),
    /read-only and cannot allow write/,
  )
  assert.throws(
    () => overridePresets({}, 'reviewer', { tools: { allow: ['terminal'], deny: [] } }),
    /read-only and cannot allow terminal/,
  )
  // 只改 allow 时 deny 仍会把它减掉，所以这是允许的——拒绝的是「两端一起放开」。
  assert.deepEqual(byId(overridePresets({}, 'reviewer', { tools: { allow: ['read', 'write'] } }), 'reviewer').tools.allow, ['read'])
})

test('emptying the deny list still leaves the reviewer unable to write', () => {
  const reviewer = byId(overridePresets({}, 'reviewer', { tools: { deny: [] } }), 'reviewer')
  for (const forbidden of ['write', 'edit', 'terminal']) {
    assert.equal(reviewer.tools.allow.includes(forbidden), false, `${forbidden} must stay out of allow`)
  }
})

test('an override cannot grant a re-dispatch to a preset the ADR does not name', () => {
  assert.throws(
    () => overridePresets({}, 'scout', { mayRequestDispatch: true }),
    /only implementer\/debugger\/refactorer\/operator may request a re-dispatch/,
  )
  assert.equal(byId(overridePresets({}, 'implementer', { mayRequestDispatch: true }), 'implementer').mayRequestDispatch, true)
})

test('a tool named in both lists is denied, not allowed', () => {
  const preset = byId(overridePresets({}, 'implementer', { tools: { allow: ['read', 'terminal'], deny: ['terminal'] } }), 'implementer')
  assert.deepEqual(preset.tools.allow, ['read'])
  assert.ok(preset.tools.deny.includes('terminal'))
})

test('a stored id that collides with Object.prototype stays an ordinary preset', () => {
  const table = normalizePresets({ presets: [{ id: 'toString', prompt: 'x' }] })
  assert.equal(Object.getPrototypeOf(table), Object.prototype)
  assert.equal(typeof table.toString, 'object')
  assert.equal(table.toString.prompt, 'x')
})

test('a stored id of __proto__ becomes an own key instead of replacing the prototype', () => {
  const table = normalizePresets({ presets: [{ id: '__proto__', prompt: 'x' }] })
  assert.equal(Object.getPrototypeOf(table), Object.prototype)
  assert.equal(Object.hasOwn(table, '__proto__'), true)
  assert.equal(table['__proto__'].prompt, 'x')
  assert.equal(Object.keys(table).length, 11)
})
