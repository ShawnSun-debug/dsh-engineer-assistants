# 蓝图：四段流水线 + 盲评闸门

两份结构不同的草图，同一组决定（ADR 0004/0005/0006），只差「状态存在哪」。

## 草图 A —— 线性四段，函数调用推进

```text
runPipeline(deps, rawCard)
  plan     -> normalizeCard / missingFields
  review   -> riskTier ? reviewCard : skip
  dispatch -> deps.dispatch(card, dispatchId)
  settle   -> deps.settle(dispatchId)
```

公共面：`runPipeline`、`nextPhase`、`reviewCard`、`shouldBlock`、`riskTier`。三个文件共 2539 字节。

## 草图 B —— 事件归约，状态是投影

```text
TRANSITIONS = { plan:{planned:review}, review:{reviewed:dispatch,blocked:plan}, ... }
transition(state, event) / replay(log) / isTerminal(phase)
```

公共面多一层事件词汇（6 个事件 + 5 个阶段），换来断电可重放与「非法转移直接抛错」。

## 对照

| | A 线性四段 | B 事件归约 |
|---|---|---|
| 公共函数 | 5 个 | 8 个（含事件表） |
| 回答「这张卡现在在哪」 | 读调用栈/一个变量 | 读投影，可重放 |
| 与 ADR 0005（评审是独立一段） | 一致 | **冲突**：B 把评审压成 dispatch 入口的准入检查 |
| 与现有 supervise/retry 的接缝 | `deps.dispatch` 一个门面 | 要把现有链路改造成事件源 |
| 断电恢复 | 不支持，重派 | 支持 |

## 选定：A

选 A 的理由只有一条是决定性的：**B 把评审塞回 dispatch 入口，等于推翻 ADR 0004 与 0005**。
把评审做成独立一段，是这次重画唯一新增的结构；被草图吃掉就失去意义。
第二条：A 的公共面更小，从单个文件看是对的改法，放到全仓也是对的。

从 B 吸收一点：`TRANSITIONS` 那张显式表值得进 A 内部——`nextPhase` 用表驱动而不是 if/else，
非法转移抛错。这不改变 A 的形状，只是让 A 的第四段更硬。

## 编译器证据

```text
node --check sketch-a{,b}/card.js  -> OK
node --check sketch-a/pipeline.js  -> OK
node --check sketch-a/review.js    -> OK
node --check sketch-b/machine.js   -> OK
node --check sketch-b/review.js    -> OK
```

（仓库是纯 ESM + JSDoc，没有 tsc；类型面靠 `@typedef` 声明，语法面用 `node --check` 证明，未跑类型检查器。）

## 未决

- `delegate` / `orchestrate` 的别名期给不给？ADR 0006 说直接换，但已有提示词会静默失效。
- `settle` 的活跃集压缩策略没定，只定了「不删行」。
- 评审者的 prompt 与 `CHECKED` 清单需要一轮真实任务校准，蓝图里只有形状。

## 实现状态（草图 A 已填）

```text
blueprint/sketch-a/card.js       normalizeCard / missingFields / riskTier
blueprint/sketch-a/review.js     assertReviewShape / buildReviewPrompt / reviewCard / shouldBlock
blueprint/sketch-a/pipeline.js   runPipeline / nextPhase / TRANSITIONS
blueprint/test/pipeline.test.js  9 个用例
blueprint/test/fixtures/golden-cards.json  10 张黄金任务卡
```

测试证据（node --test，2026-2026-11-05）：

```text
tests 9 / pass 9 / fail 0 / duration 138.8ms
```

`reviewCard` 的模型调用是注入的（`complete`），仓库里没有真实路由接线——
黄金用例目前只验证**风险分档**，不验证评审者的判断质量（那需要真实模型在环）。

## 决定修订（第二轮拷问）

- 旧工具名**不留别名**，`delegate` / `orchestrate` 直接换成 `dispatch`。代价：已有提示词静默失效。
- 活跃集**不设上限**，`settle` 只从巡检到期集摘除。代价：长时间运行后索引变慢，需另立一页压缩策略。
- 评审校准走 10 张黄金任务卡（已落盘），先定 verdict 期望值再调 prompt。
