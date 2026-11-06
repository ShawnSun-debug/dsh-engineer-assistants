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
/** Run every pending microtask; the hook shim commits effects after each render. */
const flush = async (rounds = 10) => {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve()
}

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

test('apply puts the toggle in the left slot, the picker and the master panel in input.right', async () => {
  const regs = []
  const projection = { enabled: true, byState: { Working: 1 }, workers: [{ id: 'w-1', role: 'worker', state: 'Working', summary: 'wired' }] }
  // The Gateway installs a mounted namespace as the Cordis service `remote.<namespace>`;
  // ctx.get is the inject-free read, and $mount is what installs it.
  let installed
  const ctx = {
    effect: (fn) => fn(),
    locale: { register: () => {} },
    configForms: { get: (ns) => ({ ns }) },
    remote: {
      commands: { execute: async () => ({ ok: true, value: 'x' }) },
      session: { modelCatalog: async () => ({ ok: true, value: { groups: [] } }) },
      $mount: async () => {
        installed = { masterState: async () => ({ ok: true, value: projection }) }
      },
    },
    get: (name) => (name === 'remote.orchestratorMaster' ? installed : undefined),
    slots: { inject: (_n, cb) => cb(), register: (opts, comp) => regs.push({ opts, comp }) },
  }
  mod.apply(ctx)
  assert.deepEqual(regs.map((r) => [r.opts.name, r.opts.id, r.opts.order]), [
    ['conversation.input.left', 'orchestrator-plan-toggle', 20],
    ['conversation.input.right', 'orchestrator-route-picker', 11],
    ['conversation.input.right', 'orchestrator-master-panel', 12],
    // The secretary view: one keyless-identity registration into the main seat, then the sidebar
    // row that selects it by the same id.
    ['main', undefined, undefined],
    ['sidebar.panellist', 'secretary', 40],
  ])
  const props = regs[1].opts.inject('S1')
  assert.deepEqual([props.scopes.main.ns, props.scopes.worker.ns, props.scopes.orch.ns], ['agent-default-model', 'orchestrator', 'orchestrator'])
  assert.equal(props.setPlan, undefined)
  // The master panel gets the same config scope plus one loader; it owns no writer.
  const master = regs[2].opts.inject('S1')
  assert.equal(master.orch.ns, 'orchestrator')
  assert.equal(typeof master.loadState, 'function')
  assert.equal(master.setPlan, undefined)
  // The loader is wired to the ctx (not ctx.remote) and reads the namespace through ctx.get;
  // a `remote.orchestratorMaster` property read would throw "cannot get property … without inject".
  assert.deepEqual(plain(await master.loadState()), projection)
  assert.deepEqual(plain(mod.inject), [
    'slots',
    'locale',
    'remote',
    'remote.commands',
    'remote.session',
    'configForms',
    'layout',
    'uiWorkspace',
  ])
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

test('masterGroups keeps the six-state order, counts every group and filters rows by state', () => {
  const { MASTER_STATES, masterGroups } = mod.__test
  assert.deepEqual(plain(MASTER_STATES), ['Working', 'Needs input', 'Idle', 'Completed', 'Failed', 'Stopped'])
  const groups = masterGroups({
    byState: { Working: 2, Idle: 1 },
    workers: [
      { id: 'a', role: 'worker', state: 'Working', summary: 'one' },
      { id: 'b', role: 'worker', state: 'Idle', summary: '' },
      { id: 'c', role: 'worker', state: 'Working', summary: 'two' },
    ],
  })
  assert.deepEqual(plain(groups.map((group) => [group.state, group.count, group.workers.map((worker) => worker.id)])), [
    ['Working', 2, ['a', 'c']],
    ['Needs input', 0, []],
    ['Idle', 1, ['b']],
    ['Completed', 0, []],
    ['Failed', 0, []],
    ['Stopped', 0, []],
  ])
  // A missing or malformed snapshot is the empty six-state shape, never a crash.
  assert.equal(masterGroups(null).length, 6)
  assert.equal(masterGroups({ byState: null, workers: null }).every((group) => group.count === 0), true)
})

test('the master contribution declares its result as an src-json codec', () => {
  const { MASTER_CONTRIBUTION } = mod.__test
  const [descriptor] = MASTER_CONTRIBUTION.descriptors
  // The host validates every mounted result codec: `src-json` returns before the
  // create() check, while a strict codec must carry its own create() factory, which a
  // hand-written plugin contribution cannot supply. Declaring strict makes $mount throw
  // "strict codec has no create() factory" and the panel never reads its state.
  assert.deepEqual(plain(descriptor.result), { mode: 'src-json' })
  assert.equal('typeSymbol' in descriptor.result, false)
  assert.equal('create' in descriptor.result, false)
})

test('the master panel renders nothing and makes no request while its switch is off', () => {
  const { MasterPanel } = mod.__test
  const scope = fakeScope({ initial: { masterPanelEnabled: false } })
  let loads = 0
  const view = mount(MasterPanel, {
    t,
    orch: scope,
    loadState: () => {
      loads += 1
      return Promise.resolve({ enabled: true, byState: {}, workers: [] })
    },
  })
  assert.equal(view.tree, null)
  assert.equal(loads, 0)
  view.unmount()
})

test('the master panel shows its empty state when the endpoint has no workers', async () => {
  const { MasterPanel } = mod.__test
  const scope = fakeScope({ initial: { masterPanelEnabled: true } })
  const view = mount(MasterPanel, {
    t,
    orch: scope,
    loadState: async () => ({ enabled: true, byState: { Working: 0 }, workers: [] }),
  })
  const trigger = nodes(view.tree).find((node) => node.type === 'button')
  assert.ok(trigger, 'the panel renders its trigger once enabled')
  trigger.props.onClick()
  await flush()
  assert.ok(
    nodes(view.tree).some((node) => node.props?.['data-testid'] === 'orchestrator-master-empty'),
    'the empty state is a visible element, not an error',
  )
  assert.equal(nodes(view.tree).some((node) => node.props?.role === 'alert'), false)
  view.unmount()
})

test('the master panel groups worker rows under their state with the projection summary', async () => {
  const { MasterPanel } = mod.__test
  const scope = fakeScope({ initial: { masterPanelEnabled: true } })
  const view = mount(MasterPanel, {
    t,
    orch: scope,
    loadState: async () => ({
      enabled: true,
      byState: { Working: 1, 'Needs input': 1 },
      workers: [
        { id: 'w-1234567890', role: 'worker', state: 'Working', summary: 'build the panel' },
        { id: 'w2', role: 'worker', state: 'Needs input', summary: '' },
      ],
    }),
  })
  nodes(view.tree).find((node) => node.type === 'button').props.onClick()
  await flush()
  const text = textOf(view.tree)
  assert.match(text, /Working · 1/)
  assert.match(text, /Needs input · 1/)
  assert.match(text, /build the panel/)
  assert.match(text, /w-123456/)
  assert.match(text, /master\.summaryEmpty/)
  view.unmount()
})

test('a failed master read shows an alert instead of crashing the toolbar', async () => {
  const { MasterPanel } = mod.__test
  const scope = fakeScope({ initial: { masterPanelEnabled: true } })
  const view = mount(MasterPanel, {
    t,
    orch: scope,
    loadState: async () => {
      throw new Error('remote down')
    },
  })
  nodes(view.tree).find((node) => node.type === 'button').props.onClick()
  await flush()
  const alert = nodes(view.tree).find((node) => node.props?.role === 'alert')
  assert.ok(alert, 'the failure is shown as an alert')
  assert.match(textOf(alert), /master\.failed/)
  assert.match(textOf(alert), /remote down/)
  view.unmount()
})


test('every expansion asks the endpoint again, and a closed panel never reads', async () => {
  const { MasterPanel } = mod.__test
  const scope = fakeScope({ initial: { masterPanelEnabled: true } })
  let loads = 0
  const view = mount(MasterPanel, {
    t,
    orch: scope,
    loadState: async () => {
      loads += 1
      return { enabled: true, byState: {}, workers: [] }
    },
  })
  await flush()
  assert.equal(loads, 0, 'mounting the toolbar entry alone no longer reads the endpoint')

  const trigger = () => nodes(view.tree).find((node) => node.type === 'button')
  trigger().props.onClick()
  await flush()
  assert.equal(loads, 1, 'opening the panel reads it once')

  trigger().props.onClick()
  await flush()
  assert.equal(loads, 1, 'closing the panel reads nothing')

  trigger().props.onClick()
  await flush()
  assert.equal(loads, 2, 'the second expansion reads it again instead of replaying the mount snapshot')
  view.unmount()
})

/**
 * A stand-in for the host's client ctx. `get(name)` is the inject-free service read Cordis
 * offers and `$mount` installs `remote.<namespace>`, exactly like the Gateway does, so the
 * real `loadMasterState` runs end to end. The `remote` view answers `$mount` and throws on
 * every other property — the way the host's traced Remote service throws
 * `cannot get property "remote.orchestratorMaster" without inject` for a namespace the
 * plugin never declared. Any regression back to that property read fails loudly.
 */
function fakeCtx({ value, result, failFirstMount = false, remoteViaGet = false } = {}) {
  let namespace
  const mounts = []
  const remote = {
    $mount(contribution) {
      mounts.push(contribution)
      if (failFirstMount === true && mounts.length === 1) {
        return Promise.reject(new Error('the host is not ready yet'))
      }
      namespace = { masterState: async () => result ?? { ok: true, value } }
      return Promise.resolve(() => {})
    },
  }
  const guarded = new Proxy(remote, {
    get(target, prop) {
      if (prop === '$mount') return target.$mount.bind(target)
      throw new Error(`cannot get property "remote.${String(prop)}" without inject`)
    },
  })
  const ctx = {
    mounts,
    get(name) {
      if (name === 'remote.orchestratorMaster') return namespace
      if (name === 'remote' && remoteViaGet) return remote
      return undefined
    },
  }
  if (!remoteViaGet) ctx.remote = guarded
  return ctx
}

test('loadMasterState reads the namespace through ctx.get and mounts once', async () => {
  const { loadMasterState } = mod.__test
  const value = { enabled: true, byState: { Working: 1 }, workers: [{ id: 'w-1', role: 'worker', state: 'Working', summary: 'ok' }] }
  const ctx = fakeCtx({ value })

  assert.deepEqual(plain(await loadMasterState(ctx)), value)
  assert.deepEqual(plain(await loadMasterState(ctx)), value)
  assert.equal(ctx.mounts.length, 1, 'one mount serves every read')
  assert.equal(ctx.mounts[0].descriptors[0].id, 'dsh-orchestrator-master#orchestratorMaster/masterState')
})

test('the remote service is reachable through ctx.get as well as the injected property', async () => {
  const { loadMasterState } = mod.__test
  const value = { enabled: false, byState: {}, workers: [] }
  // No `remote` property at all: the service lookup alone has to carry the mount.
  const ctx = fakeCtx({ value, remoteViaGet: true })
  assert.deepEqual(plain(await loadMasterState(ctx)), value)
  assert.equal(ctx.mounts.length, 1)
})

test('an unavailable namespace is a clear error instead of a property read', async () => {
  const { loadMasterState } = mod.__test
  // $mount succeeds but installs nothing: ctx.get keeps answering undefined.
  const ctx = { mounts: [], remote: { $mount: async () => {} }, get: () => undefined }
  await assert.rejects(loadMasterState(ctx), /orchestratorMaster\/masterState is unavailable/)
})

test('a failed RemoteResult becomes a rejection with the host message', async () => {
  const { loadMasterState } = mod.__test
  const ctx = fakeCtx({ result: { ok: false, error: { message: 'projection is not ready' } } })
  await assert.rejects(loadMasterState(ctx), /projection is not ready/)
})

test('a failed mount is retried on the next read instead of being cached forever', async () => {
  const { loadMasterState } = mod.__test
  const ctx = fakeCtx({ value: { enabled: true, byState: {}, workers: [] }, failFirstMount: true })

  await assert.rejects(loadMasterState(ctx), /host is not ready yet/)
  assert.deepEqual(plain(await loadMasterState(ctx)), { enabled: true, byState: {}, workers: [] })
  assert.equal(ctx.mounts.length, 2, 'the rejection is not the cached answer for the rest of the page')
})

test('the panel reads through the real loader and the host mount, not an injected snapshot', async () => {
  const { MasterPanel, loadMasterState } = mod.__test
  const ctx = fakeCtx({
    value: {
      enabled: true,
      byState: { Working: 1 },
      workers: [{ id: 'w-1234567890', role: 'worker', state: 'Working', summary: 'from the remote endpoint' }],
    },
  })
  const scope = fakeScope({ initial: { masterPanelEnabled: true } })
  const view = mount(MasterPanel, { t, orch: scope, loadState: () => loadMasterState(ctx) })

  nodes(view.tree).find((node) => node.type === 'button').props.onClick()
  await flush(14)

  assert.equal(ctx.mounts.length, 1, 'the panel mounted the contribution itself')
  const text = textOf(view.tree)
  assert.match(text, /from the remote endpoint/)
  assert.match(text, /Working · 1/)
  view.unmount()
})

// ---- 秘书视图（票 07） -------------------------------------------------------------------
//
// The view reads the ticket-06 payload and nothing else. These cases mount the real components
// over the same hook shim the master-panel cases use, so a regression in the mapping, the empty
// state or the error path fails here instead of only in the browser.

/** A payload with one waiting session, one running one, a report and a conflict row. */
function secretaryPayload(overrides = {}) {
  return Object.assign(
    {
      enabled: true,
      registry: {
        masterSessionId: 'm-1',
        orchestrators: [
          { sessionId: 's-1', title: '构建视图', workspace: 'D:\\w', trackedAt: 1 },
          { sessionId: 's-2', title: '收尾', workspace: '', trackedAt: 2 },
        ],
        conflict: { masterSessionId: 'm-1', conflictingOrchestratorIds: ['s-9'] },
      },
      orchestrators: [
        {
          sessionId: 's-1',
          title: '构建视图',
          workspace: 'D:\\w',
          live: true,
          state: 'Needs input',
          step: { index: 2, total: 5, done: false },
          workers: [
            { id: 'w-1', state: 'Working', summary: '写测试' },
            { id: 'w-2', state: 'Idle', summary: '' },
          ],
          beats: { count: 3, startedAt: 1, capped: false, stoppedReason: null },
          lastReport: { path: 'r/1.md', at: 1700000000000, kind: 'delta' },
          lastError: null,
        },
        {
          sessionId: 's-2',
          title: '收尾',
          workspace: '',
          live: true,
          state: 'Working',
          step: { index: 1, total: 3, done: false },
          workers: [{ id: 'w-3', state: 'Working', summary: '整理提交' }],
          beats: { count: 1, startedAt: 2, capped: false, stoppedReason: null },
          lastReport: null,
          lastError: null,
        },
      ],
      reports: [
        {
          sessionId: 's-1',
          at: 1700000000000,
          kind: 'delta',
          path: 'r/1.md',
          bytes: 10,
          // Ticket 08: the endpoint sends the three groups lib/secretary-diff.js returns.
          changes: {
            completed: ['进度：第 3 步 / 共 5 步', '写测试：完成'],
            blocked: ['会话进入 Needs input'],
            flipped: ['会话：Idle → Working'],
          },
          error: null,
        },
      ],
      drafts: [],
      policy: {
        beatSeconds: 180,
        maxRunSeconds: 7200,
        notifyOn: { state: true, step: true, block: true, deliverable: true, timeout: true },
        promptText: '',
        reportsRoot: '.scratch/master-secretary/reports',
        viewReportLimit: 50,
      },
    },
    overrides,
  )
}

/** Mount the panel over the hook shim; the scope is enabled unless a case says otherwise. */
function mountSecretary({ payload = secretaryPayload(), loadState, scope, openSession, mutate, nudge } = {}) {
  return mount(mod.__test.SecretaryPanel, {
    t,
    orch: scope ?? fakeScope({ initial: { secretaryEnabled: true } }),
    loadState: loadState ?? (async () => payload),
    openSession,
    mutate,
    nudge,
  })
}

/** The node carrying a data-testid, or undefined. */
function byTestId(tree, id) {
  return nodes(tree).find((node) => node.props?.['data-testid'] === id)
}

/**
 * The tab panel's body. The shim renders one component per mount, so a child component stays an
 * element node here: its type is what a panel-level case can assert, and its own cases mount it
 * directly.
 */
function bodyOf(tree) {
  const panel = nodes(tree).find((node) => node.props?.role === 'tabpanel')
  return panel === undefined ? undefined : panel.kids[0]
}

test('the three tabs are the fixed vocabulary and both dictionaries label them', () => {
  const tabs = plain(T.secretaryTabsOf())
  assert.deepEqual(tabs.map((tab) => tab.id), ['overview', 'history', 'settings'])
  for (const tab of tabs) {
    for (const dict of [T.zh, T.en]) {
      assert.equal(typeof dict[tab.labelKey], 'string', tab.labelKey)
      assert.ok(dict[tab.labelKey].length > 0, tab.labelKey)
    }
  }
  // Both dictionaries carry the same secretary keys, so a language switch never shows a raw key.
  const zhKeys = Object.keys(T.zh)
    .filter((key) => key.startsWith('secretary.'))
    .sort()
  const enKeys = Object.keys(T.en)
    .filter((key) => key.startsWith('secretary.'))
    .sort()
  assert.deepEqual(zhKeys, enKeys)
  assert.ok(zhKeys.length > 40)
})

test('the secretary contribution declares the two draft transitions with one draftId each (why: ticket 08 adds a write seam)', () => {
  const descriptors = plain(T.SECRETARY_CONTRIBUTION.descriptors)
  assert.deepEqual(
    descriptors.map((descriptor) => descriptor.method),
    ['secretaryState', 'confirmDraft', 'discardDraft'],
  )
  for (const descriptor of descriptors.slice(1)) {
    assert.equal(descriptor.id, 'dsh-orchestrator-secretary#orchestratorSecretary/' + descriptor.method)
    assert.equal(descriptor.service, 'orchestratorSecretary')
    assert.equal(descriptor.namespace, 'orchestratorSecretary')
    assert.equal(descriptor.invocation.kind, 'direct')
    assert.deepEqual(descriptor.parameters, [{ name: 'draftId', source: 'json', codec: { mode: 'src-json' } }])
    assert.deepEqual(descriptor.result, { mode: 'src-json' })
  }
})

test('the secretary contribution mirrors the master one: src-json, zero parameters', () => {
  const [descriptor] = T.SECRETARY_CONTRIBUTION.descriptors
  assert.deepEqual(plain(descriptor.result), { mode: 'src-json' })
  assert.deepEqual(plain(descriptor.parameters), [])
  assert.equal(descriptor.id, 'dsh-orchestrator-secretary#orchestratorSecretary/secretaryState')
  assert.equal(descriptor.service, 'orchestratorSecretary')
  assert.equal(descriptor.namespace, 'orchestratorSecretary')
  assert.equal(descriptor.method, 'secretaryState')
})

test('the three tabs switch, keep aria-selected honest, and answer the arrow keys', async () => {
  const view = mountSecretary()
  await flush()
  const tab = (id) => byTestId(view.tree, 'orchestrator-secretary-tab-' + id)
  const panel = () => nodes(view.tree).find((node) => node.props?.role === 'tabpanel')

  assert.deepEqual(
    ['overview', 'history', 'settings'].map((id) => tab(id).props['aria-selected']),
    [true, false, false],
  )
  assert.equal(tab('overview').props.role, 'tab')
  assert.equal(nodes(view.tree).find((node) => node.props?.role === 'tablist') !== undefined, true)
  assert.equal(panel().props['aria-labelledby'], 'orchestrator-secretary-tab-overview')

  tab('history').props.onClick()
  assert.deepEqual(
    ['overview', 'history', 'settings'].map((id) => tab(id).props['aria-selected']),
    [false, true, false],
  )
  assert.equal(panel().props.id, 'orchestrator-secretary-panel-history')
  assert.equal(panel().props['aria-labelledby'], 'orchestrator-secretary-tab-history')

  // Left/right walk the strip and wrap at both ends; the focused tab is the selected one.
  tab('history').props.onKeyDown({ key: 'ArrowRight', preventDefault() {} })
  assert.equal(tab('settings').props['aria-selected'], true)
  tab('settings').props.onKeyDown({ key: 'ArrowRight', preventDefault() {} })
  assert.equal(tab('overview').props['aria-selected'], true)
  tab('overview').props.onKeyDown({ key: 'ArrowLeft', preventDefault() {} })
  assert.equal(tab('settings').props['aria-selected'], true)
  tab('settings').props.onKeyDown({ key: 'Home', preventDefault() {} })
  assert.equal(tab('overview').props['aria-selected'], true)
  tab('overview').props.onKeyDown({ key: 'End', preventDefault() {} })
  assert.equal(tab('settings').props['aria-selected'], true)
  // Any other key leaves the selection alone.
  tab('settings').props.onKeyDown({ key: 'a', preventDefault() {} })
  assert.equal(tab('settings').props['aria-selected'], true)
  view.unmount()
})

test('nothing registered renders the guide instead of a blank panel', async () => {
  const payload = secretaryPayload({
    registry: { masterSessionId: '', orchestrators: [], conflict: null },
    orchestrators: [],
    reports: [],
  })
  const view = mountSecretary({ payload })
  await flush()
  const empty = byTestId(view.tree, 'orchestrator-secretary-empty')
  assert.ok(empty, 'the empty state is a visible element')
  assert.match(textOf(empty), /secretary\.empty/)
  assert.equal(nodes(view.tree).some((node) => node.props?.role === 'alert'), false)
  // The tabs stay reachable: the copy points at the Settings tab, which must be clickable.
  byTestId(view.tree, 'orchestrator-secretary-tab-settings').props.onClick()
  assert.equal(byTestId(view.tree, 'orchestrator-secretary-empty'), undefined)
  assert.equal(bodyOf(view.tree).type, T.SecretarySettings)
  view.unmount()
})

test('a failed read is an alert with a retry, never a silent blank', async () => {
  let calls = 0
  const view = mountSecretary({
    loadState: async () => {
      calls += 1
      if (calls === 1) throw new Error('secretary endpoint is down')
      return secretaryPayload()
    },
  })
  await flush()
  const failed = byTestId(view.tree, 'orchestrator-secretary-failed')
  assert.ok(failed, 'the failure is rendered')
  assert.equal(failed.props.role, 'alert')
  assert.match(textOf(failed), /secretary\.failed/)
  assert.match(textOf(failed), /secretary endpoint is down/)
  const retry = byTestId(view.tree, 'orchestrator-secretary-retry')
  assert.ok(retry, 'the alert carries a retry')

  retry.props.onClick()
  await flush()
  assert.equal(calls, 2, 'the retry really reads the endpoint again')
  assert.equal(byTestId(view.tree, 'orchestrator-secretary-failed'), undefined)
  assert.equal(byTestId(view.tree, 'orchestrator-secretary-loading'), undefined)
  assert.equal(bodyOf(view.tree).type, T.SecretaryOverview)
  view.unmount()
})

test('the overview maps the payload to its blockers, its current run and its worker rows', () => {
  const opened = []
  const view = mount(T.SecretaryOverview, {
    t,
    payload: secretaryPayload(),
    width: 1200,
    openSession: (sessionId) => opened.push(sessionId),
  })
  const text = textOf(view.tree)

  // The waiting session is a blocker, and the conflict row is the warning above them.
  const blocker = byTestId(view.tree, 'orchestrator-secretary-blocker-s-1')
  assert.ok(blocker, 'a session waiting for input is a blocker')
  assert.match(textOf(blocker), /secretary\.reason\.needsInput/)
  assert.match(textOf(blocker), /构建视图/)
  assert.match(textOf(byTestId(view.tree, 'orchestrator-secretary-conflict')), /s-9/)

  // The current run is the Working row, with its step label and its worker table.
  const current = byTestId(view.tree, 'orchestrator-secretary-current')
  assert.match(textOf(current), /收尾/)
  assert.match(textOf(current), /1\/3/)
  const worker = byTestId(view.tree, 'orchestrator-secretary-worker-w-3')
  assert.ok(worker, 'the running session lists its workers')
  assert.match(textOf(worker), /整理提交/)
  assert.match(textOf(worker), /Working/)

  // The tracker tree carries both registered rows, grouped by workspace.
  assert.ok(byTestId(view.tree, 'orchestrator-secretary-row-s-1'))
  assert.ok(byTestId(view.tree, 'orchestrator-secretary-row-s-2'))
  assert.match(text, /secretary\.workspaceNone/)
  // A worker with no summary still gets a row, with the placeholder instead of an empty cell.
  const quiet = mount(T.SecretaryOverview, {
    t,
    width: 1200,
    payload: secretaryPayload({
      orchestrators: [
        {
          sessionId: 's-2',
          title: '收尾',
          live: true,
          state: 'Working',
          step: null,
          workers: [{ id: 'w-9', state: 'Idle', summary: '' }],
        },
      ],
    }),
  })
  assert.match(textOf(byTestId(quiet.tree, 'orchestrator-secretary-worker-w-9')), /secretary\.workerSummaryEmpty/)

  // A live row opens its session; the Master is marked in the tree.
  byTestId(view.tree, 'orchestrator-secretary-row-s-1').props.onClick()
  assert.deepEqual(opened, ['s-1'])
  // Without the host's uiWorkspace every jump is disabled instead of throwing.
  const noHost = mount(T.SecretaryOverview, { t, payload: secretaryPayload(), width: 1200 })
  assert.equal(byTestId(noHost.tree, 'orchestrator-secretary-row-s-1').props.disabled, true)
  assert.match(byTestId(noHost.tree, 'orchestrator-secretary-row-s-1').props.title, /secretary\.rowDisabled/)
  // An ended session keeps its row but cannot be opened.
  const ended = mount(T.SecretaryOverview, {
    t,
    width: 1200,
    openSession: () => {},
    payload: secretaryPayload({
      registry: { masterSessionId: '', orchestrators: [{ sessionId: 'gone', title: '旧的', workspace: '' }], conflict: null },
      orchestrators: [{ sessionId: 'gone', title: '旧的', live: false, state: 'Completed', step: null, workers: [] }],
    }),
  })
  assert.equal(byTestId(ended.tree, 'orchestrator-secretary-row-gone').props.disabled, true)
  assert.match(textOf(byTestId(ended.tree, 'orchestrator-secretary-row-gone')), /secretary\.ended/)
})

/** A pending draft card's payload row, ticket 08 shape. */
const PENDING_DRAFT = {
  id: 'd-1',
  sessionId: 's-1',
  reason: 'needs-input',
  text: '秘书催办：会话「s-1」正在等你确认。',
  status: 'pending',
  createdAt: 1,
  sentAt: null,
}

test('the blocker area renders the draft card and its two buttons call the nudge seam (why: a draft sends only on confirm)', async () => {
  const calls = []
  const refreshes = []
  const view = mount(T.SecretaryOverview, {
    t,
    payload: secretaryPayload({ drafts: [PENDING_DRAFT] }),
    width: 1200,
    nudge: (draftId, action) => {
      calls.push([draftId, action])
      return Promise.resolve({ delivered: true, draft: { id: draftId, status: 'sent', sentAt: 5 } })
    },
    refresh: () => refreshes.push(1),
  })

  const card = byTestId(view.tree, 'orchestrator-secretary-draft-d-1')
  assert.ok(card, 'a pending draft is a card in the blocker area')
  assert.match(textOf(card), /秘书催办：会话「s-1」/)
  assert.match(textOf(card), /secretary\.draft\.pending/)

  const confirm = byTestId(view.tree, 'orchestrator-secretary-draft-confirm-d-1')
  assert.equal(confirm.props.disabled, false)
  confirm.props.onClick()
  await flush()
  assert.deepEqual(calls, [['d-1', 'confirm']], 'the confirm button calls confirm with the draft id')
  assert.equal(refreshes.length, 1, 'a confirmed send re-reads the endpoint')

  byTestId(view.tree, 'orchestrator-secretary-draft-discard-d-1').props.onClick()
  await flush()
  assert.deepEqual(calls, [
    ['d-1', 'confirm'],
    ['d-1', 'discard'],
  ])
  assert.equal(refreshes.length, 2)
  view.unmount()
})

test('a refused send keeps the draft card pending and shows the reason (why: a failed send must not look sent)', async () => {
  const refreshes = []
  const view = mount(T.SecretaryOverview, {
    t,
    payload: secretaryPayload({ drafts: [PENDING_DRAFT] }),
    width: 1200,
    nudge: () =>
      Promise.resolve({ delivered: false, draft: { id: 'd-1', status: 'pending' }, reason: 'target-missing' }),
    refresh: () => refreshes.push(1),
  })

  byTestId(view.tree, 'orchestrator-secretary-draft-confirm-d-1').props.onClick()
  await flush()
  const error = byTestId(view.tree, 'orchestrator-secretary-draft-error-d-1')
  assert.ok(error, 'the reason is visible under the card')
  assert.equal(error.props.role, 'alert')
  assert.match(textOf(error), /target-missing/)
  assert.ok(byTestId(view.tree, 'orchestrator-secretary-draft-confirm-d-1'), 'the draft is still there')
  assert.equal(refreshes.length, 0, 'a failed send does not refresh as if it worked')
})

test('a sent draft shows when it was sent, and a discarded one offers no buttons', () => {
  const view = mount(T.SecretaryOverview, {
    t,
    width: 1200,
    payload: secretaryPayload({
      drafts: [
        { id: 'd-sent', sessionId: 's-1', status: 'sent', text: '已发送的正文', createdAt: 1, sentAt: 1700000000000 },
        { id: 'd-gone', sessionId: 's-1', status: 'discarded', text: '丢弃的正文', createdAt: 2 },
      ],
    }),
  })
  const sent = byTestId(view.tree, 'orchestrator-secretary-draft-d-sent')
  assert.match(textOf(sent), /secretary\.draft\.sentAt/)
  assert.equal(byTestId(view.tree, 'orchestrator-secretary-draft-confirm-d-sent'), undefined)
  const gone = byTestId(view.tree, 'orchestrator-secretary-draft-d-gone')
  assert.match(textOf(gone), /secretary\.draft\.discarded/)
  assert.equal(byTestId(view.tree, 'orchestrator-secretary-draft-confirm-d-gone'), undefined)
})

test('the panel hands the overview the nudge seam and its refresh re-reads the endpoint', async () => {
  let loads = 0
  const nudges = []
  const view = mountSecretary({
    payload: secretaryPayload({ drafts: [PENDING_DRAFT] }),
    loadState: async () => {
      loads += 1
      return secretaryPayload({ drafts: [PENDING_DRAFT] })
    },
    nudge: (draftId, action) => {
      nudges.push([draftId, action])
      return Promise.resolve({ delivered: true, draft: { id: draftId, status: 'sent', sentAt: 5 } })
    },
  })
  await flush()
  const body = bodyOf(view.tree)
  assert.equal(body.type, T.SecretaryOverview)
  assert.equal(typeof body.props.nudge, 'function')
  assert.equal(typeof body.props.refresh, 'function')

  body.props.refresh()
  await flush()
  assert.equal(loads, 2, 'the refresh callback re-reads the endpoint')
  assert.deepEqual(nudges, [])
  view.unmount()
})

test('the blockers and the tracker rows come from the payload, not from the view', () => {
  const payload = secretaryPayload()
  const blockers = plain(T.secretaryBlockersOf(payload))
  assert.deepEqual(
    blockers.map((blocker) => [blocker.sessionId, blocker.reason]),
    [['s-1', 'needsInput']],
  )
  // A loud failure and a stopped beat are blockers too; a pending draft is one as well.
  const more = plain(
    T.secretaryBlockersOf({
      orchestrators: [
        { sessionId: 'x', title: '坏掉的', state: 'Idle', lastError: 'boom', beats: { capped: false } },
        { sessionId: 'y', title: '超时的', state: 'Idle', lastError: null, beats: { capped: true, stoppedReason: '达到上限' } },
        { sessionId: 'z', title: '安静的', state: 'Idle', lastError: null, beats: { capped: false } },
      ],
      drafts: [
        { id: 'd-1', sessionId: 'x', reason: '等待拍板', text: '等你拍板', status: 'pending' },
        { id: 'd-2', sessionId: 'x', reason: '已发过', status: 'sent' },
      ],
    }),
  )
  assert.deepEqual(
    more.map((blocker) => [blocker.sessionId, blocker.reason]),
    [
      ['x', 'error'],
      ['y', 'capped'],
      ['x', 'draft'],
    ],
  )
  assert.equal(more[0].text, 'boom')
  assert.equal(more[1].text, '达到上限')
  assert.equal(more[2].text, '等你拍板', 'a draft blocker carries the generated body')

  const rows = plain(T.secretaryRowsOf(payload))
  assert.deepEqual(
    rows.map((row) => [row.sessionId, row.state, row.live, row.stepLabel]),
    [
      ['s-1', 'Needs input', true, '2/5'],
      ['s-2', 'Working', true, '1/3'],
    ],
  )
  assert.deepEqual(rows[0].workers.map((worker) => worker.id), ['w-1', 'w-2'])
  assert.equal(rows[0].lastReportAt, 1700000000000)
  // A registered session with no live row keeps its place, ended and idle.
  const ended = plain(T.secretaryRowsOf({ registry: { orchestrators: [{ sessionId: 'gone', title: '旧的' }] }, orchestrators: [] }))
  assert.deepEqual([ended[0].state, ended[0].live], ['Idle', false])
  // A missing segment is no rows, never a throw.
  assert.deepEqual(plain(T.secretaryRowsOf(undefined)), [])
  assert.deepEqual(plain(T.secretaryBlockersOf(undefined)), [])
  assert.deepEqual(plain(T.reportLinesOf(undefined)), [])
  assert.deepEqual(plain(T.draftRowsOf(undefined)), [])
})

test('the history tab groups the newest report and lists the timeline (why: it reads the structured changes field)', () => {
  const view = mount(T.SecretaryHistory, { t, payload: secretaryPayload() })
  const diff = byTestId(view.tree, 'orchestrator-secretary-diff')
  const text = textOf(diff)
  assert.match(text, /secretary\.diff\.completed/)
  assert.match(text, /secretary\.diff\.blocked/)
  assert.match(text, /secretary\.diff\.flipped/)
  assert.match(text, /进度：第 3 步 \/ 共 5 步/)
  assert.match(text, /会话进入 Needs input/)
  assert.match(text, /会话：Idle → Working/)
  // The structured payload has no unclassified group, so "other" is not rendered.
  assert.equal(text.includes('secretary.diff.other'), false, 'the structured diff needs no fallback bucket')
  const timeline = byTestId(view.tree, 'orchestrator-secretary-timeline')
  assert.match(textOf(timeline), /secretary\.reportKind\.delta/)
  assert.match(textOf(timeline), /r\/1\.md/)
  view.unmount()
})

test('diffGroupsOf separates the writer shapes and keeps the unknown ones', () => {
  const groups = plain(
    T.diffGroupsOf(['进度：第 2 步 / 共 5 步', '产出：a.md', 'worker：完成', 'worker：等确认', '会话进入 Needs input', 'worker：Idle → Working', '别的话']),
  )
  assert.deepEqual(groups.completed, ['进度：第 2 步 / 共 5 步', '产出：a.md', 'worker：完成'])
  assert.deepEqual(groups.blocked, ['worker：等确认', '会话进入 Needs input'])
  assert.deepEqual(groups.flipped, ['worker：Idle → Working'])
  assert.deepEqual(groups.other, ['别的话'])
})

test('a legacy flat diff is grouped by the fallback, marked degraded, and the settings tab says so (why: an older host still sends strings)', () => {
  // A host that predates the structured field answers the old flat list. The page must keep
  // rendering it — and flag it, so a missing group is never mistaken for "no change".
  const legacy = secretaryPayload({
    reports: [
      {
        sessionId: 's-1',
        at: 1,
        kind: 'delta',
        path: 'r/1.md',
        bytes: 1,
        changes: ['写测试：完成', 'worker：等确认', 'worker：Idle → Working'],
        error: null,
      },
    ],
  })
  const lines = plain(T.reportLinesOf(legacy))
  assert.deepEqual(lines[0].changes, {
    completed: ['写测试：完成'],
    blocked: ['worker：等确认'],
    flipped: ['worker：Idle → Working'],
    other: [],
  })
  assert.equal(lines[0].degraded, true, 'the fallback is visible, not silent')
  assert.equal(plain(T.reportLinesOf(secretaryPayload()))[0].degraded, false, 'the structured field is not degraded')

  // The history tab still shows the recovered groups...
  const history = mount(T.SecretaryHistory, { t, payload: legacy })
  const diff = textOf(byTestId(history.tree, 'orchestrator-secretary-diff'))
  assert.match(diff, /worker：等确认/)
  assert.match(diff, /worker：Idle → Working/)
  // ...and the settings tab carries the one-line notice.
  const scope = fakeScope()
  const settings = mount(T.SecretarySettings, { t, orch: scope, payload: legacy, mutate: scope.mutate })
  assert.match(textOf(byTestId(settings.tree, 'orchestrator-secretary-degraded')), /secretary\.degraded/)
  const cleanScope = fakeScope()
  const clean = mount(T.SecretarySettings, { t, orch: cleanScope, payload: secretaryPayload(), mutate: cleanScope.mutate })
  assert.equal(byTestId(clean.tree, 'orchestrator-secretary-degraded'), undefined)
})

test('the layout is two columns at 1100 and scrolls only inside the list regions', () => {
  const wide = T.secretaryStyleOf(1100)
  assert.equal(wide.wide, true)
  assert.match(wide.columns.gridTemplateColumns, /^minmax\(0, 2fr\) minmax\(0, 1fr\)$/)
  assert.equal(wide.root.height, '100%')
  assert.equal(wide.root.overflow, 'hidden')
  assert.equal(wide.listOverflow.overflowY, 'auto')
  const narrow = T.secretaryStyleOf(1099)
  assert.equal(narrow.wide, false)
  assert.equal(narrow.columns.gridTemplateColumns, 'minmax(0, 1fr)')
  assert.equal(T.secretaryStyleOf(undefined).wide, false)
  assert.equal(T.secretaryStyleOf(Number.NaN).wide, false)
})

test('the settings tab shows the policy numbers the payload carries', () => {
  const render = (policy) => {
    const scope = fakeScope()
    const view = mount(T.SecretarySettings, { t, orch: scope, payload: secretaryPayload({ policy }), mutate: scope.mutate })
    return {
      view,
      field: (key) => byTestId(view.tree, 'orchestrator-secretary-field-' + key),
      scope,
    }
  }
  const first = render({
    beatSeconds: 180,
    maxRunSeconds: 7200,
    notifyOn: { state: true, step: false, block: true, deliverable: false, timeout: true },
    promptText: '口径一',
    reportsRoot: 'r',
    viewReportLimit: 50,
  })
  assert.equal(first.field('beatSeconds').props.value, '180')
  assert.equal(first.field('maxRunSeconds').props.value, '7200')
  assert.equal(byTestId(first.view.tree, 'orchestrator-secretary-prompt').props.value, '口径一')
  assert.equal(byTestId(first.view.tree, 'orchestrator-secretary-notify-state').props.checked, true)
  assert.equal(byTestId(first.view.tree, 'orchestrator-secretary-notify-step').props.checked, false)

  // A second profile with different numbers renders those numbers: nothing is hardcoded.
  const second = render({
    beatSeconds: 300,
    maxRunSeconds: 900,
    notifyOn: { state: true, step: true, block: true, deliverable: true, timeout: true },
    promptText: '',
    reportsRoot: 'r',
    viewReportLimit: 50,
  })
  assert.equal(second.field('beatSeconds').props.value, '300')
  assert.equal(second.field('maxRunSeconds').props.value, '900')
})

test('a policy edit writes the one key with the snapshot revision', async () => {
  const scope = fakeScope()
  const view = mount(T.SecretarySettings, { t, orch: scope, payload: secretaryPayload(), mutate: scope.mutate })
  const field = () => byTestId(view.tree, 'orchestrator-secretary-field-beatSeconds')
  field().props.onChange({ target: { value: '300' } })
  await field().props.onBlur()
  await flush()
  assert.deepEqual(plain(scope.calls[0].ops), [{ op: 'set', path: ['beatSeconds'], value: 300 }])
  assert.equal(scope.calls[0].expected, 1)
  assert.equal(field().props.value, '300')

  // Junk is rejected without a write and explained inside the tab.
  field().props.onChange({ target: { value: '0' } })
  await field().props.onBlur()
  await flush()
  assert.equal(scope.calls.length, 1)
  assert.match(textOf(byTestId(view.tree, 'orchestrator-secretary-settings-error')), /secretary\.invalidNumber/)
})

test('a rejected settings write stays in the tab instead of escaping as a toast', async () => {
  const scope = fakeScope({ reject: 'settings changed since it was read' })
  const view = mount(T.SecretarySettings, { t, orch: scope, payload: secretaryPayload(), mutate: scope.mutate })
  const notify = byTestId(view.tree, 'orchestrator-secretary-notify-step')
  notify.props.onChange()
  await flush()
  const error = byTestId(view.tree, 'orchestrator-secretary-settings-error')
  assert.equal(error.props.role, 'alert')
  assert.match(textOf(error), /settings changed/)
  // The switch still reflects the stored payload: a failed write does not invent a value.
  assert.equal(byTestId(view.tree, 'orchestrator-secretary-notify-step').props.checked, true)
})

test('registering, unregistering and designating the Master each write the ticket ops', async () => {
  const scope = fakeScope()
  const view = mount(T.SecretarySettings, { t, orch: scope, payload: secretaryPayload(), mutate: scope.mutate })
  byTestId(view.tree, 'orchestrator-secretary-register-id').props.onChange({ target: { value: 's-3' } })
  byTestId(view.tree, 'orchestrator-secretary-register-title').props.onChange({ target: { value: '新会话' } })
  byTestId(view.tree, 'orchestrator-secretary-register').props.onClick()
  await flush()
  const registered = plain(scope.calls[0].ops[0])
  assert.deepEqual(registered.path, ['secretaryOrchestrators', '2'])
  assert.equal(registered.op, 'set')
  assert.equal(registered.value.sessionId, 's-3')
  assert.equal(registered.value.title, '新会话')
  assert.equal(typeof registered.value.trackedAt, 'number')

  byTestId(view.tree, 'orchestrator-secretary-unregister-s-1').props.onClick()
  await flush()
  assert.deepEqual(plain(scope.calls[1].ops), [{ op: 'unset', path: ['secretaryOrchestrators', '0'] }])

  byTestId(view.tree, 'orchestrator-secretary-setmaster-s-2').props.onClick()
  await flush()
  // The new Master, its row removed, and the old conflict row unset — all in one mutate.
  assert.deepEqual(plain(scope.calls[2].ops), [
    { op: 'set', path: ['secretaryMasterSessionId'], value: 's-2' },
    { op: 'unset', path: ['secretaryOrchestrators', '1'] },
  ])
})

test('the switch off renders its own state, reads nothing, and can be turned on', async () => {
  const scope = fakeScope({ initial: { secretaryEnabled: false } })
  let loads = 0
  const view = mount(mod.__test.SecretaryPanel, {
    t,
    orch: scope,
    loadState: async () => {
      loads += 1
      return secretaryPayload()
    },
    mutate: scope.mutate,
  })
  await flush()
  assert.ok(byTestId(view.tree, 'orchestrator-secretary-disabled'))
  assert.equal(loads, 0, 'a disabled view never calls the endpoint')
  byTestId(view.tree, 'orchestrator-secretary-enable').props.onClick()
  await flush()
  assert.deepEqual(plain(scope.calls[0].ops), [{ op: 'set', path: ['secretaryEnabled'], value: true }])
})

test('the sidebar glyph is decorative: no second button inside the row', () => {
  const view = mount(T.SecretaryIcon, { size: 16 })
  assert.equal(view.tree.type, 'svg')
  assert.equal(view.tree.props['aria-hidden'], 'true')
  assert.equal(view.tree.props.width, 16)
  assert.equal(nodes(view.tree).filter((node) => node.type === 'button').length, 0)
  // The default edge keeps the icon sane when the host passes no size.
  assert.equal(mount(T.SecretaryIcon, {}).tree.props.width, 18)
})

test('the icon and the main panel share one id so the sidebar row can select it', () => {
  const regs = []
  const scopes = { orch: { ns: 'orchestrator' } }
  const selected = []
  const opened = []
  const ctx = {
    effect: (fn) => fn(),
    locale: { register: () => {}, bind: () => (key) => key },
    configForms: { get: () => ({ ...scopes.orch, getSnapshot: () => ({ status: 'ready', writable: true, revision: 1, value: {} }) }) },
    remote: { commands: { execute: async () => ({ ok: true, value: 'x' }) }, session: { modelCatalog: async () => ({ ok: true, value: { groups: [] } }) } },
    get(name) {
      if (name === 'uiWorkspace') return { openSession: (id) => opened.push(id) }
      if (name === 'layout') return { selectPanel: (id) => selected.push(id) }
      return undefined
    },
    slots: { inject: (_name, cb) => cb(), register: (opts, component) => regs.push({ opts, component }) },
  }
  mod.apply(ctx)
  const main = regs.find((reg) => reg.opts.name === 'main')
  const icon = regs.find((reg) => reg.opts.name === 'sidebar.panellist')
  assert.equal(main.opts.key, 'secretary')
  assert.equal(icon.opts.id, main.opts.key)
  assert.equal(icon.opts.order, 40)
  assert.equal(icon.opts.locale, 'orchestrator')
  assert.equal(icon.opts.label(), 'secretary.label')
  assert.equal(icon.component, T.SecretaryIcon)

  const props = main.opts.inject()
  assert.equal(props.orch.ns, 'orchestrator')
  assert.equal(typeof props.loadState, 'function')
  assert.equal(typeof props.mutate, 'function')
  // Opening a row leaves the panel seat first, then opens the session.
  props.openSession('s-1')
  assert.deepEqual(selected, [null])
  assert.deepEqual(opened, ['s-1'])
})

/**
 * A stand-in client ctx for the secretary endpoint: ctx.get answers the namespace once $mount
 * installed it, and the injected remote property throws on every other read, exactly like the
 * host's traced Remote service.
 */
function fakeSecretaryCtx({ value, result, nudgeResult, failFirstMount = false, remoteViaGet = false } = {}) {
  let namespace
  const mounts = []
  const nudgeCalls = []
  const remote = {
    $mount(contribution) {
      mounts.push(contribution)
      if (failFirstMount === true && mounts.length === 1) {
        return Promise.reject(new Error('the host is not ready yet'))
      }
      namespace = {
        secretaryState: async () => result ?? { ok: true, value },
        confirmDraft: async (draftId) => {
          nudgeCalls.push(['confirm', draftId])
          return nudgeResult ?? { ok: true, value: { delivered: true, draft: { id: draftId, status: 'sent', sentAt: 5 } } }
        },
        discardDraft: async (draftId) => {
          nudgeCalls.push(['discard', draftId])
          return nudgeResult ?? { ok: true, value: { draft: { id: draftId, status: 'discarded' } } }
        },
      }
      return Promise.resolve(() => {})
    },
  }
  const guarded = new Proxy(remote, {
    get(target, prop) {
      if (prop === '$mount') return target.$mount.bind(target)
      throw new Error('cannot get property "remote.' + String(prop) + '" without inject')
    },
  })
  const ctx = {
    mounts,
    nudgeCalls,
    get(name) {
      if (name === 'remote.orchestratorSecretary') return namespace
      if (name === 'remote' && remoteViaGet) return remote
      return undefined
    },
  }
  if (!remoteViaGet) ctx.remote = guarded
  return ctx
}

test('loadSecretaryState reads through ctx.get and mounts the contribution once', async () => {
  const { loadSecretaryState } = mod.__test
  const value = secretaryPayload()
  const ctx = fakeSecretaryCtx({ value })
  assert.deepEqual(plain(await loadSecretaryState(ctx)), plain(value))
  assert.deepEqual(plain(await loadSecretaryState(ctx)), plain(value))
  assert.equal(ctx.mounts.length, 1, 'one mount serves every read')
  assert.equal(ctx.mounts[0].descriptors[0].id, 'dsh-orchestrator-secretary#orchestratorSecretary/secretaryState')
})

test('the secretary namespace is also reachable through ctx.get("remote")', async () => {
  const { loadSecretaryState } = mod.__test
  const ctx = fakeSecretaryCtx({ value: secretaryPayload(), remoteViaGet: true })
  assert.deepEqual(plain(await loadSecretaryState(ctx)).enabled, true)
  assert.equal(ctx.mounts.length, 1)
})

test('an unavailable secretary namespace and a failed result both reject', async () => {
  const { loadSecretaryState } = mod.__test
  const unavailable = { mounts: [], remote: { $mount: async () => {} }, get: () => undefined }
  await assert.rejects(loadSecretaryState(unavailable), /orchestratorSecretary\/secretaryState is unavailable/)
  const failed = fakeSecretaryCtx({ result: { ok: false, error: { message: 'projection is not ready' } } })
  await assert.rejects(loadSecretaryState(failed), /projection is not ready/)
})

test('loadNudge confirms and discards through the mounted namespace (why: the card buttons need one write seam)', async () => {
  const { loadNudge } = mod.__test
  const ctx = fakeSecretaryCtx({ value: secretaryPayload() })

  const confirmed = await loadNudge(ctx, 'd-1', 'confirm')
  assert.equal(confirmed.delivered, true)
  const discarded = await loadNudge(ctx, 'd-1', 'discard')
  assert.equal(discarded.draft.status, 'discarded')
  assert.deepEqual(ctx.nudgeCalls, [
    ['confirm', 'd-1'],
    ['discard', 'd-1'],
  ])
  assert.equal(ctx.mounts.length, 1, 'one mount serves the read and both writes')
  // An action the endpoint does not have is refused before any call is made.
  await assert.rejects(loadNudge(ctx, 'd-1', 'later'), /unknown nudge action/)
  assert.equal(ctx.nudgeCalls.length, 2)
})

test('a failed nudge result becomes a rejection with the host message', async () => {
  const ctx = fakeSecretaryCtx({
    value: secretaryPayload(),
    nudgeResult: { ok: false, error: { message: 'draft is gone' } },
  })
  await assert.rejects(mod.__test.loadNudge(ctx, 'd-1', 'confirm'), /draft is gone/)
})

test('a failed mount is retried on the next read instead of poisoning the panel', async () => {
  const { loadSecretaryState } = mod.__test
  const ctx = fakeSecretaryCtx({ value: secretaryPayload(), failFirstMount: true })
  await assert.rejects(loadSecretaryState(ctx), /host is not ready yet/)
  assert.deepEqual(plain(await loadSecretaryState(ctx)).enabled, true)
  assert.equal(ctx.mounts.length, 2)
})

test('the panel reads through the real loader and the host mount', async () => {
  const { SecretaryPanel, loadSecretaryState } = mod.__test
  const ctx = fakeSecretaryCtx({ value: secretaryPayload() })
  const scope = fakeScope({ initial: { secretaryEnabled: true } })
  const view = mount(SecretaryPanel, { t, orch: scope, loadState: () => loadSecretaryState(ctx) })
  await flush(14)
  assert.equal(ctx.mounts.length, 1, 'the view mounted the contribution itself')
  assert.equal(byTestId(view.tree, 'orchestrator-secretary-loading'), undefined)
  assert.equal(bodyOf(view.tree).type, T.SecretaryOverview)
  // The payload the endpoint answered is what the body was handed.
  assert.equal(bodyOf(view.tree).props.payload.registry.orchestrators.length, 2)
  view.unmount()
})
test('the first render is a loading line and polling stops on unmount', async () => {
  // A read that has not answered yet is one loading line, not a blank frame.
  const pending = mountSecretary({ loadState: () => new Promise(() => {}) })
  assert.ok(byTestId(pending.tree, 'orchestrator-secretary-loading'))
  assert.equal(byTestId(pending.tree, 'orchestrator-secretary-failed'), undefined)
  pending.unmount()

  let calls = 0
  const view = mountSecretary({
    loadState: async () => {
      calls += 1
      return secretaryPayload()
    },
  })
  await flush()
  assert.equal(calls, 1)
  const timer = timers[timers.length - 1]
  assert.equal(timer.ms, T.SECRETARY_POLL_MS, 'the view re-reads on one slow cadence')
  view.unmount()
  timer.fn()
  await flush()
  assert.equal(calls, 1, 'an unmounted view never reads again')
})

test('every tab survives a payload with no segments', () => {
  for (const component of [T.SecretaryOverview, T.SecretaryHistory]) {
    const bare = mount(component, { t, payload: {}, width: 0 })
    assert.ok(bare.tree, component.name)
    assert.equal(nodes(bare.tree).some((node) => node.props?.role === 'alert'), false, component.name)
  }
  const scope = fakeScope()
  const settings = mount(T.SecretarySettings, { t, orch: scope, payload: {}, mutate: scope.mutate })
  assert.ok(byTestId(settings.tree, 'orchestrator-secretary-policy'))
  assert.ok(byTestId(settings.tree, 'orchestrator-secretary-binding'))
})


