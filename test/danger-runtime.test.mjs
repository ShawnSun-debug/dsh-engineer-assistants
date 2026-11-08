import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DANGER_IRREVERSIBLE,
  DANGER_RECORD_ONLY,
  commandOfToolCall,
  createDangerPolicy,
} from '../lib/danger-runtime.js'

const approved = { approved: true, reason: 'confirmed' }
const declined = { approved: false, reason: 'declined' }

/** Run one pre-execute call; returns the decision and how often the tool body was let through. */
async function run(policy, { name = 'bash', args = {}, agent = { id: 'w-1' }, callId = 'call-1' } = {}) {
  let next = 0
  const decision = await policy.preExecute(
    { name, arguments: args, agent, callId },
    async () => {
      next += 1
      return { kind: 'allow' }
    },
  )
  return { decision, next }
}

test('the irreversible list is the five that cannot be undone, and deploy is record-only', () => {
  assert.deepEqual([...DANGER_IRREVERSIBLE], [
    'file-destruction',
    'history-rewrite',
    'production-data',
    'host-config',
    'outbound',
  ])
  assert.deepEqual([...DANGER_RECORD_ONLY], ['deploy'])
})

test('a deploy is recorded and let through without asking', async () => {
  const asked = []
  const events = []
  const policy = createDangerPolicy({
    check: async (plan) => {
      asked.push(plan)
      return approved
    },
    record: (event) => events.push(event),
  })
  const { decision, next } = await run(policy, { args: { command: 'kubectl apply -f app.yaml' } })
  assert.equal(next, 1, 'the tool body still runs')
  assert.deepEqual(decision, { kind: 'allow' })
  assert.deepEqual(asked, [], 'a reversible category never opens a card')
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'record-only')
  assert.deepEqual(events[0].categories, ['deploy'])
})

test('an irreversible command is asked once and only then runs', async () => {
  const asked = []
  const events = []
  const policy = createDangerPolicy({
    check: async (plan, context) => {
      asked.push({ plan, context })
      return approved
    },
    record: (event) => events.push(event),
  })
  const { decision, next } = await run(policy, { args: { command: 'rm -rf build' } })
  assert.equal(asked.length, 1, 'the card is asked before the body')
  assert.equal(asked[0].plan.command, 'rm -rf build')
  assert.equal(asked[0].context.workerId, 'w-1')
  assert.equal(asked[0].context.callId, 'call-1')
  assert.equal(asked[0].context.toolName, 'bash')
  assert.equal(next, 1)
  assert.deepEqual(decision, { kind: 'allow' })
  assert.deepEqual(events.map((event) => event.kind), ['asked', 'decision'])
  assert.equal(events[1].approved, true)
})

test('a denied command is refused with the category and the command text', async () => {
  const policy = createDangerPolicy({ check: async () => declined })
  const { decision, next } = await run(policy, { args: { command: 'rm -rf build' } })
  assert.equal(next, 0, 'the body never runs')
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /file-destruction/)
  assert.match(decision.reason, /rm -rf build/)
})

test('the same command asks once even when two calls arrive together', async () => {
  let resolveAsk
  let asked = 0
  const policy = createDangerPolicy({
    check: () => {
      asked += 1
      return new Promise((resolve) => {
        resolveAsk = resolve
      })
    },
  })
  const first = run(policy, { args: { command: 'git push --force' } })
  const second = run(policy, { args: { command: 'git push --force' } })
  await Promise.resolve()
  assert.equal(asked, 1, 'one card, not two')
  assert.equal(policy.inflightCount(), 1)
  resolveAsk(approved)
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.next, 1)
  assert.equal(b.next, 1)
  assert.equal(policy.inflightCount(), 0, 'the slot is released once it settles')
})

test('one command on two different tools is two different things', async () => {
  let asked = 0
  const policy = createDangerPolicy({
    check: async () => {
      asked += 1
      return declined
    },
  })
  await run(policy, { name: 'bash', args: { command: 'git push --force' } })
  await run(policy, { name: 'pwsh', args: { command: 'git push --force' } })
  assert.equal(asked, 2, 'the key includes the intent, so these do not merge')
})

test('junk arguments are not a command, so nothing is asked', async () => {
  const asked = []
  const policy = createDangerPolicy({
    check: async (plan) => {
      asked.push(plan)
      return approved
    },
  })
  for (const args of [undefined, null, 'rm -rf build', [], { command: '   ' }, { command: ['rm'] }, {}]) {
    const { next } = await run(policy, { args })
    assert.equal(next, 1, JSON.stringify(args))
  }
  assert.deepEqual(asked, [])
})

test('a missing channel means no approval, and a throwing recorder cannot change that', async () => {
  const bare = createDangerPolicy({})
  const refused = await run(bare, { args: { command: 'rm -rf build' } })
  assert.equal(refused.next, 0)
  assert.equal(refused.decision.kind, 'deny')

  const noisy = createDangerPolicy({
    check: async () => approved,
    record: () => {
      throw new Error('the log is gone')
    },
  })
  const allowed = await run(noisy, { args: { command: 'rm -rf build' } })
  assert.equal(allowed.next, 1)
})

test('commandOfToolCall reads one string command field and nothing else', () => {
  assert.equal(commandOfToolCall({ command: ' rm -rf x ' }), 'rm -rf x')
  assert.equal(commandOfToolCall({ script: 'echo hi' }), 'echo hi')
  assert.equal(commandOfToolCall({ command: '', script: 'echo hi' }), 'echo hi')
  assert.equal(commandOfToolCall({ command: 1, script: null }), '')
  assert.equal(commandOfToolCall(null), '')
  assert.equal(commandOfToolCall(['rm -rf x']), '')
})
