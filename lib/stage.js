/**
 * Stage derivation. Pure: no imports, so it can be tested without the DSH runtime.
 *
 * The stage is a fold over events the session already records. Nothing new is
 * persisted, and a reload rebuilds the same answer from the log.
 *
 * Not derivable today: a review/acceptance stage. Nothing in the log marks "the
 * workers are done and the main agent is now checking", so it is left out rather
 * than guessed.
 */

export const STAGES = ['idle', 'clarify', 'planning', 'awaiting', 'executing', 'na']

/**
 * Tools whose call means work is being handed to other agents. `delegate` and
 * `orchestrate` stay for logs recorded before they were merged into `dispatch`.
 */
export const DELEGATE_TOOLS = new Set([
  'subagent',
  'subagent_fork',
  'workflow',
  'dispatch',
  'delegate',
  'orchestrate',
])

/**
 * A forked session inherits the parent's history, so its tool calls say nothing
 * about this session's own stage. It reports `na` instead of a misleading stage.
 */
export function initialState(inheritedEventCount) {
  return { stage: inheritedEventCount > 0 ? 'na' : 'idle', plan: false }
}

/** The tool a call event names. PTC dispatch carries the name on its start event. */
function calledTool(event) {
  if (event.type !== 'tool/call' && event.type !== 'tool/ptc-dispatch-start') return undefined
  const name = event.data?.name
  return typeof name === 'string' ? name : undefined
}

export function reduceStage(state, event) {
  if (state.stage === 'na') return state

  if (event.type === 'turn/start') {
    return state.stage === 'idle' ? { ...state, stage: 'clarify' } : state
  }

  if (event.type === 'plan/mode') {
    if (event.data?.active === true) return { stage: 'planning', plan: true }
    // Leaving plan mode while a plan is awaiting review means it was approved.
    if (state.stage === 'awaiting') return { stage: 'executing', plan: false }
    // Leaving by hand mid-planning drops back to conversation.
    if (state.stage === 'planning') return { stage: 'clarify', plan: false }
    return { ...state, plan: false }
  }

  const tool = calledTool(event)
  if (tool === undefined) return state

  if (tool === 'todo_write') {
    return state.stage === 'idle' || state.stage === 'clarify' ? { ...state, stage: 'planning' } : state
  }
  if (tool === 'exit_plan_mode') {
    return state.plan ? { ...state, stage: 'awaiting' } : state
  }
  if (DELEGATE_TOOLS.has(tool)) {
    // Delegation while still planning or awaiting review is exploration, not execution.
    return state.stage === 'planning' || state.stage === 'awaiting' ? state : { ...state, stage: 'executing' }
  }
  return state
}
