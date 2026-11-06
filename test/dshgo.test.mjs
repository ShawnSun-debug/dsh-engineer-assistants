import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ACTIONS,
  PANEL_ID,
  PANEL_LIMITS,
  TAB_TITLES,
  buildView,
  mountDshGo,
  summarize,
} from '../lib/dshgo.js'

/**
 * The native view is judged against the host's panel budgets with a counter written here,
 * not one exported by the module: if buildView and its test shared a counter, a wrong
 * budget reading would agree with itself and pass.
 *
 * Counting rule (the one the panel contract states): a component is an object with a
 * string 'type'; every array element that is not a component is one data leaf (a page, a
 * row, a timeline entry). An object that only holds scalars is a data row and is not
 * descended into. 'depth' counts nesting levels of components and data rows together.
 */
function countNodes(value, depth = 1) {
  if (Array.isArray(value)) {
    let nodes = 0
    let maxDepth = depth
    for (const item of value) {
      if (isComponent(item)) {
        const inner = countNodes(item, depth + 1)
        nodes += inner.nodes
        maxDepth = Math.max(maxDepth, inner.depth)
        continue
      }
      nodes += 1
      if (hasNestedContainer(item)) {
        const inner = countNodes(item, depth + 1)
        nodes += inner.nodes
        maxDepth = Math.max(maxDepth, inner.depth)
      }
    }
    return { nodes, depth: maxDepth }
  }
  if (value === null || typeof value !== 'object') return { nodes: 0, depth }
  let nodes = isComponent(value) ? 1 : 0
  let maxDepth = depth
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === 'object') {
      const inner = countNodes(child, depth + 1)
      nodes += inner.nodes
      maxDepth = Math.max(maxDepth, inner.depth)
    }
  }
  return { nodes, depth: maxDepth }
}

function isComponent(value) {
  return value !== null && typeof value === 'object' && typeof value.type === 'string'
}

function hasNestedContainer(value) {
  if (value === null || typeof value !== 'object') return false
  return Object.values(value).some((child) => child !== null && typeof child === 'object')
}

function componentsOf(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) componentsOf(item, out)
    return out
  }
  if (value === null || typeof value !== 'object') return out
  if (isComponent(value)) out.push(value)
  for (const child of Object.values(value)) componentsOf(child, out)
  return out
}

function tabsOf(view) {
  return view.children[0]
}

function pageOf(view, title) {
  return tabsOf(view).items.find((page) => page.label === title)
}

const POLICY = {
  beatSeconds: 180,
  maxRunSeconds: 7200,
  notifyOn: { state: true, step: true, block: true, deliverable: true, timeout: true },
  promptText: '',
}

function orchestrator(sessionId, overrides = {}) {
  return {
    sessionId,
    title: '会话 ' + sessionId,
    workspace: 'D:/work/' + sessionId,
    live: true,
    state: 'Working',
    workers: [{ id: sessionId + '-w1', state: 'Working', summary: '干活' }],
    beats: { count: 2, startedAt: 1_700_000_000_000, capped: false, stoppedReason: null },
    lastReport: { path: 'D:/work/' + sessionId + '/.scratch/r/12-00.md', at: 1_700_000_060_000, kind: 'delta' },
    ...overrides,
  }
}

function report(sessionId, at, changes = { completed: ['w1: Working → Completed'], blocked: [], flipped: [] }) {
  return {
    sessionId,
    at,
    kind: 'delta',
    path: 'D:/work/' + sessionId + '/.scratch/r/12-00.md',
    bytes: 120,
    changes,
    error: null,
  }
}

function draft(sessionId, overrides = {}) {
  return {
    id: 'd-' + sessionId,
    sessionId,
    reason: 'needs-input',
    text: '需要你拍板',
    status: 'pending',
    createdAt: 80,
    sentAt: null,
    ...overrides,
  }
}

function stateOf(parts = {}) {
  return {
    enabled: true,
    registry: { masterSessionId: 'master-1', orchestrators: [] },
    orchestrators: [orchestrator('orch-1'), orchestrator('orch-2', { title: '第二会话' })],
    reports: [report('orch-1', 1_700_000_120_000), report('orch-2', 1_700_000_180_000)],
    drafts: [draft('orch-1'), draft('orch-2', { text: '第二个卡点' })],
    policy: POLICY,
    ...parts,
  }
}

test('scope.sessionId limits every page to that session (why: session.tab gives a scope, features does not)', () => {
  const scoped = buildView({ state: stateOf(), scope: { sessionId: 'orch-1', features: [] } })
  const serialized = JSON.stringify(scoped)

  assert.ok(!serialized.includes('orch-2'), 'no row of another session may leak into a scoped view')
  assert.ok(!serialized.includes('第二会话'))
  assert.ok(!serialized.includes('第二个卡点'))

  const trackingRows = pageOf(scoped, '跟踪').children[0].items
  assert.equal(trackingRows.length, 1)
  assert.equal(trackingRows[0].title, '会话 orch-1')

  const historyItems = pageOf(scoped, '历史').children[0].items
  assert.equal(historyItems.length, 1)

  const diffTitles = pageOf(scoped, '差异').children.map((component) => component.items[0].title)
  assert.deepEqual(diffTitles, ['w1: Working → Completed', '无', '无'])

  const unscoped = buildView({ state: stateOf() })
  assert.equal(pageOf(unscoped, '跟踪').children[0].items.length, 2)
})

test('the native panel has the five pages the panel contract names', () => {
  const view = buildView({ state: stateOf() })
  assert.equal(view.type, 'stack')
  assert.equal(view.title, '秘书')
  assert.deepEqual(tabsOf(view).items.map((page) => page.label), [...TAB_TITLES])
  assert.deepEqual(
    [...TAB_TITLES],
    ['总览', '跟踪', '编排', '差异', '历史'],
  )
})

test('the view root declares v 2, so the tabs and timeline components render', () => {
  // Two different version numbers: the manifest's dshGo.v is the protocol (1, or the app
  // rejects the plugin as unsupported), this root v is the view path (2, or the app drops
  // every v2-only component — tabs and timeline among them — and shows an empty panel).
  const view = buildView({ state: stateOf() })
  assert.equal(view.v, 2)

  const types = componentsOf(view).map((component) => component.type)
  for (const type of ['tabs', 'timeline']) assert.ok(types.includes(type), type + ' is v2-only')
  assert.equal(tabsOf(view).type, 'tabs')

  // A v2 timeline entry is { label } and nothing else: the schema forbids extra fields, so
  // the clock time has to live inside the label rather than in its own 'at'.
  const entry = pageOf(view, '历史').children[0].items[0]
  assert.deepEqual(Object.keys(entry), ['label'])
  assert.ok(entry.label.includes(' · '), 'the label carries the clock time: ' + entry.label)
})

test('the view stays inside the node budget and the 8-level depth cap', () => {
  const many = {
    orchestrators: Array.from({ length: 80 }, (_, index) =>
      orchestrator('s' + index, {
        title: '长会话 ' + index + ' ' + '很长'.repeat(40),
        workspace: 'D:/' + '很长的路径'.repeat(30),
        workers: [
          { id: 'w-a-' + index, state: 'Working', summary: 'x' },
          { id: 'w-b-' + index, state: 'Needs input', summary: 'y' },
        ],
      }),
    ),
    reports: Array.from({ length: 80 }, (_, index) =>
      report('s' + (index % 5), 1_700_000_000_000 + index * 60_000, {
        completed: ['完成'.repeat(60)],
        blocked: ['卡住'.repeat(60)],
        flipped: ['翻转'.repeat(60)],
      }),
    ),
    drafts: Array.from({ length: 80 }, (_, index) => draft('s' + (index % 5), { text: '待拍板'.repeat(100) })),
    policy: { ...POLICY, promptText: '提示'.repeat(500) },
  }
  const view = buildView({ state: { ...stateOf(), ...many } })
  const measured = countNodes(view)

  assert.ok(measured.nodes <= PANEL_LIMITS.nodes, 'got ' + measured.nodes + ' nodes')
  assert.ok(measured.depth <= PANEL_LIMITS.depth, 'got depth ' + measured.depth)
  assert.equal(tabsOf(view).items.length, 5, 'budget trimming never removes a page')
  assert.ok(pageOf(view, '跟踪').children[0].items.length <= PANEL_LIMITS.list)
  assert.ok(pageOf(view, '编排').children[1].rows.length <= PANEL_LIMITS.table)
  assert.ok(pageOf(view, '历史').children[0].items.length <= PANEL_LIMITS.timeline)
  assert.ok(pageOf(view, '总览').children[0].items.length <= PANEL_LIMITS.keyValue)
})

test('the view stays under 32 KiB even with pathological strings', () => {
  const bloated = {
    orchestrators: Array.from({ length: 80 }, (_, index) =>
      orchestrator('s' + index, {
        title: '标题'.repeat(80),
        workspace: '工作区'.repeat(200),
        workers: [{ id: 'w-' + index, state: 'Working', summary: '摘要'.repeat(100) }],
      }),
    ),
    reports: Array.from({ length: 80 }, (_, index) =>
      report('s' + (index % 5), 1_700_000_000_000 + index * 60_000, {
        completed: ['完成'.repeat(100)],
        blocked: ['卡住'.repeat(100)],
        flipped: ['翻转'.repeat(100)],
      }),
    ),
    drafts: Array.from({ length: 80 }, (_, index) => draft('s' + (index % 5), { text: '催办'.repeat(200) })),
    policy: { ...POLICY, promptText: '口径'.repeat(1000) },
  }
  const view = buildView({ state: { ...stateOf(), ...bloated } })
  const bytes = Buffer.byteLength(JSON.stringify(view), 'utf8')

  assert.ok(bytes <= PANEL_LIMITS.bytes, 'got ' + bytes + ' bytes')
  assert.equal(tabsOf(view).items.length, 5)
  assert.ok(countNodes(view).nodes <= PANEL_LIMITS.nodes)
})

test('no settings-input component ever appears in the native view (why: settings stay on the web side)', () => {
  const forbidden = new Set([
    'input',
    'textarea',
    'select',
    'switch',
    'slider',
    'checkbox',
    'radio',
    'toggle',
    'form',
    'field',
    'setting',
    'settings',
    'textField',
    'numberField',
    'password',
  ])
  const views = [
    buildView({}),
    buildView({ state: stateOf() }),
    buildView({ state: stateOf(), scope: { sessionId: 'orch-1', features: [] } }),
  ]
  for (const view of views) {
    for (const component of componentsOf(view)) {
      assert.ok(!forbidden.has(component.type), 'unexpected input component: ' + component.type)
      assert.ok(!Object.hasOwn(component, 'options'), 'no component may carry select options')
      assert.ok(!Object.hasOwn(component, 'placeholder'), 'no component may carry an input placeholder')
    }
  }
})

test('the view builders are pure: the payload is not mutated and two calls differ only by input', () => {
  const state = stateOf()
  const snapshot = JSON.stringify(state)
  const first = buildView({ state })
  const second = buildView({ state })
  assert.equal(JSON.stringify(state), snapshot, 'buildView must not write into its input')
  assert.deepEqual(first, second)
  assert.notEqual(first, second)
})

test('mountDshGo degrades to a no-op when the host has no dshGo bridge', () => {
  const noInject = mountDshGo({ ctx: {}, readState: () => undefined })
  assert.equal(typeof noInject, 'function')
  noInject()

  const throwingInject = mountDshGo({
    ctx: {
      inject() {
        throw new Error('the host has no dshGo service')
      },
    },
    readState: () => undefined,
  })
  assert.equal(typeof throwingInject, 'function')
  throwingInject()

  const noPanel = mountDshGo({
    ctx: {
      inject(requirements, callback) {
        callback({ dshGo: {} })
        return () => {}
      },
    },
    readState: () => undefined,
  })
  assert.equal(typeof noPanel, 'function')
  noPanel()

  assert.equal(typeof mountDshGo(), 'function')
})

test('mountDshGo registers exactly one panel called secretary through ctx.inject', async () => {
  const panels = []
  const requirements = []
  const emissions = []
  const ctx = {
    inject(deps, callback) {
      requirements.push(deps)
      callback({
        dshGo: {
          panel(id, options) {
            panels.push({ id, options })
            return () => {}
          },
        },
      })
      return () => {}
    },
  }

  const state = stateOf()
  const mounted = mountDshGo({ ctx, readState: async () => state, intervalMs: 5 })
  assert.equal(typeof mounted, 'function')
  assert.deepEqual(requirements, [['dshGo']], 'dshGo is injected with ctx.inject, not the top-level inject')
  assert.equal(panels.length, 1)
  assert.equal(panels[0].id, 'secretary')
  assert.equal(PANEL_ID, 'secretary')

  const options = panels[0].options
  assert.equal(typeof options.view, 'function')
  assert.equal(typeof options.data, 'function')
  assert.equal(typeof options.actions, 'object')
  assert.equal(typeof options.actions[ACTIONS.refresh], 'function')
  assert.equal(typeof options.actions[ACTIONS.copySummary], 'function')

  const view = options.view({ sessionId: 'orch-1', features: [] })
  assert.equal(pageOf(view, '跟踪').children[0].items.length, 1)
  assert.equal(summarize(state).startsWith('在跑 2'), true)

  const cancel = options.data({}, (payload) => emissions.push(payload))
  assert.equal(typeof cancel, 'function')
  await new Promise((resolve) => setTimeout(resolve, 30))
  cancel()
  assert.ok(emissions.length >= 1, 'the data callback emits the latest state')
  assert.ok(emissions.every((payload) => payload === state))

  mounted()
})
