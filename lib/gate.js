/**
 * The main-agent gate. Dependency-free, so the whole gate can be tested without
 * the DSH runtime.
 *
 * The gate is whitelist-driven: only the tools named by the live Allowed Tools list
 * stay available to a main agent, and every other tool the host offers — a built-in
 * tool, a tool another plugin registered, an MCP tool loaded after this plugin, and
 * even a tool that does not exist yet — is hidden and refused. The shipped default is
 * `DEFAULT_ALLOWED_TOOLS` in `lib/index.js`; a profile may replace it with any set,
 * and an empty set means the main agent gets nothing at all.
 *
 * The gate follows the dispatch switch instead of the moment an agent was created:
 * the guard is installed for every top-level agent and reads `enabled()` on each
 * call, so turning the switch on in an already open conversation takes effect at
 * once. Hiding is a separate, reversible step, re-applied from the live list whenever
 * the config or the registry changes (`refresh`), because the host stores the names a
 * restriction was installed with instead of re-reading them on every request.
 *
 * Two mechanisms, because one is not enough:
 * - `tools.restrict` hides a tool from the agent, but only for GLOBAL tools. It throws
 *   `tools.restrict() names unknown global tool "x"` for a tool registered in the agent's
 *   own scope, which is where DSH registers the native `subagent` tool. A throw leaves the
 *   tool visible and callable, so hiding alone cannot make the gate real.
 * - `tools.guard` takes a synchronous predicate over an attempted execution and applies to
 *   the agent's own scope too, so a scope-local tool such as `subagent`, and any shell tool
 *   that could write files, can be refused at call time. It also covers calls nested inside
 *   `run_code`.
 *
 * Every name is allow-listed, the two delegation tools included: the panel offers the whole
 * catalog, only the checked names stay callable, and the guard refuses exactly what the
 * whitelist leaves out.
 *
 * One name needs more than a name check. `run_code` is the PTC transport: it is the one
 * tool a main agent may call directly, it cannot be restricted, and hiding it would hide
 * `tools.dispatch` with it. It is therefore never part of the hidden set; the guard lets
 * it through unless the panel checks it explicitly, and reads the call's own arguments
 * instead — see `run-code-guard.js` for the two escapes it closes (a sandbox escalation
 * on the call, and a program that reaches the Node.js runtime instead of going through
 * `tools.*`).
 */

import { DELEGATE_TOOL } from './api.js'
import { viewNames } from './catalog.js'
import { RUN_CODE_TOOL, runCodeRefusal } from './run-code-guard.js'

export { DELEGATE_TOOL }

/**
 * Whether an agent is a delegated child. Mirrors the host's `delegationDepthOf`
 * (`Math.max(header.delegationDepth ?? 0, options.subagentDepth ?? 0)`): the
 * persisted session header is the authoritative, monotonic record, and it is the
 * only depth that survives a cold resume. A resumed child is rebuilt from options
 * holding just provider/model/effort, with no `subagentDepth`, so reading the live
 * options alone would misclassify it as the main agent; the runtime value may only
 * deepen the depth, never lower it. A dirty value (negative, fractional, NaN, a
 * string) is treated as absent instead of throwing, because a throw inside the
 * `agent/created` hook would break the host's announce path. A GUI fork is a new
 * root session — it has a `parentSession` but a depth of zero — so it is still
 * gated as a main agent, which is why the test is depth-based, not origin-based.
 */
export function isDelegatedChild(agent) {
  const runtime = agent?.options?.subagentDepth
  const persisted = agent?.session?.header?.delegationDepth
  const floor = Number.isSafeInteger(persisted) && persisted > 0 ? persisted : 0
  const live = Number.isSafeInteger(runtime) && runtime > 0 ? runtime : 0
  return Math.max(floor, live) > 0
}

/**
 * Restrict one tool at a time. `tools.restrict` throws for a name the agent does
 * not inherit, so a single unknown name must not discard the others. Each
 * restriction hands back its disposer, so the gate can be lifted again.
 */
export function restrictEach(agent, names) {
  const applied = []
  const skipped = []
  const disposers = []
  for (const tool of names) {
    try {
      const dispose = agent.ctx.tools.restrict({ deny: [tool] })
      applied.push(tool)
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      skipped.push(`${tool} (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  return { applied, skipped, disposers }
}

/** Non-empty strings only, in first-seen order. */
function cleanNames(names) {
  const seen = new Set()
  for (const name of names ?? []) {
    if (typeof name === 'string' && name !== '') seen.add(name)
  }
  return [...seen]
}

/**
 * The effective allow list, read live by the gate.
 *
 * A whitelist is driven only by what it names, so it never merges the shipped default
 * with the profile's value: a profile that spells out `allowedTools` replaces the schema
 * default instead of extending it. `undefined`/`null` means "not configured yet" and falls
 * back to `defaults`; an array — the empty array included — is used as given, so unchecking
 * every box in the panel disables every tool instead of resurrecting the default. Duplicates
 * and non-string entries are dropped.
 */
export function effectiveAllowed(configured, defaults = []) {
  const source = configured === undefined || configured === null ? defaults : configured
  return cleanNames(source)
}

/**
 * The tools a whitelist hides: every catalog name that is neither allowed nor the reserved
 * `run_code` transport. `run_code` is excluded because `tools.restrict` refuses to hide it
 * (hiding it would also hide `tools.dispatch`); the guard covers it by its arguments instead.
 */
export function hiddenTools(catalog, allowed) {
  const allowedSet = new Set(cleanNames(allowed))
  const hidden = []
  const seen = new Set()
  for (const name of catalog ?? []) {
    if (typeof name !== 'string' || name === '') continue
    if (name === RUN_CODE_TOOL || allowedSet.has(name) || seen.has(name)) continue
    seen.add(name)
    hidden.push(name)
  }
  return hidden
}

/**
 * The refusal for one tool outside the whitelist. One home for the text, so a name check
 * and the `run_code` argument check can never drift into two slightly different messages.
 */
function refusalFor(tool) {
  return `orchestrator: "${tool}" is not available to the main agent. The main agent only plans; hand every action to a worker with the dispatch tool.`
}

/**
 * Build a whitelist guard predicate for a fixed list. Kept separate from `installGate`,
 * which reads its list per call.
 *
 * An allowed name passes untouched, `run_code` included: a profile that checks the
 * transport in the panel gets the plain pass. Only a name outside the list is refused, and
 * `run_code` gets the argument check instead, because the transport itself must stay
 * callable while the arguments that would escape the gate are refused.
 */
export function allowGuard(allowed) {
  const allowedSet = new Set(cleanNames(allowed))
  return (exec) => {
    const tool = exec?.name
    if (typeof tool !== 'string' || tool === '') return undefined
    if (allowedSet.has(tool)) return undefined
    if (tool === RUN_CODE_TOOL) return runCodeRefusal(exec?.arguments, true)
    return refusalFor(tool)
  }
}

/**
 * Install a switch-aware, whitelist-driven gate on one top-level agent.
 *
 * `allowed()`, `catalog()` and `enabled()` are read live. `allowed` is the Allowed Tools
 * whitelist; `catalog` is the full set of names the host currently knows. Both accept a
 * plain array too, for tests and callers without a live config. While the switch is off the
 * guard lets everything through and lifts any earlier restriction; while it is on the gate
 * hides every name the whitelist does not cover and refuses a call to one at execution
 * time, which is what covers scope-local tools such as `subagent`. A guard failure is
 * reported, not thrown: a broken gate must not break agent creation.
 *
 * The hidden set is computed from `catalog()` plus whatever the agent's own scope view
 * shows, so a new plugin or MCP tool that registers after this agent was created is hidden
 * as soon as something calls `refresh()` — which is why `lib/index.js` refreshes on
 * `tools/change`, not only on a settings write.
 *
 * Hiding is a mask the host stores, not a predicate it calls: the tool registry evaluates
 * every restriction on every model request, but it evaluates the names it was given when
 * `restrict()` ran. A panel write or a late registration therefore changes nothing the
 * model sees until the mask is replaced, which is what `refresh()` does — lift the old
 * handles first, then install the current set, so repeated calls never accumulate
 * restrictions. `dispose()` removes the mask and the guard together.
 */
export function installGate({ agent, allowed, catalog = () => [], enabled = () => true }) {
  const liveAllowed = typeof allowed === 'function' ? allowed : () => allowed ?? []
  const liveCatalog = typeof catalog === 'function' ? catalog : () => catalog ?? []

  let disposers = []
  // The hidden set the live mask was built from; `null` means nothing is hidden.
  let appliedKey = null

  const lift = () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // A restriction that is already gone needs no further cleanup.
      }
    }
    disposers = []
    appliedKey = null
  }

  /** The names the agent's own scope knows, so a scope-local tool is a hide candidate too. */
  const scopeNames = () => {
    try {
      return viewNames(agent?.ctx?.tools?.view?.(agent))
    } catch {
      return []
    }
  }

  /**
   * Every name the gate may need to hide: the catalog the caller passes plus the agent's own
   * scope view. The union matters because the catalog is a snapshot of the registry, while
   * the scope view also names a tool a preset registered in this agent's own scope.
   */
  const candidateTools = () => {
    const names = new Set()
    try {
      for (const name of liveCatalog() ?? []) {
        if (typeof name === 'string' && name !== '') names.add(name)
      }
    } catch {
      // An unreadable catalog contributes nothing; the scope view below still applies.
    }
    for (const name of scopeNames()) names.add(name)
    return [...names]
  }

  /**
   * Lift the old mask and install the one the config and the current catalog describe.
   * Idempotent: an unchanged whitelist costs one list comparison and touches nothing, so a
   * caller may run it on every request, every tool call, or every settings write.
   */
  const sync = () => {
    if (!enabled()) {
      const changed = appliedKey !== null || disposers.length > 0
      lift()
      return { applied: [], skipped: [], changed }
    }
    const toHide = hiddenTools(candidateTools(), liveAllowed())
    const key = toHide.join('\u0000')
    if (key === appliedKey) return { applied: [], skipped: [], changed: false }
    lift()
    const result = restrictEach(agent, toHide)
    disposers = result.disposers
    appliedKey = key
    return { ...result, changed: true }
  }

  const installed = sync()
  let guardError
  let guardDispose
  try {
    guardDispose = agent.ctx.tools.guard((exec) => {
      // Safety net for a change no event announced (an older host, a direct write):
      // the next call re-syncs before it decides, so the model's next request sees it.
      sync()
      if (!enabled()) return undefined
      const tool = exec?.name
      if (typeof tool !== 'string' || tool === '') return undefined
      const list = liveAllowed()
      if (list.includes(tool)) return undefined
      // `run_code` is the PTC transport: it stays callable unless the panel checks it, and
      // the arguments that would escape the gate are refused instead.
      if (tool === RUN_CODE_TOOL) return runCodeRefusal(exec?.arguments, true)
      return refusalFor(tool)
    })
  } catch (error) {
    guardError = error instanceof Error ? error.message : String(error)
  }
  return {
    applied: installed.applied,
    skipped: installed.skipped,
    allowed: [...liveAllowed()],
    guardError,
    /** Re-apply the mask from the current config and catalog. `true` when it moved. */
    refresh: () => sync().changed,
    /** Lift the mask and unregister the guard. */
    dispose: () => {
      lift()
      if (typeof guardDispose === 'function') guardDispose()
    },
  }
}
