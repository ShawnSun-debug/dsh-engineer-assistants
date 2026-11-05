# 0008 master 会话与状态索引

## 状态

已决定（2026-11-05）

## 背景

DSH 的会话以 cwd 为锚：一个会话属于一个工作目录，关掉就没了，协调状态、对项目的理解、
跨项目的进展全在会话里，重启之后要从零重建。宿主提供 `ctx.agents.roots()`，
但它只报当前进程里活着的根会话——04 的 spike 实测**冷启动时恒为空**，所以它不能用来判断
「master 是不是已经存在」，只能作为进程内的一次性快照。

## 决定

1. **状态索引走 host-only 投影。** 注册 `sessionProjections` 的 key `orchestrator-master`
   （`stateVersion: 1`），状态形状是 `{ workers: [{ id, role, state, summary }] }`；进入 `Needs input` 时
   另带一个 `pending`（阻塞调用的 callId），只有该调用的 `tool/result` 才清回 `Working`。
   `apply` 是同步纯折叠函数：不读服务、不调模型、不写盘；不关心的事件返回同一引用。
   **没有 `wire`**，因此不进客户端快照、不产生视图。状态固定六个值：
   `Working` / `Needs input` / `Idle` / `Completed` / `Failed` / `Stopped`；
   一行摘要取 `session/title` 事件的标题（单行、截到 120 字符），不额外调模型。
2. **master 会话无 cwd。** 用 `ctx.agents.create({ sessionId })` 建，不传 `parentAgent`、
   不传 `meta.cwd`；磁盘位置是 `sessions/_no-cwd/<sessionId>/`。
   `ctx.sessions.create()` 建的会话不落盘，禁止使用。
3. **resume-first 发现。** 会话 id 固定为 `orchestrator-master`，发现顺序写死：
   `agents.get(id)`（活着直接用）→ `agents.resume({ resumeSessionId })` → 失败才 `agents.create`。
   不用 `roots()` 判重。同一进程内并发调用共享一个 in-flight promise，最多一次 resume、一次 create。
4. **flush 语义。** 建成/恢复后立刻 `sessions.flush(agent.session)`；每一次 `followup` 之后也 flush。
   `flush` 返回 `true` 只表示「有落盘监听者参与且都成功」，**不等于 fsync**；`false` 与 throw 都按失败处理，
   失败就明确报错，不留下「只在内存里的 master」。
5. **卸载先 flush 再 dispose。** 04 spike 实测：插件 fiber 销毁时 agent 被拆，缓冲的事件不会补写磁盘。
   因此 master 由插件 effect 持有，卸载路径先 flush、再 `record.dispose()`；flush 失败也仍 dispose。
   `disposeMaster` 把错误抛给它所在的 effect，effect 记一条 warn 并继续卸载，不阻塞插件退出。
6. **开关**：`masterSessionEnabled`，默认 `false`；关闭时在第一次判断就返回，不碰 `agents` / `sessions`。

## 替代方案与不选的理由

**用 `roots()` 判重或发现。** 冷启动恒空，结果是每次重启都新建一个 master，越积越多。
**生成新 id、靠标题找回。** 没有确定的索引键，重启后无法证明找到的是同一个协调者。
**用 `ctx.sessions.create()`。** 它不落盘（spike 结论），重启即失去协调状态。
**用 `steer` 投喂通知。** `steer` 会打断用户正在跑的回合；master 的协议是「排一轮普通回合」。
**状态索引做成带 `wire` 的投影。** 一个会话的投影只代表它自己，客户端要跨会话聚合还得再拼一层，
而面板端点已经能按需读所有会话；host-only 少一条跨会话可见性的路。

## 后果

- 固定 id 是全局唯一键：同一个 `DSH_HOME` 被两个进程同时打开时会争同一个会话（多进程租约未验）。
- master 会话占一个根会话位；**无 cwd ≠ 干净上下文**——`dsh-working-directory` 仍会把进程 cwd
  作为运行时 `user/message` 注入，这是已知限制。
- 投影对每个事件都要折叠一次，未读时多一次对象分配。这也是它不挂开关的理由：同步纯函数、无 `wire`、
  零可观察影响；挂在一个并不拥有它的开关后面反而制造假耦合。
- 状态只有六值：`blocked` / `max-tokens` / `forked` 一律 `Idle`，不编造 `Completed` 或 `Failed`。
- 分叉会话从 `Idle` 开始：宿主不会把继承前缀折进新单元，`init` 也刻意忽略继承计数，
  所以一个 mid-turn 被 fork 的 worker 在它自己的第一个 `turn/start` 之前会短暂报 `Idle`。

## 与实现的偏差

1. **没有调用方给 master 喂通知。** `ensureMaster` / `notice` 只是库导出，巡检仍把通知投给父代理；
   master 会话目前收不到任何消息，状态索引也没有被 master 读取（面板端点自己读）。
   「worker 完工通知只带最终答案与短尾」这一条还差接线。
2. **面板只收 `role === 'worker'` 的行。** 主会话 `turn/end(completed)` 报 `Idle`
   （日志里没有「任务完成」事件），主会话进面板会让「暂无 worker」永远不可达。
3. **`Needs input` 靠工具名白名单判定**（`ask_user_question` / `request_user_input` / `pick_files` /
   `exit_plan_mode`），并记下阻塞调用的 callId，只认它的 result。宿主改名或新增阻塞工具会漏判，
   这是已知限制。
4. **双重 teardown 的幂等性**只在单测覆盖，真实宿主未验（推断 cordis effect 语义幂等）。
5. **未验证**：真实 `~/.dsh/sessions/_no-cwd/` 的落盘（spike 在 `DSH_HOME` 重定向下验过同一段代码）、
   `_no-cwd` 会话在 GUI 里的显示、同一 sessionId 的多进程租约。
