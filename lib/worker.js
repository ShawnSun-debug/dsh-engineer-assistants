/**
 * Shared worker plumbing for `delegate` and `orchestrate`. Dependency-free: the
 * host's `defineTool` is passed in by the caller, so the request shaping can be
 * tested without the DSH runtime.
 *
 * Both tools must read the route from the same config fields and build the same
 * `startActivation` spec; keeping that here is what prevents route drift.
 */

/** The worker route from config, in the `AgentOptions` shape `startActivation` takes. */
export function readRoute(config) {
  const provider = String(config.workerProvider.get() ?? '').trim()
  const model = String(config.workerModel.get() ?? '').trim()
  if (provider === '' || model === '') {
    throw new Error('orchestrator: the worker route is not configured (set workerProvider and workerModel)')
  }
  const effort = String(config.workerReasoningEffort.get() ?? '').trim()
  // Changing the route without naming an effort lets the model resolve its own default,
  // so an empty effort is simply left out rather than sent as an empty string.
  return { provider, model, ...(effort === '' ? {} : { reasoningEffort: effort }) }
}

/**
 * 评审者走的路由：两条 review 字段都填了就用它，否则整体跟随 worker 路由。
 * 不做半套覆盖——只填 provider 不会悄悄拼出一个混合路由。
 */
export function readReviewRoute(config) {
  const provider = String(config.reviewProvider?.get?.() ?? '').trim()
  const model = String(config.reviewModel?.get?.() ?? '').trim()
  if (provider === '' || model === '') return readRoute(config)
  const effort = String(config.reviewReasoningEffort?.get?.() ?? '').trim()
  return { provider, model, ...(effort === '' ? {} : { reasoningEffort: effort }) }
}

/** One optional string parameter, trimmed; a wrong type fails loudly. */
function stringArg(args, key, tool) {
  const value = args?.[key]
  if (value === undefined) return ''
  if (typeof value !== 'string') throw new Error(`${tool}: "${key}" must be a string when provided`)
  return value.trim()
}

/**
 * A per-call route override, named like the native `subagent` tool's parameters.
 *
 * It exists for one case only: the user explicitly names a model for a specific
 * delegation. Provider and model belong together, so a half-specified override is
 * refused instead of silently falling back to the configured route. An omitted
 * effort leaves the route's own effort out, so the selected model resolves its
 * own default.
 */
export function readRouteOverride(args, tool) {
  const provider = stringArg(args, 'provider', tool)
  const model = stringArg(args, 'model', tool)
  const effort = stringArg(args, 'reasoning_effort', tool)
  if (provider === '' && model === '' && effort === '') return undefined
  if (provider === '' || model === '') {
    throw new Error(`${tool}: "provider" and "model" must be given together to override the worker route`)
  }
  return { provider, model, ...(effort === '' ? {} : { reasoningEffort: effort }) }
}

/**
 * Every worker is told to answer in Simplified Chinese. The worker never sees the
 * parent conversation, so the instruction has to travel with the prompt. The header
 * also tells the worker to end with its final summary rather than reporting back
 * through `send_message`: its closing message already reaches the parent.
 *
 * `prompt` is unused now that the wording no longer depends on the request; the
 * parameter stays so the exported signature and its callers are unchanged.
 */
export function languageNote(prompt) {
  return (
    '用中文回复。' +
    '完成任务时直接在回复中输出最终总结并结束本回合，' +
    '禁止调用 send_message 向父代理发送完成汇报，' +
    '主代理会自动接收你的收尾消息。\n\n'
  )
}

/**
 * The spec handed to `ctx.subagents.startActivation`.
 *
 * `agentOptions` is the route read from config, or the explicit per-call override
 * when the user named one; either way exactly one route reaches the host.
 * `delivery` differs per tool: `delegate` answers the parent, `orchestrate`
 * answers the caller that is waiting for `run.result`.
 */
export function buildSpawnActivation({
  cwd,
  prompt,
  label,
  parent,
  route,
  maxDepth,
  signal,
  outputSchema,
  delivery,
}) {
  const request = {
    ...(cwd === undefined ? {} : { cwd }),
    prompt: [{ type: 'text', text: prompt }],
    parent,
    agentOptions: route,
    ...(maxDepth === undefined ? {} : { maxDepth }),
    ...(outputSchema === undefined ? {} : { outputSchema }),
  }
  return { provider: 'spawn', label, request, signal, delivery }
}
