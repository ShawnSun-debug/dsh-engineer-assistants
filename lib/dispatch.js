
/**
 * 单一派发入口（ADR 0006）。把 delegate 与 orchestrate 收成一个工具：
 * 不给 items/stages 就是单任务，给了就是批量；主代理不再选形状，只填字段。
 *
 * 评审闸在单任务路径由 delegate 内部执行，在批量路径由这里执行——
 * 两条路都保证「worker 存在之前就判完」，且都不会重复评审。
 */

import { cardFromArgs, riskTier } from './card.js'
import { createDelegateTool, DELEGATE_PARAMETERS } from './delegate.js'
import { createOrchestrateTool, ORCHESTRATE_PARAMETERS } from './orchestrate.js'
import { blockMessage, isReviewDispatch, reviewCard, shouldBlock } from './review.js'
import { mainAgentRule } from './rules.js'

export const DISPATCH_TOOL = 'dispatch'

const BATCH_ONLY = ['items', 'stages', 'maxConcurrency']

// Required by the single-task shape only. The host compiles every `required: true`
// property into one shared required list, so leaving them required would make a
// legitimate batch call fail schema validation for omitting prompt/description.
const SINGLE_ONLY = ['description', 'prompt']

const BATCH_KEYS = ['cwd', 'items', 'stages', 'maxConcurrency', 'provider', 'model', 'reasoning_effort']

/** 批量派发时只把 orchestrate 认识的键递下去：卡片字段不属于那一层。 */
function batchArgs(args) {
  const out = {}
  for (const key of BATCH_KEYS) if (args?.[key] !== undefined) out[key] = args[key]
  return out
}

/** 单任务派发时把批量专用键去掉，否则 delegate 的未知键检查会拒。 */
function singleArgs(args) {
  const out = {}
  for (const [key, value] of Object.entries(args ?? {})) if (!BATCH_ONLY.includes(key)) out[key] = value
  return out
}

/** 一张参数表：两个工具的原始参数表合并，只有一种形状需要的键去掉必填。 */
function mergeParameters(single, batch) {
  const merged = { ...batch, ...single }
  for (const key of [...BATCH_ONLY, ...SINGLE_ONLY]) {
    if (!merged[key]) continue
    // 宿主的参数 DSL 只接受 `required: true`；写成 false 会直接报作者错误，
    // 所以可选键必须把 required 整个去掉，而不是改成 false。
    const { required, ...rest } = merged[key]
    merged[key] = rest
  }
  return merged
}

export function createDispatchTool({ defineTool, subagents, config, onStarted, allowedTools, deniedTools, reviewer, forWorker = false }) {
  // `allowedTools` is the Allowed Tools whitelist the gate enforces; `deniedTools` stays only
  // as the legacy alias the inner tools still accept, so an older caller cannot describe the
  // wrong rule.
  const single = createDelegateTool({ defineTool, subagents, config, onStarted, allowedTools, deniedTools, reviewer, forWorker })
  const batch = createOrchestrateTool({ defineTool, subagents, config, allowedTools, deniedTools, forWorker })

  const list = allowedTools ?? deniedTools
  const liveAllowed = typeof list === 'function' ? list : () => list
  const rule = () => mainAgentRule(liveAllowed())

  const workerText = 'Dispatch one self-contained task, or a batch of items through ordered stages, on the configured worker route.'
  const body =
    'Hand one self-contained task to a worker, or a batch of items through ordered stages. ' +
    'This is the only dispatch entry. The worker does not see this conversation, so the task card ' +
    'must carry the goal, the allowed files, the acceptance command and the fallback. It runs on ' +
    'the worker route chosen by the user; do not pick a model. Omit items and stages for a single ' +
    'task; that shape needs prompt and description. Give both for a batch, where items are ' +
    'independent and stages run per item in order; a batch does not need prompt or description. ' +
    'Nothing is started when the review blocks the card: you get the failure mechanism back and replan.'

  const tool = defineTool({
    name: DISPATCH_TOOL,
    description: forWorker ? workerText : rule() + body,
    parameters: mergeParameters(DELEGATE_PARAMETERS, ORCHESTRATE_PARAMETERS),
    // 宿主强制每个工具声明 output.render；两种形状共用一张输出 schema。
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['activation', 'orchestration'] },
          subagentId: { type: 'string' },
          agentsStarted: { type: 'integer' },
          results: { type: 'json' },
          errors: { type: 'json' },
        },
      },
      render: (_args, value) =>
        value?.kind === 'activation'
          ? [{ type: 'text', text: `started subagent ${value.subagentId}` }]
          : [{ type: 'text', text: `started ${value?.agentsStarted ?? 0} worker(s)` }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const isBatch = Array.isArray(args?.items) || Array.isArray(args?.stages)
      if (!isBatch) return single.execute(singleArgs(args), exec)

      // 批量路径的评审闸：在任何一个 worker 启动之前判一次。
      if (reviewer && !isReviewDispatch(args)) {
        const card = cardFromArgs(args)
        const tier = riskTier(card, { irreversible: args?.irreversible })
        if (tier === 'high') {
          const verdict = await reviewCard(card, { run: (c) => reviewer(c, { parent: exec.agent, signal: exec.signal }) })
          if (shouldBlock(verdict, tier)) throw new Error(blockMessage(card, verdict))
        }
      }

      return batch.execute(batchArgs(args), exec)
    },
  })

  // 与 delegate 同源：描述是 getter，面板一改，下一次请求就渲染新名单。
  Object.defineProperty(tool, 'description', {
    enumerable: true,
    configurable: true,
    get: () => (forWorker ? workerText : rule() + body),
  })
  return tool
}
