import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { z } from 'zod'
import { WORKER_STATE } from '../lib/master-state.js'
import { NOTIFY_SWITCHES } from '../lib/secretary-constants.js'
import { DISPATCH_COMMAND } from '../lib/secretary-authority.js'
import * as panelSurface from '../lib/panel-surface.js'

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

let mod
const timers = []
// 清扫的定时器走 setInterval；测试手动打一拍，别让真实时间参与。
const intervals = []
// A stand-in browser: the row measures its own box and the window height before it opens
// the model list, and listens for scroll and resize while it is open.
const fakeWindow = {
  __ModuleLoader__: {
    load: (def) => {
      mod = def.factory((id) => {
        if (id === 'react') return React
        // The web loader resolves 'zod' for every client bundle that asks (api-remotes does),
        // so the plugin's codec factory may require it by the same id.
        if (id === 'zod') return { z }
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
// hidden 是这个共享对象上的一个开关：bundle 读的是它，测试改的也是它。
const fakeDocument = { listeners: [], hidden: false, addEventListener() {}, removeEventListener() {} }
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
  setInterval: (fn, ms) => {
    const timer = { fn, ms }
    intervals.push(timer)
    return timer
  },
  clearInterval: (timer) => {
    const at = intervals.indexOf(timer)
    if (at !== -1) intervals.splice(at, 1)
  },
})
const T = mod.__test
const t = (k) => k
function mountField(scope) {
  const view = mount(mod.__test.SuperviseIntervalField, { scope, t })
  return {
    view,
    input: () => nodes(view.tree).find((node) => node.type === 'input'),
    alert: () => nodes(view.tree).find((node) => node.props?.role === 'alert'),
  }
}

/** 巡检「每次上限」字段：与间隔共用同一个组件，只是 setting / keys / testid 不同。 */
function mountMaxNoticesField(scope) {
  const view = mount(mod.__test.SuperviseIntervalField, {
    scope,
    t,
    setting: mod.__test.MAX_NOTICES,
    keys: { label: 'supervise.maxLabel', hint: 'supervise.maxHint', invalid: 'supervise.maxInvalid' },
    testid: 'orchestrator-supervise-max',
  })
  return {
    view,
    input: () => nodes(view.tree).find((node) => node.type === 'input'),
    alert: () => nodes(view.tree).find((node) => node.props?.role === 'alert'),
  }
}
// Values built inside the vm context have another Object.prototype; compare them as plain JSON.
const plain = (v) => JSON.parse(JSON.stringify(v))

test('the client mirrors the shared worker-state and notify vocabularies exactly', () => {
  // The client bundle cannot import a server module, so lib/client.js keeps a copy of each
  // vocabulary. The copy is only safe while its keys, values and order match the server's.
  for (const [mirror, server] of [
    [T.WORKER_STATE, WORKER_STATE],
    [T.SECRETARY_NOTIFY_NAMES, NOTIFY_SWITCHES],
  ]) {
    const copy = plain(mirror)
    assert.deepEqual(Object.keys(copy), Object.keys(server))
    assert.deepEqual(Object.values(copy), Object.values(server))
  }
})
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

test('apply leaves only the plan toggle in the composer, registers the smaller settings page, and keeps the secretary seats', () => {
  const regs = []
  const ctx = {
    effect: (fn) => fn(),
    locale: { register: () => {}, bind: () => (key) => key },
    configForms: { get: (ns) => ({ ns }) },
    remote: {
      commands: { execute: async () => ({ ok: true, value: 'x' }) },
      session: { modelCatalog: async () => ({ ok: true, value: { groups: [] } }) },
    },
    get: () => undefined,
    slots: { inject: (_n, cb) => cb(), register: (opts, comp) => regs.push({ opts, comp }) },
  }
  mod.apply(ctx)
  assert.deepEqual(regs.map((r) => [r.opts.name, r.opts.id, r.opts.order]), [
    // The composer keeps one plugin control: the plan toggle.
    ['conversation.input.left', 'orchestrator-plan-toggle', 20],
    // 票 15：设置页座位保留（内容只剩白名单 / 巡检 / 权限），标题走新键。
    ['settings.section', 'orchestrator', 30],
    // The secretary view: one keyless-identity registration into the main seat, then the sidebar
    // row that selects it by the same id.
    ['main', undefined, undefined],
    ['sidebar.panellist', 'secretary', 40],
  ])
  // Ticket 10 retired the legacy master panel: no slot carries its id any more.
  assert.equal(regs.some((r) => r.opts.id === 'orchestrator-master-panel'), false)
  assert.deepEqual(
    regs.filter((r) => r.opts.id === 'secretary' || r.opts.key === 'secretary').map((r) => r.opts.name),
    ['main', 'sidebar.panellist'],
  )
  // The settings seat is back, but its page is the smaller one: new title key, one config scope.
  const settings = regs.find((r) => r.opts.name === 'settings.section')
  assert.equal(settings.opts.id, 'orchestrator')
  assert.equal(settings.opts.order, 30)
  assert.equal(settings.opts.locale, 'orchestrator')
  assert.equal(settings.opts.label(), 'assistant.settings.title')
  assert.equal(settings.comp, T.AssistantSettingsSection)
  assert.deepEqual(Object.keys(settings.opts.inject()), ['orch'])
  // The old dispatch-mode page is still gone: no enable switch, no routes, no Master picker in it.
  for (const symbol of ['section.title', 'route.enable', 'SessionPicker', 'OrchestratorSettingsSection']) {
    assert.equal(src.includes(symbol), false, symbol + ' must stay deleted')
  }
  // The composer's plugin controls are down to the plan toggle.
  const composer = regs.filter((r) => String(r.opts.name).startsWith('conversation.input.'))
  assert.deepEqual(
    composer.map((r) => [r.opts.name, r.opts.id]),
    [['conversation.input.left', 'orchestrator-plan-toggle']],
  )
  assert.equal(regs.some((r) => r.opts.name === 'conversation.input.right'), false)
  assert.equal(regs.some((r) => r.opts.id === 'orchestrator-route-picker'), false)
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

// ---- Allowed tools ------------------------------------------------------------------

// The panel cannot ask the host for a tool catalog (the session remote has no such
// method), so it re-declares the shipped whitelist. Reading the host constant out of the
// source keeps the two copies honest without loading the host entry, whose packages
// this test process does not install.
const hostSource = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const hostListSource = /export const DEFAULT_ALLOWED_TOOLS = \[([\s\S]*?)\]/.exec(hostSource)
// Strip `//` comments first: an apostrophe inside a comment ("the agent's surface")
// would otherwise pair with a real string quote and skew the extraction.
const hostListBody = hostListSource[1].replace(/\/\/[^\n]*/g, '')
const HOST_DEFAULT_ALLOWED_TOOLS = [...hostListBody.matchAll(/'([^']+)'/g)].map((match) => match[1])

test('the bundled copy of the shipped whitelist matches the host constant', () => {
  assert.deepEqual(plain(T.DEFAULT_ALLOWED_TOOLS), HOST_DEFAULT_ALLOWED_TOOLS)
  assert.equal(HOST_DEFAULT_ALLOWED_TOOLS.length, 11)
  // The whitelist names the planning and delegation tools only: no file, search, shell or
  // web tool may appear here, or the main agent could work on the repo by itself.
  for (const name of ['dispatch', 'send_message', 'interrupt_agent', 'todo_write', 'ask_user_question', 'compress']) {
    assert.equal(HOST_DEFAULT_ALLOWED_TOOLS.includes(name), true, name)
  }
  for (const name of ['read', 'edit', 'write', 'bash', 'subagent', 'workflow', 'ralph', 'decompress', 'search_context']) {
    assert.equal(HOST_DEFAULT_ALLOWED_TOOLS.includes(name), false, name)
  }
})

test('the rows start with the shipped whitelist, every box checked', () => {
  const shown = plain(T.toolListOf({}))
  assert.deepEqual(shown, HOST_DEFAULT_ALLOWED_TOOLS)
  // A host tool the whitelist omits is not a row until the host catalog names it.
  for (const name of ['read', 'edit', 'bash', 'subagent', 'workflow']) {
    assert.equal(shown.includes(name), false, name)
  }
  const withCatalog = plain(T.toolListOf({ toolCatalog: ['edit', 'read'] }))
  for (const name of ['edit', 'read']) assert.equal(withCatalog.includes(name), true, name)
})

test('config and catalog names join the rows as extras, after the shipped order and sorted', () => {
  const shown = plain(T.toolListOf({ allowedTools: ['zeta', 'alpha'], toolCatalog: ['read'] }))
  assert.deepEqual(shown.slice(0, HOST_DEFAULT_ALLOWED_TOOLS.length), HOST_DEFAULT_ALLOWED_TOOLS)
  assert.deepEqual(shown.slice(-3), ['alpha', 'read', 'zeta'])
  assert.equal(new Set(shown).size, shown.length)
  // A name a profile checked is offered like any other, whatever it is called.
  assert.equal(plain(T.toolListOf({ allowedTools: ['custom_tool'] })).includes('custom_tool'), true)
})

test('the live catalog from the host joins the rows, deduped and sorted after the shipped list', () => {
  const shown = plain(T.toolListOf({ toolCatalog: ['zeta', 'mcp__github__create_issue', 'edit', 'read'] }))
  // A catalog name the whitelist does not know becomes one extra row, once only.
  assert.equal(shown.filter((name) => name === 'edit').length, 1)
  assert.equal(shown.filter((name) => name === 'dispatch').length, 1)
  assert.deepEqual(shown.slice(-4), ['edit', 'mcp__github__create_issue', 'read', 'zeta'])
  // A delegation tool the catalog names is a row like any other, once only.
  assert.equal(plain(T.toolListOf({ toolCatalog: ['delegate'] })).filter((name) => name === 'delegate').length, 1)
})

test('a tool the shipped whitelist never heard of is a row and defaults to disabled', () => {
  const catalog = { toolCatalog: ['mcp__demo__ping', 'ops_new'] }
  const shown = plain(T.toolListOf(catalog))
  assert.ok(shown.includes('mcp__demo__ping'))
  assert.ok(shown.includes('ops_new'))
  // Unchecked, i.e. not allowed: a tool another plugin adds is blocked until the user
  // checks it, which is what makes the whitelist a default-deny rule for new tools too.
  const allowed = T.allowedSetOf(catalog)
  assert.equal(allowed.has('mcp__demo__ping'), false)
  assert.equal(allowed.has('ops_new'), false)
  // Once checked, the panel writes the name and the row reads checked.
  const checked = T.allowedSetOf({ ...catalog, allowedTools: [...HOST_DEFAULT_ALLOWED_TOOLS, 'mcp__demo__ping'] })
  assert.equal(checked.has('mcp__demo__ping'), true)
})

test('an absent or empty catalog keeps the shipped rows', () => {
  const shipped = HOST_DEFAULT_ALLOWED_TOOLS
  assert.deepEqual(plain(T.toolListOf({ toolCatalog: [] })), shipped)
  assert.deepEqual(plain(T.toolListOf({ toolCatalog: 'not-a-list' })), shipped)
  assert.deepEqual(plain(T.toolListOf({})), shipped)
  assert.deepEqual(plain(T.catalogOf({})), [])
  // Junk entries are dropped instead of rendering as empty rows.
  assert.deepEqual(plain(T.catalogOf({ toolCatalog: ['b', '', 7, 'a'] })), ['b', 'a'])
  assert.equal(T.CATALOG_KEY, 'toolCatalog')
  assert.equal(T.ALLOW_KEY, 'allowedTools')
})

test('the default whitelist is the shipped eleven, and nothing else is checked', () => {
  const shipped = T.allowedSetOf({})
  assert.equal(shipped.size, HOST_DEFAULT_ALLOWED_TOOLS.length)
  for (const name of HOST_DEFAULT_ALLOWED_TOOLS) assert.equal(shipped.has(name), true, name)
  // A tool outside the shipped list starts unchecked: a new plugin tool is disabled.
  assert.equal(shipped.has('read'), false)
  assert.equal(shipped.has('mcp__demo__ping'), false)

  // A catalog name is not an allowance: only the stored whitelist decides.
  const withCatalog = T.allowedSetOf({ toolCatalog: ['read', 'mcp__demo__ping'] })
  assert.equal(withCatalog.has('read'), false)
  assert.equal(withCatalog.size, HOST_DEFAULT_ALLOWED_TOOLS.length)
})

test('an explicit whitelist replaces the default, the empty array included', () => {
  const narrowed = T.allowedSetOf({ allowedTools: ['delegate', 'orchestrate'] })
  assert.deepEqual([...narrowed].sort(), ['delegate', 'orchestrate'])
  assert.equal(narrowed.has('compress'), false)

  // Unchecking every box must disable every tool; falling back on the default here would
  // silently re-arm the main agent.
  assert.equal(T.allowedSetOf({ allowedTools: [] }).size, 0)

  // Junk entries are dropped rather than becoming a checked row nobody can see.
  assert.deepEqual([...T.allowedSetOf({ allowedTools: ['delegate', '', 7] })], ['delegate'])
  assert.equal(T.allowedSetOf({ allowedTools: 'not-a-list' }).size, HOST_DEFAULT_ALLOWED_TOOLS.length)
})

test('checking exactly the shipped eleven stores nothing, so the default applies again', () => {
  // The stored value is only the difference from the shipped whitelist: a full default set
  // is written as `unset`, so a later default change still reaches an untouched profile.
  assert.deepEqual(plain(T.allowOps(HOST_DEFAULT_ALLOWED_TOOLS)), [{ op: 'unset', path: ['allowedTools'] }])
  // Order and duplicates do not matter: the same set is the same default.
  assert.deepEqual(plain(T.allowOps([...HOST_DEFAULT_ALLOWED_TOOLS].reverse())), [
    { op: 'unset', path: ['allowedTools'] },
  ])
  assert.deepEqual(plain(T.allowOps([...HOST_DEFAULT_ALLOWED_TOOLS, 'dispatch'])), [
    { op: 'unset', path: ['allowedTools'] },
  ])
})

test('a narrowed or widened whitelist is stored as one explicit list, deduped', () => {
  const narrowed = HOST_DEFAULT_ALLOWED_TOOLS.filter((name) => name !== 'compress')
  assert.deepEqual(plain(T.allowOps(narrowed)), [{ op: 'set', path: ['allowedTools'], value: narrowed }])

  // An added name joins the same list: there is no second key any more.
  assert.deepEqual(plain(T.allowOps([...HOST_DEFAULT_ALLOWED_TOOLS, 'read'])), [
    { op: 'set', path: ['allowedTools'], value: [...HOST_DEFAULT_ALLOWED_TOOLS, 'read'] },
  ])
  // Duplicates collapse, and the click order is what gets stored.
  assert.deepEqual(plain(T.allowOps(['read', 'read', 'delegate'])), [
    { op: 'set', path: ['allowedTools'], value: ['read', 'delegate'] },
  ])
  // Unchecking every box stores the empty list, which means "allow nothing at all".
  assert.deepEqual(plain(T.allowOps([])), [{ op: 'set', path: ['allowedTools'], value: [] }])
})

test('reset unsets the one key, so the shipped whitelist applies again', () => {
  assert.deepEqual(plain(T.resetAllowOps()), [{ op: 'unset', path: ['allowedTools'] }])
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

/** Mount the allowed-tools column and expose the nodes the tests reach for. */
function mountAllowed(scope) {
  const view = mount(T.AllowedToolsPanel, { scope, t })
  const rows = () => nodes(view.tree).filter((node) => node.type === 'label')
  const search = () => nodes(view.tree).find((node) => node.props?.['data-search'] === 'allowed-tools')
  const button = () => nodes(view.tree).find((node) => node.type === 'button')
  const text = () => nodes(view.tree).map((node) => node.kids?.[0]).filter((kid) => typeof kid === 'string')
  return { view, rows, search, button, text }
}

test('the column is headed Allowed Tools and lists one checked row per shipped tool', () => {
  const panel = mountAllowed(fakeScope())
  assert.equal(panel.text().includes('allowed.title'), true)
  // The heading is literally "Allowed Tools" in the dictionary.
  const title = /'allowed\.title': '([^']+)'/.exec(src)?.[1]
  assert.equal(title, 'Allowed Tools')
  // The column is addressable, so a host layout can find it without guessing a class.
  assert.equal(panel.view.tree.props['data-panel'], 'allowed-tools')

  const rows = panel.rows()
  assert.equal(rows.length, HOST_DEFAULT_ALLOWED_TOOLS.length)
  const first = rows[0]
  assert.equal(first.kids[0].type, 'input')
  assert.equal(first.kids[1].type, 'span')
  assert.equal(first.kids[0].props.type, 'checkbox')
  // A checked box means "allowed for the main agent": the shipped eleven start checked.
  assert.equal(first.kids[0].props.checked, true)
  assert.equal(first.kids[0].props.disabled, false)
  assert.deepEqual(rows.map((row) => row.props['data-tool']), HOST_DEFAULT_ALLOWED_TOOLS)

  // A host tool the whitelist does not cover is a row too, unchecked: a new plugin or MCP
  // tool is disabled by default instead of silently joining the main agent's kit.
  const withCatalog = mountAllowed(fakeScope({ initial: { toolCatalog: ['read', 'edit', 'mcp__demo__ping'] } }))
  const extra = withCatalog.rows().filter((row) => ['read', 'edit', 'mcp__demo__ping'].includes(row.props['data-tool']))
  assert.equal(extra.length, 3)
  for (const row of extra) {
    assert.equal(row.kids[0].type, 'input')
    assert.equal(row.kids[0].props.disabled, false)
    assert.equal(row.kids[0].props.checked, false, row.props['data-tool'])
  }
  // The search box sits above the list.
  assert.equal(panel.search().props.type, 'search')
})

test('every row leads with the checkbox so a long name cannot scroll it out of the column', () => {
  const panel = mountAllowed(
    fakeScope({ initial: { toolCatalog: ['mcp__a_very_long_server__a_very_long_tool_name_that_will_not_fit'] } }),
  )
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
  const panel = mountAllowed(
    fakeScope({ initial: { toolCatalog: ['read', 'edit', 'ops_read_files', 'read_image', 'acp_read_original_image'] } }),
  )
  panel.search().props.onChange({ target: { value: 'READ' } })
  assert.deepEqual(
    panel.rows().map((row) => row.props['data-tool']),
    // `session_event_read` is a shipped row, so it comes first; the catalog extras follow sorted.
    ['session_event_read', 'acp_read_original_image', 'ops_read_files', 'read', 'read_image'],
  )
  panel.search().props.onChange({ target: { value: 'zzz' } })
  assert.deepEqual(panel.rows(), [])
  assert.equal(panel.text().includes('allowed.empty'), true)
})

test('a tool published by another plugin is listed, searchable and unchecked', async () => {
  const scope = fakeScope({ initial: { toolCatalog: ['mcp__demo__ping', 'ops_new_tool'] } })
  const panel = mountAllowed(scope)
  panel.search().props.onChange({ target: { value: 'DEMO' } })
  const rows = panel.rows()
  assert.deepEqual(rows.map((row) => row.props['data-tool']), ['mcp__demo__ping'])
  assert.equal(rows[0].kids[0].props.type, 'checkbox')
  assert.equal(rows[0].kids[0].props.checked, false, 'a new tool starts disabled')

  // Checking it writes the name into the whitelist, on top of the shipped eleven.
  await rows[0].kids[0].props.onChange({ target: { checked: true } })
  assert.deepEqual(plain(scope.calls[0].ops), [
    { op: 'set', path: ['allowedTools'], value: [...HOST_DEFAULT_ALLOWED_TOOLS, 'mcp__demo__ping'] },
  ])
})

test('unchecking a shipped name drops it from the stored whitelist', async () => {
  const scope = fakeScope()
  const panel = mountAllowed(scope)
  const row = () => panel.rows().find((entry) => entry.props['data-tool'] === 'dispatch')
  assert.equal(row().kids[0].props.checked, true)
  await row().kids[0].props.onChange({ target: { checked: false } })
  assert.equal(scope.calls.length, 1)
  assert.deepEqual(plain(scope.calls[0].ops), [
    { op: 'set', path: ['allowedTools'], value: HOST_DEFAULT_ALLOWED_TOOLS.filter((name) => name !== 'dispatch') },
  ])
  assert.equal(scope.calls[0].expected, 1)
  assert.equal(row().kids[0].props.checked, false)
})

test('checking the last unchecked name restores the default instead of storing a list', async () => {
  // Re-checking everything must go back to `unset`, so the profile follows the shipped
  // whitelist again rather than pinning today's copy of it.
  const scope = fakeScope({ initial: { allowedTools: HOST_DEFAULT_ALLOWED_TOOLS.filter((name) => name !== 'compress') } })
  const panel = mountAllowed(scope)
  const row = panel.rows().find((entry) => entry.props['data-tool'] === 'compress')
  assert.equal(row.kids[0].props.checked, false)
  await row.kids[0].props.onChange({ target: { checked: true } })
  assert.deepEqual(plain(scope.calls[0].ops), [{ op: 'unset', path: ['allowedTools'] }])
  assert.equal(panel.rows().find((entry) => entry.props['data-tool'] === 'compress').kids[0].props.checked, true)
})

test('a name a profile checked but the catalog does not list is still a row', async () => {
  const scope = fakeScope({ initial: { allowedTools: [...HOST_DEFAULT_ALLOWED_TOOLS, 'custom_tool'] } })
  const panel = mountAllowed(scope)
  const row = panel.rows().find((entry) => entry.props['data-tool'] === 'custom_tool')
  assert.ok(row, 'a checked name is listed even without a catalog entry')
  assert.equal(row.kids[0].props.checked, true)
  await row.kids[0].props.onChange({ target: { checked: false } })
  assert.deepEqual(plain(scope.calls[0].ops), [{ op: 'unset', path: ['allowedTools'] }])
})

test('reset unsets the whitelist so the shipped eleven apply again', async () => {
  const scope = fakeScope({ initial: { allowedTools: ['delegate'] } })
  const panel = mountAllowed(scope)
  assert.equal(panel.button().kids[0], 'allowed.reset')
  // Only one tool was allowed, so every other shipped row starts unchecked.
  assert.equal(panel.rows().find((entry) => entry.props['data-tool'] === 'compress').kids[0].props.checked, false)
  await panel.button().props.onClick()
  assert.deepEqual(plain(scope.calls[0].ops), plain(T.resetAllowOps()))
  assert.deepEqual(plain(T.resetAllowOps()), [{ op: 'unset', path: ['allowedTools'] }])
  assert.equal(panel.rows().find((entry) => entry.props['data-tool'] === 'compress').kids[0].props.checked, true)
})

test('a read-only scope disables the boxes and never writes', async () => {
  const scope = fakeScope({ writable: false })
  const panel = mountAllowed(scope)
  const box = panel.rows().find((row) => row.props['data-tool'] === 'dispatch').kids[0]
  assert.equal(box.props.disabled, true)
  assert.equal(panel.button().props.disabled, true)
  await panel.button().props.onClick()
  assert.equal(scope.calls.length, 0)
})

test('a rejected write is reported without dropping the stored state', async () => {
  const scope = fakeScope({ reject: 'settings changed since it was read' })
  const panel = mountAllowed(scope)
  const row = () => panel.rows().find((entry) => entry.props['data-tool'] === 'dispatch')
  await row().kids[0].props.onChange({ target: { checked: false } })
  const alert = nodes(panel.view.tree).find((node) => node.props?.role === 'alert')
  assert.match(alert.kids[0], /settings changed/)
  assert.equal(row().kids[0].props.checked, true)
})

test('the composer popover is gone, and the whitelist stands alone as a settings card', () => {
  // The two-column popover, its trigger and its component are gone from the bundle.
  assert.equal(src.includes('orchestrator-route-picker'), false)
  assert.equal(src.includes('function RoutePicker'), false)
  assert.equal('RoutePicker' in T, false, '__test still exports RoutePicker')
  // The allowed-tools panel survives as a full-width card: no fixed column, no divider, one box.
  const panel = mountAllowed(fakeScope())
  assert.equal(panel.view.tree.props.style.width, undefined)
  assert.equal(panel.view.tree.props.style.borderRight, undefined)
  assert.match(panel.view.tree.props.style.border, /^1px solid/)
  assert.equal(panel.rows().length, HOST_DEFAULT_ALLOWED_TOOLS.length)
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

test('a catalog that reads empty mid-write does not collapse the panel to the shipped rows', () => {
  const scope = fakeScope({ initial: { toolCatalog: ['mcp__demo__ping', 'read'] } })
  const panel = mountAllowed(scope)
  const names = () => panel.rows().map((row) => row.props['data-tool'])
  assert.ok(names().includes('mcp__demo__ping'))

  // The host's own settings write empties the field for an instant; the rows must survive it.
  scope.externalSet({ toolCatalog: [] })
  assert.ok(names().includes('mcp__demo__ping'))
  assert.ok(names().includes('dispatch'))

  // A genuinely different catalog still replaces the remembered one.
  scope.externalSet({ toolCatalog: ['ops_new'] })
  assert.ok(names().includes('ops_new'))
  assert.equal(names().includes('mcp__demo__ping'), false)
})

// ---- 最小设置页（票 15 恢复） ------------------------------------------------------------

test('the smaller settings page keeps three zones: whitelist, supervision, read-only authority', async () => {
  const scope = fakeScope({
    initial: { superviseEnabled: false, superviseUnlimited: true, superviseNotifyOnNoProgress: false },
  })
  const view = mount(T.AssistantSettingsSection, { t, orch: scope })
  const tree = view.tree
  assert.match(textOf(tree), /assistant\.settings\.title/)
  const zones = nodes(tree)
    .map((node) => node.props?.['data-zone'])
    .filter((zone) => typeof zone === 'string')
  assert.deepEqual(zones, ['allowed', 'supervise', 'permissions'])
  assert.ok(nodes(tree).some((node) => node.type === T.AllowedToolsPanel), 'the whitelist panel is rendered')
  assert.ok(nodes(tree).some((node) => node.type === T.AuthorityPanel), 'the read-only authority panel is rendered')

  // 间隔与「每次上限」是同一个组件、两个 setting：键不同，写入目标就不同。
  const fields = nodes(tree).filter((node) => node.type === T.SuperviseIntervalField)
  assert.equal(fields.length, 2)
  assert.deepEqual(
    fields.map((node) => (node.props.setting ?? T.INTERVAL).key),
    ['superviseIntervalSeconds', 'superviseMaxNoticesPerChild'],
    'same component, two config keys',
  )

  // 三个巡检开关：每个只写自己那个配置键，且显示的是存储值。
  const switches = [
    ['orchestrator-supervise-enabled', 'superviseEnabled', false],
    ['orchestrator-supervise-unlimited', 'superviseUnlimited', true],
    ['orchestrator-supervise-no-progress', 'superviseNotifyOnNoProgress', false],
  ]
  for (const [testid, key, checked] of switches) {
    const row = byTestId(tree, testid)
    assert.ok(row, testid + ' is rendered')
    const sw = nodes(row).find((node) => node.type === T.EnableSwitch)
    assert.ok(sw, testid + ' renders the switch')
    assert.equal(sw.props.checked, checked, testid + ' shows the stored value')
    sw.props.onChange(!checked)
  }
  await flush()
  assert.deepEqual(
    plain(scope.calls.map((call) => call.ops[0].path[0])),
    switches.map((entry) => entry[1]),
  )
  assert.deepEqual(
    plain(scope.calls.map((call) => call.ops[0].value)),
    switches.map((entry) => !entry[2]),
  )
  view.unmount()
})

test('the max-notices field writes superviseMaxNoticesPerChild and rejects out-of-range input', async () => {
  const scope = fakeScope({ initial: { superviseMaxNoticesPerChild: 5 } })
  const field = mountMaxNoticesField(scope)
  assert.equal(field.input().props.value, '5')
  assert.equal(field.input().props['data-testid'], 'orchestrator-supervise-max')

  field.input().props.onChange({ target: { value: '21' } })
  await field.input().props.onBlur()
  assert.equal(scope.calls.length, 0, 'out of range writes nothing')
  assert.match(field.alert().kids[0], /supervise\.maxInvalid/)

  field.input().props.onChange({ target: { value: '7' } })
  await field.input().props.onBlur()
  assert.deepEqual(plain(scope.calls[0].ops), [{ op: 'set', path: ['superviseMaxNoticesPerChild'], value: 7 }])
  assert.equal(scope.calls[0].expected, 1)
  field.view.unmount()
})

test('the permissions zone names the dispatch-command level and its four read-only scopes', () => {
  // 级别的 id 镜像在客户端 bundle 里（不能 import 服务端模块）；服务端常量是真源，两边必须一致。
  assert.equal(T.SECRETARY_AUTHORITY_LEVEL, DISPATCH_COMMAND)
  assert.deepEqual(plain(T.SECRETARY_AUTHORITY_SCOPE_KEYS), [
    'secretary.permissions.scopeNoWrite',
    'secretary.permissions.scopeNoConfig',
    'secretary.permissions.scopeNoSessionEdit',
    'secretary.permissions.scopeRegisteredOnly',
  ])

  const inner = mount(T.AuthorityPanel, { t: (key) => T.zh[key] ?? key })
  const text = textOf(inner.tree)
  assert.match(text, /调度指挥/)
  assert.match(text, /dispatch-command/)
  assert.match(text, /Master 会话只读/)
  const list = nodes(inner.tree).find((node) => node.props?.['data-list'] === 'secretary-authority-scope')
  assert.ok(list, 'the scope list must be rendered')
  const scopeLines = nodes(list)
    .filter((node) => node.type === 'li')
    .map((node) => node.kids[0])
  assert.deepEqual(scopeLines, [
    T.zh['secretary.permissions.scopeNoWrite'],
    T.zh['secretary.permissions.scopeNoConfig'],
    T.zh['secretary.permissions.scopeNoSessionEdit'],
    T.zh['secretary.permissions.scopeRegisteredOnly'],
  ])
  // 只读：没有输入、没有选择、没有按钮。
  assert.equal(nodes(inner.tree).some((node) => ['input', 'select', 'button'].includes(node.type)), false)
  inner.unmount()
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
    for (const key of ['route.review', 'route.reviewNote']) {
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

test('ticket 10 leaves no trace of the legacy master panel in the client bundle', () => {
  // The input.right button, its component, its poll and its endpoint descriptor are gone.
  // Matching the source keeps a dead copy from creeping back: any of these names returning
  // means the retired panel was reintroduced, and fails here before it reaches a session.
  for (const name of [
    'MASTER_CONTRIBUTION',
    'MASTER_STATES',
    'MASTER_POLL_MS',
    'MASTER_SERVICE',
    'masterGroups',
    'masterNamespaceOf',
    'mountMasterRemote',
    'loadMasterState',
    'MasterPanel',
    'masterPanelEnabled',
    'orchestrator-master-panel',
  ]) {
    assert.equal(src.includes(name), false, name)
  }
  for (const name of ['MASTER_CONTRIBUTION', 'MASTER_STATES', 'MasterPanel', 'masterGroups', 'loadMasterState']) {
    assert.equal(name in T, false, '__test still exports ' + name)
  }
  // The deleted panel owned the only master.* copy, so both dictionaries dropped those keys.
  for (const dict of [T.zh, T.en]) {
    assert.deepEqual(Object.keys(dict).filter((key) => key.startsWith('master.')), [])
  }
  // The helpers the secretary view reuses survived the deletion.
  assert.equal(typeof T.loadSecretaryState, 'function')
})


// ---- 秘书视图（票 07） -------------------------------------------------------------------
//
// The view reads the ticket-06 payload and nothing else. These cases mount the real components
// over the same hook shim the cases above use, so a regression in the mapping, the empty
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
        // The stored list the settings writes address by index. Here it is longer than the
        // normalized one: s-9 duplicates the Master and is dropped by normalization, which is
        // exactly when the two lists differ.
        raw: [{ sessionId: 's-1' }, { sessionId: 's-9' }, { sessionId: 's-2' }],
        conflict: { masterSessionId: 'm-1', conflictingOrchestratorIds: ['s-9'] },
      },
      orchestrators: [
        {
          sessionId: 's-1',
          title: '构建视图',
          workspace: 'D:\\w',
          live: true,
          state: 'Needs input',
          workers: [
            { id: 'w-1', state: 'Working', summary: '写测试' },
            { id: 'w-2', state: 'Idle', summary: '' },
          ],
          beats: { count: 3, startedAt: 1, capped: false, stoppedReason: null },
          lastReport: { path: 'r/1.md', at: 1700000000000, kind: 'delta' },
        },
        {
          sessionId: 's-2',
          title: '收尾',
          workspace: '',
          live: true,
          state: 'Working',
          workers: [{ id: 'w-3', state: 'Working', summary: '整理提交' }],
          beats: { count: 1, startedAt: 2, capped: false, stoppedReason: null },
          lastReport: null,
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
      },
    },
    overrides,
  )
}

/** Mount the panel over the hook shim; the scope is enabled unless a case says otherwise. */
function mountSecretary({ payload = secretaryPayload(), loadState, scope, openSession, mutate, nudge, loadCandidates } = {}) {
  return mount(mod.__test.SecretaryPanel, {
    t,
    orch: scope ?? fakeScope({ initial: { secretaryEnabled: true } }),
    loadState: loadState ?? (async () => payload),
    openSession,
    mutate,
    nudge,
    loadCandidates,
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
  // Why changed: the session picker adds two endpoints. The old three-method list asserted the
  // picker out of existence; the two new ones are zero-argument calls, checked separately below.
  assert.deepEqual(
    descriptors.map((descriptor) => descriptor.method),
    ['secretaryState', 'confirmDraft', 'discardDraft', 'listCandidateSessions', 'createMasterSession'],
  )
  for (const descriptor of descriptors.filter((entry) => entry.method.endsWith('Draft'))) {
    assert.equal(descriptor.id, 'dsh-engineer-assistants-secretary#orchestratorSecretary/' + descriptor.method)
    assert.equal(descriptor.service, 'orchestratorSecretary')
    assert.equal(descriptor.namespace, 'orchestratorSecretary')
    assert.equal(descriptor.invocation.kind, 'direct')
    // Why changed (mount-gate fix): the parameter used to be src-json and carried no wire name,
    // so $mount threw "field undefined has no strict codec" before anything was installed and
    // the panel never read its state. The wire name is what the Host matches its SRC parameter
    // against — without it the request would carry no draftId and the Host would refuse it as an
    // unexpected field.
    const [parameter] = descriptor.parameters
    assert.equal(parameter.name, 'draftId')
    assert.equal(parameter.wire, 'draftId')
    assert.equal(parameter.source, 'json')
    assert.equal(parameter.codec.mode, 'strict')
    assert.equal(typeof parameter.codec.typeSymbol, 'string')
    assert.ok(parameter.codec.typeSymbol.length > 0)
    // plain() drops functions, so the factory is read from the live descriptor and run once:
    // the declared codec really is a string schema, not a placeholder that only satisfies a
    // typeof check.
    const live = T.SECRETARY_CONTRIBUTION.descriptors.find((entry) => entry.method === descriptor.method)
    assert.equal(typeof live.parameters[0].codec.create, 'function', 'a strict codec needs its factory')
    const schema = live.parameters[0].codec.create()
    assert.equal(schema.parse('d-1'), 'd-1')
    assert.throws(() => schema.parse(1), 'draftId is a string on the wire')
    assert.deepEqual(plain(parameter.codec.jsonSchema), { type: 'string' })
    // The results stay src-json (commit 814d662): raw JSON both ways, no generated decoder.
    assert.deepEqual(descriptor.result, { mode: 'src-json' })
  }
  // The picker's two calls carry no client-supplied field at all: the optional master id stays
  // absent so the Host applies the plugin's default, and the list read takes nothing.
  for (const method of ['listCandidateSessions', 'createMasterSession']) {
    const descriptor = descriptors.find((entry) => entry.method === method)
    assert.ok(descriptor, method)
    assert.deepEqual(descriptor.parameters, [], method)
    assert.deepEqual(descriptor.result, { mode: 'src-json' }, method)
  }
})


// ---- The Gateway's client mount gate, ported -------------------------------------------
//
// ctx.remote.$mount() validates a contribution before any method becomes callable, in two
// places outside this repo:
//
//   @deepseek-ai/dsh-api-gateway lib/types/client/index.js
//     validateContribution -> requireStrictInputs -> requireStrictCodec
//   @deepseek-ai/dsh-typert-registry lib/client.browser.js
//     RemoteStore.register -> DescriptorStore.validate -> validateInvocation -> validateCodec
//
// The first refuses every Client-supplied field whose codec is not 'strict' (the message is
// "client api: generated Remote <endpoint> field <wire> has no strict codec"); the second
// refuses a strict codec without a type symbol and a create() factory. Both are copied here
// in behaviour, message included, so a red run says exactly what the browser console says.
function requireStrictCodec(codec, endpoint, field) {
  if (codec === undefined || codec.mode !== 'strict') {
    throw new Error('client api: generated Remote ' + endpoint + ' field ' + JSON.stringify(field) + ' has no strict codec')
  }
}

function validateWireName(subject, value) {
  if (value === '.' || value === '..' || !/^[A-Za-z0-9_$.-]+$/.test(value)) {
    throw new Error('typert: invalid ' + subject + ' "' + String(value) + '"')
  }
}

function validateCodec(codec, subject) {
  if (codec === undefined) throw new Error('typert: ' + subject + ' has no codec')
  if (codec.mode === 'src-json') return
  if (typeof codec.typeSymbol !== 'string' || codec.typeSymbol.length === 0) {
    throw new Error('typert: ' + subject + ' type symbol is not a nonempty string')
  }
  if (typeof codec.create !== 'function') throw new Error('typert: ' + subject + ' strict codec has no create() factory')
}

function mountContribution(contribution) {
  // The Gateway refuses inputs it cannot type before anything is installed.
  for (const descriptor of contribution.descriptors) {
    for (const parameter of descriptor.parameters) {
      requireStrictCodec(parameter.codec, descriptor.namespace + '/' + descriptor.method, parameter.wire)
    }
  }
  // The Typert registry then validates what it is about to store, result codec included.
  for (const descriptor of contribution.descriptors) {
    validateWireName('invocation method', descriptor.method)
    validateCodec(descriptor.result, descriptor.id + ' result')
    for (const parameter of descriptor.parameters) {
      validateWireName('parameter name', parameter.name)
      validateCodec(parameter.codec, descriptor.id + ' parameter ' + parameter.name)
    }
  }
}

test('the secretary contribution passes the Gateway mount gate (why: a src-json input made every $mount throw and the panel never read its state)', () => {
  assert.doesNotThrow(() => mountContribution(T.SECRETARY_CONTRIBUTION))
})

test('the secretary contribution stays src-json with zero parameters', () => {
  const [descriptor] = T.SECRETARY_CONTRIBUTION.descriptors
  assert.deepEqual(plain(descriptor.result), { mode: 'src-json' })
  assert.deepEqual(plain(descriptor.parameters), [])
  assert.equal(descriptor.id, 'dsh-engineer-assistants-secretary#orchestratorSecretary/secretaryState')
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

  // The current run is the Working row, with its state, its step line and its worker table.
  // This fixture's rows carry no step (null), so the line says 未提供 (secretary.stepNone)
  // instead of inventing a step — the reason this assertion replaced "no step line at all".
  const current = byTestId(view.tree, 'orchestrator-secretary-current')
  assert.match(textOf(current), /收尾/)
  assert.match(textOf(current), /Working/)
  assert.match(textOf(byTestId(view.tree, 'orchestrator-secretary-current-step')), /secretary.stepNone/)
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
      orchestrators: [{ sessionId: 'gone', title: '旧的', live: false, state: 'Completed', workers: [] }],
    }),
  })
  assert.equal(byTestId(ended.tree, 'orchestrator-secretary-row-gone').props.disabled, true)
  assert.match(textOf(byTestId(ended.tree, 'orchestrator-secretary-row-gone')), /secretary\.ended/)
})

test('a row the host could not tie to a workspace says why no report is listed (why: the history stayed blank)', () => {
  const view = mount(T.SecretaryOverview, {
    t,
    width: 1200,
    payload: secretaryPayload({
      registry: {
        masterSessionId: '',
        orchestrators: [
          { sessionId: 's-1', title: '构建视图', workspace: 'D:\\w', trackedAt: 1 },
          { sessionId: 's-3', title: '无工作区', workspace: '', workspaceMissing: true, trackedAt: 2 },
        ],
        conflict: null,
      },
      orchestrators: [],
    }),
  })
  const missing = byTestId(view.tree, 'orchestrator-secretary-workspace-missing-s-3')
  assert.ok(missing, 'the tree says why the report list is empty')
  assert.match(textOf(missing), /secretary\.workspaceMissing/)
  assert.equal(byTestId(view.tree, 'orchestrator-secretary-workspace-missing-s-1'), undefined)
  // The flag rides on the row, not on the group: a resolved workspace never shows the notice.
  const rows = plain(T.secretaryRowsOf(secretaryPayload()))
  assert.deepEqual(rows.map((row) => row.workspaceMissing), [false, false])
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

// ---- 可登记折叠区（票：可登记会话） -------------------------------------------------------
/** One candidate row exactly as orchestratorSecretary/listCandidateSessions answers it. */
const REGISTRABLE_CANDIDATE = (id, extra) => ({
  sessionId: id,
  title: '标题-' + id,
  titleMissing: false,
  cwd: 'D:\\ws',
  live: true,
  running: false,
  updatedAt: 1_700_000_000_000,
  parentSession: null,
  delegationDepth: 0,
  isMaster: false,
  isOrchestrator: false,
  ...(extra ?? {}),
})

test('the registrable fold lists only unregistered sessions and leaves out the master (why: a registered row would be a dead click)', async () => {
  let reads = 0
  const view = mount(T.SecretaryOverview, {
    t,
    width: 1200,
    payload: secretaryPayload(),
    loadCandidates: async () => {
      reads += 1
      return [
        REGISTRABLE_CANDIDATE('s-1', { isOrchestrator: true }),
        REGISTRABLE_CANDIDATE('m-1', { isMaster: true }),
        REGISTRABLE_CANDIDATE('c-1', { running: true }),
        REGISTRABLE_CANDIDATE('c-2', { title: '', titleMissing: true, cwd: null, live: false, running: false }),
      ]
    },
  })
  await flush()
  assert.equal(reads, 1, 'the fold reads the candidate endpoint once when the view appears')

  const fold = byTestId(view.tree, 'orchestrator-secretary-registrable')
  assert.ok(fold, 'the fold sits at the top of the tracking tree')
  assert.match(textOf(fold), /secretary\.registrable/)
  assert.equal(byTestId(view.tree, 'orchestrator-secretary-registrable-s-1'), undefined, 'a registered row is not offered again')
  assert.equal(byTestId(view.tree, 'orchestrator-secretary-registrable-m-1'), undefined, 'the Master is not registrable')

  const c1 = byTestId(view.tree, 'orchestrator-secretary-registrable-c-1')
  assert.match(textOf(c1), /标题-c-1/)
  assert.match(textOf(c1), /D:\\ws/)
  assert.match(textOf(c1), /sessions\.status\.running/)
  const c2 = byTestId(view.tree, 'orchestrator-secretary-registrable-c-2')
  assert.match(textOf(c2), /secretary\.untitled/, 'a missing title is named instead of left blank')
  assert.match(textOf(c2), /sessions\.noWorkspace/)
  assert.match(textOf(c2), /sessions\.status\.persisted/)

  // The header collapses the region; aria-expanded is the state it reports.
  const toggle = byTestId(view.tree, 'orchestrator-secretary-registrable-toggle')
  assert.equal(toggle.props['aria-expanded'], true)
  toggle.props.onClick()
  assert.equal(byTestId(view.tree, 'orchestrator-secretary-registrable-toggle').props['aria-expanded'], false)
  assert.equal(byTestId(view.tree, 'orchestrator-secretary-registrable-c-1'), undefined, 'a collapsed fold hides its rows')
  byTestId(view.tree, 'orchestrator-secretary-registrable-toggle').props.onClick()
  assert.ok(byTestId(view.tree, 'orchestrator-secretary-registrable-c-1'))
  view.unmount()
})

test('an empty or unreadable candidate read still says what happened inside the fold', async () => {
  const empty = mount(T.SecretaryOverview, {
    t,
    width: 1200,
    payload: secretaryPayload(),
    loadCandidates: async () => [REGISTRABLE_CANDIDATE('s-1', { isOrchestrator: true })],
  })
  await flush()
  assert.match(
    textOf(byTestId(empty.tree, 'orchestrator-secretary-registrable-empty')),
    /secretary\.registrableEmpty/,
    'nothing left to register is said out loud',
  )
  empty.unmount()

  let calls = 0
  const failing = mount(T.SecretaryOverview, {
    t,
    width: 1200,
    payload: secretaryPayload(),
    loadCandidates: async () => {
      calls += 1
      throw new Error('session endpoint down')
    },
  })
  await flush()
  const alert = byTestId(failing.tree, 'orchestrator-secretary-registrable-failed')
  assert.ok(alert, 'a broken read is visible, never a blank fold')
  assert.equal(alert.props.role, 'alert')
  assert.match(textOf(alert), /sessions\.failed/)
  byTestId(failing.tree, 'orchestrator-secretary-registrable-retry').props.onClick()
  await flush()
  assert.equal(calls, 2, 'the retry really re-reads the candidates')
  failing.unmount()
})

test('registering a candidate stages a page-local draft and writes nothing', async () => {
  const view = mount(T.SecretaryOverview, {
    t,
    width: 1200,
    payload: secretaryPayload(),
    loadCandidates: async () => [REGISTRABLE_CANDIDATE('c-1'), REGISTRABLE_CANDIDATE('c-2', { title: '' })],
  })
  await flush()
  assert.equal(byTestId(view.tree, 'orchestrator-secretary-registrable-draft'), undefined, 'nothing staged yet')

  const register = () => byTestId(view.tree, 'orchestrator-secretary-registrable-register-c-1')
  assert.equal(register().props.disabled, false)
  register().props.onClick()

  const draft = byTestId(view.tree, 'orchestrator-secretary-registrable-draft')
  assert.ok(draft, 'the click stages a draft instead of writing the config')
  assert.match(textOf(draft), /标题-c-1/)
  assert.match(textOf(draft), /secretary\.registrableDraftHint/, 'the draft says where it is really saved')
  assert.ok(byTestId(view.tree, 'orchestrator-secretary-registrable-draft-c-1'), 'the staged row is listed by id')
  assert.equal(register().props.disabled, true, 'a staged row cannot be staged twice')
  assert.match(textOf(byTestId(view.tree, 'orchestrator-secretary-registrable-c-1')), /secretary\.staged/)

  // A second click on the same row never duplicates the draft entry.
  register().props.onClick()
  const chips = nodes(view.tree).filter((node) =>
    String(node.props?.['data-testid'] ?? '').startsWith('orchestrator-secretary-registrable-draft-'),
  )
  assert.equal(chips.length, 1)
  // A row with no title still lands in the draft with the placeholder name.
  byTestId(view.tree, 'orchestrator-secretary-registrable-register-c-2').props.onClick()
  assert.match(
    textOf(byTestId(view.tree, 'orchestrator-secretary-registrable-draft-c-2')),
    /secretary\.untitled/,
  )
  view.unmount()
})

test('the panel hands the overview the candidate reader (why: the fold cannot exist on the settings endpoint alone)', async () => {
  const view = mountSecretary({ loadCandidates: async () => [REGISTRABLE_CANDIDATE('c-1')] })
  await flush()
  const body = bodyOf(view.tree)
  assert.equal(body.type, T.SecretaryOverview)
  assert.equal(typeof body.props.loadCandidates, 'function')
  view.unmount()
})

test('the blockers and the tracker rows come from the payload, not from the view', () => {
  const payload = secretaryPayload()
  const blockers = plain(T.secretaryBlockersOf(payload))
  assert.deepEqual(
    blockers.map((blocker) => [blocker.sessionId, blocker.reason]),
    [['s-1', 'needsInput']],
  )
  // A stopped beat is a blocker too, and a pending draft is one as well. A session that only
  // carries the removed lastError field is not: the endpoint has no such field, so nothing may
  // turn it into a blocker any more.
  const more = plain(
    T.secretaryBlockersOf({
      orchestrators: [
        { sessionId: 'x', title: '安静的', state: 'Idle', beats: { capped: false } },
        { sessionId: 'y', title: '超时的', state: 'Idle', beats: { capped: true, stoppedReason: '达到上限' } },
        { sessionId: 'z', title: '旧的', state: 'Idle', lastError: 'boom', beats: { capped: false } },
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
      ['y', 'capped'],
      ['x', 'draft'],
    ],
  )
  assert.equal(more[0].text, '达到上限')
  assert.equal(more[1].text, '等你拍板', 'a draft blocker carries the generated body')

  const rows = plain(T.secretaryRowsOf(payload))
  assert.deepEqual(
    rows.map((row) => [row.sessionId, row.state, row.live]),
    [
      ['s-1', 'Needs input', true],
      ['s-2', 'Working', true],
    ],
  )
  // Neither field is read any more: a payload that still carries them does not resurrect them.
  assert.equal('stepLabel' in rows[0], false)
  assert.equal('lastError' in rows[0], false)
  assert.deepEqual(rows[0].workers.map((worker) => worker.id), ['w-1', 'w-2'])
  assert.equal(rows[0].lastReportAt, 1700000000000)
  // A registered session with no live row keeps its place, ended and idle.
  const ended = plain(T.secretaryRowsOf({ registry: { orchestrators: [{ sessionId: 'gone', title: '旧的' }] }, orchestrators: [] }))
  assert.deepEqual([ended[0].state, ended[0].live], ['Idle', false])
  // A missing segment is no rows, never a throw.
  assert.deepEqual(plain(T.secretaryRowsOf(undefined)), [])
  assert.deepEqual(plain(T.secretaryBlockersOf(undefined)), [])
  assert.deepEqual(plain(T.draftRowsOf(undefined)), [])
})

test('the history tab says reports moved to the dock, and keeps no timeline (why: the archive is gone)', () => {
  // 票 15：归档停产、旧报告模块删除。这一页只留一行说明，差异与时间线都不再画。
  const view = mount(T.SecretaryHistory, { t, payload: secretaryPayload() })
  const note = byTestId(view.tree, 'orchestrator-secretary-history-moved')
  assert.equal(textOf(note).trim(), 'secretary.historyMoved')
  assert.equal(byTestId(view.tree, 'orchestrator-secretary-timeline'), undefined)
  assert.equal(byTestId(view.tree, 'orchestrator-secretary-diff'), undefined)
  assert.ok(T.zh['secretary.historyMoved'].length > 0)
  assert.ok(T.en['secretary.historyMoved'].length > 0)
  view.unmount()
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

test('the overview status bar derives every number from the payload (why: a hardcoded bar would lie)', () => {
  const now = 1_700_000_000_000
  const clock = (ms) => {
    const date = new Date(ms)
    const pad = (part) => String(part).padStart(2, '0')
    return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
  }
  const run = (beats) => ({
    sessionId: 's-2',
    title: '收尾',
    workspace: '',
    live: true,
    state: 'Working',
    workers: [],
    beats,
    lastReport: null,
  })
  const status = (tree, id) => textOf(byTestId(tree, 'orchestrator-secretary-status-' + id)).trim()
  const withPolicy = (orchestrators, policy, reports = []) =>
    secretaryPayload({
      registry: { masterSessionId: '', orchestrators: [], conflict: null },
      orchestrators,
      reports,
      policy: Object.assign({ notifyOn: {}, promptText: '' }, policy),
    })

  // The beat is 300s in (count 2 of a 120s cadence), so its next tick is 60s away; the 600s cap
  // leaves 300s. The next-report clock is the beat's next tick, computed locally by the view.
  const view = mount(T.SecretaryOverview, {
    t,
    width: 1200,
    now,
    payload: withPolicy(
      [run({ count: 2, startedAt: now - 300000, capped: false, stoppedReason: null })],
      { beatSeconds: 120, maxRunSeconds: 600 },
    ),
  })
  assert.match(textOf(byTestId(view.tree, 'orchestrator-secretary-status-tracking')), /secretary.status.on/)
  assert.equal(status(view.tree, 'running'), '1')
  assert.equal(status(view.tree, 'blocked'), '0')
  assert.match(status(view.tree, 'beat'), /01:00/)
  assert.match(status(view.tree, 'maxrun'), /05:00/)
  assert.match(status(view.tree, 'next-report'), new RegExp(clock(now + 60000)))

  // A second profile renders its own numbers: the bar reads policy, not constants.
  const second = mount(T.SecretaryOverview, {
    t,
    width: 1200,
    now,
    payload: withPolicy(
      [run({ count: 1, startedAt: now - 100000, capped: false, stoppedReason: null })],
      { beatSeconds: 300, maxRunSeconds: 3600 },
    ),
  })
  assert.match(status(second.tree, 'beat'), /08:20/)
  assert.match(status(second.tree, 'maxrun'), /58:20/)

  // With no running beat, the newest report's cadence is the only next-report projection.
  const reportsOnly = mount(T.SecretaryOverview, {
    t,
    width: 1200,
    now,
    payload: withPolicy(
      [],
      { beatSeconds: 120, maxRunSeconds: 600 },
      [
        {
          sessionId: 's-2',
          at: now - 100000,
          kind: 'delta',
          path: 'r/2.md',
          changes: { completed: [], blocked: [], flipped: [] },
          error: null,
        },
      ],
    ),
  })
  assert.equal(status(reportsOnly.tree, 'beat'), '—')
  assert.equal(status(reportsOnly.tree, 'next-report'), clock(now + 20000))

  // A payload that can produce none of it says '—' instead of a plausible zero.
  const bare = mount(T.SecretaryOverview, {
    t,
    width: 1200,
    now,
    payload: {
      enabled: false,
      orchestrators: [run({ count: 2, startedAt: now - 300000, capped: true, stoppedReason: 'max-run' })],
      reports: [],
      drafts: [],
    },
  })
  assert.match(status(bare.tree, 'tracking'), /secretary\.status\.off/)
  assert.equal(status(bare.tree, 'running'), '1')
  assert.equal(status(bare.tree, 'beat'), '—')
  assert.equal(status(bare.tree, 'maxrun'), '—')
  assert.equal(status(bare.tree, 'next-report'), '—')
})

test('a blocker row says what the user must do and never leaves the line blank (why: the reason alone does not name the action)', () => {
  const payload = secretaryPayload({
    orchestrators: [
      {
        sessionId: 's-1',
        title: '构建视图',
        live: true,
        state: 'Needs input',
        workers: [],
        beats: { count: 1, startedAt: 1, capped: false, stoppedReason: null },
        needsAction: '先确认 12 条记录是否已导出',
      },
      {
        sessionId: 's-2',
        title: '收尾',
        live: true,
        state: 'Needs input',
        workers: [],
        beats: { count: 1, startedAt: 1, capped: false, stoppedReason: null },
      },
    ],
  })
  const view = mount(T.SecretaryOverview, { t, width: 1200, payload })
  const withField = textOf(byTestId(view.tree, 'orchestrator-secretary-blocker-needs-action-s-1'))
  assert.match(withField, /secretary.needsAction/)
  assert.match(withField, /先确认 12 条记录是否已导出/)
  const without = textOf(byTestId(view.tree, 'orchestrator-secretary-blocker-needs-action-s-2'))
  assert.match(without, /secretary.needsActionHint/)
  // The suggestion is real copy in both dictionaries, not an empty placeholder.
  assert.match(T.zh['secretary.needsActionHint'], /决定是否允许继续/)
  assert.ok(T.en['secretary.needsActionHint'].length > 0)
})

test('the current run shows its step highlighted with the elapsed time from the beat start (why: a blank step line hid progress)', () => {
  const now = 1_700_000_000_000
  const run = (extra) =>
    Object.assign(
      {
        sessionId: 's-2',
        title: '收尾',
        workspace: '',
        live: true,
        state: 'Working',
        workers: [],
        beats: { count: 1, startedAt: now - 372000, capped: false, stoppedReason: null },
        lastReport: null,
      },
      extra,
    )
  const at = (row) => secretaryPayload({ orchestrators: [row] })

  const view = mount(T.SecretaryOverview, { t, width: 1200, now, payload: at(run()) })
  const current = byTestId(view.tree, 'orchestrator-secretary-current')
  assert.match(textOf(current), /secretary.currentStep/)
  // No step in this fixture (null): the highlighted value is 未提供, never blank.
  assert.equal(textOf(byTestId(view.tree, 'orchestrator-secretary-current-step')).trim(), 'secretary.stepNone')
  assert.match(textOf(current), /secretary.elapsed/)
  assert.equal(textOf(byTestId(view.tree, 'orchestrator-secretary-current-elapsed')).trim(), '06:12')

  // When the payload does carry a step, the same line shows it instead of the placeholder.
  const stepped = mount(T.SecretaryOverview, { t, width: 1200, now, payload: at(run({ step: { index: 3, total: 5 } })) })
  assert.equal(textOf(byTestId(stepped.tree, 'orchestrator-secretary-current-step')).trim(), '3 / 5')

  // Without a beat start the elapsed cell says '—' rather than a made-up zero.
  const noBeat = mount(T.SecretaryOverview, {
    t,
    width: 1200,
    now,
    payload: at(run({ beats: { count: 0, startedAt: null, capped: false, stoppedReason: null } })),
  })
  assert.equal(textOf(byTestId(noBeat.tree, 'orchestrator-secretary-current-elapsed')).trim(), '—')
})

test('the settings tab shows the policy numbers the payload carries, keyed by the real config key', () => {
  const render = (policy) => {
    const scope = fakeScope()
    const view = mount(T.SecretarySettings, { t, orch: scope, payload: secretaryPayload({ policy }), mutate: scope.mutate })
    return {
      view,
      // The field is addressed by its config key; the number it shows comes from the payload's
      // short policy name. The two must not be the same string (see the write test below).
      field: (key) => byTestId(view.tree, 'orchestrator-secretary-field-' + key),
      scope,
    }
  }
  const first = render({
    beatSeconds: 180,
    maxRunSeconds: 7200,
    notifyOn: { state: true, step: false, block: true, deliverable: false, timeout: true },
    promptText: '口径一',
  })
  assert.equal(first.field('secretaryBeatSeconds').props.value, '180')
  assert.equal(first.field('secretaryMaxRunSeconds').props.value, '7200')
  assert.equal(first.field('beatSeconds'), undefined, 'the payload name is never the field key')
  assert.equal(byTestId(first.view.tree, 'orchestrator-secretary-prompt').props.value, '口径一')
  assert.equal(byTestId(first.view.tree, 'orchestrator-secretary-notify-state').props.checked, true)
  assert.equal(byTestId(first.view.tree, 'orchestrator-secretary-notify-step').props.checked, false)

  // A second profile with different numbers renders those numbers: nothing is hardcoded.
  const second = render({
    beatSeconds: 300,
    maxRunSeconds: 900,
    notifyOn: { state: true, step: true, block: true, deliverable: true, timeout: true },
    promptText: '',
  })
  assert.equal(second.field('secretaryBeatSeconds').props.value, '300')
  assert.equal(second.field('secretaryMaxRunSeconds').props.value, '900')

  // The report location is a property of each registered row. The old single "report root" line
  // was a policy field the endpoint never sent, so it went away with the row-level display.
  const binding = textOf(byTestId(first.view.tree, 'orchestrator-secretary-binding'))
  assert.match(binding, /D:\\w/)
  assert.match(binding, /secretary\.workspaceNone/)
  assert.equal(textOf(first.view.tree).includes('secretary.reportsRoot'), false)
})

test('a policy edit writes the full config key with the snapshot revision', async () => {
  const scope = fakeScope()
  const view = mount(T.SecretarySettings, { t, orch: scope, payload: secretaryPayload(), mutate: scope.mutate })
  const field = () => byTestId(view.tree, 'orchestrator-secretary-field-secretaryBeatSeconds')
  field().props.onChange({ target: { value: '300' } })
  await field().props.onBlur()
  await flush()
  // A write to the payload's short name beatSeconds reaches no config field at all, so the
  // beat never changed. The path is the schema key.
  assert.deepEqual(plain(scope.calls[0].ops), [{ op: 'set', path: ['secretaryBeatSeconds'], value: 300 }])
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

test('registering, unregistering and designating the Master address the stored row, not the normalized index', async () => {
  // The fixture's raw list is longer than the normalized one (s-9 duplicates the Master and is
  // dropped), so a normalized index addresses the wrong stored row.
  const scope = fakeScope()
  const view = mount(T.SecretarySettings, { t, orch: scope, payload: secretaryPayload(), mutate: scope.mutate })
  byTestId(view.tree, 'orchestrator-secretary-register-id').props.onChange({ target: { value: 's-3' } })
  byTestId(view.tree, 'orchestrator-secretary-register-title').props.onChange({ target: { value: '新会话' } })
  byTestId(view.tree, 'orchestrator-secretary-register').props.onClick()
  await flush()
  const registered = plain(scope.calls[0].ops[0])
  // Appended at the stored length (3), not the normalized length (2): a set at 2 would overwrite
  // the stored row that sits there.
  assert.deepEqual(registered.path, ['secretaryOrchestrators', '3'])
  assert.equal(registered.op, 'set')
  assert.equal(registered.value.sessionId, 's-3')
  assert.equal(registered.value.title, '新会话')
  assert.equal(typeof registered.value.trackedAt, 'number')

  // s-2 is normalized index 1 but stored index 2; the old code unset index 1 — the Master row.
  byTestId(view.tree, 'orchestrator-secretary-unregister-s-2').props.onClick()
  await flush()
  assert.deepEqual(plain(scope.calls[1].ops), [{ op: 'unset', path: ['secretaryOrchestrators', '2'] }])

  // Two rows have to go (the new Master and the row duplicating it). Unsetting both by index
  // would shift the second index, so the whole list is rewritten from the normalized rows.
  byTestId(view.tree, 'orchestrator-secretary-setmaster-s-2').props.onClick()
  await flush()
  assert.deepEqual(plain(scope.calls[2].ops), [
    { op: 'set', path: ['secretaryMasterSessionId'], value: 's-2' },
    {
      op: 'set',
      path: ['secretaryOrchestrators'],
      value: [{ sessionId: 's-1', workspace: 'D:\\w', title: '构建视图', trackedAt: 1 }],
    },
  ])
})

test('an id the stored list does not hold is removed by rewriting, never by index (why: index deletes a neighbour)', async () => {
  // The host sent no raw list at all: there is no index to trust.
  const legacy = fakeScope()
  const legacyView = mount(T.SecretarySettings, {
    t,
    orch: legacy,
    payload: secretaryPayload({ registry: { masterSessionId: 'm-1', orchestrators: [{ sessionId: 's-1', title: '构建', workspace: 'D:\\w', trackedAt: 1 }], conflict: null } }),
    mutate: legacy.mutate,
  })
  byTestId(legacyView.tree, 'orchestrator-secretary-unregister-s-1').props.onClick()
  await flush()
  assert.deepEqual(plain(legacy.calls[0].ops), [{ op: 'set', path: ['secretaryOrchestrators'], value: [] }])

  // A raw list that does not contain the row (a stale payload) is no better.
  const stale = fakeScope()
  const staleView = mount(T.SecretarySettings, {
    t,
    orch: stale,
    payload: secretaryPayload({
      registry: { masterSessionId: '', orchestrators: [{ sessionId: 's-1', title: '构建', workspace: 'D:\\w', trackedAt: 1 }], raw: [{ sessionId: 'other' }], conflict: null },
    }),
    mutate: stale.mutate,
  })
  byTestId(staleView.tree, 'orchestrator-secretary-unregister-s-1').props.onClick()
  await flush()
  assert.deepEqual(plain(stale.calls[0].ops), [{ op: 'set', path: ['secretaryOrchestrators'], value: [] }])
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
  // With the switch off no endpoint is registered and the entry disappears; the page left on
  // screen has to say so and point at the plugin settings that can turn it back on.
  assert.match(textOf(byTestId(view.tree, 'orchestrator-secretary-disabled-hint')), /secretary\.disabledHint/i)
  assert.equal(loads, 0, 'a disabled view never calls the endpoint')
  byTestId(view.tree, 'orchestrator-secretary-enable').props.onClick()
  await flush()
  assert.deepEqual(plain(scope.calls[0].ops), [{ op: 'set', path: ['secretaryEnabled'], value: true }])
})

test('the tracking switch shows the host answer and writes both directions (why: it could only turn off)', async () => {
  // On: the switch is checked because the endpoint says enabled, and turning it off writes
  // false — the one value the old hardwired handler could produce at all.
  const scope = fakeScope({ initial: { secretaryEnabled: true } })
  const view = mount(T.SecretarySettings, { t, orch: scope, payload: secretaryPayload(), mutate: scope.mutate })
  const toggle = byTestId(view.tree, 'orchestrator-secretary-enabled')
  assert.equal(toggle.props.checked, true, 'the switch shows what the endpoint reports')
  toggle.props.onChange()
  await flush()
  assert.deepEqual(plain(scope.calls[0].ops), [{ op: 'set', path: ['secretaryEnabled'], value: false }])

  // Off: a host that answers enabled:false shows an unchecked switch, and clicking it turns the
  // secretary on instead of writing false once more.
  const offScope = fakeScope({ initial: { secretaryEnabled: true } })
  const offView = mount(T.SecretarySettings, {
    t,
    orch: offScope,
    payload: secretaryPayload({ enabled: false }),
    mutate: offScope.mutate,
  })
  const offToggle = byTestId(offView.tree, 'orchestrator-secretary-enabled')
  assert.equal(offToggle.props.checked, false)
  offToggle.props.onChange()
  await flush()
  assert.deepEqual(plain(offScope.calls[0].ops), [{ op: 'set', path: ['secretaryEnabled'], value: true }])
})

// ---- 秘书设置区：模型路由、卡点唤醒与正文截断 ----------------------------------------------

/** Mount the secretary settings tab over the three route scopes and one model catalog. */
function mountSecretarySettings({
  initial = {},
  mainInitial = {},
  workerInitial = {},
  groups = ROW_GROUPS,
  payload = secretaryPayload(),
  catalog,
} = {}) {
  const orch = fakeScope({ initial })
  const scopes = {
    main: fakeScope({ initial: mainInitial }),
    worker: fakeScope({ initial: workerInitial }),
    orch,
    // REVIEW.ns 与 NS 同值：评审路由和 worker 路由存在同一个 orchestrator 条目里，所以设置区
    // 递的是同一个 controller，这里也照实情写。
    review: orch,
  }
  const view = mount(T.SecretarySettings, {
    t,
    orch: scopes.orch,
    payload,
    mutate: scopes.orch.mutate,
    scopes,
    catalog: catalog ?? (async () => ({ ok: true, value: { groups } })),
  })
  return { view, scopes }
}

test('the settings tab renders the three route rows from their config scopes', async () => {
  const { view } = mountSecretarySettings({
    mainInitial: { provider: 'nexus-claude', model: 'claude/opus:5.5', reasoningEffort: 'high' },
    workerInitial: { workerProvider: 'nexus-deepseek', workerModel: 'deepseek-v4.1-flash' },
  })
  await flush()
  const rows = () => nodes(view.tree).filter((node) => node.type === T.RouteRow)
  assert.deepEqual(rows().map((row) => row.props.label), ['route.main', 'route.worker', 'route.review'])
  // The shown value is the scope's snapshot, mapped through that route's field table.
  assert.deepEqual(plain(rows()[0].props.route), { provider: 'nexus-claude', model: 'claude/opus:5.5', effort: 'high' })
  assert.deepEqual(plain(rows()[1].props.route), {
    provider: 'nexus-deepseek',
    model: 'deepseek-v4.1-flash',
    effort: '',
  })
  // The reviewer starts empty, which is how "follow the worker" is stored.
  assert.deepEqual(plain(rows()[2].props.route), { provider: '', model: '', effort: '' })
  // Each row carries its own test id so a browser can address it.
  for (const key of ['main', 'worker', 'review']) {
    assert.ok(byTestId(view.tree, 'orchestrator-secretary-route-' + key), key)
  }
  // One catalog feeds all three rows; a writable scope and an idle tab leave them enabled.
  assert.equal(rows()[0].props.groups.length, ROW_GROUPS.length)
  assert.equal(rows()[2].props.groups, rows()[0].props.groups)
  assert.equal(rows()[0].props.disabled, false)
})

test('the three route rows write the same config keys the plugin settings page writes', async () => {
  const { view, scopes } = mountSecretarySettings()
  await flush()
  const rows = () => nodes(view.tree).filter((node) => node.type === T.RouteRow)

  // Main: the host's agent-default-model entry, three ops under its own field names.
  await rows()[0].props.onChange({ provider: 'nexus-deepseek', model: 'deepseek-v4.1-pro', effort: 'high' })
  await flush()
  assert.deepEqual(plain(scopes.main.calls[0].ops), [
    { op: 'set', path: ['provider'], value: 'nexus-deepseek' },
    { op: 'set', path: ['model'], value: 'deepseek-v4.1-pro' },
    { op: 'set', path: ['reasoningEffort'], value: 'high' },
  ])
  assert.equal(scopes.main.calls[0].expected, 1)

  // Worker: this plugin's own entry.
  await rows()[1].props.onChange({ provider: 'p', model: 'm', effort: 'low' })
  await flush()
  assert.deepEqual(plain(scopes.worker.calls[0].ops), [
    { op: 'set', path: ['workerProvider'], value: 'p' },
    { op: 'set', path: ['workerModel'], value: 'm' },
    { op: 'set', path: ['workerReasoningEffort'], value: 'low' },
  ])

  // Reviewer: the review fields in the same entry. No effort stores '' rather than an unset,
  // because an unset would bring the bundled default back.
  await rows()[2].props.onChange({ provider: 'p2', model: 'm2', effort: '' })
  await flush()
  assert.deepEqual(plain(scopes.orch.calls[0].ops), [
    { op: 'set', path: ['reviewProvider'], value: 'p2' },
    { op: 'set', path: ['reviewModel'], value: 'm2' },
    { op: 'set', path: ['reviewReasoningEffort'], value: '' },
  ])
  assert.equal(byTestId(view.tree, 'orchestrator-secretary-settings-error'), undefined)
})

test('the wake-on-blocked switch reads the scope and writes both directions (why: the payload omits the key)', async () => {
  // The server's composePolicy whitelists four keys only, so a payload copy of this one never
  // arrives; the stored value has to come from the scope snapshot.
  const payload = secretaryPayload()
  assert.equal('secretaryWakeOnBlocked' in (payload.policy ?? {}), false)

  const off = mountSecretarySettings({ initial: { secretaryWakeOnBlocked: false }, payload })
  await flush()
  const offSwitch = byTestId(off.view.tree, 'orchestrator-secretary-wake-on-blocked')
  assert.equal(offSwitch.props.checked, false, 'the switch shows the stored false')
  offSwitch.props.onChange()
  await flush()
  assert.deepEqual(plain(off.scopes.orch.calls[0].ops), [{ op: 'set', path: ['secretaryWakeOnBlocked'], value: true }])

  const on = mountSecretarySettings({ initial: { secretaryWakeOnBlocked: true }, payload })
  await flush()
  const onSwitch = byTestId(on.view.tree, 'orchestrator-secretary-wake-on-blocked')
  assert.equal(onSwitch.props.checked, true, 'and the stored true')
  onSwitch.props.onChange()
  await flush()
  assert.deepEqual(plain(on.scopes.orch.calls[0].ops), [{ op: 'set', path: ['secretaryWakeOnBlocked'], value: false }])
})


test('a tab handed no route scopes renders no editable row instead of writing to the wrong entry', async () => {
  // 缺 main/worker/review 的 controller 时，退回 orch 会把 MAIN 的字段名写进 orchestrator
  // 条目——写错地方比不显示更糟，所以这一段干脆不出现。
  const scope = fakeScope()
  const bare = mount(T.SecretarySettings, {
    t,
    orch: scope,
    payload: secretaryPayload(),
    mutate: scope.mutate,
    catalog: async () => ({ ok: true, value: { groups: ROW_GROUPS } }),
  })
  await flush()
  assert.equal(nodes(bare.tree).some((node) => node.type === T.RouteRow), false)
  assert.equal(byTestId(bare.tree, 'orchestrator-secretary-routes'), undefined)
  bare.unmount()
})

test('a failed catalog read is said out loud instead of looking like an empty model list', async () => {
  const { view } = mountSecretarySettings({ catalog: async () => ({ ok: false, error: { message: 'no catalog' } }) })
  await flush()
  const alert = byTestId(view.tree, 'orchestrator-secretary-routes-error')
  assert.equal(alert.props.role, 'alert')
  assert.match(textOf(alert), /route\.catalogFailed/)
  assert.equal(nodes(view.tree).some((node) => node.type === T.RouteRow), false)
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
  assert.equal(ctx.mounts[0].descriptors[0].id, 'dsh-engineer-assistants-secretary#orchestratorSecretary/secretaryState')
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




// ---- 秘书设置页的「查看设计稿」入口 ---------------------------------------------------------
// 设计稿由服务端在同一 3080 上托管（见 test/index.test.mjs 的设计稿用例），这里只守入口：
// 一个 <a>、新窗口、noreferrer。不用 iframe：设计稿是独立文档，同源 iframe 只会把脚本
// 和布局耦合进来。

test('the settings tab links to the hosted design in a new tab', async () => {
  // 两种语言都要有这份文案；键集一致性在别处守着，这里守内容。
  assert.equal(T.zh['secretary.design'], '查看设计稿')
  assert.equal(T.en['secretary.design'], 'Open the design')

  const { view } = mountSecretarySettings()
  await flush()
  const link = byTestId(view.tree, 'orchestrator-secretary-design-link')
  assert.ok(link, 'the settings tab carries the design entry')
  assert.equal(link.type, 'a', 'a link, not an iframe')
  assert.equal(link.props.href, '/orchestrator/secretary-view')
  assert.equal(link.props.target, '_blank')
  assert.equal(link.props.rel, 'noreferrer')
  // mountSecretarySettings uses the identity translator, so the shown text is the key it uses.
  assert.equal(textOf(link).trim(), 'secretary.design')
  view.unmount()
})

// ---- 右栏面板（票 12：dock 接线） --------------------------------------------------------

/**
 * 端点一次交出的两半：模型（三个常驻入口 + master 指向 + worker 列表）与点击动作表。
 * `plain()` 比较的是 JSON，所以这里只用可序列化的值。
 */
const PANEL_MODEL = () => ({
  fixed: [
    { id: 'master', title: 'master' },
    { id: 'inspector', title: 'inspector' },
    { id: 'reporter', title: 'reporter' },
  ],
  master: { sessionId: 'master-session' },
  workers: [
    { sessionId: 'w-1', presetId: 'worker-a', category: 'code', status: 'running', startedAt: 10, retries: 0 },
    { sessionId: 'w-2', presetId: 'worker-b', category: 'review', status: 'reserved', startedAt: 20, retries: 2 },
  ],
})

const PANEL_ACTIONS = () => ({
  fixed: [
    { id: 'master', action: { kind: 'open-session', sessionId: 'master-session' } },
    { id: 'inspector', action: { kind: 'show-section', section: 'inspector' } },
    { id: 'reporter', action: { kind: 'show-section', section: 'reporter' } },
  ],
  workers: [
    { sessionId: 'w-1', action: { kind: 'open-worker', sessionId: 'w-1' } },
    { sessionId: 'w-2', action: { kind: 'open-worker', sessionId: 'w-2', address: 'ignored' } },
  ],
})

const panelPayload = () => ({ model: PANEL_MODEL(), actions: PANEL_ACTIONS() })

/** 一个只认 panel 端点、只经 ctx.remote.$mount 暴露的宿主。 */
function fakePanelCtx({ value = panelPayload(), result, failFirstMount = false } = {}) {
  const mounts = []
  const ctx = {
    mounts,
    get(name) {
      if (name === 'remote.orchestratorPanel') return ctx.namespace
      return undefined
    },
    remote: {
      $mount(contribution) {
        mounts.push(contribution)
        if (failFirstMount === true && mounts.length === 1) {
          return Promise.reject(new Error('the host is not ready yet'))
        }
        ctx.namespace = { panelState: async () => (result === undefined ? { ok: true, value } : result) }
        return Promise.resolve(() => {})
      },
    },
  }
  return ctx
}

test('loadPanelState resolves the payload through one mount', async () => {
  const { loadPanelState, PANEL_CONTRIBUTION, PANEL_TAB_ID, PANEL_TAB_KIND } = T
  const ctx = fakePanelCtx()
  assert.deepEqual(plain(await loadPanelState(ctx)), plain(panelPayload()))
  assert.deepEqual(plain(await loadPanelState(ctx)), plain(panelPayload()))
  assert.equal(ctx.mounts.length, 1, 'one mount serves every read')
  assert.equal(ctx.mounts[0].package, 'dsh-engineer-assistants-panel')
  assert.equal(ctx.mounts[0].descriptors.length, 1)
  assert.equal(ctx.mounts[0].descriptors[0].id, 'dsh-engineer-assistants-panel#orchestratorPanel/panelState')
  assert.equal(ctx.mounts[0].descriptors[0].service, 'orchestratorPanel')
  assert.equal(ctx.mounts[0].descriptors[0].namespace, 'orchestratorPanel')
  assert.equal(ctx.mounts[0].descriptors[0].method, 'panelState')
  assert.deepEqual(plain(ctx.mounts[0].descriptors[0].parameters), [])
  assert.deepEqual(plain(ctx.mounts[0].descriptors[0].result), { mode: 'src-json' })
  assert.equal(PANEL_CONTRIBUTION.descriptors[0].id, 'dsh-engineer-assistants-panel#orchestratorPanel/panelState')
  assert.equal(PANEL_TAB_KIND, 'engineer-assistants-panel')
  assert.equal(PANEL_TAB_ID, 'dsh-engineer-assistants-panel')
})

test('an unavailable panel namespace and a failed result both reject with the host message', async () => {
  const { loadPanelState } = T
  const unavailable = { mounts: [], remote: { $mount: async () => {} }, get: () => undefined }
  await assert.rejects(loadPanelState(unavailable), /orchestratorPanel\/panelState is unavailable/)
  const failed = fakePanelCtx({ result: { ok: false, error: { message: 'assignments are not wired' } } })
  await assert.rejects(loadPanelState(failed), /assignments are not wired/)
})

const PANEL_ADDRESS = () => ({ parentSessionId: 'parent-1', childSessionId: 'child-1', mode: 'continuable' })

test('panelOpenStepsOf resolves the address and keeps the bare id as the fallback', () => {
  const { panelOpenStepsOf, panelChatAddressOf } = T
  const steps = panelOpenStepsOf('child-1', () => PANEL_ADDRESS())
  assert.deepEqual(plain(steps.resource), {
    address: 'dsh-resource://subagentchat/session/child-1?parent=parent-1&mode=continuable',
    kind: 'subagentchat',
    preferNewPane: true,
  })
  // 解析出地址时退路递的是地址不是裸 id：宿主的 SessionTarget 是 SessionId | SubagentAddress。
  assert.deepEqual(plain(steps.session), PANEL_ADDRESS())
  // 客户端与服务端各自拼一次地址，差一个字符宿主就认不出来，所以逐字比。
  assert.equal(steps.resource.address, panelSurface.workerChatAddressOf({ address: PANEL_ADDRESS() }))
  // 空白与不常见的值也必须逐字一致：URLSearchParams 编的是 form-urlencoded，不是 encodeURIComponent。
  const odd = { parentSessionId: 'p 1', childSessionId: 'child/1 a', mode: 'unknown' }
  assert.equal(
    panelOpenStepsOf('child/1 a', () => odd).resource.address,
    panelSurface.workerChatAddressOf({ address: odd }),
  )
  assert.equal(panelChatAddressOf(odd), panelSurface.workerChatAddressOf({ address: odd }))
})

test('panelOpenStepsOf treats nothing, junk and a throw as "no address"', () => {
  const { panelOpenStepsOf } = T
  for (const resolver of [
    () => undefined,
    () => null,
    () => ({}),
    () => ({ parentSessionId: 'p', childSessionId: 'c' }),
    () => ({ parentSessionId: 'p', childSessionId: '   ', mode: 'continuable' }),
    () => {
      throw new Error('the sessions domain is gone')
    },
  ]) {
    const bare = panelOpenStepsOf('child-1', resolver)
    assert.equal(bare.resource, undefined)
    assert.equal(bare.session, 'child-1')
  }
  // mode 不在宿主认的三种里：右栏开不了，但地址仍能当主栏目标。
  const unknownMode = panelOpenStepsOf('child-1', () => ({ parentSessionId: 'p', childSessionId: 'c', mode: 'once' }))
  assert.equal(unknownMode.resource, undefined)
  assert.equal(unknownMode.session.childSessionId, 'c')
  assert.equal(panelOpenStepsOf('   ', () => PANEL_ADDRESS()), undefined)
  assert.equal(panelOpenStepsOf(undefined, () => PANEL_ADDRESS()), undefined)
})

test('the click runner tries the dock first, falls back to the main column, and never throws', () => {
  const { panelOpenStepsOf, runPanelSteps } = T
  const steps = panelOpenStepsOf('child-1', () => PANEL_ADDRESS())
  const sessions = []

  // 右栏抛（没挂载 / 没有类型认领）：仍然要把地址交给主栏。
  const dockThrows = {
    get(name) {
      if (name === 'sidebarRight') return { openResource: () => { throw new Error('no registered tab type claims it') } }
      if (name === 'uiWorkspace') return { openSession: (target) => sessions.push(plain(target)) }
      return undefined
    },
  }
  assert.deepEqual(plain(runPanelSteps(dockThrows, steps)), { resource: false, session: true })
  assert.deepEqual(sessions[0], PANEL_ADDRESS())

  // 右栏开成：主栏一次都不碰。
  const dockCalls = []
  const dockOpens = {
    get(name) {
      if (name === 'sidebarRight') return { openResource: (address, options) => dockCalls.push([address, plain(options)]) }
      if (name === 'uiWorkspace') return { openSession: () => sessions.push('should not happen') }
      return undefined
    },
  }
  assert.deepEqual(plain(runPanelSteps(dockOpens, steps)), { resource: true, session: false })
  assert.equal(sessions.length, 1)
  assert.equal(dockCalls[0][0], steps.resource.address)
  assert.deepEqual(dockCalls[0][1], { kind: 'subagentchat', preferNewPane: true })

  // 两个服务都没有：报告什么也没开成，不抛。
  assert.deepEqual(plain(runPanelSteps({ get: () => undefined }, steps)), { resource: false, session: false })
  assert.deepEqual(plain(runPanelSteps(undefined, steps)), { resource: false, session: false })
  assert.deepEqual(plain(runPanelSteps({ get: () => undefined }, undefined)), { resource: false, session: false })
})

test('openPanelAction dispatches by kind and marks designate-master instead of inventing navigation', () => {
  const { openPanelAction } = T
  const opened = []
  const ctx = {
    get(name) {
      if (name === 'uiWorkspace') return { openSession: (id) => opened.push(id) }
      return undefined
    },
  }
  assert.deepEqual(plain(openPanelAction(ctx, { kind: 'open-session', sessionId: 'master-session' })), { landed: 'session' })
  assert.deepEqual(opened, ['master-session'])
  assert.deepEqual(plain(openPanelAction(ctx, { kind: 'designate-master' })), { landed: 'settings' })
  assert.deepEqual(plain(openPanelAction(ctx, { kind: 'show-section', section: 'inspector' })), { landed: 'none' })
  assert.deepEqual(plain(openPanelAction({ get: () => undefined }, { kind: 'open-session', sessionId: 'x' })), { landed: 'none' })
  assert.deepEqual(plain(openPanelAction(ctx, undefined)), { landed: 'none' })
  assert.equal(opened.length, 1, 'a marker or a no-op never opens anything')
})

/** 挂一次正文；`t` 是恒等翻译，断言的文本就是字典键本身。 */
function mountPanelBody({ value = panelPayload(), loadState, openAction } = {}) {
  return mount(T.OrchestratorPanelBody, {
    t,
    loadState: loadState ?? (async () => value),
    addressOf: () => undefined,
    openAction: openAction ?? (() => ({ landed: 'none' })),
  })
}

/** 正文里的行，按渲染顺序。 */
function panelRowIds(tree) {
  return nodes(tree)
    .map((node) => String(node.props?.['data-testid'] ?? ''))
    .filter((id) => /^orchestrator-panel-(fixed|worker)-/.test(id))
}

test('the panel body lists the three fixed entries, then the workers in model order', async () => {
  const view = mountPanelBody()
  await flush(14)
  assert.equal(byTestId(view.tree, 'orchestrator-panel-loading'), undefined)
  assert.deepEqual(panelRowIds(view.tree), [
    'orchestrator-panel-fixed-master',
    'orchestrator-panel-fixed-inspector',
    'orchestrator-panel-fixed-reporter',
    'orchestrator-panel-worker-w-1',
    'orchestrator-panel-worker-w-2',
  ])
  // master 行写它指向的会话 id；两个 worker 写 presetId / 状态 / 重试次数。
  const master = byTestId(view.tree, 'orchestrator-panel-fixed-master')
  assert.match(textOf(master), /master-session/)
  const first = textOf(byTestId(view.tree, 'orchestrator-panel-worker-w-1'))
  assert.match(first, /worker-a/)
  assert.match(first, /running/)
  assert.equal(byTestId(view.tree, 'orchestrator-panel-retries-w-1'), undefined, 'zero retries stay quiet')
  const second = textOf(byTestId(view.tree, 'orchestrator-panel-worker-w-2'))
  assert.match(second, /worker-b/)
  assert.match(second, /reserved/)
  assert.match(textOf(byTestId(view.tree, 'orchestrator-panel-retries-w-2')), /2/)
  assert.equal(byTestId(view.tree, 'orchestrator-panel-empty'), undefined)
  view.unmount()
})

test('the row shows the preset category, and says so when no preset was applied', async () => {
  // 票 15：类别来自预设，不是常量。没有预设时这一行写出「未施加预设」，不是什么都不显示。
  const value = PANEL_MODEL()
  value.workers = [
    { sessionId: 'w-1', presetId: 'verifier', category: 'non-code', status: 'running', startedAt: 10, retries: 0 },
    { sessionId: 'w-2', presetId: '', category: '', status: 'running', startedAt: 20, retries: 0 },
  ]
  const view = mountPanelBody({ value: { model: value, actions: { fixed: PANEL_ACTIONS().fixed, workers: [] } } })
  await flush(14)
  assert.equal(textOf(byTestId(view.tree, 'orchestrator-panel-category-w-1')).trim(), 'non-code')
  assert.equal(textOf(byTestId(view.tree, 'orchestrator-panel-category-w-2')).trim(), 'dock.categoryUnset')
  assert.ok(T.zh['dock.categoryUnset'].length > 0)
  assert.ok(T.en['dock.categoryUnset'].length > 0)
  view.unmount()
})

test('the two section rows are text, not buttons that do nothing', async () => {
  // inspector / reporter 指向 show-section：分段视图还没做，画成按钮就是「点了没反应」。
  // master 有权动作，仍然是按钮。
  const view = mountPanelBody()
  await flush(14)
  const master = byTestId(view.tree, 'orchestrator-panel-fixed-master')
  const inspector = byTestId(view.tree, 'orchestrator-panel-fixed-inspector')
  const reporter = byTestId(view.tree, 'orchestrator-panel-fixed-reporter')
  assert.equal(master.type, 'button')
  assert.equal(typeof master.props.onClick, 'function')
  for (const [name, row] of [['inspector', inspector], ['reporter', reporter]]) {
    assert.notEqual(row.type, 'button', name + ' must not pretend to be clickable')
    assert.equal(row.props.onClick, undefined)
    assert.equal(row.props['data-interactive'], 'false')
  }
  view.unmount()
})

test('an undesignated master and an empty worker list both say so', async () => {
  const view = mountPanelBody({
    value: {
      model: { fixed: PANEL_MODEL().fixed, master: { sessionId: null }, workers: [] },
      actions: { fixed: PANEL_ACTIONS().fixed, workers: [] },
    },
  })
  await flush(14)
  assert.match(textOf(byTestId(view.tree, 'orchestrator-panel-fixed-master')), new RegExp('dock\\.master\\.none'))
  const empty = byTestId(view.tree, 'orchestrator-panel-empty')
  assert.ok(empty, 'no workers is one explicit line, not a blank list')
  assert.equal(textOf(empty).trim(), 'dock.empty')
  assert.deepEqual(panelRowIds(view.tree), [
    'orchestrator-panel-fixed-master',
    'orchestrator-panel-fixed-inspector',
    'orchestrator-panel-fixed-reporter',
  ])
  view.unmount()
})

test('a failed panel read is a visible alert that the retry button re-reads', async () => {
  let calls = 0
  const view = mountPanelBody({
    loadState: async () => {
      calls += 1
      if (calls === 1) throw new Error('assignments are not wired')
      return panelPayload()
    },
  })
  await flush(14)
  const alert = byTestId(view.tree, 'orchestrator-panel-error')
  assert.ok(alert, 'a failed read is never a blank frame')
  assert.equal(alert.props.role, 'alert')
  assert.match(textOf(alert), /assignments are not wired/)
  assert.equal(calls, 1)
  byTestId(view.tree, 'orchestrator-panel-retry').props.onClick()
  await flush(14)
  assert.equal(calls, 2, 'the retry really re-reads')
  assert.equal(byTestId(view.tree, 'orchestrator-panel-error'), undefined)
  assert.ok(byTestId(view.tree, 'orchestrator-panel-fixed-master'))
  view.unmount()
})

test('clicking a worker row hands the action to the runner, and designate-master shows the settings hint', async () => {
  const seen = []
  const view = mountPanelBody({
    value: {
      model: PANEL_MODEL(),
      actions: {
        fixed: [{ id: 'master', action: { kind: 'designate-master' } }, ...PANEL_ACTIONS().fixed.slice(1)],
        workers: PANEL_ACTIONS().workers,
      },
    },
    openAction: (action) => {
      seen.push(plain(action))
      return { landed: action.kind === 'designate-master' ? 'settings' : 'resource' }
    },
  })
  await flush(14)
  byTestId(view.tree, 'orchestrator-panel-worker-w-2').props.onClick()
  assert.deepEqual(seen[0], { kind: 'open-worker', sessionId: 'w-2', address: 'ignored' })
  assert.equal(byTestId(view.tree, 'orchestrator-panel-settings-hint'), undefined)
  byTestId(view.tree, 'orchestrator-panel-fixed-master').props.onClick()
  assert.deepEqual(seen[1], { kind: 'designate-master' })
  assert.ok(byTestId(view.tree, 'orchestrator-panel-settings-hint'), 'the marker is rendered as a hint')
  view.unmount()
})

test('the tab chip title and both dictionaries answer for the dock', () => {
  const view = mount(T.OrchestratorPanelTitle, { t })
  assert.equal(textOf(view.tree).trim(), 'dock.title')
  for (const key of Object.keys(T.zh).filter((entry) => entry.startsWith('dock.'))) {
    assert.equal(typeof T.en[key], 'string', 'the English table carries ' + key)
    assert.ok(T.en[key].length > 0, key)
    assert.ok(T.zh[key].length > 0, key)
  }
  assert.ok(Object.keys(T.zh).filter((entry) => entry.startsWith('dock.')).length >= 10)
})

// ---- 右栏红点（票 22） ----------------------------------------------------------------

const attentionPayload = (attention) => ({ model: PANEL_MODEL(), actions: PANEL_ACTIONS(), attention })

/** 红点上的数字：旁边还有给读屏的原因文字，这里只取可见的那个数。 */
const badgeNumber = (node) => String(node.kids.filter((kid) => typeof kid === 'string' || typeof kid === 'number').join('')).trim()

test('the client attention vocabulary is the inspector vocabulary, not a second one', () => {
  // 客户端 bundle 不能 import 服务端模块，所以词表只能镜像；这条测试与 panel-surface 的断言互补。
  assert.deepEqual(plain(T.ATTENTION_REASONS), [...panelSurface.ATTENTION_REASONS])
})

test('panelAttentionBadgeOf keeps only stuck, drawn workers and counts each one once', () => {
  const badge = plain(
    T.panelAttentionBadgeOf({
      workers: PANEL_MODEL().workers,
      attention: {
        'w-1': ['idle', 'idle', 'retrying'],
        'w-2': ['waiting-approval'],
        // 已经结束的 worker 不在列表里：红点不该为它亮。
        'w-9': ['idle'],
        // 监工不认识的原因不是「需要人」的理由。
        'w-3': ['slow'],
        '': ['idle'],
      },
    }),
  )
  assert.equal(badge.count, 2)
  assert.deepEqual(badge.sessionIds, ['w-1', 'w-2'])
  assert.deepEqual(badge.byReason, { idle: 1, retrying: 1, 'waiting-approval': 1 })
  assert.deepEqual(badge.reasonsOf, { 'w-1': ['idle', 'retrying'], 'w-2': ['waiting-approval'] })
})

test('the client badge agrees with the server badge for the same rows', () => {
  // 两边各算一遍是为了「画出来的行」这一侧能独立过滤；结果必须逐项相同，否则服务端说卡着、
  // 客户端不亮，而且不报错。
  const model = PANEL_MODEL()
  const attention = { 'w-1': ['idle', 'waiting-approval'], 'w-2': ['retrying'], gone: ['idle'] }
  const server = plain(panelSurface.badgeOf({ model, attention }))
  const client = plain(T.panelAttentionBadgeOf({ workers: model.workers, attention }))
  assert.equal(client.count, server.count)
  assert.deepEqual(client.sessionIds, server.sessionIds)
  assert.deepEqual(client.byReason, server.byReason)
})

test('junk attention and junk rows are "no red dot", never a throw', () => {
  // 端点失败另有 alert；红点这一侧只许安静地不亮——一个坏字段不能把整页面板打成错误。
  const empty = { count: 0, sessionIds: [], byReason: { idle: 0, retrying: 0, 'waiting-approval': 0 }, reasonsOf: {} }
  for (const attention of [undefined, null, 'w-1', [], 7, { 'w-1': 'idle' }, { 'w-1': [] }, { 'w-1': [{}] }]) {
    assert.deepEqual(plain(T.panelAttentionBadgeOf({ workers: PANEL_MODEL().workers, attention })), empty)
  }
  assert.deepEqual(plain(T.panelAttentionBadgeOf({ workers: 'w-1', attention: { 'w-1': ['idle'] } })), empty)
  assert.deepEqual(plain(T.panelAttentionBadgeOf()), empty)
  // 同一行在列表里出现两次，也只算一个卡住的 worker。
  const twice = plain(
    T.panelAttentionBadgeOf({
      workers: [PANEL_MODEL().workers[0], PANEL_MODEL().workers[0]],
      attention: { 'w-1': ['idle'] },
    }),
  )
  assert.equal(twice.count, 1)
  assert.deepEqual(twice.sessionIds, ['w-1'])
})

test('the stuck row carries its number and the workers head carries the deduped total', async () => {
  const view = mountPanelBody({
    value: attentionPayload({ 'w-1': ['idle', 'retrying'], 'w-2': ['waiting-approval'], 'w-9': ['idle'] }),
  })
  await flush(14)
  // 行上的数字 = 这一行卡在几处。
  assert.equal(badgeNumber(byTestId(view.tree, 'orchestrator-panel-attention-w-1')), '2')
  assert.equal(badgeNumber(byTestId(view.tree, 'orchestrator-panel-attention-w-2')), '1')
  // 不在画出来的列表里的 id 一个都不亮。
  assert.equal(byTestId(view.tree, 'orchestrator-panel-attention-w-9'), undefined)
  // 同一 worker 命中多种原因，在总数上只算一次。
  assert.equal(badgeNumber(byTestId(view.tree, 'orchestrator-panel-attention')), '2')
  view.unmount()
})

test('clicking the number says where the stuck workers are stuck', async () => {
  const view = mountPanelBody({ value: attentionPayload({ 'w-1': ['idle', 'retrying'], 'w-2': ['waiting-approval'] }) })
  await flush(14)
  assert.equal(byTestId(view.tree, 'orchestrator-panel-attention-detail'), undefined, '没点开时只有数字')
  assert.equal(byTestId(view.tree, 'orchestrator-panel-attention').props['aria-expanded'], false)
  byTestId(view.tree, 'orchestrator-panel-attention').props.onClick()
  await flush(14)
  assert.equal(byTestId(view.tree, 'orchestrator-panel-attention').props['aria-expanded'], true)
  assert.ok(byTestId(view.tree, 'orchestrator-panel-attention-detail'), '点开是三种原因，不是一个总数')
  for (const reason of ['idle', 'retrying', 'waiting-approval']) {
    assert.ok(byTestId(view.tree, 'orchestrator-panel-attention-reason-' + reason), reason)
  }
  // 再点一次收起来。
  byTestId(view.tree, 'orchestrator-panel-attention').props.onClick()
  await flush(14)
  assert.equal(byTestId(view.tree, 'orchestrator-panel-attention-detail'), undefined)
  view.unmount()
})

test('a payload without attention, or with junk attention, shows no number and no error', async () => {
  for (const value of [
    { model: PANEL_MODEL(), actions: PANEL_ACTIONS() },
    { model: PANEL_MODEL(), actions: PANEL_ACTIONS(), attention: null },
    { model: PANEL_MODEL(), actions: PANEL_ACTIONS(), attention: 'w-1' },
    { model: PANEL_MODEL(), actions: PANEL_ACTIONS(), attention: { 'w-1': ['slow'] } },
  ]) {
    const view = mountPanelBody({ value })
    await flush(14)
    assert.equal(byTestId(view.tree, 'orchestrator-panel-error'), undefined)
    assert.equal(byTestId(view.tree, 'orchestrator-panel-attention'), undefined)
    assert.equal(byTestId(view.tree, 'orchestrator-panel-attention-w-1'), undefined)
    assert.ok(byTestId(view.tree, 'orchestrator-panel-worker-w-1'), 'the rows still draw')
    view.unmount()
  }
})

test('the red dot reads the attention the one payload already carries', () => {
  // 接线那一行：红点不许开第二条查询，一次读回来的载荷里就有它。
  assert.match(src, /attention: payload\.attention/)
})

test('a worker id that looks like an Object member is just an id', async () => {
  // 载荷里的 sessionId 是外部数据：拿它直接查普通对象，'toString' / 'constructor' 会查到原型上的
  // 函数，join 一调就抛——整块右栏变成错误页。查表必须是自有属性。
  for (const id of ['toString', 'constructor', 'hasOwnProperty', '__proto__', 'valueOf']) {
    const view = mountPanelBody({
      value: {
        model: {
          fixed: PANEL_MODEL().fixed,
          master: PANEL_MODEL().master,
          workers: [{ sessionId: id, presetId: 'w', category: 'code', status: 'running', startedAt: 1, retries: 0 }],
        },
        actions: { fixed: PANEL_ACTIONS().fixed, workers: [] },
      },
    })
    await flush(14)
    assert.ok(byTestId(view.tree, 'orchestrator-panel-worker-' + id), id + ' still draws')
    assert.equal(byTestId(view.tree, 'orchestrator-panel-attention-' + id), undefined, id + ' is not stuck')
    assert.equal(byTestId(view.tree, 'orchestrator-panel-error'), undefined, id + ' must not crash the panel')
    view.unmount()
  }
  // 同一个 id 真卡住时照常亮，且只报它自己的原因。
  const lit = plain(T.panelAttentionBadgeOf({ workers: [{ sessionId: 'toString' }], attention: { toString: ['idle'] } }))
  assert.deepEqual(lit.sessionIds, ['toString'])
  assert.deepEqual(Object.keys(lit.reasonsOf), ['toString'])
})

test('the accessible name carries the number, and the row reads out why it is stuck', async () => {
  const view = mountPanelBody({ value: attentionPayload({ 'w-1': ['idle', 'retrying'], 'w-2': ['waiting-approval'] }) })
  await flush(14)
  const total = byTestId(view.tree, 'orchestrator-panel-attention')
  // 可见文本是「2」，可访问名必须也含「2」（Label in Name）；读屏才有数量可听。
  assert.ok(total.props['aria-label'].includes('2'), 'the visible number is in the name: ' + total.props['aria-label'])
  assert.equal(total.props['aria-controls'], 'orchestrator-panel-attention-detail')
  // 行上的原因不只是 title：读屏与键盘用户也拿得到。
  const reasons = byTestId(view.tree, 'orchestrator-panel-attention-reasons-w-1')
  assert.ok(reasons, 'the row carries its reasons as text, not only a tooltip')
  assert.match(textOf(reasons), /idle/)
  assert.match(textOf(reasons), /retrying/)
  // 展开区的 id 与按钮的 aria-controls 对得上。
  total.props.onClick()
  await flush(14)
  assert.equal(byTestId(view.tree, 'orchestrator-panel-attention-detail').props.id, total.props['aria-controls'])
  view.unmount()
})

test('the reason labels come from the dictionaries, not raw keys', () => {
  const zh = (key) => (T.zh[key] === undefined ? key : T.zh[key])
  assert.equal(T.panelAttentionText(zh, 'idle'), '空转')
  assert.equal(T.panelAttentionText(zh, 'retrying'), '重试中')
  assert.equal(T.panelAttentionText(zh, 'waiting-approval'), '等批准')
  // 宿主将来加原因时退回原字，不把 key 显示给人看（同 panelStatusText）。
  assert.equal(T.panelAttentionText(zh, 'slow'), 'slow')
})

/** apply 的最小宿主：只有右栏三个服务按开关提供，其余按秘书接线需要的最少形状。 */
function fakeApplyCtx({ dock = false, registerThrows = false } = {}) {
  const slotNames = []
  const slots = []
  const types = []
  const openTabCalls = []
  const disposers = []
  const ctx = {
    effect: (fn) => {
      const disposer = fn()
      const stop = () => {
        if (typeof disposer === 'function') disposer()
      }
      disposers.push(stop)
      return stop
    },
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject: (name, build) => {
        const disposer = build()
        return typeof disposer === 'function' ? disposer : () => {}
      },
      register: (spec) => {
        slotNames.push(spec.name)
        slots.push(spec)
        return () => {}
      },
    },
    configForms: {
      get: () => ({
        getSnapshot: () => ({ status: 'ready', writable: true, revision: 1, value: {} }),
        subscribe: () => () => {},
        mutate: async () => {},
      }),
    },
    remote: {},
    get(name) {
      if (dock !== true) return undefined
      if (name === 'sidebarRightTabs') {
        return {
          register: (definition) => {
            if (registerThrows) throw new Error('sidebarRight: tab id "dsh-engineer-assistants-panel" is already registered')
            types.push(definition)
            return () => {}
          },
        }
      }
      if (name === 'sidebarRight') {
        return {
          openResource: () => {},
          openTab: (...args) => {
            openTabCalls.push(args)
          },
        }
      }
      if (name === 'uiWorkspace') return { openSession: () => {} }
      return undefined
    },
  }
  return { ctx, slotNames, slots, types, openTabCalls, disposers }
}

test('apply wires the dock only when the host provides it, and loads without it', () => {
  // 老宿主：三个服务一个都没有，apply 不许抛，也不许留下半个注册。
  const absent = fakeApplyCtx()
  assert.doesNotThrow(() => mod.apply(absent.ctx))
  assert.equal(absent.types.length, 0)
  assert.deepEqual(absent.slotNames.filter((name) => name.startsWith('sidebar.right.')), [])

  const present = fakeApplyCtx({ dock: true })
  assert.doesNotThrow(() => mod.apply(present.ctx))
  assert.equal(present.types.length, 1)
  assert.equal(present.types[0].id, 'dsh-engineer-assistants-panel')
  assert.equal(present.types[0].kind, 'engineer-assistants-panel')
  assert.equal(present.types[0].priority, 'extension')
  assert.equal(present.types[0].patterns, undefined, 'a page type recognizes no address')
  assert.equal(present.types[0].title(), 'dock.title', 'the chip reads the dictionary through the bound translator')
  assert.deepEqual(plain(present.types[0].guide.map((entry) => entry.id)), ['panel'])
  // 槽按定义 id 认领，不按 kind；三个都在，而且 key 就是那个 id——宿主按 entryKey 找 body，
  // key 写错只会掉进「这个类型没有实现」的兜底，静默不报错。
  assert.deepEqual(present.slotNames.filter((name) => name.startsWith('sidebar.right.')), [
    'sidebar.right.tab.guide.entry',
    'sidebar.right.pane.tab',
    'sidebar.right.pane.tab.title',
  ])
  for (const spec of present.slots.filter((slot) => slot.name.startsWith('sidebar.right.'))) {
    assert.equal(spec.key, present.types[0].id, spec.name + ' is keyed by the definition id, not the kind')
  }

  // 引导入口与宿主自己的入口同一种开法：replaceTab 不给的话引导页会留在面板旁边。
  const guide = present.slots.find((slot) => slot.name === 'sidebar.right.tab.guide.entry')
  guide.inject().open()
  // 值来自 vm 上下文，原型不同，按 JSON 比。
  assert.deepEqual(plain(present.openTabCalls), [['engineer-assistants-panel', { replaceTab: true }]])
})

test('a second registration of the same type does not take the whole boot down', () => {
  // 同一档位重复注册时宿主会抛。让它冒出 apply 就是 web boot 失败——而这个类型已经在那里了，
  // 效果一样，所以吞掉、留日志、继续。
  const present = fakeApplyCtx({ dock: true, registerThrows: true })
  assert.doesNotThrow(() => mod.apply(present.ctx))
  assert.equal(present.types.length, 0)
  // 类型没注册上，槽仍然注册：宿主找不到 body 时会画兜底，不会因为缺槽崩掉整页。
  assert.equal(present.slots.filter((slot) => slot.name === 'sidebar.right.pane.tab').length, 1)
})

test('the panel still registers when only the tab registry exists', () => {
  // 注册一个类型只要注册表与插槽；右栏/主栏是点击时才需要的东西。
  const onlyTabs = fakeApplyCtx({ dock: true })
  const get = onlyTabs.ctx.get
  onlyTabs.ctx.get = (name) => (name === 'sidebarRight' || name === 'uiWorkspace' ? undefined : get(name))
  assert.doesNotThrow(() => mod.apply(onlyTabs.ctx))
  assert.equal(onlyTabs.types.length, 1, 'the type is registered even without the dock services')
})

// ---- 死页签清扫（票 12） -------------------------------------------------------------------
//
// worker 结束以后它那个聊天页签还开着，里面是一条没人能再说话的会话。清扫靠两条触发点，
// 安全规则压过覆盖率：宿主还列着的子会话一张都不许关。

/** 一张宿主 chat 页签的行，形状就是 openTabs 平表里的那一项。 */
const panelChatTab = (childId, overrides = {}) =>
  Object.assign(
    {
      sessionId: 'parent-1',
      tabId: 'tab-' + childId,
      kind: 'subagentchat',
      contentId:
        'dsh-resource://subagentchat/session/' + encodeURIComponent(childId) + '?parent=parent-1&mode=continuable',
    },
    overrides,
  )

test('the client parses a worker chat address like the server module, and is stricter on three shapes', () => {
  // 客户端读不进来服务端模块，只能照抄一份。两份在**可打印的正常形状**上必须一致；分歧只允许
  // 出现在「客户端拒、服务端收」这个方向——那样最坏是漏关一张死页签，不会误关活的。
  const inputs = [
    'dsh-resource://subagentchat/session/child-1?parent=parent-1&mode=continuable',
    'dsh-resource://subagentchat/session/child-1?parent=parent-1&mode=one-shot',
    'dsh-resource://subagentchat/session/child-1?parent=parent-1&mode=unknown',
    'dsh-resource://subagentchat/session/child%2F1%20a?parent=p%201&mode=continuable',
    'dsh-resource://subagentchat/session/child-1?parent=parent-1&mode=continuable&extra=1',
    'dsh-resource://subagentchat/session/child-1?parent=parent-1&mode=continuable#frag',
    'dsh-resource://subagentchat/session/child-1/',
    'dsh-resource://subagentchat/session//child-1?parent=p&mode=one-shot',
    'dsh-resource://subagentchat/session/child%20?parent=p&mode=one-shot',
    'dsh-resource://subagentchat/session/%20%20?parent=p&mode=one-shot',
    'dsh-resource://subagentchat/session/child%zz?parent=p&mode=one-shot',
    'dsh-resource://subagentchat/session/child-1',
    'dsh-resource://subagentchat/session/child-1?parent=&mode=one-shot',
    'dsh-resource://subagentchat/session/child-1?mode=continuable',
    'dsh-resource://subagentchat/session/child-1?parent=p&mode=once',
    'dsh-resource://subagentchat/session/child-1?parent=p&mode=continuable&parent=other',
    'dsh-resource://subagentchat/chat/child-1?parent=p&mode=continuable',
    'dsh-resource://subagentchat/session/child-1/child-2?parent=p&mode=continuable',
    'dsh-resource://subagentchat',
    'dsh-resource:///session/child-1?parent=p&mode=continuable',
    'dsh-resource://otherhost/session/child-1?parent=p&mode=continuable',
    'https://subagentchat/session/child-1?parent=p&mode=continuable',
    'dsh-resource://subagentchat/session/Child-1?parent=p&mode=continuable',
    'dsh-resource://subagentchat/Session/child-1?parent=p&mode=continuable',
    'dsh-resource://subagentchat/session/child-1?parent=p&mode=undefined',
    'not a url',
    '',
    undefined,
    null,
    42,
  ]
  for (const input of inputs) {
    const server = panelSurface.parseWorkerChatAddress(input)
    const expected = server === undefined ? undefined : server.childSessionId
    assert.equal(T.panelChatChildOf(input), expected, 'the mirror disagrees on ' + String(input))
  }
  // 两边都解析失败的地方不能靠「两边都坏」蒙过去：抽两条钉住真值。
  assert.equal(T.panelChatChildOf(inputs[0]), 'child-1')
  assert.equal(T.panelChatChildOf(inputs[3]), 'child/1 a')
  assert.equal(T.panelChatChildOf(inputs[11]), undefined, 'no query means no address')

  // 记下来的三处分歧（都实测过）：WHATWG 的 URL 会把 userinfo、端口、点段规范化掉，所以服务端
  // 解析器照收；客户端的解析器不走 URL，一律拒绝。方向安全，但要写成断言，别靠「大概没事」。
  for (const odd of [
    'dsh-resource://user@subagentchat/session/child-1?parent=p&mode=one-shot',
    'dsh-resource://subagentchat:8080/session/child-1?parent=p&mode=one-shot',
    'dsh-resource://subagentchat/./session/child-1?parent=p&mode=one-shot',
  ]) {
    assert.equal(typeof panelSurface.parseWorkerChatAddress(odd)?.childSessionId, 'string', 'the server takes ' + odd)
    assert.equal(T.panelChatChildOf(odd), undefined, 'the client refuses ' + odd)
  }
})

test('a tab is stale only when the server says its child ended, and it sits in the mounted session', () => {
  const { panelStaleTabIdsOf } = T
  const ended = ['dead-1']
  const stale = panelStaleTabIdsOf({ tabs: [panelChatTab('dead-1')], mountedSessionId: 'parent-1', ended })
  assert.deepEqual(plain(stale), ['tab-dead-1'])

  // 服务端没说结束的，一张都不许关——哪怕浏览器里根本查不到这个子会话。
  assert.deepEqual(plain(panelStaleTabIdsOf({ tabs: [panelChatTab('live-1')], mountedSessionId: 'parent-1', ended })), [])
  // 别的会话里的页签不归这里管：close() 只作用于挂载会话。
  assert.deepEqual(
    plain(panelStaleTabIdsOf({ tabs: [panelChatTab('dead-1', { sessionId: 'other-1' })], mountedSessionId: 'parent-1', ended })),
    [],
  )
  // contentId 里写着 subagentchat 不等于这张页签就是宿主的聊天页签：kind 也要对上。
  for (const kind of ['files', 'terminal', 'subagentchat2', undefined]) {
    assert.deepEqual(plain(panelStaleTabIdsOf({ tabs: [panelChatTab('dead-1', { kind })], mountedSessionId: 'parent-1', ended })), [])
  }
  // 垃圾行跳过；同一张页签出现两次只报一次；解析不出来的地址跳过。
  const mixed = [
    null,
    'dead',
    [],
    42,
    panelChatTab('dead-1'),
    panelChatTab('dead-1'),
    { sessionId: 'parent-1', tabId: 'tab-junk', kind: 'subagentchat', contentId: 'not an address' },
    { sessionId: 'parent-1', tabId: '   ', kind: 'subagentchat', contentId: panelChatTab('dead-2').contentId },
    panelChatTab('dead-3'),
  ]
  assert.deepEqual(plain(panelStaleTabIdsOf({ tabs: mixed, mountedSessionId: 'parent-1', ended: ['dead-1', 'dead-3'] })), [
    'tab-dead-1',
    'tab-dead-3',
  ])
  // 没有挂载会话就没有目标：宿主只按挂载会话关。
  for (const mountedSessionId of [undefined, '', '   ', null]) {
    assert.deepEqual(plain(panelStaleTabIdsOf({ tabs: [panelChatTab('dead-1')], mountedSessionId, ended })), [])
  }
  // 读不到结束名单就一张都不动：读不到真相时宁可留一张死页签。
  for (const missing of [undefined, null, 'ended', {}, 7]) {
    assert.deepEqual(plain(panelStaleTabIdsOf({ tabs: [panelChatTab('dead-1')], mountedSessionId: 'parent-1', ended: missing })), [])
  }
  // 空名单等于没人结束过。
  assert.deepEqual(plain(panelStaleTabIdsOf({ tabs: [panelChatTab('dead-1')], mountedSessionId: 'parent-1', ended: [] })), [])
  // 已经为它关过一次：用户重开来读的那张不许再被抽走。
  assert.deepEqual(
    plain(panelStaleTabIdsOf({ tabs: [panelChatTab('dead-1')], mountedSessionId: 'parent-1', ended, handled: ['dead-1'] })),
    [],
  )
  assert.deepEqual(
    plain(panelStaleTabIdsOf({ tabs: [panelChatTab('dead-1'), panelChatTab('dead-3')], mountedSessionId: 'parent-1', ended: ['dead-1', 'dead-3'], handled: ['dead-1'] })),
    ['tab-dead-3'],
  )
})

/** 一个能答「谁结束了」的宿主：右栏两个快照 store，加面板端点命名空间。 */
function fakeSweepHost({ tabs = [], mounted = 'parent-1', ended = [], closeThrows = [], endpoint = 'ok' } = {}) {
  const closes = []
  const ctx = {
    get(name) {
      if (name === 'sidebarRight') {
        return {
          close: (tabId) => {
            if (closeThrows.includes(tabId)) throw new Error('no session surface is mounted')
            closes.push(tabId)
          },
          openTabs: { getSnapshot: () => tabs, subscribe: () => () => {} },
          mounted: { getSnapshot: () => mounted, subscribe: () => () => {} },
        }
      }
      if (name === 'remote.orchestratorPanel') {
        if (endpoint === 'missing') return undefined
        return {
          panelState: async () => {
            if (endpoint === 'fails') return { ok: false, error: { message: 'gateway is down' } }
            return { ok: true, value: { model: { fixed: [], master: { sessionId: null }, workers: [] }, actions: { fixed: [], workers: [] }, ended } }
          },
        }
      }
      if (name === 'remote') return { $mount: async () => {} }
      return undefined
    },
  }
  return { ctx, closes }
}

test('sweepPanelTabs closes only what the server reported, and reports a close that throws', async () => {
  const { sweepPanelTabs } = T
  const host = fakeSweepHost({
    tabs: [panelChatTab('dead-1'), panelChatTab('live-1'), panelChatTab('dead-2'), panelChatTab('dead-1', { sessionId: 'other' })],
    ended: ['dead-1', 'dead-2'],
    closeThrows: ['tab-dead-1'],
  })
  const result = await sweepPanelTabs(host.ctx, { schedule: (run) => run() })
  assert.deepEqual(plain(result), {
    asked: ['tab-dead-2'],
    failed: [{ tabId: 'tab-dead-1', message: 'no session surface is mounted' }],
  })
  assert.deepEqual(host.closes, ['tab-dead-2'], 'a throwing close does not stop the rest')

  // 同一个 ctx 再扫一次：已经关成功的子会话不再关（用户重开一张就留住）；关失败的那一张
  // 仍然重试——它这一拍没落地，状态没变。
  const again = await sweepPanelTabs(host.ctx, { schedule: (run) => run() })
  assert.deepEqual(plain(again), {
    asked: [],
    failed: [{ tabId: 'tab-dead-1', message: 'no session surface is mounted' }],
  })
  assert.deepEqual(host.closes, ['tab-dead-2'], 'a deliberate reopen is not swept again')
})

test('sweepPanelTabs never closes anything when the endpoint cannot answer', async () => {
  // 关页签是可选的清理：网关不在、端点没挂、载荷报错，都该安静地什么都不做。
  const { sweepPanelTabs } = T
  for (const endpoint of ['missing', 'fails']) {
    const host = fakeSweepHost({ tabs: [panelChatTab('dead-1')], ended: ['dead-1'], endpoint })
    assert.deepEqual(plain(await sweepPanelTabs(host.ctx, { schedule: (run) => run() })), { asked: [], failed: [] })
    assert.deepEqual(host.closes, [], endpoint)
  }
})

test('sweepPanelTabs asks nothing at all when no chat tab is on screen', async () => {
  // 本地就能否决的请求不该发出去：没有聊天页签时端点一次都不该被调。
  const { sweepPanelTabs } = T
  let calls = 0
  const host = fakeSweepHost({ tabs: [panelChatTab('dead-1', { sessionId: 'other-1' })], ended: ['dead-1'] })
  const namespace = host.ctx.get('remote.orchestratorPanel')
  const original = namespace.panelState
  namespace.panelState = async () => {
    calls += 1
    return original()
  }
  assert.deepEqual(plain(await sweepPanelTabs(host.ctx, { schedule: (run) => run() })), { asked: [], failed: [] })
  assert.equal(calls, 0, 'a tab in another session does not justify a round trip')
})

test('sweepPanelTabs defers past adoption, coalesces a burst, and survives a bare ctx', async () => {
  const { sweepPanelTabs } = T
  const host = fakeSweepHost({ tabs: [panelChatTab('dead-1')], ended: ['dead-1'] })
  const before = timers.length
  const first = sweepPanelTabs(host.ctx)
  const second = sweepPanelTabs(host.ctx)
  assert.equal(timers.length - before, 1, 'a burst schedules one sweep')
  assert.deepEqual(host.closes, [], 'nothing closes synchronously: adoption has not happened yet')
  timers[timers.length - 1].fn()
  const result = await first
  assert.equal(await second, result, 'the second call joined the first sweep instead of scheduling another')
  assert.deepEqual(plain(result), { asked: ['tab-dead-1'], failed: [] })
  assert.deepEqual(host.closes, ['tab-dead-1'])
  // 扫完就松开：下一次触发要能再排一个，而不是并进已经扫过的那一次。
  const later = timers.length
  const third = sweepPanelTabs(host.ctx)
  assert.equal(timers.length - later, 1, 'a finished sweep does not absorb the next trigger')
  timers[timers.length - 1].fn()
  await third

  // 没有挂载会话：一次都不关，也不抛。
  const unmounted = fakeSweepHost({ tabs: [panelChatTab('dead-1')], mounted: '', ended: ['dead-1'] })
  assert.deepEqual(plain(await sweepPanelTabs(unmounted.ctx, { schedule: (run) => run() })), { asked: [], failed: [] })
  assert.deepEqual(unmounted.closes, [])

  // 服务缺了、ctx 是垃圾：照旧 resolve，不抛。
  for (const ctx of [{}, { get: () => undefined }, { get: () => ({}) }, undefined, null]) {
    assert.deepEqual(plain(await sweepPanelTabs(ctx, { schedule: (run) => run() })), { asked: [], failed: [] })
  }
})

/** apply 的宿主：在 fakeApplyCtx 上补右栏两个快照 store 与面板端点。 */
function fakeSweepApplyCtx({ tabs = [], mounted = 'parent-1', ended = [], dock = true } = {}) {
  const base = fakeApplyCtx({ dock })
  const closes = []
  const mountedListeners = []
  const mountedStore = {
    getSnapshot: () => mounted,
    subscribe(listener) {
      mountedListeners.push(listener)
      return () => {
        const at = mountedListeners.indexOf(listener)
        if (at !== -1) mountedListeners.splice(at, 1)
      }
    },
  }
  const openTabs = { getSnapshot: () => tabs, subscribe: () => () => {} }
  const getService = base.ctx.get
  base.ctx.get = (name) => {
    if (name === 'remote.orchestratorPanel') {
      return {
        panelState: async () => ({
          ok: true,
          value: { model: { fixed: [], master: { sessionId: null }, workers: [] }, actions: { fixed: [], workers: [] }, ended },
        }),
      }
    }
    const value = getService(name)
    if (name === 'sidebarRight' && value !== undefined && value !== null && dock) {
      return Object.assign({}, value, {
        mounted: mountedStore,
        openTabs,
        close: (tabId) => {
          closes.push(tabId)
        },
      })
    }
    return value
  }
  return { ctx: base.ctx, closes, mountedListeners, slots: base.slots, types: base.types, disposers: base.disposers }
}

test('apply sweeps on a mounted change and on its own timer, once per burst', async () => {
  const host = fakeSweepApplyCtx({ tabs: [panelChatTab('dead-1'), panelChatTab('live-1')], ended: ['dead-1'] })
  const beforeIntervals = intervals.length
  assert.doesNotThrow(() => mod.apply(host.ctx))
  assert.equal(host.mountedListeners.length, 1, 'the mounted store is watched')
  // 结束不会改变浏览器里任何 store，所以必须有自己的定时器；否则「你正看着它死」永远收不到。
  assert.equal(intervals.length - beforeIntervals, 1, 'a sweep timer is registered')
  assert.equal(intervals[intervals.length - 1].ms, T.PANEL_SWEEP_MS, 'the timer uses the documented cadence')

  const before = timers.length
  host.mountedListeners[0]()
  host.mountedListeners[0]()
  assert.equal(timers.length - before, 1, 'a burst schedules exactly one deferred sweep')
  assert.deepEqual(host.closes, [], 'the sweep is deferred past adoption')
  timers[timers.length - 1].fn()
  await flush()
  assert.deepEqual(host.closes, ['tab-dead-1'], 'only the tab the server reported is closed')

  // 定时器那一拍也必须真的清扫一次（会排一次清扫），但它不再关同一个子会话的页签：
  // 用户重开一张来读，不该每 5 秒被抽走一次。
  const beforeTick = timers.length
  intervals[intervals.length - 1].fn()
  assert.equal(timers.length - beforeTick, 1, 'a timer tick schedules a sweep')
  timers[timers.length - 1].fn()
  await flush()
  assert.deepEqual(host.closes, ['tab-dead-1'], 'the reopen rule keeps a deliberate reopen open')
})

test('unloading the plugin takes the sweep timer with it', () => {
  const host = fakeSweepApplyCtx({ tabs: [panelChatTab('dead-1')], ended: ['dead-1'] })
  const before = intervals.length
  mod.apply(host.ctx)
  assert.equal(intervals.length - before, 1, 'the timer is registered while the plugin lives')
  for (const stop of [...host.disposers].reverse()) stop()
  assert.equal(intervals.length, before, 'every effect teardown ran, including clearInterval')
})

test('a hidden page does not poll for dead tabs', () => {
  const host = fakeSweepApplyCtx({ tabs: [panelChatTab('dead-1')], ended: ['dead-1'] })
  mod.apply(host.ctx)
  const tick = intervals[intervals.length - 1].fn
  const before = timers.length
  fakeDocument.hidden = true
  try {
    tick()
  } finally {
    fakeDocument.hidden = false
  }
  assert.equal(timers.length - before, 0, 'no sweep is scheduled while the page is hidden')
  // 可见时那一拍照常排清扫：别把这个开关做成永久关闭。
  tick()
  assert.equal(timers.length - before, 1, 'a visible page still polls')
})

test('apply registers no sweep when the dock cannot close tabs', () => {
  const host = fakeSweepApplyCtx({ dock: false })
  assert.doesNotThrow(() => mod.apply(host.ctx))
  assert.deepEqual(host.mountedListeners, [], 'no mounted subscription without a closable dock')
})
