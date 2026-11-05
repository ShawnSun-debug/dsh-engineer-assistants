import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// A tiny hook runtime for one self-contained component: rendering is synchronous, state
// setters re-render, and effects run after each commit. Components render as plain trees.
let hookOwner = null

function sameDeps(a, b) {
  if (a === undefined || b === undefined || a.length !== b.length) return false
  return a.every((dep, i) => Object.is(dep, b[i]))
}

function useState(initial) {
  if (hookOwner === null) return [typeof initial === 'function' ? initial() : initial, () => {}]
  const owner = hookOwner
  const index = owner.index++
  if (!(index in owner.states)) owner.states[index] = typeof initial === 'function' ? initial() : initial
  return [
    owner.states[index],
    (next) => {
      const value = typeof next === 'function' ? next(owner.states[index]) : next
      if (Object.is(value, owner.states[index])) return
      owner.states[index] = value
      owner.dirty = true
      if (!owner.rendering) owner.render()
    },
  ]
}

function useReducer(reducer, initial) {
  if (hookOwner === null) return [initial, () => {}]
  const owner = hookOwner
  const index = owner.index++
  if (!(index in owner.states)) owner.states[index] = initial
  return [
    owner.states[index],
    (action) => {
      const value = reducer(owner.states[index], action)
      if (Object.is(value, owner.states[index])) return
      owner.states[index] = value
      owner.dirty = true
      if (!owner.rendering) owner.render()
    },
  ]
}

function useRef(initial) {
  if (hookOwner === null) return { current: initial }
  const owner = hookOwner
  const index = owner.index++
  if (!(index in owner.refs)) owner.refs[index] = { current: initial }
  return owner.refs[index]
}

const React = {
  useState,
  useReducer,
  useRef,
  useEffect: (fn, deps) => {
    if (hookOwner !== null) hookOwner.effects.push({ fn, deps })
  },
  createElement: (type, props, ...kids) => ({ type, props, kids }),
}

/** Render a component with the hook runtime above; effects are committed after each pass. */
function mount(component, props) {
  const owner = { states: [], refs: [], effects: [], committed: [], index: 0, dirty: false, rendering: false, tree: null }
  const commitEffects = () => {
    const previous = owner.committed
    const next = owner.effects
    for (let i = 0; i < next.length; i += 1) {
      const old = previous[i]
      if (old !== undefined && sameDeps(old.deps, next[i].deps)) {
        next[i].cleanup = old.cleanup
        continue
      }
      if (typeof old?.cleanup === 'function') old.cleanup()
      const cleanup = next[i].fn()
      next[i].cleanup = typeof cleanup === 'function' ? cleanup : undefined
    }
    for (let i = next.length; i < previous.length; i += 1) {
      if (typeof previous[i]?.cleanup === 'function') previous[i].cleanup()
    }
    owner.committed = next
  }
  const render = () => {
    if (owner.rendering) {
      owner.dirty = true
      return owner.tree
    }
    owner.rendering = true
    try {
      for (let pass = 0; pass < 100; pass += 1) {
        owner.index = 0
        owner.dirty = false
        owner.effects = []
        hookOwner = owner
        try {
          owner.tree = component(props)
        } finally {
          hookOwner = null
        }
        commitEffects()
        if (!owner.dirty) break
      }
    } finally {
      owner.rendering = false
    }
    return owner.tree
  }
  owner.render = render
  render()
  return {
    get tree() {
      return owner.tree
    },
    unmount() {
      for (const effect of owner.committed) {
        if (typeof effect?.cleanup === 'function') effect.cleanup()
      }
    },
  }
}

/** Every host element in a rendered tree. */
function nodes(tree, out = []) {
  if (tree === null || tree === undefined || typeof tree !== 'object') return out
  if (Array.isArray(tree)) {
    for (const child of tree) nodes(child, out)
    return out
  }
  out.push(tree)
  for (const child of tree.kids ?? []) nodes(child, out)
  return out
}

function mountField(scope) {
  const view = mount(mod.__test.SuperviseIntervalField, { scope, t })
  return {
    view,
    input: () => nodes(view.tree).find((node) => node.type === 'input'),
    alert: () => nodes(view.tree).find((node) => node.props?.role === 'alert'),
  }
}

let mod
const timers = []
// A stand-in browser: the row measures its own box and the window height before it opens
// the model list, and listens for scroll and resize while it is open.
const fakeWindow = {
  __ModuleLoader__: {
    load: (def) => {
      mod = def.factory((id) => {
        if (id === 'react') return React
        throw new Error('unexpected require ' + id)
      })
    },
  },
  innerHeight: 900,
  listeners: [],
  addEventListener(type) {
    fakeWindow.listeners.push(type)
  },
  removeEventListener(type) {
    fakeWindow.listeners = fakeWindow.listeners.filter((entry) => entry !== type)
  },
}
const fakeDocument = { listeners: [], addEventListener() {}, removeEventListener() {} }
vm.runInNewContext(src, {
  window: fakeWindow,
  document: fakeDocument,
  // The field schedules its transient warning; tests drive the timer by hand.
  setTimeout: (fn, ms) => {
    const timer = { fn, ms }
    timers.push(timer)
    return timer
  },
  clearTimeout: () => {},
})
const T = mod.__test
const t = (k) => k
// Values built inside the vm context have another Object.prototype; compare them as plain JSON.
const plain = (v) => JSON.parse(JSON.stringify(v))

test('route keys round-trip, including ids with slashes, and reject junk', () => {
  const key = T.routeKey('nexus-claude', 'claude/opus:5.5')
  assert.deepEqual(plain(T.parseRouteKey(key)), { provider: 'nexus-claude', model: 'claude/opus:5.5' })
  assert.equal(T.parseRouteKey('not json'), undefined)
  assert.equal(T.parseRouteKey('[1,2]'), undefined)
  assert.equal(T.parseRouteKey('{}'), undefined)
})

test('routeOf reads the two stored shapes and treats missing fields as empty', () => {
  assert.deepEqual(plain(T.routeOf(T.MAIN.fields, { provider: 'p', model: 'm', reasoningEffort: 'high' })), {
    provider: 'p',
    model: 'm',
    effort: 'high',
  })
  assert.deepEqual(plain(T.routeOf(T.WORKER.fields, { workerProvider: 'w', workerModel: 'x' })), {
    provider: 'w',
    model: 'x',
    effort: '',
  })
  assert.deepEqual(plain(T.routeOf(T.MAIN.fields, undefined)), { provider: '', model: '', effort: '' })
})

test('routeOps sets provider and model, and sets or unsets the effort', () => {
  assert.deepEqual(plain(T.routeOps(T.WORKER.fields, { provider: 'p', model: 'm', effort: 'high' })), [
    { op: 'set', path: ['workerProvider'], value: 'p' },
    { op: 'set', path: ['workerModel'], value: 'm' },
    { op: 'set', path: ['workerReasoningEffort'], value: 'high' },
  ])
  const cleared = T.routeOps(T.MAIN.fields, { provider: 'p', model: 'm', effort: '' })
  assert.deepEqual(plain(cleared[2]), { op: 'unset', path: ['reasoningEffort'] })
})

test('findModel matches provider and model together', () => {
  const groups = [
    { id: 'a', models: [{ id: 'x' }] },
    { id: 'b', models: [{ id: 'x', reasoning: { efforts: [] } }] },
  ]
  assert.equal(T.findModel(groups, { provider: 'b', model: 'x' }), groups[1].models[0])
  assert.equal(T.findModel(groups, { provider: 'a', model: 'nope' }), undefined)
  assert.equal(T.findModel(groups, { provider: 'zzz', model: 'x' }), undefined)
})

/** A fake config scope that applies set/unset ops to a plain object. */
function fakeScope({ writable = true, status = 'ready', reject, drop, inherited = {}, initial = {} } = {}) {
  let revision = 1
  let value = { ...initial }
  const calls = []
  const listeners = new Set()
  const notify = () => {
    for (const listener of [...listeners]) listener()
  }
  return {
    calls,
    // `unset` only removes the user's override, so an inherited layer shows through again.
    getSnapshot: () => ({ status, writable, revision, value: { ...inherited, ...value } }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    mutate: async (ops, expected) => {
      calls.push({ ops, expected })
      if (reject) throw new Error(reject)
      const next = { ...value }
      for (const op of ops) {
        const key = op.path[0]
        if (drop === key) continue
        if (op.op === 'set') next[key] = op.value
        else delete next[key]
      }
      value = next
      revision += 1
      notify()
    },
    /** Simulate the same field changing elsewhere: another panel, the config file, the host. */
    externalSet: (patch) => {
      value = { ...value, ...patch }
      revision += 1
      notify()
    },
  }
}

test('saveRoute writes with the snapshot revision and reports success', async () => {
  const scope = fakeScope()
  const failure = await T.saveRoute(scope, T.WORKER.fields, { provider: 'p', model: 'm', effort: 'high' }, t)
  assert.equal(failure, null)
  assert.equal(scope.calls[0].expected, 1)
  assert.deepEqual(plain(T.routeOf(T.WORKER.fields, scope.getSnapshot().value)), { provider: 'p', model: 'm', effort: 'high' })
})

test('saveRoute clears a stored effort when the new choice is the model default', async () => {
  const scope = fakeScope()
  await T.saveRoute(scope, T.MAIN.fields, { provider: 'p', model: 'm', effort: 'high' }, t)
  const failure = await T.saveRoute(scope, T.MAIN.fields, { provider: 'p', model: 'm', effort: '' }, t)
  assert.equal(failure, null)
  assert.equal('reasoningEffort' in scope.getSnapshot().value, false)
})

test('clearing the subagent effort must beat the value the plugin bundle ships with', async () => {
  // The bundled patch ships workerReasoningEffort: high. Unsetting the override would
  // reveal that again, so the effort has to be stored as an explicit empty string.
  const scope = fakeScope({ inherited: { workerReasoningEffort: 'high' } })
  const failure = await T.saveRoute(scope, T.WORKER.fields, { provider: 'p', model: 'm', effort: '' }, t)
  assert.equal(failure, null)
  assert.equal(plain(scope.getSnapshot().value).workerReasoningEffort, '')
})

test('clearing the main agent effort removes the override, since that field has no empty value', async () => {
  const scope = fakeScope()
  await T.saveRoute(scope, T.MAIN.fields, { provider: 'p', model: 'm', effort: 'high' }, t)
  assert.equal(await T.saveRoute(scope, T.MAIN.fields, { provider: 'p', model: 'm', effort: '' }, t), null)
  assert.equal('reasoningEffort' in plain(scope.getSnapshot().value), false)
})

test('saveRoute refuses an unwritable or unready scope without calling mutate', async () => {
  for (const scope of [fakeScope({ writable: false }), fakeScope({ status: 'loading' })]) {
    assert.equal(await T.saveRoute(scope, T.MAIN.fields, { provider: 'p', model: 'm', effort: '' }, t), 'route.readonly')
    assert.equal(scope.calls.length, 0)
  }
})

test('saveRoute surfaces a rejected write and a write that did not land', async () => {
  const rejected = fakeScope({ reject: 'settings changed since it was read' })
  assert.match(await T.saveRoute(rejected, T.MAIN.fields, { provider: 'p', model: 'm', effort: '' }, t), /settings changed/)
  const dropped = fakeScope({ drop: 'model' })
  assert.equal(await T.saveRoute(dropped, T.MAIN.fields, { provider: 'p', model: 'm', effort: '' }, t), 'route.saveFailed')
})

test('apply puts the toggle in the left slot and the picker in input.right', () => {
  const regs = []
  const ctx = {
    effect: (fn) => fn(),
    locale: { register: () => {} },
    configForms: { get: (ns) => ({ ns }) },
    remote: { commands: { execute: async () => ({ ok: true, value: 'x' }) }, session: { modelCatalog: async () => ({ ok: true, value: { groups: [] } }) } },
    slots: { inject: (_n, cb) => cb(), register: (opts, comp) => regs.push({ opts, comp }) },
  }
  mod.apply(ctx)
  assert.deepEqual(regs.map((r) => [r.opts.name, r.opts.id, r.opts.order]), [
    ['conversation.input.left', 'orchestrator-plan-toggle', 20],
    ['conversation.input.right', 'orchestrator-route-picker', 11],
  ])
  const props = regs[1].opts.inject('S1')
  assert.deepEqual([props.scopes.main.ns, props.scopes.worker.ns, props.scopes.orch.ns], ['agent-default-model', 'orchestrator', 'orchestrator'])
  assert.equal(props.setPlan, undefined)
  assert.deepEqual(plain(mod.inject), ['slots', 'locale', 'remote', 'remote.commands', 'remote.session', 'configForms'])
})

test('filterGroups matches provider names wholesale and model ids or names otherwise', () => {
  const groups = [
    {
      id: 'nexus-deepseek',
      name: 'Nexus DeepSeek',
      models: [
        { id: 'deepseek-v4.1-flash', name: 'Flash' },
        { id: 'deepseek-v4.1-pro', name: 'Pro' },
      ],
    },
    { id: 'nexus-claude', name: 'Nexus Claude', models: [{ id: 'claude/opus:5.5', name: 'Opus 5.5' }] },
  ]
  assert.equal(plain(T.filterGroups(groups, '   ')).length, 2)
  // A provider hit keeps every model that provider offers.
  const byProvider = plain(T.filterGroups(groups, 'claude'))
  assert.deepEqual(byProvider.map((g) => g.id), ['nexus-claude'])
  assert.equal(byProvider[0].models.length, 1)
  // A model hit keeps only the matching models and drops providers left empty.
  const byModel = plain(T.filterGroups(groups, 'PRO'))
  assert.deepEqual(byModel.map((g) => g.id), ['nexus-deepseek'])
  assert.deepEqual(byModel[0].models.map((m) => m.id), ['deepseek-v4.1-pro'])
  // Display names count too, and nothing matching is an empty catalog, not the full one.
  assert.deepEqual(plain(T.filterGroups(groups, 'opus')).map((g) => g.id), ['nexus-claude'])
  assert.deepEqual(plain(T.filterGroups(groups, 'zzz')), [])
})


test('countModels sums the models each provider offers', () => {
  assert.equal(T.countModels([]), 0)
  assert.equal(T.countModels([{ models: [{ id: 'a' }, { id: 'b' }] }, { models: [{ id: 'c' }] }]), 3)
})

test('the supervision interval field shows the stored value, or 600 when it is absent or malformed', () => {
  const cases = [
    [{}, '600'],
    [{ superviseIntervalSeconds: 1200 }, '1200'],
    [{ superviseIntervalSeconds: 0 }, '600'],
    [{ superviseIntervalSeconds: 'abc' }, '600'],
    [{ superviseIntervalSeconds: null }, '600'],
    [{ superviseIntervalSeconds: 12.5 }, '600'],
  ]
  for (const [initial, shown] of cases) {
    const field = mountField(fakeScope({ initial }))
    const input = field.input()
    assert.equal(input.props.value, shown)
    // Text plus a numeric keypad keeps "abc" observable; a number input would blank it.
    assert.equal(input.props.type, 'text')
    assert.equal(input.props.inputMode, 'numeric')
    assert.equal(input.props.min, 10)
    assert.equal(input.props.max, 86400)
    assert.equal(input.props.step, 1)
    assert.equal(input.props['aria-label'], 'supervise.label')
    field.view.unmount()
  }
})

test('invalid interval input is rejected, restored, and explained', async () => {
  for (const bad of ['9', '86401', '12.5', '1e3', 'abc']) {
    const scope = fakeScope({ initial: { superviseIntervalSeconds: 900 } })
    const field = mountField(scope)
    field.input().props.onChange({ target: { value: bad } })
    await field.input().props.onBlur()
    assert.equal(scope.calls.length, 0, bad)
    assert.equal(field.input().props.value, '900', bad)
    assert.equal(field.alert().kids[0], 'supervise.invalid', bad)
    field.view.unmount()
  }
})

test('a valid interval is written on blur with the snapshot revision', async () => {
  const scope = fakeScope({ initial: { superviseIntervalSeconds: 600 } })
  const field = mountField(scope)
  field.input().props.onChange({ target: { value: ' 900 ' } })
  await field.input().props.onBlur()
  assert.equal(scope.calls.length, 1)
  assert.deepEqual(plain(scope.calls[0].ops), [{ op: 'set', path: ['superviseIntervalSeconds'], value: 900 }])
  assert.equal(scope.calls[0].expected, 1)
  assert.equal(scope.getSnapshot().value.superviseIntervalSeconds, 900)
  assert.equal(field.input().props.value, '900')
  assert.equal(field.alert(), undefined)
})

test('Enter also commits a valid interval', async () => {
  const scope = fakeScope({ initial: { superviseIntervalSeconds: 600 } })
  const field = mountField(scope)
  field.input().props.onChange({ target: { value: '1800' } })
  await field.input().props.onKeyDown({ key: 'Enter', preventDefault() {} })
  assert.deepEqual(plain(scope.calls[0].ops), [{ op: 'set', path: ['superviseIntervalSeconds'], value: 1800 }])
})

test('an empty interval writes the 600 default, since a number field cannot clear to an empty string', async () => {
  const scope = fakeScope({ initial: { superviseIntervalSeconds: 1200 } })
  const field = mountField(scope)
  field.input().props.onChange({ target: { value: '   ' } })
  await field.input().props.onBlur()
  assert.equal(scope.calls.length, 1)
  assert.deepEqual(plain(scope.calls[0].ops), [{ op: 'set', path: ['superviseIntervalSeconds'], value: 600 }])
  assert.equal(field.input().props.value, '600')
})

test('an unchanged interval does not mutate the config', async () => {
  const scope = fakeScope({ initial: { superviseIntervalSeconds: 600 } })
  const field = mountField(scope)
  field.input().props.onChange({ target: { value: ' 600 ' } })
  await field.input().props.onBlur()
  assert.equal(scope.calls.length, 0)
  assert.equal(field.input().props.value, '600')
  assert.equal(field.alert(), undefined)
})

test('Escape abandons the edit and restores the stored interval', () => {
  const scope = fakeScope({ initial: { superviseIntervalSeconds: 600 } })
  const field = mountField(scope)
  field.input().props.onChange({ target: { value: '9000' } })
  field.input().props.onKeyDown({ key: 'Escape', preventDefault() {} })
  assert.equal(scope.calls.length, 0)
  assert.equal(field.input().props.value, '600')
  assert.equal(field.alert(), undefined)
})

test('a rejected interval write is caught and shown without crashing', async () => {
  const scope = fakeScope({ reject: 'settings changed since it was read', initial: { superviseIntervalSeconds: 600 } })
  const field = mountField(scope)
  field.input().props.onChange({ target: { value: '900' } })
  await field.input().props.onBlur()
  assert.equal(scope.calls.length, 1)
  assert.equal(field.alert().kids[0], 'supervise.saveFailed')
  assert.equal(field.input().props.value, '600')
})

test('the invalid-input hint disappears when its timer fires', async () => {
  const scope = fakeScope()
  const field = mountField(scope)
  field.input().props.onChange({ target: { value: '9' } })
  await field.input().props.onBlur()
  assert.ok(field.alert())
  const timer = timers[timers.length - 1]
  timer.fn()
  assert.equal(field.alert(), undefined)
})


test('the interval field follows a value changed elsewhere', () => {
  const scope = fakeScope({ initial: { superviseIntervalSeconds: 600 } })
  const field = mountField(scope)
  scope.externalSet({ superviseIntervalSeconds: 1200 })
  assert.equal(field.input().props.value, '1200')
})

// ---- Denied tools -------------------------------------------------------------------

// The panel cannot ask the host for a tool catalog (the session remote has no such
// method), so it re-declares the shipped list. Reading the host constant out of the
// source keeps the two copies honest without loading the host entry, whose packages
// this test process does not install.
const hostSource = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const hostListSource = /export const DEFAULT_DENIED_TOOLS = \[([\s\S]*?)\]/.exec(hostSource)
const HOST_DEFAULT_DENIED_TOOLS = [...hostListSource[1].matchAll(/'([^']+)'/g)].map((match) => match[1])

test('the bundled copy of the shipped deny list matches the host constant', () => {
  assert.deepEqual(plain(T.DEFAULT_DENIED_TOOLS), HOST_DEFAULT_DENIED_TOOLS)
  assert.equal(HOST_DEFAULT_DENIED_TOOLS.length, 42)
})

test('the list holds every shipped name, with nothing locked out of it', () => {
  const shown = plain(T.toolListOf({}))
  assert.deepEqual(shown, HOST_DEFAULT_DENIED_TOOLS)
  // The tools the shipped list omits are not rows until the host catalog names them, but
  // a profile may deny them like any other once it does.
  for (const name of ['delegate', 'orchestrate', 'send_message', 'todo_write', 'compress']) {
    assert.equal(shown.includes(name), false, name)
  }
  const withCatalog = plain(T.toolListOf({ toolCatalog: ['delegate', 'todo_write'] }))
  for (const name of ['delegate', 'todo_write']) assert.equal(withCatalog.includes(name), true, name)
})

test('config names join the list, extras after the shipped order and sorted', () => {
  const shown = plain(T.toolListOf({ deniedTools: ['zeta', 'alpha'], allowedTools: ['edit'] }))
  // An allowed shipped name stays listed (unchecked); it is not removed from the rows.
  assert.equal(shown.includes('edit'), true)
  assert.deepEqual(shown.slice(-2), ['alpha', 'zeta'])
  assert.equal(new Set(shown).size, shown.length)
  // A name outside the shipped list is offered like any other: nothing is exempt.
  assert.equal(plain(T.toolListOf({ deniedTools: ['delegate'] })).includes('delegate'), true)
})

test('the live catalog from the host joins the rows, deduped and sorted after the shipped list', () => {
  const shown = plain(T.toolListOf({ toolCatalog: ['zeta', 'mcp__github__create_issue', 'edit', 'read'] }))
  // A catalog name the shipped list also knows is listed once, in its shipped place.
  assert.equal(shown.filter((name) => name === 'edit').length, 1)
  assert.deepEqual(shown.slice(-2), ['mcp__github__create_issue', 'zeta'])
  // A delegation tool the catalog names is a row like any other.
  assert.equal(plain(T.toolListOf({ toolCatalog: ['delegate'] })).includes('delegate'), true)
})

test('a tool the shipped list never heard of is offered and defaults to available', () => {
  const catalog = { toolCatalog: ['mcp__demo__ping', 'ops_new'] }
  const shown = plain(T.toolListOf(catalog))
  assert.ok(shown.includes('mcp__demo__ping'))
  assert.ok(shown.includes('ops_new'))
  // Unchecked, i.e. not denied: a tool another plugin adds is available unless configured.
  const denied = T.deniedSetOf(catalog)
  assert.equal(denied.has('mcp__demo__ping'), false)
  assert.equal(denied.has('ops_new'), false)
  // Once denied, the panel writes the name and the row reads checked.
  assert.equal(T.deniedSetOf({ ...catalog, deniedTools: ['mcp__demo__ping'] }).has('mcp__demo__ping'), true)
})

test('an absent or empty catalog keeps the shipped fallback', () => {
  const shipped = HOST_DEFAULT_DENIED_TOOLS
  assert.deepEqual(plain(T.toolListOf({ toolCatalog: [] })), shipped)
  assert.deepEqual(plain(T.toolListOf({ toolCatalog: 'not-a-list' })), shipped)
  assert.deepEqual(plain(T.toolListOf({})), shipped)
  assert.deepEqual(plain(T.catalogOf({})), [])
  // Junk entries are dropped instead of rendering as empty rows.
  assert.deepEqual(plain(T.catalogOf({ toolCatalog: ['b', '', 7, 'a'] })), ['b', 'a'])
  assert.equal(T.CATALOG_KEY, 'toolCatalog')
})

test('no name is exempt: anything the panel lists can be denied or re-allowed', () => {
  const onlyShipped = T.deniedSetOf({})
  assert.equal(onlyShipped.has('delegate'), false, 'not denied by default')
  const denied = T.deniedSetOf({ deniedTools: ['delegate', 'orchestrate', 'todo_write'] })
  for (const name of ['delegate', 'orchestrate', 'todo_write']) assert.equal(denied.has(name), true, name)
  const allowed = T.deniedSetOf({ allowedTools: ['read', 'todo_write'] })
  assert.equal(allowed.has('read'), false)
  assert.equal(allowed.has('todo_write'), false)
})

test('checked means denied: the shipped list is checked, an allowance is not', () => {
  const shipped = T.deniedSetOf({})
  for (const name of HOST_DEFAULT_DENIED_TOOLS) assert.equal(shipped.has(name), true, name)
  // Tools outside the shipped list start available: default denied is the shipped list.
  assert.equal(shipped.has('delegate'), false)
  assert.equal(shipped.has('compress'), false)

  const tweaked = T.deniedSetOf({ allowedTools: ['edit'], deniedTools: ['custom'] })
  assert.equal(tweaked.has('edit'), false)
  assert.equal(tweaked.has('read'), true)
  assert.equal(tweaked.has('custom'), true)
})

test('a legacy deniedTools-only profile still adds to the shipped list', () => {
  const legacy = ['session_search', 'interrupt_agent']
  const denied = T.deniedSetOf({ deniedTools: legacy })
  assert.equal(denied.size, HOST_DEFAULT_DENIED_TOOLS.length + 2)
  for (const name of legacy) assert.equal(denied.has(name), true, name)
})

test('the checkbox state maps to the two keys, storing only the differences', () => {
  const clear = [
    { op: 'unset', path: ['deniedTools'] },
    { op: 'unset', path: ['allowedTools'] },
  ]
  assert.deepEqual(plain(T.denyOps(HOST_DEFAULT_DENIED_TOOLS)), clear)

  const withoutEdit = HOST_DEFAULT_DENIED_TOOLS.filter((name) => name !== 'edit')
  assert.deepEqual(plain(T.denyOps(withoutEdit)), [
    { op: 'unset', path: ['deniedTools'] },
    { op: 'set', path: ['allowedTools'], value: ['edit'] },
  ])

  assert.deepEqual(plain(T.denyOps([...HOST_DEFAULT_DENIED_TOOLS, 'zeta', 'alpha'])), [
    { op: 'set', path: ['deniedTools'], value: ['alpha', 'zeta'] },
    { op: 'unset', path: ['allowedTools'] },
  ])

  // A name outside the shipped list is stored as an addition, exactly like any other, and
  // both keys can move at once when one shipped name is unchecked while another is denied.
  assert.deepEqual(plain(T.denyOps([...HOST_DEFAULT_DENIED_TOOLS, 'delegate'])), [
    { op: 'set', path: ['deniedTools'], value: ['delegate'] },
    { op: 'unset', path: ['allowedTools'] },
  ])
  assert.deepEqual(plain(T.denyOps([...withoutEdit, 'custom'])), [
    { op: 'set', path: ['deniedTools'], value: ['custom'] },
    { op: 'set', path: ['allowedTools'], value: ['edit'] },
  ])
})

test('reset clears both keys so the shipped list applies again', () => {
  assert.deepEqual(plain(T.resetDenyOps()), [
    { op: 'unset', path: ['deniedTools'] },
    { op: 'unset', path: ['allowedTools'] },
  ])
})

test('the search matches a case-insensitive substring of the tool name', () => {
  const names = ['edit', 'read', 'ops_bash', 'web_search']
  assert.deepEqual(plain(T.filterTools(names, '')), names)
  assert.deepEqual(plain(T.filterTools(names, '  ED ')), ['edit'])
  assert.deepEqual(plain(T.filterTools(names, 'ops')), ['ops_bash'])
  assert.deepEqual(plain(T.filterTools(names, 'SEARCH')), ['web_search'])
  assert.deepEqual(plain(T.filterTools(names, 'zzz')), [])
})

/** Mount the switch and expose the nodes the tests reach for. */
function mountSwitch(props) {
  const view = mount(T.EnableSwitch, {
    checked: false,
    disabled: false,
    onChange: () => {},
    label: 'route.enable',
    ...props,
  })
  const input = () => nodes(view.tree).find((node) => node.type === 'input')
  const track = () => nodes(view.tree).find((node) => node.props?.['data-switch'] !== undefined)
  return { view, input, track }
}

test('the switch is a role=switch checkbox with a real aria-checked state', () => {
  const off = mountSwitch({})
  assert.equal(off.input().props.type, 'checkbox')
  assert.equal(off.input().props.role, 'switch')
  assert.equal(off.input().props['aria-checked'], 'false')
  assert.equal(off.input().props.checked, false)
  assert.equal(off.input().props['aria-label'], 'route.enable')
  assert.equal(off.track().props['data-switch'], 'off')

  const on = mountSwitch({ checked: true })
  assert.equal(on.input().props['aria-checked'], 'true')
  assert.equal(on.track().props['data-switch'], 'on')
  // The on-track colour is fixed so it reads the same in both themes.
  assert.equal(on.track().props.style.background, '#C6FFD5')
  // The knob slides rather than jumping, and is ringed so white stays visible on it.
  const knob = on.track().kids[0]
  assert.equal(knob.props.style.transform, 'translateX(16px)')
  assert.match(knob.props.style.transition, /transform/)
  assert.match(knob.props.style.boxShadow, /rgba\(0, 0, 0/)
  const offKnob = off.track().kids[0]
  assert.equal(offKnob.props.style.transform, 'translateX(0)')
  assert.match(off.track().props.style.transition, /background-color/)
})

test('the switch is grey when off and green when on, from theme tokens', () => {
  const off = mountSwitch({})
  assert.match(off.track().props.style.background, /--dsw-alias-border-l3/)
  const on = mountSwitch({ checked: true })
  assert.equal(on.track().props.style.background, '#C6FFD5')
  assert.equal(mountSwitch({ checked: true, disabled: true }).track().props.style.opacity, 0.5)
})

test('Enter toggles the switch, and a disabled switch ignores it', () => {
  const seen = []
  const off = mountSwitch({ onChange: (next) => seen.push(next) })
  off.input().props.onKeyDown({ key: 'Enter', preventDefault() {} })
  const on = mountSwitch({ checked: true, onChange: (next) => seen.push(next) })
  on.input().props.onKeyDown({ key: 'Enter', preventDefault() {} })
  assert.deepEqual(seen, [true, false])
  off.input().props.onKeyDown({ key: 'a', preventDefault() {} })
  assert.deepEqual(seen, [true, false])
  const locked = mountSwitch({ disabled: true, onChange: (next) => seen.push(next) })
  locked.input().props.onKeyDown({ key: 'Enter', preventDefault() {} })
  assert.deepEqual(seen, [true, false])
  // The native checkbox change path is untouched.
  off.input().props.onChange({ target: { checked: true } })
  assert.deepEqual(seen, [true, false, true])
})

test('the switch draws a focus ring only while focused', () => {
  const sw = mountSwitch({})
  assert.equal(sw.track().props.style.boxShadow, 'none')
  sw.input().props.onFocus()
  assert.match(sw.track().props.style.boxShadow, /0 0 0 2px/)
  sw.input().props.onBlur()
  assert.equal(sw.track().props.style.boxShadow, 'none')
})

/** Mount the denied-tools column and expose the nodes the tests reach for. */
function mountDenied(scope) {
  const view = mount(T.DeniedToolsPanel, { scope, t })
  const rows = () => nodes(view.tree).filter((node) => node.type === 'label')
  const search = () => nodes(view.tree).find((node) => node.props?.['data-search'] === 'denied-tools')
  const button = () => nodes(view.tree).find((node) => node.type === 'button')
  const text = () => nodes(view.tree).map((node) => node.kids?.[0]).filter((kid) => typeof kid === 'string')
  return { view, rows, search, button, text }
}

test('the column is headed Denied Tools and lists one checkbox row per tool', () => {
  const panel = mountDenied(fakeScope())
  assert.equal(panel.text().includes('denied.title'), true)
  // The heading is literally "Denied Tools" in both dictionaries.
  const zhTitle = /'denied.title': '([^']+)'/.exec(src)?.[1]
  assert.equal(zhTitle, 'Denied Tools')

  const rows = panel.rows()
  assert.equal(rows.length, HOST_DEFAULT_DENIED_TOOLS.length)
  const first = rows[0]
  assert.equal(first.kids[0].type, 'input')
  assert.equal(first.kids[1].type, 'span')
  assert.equal(first.kids[0].props.type, 'checkbox')
  assert.equal(first.kids[0].props.checked, true)
  assert.equal(first.kids[0].props.disabled, false)
  // The five tools the shipped list omits are ordinary rows once the catalog names them,
  // with a working checkbox: the panel no longer locks anything.
  const withCatalog = mountDenied(fakeScope({ initial: { toolCatalog: ['delegate', 'orchestrate', 'send_message', 'todo_write', 'compress'] } }))
  const extra = withCatalog.rows().filter((row) => row.props['data-tool'] === 'delegate' || row.props['data-tool'] === 'compress')
  assert.equal(extra.length, 2)
  for (const row of extra) {
    assert.equal(row.kids[0].type, 'input')
    assert.equal(row.kids[0].props.disabled, false)
    assert.equal(row.kids[0].props.checked, false)
  }
  // The search box sits above the list.
  assert.equal(panel.search().props.type, 'search')
})

test('every row leads with the checkbox so a long name cannot scroll it out of the column', () => {
  const panel = mountDenied(fakeScope({ initial: { toolCatalog: ['mcp__a_very_long_server__a_very_long_tool_name_that_will_not_fit'] } }))
  const rows = panel.rows()
  assert.ok(rows.length > 0)
  // The list is one column pinned to the container, not an `auto` track that a long name
  // would widen (and scroll) sideways.
  const list = nodes(panel.view.tree).find((node) => node.props?.role === 'group')
  assert.equal(list.props.style.display, 'grid')
  assert.equal(list.props.style.gridTemplateColumns, 'minmax(0, 1fr)')
  for (const row of rows) {
    // Checkbox first, name second: the reading order follows the visual order, so the box
    // stays inside the 232px column however long the name is.
    assert.equal(row.kids[0].type, 'input', row.props['data-tool'])
    assert.equal(row.kids[0].props.type, 'checkbox', row.props['data-tool'])
    assert.equal(row.kids[1].type, 'span', row.props['data-tool'])
    assert.equal(row.kids[1].kids[0], row.props['data-tool'])
    // The row cannot be widened past the column by its content, so nothing scrolls sideways.
    assert.equal(row.props.style.minWidth, 0)
    // The box never shrinks; the name absorbs the remaining width and truncates.
    assert.equal(row.kids[0].props.style.flex, 'none')
    assert.equal(row.kids[1].props.style.flex, '1 1 auto')
    assert.equal(row.kids[1].props.style.minWidth, 0)
    assert.equal(row.kids[1].props.style.overflow, 'hidden')
    assert.equal(row.kids[1].props.style.textOverflow, 'ellipsis')
  }
  // The long name keeps its full value in the tooltip instead of being cut in the markup.
  const long = rows.find((row) => row.props['data-tool'].startsWith('mcp__a_very_long'))
  assert.equal(long.kids[1].props.title, 'mcp__a_very_long_server__a_very_long_tool_name_that_will_not_fit')
})

test('the search narrows the rows case-insensitively and explains an empty result', () => {
  const panel = mountDenied(fakeScope())
  panel.search().props.onChange({ target: { value: 'READ' } })
  assert.deepEqual(
    panel.rows().map((row) => row.props['data-tool']),
    ['read', 'ops_read_files', 'read_image', 'acp_read_original_image'],
  )
  panel.search().props.onChange({ target: { value: 'zzz' } })
  assert.deepEqual(panel.rows(), [])
  assert.equal(panel.text().includes('denied.empty'), true)
})

test('a tool published by another plugin is listed, searchable and unchecked', async () => {
  const scope = fakeScope({ initial: { toolCatalog: ['mcp__demo__ping', 'ops_new_tool'] } })
  const panel = mountDenied(scope)
  panel.search().props.onChange({ target: { value: 'DEMO' } })
  const rows = panel.rows()
  assert.deepEqual(rows.map((row) => row.props['data-tool']), ['mcp__demo__ping'])
  assert.equal(rows[0].kids[0].props.type, 'checkbox')
  assert.equal(rows[0].kids[0].props.checked, false)

  // Checking it writes the name as a deny addition, not as an allowance.
  await rows[0].kids[0].props.onChange({ target: { checked: true } })
  assert.deepEqual(plain(scope.calls[0].ops), [
    { op: 'set', path: ['deniedTools'], value: ['mcp__demo__ping'] },
    { op: 'unset', path: ['allowedTools'] },
  ])
})

test('unchecking a shipped name writes allowedTools and re-renders from the store', async () => {
  const scope = fakeScope()
  const panel = mountDenied(scope)
  const row = () => panel.rows().find((entry) => entry.props['data-tool'] === 'edit')
  assert.equal(row().kids[0].props.checked, true)
  await row().kids[0].props.onChange({ target: { checked: false } })
  assert.equal(scope.calls.length, 1)
  assert.deepEqual(plain(scope.calls[0].ops), [
    { op: 'unset', path: ['deniedTools'] },
    { op: 'set', path: ['allowedTools'], value: ['edit'] },
  ])
  assert.equal(scope.calls[0].expected, 1)
  assert.equal(row().kids[0].props.checked, false)
})

test('unchecking a name a profile added removes it from deniedTools', async () => {
  const scope = fakeScope({ initial: { deniedTools: ['custom_tool'] } })
  const panel = mountDenied(scope)
  const row = panel.rows().find((entry) => entry.props['data-tool'] === 'custom_tool')
  assert.ok(row, 'a config-added name is listed')
  await row.kids[0].props.onChange({ target: { checked: false } })
  assert.deepEqual(plain(scope.calls[0].ops), [
    { op: 'unset', path: ['deniedTools'] },
    { op: 'unset', path: ['allowedTools'] },
  ])
})

test('reset to defaults clears both keys', async () => {
  const scope = fakeScope({ initial: { deniedTools: ['custom_tool'], allowedTools: ['edit'] } })
  const panel = mountDenied(scope)
  assert.equal(panel.button().kids[0], 'denied.reset')
  await panel.button().props.onClick()
  assert.deepEqual(plain(scope.calls[0].ops), plain(T.resetDenyOps()))
  assert.equal(panel.rows().find((entry) => entry.props['data-tool'] === 'edit').kids[0].props.checked, true)
})

test('a read-only scope disables the boxes and never writes', async () => {
  const scope = fakeScope({ writable: false })
  const panel = mountDenied(scope)
  const box = panel.rows().find((row) => row.props['data-tool'] === 'edit').kids[0]
  assert.equal(box.props.disabled, true)
  assert.equal(panel.button().props.disabled, true)
  await panel.button().props.onClick()
  assert.equal(scope.calls.length, 0)
})

test('a rejected write is reported without dropping the stored state', async () => {
  const scope = fakeScope({ reject: 'settings changed since it was read' })
  const panel = mountDenied(scope)
  const row = () => panel.rows().find((entry) => entry.props['data-tool'] === 'edit')
  await row().kids[0].props.onChange({ target: { checked: false } })
  const alert = nodes(panel.view.tree).find((node) => node.props?.role === 'alert')
  assert.match(alert.kids[0], /settings changed/)
  assert.equal(row().kids[0].props.checked, true)
})

test('the popover is two columns, the original panel then the denied tools column', () => {
  const scopes = { main: fakeScope(), worker: fakeScope(), orch: fakeScope() }
  const view = mount(T.RoutePicker, {
    t,
    scopes,
    orch: scopes.orch,
    loadCatalog: async () => ({ ok: true, value: { groups: [] } }),
  })
  // The popover only exists while open; the trigger is the only button before that.
  nodes(view.tree).find((node) => node.type === 'button').props.onClick()
  const dialog = nodes(view.tree).find((node) => node.props?.role === 'dialog')
  assert.ok(dialog)
  assert.equal(dialog.kids.length, 2)
  const [left, right] = dialog.kids
  assert.equal(left.type, 'div')
  assert.equal(left.props.style.width, '340px')
  assert.match(left.props.style.borderRight, /^1px solid/)
  assert.equal(right.type, T.DeniedToolsPanel)
  assert.equal(right.props.scope, scopes.orch)
  // The enable row is label-then-switch, and the switch is the new component.
  const switchRow = nodes(left).find((node) => node.type === T.EnableSwitch)
  assert.ok(switchRow)
  assert.equal(switchRow.props.label, 'route.enable')
  view.unmount()
})


// ---- The model list inside a clipped popover ------------------------------------------

test('catalogFor keeps the last non-empty catalog, because an empty read is a write in flight', () => {
  assert.deepEqual(plain(T.catalogFor({ toolCatalog: ['a', 'b'] }, ['stale'])), ['a', 'b'])
  // The Loader commits the profile's raw value on every settings write; for an unset key
  // that is [], and a real catalog is never empty.
  assert.deepEqual(plain(T.catalogFor({ toolCatalog: [] }, ['kept'])), ['kept'])
  assert.deepEqual(plain(T.catalogFor({}, ['kept'])), ['kept'])
  assert.deepEqual(plain(T.catalogFor({}, undefined)), [])
  // A remembered catalog never leaks into toolListOf on its own.
  assert.deepEqual(plain(T.toolListOf({ toolCatalog: [] }, ['mcp__demo__ping'])).slice(-1), ['mcp__demo__ping'])
})

test('a catalog that reads empty mid-write does not collapse the panel to the shipped list', () => {
  const scope = fakeScope({ initial: { toolCatalog: ['mcp__demo__ping', 'delegate'] } })
  const panel = mountDenied(scope)
  const names = () => panel.rows().map((row) => row.props['data-tool'])
  assert.ok(names().includes('mcp__demo__ping'))

  // The host's own settings write empties the field for an instant; the rows must survive it.
  scope.externalSet({ toolCatalog: [] })
  assert.ok(names().includes('mcp__demo__ping'))
  assert.ok(names().includes('delegate'))

  // A genuinely different catalog still replaces the remembered one.
  scope.externalSet({ toolCatalog: ['ops_new'] })
  assert.ok(names().includes('ops_new'))
  assert.equal(names().includes('mcp__demo__ping'), false)
})

test('the model list opens on the side with room and caps its height to that room', () => {
  const rect = { top: 100, bottom: 134, left: 20, width: 300 }
  // Plenty of room below: open downward at the preferred height, aligned to the button.
  const down = plain(T.popupPlacement(rect, 900))
  assert.deepEqual(down, { side: 'down', maxHeight: 260, top: 138, bottom: 'auto', left: 20, width: 300 })

  // At the bottom of the window the room below is small, so it flips upward.
  const up = plain(T.popupPlacement({ top: 700, bottom: 734, left: 20, width: 300 }, 800))
  assert.equal(up.side, 'up')
  assert.equal(up.maxHeight, 260)
  assert.equal(up.top, 'auto')
  assert.equal(up.bottom, 104)

  // Tight on both sides: stay on the roomier side, shrink to it, and scroll inside.
  const tight = plain(T.popupPlacement({ top: 200, bottom: 240, left: 0, width: 200 }, 400))
  assert.equal(tight.side, 'up')
  assert.equal(tight.maxHeight, 188)
  assert.ok(tight.maxHeight < 260)

  // No layout to measure (a test host, a detached render): leave the caller on its own style.
  assert.equal(T.popupPlacement(null, 900), null)
  assert.equal(T.popupPlacement(rect, undefined), null)
  assert.equal(T.popupPlacement({ top: NaN, bottom: 10 }, 900), null)
  // The fallback keeps the list scrollable rather than open-ended.
  assert.equal(T.dropdownStyleOf(null).maxHeight, '260px')
  assert.equal(T.dropdownStyleOf(null).position, 'fixed')
  const placed = T.dropdownStyleOf(T.popupPlacement({ top: 700, bottom: 734, left: 8, width: 240 }, 800))
  assert.equal(placed.maxHeight, '260px')
  assert.equal(placed.bottom, 104)
  assert.equal(placed.right, 'auto')
  assert.equal(placed.width, 240)
})

/** Mount one model row, open its list, and expose what the tests read off it. */
function mountRow({ groups = [], route = { provider: '', model: '', effort: '' }, rect, viewport = 900 } = {}) {
  const changes = []
  fakeWindow.innerHeight = viewport
  const view = mount(T.RouteRow, {
    label: 'worker',
    route,
    groups,
    disabled: false,
    onChange: (next) => changes.push(next),
    t,
  })
  const all = () => nodes(view.tree)
  const trigger = () => all().find((node) => node.props?.['aria-haspopup'] === 'listbox')
  const listbox = () => all().find((node) => node.props?.role === 'listbox')
  const choices = () => all().filter((node) => node.props?.role === 'option')
  const open = () => {
    // The row measures its own box before the list paints; the harness has no layout
    // engine, so the anchor's ref is handed a rect the way React would hand it a node.
    const anchor = all().find((node) => node.props?.ref !== null && typeof node.props?.ref === 'object')
    if (anchor !== undefined && rect !== undefined) anchor.props.ref.current = { getBoundingClientRect: () => rect }
    trigger().props.onClick()
  }
  return { view, changes, trigger, listbox, choices, open }
}

const ROW_GROUPS = [
  {
    id: 'nexus-deepseek',
    name: 'Nexus DeepSeek',
    models: [
      { id: 'deepseek-v4.1-flash', name: 'Flash' },
      { id: 'deepseek-v4.1-pro', name: 'Pro' },
    ],
  },
  { id: 'nexus-claude', name: 'Nexus Claude', models: [{ id: 'claude/opus:5.5', name: 'Opus 5.5' }] },
]

test('the model list flips above the row and stays clickable at the bottom of the window', () => {
  const row = mountRow({
    groups: ROW_GROUPS,
    route: { provider: 'nexus-deepseek', model: 'deepseek-v4.1-pro', effort: '' },
    rect: { top: 700, bottom: 734, left: 40, width: 320 },
    viewport: 800,
  })
  assert.equal(row.listbox(), undefined, 'the list is closed until the row is clicked')
  row.open()

  const list = row.listbox()
  assert.ok(list, 'clicking the row opens the listbox')
  // Upward, because the window bottom leaves 58px below and 688px above.
  assert.equal(list.props['data-side'], 'up')
  assert.equal(list.props.style.position, 'fixed')
  assert.equal(list.props.style.bottom, 104)
  assert.equal(list.props.style.top, 'auto')
  assert.equal(list.props.style.maxHeight, '260px')
  // Capped and scrollable: the last option is reachable instead of clipped away.
  assert.equal(list.props.style.overflowY, 'auto')
  assert.equal(list.props.style.left, 40)
  assert.equal(list.props.style.width, 320)
  // Scroll and resize are watched while it is open, and released when it closes.
  assert.ok(fakeWindow.listeners.includes('resize'))
  assert.ok(fakeWindow.listeners.includes('scroll'))
  row.view.unmount()
  assert.deepEqual(fakeWindow.listeners, [])
})

test('the last model in the list is a real choice, and it saves that model', () => {
  const row = mountRow({
    groups: ROW_GROUPS,
    route: { provider: 'nexus-deepseek', model: 'deepseek-v4.1-pro', effort: '' },
    rect: { top: 700, bottom: 734, left: 40, width: 320 },
    viewport: 800,
  })
  row.open()
  const choices = row.choices()
  // Unset, then three models: the last one is the final provider's only model.
  assert.equal(choices.length, 4)
  const last = choices.at(-1)
  assert.equal(last.kids[0], 'Opus 5.5')
  last.props.onClick()
  assert.deepEqual(plain(row.changes), [{ provider: 'nexus-claude', model: 'claude/opus:5.5', effort: '' }])
  assert.equal(row.listbox(), undefined, 'choosing closes the list')
})

test('a row with no measurable box still opens, on the static upward-or-downward style', () => {
  const row = mountRow({ groups: ROW_GROUPS })
  row.open()
  const list = row.listbox()
  assert.ok(list)
  // No rect was supplied, so no placement was measured and the element keeps the fallback.
  assert.equal(list.props['data-side'], undefined)
  assert.equal(list.props.style.position, 'fixed')
  assert.equal(list.props.style.maxHeight, '260px')
  assert.equal(row.choices().length, 4)
  row.view.unmount()
})


test('review route: own fields, same plugin namespace, and copy for both languages', () => {
  const { REVIEW, WORKER, zh, en } = mod.__test
  // 评审路由与 worker 路由同一个配置段，但字段各自独立
  assert.equal(REVIEW.ns, WORKER.ns)
  // 跨 realm 取回的对象原型不同，deepStrictEqual 会拒；逐字段比对
  assert.equal(REVIEW.fields.provider, 'reviewProvider')
  assert.equal(REVIEW.fields.model, 'reviewModel')
  assert.equal(REVIEW.fields.effort, 'reviewReasoningEffort')
  assert.equal(REVIEW.fields.clear, 'empty')
  assert.notEqual(REVIEW.fields.provider, WORKER.fields.provider)

  for (const dict of [zh, en]) {
    for (const key of ['route.review', 'route.reviewNote', 'route.lastReview', 'route.lastReviewNone']) {
      assert.equal(typeof dict[key], 'string', key)
      assert.ok(dict[key].length > 0, key)
    }
  }
})

/** 把渲染树压成可见文本，用来断言面板真的写出了那几行。 */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  const props = node.props ?? {}
  return textOf(node.kids) + ' ' + textOf(props.title ?? '') + ' ' + textOf(props.children ?? '')
}

test('the panel shows a review route row and the last verdict', async () => {
  const { RoutePicker } = mod.__test
  const mainScope = fakeScope({ initial: { provider: 'p', model: 'm', reasoningEffort: '' } })
  const workerScope = fakeScope({ initial: { workerProvider: 'wp', workerModel: 'wm', workerReasoningEffort: '' } })
  const orchScope = fakeScope({ initial: { enabled: true, lastReview: JSON.stringify({ verdict: 'BLOCK', target: 'verify', at: 1 }) } })

  const view = mount(RoutePicker, {
    t: (key) => key,
    scopes: { main: mainScope, worker: workerScope, orch: orchScope },
    orch: orchScope,
    loadCatalog: async () => ({ ok: true, value: { groups: [{ id: 'wp', name: 'WP', models: [{ id: 'wm', name: 'WM' }] }] } }),
  })

  // 打开面板：找到那颗标题为 route.title 的按钮并触发它的 onClick
  const findButton = (node) => {
    if (node === null || typeof node !== 'object') return null
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = findButton(child)
        if (hit !== null) return hit
      }
      return null
    }
    if (node.props?.title === 'route.title') return node
    return findButton(node.kids)
  }
  const button = findButton(view.tree)
  assert.ok(button, 'the picker must render its trigger button')
  // 状态更新后 hook shim 会自己重渲染；目录加载的 promise 随后到达，再跑一轮
  button.props.onClick()
  for (let i = 0; i < 5; i += 1) await Promise.resolve()

  const text = textOf(view.tree)
  assert.match(text, /route\.review/, 'the reviewer row must be rendered')
  assert.match(text, /route\.lastReview/, 'the last verdict line must be rendered')
  assert.match(text, /BLOCK/, 'the verdict itself must be visible')
  assert.match(text, /verify/, 'the reviewed field must be visible')
  view.unmount()
})
