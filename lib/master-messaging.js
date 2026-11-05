/**
 * Cross-session messages (ticket 06, phase C of the master spec).
 *
 * Three rules, each small enough to test with plain data:
 *
 * - **The envelope is the message.** {@link composeMessage} returns exactly
 *   `{ id, from, to, text, createdAt }`. No conversation history, no files, no
 *   reasoning: a receiver that gets the sender's context starts accumulating it and
 *   every later hop snowballs. What a message says, plus who sent it, is all.
 * - **Admission is decided per receiving session.** {@link checkInbound} is the pure
 *   accept/hold/refuse rule over one body's byte size and the receiver's own queue
 *   depth. Limits are inclusive, and an unreadable policy refuses rather than
 *   defaulting to a permissive one.
 * - **Delivery follows the receiver's state.** {@link deliverMessage} opens a new
 *   turn on an idle agent (`followup`), hands context to a running one at its next
 *   step boundary (`inject`), and checkpoints the session afterwards. A failed
 *   checkpoint is an error: the caller has to know the message only lives in memory.
 *
 * The module imports nothing at load time except the fixed source kind from
 * `master-session.js` (no host package: the LLM module is a dynamic import the
 * caller can replace in tests).
 *
 * @module
 */

import { MASTER_SESSION_ID, MASTER_SOURCE_KIND } from './master-session.js'

/**
 * The durable `source.kind` of a cross-session message: the plugin's own kind, the
 * same string the master notice uses. The `form` keeps the two apart — `'relay'` here
 * (the host's ContextForm for "a message another agent addressed to this one") and
 * `'notice'` there — so a reader of the log can tell a peer message from a notice
 * without parsing the text. Supervision notices are a separate kind entirely.
 */
export const MESSAGE_SOURCE_KIND = MASTER_SOURCE_KIND

/** One message body's ceiling, in UTF-8 bytes. A constant until a config key is asked for. */
export const MAX_MESSAGE_BYTES = 8 * 1024

/** How many undelivered messages one receiving session may hold. Per receiver, not global. */
export const MAX_MESSAGE_QUEUE = 16

/** The policy used when a caller names none. */
export const DEFAULT_INBOUND_POLICY = 'accept'

/** The three admission policies. Anything else is refused, not guessed. */
export const INBOUND_POLICIES = ['accept', 'hold', 'refuse']

const encoder = new TextEncoder()

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** A finite non-negative number, or the fallback. Limits are numbers, never strings. */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/** The UTF-8 size of one body, which is what a byte limit counts. */
function byteLength(text) {
  return encoder.encode(text).length
}

/**
 * A short stable fingerprint of a body's identity. The message id is derived from
 * the five inputs instead of a clock or a counter, so composing is a pure function:
 * identical inputs name an identical message, and any different input names a
 * different one. Callers that want two messages in the same millisecond to be
 * distinct resend with a distinct `now`.
 */
function fingerprint(input) {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * Build the message envelope.
 *
 * Pure when `now` is supplied, and — more importantly — closed: only the five
 * fields below are returned, so a caller cannot smuggle the sender's history, files
 * or reasoning into a receiver by adding them to the input.
 *
 * @param input - `{ from, to, text, now }`; `now` defaults to the wall clock.
 * @returns `{ id, from, to, text, createdAt }`.
 * @throws when either endpoint is missing, the body is blank, or `now` is not finite.
 */
export function composeMessage(input = {}) {
  const from = input?.from
  const to = input?.to
  const text = input?.text
  if (typeof from !== 'string' || from === '') {
    throw new Error('orchestrator: master: a message needs a "from" session id')
  }
  if (typeof to !== 'string' || to === '') {
    throw new Error('orchestrator: master: a message needs a "to" session id')
  }
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('orchestrator: master: the message body is empty')
  }
  const createdAt = input?.now === undefined ? Date.now() : input.now
  if (typeof createdAt !== 'number' || Number.isFinite(createdAt) === false) {
    throw new Error('orchestrator: master: a message needs a finite "now"')
  }
  const id = 'msg-' + fingerprint([from, to, createdAt, text].join('\u0000'))
  return { id, from, to, text, createdAt }
}

/**
 * Decide whether one inbound body may be admitted to a receiving session.
 *
 * The order is deliberate. The policy is read first: an explicit `refuse` is a
 * decision about the peer, so it is reported as such even when the body would also
 * have overflowed — an operator reading the log should not see "queue-full" for a
 * peer that is simply not allowed to send. An unknown policy refuses too: a typo
 * must not quietly turn into `accept`.
 *
 * Size and queue limits are inclusive and counted per receiver: the queue length is
 * the caller's count of undelivered messages held for that one session.
 *
 * @param input - `{ policy, queueLength, maxQueue, bytes, maxBytes }`.
 * @returns `{ decision: 'accept' | 'hold' }` or `{ decision: 'refuse', reason }`.
 *   Reasons: `oversize`, `queue-full`, `policy-refuse`, `unknown-policy`.
 */
export function checkInbound(input = {}) {
  const policy = input?.policy === undefined || input?.policy === null ? DEFAULT_INBOUND_POLICY : input.policy
  if (INBOUND_POLICIES.includes(policy) === false) return { decision: 'refuse', reason: 'unknown-policy' }
  if (policy === 'refuse') return { decision: 'refuse', reason: 'policy-refuse' }

  const bytes = numberOr(input?.bytes, 0)
  const maxBytes = numberOr(input?.maxBytes, MAX_MESSAGE_BYTES)
  if (bytes > maxBytes) return { decision: 'refuse', reason: 'oversize' }

  const queueLength = numberOr(input?.queueLength, 0)
  const maxQueue = numberOr(input?.maxQueue, MAX_MESSAGE_QUEUE)
  if (queueLength >= maxQueue) return { decision: 'refuse', reason: 'queue-full' }

  if (policy === 'hold') return { decision: 'hold' }
  return { decision: 'accept' }
}

/** How many undelivered messages the receiving session holds. No queue means none. */
function heldFor(queue, sessionId) {
  if (queue === undefined || queue === null || typeof queue.lengthOf !== 'function') return 0
  let held
  try {
    held = queue.lengthOf(sessionId)
  } catch (error) {
    // Encoding the limit on a guess would silently drop the bound, so say so instead.
    throw new Error(
      `orchestrator: master: cannot read the queue of session ${sessionId}, so the inbound limit cannot be enforced: ${messageOf(error)}`,
      { cause: error },
    )
  }
  return numberOr(held, 0)
}

/** The live receiving agent, or a named failure. */
function agentFor(agents, sessionId) {
  if (agents === undefined || agents === null || typeof agents.get !== 'function') {
    throw new Error('orchestrator: master: ctx.agents is unavailable, so no message can be delivered')
  }
  let agent
  try {
    agent = agents.get(sessionId)
  } catch (error) {
    throw new Error(`orchestrator: master: the agent registry rejected the lookup for session ${sessionId}: ${messageOf(error)}`, {
      cause: error,
    })
  }
  if (agent === undefined || agent === null) {
    throw new Error(`orchestrator: master: no live agent for session ${sessionId}`)
  }
  return agent
}

/**
 * Hand one message to a running agent at its next step boundary.
 *
 * `inject` is the host member that queues model-facing context without waking the
 * driver, which is exactly "between steps". Older hosts expose steering only; a steer
 * is also consumed at the next step boundary, so it is the fallback — the difference
 * (it can wake an idle driver) does not apply to a receiver already running.
 */
function deliverToWorking(agent, message, sessionId) {
  if (typeof agent.inject === 'function') {
    agent.inject(message)
    return 'inject'
  }
  if (typeof agent.steer === 'function') {
    agent.steer(message)
    return 'steer'
  }
  throw new Error(`orchestrator: master: session ${sessionId} is running but exposes neither inject nor steer`)
}

/** Open a new turn on an idle agent. `followup` makes the message that turn's own input. */
function deliverToIdle(agent, message, sessionId) {
  if (typeof agent.followup !== 'function') {
    throw new Error(`orchestrator: master: session ${sessionId} cannot accept a message (no followup)`)
  }
  agent.followup(message)
  return 'followup'
}

/**
 * Checkpoint the receiving session, or say why the message is not durable. Both a
 * rejecting flush and a `false` answer are failures: `false` means no durability
 * listener took part, i.e. the events never left memory.
 */
async function flushAfter(sessions, agent, sessionId) {
  const session = agent?.session
  if (session === undefined || session === null) {
    throw new Error(`orchestrator: master: the message reached session ${sessionId} but it has no session to flush`)
  }
  if (sessions === undefined || sessions === null || typeof sessions.flush !== 'function') {
    throw new Error(
      `orchestrator: master: the message reached session ${sessionId} but ctx.sessions.flush is unavailable, so it is not durable`,
    )
  }
  let flushed
  try {
    flushed = await sessions.flush(session)
  } catch (error) {
    throw new Error(
      `orchestrator: master: the message reached session ${sessionId} but flushing it failed: ${messageOf(error)}`,
      { cause: error },
    )
  }
  if (flushed === false) {
    throw new Error(
      `orchestrator: master: the message reached session ${sessionId} but ctx.sessions.flush reported no durability listener (false)`,
    )
  }
}

const defaultLoadLlm = () => import('@deepseek-ai/dsh-llm')

async function userMessageFor(text, senderSessionId, loadLlm) {
  let llm
  try {
    llm = await loadLlm()
  } catch (error) {
    throw new Error(`orchestrator: master: cannot load @deepseek-ai/dsh-llm; the message is not delivered: ${messageOf(error)}`, {
      cause: error,
    })
  }
  if (typeof llm?.createUserMessage !== 'function') {
    throw new Error('orchestrator: master: @deepseek-ai/dsh-llm does not export createUserMessage')
  }
  // The host's ContextForm (dsh-llm message.d.ts) has no 'message' form; a message
  // another agent addressed to this one is 'relay', which needs no extra field.
  const source = { kind: MESSAGE_SOURCE_KIND, form: 'relay' }
  if (senderSessionId !== undefined) source.senderSessionId = senderSessionId
  return llm.createUserMessage({ content: [{ type: 'text', text }], source })
}

/**
 * Deliver one cross-session message to a live session.
 *
 * The receiving agent is resolved only after admission: a refused or held message
 * never touches the registry, so a message nobody may receive cannot wake anybody.
 *
 * @param services - `{ agents, sessions, queue }`: the host services plus the
 *   caller-owned queue of undelivered messages (`lengthOf(sessionId)`, and `add`
 *   when the policy is `hold`).
 * @param request - `{ toSessionId, text, senderSessionId? }`; the sender defaults to
 *   the master session id so the envelope always names a real endpoint.
 * @param options - `{ policy, maxBytes, maxQueue, enabled?, now?, loadLlm? }`.
 *   `enabled: false` (the plugin switch) refuses before anything is built.
 * @returns `{ decision, reason?, message?, via? }`; `via` is `followup`,
 *   `inject` or `steer` for an accepted message.
 * @throws when the body is empty, the body or the queue overflows its limit, the
 *   receiver does not exist, a `hold` has no queue to wait in, or the checkpoint fails.
 */
export async function deliverMessage(services, request, options = {}) {
  const toSessionId = request?.toSessionId
  const text = request?.text
  if (typeof toSessionId !== 'string' || toSessionId === '') {
    throw new Error('orchestrator: master: deliverMessage needs the receiving session id')
  }
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('orchestrator: master: the message body is empty')
  }
  if (options.enabled === false) return { decision: 'refuse', reason: 'disabled' }

  const senderSessionId =
    typeof request.senderSessionId === 'string' && request.senderSessionId !== '' ? request.senderSessionId : undefined
  const message = composeMessage({
    from: senderSessionId ?? MASTER_SESSION_ID,
    to: toSessionId,
    text,
    now: options.now,
  })

  const queue = services?.queue
  const bytes = byteLength(text)
  const queueLength = heldFor(queue, toSessionId)
  const maxBytes = numberOr(options.maxBytes, MAX_MESSAGE_BYTES)
  const maxQueue = numberOr(options.maxQueue, MAX_MESSAGE_QUEUE)

  const verdict = checkInbound({ policy: options.policy, queueLength, maxQueue, bytes, maxBytes })

  if (verdict.decision === 'refuse') {
    // Capacity is a caller error worth throwing; a policy refusal is an ordinary no.
    if (verdict.reason === 'oversize') {
      throw new Error(
        `orchestrator: master: the message for session ${toSessionId} is ${bytes} bytes, over the ${maxBytes}-byte limit; nothing was delivered`,
      )
    }
    if (verdict.reason === 'queue-full') {
      throw new Error(
        `orchestrator: master: the inbound queue of session ${toSessionId} already holds ${queueLength} undelivered messages (limit ${maxQueue}); nothing was delivered`,
      )
    }
    return { decision: 'refuse', reason: verdict.reason, message }
  }

  if (verdict.decision === 'hold') {
    if (typeof queue?.add !== 'function') {
      throw new Error(
        `orchestrator: master: the inbound policy is hold but no queue can park a message for session ${toSessionId}`,
      )
    }
    queue.add(toSessionId, message)
    return { decision: 'hold', message }
  }

  const agent = agentFor(services?.agents, toSessionId)
  const userMessage = await userMessageFor(text, senderSessionId, options.loadLlm ?? defaultLoadLlm)
  // Only 'running' is delivered between steps. An idle agent — and one whose status
  // cannot be read — gets a new turn, because inject does not wake a driver and a
  // parked instruction could wait forever.
  const via =
    agent.status === 'running'
      ? deliverToWorking(agent, userMessage, toSessionId)
      : deliverToIdle(agent, userMessage, toSessionId)

  await flushAfter(services?.sessions, agent, toSessionId)
  return { decision: 'accept', message, via }
}
