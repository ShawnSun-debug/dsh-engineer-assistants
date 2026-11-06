import assert from 'node:assert/strict'
import test from 'node:test'
import { REPORT_KINDS, renderPlanReport, renderReport, summarizeForDiff } from '../lib/secretary-report.js'

const AT = new Date(2026, 9, 17, 6, 18).getTime()

const SECTIONS = ['## 状态', '## 步骤', '## worker', '## 差异', '## 产出', '## 耗时与异常']

function reportInput(overrides = {}) {
  return {
    kind: 'delta',
    at: AT,
    session: { title: '发布编排' },
    orchestrator: {
      state: 'Working',
      summary: '正在跑第 2 步',
      step: { index: 2, total: 5 },
      workers: [
        { name: 'worker-a', state: 'Working', activity: '改接口' },
        { name: 'worker-b', state: 'Needs input', summary: '等确认' },
      ],
    },
    diff: {
      completed: ['worker-a 收尾'],
      blocked: ['worker-b'],
      flipped: [{ name: 'worker-c', from: 'Idle', to: 'Working' }],
    },
    artifacts: ['D:/out/a.png'],
    timing: { elapsedMs: 750_000, retries: 2, errors: ['第一次超时'] },
    ...overrides,
  }
}

test('renderReport writes the six sections in the documented order', () => {
  const text = renderReport(reportInput())
  const positions = SECTIONS.map((section) => text.indexOf(section))
  for (const [index, position] of positions.entries()) {
    assert.ok(position >= 0, `missing section ${SECTIONS[index]}`)
    if (index > 0) assert.ok(position > positions[index - 1], `section out of order: ${SECTIONS[index]}`)
  }
})

test('renderReport keeps every section heading when there is no data', () => {
  const text = renderReport({ kind: 'delta', at: AT })
  for (const section of SECTIONS) assert.match(text, new RegExp(`^${section}$`, 'm'))
  assert.match(text, /## worker\n\n无/)
  assert.match(text, /## 产出\n\n无/)
  for (const group of ['### 新完成', '### 新卡住', '### 状态翻转']) {
    assert.match(text, new RegExp(`${group}\\n\\n无`))
  }
})

test('the header carries the local time, the session name and a Chinese kind label', () => {
  const text = renderReport(reportInput())
  assert.match(text, /时间：2026-10-17 06:18/)
  assert.match(text, /会话：发布编排/)
  assert.match(text, /类型：增量/)

  const labels = [
    ['plan', '规划'],
    ['delta', '增量'],
    ['limit', '超时截断'],
  ]
  for (const [kind, label] of labels) {
    assert.match(renderReport(reportInput({ kind })), new RegExp(`类型：${label}$`, 'm'), kind)
  }
  assert.deepEqual(REPORT_KINDS, ['plan', 'delta', 'limit'])
  assert.throws(() => renderReport(reportInput({ kind: 'other' })), /kind/)
})

test('renderReport renders state, step, workers, diff groups and timing', () => {
  const text = renderReport(reportInput())
  assert.match(text, /## 状态\n\nWorking — 正在跑第 2 步/)
  assert.match(text, /## 步骤\n\n第 2 步 \/ 共 5 步/)
  assert.match(text, /\| 名字 \| 状态 \| 在做的事 \|/)
  assert.match(text, /\| worker-a \| Working \| 改接口 \|/)
  assert.match(text, /\| worker-b \| Needs input \| 等确认 \|/)
  assert.match(text, /### 新完成\n\n- worker-a 收尾/)
  assert.match(text, /### 新卡住\n\n- worker-b/)
  assert.match(text, /### 状态翻转\n\n- worker-c：Idle → Working/)
  assert.match(text, /## 产出\n\n- D:\/out\/a\.png/)
  assert.match(text, /- 已跑时长：12 分 30 秒/)
  assert.match(text, /- 重试次数：2/)
  assert.match(text, /- 错误：\n  - 第一次超时/)
})

test('a report without workers or artifacts still renders those sections as 无', () => {
  const text = renderReport(
    reportInput({
      orchestrator: { state: 'Idle', summary: '' },
      diff: {},
      artifacts: [],
      timing: {},
    }),
  )
  assert.match(text, /## 状态\n\nIdle — 暂无摘要/)
  assert.match(text, /## 步骤\n\n未提供/)
  assert.match(text, /## worker\n\n无/)
  assert.match(text, /## 产出\n\n无/)
  assert.match(text, /- 已跑时长：未提供/)
  assert.match(text, /- 重试次数：未提供/)
  assert.match(text, /- 错误：无/)
})

test('summarizeForDiff returns the structured summary the next diff compares', () => {
  assert.deepEqual(summarizeForDiff(reportInput()), {
    state: 'Working',
    step: { index: 2, total: 5 },
    workers: [
      { name: 'worker-a', state: 'Working' },
      { name: 'worker-b', state: 'Needs input' },
    ],
    artifacts: ['D:/out/a.png'],
  })
})

test('summarizeForDiff degrades missing data to an empty projection', () => {
  assert.deepEqual(summarizeForDiff({}), {
    state: 'Idle',
    step: { index: null, total: null },
    workers: [],
    artifacts: [],
  })
})

test('an invalid time is rejected instead of silently stamped with now', () => {
  assert.throws(() => renderReport({ kind: 'delta', at: 'not a date' }), /at/)
})


// ---- renderPlanReport（票 05 A）：规划首报的六段 Markdown -------------------------

const PLAN_SECTIONS = ['## 状态', '## 步骤', '## 验收点', '## 触发依据', '## worker', '## 预计耗时']

function planInput(overrides = {}) {
  return {
    at: AT,
    session: { title: '发布编排' },
    plan: {
      state: 'Working',
      steps: [{ index: 1, name: '修登录', detail: '让重试可用' }],
      acceptance: ['测试全绿', 'node --test'],
      trigger: { kind: 'dispatch', tool: 'dispatch', sessionId: 'orch-1', at: AT, callId: 'call-1' },
      workers: [{ id: 'worker-1', role: 'worker', state: 'planned', task: '修登录' }],
      estimate: {
        seconds: 600,
        label: '粗估约 10 分钟（按每 worker 每阶段 10 分钟基线，非实测）',
        basis: 'baseline',
      },
    },
    ...overrides,
  }
}

test('renderPlanReport writes the six planning sections in the documented order', () => {
  const text = renderPlanReport(planInput())
  const positions = PLAN_SECTIONS.map((section) => text.indexOf(section))
  for (const [index, position] of positions.entries()) {
    assert.ok(position >= 0, `missing section ${PLAN_SECTIONS[index]}`)
    if (index > 0) assert.ok(position > positions[index - 1], `section out of order: ${PLAN_SECTIONS[index]}`)
  }
})

test('renderPlanReport renders the plan it was given', () => {
  const text = renderPlanReport(planInput())
  assert.match(text, /^# 秘书规划$/m)
  assert.match(text, /时间：2026-10-17 06:18/)
  assert.match(text, /会话：发布编排/)
  assert.match(text, /## 状态\n\nWorking/)
  assert.match(text, /## 步骤\n\n1\. 修登录 — 让重试可用/)
  assert.match(text, /## 验收点\n\n- 测试全绿\n- node --test/)
  assert.match(text, /- 来源：dispatch/)
  assert.match(text, /- 工具：dispatch/)
  assert.match(text, /- 会话：orch-1/)
  assert.match(text, /- 调用：call-1/)
  assert.match(text, /\| worker-1 \| planned \| 修登录 \|/)
  assert.match(text, /## 预计耗时\n\n粗估约 10 分钟/)
})

test('renderPlanReport keeps every heading and writes 未提供 when a field is missing', () => {
  const text = renderPlanReport({ at: AT })
  for (const section of PLAN_SECTIONS) {
    assert.match(text, new RegExp(`^${section}\\n\\n未提供$`, 'm'), section)
  }
})

test('renderPlanReport degrades a malformed plan instead of throwing', () => {
  for (const plan of [null, 'x', [], { steps: 'x', acceptance: 1, trigger: 2, workers: {}, estimate: [] }]) {
    assert.doesNotThrow(() => renderPlanReport({ at: AT, plan }))
  }
  // 会话也缺：名字退化成占位，不留空洞。
  assert.match(renderPlanReport({ at: AT }), /会话：未命名会话/)
  // 只有 at 是必填项；坏时间仍然直说，不拿当前时间冒充。
  assert.throws(() => renderPlanReport({ at: 'not a date' }), /at/)
})
