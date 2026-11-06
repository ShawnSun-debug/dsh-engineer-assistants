/**
 * 调度工具与卡点唤醒（dispatch-command 的下半场）。
 *
 * 三个工具只面向被指定为 Master 的那个会话：
 *
 * - `secretary_state` 读视图端点的同一份 payload（registry / orchestrators / reports /
 *   drafts / policy，越权记录由注入的读函数附在 policy.violations 上）。
 * - `secretary_command` 把一条指令投递到一个**已登记**的 orchestrator 会话；会话不在
 *   登记表里就直接拒绝，和 lib/secretary-authority.js 的 scope.sessions 同一口径。
 * - `secretary_interrupt` 尝试打断该会话正在跑的回合。本模块不认识宿主：打断能力由
 *   调用方注入一个函数，没注入就如实返回「未支持」，绝不伪装成功。
 *
 * 调用者身份按 agent 的 session id 与配置里的 secretaryMasterSessionId 比对
 * （lib/secretary-authority.js 的 sessionIdOf 是唯一读法）。不是 Master 时返回
 * `{ ok: false, error }`，不抛异常——工具被别的会话调用是一次普通拒绝，不是宿主故障。
 *
 * 卡点唤醒（secretaryWakeOnBlocked，默认 false）也在这里：`createBlockedWake` 只做
 * 去重与调用投递器，投递通道是 lib/secretary-deliver.js 的 deliver，由 lib/index.js
 * 注入。开关关着时一次都不调用投递器。
 *
 * 纯构造：本模块不 import 宿主包，也不读时钟。
 *
 * @module
 */

import { sessionIdOf } from './secretary-authority.js'

/** 读状态的工具名。 */
export const SECRETARY_STATE_TOOL = 'secretary_state'

/** 投递一条指令的工具名。 */
export const SECRETARY_COMMAND_TOOL = 'secretary_command'

/** 尝试打断一个回合的工具名。 */
export const SECRETARY_INTERRUPT_TOOL = 'secretary_interrupt'

/** 三个工具名，按注册顺序。 */
export const SECRETARY_TOOL_NAMES = Object.freeze([
  SECRETARY_STATE_TOOL,
  SECRETARY_COMMAND_TOOL,
  SECRETARY_INTERRUPT_TOOL,
])

/** 一条唤醒消息的上限（字）：唤醒是提醒，不是报告。 */
export const WAKE_MAX_CHARS = 300

/** 卡点原因说成人话；认不出的名字不猜，给一句中性描述。 */
const REASON_LABELS = Object.freeze({
  'needs-input': '等你确认',
  error: '运行出错',
  conflict: '登记冲突',
})

function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 正文原样保留：指令里的换行是有意义的。 */
function rawTextOf(value) {
  return typeof value === 'string' ? value : ''
}

function messageOf(error) {
  return error instanceof Error ? error.message || error.name : String(error)
}

/** 按字截断，永远一行。 */
function clamp(text) {
  const chars = [...text]
  if (chars.length <= WAKE_MAX_CHARS) return text
  return chars.slice(0, WAKE_MAX_CHARS - 1).join('') + '…'
}

/** 一条卡点唤醒：说清哪个会话、卡在哪，不重复草稿正文。 */
export function wakeTextOf(draft) {
  const source = asObject(draft)
  const sessionId = textOf(source.sessionId) || '未命名会话'
  const label = REASON_LABELS[textOf(source.reason)] ?? '需要你看一下'
  return clamp(`秘书：会话「${sessionId}」出现卡点（${label}）。草稿已备好，请到秘书视图确认。`)
}

/**
 * 卡点唤醒器。
 *
 * `enabled` 每次调用现读（配置是 volatile），所以关着时连去重表都不写。
 * `target` 现读 Master 会话 id；没有 Master 就返回 null，一次都不投递——猜错接收方
 * 比不说更糟（lib/secretary-deliver.js 的 pickTarget 同一原则）。
 *
 * 去重键是「会话 + 卡点原因」：同一个卡点只唤醒一次，进程重启后清空。投递失败也记
 * 进表：唤醒只在一次卡点里出现一次，失败写日志，不在下一拍重试成刷屏。
 *
 * @param options.enabled - () => boolean，配置开关。
 * @param options.target - () => string | null，Master 会话 id。
 * @param options.deliver - (target, text) => Promise<{ delivered, reason? }>，投递器。
 * @param options.logger - 可选 (message) => void，投递失败只记日志。
 * @returns `{ seen, wake }`；wake(drafts) 返回本次尝试的投递结果。
 */
export function createBlockedWake({ enabled, target, deliver, logger } = {}) {
  const seen = new Set()
  const warn = (message) => {
    try {
      if (typeof logger === 'function') logger(message)
    } catch {
      // 记日志失败不能反过来打断节拍。
    }
  }
  const isOn = () => {
    try {
      return typeof enabled === 'function' ? enabled() === true : enabled === true
    } catch {
      return false
    }
  }
  const targetOf = () => {
    try {
      const value = typeof target === 'function' ? target() : target
      return textOf(value)
    } catch {
      return ''
    }
  }

  return {
    seen,
    async wake(drafts) {
      const outcomes = []
      if (!isOn()) return outcomes
      if (typeof deliver !== 'function') return outcomes
      const to = targetOf()
      if (to === '') return outcomes
      for (const draft of Array.isArray(drafts) ? drafts : []) {
        const source = asObject(draft)
        const sessionId = textOf(source.sessionId)
        const reason = textOf(source.reason)
        if (sessionId === '' || reason === '') continue
        const key = sessionId + '\u0000' + reason
        if (seen.has(key)) continue
        seen.add(key)
        let result
        try {
          result = await deliver(to, wakeTextOf(source))
        } catch (error) {
          result = { delivered: false, reason: messageOf(error) }
        }
        const delivered = result === null || typeof result !== 'object' || result.delivered !== false
        if (!delivered) {
          warn(`orchestrator: secretary: the blocked wake for ${sessionId} (${reason}) was not delivered (${textOf(result.reason) || 'refused'})`)
        }
        outcomes.push({ sessionId, reason, delivered })
      }
      return outcomes
    },
  }
}

/** 三个工具共用的输出形状：成功与拒绝共用一个对象，调用方永远不必 catch。 */
function outcomeProperties() {
  return {
    ok: { type: 'boolean', required: true },
    state: { type: 'json' },
    sessionId: { type: 'string' },
    delivered: { type: 'boolean' },
    supported: { type: 'boolean' },
    requested: { type: 'boolean' },
    status: { type: 'string' },
    reason: { type: 'string' },
    error: { type: 'string' },
  }
}

/**
 * 造三个调度工具。
 *
 * `defineTool` 与全部宿主侧能力都由调用方注入（lib/index.js 是唯一调用方），所以这个
 * 文件可以在没有 DSH 运行时的测试里直接构造。
 *
 * @param options.defineTool - 宿主的 defineTool。
 * @param options.readState - () => Promise<payload>；视图端点的同一个读函数。
 * @param options.deliver - (sessionId, text, senderSessionId) => Promise<{ delivered, reason? }>。
 * @param options.registeredSessionIds - () => string[]，实时读的登记表。
 * @param options.masterSessionId - () => string，实时读的 Master 会话 id。
 * @param options.interrupt - 可选 (sessionId) => { requested, reason?, status? }；
 *   宿主没有打断 API 时省略，工具返回「未支持」。
 * @returns `{ secretary_state, secretary_command, secretary_interrupt }`，键就是工具名。
 */
export function createSecretaryTools({
  defineTool,
  readState,
  deliver,
  registeredSessionIds,
  masterSessionId,
  interrupt,
} = {}) {
  if (typeof defineTool !== 'function') {
    throw new TypeError('createSecretaryTools: defineTool must be injected by the host adapter')
  }
  const masterOf = () => {
    try {
      const value = typeof masterSessionId === 'function' ? masterSessionId() : masterSessionId
      return textOf(value)
    } catch {
      return ''
    }
  }
  const registeredOf = () => {
    try {
      const value = typeof registeredSessionIds === 'function' ? registeredSessionIds() : registeredSessionIds
      if (!Array.isArray(value)) return []
      return value.filter((id) => typeof id === 'string' && id !== '')
    } catch {
      return []
    }
  }

  /** 只有被指定的 Master 会话能调用；其余（包括没指定 Master）一律返回错误对象。 */
  const refusalOf = (exec, toolName) => {
    const master = masterOf()
    if (master === '') {
      return {
        ok: false,
        error:
          'orchestrator: no secretary master is designated (secretaryMasterSessionId is empty), ' +
          `so "${toolName}" has no session it may answer.`,
      }
    }
    const caller = sessionIdOf(exec?.agent)
    if (caller === '') {
      return {
        ok: false,
        error: `orchestrator: cannot tell which session is calling "${toolName}"; only the designated master session may.`,
      }
    }
    if (caller !== master) {
      return {
        ok: false,
        error:
          `orchestrator: session "${caller}" may not call "${toolName}"; ` +
          `only the designated master session ("${master}") may.`,
      }
    }
    return undefined
  }

  const stateTool = defineTool({
    name: SECRETARY_STATE_TOOL,
    description:
      'Read the secretary view state: the registered sessions and their live state, the archived reports, ' +
      'the nudge drafts, the policy and the recorded authority refusals. It returns the same payload the ' +
      'secretary view renders. Only the designated master session may call it; every other caller gets an error.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: outcomeProperties() },
      render: (_args, value) =>
        value?.ok === false
          ? [{ type: 'text', text: value.error ?? 'secretary state refused' }]
          : [{ type: 'text', text: 'secretary state' }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const refusal = refusalOf(exec, SECRETARY_STATE_TOOL)
      if (refusal !== undefined) return refusal
      if (typeof readState !== 'function') {
        return { ok: false, error: 'orchestrator: the secretary state reader is unavailable' }
      }
      try {
        const state = await readState()
        return { ok: true, state: state ?? null }
      } catch (error) {
        return { ok: false, error: 'orchestrator: cannot read the secretary state: ' + messageOf(error) }
      }
    },
  })

  const commandTool = defineTool({
    name: SECRETARY_COMMAND_TOOL,
    description:
      'Send one instruction to a session registered with the secretary. The session id must be in the ' +
      'registered orchestrator list: an unregistered conversation is refused, and nothing is delivered. ' +
      'Only the designated master session may call it.',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: 'The registered orchestrator session that should receive the instruction.',
      },
      text: {
        type: 'string',
        required: true,
        description: 'The instruction, delivered as one cross-session message.',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: outcomeProperties() },
      render: (_args, value) =>
        value?.ok === true
          ? [{ type: 'text', text: `delivered to ${value.sessionId}` }]
          : [{ type: 'text', text: value?.error ?? 'command refused' }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const refusal = refusalOf(exec, SECRETARY_COMMAND_TOOL)
      if (refusal !== undefined) return refusal
      const sessionId = textOf(args?.sessionId)
      const text = rawTextOf(args?.text)
      if (sessionId === '') {
        return { ok: false, sessionId: '', error: `orchestrator: "${SECRETARY_COMMAND_TOOL}" needs a session id` }
      }
      if (text.trim() === '') {
        return { ok: false, sessionId, error: `orchestrator: "${SECRETARY_COMMAND_TOOL}" needs a non-empty text` }
      }
      if (!registeredOf().includes(sessionId)) {
        return {
          ok: false,
          sessionId,
          error:
            `orchestrator: "${SECRETARY_COMMAND_TOOL}" to session "${sessionId}" is refused: ` +
            'only a session registered with the secretary may receive a command.',
        }
      }
      if (typeof deliver !== 'function') {
        return { ok: false, sessionId, error: 'orchestrator: no cross-session delivery is available' }
      }
      let result
      try {
        result = await deliver(sessionId, text, sessionIdOf(exec?.agent))
      } catch (error) {
        result = { delivered: false, reason: messageOf(error) }
      }
      if (result === null || typeof result !== 'object' || result.delivered !== false) {
        return { ok: true, sessionId, delivered: true }
      }
      const reason = textOf(result.reason) || 'refused'
      return {
        ok: false,
        sessionId,
        delivered: false,
        reason,
        error: `orchestrator: the command for session "${sessionId}" was not delivered (${reason})`,
      }
    },
  })

  const interruptTool = defineTool({
    name: SECRETARY_INTERRUPT_TOOL,
    description:
      'Ask the current turn of a registered orchestrator session to stop. It returns once the request is ' +
      'issued, not when the session is idle, and an idle session is an ordinary no-op. Only the designated ' +
      'master session may call it. When the host exposes no interrupt API the tool reports ' +
      'supported:false and nothing is interrupted.',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: 'The registered orchestrator session whose current turn should stop.',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: outcomeProperties() },
      render: (_args, value) =>
        value?.ok === true
          ? [{ type: 'text', text: `interrupt requested for ${value.sessionId}` }]
          : [{ type: 'text', text: value?.error ?? 'interrupt refused' }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const refusal = refusalOf(exec, SECRETARY_INTERRUPT_TOOL)
      if (refusal !== undefined) return refusal
      const sessionId = textOf(args?.sessionId)
      if (sessionId === '') {
        return { ok: false, sessionId: '', error: `orchestrator: "${SECRETARY_INTERRUPT_TOOL}" needs a session id` }
      }
      if (!registeredOf().includes(sessionId)) {
        return {
          ok: false,
          sessionId,
          error:
            `orchestrator: "${SECRETARY_INTERRUPT_TOOL}" to session "${sessionId}" is refused: ` +
            'only a session registered with the secretary may be interrupted.',
        }
      }
      if (typeof interrupt !== 'function') {
        return {
          ok: false,
          sessionId,
          supported: false,
          error: 'orchestrator: the host exposes no API to interrupt a running turn; nothing was interrupted',
        }
      }
      let outcome
      try {
        outcome = await interrupt(sessionId)
      } catch (error) {
        outcome = { requested: false, reason: messageOf(error) }
      }
      const result = asObject(outcome)
      if (result.requested !== true) {
        const reason = textOf(result.reason) || 'not-interrupted'
        if (reason === 'unsupported') {
          return {
            ok: false,
            sessionId,
            supported: false,
            error: 'orchestrator: the host exposes no API to interrupt a running turn; nothing was interrupted',
          }
        }
        return {
          ok: false,
          sessionId,
          supported: true,
          reason,
          error: `orchestrator: the interrupt for session "${sessionId}" was not issued (${reason})`,
        }
      }
      const status = textOf(result.status)
      return { ok: true, sessionId, requested: true, ...(status === '' ? {} : { status }) }
    },
  })

  // 键就是工具名：注册处按名字取用，不必再复制一份对应表。
  return {
    [SECRETARY_STATE_TOOL]: stateTool,
    [SECRETARY_COMMAND_TOOL]: commandTool,
    [SECRETARY_INTERRUPT_TOOL]: interruptTool,
  }
}
