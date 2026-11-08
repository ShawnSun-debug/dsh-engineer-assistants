import * as fsp from 'node:fs/promises'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z as zod } from 'zod'
import { DELIVERY } from './api.js'
import { collectCatalog, createCatalogPublisher } from './catalog.js'
import { createDispatchTool } from './dispatch.js'
import { mountDshGo } from './dshgo.js'
import { effectiveAllowed, installGate, isDelegatedChild } from './gate.js'
import { installToolSurface } from './tool-surface.js'
import { MASTER_ROLES, WORKER_STATE, WORKER_STATES, initialMasterState, reduceMasterState } from './master-state.js'
import { CATEGORIES, assignSession, findAssignment, finishSession, isTerminal, reopenSession, reserveChildId } from './assignments.js'
import { MASTER_SERVICE_KEY, MasterRemote } from './master-panel.js'
import { PANEL_ENDED_LIMIT, PANEL_SERVICE_KEY, PanelRemote } from './panel-remote.js'
import { createReporter } from './reporter.js'
import { DEFAULT_INBOUND_POLICY, MAX_MESSAGE_BYTES, MAX_MESSAGE_QUEUE, deliverMessage } from './master-messaging.js'
import { createInspector } from './inspector.js'
import { DEFAULT_TIMEOUT_MS as DANGER_CONFIRM_TIMEOUT_MS, createDangerGate } from './danger.js'
import { createDangerPolicy } from './danger-runtime.js'
import { MASTER_SESSION_ID, disposeMaster, ensureMaster, noticeSource } from './master-session.js'
import { MEMORY_INDEX_SECTION, MEMORY_SECTION_ORDER, openMemoryDomain } from './memory.js'
import { collectText } from './orchestrate.js'
import { buildReviewPrompt, parseReviewText } from './review.js'
import { buildSpawnActivation, readReviewRoute } from './worker.js'
import { RETRY_SOURCE_KIND, createRetry } from './retry.js'
import {
  DISPATCH_COMMAND,
  VIOLATION_LIMIT,
  authorityFor,
  buildPolicy,
  createAuthority,
  createViolationRing,
  listViolations,
} from './secretary-authority.js'
import { DEFAULT_BEAT_SECONDS, DEFAULT_MAX_RUN_SECONDS, createBeat } from './secretary-beat.js'
import { CHANGE_KINDS } from './secretary-constants.js'
import { pickTarget } from './secretary-deliver.js'
import { applyDraftTriggers, createDraftStore } from './secretary-nudge.js'
import {
  SECRETARY_SERVICE_KEY,
  SecretaryRemote,
  collectOrchestratorRows,
  composeViewState,
  notifyOnFrom,
  readSessionTitles,
  registryConflictOf,
} from './secretary-panel.js'
import { normalizeRegistry } from './secretary-registry.js'
import { createBlockedWake, createSecretaryTools } from './secretary-tools.js'
import { createTriggerState, detectTrigger } from './secretary-watch.js'
import { STAGES, initialState, reduceStage } from './stage.js'
import { createSettlements } from './settle.js'
import { SUPERVISE_SOURCE_KIND, createSupervisor } from './supervise.js'

export { SUPERVISE_SOURCE_KIND }
// Cross-session messaging (ticket 06) is a library seam, not a tool: the ticket asks for
// the protocol, and whoever later owns the message entry (a tool, a panel action) calls
// these three functions instead of reimplementing the rules.
export {
  INBOUND_POLICIES,
  MESSAGE_SOURCE_KIND,
  checkInbound,
  composeMessage,
  deliverMessage,
} from './master-messaging.js'

export const name = 'dsh-engineer-assistants'

/**
 * Services used here: the projection registry, the tool registry, the subagent
 * service, the live agent/session registries the supervision adapters read, and the
 * web server the design route registers on (an optional service at runtime: apply
 * still loads when a host has none).
 */
export const inject = ['sessionProjections', 'tools', 'subagents', 'agents', 'sessions', 'webServer']

/**
 * Stage projection. The registry calls `.parse` on these schemas, so they must be
 * zod schemas (schemastery objects have no `.parse`), as the native plan projection does.
 */
const stageProjection = {
  key: 'orchestrator',
  stateVersion: 1,
  stateSchema: zod.object({ stage: zod.enum(STAGES), plan: zod.boolean() }).strict(),
  init: (_header, inheritedEventCount) => initialState(inheritedEventCount),
  apply: reduceStage,
  wire: {
    viewSchema: zod.object({ stage: zod.enum(STAGES), plan: zod.boolean() }),
    view: (state) => ({ stage: state.stage, plan: state.plan }),
  },
}

/**
 * Cross-project worker status (ticket 02). The master and its panel ask "who is
 * running, who is waiting, who is done" of every session, and each session's own
 * log answers for that session — one row per fold. It is registered for every
 * session unconditionally: `apply` is a synchronous pure fold that reads no
 * service, calls no model and writes nothing, and a host-only unit (no `wire`)
 * changes no client view, so an unread row costs one object per event and no
 * observable behaviour. A switch would only guess which future feature owns the
 * key, and a unit registered late refolds the whole log anyway.
 */
const masterProjection = {
  key: 'orchestrator-master',
  stateVersion: 1,
  stateSchema: zod
    .object({
      workers: zod.array(
        zod.object({
          id: zod.string(),
          role: zod.enum(MASTER_ROLES),
          state: zod.enum(WORKER_STATES),
          summary: zod.string(),
        }),
      ),
      // Present only while a blocking tool call waits: the call id whose result is
      // the answer. Optional so an older checkpoint without it still parses.
      pending: zod.string().optional(),
    })
    .strict(),
  init: (header) => initialMasterState(header),
  apply: reduceMasterState,
}

/**
 * The tools a main agent keeps while orchestration mode is on — the shipped whitelist.
 *
 * The gate is whitelist-driven: this list is the whole surface a main agent has, and
 * every other tool the host offers (files, search, shells, fetch, the native
 * `subagent`/`workflow`, and any plugin or MCP tool) is hidden and refused. The order is
 * fixed because the panel and the client fallback mirror it literally.
 */
export const DEFAULT_ALLOWED_TOOLS = [
  // Delegation & worker control — this plugin registers one entry, `dispatch`
  'dispatch',
  'send_message',
  'interrupt_agent',
  // Planning, user clarification & context compression
  'todo_write',
  'ask_user_question',
  'compress',
  // Read-only session history inspection
  'session_search',
  'session_trace',
  'session_event_search',
  'session_event_read',
  'session_event_trace',
]

/**
 * Every field is volatile so a switch or settings card can rewrite it without
 * editing the profile file. `enabled` and `allowedTools` are read live by the guard,
 * so the switch and the whitelist reach conversations that are already open. The worker
 * route is read on every delegation, so it applies from the next `delegate` call.
 */
export const Config = z.object({
  /** Hide the creation tools from top-level agents. Delegated children keep them. */
  enabled: z.boolean().default(true).volatile(),
  /**
   * The only tool whitelist there is. Whitelist-driven: only the names listed here stay
   * available to the main agent, and every other host, MCP or plugin tool is filtered out.
   * Workers always keep the full tool set.
   *
   * That is only the default: the panel may check any tool the host offers.
   * The visible surface is filtered per request by `installToolSurface`, a wrapper over
   * `tools.definitions`; `installGate` only installs `tools.guard`, which refuses at
   * execution time what the filter left out (scope-local tools such as the native
   * `subagent` included). `tools.restrict` survives for one caller only: the dispatch
   * claim, whose scope policy belongs to another layer. Read on every gated call, so a
   * panel change applies to open conversations.
   */
  allowedTools: z
    .array(z.string())
    .default(DEFAULT_ALLOWED_TOOLS)
    .description(
      'Tools allowed for the main agent while orchestration mode is enabled. ' +
        'Whitelist-driven: only tools in this list are available to the main agent; ' +
        'every other host, MCP, or plugin tool is automatically hidden and blocked. ' +
        'Workers always keep the full tool set.'
    )
    .volatile(),
  /**
   * Read-only mirror of every tool the running host has registered, published by the plugin
   * for the Allowed Tools panel: a web client cannot enumerate tools itself, so the catalog
   * is handed to it through the config form it already reads (lib/catalog.js). It feeds both
   * sides — the panel's complete checklist and the gate's set of names the whitelist leaves
   * out — and is recomputed from the live registry on every `tools/change`. Never written by
   * the panel and never persisted — a settings edit stores only the paths it names — and
   * empty until the first publish, which keeps the panel's built-in fallback on a host that
   * cannot be enumerated.
   */
  toolCatalog: z.array(z.string()).default([]).volatile(),
  /** Route every `delegate` worker runs on. Empty means unconfigured, which fails loudly. */
  workerProvider: z.string().default('').volatile(),
  workerModel: z.string().default('').volatile(),
  /** Optional. Empty leaves the effort out so the worker model resolves its own default. */
  workerReasoningEffort: z.string().default('').volatile(),
  /**
   * 评审路由（ADR 0004）。留空即跟随 worker 路由——闸门默认零成本；
   * 需要更强的评审时单独指定，不影响任何 worker。
   */
  reviewProvider: z.string().default('').volatile(),
  reviewModel: z.string().default('').volatile(),
  reviewReasoningEffort: z.string().default('').volatile(),
  /** 最近一次评审的结论，JSON 字符串。空串表示本次会话还没评审过。只写不读，供面板展示。 */
  lastReview: z.string().default('').volatile(),
  /**
   * Supervision of long-running `delegate` children. Every field is volatile and
   * read again on each scan, so a settings change applies without a restart.
   * `orchestrate` workers are deliberately not supervised: their parent waits
   * inside the tool call, so a notice would always be stale by the time it ran.
   */
  superviseEnabled: z.boolean().default(true).volatile(),
  /** How long a child may run before its parent is woken with one summary notice, in seconds. */
  superviseIntervalSeconds: z.number().min(10).max(86400).step(1).default(600).volatile(),
  /** Notices allowed per child; 0 turns supervision off unless superviseUnlimited is on. */
  superviseMaxNoticesPerChild: z.number().min(0).max(20).default(3).volatile(),
  /** Ignore the notice cap and keep supervising until the child stops, delivers, or ends. */
  superviseUnlimited: z.boolean().default(false).volatile(),
  /** Also notify when a child produced no new events; off saves a model turn. */
  superviseNotifyOnNoProgress: z.boolean().default(false).volatile(),
  /**
   * 全局 master 记忆层（票 01），默认关闭。开关在插件挂载时读取：打开时创建记忆域并
   * 注册一段紧凑索引注入；关闭时不打开域、不注册注入段，既有会话行为不变。
   */
  masterMemoryEnabled: z.boolean().default(false).volatile(),
  /**
   * Master 状态面板（票 03），默认关闭。关闭时客户端不渲染面板，服务端的
   * masterState 端点也只返回空投影，不向客户端暴露任何 worker 数据。
   */
  masterPanelEnabled: z.boolean().default(false).volatile(),
  /**
   * 常驻 master 会话（票 05），默认关闭。开关在插件挂载时读取：打开时先按固定 id resume
   * 一个已落盘的无 cwd 根会话，resume 失败才 create；通知经 followup 投喂并在投喂后
   * flush；卸载路径先 flush 再 dispose。关闭时不接任何线，既有会话行为不变。
   */
  masterSessionEnabled: z.boolean().default(false).volatile(),
  /**
   * 跨会话消息（票 06），默认关闭。开关不产生任何副作用，只在一次投递时被
   * `masterMessagingSettings` 读取：关闭时投递直接以 reason 'disabled' 拒绝，
   * 不构造消息、不接触接收方。默认关闭意味着既有会话的入站面完全不变。
   */
  masterMessagingEnabled: z.boolean().default(false).volatile(),
  /**
   * 入站策略（票 06）：`accept` 直接投递、`hold` 排队等待、`refuse` 丢弃。
   * 未知值由 `checkInbound` 判为 `unknown-policy` 拒绝，而不是悄悄当成 accept。
   */
  masterInboundPolicy: z.string().default(DEFAULT_INBOUND_POLICY).volatile(),
  /**
   * 秘书触发侦测（秘书 spec 票 03），默认关闭。开关只在插件挂载时读一次：打开时才
   * 订阅会话事件、才注册 effect；关闭时既有的会话行为完全不变（票面要求）。
   */
  secretaryEnabled: z.boolean().default(false).volatile(),
  /**
   * 秘书登记表（秘书 spec 票 01）。设置页写的只有存储面：哪个会话是 Master/秘书、
   * 哪些会话是允许被读取的 orchestrator。规则在 lib/secretary-registry.js；票 01 本身
   * 不接运行时行为（第一个监听是票 03 的 secretary watch）。六把键都标 volatile，设置页
   * 写一次就生效且随配置落盘，重启后读回。
   */
  secretaryMasterSessionId: z.string().default('').volatile(),
  /** 一行一个被跟踪的 orchestrator；workspace / title 只用于展示，trackedAt 是登记时刻。 */
  secretaryOrchestrators: z
    .array(
      z.object({
        sessionId: z.string(),
        workspace: z.string().default(''),
        title: z.string().default(''),
        trackedAt: z.number().default(0),
      }),
    )
    .default([])
    .volatile(),
  /** 汇报节拍：默认 3 分钟，同 superviseIntervalSeconds 一样以秒为单位、可设到 1 天。 */
  secretaryBeatSeconds: z.number().min(10).max(86400).default(DEFAULT_BEAT_SECONDS).volatile(),
  /** 一次编排最长跟踪多久：默认 2 小时，到点停表，免得卡住的运行一直写汇报。 */
  secretaryMaxRunSeconds: z.number().min(60).max(86400).default(DEFAULT_MAX_RUN_SECONDS).volatile(),
  /**
   * 允许冒泡的五类实质变化。存名字而不是布尔开关，后续票要加一类时不必改 Config；
   * 认不出的名字由读取方忽略，而不是当成"全部打开"。
   */
  secretaryNotifyOn: z
    .array(z.string())
    .default([...CHANGE_KINDS])
    .volatile(),
  /** 被选为 Master 时注入的常驻口径；空串表示用内置默认文案（后续票读取）。 */
  secretaryPromptText: z.string().default('').volatile(),
  /**
   * 卡点唤醒（默认关闭）。为真时，被跟踪会话出现卡点（Needs input / registry.conflict /
   * 新建催办草稿）会向 Master 会话投递一条简短唤醒，同一会话同一卡点只唤醒一次（进程内
   * 内存 Set 去重）。默认关闭意味着打开这笔设置之前一条消息都不发。
   */
  secretaryWakeOnBlocked: z.boolean().default(false).volatile(),
})

/** Read one config field whether it is a schemastery ref or a plain value. */
function configValue(config, key, fallback) {
  try {
    const field = config?.[key]
    const value = typeof field?.get === 'function' ? field.get() : field
    return value === undefined || value === null ? fallback : value
  } catch {
    return fallback
  }
}

/** A config field that must read as a string; anything else is '' (the "not set" route value). */
function configText(config, key) {
  const value = configValue(config, key, '')
  return typeof value === 'string' ? value : ''
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read the cross-session messaging switch and limits for one delivery (ticket 06).
 *
 * The switch and the policy are volatile, so this is read per message — a settings flip
 * applies to the next delivery without a restart. The size and queue ceilings are
 * constants for now ({@link MAX_MESSAGE_BYTES}, {@link MAX_MESSAGE_QUEUE}): the ticket
 * asked for the protocol, not for two more knobs, and a caller can still pass explicit
 * limits to `deliverMessage`.
 */
export function masterMessagingSettings(config) {
  return {
    enabled: configValue(config, 'masterMessagingEnabled', false) === true,
    policy: configValue(config, 'masterInboundPolicy', DEFAULT_INBOUND_POLICY),
    maxBytes: MAX_MESSAGE_BYTES,
    maxQueue: MAX_MESSAGE_QUEUE,
  }
}

/**
 * Read an optional host service. Memory is an add-on, so `systemPrompt` and
 * `storageDomain` are deliberately not in the plugin's required `inject` list:
 * a host that lacks either must still load every other feature.
 */
function optionalService(ctx, name) {
  try {
    if (typeof ctx?.get === 'function') {
      const value = ctx.get(name)
      if (value !== undefined) return value
    }
  } catch {
    // A context that cannot answer `get` falls back to the direct property.
  }
  try {
    return ctx?.[name]
  } catch {
    return undefined
  }
}

/**
 * 一组模型路由：provider / model / effort 三个字符串，空串表示未设。
 *
 * 宿主 agentDefaultModel 的 currentSelection() 返回 { provider, model, reasoningEffort? }，
 * 未设 effort 时直接省略那个键（不是空串），所以读侧必须补 ''；本插件自己的 Config 键叫
 * workerReasoningEffort / reviewReasoningEffort，透出时统一改名成 effort。
 */
function routeOfSelection(selection) {
  const source = selection !== null && typeof selection === 'object' ? selection : {}
  const field = (value) => (typeof value === 'string' ? value : '')
  return { provider: field(source.provider), model: field(source.model), effort: field(source.reasoningEffort) }
}

/**
 * 沙箱锁：把调度指挥钉成 read-only（草图 B 的第二道文件锁）。
 *
 * 写入路径就是宿主自己那条：会话日志里的一条 sandbox/mode 事件（dsh-sandbox-policy 的
 * setSandboxMode 写的正是它，投影负责把它折进每一次受限调用）。这里刻意不 import 宿主包：
 * 插件跑在宿主里，宿主包不是本 repo 的依赖；服务名用 ctx.get 探测（Context 上叫
 * sandboxPolicy），缺了只 warn——工具遮罩仍然生效，少的只是这一层。
 *
 * 还原读会话自己的 override（overrideOf）；没有 override 就写回部署默认
 * （resolve({}).mode）。两个都读不到时不写任何东西：宁可让这次会话继续只读，也不猜一个
 * 可能比原来更宽的档位。
 */
const SANDBOX_READ_ONLY = 'read-only'

function createHostSandboxLock(ctx, warn) {
  return {
    lock(agent) {
      const session = agent?.session
      if (session === null || typeof session?.append !== 'function') return undefined
      const policy = optionalService(ctx, 'sandboxPolicy')
      if (policy === undefined || policy === null) {
        warn('orchestrator: secretary authority: ctx.sandboxPolicy is unavailable; the host sandbox lock is not applied')
        return undefined
      }
      let previous
      try {
        previous = typeof policy.overrideOf === 'function' ? policy.overrideOf(session) : undefined
      } catch {
        previous = undefined
      }
      try {
        session.append('sandbox/mode', { mode: SANDBOX_READ_ONLY })
      } catch (error) {
        warn('orchestrator: secretary authority: cannot pin the sandbox to read-only: ' + messageOf(error))
        return undefined
      }
      return () => {
        let restore = previous
        if (typeof restore !== 'string' || restore === '') {
          try {
            const resolved = typeof policy.resolve === 'function' ? policy.resolve({}) : undefined
            restore = resolved?.mode
          } catch {
            restore = undefined
          }
        }
        if (typeof restore !== 'string' || restore === '') {
          warn('orchestrator: secretary authority: the previous sandbox mode is unknown; the session stays read-only')
          return
        }
        try {
          session.append('sandbox/mode', { mode: restore })
        } catch (error) {
          warn('orchestrator: secretary authority: cannot restore the sandbox mode: ' + messageOf(error))
        }
      }
    },
  }
}

/**
 * 审批锁：把调度指挥钉成 never（同一个第二道锁）。写入路径同样是会话日志里的
 * approval/policy 事件（dsh-user-approval 的 setApprovalPolicy）；服务在 Context 上叫
 * approval。还原优先用本次会话自己的 override，没有就写回部署默认（approval.config.policy，
 * 只接受 ask / never），再读不到才退回 ask。
 */
function createHostApprovalLock(ctx, warn) {
  return {
    lock(agent) {
      const session = agent?.session
      if (session === null || typeof session?.append !== 'function') return undefined
      const approval = optionalService(ctx, 'approval')
      if (approval === undefined || approval === null) {
        warn('orchestrator: secretary authority: ctx.approval is unavailable; the approval lock is not applied')
        return undefined
      }
      let previous
      try {
        previous = typeof approval.overrideOf === 'function' ? approval.overrideOf(session) : undefined
      } catch {
        previous = undefined
      }
      try {
        session.append('approval/policy', { policy: 'never' })
      } catch (error) {
        warn('orchestrator: secretary authority: cannot pin the approval policy to never: ' + messageOf(error))
        return undefined
      }
      return () => {
        let restore = previous
        if (restore !== 'ask' && restore !== 'never') {
          const configured = approval?.config?.policy
          restore = configured === 'ask' || configured === 'never' ? configured : 'ask'
        }
        try {
          session.append('approval/policy', { policy: restore })
        } catch (error) {
          warn('orchestrator: secretary authority: cannot restore the approval policy: ' + messageOf(error))
        }
      }
    },
  }
}

/**
 * The host's host-protocol entry for one plugin-authored child prompt.
 *
 * `subagents.sendMessage` requires the exact live sender agent, so a plugin cannot use it
 * without impersonating the parent. This symbol-keyed entry is the supported alternative:
 * it takes a durable `source` descriptor, and `'queue'` makes the prompt a distinct new
 * turn — which is what a retry needs, because the child that failed is not running one.
 */
const DELIVER_PROMPT = Symbol.for('dsh.subagent.deliverPrompt')

/**
 * Queue one plugin-authored turn on a delegated child, cold-resuming it when it is gone.
 * Exported so the adapter can be driven with plain objects instead of a running host.
 */
export async function deliverRetryPrompt(ctx, parentId, childId, text) {
  const deliver = ctx?.subagents?.[DELIVER_PROMPT]
  if (typeof deliver !== 'function') throw new Error('the host does not expose dsh.subagent.deliverPrompt')
  const parent = ctx?.agents?.get?.(parentId)
  if (parent === undefined || parent === null) throw new Error(`the main agent ${parentId} is not live`)
  // A notice must carry its one-line summary (dsh-llm ContextFormed).
  const source = noticeSource(RETRY_SOURCE_KIND, text)
  return deliver.call(ctx.subagents, parent, childId, [{ type: 'text', text }], source, new AbortController().signal, 'queue')
}

/**
 * Build the host side of supervision: the four adapters `createSupervisor`
 * needs, bound to the live registries. Exported so tests can drive the
 * adapters with plain objects instead of a running host.
 *
 * `loadLlm` is injectable only so the lazy import can be exercised without the
 * host package: production always uses the dynamic `@deepseek-ai/dsh-llm`
 * import, which is never a top-level import (the plugin must load even when the
 * package is not resolvable in a unit test).
 */
export function createSupervision({ ctx, config, logger = ctx?.logger, loadLlm = () => import('@deepseek-ai/dsh-llm') }) {
  let pendingWarned = false
  let llmWarned = false
  const warn = (message) => {
    try {
      logger?.warn?.(message)
    } catch {
      // A logger must never break the timer or a dispatch.
    }
  }

  /** `ctx.agents.get(id)` returning undefined is the host's "not live" answer. */
  const isParentAlive = (parentId) => ctx?.agents?.get?.(parentId) !== undefined
  const isChildAlive = (childId) => ctx?.agents?.get?.(childId) !== undefined

  /**
   * The child's own session log. `Session.log` is the append-only event array
   * (`seq`, `time`, `type`, `data`); the supervisor reads it directly, which
   * costs no model tokens.
   */
  const readEvents = (childId) => {
    const session = ctx?.sessions?.get?.(childId)
    if (session === undefined || session === null) throw new Error(`no live session for child ${childId}`)
    if (!Array.isArray(session.log)) throw new Error(`session ${childId} has no readable event log`)
    return session.log
  }

  /**
   * Whether the parent already has an undelivered supervision notice. The inbox
   * projection state is `{ 'next-turn': Message[], 'next-step': Message[] }`;
   * its shape is not a declared public API, so every failure here is swallowed:
   * returning false risks one duplicate notice, while throwing would make the
   * supervisor treat every parent as always pending.
   */
  const hasPendingNotice = (parentId) => {
    const parent = ctx?.agents?.get?.(parentId)
    if (parent === undefined || parent === null) return false
    try {
      const stateOf = ctx?.sessionProjections?.stateOf
      if (typeof stateOf !== 'function') throw new Error('sessionProjections.stateOf is unavailable')
      const state = stateOf.call(ctx.sessionProjections, parent.session, 'inbox')
      if (state === undefined || state === null) throw new Error('the inbox projection returned no state')
      for (const bucket of ['next-turn', 'next-step']) {
        const pending = state[bucket]
        if (!Array.isArray(pending)) continue
        for (const message of pending) {
          if (message?.source?.kind === SUPERVISE_SOURCE_KIND) return true
        }
      }
      return false
    } catch (error) {
      if (!pendingWarned) {
        pendingWarned = true
        warn(`orchestrator: supervision: cannot read the parent inbox; duplicate notices are possible: ${messageOf(error)}`)
      }
      return false
    }
  }

  /**
   * Queue one notice on the parent with `followup` — never `steer`, which would
   * splice into a user turn that is already running. A missing parent is final
   * (`parent-gone`); a missing `@deepseek-ai/dsh-llm` is not fatal: return
   * `unavailable` so the supervisor logs it and keeps the notice budget.
   *
   * `kind` is the durable `source.kind` the notice carries. Supervision keeps its own
   * kind, because `hasPendingNotice` looks for exactly that kind in the parent inbox;
   * the retry policy uses a second one, so neither ever reads the other's queue.
   */
  const deliverAs = async (kind, parentId, text, childIds) => {
    const parent = ctx?.agents?.get?.(parentId)
    if (parent === undefined || parent === null) return 'parent-gone'
    // The dynamic import is not retried once it failed: the supervisor reschedules
    // without spending the child's budget, and one warning is enough.
    if (llmWarned) return 'unavailable'

    let llm
    try {
      llm = await loadLlm()
    } catch (error) {
      if (!llmWarned) {
        llmWarned = true
        warn(`orchestrator: supervision: cannot load @deepseek-ai/dsh-llm; notices are disabled: ${messageOf(error)}`)
      }
      return 'unavailable'
    }
    if (typeof llm?.createUserMessage !== 'function') {
      if (!llmWarned) {
        llmWarned = true
        warn('orchestrator: supervision: @deepseek-ai/dsh-llm does not export createUserMessage; notices are disabled')
      }
      return 'unavailable'
    }

    const source = noticeSource(kind, text, Array.isArray(childIds) ? childIds[0] : undefined)
    const message = llm.createUserMessage({ content: [{ type: 'text', text }], source })
    parent.followup(message)
    try {
      const flushed = await ctx?.sessions?.flush?.(parent.session)
      if (flushed === false) warn('orchestrator: supervision: the notice was queued but session flush did not acknowledge it')
    } catch (error) {
      warn(`orchestrator: supervision: the notice was queued but session flush failed: ${messageOf(error)}`)
    }
    return 'queued'
  }

  const deliver = (parentId, text, childIds) => deliverAs(SUPERVISE_SOURCE_KIND, parentId, text, childIds)

  /** The retry notice: same delivery, its own `source.kind`. */
  const deliverRetry = (parentId, text, childIds) => deliverAs(RETRY_SOURCE_KIND, parentId, text, childIds)

  // Live getters: an interval change applies without rebuilding the supervisor.
  const liveConfig = {
    get enabled() {
      return configValue(config, 'superviseEnabled', true) !== false
    },
    get intervalSeconds() {
      return configValue(config, 'superviseIntervalSeconds', 600)
    },
    get maxNoticesPerChild() {
      return configValue(config, 'superviseMaxNoticesPerChild', 3)
    },
    get unlimited() {
      return configValue(config, 'superviseUnlimited', false) === true
    },
    get notifyOnNoProgress() {
      return configValue(config, 'superviseNotifyOnNoProgress', false) === true
    },
  }

  const supervisor = createSupervisor({
    config: liveConfig,
    now: () => Date.now(),
    isParentAlive,
    isChildAlive,
    readEvents,
    hasPendingNotice,
    deliver,
    logger,
  })

  /**
   * The highest `seq` in the child's log right now. A cold-resumed worker re-enters the
   * registry with this as its baseline, so its pre-interrupt history is not summarised
   * again as new activity. An unreadable log is simply "no baseline".
   */
  const headSeq = (childId) => {
    let head = 0
    try {
      for (const event of readEvents(childId)) {
        const seq = event?.seq
        if (typeof seq === 'number' && Number.isFinite(seq) && seq > head) head = seq
      }
    } catch {
      return 0
    }
    return head
  }

  return { supervisor, isParentAlive, isChildAlive, readEvents, headSeq, hasPendingNotice, deliver, deliverRetry }
}

/**
 * The `onStarted` callback for the delegate tool: register the child, and drop
 * it once its receipt settles (either way). `onResumed` re-arms that same child when a
 * `send_message` cold resume recreates it. Exported for the same reason as
 * `createSupervision` — a plain recording object is enough to test it.
 */
export function createSupervisionHooks(supervisor, { headSeq, retry, settlements, panel } = {}) {
  const callPanel = (name, ...args) => {
    const fn = panel !== null && typeof panel === 'object' ? panel[name] : undefined
    if (typeof fn !== 'function') return
    try {
      fn(...args)
    } catch {
      // 登记表是面板的账，不是派发的账：写不进去也不能影响这次派发。
    }
  }
  const forget = (childId) => {
    try {
      supervisor.forget(childId)
    } catch {
      // A registry failure here cannot affect the dispatch either.
    }
  }

  /**
   * The children this plugin dispatched itself, oldest first. Only these may be re-armed
   * by a cold resume: the host's own `subagent` tool also creates delegated children, and
   * they never entered supervision, so resuming one must not start a timer on it. The map
   * is bounded because a long-lived host never reports a worker gone for good.
   */
  const dispatched = new Map()
  const MAX_DISPATCHED = 128
  const remember = (childId, record) => {
    dispatched.delete(childId)
    dispatched.set(childId, record)
    while (dispatched.size > MAX_DISPATCHED) {
      const oldest = dispatched.keys().next().value
      dispatched.delete(oldest)
    }
  }

  const baselineOf = (childId) => {
    try {
      const value = typeof headSeq === 'function' ? headSeq(childId) : undefined
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
    } catch {
      return 0
    }
  }

  return {
    onStarted(parent, started, args) {
      const childId = started?.childId
      const parentId = parent?.id
      if (typeof childId !== 'string' || typeof parentId !== 'string') return
      // 预设的类别与 id 跟着这一行走（票 15）：v2 派发工具把它放在入参里，旧 delegate 没有
      // 这两个键，于是登记行留空并如实画成「未施加预设」。
      const preset = {
        label: args?.description,
        presetId: typeof args?.presetId === 'string' ? args.presetId : '',
        category: typeof args?.category === 'string' ? args.category : '',
      }
      remember(childId, { parentId, ...preset })
      // The retry policy keys on the same record: a child this plugin did not dispatch is
      // never retried, so the host's own `subagent` children stay untouched.
      try {
        retry?.track?.(childId, { parentId, label: args?.description })
      } catch {
        // A retry bookkeeping failure cannot affect the dispatch.
      }
      // 面板的行从这里来：这是插件唯一确定「这个子会话是我派的」的时刻。
      callPanel('dispatched', childId, { parentId, ...preset })
      try {
        supervisor.track({ childId, parentId, label: args?.description, startedAt: Date.now() })
      } catch {
        // Still subscribe to the receipt below: an untracked child is harmless.
      }
      const settled = started?.result
      if (settled !== null && typeof settled === 'object' && typeof settled.then === 'function') {
        try {
          settled.then(
            () => {
              // 落定：先记账，再摘出巡检到期集。日志留在宿主侧，重试还要读。
              settlements?.settle?.(childId, { ok: true })
              callPanel('settled', childId, { ok: true })
              forget(childId)
            },
            (error) => {
              settlements?.settle?.(childId, { ok: false, reason: error instanceof Error ? error.message : String(error) })
              callPanel('settled', childId, { ok: false })
              forget(childId)
            },
          )
        } catch {
          // A hostile thenable must not break the dispatch.
        }
      }
    },

    /**
     * A cold resume is a fresh activation of a worker the receipt once released, so the
     * registry has no entry for it any more. Re-arm it from the dispatch record (the host
     * gives no `result` here, so cleanup falls back to the liveness, budget and parent
     * rules inside the supervisor). A child this plugin never dispatched, or one already
     * tracked, is left alone — a repeated event must not restart the clock or the budget.
     */
    onResumed(agent) {
      const childId = agent?.id
      if (typeof childId !== 'string' || childId === '') return
      const record = dispatched.get(childId)
      if (record === undefined) return
      try {
        if (typeof supervisor.has === 'function' && supervisor.has(childId)) return
      } catch {
        // An unreadable registry means "no entry"; re-tracking is idempotent anyway.
      }
      // 冷恢复同样是「这个 worker 又活着了」，面板上的行要跟着回来；预设的类别与 id 从
      // 派发记录里带回来，冷恢复不该把一行「有预设」画成「未施加预设」。
      callPanel('dispatched', childId, {
        parentId: record.parentId,
        label: record.label,
        presetId: record.presetId,
        category: record.category,
      })
      try {
        supervisor.track({
          childId,
          parentId: record.parentId,
          label: record.label,
          startedAt: Date.now(),
          resumed: true,
          sinceSeq: baselineOf(childId),
        })
      } catch {
        // Supervision is best-effort; the resumed worker still runs without it.
      }
    },

    forget,
  }
}

/**
 * Attach the master memory layer (ticket 01): open the memory domain and register
 * the one prompt section carrying its compact index. Called by `apply` only while
 * the switch is on. A host without the storage domain, or a domain that fails to
 * open, is reported through the logger and the rest of the plugin keeps working.
 *
 * The section text is a provider over the opened facade rather than a snapshot:
 * `PromptSection.text` receives only `{ scope, signal }`, so there is no
 * assembly context to hand the index through. While the domain is still opening
 * (or after an open failure) the provider returns the empty string, which the
 * renderer drops — so a failed memory layer injects nothing.
 *
 * @returns the memory facade once opened, or undefined when the feature is off
 * or unavailable.
 */
export async function attachMasterMemory(ctx, config) {
  if (configValue(config, 'masterMemoryEnabled', false) !== true) return undefined
  const warn = (message) => {
    try {
      ctx?.logger?.warn?.('orchestrator: memory: ' + message)
    } catch {
      // A logging failure must not break plugin startup.
    }
  }

  const storageDomain = optionalService(ctx, 'storageDomain')
  if (storageDomain === undefined || storageDomain === null || typeof storageDomain.open !== 'function') {
    warn('ctx.storageDomain is unavailable (the storage-domain plugin is not mounted); memory stays off')
    return undefined
  }
  const prompt = optionalService(ctx, 'systemPrompt')
  if (prompt === undefined || prompt === null || typeof prompt.section !== 'function') {
    warn('ctx.systemPrompt is unavailable; the memory index cannot be injected')
    return undefined
  }

  const state = { memory: undefined, close: undefined, disposed: false }
  ctx.effect(
    () => () => {
      state.disposed = true
      state.memory = undefined
      const close = state.close
      state.close = undefined
      if (typeof close !== 'function') return
      void Promise.resolve()
        .then(close)
        .catch((error) => warn('cannot close the memory domain: ' + messageOf(error)))
    },
    'orchestrator: master memory domain',
  )
  ctx.effect(
    () =>
      prompt.section({
        name: MEMORY_INDEX_SECTION,
        order: MEMORY_SECTION_ORDER,
        // Stored notes are arbitrary text: interpolating `{{...}}` in them would fail
        // assembly for any entry that happens to look like a prompt variable.
        interpolate: false,
        text: () => {
          if (state.memory === undefined) return ''
          try {
            return state.memory.indexText()
          } catch (error) {
            return 'AI 记忆索引不可用（' + messageOf(error) + '）'
          }
        },
      }),
    'orchestrator: master memory index',
  )

  try {
    const opened = await openMemoryDomain(storageDomain)
    if (state.disposed) {
      await opened.close()
      return undefined
    }
    state.memory = opened.memory
    state.close = opened.close
    return opened.memory
  } catch (error) {
    warn('cannot open the memory domain: ' + messageOf(error))
    return undefined
  }
}

/**
 * Attach the persistent master session (ticket 05): one root agent without a working
 * directory, found again by its fixed id on every later start. Called by `apply`
 * only while the switch is on, so an off switch owns no agent, registers no effect
 * and never touches the registry.
 *
 * The lifecycle is owned by two effects, and the order is load-bearing: cordis runs
 * disposers in reverse registration order, and disposing an agent drops its buffered
 * events without writing them (ticket-04 spike). The master effect is therefore
 * registered *after* the agent exists, so it flushes before the agent's own teardown;
 * the shutdown effect registered here covers the weaker case where the plugin unloads
 * before the master was ever resolved.
 *
 * A failure is logged and swallowed, never thrown: a missing master must not block
 * ordinary orchestration (spec, story 20).
 *
 * @returns `{ ready, state }` for tests and later features (ticket 06); undefined
 *   while the switch is off or the host has no agent registry.
 */
export function attachMasterSession(ctx, config, options = {}) {
  if (configValue(config, 'masterSessionEnabled', false) !== true) return undefined
  const warn = (message) => {
    try {
      ctx?.logger?.warn?.('orchestrator: master: ' + message)
    } catch {
      // A logging failure must not break plugin startup.
    }
  }

  const agents = optionalService(ctx, 'agents')
  if (agents === undefined || agents === null) {
    warn('ctx.agents is unavailable; the persistent master session stays off')
    return undefined
  }
  const sessions = optionalService(ctx, 'sessions')

  const state = { disposed: false, master: undefined }

  // A plugin unload that starts while the master is still being found must be seen by
  // the resolution below; this effect only records it.
  ctx.effect(
    () => () => {
      state.disposed = true
    },
    'orchestrator: master session shutdown',
  )

  const ready = ensureMaster(agents, sessions, { ...options, sessionId: MASTER_SESSION_ID })
    .then(async (master) => {
      if (state.disposed) {
        // The plugin unloaded first: flush what we found, then let it go.
        await disposeMaster(master, sessions).catch((error) =>
          warn('cannot dispose a master that arrived after unload: ' + messageOf(error)),
        )
        return undefined
      }
      state.master = master
      try {
        ctx.effect(
          () => () => {
            const current = state.master
            state.master = undefined
            if (current === undefined) return undefined
            return disposeMaster(current, sessions).catch((error) =>
              warn('cannot save the master session on unload: ' + messageOf(error)),
            )
          },
          'orchestrator: master session',
        )
      } catch (error) {
        // The fiber already went away: nothing will run the disposer, so do the work now.
        state.master = undefined
        await disposeMaster(master, sessions).catch((inner) =>
          warn('cannot dispose the master session: ' + messageOf(inner)),
        )
        warn('cannot own the master session lifecycle: ' + messageOf(error))
      }
      return master
    })
    .catch((error) => {
      warn('cannot start: ' + messageOf(error))
      return undefined
    })

  return { ready, state }
}

/**
 * 秘书常驻口径的默认文案（秘书 spec 票 09）。
 *
 * 设置页的 `secretaryPromptText` 默认是空串；空串必须仍然注入一段可用口径，否则
 * 「指定了 Master 却什么都没注入」。作者填了文本（去首尾空白后非空）就以作者的为准。
 */
export const DEFAULT_SECRETARY_PROMPT = [
  '你是这个工作区的秘书：只汇总、只汇报，不替用户或 Master 做决定。',
  '汇报写清事实、依据与结论；遇到卡点必须单独写出「我需要做什么」，不要等用户追问。',
  '催办他人之前先得到用户确认；只读用户登记过的会话，未登记的一概不读。',
].join('\n')

/** 常驻口径的 section 名。 */
export const SECRETARY_PERSONA_SECTION = 'orchestrator:secretary'
/** 排在记忆索引（490）之后、计划口径（500）之前：口径是策略，记忆是上下文。 */
export const SECRETARY_PERSONA_ORDER = 491

/**
 * 这次装配属于哪个会话。
 *
 * 宿主把 agent 自己当作作用域键（`dsh-agent` 的 `assembleContextFor` 返回
 * `{ agent, scope: agent }`），而 `AssembleContext` 的公开声明里只有一个不透明的
 * `scope: ScopeKey`。所以先读 `agent.id`，再从不透明的 scope 上读 `id`；两个都读
 * 不到就返回空串，调用方据此退回「全局生效」。
 */
export function assembledSessionId(context) {
  const agent = context?.agent
  if (typeof agent?.id === 'string' && agent.id !== '') return agent.id
  const scope = context?.scope
  if (scope !== null && typeof scope === 'object' && typeof scope.id === 'string' && scope.id !== '') {
    return scope.id
  }
  return ''
}

/** 要注入的口径文本：作者填了就用作者的，空串（或非字符串）回落默认文案。 */
export function personaTextOf(config) {
  const text = configValue(config, 'secretaryPromptText', '')
  if (typeof text !== 'string') return DEFAULT_SECRETARY_PROMPT
  return text.trim() === '' ? DEFAULT_SECRETARY_PROMPT : text
}

/**
 * 常驻口径的附着器（秘书 spec 票 09）。
 *
 * section 注册在插件根 ctx 上（与记忆索引同一个挂载点），所以它对每个会话的装配都
 * 可见；`text` 在每次装配时现读配置，只对被指定为 Master 的那个会话返回文本，其余
 * 会话返回空串——宿主会把空 section 丢掉，等于没注入。于是改文本不必重新注册，改指定
 * 由 `sync()` 在设置写回（`loader/volatile-update`）时摘挂。
 *
 * 边界：装配上下文拿不到会话标识时（老宿主、诊断装配）返回空串并记一条 warn。宁可让
 * Master 少一段口径，也不把秘书口径注入每一个子代理——全局生效正是票 09 要避免的。
 *
 * @returns `{ sync, dispose, text, attached }`；同步调用、失败只 warn 不抛。
 */
export function createSecretaryPersona({ ctx, config }) {
  const warn = (message) => {
    try {
      ctx?.logger?.warn?.('orchestrator: secretary persona: ' + message)
    } catch {
      // 记日志失败不能反过来打断装配。
    }
  }
  const prompt = optionalService(ctx, 'systemPrompt')
  let removeSection
  let ownsLifecycle = false

  const text = (context) => {
    if (configValue(config, 'secretaryEnabled', false) !== true) return ''
    const masterSessionId = configValue(config, 'secretaryMasterSessionId', '')
    if (typeof masterSessionId !== 'string' || masterSessionId === '') return ''
    const sessionId = assembledSessionId(context)
    // 会话标识读不到时不敢猜：空串让宿主丢掉这个 section，口径不会漏进别的会话。
    if (sessionId === '') {
      warn('cannot tell which session is assembling; the secretary prompt is not injected')
      return ''
    }
    if (sessionId !== masterSessionId) return ''
    return personaTextOf(config)
  }

  const dispose = () => {
    const current = removeSection
    removeSection = undefined
    if (current === undefined) return
    try {
      current()
    } catch (error) {
      warn('cannot remove the section: ' + messageOf(error))
    }
  }

  /**
   * 让插件的 effect 生命周期持有 section 的 disposer。只在真的挂载时登记，所以开关关
   * 闭与「未指定 Master」都不产生任何 effect——关闭时零注册不是一句注释。
   */
  const ownLifecycle = () => {
    if (ownsLifecycle) return
    ownsLifecycle = true
    try {
      ctx.effect(() => () => dispose(), 'orchestrator: secretary persona')
    } catch (error) {
      // 宿主自身的注册边界仍会回收 section；这里只是少一层所有权，不该打断装配。
      ownsLifecycle = false
      warn('cannot own the section lifecycle: ' + messageOf(error))
    }
  }

  const sync = () => {
    // 开关关闭与「取消指定」是同一条摘除路径：留着一个不生效的 section 没有意义。
    const masterSessionId =
      configValue(config, 'secretaryEnabled', false) === true
        ? configValue(config, 'secretaryMasterSessionId', '')
        : ''
    if (typeof masterSessionId !== 'string' || masterSessionId === '') {
      dispose()
      return { attached: false, sessionId: '' }
    }
    // 幂等：同名 section 重复注册会被宿主判为重复并抛错。
    if (removeSection !== undefined) return { attached: true, sessionId: masterSessionId }
    if (prompt === undefined || prompt === null || typeof prompt.section !== 'function') {
      warn('ctx.systemPrompt is unavailable; the standing secretary prompt cannot be injected')
      return { attached: false, sessionId: masterSessionId, error: 'ctx.systemPrompt is unavailable' }
    }
    try {
      ownLifecycle()
      const removed = prompt.section({
        name: SECRETARY_PERSONA_SECTION,
        order: SECRETARY_PERSONA_ORDER,
        // 口径由用户自由编辑：其中的 {{...}} 不能被当成提示词变量解析（同记忆索引）。
        interpolate: false,
        text,
      })
      removeSection = typeof removed === 'function' ? removed : () => {}
      return { attached: true, sessionId: masterSessionId }
    } catch (error) {
      warn('cannot register the section: ' + messageOf(error))
      return { attached: false, sessionId: masterSessionId, error: messageOf(error) }
    }
  }

  return { sync, dispose, text, attached: () => removeSection !== undefined }
}

/**
 * 默认定时器：与 setTimeout 同形，只是 unref —— 后台节拍不该把宿主进程钉住。
 * 注入了定时器（测试）时用注入的那个，这一层不参与。
 */
function unrefScheduled(fn, ms) {
  const handle = setTimeout(fn, ms)
  if (handle !== null && typeof handle?.unref === 'function') handle.unref()
  return handle
}

/**
 * 秘书的触发侦测（秘书 spec 票 03）。开关只在挂载时读一次：关闭时零接线——不订阅
 * 会话事件、不注册 effect，既有会话的行为完全不变。
 *
 * 接线点是宿主的 `session/event`：dsh-session 在每次提交事件后向观察者广播
 * `(session, event)`，dsh-session-projection 正是靠它驱动投影的，所以这里不用自己读
 * 日志、更不用轮询。事件由子会话/子代理的上下文发出，普通路由的监听器会被上下文
 * 过滤掉，所以和 `subagent/end` 一样注册成 global，再由登记表筛掉不该读的会话。
 *
 * 登记表与「是否已经起过表」都在事件发生时读取，所以取消登记、重复 dispatch 都在
 * 下一次事件就生效。
 *
 * 票 21 之后这里只剩一块表（票 05）——每 `secretaryBeatSeconds` 一拍：刷新卡点草稿、
 * 用六态投影判结束。报告本身（五项、三分钟、两小时封顶）已迁到 lib/reporter.js，由它
 * 随右栏端点落座；规划首报与增量报告都不再产出，否则升级后会有两份报告。
 *
 * 上一拍与这一拍都是 idle/completed 且没有在跑的 worker 时停表（`finished`），到达
 * `secretaryMaxRunSeconds` 由节拍自己停（`max-run`）；停表之后一拍都不再做任何事。
 *
 * 时钟、定时器、投影句柄与投递器都能注入（`deps`），生产路径用默认实现；
 * 测试把前几个换成假实现，就能在毫秒内断言九分钟的节拍，而不是等三分钟一拍的真人时间。
 *
 * @param deps.drafts - 票 08 的草稿表；挂载后与每一拍由这里刷新，读端点只取快照。
 * @param deps.readState - 可选；App 原生面板（dshGo）的读函数，与网页视图端点同一个。
 *   同一个函数也交给 secretary_state：越权记录（policy.violations）由它附上。
 *   缺省时原生面板不注册，secretary_state 退回同一份拼装但没有 ring 可读。
 * @param deps.defineTool - 可选；宿主的 defineTool。缺省用插件入口导入的那个。
 * @param deps.interrupt - 可选；(sessionId) => { requested, reason?, status? }；测试替换
 *   打断能力用。缺省走 attachSecretary 内置的 `agent.cancel({ kind: 'user' })`。
 * @returns `{ triggerState, listen, beats, settled, beatStatus, refreshDrafts, ready, wake, tools }`
 *   （测试与视图端点用）；开关关闭时 undefined。`settled()` 等所有在跑的拍落定；
 *   `beatStatus(sessionId)` 给端点填 beats；`ready` 是挂载初始化草稿的 promise；
 *   `wake` 是卡点唤醒器（默认关）；`tools` 是三个调度工具，宿主没有工具注册表时为 undefined。
 */
/**
 * 步骤来源：宿主 dsh-tool-todo 注册的 `todos` 投影。读法与 hasPendingNotice 同形——
 * registry 级两参 `stateOf(session, key)`；六态句柄（`handle.stateOf(session)`）只能读
 * 它自己那一份，按键读不到 todos，所以不走句柄。
 *
 * 这份投影是可选的：宿主没提供、没写过（null）、已释放（undefined）或读的时候抛错，
 * 都退回 undefined。六态投影今天没有 step 也能跑，不能因为缺一份可选投影让整拍失败。
 * 读失败只 warn 一次——每拍每个会话都 warn 一次会把日志淹掉。
 */
function createTodosReader(ctx, warn) {
  let warned = false
  return (session) => {
    if (session === undefined || session === null) return undefined
    try {
      const registry = ctx?.sessionProjections
      const stateOf = registry?.stateOf
      if (typeof stateOf !== 'function') return undefined
      return stateOf.call(registry, session, 'todos')
    } catch (error) {
      if (!warned) {
        warned = true
        warn(`orchestrator: secretary: cannot read the todos projection; the step stays empty: ${messageOf(error)}`)
      }
      return undefined
    }
  }
}

/**
 * 步骤语义（钉在 test/secretary-runtime.test.mjs 的五个用例上）：
 * - total = todos 列表长度；
 * - index = 第一个 `status === 'in_progress'` 条目的 1-based 下标；
 * - 没有 in_progress 时 index = 已 completed 的条数（不超过 total）；
 * - 空列表、null、undefined、非数组一律 null。
 *
 * 不拿 worker 数量或 dispatch 的 stage 冒充步骤：那会让「步骤推进」变成编出来的变化。
 */
function stepOf(todos) {
  if (!Array.isArray(todos) || todos.length === 0) return null
  const total = todos.length
  const position = todos.findIndex((item) => item?.status === 'in_progress')
  if (position >= 0) return { index: position + 1, total }
  const done = todos.filter((item) => item?.status === 'completed').length
  return { index: Math.min(done, total), total }
}

/**
 * 一个会话的步骤：同一份 todos 投影 + 同一个 stepOf。
 *
 * 节拍（报告与冒泡）与面板端点都从这一个工厂取，不各读一份、不各算一套——否则「步骤」
 * 会变成两个时钟。读不到就是 null，绝不拿别的量顶上。
 */
function createStepReader(ctx, warn) {
  const todosOf = createTodosReader(ctx, warn)
  return (session) => stepOf(todosOf(session))
}

export function attachSecretary(ctx, config, deps = {}) {
  if (configValue(config, 'secretaryEnabled', false) !== true) return undefined

  const options = deps !== null && typeof deps === 'object' ? deps : {}
  const clock = typeof options.now === 'function' ? options.now : Date.now
  const schedule = typeof options.schedule === 'function' ? options.schedule : unrefScheduled
  const cancel = typeof options.cancel === 'function' ? options.cancel : clearTimeout

  const triggerState = createTriggerState()
  // 每会话一个节拍实例：`beat` 管定时与自停，`lastSummary` 是下一拍的比较起点，
  // `startedAt` 是这一轮的零点（报告的「已跑时长」与 max-run 都从它算）。
  const beats = new Map()
  // 正在跑的拍：`settled()` 等它们落定，卸载时也不该有半截的写入。
  const inFlight = new Set()

  const warn = (message) => {
    try {
      ctx?.logger?.warn?.(message)
    } catch {
      // 日志不可用也不能影响节拍本身。
    }
  }

  const readNow = () => {
    try {
      const value = Number(clock())
      return Number.isFinite(value) ? value : Date.now()
    } catch {
      return Date.now()
    }
  }

  const textOf = (value) => (typeof value === 'string' ? value.trim() : '')

  const idOf = (session) => {
    if (session === null || typeof session !== 'object') return ''
    return textOf(session.id) || textOf(session.header?.id)
  }

  const listSessions = () => {
    try {
      const list = ctx?.sessions?.list?.()
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }

  // 投影注册返回的是 thenable（宿主契约），也可能已经是带 stateOf 的句柄；解析一次就缓存。
  let handlePromise
  const projectionHandle = () => {
    if (handlePromise === undefined) {
      handlePromise = Promise.resolve(options.registration).catch((error) => {
        warn('orchestrator: secretary: the six-state projection is unavailable: ' + messageOf(error))
        return undefined
      })
    }
    return handlePromise
  }

  // 草稿表（票 08）由插件实例持有；这里只负责在挂载与每一拍把它刷新一次。
  const draftStore =
    options.drafts !== undefined && options.drafts !== null && typeof options.drafts.add === 'function'
      ? options.drafts
      : undefined

  const rawRegistryOf = () => ({
    masterSessionId: configValue(config, 'secretaryMasterSessionId', ''),
    orchestrators: configValue(config, 'secretaryOrchestrators', []),
  })

  const isLive = (sessionId) => {
    try {
      return ctx?.agents?.get?.(sessionId) !== undefined
    } catch {
      return false
    }
  }

  // 默认投递器：复用 master-messaging 的 deliverMessage（running 走 inject、idle 走
  // followup，随后 flush），不复制它的分支；失败变成返回值，由 deliver() 收口。
  // 唤醒与 secretary_command 共用它：senderSessionId 非空时投出去的消息带来源，
  // 空时就是秘书自己的一次冒泡。
  const messaging = options.messaging ?? {
    async deliver(target, text, senderSessionId) {
      const result = await deliverMessage(
        { agents: ctx?.agents, sessions: ctx?.sessions },
        {
          toSessionId: target,
          text,
          ...(typeof senderSessionId === 'string' && senderSessionId !== '' ? { senderSessionId } : {}),
        },
      )
      if (result.decision === 'accept') return { delivered: true, via: result.via }
      return { delivered: false, reason: result.reason ?? result.decision }
    },
  }

  /** 一次跨会话投递的薄适配器：失败、缺接收方都变成返回值，调用方永远不必 catch。 */
  const sendMessage = async (target, text, senderSessionId) => {
    const to = textOf(target)
    if (to === '') return { delivered: false, reason: 'no-target' }
    const adapter = messaging !== null && typeof messaging === 'object' ? messaging.deliver : undefined
    if (typeof adapter !== 'function') return { delivered: false, reason: 'no-messaging' }
    try {
      const result = await adapter(to, text, senderSessionId)
      if (result !== null && typeof result === 'object' && result.delivered === false) {
        return { delivered: false, reason: textOf(result.reason) || 'refused' }
      }
      return { delivered: true }
    } catch (error) {
      return { delivered: false, reason: messageOf(error) }
    }
  }

  /**
   * 卡点唤醒（secretaryWakeOnBlocked，默认关）。与草稿同一处触发：refreshDrafts 拿到
   * applyDraftTriggers 的返回值之后调用；开关关着时 wake() 直接返回，一次都不投递。
   * 去重键是「会话 + 卡点原因」，同一卡点只唤醒一次。
   */
  const wake = createBlockedWake({
    enabled: () => configValue(config, 'secretaryWakeOnBlocked', false) === true,
    target: () => pickTarget({ registry: rawRegistryOf(), config }),
    deliver: (target, text) => sendMessage(target, text),
    logger: warn,
  })

  /**
   * 把当前的卡点刷新成草稿。票 08 原本挂在端点读函数里——客户端每十秒轮询一次，
   * 草稿就成了读的副产物。现在只在挂载后与每一拍调用；读端点只取快照。
   */
  const refreshDrafts = async () => {
    if (draftStore === undefined) return []
    const raw = rawRegistryOf()
    try {
      const handle = await projectionHandle()
      const rows = collectOrchestratorRows({
        registry: raw,
        sessions: listSessions(),
        stateOf: (session) => handle?.stateOf?.(session),
        isLive,
        reports: [],
      })
      const touched = applyDraftTriggers({
        store: draftStore,
        orchestrators: rows,
        conflict: registryConflictOf(raw),
        now: readNow(),
      })
      // 唤醒与草稿同一处触发：开关关着时这里一行都不发。
      await wake.wake(touched)
      return touched
    } catch (error) {
      warn(`orchestrator: secretary: cannot refresh the nudge drafts: ${messageOf(error)}`)
      return []
    }
  }
  // 挂载后的显式初始化：不等第一拍，视图一打开就能看到当前卡点的草稿。
  const ready = refreshDrafts()

  /** 该会话自己的节拍状态；端点用它填 beats.count / startedAt / capped / stoppedReason。 */
  const beatStatus = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    const entry = beats.get(sessionId)
    return entry === undefined ? undefined : entry.beat.status()
  }

  /** 一个会话自己的六态行；投影读不出来就按投影的初始态 Idle，不抛。 */
  const rowOf = async (session) => {
    if (session === undefined) return undefined
    const handle = await projectionHandle()
    if (typeof handle?.stateOf !== 'function') return undefined
    try {
      const state = handle.stateOf(session)
      const rows = Array.isArray(state?.workers) ? state.workers : []
      return rows[0]
    } catch {
      return undefined
    }
  }

  // 步骤：与面板端点用的是同一个工厂（createStepReader），所以报告、冒泡与视图看到的
  // 是同一份 todos 投影、同一套语义。读不到就是 null，不拿 worker 数冒充步骤进度。
  const stepOfSession = createStepReader(ctx, warn)

  /**
   * 这一拍看到的会话投影：orchestrator 行取自该会话自己的六态，worker 取 header 里
   * 认它作 parentSession 的子会话（与集中视图 collectOrchestratorRows 同一规则）。
   * 步骤取自容器加进来的 stepOfSession（见 createStepReader）。
   */
  const projectSession = async (sessionId) => {
    const sessions = listSessions()
    const own = sessions.find((session) => idOf(session) === sessionId)
    const ownRow = await rowOf(own)
    const workers = []
    for (const child of sessions) {
      if (textOf(child?.header?.parentSession) !== sessionId) continue
      const row = await rowOf(child)
      if (row === undefined || row.role === 'main') continue
      workers.push({ id: textOf(row.id) || idOf(child), state: row.state, summary: textOf(row.summary) })
    }
    return {
      state: ownRow === undefined ? WORKER_STATE.idle : ownRow.state,
      summary: ownRow === undefined ? '' : textOf(ownRow.summary),
      step: stepOfSession(own),
      workers,
    }
  }

  /**
   * 一拍：投影 → 摘要 → 刷新草稿 → 结束判定。票 21 把渲染、落盘、冒泡三步迁走了；
   * 摘要仍然前移，因为「两次都收工」的判定靠它。任何一步失败都不让节拍塌。
   */
  /**
   * 这一拍还该不该写。节拍自己的 `status().running` 是主判据：停表之后一拍都不写。
   *
   * 唯一的放宽：拍是排队执行的，一拍可能排在队列里、等轮到时表已经停了。这时看这一拍
   * 的**到期时刻** `at`：它早于停表时刻就仍然算数（它说的是停表之前那一刻的事实），
   * 晚于停表时刻就丢掉。停表时刻我们自己知道两种：本段主动停的（记 `stoppedAt`），
   * 以及节拍因到达上限自停的（`startedAt + maxRunMs`，与节拍内部的判定同一条算式）。
   */
  const canWrite = (entry, at) => {
    const status = entry.beat.status()
    if (status.running === true) return true
    const stoppedAt =
      entry.stoppedAt !== undefined
        ? entry.stoppedAt
        : status.stopReason === 'max-run'
          ? entry.startedAt + entry.maxRunMs
          : Number.NaN
    return Number.isFinite(stoppedAt) && at <= stoppedAt
  }

  const runTick = async (sessionId, info) => {
    const entry = beats.get(sessionId)
    if (entry === undefined) return

    // 这一拍的时刻取自节拍自己给的起点与经过时间，不取"执行到这一行时的现在"：
    // 排队里的拍可能晚一点才轮到，停止判定的时刻要落在这一拍真正到期的那个点上。
    const at = Number.isFinite(info?.elapsedMs) ? info.startedAt + info.elapsedMs : readNow()
    if (!canWrite(entry, at)) return

    const orchestrator = await projectSession(sessionId)
    // await 期间可能已经停表（另一拍刚判出结束），刷新草稿前再查一次。
    if (!canWrite(entry, at)) return

    // 每一拍刷新一次草稿：卡点变成可确认的催办由节拍负责，读端点不再顺手攒草稿。
    await refreshDrafts()

    const previous = entry.lastSummary
    // 票 21 把报告生产迁走了，票 15 拆掉了旧的报告模块。这里只需要「这一拍看到了什么」
    // 用来判「两次都收工」：状态与每个 worker 的状态。摘要照旧前移。
    const current = { state: orchestrator.state, workers: orchestrator.workers }
    entry.lastSummary = current

    // 结束判定：上一次与这一次都停在 idle/completed，且没有任何 worker 在跑。
    const isSettled = (state) => state === WORKER_STATE.idle || state === WORKER_STATE.completed
    const workerRunning = current.workers.some((worker) => worker.state === WORKER_STATE.working)
    if (previous !== undefined && isSettled(previous.state) && isSettled(current.state) && workerRunning === false) {
      // 停表的时刻是这一拍的时刻，不是"决定停表时的现在"。
      entry.stoppedAt = at
      entry.beat.stop('finished')
    }
  }

  const track = (sessionId, work) => {
    const guarded = work.catch((error) => {
      warn(`orchestrator: secretary: a beat tick of ${sessionId} failed: ${messageOf(error)}`)
    })
    inFlight.add(guarded)
    guarded.then(() => {
      inFlight.delete(guarded)
    })
    return guarded
  }

  /**
   * 把这一拍排进该会话的串行队列。一拍读上一拍的 `lastSummary` 当比较起点，两拍并发
   * 会把同一批变化算两遍，停止判定也会错一拍，所以宁可按顺序走。
   */
  const enqueue = (sessionId, info) => {
    const entry = beats.get(sessionId)
    if (entry === undefined) return
    const run = entry.chain.then(() => runTick(sessionId, info))
    entry.chain = run.then(
      () => undefined,
      () => undefined,
    )
    track(sessionId, run)
  }

  /**
   * 给一个会话起表。重复 dispatch 不会再起第二块表（`triggerState.mark` 已挡住），
   * 这里再挡一次：Map 里有就是已经起过。`beatSeconds` / `maxRunSeconds` 在起表时读一次，
   * 这一轮按当时的值跑完。
   */
  const startBeat = ({ sessionId, startedAt }) => {
    const existing = beats.get(sessionId)
    if (existing !== undefined) return existing
    const maxRunSeconds = configValue(config, 'secretaryMaxRunSeconds', DEFAULT_MAX_RUN_SECONDS)
    const beat = createBeat({
      now: clock,
      schedule,
      cancel,
      beatSeconds: configValue(config, 'secretaryBeatSeconds', DEFAULT_BEAT_SECONDS),
      maxRunSeconds,
      onTick: (info) => {
        enqueue(sessionId, info)
      },
      onError: (error) => warn(`orchestrator: secretary: the beat of ${sessionId} raised: ${messageOf(error)}`),
    })
    const entry = {
      beat,
      lastSummary: undefined,
      startedAt,
      // 上限时刻由节拍自己判（到点它就不 tick 了），这里只是把同一个上限算成毫秒，
      // 好让 canWrite 认出"这一拍是在停表之前到期的"。算式与 secretary-beat 的 toMs 一致。
      maxRunMs: Math.max(1, Math.round((Number(maxRunSeconds) > 0 ? Number(maxRunSeconds) : DEFAULT_MAX_RUN_SECONDS) * 1000)),
      chain: Promise.resolve(),
    }
    beats.set(sessionId, entry)
    beat.start()
    return entry
  }

  /** 等所有在跑的拍落定；测试用它把「推进假时钟」和断言对上。 */
  const settled = async () => {
    while (inFlight.size > 0) await Promise.all([...inFlight])
  }

  // 迁移说明只写一条 warn：老路径停产是升级后最容易让人以为「坏了」的地方。
  let migrationWarned = false

  const listen = (session, event) => {
    const sessionId = typeof session?.id === 'string' ? session.id : ''
    if (sessionId === '') return undefined
    // 登记表是 volatile 的：每一件事都读一次，取消登记立即生效。
    const trigger = detectTrigger(
      [{ sessionId, event }],
      {
        masterSessionId: configValue(config, 'secretaryMasterSessionId', ''),
        orchestrators: configValue(config, 'secretaryOrchestrators', []),
      },
    )
    if (trigger === null) return undefined
    const triggerId = trigger.sessionId
    // 同一会话重复 dispatch 不再起表：一份运行只有一块表。
    if (triggerState.has(triggerId)) return undefined

    // 票 21：规划首报与增量报告都停了——报告统一由 lib/reporter.js 产出并落到右栏。
    // 表照起：草稿刷新与「两次收工就停」的语义还在；启动即记触发，不再等一次落盘。
    if (!migrationWarned) {
      migrationWarned = true
      ctx?.logger?.warn?.(
        'orchestrator: secretary: report production moved to lib/reporter.js (ticket 21); ' +
          'the old planning and delta reports are no longer written',
      )
    }
    startBeat({ sessionId: triggerId, startedAt: readNow() })
    triggerState.mark(triggerId)
    return undefined
  }

  ctx.effect(
    () => {
      const off = ctx.on('session/event', listen, { global: true })
      // App 原生半侧（dshGo）：面板的视图规则在 lib/dshgo.js，这里只负责挂载。宿主没有
      // dshGo 桥（网页版、或测试里的假 ctx）时 mountDshGo 返回空 disposer，不抛错，
      // 也不影响插件主体加载与网页半侧。
      const disposeDshGo = mountDshGo({
        ctx,
        readState: typeof options.readState === 'function' ? options.readState : undefined,
      })
      return () => {
        if (typeof off === 'function') off()
        disposeDshGo()
        // 卸载即停表：Map 里每一块表都要取消自己的定时器，否则插件走了还在写文件。
        for (const entry of beats.values()) {
          entry.stoppedAt = readNow()
          entry.beat.stop('unload')
        }
        beats.clear()
      }
    },
    'orchestrator: secretary watch',
  )

  /** 登记表里的 orchestrator 会话：命令与打断的唯一合法目标。 */
  const registeredIdsOf = () => {
    const rows = configValue(config, 'secretaryOrchestrators', [])
    const ids = []
    for (const row of Array.isArray(rows) ? rows : []) {
      const id = typeof row?.sessionId === 'string' ? row.sessionId.trim() : ''
      if (id !== '' && !ids.includes(id)) ids.push(id)
    }
    return ids
  }

  /**
   * 打断一个会话正在跑的回合。
   *
   * 宿主的现成 API 在 agent 上：`agent.cancel(cause, options)`
   * （node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:184；cause 的取值见
   * @deepseek-ai/dsh-session/lib/types/types.d.ts:153 的 AgentCancelCause）。
   * `ctx.subagents.interrupt(target, authority)`（dsh-subagent/lib/types/index.d.ts:197）
   * 只认「人类父地址或活的祖先 agent」；登记表里的 orchestrator 是用户自己开的根会话，
   * 不是 Master 的子代理，所以那条路走不通。没有活的 agent、或宿主没有 cancel 时如实
   * 返回原因，不假装打断成功。
   */
  const interruptSession = (sessionId) => {
    let agent
    try {
      agent = ctx?.agents?.get?.(sessionId)
    } catch {
      return { requested: false, reason: 'agents-unavailable' }
    }
    if (agent === undefined || agent === null) return { requested: false, reason: 'no-live-agent' }
    if (typeof agent.cancel !== 'function') return { requested: false, reason: 'unsupported' }
    const status = typeof agent.status === 'string' ? agent.status.trim() : ''
    try {
      // 'user' 是宿主自己的「用户要求停止当前活动」意图；没有活动时 cancel 是无操作。
      agent.cancel({ kind: 'user' })
    } catch (error) {
      return { requested: false, reason: messageOf(error) }
    }
    return { requested: true, ...(status === '' ? {} : { status }) }
  }

  /**
   * secretary_state 的读函数：与网页视图端点、App 原生面板同一份
   * createSecretaryViewRead + composeViewState。apply 注入的 readState 已经附上
   * policy.violations；没有注入时（测试或其他宿主）退回同一份拼装，但越权记录只在
   * apply 的 ring 里，这条退路上没有。
   */
  const readViewState =
    typeof options.readState === 'function'
      ? options.readState
      : async () => {
          const read = createSecretaryViewRead({
            ctx,
            config,
            registration: options.registration,
            drafts: draftStore,
            beatStatus,
            ready: () => ready,
          })
          return composeViewState({ ...(await read()), enabled: true })
        }

  // 三个调度工具只在秘书打开时注册（attachSecretary 本身就只在打开时被调用；这里再让
  // 「宿主没有工具注册表」的测试与最小宿主安静地少注册，而不是抛错）。
  let secretaryTools
  const toolRegistry = ctx?.tools
  if (toolRegistry !== undefined && toolRegistry !== null && typeof toolRegistry.register === 'function') {
    secretaryTools = createSecretaryTools({
      defineTool: typeof options.defineTool === 'function' ? options.defineTool : defineTool,
      readState: readViewState,
      deliver: (target, text, senderSessionId) => sendMessage(target, text, senderSessionId),
      registeredSessionIds: registeredIdsOf,
      masterSessionId: () => configValue(config, 'secretaryMasterSessionId', ''),
      interrupt: typeof options.interrupt === 'function' ? options.interrupt : interruptSession,
    })
    for (const tool of [
      secretaryTools.secretary_state,
      secretaryTools.secretary_command,
      secretaryTools.secretary_interrupt,
    ]) {
      try {
        ctx.effect(() => toolRegistry.register(tool), 'orchestrator: secretary tool ' + tool.name)
      } catch (error) {
        warn(`orchestrator: secretary: cannot register "${tool.name}": ${messageOf(error)}`)
      }
    }
  }

  return { triggerState, listen, beats, settled, beatStatus, refreshDrafts, ready, wake, tools: secretaryTools }
}

/**
 * 秘书视图端点的读函数（秘书 spec 票 06）。
 *
 * 只读拼接：登记表与策略照票 01 的键读，运行态取票 02 注册的六态投影。报告段自票 15
 * 起恒为空（票 21 已把汇报迁到右栏，归档停产）——这个函数不碰磁盘上的任何报告目录。
 * 任何一段读不到都降级成空段而不抛——视图要看的是"现在能看到什么"，不是一次目录不存在
 * 就把整页变白。真正的失败（read 自己抛错）由 SecretaryRemote 原样抛给 Gateway，与
 * MasterRemote.masterState 的"无 handle 就失败"同一原则。
 *
 * 只读工作区：登记行没写工作区时，用该会话 header.cwd 补上（视图要显示它）；补不到就在
 * 行上标 workspaceMissing，不猜目录。
 *
 * 纯快照：草稿由节拍与挂载初始化生成，这里只等那次初始化落定（`ready`）再取
 * `drafts.list()`，自己一条都不生成、不迁移、不写盘。
 *
 * @param ready - 可选；返回挂载初始化的 promise，读之前等它落定，失败只 warn。
 * @param beatStatus - 可选；(sessionId) => 该会话节拍的 status()，填 orchestrators[].beats。
 * 步骤不在这里另读：行上的 step 由 createStepReader 这一份读法与节拍报告共用（见下）。
 * @returns 一个零参数 async 函数，返回端点要的四段数据 + policy（enabled 由端点补）。
 */
export function createSecretaryViewRead({ ctx, config, registration, drafts, beatStatus, ready }) {
  // 端点自己也要一份 warn：步骤读失败只 warn 一次，而节拍那边的 warn 不在这个作用域里。
  const warn = (message) => {
    try {
      ctx?.logger?.warn?.(message)
    } catch {
      // 日志不可用不能让一次只读端点抛错。
    }
  }
  // 与节拍报告同一个工厂、同一份 todos 投影：面板上的步骤不是第二个来源。
  const stepOfSession = createStepReader(ctx, warn)
  return async () => {
    if (typeof ready === 'function') {
      try {
        const pending = ready()
        if (pending !== null && typeof pending?.then === 'function') await pending
      } catch (error) {
        ctx?.logger?.warn?.('orchestrator: secretary: the draft initialization failed: ' + messageOf(error))
      }
    }

    // 原始登记表原样交给 composeViewState：归一化时被 Master 顶掉的行只有原样数据里才看得见。
    const rawRegistry = {
      masterSessionId: configValue(config, 'secretaryMasterSessionId', ''),
      orchestrators: configValue(config, 'secretaryOrchestrators', []),
    }
    const registry = normalizeRegistry(rawRegistry)

    let sessions = []
    try {
      const list = ctx?.sessions?.list?.()
      if (Array.isArray(list)) sessions = list
    } catch {
      // 没有 sessions 服务时 orchestrators 照登记行列出，live 一律 false（票面降级行为）。
    }

    let handle
    try {
      handle = await registration
    } catch (error) {
      // 投影注册失败不该让端点整页变白：照登记行列出，state 落到 Idle。
      handle = undefined
      ctx?.logger?.warn?.('orchestrator: secretary: the six-state projection is unavailable: ' + messageOf(error))
    }

    // 登记行可能没写工作区（设置页登记时只填了会话 id）。读侧用会话自己补上；补不到就是
    // 空——行上照实标 workspaceMissing，不猜目录，也不拿别人的目录顶上。
    // 票 15 起这里不再读任何报告目录：归档停产，唯一的汇报在右栏端点。
    const resolvedWorkspaceOf = (sessionId) => {
      if (typeof sessionId !== 'string' || sessionId === '') return ''
      let session
      try {
        session = ctx?.sessions?.get?.(sessionId)
      } catch {
        return ''
      }
      if (session === null || typeof session !== 'object') return ''
      try {
        const header = session.header
        const candidates = [header?.cwd, session.cwd, session.workspace]
        for (const candidate of candidates) {
          if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
        }
      } catch {
        // header 读取失败就是没有答案，和会话不存在一样处理。
      }
      return ''
    }
    // 报告段恒为空（票 15）：归档不再产生，历史由视图里的一行说明承担。
    const reports = []

    // 登记行没写标题时，标题要从宿主真实来源读：会话本身没有 title 字段，标题是
    // dsh-session-title 折出来的日志事实。只给缺标题的行读，避免每十秒为每个会话做一次冷读。
    const titleHost = { sessionTitle: optionalService(ctx, 'sessionTitle'), sessionQuery: optionalService(ctx, 'sessionQuery') }
    const sessionIdOf = (session) => {
      if (session === null || typeof session !== 'object') return ''
      const id = typeof session.id === 'string' ? session.id.trim() : ''
      if (id !== '') return id
      return typeof session.header?.id === 'string' ? session.header.id.trim() : ''
    }
    const titleTargets = registry.orchestrators
      .filter((row) => row.title === '')
      .map((row) => sessions.find((session) => sessionIdOf(session) === row.sessionId) ?? { id: row.sessionId })
    const titles = titleTargets.length === 0 ? new Map() : await readSessionTitles(titleTargets, titleHost)

    const orchestrators = collectOrchestratorRows({
      registry,
      sessions,
      reports,
      titles,
      sessionTitle: titleHost.sessionTitle,
      stateOf: (session) => handle?.stateOf?.(session),
      isLive: (sessionId) => ctx?.agents?.get?.(sessionId) !== undefined,
      beatStatus: typeof beatStatus === 'function' ? beatStatus : undefined,
      stepOf: stepOfSession,
    })

    // 五类冒泡开关在 Config 里存的是名字；认不出的名字由 notifyOnFrom 忽略。
    const notifyOn = configValue(config, 'secretaryNotifyOn', null)

    // 三组模型路由（设置页能改，读侧必须透出）：
    // - main 跟宿主默认选择，官方读法是 agentDefaultModel.currentSelection()；
    // - worker / review 是本插件自己的 Config 键（review 留空即跟随 worker）。
    // 服务不存在、currentSelection 抛错、返回非对象——三种情况都只让 main 退化成空串，
    // 绝不让一个可选服务把整页弄白；空串就是「未设」，这里不编任何默认模型名。
    let mainSelection
    try {
      mainSelection = optionalService(ctx, 'agentDefaultModel')?.currentSelection()
    } catch (error) {
      mainSelection = undefined
      ctx?.logger?.warn?.('orchestrator: secretary: the default model route is unreadable: ' + messageOf(error))
    }

    return {
      registry: rawRegistry,
      // 只读兜底：登记行没写工作区时由会话 header.cwd 补上（见上）。
      workspaceOf: resolvedWorkspaceOf,
      orchestrators,
      reports,
      drafts: drafts === undefined || drafts === null ? [] : drafts.list(),
      policy: {
        beatSeconds: configValue(config, 'secretaryBeatSeconds', DEFAULT_BEAT_SECONDS),
        maxRunSeconds: configValue(config, 'secretaryMaxRunSeconds', DEFAULT_MAX_RUN_SECONDS),
        ...(Array.isArray(notifyOn) ? { notifyOn: notifyOnFrom(notifyOn) } : {}),
        // 票 09：视图里看到的就是实际注入的那段——空串时读取方回落默认文案。
        promptText: personaTextOf(config),
        routes: {
          main: routeOfSelection(mainSelection),
          worker: {
            provider: configText(config, 'workerProvider'),
            model: configText(config, 'workerModel'),
            effort: configText(config, 'workerReasoningEffort'),
          },
          review: {
            provider: configText(config, 'reviewProvider'),
            model: configText(config, 'reviewModel'),
            effort: configText(config, 'reviewReasoningEffort'),
          },
        },
      },
    }
  }
}

/**
 * 秘书设计稿的托管路径（写死）。设置页的「查看设计稿」入口指向这里；路由是 exact，
 * 不接受任何由请求派生的文件路径，所以没有可被穿越的拼接。
 */
export const SECRETARY_VIEW_PATH = '/orchestrator/secretary-view'

/**
 * 设计稿的 CSP。页面与宿主 Web GUI 同源（127.0.0.1:3080）：不加 `sandbox`，它就能调用宿主的
 * 同源能力，所以这里把文档关进不透明源（sandbox 不带 allow-same-origin，脚本拿不到宿主的
 * 存储、cookie 与同源接口）。
 *
 * 这份指令表按设计稿的实际需要取最小值，已逐项核对源文件：1 个内联 <style>、1 个内联
 * <script>、0 处 http(s) 引用、0 处 src= 与 css url()、0 处 fetch / XHR / WebSocket / canvas。
 * 于是 style-src / script-src 只需要 'unsafe-inline'；img-src / font-src 与 allow-downloads
 * 是基线上预留的最小余量（当前设计稿用不到 data:、blob: 与下载），没有放宽到 `default-src *`。
 * 哪天设计稿要联网、画 canvas 或引外链，先审一遍再补对应指令，而不是整条退回去。
 */
export const SECRETARY_VIEW_CSP = [
  'sandbox allow-scripts allow-downloads',
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  "script-src 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

/** 设计稿就放在这个模块旁边；只读这一个固定文件。 */
const SECRETARY_VIEW_FILE = new URL('./secretary-view.html', import.meta.url)

/**
 * 一条只读设计稿的 exact 路由。返回的是宿主的 resource 形状（kind / path / resource），
 * 交给 `webServer.register`；GET 与 HEAD 由宿主自己分派。
 *
 * 首次请求读盘，之后走内存：文件是构建产物，请求期间不会变。读不到时回 404 加一句说明，
 * 绝不抛错——少一份静态文件不该把插件（以及它注册的工具）一起弄崩。
 *
 * @param options.readFile - 读文件的实现。只在这里注入，生产路径读 {@link SECRETARY_VIEW_FILE}；
 *   测试用它模拟缺文件，也顺带证明读函数拿不到任何请求派生的参数。
 */
export function createSecretaryViewRoute({ readFile = () => fsp.readFile(SECRETARY_VIEW_FILE) } = {}) {
  let cached
  return {
    kind: 'exact',
    path: SECRETARY_VIEW_PATH,
    async resource() {
      if (cached === undefined) {
        try {
          const bytes = await readFile()
          cached = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes
        } catch (error) {
          return new Response(
            'orchestrator: 设计稿文件缺失或无法读取（lib/secretary-view.html）: ' + messageOf(error) + '\n',
            {
              status: 404,
              headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' },
            },
          )
        }
      }
      return new Response(cached, {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': SECRETARY_VIEW_CSP,
          'x-content-type-options': 'nosniff',
        },
      })
    },
  }
}

/**
 * 把设计稿路由挂到宿主的 webServer 上。宿主没有这个服务（或它没有 register）时只 warn：
 * 少一条静态路由不影响插件的主体能力，设置页的入口届时会 404，报告里如实写明即可。
 * 路由的所有权交给 ctx.effect，插件卸载时由宿主一起收走。
 */
export function attachSecretaryView(ctx) {
  const webServer = optionalService(ctx, 'webServer')
  if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
    try {
      ctx?.logger?.warn?.('orchestrator: ctx.webServer is unavailable; the secretary design route is not registered')
    } catch {
      // 记日志失败不能反过来打断装配。
    }
    return undefined
  }
  try {
    return ctx.effect(() => webServer.register(createSecretaryViewRoute()), 'orchestrator: design view route')
  } catch (error) {
    try {
      ctx?.logger?.warn?.('orchestrator: the secretary design route could not be registered: ' + messageOf(error))
    } catch {
      // 同上。
    }
    return undefined
  }
}

/**
 * 面板红点的输入：监工当下认为「卡着」的每一个子会话，以及卡在哪。
 *
 * 不按登记表过滤：监工知道的事实比登记表全（登记表今天还没有写入方），而两边对不上的 id 在
 * 客户端会被 `badgeOf` 与真正画出来的行求交集——过滤放在画的那一侧，读的这侧只交事实。
 *
 * 放在模块顶层是为了能单测：它只依赖传进来的那个监工，不读 apply 的闭包。
 */
/**
 * 面板的登记表写入器。
 *
 * 面板上「有哪些 worker」只来自这一处：派发落定（含冷恢复）写一行 running，落定写终态。
 * 宿主自己的子代理不进这张表——那会把不属于这个插件的对话画进面板。
 *
 * `category` 来自预设（票 15）：派发方把预设的类别随 `info` 交进来，写进登记行；没有施加
 * 预设时留空——空串是「未施加预设」这个事实，不是缺省成某个类别。预设的 category 字段由
 * lib/presets.js 提供，`applyPresetForAgent` 的 plan 也带着它。
 * 任何写入失败都只记日志：面板的账错了，不能反过来影响一次派发。
 */
export function createPanelRegistry({ warn } = {}) {
  let table = {}
  const report = (message) => {
    try {
      warn?.(message)
    } catch {
      // 日志都写不了也照样继续。
    }
  }
  return {
    table: () => table,
    dispatched(childId, info) {
      const id = typeof childId === 'string' ? childId.trim() : ''
      const parentId = typeof info?.parentId === 'string' ? info.parentId.trim() : ''
      if (id === '' || parentId === '') return false
      // 预设的类别与 id 由派发方交给这里；认不出的类别写成空，不退回任何常量。
      const category = CATEGORIES.includes(info?.category) ? info.category : ''
      const presetId = typeof info?.presetId === 'string' ? info.presetId.trim() : ''
      try {
        const existing = findAssignment(table, id)
        if (existing === undefined) {
          // startedAt 在预占时就落地：不写的话每行都是 0，面板排序退化成按 id 排，
          // 「先派的在上面」这条就成了假话。
          table = reserveChildId(table, { id, parentId, kind: 'worker', presetId, category, startedAt: Date.now() })
        } else if (isTerminal(existing.status)) {
          // 冷恢复：同一个 id 开了新一代。assignSession 拒绝写终态行，重开走专门的那条路。
          table = reopenSession(table, { sessionId: id, startedAt: Date.now() })
        }
        table = assignSession(table, { sessionId: id, kind: 'worker', parentId, presetId, category, status: 'running' })
        return true
      } catch (error) {
        report('orchestrator: dock panel: cannot record the dispatched worker: ' + messageOf(error))
        return false
      }
    },
    settled(childId, result) {
      const id = typeof childId === 'string' ? childId.trim() : ''
      if (id === '') return false
      try {
        table = finishSession(table, { sessionId: id, status: result?.ok === true ? 'done' : 'failed' })
        return true
      } catch (error) {
        report('orchestrator: dock panel: cannot record the settled worker: ' + messageOf(error))
        return false
      }
    },
  }
}

/**
 * 六类危险动作的中文/英文名（票 20 的卡面）。卡面文字由宿主的批准通道显示，这里只给两种语言。
 */
const DANGER_LABELS = Object.freeze({
  'file-destruction': { zh: '删/覆盖文件', en: 'file destruction' },
  'history-rewrite': { zh: '强推与改写历史', en: 'history rewrite' },
  deploy: { zh: '部署发布', en: 'deploy' },
  'host-config': { zh: '改宿主或全局配置', en: 'host or global config' },
  'production-data': { zh: '改生产数据', en: 'production data' },
  outbound: { zh: '对外动作', en: 'outbound action' },
})

/** 卡面上一句话：类目 + 命令原文。命令截断到这里（卡面放不下长命令，也不该撑坏它）。 */
const DANGER_DISPLAY_COMMAND_LIMIT = 300
function dangerDisplayReasonOf(plan) {
  const command = plan.command.length > DANGER_DISPLAY_COMMAND_LIMIT
    ? plan.command.slice(0, DANGER_DISPLAY_COMMAND_LIMIT)
    : plan.command
  const zh = plan.categories.map((category) => DANGER_LABELS[category]?.zh ?? category).join('、')
  const en = plan.categories.map((category) => DANGER_LABELS[category]?.en ?? category).join(', ')
  return { zh: `危险动作（${zh}）：${command}`, en: `Dangerous action (${en}): ${command}` }
}

/**
 * 给一台 worker 装危险闸门（票 20）。
 *
 * 挂在 worker 自己的上下文上：`tools/pre-execute` 是按 agent 过滤的瀑布，所以主代理与宿主
 * 自己的子代理都不受影响。装不上不拦派发——闸门是护栏，不是启动条件——但必须记日志，否则
 * 「拦住了」会变成一句无法验证的话。
 */
export function installDangerPolicyFor(agent, policy) {
  if (agent === null || typeof agent !== 'object') return { installed: false, error: 'no agent' }
  if (policy === null || typeof policy !== 'object' || typeof policy.preExecute !== 'function') {
    return { installed: false, error: 'no policy' }
  }
  const context = agent.ctx
  if (context === null || typeof context !== 'object' || typeof context.on !== 'function') {
    return { installed: false, error: 'the agent has no event context' }
  }
  try {
    const dispose = context.on('tools/pre-execute', (exec, next) => policy.preExecute(exec, next))
    return { installed: true, dispose: typeof dispose === 'function' ? dispose : undefined }
  } catch (error) {
    return { installed: false, error: messageOf(error) }
  }
}

export function panelAttentionOf(inspector) {
  if (inspector === null || inspector === undefined || typeof inspector.activeAll !== 'function') return {}
  try {
    const all = inspector.activeAll()
    return all !== null && typeof all === 'object' && !Array.isArray(all) ? all : {}
  } catch {
    // 监工坏了就当没人卡着：红点不亮，总比整页报错好。
    return {}
  }
}

export function apply(ctx, config) {
  // 投影注册表是宿主服务，不一定在：宿主半侧的自检（sdk/plugin-kit 的 createTestHost）
  // 只提供 tools/sessions/commands，真实宿主也可能因为启动顺序还没装上。少注册一个投影
  // 远好过让整块 apply 抛错——抛错等于插件加载失败，连工具都注册不进来。
  const registerProjection = (projection) => {
    const registry = ctx?.sessionProjections
    if (registry === null || typeof registry !== 'object' || typeof registry.register !== 'function') {
      try {
        ctx?.logger?.warn?.('orchestrator: sessionProjections is unavailable; skipping the ' + projection.key + ' projection')
      } catch {
        // 日志都写不了时也只能安静地少注册一个投影。
      }
      return Promise.resolve(undefined)
    }
    return registry.register(projection)
  }
  registerProjection(stageProjection)
  // Ticket 02's handle is the only reader that folds each Session's own log; the
  // master panel endpoint awaits this registration and calls handle.stateOf().
  const masterRegistration = registerProjection(masterProjection)

  // The panel's read-only endpoint (ticket 03). A plain Service with a visible
  // typertRemote binding is all the Gateway's SRC mode needs; `provide` owns the
  // registration for this fiber. The method reads the switch per call, so the
  // endpoint returns no worker data while the panel is off.
  if (typeof ctx.provide === 'function') {
    try {
      ctx.provide(
        MASTER_SERVICE_KEY,
        new MasterRemote({
          sessions: () => (typeof ctx.sessions?.list === 'function' ? ctx.sessions.list() : []),
          registration: masterRegistration,
          enabled: () => configValue(config, 'masterPanelEnabled', false) === true,
        }),
      )
    } catch (error) {
      ctx.logger?.warn?.('orchestrator: master panel: cannot provide the remote endpoint: ' + messageOf(error))
    }
  }

  // 右栏面板的只读端点（票 12 第 4 步）。登记表由插件自己持有：今天还没有写入方——新派发链
  // 接上是票 15 的活——所以它现在只会如实答「三个常驻入口、零个 worker」。这不是占位数据，
  // 是「确实还没有派过 worker」。缺登记表就抛的规矩留给漏传的那种错，这里给的是真表。
  // 登记表：面板上那几行就是它。写入口只有派发这条链（onStarted / 冷恢复 / 落定），
  // 因为那是插件唯一确定「这个子会话是我派的」的时刻；宿主自己的子代理不进这张表。
  const panelRegistry = createPanelRegistry({
    warn: (message) => ctx.logger?.warn?.(message),
  })
  // 结束过的子会话（票 12 死页签清扫的权威事实）。浏览器判不出来：开着的页签会把自己那个子会话
  // retain 住，byId 里一直有它。这里只记账，判断留给客户端；有上限，旧的先丢——漏一条只是留一张
  // 死页签，环形表不承担完整历史。
  const panelEnded = []
  // 红点的来源（票 09 的监工）。今天只喂得到一个信号：重试。idle 要先有每子会话的
  // lastToolAt（supervise 的 tick 只在到期时才读日志），approval 要等闸门接线。
  const panelInspector = createInspector()

  // 右栏汇报（票 21）：三分钟一拍，只留最近一份，随 panelState 的同一次查询下发。事实只取
  // 下面这两处运行时真源——登记表（在跑/结束）与监工（卡住）；花费没有可读的统计，由
  // lib/reporter.js 写成缺项。旧秘书报告已在 attachSecretary 里停产，不会有两份。
  const reporter = createReporter({
    assignments: () => panelRegistry.table(),
    attention: () => panelAttentionOf(panelInspector),
    now: () => Date.now(),
    schedule: unrefScheduled,
    cancel: clearTimeout,
    onError: (error) => {
      try {
        ctx.logger?.warn?.('orchestrator: reporter: a tick failed: ' + messageOf(error))
      } catch {
        // 记日志失败不能让节拍停下。
      }
    },
  })
  ctx.effect(
    () => {
      reporter.start()
      return () => reporter.stop('unload')
    },
    'orchestrator: reporter beat',
  )

  // ---- 危险闸门（票 20） ------------------------------------------------------------------
  // worker 的每次工具调用先过一遍不可逆类目：命中的在执行前拦一次，其余只记账。卡面走宿主
  // 自带的批准通道（dsh-client-ui-approval）——本插件不画第二张卡，只把命令原文与类目交给它。
  //
  // 超时在闸门里（10 分钟，spec 第 8 节）：到点即失效，这里撤销那张卡，迟到的答案作废。
  // 同一件事的并发请求由 danger-runtime 合流，所以同一时刻一个键只有一张卡、一个截止时间。
  const panelPending = []
  /** 键（同一份计划对象）→ 撤销器。onTimeout 用它把还在飘着的卡撤掉。 */
  const dangerCards = new Map()
  let dangerPendingSeq = 0

  /** 让监工知道这台 worker 正在等批准（红点的第三种原因就靠这条事实）。 */
  function observeApproval(workerId, waiting) {
    if (workerId === '') return
    try {
      panelInspector.observe({ workerId, waitingApproval: waiting })
    } catch {
      // 红点亮不亮不能反过来影响一次工具调用。
    }
  }

  /**
   * 把一次危险动作送到宿主的批准通道，等它回话。
   *
   * 只有 `allowed-once` 算批准；拒绝、撤销、通道不可用、抛错都是「没批」——默认拒绝，
   * 与 `danger.js` 同一条口径。等的时候这张卡进 `panelPending`，端点一眼能看到。
   */
  async function requestDangerApproval(plan, context) {
    const approval = optionalService(ctx, 'approval')
    if (approval === null || approval === undefined || typeof approval.request !== 'function') {
      try {
        ctx.logger?.warn?.('orchestrator: danger gate: ctx.approval is unavailable; the action is refused')
      } catch {
        // 日志都写不了也照样拒绝。
      }
      return false
    }
    const workerId = typeof context?.workerId === 'string' ? context.workerId : ''
    const controller = typeof AbortController === 'function' ? new AbortController() : undefined
    if (controller !== undefined) dangerCards.set(plan, controller)
    const entry = {
      id: 'danger-' + String((dangerPendingSeq += 1)),
      workerId,
      toolName: typeof context?.toolName === 'string' ? context.toolName : '',
      categories: [...plan.categories],
      command: plan.command,
      at: Date.now(),
    }
    panelPending.push(entry)
    observeApproval(workerId, true)
    // 调用本身被取消时也把卡撤掉：用户已经不等这条命令了。
    const onCallAbort = () => controller?.abort()
    const callSignal = context?.signal
    try {
      if (callSignal !== null && callSignal !== undefined && typeof callSignal.addEventListener === 'function') {
        // 已经取消的调用不会再发 abort 事件：先看一眼，别把卡挂在那里没人收。
        if (callSignal.aborted === true) controller?.abort()
        else callSignal.addEventListener('abort', onCallAbort, { once: true })
      }
    } catch {
      // 拿不到调用信号只是少撤销一次卡，不影响判定。
    }
    try {
      const request = {
        agent: context?.agent,
        toolName: entry.toolName,
        reason: plan.command,
        displayReason: dangerDisplayReasonOf(plan),
      }
      if (context?.callId !== undefined) request.callId = context.callId
      if (controller !== undefined) request.signal = controller.signal
      const outcome = await approval.request(request)
      return outcome === 'allowed-once'
    } catch {
      return false
    } finally {
      dangerCards.delete(plan)
      const at = panelPending.indexOf(entry)
      if (at !== -1) panelPending.splice(at, 1)
      observeApproval(workerId, false)
    }
  }

  const dangerGate = createDangerGate({
    timeoutMs: DANGER_CONFIRM_TIMEOUT_MS,
    ask: (plan, context) => requestDangerApproval(plan, context),
    onTimeout: (plan) => {
      const card = dangerCards.get(plan)
      if (card !== undefined) card.abort()
    },
  })

  const dangerPolicy = createDangerPolicy({
    check: (input, context) => dangerGate.check(input, context),
    record: (event) => {
      try {
        if (event.kind === 'record-only') {
          ctx.logger?.info?.(
            `orchestrator: danger gate: only recording ${event.categories.join(',')}: ${event.command}`,
          )
        } else if (event.kind === 'decision' && event.approved !== true) {
          ctx.logger?.warn?.(
            `orchestrator: danger gate: refused ${event.categories.join(',')} (${event.reason}): ${event.command}`,
          )
        }
      } catch {
        // 记账失败不改变判定。
      }
    },
  })

  /** 每个子会话最近一代 activation 的编号；宿主每次重开一代都会发 start。 */
  const panelEpochs = new Map()
  const panelMasterSessionId = () =>
    configValue(config, 'secretaryMasterSessionId', '') ||
    (configValue(config, 'masterSessionEnabled', false) === true ? MASTER_SESSION_ID : '')
  if (typeof ctx.provide === 'function') {
    try {
      ctx.provide(
        PANEL_SERVICE_KEY,
        new PanelRemote({
          assignments: () => panelRegistry.table(),
          parentId: panelMasterSessionId,
          masterSessionId: panelMasterSessionId,
          ended: () => panelEnded,
          attention: () => panelAttentionOf(panelInspector),
          pending: () => panelPending,
          report: () => reporter.latest(),
        }),
      )
    } catch (error) {
      ctx.logger?.warn?.('orchestrator: dock panel: cannot provide the remote endpoint: ' + messageOf(error))
    }
  }

  // 秘书视图的只读端点（秘书 spec 票 06）。与 master 面板不同，总开关关闭时这里不注册
  // 任何东西：没有"关着也返回空"的服务，客户端拿不到端点就等于视图不存在。开关打开时
  // 注册一个只读服务，方法自己再读一次开关（volatile），关掉即返回稳定空结构。
  //
  // 草稿表（票 08）是插件实例的内存态：视图端点与节拍/挂载初始化共用同一个 store，
  // 所以「谁生成草稿」只有节拍与挂载两处，读端点只取快照。
  const violationRing = createViolationRing()
  /**
   * 拼装之后的 payload 补上 policy.violations（草图 B 的越权记录）。
   *
   * 为什么在这一层补：composeViewState 的策略区只放设置页真能改的东西——四个标量键
   * （beatSeconds / maxRunSeconds / notifyOn / promptText）加 routes 下的 main / worker /
   * review 三组模型路由。越权记录不是设置项，混进去会破坏这条契约。所以记录在拼装之后
   * 附加：没有记录时 payload 与拼装结果逐字节一致；有记录时客户端读不认识的字段，本来就降级。
   */
  const attachViolations = (payload) => {
    if (payload === null || typeof payload !== 'object') return payload
    if (payload.enabled !== true) return payload
    const rows = listViolations(violationRing)
    if (rows.length === 0) return payload
    const policy = payload.policy !== null && typeof payload.policy === 'object' ? payload.policy : {}
    return { ...payload, policy: { ...policy, violations: rows.slice(0, VIOLATION_LIMIT) } }
  }
  let drafts
  let secretaryWatch
  // App 原生半侧（dshGo）与网页视图共用同一个读函数：同一个 createSecretaryViewRead，
  // 同一份 composeViewState 拼装。开关关闭时这里保持 undefined，attachSecretary 在下一段
  // 直接返回，于是原生侧零注册。
  let dshgoReadState
  if (configValue(config, 'secretaryEnabled', false) === true) {
    drafts = createDraftStore({
      warn: (message) => {
        try {
          ctx.logger?.warn?.(message)
        } catch {
          // 记日志失败不能影响草稿的读写。
        }
      },
    })
    /**
     * 把会话选择器「新建无工作区 Master 会话」得到的 id 写进配置。
     *
     * 宿主的持久写入在 ctx.configEditor.edit（它自己走 Loader 的 profile 补丁）；没有它
     * 时至少做一次 volatile 写入，让当前进程立刻读到新值。两条都做不到就抛错，由调用方
     * 如实报告「会话建好了但没记下」——不假装写成功。
     */
    /** 会话选择器要的两条绑定值：哪个会话是 Master、哪些已登记。按调用读，volatile 即改即见。 */
    const secretaryRegistryOf = () => ({
      masterSessionId: configValue(config, 'secretaryMasterSessionId', ''),
      orchestrators: configValue(config, 'secretaryOrchestrators', []),
    })
    const writeSecretaryMasterSessionId = async (sessionId) => {
      const editor = optionalService(ctx, 'configEditor')
      let persisted = false
      if (
        editor !== null &&
        editor !== undefined &&
        typeof editor.edit === 'function' &&
        typeof editor.entries === 'function'
      ) {
        let entry
        try {
          entry = editor.entries().find((row) => {
            if (row === null || typeof row !== 'object') return false
            const viaOptions = row.options !== null && typeof row.options === 'object' ? row.options.name : undefined
            return viaOptions === name || row.name === name
          })
        } catch {
          entry = undefined
        }
        if (entry !== undefined) {
          await editor.edit(entry, (current) => ({
            ...(current !== null && typeof current === 'object' ? current : {}),
            secretaryMasterSessionId: sessionId,
          }))
          persisted = true
        }
      }
      let applied = false
      const ref = config?.secretaryMasterSessionId
      if (ref !== null && typeof ref === 'object' && typeof ref[VOLATILE_WRITE] === 'function') {
        ref[VOLATILE_WRITE](sessionId)
        applied = true
      }
      if (!persisted && !applied) {
        throw new Error('orchestrator: no config writer can record secretaryMasterSessionId')
      }
      return { persisted }
    }
    // 读函数先建出来：它只读宿主服务与路由表，不依赖 provide 是否可用；原生面板靠它，
    // 网页端点也靠它，两份视图不会各读各的。
    const readSecretaryState = createSecretaryViewRead({
      ctx,
      config,
      registration: masterRegistration,
      drafts,
      beatStatus: (sessionId) => secretaryWatch?.beatStatus?.(sessionId),
      ready: () => secretaryWatch?.ready,
    })
    dshgoReadState = async () => attachViolations(composeViewState({ ...(await readSecretaryState()), enabled: true }))
    if (typeof ctx.provide !== 'function') {
      ctx.logger?.warn?.('orchestrator: secretary: cannot provide the remote endpoint')
    } else {
      try {
        const nudgeMessaging = {
          async deliver(target, text, senderSessionId) {
            const result = await deliverMessage(
              { agents: ctx.agents, sessions: ctx.sessions },
              {
                toSessionId: target,
                text,
                ...(typeof senderSessionId === 'string' && senderSessionId !== ''
                  ? { senderSessionId }
                  : {}),
              },
            )
            if (result.decision === 'accept') return { delivered: true }
            return { delivered: false, reason: result.reason ?? result.decision }
          },
        }
        const remote = new SecretaryRemote({
          read: readSecretaryState,
          enabled: () => configValue(config, 'secretaryEnabled', false) === true,
          drafts,
          masterSessionId: () => configValue(config, 'secretaryMasterSessionId', ''),
          messaging: nudgeMessaging,
          // 会话选择器读的三级数据源与登记表。服务都按调用取（宿主可能在插件之后才装上
          // sessionController / sessionQuery / sessionTitle），缺了就是下一级降级。
          sessions: () => optionalService(ctx, 'sessions'),
          agents: () => optionalService(ctx, 'agents'),
          sessionController: () => optionalService(ctx, 'sessionController'),
          sessionQuery: () => optionalService(ctx, 'sessionQuery'),
          sessionTitle: () => optionalService(ctx, 'sessionTitle'),
          registry: secretaryRegistryOf,
          writeMasterSessionId: writeSecretaryMasterSessionId,
        })
        // secretaryState 的回包同样在拼装之后补越权记录；方法本身是原型上的，这里用
        // 实例自己的同名函数遮住它，typertRemote.service 仍是同一个对象。
        const readPayload = typeof remote.secretaryState === 'function' ? remote.secretaryState.bind(remote) : undefined
        if (readPayload !== undefined) {
          remote.secretaryState = async (...args) => attachViolations(await readPayload(...args))
        }
        ctx.provide(SECRETARY_SERVICE_KEY, remote)
      } catch (error) {
        ctx.logger?.warn?.('orchestrator: secretary: cannot provide the remote endpoint: ' + messageOf(error))
      }
    }
  }

  const settlements = createSettlements()
  const supervision = createSupervision({ ctx, config })

  // A child that dies without a closing message is woken again on the same durable session,
  // so the work already in the workspace is not thrown away; the policy (lib/retry.js) owns
  // the budget, and waking the main agent reuses the supervision delivery.
  const retry = createRetry({
    deliverPrompt: (parentId, childId, text) => deliverRetryPrompt(ctx, parentId, childId, text),
    wakeParent: supervision.deliverRetry,
    logger: ctx.logger,
  })
  const hooks = createSupervisionHooks(supervision.supervisor, {
    headSeq: supervision.headSeq,
    retry,
    settlements,
    panel: { dispatched: panelRegistry.dispatched, settled: panelRegistry.settled },
  })

  // The rule text the delegation tools show names exactly the tools the gate allows,
  // read from the same effective whitelist, so the prompt cannot drift from the
  // enforcement even when a profile checks a different set. The list is a function
  // because `allowedTools` is volatile: the tools re-read it when their description is
  // rendered, and the guard re-reads it on every call.
  const allowedTools = () =>
    effectiveAllowed(configValue(config, 'allowedTools', undefined), DEFAULT_ALLOWED_TOOLS)

  // One registration for every agent; children get it too and are bounded by maxDepth.
  // The definitions are kept so the worker shadow below can look up each name per scope.
  /** 面板要看到的那一行：结论与目标，不存整段 prompt。写不进去就算了，不能影响评审。 */
  const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')
  function publishLastReview(config, row) {
    const ref = config?.lastReview
    if (ref === null || typeof ref !== 'object') return
    if (typeof ref.get !== 'function' || typeof ref[VOLATILE_WRITE] !== 'function') return
    try {
      ref[VOLATILE_WRITE](JSON.stringify(row))
    } catch {
      // 面板展示失败不影响闸门。
    }
  }

  /**
   * 评审跑在一次受控派发上：走同一个 worker 路由，结果只取文本，
   * 形状由 reviewCard 校验。评审自身不会再触发评审——它是直接激活，不经过 tools。
   */
  const reviewer = async (card, { parent, signal } = {}) => {
    const route = readReviewRoute(config)
    const spec = buildSpawnActivation({
      prompt: buildReviewPrompt(card),
      label: 'review',
      parent,
      route,
      maxDepth: ctx.subagents.resolveMaxDepth?.(undefined),
      signal,
      delivery: DELIVERY.delegate,
    })
    const handle = await ctx.subagents.startActivation(spec)
    try {
      const result = await handle.result
      const text = collectText(result?.output ?? result)
      try {
        const verdict = parseReviewText(text)
        publishLastReview(config, { verdict: verdict.verdict, target: verdict.target ?? '', at: Date.now() })
      } catch {
        publishLastReview(config, { verdict: 'INVALID', target: '', at: Date.now() })
      }
      return text
    } finally {
      try {
        await handle.dispose?.()
      } catch {
        // 释放失败不影响已经读到的结论
      }
    }
  }

  // 单一派发入口（ADR 0006）：delegate 与 orchestrate 收在 dispatch 内部。
  const dispatchTool = createDispatchTool({
    defineTool,
    subagents: ctx.subagents,
    config,
    onStarted: hooks.onStarted,
    allowedTools,
    reviewer,
  })
  ctx.effect(() => ctx.tools.register(dispatchTool), 'orchestrator: dispatch tool')

  /**
   * The live gate of every gated main agent, keyed by agent id. The gate is the guard alone:
   * the model-facing table is cut per request by `installToolSurface`, so nothing here has
   * to be rebuilt when the panel or the registry changes — the disposer is the only state.
   */
  const gates = new Map()
  // 已被 authority 认领的 agent：遮罩与 guard 归那一层，gates 表里刻意没有它。
  const authorityClaims = new Map()

  /**
   * 默认闸门。这里顺带登记进 gates 表：authority 交还一个 agent 时会重新调用 installFor，
   * 登记必须跟着发生，否则下一次设置写回会以为这个 agent 没有闸门而重复安装一套。
   * 闸门只剩 guard：模型可见的工具面由 `installToolSurface` 在
   * `ctx.tools.definitions()` 这一处裁掉，白名单由 `allowedTools()` 每次请求现读，
   * 所以面板的勾选、插件后注册的工具都不需要重装任何遮罩。
   */
  const installFor = (agent) => {
    const gate = installGate({
      agent,
      allowed: allowedTools,
      enabled: () => config.enabled.get(),
    })
    if (typeof agent?.id === 'string') gates.set(agent.id, gate)
    return gate
  }

  /**
   * 一个在插件挂载之前就已存在的 root agent 不会收到 `agent/created`。工具面对所有 scope
   * 都生效，它的下一张表照样被过滤；这里补的是执行时的 guard——模型硬调一个表里看不见的
   * 名字时，仍然要被拒绝。只装 guard，所以不发 `tools/change`，重复调用也只是查表。
   */
  const ensureGates = () => {
    let roots = []
    try {
      if (typeof ctx.agents?.roots === 'function') roots = ctx.agents.roots()
    } catch (error) {
      ctx.logger.warn(`orchestrator: cannot enumerate live agents for a gate check: ${messageOf(error)}`)
      return
    }
    for (const agent of roots) {
      if (isDelegatedChild(agent)) continue
      if (typeof agent.id === 'string' && (gates.has(agent.id) || authorityClaims.has(agent.id))) continue
      try {
        installFor(agent)
      } catch (error) {
        ctx.logger.warn(`orchestrator: main agent ${agent.id}: cannot install the gate: ${messageOf(error)}`)
      }
    }
  }

  /**
   * The Allowed Tools panel must offer every tool the host really has, including the ones
   * other plugins and MCP servers register after this plugin loaded. A web client cannot
   * enumerate tools, so the catalog is published through this plugin's config
   * (lib/catalog.js) and announced on the settings event the client mirror refreshes on.
   * A burst of registrations is one debounced read, and an unchanged catalog publishes
   * nothing at all. The first read runs here: later registrations announce themselves on
   * `tools/change`.
   *
   * `tools/change` has one job left: keeping the panel's checklist complete. Nothing has to
   * be re-masked, because the model-facing table is filtered per request by the surface
   * wrapper below (lib/tool-surface.js).
   */
  const catalog = createCatalogPublisher({ ctx, config })
  ctx.effect(() => () => catalog.dispose(), 'orchestrator: tool catalog')
  ctx.on('tools/change', () => {
    catalog.schedule()
  })
  catalog.publish()

  /**
   * 模型可见的工具面只在一个出口上裁：`ctx.tools.definitions(scope, toolSet)`。宿主用它
   * 组装一次请求的 `tools` 声明、执行器自带的段落，以及 `# Bash command execution: ops_bash`
   * 这类插件提示块，所以只包住这一处就既完整又安静：
   * - 完整：`tools.restrict` 只能藏住继承来的全局工具，agent 自己 scope 里注册的
   *   （原生 `subagent`、所有 `ops_*`）它藏不住，还会抛 `unknown global tool`；包装按名字
   *   过滤，两种都覆盖。
   * - 安静：每次 `restrict`/dispose 都会广播 `tools/change`，dsh-ops 收到后先撤掉官方的
   *   `read`/`glob`/`grep`，再从 25/100/400/1000 ms 的重试队列里装回来；若一次请求刚好在
   *   这个窗口里组装，模型就会先看到它们、下一个请求又看不到，缓存的前缀被改写两次。
   * 包装在请求时现读白名单和 scope 视图，面板写回或开关翻转都从下一个请求开始生效，
   * 一个事件都不发。
   */
  ctx.effect(
    () =>
      installToolSurface({
        tools: ctx.tools,
        allowed: allowedTools,
        enabled: () => config.enabled.get(),
        // 本分支只有一个派发入口 `dispatch`（ADR 0006），子代理本身保持完整工具集
        // （见 Config.allowedTools 的说明），所以没有要从 worker 工具面里摘掉的名字。
        // 描述层面对 worker 的收窄仍由下面的 shadowDelegationForWorker 负责。
        workerDeny: [],
        // 被调度指挥认领的 master 会话不套这份默认白名单：那一层的 allow 名单更宽
        // （read/grep/glob/list 开放、写工具拒绝），两套叠起来会把它的 read 也藏掉。
        // 认领是活的，所以这里每次请求现读；认领与交还都从下一个请求开始生效。
        exempt: (agent) => typeof agent?.id === 'string' && authorityClaims.has(agent.id),
      }),
    'orchestrator: tool surface',
  )

  /**
   * A delegated child inherits the same global tool table as the main agent, so it also
   * reads the main-agent rule in both delegation descriptions — and may take that rule
   * as a ban on its own tools. Scoped registrations shadow globals, so the child's own
   * scope gets a short, role-neutral pair instead. The global tools, and therefore every
   * description the main agent sees, are untouched.
   *
   * A definition is immutable, so one worker pair serves every child scope. A child a
   * preset filtered the tool out of is left alone: registering the shadow in its own
   * scope would defeat that filter, because restrictions only mask inherited tools.
   *
   * A failure is reported, never thrown: a broken shadow must not break child creation,
   * and the worst case is the old long description.
   */
  const workerTools = [
    {
      tool: dispatchTool,
      shadow: createDispatchTool({
        defineTool,
        subagents: ctx.subagents,
        config,
        onStarted: hooks.onStarted,
        allowedTools,
        forWorker: true,
      }),
    },
  ]
  const shadowDelegationForWorker = (agent) => {
    for (const { tool, shadow } of workerTools) {
      try {
        // The per-scope view: undefined means a preset hid the tool from this child.
        if (agent.ctx.tools.get(tool.name, agent) === undefined) continue
      } catch {
        // An older host without a per-scope lookup: install the shadow anyway.
      }
      try {
        agent.ctx.tools.register(shadow)
      } catch (error) {
        try {
          ctx.logger?.warn?.(`orchestrator: worker ${agent.id}: cannot shorten the "${shadow.name}" description: ${messageOf(error)}`)
        } catch {
          // A logging failure must not break child creation either.
        }
      }
    }
  }

  // The host may not mount cordis-plugin-timer, so use the platform timer through
  // the existing effect lifecycle. The period is fixed at 5 s because a tick only
  // compares clocks; a child's log is read only once it is due, so this keeps the
  // 10-second minimum interval prompt without a configurable scan. `unref` keeps a
  // short-lived CLI test process from hanging on an interval the host would own.
  const scanMs = 5000
  ctx.effect(
    () => {
      const timer = setInterval(() => {
        void Promise.resolve(supervision.supervisor.tick()).catch((error) => {
          ctx.logger?.warn?.(`orchestrator: supervision timer: ${messageOf(error)}`)
        })
      }, scanMs)
      if (typeof timer?.unref === 'function') timer.unref()
      return () => clearInterval(timer)
    },
    'orchestrator: supervision timer',
  )

  /**
   * The settlement edge of every delegated child. A child that stops with `error` and left
   * no text behind is the case lib/retry.js retries; anything else releases its record.
   *
   * The host dispatches this edge with the child's parent as its carrier, so the listener
   * must be global: a context-scoped listener is filtered out for a child-scoped emission.
   * The policy is async (it queues one prompt), and the emitter contains rejections, but the
   * failure is still reported here so a broken retry is visible rather than silent.
   */
  // 一个 id 复活了就不再是「结束过」：宿主每个 activation epoch 都会发 start，续跑或重试的
  // worker 用的是同一个 durable id。不清掉的话，客户端会把它的页签在每一拍清扫里反复关掉。
  ctx.on('subagent/start', (info) => {
    const childId = info?.id
    if (typeof childId !== 'string' || childId === '') return
    const at = panelEnded.indexOf(childId)
    if (at !== -1) panelEnded.splice(at, 1)
    // 同一拍里重新武装：撤墓碑、清旧理由。宿主的 durable id 跨 epoch 复用，不重新武装的
    // 话这个 id 第一次结束之后就永远不会再亮。同时记一代编号，用来挡「上一代迟到的结算」。
    panelEpochs.set(childId, (panelEpochs.get(childId) ?? 0) + 1)
    try {
      panelInspector.rearm(childId)
    } catch {
      // 监工不参与生命周期决策，出错也不能影响 start 这条边。
    }
  })
  ctx.on(
    'subagent/end',
    (info) => {
      const childId = info?.id
      if (typeof childId !== 'string' || childId === '') return
      // 客户端据此关掉这个 worker 的聊天页签；环形表在端点里下发。
      if (!panelEnded.includes(childId)) {
        panelEnded.push(childId)
        if (panelEnded.length > PANEL_ENDED_LIMIT) panelEnded.splice(0, panelEnded.length - PANEL_ENDED_LIMIT)
      }
      // 结算在异步里回来。这期间同一个 id 可能已经开了新一代（start 先到），那一代不该被
      // 上一代的结果染色——所以记下发出结算时的代号，回来对不上就整条丢掉。
      const epoch = panelEpochs.get(childId) ?? 0
      void Promise.resolve(retry.settle(childId, info, info?.runId))
        .then((outcome) => {
          if ((panelEpochs.get(childId) ?? 0) !== epoch) return
          // 监工只借这个结果一盏灯：重试中的 worker 在面板上要能被一眼看见。
          try {
            if (outcome === 'retry') panelInspector.observe({ workerId: childId, retrying: true })
            // 'untracked' 是「这个子会话插件从来没管过」（track 现在还没有调用方）：立墓碑
            // 只会把这个 id 提前毒掉，之后真管起来时它永远不亮。所以什么都不做。
            else if (outcome !== 'untracked') panelInspector.end(childId)
          } catch {
            // 红点亮不亮不能反过来影响重试。
          }
        })
        .catch((error) => {
          try {
            ctx.logger?.warn?.(`orchestrator: retry: cannot apply the settlement of ${childId}: ${messageOf(error)}`)
          } catch {
            // A logging failure must not escape the listener either.
          }
        })
    },
    { global: true },
  )

  const warnAuthority = (message) => {
    try {
      ctx.logger?.warn?.(message)
    } catch {
      // 记日志失败不能反过来打断装配。
    }
  }

  /** 摘掉默认闸门（authority 认领时让它让位）。没有闸门时什么都不做。 */
  const disposeFor = (agent) => {
    const id = agent?.id
    if (typeof id !== 'string') return
    const gate = gates.get(id)
    if (gate === undefined) return
    gates.delete(id)
    try {
      gate.dispose()
    } catch (error) {
      ctx.logger.warn(`orchestrator: main agent ${id}: cannot lift the gate: ${messageOf(error)}`)
    }
  }

  /** 开关与指定都打开时，那个会话 id 才算数；任一关闭都等于「没有调度指挥」。 */
  const activeMasterSessionId = () => {
    if (configValue(config, 'secretaryEnabled', false) !== true) return ''
    const id = configValue(config, 'secretaryMasterSessionId', '')
    return typeof id === 'string' ? id.trim() : ''
  }

  /** 登记表里的 orchestrator 会话：send_message / interrupt_agent 的唯一合法目标。 */
  const registeredSessionIds = () => {
    const rows = configValue(config, 'secretaryOrchestrators', [])
    const ids = []
    for (const row of Array.isArray(rows) ? rows : []) {
      const id = row?.sessionId
      if (typeof id === 'string' && id !== '') ids.push(id)
    }
    return ids
  }

  /**
   * 调度指挥权限层（草图 B）。工具表每次 install 现读（collectCatalog 读的是活视图），
   * 目标会话每次调用现读（guard 里重建 policy），于是登记表改了不必重装遮罩。
   */
  const authority = createAuthority({
    installFor,
    disposeFor,
    sandbox: createHostSandboxLock(ctx, warnAuthority),
    approval: createHostApprovalLock(ctx, warnAuthority),
    violations: violationRing,
    now: Date.now,
    policy: () => buildPolicy({ toolCatalog: collectCatalog(ctx), registeredSessionIds: registeredSessionIds() }),
    logger: warnAuthority,
  })

  /** 这个 agent 现在该由 authority 管吗？开关、指定、会话 id 三者都要对上。 */
  const wantsAuthority = (agent) => {
    const masterSessionId = activeMasterSessionId()
    return masterSessionId !== '' && authorityFor(agent, { masterSessionId }) === DISPATCH_COMMAND
  }

  /**
   * 设置写回时把「该由谁管」重新结算一遍：需要指挥的会话认领，不再需要的交还默认闸门。
   * 交还必须当场完成——claim() 内部先 installFor、成功后才解自己的遮罩，否则这条会话
   * 会短暂没有闸门。默认白名单本身不必再刷新：工具面在每次请求现读白名单，而已认领的
   * 会话另有 authority 自己的遮罩。
   */
  const settleAuthorityClaims = () => {
    let roots = []
    try {
      if (typeof ctx.agents?.roots === 'function') roots = ctx.agents.roots()
    } catch (error) {
      ctx.logger.warn(`orchestrator: cannot enumerate live agents for a ${DISPATCH_COMMAND} authority refresh: ${messageOf(error)}`)
      return
    }
    for (const agent of roots) {
      if (isDelegatedChild(agent)) continue
      try {
        const wants = wantsAuthority(agent)
        const claim = typeof agent.id === 'string' ? authorityClaims.get(agent.id) : undefined
        if (wants && claim === undefined) {
          const installed = authority.install(agent)
          if (typeof installed === 'function') authorityClaims.set(agent.id, installed)
        } else if (!wants && claim !== undefined) {
          authorityClaims.delete(agent.id)
          claim()
        }
      } catch (error) {
        ctx.logger.warn(`orchestrator: main agent ${agent.id}: cannot settle the ${DISPATCH_COMMAND} authority: ${messageOf(error)}`)
      }
    }
  }

  ctx.on('agent/created', (payload) => {
    const agent = payload?.agent
    // A new root agent is the only place a preset or scope-local tool becomes visible,
    // so the catalog may have grown even though the registry itself did not change.
    catalog.schedule()
    if (agent === undefined || agent === null) return
    if (isDelegatedChild(agent)) {
      shadowDelegationForWorker(agent)
      // 危险闸门装在这台 worker 自己的上下文上：只有它的工具调用会被问。
      const danger = installDangerPolicyFor(agent, dangerPolicy)
      if (danger.installed !== true) {
        ctx.logger?.warn?.(
          `orchestrator: worker ${String(agent?.id)}: the danger gate is not installed: ${String(danger.error)}`,
        )
      }
      // A `send_message` cold resume recreates an interrupted worker, and its receipt was
      // already settled, so supervision has forgotten it. Only a child this plugin
      // dispatched is re-armed; a host `subagent` child stays unsupervised as before.
      if (payload?.source === 'resume') hooks.onResumed(agent)
      return
    }

    // 调度指挥（草图 B）：被指定为 Master 的那个会话不装默认闸门——默认名单里就有
    // read / grep / glob，而 restrict 与 guard 都只能收紧，装上去就再也放不开。认领成功
    // 才跳过；认领失败（老宿主没有工具注册表之类）退回默认闸门，绝不让它裸奔。
    if (wantsAuthority(agent)) {
      const claim = authority.install(agent)
      if (typeof claim === 'function') {
        authorityClaims.set(agent.id, claim)
        ctx.logger.info(
          `orchestrator: main agent ${agent.id}: ${DISPATCH_COMMAND} authority installed; the default gate is skipped`,
        )
        return
      }
      ctx.logger.warn(
        `orchestrator: main agent ${agent.id}: the ${DISPATCH_COMMAND} authority could not claim it; installing the default gate`,
      )
    }

    // Installed even while the switch is off: the guard follows the switch per call,
    // so turning dispatch mode on in an open conversation takes effect at once.
    const gate = installFor(agent)
    // A resumed agent with a parentSession that still read as a main agent means the
    // depth test degraded: the cold-resume regression looked exactly like this.
    if (payload?.source === 'resume' && agent.session?.header?.parentSession !== undefined) {
      ctx.logger.warn(
        `orchestrator: agent ${agent.id} resumed with a parentSession but no delegation depth; gated it as a main agent`,
      )
    }
    if (!config.enabled.get()) return
    ctx.logger.info(
      `orchestrator: main agent ${agent.id}: armed whitelist gate (${gate.allowed.length} allowed: [${gate.allowed.join(', ')}])`,
    )
    if (gate.guardError !== undefined) {
      ctx.logger.warn(`orchestrator: main agent ${agent.id}: guard not installed: ${gate.guardError}`)
    }
  })

  // A gated agent that goes away takes its gate with it: the entry is the only owner of
  // the mask handles, so dropping it here must not leave them behind.
  ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent
    const id = agent?.id
    // A root agent going away can drop its scope-local names from the catalog.
    catalog.schedule()
    if (typeof id !== 'string') return
    // A disposed worker must not keep a supervision slot: until it is resumed its session
    // is gone, and the tick would only read a dead log. A resume re-arms it above.
    if (isDelegatedChild(agent)) hooks.forget(id)
    // 调度指挥层随 agent 一起消失：不重装默认闸门（agent 已经没了），只解除自己的遮罩
    // 与宿主锁，免得在死会话上再装一套。
    const claim = authorityClaims.get(id)
    if (claim !== undefined) {
      authorityClaims.delete(id)
      try {
        claim({ installDefault: false })
      } catch (error) {
        ctx.logger.warn(
          `orchestrator: main agent ${id}: cannot release the ${DISPATCH_COMMAND} authority: ${messageOf(error)}`,
        )
      }
    }
    const gate = gates.get(id)
    if (gate === undefined) return
    gates.delete(id)
    try {
      gate.dispose()
    } catch (error) {
      ctx.logger.warn(`orchestrator: main agent ${id}: cannot lift the gate: ${messageOf(error)}`)
    }
  })

  /**
   * The panel writes `enabled` and `allowedTools` as volatile config: the loader commits
   * those values into the running references and then announces the paths on this fiber,
   * which is why the guard and the tool surface already see a switch flip or a new
   * whitelist on the very next call — the surface reads both per request, so no mask has to
   * be rebuilt and no `tools/change` has to be announced.
   */
  ctx.on('loader/volatile-update', () => {
    // The Loader commits the profile's raw value into every volatile field it was handed,
    // so a panel write (or any other settings write) resets the published catalog to the
    // stored default. Restore it here, before the write's own settings read answers, so
    // the panel never falls back to its built-in copy after a checkbox click.
    catalog.publish()
    // 常驻口径的指定也是 volatile 设置：写回后在下一次装配前摘挂，不新开定时器。
    persona.sync()
    settleAuthorityClaims()
    ensureGates()
  })

  // 秘书触发侦测与节拍（票 03 + 05）：开关关闭时零接线——不订阅会话事件、不注册 effect。
  // 六态投影的句柄是节拍读用户会话状态的地方，所以必须传进来，否则每一拍都只能看到
  // 投影的初始态。dshgoReadState 是 App 原生面板的读函数（与网页端点同一个读函数）；
  // 开关关闭时它是 undefined，原生面板一个都不注册。
  secretaryWatch = attachSecretary(ctx, config, {
    registration: masterRegistration,
    drafts,
    readState: dshgoReadState,
  })

  // 常驻 master 会话（票 05）同样是附加功能：开关关闭时零接线。
  attachMasterSession(ctx, config)

  // 常驻口径（秘书 spec 票 09）：开关打开且指定了 Master 时才注册 section，开关关闭
  // 时零注册；disposer 由附着器里的 ctx.effect 持有，插件卸载与取消指定走同一条摘除路径。
  const persona = createSecretaryPersona({ ctx, config })
  persona.sync()

  // 设计稿托管：设置页的入口指向这条 exact 路由。宿主没有 webServer 时 attachSecretaryView
  // 只记一条 warn，插件其余能力照常——少一条静态路由不该影响已经注册的工具与投影。
  attachSecretaryView(ctx)

  // 跨会话消息（票 06）没有入口工具，票面也没有要求：投递能力经 `deliverMessage`
  // 导出，开关由 `masterMessagingSettings` 逐次读取。这里刻意不注册任何工具或零行为
  // 的 effect——空接线只会让下一步多一处没人调用的代码。

  // 记忆层是附加功能：开关关闭时这里什么都不做——不打开域，也不注册注入段。
  void attachMasterMemory(ctx, config).catch((error) => {
    try {
      ctx?.logger?.warn?.('orchestrator: memory: cannot attach: ' + messageOf(error))
    } catch {
      // 附加功能失败也不影响插件主体。
    }
  })
}
