/**
 * 派发登记表（engineer-assistants 1.0.0 票 02）。
 *
 * 一句话：`sessionId → {kind, parentId, presetId, category, cwd, startedAt, status}`。
 * 宿主的 header 与 descriptor 不接受自定义字段（ADR 0014），所以「这个会话是谁派出来的、
 * 用什么预设、跑到哪一步」只能记在这里；它是冷恢复时唯一能重放的事实来源。
 *
 * 五条规矩：
 *
 * - **归一化不抛错。** 存档可能来自旧版本、手工编辑或有会抛 getter 的对象，坏行丢掉即可，
 *   不能让主对话因为一张登记表而加载失败。所有字段只经 `readProp` 读，绝不整行展开。
 * - **预占幂等，但不越过终态。** 同一 parent 对同一 id 重复预占返回同一张表；已经被别的
 *   parent 占用、已经结束、或 kind 对不上，一律抛错——否则调用方会 spawn 一个永远写不进
 *   登记表的会话。
 * - **写入是合并，不是替换。** 预占之后就只补差额：`assignSession` 没给的字段保留原值，
 *   所以不会悄悄把 `parentId` 抹成空串、把 `startedAt` 归零。
 * - **只有 finish 能写终态。** `assign` 拒绝终态与「running 退回 reserved」，避免两个写者
 *   争同一个字段。
 * - **只有这里认 kind。** `master`/`worker`/`inspector`/`reporter` 之外的字符串一律拒绝。
 *
 * 本模块不碰宿主、不读时钟、不写文件。
 *
 * @module
 */

/** 一个会话只有一种类型（spec 第 3 节）。 */
export const KINDS = Object.freeze(['master', 'worker', 'inspector', 'reporter'])

/** 派发时选的类别，决定监工盯什么（spec 第 4 节）。 */
export const CATEGORIES = Object.freeze(['code', 'maybe-code', 'non-code'])

/** `reserved` 与 `running` 是活的；其余都是终态。 */
export const STATUSES = Object.freeze(['reserved', 'running', 'done', 'failed', 'cancelled'])

const TERMINAL = new Set(['done', 'failed', 'cancelled'])

/** 非空字符串才是一个 id。 */
function readId(value) {
  if (typeof value !== 'string') return undefined
  const id = value.trim()
  return id === '' ? undefined : id
}

function readText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function readTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/** 重试次数：非负整数，其它一律当 0（旧存档没有这个字段）。 */
function readRetries(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0
}

/** 读属性，getter 抛错就当它不存在。所有字段读取都必须走这里。 */
function readProp(source, key) {
  try {
    if (source === null || source === undefined || typeof source !== 'object') return undefined
    return source[key]
  } catch {
    return undefined
  }
}

function requireId(fn, value) {
  const id = readId(value)
  if (id === undefined) throw new TypeError(`${fn}: a session id must be a non-empty string`)
  return id
}

function requireKind(fn, value) {
  if (!KINDS.includes(value)) {
    throw new TypeError(`${fn}: kind must be one of ${KINDS.join(', ')} (got ${String(value)})`)
  }
  return value
}

function requireCategory(fn, value) {
  if (value === undefined || value === '') return ''
  if (!CATEGORIES.includes(value)) {
    throw new TypeError(`${fn}: category must be one of ${CATEGORIES.join(', ')} (got ${String(value)})`)
  }
  return value
}

function requireStatus(fn, value) {
  if (!STATUSES.includes(value)) {
    throw new TypeError(`${fn}: status must be one of ${STATUSES.join(', ')} (got ${String(value)})`)
  }
  return value
}

/** 该状态是否终态。 */
export function isTerminal(status) {
  return TERMINAL.has(status)
}

/** 一组行读成一行；字段全部经 readProp，整行展开会把会抛的 getter 带进来。 */
function readRow(raw, fallbackId) {
  const sessionId = readId(readProp(raw, 'sessionId')) ?? readId(fallbackId)
  const kind = readProp(raw, 'kind')
  if (sessionId === undefined || !KINDS.includes(kind)) return undefined
  const status = readProp(raw, 'status')
  return {
    sessionId,
    kind,
    parentId: readText(readProp(raw, 'parentId')),
    presetId: readText(readProp(raw, 'presetId')),
    category: CATEGORIES.includes(readProp(raw, 'category')) ? readProp(raw, 'category') : '',
    cwd: readText(readProp(raw, 'cwd')),
    startedAt: readTimestamp(readProp(raw, 'startedAt')),
    status: STATUSES.includes(status) ? status : 'reserved',
    // 重试次数落在登记行上（票 14）：面板与汇报要看得出这个 worker 已经失败过一轮。
    retries: readRetries(readProp(raw, 'retries')),
  }
}

/** 写一行，且必须写成自有属性：`table['__proto__'] = x` 会换掉整张表的原型。 */
function putRow(table, row) {
  Object.defineProperty(table, row.sessionId, {
    value: row,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

/**
 * 把存储面读成一张可用的登记表；任何输入都有答案。
 *
 * 接受两种形状：以 sessionId 为键的对象（本模块写出的形状），或以 `sessionId` 字段为主键的
 * 数组。同一 id 出现多次时保留第一次。
 */
export function normalizeAssignments(raw) {
  const table = {}
  const entries = Array.isArray(raw)
    ? raw.map((row) => [undefined, row])
    : raw !== null && typeof raw === 'object'
      ? Object.entries(raw)
      : []
  for (const [key, row] of entries) {
    const parsed = readRow(row, key)
    if (parsed === undefined || Object.hasOwn(table, parsed.sessionId)) continue
    putRow(table, parsed)
  }
  return table
}

/** 读一行；没有就是 undefined。 */
export function findAssignment(table, sessionId) {
  const id = readId(sessionId)
  if (id === undefined) return undefined
  const current = normalizeAssignments(table)
  return Object.hasOwn(current, id) ? current[id] : undefined
}

/** 某个 parent 派出的所有会话，按 startedAt 升序（同时刻按 id 稳定排序）。 */
export function childrenOf(table, parentId) {
  const id = readId(parentId)
  if (id === undefined) return []
  return Object.values(normalizeAssignments(table))
    .filter((row) => row.parentId === id)
    .sort((a, b) => a.startedAt - b.startedAt || a.sessionId.localeCompare(b.sessionId))
}

/**
 * 预占一个 id：先占位再 spawn，避免 spawn 与写行之间出现「宿主里有会话、登记表里没有」。
 *
 * 幂等：同一 parent、同一 kind、仍然活的同一 id 返回同一张表。
 * 拒绝：id 属于别的 parent、这一行已经结束、或 kind 对不上——这三种情况调用方都会 spawn 出
 * 一个永远写不进登记表的会话。
 */
export function reserveChildId(table, entry) {
  const current = normalizeAssignments(table)
  const sessionId = requireId('reserveChildId', readProp(entry, 'id') ?? readProp(entry, 'sessionId'))
  const parentId = requireId('reserveChildId', readProp(entry, 'parentId'))
  const kind = requireKind('reserveChildId', readProp(entry, 'kind') ?? 'worker')
  if (Object.hasOwn(current, sessionId)) {
    const existing = current[sessionId]
    if (existing.parentId !== parentId) {
      throw new Error(`reserveChildId: session "${sessionId}" is already reserved by parent "${existing.parentId}"`)
    }
    if (isTerminal(existing.status)) {
      throw new Error(`reserveChildId: session "${sessionId}" already finished as "${existing.status}"`)
    }
    if (existing.kind !== kind) {
      throw new Error(`reserveChildId: session "${sessionId}" is a ${existing.kind}, not a ${kind}`)
    }
    return current
  }
  const row = {
    sessionId,
    kind,
    parentId,
    presetId: readText(readProp(entry, 'presetId')),
    category: requireCategory('reserveChildId', readProp(entry, 'category')),
    cwd: readText(readProp(entry, 'cwd')),
    startedAt: readTimestamp(readProp(entry, 'startedAt') ?? readProp(entry, 'now')),
    status: 'reserved',
    retries: 0,
  }
  const next = { ...current }
  putRow(next, row)
  return next
}

/**
 * 合并式写入：没给的字段保留原值（预占之后就只补差额）。同 id 覆盖，不产生第二行。
 *
 * 终态只能由 `finishSession` 写：`assign` 传终态、或把 running 退回 reserved，都抛错。
 */
export function assignSession(table, entry) {
  const current = normalizeAssignments(table)
  const sessionId = requireId('assignSession', readProp(entry, 'sessionId'))
  const kind = requireKind('assignSession', readProp(entry, 'kind'))
  const status = requireStatus('assignSession', readProp(entry, 'status') ?? 'running')
  const previous = Object.hasOwn(current, sessionId) ? current[sessionId] : undefined
  if (previous !== undefined) {
    if (isTerminal(previous.status)) {
      throw new Error(`assignSession: session "${sessionId}" already finished as "${previous.status}"`)
    }
    if (isTerminal(status)) {
      throw new Error(`assignSession: terminal status "${status}" belongs to finishSession`)
    }
    if (previous.status === 'running' && status === 'reserved') {
      throw new Error(`assignSession: session "${sessionId}" cannot go back from running to reserved`)
    }
  }
  const category = readProp(entry, 'category')
  const row = {
    sessionId,
    kind,
    parentId: readProp(entry, 'parentId') === undefined ? (previous?.parentId ?? '') : readText(readProp(entry, 'parentId')),
    presetId: readProp(entry, 'presetId') === undefined ? (previous?.presetId ?? '') : readText(readProp(entry, 'presetId')),
    category: category === undefined ? (previous?.category ?? '') : requireCategory('assignSession', category),
    cwd: readProp(entry, 'cwd') === undefined ? (previous?.cwd ?? '') : readText(readProp(entry, 'cwd')),
    startedAt: readProp(entry, 'startedAt') === undefined ? (previous?.startedAt ?? 0) : readTimestamp(readProp(entry, 'startedAt')),
    status,
    // 没给就保留上一次的数：重试次数是累加的，不该被一次普通写入抹掉。
    retries: readProp(entry, 'retries') === undefined ? (previous?.retries ?? 0) : readRetries(readProp(entry, 'retries')),
  }
  const next = { ...current }
  putRow(next, row)
  return next
}

/**
 * 同一个 id 开新一代：终态行改回 running，startedAt 换成这一代的时刻。
 *
 * 宿主的 durable child id 跨 activation epoch 复用（runId 每次换，id 不换），所以「续跑」
 * 在账面上就是一个已结束的 id 又活过来。assignSession 拒绝写终态行是故意的——终态只能由
 * finishSession 写——所以重开必须是这条独立的、说得出口的路，而不是在 assign 里开洞。
 *
 * 没登记过的 id 不在这里补：那是「这个插件没派过它」，重开一个不存在的行只会造出假账。
 */
export function reopenSession(table, entry) {
  const current = normalizeAssignments(table)
  const sessionId = requireId('reopenSession', readProp(entry, 'sessionId') ?? readProp(entry, 'id'))
  if (!Object.hasOwn(current, sessionId)) return current
  const previous = current[sessionId]
  const startedAt = readProp(entry, 'startedAt')
  const next = { ...current }
  putRow(next, {
    ...previous,
    status: 'running',
    startedAt: startedAt === undefined ? previous.startedAt : readTimestamp(startedAt),
  })
  return next
}

/** 置终态。没登记过的会话无法结束（返回同一张表），终态幂等。 */
export function finishSession(table, entry) {
  const current = normalizeAssignments(table)
  const sessionId = requireId('finishSession', readProp(entry, 'sessionId'))
  const status = requireStatus('finishSession', readProp(entry, 'status') ?? 'done')
  if (!isTerminal(status)) {
    throw new TypeError(`finishSession: status must be terminal, got "${status}"`)
  }
  if (!Object.hasOwn(current, sessionId)) return current
  const previous = current[sessionId]
  if (isTerminal(previous.status)) return current
  const next = { ...current }
  putRow(next, { ...previous, status })
  return next
}
