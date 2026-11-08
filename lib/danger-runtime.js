/**
 * 危险闸门的运行时（engineer-assistants phase 2 票 20）。
 *
 * 一句话：worker 的每一次工具调用先过这张单子——命中的**不可逆**类目在真正执行前问一次人，
 * 其余危险类目只记账不拦。
 *
 * 四条规矩：
 *
 * - **只拦不可逆。** 六类里 `deploy` 有回滚路径，只记不拦；其余五类（删/覆盖文件、强写历史、
 *   改生产数据、改宿主或全局配置、对外动作）一旦发生就收不回来。名单只有一处，改口径改这里。
 *   依据：spec 第 8 节与 ADR 0016（"六类不可逆动作"），phase 2 规格第 30 行（"只拦不可逆子集"）。
 * - **拦在执行之前。** 监听 `tools/pre-execute`（异步瀑布），问不到批准就不放行；不是在执行后补记录。
 * - **同一件事只问一次。** 键与 `danger.js` 的 `dangerKey` 同一把尺子：同一个键的并发请求合流到
 *   同一次询问，**不延长**原本的截止时间（超时在闸门里，这里不另起一个）。
 * - **判定失败也拦。** 分类器抛错、通道缺失、形状不对，一律按「没批」处理——静默放行等于把闸门拆掉。
 *
 * 本模块不碰宿主：询问通道（`check`）、记账（`record`）都由调用方注入。
 *
 * @module
 */

import { classifyDanger, dangerKey } from './danger.js'

/** 一旦发生就收不回来的五类：闸门拦它们。 */
export const DANGER_IRREVERSIBLE = Object.freeze([
  'file-destruction',
  'history-rewrite',
  'production-data',
  'host-config',
  'outbound',
])

/** 有回滚路径、只记不拦的类目（当前只有发布部署）。 */
export const DANGER_RECORD_ONLY = Object.freeze(['deploy'])

/** 工具参数里可能是「一条命令」的字段名，按这个顺序取第一个非空字符串。 */
const COMMAND_FIELDS = Object.freeze(['command', 'script'])

/**
 * 从一次工具调用的参数里取出要被检查的命令文本；没有就是空串。
 *
 * 只认字符串：`{ command: ['rm', '-rf'] }` 这种形状不是一条命令，不替它拼。
 */
export function commandOfToolCall(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return ''
  for (const field of COMMAND_FIELDS) {
    const value = args[field]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

/** 拒绝时交给模型/调用方的那句话：类目 + 命令原文，不含糊成「危险」。 */
function denialReasonOf(command, categories) {
  return '未获批准的不可逆动作（' + categories.join('、') + '）：' + command
}

/**
 * 建一组运行时回调。
 *
 * `check(input, context)` 是询问通道，通常就是 `createDangerGate({ ask }).check`：返回
 * `{ approved, reason }`。`record(event)` 是账本，记录只拦不拦、批没批；它抛错不影响判定。
 *
 * 返回的 `preExecute(exec, next)` 可直接挂到 `tools/pre-execute`：允许时 `next()`，
 * 拦下时返回 `{ kind: 'deny', reason }`。
 */
export function createDangerPolicy({ check, record } = {}) {
  /** 键 -> 在途询问；同一件事的并发请求合流，不另开一张卡。 */
  const inflight = new Map()

  const report = (event) => {
    if (typeof record !== 'function') return
    try {
      record(event)
    } catch {
      // 记账失败不改变判定。
    }
  }

  const askOnce = (plan, context) => {
    const key = dangerKey(plan)
    const existing = inflight.get(key)
    if (existing !== undefined) return existing
    const entry = Promise.resolve()
      .then(() => (typeof check === 'function' ? check({ command: plan.command, intent: plan.intent }, context) : { approved: false, reason: 'declined' }))
      .then((verdict) => (verdict !== null && typeof verdict === 'object' ? verdict : { approved: false, reason: 'declined' }))
      .catch(() => ({ approved: false, reason: 'declined' }))
      .finally(() => {
        if (inflight.get(key) === entry) inflight.delete(key)
      })
    inflight.set(key, entry)
    return entry
  }

  return {
    /** 在途问题数（测试与诊断用）。 */
    inflightCount() {
      return inflight.size
    },

    async preExecute(exec, next) {
      const toolName = typeof exec?.name === 'string' ? exec.name : ''
      const command = commandOfToolCall(exec?.arguments)
      // 没有命令文本就无从判定：不是 shell 类调用，放行。
      if (command === '') return next()

      let plan
      try {
        plan = classifyDanger({ command, intent: toolName })
      } catch {
        return { kind: 'deny', reason: '危险判定失败，按未批准处理：' + command }
      }

      const blocking = plan.categories.filter((category) => DANGER_IRREVERSIBLE.includes(category))
      if (blocking.length === 0) {
        if (plan.categories.length > 0) {
          report({ kind: 'record-only', categories: plan.categories, command, toolName })
        }
        return next()
      }

      // 面板与监工按**会话 id** 记账，不是 agent id：红点要和画出来的行求交集，行上是 sessionId。
      const sessionId = exec?.agent?.session?.id
      const context = {
        toolName,
        workerId:
          typeof sessionId === 'string' && sessionId !== ''
            ? sessionId
            : typeof exec?.agent?.id === 'string'
              ? exec.agent.id
              : '',
        callId: exec?.callId,
        signal: exec?.signal,
        agent: exec?.agent,
      }
      report({ kind: 'asked', categories: blocking, command, toolName, workerId: context.workerId })
      const verdict = await askOnce(plan, context)
      report({
        kind: 'decision',
        approved: verdict.approved === true,
        reason: typeof verdict.reason === 'string' ? verdict.reason : '',
        categories: blocking,
        command,
        toolName,
        workerId: context.workerId,
      })
      if (verdict.approved === true) return next()
      return { kind: 'deny', reason: denialReasonOf(command, blocking) }
    },
  }
}
