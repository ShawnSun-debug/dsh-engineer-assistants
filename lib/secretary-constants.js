/**
 * 秘书层共享词表（秘书 spec）。
 *
 * 汇报、差异与草稿共用这一份类别名，免得每个模块各写一份字面量、再慢慢漂移。归档根与
 * 六态一样放在 lib/master-state.js（写报告与读视图共用那份路径）。纯常量：不 import 任何
 * 模块，不读时钟，不认识宿主。
 *
 * 客户端不能 import 服务端模块（lib/client.js 由 window.__ModuleLoader__ 加载），它需要
 * 的副本在那边同值镜像，并由 test/client.test.mjs 断言两边一致。
 *
 * @module
 */

/** 三种报告：首报、节拍增量、超时截断。顺序即文档顺序。 */
export const REPORT_KINDS = Object.freeze(['plan', 'delta', 'limit'])

/**
 * 视图可能看到的报告种类：三种真报告，加上跨会话的 '_summary.md'（summary），以及标题
 * 没写种类的归档文件（unknown，宁可不猜）。
 */
export const REPORT_VIEW_KINDS = Object.freeze([...REPORT_KINDS, 'summary', 'unknown'])

/** 草稿的三种状态，顺序即生命周期。 */
export const DRAFT_STATUSES = Object.freeze(['pending', 'sent', 'discarded'])

/**
 * 五个「实质变化」开关：视图的短键 → config 里存的类别名。顺序即 {@link CHANGE_KINDS} 的顺序。
 */
export const NOTIFY_SWITCHES = Object.freeze({
  state: 'state-flip',
  step: 'step-advance',
  block: 'blocked',
  deliverable: 'deliverable',
  timeout: 'timeout',
})

/** 五种实质变化，顺序即报告与冒泡的顺序；类别名只在 NOTIFY_SWITCHES 里写一次。 */
export const CHANGE_KINDS = Object.freeze(Object.values(NOTIFY_SWITCHES))
