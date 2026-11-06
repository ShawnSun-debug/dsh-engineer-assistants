/**
 * Delegation tool. Dependency-free: `defineTool` is passed in, so the request
 * building can be tested without the DSH runtime.
 *
 * Why this exists (see docs/adr/0001): the native `subagent` tool's `agentOptions`
 * are plain config with no volatile field, so a settings write cannot change the
 * default worker route. This tool reads the route from the plugin's own volatile
 * config on every call, so a change applies from the next delegation.
 *
 * Route reading and request shaping live in `worker.js`, shared with `orchestrate`.
 */

import { DELEGATE_TOOL, DELIVERY } from './api.js'
import { mainAgentRule } from './rules.js'
import { cardFromArgs, riskTier } from './card.js'
import { blockMessage, isReviewDispatch, reviewCard, shouldBlock } from './review.js'
import { buildSpawnActivation, languageNote, readRoute, readRouteOverride } from './worker.js'

export { DELEGATE_TOOL, languageNote, readRoute, readRouteOverride }

/**
 * 派发前的评审闸（ADR 0004）。高风险卡必须过评审；BLOCK 直接抛错，worker 一个都不启动。
 * 评审类派发（args.review === true）不再触发评审——自指终止写在代码里，不写在提示词里。
 */
async function reviewGate({ args, reviewer, parent, signal }) {
  if (!reviewer || isReviewDispatch(args)) return null
  const card = cardFromArgs(args)
  const tier = riskTier(card, { irreversible: args?.irreversible })
  if (tier !== 'high') return null
  const verdict = await reviewCard(card, { run: (c) => reviewer(c, { parent, signal }) })
  if (shouldBlock(verdict, tier)) throw new Error(blockMessage(card, verdict))
  return { tier, verdict }
}

/** The delegate spec: the prompt carries the language note and delivery answers the parent. */
export function buildActivation({ args, parent, route, maxDepth, signal }) {
  return buildSpawnActivation({
    cwd: args.cwd,
    prompt: languageNote(args.prompt) + args.prompt,
    label: args.description,
    parent,
    route,
    maxDepth,
    signal,
    delivery: DELIVERY.delegate,
  })
}

export function createDelegateTool({
  defineTool,
  subagents,
  config,
  onStarted,
  allowedTools,
  deniedTools,
  reviewer,
  forWorker = false,
}) {
  // `allowedTools` is the Allowed Tools whitelist the gate enforces: a function when the
  // host owns the list, read again whenever the description is rendered, so a settings
  // change reaches the prompt without re-registering the tool. A fixed array is still
  // accepted, for tests and callers that have no live config. `deniedTools` is accepted
  // only as a legacy alias, so an older caller cannot silently describe the wrong rule.
  const list = allowedTools ?? deniedTools
  const liveAllowed = typeof list === 'function' ? list : () => list
  const rule = () => mainAgentRule(liveAllowed())
  /**
   * A delegated child inherits the global table, so it would read the main-agent rule
   * above and could take it as a ban on its own tools. `lib/index.js` shadows this tool
   * in the child's own scope with this shorter, role-neutral text; the wording the main
   * agent sees is untouched.
   */
  const workerText =
    'Start one worker agent on a self-contained task, on the configured worker route. The worker ' +
    'cannot see this conversation, so the prompt must carry everything it needs. Its result is ' +
    'delivered back to you when it finishes; use send_message to follow up with a running worker.'
  const body =
      'Hand one self-contained task to a worker agent. The worker does not see this conversation, ' +
      'so the prompt must carry the goal, the allowed files, the acceptance command and the ' +
      'fallback. It runs on the worker route chosen by the user; do not pick a model. ' +
      'This returns its id immediately and the runtime notifies you when it finishes. ' +
      'Do not instruct the worker to send a message back or report results via send_message; ' +
      'its closing message is delivered automatically when it ends. ' +
      'When several subtasks are independent, start all of their workers in the same turn — ' +
      'delegate is safe to call concurrently — so they work in parallel instead of one at a ' +
      'time; a very simple task is the one case for a single worker, while many homogeneous ' +
      'items belong to orchestrate. Weigh that yourself: it is guidance, not a hard rule. Never ' +
      'start two workers on the same file. Use send_message to correct a worker that is still ' +
      'running, or to give a finished worker a follow-up task: it keeps its own context and ' +
      'remains a full worker. Whether the next step reuses that worker or starts a new one is ' +
      'your call, based on how closely the new task relates to what the worker already did. ' +
      'A worker that runs for a long time is inspected by the plugin every few minutes. A ' +
      '「【插件巡检…】」 message comes from the plugin, not the user: use send_message to steer a ' +
      'worker that is off track, or reply with one line and end the turn when no action is needed.'

  const tool = defineTool({
    name: DELEGATE_TOOL,
    description: forWorker ? workerText : rule() + body,
    parameters: DELEGATE_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', const: 'activation' },
          subagentId: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `started subagent ${value.subagentId}` }],
    },
    // Workers are independent by contract, so several may be started in one message.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) throw new Error('delegate requires a calling agent (exec.agent was undefined)')
      // Requiredness is declared in the schema, but direct tool use still needs the contract checked.
      if (typeof args?.prompt !== 'string' || args.prompt.trim() === '') throw new Error('delegate requires a non-empty prompt')
      if (typeof args?.description !== 'string' || args.description.trim() === '') throw new Error('delegate requires a non-empty description')
      // 评审闸：高风险卡在这里被打回，worker 尚未存在。
      await reviewGate({ args, reviewer, parent, signal: exec.signal })
      // An explicit per-call override wins and is never read from config; otherwise the
      // route is read at call time, so a changed route applies from this delegation on.
      const route = readRouteOverride(args, DELEGATE_TOOL) ?? readRoute(config)
      exec.signal.throwIfAborted()
      const spec = buildActivation({
        args,
        parent,
        route,
        maxDepth: subagents.resolveMaxDepth(undefined),
        signal: exec.signal,
      })
      const started = await subagents.startActivation(spec)
      // Supervision is best-effort: a missing or broken callback must neither fail the
      // dispatch nor change what the main agent receives back.
      try {
        const notified = typeof onStarted === 'function' ? onStarted(parent, started, args) : undefined
        // The callback is synchronous, but tolerate an async one without awaiting it.
        if (notified !== undefined && typeof notified.catch === 'function') notified.catch(() => {})
      } catch {
        // Deliberately swallowed: a supervision bug cannot be allowed to affect dispatch.
      }
      return { kind: 'activation', subagentId: started.childId }
    },
  })
  // The host reads `description` while it builds a request (its own run_code tool uses a
  // getter for the same reason), so this keeps the rule text in step with the gate.
  Object.defineProperty(tool, 'description', {
    enumerable: true,
    configurable: true,
    get: () => (forWorker ? workerText : rule() + body),
  })
  return tool
}

/** Raw parameter spec, reused by the merged dispatch tool. */
export const DELEGATE_PARAMETERS = {
  goal: {
    type: 'string',
    description: 'Task card: what this dispatch is for, in one sentence. Missing fields make the card high-risk and force a review before any worker starts.',
  },
  doneDefinition: {
    type: 'string',
    description: 'Task card: what "finished" means, concretely enough that a reviewer can tell whether the worker met it.',
  },
  files: {
    type: 'array',
    items: { type: 'string' },
    description: 'Task card: the files the worker may change. Empty array means read-only.',
  },
  deps: {
    type: 'array',
    items: { type: 'string' },
    description: 'Task card: what must already exist or be true before this dispatch can work.',
  },
  verify: {
    type: 'string',
    description: 'Task card: the command that proves the work is done.',
  },
  fallback: {
    type: 'string',
    description: 'Task card: what to do when the work fails, so failure is not a surprise.',
  },
  irreversible: {
    type: 'boolean',
    description: 'Set when this dispatch writes or deletes something that cannot be undone. Forces a review even when the card is complete.',
  },
  review: {
    type: 'boolean',
    description: 'Internal: marks a review dispatch. Never set this yourself; it only exists so a review cannot trigger another review.',
  },
  cwd: {
    type: 'string',
    description: 'Initial worker working directory. Relative paths use your current directory; omitted inherits it.',
  },
  description: {
    type: 'string',
    required: true,
    description: 'A short (3-5 word) description of the delegated task, for display.',
  },
  prompt: {
    type: 'string',
    required: true,
    description: 'The complete task for the worker. It does not see this conversation.',
  },
  provider: {
    type: 'string',
    description:
      "Optional route override, set only when the user explicitly names the provider and model for this one worker. Must be given together with model; when both are omitted the dispatch panel's unified worker route applies. Never choose one on your own initiative." +
      ' This one dispatch only; never reuse a model from earlier turns or a summary.',
  },
  model: {
    type: 'string',
    description:
      "Optional route override, set only when the user explicitly names the provider and model for this one worker. Must be given together with provider; when both are omitted the dispatch panel's unified worker route applies. Never choose one on your own initiative." +
      ' This one dispatch only; never reuse a model from earlier turns or a summary.',
  },
  reasoning_effort: {
    type: 'string',
    description:
      'Optional, only with provider and model: the reasoning effort for this one worker. Omit it to let the selected model resolve its own default; set it only when the user names it.',
  },
}
