/**
 * 批量与分阶段（engineer-assistants 1.0.0 票 06）。
 *
 * 一句话：`items` 并行（并发上限由 maxConcurrency 控制），每个 item 内部按 `stages` 串行；
 * 每一项有自己的一条登记行，一项失败不牵连别的项。
 *
 * 三条规矩：
 *
 * - **并发上限是硬上限，不是提示。** 同时在跑的 item 永远不超过 `maxConcurrency`。
 * - **阶段失败即止。** 一个 item 的某个阶段抛错后，它后面的阶段一律不启动——半成品接着跑
 *   下一阶段，产出的是看似成功、实际基于残缺输入的产物。
 * - **结果是聚合的，不是第一个异常。** 包括「登记行都写不下」这种开跑前的失败：它只让那一项
 *   失败，不会把整批一起抛掉——否则调用方拿到异常时，其余 item 已经在后台跑起来了。
 *
 * 本模块不碰宿主：`runStage`、`onItemStart` 全部由调用方注入。
 *
 * @module
 */

/** 默认并发：四个，和宿主的 worker 池习惯一致。 */
export const DEFAULT_MAX_CONCURRENCY = 4

function readArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`runBatch: ${label} must be an array`)
  return value
}

/**
 * 把一个抛出物读成一句人话；结构化对象至少留下它的可读内容。
 *
 * 整个函数包在 try 里：抛出物可能有会抛的 getter，读数本身失败时也不能让一项的失败变整批的
 * 异常——那正是这个模块要避免的事。
 */
function messageOf(error) {
  try {
    if (error instanceof Error) {
      // message 可能是任何值（有人直接赋值），非字符串会把不可序列化的东西带进报告。
      return typeof error.message === 'string' ? error.message : 'unprintable error'
    }
    const message = error !== null && typeof error === 'object' ? error.message : undefined
    if (typeof message === 'string' && message !== '') return message
    if (error !== null && typeof error === 'object') {
      try {
        return JSON.stringify(error)
      } catch {
        return 'unprintable error'
      }
    }
    return String(error)
  } catch {
    return 'unprintable error'
  }
}

/**
 * 把抛出物压成可序列化的描述。**不留原始值**：axios 之类的错误带循环引用，BigInt 抛不出去，
 * 一旦挂在返回值上，调用方序列化整批结果时就会炸——那时所有 item 都已经跑完了。
 */
function describeCause(error) {
  try {
    const readCode = (source) => {
      const code = source !== null && typeof source === 'object' ? source.code : undefined
      return typeof code === 'string' || typeof code === 'number' ? code : undefined
    }
    if (error instanceof Error) {
      // name/message 也可能被赋成怪东西（循环对象、数字），只收字符串。
      return {
        name: typeof error.name === 'string' ? error.name : 'Error',
        message: typeof error.message === 'string' ? error.message : 'unprintable error',
        code: readCode(error),
      }
    }
    if (error !== null && typeof error === 'object') {
      const message = typeof error.message === 'string' ? error.message : undefined
      return { name: 'thrown', message, code: readCode(error) }
    }
    return { name: 'thrown', message: String(error) }
  } catch {
    return { name: 'thrown', message: 'unprintable error' }
  }
}

/**
 * 跑一批 item。
 *
 * @param items - 每个 item 会原样传给 runStage / onItemStart
 * @param stages - `[{ name, prompt }]`，按数组顺序串行
 * @param maxConcurrency - 同时在跑的 item 上限（正整数）
 * @param runStage - `({ item, stage, stageIndex, itemIndex }) => Promise<any>`
 * @param onItemStart - `(item, itemIndex) => Promise<any>`，用于写登记行；它的返回值会成为
 *   该 item 的 `handle`。它抛错只让这一项失败。
 */
export async function runBatch({ items, stages, maxConcurrency = DEFAULT_MAX_CONCURRENCY, runStage, onItemStart } = {}) {
  const list = readArray(items, 'items')
  const stageList = readArray(stages, 'stages')
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new TypeError('runBatch: maxConcurrency must be a positive integer')
  }
  if (typeof runStage !== 'function') throw new TypeError('runBatch: runStage must be a function')
  if (stageList.length === 0) throw new TypeError('runBatch: at least one stage is required')

  const results = new Array(list.length)
  let cursor = 0
  let inFlight = 0
  let peak = 0

  const runOne = async (item, itemIndex) => {
    let handle
    if (typeof onItemStart === 'function') {
      try {
        handle = await onItemStart(item, itemIndex)
      } catch (error) {
        results[itemIndex] = {
          item,
          itemIndex,
          handle: undefined,
          ok: false,
          stages: [],
          failure: { stageIndex: -1, stage: 'start', error: messageOf(error), cause: describeCause(error) },
        }
        return
      }
    }

    const stagesRun = []
    let failure
    for (let stageIndex = 0; stageIndex < stageList.length; stageIndex += 1) {
      const stage = stageList[stageIndex]
      const name = stage?.name ?? String(stageIndex)
      try {
        const output = await runStage({ item, stage, stageIndex, itemIndex })
        stagesRun.push({ stageIndex, name, ok: true, output })
      } catch (error) {
        const cause = describeCause(error)
        failure = { stageIndex, stage: name, error: messageOf(error), cause }
        stagesRun.push({ stageIndex, name, ok: false, error: failure.error, cause })
        break // 阶段失败即止：后面的阶段不启动。
      }
    }
    results[itemIndex] = { item, itemIndex, handle, ok: failure === undefined, stages: stagesRun, failure }
  }

  const worker = async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= list.length) return
      inFlight += 1
      peak = Math.max(peak, inFlight)
      try {
        await runOne(list[index], index)
      } finally {
        inFlight -= 1
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(maxConcurrency, list.length) }, () => worker()))

  const failures = results.filter((row) => row !== undefined && row.ok === false)
  return { results, failures, ok: failures.length === 0, peakConcurrency: peak }
}
