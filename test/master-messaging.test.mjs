import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_INBOUND_POLICY,
  MAX_MESSAGE_BYTES,
  MAX_MESSAGE_QUEUE,
  MESSAGE_SOURCE_KIND,
  checkInbound,
  composeMessage,
  deliverMessage,
} from '../lib/master-messaging.js'
import { MASTER_SESSION_ID, MASTER_SOURCE_KIND } from '../lib/master-session.js'

/**
 * Cross-session messages (ticket 06) are the S3 seam of the spec: three rules over
 * plain data, plus one delivery contract over two host services.
 *
 * - `composeMessage` builds the message envelope and nothing else. The sender's
 *   history, files and reasoning never travel, because a conversation that receives
 *   them snowballs its own context instead of getting a short instruction.
 * - `checkInbound` is the pure accept/hold/refuse decision. Size and queue are
 *   counted per receiving session, since the limit protects that session's inbox.
 * - `deliverMessage` routes the envelope: an idle receiver opens a new turn, a
 *   running one is handed the context at its next step boundary, and the session is
 *   flushed afterwards. A delivery that only lives in memory is reported, not
 *   silently accepted.
 *
 * Every fake here is a plain object: no DSH runtime, no host package, no clock.
 */

/** The receiving agent: only the members the delivery contract touches. */
function fakeAgent({ id = 'worker-1', status = 'idle', inject = true, steer = false } = {}) {
  const calls = []
  const agent = {
    id,
    session: { id },
    calls,
  }
  if (status !== undefined) agent.status = status
  agent.followup = (message) => calls.push(['followup', message])
  if (inject) agent.inject = (message) => calls.push(['inject', message])
  if (steer) agent.steer = (message) => calls.push(['steer', message])
  return agent
}

/** A fake `ctx.agents`: only `get` is used, and every lookup is recorded. */
function fakeAgents(agent) {
  const looked = []
  return {
    looked,
    get(id) {
      looked.push(id)
      return agent !== undefined && id === agent.id ? agent : undefined
    },
  }
}

/** A fake `ctx.sessions`: `flush` is the only member the contract uses. */
function fakeSessions({ flush } = {}) {
  const flushes = []
  return {
    flushes,
    async flush(session) {
      flushes.push(session)
      return typeof flush === 'function' ? flush(session) : true
    },
  }
}

/** A fake message queue: length is per receiving session, hold parks the envelope. */
function fakeQueue({ held = new Map(), add = true } = {}) {
  const adds = []
  const reads = []
  const queue = {
    adds,
    reads,
    lengthOf(sessionId) {
      reads.push(sessionId)
      return held.get(sessionId) ?? 0
    },
  }
  if (add) {
    queue.add = (sessionId, message) => {
      adds.push([sessionId, message])
      held.set(sessionId, (held.get(sessionId) ?? 0) + 1)
    }
  }
  return queue
}

/** The host's `createUserMessage`, recorded so the source is inspectable. */
function fakeLlm() {
  return {
    created: [],
    createUserMessage(input) {
      this.created.push(input)
      return { ...input, created: true }
    },
  }
}

function services({ agent, sessions = fakeSessions(), queue = fakeQueue(), agents } = {}) {
  return {
    agents: agents ?? fakeAgents(agent),
    sessions,
    queue,
  }
}

// ---- composeMessage: the envelope is the message ---------------------------------------

test('composeMessage carries only the five envelope fields, never the sender history', () => {
  const message = composeMessage({
    from: 'worker-1',
    to: MASTER_SESSION_ID,
    text: '任务完成：产物在 /tmp/x，验收命令已过',
    now: 1700000000000,
    // A caller must not be able to smuggle the sender context through: whatever else
    // is handed in is dropped, not copied into the envelope.
    history: [{ role: 'assistant', content: 'the whole conversation' }],
    files: ['/tmp/secret.txt'],
    messages: ['older prompt'],
  })

  assert.deepEqual(Object.keys(message).sort(), ['createdAt', 'from', 'id', 'text', 'to'])
  assert.equal(message.from, 'worker-1')
  assert.equal(message.to, MASTER_SESSION_ID)
  assert.equal(message.text, '任务完成：产物在 /tmp/x，验收命令已过')
  assert.equal(message.createdAt, 1700000000000)
  assert.equal(typeof message.id, 'string')
  assert.ok(message.id !== '')
  assert.equal(JSON.stringify(message).includes('the whole conversation'), false)
  assert.equal(JSON.stringify(message).includes('secret.txt'), false, 'no file path may travel with a message')
})

test('composeMessage is deterministic for the same inputs and distinct across bodies', () => {
  const input = { from: 'a', to: 'b', text: 'ping', now: 42 }
  assert.deepEqual(composeMessage(input), composeMessage({ ...input }))

  const other = composeMessage({ ...input, text: 'pong' })
  assert.notEqual(other.id, composeMessage(input).id, 'two different bodies never share an id')

  const resent = composeMessage({ ...input, now: 43 })
  assert.notEqual(resent.id, composeMessage(input).id, 'a resent message is a second message')
})

test('composeMessage refuses a message without both endpoints or a body', () => {
  assert.throws(() => composeMessage({ to: 'b', text: 'x', now: 1 }), /from/)
  assert.throws(() => composeMessage({ from: 'a', text: 'x', now: 1 }), /to/)
  assert.throws(() => composeMessage({ from: 'a', to: 'b', text: '   ', now: 1 }), /empty/)
  assert.throws(() => composeMessage({ from: 'a', to: 'b', text: 'x', now: Number.NaN }), /now/)
})

// ---- checkInbound: the pure three-way decision -----------------------------------------

test('accept is the default policy and lets a normal message through', () => {
  assert.equal(DEFAULT_INBOUND_POLICY, 'accept')
  assert.deepEqual(checkInbound({ policy: 'accept', queueLength: 0, maxQueue: 4, bytes: 10, maxBytes: 64 }), {
    decision: 'accept',
  })
  assert.deepEqual(checkInbound({ bytes: 10, maxBytes: 64, queueLength: 0, maxQueue: 4 }), { decision: 'accept' })
})

test('a body over the size limit is refused; the limit itself is allowed', () => {
  const atLimit = checkInbound({ policy: 'accept', bytes: 64, maxBytes: 64, queueLength: 0, maxQueue: 4 })
  assert.equal(atLimit.decision, 'accept')

  const over = checkInbound({ policy: 'accept', bytes: 65, maxBytes: 64, queueLength: 0, maxQueue: 4 })
  assert.deepEqual(over, { decision: 'refuse', reason: 'oversize' })
})

test('a receiver whose queue is full refuses another message; one free slot accepts', () => {
  assert.deepEqual(checkInbound({ policy: 'accept', queueLength: 3, maxQueue: 4, bytes: 1, maxBytes: 64 }), {
    decision: 'accept',
  })
  assert.deepEqual(checkInbound({ policy: 'accept', queueLength: 4, maxQueue: 4, bytes: 1, maxBytes: 64 }), {
    decision: 'refuse',
    reason: 'queue-full',
  })
})

test('hold waits and refuse drops', () => {
  assert.deepEqual(checkInbound({ policy: 'hold', queueLength: 0, maxQueue: 4, bytes: 1, maxBytes: 64 }), {
    decision: 'hold',
  })
  assert.deepEqual(checkInbound({ policy: 'refuse', queueLength: 0, maxQueue: 4, bytes: 1, maxBytes: 64 }), {
    decision: 'refuse',
    reason: 'policy-refuse',
  })
})

test('an explicit refuse wins over the capacity checks, so a drop is never reported as an overflow', () => {
  const verdict = checkInbound({ policy: 'refuse', queueLength: 9, maxQueue: 4, bytes: 99, maxBytes: 64 })
  assert.deepEqual(verdict, { decision: 'refuse', reason: 'policy-refuse' })
})

test('an unknown policy refuses instead of silently accepting', () => {
  assert.deepEqual(checkInbound({ policy: 'accept-if-idle', queueLength: 0, maxQueue: 4, bytes: 1, maxBytes: 64 }), {
    decision: 'refuse',
    reason: 'unknown-policy',
  })
})

// ---- deliverMessage: idle opens a turn, working injects, then flush --------------------

test('an idle receiver opens a new turn with followup carrying the plugin message source', async () => {
  const agent = fakeAgent({ status: 'idle' })
  const order = []
  agent.followup = (message) => {
    order.push('followup')
    agent.calls.push(['followup', message])
  }
  const sessions = fakeSessions({
    flush: async (session) => {
      order.push('flush')
      assert.equal(session, agent.session, 'the flush names the receiving session itself')
      return true
    },
  })
  const llm = fakeLlm()

  const result = await deliverMessage(
    services({ agent, sessions }),
    { toSessionId: 'worker-1', text: '从 master 来的消息', senderSessionId: 'orchestrator-master' },
    { policy: 'accept', maxBytes: MAX_MESSAGE_BYTES, maxQueue: MAX_MESSAGE_QUEUE, loadLlm: async () => llm, now: 7 },
  )

  assert.equal(result.decision, 'accept')
  assert.equal(result.via, 'followup')
  assert.equal(agent.calls.length, 1, 'an idle agent gets one waking delivery, not a second inject')
  assert.equal(agent.calls[0][0], 'followup')
  // A message another agent addressed to this one is the host's 'relay' form (dsh-llm
  // ContextFormed): 'message' is not in that union, and relay needs no extra field.
  const source = agent.calls[0][1].source
  assert.deepEqual(source, {
    kind: MESSAGE_SOURCE_KIND,
    form: 'relay',
    senderSessionId: 'orchestrator-master',
  })
  assert.equal('summary' in source, false, 'only a notice carries a summary')
  assert.equal(agent.calls[0][1].content[0].text, '从 master 来的消息')
  assert.deepEqual(order, ['followup', 'flush'], 'the checkpoint follows the delivery')
  assert.equal(llm.created.length, 1)
  assert.equal(MESSAGE_SOURCE_KIND, MASTER_SOURCE_KIND, 'the message shares the plugin own kind')
})

test('a working receiver is handed the message between steps with inject, never a new turn', async () => {
  const agent = fakeAgent({ status: 'running' })
  const result = await deliverMessage(
    services({ agent }),
    { toSessionId: 'worker-1', text: 'x' },
    { policy: 'accept', maxBytes: 64, maxQueue: 4, loadLlm: async () => fakeLlm() },
  )

  assert.equal(result.decision, 'accept')
  assert.equal(result.via, 'inject')
  assert.deepEqual(agent.calls.map(([name]) => name), ['inject'])
})

test('a host that only exposes steer is served with steer, and says so in the result', async () => {
  const agent = fakeAgent({ status: 'running', inject: false, steer: true })
  const result = await deliverMessage(
    services({ agent }),
    { toSessionId: 'worker-1', text: 'x' },
    { policy: 'accept', maxBytes: 64, maxQueue: 4, loadLlm: async () => fakeLlm() },
  )

  assert.equal(result.via, 'steer')
  assert.deepEqual(agent.calls.map(([name]) => name), ['steer'])
})

test('an unreadable status is delivered as a new turn rather than parked forever', async () => {
  const agent = fakeAgent({ status: undefined })
  const result = await deliverMessage(
    services({ agent }),
    { toSessionId: 'worker-1', text: 'x' },
    { policy: 'accept', maxBytes: 64, maxQueue: 4, loadLlm: async () => fakeLlm() },
  )

  assert.equal(result.via, 'followup', 'inject does not wake a driver, so an unknown status must not use it')
})

test('a flush failure after delivery is an error, not a silent loss', async () => {
  const agent = fakeAgent()
  const sessions = fakeSessions({
    flush: async () => {
      throw new Error('disk full')
    },
  })

  await assert.rejects(
    deliverMessage(
      services({ agent, sessions }),
      { toSessionId: 'worker-1', text: 'x' },
      { policy: 'accept', maxBytes: 64, maxQueue: 4, loadLlm: async () => fakeLlm() },
    ),
    (error) => {
      assert.match(error.message, /disk full/)
      assert.match(error.message, /worker-1/)
      return true
    },
  )
  assert.equal(agent.calls.length, 1, 'the message had already been handed to the agent')
})

test('a flush that reports no durability listener is a failure too', async () => {
  const agent = fakeAgent()
  await assert.rejects(
    deliverMessage(
      services({ agent, sessions: fakeSessions({ flush: async () => false }) }),
      { toSessionId: 'worker-1', text: 'x' },
      { policy: 'accept', maxBytes: 64, maxQueue: 4, loadLlm: async () => fakeLlm() },
    ),
    /no durability listener/,
  )
})

// ---- Refusals: nothing touches the receiver --------------------------------------------

test('an oversized body is refused before the receiving agent is touched', async () => {
  const agent = fakeAgent()
  const agents = fakeAgents(agent)

  await assert.rejects(
    deliverMessage(
      services({ agent, agents }),
      { toSessionId: 'worker-1', text: 'x'.repeat(200) },
      { policy: 'accept', maxBytes: 64, maxQueue: 4, loadLlm: async () => fakeLlm() },
    ),
    (error) => {
      assert.match(error.message, /200/)
      assert.match(error.message, /64/)
      assert.match(error.message, /bytes/)
      return true
    },
  )
  assert.deepEqual(agents.looked, [], 'a refused message never reaches the registry')
  assert.equal(agent.calls.length, 0)
})

test('a receiver already holding the maximum refuses another message, blocking nothing else', async () => {
  const agent = fakeAgent()
  const agents = fakeAgents(agent)
  const held = new Map([['worker-1', 4]])
  const queue = fakeQueue({ held })

  await assert.rejects(
    deliverMessage(
      services({ agent, agents, queue }),
      { toSessionId: 'worker-1', text: 'x' },
      { policy: 'accept', maxBytes: 64, maxQueue: 4, loadLlm: async () => fakeLlm() },
    ),
    /queue|排队/,
  )
  assert.deepEqual(agents.looked, [])
  assert.equal(agent.calls.length, 0)
  assert.equal(queue.adds.length, 0)

  // The limit is per receiving session: a full queue elsewhere does not block this one.
  const other = fakeQueue({ held: new Map([['worker-9', 4]]) })
  const delivered = await deliverMessage(
    services({ agent: fakeAgent({ id: 'worker-2' }), queue: other }),
    { toSessionId: 'worker-2', text: 'x' },
    { policy: 'accept', maxBytes: 64, maxQueue: 4, loadLlm: async () => fakeLlm() },
  )
  assert.equal(delivered.decision, 'accept')
  assert.deepEqual(other.reads, ['worker-2'], 'only the receiving session queue is read')
})

test('hold parks the message in the receiver queue and delivers nothing', async () => {
  const agent = fakeAgent()
  const agents = fakeAgents(agent)
  const queue = fakeQueue()

  const result = await deliverMessage(
    services({ agent, agents, queue }),
    { toSessionId: 'worker-1', text: 'x' },
    { policy: 'hold', maxBytes: 64, maxQueue: 4, loadLlm: async () => fakeLlm() },
  )

  assert.equal(result.decision, 'hold')
  assert.equal(queue.adds.length, 1)
  assert.equal(queue.adds[0][0], 'worker-1')
  assert.equal(queue.adds[0][1].text, 'x')
  assert.deepEqual(agents.looked, [], 'a held message waits outside the agent')
  assert.equal(agent.calls.length, 0)
})

test('hold without a queue is an error, never a silent drop', async () => {
  await assert.rejects(
    deliverMessage(
      services({ agent: fakeAgent(), queue: null }),
      { toSessionId: 'worker-1', text: 'x' },
      { policy: 'hold', maxBytes: 64, maxQueue: 4, loadLlm: async () => fakeLlm() },
    ),
    /hold/,
  )
})

test('refuse drops the message without touching the agent or the queue', async () => {
  const agent = fakeAgent()
  const agents = fakeAgents(agent)
  const queue = fakeQueue()

  const result = await deliverMessage(
    services({ agent, agents, queue }),
    { toSessionId: 'worker-1', text: 'x' },
    { policy: 'refuse', maxBytes: 64, maxQueue: 4, loadLlm: async () => fakeLlm() },
  )

  assert.equal(result.decision, 'refuse')
  assert.equal(result.reason, 'policy-refuse')
  assert.deepEqual(agents.looked, [])
  assert.equal(queue.adds.length, 0)
  assert.equal(agent.calls.length, 0)
})

test('a disabled switch refuses before anything is built', async () => {
  const result = await deliverMessage(
    services({ agent: fakeAgent() }),
    { toSessionId: 'worker-1', text: 'x' },
    { enabled: false, policy: 'accept', maxBytes: 64, maxQueue: 4, loadLlm: async () => fakeLlm() },
  )
  assert.deepEqual(result, { decision: 'refuse', reason: 'disabled' })
})

test('deliverMessage names the missing receiver and the missing body', async () => {
  await assert.rejects(
    deliverMessage(services({ agent: undefined }), { toSessionId: 'gone', text: 'x' }, { loadLlm: async () => fakeLlm() }),
    /no live agent/,
  )
  await assert.rejects(deliverMessage(services({ agent: fakeAgent() }), { toSessionId: 'worker-1', text: ' ' }), /empty/)
  await assert.rejects(deliverMessage(services({ agent: fakeAgent() }), { text: 'x' }), /receiving session id/)
})
