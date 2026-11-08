/**
 * dispatch v2（engineer-assistants 1.0.0 票 05）。
 *
 * 一句话：把「派一个 worker」拆成三步——**校验并定计划**、**重任务问一次**、**预占 → spawn**，
 * 调用方拿到 workerId 就回去继续说话（异步，不等结果）。
 *
 * 三条规矩：
 *
 * - **cwd 每次必填。** worker 没有默认工作目录：猜错目录的代价是改错仓。缺了直接拒。
 * - **类别与预设不一致要说出来，但不拦。** 预设自带默认类别；派发时覆盖是允许的，
 *   但静默覆盖会让监工盯错东西，所以给一条 warning 让调用方看见。
 * - **重任务先问一次。** 轻任务（≤3 个文件、或显式 light）直接走；重任务没有确认通道就拒绝，
 *   而不是默默派出去。
 *
 * 本模块不碰宿主：`reserve`、`spawn`、`release`（以及可选的 `confirm`、`reassign`）全部由
 * 调用方注入，测试用假实现。
 *
 * @module
 */

export const DISPATCH_TOOL_NAME = 'dispatch'

/** 与登记表同一套类别。 */
export const CATEGORIES = Object.freeze(['code', 'maybe-code', 'non-code'])

/** 轻任务的判定上限：预计改动不超过这么多个文件。 */
export const MAX_FILES_FOR_LIGHT = 3

function readText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function requireText(fn, label, value) {
  const text = readText(value)
  if (text === '') throw new TypeError(`${fn}: ${label} must be a non-empty string`)
  return text
}

function readList(value, label) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new TypeError(`dispatch: ${label} must be an array`)
  const out = []
  for (const item of value) {
    const text = readText(item)
    if (text === '') throw new TypeError(`dispatch: ${label} must contain non-empty strings`)
    if (!out.includes(text)) out.push(text)
  }
  return out
}

/**
 * 校验入参并给出计划。抛错即拒绝派发；`warnings` 是「照派但要告诉调用方」的提示。
 */
export function planDispatch(args, { presets } = {}) {
  const fn = 'dispatch'
  if (args === null || typeof args !== 'object') throw new TypeError(`${fn}: arguments must be an object`)
  const goal = requireText(fn, 'goal', args.goal)
  const prompt = requireText(fn, 'prompt', args.prompt)
  const cwd = requireText(fn, 'cwd', args.cwd)
  const presetId = requireText(fn, 'presetId', args.presetId)
  // 只认自有键：presets 是普通对象，'constructor' / '__proto__' 会顺着原型链拿到函数。
  if (!Object.hasOwn(presets ?? {}, presetId)) throw new TypeError(`${fn}: unknown preset "${presetId}"`)
  const preset = presets[presetId]
  const files = readList(args.files, 'files')
  if (args.verify !== undefined && typeof args.verify !== 'string') {
    throw new TypeError(`${fn}: verify must be a string (the acceptance command)`)
  }
  const verify = readText(args.verify)

  const warnings = []
  if (args.category !== undefined && typeof args.category !== 'string') {
    throw new TypeError(`${fn}: category must be one of ${CATEGORIES.join(', ')}`)
  }
  const requested = readText(args.category)
  let category = preset.category ?? ''
  if (requested !== '') {
    if (!CATEGORIES.includes(requested)) {
      throw new TypeError(`${fn}: category must be one of ${CATEGORIES.join(', ')} (got "${requested}")`)
    }
    if (requested !== preset.category) {
      warnings.push(`category "${requested}" differs from the "${presetId}" default "${preset.category}"; the inspector will watch for ${requested}`)
    }
    category = requested
  }

  // 轻任务：显式 light 说了算（显式 false 就是重任务），否则看预计改动的文件数；
  // 没给 files 就不猜，按重任务算。非布尔值不猜成一个更宽松的档位。
  if (args.light !== undefined && typeof args.light !== 'boolean') {
    throw new TypeError(`${fn}: light must be a boolean (got ${JSON.stringify(args.light)})`)
  }
  const light = args.light === false
    ? false
    : args.light === true || (files.length > 0 && files.length <= MAX_FILES_FOR_LIGHT)

  return { goal, prompt, cwd, presetId, category, files, verify, light, warnings }
}

/**
 * 执行一次派发：重任务先确认，**先预占登记行**，再 spawn，拿到 id 立刻返回。
 *
 * 顺序不能倒：spec 第 30 行钉的是 `reserve → 写行 → spawn`。反过来的话，一个写在 spawn
 * 之后的登记钩子一旦缺失，就会出现「worker 在跑、登记表里没有」——冷恢复时它拿不到预设边界。
 *
 * `deps` 必需 `presets`、`reserve(plan) => workerId`、`spawn(plan, workerId) => workerId`、
 * `release(workerId, cause) => void`（预占之后任何失败都要收回那一行；它自己失败时原始错误
 * 保留、回收失败附在后面）；
 * 可选 `confirm(plan) => boolean`（重任务必填）、`reassign(from, to)`（宿主自选了别的 id 时
 * 把登记行搬过去）。返回形状以 spec 的 `workerId` 为准，接线时工具的 output schema 要跟着改。
 */
export async function executeDispatch({ args, deps = {} }) {
  const plan = planDispatch(args, { presets: deps.presets })
  if (!plan.light) {
    if (typeof deps.confirm !== 'function') {
      throw new Error('dispatch: a heavy task needs a confirmation channel, and none is installed')
    }
    const approved = await deps.confirm(plan)
    if (approved !== true) throw new Error('dispatch: the user did not approve this dispatch')
  }
  if (typeof deps.reserve !== 'function') {
    throw new Error('dispatch: no reservation hook was installed, so the worker would run unregistered')
  }
  if (typeof deps.spawn !== 'function') throw new Error('dispatch: no spawn function was installed')
  if (typeof deps.release !== 'function') {
    throw new Error('dispatch: no release hook was installed, so a failed spawn would leave a reserved row behind')
  }

  const reservedId = await deps.reserve(plan)
  if (typeof reservedId !== 'string' || reservedId === '') {
    throw new Error('dispatch: the reservation returned no worker id')
  }

  // 预占之后任何失败都必须把这一行收回去，否则登记表里会留下一个永远不会结束的幽灵 worker：
  // 监工与面板都按这张表算，别的 parent 也再抢不到这个 id。
  //
  // 回收自己失败时**不能顶替原错误**：原错误里可能带着「某个 worker 正在跑」这种必须先处理的
  // 事实。两个钩子写的是同一张登记表，一起挂掉是相关失败，不是奇景。
  // 用 null 当「成功」哨兵：空字符串会和「release 抛了一个空消息的异常」撞车。
  const releaseRow = async (cause) => {
    try {
      await deps.release(reservedId, cause)
      return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  try {
    let workerId
    try {
      workerId = await deps.spawn(plan, reservedId)
    } catch (error) {
      throw new Error(
        `dispatch: spawn failed for reserved worker "${reservedId}": ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (typeof workerId !== 'string' || workerId === '') {
      throw new Error(`dispatch: spawn returned no worker id for the reserved worker "${reservedId}"`)
    }
    if (workerId !== reservedId) {
      if (typeof deps.reassign !== 'function') {
        throw new Error(`dispatch: the host spawned "${workerId}" but "${reservedId}" was registered, and no reassign hook exists`)
      }
      try {
        await deps.reassign(reservedId, workerId)
      } catch (error) {
        throw new Error(
          `dispatch: worker "${workerId}" is running but the registry row "${reservedId}" could not be moved (${error instanceof Error ? error.message : String(error)})`,
        )
      }
    }
    return {
      kind: 'activation',
      workerId,
      presetId: plan.presetId,
      category: plan.category,
      light: plan.light,
      warnings: plan.warnings,
    }
  } catch (error) {
    const original = error instanceof Error ? error.message : String(error)
    const releaseFailure = await releaseRow(error)
    if (releaseFailure === null) throw error
    throw new Error(`${original}; additionally the reserved row "${reservedId}" could not be released (${releaseFailure})`)
  }
}
