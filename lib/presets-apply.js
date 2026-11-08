/**
 * 按登记表施加预设（engineer-assistants 1.0.0 票 04）。
 *
 * 一句话：会话刚创建、或冷恢复重放时，按登记行把 worker 收成预设该有的样子——
 * `tools.restrict` 逐条挡住继承来的工具、`tools.guard` 挡住执行、`systemPrompt.section`
 * 挂一段只对这个会话生效的提示，并把模型可见的工具面交给上层裁。
 *
 * 三条宿主事实决定了这里的写法：
 *
 * - **预设里的 `terminal` 是抽象名。** 宿主注册的是 `terminal_open/close/send/read/list/signal`
 *   这一族，不叫 `terminal`；直接拿 `terminal` 去 restrict 会整条抛错，于是「只读」预设永远
 *   启动不了，而「能动代码」的预设也永远跑不了命令。这里把抽象名展开成真实名字。
 * - **`run_code` 是 PTC 子代理唯一的直接工具**，而且每个调用都先过 guard。挡掉它等于让
 *   worker 什么都干不了，所以 guard 必须放它过去，再用 `runCodeRefusal` 检查参数。
 * - **段落文本要 `interpolate: false`。** 预设 prompt 是用户可编辑的自由文本，含 `{{`
 *   会让宿主在装配时抛 unknown prompt variable，整个 worker 起不来。
 *
 * 两条硬规矩：该受管的 worker 没有登记行就拒绝启动；restrict / guard 装不上时撤销已装部分
 * 并抛错，绝不返回一个「看起来成功、实际裸奔」的结果。
 *
 * @module
 */

import { RUN_CODE_TOOL, runCodeRefusal } from './run-code-guard.js'

/** prompt 段名前缀：带上会话 id，避免两个 worker 用同一个预设时撞名。 */
export const PROMPT_SECTION_PREFIX = 'preset:'

/** 段落顺序：排在插件自己的常驻提示之后，不影响宿主默认段。 */
export const PROMPT_SECTION_ORDER = 120

/**
 * 预设里的抽象工具名 → 宿主真实工具名。`terminal` 是唯一需要展开的抽象：
 * 宿主按动作拆成六个工具，外加两种 shell 适配器。
 */
export const TOOL_FAMILIES = Object.freeze({
  terminal: Object.freeze([
    'terminal_open',
    'terminal_close',
    'terminal_send',
    'terminal_read',
    'terminal_list',
    'terminal_signal',
    'bash',
    'pwsh',
  ]),
})

/** 当前进程里已注册的段落，按会话 id 记 disposer——重放前先撤旧的。 */
const liveSections = new Map()

function readText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function readList(value, label) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new TypeError(`buildPresetPlan: ${label} must be an array`)
  const out = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new TypeError(`buildPresetPlan: ${label} contains a non-string entry`)
    }
    if (!out.includes(item)) out.push(item)
  }
  return out
}

/** 把抽象名展开成宿主真实名字；不是抽象名就原样返回。 */
export function expandToolName(name) {
  const text = readText(name)
  if (text === '') throw new TypeError('expandToolName: a tool name must be a non-empty string')
  return TOOL_FAMILIES[text] ? [...TOOL_FAMILIES[text]] : [text]
}

/** 把一套预设压成一份可执行的计划。非法输入抛错：这是安全边界的入口，宁可炸。 */
export function buildPresetPlan(preset) {
  if (preset === null || typeof preset !== 'object') {
    throw new TypeError('buildPresetPlan: a preset must be an object')
  }
  const id = typeof preset.id === 'string' ? preset.id.trim() : ''
  if (id === '') throw new TypeError('buildPresetPlan: a preset needs an id')
  const tools = preset.tools !== null && typeof preset.tools === 'object' ? preset.tools : {}
  const allow = readList(tools.allow, 'tools.allow')
  const deny = readList(tools.deny, 'tools.deny')
  return Object.freeze({
    id,
    allow: Object.freeze(allow),
    deny: Object.freeze(deny),
    allowNames: Object.freeze([...new Set(allow.flatMap(expandToolName))]),
    denyNames: Object.freeze([...new Set(deny.flatMap(expandToolName))]),
    prompt: typeof preset.prompt === 'string' ? preset.prompt : '',
    category: typeof preset.category === 'string' ? preset.category : '',
    modelTier: typeof preset.modelTier === 'string' ? preset.modelTier : '',
  })
}

/**
 * 执行期判定：不在允许名单里的调用被拒。宿主签名是 `(exec) => string|undefined`。
 *
 * `run_code` 例外：它是 PTC 子代理唯一的直接工具，挡掉等于让 worker 无从下手。放它过去，
 * 但用 `runCodeRefusal` 检查参数——与主代理那条 gate 的处置一致。
 */
export function presetGuard(plan) {
  const allowed = new Set(plan.allowNames ?? [])
  return (exec) => {
    const tool = exec?.name
    if (typeof tool !== 'string' || tool === '') return undefined
    if (tool === RUN_CODE_TOOL) {
      const refusal = runCodeRefusal(exec?.arguments, true)
      if (refusal === undefined) return undefined
      // 宿主那句提示是写给主代理的（"hand every action to a worker"）——对 worker 说这句话
      // 等于让它去调一个自己的 guard 也不放行的工具。保留被拒的标识符，换掉建议。
      // 申请沙箱升级与「程序想碰宿主运行时」是两件事，不能报成同一句。
      const args = exec?.arguments
      const escalation =
        args !== null && typeof args === 'object' && (args.sandbox_permissions !== undefined || args.justification !== undefined)
      if (escalation) {
        return `preset "${plan.id}": this run_code call asks for sandbox escalation; a preset-scoped worker runs without it`
      }
      const forbidden = refusal.match(/\("([^"]+)"\)/)
      return `preset "${plan.id}": this run_code program would reach the Node.js or host runtime${forbidden ? ` ("${forbidden[1]}")` : ''}`
    }
    if (allowed.has(tool)) return undefined
    return `preset "${plan.id}": tool "${tool}" is not available to this worker`
  }
}

/** 从装配上下文里读会话 id；读不到就返回空串（空串让段落不生效，绝不猜）。 */
export function sectionSessionId(context) {
  const direct = context?.sessionId ?? context?.session?.id ?? context?.agent?.id
  if (typeof direct === 'string' && direct !== '') return direct
  const options = context?.agent?.options
  return typeof options?.sessionId === 'string' ? options.sessionId : ''
}

function disposeQuietly(disposers, warn) {
  for (const dispose of disposers.splice(0)) {
    try {
      if (typeof dispose === 'function') dispose()
    } catch (error) {
      if (typeof warn === 'function') {
        warn('cannot lift a preset step: ' + (error instanceof Error ? error.message : String(error)))
      }
    }
  }
}

/**
 * `agent/created` 的入口。启动与冷恢复走同一条路（`source` 只被记录，不改变序列）。
 *
 * 选项：
 * - `isWorker(agent)`：判断这个会话是否受本插件管。**默认一律 false**：宿主自己的 subagent
 *   也是"代理子会话"，拿它当判据会在 agent/created 里误伤普通子代理。接线方必须传入「在登记表
 *   里有预占行」的判定。
 * - `surface.install(visible) => dispose`：裁模型可见工具面的安装器。宿主
 *   `tools.definitions` 是 getter 装不了东西，所以由上层把白名单接进它的包装层。没给就不
 *   声称做过裁剪。
 */
export function applyPresetForAgent({ agent, assignment, preset, warn, source = 'create', isWorker = () => false, surface }) {
  const sessionId = typeof agent?.id === 'string' ? agent.id : ''
  const managed = typeof isWorker === 'function' ? isWorker(agent) === true : false
  if (!managed) {
    return {
      sessionId,
      source,
      presetId: '',
      applied: [],
      skipped: [{ capability: 'preset', reason: 'not a worker' }],
      visible: null,
      dispose: () => {},
    }
  }
  if (assignment === undefined || assignment === null) {
    throw new Error(
      `applyPresetForAgent: no assignment row for session "${sessionId}"; refusing to start an unclassified worker`,
    )
  }
  const plan = buildPresetPlan(preset ?? {})
  const rowPresetId = readText(assignment.presetId)
  if (rowPresetId !== '' && rowPresetId !== plan.id) {
    throw new Error(
      `applyPresetForAgent: session "${sessionId}" was assigned preset "${rowPresetId}" but "${plan.id}" was supplied`,
    )
  }

  const applied = []
  const skipped = []
  const disposers = []
  const tools = agent?.ctx?.tools

  // 1) 逐条 restrict：一次一个名字。抽象名展开成一族，只要这一族里有名字装上就算这一条做到；
  //    整族都装不上（或单个名字失败）就是致命错误。
  if (tools === null || typeof tools !== 'object' || typeof tools.restrict !== 'function') {
    throw new Error(`applyPresetForAgent: session "${sessionId}" has no tools.restrict; refusing to start`)
  }
  for (const abstractName of plan.deny) {
    const names = expandToolName(abstractName)
    let installed = 0
    const failures = []
    for (const name of names) {
      try {
        const dispose = tools.restrict({ deny: [name] })
        if (typeof dispose === 'function') disposers.push(dispose)
        installed += 1
      } catch (error) {
        failures.push(`${name} (${error instanceof Error ? error.message : String(error)})`)
      }
    }
    if (installed === 0) {
      disposeQuietly(disposers, warn)
      throw new Error(
        `applyPresetForAgent: cannot restrict "${abstractName}" for session "${sessionId}": ${failures.join('; ')}`,
      )
    }
    if (failures.length > 0 && typeof warn === 'function') {
      warn(`preset ${plan.id}: some "${abstractName}" tools are not registered here: ${failures.join('; ')}`)
    }
    applied.push(`restrict:${abstractName}`)
  }

  // 2) guard：执行准入。装不上就是裸奔，必须拒绝启动。
  if (typeof tools.guard !== 'function') {
    disposeQuietly(disposers, warn)
    throw new Error(`applyPresetForAgent: session "${sessionId}" has no tools.guard; refusing to start`)
  }
  try {
    const dispose = tools.guard(presetGuard(plan))
    if (typeof dispose === 'function') disposers.push(dispose)
    applied.push('guard')
  } catch (error) {
    disposeQuietly(disposers, warn)
    throw new Error(
      `applyPresetForAgent: cannot install the preset guard for session "${sessionId}": ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  // 3) prompt 段：按会话 id 命名，重放先撤旧的；文本按装配时的会话 id 现算。
  const prompt = agent?.ctx?.systemPrompt
  if (prompt !== null && typeof prompt === 'object' && typeof prompt.section === 'function') {
    try {
      const previous = liveSections.get(sessionId)
      if (typeof previous === 'function') {
        try {
          previous()
        } catch {
          // 旧段撤不掉不影响重装。
        }
        liveSections.delete(sessionId)
      }
      const removed = prompt.section({
        name: PROMPT_SECTION_PREFIX + sessionId,
        order: PROMPT_SECTION_ORDER,
        // 用户可编辑的自由文本：含 {{ 会让宿主在装配时抛 unknown prompt variable。
        interpolate: false,
        text: (context) => (sectionSessionId(context) === sessionId ? plan.prompt : ''),
      })
      if (typeof removed === 'function') {
        liveSections.set(sessionId, removed)
        disposers.push(() => {
          if (liveSections.get(sessionId) === removed) liveSections.delete(sessionId)
          removed()
        })
        // 会话销毁时也清掉本地登记，否则一个 worker 一行、永不回收。
        if (typeof agent?.ctx?.effect === 'function') {
          try {
            agent.ctx.effect(() => () => {
              if (liveSections.get(sessionId) === removed) liveSections.delete(sessionId)
            })
          } catch {
            // effect 登记失败不影响已经装上的段落。
          }
        }
      }
      applied.push('section')
    } catch (error) {
      skipped.push({ capability: 'section', reason: error instanceof Error ? error.message : String(error) })
      if (typeof warn === 'function') {
        warn(`preset ${plan.id}: section skipped: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  } else {
    skipped.push({ capability: 'section', reason: 'unavailable' })
  }

  // 4) 模型可见工具面：宿主没有安装器，只有包装器。由上层提供 surface 才算做过。
  // `run_code` 必须留在白名单里：它是子代理唯一的直接工具，而白名单会被上层当成
  // 「模型能看见什么」的唯一依据——漏掉它，工具面裁剪就把 worker 的手也裁掉了。
  const visible = { allow: [...new Set([...plan.allowNames, RUN_CODE_TOOL])], deny: [...plan.denyNames] }
  if (surface !== null && typeof surface === 'object' && typeof surface.install === 'function') {
    try {
      const dispose = surface.install(visible)
      // 拿不到 disposer 就不算「装上了」：返回的结果不能声称一个自己撤不掉的步骤。
      if (typeof dispose !== 'function') {
        throw new Error('the surface installer returned no disposer')
      }
      disposers.push(dispose)
      applied.push('definitions')
    } catch (error) {
      skipped.push({ capability: 'definitions', reason: error instanceof Error ? error.message : String(error) })
      if (typeof warn === 'function') {
        warn(`preset ${plan.id}: definitions skipped: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  } else {
    skipped.push({ capability: 'definitions', reason: 'no surface installer' })
  }

  let disposed = false
  return {
    sessionId,
    source,
    presetId: plan.id,
    applied,
    skipped,
    visible,
    dispose: () => {
      if (disposed) return
      disposed = true
      disposeQuietly(disposers, warn)
    },
  }
}
