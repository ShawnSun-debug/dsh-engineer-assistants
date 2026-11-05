import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MASTER_ENDPOINT,
  MASTER_METHOD,
  MASTER_SERVICE_KEY,
  MasterRemote,
  collectMasterPanel,
  emptyStateCounts,
} from '../lib/master-panel.js'

const ZERO = {
  Working: 0,
  'Needs input': 0,
  Idle: 0,
  Completed: 0,
  Failed: 0,
  Stopped: 0,
}

const row = (id, state, summary = '') => ({ id, role: 'worker', state, summary })

test('an empty session list is the empty panel, with all six counters present', () => {
  assert.deepEqual(collectMasterPanel([], () => ({ workers: [] })), { byState: ZERO, workers: [] })
  assert.deepEqual(collectMasterPanel(undefined, () => ({ workers: [] })), { byState: ZERO, workers: [] })
  assert.deepEqual(emptyStateCounts(), ZERO)
})

test('rows from every session are flat-mapped and counted by state', () => {
  const sessions = [{ header: { id: 's1' } }, { header: { id: 's2' } }]
  const stateOf = (session) =>
    session.header.id === 's1'
      ? { workers: [row('w1', 'Working', 'build the panel'), row('w2', 'Needs input')] }
      : { workers: [row('w3', 'Completed', 'done')] }
  assert.deepEqual(collectMasterPanel(sessions, stateOf), {
    byState: { ...ZERO, Working: 1, 'Needs input': 1, Completed: 1 },
    workers: [
      row('w1', 'Working', 'build the panel'),
      row('w2', 'Needs input'),
      row('w3', 'Completed', 'done'),
    ],
  })
})

test('a main session row is not a worker and stays out of the panel', () => {
  const stateOf = () => ({ workers: [{ id: 'main', role: 'main', state: 'Idle', summary: 'chat' }] })
  assert.deepEqual(collectMasterPanel([{}], stateOf), { byState: ZERO, workers: [] })
})

test('one broken session is skipped instead of blanking the panel', () => {
  const stateOf = (session) => {
    if (session.broken === true) throw new Error('no log')
    return { workers: [row('ok', 'Failed', 'boom')] }
  }
  assert.deepEqual(collectMasterPanel([{ broken: true }, {}], stateOf), {
    byState: { ...ZERO, Failed: 1 },
    workers: [row('ok', 'Failed', 'boom')],
  })
})

test('a state outside the six values is not listed and does not inflate a count', () => {
  const stateOf = () => ({ workers: [row('odd', 'Sleeping'), row('fine', 'Idle')] })
  assert.deepEqual(collectMasterPanel([{}], stateOf), {
    byState: { ...ZERO, Idle: 1 },
    workers: [row('fine', 'Idle')],
  })
})

test('a prototype key on a row is not a state and never becomes a counter', () => {
  // byState is a plain object, so `state in byState` is true for 'constructor' and
  // 'toString'; those rows must be skipped, not counted and then rendered.
  const stateOf = () => ({ workers: [row('ctor', 'constructor'), row('str', 'toString'), row('ok', 'Idle')] })
  assert.deepEqual(collectMasterPanel([{}], stateOf), {
    byState: { ...ZERO, Idle: 1 },
    workers: [row('ok', 'Idle')],
  })
})

test('the Remote Service exports one zero-argument direct method at the expected endpoint', () => {
  const service = new MasterRemote({ registration: Promise.resolve({ stateOf: () => ({ workers: [] }) }) })
  assert.equal(MASTER_SERVICE_KEY, 'orchestratorMaster')
  assert.equal(MASTER_METHOD, 'masterState')
  assert.equal(MASTER_ENDPOINT, 'orchestratorMaster/masterState')
  assert.equal(service.masterState.length, 0, 'SRC reflection reads a zero-parameter method')
  assert.deepEqual(service.typertRemote, {
    service,
    serviceKey: MASTER_SERVICE_KEY,
    namespace: MASTER_SERVICE_KEY,
  })
  const marker = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(service),
    '@deepseek-ai/dsh-typert-protocol/remote-methods',
  )?.value
  assert.equal(marker.version, 1)
  assert.deepEqual(marker.methods, [{ method: 'masterState', invocation: { kind: 'direct' } }])
})

test('the switch off returns no data and never reads a session', async () => {
  let reads = 0
  const service = new MasterRemote({
    enabled: () => false,
    sessions: () => {
      reads += 1
      return [{}]
    },
    registration: {
      then(resolve) {
        reads += 1
        return Promise.resolve(resolve({ stateOf: () => ({ workers: [row('w', 'Working')] }) }))
      },
    },
  })
  assert.deepEqual(await service.masterState(), { enabled: false, byState: ZERO, workers: [] })
  assert.equal(reads, 0)
})

test('the switch on awaits the saved registration and folds live sessions', async () => {
  const sessions = [{ header: { id: 's1' } }]
  const service = new MasterRemote({
    enabled: () => true,
    sessions: () => sessions,
    registration: Promise.resolve({ stateOf: () => ({ workers: [row('w', 'Stopped', 'halted')] }) }),
  })
  assert.deepEqual(await service.masterState(), {
    enabled: true,
    byState: { ...ZERO, Stopped: 1 },
    workers: [row('w', 'Stopped', 'halted')],
  })
})

test('a registration without a handle fails loudly instead of inventing a panel', async () => {
  const service = new MasterRemote({ enabled: () => true, registration: Promise.resolve(undefined) })
  await assert.rejects(() => service.masterState(), /no stateOf handle/)
})
