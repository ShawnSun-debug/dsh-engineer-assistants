import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AUTHORITY_TOOLS,
  DISPATCH_COMMAND,
  VIOLATION_LIMIT,
  WRITE_OR_TERMINAL_TOOLS,
  assertCommandAllowed,
  authorityFor,
  buildPolicy,
  createAuthority,
  createViolationRing,
  listViolations,
  recordViolation,
} from '../lib/secretary-authority.js'

/** The policy the master really runs with: the live catalog plus the registered sessions. */
function policyOf({ catalog = ['read', 'grep', 'glob', 'list', 'dispatch', 'send_message', 'interrupt_agent', 'edit', 'write', 'pwsh'], sessions = ['orch-1'] } = {}) {
  return buildPolicy({ toolCatalog: catalog, registeredSessionIds: sessions })
}

/**
 * One agent with the two registries the layer uses, recording what it was handed. The
 * session log is recorded too, because the host locks are written as events.
 */
function fakeAgent({ id = 'master-1' } = {}) {
  const restricted = []
  const lifted = []
  const guards = []
  const events = []
  let guardRemoved = 0
  const agent = {
    id,
    session: {
      id,
      append: (type, data) => events.push({ type, data }),
    },
    ctx: {
      tools: {
        restrict({ deny }) {
          restricted.push(deny[0])
          return () => lifted.push(deny[0])
        },
        guard(fn) {
          guards.push(fn)
          return () => {
            guardRemoved += 1
          }
        },
      },
    },
  }
  return {
    agent,
    restricted,
    lifted,
    guards,
    events,
    guardRemoved: () => guardRemoved,
  }
}

test('authorityFor confers dispatch-command on the configured master session only', () => {
  assert.equal(authorityFor({ id: 'master-1' }, { masterSessionId: 'master-1' }), DISPATCH_COMMAND)
  assert.equal(authorityFor({ id: 'master-1' }, { masterSessionId: 'other' }), null)
  assert.equal(authorityFor({ id: 'other' }, { masterSessionId: 'master-1' }), null)
  // An empty id designates nobody: the first root agent must never become a commander
  // just because the setting was never filled in.
  assert.equal(authorityFor({ id: 'master-1' }, { masterSessionId: '' }), null)
  assert.equal(authorityFor({ id: 'master-1' }, { masterSessionId: '   ' }), null)
  assert.equal(authorityFor({ id: 'master-1' }, {}), null)
  assert.equal(authorityFor({ id: 'master-1' }, { masterSessionId: 7 }), null)
  assert.equal(authorityFor(undefined, { masterSessionId: 'master-1' }), null)
  // The durable session is what the agent speaks for when the two ids ever disagree.
  assert.equal(authorityFor({ id: 'x', session: { id: 'master-1' } }, { masterSessionId: 'master-1' }), DISPATCH_COMMAND)
  assert.equal(authorityFor({ id: 'master-1', session: { id: 'x' } }, { masterSessionId: 'master-1' }), null)
})

test('buildPolicy allows the reads and the two session tools, and denies every writer', () => {
  const policy = buildPolicy({
    toolCatalog: ['read', 'grep', 'glob', 'list', 'dispatch', 'send_message', 'interrupt_agent', 'edit', 'write', 'apply_patch', 'pwsh', 'bash', 'shell', 'custom_tool'],
    registeredSessionIds: ['orch-1', 'orch-2', 'orch-1', '', 7],
  })
  for (const name of ['read', 'grep', 'glob', 'list', 'dispatch', 'send_message', 'interrupt_agent']) {
    assert.ok(policy.allow.includes(name), name)
    assert.equal(policy.deny.includes(name), false, 'an allowed tool must not be denied: ' + name)
  }
  for (const name of ['edit', 'write', 'apply_patch', 'pwsh', 'bash', 'shell']) {
    assert.ok(policy.deny.includes(name), name)
  }
  assert.ok(policy.deny.includes('custom_tool'), 'a catalog tool outside the allow list is denied')
  assert.deepEqual(policy.scope.sessions, ['orch-1', 'orch-2'], 'registered ids are strings, unique, in order')
  assert.deepEqual(policy.allow, [...AUTHORITY_TOOLS], 'the allow list is the constant, never the catalog')
})

test('buildPolicy denies the fixed write and terminal names even without a catalog', () => {
  // A host whose catalog could not be read at install time must still not advertise a writer.
  const policy = buildPolicy({ toolCatalog: [], registeredSessionIds: [] })
  for (const name of WRITE_OR_TERMINAL_TOOLS) {
    assert.ok(policy.deny.includes(name), name)
  }
  assert.deepEqual(policy.scope.sessions, [])
  assert.equal(buildPolicy({}).allow.length, AUTHORITY_TOOLS.length)
})

test('assertCommandAllowed lets a read through and refuses a writer by name', () => {
  const policy = policyOf()
  assert.deepEqual(assertCommandAllowed({ toolName: 'read', args: { file_path: 'x' }, policy }), { ok: true })
  assert.deepEqual(assertCommandAllowed({ toolName: 'grep', args: {}, policy }), { ok: true })
  const refused = assertCommandAllowed({ toolName: 'edit', args: {}, policy })
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /"edit" is not available to the dispatch-command agent/)
  // A name the catalog never listed is refused too: the allow list is the contract.
  assert.equal(assertCommandAllowed({ toolName: 'never_heard_of_it', args: {}, policy }).ok, false)
  assert.equal(assertCommandAllowed({ toolName: '', policy }).ok, false)
})

test('assertCommandAllowed refuses send_message and interrupt_agent to an unregistered session', () => {
  const policy = policyOf({ sessions: ['orch-1'] })
  const refused = assertCommandAllowed({ toolName: 'send_message', args: { agent_id: 'orch-9', message: 'hi' }, policy })
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /orch-9/)
  assert.match(refused.reason, /may only contact an orchestrator session registered/)
  const registered = assertCommandAllowed({ toolName: 'send_message', args: { agent_id: 'orch-1', message: 'hi' }, policy })
  assert.deepEqual(registered, { ok: true })
  const interruptRefused = assertCommandAllowed({ toolName: 'interrupt_agent', args: { agent_id: 'orch-9' }, policy })
  assert.equal(interruptRefused.ok, false)
  assert.match(interruptRefused.reason, /"interrupt_agent" to session "orch-9"/)
  assert.deepEqual(assertCommandAllowed({ toolName: 'interrupt_agent', args: { agent_id: 'orch-1' }, policy }), { ok: true })
  // A targeted tool with no target is not "probably fine".
  const missing = assertCommandAllowed({ toolName: 'send_message', args: { message: 'hi' }, policy })
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /needs the session id/)
})

test('assertCommandAllowed keeps the run_code transport and refuses its two escapes', () => {
  const policy = policyOf()
  // run_code is the PTC transport: refusing it by name would take dispatch with it, so the
  // program is checked instead and a nested tools.write(...) is refused by name later.
  assert.deepEqual(assertCommandAllowed({ toolName: 'run_code', args: { code: 'await tools.read({})' }, policy }), { ok: true })
  const escalated = assertCommandAllowed({ toolName: 'run_code', args: { code: 'await tools.read({})', sandbox_permissions: 'workspace-write' }, policy })
  assert.equal(escalated.ok, false)
  assert.match(escalated.reason, /sandbox escalation/)
  const runtime = assertCommandAllowed({ toolName: 'run_code', args: { code: 'const fs = process' }, policy })
  assert.equal(runtime.ok, false)
  assert.match(runtime.reason, /Node.js or host runtime/)
})

test('createAuthority installs the mask and guard, then reinstalls the default gate on release', () => {
  const { agent, restricted, lifted, guards, guardRemoved } = fakeAgent()
  const installs = []
  let defaultGateLifted = 0
  const authority = createAuthority({
    installFor: (target) => {
      installs.push(target.id)
      return {}
    },
    disposeFor: () => {
      defaultGateLifted += 1
    },
    violations: createViolationRing(),
    now: () => 1000,
    policy: () => policyOf(),
  })

  const release = authority.install(agent)
  assert.equal(typeof release, 'function')
  // The mask covers exactly what the policy denies, and the default gate is lifted only
  // afterwards: strict first, loose second, with no bare window in between.
  assert.ok(restricted.includes('edit'))
  assert.ok(restricted.includes('write'))
  assert.equal(restricted.includes('read'), false, 'a read must not be hidden')
  assert.equal(defaultGateLifted, 1)
  assert.equal(guards.length, 1)
  assert.equal(authority.claimOf(agent).sessionId, 'master-1')
  assert.deepEqual(authority.policyOf(agent).scope.sessions, ['orch-1'])

  // The guard refuses by name, records the refusal, and keeps ordinary reads open.
  assert.equal(guards[0]({ name: 'read', arguments: {} }), undefined)
  const refusal = guards[0]({ name: 'edit', arguments: {} })
  assert.match(refusal, /"edit" is not available to the dispatch-command agent/)
  const recorded = authority.violations()
  assert.equal(recorded.length, 1)
  assert.deepEqual(Object.keys(recorded[0]).sort(), ['action', 'agentId', 'at', 'reason'])
  assert.equal(recorded[0].at, 1000)
  assert.equal(recorded[0].agentId, 'master-1')
  assert.equal(recorded[0].action, 'edit')

  // Releasing reinstalls the default gate before lifting this layer's mask.
  release()
  assert.deepEqual(installs, ['master-1'], 'the default gate is reinstalled on release')
  assert.equal(authority.claimOf(agent), undefined)
  assert.deepEqual(lifted.sort(), [...new Set(restricted)].sort())
  assert.equal(guardRemoved(), 1)
  // Idempotent: a second release must not reinstall a second gate.
  release()
  assert.deepEqual(installs, ['master-1'])
})

test('createAuthority leaves the mask on an agent that is going away', () => {
  const { agent, lifted } = fakeAgent()
  const installs = []
  const authority = createAuthority({
    installFor: (target) => installs.push(target.id),
    policy: () => policyOf(),
  })
  const release = authority.install(agent)
  release({ installDefault: false })
  assert.deepEqual(installs, [], 'a disposed agent must not get a fresh default gate')
  assert.ok(lifted.length > 0, 'its own mask is still lifted')
})

test('createAuthority keeps the mask when the default gate cannot be reinstalled', () => {
  const { agent, lifted } = fakeAgent()
  const warnings = []
  const authority = createAuthority({
    installFor: () => {
      throw new Error('the agent is gone')
    },
    policy: () => policyOf(),
    logger: (message) => warnings.push(message),
  })
  const release = authority.install(agent)
  release()
  assert.deepEqual(lifted, [], 'no mask is lifted while there is no gate to replace it')
  assert.match(warnings.join('\n'), /keeping the dispatch-command mask/)
})

test('createAuthority never throws when the sandbox or the approval seam is missing or broken', () => {
  const { agent, events } = fakeAgent()
  const warnings = []
  const authority = createAuthority({
    installFor: () => {},
    // Both seams absent: the claim still stands, only the host lock is reported.
    policy: () => policyOf(),
    logger: (message) => warnings.push(message),
  })
  const release = authority.install(agent)
  assert.equal(typeof release, 'function')
  release()
  assert.equal(events.length, 0)

  // A seam that throws on install is reported, not propagated.
  const second = fakeAgent()
  const locks = []
  const secondAuthority = createAuthority({
    installFor: () => {},
    sandbox: {
      lock() {
        throw new Error('sandbox policy is broken')
      },
    },
    approval: {
      lock: () => () => locks.push('approval-restored'),
    },
    policy: () => policyOf(),
    logger: (message) => warnings.push(message),
  })
  const releaseSecond = secondAuthority.install(second.agent)
  assert.equal(typeof releaseSecond, 'function')
  releaseSecond()
  assert.match(warnings.join('\n'), /the sandbox lock failed/)
  assert.deepEqual(locks, ['approval-restored'], 'the working seam is still restored')
})

test('createAuthority restores the host locks it did apply, even when install succeeds partially', () => {
  const { agent, events } = fakeAgent()
  const undone = []
  const authority = createAuthority({
    installFor: () => {},
    sandbox: {
      lock: (target) => {
        target.session.append('sandbox/mode', { mode: 'read-only' })
        return () => undone.push('sandbox')
      },
    },
    approval: {},
    policy: () => policyOf(),
  })
  const release = authority.install(agent)
  assert.deepEqual(events, [{ type: 'sandbox/mode', data: { mode: 'read-only' } }])
  release()
  assert.deepEqual(undone, ['sandbox'])
})

test('createAuthority refuses to claim an agent without a tool registry', () => {
  const warnings = []
  const authority = createAuthority({ installFor: () => {}, logger: (message) => warnings.push(message) })
  assert.equal(authority.install({ id: 'master-1' }), undefined)
  assert.equal(authority.install(null), undefined)
  assert.equal(authority.install({ id: '' }), undefined)
  assert.match(warnings.join('\n'), /has no tool registry/)
})

test('recordViolation keeps the newest 200 entries and drops the oldest', () => {
  const ring = createViolationRing()
  assert.equal(ring.limit, VIOLATION_LIMIT)
  assert.equal(VIOLATION_LIMIT, 200)
  for (let index = 0; index < VIOLATION_LIMIT + 5; index += 1) {
    recordViolation(ring, { at: index, agentId: 'master-1', action: 'edit', reason: 'v-' + index })
  }
  const rows = listViolations(ring)
  assert.equal(rows.length, VIOLATION_LIMIT)
  assert.equal(rows[0].reason, 'v-' + (VIOLATION_LIMIT + 4), 'the newest entry is first')
  assert.equal(rows[rows.length - 1].reason, 'v-5', 'the oldest five were dropped')
  assert.equal(rows.some((row) => row.reason === 'v-0'), false)
})

test('the violation store tolerates a bare array, a custom limit and a missing ring', () => {
  const bare = []
  recordViolation(bare, { agentId: 'm', action: 'write', reason: 'no' })
  assert.equal(listViolations(bare).length, 1)
  const small = createViolationRing({ limit: 2 })
  for (const reason of ['a', 'b', 'c']) recordViolation(small, { at: 1, agentId: 'm', action: 'edit', reason })
  assert.deepEqual(listViolations(small).map((row) => row.reason), ['c', 'b'])
  // A missing store is a no-op: recording is a diagnostic, never load-bearing.
  assert.doesNotThrow(() => recordViolation(undefined, { reason: 'x' }))
  assert.deepEqual(listViolations(undefined), [])
  assert.deepEqual(listViolations(createViolationRing()), [])
})

test('the authority exposes the same ring it was handed, so the view reads one store', () => {
  const ring = createViolationRing()
  const { agent } = fakeAgent()
  const authority = createAuthority({ installFor: () => {}, violations: ring, policy: () => policyOf() })
  authority.install(agent)
  assert.equal(authority.ring(), ring)
  recordViolation(ring, { at: 5, agentId: 'master-1', action: 'pwsh', reason: 'refused' })
  assert.equal(authority.violations().length, 1)
  assert.equal(authority.violations()[0].action, 'pwsh')
  authority.dispose()
  assert.equal(authority.claimOf(agent), undefined)
})
