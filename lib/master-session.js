/**
 * The persistent master session (ticket 05).
 *
 * The master is one root agent with no working directory: its identity is a fixed
 * session id, so a later process can find it again without asking the registry.
 * The rules here were settled by the ticket-04 spike against the real host tree:
 *
 * - **Discovery is resume-first.** `ctx.agents.roots()` is always empty on a cold
 *   boot (a live registry answers "who is alive now", not "what is on disk"), so it
 *   cannot decide this. Resume the fixed id; create only when resume rejects.
 * - **`ctx.sessions.flush(session)` is the only durability signal available.** It
 *   returns whether at least one durability listener participated and settled —
 *   `true` is not an fsync proof, and `false` means the events never left memory.
 *   Both a rejecting flush and a `false` answer are failures, not "probably fine".
 * - **Disposal does not flush.** Tearing an agent down drops its buffered events
 *   silently, so the unload path must flush first and dispose second.
 *
 * The module takes the two host services as arguments instead of importing them, so
 * every rule above is unit-testable with plain objects, and it imports nothing at
 * module load (the LLM package is a dynamic import kept injectable for the same
 * reason: an installed plugin may run where a unit test cannot resolve it).
 */

/** The one fixed id the master is discovered by. Never generated per process. */
export const MASTER_SESSION_ID = 'orchestrator-master'

/**
 * The durable `source.kind` every master notice carries. It is the plugin's own
 * kind, never the host's `user`: a notice must stay distinguishable from a typed
 * prompt in the log, the inbox fold and every later reader.
 */
export const MASTER_SOURCE_KIND = 'orchestrator-master'

/**
 * The host's bound for a `notice` summary (`CONTEXT_SUMMARY_MAX_CHARS` in
 * @deepseek-ai/dsh-llm). Restated here so this module stays free of a host import,
 * and because the value is part of the durable log's contract.
 */
const NOTICE_SUMMARY_MAX_CHARS = 120

/**
 * Collapse any text to one line and bound it, for a `notice` source's `summary`.
 * The host's `ContextFormed` makes that field mandatory: a notice without it is
 * accepted by `Session.append` but rejected by the log migration, so one is always
 * built here.
 */
function boundNoticeSummary(text) {
  const collapsed = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (collapsed.length <= NOTICE_SUMMARY_MAX_CHARS) return collapsed
  return collapsed.slice(0, NOTICE_SUMMARY_MAX_CHARS - 1).trimEnd() + '\u2026'
}

/**
 * The source of one notice: the plugin's own kind, the `notice` form and the
 * one-line summary that form requires. Shared by every caller that emits one.
 *
 * @param kind - the durable `source.kind` (`orchestrator-master`, `orchestrator-supervision`, ...).
 * @param text - the notice body; its collapsed first line becomes the summary.
 * @param senderSessionId - optional live session that caused the notice.
 */
export function noticeSource(kind, text, senderSessionId) {
  const source = { kind, form: 'notice', summary: boundNoticeSummary(text) }
  if (typeof senderSessionId === 'string' && senderSessionId !== '') source.senderSessionId = senderSessionId
  return source
}

/**
 * One in-flight discovery per session id. The key is the id, never the
 * `ctx.agents` object: cordis hands every access to a Service a fresh Proxy, so
 * object identity would give two concurrent callers two flights and two resumes.
 * Once the flight settles the entry is dropped, and the live registry answers the
 * next call by itself.
 */
const inflight = new Map()

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** The live agent for the master id, if this process already holds one. */
function liveMaster(agents, sessionId) {
  if (typeof agents?.get !== 'function') return undefined
  try {
    const agent = agents.get(sessionId)
    return agent === undefined || agent === null ? undefined : agent
  } catch {
    // An unreadable registry is not a reason to skip discovery: resume may still work.
    return undefined
  }
}

/**
 * Checkpoint the session, or describe why it is not durable. A master that only lives
 * in memory is worse than no master: the caller would keep writing to it and lose
 * every notice at the next restart. Returns the failure instead of throwing so callers
 * can decide the order (the unload path must dispose even when the flush failed).
 */
async function flushMasterSession(agent, sessions, what) {
  const session = agent?.session
  const id = session?.id ?? agent?.id ?? 'unknown'
  if (session === undefined || session === null) {
    return new Error(`orchestrator: master: ${what}: agent ${id} has no session to flush`)
  }
  if (typeof sessions?.flush !== 'function') {
    return new Error(
      `orchestrator: master: ${what}: ctx.sessions.flush is unavailable, so session ${id} is not durable`,
    )
  }
  try {
    const flushed = await sessions.flush(session)
    if (flushed === false) {
      return new Error(
        `orchestrator: master: ${what}: ctx.sessions.flush reported no durability listener (false), ` +
          `so session ${id} is not on disk`,
      )
    }
    return undefined
  } catch (error) {
    return new Error(
      `orchestrator: master: ${what}: flushing session ${id} failed: ${messageOf(error)}`,
      { cause: error },
    )
  }
}

/** One master record: the agent, how it was found, and its disposal capability. */
function recordOf(handle, sessionId, source, options) {
  const agent = handle?.agent ?? handle
  if (agent === undefined || agent === null || typeof agent !== 'object') {
    throw new Error(`orchestrator: master: the host returned no agent for session ${sessionId}`)
  }
  return {
    sessionId,
    agent,
    source,
    loadLlm: options.loadLlm,
    dispose: typeof handle?.dispose === 'function' ? handle.dispose : undefined,
    disposed: false,
  }
}

/**
 * Release a handle whose first flush failed. The caller gets the flush failure;
 * the agent is not left in the registry without an owner (a live record carries no
 * disposer, so nothing would ever checkpoint it again).
 */
async function releaseFailedMaster(record) {
  const dispose = record.dispose
  record.dispose = undefined
  record.disposed = true
  if (typeof dispose !== 'function') return
  try {
    await dispose()
  } catch {
    // The flush failure is the one worth reporting; a dispose failure on top of it
    // leaves nothing further this module can do.
  }
}

async function startMaster(agents, sessions, sessionId, options) {
  if (typeof agents?.resume !== 'function') {
    throw new Error(`orchestrator: master: ctx.agents.resume is unavailable; cannot find session ${sessionId}`)
  }

  const agentOptions = options.agentOptions
  const common = agentOptions === undefined ? {} : { agentOptions }

  let resumeError
  try {
    const resumed = await agents.resume({ resumeSessionId: sessionId, ...common })
    const record = recordOf(resumed, sessionId, 'resume', options)
    const flushed = await flushMasterSession(record.agent, sessions, 'the resumed master session')
    if (flushed !== undefined) {
      await releaseFailedMaster(record)
      throw flushed
    }
    return record
  } catch (error) {
    // Only a failed flush is final: a resume that could not find the session is the
    // expected cold-start path and falls through to creation.
    if (isResumeFailure(error) === false) throw error
    resumeError = error
  }

  if (typeof agents?.create !== 'function') {
    throw new Error(
      `orchestrator: master: cannot resume (${messageOf(resumeError)}) and ctx.agents.create is unavailable; ` +
        `no master session ${sessionId}`,
    )
  }

  let created
  try {
    created = await agents.create({
      sessionId,
      ...common,
      ...(options.setup === undefined ? {} : { setup: options.setup }),
    })
  } catch (error) {
    throw new Error(
      `orchestrator: master: cannot resume (${messageOf(resumeError)}) or create (${messageOf(error)}) ` +
        `session ${sessionId}`,
      { cause: error },
    )
  }
  const record = recordOf(created, sessionId, 'create', options)
  const flushed = await flushMasterSession(record.agent, sessions, 'the new master session')
  if (flushed !== undefined) {
    await releaseFailedMaster(record)
    throw flushed
  }
  return record
}

/**
 * Whether an error thrown by `resume` means "this session is not persisted". The
 * host gives no typed code for that, so any failure that is not ours counts: a
 * failed post-resume flush is the one case that must not be retried as a creation.
 */
function isResumeFailure(error) {
  return !(error instanceof Error && error.message.startsWith('orchestrator: master: '))
}

/**
 * Find the master session, creating it only when no persisted one exists.
 *
 * Idempotent by construction: the live registry answers a second call in the same
 * process, concurrent calls share one flight, and a later process resumes the same
 * fixed id instead of minting a second root.
 *
 * @param agents - `ctx.agents` (needs `get`, `resume` and `create`).
 * @param sessions - `ctx.sessions` (needs `flush`).
 * @param options - `{ sessionId, agentOptions, setup, loadLlm }`; the id defaults to
 *   {@link MASTER_SESSION_ID}.
 * @returns the master record `{ sessionId, agent, source, dispose, disposed }`.
 * @throws when the session can be neither resumed nor created, or cannot be flushed.
 */
export function ensureMaster(agents, sessions, options = {}) {
  // A plain function (not `async`) so the flight is registered synchronously, but
  // every failure must still be a rejection: a plugin that loaded a broken host must
  // log it, never fail its own `apply`.
  try {
    return lookupMaster(agents, sessions, options)
  } catch (error) {
    return Promise.reject(error)
  }
}

function lookupMaster(agents, sessions, options) {
  if (agents === undefined || agents === null || typeof agents !== 'object') {
    throw new Error('orchestrator: master: ctx.agents is unavailable; no master session can exist')
  }
  const sessionId =
    typeof options.sessionId === 'string' && options.sessionId !== '' ? options.sessionId : MASTER_SESSION_ID

  const live = liveMaster(agents, sessionId)
  if (live !== undefined) return Promise.resolve(recordOf({ agent: live }, sessionId, 'live', options))

  const existing = inflight.get(sessionId)
  if (existing !== undefined) return existing

  const flight = startMaster(agents, sessions, sessionId, options)
  inflight.set(sessionId, flight)
  // A settled flight leaves the map: the live registry answers the next call, and a
  // failed discovery is retried instead of being replayed from the cache.
  return flight.finally(() => {
    if (inflight.get(sessionId) === flight) inflight.delete(sessionId)
  })
}

/** A user message the host will accept: `followup` takes `UserMessage`, not text. */
async function buildMessage(loadLlm, payload) {
  let llm
  try {
    llm = await loadLlm()
  } catch (error) {
    throw new Error(
      `orchestrator: master: cannot load @deepseek-ai/dsh-llm; the notice is not delivered: ${messageOf(error)}`,
      { cause: error },
    )
  }
  if (typeof llm?.createUserMessage !== 'function') {
    throw new Error('orchestrator: master: @deepseek-ai/dsh-llm does not export createUserMessage')
  }
  const text = typeof payload === 'string' ? payload : payload?.text
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('orchestrator: master: the notice body is empty')
  }
  const sender = typeof payload === 'object' ? payload?.senderSessionId : undefined
  const source = noticeSource(MASTER_SOURCE_KIND, text, sender)
  return llm.createUserMessage({ content: [{ type: 'text', text }], source })
}

const defaultLoadLlm = () => import('@deepseek-ai/dsh-llm')

/**
 * Queue one notice on the master and checkpoint it.
 *
 * `followup` is used, never `steer`: the master is a root session that may be
 * idle, and a steer would splice into a turn that a person is running. The flush
 * follows the queued message and its failure is an error, because the alternative
 * is a notice the caller believes was delivered while it only lives in memory.
 *
 * @param master - the record from {@link ensureMaster} (a bare agent is accepted too).
 * @param sessions - `ctx.sessions`.
 * @param payload - `{ text, senderSessionId? }`, or the text itself.
 * @param options - `{ loadLlm }` override; production uses `@deepseek-ai/dsh-llm`.
 */
export async function notice(master, sessions, payload, options = {}) {
  const agent = master?.agent ?? master
  if (agent === undefined || agent === null || typeof agent.followup !== 'function') {
    throw new Error('orchestrator: master: the master agent is not live, so no notice can be queued')
  }
  const loadLlm = options.loadLlm ?? master?.loadLlm ?? defaultLoadLlm
  const message = await buildMessage(loadLlm, payload)

  agent.followup(message)

  const failure = await flushMasterSession(
    agent,
    sessions,
    'the notice was queued but the master session did not reach disk',
  )
  if (failure !== undefined) throw failure
}

/**
 * Flush the master session, then dispose the agent — in that order.
 *
 * The spike proved disposal drops buffered events and that a flushed session can no
 * longer be flushed after it left the store, so the ordering is the whole point of
 * this function. A failed flush does not keep the agent alive: it is disposed anyway
 * and the loss is reported to the caller, which logs it.
 *
 * Idempotent: a second call neither flushes nor disposes again.
 *
 * @param master - the record from {@link ensureMaster}.
 * @param sessions - `ctx.sessions`.
 * @returns `{ disposed }`: whether this call owned a disposer to run.
 * @throws the flush failure, after disposal, when the session could not be saved.
 */
export async function disposeMaster(master, sessions) {
  const record = master
  if (record === undefined || record === null || typeof record !== 'object') {
    throw new Error('orchestrator: master: disposeMaster needs the record returned by ensureMaster')
  }
  if (record.disposed === true) return { disposed: false }
  record.disposed = true

  const agent = record.agent
  const failure = await flushMasterSession(agent, sessions, 'the master session could not be flushed before disposal')

  const dispose = record.dispose
  record.dispose = undefined
  let disposeError
  if (typeof dispose === 'function') {
    try {
      await dispose()
    } catch (error) {
      disposeError = error
    }
  }

  if (failure !== undefined) throw failure
  if (disposeError !== undefined) throw disposeError
  return { disposed: typeof dispose === 'function' }
}
