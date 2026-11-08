/**
 * 面板表面（engineer-assistants 1.0.0 票 12）。
 *
 * 一句话：把面板模型与宿主事实翻成界面真要的那几样——红点数字、切进某个 worker 的导航目标、
 * 主对话里那张危险确认卡。
 *
 * 五条规矩：
 *
 * - **只算，不画。** 不 import React、不碰 ctx、不读时钟。输出是纯数据，宿主接入留在 client 侧。
 *   时间由调用方给（`now`），否则这里就没法测。
 * - **只出事实，不出口播。** 卡片不带中文文案——文案是 client 的多语言表的事。
 * - **红点的词表跟着监工走。** 卡点原因直接复用 `inspector.js` 的 `STUCK_REASONS`，不另定一套：
 *   自己造一套的结果是监工说 `waiting-approval`、这里认 `awaiting-approval`，红点永远不亮，
 *   而且不会报错。
 * - **确认卡的键只有一个来源。** 去重直接用 `danger.js` 的 `dangerKey`——另算一遍，
 *   「同一件事」就会跟闸门的判定分叉。
 * - **不给错的输入编一个看起来对的答案。** 时间不是有限数就抛，解析不出来就退，空确认就不出卡。
 *
 * @module
 */

import { dangerKey } from './danger.js'
import { STUCK_REASONS } from './inspector.js'
import { FIXED_SECTIONS } from './panel-model.js'

/**
 * 需要用户介入的原因——就是监工的三种卡点判据。
 *
 * 与 `STUCK_REASONS` 是同一份（spec 第 7 节：监工的提醒通道之一就是右栏页签红点），
 * 所以这里直接引用而不是抄一份。
 */
export const ATTENTION_REASONS = STUCK_REASONS

function readText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 面板模型的形状检查：没有 workers 数组就不是面板模型。 */
function requireModel(model, fn, { fixed = false } = {}) {
  if (model === null || typeof model !== 'object') throw new TypeError(`${fn}: a panel model is required`)
  if (!Array.isArray(model.workers)) throw new TypeError(`${fn}: a panel model is required (no workers array)`)
  // 只有需要固定入口的调用方才要求 fixed：红点只数 worker，不该因为模型里没写 fixed 就炸。
  if (fixed && !Array.isArray(model.fixed)) {
    throw new TypeError(`${fn}: a panel model is required (no fixed array)`)
  }
}

/**
 * 红点：列表里需要人介入的 worker 数。
 *
 * `attention` 形如 `{ [sessionId]: ['idle', 'retrying', 'waiting-approval'] }`，由巡检与
 * 申请派发两处各自填。未知原因忽略、重复原因去重、同一个 id 出现多行只算一次、不在列表里的
 * id 不算（它已经结束了，红点不该为它亮）。
 */
export function badgeOf({ model, attention = {} } = {}) {
  requireModel(model, 'badgeOf')
  if (attention === null || typeof attention !== 'object') {
    throw new TypeError('badgeOf: attention must be an object')
  }

  const reasons = new Map()
  for (const [rawId, list] of Object.entries(attention)) {
    const id = readText(rawId)
    if (id === '') continue
    const kept = (Array.isArray(list) ? list : []).filter((reason) => ATTENTION_REASONS.includes(reason))
    if (kept.length > 0) reasons.set(id, [...new Set(kept)])
  }

  const seen = new Set()
  const sessionIds = []
  for (const row of model.workers) {
    if (row === null || typeof row !== 'object') continue
    const id = readText(row.sessionId)
    if (id === '' || seen.has(id) || !reasons.has(id)) continue
    seen.add(id)
    sessionIds.push(id)
  }

  const byReason = {}
  for (const reason of ATTENTION_REASONS) {
    byReason[reason] = sessionIds.filter((id) => reasons.get(id).includes(reason)).length
  }
  return { count: sessionIds.length, sessionIds, byReason }
}

/**
 * 一个值是不是真能当 subagent 地址用。
 *
 * 按宿主 `SubagentAddress` 的**完整形状**判：`{ parentSessionId, childSessionId, mode }`，
 * 前两个是非空字符串、`mode` 是非空字符串（具体认哪几种由用它的地方各自判）。
 *
 * 两处用它的地方必须用同一把尺子——否则会出现「能导航但拼不出地址」或反过来。也不能按真值
 * 判：`{}` 和 `[]` 都是 truthy，靠真值会把它们当地址交出去。
 */
function usableAddress(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return readText(value.parentSessionId) !== '' && readText(value.childSessionId) !== '' && readText(value.mode) !== ''
}

/**
 * 「切进 worker 说话」的导航目标。
 *
 * 返回的是**信封** `{ kind, target }`：真正交给 `uiWorkspace.openSession` 的是 `target`，
 * 它的类型是宿主的 `SessionTarget = SessionId | SubagentAddress`——**裸会话 id 本身就是
 * 合法目标**。优先用 subagent 地址，是因为地址在会话重建后仍然指向同一条子代理，
 * 但宿主只解析「已经被发现」的地址，解析不到就退 id，不是 id 不能用。
 *
 * `addressOf` 由调用方注入（宿主是 `ctx.sessions.subagentAddress`）；它抛错时退回 id：
 * 一个坏掉的 sessions 域不该让 worker 点不动。
 */
export function navigationTargetOf({ sessionId, addressOf } = {}) {
  const id = readText(sessionId)
  if (id === '') throw new TypeError('navigationTargetOf: a session id is required')
  if (typeof addressOf !== 'function') return { kind: 'session', target: id }

  let address
  try {
    address = addressOf(id)
  } catch {
    return { kind: 'session', target: id }
  }
  if (!usableAddress(address)) return { kind: 'session', target: id }
  return { kind: 'subagent', target: address }
}

/** 一项待确认的东西到底是不是 plan。plan 至少得说得清命令或类别。 */
function planOf(entry) {
  if (entry === null || typeof entry !== 'object') return undefined
  const looksLikePlan = (value) =>
    value !== null && typeof value === 'object' && (typeof value.command === 'string' || Array.isArray(value.categories))
  if (looksLikePlan(entry)) return entry
  return looksLikePlan(entry.plan) ? entry.plan : undefined
}

/**
 * 主对话里的危险确认卡。
 *
 * `pending` 是闸门还没拿到答复的东西，每项 `{ plan, requestedAt }`（也接受裸 plan，此时按
 * `now` 起算）。同一件事只出一张卡，保留**最早**的那次请求——后来的重复请求不该把倒计时
 * 续上。`requestedAt` 给了就必须是有限数：编不出来就别编，否则「最早的那次」会算错。
 *
 * 过期边界是**含等号**：`now >= expiresAt` 即过期，此时 `remainingMs` 归零、不留负数。
 */
export function confirmationCardsOf({ pending, now, timeoutMs } = {}) {
  if (!Array.isArray(pending)) throw new TypeError('confirmationCardsOf: pending must be an array')
  if (!Number.isFinite(now)) throw new TypeError('confirmationCardsOf: now must be a finite number')
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('confirmationCardsOf: timeoutMs must be a positive integer')
  }

  const cards = new Map()
  for (const entry of pending) {
    const plan = planOf(entry)
    if (plan === undefined) continue

    const categories = Array.isArray(plan.categories) ? plan.categories.map(readText).filter((item) => item !== '') : []
    const command = readText(plan.command)
    const intent = readText(plan.intent)
    // 既没命令也没类别的东西不是一次确认，不出卡。
    if (command === '' && categories.length === 0) continue

    let requestedAt = now
    if (entry.requestedAt !== undefined) {
      if (!Number.isFinite(entry.requestedAt)) {
        throw new TypeError('confirmationCardsOf: requestedAt must be a finite number')
      }
      requestedAt = entry.requestedAt
    }

    const key = dangerKey({ categories, command, intent })
    const previous = cards.get(key)
    if (previous !== undefined && previous.requestedAt <= requestedAt) continue

    const expiresAt = requestedAt + timeoutMs
    cards.set(key, {
      key,
      categories: [...categories].sort(),
      command,
      intent,
      requestedAt,
      expiresAt,
      remainingMs: Math.max(0, expiresAt - now),
      expired: now >= expiresAt,
    })
  }

  return [...cards.values()].sort((a, b) => a.requestedAt - b.requestedAt || a.key.localeCompare(b.key))
}
/**
 * 宿主 SidebarChat 的资源前缀（`dsh-client-ui-subagent/lib/client.js:708`）。
 *
 * worker 的完整会话不需要我们自己画：宿主已经有一个能渲染完整会话（自带输入框）的页签类型，
 * 只认这一种地址。我们拼出地址交给 `ctx.sidebarRight.openResource`，页签与视图都由宿主负责。
 */
export const SUBAGENT_CHAT_ADDRESS = 'dsh-resource://subagentchat/session/'

/** 宿主认的三种 mode（`parseSubagentChatAddress`，同文件 :738）。 */
export const SUBAGENT_CHAT_MODES = Object.freeze(['one-shot', 'continuable', 'unknown'])

/**
 * 把一个 subagent 地址变成宿主 SidebarChat 的资源地址。
 *
 * 规则逐条对齐宿主的 `parseSubagentChatAddress`：协议 `dsh-resource:`、hostname
 * `subagentchat`、路径恰好 `session/<childId>`、查询串必须带非空 `parent` 且 `mode` 在三种之内。
 * 拼错任何一条，宿主就认不出来：`sidebarRight.openResource` 会抛 `no registered tab type claims …`
 * （dock 没挂载时抛 `no session surface is mounted`），**不是静默无反应**。所以调用点必须
 * try/catch，而这里是纯函数、有测试。
 */
export function workerChatAddressOf({ address } = {}) {
  if (!usableAddress(address)) throw new TypeError('workerChatAddressOf: a subagent address is required')
  const parent = readText(address.parentSessionId)
  const mode = readText(address.mode)
  if (!SUBAGENT_CHAT_MODES.includes(mode)) {
    throw new TypeError(`workerChatAddressOf: mode must be one of ${SUBAGENT_CHAT_MODES.join(', ')}`)
  }
  const child = readText(address.childSessionId)
  const query = new URLSearchParams({ parent, mode })
  return `${SUBAGENT_CHAT_ADDRESS}${encodeURIComponent(child)}?${query}`
}
/**
 * `workerChatAddressOf` 的逆：把一个资源地址读回 subagent 地址。
 *
 * 逐条对齐宿主的 `parseSubagentChatAddress`（`dsh-client-ui-subagent/lib/client.js:726`）：
 * 协议 `dsh-resource:`、hostname `subagentchat`、路径恰好 `session/<childId>`、非空
 * `parent`、`mode` 在三种之内。宿主记的页签里 `contentId` 就是这个地址原样存着，
 * 所以反查只能解析它，不能拿我们自己拼出来的地址去做字符串相等——worker 结束时正是
 * 「拼不出那个地址」的时刻（mode / parent 都可能已经取不到了）。
 *
 * 比宿主严一处：解出来的 child 是空白就当不是地址。理由与 `usableAddress` 同一条尺子——
 * 空白 id 指不到任何会话，交出去只会换来一个点了没反应的东西。
 */
export function parseWorkerChatAddress(value) {
  if (typeof value !== 'string') return undefined
  let url
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'dsh-resource:' || url.hostname.toLowerCase() !== 'subagentchat') return undefined
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length !== 2 || parts[0] !== 'session') return undefined
  const parentSessionId = url.searchParams.get('parent')
  const mode = url.searchParams.get('mode')
  if (parentSessionId === null || parentSessionId === '' || !SUBAGENT_CHAT_MODES.includes(mode)) return undefined
  let childSessionId
  try {
    childSessionId = decodeURIComponent(parts[1])
  } catch {
    return undefined
  }
  if (readText(childSessionId) === '') return undefined
  return { parentSessionId, childSessionId, mode }
}

/**
 * 一个 worker 在右栏还开着哪些页签。
 *
 * `tabs` 就是宿主的 `ctx.sidebarRight.openTabs` 快照——**跨会话的一张平表**，每项
 * `{ sessionId, tabId, kind, contentId }`（`dsh-client-ui-sidebar-right/lib/client.js:2298-2303`）。
 * 注意 `openTabs` 挂在控制器实例上，**不在 `ISidebarRight` 的公开接口里**：能读是靠现在这份
 * 实现，不是靠契约。按 `contentId` 解析出来的 child 会话 id 匹配，不按地址字符串相等匹配：
 * 见上面那条理由（同一个 worker 换过 parent/mode 后地址字符串就变了）。
 *
 * `kind` 也要对上。`contentId` 里写着 `subagentchat` 不等于这张页签就是宿主的聊天页签——
 * 类型是按地址 pattern 认领的（`claim()`，`client.js:5027`；档位排序 `RANKS`/`DEFAULT_BAND`
 * 在 `:4834-4840`，`extension` 压 `builtin`，没写档位的默认就是 `extension`），glob 开得宽的
 * `extension` 档可以接管同一串地址。关错页签比不关更糟，所以只认 `kind === 'subagentchat'`。
 *
 * 为什么要把这件事算出来：worker 结束（`subagent/end`）后它那个聊天页签还开着，里面是
 * 一条没人能再说话的会话。宿主管开不管关（`dsh-client-ui-subagent` 只在 `:1252` 开、
 * 从不关），插件不主动关就会一列死页签堆着。
 *
 * **找到 ≠ 关得掉。** 唯一的公开关法是 `close(tabId)`，它只作用于**屏幕所在会话**
 * （`client.js:2654` 走 `require()`，没有挂载的会话直接抛）。按会话关的
 * `closeIn(sessionId, tabId)` 存在，但源码自己写着 "Not part of `ISidebarRight`"
 * （`client.js:2534`），且在会话 store 没被 adopt 时静默什么都不做（`client.js:2541`）——
 * 押它等于押宿主不改这个内部方法。
 *
 * 所以清扫要挂在**两个**触发点上，缺一个就只剩一半情况能用：
 *
 * 1. 插件自己的 `subagent/end` 处理里，当这个 worker 的父会话就是当前挂载会话时立刻扫一遍——
 *    否则「你正看着它、它就死了」这种最常见的情况永远等不到窗口变化。
 * 2. `ctx.sidebarRight.mounted` 变化时重扫——否则「worker 死时你在别的会话」那一半没有第二次机会。
 *
 * 两个都是快照 store，要读 `getSnapshot()`（`createSnapshotStore`，`client.js:2367/2453`；
 * `openTabs` 同理，`tab-inventory.d.ts:17`）。直接拿 store 跟 id 比恒为 false，会静默地一个都不关。
 *
 * 两个真机陷阱，写 client 时必须绕开：
 *
 * - **别在 subscribe 回调里同步 `close()`。** 挂载会话先翻，adoption 在随后那次渲染里发生，
 *   而 `require()` 在 `actionsFor` 为空时抛 `no session surface is mounted`
 *   （`client.js:2919-2927`；时序注释在 `service.d.ts:167-173`）。延到 microtask / 一帧 /
 *   React effect 里再做，并 try/catch。
 * - **`openTabs` 里还有 localStorage 恢复出来的、属于未 adopt 会话的行**（`client.js:2274-2291`），
 *   所以「只挑挂载会话那几张」是必须的过滤，不是优化。
 */
export function workerChatTabsOf({ tabs, sessionId } = {}) {
  if (!Array.isArray(tabs)) throw new TypeError('workerChatTabsOf: tabs must be an array')
  const id = readText(sessionId)
  if (id === '') throw new TypeError('workerChatTabsOf: a session id is required')

  // Map 本身就按键去重：同一张页签在表里出现两次只会留一条关闭动作，不需要额外守卫。
  const found = new Map()
  for (const raw of tabs) {
    if (raw === null || typeof raw !== 'object') continue
    if (readText(raw.kind) !== 'subagentchat') continue
    const tabId = readText(raw.tabId)
    if (tabId === '') continue
    const address = parseWorkerChatAddress(raw.contentId)
    if (address === undefined || address.childSessionId !== id) continue
    const owner = readText(raw.sessionId)
    found.set(`${owner}\u0000${tabId}`, { sessionId: owner, tabId })
  }
  return [...found.values()]
}

/**
 * 点一个 worker 要执行的两步。**点击那一刻**算，不是渲染那一刻。
 *
 * 返回 `{ resource, session }`：
 *
 * - `resource` —— 有 subagent 地址时才有，形状就是 `openResource` 的两个参数
 *   （`{ address, kind, preferNewPane }`）。`kind` 显式给，免得靠 glob 排序猜；`preferNewPane`
 *   不给的话聊天会落进面板自己占的那个格里。
 * - `session` —— 退路：交给 `uiWorkspace.openSession` 的目标。解析出地址时**递地址不是裸 id**，
 *   宿主的 `SessionTarget` 是 `SessionId | SubagentAddress`，`resolveTarget` 只对字符串目标抛
 *   `unknown session`；地址能打开一条列表里还没有的子会话，裸 id 正好会抛。
 *
 * 为什么要在点击时重算：渲染时对的东西到点击时可能已经变了（地址被淘汰、会话已结束）。
 * 所以`panelActionsOf` 里那串地址只是渲染提示，这里才是真值。
 *
 * 为什么这层要单独存在：`client.js` 里塞不下可测的东西。决定（开哪里、退哪里）留在这个
 * 纯函数里，客户端只当执行器 + try/catch。
 */
export function workerOpenStepsOf({ sessionId, addressOf } = {}) {
  const target = navigationTargetOf({ sessionId, addressOf })
  let resource
  if (target.kind === 'subagent') {
    try {
      resource = { address: workerChatAddressOf({ address: target.target }), kind: 'subagentchat', preferNewPane: true }
    } catch {
      // mode 不认识之类的：右栏开不了，但地址仍然能当主栏目标，不该因此整行点不动。
      resource = undefined
    }
  }
  return { resource, session: target.target }
}

/** 面板上可以做的四种事。 */
export const PANEL_ACTIONS = Object.freeze(['open-session', 'open-worker', 'designate-master', 'show-section'])

/** 造一个动作，顺便保证 kind 在这个表里——否则这张表就成了没人读的装饰。 */
function action(kind, rest) {
  if (!PANEL_ACTIONS.includes(kind)) throw new TypeError(`panelActionsOf: unknown action kind "${kind}"`)
  return { kind, ...(rest === undefined ? {} : rest) }
}

/**
 * 点一下面板入口该发生什么。
 *
 * 返回值是纯数据，client 侧按 `kind` 分派。**这里只描述意图，不承诺结果**：
 * 能不能开成，取决于点击那一刻宿主知道什么。
 *
 * - `open-session` —— 在主栏打开一个会话（`uiWorkspace.openSession`，目标是宿主的
 *   `SessionTarget`）。master 走这条。
 * - `open-worker` —— 一个 worker，带 `sessionId`；能同步解析出 subagent 地址时附带 `address`。
 *   **`address` 只是渲染时的提示，不是点击时要用的那个值**：点击时重新跑一遍
 *   `addressOf` → `workerChatAddressOf`，别照这里给的地址开——渲染时对的东西到点击时可能已经变了。
 *
 *   点击时的顺序（由客户端执行，全部 try/catch）：
 *   1. 重新解析出地址 → `sidebarRight.openResource(address, { kind: 'subagentchat', preferNewPane: true })`。
 *      `kind` 显式给，免得靠 glob 排序猜；`preferNewPane` 不给的话聊天会落在本面板占的那个格里。
 *   2. 开不成（dock 没挂载、类型没注册、地址被淘汰）→ 退主栏 `openSession(目标)`。
 *      **这里的目标要用地址，不是裸 id**：宿主的 `SessionTarget` 是 `SessionId | SubagentAddress`，
 *      `resolveTarget` 只对字符串目标抛 `unknown session`；递地址能打开一条列表里还没有的子会话，
 *      递裸 id 正好会抛。这是唯一真能救回来的那条退路。
 * - `designate-master` —— master 还没指定：去设置里指定或一键生成，而不是点一个空目标。
 * - `show-section` —— 监工与汇报不是会话，是面板里的一段。
 *
 * 为什么 worker 不直接给一个「已经决定好开哪里」的答案：宿主侧根本没有一条可靠的退路可以
 * 在这里承诺。`sessions.retain(裸 id)` 对「未物化、不在列表、也没有地址」的会话抛
 * `unknown session <id>`——而这正好就是解析器返回空的那种状态。反过来，冷恢复其实是解析器
 * 的好情况：宿主会给任何「已列且有 parent」的子会话合成 `mode: 'unknown'`。所以同步解析不出
 * 地址，通常意味着客户端对这条子会话一无所知，此时退回主栏**不保证打得开**，只是尽力而为。
 */
export function panelActionsOf({ model, addressOf } = {}) {
  requireModel(model, 'panelActionsOf', { fixed: true })
  const master = model.master !== null && typeof model.master === 'object' ? model.master : { sessionId: null }

  const fixed = model.fixed.map((row) => {
    const id = readText(row?.id)
    if (!FIXED_SECTIONS.includes(id)) {
      throw new TypeError(`panelActionsOf: "${id}" is not a fixed entry (${FIXED_SECTIONS.join(', ')})`)
    }
    if (id === 'master') {
      const sessionId = readText(master.sessionId)
      return { id, action: sessionId === '' ? action('designate-master') : action('open-session', { sessionId }) }
    }
    return { id, action: action('show-section', { section: id }) }
  })

  const seen = new Set()
  const workers = []
  for (const row of model.workers) {
    if (row === null || typeof row !== 'object') continue
    const sessionId = readText(row.sessionId)
    if (sessionId === '' || seen.has(sessionId)) continue
    seen.add(sessionId)

    let address
    try {
      const resolved = typeof addressOf === 'function' ? addressOf(sessionId) : undefined
      // 只认同步值：Promise 不是地址，异步解析器在这里一律当「还不知道」，交给点击时再解析。
      address = usableAddress(resolved) ? workerChatAddressOf({ address: resolved }) : undefined
    } catch {
      // 解析器抛错、或地址里的 mode 不认识：都退回「不知道」，不让一行坏数据拖垮整张表。
      address = undefined
    }
    workers.push({ sessionId, action: address === undefined ? action('open-worker', { sessionId }) : action('open-worker', { sessionId, address }) })
  }

  return { fixed, workers }
}
