import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import * as fsp from 'node:fs/promises'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  fs,
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
  }

  const secretary = mod.attachSecretary(ctx, config, {
    registration,
    now: timer.now,
    schedule: timer.schedule,
    cancel: timer.cancel,
    ...(drafts === undefined ? {} : { drafts }),
    ...(fs === undefined ? {} : { fs }),
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
  const files = async (sessionId) => (await readdir(reportDir(sessionId))).sort()

  return {
    secretary,
    timer,
    messages,
    logs,
    effects,
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

test('a tracked dispatch starts the beat, and nine minutes produce three delta reports', async () => {
  await withDir(async (dir) => {
    const h = harness({ dir })
    await h.dispatch()
    assert.deepEqual(await h.files('orch-1'), ['09-00.md'], 'the planning report is the first file')

    h.timer.advance(9 * MINUTE)
    await h.secretary.settled()

    assert.deepEqual(await h.files('orch-1'), ['09-00.md', '09-03.md', '09-06.md', '09-09.md'])
    assert.match(await readFile(join(h.reportDir('orch-1'), '09-00.md'), 'utf8'), /^# 秘书规划$/m)
    for (const name of ['09-03.md', '09-06.md', '09-09.md']) {
      const body = await readFile(join(h.reportDir('orch-1'), name), 'utf8')
      assert.match(body, /^# 秘书汇报$/m, name)
      assert.match(body, /- 类型：增量/, name)
      // 会话名与规划首报同一规则：标题优先，缺标题才退回会话 id。
      assert.match(body, /- 会话：修登录/, name)
      assert.match(body, /\| worker-1 \| Working \|/, name)
    }
    assert.match(await readFile(join(h.reportDir('orch-1'), '09-03.md'), 'utf8'), /已跑时长：3 分 00 秒/)
    assert.match(await readFile(join(h.reportDir('orch-1'), '09-09.md'), 'utf8'), /已跑时长：9 分 00 秒/)
  })
})

test('a tick with no substantial change writes its report and delivers nothing', async () => {
  await withDir(async (dir) => {
    const h = harness({ dir })
    await h.dispatch()

    // 第一拍没有上一份摘要，按投影的初始态（Idle、无 worker）比较，所以它是有变化的。
    h.timer.advance(BEAT)
    await h.secretary.settled()
    assert.equal(h.messages.length, 1, 'the first delta is compared with the baseline')

    // 第二拍什么都不变：文件照写，一个人都不打扰。
    h.messages.length = 0
    h.timer.advance(BEAT)
    await h.secretary.settled()
    assert.equal(h.messages.length, 0, 'nothing changed, so nobody is interrupted')
    assert.deepEqual(await h.files('orch-1'), ['09-00.md', '09-03.md', '09-06.md'])
  })
})

test('a state flip delivers exactly one bubble, and only to the Master', async () => {
  await withDir(async (dir) => {
    const h = harness({ dir, orchestrators: [{ id: 'orch-1', state: 'Working' }] })
    await h.dispatch()
    h.timer.advance(BEAT)
    await h.secretary.settled()
    h.messages.length = 0

    // worker 还在跑，所以"两次都收工"不成立；会话自己的六态从 Working 翻到 Idle。
    h.setState('orch-1', 'Idle')
    h.timer.advance(BEAT)
    await h.secretary.settled()

    assert.equal(h.messages.length, 1, 'one flip, one bubble')
    assert.equal(h.messages[0].to, 'master-1', 'the declared Master is the only receiver')
    assert.match(h.messages[0].text, /^秘书：状态翻转/)
    assert.equal(h.timer.pendingCount(), 1, 'a worker is still running, so the beat keeps going')
  })
})

test('secretaryNotifyOn gates the bubble, not the file', async () => {
  await withDir(async (dir) => {
    const h = harness({ dir, notifyOn: ['blocked'] })
    await h.dispatch()
    h.timer.advance(BEAT)
    await h.secretary.settled()

    assert.equal(h.messages.length, 0, 'a state flip is not one of the allowed kinds')
    assert.deepEqual(await h.files('orch-1'), ['09-00.md', '09-03.md'], 'the report is written anyway')
  })
})

test('a failing delivery is only logged, and the report stays on disk', async () => {
  await withDir(async (dir) => {
    const h = harness({
      dir,
      messaging: {
        async deliver() {
          throw new Error('the Master session is gone')
        },
      },
    })
    await h.dispatch()
    h.timer.advance(BEAT)
    await h.secretary.settled()

    assert.deepEqual(await h.files('orch-1'), ['09-00.md', '09-03.md'])
    assert.ok(
      h.logs.some((message) => /notice was not delivered/.test(message)),
      'the failure is recorded in the log',
    )
    assert.equal(h.timer.pendingCount(), 1, 'a lost bubble does not stop the beat')
  })
})

test('two settled ticks stop the beat, and a stopped beat writes nothing more', async () => {
  await withDir(async (dir) => {
    const h = harness({ dir, workers: [{ id: 'worker-1', parent: 'orch-1', state: 'Completed' }] })
    await h.dispatch()

    h.timer.advance(BEAT)
    await h.secretary.settled()
    assert.equal((await h.files('orch-1')).length, 2)

    // 上一拍是 Working，这一拍是 Idle：还没连续两次收工，继续走。
    h.setState('orch-1', 'Idle')
    h.timer.advance(BEAT)
    await h.secretary.settled()
    assert.equal((await h.files('orch-1')).length, 3)

    // 两次都是 Idle 且没有 worker 在跑：这一拍写完就停表。
    h.timer.advance(BEAT)
    await h.secretary.settled()
    assert.equal((await h.files('orch-1')).length, 4)
    assert.equal(h.timer.pendingCount(), 0, 'a finished run leaves no timer')

    h.timer.advance(60 * MINUTE)
    await h.secretary.settled()
    assert.equal((await h.files('orch-1')).length, 4, 'a stopped beat writes nothing')
  })
})

test('the run cap stops the beat by itself', async () => {
  await withDir(async (dir) => {
    // 两小时的上限压到十分钟：180s、360s、540s 三拍在界内，720s 那一拍越界，节拍自己停。
    const h = harness({ dir, maxRunSeconds: 600 })
    await h.dispatch()
    h.timer.advance(12 * MINUTE)
    await h.secretary.settled()

    assert.deepEqual(await h.files('orch-1'), ['09-00.md', '09-03.md', '09-06.md', '09-09.md'])
    assert.equal(h.timer.pendingCount(), 0, 'the cap leaves no timer behind')

    h.timer.advance(60 * MINUTE)
    await h.secretary.settled()
    assert.equal((await h.files('orch-1')).length, 4, 'past the cap nothing is written')
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
    assert.deepEqual(await h.files('orch-1'), ['09-00.md'])
    assert.deepEqual(await h.files('orch-2'), ['09-00.md'])

    h.unload()
    assert.equal(h.timer.pendingCount(), 0, 'every beat is stopped on unload')

    h.timer.advance(60 * MINUTE)
    await h.secretary.settled()
    assert.deepEqual(await h.files('orch-1'), ['09-00.md'], 'no report may be written after unload')
    assert.deepEqual(await h.files('orch-2'), ['09-00.md'])
  })
})

test('a planning report that fails to write spends no trigger, so the next dispatch retries', async () => {
  await withDir(async (dir) => {
    // The first write fails the way a full disk would; the retry must still be allowed.
    let failures = 1
    const flaky = {
      async mkdir(...args) {
        return fsp.mkdir(...args)
      },
      async writeFile(...args) {
        if (failures > 0) {
          failures -= 1
          throw new Error('disk full')
        }
        return fsp.writeFile(...args)
      },
    }
    const h = harness({ dir, fs: flaky })

    await h.dispatch()
    assert.deepEqual(await h.files('orch-1'), [], 'the failed write left no planning report')
    assert.equal(h.secretary.triggerState.has('orch-1'), false, 'the trigger was not spent')
    assert.ok(
      h.logs.some((message) => /cannot write the planning report/.test(message)),
      'the failure is recorded in the log',
    )

    await h.dispatch()
    assert.deepEqual(await h.files('orch-1'), ['09-00.md'], 'the second dispatch writes the planning report')
    assert.equal(h.secretary.triggerState.has('orch-1'), true, 'and now the trigger is spent')
  })
})

test('the beat drafts the blocker each tick, and a decided draft does not block the next tick', async () => {
  await withDir(async (dir) => {
    const drafts = createDraftStore()
    const h = harness({ dir, orchestrators: [{ id: 'orch-1', state: 'Needs input' }], workers: [], drafts })

    await h.dispatch()
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
