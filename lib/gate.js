/**
 * The main-agent gate. Dependency-free, so the whole gate can be tested without
 * the DSH runtime.
 *
 * The gate follows the dispatch switch instead of the moment an agent was created:
 * the guard is installed for every top-level agent and reads `enabled()` on each
 * call, so turning the switch on in an already open conversation takes effect at
 * once. Hiding is a separate, reversible step, re-applied from the live list whenever
 * the config changes (`refresh`), because the host stores the names a restriction was
 * installed with instead of re-reading them on every request.
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
 * Every name is deniable, the two delegation tools included: the panel offers the whole
 * catalog and the guard refuses exactly what the profile denies.
 *
 * One name needs more than a name check. `run_code` is the PTC transport: it is the only
 * tool a main agent may call directly, it cannot be restricted, and hiding it would hide
 * `tools.dispatch` with it. So while the gate denies anything at all, the guard also reads
 * the call's own arguments — see `run-code-guard.js` for the two escapes it closes (a
 * sandbox escalation on the call, and a program that reaches the Node.js runtime instead of
 * going through `tools.*`).
 */

import { DELEGATE_TOOL } from './api.js'
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

/**
 * The effective deny list. A profile that spells out `deniedTools` replaces the
 * schema default instead of extending it, so the shipped list is always merged in:
 * a stale profile can add names but never silently shrink the gate back to a few
 * tools.
 */
export function mergeDenied(defaults, configured) {
  const merged = new Set()
  for (const name of defaults ?? []) merged.add(name)
  for (const name of configured ?? []) merged.add(name)
  return [...merged]
}

/**
 * The effective deny list, read live by the gate: the shipped list plus the profile's
 * additions, minus the names the profile re-allows. `allowedTools` is the only way to
 * remove a name, because a profile's `deniedTools` replaces the schema default and
 * therefore can only ever widen the gate. There is no exception: the panel may deny any
 * tool the host offers, the two delegation tools included.
 */
export function effectiveDenied(defaults, denied, allowed) {
  const merged = mergeDenied(defaults, denied)
  const removable = new Set(allowed ?? [])
  return merged.filter((name) => !removable.has(name))
}

/**
 * The refusal for one denied tool name. One home for the text, so a name check and the
 * `run_code` argument check can never drift into two slightly different messages.
 */
function refusalFor(tool) {
  return `orchestrator: "${tool}" is not available to the main agent. The main agent only plans; hand every action to a worker with the dispatch tool.`
}

/**
 * Build a guard predicate for a fixed list. Kept separate from `installGate`,
 * which reads its list per call.
 *
 * A name in the list is refused first and unchanged, `run_code` included: a profile that
 * checks it in the panel gets the plain tool-level refusal. Only when the name itself is
 * not denied does the `run_code` argument check run, and only while the list is non-empty —
 * an empty list means the profile denied nothing, so nothing is refused here either.
 */
export function denyGuard(names) {
  const denied = new Set(names ?? [])
  return (exec) => {
    const tool = exec?.name
    if (typeof tool !== 'string') return undefined
    if (denied.has(tool)) return refusalFor(tool)
    if (tool !== RUN_CODE_TOOL) return undefined
    return runCodeRefusal(exec?.arguments, denied.size > 0)
  }
}

/**
 * Install a switch-aware gate on one top-level agent.
 *
 * `names()` and `enabled()` are read live. While the switch is off the guard lets
 * everything through and lifts any earlier restriction; while it is on the gate
 * hides the current list and refuses a denied name at execution time, which is what
 * covers scope-local tools such as `subagent`. A guard failure is reported, not
 * thrown: a broken gate must not break agent creation.
 *
 * Hiding is a mask the host stores, not a predicate it calls: the tool registry
 * evaluates every restriction on every model request, but it evaluates the names it
 * was given when `restrict()` ran. A panel write therefore changes nothing the model
 * sees until the mask is replaced, which is what `refresh()` does — lift the old
 * handles first, then install the current list, so repeated calls never accumulate
 * restrictions. `dispose()` removes the mask and the guard together.
 */
export function installGate({ agent, names, enabled }) {
  let disposers = []
  // The list the live mask was built from; `null` means nothing is hidden.
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

  /**
   * Lift the old mask and install the one the config describes now. Idempotent: an
   * unchanged config costs one list comparison and touches nothing, so a caller may
   * run it on every request, every tool call, or every settings write.
   */
  const sync = () => {
    const on = enabled()
    const list = on ? [...names()] : []
    const key = on ? list.join('\u0000') : null
    if (key === appliedKey) return { applied: [], skipped: [], changed: false }
    lift()
    if (key === null) return { applied: [], skipped: [], changed: true }
    const result = restrictEach(agent, list)
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
      if (typeof tool !== 'string') return undefined
      const list = names()
      if (list.includes(tool)) return refusalFor(tool)
      // `run_code` is never in the list on a normal profile, so the transport itself stays
      // callable while the arguments that would escape the gate are refused.
      if (tool !== RUN_CODE_TOOL) return undefined
      return runCodeRefusal(exec?.arguments, list.length > 0)
    })
  } catch (error) {
    guardError = error instanceof Error ? error.message : String(error)
  }
  return {
    applied: installed.applied,
    skipped: installed.skipped,
    guarded: [...names()],
    guardError,
    /** Re-apply the mask from the current config. `true` when the list actually moved. */
    refresh: () => sync().changed,
    /** Lift the mask and unregister the guard. */
    dispose: () => {
      lift()
      if (typeof guardDispose === 'function') guardDispose()
    },
  }
}
