import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReporter } from '../lib/reporter.js'
import { createDraftStore } from '../lib/secretary-nudge.js'
import { collectOrchestratorRows } from '../lib/secretary-panel.js'

/**
 * 秘书的节拍（秘书 spec 票 05）在这里被真的跑一遍：dispatch 之后用假时钟把九分钟推完，
 * 断言的是磁盘上的增量报告和收到的冒泡，而不是"节拍器函数能自测"。
 *
 * 三件宿主包这一个文件用不到，插件入口却必须导入它们，所以照 test/index.test.mjs 的
 * 先例换成 data: URL 的替身；真正被驱动的是 lib/index.js 的 attachSecretary。
 */
const dataUrl = (source) => 'data:text/javascript,' + encodeURIComponent(source)

const STUBS = {
  '@deepseek-ai/schemastery': `
    function chain() {
      const node = { defaultValue: undefined, minValue: undefined, maxValue: undefined, volatileFlag: false }
      node.default = (value) => { node.defaultValue = value; return node }
      node.volatile = () => { node.volatileFlag = true; return node }
      node.min = (value) => { node.minValue = value; return node }
      node.max = (value) => { node.maxValue = value; return node }
      node.step = () => node
      node.description = () => node
      return node
    }
    const z = {
      boolean: () => chain(),
      string: () => chain(),
      number: () => chain(),
      array: (item) => Object.assign(chain(), { item }),
      object: (shape) => Object.assign(chain(), { shape }),
    }
    export default z
  `,
  '@deepseek-ai/dsh-tools': `
    export function defineTool(spec) { return spec }
  `,
  zod: `
    const chain = () => {
      const node = {}
      node.default = () => chain()
      node.min = () => node
      node.max = () => node
      node.int = () => node
      node.nonnegative = () => node
      node.strict = () => node
      node.optional = () => node
      return node
    }
    const z = {
      object: () => chain(),
      enum: () => ({}),
      boolean: () => ({}),
      string: () => chain(),
      number: () => chain(),
      array: () => chain(),
    }
    export { z }
    export default z
  `,
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = STUBS[specifier]
    if (stub !== undefined) return { url: dataUrl(stub), shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

const mod = await import(new URL('../lib/index.js', import.meta.url).href)

const MINUTE = 60_000
const BEAT = 3 * MINUTE
/** 本地时间 09:00 整：报告文件名是本地时间，这样每一拍落在 09-03 / 09-06 / 09-09。 */
const START = new Date(2025, 0, 1, 9, 0, 0).getTime()
const REPORT_ROOT = ['.scratch', 'master-secretary', 'reports']

/**
 * 手推的时钟与定时器（与 test/secretary-beat.test.mjs 同一份形状）。advance 把虚拟
 * 时间推到目标，并把过程中到点的定时器按先后依次触发。
 */
function fakeClock(startAt) {
  let current = startAt
  let nextId = 1
  const pending = new Map()
  return {
    now: () => current,
    schedule(fn, ms) {
      const id = nextId
      nextId += 1
      pending.set(id, { id, fn, dueAt: current + ms })
      return id
    },
    cancel(id) {
      pending.delete(id)
    },
    advance(ms) {
      const target = current + ms
      for (;;) {
        let due
        for (const timer of pending.values()) {
          if (timer.dueAt <= target && (due === undefined || timer.dueAt < due.dueAt)) due = timer
        }
        if (due === undefined) break
        pending.delete(due.id)
        current = due.dueAt
        due.fn()
      }
      current = target
    },
    pendingCount: () => pending.size,
  }
}

function dispatchEvent(args, { callId = 'call-1', time = 1000 } = {}) {
  return { type: 'tool/call', time, data: { turn: 1, step: 1, callId, name: 'dispatch', arguments: JSON.stringify(args) } }
}

/**
 * 一个只提供秘书要用的那几样东西的宿主替身：会话名单、六态投影、事件订阅、日志。
 * 投影是逐会话的（一个会话一行），状态可以随时改，用来制造翻转。
 */
function harness({
  dir,
  orchestrators = [{ id: 'orch-1', state: 'Working', title: '修登录' }],
  workers = [{ id: 'worker-1', parent: 'orch-1', state: 'Working' }],
  notifyOn = ['state-flip', 'step-advance', 'blocked', 'deliverable', 'timeout'],
  beatSeconds = 180,
  maxRunSeconds = 7200,
  messaging,
  drafts,
  projectionStateOf,
} = {}) {
  const timer = fakeClock(START)
  const messages = []
  const logs = []
  const effects = []
  const handlers = new Map()

  const rows = new Map()
  for (const row of orchestrators) rows.set(row.id, { id: row.id, state: row.state, summary: row.summary ?? '' })
  for (const row of workers) rows.set(row.id, { id: row.id, state: row.state, summary: row.summary ?? '' })

  const sessionList = [
    ...orchestrators.map((row) => ({ id: row.id, title: row.title ?? '', header: { id: row.id, cwd: dir } })),
    ...workers.map((row) => ({ id: row.id, header: { id: row.id, parentSession: row.parent, origin: 'subagent' } })),
  ]

  const registration = {
    stateOf(session) {
      const row = rows.get(session?.id)
      if (row === undefined) return { workers: [] }
      return {
        workers: [
          {
            id: row.id,
            role: session.header?.parentSession === undefined ? 'main' : 'worker',
            state: row.state,
            summary: row.summary,
          },
        ],
      }
    },
  }

  const config = {
    secretaryEnabled: { get: () => true },
    secretaryMasterSessionId: { get: () => 'master-1' },
    secretaryOrchestrators: {
      get: () => orchestrators.map((row) => ({ sessionId: row.id, workspace: dir, title: row.title ?? '', trackedAt: 1 })),
    },
    secretaryBeatSeconds: { get: () => beatSeconds },
    secretaryMaxRunSeconds: { get: () => maxRunSeconds },
    secretaryNotifyOn: { get: () => notifyOn },
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
    logger: {
      info: () => {},
      warn: (message) => logs.push(message),
    },
    sessions: {
      get: (id) => sessionList.find((session) => session.id === id),
      list: () => sessionList,
      flush: async () => true,
    },
    agents: { get: () => ({ id: 'master-1', status: 'idle' }) },
    // registry 级投影读法 `(session, key)`：生产里由 dsh-session-projection 提供，
    // 秘书用 `todos` 填步骤。不给就当作宿主没有这份投影。
    ...(projectionStateOf === undefined ? {} : { sessionProjections: { stateOf: projectionStateOf } }),
  }

  const secretary = mod.attachSecretary(ctx, config, {
    registration,
    now: timer.now,
    schedule: timer.schedule,
    cancel: timer.cancel,
    ...(drafts === undefined ? {} : { drafts }),
    ...(messaging === undefined
      ? {
          messaging: {
            async deliver(to, text) {
              messages.push({ to, text })
              return { delivered: true }
            },
          },
        }
      : { messaging }),
  })

  const reportDir = (sessionId) => join(dir, ...REPORT_ROOT, sessionId)
  // 票 21 之后这里再也不会生成目录：读不到就是「一份都没写」，不是测试错误。
  const files = async (sessionId) => {
    try {
      return (await readdir(reportDir(sessionId))).sort()
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
  }

  // 报告不再落盘之后，步骤语义仍然由视图端点使用同一份 todos 读法（createSecretaryViewRead）。
  const readView = async () =>
    mod.createSecretaryViewRead({ ctx, config, registration, beatStatus: secretary.beatStatus })()

  return {
    secretary,
    timer,
    messages,
    logs,
    effects,
    readView,
    readStep: async () => (await readView()).orchestrators[0]?.step ?? null,
    handlers,
    rows,
    drafts,
    reportDir,
    files,
    setState: (id, state) => {
      rows.get(id).state = state
    },
    dispatch: (sessionId = 'orch-1') => {
      const session = sessionList.find((row) => row.id === sessionId)
      const listener = handlers.get('session/event')
      return listener(session, dispatchEvent({ description: '修登录', prompt: '让重试可用' }))
    },
    unload: () => {
      const entry = effects.find(({ label }) => label === 'orchestrator: secretary watch')
      assert.ok(entry !== undefined, 'the watch must own an effect so an unload removes it')
      return entry.dispose()
    },
  }
}

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'secretary-runtime-'))
  try {
    return await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('a tracked dispatch starts the beat, and nine minutes produce three ticks with no report file', async () => {
  await withDir(async (dir) => {
    const h = harness({ dir })
    await h.dispatch()
    assert.deepEqual(await h.files('orch-1'), [], 'the planning report is retired (ticket 21)')

    h.timer.advance(9 * MINUTE)
    await h.secretary.settled()

    assert.deepEqual(await h.files('orch-1'), [], 'the delta reports moved to lib/reporter.js')
    assert.equal(h.secretary.beatStatus('orch-1').tickIndex, 3, 'the beat still ticks: drafts and settle detection')
    assert.equal(h.messages.length, 0, 'the retired path bubbles to nobody')
    assert.equal(
      h.logs.filter((message) => /lib\/reporter\.js \(ticket 21\)/.test(message)).length,
      1,
      'the migration is announced exactly once',
    )
  })
})

test('the retired archive and the new reporter never coexist: one stays empty while the other reports', async () => {
  await withDir(async (dir) => {
    const h = harness({ dir })
    const reporter = createReporter({
      assignments: () => ({}),
      attention: () => ({}),
      now: h.timer.now,
      schedule: h.timer.schedule,
      cancel: h.timer.cancel,
    })
    reporter.start()
    await h.dispatch()

    h.timer.advance(9 * MINUTE)
    await h.secretary.settled()

    assert.deepEqual(await h.files('orch-1'), [], 'the old path produces no report file')
    assert.equal(h.messages.length, 0, 'and no bubble')
    assert.equal(reporter.count(), 3, 'the new reporter produced its reports on the same clock')
    assert.ok(reporter.latest() !== null, 'so there is exactly one report source, not two')
    reporter.stop('test-end')
  })
})

test('a tick writes no report and interrupts nobody', async () => {
  await withDir(async (dir) => {
    const h = harness({ dir })
    await h.dispatch()

    h.timer.advance(BEAT)
    await h.secretary.settled()
    assert.equal(h.messages.length, 0, 'the first tick used to bubble against the baseline; now it does not')

    h.timer.advance(BEAT)
    await h.secretary.settled()
    assert.equal(h.messages.length, 0, 'nothing is delivered from the retired path at all')
    assert.deepEqual(await h.files('orch-1'), [], 'and nothing is written either')
    assert.equal(h.secretary.beatStatus('orch-1').tickIndex, 2)
  })
})

test('a state flip no longer bubbles: the report belongs to the dock now', async () => {
  await withDir(async (dir) => {
    const h = harness({ dir, orchestrators: [{ id: 'orch-1', state: 'Working' }] })
    await h.dispatch()
    h.timer.advance(BEAT)
    await h.secretary.settled()

    // worker 还在跑，所以"两次都收工"不成立；会话自己的六态从 Working 翻到 Idle。
    h.setState('orch-1', 'Idle')
    h.timer.advance(BEAT)
    await h.secretary.settled()

    assert.equal(h.messages.length, 0, 'no bubble may come out of the retired path')
    assert.equal(h.timer.pendingCount(), 1, 'a worker is still running, so the beat keeps going')
  })
})

test('the retired path ignores secretaryNotifyOn: there is neither a bubble nor a file to gate', async () => {
  await withDir(async (dir) => {
    const h = harness({ dir, notifyOn: ['blocked'] })
    await h.dispatch()
    h.timer.advance(BEAT)
    await h.secretary.settled()

    assert.equal(h.messages.length, 0, 'nothing is delivered, whatever the switch says')
    assert.deepEqual(await h.files('orch-1'), [], 'and nothing is written either')
    assert.equal(h.secretary.beatStatus('orch-1').tickIndex, 1, 'the beat itself is unaffected by the switch')
  })
})

test('the retired path never calls the delivery channel', async () => {
  await withDir(async (dir) => {
    let calls = 0
    const h = harness({
      dir,
      messaging: {
        async deliver() {
          calls += 1
          throw new Error('the Master session is gone')
        },
      },
    })
    await h.dispatch()
    h.timer.advance(BEAT)
    await h.secretary.settled()

    assert.equal(calls, 0, 'the report path no longer delivers anything, so a broken channel cannot matter')
    assert.deepEqual(await h.files('orch-1'), [], 'nor does it write a file')
    assert.equal(h.timer.pendingCount(), 1, 'the beat keeps going')
  })
})

test('two settled ticks stop the beat, and a stopped beat does nothing more', async () => {
  await withDir(async (dir) => {
    const h = harness({ dir, workers: [{ id: 'worker-1', parent: 'orch-1', state: 'Completed' }] })
    await h.dispatch()

    h.timer.advance(BEAT)
    await h.secretary.settled()
    assert.deepEqual(await h.files('orch-1'), [], 'the retired path writes no report')

    // 上一拍是 Working，这一拍是 Idle：还没连续两次收工，继续走。
    h.setState('orch-1', 'Idle')
    h.timer.advance(BEAT)
    await h.secretary.settled()
    assert.equal(h.secretary.beatStatus('orch-1').tickIndex, 2, 'one settled tick is not enough')
    assert.equal(h.timer.pendingCount(), 1)

    // 两次都是 Idle 且没有 worker 在跑：这一拍就停表（不再有「这一拍写完」这一步）。
    h.timer.advance(BEAT)
    await h.secretary.settled()
    assert.equal(h.secretary.beatStatus('orch-1').tickIndex, 3)
    assert.equal(h.secretary.beatStatus('orch-1').stopReason, 'finished')
    assert.equal(h.timer.pendingCount(), 0, 'a finished run leaves no timer')

    h.timer.advance(60 * MINUTE)
    await h.secretary.settled()
    assert.equal(h.secretary.beatStatus('orch-1').tickIndex, 3, 'a stopped beat does nothing more')
    assert.deepEqual(await h.files('orch-1'), [], 'and it never wrote a file on the way out')
  })
})

test('the run cap stops the beat by itself', async () => {
  await withDir(async (dir) => {
    // 两小时的上限压到十分钟：180s、360s、540s 三拍在界内，720s 那一拍越界，节拍自己停。
    const h = harness({ dir, maxRunSeconds: 600 })
    await h.dispatch()
    h.timer.advance(12 * MINUTE)
    await h.secretary.settled()

    assert.equal(h.secretary.beatStatus('orch-1').tickIndex, 3)
    assert.equal(h.timer.pendingCount(), 0, 'the cap leaves no timer behind')
    assert.deepEqual(await h.files('orch-1'), [], 'the capped beat wrote nothing either')

    h.timer.advance(60 * MINUTE)
    await h.secretary.settled()
    assert.equal(h.secretary.beatStatus('orch-1').tickIndex, 3, 'past the cap nothing more happens')
  })
})

test('unloading the plugin stops every beat and leaves no timer', async () => {
  await withDir(async (dir) => {
    const h = harness({
      dir,
      orchestrators: [
        { id: 'orch-1', state: 'Working' },
        { id: 'orch-2', state: 'Working' },
      ],
      workers: [],
    })
    await h.dispatch('orch-1')
    await h.dispatch('orch-2')
    assert.equal(h.timer.pendingCount(), 2, 'one beat per tracked session')
    assert.deepEqual(await h.files('orch-1'), [])
    assert.deepEqual(await h.files('orch-2'), [])

    h.unload()
    assert.equal(h.timer.pendingCount(), 0, 'every beat is stopped on unload')

    h.timer.advance(60 * MINUTE)
    await h.secretary.settled()
    assert.deepEqual(await h.files('orch-1'), [], 'no report may be written after unload')
    assert.deepEqual(await h.files('orch-2'), [])
  })
})

test('the planning report is retired: the first dispatch writes nothing and spends the trigger', async () => {
  await withDir(async (dir) => {
    const h = harness({ dir })

    await h.dispatch()
    assert.deepEqual(await h.files('orch-1'), [], 'no planning report is written any more (ticket 21)')
    assert.equal(h.secretary.triggerState.has('orch-1'), true, 'the trigger is spent at once; no write gates it')
    assert.equal(h.timer.pendingCount(), 1, 'the beat still starts')

    await h.dispatch()
    assert.equal(h.timer.pendingCount(), 1, 'a second dispatch must not stack a second beat')
    assert.deepEqual(await h.files('orch-1'), [], 'and still nothing is written')
  })
})

test('the beat drafts the blocker each tick, and a decided draft does not block the next tick', async () => {
  await withDir(async (dir) => {
    const drafts = createDraftStore()
    const h = harness({ dir, orchestrators: [{ id: 'orch-1', state: 'Needs input' }], workers: [], drafts })

    await h.dispatch()
    // 挂载初始化是异步的；dispatch 不再等一次写盘，所以这里显式等它落定。
    await h.secretary.ready
    assert.equal(drafts.list().length, 1, 'the mount initialization drafts the current blocker')
    assert.equal(drafts.list()[0].status, 'pending')

    h.timer.advance(BEAT)
    await h.secretary.settled()
    assert.equal(drafts.list().length, 1, 'the tick reuses the same pending draft')

    const draft = drafts.list()[0]
    drafts.decide(draft.id, 'discarded', 2)
    h.timer.advance(BEAT)
    await h.secretary.settled()
    assert.equal(drafts.list().length, 2, 'a decided draft does not block the next tick from drafting again')
    assert.equal(drafts.list().filter((row) => row.status === 'pending').length, 1)
  })
})

test('the view beats follow the real beat: count grows per tick and capped after the run cap', async () => {
  await withDir(async (dir) => {
    const h = harness({ dir, maxRunSeconds: 600 })
    const rowBeats = () =>
      collectOrchestratorRows({
        registry: { orchestrators: [{ sessionId: 'orch-1', workspace: dir, title: '修登录', trackedAt: 1 }] },
        sessions: [{ id: 'orch-1', header: { id: 'orch-1' } }],
        beatStatus: h.secretary.beatStatus,
      })[0].beats

    await h.dispatch()
    assert.deepEqual(rowBeats(), { count: 0, startedAt: START, capped: false, stoppedReason: null })

    h.timer.advance(BEAT)
    await h.secretary.settled()
    assert.equal(rowBeats().count, 1, 'one tick, one count')

    // 180s / 360s / 540s tick; the 720s tick is past the 600s cap, so the beat stops itself.
    h.timer.advance(9 * MINUTE)
    await h.secretary.settled()
    const capped = rowBeats()
    assert.equal(capped.count, 3)
    assert.equal(capped.capped, true)
    assert.equal(capped.stoppedReason, 'max-run')
  })
})
// ---- 步骤来源（交接文档 Next 第 3 条）：六态投影的 step 读宿主 `todos` 投影 --------
//
// 语义钉死在这里：total = 列表长度；index = 第一个 status 为 in_progress 的条目
// 1-based 下标；没有 in_progress 时 index = 已 completed 条数（不超过 total）；
// 空列表 / null / undefined / 抛错 / 非数组一律保持 step: null。
// 报告停产之后，视图端点行上的 step 是这条语义的出口，所以断言落在 readStep 上。

test('the step is the first in_progress todo, over the whole list length (why: the six-state projection hardcoded step: null)', async () => {
  await withDir(async (dir) => {
    const todos = [
      { id: 'a', status: 'completed' },
      { id: 'b', status: 'in_progress' },
      { id: 'c', status: 'pending' },
    ]
    const h = harness({ dir, projectionStateOf: (session, key) => (key === 'todos' ? todos : undefined) })
    await h.dispatch()
    h.timer.advance(BEAT)
    await h.secretary.settled()

    // 报告不再落盘；步骤的出口只剩视图端点，读法与 todos 投影都没有变。
    assert.deepEqual(await h.files('orch-1'), [], 'the retired path writes no report')
    assert.deepEqual(await h.readStep(), { index: 2, total: 3 }, 'total 是列表长度，index 是 in_progress 的 1-based 下标')
    assert.equal(h.messages.length, 0, 'and nothing bubbles any more')
  })
})

test('with no in_progress entry the step index is the completed count', async () => {
  await withDir(async (dir) => {
    const todos = [
      { id: 'a', status: 'completed' },
      { id: 'b', status: 'completed' },
      { id: 'c', status: 'completed' },
    ]
    const h = harness({ dir, projectionStateOf: (session, key) => (key === 'todos' ? todos : undefined) })
    await h.dispatch()
    h.timer.advance(BEAT)
    await h.secretary.settled()

    assert.deepEqual(await h.files('orch-1'), [], 'the retired path writes no report')
    assert.deepEqual(await h.readStep(), { index: 3, total: 3 }, '全 completed：index = 已完成的条数，不超过 total')
  })
})

test('a null todos state keeps the step empty without writing a report', async () => {
  await withDir(async (dir) => {
    // 宿主对没写过的 todos 投影返回 null（init 值）。
    const h = harness({ dir, projectionStateOf: () => null })
    await h.dispatch()
    h.timer.advance(BEAT)
    await h.secretary.settled()

    assert.equal(await h.readStep(), null, 'null 不能变成一个编出来的步骤')
    assert.deepEqual(await h.files('orch-1'), [], '投影缺一份可选字段，旧路径也不再落盘')
  })
})

test('an undefined todos state keeps the step empty', async () => {
  await withDir(async (dir) => {
    // 宿主对未注册或已释放的 key 返回 undefined。
    const h = harness({ dir, projectionStateOf: () => undefined })
    await h.dispatch()
    h.timer.advance(BEAT)
    await h.secretary.settled()

    assert.equal(await h.readStep(), null)
    assert.deepEqual(await h.files('orch-1'), [])
  })
})

test('a throwing todos read never fails the tick: the step is empty and no report file appears', async () => {
  await withDir(async (dir) => {
    const h = harness({
      dir,
      projectionStateOf: () => {
        throw new Error('the todos projection is unavailable')
      },
    })
    await h.dispatch()
    h.timer.advance(BEAT)
    await h.secretary.settled()

    assert.equal(await h.readStep(), null, '抛错也退回 null，不硬塞步骤')
    assert.deepEqual(await h.files('orch-1'), [], '读不到 todos 也不会有报告文件')
    assert.ok(
      h.logs.some((message) => /todos/.test(message)),
      '降级读法进日志，下一次协议坏了能看见',
    )
    assert.equal(
      h.logs.some((message) => /a beat tick of orch-1 failed/.test(message)),
      false,
      '整拍不能因为这一步失败',
    )
  })
})
