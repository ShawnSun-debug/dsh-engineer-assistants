/**
 * The App native half of the secretary (dsh-Go).
 *
 * The web half lives in lib/client.js and is deliberately not touched: this module is a
 * second, independent renderer over the same read payload. It owns three things:
 *
 * 1. buildView — a pure fold from the five-segment payload (the return value of
 *    lib/secretary-panel.js's composeViewState: enabled / registry / orchestrators /
 *    reports / drafts / policy) into the native panel's view tree. Pure means: no host
 *    import, no clock, no I/O, and the input object is never written to. The view
 *    builder is testable without a running host, which is the whole point of splitting
 *    it out of the mount.
 * 2. mountDshGo — the only place that talks to the host: ctx.inject(['dshGo'], ...), one
 *    panel registered per plugin instance. Every failure path degrades to "no native
 *    panel" instead of taking the plugin down with it; a host without the dshGo service
 *    (or without ctx.inject at all, as in the unit tests) gets a no-op disposer.
 * 3. The panel budgets, written once. buildView enforces the total node budget, the byte
 *    budget and the per-component caps by trimming *data rows only* — never pages, never
 *    the page structure — so a pathological archive still renders a valid view.
 *
 * The view wire shape (one object per component, data rows as plain objects), as
 * sdk/plugin-kit/schema/view.schema.json defines it:
 *
 *   { type: 'stack',    v: 2, title, children: [component] }
 *   { type: 'tabs',     items: [{ label, children: [component] }] }
 *   { type: 'keyValue', items: [{ label, value, tone? }] }
 *   { type: 'list',     items: [{ title, subtitle?, trailing?, tone? }] }
 *   { type: 'table',    columns: [string], rows: [[string]] }
 *   { type: 'timeline', items: [{ label, children?: [component] }] }
 *   { type: 'callout',  tone, text }
 *   { type: 'actions',  items: [{ label, action }] }
 *
 * The root carries v: 2 because 'tabs' and 'timeline' are v2-only components: on a v1 root
 * the app drops them and the panel shows nothing. The manifest's own protocol v
 * (package.json dshGo.v) is a separate number and stays 1 — 2 there makes the app reject
 * the plugin as unsupported.
 *
 * A timeline entry has no time or tone field of its own: the clock time and the report
 * kind are folded into the entry's label, and the tone is gone because data rows carry no
 * tone in v2 any more.
 *
 * There is no status-dot component in the native vocabulary: a row's state is carried by
 * the 'trailing' text plus a tone, never by a made-up dot node.
 *
 * @module
 */

import { WORKER_STATE } from './master-state.js'
import { REPORT_VIEW_KINDS } from './secretary-constants.js'

/** The panel id the host registers and the client addresses. */
export const PANEL_ID = 'secretary'

/** The panel title; the same string the web tab uses. */
export const PANEL_TITLE = '秘书'

/** The five native pages, in tab order. */
export const TAB_TITLES = Object.freeze(['总览', '跟踪', '编排', '差异', '历史'])

/** The two panel actions the overview page offers. */
export const ACTIONS = Object.freeze({
  refresh: 'secretary.refresh',
  copySummary: 'secretary.copySummary',
})

/** How often the data callback pushes a fresh payload, unless the caller overrides it. */
export const DEFAULT_INTERVAL_MS = 10_000

/**
 * The host's panel budgets, written once here so the builder and its tests cannot drift.
 *
 * 'list', 'table', 'keyValue', 'actions' and 'timeline' are per-component caps; 'nodes'
 * and 'bytes' are totals over the whole view. 'depth' counts component nesting (a data
 * row adds one level but is not a component), which is the reading every panel tree in
 * this repo can satisfy.
 */
export const PANEL_LIMITS = Object.freeze({
  nodes: 120,
  bytes: 32 * 1024,
  depth: 8,
  tabs: 8,
  list: 50,
  table: 50,
  keyValue: 24,
  actions: 4,
  timeline: 24,
})

/** Per-field text clamps. A long summary is truncated in the view, not in the payload. */
const CLIP = Object.freeze({
  title: 80,
  subtitle: 120,
  trailing: 48,
  value: 80,
  change: 160,
  callout: 240,
  worker: 48,
})

/** The six-state vocabulary as tones; there is no seventh ('unknown') state. */
const TONE_BY_STATE = Object.freeze({
  [WORKER_STATE.working]: 'info',
  [WORKER_STATE.needsInput]: 'warn',
  [WORKER_STATE.idle]: 'muted',
  [WORKER_STATE.completed]: 'good',
  [WORKER_STATE.failed]: 'bad',
  [WORKER_STATE.stopped]: 'muted',
})

/** How a report kind is named in the history timeline. */
const KIND_LABELS = Object.freeze({ plan: '规划', delta: '增量', limit: '超时截断', summary: '汇总', unknown: '未知' })

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function rows(value) {
  return Array.isArray(value) ? value : []
}

/** A trimmed string cut to max characters, ellipsis included in the budget. */
function clip(value, max) {
  const raw = text(value)
  if (raw.length <= max) return raw
  return raw.slice(0, Math.max(0, max - 1)) + '…'
}

/** A non-negative integer, or 0 (junk numbers are 0, never NaN in a view). */
function countOf(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
}

/** An epoch timestamp, or 0. */
function atOf(row) {
  return isObject(row) ? countOf(row.at) : 0
}

/** HH:MM in the process's local time; anything that is not a real timestamp is '—'. */
function clockOf(value) {
  const at = countOf(value)
  if (at <= 0) return '—'
  const date = new Date(at)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return hours + ':' + minutes
}

/** A session id is in scope when no scope was given, or when it matches exactly. */
function inScope(sessionId, scopeSessionId) {
  return scopeSessionId === '' || sessionId === scopeSessionId
}

function toneOfState(state) {
  const key = text(state)
  return Object.hasOwn(TONE_BY_STATE, key) ? TONE_BY_STATE[key] : 'muted'
}

/** The five segments, defensively normalized: junk in a segment is an empty segment. */
function normalize(state) {
  const source = isObject(state) ? state : {}
  return {
    orchestrators: rows(source.orchestrators).filter(isObject),
    reports: rows(source.reports).filter(isObject),
    drafts: rows(source.drafts).filter(isObject),
    policy: isObject(source.policy) ? source.policy : {},
  }
}

/**
 * Fold one payload into the native five-page view.
 *
 * @param input.state is the composed payload of the secretary read endpoint. The
 * builder never requires any segment to exist: a missing state (the host asks before the
 * first data tick, or the plugin has no read function) yields the empty five-page view.
 *
 * @param input.scope is the host's scope object. When scope.sessionId is set (as it is
 * on session.tab), every page renders only that session's rows; otherwise the whole
 * registry is rendered.
 *
 * Reports are sorted newest first defensively; the endpoint already sorts them, but the
 * builder is usable with a raw payload too.
 */
export function buildView(input = {}) {
  const source = isObject(input) ? input : {}
  const state = normalize(source.state)
  const scope = isObject(source.scope) ? source.scope : {}
  const scopeSessionId = text(scope.sessionId)

  const orchestrators = state.orchestrators.filter((row) => inScope(text(row.sessionId), scopeSessionId))
  const reports = state.reports
    .filter((row) => inScope(text(row.sessionId), scopeSessionId))
    .slice()
    .sort((left, right) => atOf(right) - atOf(left))
  const drafts = state.drafts.filter((row) => inScope(text(row.sessionId), scopeSessionId))

  const view = {
    type: 'stack',
    // The view protocol version, not the manifest's: only v2 unlocks tabs and timeline.
    v: 2,
    title: PANEL_TITLE,
    children: [
      {
        type: 'tabs',
        items: [
          { label: TAB_TITLES[0], children: overviewPage(orchestrators, drafts, state.policy) },
          { label: TAB_TITLES[1], children: trackingPage(orchestrators) },
          { label: TAB_TITLES[2], children: organizePage(orchestrators) },
          { label: TAB_TITLES[3], children: diffPage(reports) },
          { label: TAB_TITLES[4], children: historyPage(reports, orchestrators) },
        ],
      },
    ],
  }
  fitToBudget(view)
  return view
}

/** 总览: the four headline numbers, the card-point callout, and the two actions. */
function overviewPage(orchestrators, drafts, policy) {
  const working = orchestrators.filter((row) => text(row.state) === WORKER_STATE.working).length
  const blocked = orchestrators.filter((row) => text(row.state) === WORKER_STATE.needsInput).length
  const pending = drafts.filter((row) => text(row.status) === 'pending')
  const next = nextBeatAt(orchestrators, policy)

  return [
    {
      type: 'keyValue',
      items: [
        { label: '在跑', value: working + ' 个会话' },
        { label: '阻塞', value: blocked + ' 个会话' + (pending.length === 0 ? '' : ' · ' + pending.length + ' 条待拍板') },
        { label: '下次汇报', value: next },
        { label: '时限', value: limitText(policy) },
      ].slice(0, PANEL_LIMITS.keyValue),
    },
    {
      // A callout has no title of its own in the v2 vocabulary: the sentence is the callout.
      type: 'callout',
      tone: pending.length === 0 && blocked === 0 ? 'good' : 'warn',
      text: calloutText(pending, blocked),
    },
    {
      type: 'actions',
      items: [
        { label: '刷新', action: ACTIONS.refresh },
        { label: '复制摘要', action: ACTIONS.copySummary },
      ],
    },
  ]
}

/** 跟踪: one row per tracked session, title / workspace / state / tone. */
function trackingPage(orchestrators) {
  const list = orchestrators.slice(0, PANEL_LIMITS.list).map((row) => ({
    title: clip(row.title, CLIP.title) || clip(row.sessionId, CLIP.title) || '未命名会话',
    subtitle: clip(row.workspace, CLIP.subtitle) || '未绑定工作区',
    trailing: row.live === true ? text(row.state) + ' · 在线' : text(row.state),
    tone: toneOfState(row.state),
  }))
  return [
    {
      type: 'list',
      title: '跟踪',
      items:
        list.length === 0
          ? [{ title: '还没有登记任何会话', subtitle: '在设置页登记一个 orchestrator', trailing: '—', tone: 'muted' }]
          : list,
    },
  ]
}

/** 编排: how the tracked run stands, then one table row per worker. */
function organizePage(orchestrators) {
  const table = []
  for (const row of orchestrators) {
    for (const worker of rows(row.workers)) {
      if (!isObject(worker)) continue
      table.push([
        clip(row.title, CLIP.title) || clip(row.sessionId, CLIP.title) || '未命名会话',
        clip(worker.id, CLIP.worker) || '—',
        text(worker.state),
      ])
    }
  }
  const beats = orchestrators.reduce((sum, row) => sum + countOf(row.beats?.count), 0)
  const single = orchestrators.length === 1 ? orchestrators[0] : undefined
  const tableRows = table.slice(0, PANEL_LIMITS.table)
  return [
    {
      type: 'keyValue',
      items: [
        { label: '状态', value: clip(stateSummary(orchestrators), CLIP.value) },
        { label: '触发', value: clip(triggerText(orchestrators, single), CLIP.value) },
        { label: '已跑', value: beats + ' 拍' },
      ],
    },
    {
      type: 'table',
      columns: ['会话', 'worker', '状态'],
      rows: tableRows.length === 0 ? [['—', '没有在跑的 worker', '—']] : tableRows,
    },
  ]
}

/** 差异: the newest report's three change groups; an empty group says 无. */
function diffPage(reports) {
  const latest = reports[0]
  const changes = latest === undefined ? undefined : latest.changes
  let titles = ['新完成', '新卡住', '状态翻转']
  let groups
  if (Array.isArray(changes)) {
    // Archive files written before the grouped sections only carry a flat list. Keeping them
    // visible under one honestly labelled list beats guessing which group each bullet belongs to.
    titles = ['新完成（旧版无分组）', '新卡住', '状态翻转']
    groups = { completed: changeRows(changes), blocked: [], flipped: [] }
  } else {
    const source = isObject(changes) ? changes : {}
    groups = { completed: changeRows(source.completed), blocked: changeRows(source.blocked), flipped: changeRows(source.flipped) }
  }
  return [groups.completed, groups.blocked, groups.flipped].map((group, index) => ({
    type: 'list',
    title: titles[index],
    items: group.length === 0 ? [{ title: '无', tone: 'muted' }] : group.slice(0, PANEL_LIMITS.list),
  }))
}

/** 历史: the archive, newest first, at most 24 entries. */
function historyPage(reports, orchestrators) {
  const names = new Map()
  for (const row of orchestrators) {
    const sessionId = text(row.sessionId)
    if (sessionId === '') continue
    names.set(sessionId, clip(row.title, CLIP.title) || sessionId)
  }
  // A v2 timeline entry is only { label }: the clock time and the content are one line, and
  // the old per-entry tone has no field to live in.
  const items = reports.slice(0, PANEL_LIMITS.timeline).map((row) => {
    const kind = REPORT_VIEW_KINDS.includes(row.kind) ? row.kind : 'unknown'
    const sessionId = text(row.sessionId)
    const who = sessionId === '' ? '跨会话' : names.get(sessionId) ?? sessionId
    return { label: clip(clockOf(atOf(row)) + ' · ' + (KIND_LABELS[kind] ?? KIND_LABELS.unknown) + ' · ' + who, CLIP.title) }
  })
  return [{ type: 'timeline', items }]
}

/** The earliest beat still running, as the time of its next tick; '—' when none runs. */
function nextBeatAt(orchestrators, policy) {
  const beatSeconds = countOf(policy.beatSeconds) || 180
  let earliest = 0
  for (const row of orchestrators) {
    const beats = isObject(row.beats) ? row.beats : {}
    const startedAt = countOf(beats.startedAt)
    if (startedAt <= 0) continue
    if (text(beats.stoppedReason) !== '') continue
    const next = startedAt + (countOf(beats.count) + 1) * beatSeconds * 1000
    if (earliest === 0 || next < earliest) earliest = next
  }
  return earliest === 0 ? '—' : clockOf(earliest)
}

/** The '时限' value: the run cap, plus the cadence it is measured against. */
function limitText(policy) {
  const maxRunSeconds = countOf(policy.maxRunSeconds) || 7200
  const beatSeconds = countOf(policy.beatSeconds) || 180
  return maxRunSeconds + ' 秒上限 · 每 ' + beatSeconds + ' 秒一拍'
}

/** The card-point summary. With nothing pending the callout is good news, not an empty line. */
function calloutText(pending, blocked) {
  if (pending.length > 0) {
    const first = clip(pending[0].text, CLIP.callout)
    return pending.length === 1 ? '待拍板 1 条：' + first : '待拍板 ' + pending.length + ' 条，最新：' + first
  }
  if (blocked > 0) return blocked + ' 个会话停在 Needs input，还没有催办草稿。'
  return '现在没有卡点。'
}

/** The aggregate state line of the run: one state, or the non-zero counts. */
function stateSummary(orchestrators) {
  if (orchestrators.length === 0) return '没有登记会话'
  if (orchestrators.length === 1) return text(orchestrators[0].state) || WORKER_STATE.idle
  const counts = new Map()
  for (const row of orchestrators) {
    const state = text(row.state)
    if (state === '') continue
    counts.set(state, (counts.get(state) ?? 0) + 1)
  }
  return [...counts.entries()].map(([state, count]) => state + ' ' + count).join(' · ') || '—'
}

/** When the tracked run started: the beat's zero point, marked once it hit the cap. */
function triggerText(orchestrators, single) {
  if (single === undefined) return orchestrators.length === 0 ? '—' : orchestrators.length + ' 个会话'
  const beats = isObject(single.beats) ? single.beats : {}
  const startedAt = countOf(beats.startedAt)
  if (startedAt <= 0) return '未开始'
  return clockOf(startedAt) + (beats.capped === true ? '（已封顶）' : '')
}

/** One change group's rows, clipped and toned. */
function changeRows(value) {
  return rows(value)
    .map((item) => clip(item, CLIP.change))
    .filter((item) => item !== '')
    .map((item) => ({ title: item, tone: 'muted' }))
}

/**
 * Trim data rows until the view fits the host's total budgets.
 *
 * Only 'list.items', 'table.rows' and 'timeline.items' are trimmed, largest array first, so
 * a full page loses rows from whichever page is most overloaded instead of the small
 * headline pages losing their content. The page structure is never touched: the five tabs
 * and their components always exist, which is what makes the budget trimming invisible to
 * the user beyond the shortened lists.
 */
function fitToBudget(view) {
  trim(view, () => countView(view).nodes <= PANEL_LIMITS.nodes)
  trim(view, () => byteSize(view) <= PANEL_LIMITS.bytes)
}

function trim(view, fits) {
  for (let guard = 0; guard < 500; guard += 1) {
    if (fits()) return
    const pools = trimmableRows(view)
    if (pools.length === 0) return
    pools.sort((left, right) => right.length - left.length)
    if (pools[0].length === 0) return
    pools[0].pop()
  }
}

/** The data arrays a budget overrun may shorten. Components and keyValue rows are structural. */
function trimmableRows(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) if (isObject(item)) trimmableRows(item, out)
    return out
  }
  if (!isObject(node)) return out
  if (node.type === 'list' && Array.isArray(node.items)) out.push(node.items)
  if (node.type === 'table' && Array.isArray(node.rows)) out.push(node.rows)
  if (node.type === 'timeline' && Array.isArray(node.items)) out.push(node.items)
  for (const child of Object.values(node)) {
    if (Array.isArray(child) || isObject(child)) trimmableRows(child, out)
  }
  return out
}

function byteSize(view) {
  return Buffer.byteLength(JSON.stringify(view), 'utf8')
}

/**
 * Count the view against the host's node rule: every component object (one with a string
 * 'type') is one node; every array element that is not a component is one data leaf
 * (a page or a row). Container levels are reported as 'depth' — a component level, or one
 * for a data row — which is the number the host's 8-level cap refers to.
 */
function countView(value, depth = 1) {
  if (!isObject(value) && !Array.isArray(value)) return { nodes: 0, depth }
  if (Array.isArray(value)) {
    let nodes = 0
    let maxDepth = depth
    for (const item of value) {
      if (isObject(item) && typeof item.type === 'string') {
        const inner = countView(item, depth + 1)
        nodes += inner.nodes
        maxDepth = Math.max(maxDepth, inner.depth)
        continue
      }
      nodes += 1
      if (isObject(item) && hasContainer(item)) {
        const inner = countView(item, depth + 1)
        nodes += inner.nodes
        maxDepth = Math.max(maxDepth, inner.depth)
      }
    }
    return { nodes, depth: maxDepth }
  }
  let nodes = typeof value.type === 'string' ? 1 : 0
  let maxDepth = depth
  for (const child of Object.values(value)) {
    if (Array.isArray(child) || isObject(child)) {
      const inner = countView(child, depth + 1)
      nodes += inner.nodes
      maxDepth = Math.max(maxDepth, inner.depth)
    }
  }
  return { nodes, depth: maxDepth }
}

/** Whether any field of an object is itself a container (a page has children; a row does not). */
function hasContainer(value) {
  return Object.values(value).some((child) => Array.isArray(child) || isObject(child))
}

/** A short one-line summary of the payload, for the copy action's return value. */
export function summarize(state) {
  const data = normalize(state)
  const working = data.orchestrators.filter((row) => text(row.state) === WORKER_STATE.working).length
  const blocked = data.orchestrators.filter((row) => text(row.state) === WORKER_STATE.needsInput).length
  const pending = data.drafts.filter((row) => text(row.status) === 'pending').length
  const next = nextBeatAt(data.orchestrators, data.policy)
  return '在跑 ' + working + ' · 阻塞 ' + blocked + ' · 待拍板 ' + pending + ' · 下次汇报 ' + next
}

/**
 * Register the native panel once, against the host's dshGo bridge.
 *
 * @param options.ctx is the plugin context. The dshGo service is reached through
 * ctx.inject(['dshGo'], ...) and never through a top-level inject entry: the plugin must keep
 * loading on a host that has no App bridge.
 *
 * @param options.readState returns the same payload the read endpoint serves (a promise is
 * fine). It may be undefined when the secretary is off or the endpoint could not be built;
 * the panel then renders the empty five-page view rather than refusing to register.
 *
 * @param options.actions overrides the two default action handlers ({ id: handler }).
 *
 * @param options.intervalMs is the data push interval (10s by default), injectable so a
 * test does not wait ten real seconds.
 *
 * @returns a disposer. It is always a function: with no bridge, with a bridge without
 * 'panel', or with an 'inject' that throws, it does nothing and the plugin continues.
 */
export function mountDshGo(options = {}) {
  const settings = isObject(options) ? options : {}
  const ctx = settings.ctx
  const intervalMs =
    Number.isFinite(settings.intervalMs) && settings.intervalMs > 0 ? settings.intervalMs : DEFAULT_INTERVAL_MS

  let latest
  const read = typeof settings.readState === 'function' ? settings.readState : undefined

  const refresh = async () => {
    if (read === undefined) return latest
    try {
      latest = await read()
      return latest
    } catch {
      return latest
    }
  }

  let disposed = false
  const handlers = {
    [ACTIONS.refresh]: async () => {
      await refresh()
      return summarize(latest)
    },
    [ACTIONS.copySummary]: () => summarize(latest),
  }
  const overrides = isObject(settings.actions) ? settings.actions : {}
  const actionHandlers = Object.assign({}, handlers, overrides)

  const panelOptions = {
    view: (scope) => buildView({ state: latest, scope }),
    data: (scope, emit) => {
      let stopped = false
      const push = async () => {
        const state = await refresh()
        if (stopped || disposed) return
        if (typeof emit === 'function') {
          try {
            emit(state)
          } catch {
            // A throwing consumer must not stop the periodic refresh of the others.
          }
        }
      }
      void push()
      let timer
      try {
        timer = setInterval(() => void push(), intervalMs)
      } catch {
        timer = undefined
      }
      try {
        if (timer !== undefined && typeof timer.unref === 'function') timer.unref()
      } catch {
        // An exotic timer without unref is fine; the disposer still clears it.
      }
      return () => {
        stopped = true
        if (timer === undefined) return
        try {
          clearInterval(timer)
        } catch {
          // Clearing an already-dead timer is not a failure.
        }
      }
    },
    actions: actionHandlers,
  }

  if (!isObject(ctx) || typeof ctx.inject !== 'function') return () => {}
  let outer
  try {
    outer = ctx.inject(['dshGo'], (sub) => {
      try {
        const bridge = isObject(sub) ? sub.dshGo : undefined
        if (!isObject(bridge) || typeof bridge.panel !== 'function') return undefined
        const handle = bridge.panel(PANEL_ID, panelOptions)
        return typeof handle === 'function' ? handle : undefined
      } catch {
        // A host-side panel failure is not allowed to break the plugin's own mount.
        return undefined
      }
    })
  } catch {
    return () => {}
  }
  return () => {
    disposed = true
    try {
      if (typeof outer === 'function') outer()
    } catch {
      // Disposal failures are swallowed for the same reason mounting failures are.
    }
  }
}
