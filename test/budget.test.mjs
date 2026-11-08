import assert from 'node:assert/strict'
import test from 'node:test'

import { assignSession, normalizeAssignments, reserveChildId } from '../lib/assignments.js'
import {
  BUDGET_MAX_RETRIES,
  DEFAULT_BUDGET,
  describeFailure,
  evaluateBudget,
  retryDecision,
} from '../lib/budget.js'

test('a worker inside its budget is not reported', () => {
  const verdict = evaluateBudget({ usage: { minutes: 10, tokens: 1000 } })
  assert.equal(verdict.exceeded, false)
  assert.deepEqual(verdict.reasons, [])
  assert.equal(verdict.message, '')
})

test('going over either limit is reported, and both are named', () => {
  const minutes = evaluateBudget({ workerId: 'worker-3', usage: { minutes: 31, tokens: 1 } })
  assert.equal(minutes.exceeded, true)
  assert.match(minutes.message, /worker "worker-3" over budget/)
  assert.match(minutes.message, /ran 31 min \(limit 30\)/)
  assert.match(minutes.message, /Continue or stop\?/, 'the report asks a question, it does not kill')

  const both = evaluateBudget({ usage: { minutes: 60, tokens: 500000 } })
  assert.deepEqual(both.reasons, ['ran 60 min (limit 30)', 'used 500000 tokens (limit 200000)'])
})

test('a partial budget fills the missing dimension from the default instead of going unlimited', () => {
  const minutesOnly = evaluateBudget({ budget: { minutes: 45 }, usage: { minutes: 1, tokens: 10_000_000 } })
  assert.equal(minutesOnly.exceeded, true, 'the token dimension must not become Infinity')
  assert.equal(minutesOnly.budget.tokens, DEFAULT_BUDGET.tokens)

  const empty = evaluateBudget({ budget: {}, usage: { minutes: 1, tokens: DEFAULT_BUDGET.tokens + 1 } })
  assert.equal(empty.exceeded, true)
})

test('budget maths is strict about its inputs', () => {
  assert.throws(() => evaluateBudget({ usage: null }), /usage must be an object/)
  assert.throws(() => evaluateBudget({ usage: { minutes: -1 } }), /non-negative finite number/)
  assert.throws(() => evaluateBudget({ budget: { minutes: 'soon' }, usage: {} }), /non-negative finite number/)
  assert.throws(() => evaluateBudget({ usage: {}, budget: null }), /budget must be an object/)
})

test('the default budget is 30 minutes and 200k tokens', () => {
  assert.deepEqual({ ...DEFAULT_BUDGET }, { minutes: 30, tokens: 200_000 })
  assert.equal(BUDGET_MAX_RETRIES, 1)
})

test('exactly at the limit is not over it', () => {
  assert.equal(evaluateBudget({ usage: { minutes: 30, tokens: 200_000 } }).exceeded, false)
})

test('the first failure is retried once, the second is final', () => {
  assert.deepEqual(retryDecision({ attempt: 1 }), { retry: true, retries: 1, attempt: 1, maxRetries: 1 })
  assert.deepEqual(retryDecision({ attempt: 2 }), { retry: false, retries: 1, attempt: 2, maxRetries: 1 })
  assert.equal(retryDecision({ attempt: 3 }).retry, false)
})

test('the retry count never exceeds the cap', () => {
  assert.equal(retryDecision({ attempt: 1 }).retries, 1)
  assert.equal(retryDecision({ attempt: 9 }).retries, BUDGET_MAX_RETRIES)
})

test('retry decisions reject nonsense', () => {
  assert.throws(() => retryDecision({ attempt: 0 }), /positive integer/)
  assert.throws(() => retryDecision({ attempt: 1.5 }), /positive integer/)
  assert.throws(() => retryDecision({ attempt: 1, maxRetries: -1 }), /non-negative integer/)
})

test('the second failure names the worker, the count and the cause', () => {
  const message = describeFailure({ workerId: 'worker-7', attempt: 2, error: new Error('tests red') })
  assert.equal(message, 'worker "worker-7" failed after 1 retry (2 attempts): tests red')
})

test('describeFailure is as strict about its numbers as retryDecision', () => {
  assert.equal(describeFailure({ attempt: 1 }), 'worker "unknown worker" failed after 0 retries (1 attempt): no error recorded')
  assert.throws(() => describeFailure({ attempt: 0 }), /positive integer/)
  assert.throws(() => describeFailure({ attempt: Number.NaN }), /positive integer/)
  assert.throws(() => describeFailure({ attempt: 2.5 }), /positive integer/)
  assert.throws(() => describeFailure({ attempt: 2, retries: 5 }), /cannot reach attempts/)
  assert.throws(() => describeFailure({ attempt: 1, retries: 1 }), /cannot reach attempts/)
  assert.throws(() => describeFailure({ attempt: 2, retries: 2 }), /cannot reach attempts/)
  assert.doesNotThrow(() => describeFailure({ attempt: 2, retries: 1 }))
  assert.throws(() => describeFailure({ attempt: 2, retries: 1.5 }), /non-negative integer/)
})

test('the retry count survives a write to the assignment row', () => {
  const parent = 'session-master-1'
  let table = reserveChildId({}, { id: 'child-1', parentId: parent, now: 1000 })
  assert.equal(table['child-1'].retries, 0)
  table = assignSession(table, { sessionId: 'child-1', kind: 'worker', parentId: parent, status: 'running' })
  assert.equal(table['child-1'].retries, 0)
  table = assignSession(table, { sessionId: 'child-1', kind: 'worker', retries: 1 })
  assert.equal(table['child-1'].retries, 1)
  // 普通写入不该把次数抹回 0。
  table = assignSession(table, { sessionId: 'child-1', kind: 'worker', cwd: 'D:/w' })
  assert.equal(table['child-1'].retries, 1)
  assert.equal(normalizeAssignments(JSON.parse(JSON.stringify(table)))['child-1'].retries, 1)
})
