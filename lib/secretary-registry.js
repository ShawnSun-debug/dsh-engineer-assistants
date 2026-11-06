/**
 * 秘书登记表（秘书 spec 票 01）。
 *
 * 两个字段：`masterSessionId` 是 Master/秘书会话，`orchestrators` 是允许被读取的
 * 编排会话。它们存在插件的 Config 里，所以写一次设置就生效、重启后还能读回；这里
 * 只放规则，不碰宿主、不读时钟、不写文件——设置页、只读端点与测试共用同一套规则。
 *
 * 三条规则：
 *
 * - **归一化永不抛错。** `normalizeRegistry` 把存档里的一切脏数据（缺字段、重复行、
 *   非数组、会抛的 getter）降级成可用的登记表，而不是让设置页或会话加载失败。
 * - **互斥。** 一个会话要么是 Master、要么是 orchestrator。`setMaster` 把已登记的会话
 *   挪进 Master 槽（后来者胜）；`addOrchestrator` 拒绝 Master 会话（要降成
 *   orchestrator 得先 `clearMaster`，否则等于悄悄关掉汇报）；归一化遇到冲突时留下
 *   Master、丢掉那一行。
 * - **不可变。** 每个函数都返回新数据，入参一个字段都不改，所以面板可以先比较
 *   "是不是同一个对象"再决定要不要重绘。
 *
 * 登记表的读取方只需要 `isTracked` / `isMaster`；未登记的会话一律读不到。
 *
 * @module
 */

/** 一个会话 id：非空、去掉首尾空白的字符串。其它一律视为"没有 id"。 */
function readId(value) {
  if (typeof value !== 'string') return undefined
  const id = value.trim()
  return id === '' ? undefined : id
}

/** 一个字符串字段：不是字符串就是空串，从不抛错。 */
function readText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 一个时间戳：有限、非负的数字，否则 0（调用方没给时间也照样能记一行）。 */
function readTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * 读一个属性，getter 抛错就当它不存在。存档可能来自任何一次手改或旧版本，
 * 一个会抛的字段不能让整张表不可读。
 */
function readProp(source, key) {
  try {
    if (source === null || source === undefined || typeof source !== 'object') return undefined
    return source[key]
  } catch {
    return undefined
  }
}

/** 账本里的一行：字段齐全，多出来的字段一律丢掉。 */
function readEntry(raw) {
  const sessionId = readId(readProp(raw, 'sessionId'))
  if (sessionId === undefined) return undefined
  return {
    sessionId,
    workspace: readText(readProp(raw, 'workspace')),
    title: readText(readProp(raw, 'title')),
    trackedAt: readTimestamp(readProp(raw, 'trackedAt')),
  }
}

/** 一个写操作的入参 id：这里给错了是程序错误，所以直接抛，而不是悄悄不办事。 */
function requireId(fn, value) {
  const id = readId(value)
  if (id === undefined) throw new TypeError(`${fn}: a session id must be a non-empty string`)
  return id
}

/**
 * 把存储面读成一张可用的登记表；任何输入都有答案。
 *
 * 规则：只有对象里的非空字符串 id 算一行；字符串字段去空白、数字字段补 0；重复 id
 * 保留第一行；与 Master 相同的 id 丢掉（Master 胜出，见模块注释）。
 */
export function normalizeRegistry(raw) {
  const masterSessionId = readId(readProp(raw, 'masterSessionId')) ?? ''
  const rows = []
  const seen = new Set()
  const list = readProp(raw, 'orchestrators')
  if (Array.isArray(list)) {
    for (const item of list) {
      const entry = readEntry(item)
      if (entry === undefined) continue
      if (seen.has(entry.sessionId)) continue
      if (entry.sessionId === masterSessionId) continue
      seen.add(entry.sessionId)
      rows.push(entry)
    }
  }
  return { masterSessionId, orchestrators: rows }
}

/** 该会话是否被登记为 orchestrator。Master 永远不是 orchestrator。 */
export function isTracked(registry, sessionId) {
  const id = readId(sessionId)
  if (id === undefined) return false
  return normalizeRegistry(registry).orchestrators.some((row) => row.sessionId === id)
}

/** 该会话是否是 Master/秘书。 */
export function isMaster(registry, sessionId) {
  const id = readId(sessionId)
  if (id === undefined) return false
  return normalizeRegistry(registry).masterSessionId === id
}

/**
 * 指定 Master/秘书。已登记的会话会从 orchestrators 里移出，所以一步之内就满足互斥；
 * 传入当前 Master 本身返回同一个登记表，面板重绘不必重建。
 */
export function setMaster(registry, sessionId) {
  const id = requireId('setMaster', sessionId)
  const current = normalizeRegistry(registry)
  if (current.masterSessionId === id && !current.orchestrators.some((row) => row.sessionId === id)) {
    return registry
  }
  return {
    masterSessionId: id,
    orchestrators: current.orchestrators.filter((row) => row.sessionId !== id),
  }
}

/** 取消 Master 指定；没有指定时返回同一个登记表。orchestrators 原样保留。 */
export function clearMaster(registry) {
  const current = normalizeRegistry(registry)
  if (current.masterSessionId === '') return registry
  return { masterSessionId: '', orchestrators: current.orchestrators }
}

/**
 * 登记一个 orchestrator。已登记则返回同一个登记表（幂等）；目标若是 Master 则拒绝，
 * 因为"降成 orchestrator"必须由调用方显式先 clearMaster，不能顺手把秘书关掉。
 * `trackedAt` 由调用方给（本模块不读时钟）。
 */
export function addOrchestrator(registry, entry) {
  if (entry === null || typeof entry !== 'object') {
    throw new TypeError('addOrchestrator: an orchestrator entry must be an object')
  }
  const sessionId = requireId('addOrchestrator', readProp(entry, 'sessionId'))
  const current = normalizeRegistry(registry)
  if (current.masterSessionId === sessionId) {
    throw new Error(`addOrchestrator: ${sessionId} is the Master session; clear the Master designation first`)
  }
  if (current.orchestrators.some((row) => row.sessionId === sessionId)) return registry
  const row = {
    sessionId,
    workspace: readText(readProp(entry, 'workspace')),
    title: readText(readProp(entry, 'title')),
    trackedAt: readTimestamp(readProp(entry, 'trackedAt')),
  }
  return { masterSessionId: current.masterSessionId, orchestrators: [...current.orchestrators, row] }
}

/** 取消一个登记；该 id 本来就不在时返回同一个登记表。Master 指定不受影响。 */
export function removeOrchestrator(registry, sessionId) {
  const id = requireId('removeOrchestrator', sessionId)
  const current = normalizeRegistry(registry)
  if (!current.orchestrators.some((row) => row.sessionId === id)) return registry
  return {
    masterSessionId: current.masterSessionId,
    orchestrators: current.orchestrators.filter((row) => row.sessionId !== id),
  }
}
