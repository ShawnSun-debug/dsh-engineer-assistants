/**
 * The master status panel's data plane (ticket 03).
 *
 * One pure fold over every live Session's own projection row (ticket 02):
 * handle.stateOf(session) returns { workers: [row] }, and this module flatMaps
 * those rows into the six-state counts plus the rows the panel lists. It reads
 * no service and calls no model, so it is testable with fake sessions and a
 * fake stateOf.
 *
 * Only role 'worker' rows enter the panel. A main session is a conversation,
 * not a worker: ticket 02 reports its closed turn as Idle (there is no 'task
 * finished' event), so listing it would make the panel's empty state ('no
 * worker yet') unreachable while adding no information the master can act on.
 *
 * The Remote entry is deliberately built from the host's documented SRC
 * fallback rather than generated Typert artifacts: this plugin is plain
 * JavaScript with no build step, and the Gateway's SRC mode exists for exactly
 * that case (a Service with a typertRemote binding and method markers on its
 * prototype). ctx.provide() registers the Service under MASTER_SERVICE_KEY; the
 * Gateway exposes it at orchestratorMaster/masterState.
 */

import { WORKER_STATES } from './master-state.js'

/** Cordis service key and Remote namespace of the read-only endpoint. */
export const MASTER_SERVICE_KEY = 'orchestratorMaster'

/** The one Remote method the panel calls. */
export const MASTER_METHOD = 'masterState'

/** Canonical Remote endpoint: <namespace>/<method>. */
export const MASTER_ENDPOINT = MASTER_SERVICE_KEY + '/' + MASTER_METHOD

/**
 * The Typert protocol's marker key. A Service without a build step records its
 * Remote methods here; the Gateway's SRC reflection reads it from the live
 * prototype (remoteMethods() in @deepseek-ai/dsh-typert-protocol).
 */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** Six zeroed counters, in the fixed state order. */
export function emptyStateCounts() {
  const byState = {}
  for (const state of WORKER_STATES) byState[state] = 0
  return byState
}

/**
 * Fold every live Session's projection row into the panel's data.
 *
 * A session whose projection throws, or that has no row, is skipped: one broken
 * session must not blank the whole panel. A row whose state is outside the six
 * values is skipped too - the panel's grouping is fixed, and an unknown value
 * would otherwise be dropped from every group while inflating a count.
 *
 * @param sessions - live Sessions from ctx.sessions.list().
 * @param stateOf - handle.stateOf from the ticket-02 registration.
 * @returns { byState, workers }: six counts and the worker rows in session order.
 */
export function collectMasterPanel(sessions, stateOf) {
  const byState = emptyStateCounts()
  const workers = []
  for (const session of Array.isArray(sessions) ? sessions : []) {
    let rows
    try {
      rows = stateOf(session)?.workers
    } catch {
      continue
    }
    if (!Array.isArray(rows)) continue
    for (const row of rows) {
      if (row?.role !== 'worker') continue
      const state = row.state
      // hasOwn, not `in`: a plain object answers true for 'constructor' and 'toString',
      // and those rows would then be counted and rendered as states.
      if (typeof state !== 'string' || !Object.hasOwn(byState, state)) continue
      byState[state] += 1
      workers.push({
        id: typeof row.id === 'string' ? row.id : String(row.id ?? ''),
        role: 'worker',
        state,
        summary: typeof row.summary === 'string' ? row.summary : '',
      })
    }
  }
  return { byState, workers }
}

/**
 * The read-only Host Service behind orchestratorMaster/masterState.
 *
 * registration is the thenable ctx.sessionProjections.register() returned; it
 * resolves to the handle whose stateOf this Service calls. The switch is read
 * per call, so turning the panel off takes effect without a reload - and while
 * it is off the method returns the empty shape instead of any worker data.
 */
export class MasterRemote {
  /**
   * @param options.sessions - returns the live Session list (ctx.sessions.list).
   * @param options.registration - the master projection registration thenable.
   * @param options.enabled - reads the live masterPanelEnabled switch.
   */
  constructor({ sessions, registration, enabled } = {}) {
    this.sessions = typeof sessions === 'function' ? sessions : () => sessions ?? []
    this.registration = registration
    this.enabled = typeof enabled === 'function' ? enabled : () => enabled !== false
    // The Gateway reads this binding from the Service object; service is checked
    // by identity against the object registered under serviceKey.
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: MASTER_SERVICE_KEY,
      namespace: MASTER_SERVICE_KEY,
    })
  }

  /**
   * The panel snapshot. No parameters: SRC reflection reads zero arguments.
   *
   * @returns { enabled, byState, workers }; with the switch off, every count is
   *   zero and no worker row leaves the host.
   */
  async masterState() {
    if (!this.enabled()) return { enabled: false, byState: emptyStateCounts(), workers: [] }
    const handle = await this.registration
    if (handle === undefined || handle === null || typeof handle.stateOf !== 'function') {
      throw new Error('orchestrator: the master projection registration has no stateOf handle')
    }
    return { enabled: true, ...collectMasterPanel(this.sessions(), (session) => handle.stateOf(session)) }
  }
}

// SRC method marker: one direct Remote method with no parameters. The Gateway's
// methodParameterNames parses the method's source text, so masterState must stay
// a plain class method with an empty parameter list.
Object.defineProperty(MasterRemote.prototype, REMOTE_METHOD_DESCRIPTOR, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([Object.freeze({ method: MASTER_METHOD, invocation: Object.freeze({ kind: 'direct' }) })]),
  }),
})
