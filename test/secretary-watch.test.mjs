import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPlanReport, createTriggerState, detectTrigger, isDispatchCall } from '../lib/secretary-watch.js'

/**
 * 秘书触发侦测与规划首报（秘书 spec 票 03）。
 *
 * 纯逻辑，不 import 宿主：事件来自会话日志（`{ seq, time, type, data }`），登记表来自
 * lib/secretary-registry.js，规划报告是交给渲染层的结构化输入。四件事在这里被钉住：
 *
 * - 只有被跟踪会话里的 `dispatch` 工具调用算「出发」，别的一概不算。
 * - 未登记会话里的 dispatch 什么都不算：秘书不读没被授权的会话。
 * - 同一会话只起一次表，重复 dispatch 不产第二份规划。
 * - 规划报告自带五要素：步骤、预估耗时、验收点、触发依据、已派 worker。
 */

const registry = {
  masterSessionId: 'master-1',
  orchestrators: [{ sessionId: 'orch-1', workspace: 'D:/w', title: '日报', trackedAt: 1 }],
}

/** 一条工具调用事件，形状与宿主的 `tool/call` 事件一致。 */
function toolCall(name, { callId = 'call-1', raw = '{}', time = 1000 } = {}) {
  return { seq: 1, time, type: 'tool/call', data: { turn: 1, step: 1, callId, name, arguments: raw } }
}

const dispatchOf = (args, options = {}) =>
  toolCall('dispatch', { ...options, raw: typeof args === 'string' ? args : JSON.stringify(args) })

test('isDispatchCall accepts exactly one shape: a tool/call of the dispatch tool', () => {
  assert.equal(isDispatchCall(dispatchOf({ description: '修登录' })), true)
  // 另一个工具、同一工具的结果事件、以及无关事件都不是出发信号。
  assert.equal(isDispatchCall(toolCall('read')), false)
  assert.equal(isDispatchCall({ type: 'tool/result', data: { name: 'dispatch' } }), false)
  assert.equal(isDispatchCall({ type: 'user/message', data: { content: [] } }), false)
  assert.equal(isDispatchCall({ type: 'tool/call', data: { name: 'delegate' } }), false)
  // 名字两端空白仍算同一个工具；非字符串的 name 与残缺对象一律不算。
  assert.equal(isDispatchCall({ type: 'tool/call', data: { name: ' dispatch ' } }), true)
  assert.equal(isDispatchCall({ type: 'tool/call', data: { name: 42 } }), false)
  assert.equal(isDispatchCall({ type: 'tool/call', data: null }), false)
  assert.equal(isDispatchCall({ type: 'tool/call' }), false)
  for (const junk of [undefined, null, 0, 'dispatch', []]) assert.equal(isDispatchCall(junk), false)
})

test('detectTrigger finds the first dispatch of a tracked session, in log order', () => {
  const events = [
    // 未登记会话的 dispatch 排在最前：它不能触发，也不能挡住后面那一条。
    { sessionId: 'stranger', event: dispatchOf({ prompt: '未登记' }, { time: 100 }) },
    { sessionId: 'orch-1', event: { type: 'turn/start', time: 200, data: { turn: 1 } } },
    { sessionId: 'orch-1', event: toolCall('read', { time: 300 }) },
    { sessionId: 'orch-1', event: dispatchOf({ description: '修登录', prompt: '让重试可用' }, { callId: 'call-7', time: 400 }) },
    { sessionId: 'orch-1', event: dispatchOf({ description: '第二份' }, { callId: 'call-8', time: 500 }) },
  ]
  const trigger = detectTrigger(events, registry)
  assert.deepEqual(trigger, {
    sessionId: 'orch-1',
    at: 400,
    call: { callId: 'call-7', name: 'dispatch', arguments: JSON.stringify({ description: '修登录', prompt: '让重试可用' }) },
  })
})

test('an event that carries its own session id is read the same way', () => {
  // 会话日志本身不带 id（id 在 Session 上），所以调用方可以二选一：加信封，或直接写进事件。
  const bare = { ...dispatchOf({ description: '修登录' }, { time: 700 }), sessionId: 'orch-1' }
  assert.equal(detectTrigger([bare], registry).at, 700)
  // 没有会话 id 的事件无法归属，直接跳过。
  assert.equal(detectTrigger([dispatchOf({ description: '无主' })], registry), null)
})

test('a dispatch in an untracked session triggers nothing at all', () => {
  assert.equal(detectTrigger([{ sessionId: 'stranger', event: dispatchOf({ prompt: 'x' }) }], registry), null)
  // 空流、非数组、以及只有非 dispatch 事件的流都是一个答案。
  assert.equal(detectTrigger([], registry), null)
  assert.equal(detectTrigger(undefined, registry), null)
  assert.equal(detectTrigger([{ sessionId: 'orch-1', event: toolCall('read') }], registry), null)
  // 登记表坏了、或根本不存在时，谁都不算被跟踪。
  assert.equal(detectTrigger([{ sessionId: 'orch-1', event: dispatchOf({}) }], undefined), null)
})

test('the same session never starts a second sheet', () => {
  const state = createTriggerState()
  assert.equal(state.has('orch-1'), false)
  assert.ok(state.seen instanceof Set)

  const first = detectTrigger([{ sessionId: 'orch-1', event: dispatchOf({ description: '第一份' }) }], registry)
  assert.equal(state.mark(first.sessionId), true, 'the first dispatch starts the sheet')
  assert.equal(state.has('orch-1'), true)

  // 事件流继续变长：同一条 dispatch 还会被再次找到，但 mark 不会再起表。
  const second = detectTrigger(
    [
      { sessionId: 'orch-1', event: dispatchOf({ description: '第一份' }) },
      { sessionId: 'orch-1', event: dispatchOf({ description: '第二份' }, { callId: 'call-2', time: 2000 }) },
    ],
    registry,
  )
  assert.equal(second.sessionId, 'orch-1')
  assert.equal(state.mark(second.sessionId), false, 'a repeat dispatch must not start another sheet')

  // 另一个会话有自己的第一份；空 id 永远不会被记住。
  assert.equal(state.mark('orch-2'), true)
  assert.equal(state.mark(''), false)
  assert.equal(state.has(''), false)
})

test('the planning report carries the five elements: steps, estimate, acceptance, trigger, workers', () => {
  const args = {
    description: '修登录',
    prompt: '让登录重试可用\n不要动 tests',
    verify: 'node --test',
    doneDefinition: '测试全绿',
  }
  const trigger = detectTrigger([{ sessionId: 'orch-1', event: dispatchOf(args, { callId: 'call-9', time: 4000 }) }], registry)
  const report = buildPlanReport({
    session: { id: 'orch-1', title: '日报', header: { cwd: 'D:/work' } },
    trigger,
    workers: [],
    now: 5000,
  })

  assert.equal(report.kind, 'plan')
  assert.equal(report.sessionId, 'orch-1')
  assert.equal(report.title, '日报')
  assert.equal(report.workspace, 'D:/work')
  assert.equal(report.at, 5000)

  // 1 步骤：单任务派发就是任务卡自己。
  assert.deepEqual(report.steps, [{ index: 1, name: '修登录', detail: '让登录重试可用 不要动 tests' }])
  // 2 预估耗时：基线估算，必须标明是估的而不是量出来的。
  assert.equal(report.estimate.basis, 'baseline')
  assert.equal(typeof report.estimate.seconds, 'number')
  assert.ok(report.estimate.seconds > 0)
  assert.match(report.estimate.label, /估/)
  // 3 验收点：卡片里的完成定义与验证命令，按这个顺序。
  assert.deepEqual(report.acceptance, ['测试全绿', 'node --test'])
  // 4 触发依据：哪一条调用、哪个会话、什么时候。
  assert.deepEqual(report.trigger, {
    kind: 'dispatch',
    tool: 'dispatch',
    sessionId: 'orch-1',
    at: 4000,
    callId: 'call-9',
  })
  // 5 已派 worker：调用还没返回，所以是「按参数即将派出」的那些，state 标明是计划。
  assert.deepEqual(report.workers, [{ id: 'call-9', role: '', state: 'planned', task: '修登录' }])
})

test('a batch dispatch plans one step per stage and one planned worker per item', () => {
  const args = {
    items: [{ path: 'a.js' }, { path: 'b.js' }],
    stages: [
      { name: '改', prompt: '改掉拼写' },
      { name: '验', prompt: '跑测试' },
    ],
  }
  const trigger = detectTrigger([{ sessionId: 'orch-1', event: dispatchOf(args, { callId: 'call-3', time: 100 }) }], registry)
  const report = buildPlanReport({ session: { id: 'orch-1', header: { cwd: 'D:/w' } }, trigger, workers: [], now: 200 })

  assert.deepEqual(
    report.steps.map(({ index, name }) => ({ index, name })),
    [
      { index: 1, name: '改' },
      { index: 2, name: '验' },
    ],
  )
  assert.equal(report.steps[0].detail, '改掉拼写')
  assert.deepEqual(report.workers, [
    { id: 'item-1', role: '', state: 'planned', task: '{"path":"a.js"}' },
    { id: 'item-2', role: '', state: 'planned', task: '{"path":"b.js"}' },
  ])
  // 批量派发没有任务卡，所以没有可报的验收点：空数组，而不是编一个。
  assert.deepEqual(report.acceptance, [])
})

test('already dispatched worker rows win over the plan derived from the call', () => {
  const trigger = detectTrigger([{ sessionId: 'orch-1', event: dispatchOf({ description: '修登录' }) }], registry)
  const report = buildPlanReport({
    session: { id: 'orch-1', header: { cwd: 'D:/w' } },
    trigger,
    workers: [
      { id: 'child-1', role: 'worker', state: 'Working', summary: '在跑测试' },
      { id: 'child-2', role: 'main', state: 'Idle', summary: '' },
    ],
    now: 1,
  })
  assert.deepEqual(report.workers, [
    { id: 'child-1', role: 'worker', state: 'Working', task: '在跑测试' },
    { id: 'child-2', role: 'main', state: 'Idle', task: '' },
  ])
})

test('a malformed dispatch still produces a report instead of throwing', () => {
  const trigger = detectTrigger([{ sessionId: 'orch-1', event: dispatchOf('不是 JSON') }], registry)
  const report = buildPlanReport({ session: { id: 'orch-1' }, trigger, workers: [], now: 1 })
  assert.deepEqual(report.steps, [])
  assert.deepEqual(report.workers, [])
  assert.deepEqual(report.acceptance, [])
  // 参数读不出来时说清楚，而不是假装有估计。
  assert.equal(report.estimate.basis, 'undisclosed')
  assert.equal(report.estimate.seconds, null)
  assert.equal(report.trigger.callId, 'call-1')
})
