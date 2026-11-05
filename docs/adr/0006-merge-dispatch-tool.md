# 0006 合并 delegate 与 orchestrate 为单一 dispatch 工具

## 状态

已决定（2026-11-05）

## 背景

`delegate`（单任务、异步返回 activation）与 `orchestrate`（items × stages、同步返回全部结果）
是同一件事的两种形状：都是「把任务卡交给 worker 执行」。
两者各自带一份工具 schema，每个父级请求都要付两份 token；
主代理还要先判断「这是一件事还是很多件事」，判错的代价是改派或重派。
评审（ADR 0004）若只加在其中一个上，另一个就成了绕过闸门的旁路。

## 决定

收敛成一个 `dispatch` 工具：

```text
dispatch({ card, items?, stages?, maxConcurrency? }) -> { dispatchId, phase, accepted }
```

- `items` 省略时按单任务处理，等价于原 `delegate`；给定 `items × stages` 时等价于原 `orchestrate`。
- 统一**异步**返回：立即给 `dispatchId`，结算走 `followup`。原 `orchestrate` 的同步返回取消——评审已经引入延迟，同步等待只会更长。
- 返回前必经 `plan` / `review` 两段；低风险档直接放行（ADR 0004 的分级）。
- 工具描述里写明：这是唯一派发入口；评审不通过时返回 `{ phase: 'review', verdict: 'BLOCK', failureMode }`。

## 替代方案与不选的理由

**保留两个工具、只在外面包一层闸门**：改动最小，但两份 schema 的 token 成本仍在，
且「两个入口」本身就是以后加第三个的理由。
**保留同步语义**：大批量编排一次性拿全结果的体验确实好，但它让 `phase` 在调用期间不可观测，
与四段流水线（ADR 0005）直接冲突。

## 后果

- 已有提示词里写的 `delegate` / `orchestrate` 全部失效，需要一次性改写。
- 大批量任务原计划改成「工具只回 `dispatchId`、结果等通知」；实现仍同步返回全部结果，见下方偏差 3。
- 工具 schema 减为一份，主代理的派发判断从「选哪个工具」降级为「填哪几个字段」。

## 决定修订（2026-11-05，第二轮拷问后）

- **不留别名期**：`delegate` / `orchestrate` 不再注册，也不接受旧名字。代价是已有提示词静默失效，发布说明必须写清。
- **只有 `high` 档过评审**：低风险卡放行并记账（ADR 0004 的分级），不是每次派发都审。

## 与实现的偏差（2026-11-05 收口核对）

1. **没有统一的 `{ dispatchId, phase, accepted }` 返回**：单任务沿用 `{ kind: 'activation', subagentId }`，
   批量沿用 `{ kind: 'orchestration', agentsStarted, results, errors }`。输出 schema 由宿主渲染，
   改形状要同时改渲染与既有用例；`phase` 目前只在评审拒绝时以错误消息出现。
2. **`BLOCK` 用抛错交回，不是返回值**：仓库对「拒绝派发」一贯抛错，返回假结果会让主代理以为派发成功。
   错误消息里带 `failureMode` 与 `target`。
3. **批量路径仍是同步的**：ADR 原写「统一异步返回 `dispatchId`」。改成异步要引入后台编排与 followup 投递，
   已记为欠账（票 03）。

## 收口记录（2026-11-05）

- **合并 schema 的必填表**：宿主的 schema 编译器把每个 `required: true` 收进同一个必填表，合并后的工具
  原本要求 `prompt` / `description` / `items` / `stages` 同时出现，合法的批量调用会在校验阶段被拒。
  现在两种形状各自的必填键都降为可选，单任务的必填检查仍留在 delegate 的 execute 里。
- **旧工具名残留**：主代理规则正文、`run_code` 与闸门的拒绝文案、会话阶段投影（`dispatch` 计入执行）
  与一处死 import 都已清理；`stage.js` 保留旧名，只用于合并前录下的日志。
