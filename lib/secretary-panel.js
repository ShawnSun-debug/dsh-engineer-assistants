/**
 * The secretary view's data plane (secretary spec, tickets 06 + 08).
 *
 * One read endpoint — orchestratorSecretary/secretaryState — feeds the client view
 * with five segments: registry / orchestrators / reports / drafts / policy. Everything
 * here is a pure fold over data the host already has:
 *
 * - 'registry' comes from lib/secretary-registry.js (the stored ledger, normalized).
 * - 'orchestrators' merges that ledger with the six-state projection (lib/master-state.js)
 *   and the archive index, one row per registered session.
 * - 'reports' is the archive listing under '<workspace>/.scratch/master-secretary/reports'
 *   (lib/secretary-archive.js writes them).
 * - 'drafts' is the plugin instance's nudge-draft snapshot (lib/secretary-nudge.js);
 *   the beat ticks and the plugin mount fill it, and the same Service exposes the two
 *   write transitions.
 * - 'policy' is read from the existing config keys; no new key is introduced.
 *
 * Two invariants the module exists to keep:
 *
 * 1. The five segments always exist. A session that is not registered, a workspace
 *    that was never written, a projection that has no row — each degrades to an empty
 *    segment with the exact contract field names, so the view never has to test for a
 *    missing segment.
 * 2. Reading is pure. 'composeViewState' returns new objects and never writes back
 *    into its input, and 'secretaryState' never calls a mutating host service and never
 *    drafts a nudge. The only writes are the two explicit draft transitions
 *    (confirmDraft / discardDraft); a draft is never delivered just by being read.
 *
 * The Remote below is built from the host's documented SRC fallback rather than
 * generated Typert artifacts, exactly like lib/master-panel.js: this plugin is plain
 * JavaScript with no build step, and the Gateway's SRC mode reads the typertRemote
 * binding plus the method marker on the prototype.
 *
 * @module
 */

import { join } from 'node:path'
import { DEFAULT_REPORTS_ROOT, WORKER_STATE, WORKER_STATES } from './master-state.js'
import { DEFAULT_BEAT_SECONDS, DEFAULT_MAX_RUN_SECONDS } from './secretary-beat.js'
import {
  DRAFT_STATUSES,
  NOTIFY_SWITCHES,
  REPORT_VIEW_KINDS as REPORT_KINDS,
} from './secretary-constants.js'
import { deliver } from './secretary-deliver.js'
import { normalizeRegistry } from './secretary-registry.js'

/** Cordis service key and Remote namespace of the endpoint. */
export const SECRETARY_SERVICE_KEY = 'orchestratorSecretary'

/** The read Remote method the view calls. */
export const SECRETARY_METHOD = 'secretaryState'

/** The confirm transition of a nudge draft (ticket 08). */
export const SECRETARY_CONFIRM_METHOD = 'confirmDraft'

/** The discard transition of a nudge draft (ticket 08). */
export const SECRETARY_DISCARD_METHOD = 'discardDraft'

/** Canonical Remote endpoint: <namespace>/<method>. */
export const SECRETARY_ENDPOINT = SECRETARY_SERVICE_KEY + '/' + SECRETARY_METHOD

/** How many report rows the endpoint hands the view; the only knob for that number. */
export const VIEW_REPORT_LIMIT = 50

/**
 * Archive root, relative to a workspace. Not a policy field: the reader owns it; the
 * value (and the archive writer's path segments) lives in master-state.js.
 */
export { DEFAULT_REPORTS_ROOT }

/**
 * Report kinds the view may see: the three renderable kinds (secretary-constants.js)
 * plus 'summary', the cross-session '_summary.md' the archive writes at the root, and
 * 'unknown', an archived file whose heading does not say what it is — reported as
 * unknown rather than guessed.
 */
export { REPORT_KINDS }

/** The three draft states; a draft is only ever one of them (secretary-constants.js). */
export { DRAFT_STATUSES }

/**
 * The five "substantial change" switches (secretary-constants.js). Config stores names
 * in secretaryNotifyOn; the view reads booleans, so this is where the two vocabularies
 * meet.
 */
export { NOTIFY_SWITCHES }

/**
 * The Typert protocol's marker key (see lib/master-panel.js): a Service without a
 * build step records its Remote methods here and the Gateway's SRC reflection reads
 * it from the live prototype.
 */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** The two headings that already name their kind (lib/secretary-report.js). */
const KIND_BY_HEADING = Object.freeze({ 秘书规划: 'plan', 秘书汇总: 'summary' })

/** A report that says its kind only on the '类型' line of the head block. */
const REPORT_HEADING = '秘书汇报'
const KIND_BY_LABEL = Object.freeze({ 规划: 'plan', 增量: 'delta', 超时截断: 'limit', 汇总: 'summary' })

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A trimmed display string; anything else is the empty string. */
function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** A string kept verbatim (draft text and prompt text may be multi-line). */
function rawText(value) {
  return typeof value === 'string' ? value : ''
}

/** A non-negative integer, or null. */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}

/** A positive integer, or null. */
function positive(value) {
  const number = count(value)
  return number !== null && number > 0 ? number : null
}

/** An epoch timestamp; junk is 0 (the same reading lib/secretary-registry.js uses). */
function timestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/** A timestamp that may be absent, for fields the contract allows to be null. */
function optionalTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function errorText(error) {
  if (error instanceof Error) return text(error.message) || text(error.name)
  return typeof error === 'string' ? text(error) : ''
}

/** The list a segment may hold; anything else is no rows. */
function rows(value) {
  return Array.isArray(value) ? value : []
}

/** All five switches on — what an unconfigured profile means. */
export function defaultNotifyOn() {
  return { state: true, step: true, block: true, deliverable: true, timeout: true }
}

/**
 * Read Config's name list as the view's five booleans.
 *
 * A name the view does not know is ignored (spec: adding a class later must not mean
 * re-reading stored values), and an explicitly empty list means "notify on nothing" —
 * which is different from a missing key, whose default is all five on.
 */
export function notifyOnFrom(names) {
  const list = Array.isArray(names) ? names : []
  const notifyOn = {}
  for (const [key, name] of Object.entries(NOTIFY_SWITCHES)) notifyOn[key] = list.includes(name)
  return notifyOn
}

/**
 * The conflicting registry rows: stored orchestrator ids that are also the Master.
 *
 * lib/secretary-registry.js keeps the Master and drops the row (mutual exclusion), so
 * the row still exists in the stored value but not in the normalized ledger. The view
 * shows it as a warning line rather than silently forgetting it, which is why the raw
 * input is inspected here and not the normalized result.
 */
function conflictOf(raw, masterSessionId) {
  if (masterSessionId === '') return null
  const ids = []
  for (const entry of rows(isObject(raw) ? raw.orchestrators : undefined)) {
    const sessionId = text(isObject(entry) ? entry.sessionId : undefined)
    if (sessionId !== '' && sessionId === masterSessionId && !ids.includes(sessionId)) ids.push(sessionId)
  }
  if (ids.length === 0) return null
  return { masterSessionId, conflictingOrchestratorIds: ids }
}

/**
 * The conflict a raw registry carries, in the shape the view reports.
 *
 * Exported because the read function in lib/index.js needs the same answer to decide
 * whether a conflict draft is due; two copies of this rule would drift.
 */
export function registryConflictOf(raw) {
  const source = isObject(raw) ? raw : {}
  return conflictOf(source, text(source.masterSessionId))
}

/**
 * The stored orchestrator rows, ids only, in storage order.
 *
 * Deliberately not normalized: duplicate rows and the row that duplicates the Master stay
 * where they are stored. The view edits rows by stored index (a normalized index points at a
 * different row as soon as one was deduped), so this list has to have the storage's length and
 * order. Only the id is carried: the rest of a stored entry is not the view's business, and a
 * malformed entry may hold values that do not serialize.
 */
function rawOrchestratorsOf(raw) {
  let list
  try {
    list = isObject(raw) ? raw.orchestrators : undefined
  } catch {
    return []
  }
  return rows(list).map((entry) => ({ sessionId: text(isObject(entry) ? entry.sessionId : undefined) }))
}

/** A workspace resolver that throws is simply not an answer. */
function workspaceFrom(resolve, sessionId) {
  if (typeof resolve !== 'function' || sessionId === '') return ''
  try {
    return text(resolve(sessionId))
  } catch {
    return ''
  }
}

/**
 * The ledger segment: the normalized registry plus the rows it had to drop.
 *
 * A row whose stored workspace is empty asks 'workspaceOf' for the live session's directory
 * (the archive was written under it, so an unbound row still has a place to read), and is
 * flagged 'workspaceMissing' when even that answers nothing — the view then says the session
 * has no workspace instead of quietly listing no reports.
 */
function composeRegistry(raw, workspaceOf) {
  const registry = normalizeRegistry(raw)
  return {
    masterSessionId: registry.masterSessionId,
    orchestrators: registry.orchestrators.map((row) => {
      const workspace = row.workspace !== '' ? row.workspace : workspaceFrom(workspaceOf, row.sessionId)
      return {
        sessionId: row.sessionId,
        workspace,
        workspaceMissing: workspace === '',
        title: row.title,
        trackedAt: row.trackedAt,
      }
    }),
    raw: rawOrchestratorsOf(raw),
    conflict: registryConflictOf(raw),
  }
}

/** One worker row of an orchestrator's run. */
function composeWorker(raw) {
  const source = isObject(raw) ? raw : {}
  return {
    id: text(source.id),
    state: WORKER_STATES.includes(source.state) ? source.state : WORKER_STATE.idle,
    summary: text(source.summary),
  }
}

/**
 * The per-session beat, normalized from whatever the beat wiring reported.
 *
 * No beat yet is the zeroed shape (count 0, no start time, not capped, no stop
 * reason). 'capped' only means the run hit its cap; a beat stopped because the run
 * finished is not capped.
 */
function composeBeats(raw) {
  const beats = isObject(raw) ? raw : {}
  return {
    count: count(beats.count) ?? 0,
    startedAt: optionalTimestamp(beats.startedAt),
    capped: beats.capped === true,
    stoppedReason: text(beats.stoppedReason) || null,
  }
}

/**
 * One orchestrator row's beat from the live beat's status().
 *
 * createBeat reports { running, startedAt, tickIndex, stopReason }; the view's contract
 * asks for { count, startedAt, capped, stoppedReason }. A status the wiring cannot
 * produce (no beat for the session) is the zeroed shape, never an invented count.
 */
function beatsOf(status) {
  if (!isObject(status)) return { count: 0, startedAt: null, capped: false, stoppedReason: null }
  return {
    count: count(status.tickIndex) ?? 0,
    startedAt: optionalTimestamp(status.startedAt),
    capped: status.stopReason === 'max-run',
    stoppedReason: text(status.stopReason) || null,
  }
}

/** The newest archived report of one session, as the view names it. */
function composeLastReport(raw) {
  if (!isObject(raw)) return null
  const path = text(raw.path)
  if (path === '') return null
  return { path, at: timestamp(raw.at), kind: REPORT_KINDS.includes(raw.kind) ? raw.kind : 'unknown' }
}

/** One orchestrator row: registry identity + live run state + the newest report. */
function composeOrchestrator(raw) {
  const source = isObject(raw) ? raw : {}
  return {
    sessionId: text(source.sessionId),
    title: text(source.title),
    workspace: text(source.workspace),
    live: source.live === true,
    state: WORKER_STATES.includes(source.state) ? source.state : WORKER_STATE.idle,
    workers: rows(source.workers).map(composeWorker),
    beats: composeBeats(source.beats),
    lastReport: composeLastReport(source.lastReport),
  }
}

/**
 * The diff groups of one report: the same three arrays lib/secretary-diff.js returns.
 *
 * Why changed (ticket 08): the view groups the report's 新完成 / 新卡住 / 状态翻转
 * sections from the structure instead of re-deriving them from sentence shapes. A
 * flat array survives only for an archive written before those sections existed —
 * guessing which group an unlabeled bullet belongs to would be worse than handing
 * it over unchanged and letting the view mark the row degraded.
 */
function composeChanges(raw) {
  if (Array.isArray(raw)) {
    return rows(raw)
      .map((change) => text(change))
      .filter((change) => change !== '')
  }
  const source = isObject(raw) ? raw : {}
  const group = (value) =>
    rows(value)
      .map((change) => text(change))
      .filter((change) => change !== '')
  return { completed: group(source.completed), blocked: group(source.blocked), flipped: group(source.flipped) }
}

/** One archived report row of the history tab. */
function composeReport(raw) {
  const source = isObject(raw) ? raw : {}
  const changes = composeChanges(source.changes)
  return {
    sessionId: text(source.sessionId),
    at: timestamp(source.at),
    kind: REPORT_KINDS.includes(source.kind) ? source.kind : 'unknown',
    path: text(source.path),
    bytes: count(source.bytes) ?? 0,
    changes,
    error: text(source.error) || null,
  }
}

/**
 * One nudge draft row (ticket 08): the stuck session, why it needs a nudge, the
 * generated body and the confirm transition. 'sentAt' only exists once confirmDraft
 * actually delivered the text, so a pending draft never looks sent.
 */
function composeDraft(raw) {
  const source = isObject(raw) ? raw : {}
  return {
    id: text(source.id),
    sessionId: text(source.sessionId),
    reason: text(source.reason),
    text: rawText(source.text),
    status: DRAFT_STATUSES.includes(source.status) ? source.status : 'pending',
    createdAt: timestamp(source.createdAt),
    sentAt: optionalTimestamp(source.sentAt),
  }
}

/** The settings tab's segment: every number the view shows comes from here. */
function composePolicy(raw) {
  const policy = isObject(raw) ? raw : {}
  const notifyOn = isObject(policy.notifyOn) ? policy.notifyOn : null
  const defaults = defaultNotifyOn()
  const switches = {}
  for (const key of Object.keys(defaults)) {
    switches[key] = notifyOn === null ? defaults[key] : notifyOn[key] === true
  }
  // Four fields, all of them read from config by the endpoint: the report root is fixed here
  // (DEFAULT_REPORTS_ROOT) and the cap is VIEW_REPORT_LIMIT, so neither is a policy number the
  // view could show or change. A field the endpoint never sends would be a lie on screen.
  return {
    beatSeconds: positive(policy.beatSeconds) ?? DEFAULT_BEAT_SECONDS,
    maxRunSeconds: positive(policy.maxRunSeconds) ?? DEFAULT_MAX_RUN_SECONDS,
    notifyOn: switches,
    promptText: rawText(policy.promptText),
  }
}

/**
 * The five-segment payload, with every field name the ticket's data contract names.
 *
 * Pure: the input object is never written to, and each segment is a fresh object.
 * A segment that is missing, not an array, or full of junk degrades to the empty
 * shape rather than throwing — the view's job is to render "nothing yet", not to
 * show an error page because one row was malformed.
 *
 * Reports are ordered newest first and capped at VIEW_REPORT_LIMIT; drafts are ordered
 * newest first too. 'enabled' is the only flag that is not data.
 *
 * @param {object} input - { enabled, registry, orchestrators, reports, drafts, policy,
 *   workspaceOf }. 'workspaceOf' is an optional (sessionId) => directory resolver used for a
 *   ledger row that was registered without one.
 * @returns the composed five-segment payload.
 */
export function composeViewState(input = {}) {
  const source = isObject(input) ? input : {}
  const policy = composePolicy(source.policy)
  const reports = rows(source.reports)
    .map(composeReport)
    .filter((report) => report.path !== '')
    .sort((left, right) => right.at - left.at || left.path.localeCompare(right.path))
  const drafts = rows(source.drafts)
    .map(composeDraft)
    .sort((left, right) => right.createdAt - left.createdAt)
  return {
    enabled: source.enabled === true,
    registry: composeRegistry(source.registry, source.workspaceOf),
    orchestrators: rows(source.orchestrators).map(composeOrchestrator),
    reports: reports.slice(0, VIEW_REPORT_LIMIT),
    drafts,
    policy,
  }
}

/**
 * The stable empty payload the view renders while the secretary is off (ticket 06).
 *
 * A fresh structure on every call: the view may keep one as a previous state and
 * compare it, so two calls must never share an object.
 *
 * @returns the empty five-segment payload with enabled false.
 */
export function emptyViewState() {
  return composeViewState({ enabled: false })
}

/** A session's id: the Session itself or its header both answer. */
function sessionIdOf(session) {
  if (!isObject(session)) return ''
  return text(session.id) || text(session.header?.id)
}

/** A session's workspace: the session, its cwd, or its header's cwd. */
function workspaceOf(session) {
  if (!isObject(session)) return ''
  return text(session.workspace) || text(session.cwd) || text(session.header?.cwd)
}

/** A session's title, when it has one. */
function titleOf(session) {
  if (!isObject(session)) return ''
  return text(session.title) || text(session.header?.title)
}

/**
 * One row per registered orchestrator, folding the ledger, the six-state projection,
 * the live beat status and the archive index together.
 *
 * The orchestrator's own state is its projection row (a main session, so the row's
 * role is 'main'); its workers are the live sessions whose header names it as their
 * parent, one row each. 'beats' comes from the real beat status the wiring exposes per
 * session, so count grows with every tick and capped turns true once the run hit its
 * cap. A session that is gone is still listed (title from the ledger, live false) so
 * its history does not vanish.
 *
 * 'step' and 'lastError' are deliberately absent: the six-state projection has no
 * source for either, and returning a field that is always null would leave the view's
 * branches unreachable while looking supported. They come back when a ticket has a
 * real source for them.
 *
 * Pure, and every adapter is optional: a missing stateOf, isLive or beatStatus
 * degrades to no worker rows, live false and the zeroed beat shape instead of throwing.
 *
 * @param {object} input
 * @param registry - the ledger (normalized here, so a raw config value works too).
 * @param sessions - live Sessions from ctx.sessions.list().
 * @param stateOf - handle.stateOf from the projection registration.
 * @param isLive - whether the host still has the agent (ctx.agents.get(id) !== undefined).
 * @param beatStatus - (sessionId) => createBeat(...).status() for that session's beat.
 * @param reports - already-listed report rows (newest first), used for lastReport.
 * @returns the orchestrators segment, one row per registered session, in ledger order.
 */
export function collectOrchestratorRows({ registry, sessions, stateOf, isLive, beatStatus, reports } = {}) {
  const ledger = normalizeRegistry(registry)
  const live = rows(sessions).filter(isObject)
  const byId = new Map()
  const children = new Map()
  for (const session of live) {
    const id = sessionIdOf(session)
    if (id !== '') byId.set(id, session)
    const parent = text(session.header?.parentSession)
    if (parent === '') continue
    const list = children.get(parent)
    if (list === undefined) children.set(parent, [session])
    else list.push(session)
  }

  /** The session's own projection row, if the projection can answer at all. */
  const rowOf = (session) => {
    if (session === undefined || typeof stateOf !== 'function') return undefined
    try {
      const state = stateOf(session)
      const list = rows(state?.workers)
      return list[0]
    } catch {
      return undefined
    }
  }
  const isAlive = (sessionId) => {
    if (typeof isLive !== 'function') return false
    try {
      return isLive(sessionId) === true
    } catch {
      return false
    }
  }
  const beatOf = (sessionId) => {
    if (typeof beatStatus !== 'function') return undefined
    try {
      return beatStatus(sessionId)
    } catch {
      return undefined
    }
  }
  const archived = rows(reports)

  return ledger.orchestrators.map((entry) => {
    const session = byId.get(entry.sessionId)
    const own = rowOf(session)
    const workers = []
    for (const child of children.get(entry.sessionId) ?? []) {
      const row = rowOf(child)
      // A child's own row is a worker row; a 'main' row here would be a tracking mistake.
      if (row === undefined || row.role === 'main') continue
      workers.push({ id: text(row.id) || sessionIdOf(child), state: row.state, summary: row.summary })
    }
    const last = archived.find((report) => text(report?.sessionId) === entry.sessionId)
    return {
      sessionId: entry.sessionId,
      title: entry.title || titleOf(session),
      workspace: entry.workspace || workspaceOf(session),
      live: isAlive(entry.sessionId),
      state: own === undefined ? WORKER_STATE.idle : own.state,
      workers,
      beats: beatsOf(beatOf(entry.sessionId)),
      lastReport: last === undefined ? null : { path: last.path, at: last.at, kind: last.kind },
    }
  })
}

/** The report root of one workspace, built from the policy string. */
function reportRoot(workspace, reportsRoot) {
  const segments = reportsRoot
    .trim()
    .split(/[\\/]+/)
    .filter((segment) => segment !== '')
  return join(workspace, ...segments)
}

/** A report file's kind, read from the heading and the '类型' line it was written with. */
function kindOf(body) {
  const match = body.match(/^#\s*(\S+)/m)
  const heading = match === null ? '' : match[1]
  const byHeading = KIND_BY_HEADING[heading]
  if (byHeading !== undefined) return byHeading
  if (heading !== REPORT_HEADING) return 'unknown'
  const label = body.match(/^-\s*类型：(.+)$/m)
  const mapped = label === null ? undefined : KIND_BY_LABEL[label[1].trim()]
  return mapped ?? 'unknown'
}

/** The three diff subheadings lib/secretary-report.js writes, in template order. */
const DIFF_GROUPS = Object.freeze({ 新完成: 'completed', 新卡住: 'blocked', 状态翻转: 'flipped' })

/**
 * The diff of a report, grouped the way its ### sections were written.
 *
 * Why changed (ticket 08): the three groups are the structure the report already
 * has; flattening them forced the view to reverse-engineer the writer's sentence
 * shapes. A report with the sections returns { completed, blocked, flipped },
 * isomorphic with lib/secretary-diff.js. A report that predates the sections has
 * no labels at all, so it keeps the old flat list (no bullet is dropped and none is
 * mislabeled) and the view marks that row degraded.
 */
function changesOf(body) {
  const groups = { completed: [], blocked: [], flipped: [] }
  const flat = []
  let inside = false
  let current = null
  let sectioned = false
  for (const line of body.split(/\r?\n/)) {
    if (!inside) {
      if (/^##\s*差异/.test(line)) inside = true
      continue
    }
    if (/^##\s/.test(line)) break
    const heading = line.match(/^###\s*(.*)$/)
    if (heading !== null) {
      const name = heading[1].trim()
      current = Object.hasOwn(DIFF_GROUPS, name) ? DIFF_GROUPS[name] : null
      if (current !== null) sectioned = true
      continue
    }
    const bullet = line.match(/^-\s+(.+)$/)
    if (bullet === null) continue
    const item = bullet[1].trim()
    if (item === '') continue
    flat.push(item)
    if (current !== null) groups[current].push(item)
  }
  // Only an unlabeled but non-empty diff is worth the legacy shape; an empty diff has
  // nothing to group either way.
  return sectioned || flat.length === 0 ? groups : flat
}

/** One archived file as a row; a file that vanished between the two calls is skipped. */
async function fileRow(fs, path, sessionId) {
  let stat
  try {
    stat = await fs.stat(path)
  } catch {
    return null
  }
  let body = ''
  let error = null
  if (typeof fs.readFile !== 'function') {
    error = 'the file system cannot read the report'
  } else {
    try {
      const value = await fs.readFile(path, 'utf8')
      if (typeof value === 'string') body = value
      else error = 'the report is not text'
    } catch (cause) {
      error = errorText(cause) || 'unreadable'
    }
  }
  return {
    sessionId,
    at: typeof stat?.mtimeMs === 'number' && Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0,
    kind: kindOf(body),
    path,
    bytes: count(stat?.size) ?? 0,
    changes: changesOf(body),
    error,
  }
}

/** The report files of one conversation directory. */
async function reportFiles(fs, dir, sessionId) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files = []
  for (const entry of rows(entries)) {
    const name = text(entry?.name)
    if (name === '' || !name.toLowerCase().endsWith('.md')) continue
    const row = await fileRow(fs, join(dir, name), sessionId)
    if (row !== null) files.push(row)
  }
  return files
}

/**
 * The archived reports under one workspace's report root.
 *
 * Layout (lib/secretary-archive.js): <root>/<conversation>/<HH-mm>.md, plus a
 * root-level _summary.md that covers several sessions at once (sessionId '').
 * A root that was never written — the normal state before the first report — is an
 * empty list, not an error; that also covers a workspace that was deleted.
 */
async function reportsUnder(fs, root) {
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const listed = []
  for (const entry of rows(entries)) {
    const name = text(entry?.name)
    if (name === '') continue
    const directory = typeof entry.isDirectory === 'function' ? entry.isDirectory() === true : false
    if (directory) {
      listed.push(...(await reportFiles(fs, join(root, name), name)))
      continue
    }
    if (!name.toLowerCase().endsWith('.md')) continue
    const row = await fileRow(fs, join(root, name), '')
    if (row !== null) listed.push(row)
  }
  return listed
}

/**
 * List the archived reports of the given workspaces, newest first.
 *
 * fs is injected (node:fs/promises shape: readdir / stat / readFile) so a test can
 * prove what is and is not read. Missing directories and unreadable files never
 * throw: a report that cannot be listed is left out, and one that can be stat'ed but
 * not read keeps its row with the failure in 'error' — the view shows the problem
 * instead of hiding the entry.
 *
 * @param fs - the file system implementation.
 * @param workspaces - workspaces to read; empty and duplicate roots are skipped.
 * @param reportsRoot - the archive root, relative to a workspace.
 * @param limit - at most this many rows (VIEW_REPORT_LIMIT by default).
 * @returns the report rows, newest first.
 */
export async function listReportRows({ fs, workspaces, reportsRoot = DEFAULT_REPORTS_ROOT, limit = VIEW_REPORT_LIMIT } = {}) {
  if (fs === null || fs === undefined || typeof fs.readdir !== 'function') return []
  const root = typeof reportsRoot === 'string' && reportsRoot.trim() !== '' ? reportsRoot : DEFAULT_REPORTS_ROOT
  const seen = new Set()
  const roots = []
  for (const workspace of rows(workspaces)) {
    const dir = text(workspace)
    if (dir === '') continue
    const target = reportRoot(dir, root)
    if (seen.has(target)) continue
    seen.add(target)
    roots.push(target)
  }
  const listed = []
  for (const target of roots) listed.push(...(await reportsUnder(fs, target)))
  listed.sort((left, right) => right.at - left.at || left.path.localeCompare(right.path))
  const cap = positive(limit) ?? VIEW_REPORT_LIMIT
  return listed.slice(0, cap)
}

/**
 * The Host Service behind orchestratorSecretary/*.
 *
 * secretaryState is the read side (registry + projection + archive + the draft
 * snapshot); confirmDraft / discardDraft are the two writes ticket 08 adds. The switch
 * is read per call, so the same Service answers the empty payload once the secretary is
 * turned off, without a reload and without touching the disk. A read that throws is
 * passed on unchanged: the client then gets an error rather than a blank page that
 * looks like "nothing is running".
 *
 * The write methods never throw for an ordinary outcome: "no such draft", "already
 * sent or discarded", "delivery refused" all come back as `{ delivered, draft, reason }`
 * so the view can leave the draft on screen and show why. Only a broken Service (no
 * draft store / no messaging adapter) answers the documented failure reasons.
 */
export class SecretaryRemote {
  /**
   * @param options.read - returns the four data segments (registry/orchestrators/
   *   reports/drafts) plus policy; composed here into the five-segment payload.
   * @param options.enabled - reads the live secretaryEnabled switch.
   * @param options.drafts - the plugin instance's draft store (lib/secretary-nudge.js).
   * @param options.masterSessionId - reads the registered master session id, the target
   *   of a confirmed nudge.
   * @param options.messaging - the `deliver(target, text, senderSessionId)` adapter built
   *   in lib/index.js over lib/master-messaging.js.
   */
  constructor({ read, enabled, drafts, masterSessionId, messaging } = {}) {
    this.read = read
    this.enabled = typeof enabled === 'function' ? enabled : () => enabled === true
    this.drafts = drafts
    this.masterSessionId =
      typeof masterSessionId === 'function'
        ? masterSessionId
        : () => (typeof masterSessionId === 'string' ? masterSessionId : '')
    this.messaging = messaging
    // The Gateway reads this binding from the Service object; service is checked by
    // identity against the object registered under serviceKey.
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: SECRETARY_SERVICE_KEY,
      namespace: SECRETARY_SERVICE_KEY,
    })
  }

  /** The store's draft, or undefined when there is no store or no such id. */
  draftOf(draftId) {
    if (this.drafts === undefined || this.drafts === null || typeof this.drafts.get !== 'function') return undefined
    return this.drafts.get(draftId)
  }

  /** One status transition; the store refuses anything but pending. */
  decideDraft(draftId, status) {
    if (this.drafts === undefined || this.drafts === null || typeof this.drafts.decide !== 'function') return undefined
    return this.drafts.decide(draftId, status, Date.now())
  }

  /**
   * The view snapshot. No parameters: SRC reflection reads zero arguments.
   *
   * With the switch off, returns emptyViewState() and never calls read — a secretary
   * that is off must not read a conversation, a projection or the archive.
   */
  async secretaryState() {
    if (!this.enabled()) return emptyViewState()
    if (typeof this.read !== 'function') {
      throw new Error('orchestrator: the secretary endpoint has no read function')
    }
    const data = await this.read()
    return composeViewState({ ...(isObject(data) ? data : {}), enabled: true })
  }

  /**
   * Send one pending draft to the registered master session.
   *
   * This is the only place a draft becomes a message. The target is the registered
   * master (never the stuck session itself, and never a guess when the registry is
   * empty); the sender is the session the draft is about, so the receiver can tell
   * where the nudge came from. A refused delivery leaves the draft pending — a failed
   * send must never look sent.
   *
   * A delivery that went through but whose state the store refused to record (for
   * example, the draft was archived while the message was in flight) still answers
   * delivered:true — the message really did go out — but with reason
   * 'state-not-recorded' and the draft's actual state, so the view never shows a
   * pending draft that was already sent.
   *
   * @param draftId - the draft's id (a plain parameter: SRC reflection reads the name).
   * @returns `{ delivered, draft, reason? }`; 'reason' is set on every failure and on
   *   a delivery the store could not record.
   */
  async confirmDraft(draftId) {
    if (!this.enabled()) return { delivered: false, draft: null, reason: 'disabled' }
    const draft = this.draftOf(draftId)
    if (draft === undefined) return { delivered: false, draft: null, reason: 'draft-missing' }
    if (draft.status !== 'pending') return { delivered: false, draft, reason: 'draft-decided' }

    const senderSessionId = draft.sessionId
    const messaging =
      isObject(this.messaging) && typeof this.messaging.deliver === 'function' ? this.messaging : undefined
    const outcome = await deliver({
      messaging:
        messaging === undefined
          ? undefined
          : { deliver: (target, text) => messaging.deliver(target, text, senderSessionId) },
      target: this.masterSessionId(),
      text: draft.text,
    })
    if (outcome.delivered !== true) {
      return { delivered: false, draft, reason: outcome.reason }
    }
    const sent = this.decideDraft(draftId, 'sent')
    if (sent === undefined) {
      // The message is out, but the store did not record it (it was decided by
      // another action while the delivery was in flight). Report the truth instead
      // of handing back a draft that still says pending.
      return { delivered: true, draft, reason: 'state-not-recorded' }
    }
    return { delivered: true, draft: sent }
  }

  /**
   * Archive one pending draft without sending it.
   *
   * @param draftId - the draft's id (a plain parameter: SRC reflection reads the name).
   * @returns `{ draft, reason? }`; a draft that was already decided is not re-decided.
   */
  async discardDraft(draftId) {
    if (!this.enabled()) return { draft: null, reason: 'disabled' }
    const draft = this.draftOf(draftId)
    if (draft === undefined) return { draft: null, reason: 'draft-missing' }
    if (draft.status !== 'pending') return { draft, reason: 'draft-decided' }
    return { draft: this.decideDraft(draftId, 'discarded') ?? draft }
  }
}

// SRC method marker: three direct Remote methods. The Gateway's methodParameterNames
// parses each method's source text, so every one of them stays a plain class method
// with plain parameter names (no destructuring, defaults or rest).
Object.defineProperty(SecretaryRemote.prototype, REMOTE_METHOD_DESCRIPTOR, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([
      Object.freeze({ method: SECRETARY_METHOD, invocation: Object.freeze({ kind: 'direct' }) }),
      Object.freeze({ method: SECRETARY_CONFIRM_METHOD, invocation: Object.freeze({ kind: 'direct' }) }),
      Object.freeze({ method: SECRETARY_DISCARD_METHOD, invocation: Object.freeze({ kind: 'direct' }) }),
    ]),
  }),
})
