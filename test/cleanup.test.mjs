import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

/**
 * 票 15 的静态钉子：旧机制确实不在源码里了。
 *
 * 行为测试守不住「某个模块被删干净」——代码删了、调用方留一行注释，测试照样全绿。这里直接
 * 读源码，把删除清单上的符号逐个钉住；哪天有人把旧路径捡回来，这条先红，比真机报错早。
 */
const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), 'utf8')
const exists = (relative) => fs.existsSync(new URL(relative, import.meta.url))

test('the two old report modules and their dedicated tests are gone', () => {
  for (const file of [
    '../lib/secretary-archive.js',
    '../lib/secretary-report.js',
    '../test/secretary-archive.test.mjs',
    '../test/secretary-report.test.mjs',
  ]) {
    assert.equal(exists(file), false, file + ' still exists')
  }
})

test('no surviving source mentions the old report chain', () => {
  // 旧归档写盘、旧报告渲染、旧读盘入口与旧正文上限：整条链都不该再有任何引用，注释也不行。
  const oldSymbols = ['secretary-archive', 'secretary-report', 'listReportRows', 'renderPlanReport', 'summarizeForDiff', 'REPORT_CONTENT_LIMIT']
  const files = [
    '../lib/index.js',
    '../lib/secretary-panel.js',
    '../lib/client.js',
    '../lib/dshgo.js',
    '../lib/master-state.js',
    '../lib/secretary-deliver.js',
    '../lib/secretary-watch.js',
  ]
  for (const file of files) {
    const source = read(file)
    for (const symbol of oldSymbols) {
      assert.equal(source.includes(symbol), false, file + ' still mentions ' + symbol)
    }
  }
})

test('the old dispatch-mode page stays gone from the client bundle', () => {
  // 票 15 第一版删掉整页；操作者随后要求保留一个最小设置页（见下一条）。这里钉的是
  // 「旧调度语义不回来」：总开关、模型路由、Master/登记选择器、旧 section 名。
  const source = read('../lib/client.js')
  for (const symbol of [
    'OrchestratorSettingsSection',
    'SessionPicker',
    'pickerRowsOf',
    "'section.title'",
    "'section.enable'",
    "'route.enable'",
    "'route.enableNote'",
    "'route.lastReview'",
  ]) {
    assert.equal(source.includes(symbol), false, 'lib/client.js still mentions ' + symbol)
  }
})

test('the smaller settings page is registered and carries the restored controls', () => {
  // 最小设置页存在：座位重新注册、标注新标题键，三块控件都能在源码里找到。
  const source = read('../lib/client.js')
  for (const symbol of [
    "'settings.section'",
    'AssistantSettingsSection',
    'AllowedToolsPanel',
    'EnableSwitch',
    'SuperviseIntervalField',
    'AuthorityPanel',
    "'assistant.settings.title'",
    "'allowed.title'",
    "'supervise.label'",
    "'supervise.maxLabel'",
  ]) {
    assert.equal(source.includes(symbol), true, 'lib/client.js is missing ' + symbol)
  }
  assert.equal(source.includes("'superviseIntervalSeconds'"), true, 'the interval field writes its config key')
  assert.equal(source.includes("'superviseMaxNoticesPerChild'"), true, 'the max-notices field writes its config key')
  assert.equal(source.includes("'superviseNotifyOnNoProgress'"), true, 'the no-progress switch writes its config key')
  assert.equal(source.includes("'superviseEnabled'"), true, 'the supervision switch writes its config key')
  assert.equal(source.includes("'superviseUnlimited'"), true, 'the unlimited switch writes its config key')
})

test('the secretary history tab says where reports went instead of reading an archive', () => {
  const source = read('../lib/client.js')
  assert.equal(source.includes("'secretary.historyMoved'"), true, 'the one-line notice is still rendered')
  assert.equal(source.includes('orchestrator-secretary-timeline'), false, 'the old report timeline is gone')
})

test('both READMEs carry the manual migration steps', () => {
  const zh = read('../README.md')
  const en = read('../README.en.md')
  assert.match(zh, /## 从旧版本手工迁移/)
  assert.match(en, /## Manual migration from an older version/)
  // 不做自动迁移，且旧设置页的入口要说清楚去哪了。
  assert.match(zh, /不做自动迁移/)
  assert.match(en, /no automatic migration/i)
})
