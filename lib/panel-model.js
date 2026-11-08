/**
 * 面板数据面（engineer-assistants 1.0.0 票 11）。
 *
 * 一句话：右栏是两段式——上段固定 Master、Inspector 与 Reporter 三个常驻助手，下段是
 * worker 列表（按 startedAt 升序），点开一个 worker 占一个页签。
 *
 * 四条规矩：
 *
 * - **上段永远是那三个。** 三个常驻助手不随 worker 增减而变。固定入口只是槽位；
 *   master 指向哪个会话由 `model.master` 单独暴露（`null` = 未指定），不挂在行上——
 *   否则「master 行的 sessionId 是 null」会和「inspector 行本来就不是会话」混成同一个 null。
 * - **下段只列还活着的。** 只有 running 与 reserved 上列表；结束的从列表消失，页签一并关掉。
 * - **顺序是 startedAt 升序。** 先派的在上面；同一时刻按 id 稳定排序，避免列表来回跳。
 * - **页签是「打开过」的事实。** 关掉页签不等于 worker 结束；worker 结束则页签必然关掉。
 *
 * 本模块不碰宿主：会话列表、归档都不调——宿主本来就不列 `origin === 'subagent'` 的会话。
 *
 * @module
 */

/** 上段固定入口。 */
export const FIXED_SECTIONS = Object.freeze(['master', 'inspector', 'reporter'])

/** 还活着的状态。 */
const LIVE = Object.freeze(['running', 'reserved'])

function readText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 一行列表项：只带面板要显示的字段。 */
function toRow(row) {
  return {
    sessionId: row.sessionId,
    presetId: readText(row.presetId),
    category: readText(row.category),
    status: row.status,
    startedAt: Number.isFinite(row.startedAt) ? row.startedAt : 0,
    // 重试次数要跟着行走：否则「第二次机会」的 worker 在面板上和第一次长得一样。
    retries: Number.isInteger(row.retries) && row.retries > 0 ? row.retries : 0,
  }
}

/**
 * 由登记表建一次面板模型。`openTabs` 是已经打开的页签（按打开顺序）；`activeTab` 是当前
 * 显示的那个，没打开的 worker 不在模型里。
 *
 * `masterSessionId` 要传**生效的** id，不是只传配置值：插件可以在没有任何指定的时候
 * 仍然有一个活着的常驻 master（`masterSessionEnabled` 打开时 `attachMasterSession` 直接用
 * `MASTER_SESSION_ID`，并不回写设置里的指定项）。调用方要自己合成：
 * `secretaryMasterSessionId || (masterSessionEnabled ? MASTER_SESSION_ID : '')`——否则面板会把
 * 一个活着、可打开的 master 显示成「未指定」。
 */
export function buildPanelModel({ assignments, parentId, openTabs = [], masterSessionId = '' } = {}) {
  if (assignments === null || typeof assignments !== 'object') {
    throw new TypeError('buildPanelModel: assignments must be an object')
  }
  const scope = readText(parentId)
  const rows = Object.values(assignments)
    .filter((row) => row !== null && typeof row === 'object')
    .filter((row) => scope === '' || row.parentId === scope)
    // 下段是 worker 列表：同一个 parent 底下的 inspector / reporter 行不是 worker，不该混进来。
    .filter((row) => row.kind === 'worker')
    .filter((row) => LIVE.includes(row.status))
    .map(toRow)
    .sort((a, b) => a.startedAt - b.startedAt || a.sessionId.localeCompare(b.sessionId))

  const byId = new Map(rows.map((row) => [row.sessionId, row]))
  const tabs = []
  for (const raw of Array.isArray(openTabs) ? openTabs : []) {
    const id = readText(typeof raw === 'string' ? raw : raw?.sessionId)
    const row = byId.get(id)
    // 只保留仍在列表里的 worker 的页签：worker 结束，页签就该关。
    if (row !== undefined && !tabs.some((tab) => tab.sessionId === id)) {
      tabs.push({ sessionId: id, title: row.presetId || row.sessionId })
    }
  }

  // 三个固定入口只是**槽位**，不带 session：把 master 的 id 挂在行上会让「master 行的
  // sessionId 是 null」和「inspector 行本来就不是会话」混成同一个 null，通用渲染器会把
  // master 槽画成死的。所以事实只在一处暴露：model.master。
  const fixed = FIXED_SECTIONS.map((id) => ({ id, title: id }))
  const master = readText(masterSessionId)
  const masterFacts = { sessionId: master === '' ? null : master }
  const activeTab = tabs.length === 0 ? null : tabs[tabs.length - 1].sessionId
  return { fixed, master: masterFacts, workers: rows, tabs, activeTab }
}

/** 打开一个页签；worker 不在列表里就返回同一个模型（不能给消失的 worker 开页签）。 */
export function openTab(model, sessionId) {
  const id = readText(sessionId)
  if (id === '') throw new TypeError('openTab: a session id is required')
  if (!model.workers.some((row) => row.sessionId === id)) return model
  if (model.tabs.some((tab) => tab.sessionId === id)) return { ...model, activeTab: id }
  const row = model.workers.find((item) => item.sessionId === id)
  return {
    ...model,
    tabs: [...model.tabs, { sessionId: id, title: row.presetId || id }],
    activeTab: id,
  }
}

/** 关掉一个页签：worker 还在列表里，只是不显示了。 */
export function closeTab(model, sessionId) {
  const id = readText(sessionId)
  if (id === '') throw new TypeError('closeTab: a session id is required')
  const tabs = model.tabs.filter((tab) => tab.sessionId !== id)
  if (tabs.length === model.tabs.length) return model
  const activeTab = model.activeTab === id ? (tabs.length === 0 ? null : tabs[tabs.length - 1].sessionId) : model.activeTab
  return { ...model, tabs, activeTab }
}

/**
 * worker 结束：从列表移除，并关掉它的页签。与 `subagent/end` 对应——
 * 它同时是「列表移除」的唯一触发点。
 */
export function endWorker(model, sessionId) {
  const id = readText(sessionId)
  if (id === '') throw new TypeError('endWorker: a session id is required')
  const workers = model.workers.filter((row) => row.sessionId !== id)
  if (workers.length === model.workers.length) return model
  return closeTab({ ...model, workers }, id)
}
