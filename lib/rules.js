/**
 * The main-agent rule, rendered into the opening of both delegation tool
 * descriptions. It lives apart from `gate.js` so the prompt and the enforcement
 * read from the same allow list and cannot drift: the allowed tools named in the
 * text are exactly the ones the gate lets through, and every other tool is blocked.
 *
 * A description is the first thing a main agent reads about delegation, and the
 * same description is registered for delegating children too, so the rule says
 * outright that a delegated worker is not gated. Without that, a worker could
 * read the rule as a ban on its own tools.
 */

import { DELEGATE_TOOL, ORCHESTRATE_TOOL } from './api.js'

/**
 * Build the rule text. `allowedTools` is the live whitelist the gate enforces, so the
 * closing sentence names exactly what stays available. `preferred` is kept for callers
 * written against the two-tool rule text; this plugin registers one delegation entry,
 * `dispatch`, so both shapes name it and the text cannot advertise a tool we do not ship.
 */
export function mainAgentRule(allowedTools, preferred = DELEGATE_TOOL) {
  const order =
    preferred === ORCHESTRATE_TOOL
      ? 'dispatch (many items through ordered stages)'
      : 'dispatch (one task, or many items through ordered stages)'
  const allowed = [...new Set(allowedTools ?? [])]
  const allowedNames = allowed.join(', ')
  return (
    'Main-agent rule: the main agent plans only. Every read/write/edit/search/command/fetch/inspect ' +
    'runs ONLY in a worker — never by you, not even read or write, nor to test availability (not ' +
    'even once; they are blocked) — via ' +
    order +
    '; workers are not gated. Independent delegations start in the same message. ' +
    'Never re-check on a new session or after compression/memory clearing; go straight to ' +
    'dispatch. When parallel work is unnecessary, wait for the subagent to finish ' +
    'before proceeding with further work; ' +
    'do not repeatedly check its status or start duplicate workers for the same task. ' +
    'compress is available to the main agent. A worker that drops without a ' +
    'closing message is retried on the same session by the plugin: wait for those automatic retries; do not re-dispatch the worker or start a replacement while it is being retried. If it disconnects quickly three times within 2 minutes (two automatic retries), the plugin stops retrying and reports that its model may be unavailable. Tell the user and ask only: A) start a fresh worker, or B) switch the worker model and retry. Wait for the user’s choice; do not retry the old worker or silently switch models. ' +
    '子代理中断或未正常结束时，先等待插件对同一子代理自动重试；结果为空时不要立即重复派遣，先确认插件状态。若2分钟内连续3次快速断联（插件自动重试2次），插件停止重试并提示：“【插件重试｜子代理 <id>】它在 2 分钟内连续 3 次快速断联（failed before it finished / It left no closing message），插件已停止自动重试，判定子代理模型可能不可用。请告知用户，并询问：A) 派生一个新的子代理重做，还是 B) 更换子代理模型后重试？在用户答复之前不要再对这个子代理自动重试，也不要自己换一个模型悄悄重发。”只提供通知中的A/B选项并等待用户答复，不要建议继续唤醒旧子代理；未经用户选择A，不要另派子代理重复工作。' +
    'Never use run_code to reach ' +
    'the host: no Node/host imports or globals (import, require, process, fetch, eval) and no ' +
    'sandbox_permissions or justification — a program only calls the dispatch tool. Pass ' +
    'provider/model/reasoning_effort only when the current message explicitly names them for this ' +
    'dispatch; otherwise omit all three (dispatch panel route). A named model is for this dispatch ' +
    'only: never reuse one from earlier turns, dispatch or summary; never assume an unstated ' +
    'default; if unsure, ask.' +
    (allowedNames === ''
      ? ' No tools are currently allowed for the main agent.'
      : ` Allowed for the main agent (whitelist-driven; every other tool is blocked): ${allowedNames}.`) +
    ' '
  )
}
