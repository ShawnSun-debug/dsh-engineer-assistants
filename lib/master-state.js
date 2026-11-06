/**
 * Cross-project worker status. Pure: no imports, so it can be folded inside the
 * host's projection drive and tested without the DSH runtime.
 *
 * One session is one worker: the master (and its panel) sees "who is running,
 * who is waiting, who is done" by folding each session's own log, so nothing new
 * is persisted and nothing calls a model. A reload rebuilds the same answer.
 *
 * The fold only reads evidence the host already records:
 * - `turn/start` opens work; `turn/end` closes it with a recorded reason
 *   (@deepseek-ai/dsh-session `TurnEndReasonMap`).
 * - A `tool/call` of a tool that parks the turn on a human answer is the only
 *   reliable "waiting for the user" signal in the log; `ask_user_question` is
 *   what the host's own client keys that state on
 *   (dsh-client-ui-user-questions: `tool/call` with that name starts a question).
 * - The one-line summary is the latest `session/title` event (log-only, derived
 *   by the host without asking us); before the first title it falls back to the
 *   first human `user/message` text.
 *
 * Not derivable today: whether a worker's result was accepted, and whether a
 * *main* session's turn is a finished task or just a pause. Nothing in the log
 * marks either, so a main session reports Idle and only a delegated session
 * (header `origin` / `delegationDepth`) may report Completed.
 */

/** The fixed state machine. Six values, no more: the index is machine-checked. */
export const WORKER_STATES = ['Working', 'Needs input', 'Idle', 'Completed', 'Failed', 'Stopped']

const [WORKING, NEEDS_INPUT, IDLE, COMPLETED, FAILED, STOPPED] = WORKER_STATES

/**
 * The six states as named constants, so comparisons read a name instead of repeating the
 * string literal. Every value comes from WORKER_STATES: the state name is written once.
 */
export const WORKER_STATE = Object.freeze({
  working: WORKING,
  needsInput: NEEDS_INPUT,
  idle: IDLE,
  completed: COMPLETED,
  failed: FAILED,
  stopped: STOPPED,
})

/**
 * The secretary archive root, relative to a workspace. The report writer
 * (lib/secretary-archive.js) and the view reader (lib/secretary-panel.js) both build paths
 * from this one value; it is a fixed layout, not a configuration field.
 */
export const DEFAULT_REPORTS_ROOT = '.scratch/master-secretary/reports'

/** The archive root's path segments for join(); derived, so the layout is written once. */
export const REPORT_ROOT = Object.freeze(DEFAULT_REPORTS_ROOT.split('/'))

/** The worker row's role: a dialog session or a delegated child. */
export const MASTER_ROLES = ['main', 'worker']

/**
 * Tools whose call parks the turn on a human decision:
 * `ask_user_question` / `request_user_input` ask the user (the host's own question
 * view keys on the first name), `pick_files` waits for a file selection, and
 * `exit_plan_mode` waits for plan approval. Every other tool keeps the turn
 * running, so it never changes the state.
 */
export const NEEDS_INPUT_TOOLS = new Set(['ask_user_question', 'request_user_input', 'pick_files', 'exit_plan_mode'])

/**
 * Bound for the one-line summary. The host bounds its own context summaries the
 * same way (`CONTEXT_SUMMARY_MAX_CHARS = 120`), so one row costs the master a
 * bounded amount of context.
 */
export const SUMMARY_MAX_CHARS = 120

/** Whether a session header belongs to a delegated child (persisted across resume). */
function roleOf(header) {
  if (header?.origin === 'subagent') return 'worker'
  const depth = header?.delegationDepth
  return typeof depth === 'number' && depth > 0 ? 'worker' : 'main'
}

/**
 * The row for a session with an empty log. `inheritedEventCount` is not read: the
 * fold above a forked prefix still starts from this same row, and only the
 * events themselves say what happened afterwards.
 *
 * @param header - the Session's immutable metadata (only `id`, `origin` and
 * `delegationDepth` are read).
 * @returns one `main`/`worker` row in the Idle state with no summary.
 */
export function initialMasterState(header) {
  return {
    workers: [
      {
        id: typeof header?.id === 'string' ? header.id : String(header?.id ?? ''),
        role: roleOf(header),
        state: 'Idle',
        summary: '',
      },
    ],
  }
}

/** The one worker row this session's log speaks for. */
function rowOf(state) {
  return state.workers[0]
}

/**
 * Replace the row, keeping the state reference when nothing observable changed.
 * A fold that returns the same object produces no downstream projection work.
 *
 * `pending` is the call id of the one blocking tool call the row waits on; pass
 * `null` to clear it. Omitting it keeps whatever the state already tracks.
 */
function withRow(state, patch, pending = state.pending) {
  const row = rowOf(state)
  const next = { ...row, ...patch }
  const nextPending = pending === null ? undefined : pending
  if (
    next.role === row.role &&
    next.state === row.state &&
    next.summary === row.summary &&
    nextPending === state.pending
  ) {
    return state
  }
  const nextState = { workers: [next] }
  if (nextPending !== undefined) nextState.pending = nextPending
  return nextState
}

/** Collapse whitespace and bound one line of text. */
function oneLine(text) {
  const collapsed = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (collapsed.length <= SUMMARY_MAX_CHARS) return collapsed
  return collapsed.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd() + '\u2026'
}

/** The text blocks of a message's content, joined into one string. */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join(' ')
}

/**
 * Whether a user-role event is a human prompt. `UserMessage.source` is what tells
 * a typed prompt (`kind: 'user'`) apart from a synthetic injection — plugin
 * notices, skill content, continuation rounds — so an injected notice never
 * becomes the worker's summary. A message without a source is treated as human,
 * which keeps older logs usable.
 */
function isHuman(message) {
  const kind = message?.source?.kind
  return kind === undefined || kind === null || kind === 'user'
}

/**
 * The state a closed turn leaves behind. `TurnEndReasonMap` is merge-extensible,
 * so an unknown variant is read as "not running, no verdict" rather than as a
 * success or a failure it may not be.
 */
function stateAfterTurn(role, reason) {
  switch (reason?.kind) {
    case 'error':
      return 'Failed'
    case 'aborted':
    case 'interrupted':
      return 'Stopped'
    case 'completed':
      // A delegated session finished its turn: its work is done. A dialog session
      // is simply waiting for the next prompt, which is Idle, not Completed.
      return role === 'worker' ? 'Completed' : 'Idle'
    // 'blocked' is a pre-step rejection that discarded the claimed input
    // (dsh-agent consumed-work): nothing is running and nothing failed. 'max-tokens'
    // closed the turn at the output ceiling and 'forked' is only a fork seed's
    // closer; all three are "not running" without a verdict.
    case 'blocked':
    case 'max-tokens':
    case 'forked':
    default:
      return 'Idle'
  }
}

/**
 * Fold one committed session event into the worker row. Anything the unit does not
 * own returns the same state reference, so the projection registry runs no
 * downstream work for it.
 *
 * @param state - the state covering all prior events.
 * @param event - the next committed event (`{ type, data }`).
 * @returns the next state; the same reference when the event is not ours.
 */
export function reduceMasterState(state, event) {
  const type = event?.type

  if (type === 'turn/start') return withRow(state, { state: 'Working' }, null)

  if (type === 'turn/end') {
    return withRow(state, { state: stateAfterTurn(rowOf(state).role, event.data?.reason) }, null)
  }

  if (type === 'tool/call') {
    const name = event.data?.name
    if (typeof name !== 'string' || !NEEDS_INPUT_TOOLS.has(name)) return state
    // Remember which call parks the turn: the model may issue another tool in the same
    // step, and that tool's result must not clear the wait.
    const callId = event.data?.callId
    return withRow(
      state,
      { state: 'Needs input' },
      typeof callId === 'string' && callId !== '' ? callId : null,
    )
  }

  if (type === 'tool/result') {
    if (rowOf(state).state !== 'Needs input') return state
    const pending = state.pending
    if (pending !== undefined) {
      const answered = event.data?.message?.toolCallId ?? event.data?.callId
      if (answered !== pending) return state
    }
    // The answer — or the failure — the pending question was waiting for.
    return withRow(state, { state: 'Working' }, null)
  }

  if (type === 'session/title') {
    const title = oneLine(event.data?.title)
    return title === '' ? state : withRow(state, { summary: title })
  }

  if (type === 'user/message') {
    if (!isHuman(event.data)) return state
    const patch = { state: 'Working' }
    // The title owns the summary once one exists; the fallback only fills the blank.
    if (rowOf(state).summary === '') {
      const fallback = oneLine(textOf(event.data?.content))
      if (fallback !== '') patch.summary = fallback
    }
    return withRow(state, patch, null)
  }

  return state
}
