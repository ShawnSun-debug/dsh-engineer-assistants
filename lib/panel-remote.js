/**
 * 右栏面板的 remote 端点（engineer-assistants 1.0.0 票 12 第 4 步）。
 *
 * 一句话：把 `assignments → buildPanelModel → panelActionsOf` 串成一次调用，按宿主 Gateway 的
 * SRC 反射能认的形状交出去。客户端只发一次请求，拿到的就是「有哪些行」「点每一行做什么」，
 * 外加最近一份汇报（票 21）——报告不新开端点，也不另发一次读。
 *
 * 三条规矩：
 *
 * - **每次都从上游重算。** 依赖（登记表、master 指向、地址解析器）都按调用读，不在构造时
 *   快照。面板是「现在有什么」，不是「启动时有什么」。
 * - **不编造上游没有的东西。** 登记表不是对象就让它抛（那是接线错误），不返回一个空面板假装
 *   世界很好——空的登记表本身已经能如实表达「还没有 worker」。
 * - **端点只有一条无参方法。** Gateway 的 SRC 反射会去读方法源码里的参数名，所以
 *   `panelState` 必须保持零参数的普通类方法（与 `MasterRemote.masterState` 同一条约束）。
 *   要筛哪一轮、哪一个 parent，由插件按配置自己决定，不从请求里取。
 *
 * 现状（如实写在这里）：`lib/index.js` 已经 provide 它，登记表是插件自己持有的那张表——
 * 今天还没有写入方，新派发连接上是票 15 的活。所以它现在如实答「三个常驻入口、零个 worker」。
 * 这是真话，不是占位数据：客户端那一页确实还一个 worker 都没派过。
 *
 * @module
 */

import { buildPanelModel } from './panel-model.js'
import { panelActionsOf } from './panel-surface.js'
import { ITEM_LABELS, REQUIRED_ITEMS } from './reporter.js'

/** Cordis service key 与 Remote 命名空间。 */
export const PANEL_SERVICE_KEY = 'orchestratorPanel'

/** 客户端唯一会调的方法。 */
export const PANEL_METHOD = 'panelState'

/** 规范端点：<namespace>/<method>。 */
export const PANEL_ENDPOINT = PANEL_SERVICE_KEY + '/' + PANEL_METHOD

/** Typert 协议的方法标记键（与 `MasterRemote` 用的是同一个）。 */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** 一个依赖可能是值，也可能是个读函数；按调用取值。 */
function readDependency(value, fallback) {
  if (typeof value === 'function') return value()
  return value === undefined ? fallback : value
}

/**
 * 一次面板快照：模型加点击动作表。
 *
 * 两者一起交出去，是因为客户端必须用**同一份**模型算出来的动作来画：分两次取，中间插进一次
 * worker 结束，动作表里就会有一行模型里没有的 id，点下去开的是死会话。
 *
 * 这条保证是**结构性**的，不是测试守着的：这里是直线代码，两个调用之间没有 `await`，
 * 而 `buildPanelModel` 与 `panelActionsOf` 交出来的都是当场摊出来的新对象（行是拷贝，不是
 * 登记表里的引用），所以序列化时读到的一定是同一瞬间的两半。没有 await 就没有插入点。
 *
 * `addressOf` 由调用方注入（宿主是 `ctx.sessions.subagentAddress`，**必须绑成
 * `(id) => ctx.sessions.subagentAddress(id)`**——直接递方法引用会丢 this，宿主那边每次被吞，
 * 所有 worker 静默走主栏）。解析器抛错时 `panelActionsOf` 自己会退回「不知道」。
 *
 * **本端点今天不注入它**：`lib/index.js` 只给登记表与两个 id。所以 `actions` 里 `open-worker`
 * 的 `address` 字段恒缺——客户端点击时自己用 `ctx.sessions` 现解析，那个字段从来不被读。
 * 哪天要让载荷自带地址，在这里接上解析器即可，客户端那边不用改。
 */
export function panelPayloadOf({
  assignments,
  parentId = '',
  masterSessionId = '',
  addressOf,
  ended,
  attention,
  pending,
  report,
} = {}) {
  const model = buildPanelModel({ assignments, parentId, masterSessionId })
  return {
    model,
    actions: panelActionsOf({ model, addressOf }),
    ended: endedIdsOf(ended),
    attention: attentionOf(attention),
    pending: pendingOf(pending),
    report: reportOf(report),
  }
}

/**
 * 正在等批准的动作（票 20）。这是闸门此刻挂起的那几张卡，端点一次交出去，界面不必再问一次。
 *
 * 只保留画得出来的字段：谁、什么工具、哪几类、命令原文、什么时候问的。命令按上限截断——
 * 一条卡面放不下的长命令不该把整页撑坏；截断了也不假装完整（客户端只显示它）。
 *
 * 坏输入一律当「没有待批准项」：这个字段可选，缺了不该让整页面板报错。
 */
export const PANEL_PENDING_LIMIT = 50
const PANEL_PENDING_COMMAND_LIMIT = 500
function pendingOf(value) {
  const list = typeof value === 'function' ? value() : value
  if (!Array.isArray(list)) return []
  const kept = []
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (id === '') continue
    const categories = (Array.isArray(raw.categories) ? raw.categories : [])
      .map((category) => (typeof category === 'string' ? category.trim() : ''))
      .filter((category) => category !== '')
    const command = typeof raw.command === 'string' ? raw.command : ''
    kept.push({
      id,
      workerId: typeof raw.workerId === 'string' ? raw.workerId.trim() : '',
      toolName: typeof raw.toolName === 'string' ? raw.toolName.trim() : '',
      categories: [...new Set(categories)],
      command: command.length > PANEL_PENDING_COMMAND_LIMIT ? command.slice(0, PANEL_PENDING_COMMAND_LIMIT) : command,
      at: Number.isFinite(raw.at) ? raw.at : 0,
    })
    if (kept.length >= PANEL_PENDING_LIMIT) break
  }
  return kept
}

/** 一份报告的文本上限：报告本身只有五行，这个上限只用来挡住坏输入撑坏页面。 */
export const PANEL_REPORT_TEXT_LIMIT = 4000

/** 一个读函数可能抛错；端点的可选字段不该把它变成一次整页失败。 */
function safeRead(read) {
  try {
    return read()
  } catch {
    return undefined
  }
}

/** 五项按固定顺序补齐：客户端直接画，不必自己维护第二张键表，也不会见到空行。 */
function reportItemsOf(value) {
  const list = Array.isArray(value) ? value : []
  const byKey = new Map()
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const key = typeof raw.key === 'string' ? raw.key.trim() : ''
    if (!REQUIRED_ITEMS.includes(key) || byKey.has(key)) continue
    byKey.set(key, typeof raw.text === 'string' ? raw.text.replace(/\s+/g, ' ').trim() : '')
  }
  return REQUIRED_ITEMS.map((key) => {
    const detail = byKey.get(key) ?? ''
    return { key, label: ITEM_LABELS[key], text: detail === '' ? '未提供' : detail }
  })
}

/**
 * 最近一份汇报（票 21）：第几次、什么时候、全文、五项齐全。
 *
 * 坏输入读成 null 而不是抛：它跟着整页面板一起下发，一份坏报告不该让整页变白。
 * 这里的补全只面对坏输入；正常路径由 lib/reporter.js 交来五项都写好的对象。
 */
function reportOf(value) {
  const source = typeof value === 'function' ? safeRead(value) : value
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return null
  const text = typeof source.text === 'string' ? source.text : ''
  if (text.trim() === '') return null
  return {
    seq: Number.isInteger(source.seq) && source.seq > 0 ? source.seq : 0,
    at: Number.isFinite(source.at) && source.at >= 0 ? source.at : 0,
    stamp: typeof source.stamp === 'string' ? source.stamp.trim() : '',
    text: text.length > PANEL_REPORT_TEXT_LIMIT ? text.slice(0, PANEL_REPORT_TEXT_LIMIT) : text,
    oneLine: source.oneLine === true,
    items: reportItemsOf(source.items),
  }
}

/**
 * 红点输入：`{ [sessionId]: [reason...] }`。只有非空 id 与非空理由进得来，别的键一律丢掉——
 * 客户端要拿它直接数点，一条 `undefined` 就会让整行亮起来。
 *
 * 理由的词表不在这里校验：那是 `panel-surface.js` 的 `badgeOf` 与监工的
 * `STUCK_REASONS` 的事，两处各校验一遍只会分叉。
 */
function attentionOf(value) {
  const source = typeof value === 'function' ? value() : value
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return {}
  const kept = {}
  for (const [rawId, list] of Object.entries(source)) {
    const id = typeof rawId === 'string' ? rawId.trim() : ''
    if (id === '') continue
    const reasons = (Array.isArray(list) ? list : [])
      .map((reason) => (typeof reason === 'string' ? reason.trim() : ''))
      .filter((reason) => reason !== '')
    if (reasons.length > 0) kept[id] = [...new Set(reasons)]
  }
  return kept
}

/**
 * 最近结束的子会话 id，规范化后就交给客户端。
 *
 * 这是整个右栏唯一一条「某个 worker 已经结束」的权威事实。浏览器自己判不出来：`byId` 会被
 * 开着的页签 retain 住（宿主 `projectList` 把还活着且有地址的 scope 重新塞回去），父会话的
 * `subagentCatalog` 是只追加的「发现过」记录，两者都不随结束变化。所以由服务端记、客户端照做。
 *
 * 空串、非字符串、重复一律去掉；只保留最后 `PANEL_ENDED_LIMIT` 条（旧的先丢）——环形表的意义
 * 是「最近结束的」，不是完整历史：漏掉一条的代价是留一个死页签，不是误关。
 */
export const PANEL_ENDED_LIMIT = 200
function endedIdsOf(value) {
  const list = typeof value === 'function' ? value() : value
  if (!Array.isArray(list)) return []
  const kept = []
  const seen = new Set()
  for (const raw of list) {
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    kept.push(id)
  }
  return kept.slice(-PANEL_ENDED_LIMIT)
}

/**
 * `orchestratorPanel/panelState` 背后的只读 Host Service。
 *
 * 构造参数全是依赖：给值是快照、给函数则按调用读，所以 master 指定与登记表都能即改即见，
 * 不需要重载。
 *
 * 唯一**必须**给的是 `assignments`。它没有兜底值：漏传时 `buildPanelModel` 直接抛
 * `assignments must be an object`。这里不把「没接线」装扮成「还没有 worker」——两者在客户端
 * 眼里长得一模一样，而前者是 bug、后者是正常状态，混起来就再没人查得出来。
 */
export class PanelRemote {
  /**
   * @param options.assignments - 登记表，或返回它的函数（票 02 的形状）。
   * @param options.parentId - 面板作用域（master 会话 id），或返回它的函数。
   * @param options.masterSessionId - **生效的** master 会话 id，或返回它的函数。
   * @param options.addressOf - 子代理地址解析器，通常 `(id) => ctx.sessions.subagentAddress(id)`。
   * @param options.ended - 最近结束的子会话 id 列表，或返回它的函数。
   * @param options.attention - 红点输入 `{ sessionId: [reason...] }`，或返回它的函数。
   * @param options.pending - 正在等批准的动作，或返回它的函数（票 20）。
   * @param options.report - 最近一份汇报，或返回它的函数（票 21）。
   */
  constructor({ assignments, parentId, masterSessionId, addressOf, ended, attention, pending, report } = {}) {
    // 登记表没有兜底值：缺了就是接线错误，让它抛（见 `panelState` 的说明）。
    this.readAssignments = () => readDependency(assignments)
    this.readParentId = () => readDependency(parentId, '')
    this.readMasterSessionId = () => readDependency(masterSessionId, '')
    this.readEnded = typeof ended === 'function' ? ended : () => ended
    this.readAttention = typeof attention === 'function' ? attention : () => attention
    this.readPending = typeof pending === 'function' ? pending : () => pending
    this.readReport = typeof report === 'function' ? report : () => report
    this.addressOf = typeof addressOf === 'function' ? addressOf : undefined
    // Gateway 从这个绑定读命名空间；service 是按身份比对注册对象用的。
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: PANEL_SERVICE_KEY,
      namespace: PANEL_SERVICE_KEY,
    })
  }

  /**
   * 面板快照。无参数：SRC 反射读的是源码里的参数表。
   *
   * @returns `{ model, actions, ended, attention, pending, report }`，形状见 `panelPayloadOf`。
   */
  async panelState() {
    return panelPayloadOf({
      assignments: this.readAssignments(),
      parentId: this.readParentId(),
      masterSessionId: this.readMasterSessionId(),
      addressOf: this.addressOf,
      ended: this.readEnded(),
      attention: this.readAttention(),
      pending: this.readPending(),
      // 包一层：report 的读函数抛错时由 reportOf 收成 null，不带走整页面板。
      report: () => this.readReport(),
    })
  }
}

// SRC 方法标记：一条直接调用的无参方法。Gateway 的 methodParameterNames 会解析方法源码，
// 所以 panelState 必须保持零参数的普通类方法。
Object.defineProperty(PanelRemote.prototype, REMOTE_METHOD_DESCRIPTOR, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([Object.freeze({ method: PANEL_METHOD, invocation: Object.freeze({ kind: 'direct' }) })]),
  }),
})
