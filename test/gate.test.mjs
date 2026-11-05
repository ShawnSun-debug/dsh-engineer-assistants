import assert from 'node:assert/strict'
import test from 'node:test'
import { ORCHESTRATE_TOOL } from '../lib/api.js'
import {
  DELEGATE_TOOL,
  denyGuard,
  effectiveDenied,
  installGate,
  isDelegatedChild,
  mergeDenied,
  restrictEach,
} from '../lib/gate.js'

const HIDDEN = ['edit', 'write', 'str_replace_editor', 'subagent', 'subagent_fork', 'workflow', 'ralph', 'ops_bash', 'pwsh']

/** A stand-in agent: only `globals` may be restricted, as DSH allows only global tools. */
function fakeAgent({ globals = ['edit', 'write', 'str_replace_editor'], guardError } = {}) {
  const restricted = []
  let recorded
  return {
    restricted,
    getGuard: () => recorded,
    agent: {
      id: 'main',
      ctx: {
        tools: {
          restrict({ deny }) {
            const [tool] = deny
            if (!globals.includes(tool)) throw new Error(`tools.restrict() names unknown global tool "${tool}"`)
            restricted.push(tool)
            return () => {
              const at = restricted.indexOf(tool)
              if (at !== -1) restricted.splice(at, 1)
            }
          },
          guard(fn) {
            if (guardError !== undefined) throw new Error(guardError)
            recorded = fn
          },
        },
      },
    },
  }
}

test('denyGuard denies a listed name and lets anything else through', () => {
  const guard = denyGuard(HIDDEN)
  assert.equal(
    guard({ name: 'edit' }),
    'orchestrator: "edit" is not available to the main agent. The main agent only plans; hand every action to a worker with the dispatch tool.',
  )
  assert.equal(guard({ name: 'write' }).startsWith('orchestrator: "write"'), true)
  assert.equal(guard({ name: 'todo_write' }), undefined)
  assert.equal(guard({ name: 'read' }), undefined)
})

test('every name is deniable, the delegation tools and the main agent own ones included', () => {
  const listed = [...HIDDEN, DELEGATE_TOOL, ORCHESTRATE_TOOL, 'send_message', 'todo_write', 'compress']
  const guard = denyGuard(listed)
  for (const name of [DELEGATE_TOOL, ORCHESTRATE_TOOL, 'send_message', 'todo_write', 'compress']) {
    assert.match(guard({ name }), new RegExp('"' + name + '" is not available'), name)
  }
  // A name that is not listed stays callable, whatever it is.
  assert.equal(guard({ name: 'ask_user_question' }), undefined)
})

test('the gate denies exactly the names it was handed, the native workflow included', () => {
  const guard = denyGuard([...HIDDEN, 'orchestrate', 'workflow'])
  assert.match(guard({ name: 'orchestrate' }), /"orchestrate" is not available/)
  assert.match(guard({ name: 'workflow' }), /"workflow" is not available/)
  const { agent, getGuard } = fakeAgent()
  const { guarded } = installGate({ agent, names: () => [...HIDDEN, 'orchestrate'], enabled: () => true })
  assert.equal(guarded.includes('orchestrate'), true)
  assert.notEqual(getGuard()({ name: 'orchestrate' }), undefined)
})

test('denyGuard tolerates an execution without a name', () => {
  const guard = denyGuard(HIDDEN)
  assert.equal(guard(undefined), undefined)
  assert.equal(guard(null), undefined)
  assert.equal(guard({}), undefined)
  assert.equal(guard({ name: 42 }), undefined)
})

test('restrictEach keeps going after one name is refused and reports it in skipped', () => {
  const { agent, restricted } = fakeAgent()
  const { applied, skipped } = restrictEach(agent, ['edit', 'subagent', 'write'])
  assert.deepEqual(applied, ['edit', 'write'])
  assert.deepEqual(restricted, ['edit', 'write'])
  assert.equal(skipped.length, 1)
  assert.match(skipped[0], /^subagent \(/)
  assert.match(skipped[0], /unknown global tool "subagent"/)
})

test('installGate hides global tools and refuses a scope-local one through the guard', () => {
  const { agent, restricted, getGuard } = fakeAgent()
  const { applied, skipped, guarded, guardError } = installGate({ agent, names: () => HIDDEN, enabled: () => true })
  assert.deepEqual(applied, ['edit', 'write', 'str_replace_editor'])
  assert.deepEqual(restricted, applied)
  assert.equal(skipped.length, 6)
  assert.match(skipped.join('\n'), /subagent \(.*unknown global tool/)
  assert.equal(guardError, undefined)
  assert.notEqual(getGuard()({ name: 'subagent' }), undefined)
  assert.notEqual(getGuard()({ name: 'ops_bash' }), undefined)
  assert.equal(getGuard()({ name: DELEGATE_TOOL }), undefined)
  assert.deepEqual(guarded, HIDDEN.filter((name) => name !== DELEGATE_TOOL))
})

test('installGate reports a guard failure instead of throwing', () => {
  const { agent } = fakeAgent({ guardError: 'guard is not available here' })
  const result = installGate({ agent, names: () => ['edit', 'subagent'], enabled: () => true })
  assert.equal(result.guardError, 'guard is not available here')
  assert.deepEqual(result.applied, ['edit'])
  assert.equal(result.skipped.length, 1)
})

test('installGate follows the switch: off hides nothing, on hides and denies, off again lifts it', () => {
  const { agent, restricted, getGuard } = fakeAgent({ globals: ['edit'] })
  let on = false
  const names = ['edit', 'subagent']
  const result = installGate({ agent, names: () => names, enabled: () => on })
  assert.deepEqual(result.applied, [])
  assert.deepEqual(restricted, [])
  assert.equal(getGuard()({ name: 'edit' }), undefined)

  on = true
  assert.notEqual(getGuard()({ name: 'edit' }), undefined)
  assert.deepEqual(restricted, ['edit'])
  assert.notEqual(getGuard()({ name: 'subagent' }), undefined)

  on = false
  assert.equal(getGuard()({ name: 'edit' }), undefined)
  assert.deepEqual(restricted, [])
})

test('installGate reads the denied list per call, so a config edit reaches a live agent', () => {
  const { agent, getGuard } = fakeAgent({ globals: [] })
  const names = ['edit', 'subagent']
  installGate({ agent, names: () => names, enabled: () => true })
  assert.notEqual(getGuard()({ name: 'edit' }), undefined)
  assert.equal(getGuard()({ name: 'todo_write' }), undefined)
  names.push('todo_write')
  assert.notEqual(getGuard()({ name: 'todo_write' }), undefined)
})

test('mergeDenied keeps the shipped defaults when a profile lists only a few', () => {
  const merged = mergeDenied(['edit', 'read', 'pwsh'], ['edit', 'write'])
  for (const name of ['edit', 'read', 'pwsh', 'write']) assert.ok(merged.includes(name), name)
  assert.equal(merged.length, 4)
})

test('mergeDenied tolerates a missing list on either side', () => {
  assert.deepEqual(mergeDenied(['read'], undefined), ['read'])
  assert.deepEqual(mergeDenied(undefined, ['read']), ['read'])
  assert.deepEqual(mergeDenied(undefined, undefined), [])
})

test('a cold-resumed child is recognised from the persisted header alone', () => {
  // Cold resume rebuilds options as provider/model/effort only, dropping subagentDepth;
  // the session header is then the only depth left. Reading options alone returned false
  // here, so the child got the main agent's gate and could only spawn grandchildren.
  const resumed = { options: { provider: 'p', model: 'm' }, session: { header: { delegationDepth: 1 } } }
  assert.equal(isDelegatedChild(resumed), true)
})

test('a freshly created child is a child through both sources', () => {
  const child = { options: { subagentDepth: 1 }, session: { header: { delegationDepth: 1 } } }
  assert.equal(isDelegatedChild(child), true)
  assert.equal(isDelegatedChild({ options: { subagentDepth: 1 }, session: { header: {} } }), true)
  assert.equal(isDelegatedChild({ options: { subagentDepth: 2 }, session: { header: { delegationDepth: 1 } } }), true)
})

test('the main agent has no depth on either side', () => {
  assert.equal(isDelegatedChild({ options: {}, session: { header: {} } }), false)
  assert.equal(isDelegatedChild({ options: { provider: 'p', model: 'm' }, session: { header: {} } }), false)
})

test('an explicit zero on both sides is still the main agent', () => {
  assert.equal(isDelegatedChild({ options: { subagentDepth: 0 }, session: { header: { delegationDepth: 0 } } }), false)
})

test('the depth is monotonic: the deeper of header and options wins', () => {
  assert.equal(isDelegatedChild({ options: { subagentDepth: 1 }, session: { header: { delegationDepth: 2 } } }), true)
  assert.equal(isDelegatedChild({ options: { subagentDepth: 0 }, session: { header: { delegationDepth: 1 } } }), true)
})

test('a dirty live depth falls back on the header instead of throwing', () => {
  for (const dirty of [-1, 1.5, Number.NaN, '1', null, undefined, {}, []]) {
    const label = String(dirty)
    assert.equal(
      isDelegatedChild({ options: { subagentDepth: dirty }, session: { header: { delegationDepth: 2 } } }),
      true,
      `header 2 with live ${label}`,
    )
    assert.equal(
      isDelegatedChild({ options: { subagentDepth: dirty }, session: { header: {} } }),
      false,
      `no depth with live ${label}`,
    )
  }
})

test('a dirty persisted depth is ignored, not thrown on', () => {
  for (const dirty of [-1, 2.5, Number.NaN, '2', Number.MAX_SAFE_INTEGER + 2, {}, null]) {
    assert.equal(isDelegatedChild({ options: {}, session: { header: { delegationDepth: dirty } } }), false, String(dirty))
  }
  // A dirty header must not block a valid live depth either.
  assert.equal(isDelegatedChild({ options: { subagentDepth: 1 }, session: { header: { delegationDepth: '2' } } }), true)
})

test('a partial agent reads whichever side it has, and never throws', () => {
  assert.equal(isDelegatedChild(undefined), false)
  assert.equal(isDelegatedChild(null), false)
  assert.equal(isDelegatedChild({}), false)
  assert.equal(isDelegatedChild({ options: { subagentDepth: 1 } }), true)
  assert.equal(isDelegatedChild({ session: { header: { delegationDepth: 1 } } }), true)
  assert.equal(isDelegatedChild({ options: null, session: null }), false)
  assert.equal(isDelegatedChild({ options: {}, session: {} }), false)
  assert.equal(isDelegatedChild({ options: {}, session: { header: null } }), false)
})


/** The shipped list is big; two names stand in for it in these tests. */
const SHIPPED = ['edit', 'read', 'ops_bash']

test('the effective list is the shipped list plus additions, minus allowances', () => {
  assert.deepEqual(effectiveDenied(SHIPPED, [], []), SHIPPED)
  assert.deepEqual(effectiveDenied(SHIPPED, ['custom'], []), [...SHIPPED, 'custom'])
  assert.deepEqual(effectiveDenied(SHIPPED, [], ['read']), ['edit', 'ops_bash'])
  // An allowance and an addition can name the same field: the allowance wins.
  assert.deepEqual(effectiveDenied(SHIPPED, ['custom', 'read'], ['read']), ['edit', 'ops_bash', 'custom'])
  // Unknown names are tolerated in both directions: allowing one is a no-op.
  assert.deepEqual(effectiveDenied(SHIPPED, [], ['not-a-tool']), SHIPPED)
  assert.deepEqual(effectiveDenied(SHIPPED, ['not-a-tool'], []), [...SHIPPED, 'not-a-tool'])
  // A dirty profile value must not throw.
  assert.deepEqual(effectiveDenied(SHIPPED, undefined, undefined), SHIPPED)
  assert.deepEqual(effectiveDenied(undefined, ['x'], undefined), ['x'])
})

test('the delegation tools are denied like any other when the profile lists them', () => {
  const listed = [...SHIPPED, DELEGATE_TOOL, ORCHESTRATE_TOOL, 'send_message', 'todo_write', 'compress']
  const live = effectiveDenied(SHIPPED, listed, [])
  for (const name of [DELEGATE_TOOL, ORCHESTRATE_TOOL, 'send_message', 'todo_write', 'compress']) {
    assert.equal(live.includes(name), true, name)
  }
  // `allowedTools` is the one way back, for these names as for any other.
  assert.equal(effectiveDenied(SHIPPED, listed, [DELEGATE_TOOL]).includes(DELEGATE_TOOL), false)
  assert.deepEqual(effectiveDenied(SHIPPED, [], [DELEGATE_TOOL, ORCHESTRATE_TOOL]), SHIPPED)
})

test('a name is deniable whether or not the shipped list contains it', () => {
  assert.deepEqual(effectiveDenied(['edit', 'todo_write'], ['todo_write'], []), ['edit', 'todo_write'])
  assert.deepEqual(effectiveDenied(['edit'], ['todo_write'], []), ['edit', 'todo_write'])
  assert.deepEqual(effectiveDenied(['edit', 'todo_write'], [], ['todo_write']), ['edit'])
})

test('a legacy deniedTools-only profile keeps exactly the 0.4.6 deny list', () => {
  const legacy = ['session_search', 'session_trace', 'session_event_search', 'session_event_read', 'session_event_trace', 'interrupt_agent']
  const live = effectiveDenied(SHIPPED, legacy, [])
  assert.deepEqual(live, mergeDenied(SHIPPED, legacy))
  for (const name of legacy) assert.equal(live.includes(name), true, name)
})

test('installGate with allowedTools leaves an allowed name callable and keeps the rest denied', () => {
  const { agent, restricted, getGuard } = fakeAgent({ globals: ['edit', 'read', 'ops_bash'] })
  const allowed = []
  const { applied, guarded } = installGate({
    agent,
    names: () => effectiveDenied(SHIPPED, [], allowed),
    enabled: () => true,
  })
  assert.deepEqual(applied, SHIPPED)
  assert.deepEqual(restricted, SHIPPED)
  const guard = getGuard()
  assert.match(guard({ name: 'edit' }), /not available to the main agent/)
  // The switch is live: allowing `edit` after installation lifts the guard for it only.
  allowed.push('edit')
  assert.equal(guard({ name: 'edit' }), undefined)
  assert.match(guard({ name: 'read' }), /not available to the main agent/)
  assert.equal(guarded.includes('edit'), true)
})
test('a forked root keeps the gate: parentSession without a depth is not a child', () => {
  // A GUI fork is a new root session: it records where it came from but starts at depth 0.
  const forked = { options: {}, session: { header: { parentSession: 'root-session', delegationDepth: 0 } } }
  assert.equal(isDelegatedChild(forked), false)
  const forkedWithoutDepth = { options: {}, session: { header: { parentSession: 'root-session' } } }
  assert.equal(isDelegatedChild(forkedWithoutDepth), false)
})

/**
 * An agent whose deny mask is a real set with real disposers, so a re-install shows up as
 * the exact table the host would compute. `restricts` counts installs, `lifts` counts
 * disposals: a leaked handle is a lift that never happened, a double disposal throws.
 */
function maskAgent({ globals }) {
  const mask = new Set()
  const denies = []
  const counts = { restrict: 0, lift: 0 }
  let guard
  return {
    mask,
    denies,
    counts,
    getGuard: () => guard,
    agent: {
      id: 'main',
      ctx: {
        tools: {
          restrict({ deny }) {
            const [tool] = deny
            if (!globals.includes(tool)) throw new Error('tools.restrict() names unknown global tool "' + tool + '"')
            counts.restrict += 1
            denies.push(tool)
            mask.add(tool)
            let live = true
            return () => {
              if (!live) throw new Error('a restriction was disposed twice')
              live = false
              counts.lift += 1
              mask.delete(tool)
            }
          },
          guard(fn) {
            guard = fn
          },
        },
      },
    },
  }
}

test('a checkbox change rebuilds the mask, so the next request sees the new table', () => {
  const { agent, mask, getGuard } = maskAgent({ globals: ['edit', 'read', 'ops_bash'] })
  let names = ['edit', 'read', 'ops_bash']
  const gate = installGate({ agent, names: () => names, enabled: () => true })
  assert.deepEqual([...mask], ['edit', 'read', 'ops_bash'])

  // Un-checking `read` only rewrites the config; refresh is what the panel write triggers.
  names = ['edit', 'ops_bash']
  assert.equal(gate.refresh(), true)
  assert.deepEqual([...mask].sort(), ['edit', 'ops_bash'])
  assert.equal(getGuard()({ name: 'read' }), undefined, 'the re-allowed tool is callable at once')

  // Re-checking it hides it again, and the guard refuses it in the same breath.
  names = ['edit', 'read']
  assert.equal(gate.refresh(), true)
  assert.deepEqual([...mask].sort(), ['edit', 'read'])
  assert.match(getGuard()({ name: 'read' }), /not available to the main agent/)
  // The tool that left the list is callable again, with no session restart anywhere.
  assert.equal(getGuard()({ name: 'ops_bash' }), undefined)
})

test('refresh with an unchanged list does not touch the registry', () => {
  const { agent, mask, counts } = maskAgent({ globals: ['edit'] })
  const gate = installGate({ agent, names: () => ['edit'], enabled: () => true })
  for (let index = 0; index < 5; index += 1) assert.equal(gate.refresh(), false)
  assert.equal(counts.restrict, 1)
  assert.equal(counts.lift, 0)
  assert.deepEqual([...mask], ['edit'])
})

test('repeated changes never accumulate restrictions or leak handles', () => {
  const { agent, mask, counts } = maskAgent({ globals: ['edit', 'read'] })
  let names = ['edit', 'read']
  const gate = installGate({ agent, names: () => names, enabled: () => true })
  const rounds = ['edit', 'read', 'edit', 'edit', 'read', 'edit', 'read', 'read']
  for (const name of rounds) {
    names = [name]
    gate.refresh()
    assert.deepEqual([...mask], [name], name)
  }
  // Each refresh lifts exactly what it installed: one lift per install.
  assert.equal(counts.lift, counts.restrict - 1)
  assert.equal(counts.lift, counts.restrict - 1)
  assert.equal(mask.size, 1)
})

test('the switch flips the whole table in an open session, both ways', () => {
  const { agent, mask, getGuard } = maskAgent({ globals: ['edit', 'read'] })
  let on = true
  const gate = installGate({ agent, names: () => ['edit', 'read'], enabled: () => on })
  assert.deepEqual([...mask].sort(), ['edit', 'read'])
  assert.match(getGuard()({ name: 'edit' }), /not available/)

  on = false
  assert.equal(gate.refresh(), true)
  assert.deepEqual([...mask], [], 'off lifts every restriction')
  assert.equal(getGuard()({ name: 'edit' }), undefined, 'off lets everything through')

  on = true
  assert.equal(gate.refresh(), true)
  assert.deepEqual([...mask].sort(), ['edit', 'read'], 'on restores the same table')
  assert.match(getGuard()({ name: 'edit' }), /not available/)
})

test('a denied delegation tool lands in the mask and is refused, then comes back', () => {
  const extra = [DELEGATE_TOOL, ORCHESTRATE_TOOL, 'send_message', 'todo_write', 'compress']
  const { agent, mask, denies, getGuard } = maskAgent({ globals: [...extra, ...SHIPPED] })
  let configured = []
  const names = () => effectiveDenied(SHIPPED, configured, [])
  const gate = installGate({ agent, names, enabled: () => true })
  assert.deepEqual([...mask].sort(), [...SHIPPED].sort())

  configured = [...extra]
  assert.equal(gate.refresh(), true)
  for (const name of extra) {
    assert.equal(mask.has(name), true, name)
    assert.equal(denies.includes(name), true, name)
    assert.match(getGuard()({ name }), /not available/, name)
  }
  assert.deepEqual([...mask].sort(), [...extra, ...SHIPPED].sort())

  // Re-allowing them lifts the mask and the guard in the same breath.
  configured = []
  gate.refresh()
  for (const name of extra) {
    assert.equal(mask.has(name), false, name)
    assert.equal(getGuard()({ name }), undefined, name)
  }
  assert.deepEqual([...mask].sort(), [...SHIPPED].sort())
})

/**
 * A nested call from inside \`run_code\` reaches the same registry pipeline as a
 * model-direct one: the transport builds its sub-dispatch with the SAME \`agent\`
 * and a \`parent\` execution token (dsh-tools \`lib/index.js\`: \`parent: exec.token\`),
 * then runs it through \`scheduler.prepare\` -> \`prepareExecution\` -> \`guardReason\`.
 * The guard therefore has to decide on the name alone and must NOT treat a
 * \`parent\` token as an exemption, or every denied tool becomes callable from
 * inside a program.
 */
test('a run_code sub-dispatch is refused by name, exactly like a direct call', () => {
  const { agent, getGuard } = fakeAgent()
  installGate({ agent, names: () => HIDDEN, enabled: () => true })
  const guard = getGuard()
  // The shape the transport builds: same agent, a parent token set, a sub-call id.
  const nested = (name) => ({
    name,
    agent,
    parent: Symbol('parent-execution'),
    callId: 'call:ptc:1',
    rootCallId: 'call',
    arguments: {},
  })
  for (const name of ['edit', 'write', 'ops_bash', 'subagent', 'pwsh']) {
    assert.match(guard(nested(name)), new RegExp('"' + name + '" is not available'), name)
  }
  // An allowed tool stays callable through the same nested shape: no over-blocking.
  assert.equal(guard(nested('delegate')), undefined)
  assert.equal(guard(nested('todo_write')), undefined)
})

test('a denial is decided before the body runs, so the nested call has no effect', () => {
  const { agent, getGuard } = fakeAgent()
  installGate({ agent, names: () => ['write'], enabled: () => true })
  const guard = getGuard()
  const ran = []
  // A stand-in body: the guard runs first in the pipeline, so a denial must mean
  // the body is never reached.
  const dispatch = (exec) => {
    const reason = guard(exec)
    if (reason !== undefined) return { denied: reason }
    ran.push(exec.name)
    return { ok: true }
  }
  const outcome = dispatch({ name: 'write', agent, parent: Symbol('parent-execution'), arguments: { path: 'x' } })
  assert.match(outcome.denied, /"write" is not available/)
  assert.deepEqual(ran, [], 'a denied body must never run')
  // The allowed tool in the same nested shape does reach its body: the denial is
  // by name, not a blanket block on run_code sub-dispatch.
  assert.equal(dispatch({ name: 'todo_write', agent, parent: Symbol('parent-execution') }).ok, true)
  assert.deepEqual(ran, ['todo_write'])
})

test('dispose lifts the mask and unregisters the guard', () => {
  const { agent, mask, counts } = maskAgent({ globals: ['edit', 'read'] })
  const gate = installGate({ agent, names: () => ['edit', 'read'], enabled: () => true })
  gate.dispose()
  assert.deepEqual([...mask], [])
  assert.equal(counts.lift, 2)
  gate.dispose()
  assert.equal(counts.lift, 2, 'a second dispose must not re-run a lifted handle')
})

/**
 * `run_code` is the PTC transport: the one tool a main agent calls directly, and the
 * one the host refuses to hide (`tools.restrict` throws on it). A name check is
 * therefore not enough — the program itself runs in a Node.js subprocess, where
 * `import('node:fs')` or a `sandbox_permissions` escalation reaches the host without
 * ever naming a denied tool. The gate reads the call's arguments instead, and it reads
 * them lexically: the program body is mostly a prompt, so only code positions count.
 */
test('a run_code program that reaches the host runtime is refused', () => {
  const { agent, getGuard } = fakeAgent()
  installGate({ agent, names: () => HIDDEN, enabled: () => true })
  const guard = getGuard()
  const program = (code) => ({ name: 'run_code', agent, arguments: { code, description: 'x' } })

  // The reported bypass: read and execute from inside the program.
  assert.match(
    guard(program('const fs = await import("node:fs/promises")\nconst cp = await import("node:child_process")')),
    /"run_code" cannot reach the Node\.js or host runtime \("import"\)/,
  )
  assert.match(guard(program('process.getBuiltinModule("fs")')), /\("process"\)/)
  assert.match(guard(program('await fetch("https://example.com")')), /\("fetch"\)/)
  assert.match(guard(program('(()=>{}).constructor("return process")()')), /\("constructor"\)/)
  assert.match(guard(program('\\u0070rocess.exit(0)')), /\("process"\)/)

  // Escalating the call itself is a different refusal, decided on the arguments.
  for (const permissions of ['workspace-write', 'danger-full-access']) {
    assert.match(
      guard({ name: 'run_code', agent, arguments: { code: 'return 1', sandbox_permissions: permissions } }),
      /sandbox escalation is not available to the main agent/,
      permissions,
    )
  }
  assert.match(
    guard({ name: 'run_code', agent, arguments: { code: 'return 1', justification: 'push it' } }),
    /sandbox escalation is not available/,
  )

  // A delegation program is the normal case and stays untouched, prompts included.
  const delegated =
    'await tools.delegate({ description: "w", prompt: `write a script that calls import("node:fs") and process.env` })'
  assert.equal(guard(program(delegated)), undefined)
  assert.equal(guard(program('await tools.orchestrate({ items: [1], stages: [{ name: "s", prompt: "x" }] })')), undefined)
})

test('run_code is refused only while the gate is on', () => {
  const { agent, getGuard } = fakeAgent()
  let on = false
  installGate({ agent, names: () => HIDDEN, enabled: () => on })
  const guard = getGuard()
  const escalated = { name: 'run_code', agent, arguments: { code: 'await import("node:fs")', sandbox_permissions: 'danger-full-access' } }
  // Off means off: the profile denied nothing, so the program is the profile's business.
  assert.equal(guard(escalated), undefined)
  assert.equal(guard({ name: 'edit', agent }), undefined)
  on = true
  assert.match(guard(escalated), /sandbox escalation is not available/)
  assert.match(guard({ name: 'edit', agent }), /"edit" is not available/)
})

test('an empty deny list leaves run_code alone, a non-empty one does not', () => {
  const { agent, getGuard } = fakeAgent()
  installGate({ agent, names: () => [], enabled: () => true })
  const guard = getGuard()
  const call = { name: 'run_code', agent, arguments: { code: 'await import("node:fs")' } }
  assert.equal(guard(call), undefined, 'an empty list denies nothing')
})

test('an explicitly denied run_code keeps the plain tool-level refusal', () => {
  const { agent, getGuard } = fakeAgent()
  installGate({ agent, names: () => ['run_code', 'edit'], enabled: () => true })
  const guard = getGuard()
  // The name check runs first and is unchanged: a profile that denies run_code itself
  // gets the same sentence as any other denied tool, not the argument-level one.
  assert.equal(
    guard({ name: 'run_code', agent, arguments: { code: 'return 1' } }),
    'orchestrator: "run_code" is not available to the main agent. The main agent only plans; hand every action to a worker with the dispatch tool.',
  )
  assert.match(guard({ name: 'run_code', agent, arguments: {} }), /"run_code" is not available/)
  // denyGuard, the fixed-list form, behaves the same way.
  assert.match(denyGuard(['run_code'])({ name: 'run_code', arguments: {} }), /"run_code" is not available/)
})
