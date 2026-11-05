# 0009 跨会话消息协议

## 状态

已决定（2026-11-05）

## 背景

master 要把结论交给 worker，worker 也要把结论交回；但会话之间的上下文是隔离的。
一旦允许「把发送方的对话一起带过去」，两份长历史就互相污染，token 与失控面都跟着翻倍。
同时，放任任何会话给任何会话发消息，等于把「谁能唤醒谁」这个权限问题藏进一个函数里。

## 决定

- **信封就是消息本身**：`composeMessage({ from, to, text, now })` 只产出
  `{ id, from, to, text, createdAt }`；输入里多塞的 `history` / `files` / `messages` 一律丢弃。
  没有可以携带发送方历史的入口。
- **两个硬上限**：单条正文 ≤ 8192 字节，接收方排队 ≤ 16 条（都是含端点的常量，调用方可覆盖）。
  越界抛错（`oversize` / `queue-full`），不静默截断、不丢尾。
- **入站三态**：`accept` 直接投递、`hold` 停进接收方队列、`refuse` 丢弃。判定顺序是契约的一部分：
  未知策略 → 策略 `refuse` → 超尺寸 → 队列满 → `hold` → `accept`。
  策略性拒绝**返回** `{ decision: 'refuse', reason }` 而不抛错（这是对端的正常拒绝）；
  容量越界才抛错（这是调用方的配置/用法错误）。
- **投递路径**：`accept` 时取活的 agent，`status === 'running'` 走 `inject`（下一次 step 边界消费，
  不新开回合），否则走 `followup`（开一轮新回合）；投递后 `sessions.flush(agent.session)`，
  `false` / throw 都按失败抛错。
- **来源标注**：消息 body 的 `source.kind` 是插件自定义 kind `orchestrator-master`，
  `form` 取宿主 `ContextForm` 的 `relay`（「另一个 agent 发给本会话的消息」）。
  master 通知（`notice()`，当前未接线）用 `form: 'notice'`，并按 `ContextFormed` 契约必须带
  `summary`；巡检通知不是这个 kind，它用 `orchestrator-supervision`。
  三者分开后，「按 kind 找巡检通知」的既有逻辑不会命中跨会话消息。
- **没有入口工具**：`apply` 不注册任何消息工具，能力只经包入口导出
  （`composeMessage` / `checkInbound` / `deliverMessage`）。
  开关 `masterMessagingEnabled` 默认 `false`、策略 `masterInboundPolicy` 默认 `accept`，
  两者都 volatile、逐次读取。

## 替代方案与不选的理由

**转发发送方历史。** 上下文雪球，接收方日志里还会出现不属于它的对话，事后归因全是噪声。
**借用宿主的 `send_message`。** 那是父给子投喂的固定方向通道，没有入站策略，
用它等于把「接不接、收多少」挂在一层不负责这件事的代码上。
**不设上限。** 一次大粘贴就能把接收方撑爆，而且没有让用户调小的旋钮。
**以 `steer` 为主路径。** `steer` 会唤醒空闲 driver，与「空闲→新回合、运行中→步骤间投递」的语义冲突。
**现在就注册一个发消息工具。** 谁能发给谁（是否要用户确认、是否允许任意 session id、面板怎么呈现）
还没定，先注册会把未定的语义提前固化。

## 后果

- `hold` 目前只到「停进队列」：没有 drain 路径、也没有队列实物的持久化，
  所以打开 `hold` 后消息会停在调用方队列里，直到后续票接上投递触发点。
- 没有入口工具意味着协议现在没有真实流量；接线方按开关自行展开。
- 幂等的限制：`id` 是内容指纹，同一输入重发得到同一个 id，但没有去重表，不承担幂等语义。
- 接收方按 `agents.get(toSessionId)` 取活的 agent，不自动冷 resume 一个已落盘的会话。

## 与实现的偏差 / 未验证

1. **没有在真实宿主里跑过一次投递**：`inject` 在 running 回合里的消费时机只有宿主 d.ts 文案支撑。
2. **`status` 的竞态未验**：读到 `idle` 后、`followup` 前若恰好有另一条投递唤醒 driver，
   会得到两条排队回合而不是一条。
3. **`form` 的消费方未验**：`relay` / `notice` 已按 dsh-llm 的 `ContextFormed` 取值，
   但 `inbox` 投影或客户端是否按 `form` 分桶未查证。
4. **`inject` 路径的 flush 时机未验**：注入的消息在下一个 step 之前 flush 一次是否足以让它落到磁盘。
5. **多进程**：同一接收方的队列计数与 flush 竞争未验（队列是进程内的调用方对象）。
6. **没有 GUI 验证**：跨会话消息在客户端会话视图里如何显示（是否与用户输入混同）未验。
