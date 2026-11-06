import assert from 'node:assert/strict'
import test from 'node:test'
import { Config, attachSecretary } from '../lib/index.js'
import { createDraftStore } from '../lib/secretary-nudge.js'
import { composeViewState } from '../lib/secretary-panel.js'
import {
  SECRETARY_COMMAND_TOOL,
  SECRETARY_INTERRUPT_TOOL,
  SECRETARY_STATE_TOOL,
  createBlockedWake,
  createSecretaryTools,
  wakeTextOf,
} from '../lib/secretary-tools.js'

/**
 * 秘书的三个调度工具（secretary_state / secretary_command / secretary_interrupt）与
 * 卡点唤醒（secretaryWakeOnBlocked）。全部走注入的替身：这里证明的是工具自己的规则，
 * 不是宿主实现。
 *
 * 最后一段用真的 attachSecretary 跑一遍默认配置与两个唤醒开关，证明「默认关着时
 * 行为与今天一致」不是靠读代码猜的。
 */

const identity = (spec) => spec
const MASTER = { agent: { id: 'master-1' } }
const STRANGER = { agent: { id: 'someone-else' } }

function viewPayload() {
  const payload = composeViewState({
    enabled: true,
    registry: {
      masterSessionId: 'master-1',
      orchestrators: [{ sessionId: 'orch-1', workspace: 'w', title: '修登录', trackedAt: 1 }],
    },
    orchestrators: [{ sessionId: 'orch-1', title: '修登录', workspace: 'w', live: true, state: 'Working' }],
    reports: [],
    drafts: [],
    policy: { beatSeconds: 180, maxRunSeconds: 7200, notifyOn: ['state-flip'], promptText: '' },
  })
  // 视图端点会在拼装之后补越权记录：这里模拟同一个 payload，证明工具把整份交回来。
  return {
    ...payload,
    policy: {
      ...payload.policy,
      violations: [{ at: 1, agentId: 'master-1', action: 'pwsh', reason: 'refused' }],
    },
  }
}

function buildTools(overrides = {}) {
  const calls = []
  const tools = createSecretaryTools({
    defineTool: identity,
    readState: async () => viewPayload(),
    deliver: async (target, text, senderSessionId) => {
      calls.push({ target, text, senderSessionId })
      return { delivered: true }
    },
    registeredSessionIds: () => ['orch-1'],
    masterSessionId: () => 'master-1',
    ...overrides,
  })
  return { tools, calls }
}

test('a non-master caller is refused by all three tools, as an error object and never a throw', async () => {
  const { tools, calls } = buildTools({
    interrupt: () => {
      throw new Error('must not be called')
    },
  })
  const cases = [
    [tools[SECRETARY_STATE_TOOL], {}],
    [tools[SECRETARY_COMMAND_TOOL], { sessionId: 'orch-1', text: 'go' }],
    [tools[SECRETARY_INTERRUPT_TOOL], { sessionId: 'orch-1' }],
  ]
  for (const [tool, args] of cases) {
    const result = await tool.execute(args, STRANGER)
    assert.equal(result.ok, false, tool.name + ' must refuse a stranger')
    assert.match(result.error, /only the designated master session/, tool.name + ' names the rule')
  }
  assert.equal(calls.length, 0, 'a refusal never reaches the delivery port')
})

test('an unset master designates nobody, so even a caller with no configured master is refused', async () => {
  const { tools } = buildTools({ masterSessionId: () => '' })
  for (const tool of [tools[SECRETARY_STATE_TOOL], tools[SECRETARY_COMMAND_TOOL], tools[SECRETARY_INTERRUPT_TOOL]]) {
    const result = await tool.execute({ sessionId: 'orch-1', text: 'go' }, MASTER)
    assert.equal(result.ok, false)
    assert.match(result.error, /secretaryMasterSessionId is empty/)
  }
})

test('secretary_command refuses an unregistered session and delivers once to a registered one', async () => {
  const { tools, calls } = buildTools()

  const refused = await tools[SECRETARY_COMMAND_TOOL].execute({ sessionId: 'nobody', text: 'go' }, MASTER)
  assert.equal(refused.ok, false)
  assert.match(refused.error, /only a session registered with the secretary/)
  assert.equal(calls.length, 0, 'an unregistered target is refused before any delivery')

  const sent = await tools[SECRETARY_COMMAND_TOOL].execute(
    { sessionId: 'orch-1', text: '先跑回归，再改\n第二步' },
    MASTER,
  )
  assert.deepEqual(sent, { ok: true, sessionId: 'orch-1', delivered: true })
  assert.equal(calls.length, 1, 'exactly one delivery')
  assert.equal(calls[0].target, 'orch-1')
  assert.equal(calls[0].senderSessionId, 'master-1', 'the receiver can tell the master sent it')
  assert.equal(calls[0].text, '先跑回归，再改\n第二步', 'the instruction is passed through verbatim')

  const failed = buildTools({
    deliver: async () => ({ delivered: false, reason: 'no live agent for session orch-1' }),
  })
  const rejected = await failed.tools[SECRETARY_COMMAND_TOOL].execute({ sessionId: 'orch-1', text: 'go' }, MASTER)
  assert.equal(rejected.ok, false)
  assert.equal(rejected.delivered, false)
  assert.match(rejected.error, /no live agent/)
})

test('secretary_interrupt reports unsupported when the host has no API, and calls it when it does', async () => {
  const missing = buildTools()
  const unsupported = await missing.tools[SECRETARY_INTERRUPT_TOOL].execute({ sessionId: 'orch-1' }, MASTER)
  assert.equal(unsupported.ok, false)
  assert.equal(unsupported.supported, false)
  assert.match(unsupported.error, /no API to interrupt a running turn/)
  assert.equal('requested' in unsupported, false, 'nothing was requested')

  const interrupts = []
  const present = buildTools({
    interrupt: (sessionId) => {
      interrupts.push(sessionId)
      return { requested: true, status: 'running' }
    },
  })
  const accepted = await present.tools[SECRETARY_INTERRUPT_TOOL].execute({ sessionId: 'orch-1' }, MASTER)
  assert.deepEqual(accepted, { ok: true, sessionId: 'orch-1', requested: true, status: 'running' })
  assert.deepEqual(interrupts, ['orch-1'], 'the host API is called once for the registered session')

  const refused = await present.tools[SECRETARY_INTERRUPT_TOOL].execute({ sessionId: 'nobody' }, MASTER)
  assert.equal(refused.ok, false)
  assert.match(refused.error, /only a session registered with the secretary/)
  assert.deepEqual(interrupts, ['orch-1'], 'an unregistered target never reaches the host API')
})

test('secretary_state returns the view payload, including the authority violations', async () => {
  const { tools } = buildTools()
  const result = await tools[SECRETARY_STATE_TOOL].execute({}, MASTER)
  assert.equal(result.ok, true)
  const state = result.state
  for (const segment of ['registry', 'orchestrators', 'reports', 'drafts', 'policy']) {
    assert.ok(segment in state, segment + ' is part of the payload')
  }
  assert.equal(state.registry.masterSessionId, 'master-1')
  assert.equal(state.orchestrators[0].sessionId, 'orch-1')
  assert.equal(state.policy.violations.length, 1)
  assert.equal(state.policy.violations[0].action, 'pwsh')

  const broken = buildTools({
    readState: async () => {
      throw new Error('the projection is gone')
    },
  })
  const failure = await broken.tools[SECRETARY_STATE_TOOL].execute({}, MASTER)
  assert.equal(failure.ok, false)
  assert.match(failure.error, /the projection is gone/)
})

test('the blocked wake delivers nothing while off, and once per session and reason while on', async () => {
  const deliveries = []
  const deliver = async (target, text) => {
    deliveries.push({ target, text })
    return { delivered: true }
  }
  const drafts = [
    { sessionId: 'orch-1', reason: 'needs-input' },
    { sessionId: 'orch-1', reason: 'needs-input' },
    { sessionId: 'orch-2', reason: 'conflict' },
  ]

  const off = createBlockedWake({ enabled: () => false, target: () => 'master-1', deliver })
  assert.deepEqual(await off.wake(drafts), [])
  assert.equal(deliveries.length, 0, 'the switch being off means not one call')

  const defaults = createBlockedWake()
  assert.deepEqual(await defaults.wake(drafts), [], 'no arguments is the off default')

  const on = createBlockedWake({ enabled: () => true, target: () => 'master-1', deliver })
  await on.wake(drafts)
  assert.equal(deliveries.length, 2, 'two distinct session/reason pairs, duplicates collapsed')
  assert.deepEqual(
    deliveries.map(({ target }) => target),
    ['master-1', 'master-1'],
  )
  // 同一批草稿再刷一遍：去重表挡住第二次唤醒。
  await on.wake(drafts)
  assert.equal(deliveries.length, 2, 'the same stuck point wakes only once')

  const noMaster = createBlockedWake({ enabled: () => true, target: () => null, deliver })
  assert.deepEqual(await noMaster.wake(drafts), [], 'without a master there is no receiver to guess')
  assert.equal(deliveries.length, 2, 'and nothing is sent')

  const text = wakeTextOf({ sessionId: 'orch-1', reason: 'needs-input' })
  assert.match(text, /orch-1/)
  assert.match(text, /等你确认/)
  assert.equal(text.includes('\n'), false, 'a wake is one line')
})

/** 一个只提供 attachSecretary 会碰的那几样服务的宿主。 */
function host({ enabled = true, masterSessionId = '', wakeOnBlocked = false, omitWakeKey = false, messaging } = {}) {
  const tools = []
  const messages = []
  const effects = []
  const handlers = new Map()
  const logs = []
  const sessionList = [{ id: 'orch-1', title: '修登录', header: { id: 'orch-1', cwd: 'C:\\tmp' } }]
  const registration = {
    stateOf: (session) =>
      session?.id === 'orch-1'
        ? { workers: [{ id: 'orch-1', role: 'main', state: 'Needs input', summary: '' }] }
        : { workers: [] },
  }
  const ctx = {
    effect(fn, label) {
      const dispose = fn()
      effects.push({ label, dispose })
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    logger: { info: () => {}, warn: (message) => logs.push(message) },
    sessions: {
      list: () => sessionList,
      get: (id) => sessionList.find((session) => session.id === id),
      flush: async () => true,
    },
    agents: { get: () => undefined },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
    },
  }
  const config = {
    secretaryEnabled: { get: () => enabled },
    secretaryMasterSessionId: { get: () => masterSessionId },
    secretaryOrchestrators: {
      get: () => [{ sessionId: 'orch-1', workspace: 'w', title: '修登录', trackedAt: 1 }],
    },
  }
  // omitWakeKey = 更老的 profile：这笔键根本不存在，默认值必须等于关。
  if (!omitWakeKey) config.secretaryWakeOnBlocked = { get: () => wakeOnBlocked }
  const drafts = createDraftStore()
  const secretary = attachSecretary(ctx, config, {
    registration,
    drafts,
    readState: async () => viewPayload(),
    defineTool: identity,
    messaging:
      messaging ??
      {
        async deliver(to, text) {
          messages.push({ to, text })
          return { delivered: true }
        },
      },
  })
  return { ctx, config, drafts, secretary, tools, messages, logs }
}

test('the new switch is declared off by default and volatile', () => {
  // 完整套件里 schemastery 被替身成 `.shape`，单独跑时是宿主真包（`.dict` + meta）。
  const field = Config.shape?.secretaryWakeOnBlocked ?? Config.dict?.secretaryWakeOnBlocked
  assert.ok(field, 'Config must declare secretaryWakeOnBlocked')
  assert.equal(field.defaultValue ?? field.meta?.default, false, 'wake is opt-in')
  assert.equal(field.volatileFlag ?? field.meta?.volatile, true, 'a settings write must reach the running plugin')
})

test('with the secretary switch off nothing is registered and nothing is delivered', async () => {
  const h = host({ enabled: false })
  assert.equal(h.secretary, undefined, 'attachSecretary stays off')
  assert.deepEqual(h.tools, [], 'no secretary tool is registered')
  assert.deepEqual(h.messages, [], 'no wake is delivered')
})

test('with no master the three tools are registered but refuse, and the default wake sends nothing', async () => {
  const h = host({ masterSessionId: '', wakeOnBlocked: false })
  assert.ok(h.secretary, 'the watch still attaches')
  assert.deepEqual(
    h.tools.map(({ name }) => name).sort(),
    [SECRETARY_COMMAND_TOOL, SECRETARY_INTERRUPT_TOOL, SECRETARY_STATE_TOOL].sort(),
  )
  await h.secretary.ready
  assert.equal(h.drafts.list().length, 1, 'today a stuck session still gets its draft')
  assert.deepEqual(h.messages, [], 'the wake switch is off, so not one message')

  for (const tool of h.tools) {
    const args = tool.name === SECRETARY_COMMAND_TOOL ? { sessionId: 'orch-1', text: 'go' } : { sessionId: 'orch-1' }
    const result = await tool.execute(tool.name === SECRETARY_STATE_TOOL ? {} : args, MASTER)
    assert.equal(result.ok, false, tool.name + ' has no master to answer')
  }
})

test('an older profile without the wake key is the off default: the draft appears, the wake does not', async () => {
  const h = host({ masterSessionId: 'master-1', omitWakeKey: true })
  assert.ok(h.config.secretaryWakeOnBlocked === undefined, 'the test host really omits the key')
  await h.secretary.ready
  assert.equal(h.drafts.list().length, 1, 'today a stuck session still gets its draft')
  assert.deepEqual(h.messages, [], 'a missing key means off, not on')
})

test('turning the wake on delivers one message per stuck point and only once', async () => {
  const h = host({ masterSessionId: 'master-1', wakeOnBlocked: true })
  await h.secretary.ready
  assert.equal(h.messages.length, 1, 'the mount already saw the Needs input draft')
  assert.equal(h.messages[0].to, 'master-1')
  assert.match(h.messages[0].text, /orch-1/)

  await h.secretary.refreshDrafts()
  await h.secretary.refreshDrafts()
  assert.equal(h.messages.length, 1, 'the same stuck point is not re-announced every refresh')
})
