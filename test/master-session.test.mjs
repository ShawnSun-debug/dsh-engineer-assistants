import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MASTER_SESSION_ID,
  MASTER_SOURCE_KIND,
  disposeMaster,
  ensureMaster,
  notice,
} from '../lib/master-session.js'

/**
 * The persistent master session (ticket 05) is a contract over two host services,
 * `ctx.agents` (find or create the root session) and `ctx.sessions` (flush it to
 * disk). The spike (ticket 04) settled the rules this file pins down:
 *
 * - discovery is "resume the fixed id first, create only when that fails" —
 *   `agents.roots()` is empty after a cold boot, so it cannot decide this;
 * - `sessions.flush(session)` returns whether a durability listener took part,
 *   which is the only failure signal available before the bytes are on disk;
 * - disposing an agent does not flush it, so the unload path must flush first.
 *
 * These fakes are the two services and nothing else: no DSH runtime, no host
 * package, no clock. A real host is the spike's business, not this suite's.
 */

/** A fake `ctx.agents`: records every call and treats the resolved handle as live. */
function fakeAgents({ resume, create } = {}) {
  const calls = []
  const live = new Map()
  return {
    calls,
    live,
    get: (id) => live.get(id),
    async resume(options) {
      calls.push(['resume', options])
      if (typeof resume !== 'function') throw new Error('no persisted session ' + options.resumeSessionId)
      const handle = await resume(options)
      if (handle?.agent !== undefined) live.set(handle.agent.id, handle.agent)
      return handle
    },
    async create(options) {
      calls.push(['create', options])
      if (typeof create !== 'function') throw new Error('cannot create ' + options.sessionId)
      const handle = await create(options)
      if (handle?.agent !== undefined) live.set(handle.agent.id, handle.agent)
      return handle
    },
  }
}

/** The master agent itself: only the members the contract touches. */
function masterAgent({ id = MASTER_SESSION_ID } = {}) {
  const messages = []
  const agent = {
    id,
    session: { id },
    messages,
    followup: (message) => messages.push(message),
    steer: () => {
      throw new Error('the master notice must be queued with followup, never steered into a running turn')
    },
  }
  return agent
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

/** The host's `createUserMessage`, recorded so the source kind is inspectable. */
function fakeLlm() {
  return {
    created: [],
    createUserMessage(input) {
      this.created.push(input)
      return { ...input, created: true }
    },
  }
}

/** A resolved master record as `ensureMaster` hands it back. */
function masterRecord(agent, overrides = {}) {
  return {
    sessionId: MASTER_SESSION_ID,
    agent,
    source: 'resume',
    disposed: false,
    dispose: async () => {},
    ...overrides,
  }
}

// ---- Discovery: resume first, create only when that fails --------------------------------

test('ensureMaster resumes the persisted master first and never creates over it', async () => {
  const agent = masterAgent()
  const disposed = []
  const agents = fakeAgents({ resume: async () => ({ agent, dispose: async () => disposed.push(1) }) })
  const sessions = fakeSessions()

  const master = await ensureMaster(agents, sessions, {})

  assert.equal(master.agent, agent)
  assert.equal(master.source, 'resume')
  assert.deepEqual(
    agents.calls.map(([name]) => name),
    ['resume'],
    'a live persisted session is never replaced by a second root',
  )
  assert.equal(agents.calls[0][1].resumeSessionId, MASTER_SESSION_ID)
  assert.equal(sessions.flushes.length, 1, 'the recovered session is checkpointed to disk')
})

test('ensureMaster creates exactly once when no persisted master is found', async () => {
  const agent = masterAgent()
  let creates = 0
  const agents = fakeAgents({
    resume: async () => {
      throw new Error('session not found')
    },
    create: async () => {
      creates += 1
      return { agent, dispose: async () => {} }
    },
  })
  const sessions = fakeSessions()

  const first = await ensureMaster(agents, sessions, {})
  assert.equal(first.source, 'create')
  assert.equal(creates, 1)

  // A second call in the same process finds the live master: no resume, no second root.
  const second = await ensureMaster(agents, sessions, {})
  assert.equal(second.agent, agent)
  assert.equal(second.source, 'live')
  assert.equal(creates, 1)
  assert.equal(agents.calls.filter(([name]) => name === 'create').length, 1)
  assert.equal(agents.calls.filter(([name]) => name === 'resume').length, 1)
})

test('concurrent ensure calls share one resume and one create', async () => {
  const agent = masterAgent()
  let resolves = 0
  let creates = 0
  const gate = new Promise((resolve) => setTimeout(resolve, 5))
  const agents = fakeAgents({
    resume: async () => {
      resolves += 1
      await gate
      throw new Error('session not found')
    },
    create: async () => {
      creates += 1
      return { agent, dispose: async () => {} }
    },
  })
  const sessions = fakeSessions()

  const [left, right] = await Promise.all([
    ensureMaster(agents, sessions, {}),
    ensureMaster(agents, sessions, {}),
  ])

  assert.equal(left.agent, agent)
  assert.equal(right.agent, agent)
  assert.equal(resolves, 1, 'two starts must not race two resumes')
  assert.equal(creates, 1, 'two starts must not race two roots')
})

test('two service wrappers of the same registry share one in-flight discovery', async () => {
  // cordis hands every access to a Service a fresh Proxy, so object identity is not a
  // stable flight key: the key has to be the session id.
  const agent = masterAgent()
  let resolves = 0
  const gate = new Promise((resolve) => setTimeout(resolve, 5))
  const registry = fakeAgents({
    resume: async () => {
      resolves += 1
      await gate
      return { agent, dispose: async () => {} }
    },
  })
  const first = new Proxy(registry, {})
  const second = new Proxy(registry, {})

  const [left, right] = await Promise.all([
    ensureMaster(first, fakeSessions(), {}),
    ensureMaster(second, fakeSessions(), {}),
  ])

  assert.equal(left, right, 'both callers get the same record')
  assert.equal(resolves, 1, 'a proxy identity must not start a second resume')
})

test('create is asked for a root session by fixed id, with no cwd and no parent', async () => {
  const agent = masterAgent()
  let seen
  const agents = fakeAgents({
    resume: async () => {
      throw new Error('session not found')
    },
    create: async (options) => {
      seen = options
      return { agent, dispose: async () => {} }
    },
  })

  await ensureMaster(agents, fakeSessions(), { agentOptions: { provider: 'p', model: 'm' } })

  assert.equal(seen.sessionId, MASTER_SESSION_ID)
  // A cwd or a parent would anchor the master to one workspace or make it a child.
  assert.equal('meta' in seen, false)
  assert.equal('parentAgent' in seen, false)
  assert.deepEqual(seen.agentOptions, { provider: 'p', model: 'm' })
})

test('ensureMaster names the missing agent registry instead of crashing on it', async () => {
  await assert.rejects(ensureMaster(undefined, fakeSessions(), {}), /ctx\.agents is unavailable/)
  await assert.rejects(ensureMaster(null, fakeSessions(), {}), /ctx\.agents is unavailable/)
})

test('an unusable live agent is a rejection, never a synchronous throw into apply', async () => {
  const agents = { get: () => 'not an agent', resume: async () => ({}) }
  const pending = ensureMaster(agents, fakeSessions(), {})
  assert.ok(pending instanceof Promise, 'every failure path returns a promise')
  await assert.rejects(pending, /no agent/)
})

test('a master that can neither be resumed nor created fails with both causes', async () => {
  const agents = fakeAgents({
    resume: async () => {
      throw new Error('session not found')
    },
    create: async () => {
      throw new Error('the persistence backend is read-only')
    },
  })
  await assert.rejects(ensureMaster(agents, fakeSessions(), {}), (error) => {
    assert.match(error.message, new RegExp(MASTER_SESSION_ID))
    assert.match(error.message, /session not found/)
    assert.match(error.message, /read-only/)
    return true
  })
})

test('a master whose session cannot be flushed fails loudly instead of running in memory', async () => {
  const agent = masterAgent()
  const agents = fakeAgents({ resume: async () => ({ agent, dispose: async () => {} }) })
  const sessions = fakeSessions({
    flush: async () => {
      throw new Error('disk full')
    },
  })
  await assert.rejects(ensureMaster(agents, sessions, {}), (error) => {
    assert.match(error.message, /disk full/)
    assert.match(error.message, new RegExp(MASTER_SESSION_ID))
    return true
  })
})

test('a master whose first flush fails is released instead of being left unowned', async () => {
  // The handle is dropped once the flush fails; without a dispose here the agent stays
  // in the registry with no owner, so nothing would ever checkpoint it again.
  const agent = masterAgent()
  const order = []
  const agents = fakeAgents({
    resume: async () => {
      throw new Error('session not found')
    },
    create: async () => ({
      agent,
      dispose: async () => {
        order.push('dispose')
      },
    }),
  })
  const sessions = {
    async flush() {
      order.push('flush')
      return false
    },
  }

  await assert.rejects(ensureMaster(agents, sessions, {}), /no durability listener/)
  assert.deepEqual(order, ['flush', 'dispose'], 'the failed master is disposed before the error is reported')
})

// ---- Notice: followup with the plugin source kind, then flush ---------------------------

test('notice queues one followup carrying the plugin source kind, then flushes the session', async () => {
  const order = []
  const agent = masterAgent()
  agent.followup = (message) => {
    order.push('followup')
    agent.messages.push(message)
  }
  const sessions = {
    async flush(session) {
      order.push('flush')
      assert.equal(session, agent.session, 'the flush names the master session itself')
      return true
    },
  }
  const llm = fakeLlm()

  await notice(masterRecord(agent), sessions, { text: 'worker 完成：结果在 /tmp/x' }, { loadLlm: async () => llm })

  assert.equal(agent.messages.length, 1)
  assert.equal(agent.messages[0].content[0].text, 'worker 完成：结果在 /tmp/x')
  // ContextFormed in @deepseek-ai/dsh-llm: form 'notice' requires the one-line summary.
  assert.deepEqual(agent.messages[0].source, {
    kind: MASTER_SOURCE_KIND,
    form: 'notice',
    summary: 'worker 完成：结果在 /tmp/x',
  })
  assert.equal(MASTER_SOURCE_KIND, 'orchestrator-master', 'the kind is the plugin own, not a host one')
  assert.deepEqual(order, ['followup', 'flush'], 'the flush follows the queued message')
  assert.equal(llm.created.length, 1)
})

test('notice names the sending session when the payload carries one', async () => {
  const agent = masterAgent()
  const sources = []
  agent.followup = (message) => sources.push(message.source)
  await notice(masterRecord(agent), fakeSessions(), { text: 'x', senderSessionId: 'worker-1' }, { loadLlm: async () => fakeLlm() })
  assert.deepEqual(sources, [
    { kind: MASTER_SOURCE_KIND, form: 'notice', summary: 'x', senderSessionId: 'worker-1' },
  ])
})

test('a notice summary is one bounded line, the field the host contract requires', async () => {
  const agent = masterAgent()
  const sources = []
  agent.followup = (message) => sources.push(message.source)
  await notice(
    masterRecord(agent),
    fakeSessions(),
    { text: 'line one\n\nline two ' + 'x'.repeat(300) },
    { loadLlm: async () => fakeLlm() },
  )
  const [source] = sources
  assert.equal(source.form, 'notice')
  assert.equal(typeof source.summary, 'string')
  assert.equal(source.summary.includes('\n'), false, 'a summary is one line')
  assert.match(source.summary, /^line one line two x/)
  assert.equal(source.summary.length, 120, 'bounded like the host bounds its own summaries')
  assert.equal(source.summary.endsWith('\u2026'), true)
})

test('a notice whose flush throws reports the loss and never pretends it landed', async () => {
  const agent = masterAgent()
  const sessions = fakeSessions({
    flush: async () => {
      throw new Error('disk full')
    },
  })
  await assert.rejects(
    notice(masterRecord(agent), sessions, { text: 'x' }, { loadLlm: async () => fakeLlm() }),
    (error) => {
      assert.match(error.message, /queued/)
      assert.match(error.message, /disk full/)
      return true
    },
  )
  assert.equal(agent.messages.length, 1, 'the message was already queued on the agent')
})

test('a flush that reports no durability listener is a failure, not a success', async () => {
  // The host returns true only when a durability listener participated; false means
  // the message lives in memory alone, which is exactly the silent loss this forbids.
  const agent = masterAgent()
  const sessions = fakeSessions({ flush: async () => false })
  await assert.rejects(
    notice(masterRecord(agent), sessions, { text: 'x' }, { loadLlm: async () => fakeLlm() }),
    (error) => {
      assert.match(error.message, /no durability listener/)
      return true
    },
  )
})

test('notice refuses an empty body before it touches the agent', async () => {
  const agent = masterAgent()
  let touched = 0
  agent.followup = () => {
    touched += 1
  }
  await assert.rejects(
    notice(masterRecord(agent), fakeSessions(), { text: '   ' }, { loadLlm: async () => fakeLlm() }),
    /empty/,
  )
  assert.equal(touched, 0)
})

// ---- Disposal: flush first, dispose second ----------------------------------------------

test('disposeMaster flushes the session before it disposes the agent', async () => {
  const order = []
  const agent = masterAgent()
  const master = masterRecord(agent, {
    dispose: async () => {
      order.push('dispose')
    },
  })
  const sessions = {
    async flush(session) {
      order.push('flush')
      assert.equal(session, agent.session)
      return true
    },
  }

  const result = await disposeMaster(master, sessions)

  assert.deepEqual(order, ['flush', 'dispose'], 'disposing first would drop the tail of the log')
  assert.equal(result.disposed, true)
})

test('a flush failure during unload still disposes, then reports the lost events', async () => {
  const order = []
  const agent = masterAgent()
  const master = masterRecord(agent, {
    dispose: async () => {
      order.push('dispose')
    },
  })
  const sessions = fakeSessions({
    flush: async () => {
      order.push('flush')
      throw new Error('disk full')
    },
  })

  await assert.rejects(disposeMaster(master, sessions), (error) => {
    assert.match(error.message, /disk full/)
    return true
  })
  assert.deepEqual(order, ['flush', 'dispose'], 'a failed flush must not leave the agent alive')
})

test('disposeMaster is idempotent: a second call neither flushes nor disposes again', async () => {
  let flushes = 0
  let disposes = 0
  const master = masterRecord(masterAgent(), {
    dispose: async () => {
      disposes += 1
    },
  })
  const sessions = {
    async flush() {
      flushes += 1
      return true
    },
  }

  await disposeMaster(master, sessions)
  await disposeMaster(master, sessions)

  assert.equal(flushes, 1)
  assert.equal(disposes, 1)
})
