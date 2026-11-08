/**
 * 右栏面板的 remote 端点（engineer-assistants 1.0.0 票 12 第 4 步）。
 *
 * 一句话：把 `assignments → buildPanelModel → panelActionsOf` 串成一次调用，按宿主 Gateway 的
 * SRC 反射能认的形状交出去。客户端只发一次请求，拿到的就是「有哪些行」加「点每一行做什么」。
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
 * 现状（还没接线，如实写在这里）：登记表目前没有任何写入方——新派发链（票 05/06）与旧机制
 * 的切换是票 15 的活。所以在票 15 之前，接上这个端点只会得到一个空面板：三个常驻入口、
 * 零个 worker。这是真话，不是 bug。
 *
 * @module
 */

import { buildPanelModel } from './panel-model.js'
import { panelActionsOf } from './panel-surface.js'

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
 * `addressOf` 由调用方注入（宿主是 `ctx.sessions.subagentAddress`，**必须绑成
 * `(id) => ctx.sessions.subagentAddress(id)`**——直接递方法引用会丢 this，宿主那边每次被吞，
 * 所有 worker 静默走主栏）。解析器抛错时 `panelActionsOf` 自己会退回「不知道」。
 */
export function panelPayloadOf({ assignments, parentId = '', masterSessionId = '', addressOf } = {}) {
  const model = buildPanelModel({ assignments, parentId, masterSessionId })
  return { model, actions: panelActionsOf({ model, addressOf }) }
}

/**
 * `orchestratorPanel/panelState` 背后的只读 Host Service。
 *
 * 构造参数全是依赖，没有一个是需要宿主在构造时就必须给齐的：`assignments` 给值是登记表本身、
 * 给函数则按调用读；两个 id 同理。这样面板开关与 master 指定都能即改即见，不需要重载。
 */
export class PanelRemote {
  /**
   * @param options.assignments - 登记表，或返回它的函数（票 02 的形状）。
   * @param options.parentId - 面板作用域（master 会话 id），或返回它的函数。
   * @param options.masterSessionId - **生效的** master 会话 id，或返回它的函数。
   * @param options.addressOf - 子代理地址解析器，通常 `(id) => ctx.sessions.subagentAddress(id)`。
   */
  constructor({ assignments, parentId, masterSessionId, addressOf } = {}) {
    this.readAssignments = () => readDependency(assignments, {})
    this.readParentId = () => readDependency(parentId, '')
    this.readMasterSessionId = () => readDependency(masterSessionId, '')
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
   * @returns `{ model, actions }`，形状见 `panelPayloadOf`。
   */
  async panelState() {
    return panelPayloadOf({
      assignments: this.readAssignments(),
      parentId: this.readParentId(),
      masterSessionId: this.readMasterSessionId(),
      addressOf: this.addressOf,
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
