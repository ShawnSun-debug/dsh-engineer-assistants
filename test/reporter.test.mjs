import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { assignSession, finishSession, reserveChildId } from '../lib/assignments.js'
import { panelPayloadOf } from '../lib/panel-remote.js'
import {
  CADENCE_MS,
  CAP_MS,
  ITEM_LABELS,
  REQUIRED_ITEMS,
  archivePath,
  composeReport,
  createReporter,
  renderReport,
  reportDue,
  snapshotOf,
  stampOf,
  summaryLine,
  summaryPath,
} from '../lib/reporter.js'

// 本地时间构造：归档与兄弟模块一致用操作者的时钟。
const AT = new Date(2026, 10, 8, 12, 5, 0)

test('the rhythm is three minutes, the cap two hours, five required items', () => {
  assert.equal(CADENCE_MS, 180000)
  assert.equal(CAP_MS, 7200000)
  assert.deepEqual([...REQUIRED_ITEMS], ['running', 'stuck', 'finished', 'cost', 'next'])
  assert.deepEqual(Object.keys(ITEM_LABELS), [...REQUIRED_ITEMS], 'labels stay in item order')
})

test('the first report is due immediately, then every three minutes', () => {
  assert.deepEqual(reportDue({ startedAt: 0, now: 1000 }), { due: true, reason: 'first' })
  assert.deepEqual(reportDue({ startedAt: 0, now: 1000, lastReportAt: 1000 }), { due: false, reason: 'cadence' })
  assert.deepEqual(reportDue({ startedAt: 0, now: 1000 + CADENCE_MS, lastReportAt: 1000 }), { due: true, reason: 'cadence' })
})

test('nothing is reported after the two-hour cap', () => {
  assert.deepEqual(reportDue({ startedAt: 0, now: CAP_MS, lastReportAt: 0 }), { due: false, reason: 'capped' })
  assert.equal(reportDue({ startedAt: 0, now: CAP_MS - 1, lastReportAt: 0 }).due, true)
})

test('reportDue refuses nonsense times', () => {
  assert.throws(() => reportDue({ startedAt: Number.NaN, now: 0 }), /finite numbers/)
  assert.throws(() => reportDue({ startedAt: 0 }), /finite numbers/)
})

test('a full report has one labelled line per required item, in order', () => {
  const { text, oneLine } = renderReport({
    at: AT,
    snapshot: { running: 'w1 跑了 12 分钟', stuck: '', finished: ['a', 'b'], cost: 0.3, next: '先看 w2' },
  })
  assert.equal(oneLine, false)
  const itemLines = text.split('\n').filter((line) => line.startsWith('- **'))
  assert.equal(itemLines.length, 5)
  REQUIRED_ITEMS.forEach((key, index) => {
    assert.ok(itemLines[index].includes(ITEM_LABELS[key]), `item ${index} must be ${key}`)
  })
  // 从导出的标签表拼，不写死文案：改一处标签不该让另一处断言悄悄失配。
  assert.ok(text.includes(`**${ITEM_LABELS.stuck}**：无`), 'an empty item reads 无 under its own label')
  assert.equal(itemLines[REQUIRED_ITEMS.indexOf('cost')], '- **花费**：0.3', 'an amount is a number, not a count')
})

test('counts take 个, an amount stays a plain number', () => {
  const { text } = renderReport({ at: AT, snapshot: { running: 3, stuck: { count: 2 }, cost: 12 } })
  assert.deepEqual(
    text.split('\n').filter((line) => line.startsWith('- **')),
    ['- **在跑**：3 个', '- **卡住 / 等批准**：2 个', '- **刚完成的产出与验证**：无', '- **花费**：12', '- **建议下一步**：无'],
  )
})

test('a multi-line detail is collapsed into one line', () => {
  const { text } = renderReport({ at: AT, snapshot: { running: 'line one\nline two\n\nline three' } })
  assert.match(text, /在跑\*\*：line one line two line three/)
  assert.equal(text.split('\n').filter((line) => line.startsWith('- **')).length, 5)
})

test('the render is deterministic', () => {
  const snapshot = { running: 'a', stuck: 'b', finished: 'c', cost: 'd', next: 'e' }
  assert.equal(renderReport({ at: AT, snapshot }).text, renderReport({ at: AT, snapshot }).text)
})

test('only a genuinely empty snapshot collapses to one line', () => {
  const empty = renderReport({ at: AT, snapshot: {} })
  assert.equal(empty.oneLine, true)
  assert.match(empty.text, /无变化/)
  const busy = renderReport({ at: AT, snapshot: { running: 'w1 跑了 12 分钟' } })
  assert.equal(busy.oneLine, false)
  assert.equal(busy.text.split('\n').filter((line) => line.startsWith('- **')).length, 5)
})

test('archive paths use the local clock and join under the master cwd', () => {
  assert.equal(
    archivePath({ cwd: 'D:/work', at: AT }),
    join('D:/work', '.scratch', 'engineer-assistants', 'reports', '2026-11-08', '12-05.md'),
  )
  // 用 join 拼：Windows 的 cwd 不会拼出 "D:\work/.scratch/..." 这种混合分隔符。
  assert.equal(archivePath({ cwd: 'D:\\work', at: AT }).includes('D:\\work/.scratch'), false)
  assert.ok(archivePath({ cwd: 'D:/work', at: AT }).endsWith(join('2026-11-08', '12-05.md')))
  assert.ok(summaryPath({ cwd: 'D:/work' }).endsWith(join('reports', '_summary.md')))
  assert.throws(() => archivePath({ cwd: '', at: AT }), /master cwd is required/)
  assert.throws(() => archivePath({ cwd: 'D:/work', at: 'nope' }), /valid Date/)
})

test('stampOf accepts a Date, epoch ms and an ISO string', () => {
  assert.deepEqual(stampOf(new Date(2026, 0, 2, 3, 4, 5)), { day: '2026-01-02', time: '03-04' })
  assert.deepEqual(stampOf(new Date(2026, 0, 2, 3, 4, 5).getTime()), { day: '2026-01-02', time: '03-04' })
  assert.deepEqual(stampOf(new Date(2026, 0, 2, 3, 4, 5).toISOString()), { day: '2026-01-02', time: '03-04' })
  assert.deepEqual(stampOf(0), stampOf(new Date(0)), 'epoch ms 0 is a real timestamp, not an error')
})

test('stampOf refuses the values Date silently coerces to the epoch', () => {
  // new Date(null) 和 new Date(true) 都不报错，它们给出 epoch：照着归档，每份 at:null 的汇报
  // 会全部落在同一个文件上互相覆盖。必须在构造之前先验类型。
  for (const bad of [null, undefined, true, false, {}, [], '', '   ', Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => stampOf(bad), /valid Date/, `must refuse ${JSON.stringify(bad)}`)
  }
  // 非法 Date 实例走的是另一道关：类型合法、值非法，靠构造后的 NaN 检查挡住。
  // 少了这一条，那道检查被重构掉也不会有测试变红。
  assert.throws(() => stampOf(new Date('nope')), /valid Date/, 'an invalid Date instance is refused after construction')
  assert.throws(() => archivePath({ cwd: 'D:/work', at: null }), /valid Date/)
})

test('the summary line never claims 无变化 while something is running', () => {
  const working = summaryLine({ at: AT, snapshot: { running: 'w1 跑了 12 分钟', cost: '0.30' } })
  assert.equal(working, '- 2026-11-08 12:05 · w1 跑了 12 分钟')
  assert.equal(summaryLine({ at: AT, snapshot: {} }), '- 2026-11-08 12:05 · 无变化')
  assert.equal(summaryLine({ at: AT, snapshot: { finished: '两个测试通过' } }), '- 2026-11-08 12:05 · 两个测试通过')
})
// ---- 票 21：节拍接线与落座 ---------------------------------------------------------------
//
// 这一半测的是「每三分钟一份、两小时自停、只保留最近一份」，时钟与定时器全部注入；
// 没有一条测试等真实的三分钟。

const MINUTE = 60_000

/** 与 test/secretary-beat.test.mjs 同一份手推时钟：advance 只触发到点的定时器。 */
function fakeTimer(startAt = 1_000_000) {
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

test('the snapshot comes from the registry and the inspector, never from a guess', () => {
  // 登记表：两个在跑、一个只预占、两个已结束。监工：两个卡着，理由不同。
  let table = reserveChildId({}, { id: 'w-1', parentId: 'p', startedAt: 1000 })
  table = assignSession(table, { sessionId: 'w-1', kind: 'worker', parentId: 'p', status: 'running', startedAt: 1000 })
  table = reserveChildId(table, { id: 'w-2', parentId: 'p', startedAt: 2000 })
  table = assignSession(table, { sessionId: 'w-2', kind: 'worker', parentId: 'p', status: 'running', startedAt: 2000 })
  table = reserveChildId(table, { id: 'w-3', parentId: 'p', startedAt: 3000 })
  table = assignSession(table, { sessionId: 'w-3', kind: 'worker', parentId: 'p', status: 'running', startedAt: 3000 })
  table = finishSession(table, { sessionId: 'w-3', status: 'done' })
  table = reserveChildId(table, { id: 'w-4', parentId: 'p', startedAt: 4000 })
  table = assignSession(table, { sessionId: 'w-4', kind: 'worker', parentId: 'p', status: 'running', startedAt: 4000 })
  table = finishSession(table, { sessionId: 'w-4', status: 'failed' })
  table = reserveChildId(table, { id: 'w-5', parentId: 'p', startedAt: 5000 })

  const snapshot = snapshotOf({
    assignments: table,
    attention: { 'w-1': ['retrying'], 'w-2': ['idle', 'waiting-approval'], 'w-9': [] },
  })

  assert.match(snapshot.running, /^3 个在跑/, 'running and reserved both count as live')
  for (const id of ['w-1', 'w-2', 'w-5']) assert.ok(snapshot.running.includes(id), id)
  assert.match(snapshot.stuck, /^2 个卡住/, 'only ids the inspector still flags')
  assert.ok(snapshot.stuck.includes('重试中'))
  assert.ok(snapshot.stuck.includes('空转'))
  assert.ok(snapshot.stuck.includes('等批准'))
  assert.match(snapshot.finished, /^已结束 2 个/)
  assert.ok(snapshot.finished.includes('w-3 完成'))
  assert.ok(snapshot.finished.includes('w-4 失败'))
  // 花费没有可读的统计来源：写缺项，不编数字（这一项最容易顺手编一个 0.00）。
  assert.match(snapshot.cost, /未提供/)
  assert.equal(/\d/.test(snapshot.cost), false, 'no fabricated number stands in for a cost')
  // 卡住优先于在跑：先处理卡住的，其余在跑的等着。
  assert.match(snapshot.next, /^先处理 2 个卡住的 worker/)
  assert.match(snapshotOf({ assignments: table, attention: {} }).next, /3 个 worker 在跑/)
})

test('an idle machine still has five items, with 无 where the fact is really zero', () => {
  const snapshot = snapshotOf({ assignments: {}, attention: {} })
  assert.equal(snapshot.running, '')
  assert.equal(snapshot.stuck, '')
  assert.equal(snapshot.finished, '')
  assert.match(snapshot.cost, /未提供/)
  assert.match(snapshot.next, /没有在跑的 worker/)

  const { text } = renderReport({ at: AT, snapshot })
  const itemLines = text.split('\n').filter((line) => line.startsWith('- **'))
  assert.equal(itemLines.length, 5)
  assert.ok(text.includes(`**${ITEM_LABELS.running}**：无`), 'an empty item is written out, not left blank')
  assert.ok(text.includes('**花费**：未提供'), 'a missing data source names itself')
})

test('composeReport is the one drawable shape: sequence, time, text and five items', () => {
  const report = composeReport({ seq: 4, at: AT, snapshot: { running: '1 个在跑（w-1）' } })
  assert.equal(report.seq, 4)
  assert.equal(report.at, AT.getTime())
  assert.equal(report.stamp, '2026-11-08 12:05')
  assert.match(report.text, /^# 汇报 2026-11-08 12:05/)
  assert.equal(report.oneLine, false)
  assert.deepEqual(report.items.map((item) => item.key), [...REQUIRED_ITEMS])
  assert.equal(report.items[0].text, '1 个在跑（w-1）')
  assert.equal(report.items[1].text, '无')
})

test('three minutes produce one report, and only the latest is kept', () => {
  const timer = fakeTimer()
  const reporter = createReporter({
    assignments: () => ({}),
    attention: () => ({}),
    now: timer.now,
    schedule: timer.schedule,
    cancel: timer.cancel,
  })
  reporter.start()
  assert.equal(timer.pendingCount(), 1, 'one timer, three minutes out')

  timer.advance(3 * MINUTE)
  assert.equal(reporter.count(), 1)
  const first = reporter.latest()
  assert.equal(first.seq, 1)
  assert.equal(first.items.length, REQUIRED_ITEMS.length)

  timer.advance(6 * MINUTE)
  assert.equal(reporter.count(), 3)
  assert.equal(reporter.latest().seq, 3)
  assert.notEqual(reporter.latest(), first, 'reports are replaced, never accumulated')
  assert.equal(reporter.status().tickIndex, 3)
})

test('the two-hour cap stops the beat by itself, and nothing is produced afterwards', () => {
  const timer = fakeTimer()
  const reporter = createReporter({
    assignments: () => ({}),
    attention: () => ({}),
    now: timer.now,
    schedule: timer.schedule,
    cancel: timer.cancel,
  })
  reporter.start()
  // 默认上限就是 CAP_MS：最后一张落在 2 小时前 3 分钟，2 小时那一拍被上限吃掉。
  timer.advance(CAP_MS + 60 * MINUTE)
  assert.equal(reporter.count(), Math.floor(CAP_MS / CADENCE_MS) - 1)
  assert.equal(reporter.status().stopReason, 'max-run')
  assert.equal(timer.pendingCount(), 0)
})

test('starting the same reporter twice does not stack a second beat', () => {
  const timer = fakeTimer()
  const reporter = createReporter({
    assignments: () => ({}),
    attention: () => ({}),
    now: timer.now,
    schedule: timer.schedule,
    cancel: timer.cancel,
  })
  reporter.start()
  reporter.start()
  assert.equal(timer.pendingCount(), 1, 'one reporter, one table')
  timer.advance(3 * MINUTE)
  assert.equal(reporter.count(), 1, 'a duplicate start must not double the first tick')
})

test('a broken fact source is reported, and the next tick still runs', () => {
  const timer = fakeTimer()
  const errors = []
  const reporter = createReporter({
    assignments: () => {
      throw new Error('registry down')
    },
    attention: () => ({}),
    now: timer.now,
    schedule: timer.schedule,
    cancel: timer.cancel,
    onError: (error) => errors.push(error.message),
  })
  reporter.start()
  timer.advance(3 * MINUTE)

  assert.deepEqual(errors, ['registry down'])
  assert.equal(reporter.count(), 0, 'a tick that cannot read its facts produces no report')
  assert.equal(timer.pendingCount(), 1, 'one bad tick does not stop the beat')
})
test('the report the beat produces is already the dock payload shape', async () => {
  // 两半必须对得上：节拍产出的对象直接塞进端点，不能被端点改写成另一份（或读成 null）。
  const timer = fakeTimer()
  const reporter = createReporter({
    assignments: () => ({}),
    attention: () => ({}),
    now: timer.now,
    schedule: timer.schedule,
    cancel: timer.cancel,
  })
  reporter.start()
  timer.advance(3 * MINUTE)
  const latest = reporter.latest()

  const payload = await panelPayloadOf({ assignments: {}, report: latest })
  assert.equal(payload.report.seq, latest.seq)
  assert.equal(payload.report.stamp, latest.stamp)
  assert.equal(payload.report.text, latest.text)
  assert.deepEqual(payload.report.items, latest.items)
  assert.deepEqual(payload.report.items.map((item) => item.key), [...REQUIRED_ITEMS])
})
