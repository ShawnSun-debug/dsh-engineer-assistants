/**
 * The dispatch-command authority (sketch B): the permission layer of the one session
 * designated as the secretary's master.
 *
 * Why a separate layer instead of a wider profile: the default gate refuses read, grep
 * and glob, and its two mechanisms can only ever narrow. A tool restriction cannot grant,
 * and a guard cannot allow, so "read everything, write nothing" is not reachable by
 * adding rules to the gate. This module therefore owns the master's mask instead of the
 * gate: lib/index.js skips installFor for that one agent and hands it here. gate.js and
 * rules.js are untouched; every other agent keeps the default gate.
 *
 * The rules themselves are pure: a policy is an allow list, a deny list and the scope of
 * sessions the agent may address. Nothing in this module knows about the host - the tool
 * registry, the sandbox seam and the approval seam all arrive as injected arguments, and
 * the host-specific halves live in lib/index.js, which is where the wiring belongs.
 *
 * Three things the level means:
 * - allow is the whole contract: a name that is not in it is refused even when the live
 *   catalog never listed it. Reads observe, dispatch hands work out, and the two session
 *   tools address one registered orchestrator each.
 * - deny is what the mask hides from the model. It is the live catalog minus the allow
 *   list, plus a fixed set of write and terminal names so a host whose catalog was
 *   unreadable at install time still cannot show them.
 * - scope.sessions is the registered orchestrator list. A message or an interrupt to any
 *   other session is refused, because the master is not a general-purpose messenger and
 *   reaching into an unregistered conversation is exactly what registration prevents.
 *
 * The second lock is the host's own: the sandbox policy is pinned to read-only and the
 * approval policy to never while the claim is held. It is a file lock, not part of the
 * level definition - the allow list is what makes the level true, and the host lock stays
 * an additional barrier when the tool registry is unavailable. Either seam may be absent
 * (an older host, a unit test): the claim then still stands and only the lock is reported.
 *
 * @module lib/secretary-authority
 */

import { restrictEach } from './gate.js'
import { RUN_CODE_TOOL, runCodeRefusal } from './run-code-guard.js'

/** The one level name this layer can confer. */
export const DISPATCH_COMMAND = 'dispatch-command'

/** How many refusals the in-memory ring keeps. Restarting the process clears it. */
export const VIOLATION_LIMIT = 200

/**
 * Everything the dispatch-command agent may call: reads observe, dispatch delegates, and
 * the two session tools reach one registered orchestrator. A tool missing here is refused
 * by name, whatever the catalog says.
 */
export const AUTHORITY_TOOLS = Object.freeze([
  'read',
  'grep',
  'glob',
  'list',
  'dispatch',
  'send_message',
  'interrupt_agent',
])

/**
 * Names the mask always hides, even when the live catalog could not be read. A tool
 * absent from the catalog is still refused by assertCommandAllowed; this list exists so
 * the model's tool table does not advertise a writer in the first place.
 */
export const WRITE_OR_TERMINAL_TOOLS = Object.freeze([
  'apply_patch',
  'bash',
  'bash_persistent',
  'edit',
  'fs_write',
  'pwsh',
  'pwsh_persistent',
  'shell',
  'str_replace_editor',
  'terminal',
  'terminal_close',
  'terminal_open',
  'terminal_read',
  'terminal_send',
  'terminal_signal',
  'write',
  'working_directory',
])

/** The tools whose target session is part of the decision, not just their name. */
const TARGETED_TOOLS = Object.freeze(['send_message', 'interrupt_agent'])

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function textOf(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * The session an agent speaks for. The host keys agents and sessions by the same id, but
 * the session is the durable record, so it wins when the two ever disagree. An agent with
 * neither is the empty string, and no claim is made for it.
 */
export function sessionIdOf(agent) {
  const fromSession = agent?.session?.id
  if (typeof fromSession === 'string' && fromSession !== '') return fromSession
  return textOf(agent?.id)
}

/**
 * The level of one agent, or null when it is not the designated master.
 *
 * Only the fixed id decides this, and an empty id designates nobody: an unset
 * secretaryMasterSessionId must never turn the first root agent into a commander.
 *
 * @param agent - a live agent (session.id or id).
 * @param options.masterSessionId - the configured master session id.
 * @returns DISPATCH_COMMAND for the master, null otherwise.
 */
export function authorityFor(agent, { masterSessionId } = {}) {
  if (typeof masterSessionId !== 'string') return null
  const master = masterSessionId.trim()
  if (master === '') return null
  if (sessionIdOf(agent) !== master) return null
  return DISPATCH_COMMAND
}

/**
 * Build the policy one refusal is decided against.
 *
 * The allow list is a constant, so an unreadable catalog cannot widen the level. The deny
 * list is everything else the catalog offers plus the fixed write/terminal names, sorted
 * so a reinstalled mask compares equal instead of churning. A name that is both allowed
 * and denied is a profile bug: the deny list loses, because the allow list is the level's
 * definition and the two lists are built from one call.
 *
 * @param options.toolCatalog - every tool name the host currently offers.
 * @param options.registeredSessionIds - sessions a message or an interrupt may address.
 * @returns the policy: { allow, deny, scope: { sessions } }.
 */
export function buildPolicy({ toolCatalog, registeredSessionIds } = {}) {
  const allow = [...AUTHORITY_TOOLS]
  const allowed = new Set(allow)
  const deny = new Set(WRITE_OR_TERMINAL_TOOLS)
  for (const name of Array.isArray(toolCatalog) ? toolCatalog : []) {
    if (typeof name !== 'string' || name === '') continue
    if (allowed.has(name)) continue
    deny.add(name)
  }
  for (const name of allowed) deny.delete(name)
  const sessions = []
  for (const id of Array.isArray(registeredSessionIds) ? registeredSessionIds : []) {
    if (typeof id !== 'string' || id === '') continue
    if (!sessions.includes(id)) sessions.push(id)
  }
  return { allow, deny: [...deny].sort(), scope: { sessions } }
}

/** The refusal for one tool name. One home for the text, so mask and guard cannot drift. */
function refusalFor(toolName) {
  return (
    'orchestrator: "' + toolName + '" is not available to the dispatch-command agent. ' +
    'It reads and dispatches; it never writes, runs commands, or changes a session by itself.'
  )
}

/** The session a targeted tool names, or the empty string when it names none. */
function targetSessionOf(args) {
  if (args === null || typeof args !== 'object') return ''
  for (const key of ['agent_id', 'sessionId', 'session_id']) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

/**
 * Decide one attempted call.
 *
 * Order matters. run_code is the PTC transport: it is the only tool a main agent may call
 * directly, it cannot be restricted, and refusing it by name would take dispatch with it.
 * So the transport itself is allowed and its arguments are checked instead, the same way
 * the default gate does it - a nested tools.write(...) still reaches this guard by name
 * and is refused there.
 *
 * @param options.toolName - the name the guard saw.
 * @param options.args - the call's own arguments, for the targeted tools and run_code.
 * @param options.policy - the result of {@link buildPolicy}, read for this call.
 * @returns { ok: true } or { ok: false, reason }; the reason is also the refusal text.
 */
export function assertCommandAllowed({ toolName, args, policy } = {}) {
  if (typeof toolName !== 'string' || toolName === '') {
    return { ok: false, reason: 'orchestrator: the dispatch-command agent called a tool without a name' }
  }
  if (toolName === RUN_CODE_TOOL) {
    const refusal = runCodeRefusal(args, true)
    return refusal === undefined ? { ok: true } : { ok: false, reason: refusal }
  }
  const allow = Array.isArray(policy?.allow) ? policy.allow : []
  const deny = Array.isArray(policy?.deny) ? policy.deny : []
  if (!allow.includes(toolName) || deny.includes(toolName)) {
    return { ok: false, reason: refusalFor(toolName) }
  }
  if (TARGETED_TOOLS.includes(toolName)) {
    const target = targetSessionOf(args)
    if (target === '') {
      return {
        ok: false,
        reason:
          'orchestrator: "' + toolName + '" needs the session id of a registered orchestrator; ' +
          'the dispatch-command agent may not pick a session at random.',
      }
    }
    const sessions = Array.isArray(policy?.scope?.sessions) ? policy.scope.sessions : []
    if (!sessions.includes(target)) {
      return {
        ok: false,
        reason:
          'orchestrator: "' + toolName + '" to session "' + target + '" is refused: the dispatch-command agent ' +
          'may only contact an orchestrator session registered with the secretary.',
      }
    }
  }
  return { ok: true }
}

/**
 * One bounded, in-memory violation ring. It is a plain object with an entries array so a
 * caller can inject its own (a test, a future JSONL sink) without this module owning a
 * module-level singleton that two plugin instances would share.
 *
 * @param options.limit - how many entries to keep; the default is VIOLATION_LIMIT.
 */
export function createViolationRing({ limit = VIOLATION_LIMIT } = {}) {
  const size = Number.isSafeInteger(limit) && limit > 0 ? limit : VIOLATION_LIMIT
  return { limit: size, entries: [] }
}

/** The live entry array of a ring (a bare array is accepted too). */
function entriesOf(ring) {
  if (Array.isArray(ring)) return ring
  if (ring !== null && typeof ring === 'object' && Array.isArray(ring.entries)) return ring.entries
  return undefined
}

function limitOf(ring) {
  if (Array.isArray(ring)) return VIOLATION_LIMIT
  const limit = ring?.limit
  return Number.isSafeInteger(limit) && limit > 0 ? limit : VIOLATION_LIMIT
}

/**
 * Append one refused call. The oldest entry is dropped past the limit, so a master that
 * keeps trying cannot grow the ring without bound. A missing ring is a no-op rather than a
 * throw: recording is a diagnostic, never load-bearing.
 *
 * @param ring - the ring from {@link createViolationRing}, or a bare array.
 * @param entry - { at, agentId, action, reason }; at defaults to now.
 */
export function recordViolation(ring, entry) {
  const store = entriesOf(ring)
  if (store === undefined) return
  const at = typeof entry?.at === 'number' && Number.isFinite(entry.at) ? entry.at : Date.now()
  store.push({
    at,
    agentId: textOf(entry?.agentId),
    action: textOf(entry?.action),
    reason: textOf(entry?.reason),
  })
  const limit = limitOf(ring)
  while (store.length > limit) store.shift()
}

/**
 * Read the ring newest first, as a copy: the view must not be able to mutate the store.
 *
 * @param ring - the ring from {@link createViolationRing}, or a bare array.
 * @returns up to the ring's limit entries, newest first.
 */
export function listViolations(ring) {
  const store = entriesOf(ring)
  if (store === undefined) return []
  return [...store].reverse()
}

/**
 * Create the authority layer: it owns the master's mask, guard, host locks and the
 * violation ring.
 *
 * The mask is installed first and the default gate is lifted only afterwards, so there is
 * no moment in which neither one is applied. Releasing runs the other way: the default gate
 * is reinstalled before this layer's mask is lifted, and if that reinstall fails the mask
 * stays - the failure mode is always "too strict", never "no gate".
 *
 * @param options.installFor - gate.installFor: reinstall the default gate on release.
 * @param options.disposeFor - lift the default gate once this layer has its own mask.
 * @param options.sandbox - optional { lock(agent) -> undo } host sandbox seam.
 * @param options.approval - optional { lock(agent) -> undo } host approval seam.
 * @param options.violations - optional ring; a fresh one is created when omitted.
 * @param options.now - clock for violation timestamps; defaults to Date.now.
 * @param options.policy - optional () => buildPolicy(...), read per call.
 * @param options.logger - optional (message) => void for failures and downgrades.
 * @returns { install, dispose, claimOf, policyOf, violations, ring }.
 */
export function createAuthority({
  installFor,
  disposeFor,
  sandbox,
  approval,
  violations,
  now,
  policy,
  logger,
} = {}) {
  const clock = typeof now === 'function' ? now : Date.now
  const ring = violations ?? createViolationRing()
  const claims = new Map()
  const warn = (message) => {
    try {
      if (typeof logger === 'function') logger(message)
    } catch {
      // A logger must never break a claim.
    }
  }

  const currentPolicy = () => {
    if (typeof policy === 'function') {
      try {
        const built = policy()
        if (built !== null && typeof built === 'object' && Array.isArray(built.allow) && Array.isArray(built.deny)) {
          return built
        }
      } catch (error) {
        warn('orchestrator: secretary authority: cannot build the policy: ' + messageOf(error))
      }
    }
    return { allow: [...AUTHORITY_TOOLS], deny: [...WRITE_OR_TERMINAL_TOOLS], scope: { sessions: [] } }
  }

  /**
   * Claim one agent. Returns that claim's disposer, or undefined when the agent cannot be
   * claimed - the caller must then install the default gate instead of leaving it bare.
   */
  const install = (agent) => {
    if (agent === null || typeof agent !== 'object') return undefined
    const id = sessionIdOf(agent)
    if (id === '') return undefined
    const existing = claims.get(id)
    if (existing !== undefined) return existing.dispose
    if (typeof agent?.ctx?.tools?.restrict !== 'function') {
      warn('orchestrator: secretary authority: session ' + id + ' has no tool registry; the dispatch-command authority cannot claim it')
      return undefined
    }

    const installedPolicy = currentPolicy()
    const mask = restrictEach(agent, installedPolicy.deny)
    let guardDispose
    try {
      guardDispose = agent.ctx.tools.guard((exec) => {
        const toolName = exec?.name
        // The policy is rebuilt per call so a registry edit (a newly registered
        // orchestrator) reaches the target check without reinstalling the mask.
        const verdict = assertCommandAllowed({ toolName, args: exec?.arguments, policy: currentPolicy() })
        if (verdict.ok) return undefined
        recordViolation(ring, {
          at: clock(),
          agentId: id,
          action: typeof toolName === 'string' ? toolName : '',
          reason: verdict.reason,
        })
        return verdict.reason
      })
    } catch (error) {
      guardDispose = undefined
      warn('orchestrator: secretary authority: session ' + id + ': cannot install the guard: ' + messageOf(error))
    }

    const undo = []
    for (const [label, seam] of [
      ['sandbox', sandbox],
      ['approval', approval],
    ]) {
      if (typeof seam?.lock !== 'function') continue
      try {
        const restore = seam.lock(agent)
        if (typeof restore === 'function') undo.push(restore)
      } catch (error) {
        warn('orchestrator: secretary authority: session ' + id + ': the ' + label + ' lock failed: ' + messageOf(error))
      }
    }

    // Only now is the default gate lifted: strict first, loose second, with no bare window.
    if (typeof disposeFor === 'function') {
      try {
        disposeFor(agent)
      } catch (error) {
        warn('orchestrator: secretary authority: session ' + id + ': cannot lift the default gate: ' + messageOf(error))
      }
    }

    const claim = { agent, sessionId: id, policy: installedPolicy, released: false }
    /**
     * Release the claim. installDefault: false is for an agent that is going away: it lifts
     * this layer without reinstalling the default gate. Every other release reinstalls the
     * default gate first, and keeps this layer when that fails.
     */
    claim.dispose = (options = {}) => {
      if (claim.released === true) return
      claim.released = true
      claims.delete(id)
      const restoreDefault = options === null || typeof options !== 'object' || options.installDefault !== false
      let reinstated = restoreDefault === false
      if (restoreDefault) {
        try {
          if (typeof installFor === 'function') {
            installFor(agent)
            reinstated = true
          }
        } catch (error) {
          warn('orchestrator: secretary authority: session ' + id + ': cannot reinstall the default gate: ' + messageOf(error))
        }
      }
      if (!reinstated) {
        warn(
          'orchestrator: secretary authority: session ' + id + ': keeping the dispatch-command mask, ' +
            'because the default gate could not be reinstalled',
        )
        return
      }
      for (const restore of undo.reverse()) {
        try {
          restore()
        } catch (error) {
          warn('orchestrator: secretary authority: session ' + id + ': cannot restore a host lock: ' + messageOf(error))
        }
      }
      for (const dispose of mask.disposers) {
        try {
          dispose()
        } catch {
          // A restriction that is already gone needs no further cleanup.
        }
      }
      if (typeof guardDispose === 'function') {
        try {
          guardDispose()
        } catch {
          // Same: an unregistered guard needs no cleanup either.
        }
      }
      claim.policy = undefined
    }

    claims.set(id, claim)
    return claim.dispose
  }

  /** Release every claim, reinstating the default gate for each live agent. */
  const dispose = () => {
    for (const claim of [...claims.values()]) {
      try {
        claim.dispose()
      } catch (error) {
        warn('orchestrator: secretary authority: cannot release ' + claim.sessionId + ': ' + messageOf(error))
      }
    }
  }

  return {
    level: DISPATCH_COMMAND,
    install,
    dispose,
    /** The live claim for one agent, or undefined. */
    claimOf: (agent) => claims.get(sessionIdOf(agent)),
    /** The claimed policy for one agent, or undefined. */
    policyOf: (agent) => claims.get(sessionIdOf(agent))?.policy,
    /** The ring newest first; the view reads this, never the store itself. */
    violations: () => listViolations(ring),
    /** The injected ring, for the payload reader. */
    ring: () => ring,
  }
}
