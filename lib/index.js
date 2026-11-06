import * as fsp from 'node:fs/promises'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z as zod } from 'zod'
import { DELIVERY } from './api.js'
import { collectCatalog, createCatalogPublisher } from './catalog.js'
import { createDispatchTool } from './dispatch.js'
import { mountDshGo } from './dshgo.js'
import { effectiveAllowed, installGate, isDelegatedChild } from './gate.js'
import { MASTER_ROLES, WORKER_STATE, WORKER_STATES, initialMasterState, reduceMasterState } from './master-state.js'
import { MASTER_SERVICE_KEY, MasterRemote } from './master-panel.js'
import { DEFAULT_INBOUND_POLICY, MAX_MESSAGE_BYTES, MAX_MESSAGE_QUEUE, deliverMessage } from './master-messaging.js'
import { MASTER_SESSION_ID, disposeMaster, ensureMaster, noticeSource } from './master-session.js'
import { MEMORY_INDEX_SECTION, MEMORY_SECTION_ORDER, openMemoryDomain } from './memory.js'
import { collectText } from './orchestrate.js'
import { buildReviewPrompt, parseReviewText } from './review.js'
import { buildSpawnActivation, readReviewRoute } from './worker.js'
import { RETRY_SOURCE_KIND, createRetry } from './retry.js'
import { reportPath, writeReport } from './secretary-archive.js'
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
import { bubbleText, deliver, pickTarget } from './secretary-deliver.js'
import { classifyChanges, diffSummaries, isSubstantial } from './secretary-diff.js'
import { applyDraftTriggers, createDraftStore } from './secretary-nudge.js'
import {
  SECRETARY_SERVICE_KEY,
  SecretaryRemote,
  VIEW_REPORT_LIMIT,
  collectOrchestratorRows,
  composeViewState,
  listReportRows,
  notifyOnFrom,
  registryConflictOf,
} from './secretary-panel.js'
import { normalizeRegistry } from './secretary-registry.js'
import { renderPlanReport, renderReport, summarizeForDiff } from './secretary-report.js'
import { createBlockedWake, createSecretaryTools } from './secretary-tools.js'
import { buildPlanReport, createTriggerState, detectTrigger } from './secretary-watch.js'
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

export const name = 'dsh-orchestrator'

/**
 * Services used here: the projection registry, the tool registry, the subagent
 * service, and the live agent/session registries the supervision adapters read.
 */
export const inject = ['sessionProjections', 'tools', 'subagents', 'agents', 'sessions']

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
   * available to the main agent, and every other host, MCP or plugin tool is automatically
   * hidden and blocked. Workers always keep the full tool set.
   *
   * That is only the default: the panel may check any tool the host offers.
   * `tools.restrict` hides the global ones; a guard additionally refuses every name that is
   * not listed at execution time, which is what stops scope-local tools such as the native
   * `subagent` (registered in the agent's own scope, so restrict throws for it). Read on
   * every gated call, so a panel change applies to open conversations.
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
  /** Notices allowed per child; 0 means no cap. */
  superviseMaxNoticesPerChild: z.number().min(0).max(20).default(3).volatile(),
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
export function createSupervisionHooks(supervisor, { headSeq, retry, settlements } = {}) {
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
      remember(childId, { parentId, label: args?.description })
      // The retry policy keys on the same record: a child this plugin did not dispatch is
      // never retried, so the host's own `subagent` children stay untouched.
      try {
        retry?.track?.(childId, { parentId, label: args?.description })
      } catch {
        // A retry bookkeeping failure cannot affect the dispatch.
      }
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
              forget(childId)
            },
            (error) => {
              settlements?.settle?.(childId, { ok: false, reason: error instanceof Error ? error.message : String(error) })
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
 * 一次被跟踪会话的 dispatch 起两样东西，顺序固定：
 * 1. 规划首报——票 04 的拼装与归档，落成 `<HH-mm>.md`（与节拍报告同一套模板、
 *    同一个文件名粒度）；
 * 2. 该会话自己的节拍（票 05）——每 `secretaryBeatSeconds` 一拍：把六态投影压成
 *    摘要、与上一份比差异、写一份增量报告；只有实质变化命中 `secretaryNotifyOn`
 *    时才向 Master 冒泡。上一拍与这一拍都是 idle/completed 且没有在跑的 worker 时
 *    停表（`finished`），到达 `secretaryMaxRunSeconds` 由节拍自己停（`max-run`）；
 *    停表之后一拍都不再写文件。
 *
 * 时钟、定时器、投影句柄、投递器与 fs 都能注入（`deps`），生产路径用默认实现；
 * 测试把前三个换成假实现，就能在毫秒内断言九分钟的节拍，而不是等三分钟一拍的真人时间。
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
export function attachSecretary(ctx, config, deps = {}) {
  if (configValue(config, 'secretaryEnabled', false) !== true) return undefined

  const options = deps !== null && typeof deps === 'object' ? deps : {}
  const clock = typeof options.now === 'function' ? options.now : Date.now
  const schedule = typeof options.schedule === 'function' ? options.schedule : unrefScheduled
  const cancel = typeof options.cancel === 'function' ? options.cancel : clearTimeout
  const fs = options.fs ?? fsp

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

  /**
   * 这一拍看到的会话投影：orchestrator 行取自该会话自己的六态，worker 取 header 里
   * 认它作 parentSession 的子会话（与集中视图 collectOrchestratorRows 同一规则）。
   * 步骤与产出在这份投影里没有字段，所以如实留空——不拿 worker 数冒充步骤进度，
   * 那会让「步骤推进」变成编出来的变化。
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
      step: null,
      workers,
    }
  }

  /**
   * 一拍。顺序固定：投影 → 摘要 → 差异 → 落盘 → （有实质变化才）冒泡 → 更新摘要 →
   * 结束判定。任何一步失败都不让节拍塌：写盘失败这一拍就不投递（不让用户收到指向
   * 不存在文件的冒泡），摘要也不前移，下一拍会把同一批变化再算一次。
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
    // 排队里的拍可能晚一点才轮到，用执行时刻会让两拍写进同一个 HH-mm.md。
    const at = Number.isFinite(info?.elapsedMs) ? info.startedAt + info.elapsedMs : readNow()
    if (!canWrite(entry, at)) return

    const orchestrator = await projectSession(sessionId)
    // await 期间可能已经停表（另一拍刚判出结束），落盘前再查一次。
    if (!canWrite(entry, at)) return

    // 每一拍刷新一次草稿：卡点变成可确认的催办由节拍负责，读端点不再顺手攒草稿。
    await refreshDrafts()

    const previous = entry.lastSummary
    const current = summarizeForDiff({ orchestrator, artifacts: [] })
    // 五个开关逐拍读：改设置下一次节拍就生效。
    const enabled = configValue(config, 'secretaryNotifyOn', null)
    const substantial = isSubstantial(previous, current, enabled)
    const changes = classifyChanges(previous, current, enabled)
    const diff = diffSummaries(previous, current)

    let text
    try {
      text = renderReport({
        kind: 'delta',
        at,
        session: entry.session ?? { id: sessionId },
        orchestrator,
        diff,
        artifacts: [],
        timing: { elapsedMs: Math.max(0, at - entry.startedAt), startedAt: entry.startedAt },
      })
    } catch (error) {
      warn(`orchestrator: secretary: cannot render the delta report of ${sessionId}: ${messageOf(error)}`)
      return
    }

    const path = reportPath({ workspace: entry.workspace, conversation: sessionId, at })
    try {
      await writeReport({ fs, path, text })
    } catch (error) {
      warn(`orchestrator: secretary: cannot write the delta report of ${sessionId}: ${messageOf(error)}`)
      return
    }

    if (substantial) {
      const target = pickTarget({
        registry: {
          masterSessionId: configValue(config, 'secretaryMasterSessionId', ''),
          orchestrators: configValue(config, 'secretaryOrchestrators', []),
        },
        config,
      })
      const result = await deliver({ messaging, target, text: bubbleText({ changes, summary: current }) })
      if (result.delivered !== true) {
        warn(
          `orchestrator: secretary: the delta report of ${sessionId} is on disk; its notice was not delivered (${result.reason})`,
        )
      }
    }

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
   * 会把同一批变化算两遍（多写一条、多冒一次泡），所以宁可按顺序走。
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
  const startBeat = ({ session, sessionId, workspace, startedAt }) => {
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
      workspace,
      session,
      // 上限时刻由节拍自己判（到点它就不 tick 了），这里只是把同一个上限算成毫秒，
      // 好让 canWrite 认出"这一拍是在停表之前到期的"。算式与 secretary-beat 的 toMs 一致。
      maxRunMs: Math.max(1, Math.round((Number(maxRunSeconds) > 0 ? Number(maxRunSeconds) : DEFAULT_MAX_RUN_SECONDS) * 1000)),
      chain: Promise.resolve(),
    }
    beats.set(sessionId, entry)
    beat.start()
    return entry
  }

  /** 等所有在跑的拍落定；测试用它把「推进假时钟」和「断言文件」对上。 */
  const settled = async () => {
    while (inFlight.size > 0) await Promise.all([...inFlight])
  }

  // 正在写规划首报的会话：写盘是异步的，两次 dispatch 可能在第一次 mark 之前交错。
  // 这份内存 Set 让第二份让路；成功落盘之后才由 triggerState 长期记住。
  const planning = new Set()

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
    // 同一会话重复 dispatch 不再起表：第一份规划就是这份运行的规划。
    if (triggerState.has(triggerId) || planning.has(triggerId)) return undefined
    planning.add(triggerId)

    // 时钟可注入：规划首报的时间戳、节拍的零点与报告文件名都取自这一个值。
    const at = readNow()
    let report
    try {
      // workers 现在必然为空：dispatch 还没返回，子会话也还不存在。计划里「即将派出」
      // 的那些由 buildPlanReport 从调用参数推出来，并标成 planned。
      report = buildPlanReport({ session, trigger, workers: [], now: at })
    } catch (error) {
      planning.delete(triggerId)
      ctx?.logger?.warn?.(`orchestrator: secretary: cannot build the planning report for ${sessionId}: ${messageOf(error)}`)
      return undefined
    }
    if (report.workspace === '') {
      planning.delete(triggerId)
      ctx?.logger?.warn?.(`orchestrator: secretary: ${sessionId} has no workspace; the planning report stays unwritten`)
      return undefined
    }

    let text
    try {
      text = renderPlanReport({ at, session, plan: report })
    } catch (error) {
      planning.delete(triggerId)
      ctx?.logger?.warn?.(`orchestrator: secretary: cannot render the planning report of ${sessionId}: ${messageOf(error)}`)
      return undefined
    }

    // 目录段先沿用会话 id：用标题还是 id 做目录名仍未决（requirements §10），id 是唯一
    // 稳定的那个。改用标题时只换这里的 conversation，归档规则不动。
    const file = reportPath({ workspace: report.workspace, conversation: report.sessionId, at })
    // 节拍先起：规划首报写失败不该让这一轮彻底失去汇报（下一拍照写）。首拍在三分钟后
    // 才到，与这次写盘无关，所以不挂在写盘的 promise 上。
    startBeat({ session, sessionId: report.sessionId, workspace: report.workspace, startedAt: at })
    // 返回 promise 只为可测：宿主的观察者会接住 rejection 并记日志，这里自己再兜一层。
    // 「起过表」只在真的落盘之后才记：写盘失败的这一轮不算数，下一次 dispatch 会再试。
    return writeReport({ fs, path: file, text }).then((written) => {
      planning.delete(triggerId)
      triggerState.mark(triggerId)
      return written
    }).catch((error) => {
      planning.delete(triggerId)
      ctx?.logger?.warn?.(`orchestrator: secretary: cannot write the planning report of ${sessionId}: ${messageOf(error)}`)
      return undefined
    })
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
 * 只读拼接：登记表与策略照票 01 的键读，运行态取票 02 注册的六态投影，报告索引来自
 * 票 04 的归档目录。任何一段读不到都降级成空段而不抛——视图要看的是"现在能看到什么"，
 * 不是一次目录不存在就把整页变白。真正的失败（read 自己抛错）由 SecretaryRemote 原样
 * 抛给 Gateway，与 MasterRemote.masterState 的"无 handle 就失败"同一原则。
 *
 * 只读工作区：报告只在登记行的工作区里找，未登记的工作区一个目录都不读（spec
 * 用户故事 2：只读用户授权登记过的东西）。登记行没写工作区时，用该会话 header.cwd 补
 * 上——报告本来就是在那里写的；仍补不到就跳过这一行并在行上标 workspaceMissing，不猜目录。
 *
 * 纯快照：草稿由节拍与挂载初始化生成，这里只等那次初始化落定（`ready`）再取
 * `drafts.list()`，自己一条都不生成、不迁移、不写盘。
 *
 * @param ready - 可选；返回挂载初始化的 promise，读之前等它落定，失败只 warn。
 * @param beatStatus - 可选；(sessionId) => 该会话节拍的 status()，填 orchestrators[].beats。
 * @returns 一个零参数 async 函数，返回端点要的四段数据 + policy（enabled 由端点补）。
 */
export function createSecretaryViewRead({ ctx, config, registration, drafts, beatStatus, ready }) {
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

    // 登记行可能没写工作区（设置页登记时只填了会话 id），而报告实际写在那个会话的
    // header.cwd 下。读侧用会话自己补上；补不到就不猜目录——行上标 workspaceMissing，
    // 报告目录整个跳过，绝不拿空串或别人的目录去碰磁盘。
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
    const reportWorkspaces = []
    for (const row of registry.orchestrators) {
      const workspace = row.workspace !== '' ? row.workspace : resolvedWorkspaceOf(row.sessionId)
      if (workspace !== '') reportWorkspaces.push(workspace)
    }

    const reports = await listReportRows({
      fs: fsp,
      workspaces: reportWorkspaces,
      limit: VIEW_REPORT_LIMIT,
    })

    const orchestrators = collectOrchestratorRows({
      registry,
      sessions,
      reports,
      stateOf: (session) => handle?.stateOf?.(session),
      isLive: (sessionId) => ctx?.agents?.get?.(sessionId) !== undefined,
      beatStatus: typeof beatStatus === 'function' ? beatStatus : undefined,
    })

    // 五类冒泡开关在 Config 里存的是名字；认不出的名字由 notifyOnFrom 忽略。
    const notifyOn = configValue(config, 'secretaryNotifyOn', null)
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
      },
    }
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
   * 为什么在这一层补：composeViewState 的策略区只透传设置页真能改的那四个键
   * （beatSeconds / maxRunSeconds / notifyOn / promptText），越权记录不是设置项，混进去
   * 会破坏「策略区只放能改的东西」这条契约。所以记录在拼装之后附加：没有记录时 payload
   * 与今天逐字节一致；有记录时客户端读不认识的字段，本来就降级。
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
  const hooks = createSupervisionHooks(supervision.supervisor, { headSeq: supervision.headSeq, retry, settlements })

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
   * The live gate of every gated main agent, keyed by agent id. A restriction is a mask
   * the host evaluates on each request but whose names are fixed when `restrict()` runs,
   * so the panel's writes only reach an open conversation's tool table once the mask is
   * replaced — see the `loader/volatile-update` listener below.
   */
  const gates = new Map()
  // 已被 authority 认领的 agent：遮罩与 guard 归那一层，gates 表里刻意没有它。
  const authorityClaims = new Map()

  /**
   * 默认闸门。这里顺带登记进 gates 表：authority 交还一个 agent 时会重新调用 installFor，
   * 登记必须跟着发生，否则下一次设置写回会以为这个 agent 没有闸门而重复安装一套。
   * 白名单由 `allowedTools()` 现读、目录由 `collectCatalog(ctx)` 现读，于是面板的勾选
   * 和插件后注册的工具都进得了遮罩。
   */
  const installFor = (agent) => {
    const gate = installGate({
      agent,
      allowed: allowedTools,
      catalog: () => collectCatalog(ctx),
      enabled: () => config.enabled.get(),
    })
    if (typeof agent?.id === 'string') gates.set(agent.id, gate)
    return gate
  }

  /**
   * Rebuild the whitelist mask of every live main agent from the current config and the
   * current registry, and return how many gates actually moved. Idempotent: a gate whose
   * hidden set did not change costs one comparison and touches nothing. A re-entrant call
   * is dropped, because installing a restriction may itself announce `tools/change`.
   */
  let refreshingGates = false
  const refreshGates = () => {
    if (refreshingGates) return 0
    refreshingGates = true
    try {
      let roots = []
      try {
        if (typeof ctx.agents?.roots === 'function') roots = ctx.agents.roots()
      } catch (error) {
        ctx.logger.warn(`orchestrator: cannot enumerate live agents for an Allowed Tools refresh: ${messageOf(error)}`)
        return 0
      }
      let refreshed = 0
      for (const agent of roots) {
        if (isDelegatedChild(agent)) continue
        // 已认领的会话遮罩与 guard 都归 authority 那一层，这里不碰：默认白名单是另一套
        // 口径，重建一套只会把它盖回去，而 restrict 与 guard 都只能收紧。
        if (typeof agent.id === 'string' && authorityClaims.has(agent.id)) continue
        try {
          const gate = gates.get(agent.id)
          if (gate === undefined) {
            gates.set(agent.id, installFor(agent))
            continue
          }
          if (gate.refresh()) refreshed += 1
        } catch (error) {
          ctx.logger.warn(`orchestrator: main agent ${agent.id}: cannot re-apply the Allowed Tools whitelist: ${messageOf(error)}`)
        }
      }
      return refreshed
    } finally {
      refreshingGates = false
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
   * `tools/change` does both jobs now. Publishing keeps the panel's checklist complete;
   * refreshing the gates is what hides a tool that registered after its agent was created,
   * because the host froze the mask of that agent when it was installed.
   */
  const catalog = createCatalogPublisher({ ctx, config })
  ctx.effect(() => () => catalog.dispose(), 'orchestrator: tool catalog')
  ctx.on('tools/change', () => {
    catalog.schedule()
    refreshGates()
  })
  catalog.publish()

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
  ctx.on(
    'subagent/end',
    (info) => {
      const childId = info?.id
      if (typeof childId !== 'string' || childId === '') return
      void Promise.resolve(retry.settle(childId, info, info?.runId)).catch((error) => {
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
   * 会短暂没有闸门。遮罩本身的刷新交给 refreshGates()，它跳过已认领的会话。
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
    const { applied, skipped, guardError } = gate
    // A resumed agent with a parentSession that still read as a main agent means the
    // depth test degraded: the cold-resume regression looked exactly like this.
    if (payload?.source === 'resume' && agent.session?.header?.parentSession !== undefined) {
      ctx.logger.warn(
        `orchestrator: agent ${agent.id} resumed with a parentSession but no delegation depth; gated it as a main agent`,
      )
    }
    if (!config.enabled.get()) return
    ctx.logger.info(
      `orchestrator: main agent ${agent.id}: hid [${applied.join(', ')}]; allowed [${gate.allowed.join(', ')}] on main agent` +
        (skipped.length > 0 ? `; skipped [${skipped.join('; ')}]` : ''),
    )
    if (guardError !== undefined) {
      ctx.logger.warn(`orchestrator: main agent ${agent.id}: guard not installed: ${guardError}`)
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
   * which is why the guard already sees a switch flip or a new whitelist immediately. The
   * model's tool table is different: the registry stores the names it was handed by
   * `restrict()`, so it has to be handed the new ones. Re-installing here rebuilds that
   * mask for every live main agent, and the next model request — the next `preStep`
   * assembly, with no new session and no switch off/on — sees the new table.
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
    const refreshed = refreshGates()
    if (refreshed > 0 && config.enabled.get()) {
      ctx.logger.info(
        `orchestrator: re-applied the Allowed Tools whitelist (${allowedTools().length} allowed) to ${refreshed} open session(s)`,
      )
    }
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
