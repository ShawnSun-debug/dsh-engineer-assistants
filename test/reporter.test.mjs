import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import {
  CADENCE_MS,
  CAP_MS,
  ITEM_LABELS,
  REQUIRED_ITEMS,
  archivePath,
  renderReport,
  reportDue,
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
  assert.match(text, /卡住 \/ 等批准\*\*：无/)
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
  assert.throws(() => archivePath({ cwd: 'D:/work', at: null }), /valid Date/)
})

test('the summary line never claims 无变化 while something is running', () => {
  const working = summaryLine({ at: AT, snapshot: { running: 'w1 跑了 12 分钟', cost: '0.30' } })
  assert.equal(working, '- 2026-11-08 12:05 · w1 跑了 12 分钟')
  assert.equal(summaryLine({ at: AT, snapshot: {} }), '- 2026-11-08 12:05 · 无变化')
  assert.equal(summaryLine({ at: AT, snapshot: { finished: '两个测试通过' } }), '- 2026-11-08 12:05 · 两个测试通过')
})
