<div align="center">
**DSH Orchestrator**
</div>
<div align="center">

**强模型主脑规划 + 便宜模型统一打工 —— DeepSeek Harness 的「硬隔离调度模式」插件**

[![version](https://img.shields.io/badge/version-0.8.0-4176E6?style=flat-square)](https://github.com/SShiRkiT/dsh-orchestrator)
[![dsh-plugin](https://img.shields.io/badge/DeepSeek%20Harness-dsh--plugin-4176E6?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![platform](https://img.shields.io/badge/platform-Web%20GUI%20%7C%20Desktop-5c6bc0?style=flat-square)](https://github.com/SShiRkiT/dsh-orchestrator)
[![node](https://img.shields.io/badge/node-%3E%3D22-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![module](https://img.shields.io/badge/module-ESM-F7DF1E?style=flat-square&logo=javascript&logoColor=black)](package.json)
[![license](https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/SShiRkiT/dsh-orchestrator?style=flat-square&logo=github)](https://github.com/SShiRkiT/dsh-orchestrator/stargazers)

**简体中文** | [English](README.en.md) · [核心差异](#为什么有了原生-subagent-和-agent-team还需要这个插件) · [核心特性](#核心特性) · [安装](#安装) · [配置说明](#配置说明)

</div>

---

## 为什么有了原生 `subagent` 和 `Agent Team`，还需要这个插件？

DSH 客户端自带了 `subagent` / `workflow`，官方也有 `@deepseek-ai/dsh-experimental-agent-team-profile`（Agent Team），但它们在实际高强度开发中仍有三个痛点——而这正是 **DSH Orchestrator** 独有的设计核心：

| 痛点场景 | 原生 `subagent` / 官方 `Agent Team` | DSH Orchestrator（本插件独有） |
| --- | --- | --- |
| **如何省钱配模型？**<br>*(最核心差异)* | **无独立子代理面板**：子代理要么默认继承昂贵的主模型，要么靠主模型每次调用时自己传参选模型（容易忘传或乱选，改默认模型还得改静态配置） | **双路由独立面板 + 强制锁定便宜模型**：在 UI 面板直接把 Main Agent 设为昂贵强模型（如 `gemini-4-argon-high`），把 Subagent 统一锁死为廉价快模型（如 `gemini-3.8-flash`），改完下一次委派立即生效 |
| **主代理总忍不住自己动手？** | **靠自觉（软提示词）**：主代理 / Team Lead 手里依然握有 `read`、`edit`、`bash` 等全套工具，聊几轮就经常脱轨亲自去读文件、跑命令，瞬间撑爆主上下文 | **白名单式驱动（Whitelist-Driven Hard Gate）**：主代理默认仅放行 11 项规划与派发核心工具（`allowedTools`），其余一切宿主读写/终端工具及未来新增的 MCP/第三方插件工具一律自动隐藏并在执行层强制拦截（连 `run_code` 嵌套偷调也拦），**逼迫 Main Agent 100% 只做规划与验收，Subagent 100% 只干苦力活** |
| **便宜模型干活卡死/跑偏怎么办？** | **运行期黑盒**：派出后只能干等结束或超时，或者靠 `wait_agent` 阻塞轮询 | **零 Token 后台巡检唤醒**：后台定时静默扫描子代理事件日志（不调模型、零 Token 消耗），超时或卡壳时自动汇总摘要唤醒主代理，由强模型发消息精准纠偏 |
| **大批量同构任务怎么跑？** | 原生 `workflow` 让模型手写任意 JS 脚本，容易失控且模型路由不统一 | **声明式 `dispatch` 流水线**：`items × stages` 结构化扇出与多阶段流水线，单项失败隔离、支持 JSON Schema 强校验，全部 Worker 强制走便宜的子代理路由 |

---

## 核心特性

### 1. 强模型当 Main Agent，便宜模型当 Subagent（独立面板、即时生效）

在输入框下方的**「调度模式」专属面板**中，主代理与子代理的模型路由完全解耦：
- **主代理（Main Agent）**：配置为你最强的旗舰模型（例如 `gpt-astra-6`、`claude-opus-5.5` 等），专门负责需求澄清、任务切分、途中纠偏与最终结果验收。
- **子代理（Subagent）**：配置为能力稍弱但极其便宜、高吞吐的模型（例如 `deepseek-v4.1-flash`、`gpt-luna-6` 等），**所有通过 `dispatch` 派出的 Worker 强制共用这条便宜路由**（除非用户在当前消息里明确点名要求临时换模型）。
- **防烧钱保护**：如果未配置子代理模型，派发时会直接报错拦截，**绝不静默回退去烧昂贵的主代理模型**。

![调度模式面板](docs/images/dispatch-panel.png)

*调度模式面板：左侧独立配置主代理（如 `gemini-4-argon-high`）与子代理（如 `gemini-3.8-flash`）各自的模型、思考强度及巡检间隔；右侧 Allowed Tools（白名单式驱动）实时拉取宿主全部工具（含 MCP 与其他插件工具），勾选即放行给主代理、未勾选（含新装插件工具）默认自动禁用，无需重启，下一条消息立即对当前会话生效。*

### 2. 主代理「规划与验收」、子代理「纯粹 Work」的白名单式硬性闸门

不同于靠 Prompt 劝主模型“多用子代理”，本插件在 DSH 工具层安装了双重守卫（`tools.restrict` + `tools.guard`），且采用**白名单式驱动**：
- **主代理被彻底收缴执行工具**：`DEFAULT_ALLOWED_TOOLS` 默认只放行 11 项规划、派发与会话只读工具——`dispatch`、`send_message`、`interrupt_agent`、`todo_write`、`ask_user_question`、`compress` 与 5 项只读会话日志工具。所有文件读写（`read` / `edit` / `write` / `apply_patch`）、搜索（`grep` / `glob`）、终端（`bash` / `pwsh`）、网页抓取、原生 `subagent` / `workflow`，以及未来新增的任何 MCP / 第三方插件工具，一律自动隐藏并在执行层强制拦截（连 `run_code` 嵌套偷调也拦）。需要额外放行时，在面板右侧 Allowed Tools 勾选即可。
- **子代理独享完整工具链**：被派出的 Worker 不受闸门限制，在各自独立的上下文中读写文件、跑测试、看报错，完工后只把干净的结论交回主代理验收。
- **一键随时切换**：需要主代理临时亲自操作时，关掉面板上的「启用调度模式」开关即可立刻恢复主代理的全部工具，无需重开会话。

### 3. 零 Token 后台巡检与强模型动态纠偏

便宜模型充当 Subagent 时，偶尔会在复杂的 shell 转义或报错上打转。插件内置了纯日志驱动的后台巡检器：
- **零额外 Token 消耗**：后台定时器直接读取运行中 Worker 的会话事件日志（不调用任何 LLM），按设定的巡检间隔（默认 600 秒）汇总它的运行时长、轮次、新增工具调用与最后输出，合并成一条通知唤醒主代理。
- **强模型一眼把关**：主代理收到巡检摘要后，只需极少 Token 即可做出决策：
  - **A) 进展正常**：回复一行 `巡检：正常` 结束回合，让子代理继续跑；
  - **B) 途中纠偏**：调用 `send_message` 直接向运行中的子代理注入修正指令（指明正确写法或跳过卡点）；
  - **C) 及时止损**：调用 `interrupt_agent` 中断失控的子代理（若后续再用 `send_message` 重新唤醒它，巡检会自动重新接管并重置通知计数）。

![巡检通知与纠偏示例](docs/images/patrol-notice.png)

*巡检通知与纠偏实录：便宜的子代理卡在了 shell 引号和反斜杠转义上，巡检机制按间隔唤醒主代理后，主代理通过 `send_message` 直接给出正确写法完成纠偏。*

### 4. 唯一派发入口 `dispatch`：任务卡 + 单任务 / 批量

派发前先交一张**任务卡**：`goal`、`doneDefinition`、`files`、`deps`、`verify`、`fallback`（`items` 可选，默认 1）。缺任一字段、涉及不可逆写或删除、条目数超过 4——任一条成立即判 `high`，必须先过评审；低风险卡直接放行。

- **单任务**：省略 `items` / `stages`，派一个自包含任务。同一回合多次调用即可并行启动多个 Worker；插件统一注入简体中文回复指令，并要求它在收尾时直接输出最终总结、禁止调用 `send_message` 向父代理汇报。
- **批量**：给定 `items`（1–64）× `stages`（1–8），走 `maxConcurrency`（1–16，默认 4）的逐条目无屏障流水线，支持阶段级 JSON Schema 强校验与单项失败隔离；批量路径当前同步返回全部结果。

> **破坏性变更**：`delegate` 与 `orchestrate` 不再注册，旧提示词里的这两个名字不会被接受。改写方式是「同一句话换成 `dispatch`，再补上任务卡字段」。

### 5. 派发前的盲评闸门与四段流水线

高风险卡在 worker 启动之前，先由一个**零上下文评审者**判一次——它只看任务卡，看不到主代理的对话与推理：

- **三态结论**：`BLOCK` / `IMPROVE` / `PASS`。`PASS` 合法，但必须列出查了哪几项（完成定义、写白名单、验收命令、回退策略），不允许为产出而编造问题。
- **`BLOCK` 就是停**：一个 worker 都不启动，错误消息带回 `failureMode`（原计划会失败的具体机制）与 `target`，主代理据此重规划；一次派发只评一次，不自动重评、不自动改写。
- **四段**：`plan → review → dispatch → settle`。`settle` 标记落定、保留会话日志、把该派发从巡检到期集摘除；日志不删，重试与复盘仍能读到原轨迹。
- **评审路由**：面板里单独一栏，留空即跟随子代理路由；最近一次结论直接显示在面板上。

### 6. Master 层：AI 记忆、状态索引与跨会话消息（默认关闭）

这一层是附加功能，四个开关默认全关；关着时四个 master 功能都不产生用户可见输出。不过一个 host-only 的状态投影单元和一个只读端点始终注册（端点关闭时不返回任何 worker 数据），理由见 ADR 0008 的「后果」。打开后多了四样东西：

- **AI 记忆（`masterMemoryEnabled`）**：插件在自己的存储域 `orchestrator_memory` 里累积条目，并在每个会话注入一段带「AI 记忆，非用户指令」标注的紧凑索引（首行标注 + 一行计数 + 每条一行）。上限 **200 条 / 索引 25 KiB**，先到者为准；写超限直接报错并要求先精简，不静默截断。它与 `~/.dsh` 下你手写的 `AGENTS.md`、`memory/topics` 完全分离——插件只读引用你的记忆树，从不写它。
  > 当前版本只接线了「存储域 + 索引注入」，还没有记忆的写入/检索工具，模型侧入口待后续票；此时打开开关看到的是空索引。
- **Master 状态面板（`masterPanelEnabled`）**：输入框右侧的「Master 状态」按钮，按六态（Working / Needs input / Idle / Completed / Failed / Stopped）分组列出 worker 与会话标题摘要，只读、可收起；没有 worker 时显示「暂无 worker」，开关关闭时按钮不渲染。
- **常驻 master 会话（`masterSessionEnabled`）**：以固定 id `orchestrator-master` 建一个**无 cwd** 的根会话，落盘在 `sessions/_no-cwd/` 下（该路径来自 spike 在 `DSH_HOME` 重定向下的验证；真实宿主目录尚未验证，见 ADR 0008），重启时按 resume 复用同一个，不会越开越多；通知经 `followup` 投喂、投喂后立即 flush，卸载时先 flush 再 dispose（否则缓冲的事件会静默丢掉）。
  > 当前版本没有调用方给它投通知：会话与契约已就绪，接线待后续票。
- **跨会话消息（`masterMessagingEnabled` / `masterInboundPolicy`）**：纯文本信封 `{ id, from, to, text, createdAt }`，**不带发送方历史**（额外塞进去的 `history` / `files` 会被丢弃）；单条 ≤ **8192 字节**、接收方排队 ≤ **16 条**，越界报错；入站策略 `accept` 直接投递、`hold` 停进队列、`refuse` 丢弃。接收方空闲时开一轮新回合，运行中则投在两次 step 之间，投完立即 flush。
  > 当前版本没有发消息的工具，`hold` 也还没有投递触发点，消息会停在队列里等后续接上。

---

## 环境要求

| 项目 | 要求 |
| --- | --- |
| **宿主环境** | DeepSeek Harness Desktop / Web GUI |
| **Node.js** | `>= 22`（内置于 DSH Desktop 运行时） |
| **插件形态** | Cordis 后端服务补丁（`cordis.patch.yml`）+ Web GUI 客户端扩展（`lib/client.js`） |
| **界面语言** | 中 / 英双语自适应（`zh-CN` / `en-US`） |

---

## 安装

在 DSH 插件页选择从 GitHub 添加，或使用 CLI：

```text
SShiRkiT/dsh-orchestrator#main
```

```bash
dsh plugin --profile desktop add SShiRkiT/dsh-orchestrator#main
```

装完后请**完全退出并重新打开 DSH**（客户端插件在启动时组合，不支持热更新）。

---

## 配置说明

配置项均为 volatile（动态热配置），在面板中修改后立即生效，无需重启 DSH；例外是 master 层的两个安装型开关（`masterMemoryEnabled` / `masterSessionEnabled`），它们在插件挂载时读取，改动要重载插件：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 调度模式总开关。关闭时立即对当前会话恢复主代理全部工具。 |
| `workerProvider` / `workerModel` | `""` | 子代理默认模型路由（必填，未配置时派发直接报错，绝不静默继承主代理模型）。 |
| `workerReasoningEffort` | `""` | 子代理思考强度，留空则由所选模型自行决定默认值。 |
| `reviewProvider` / `reviewModel` | `""` | 评审者路由。两项都填才覆盖，否则整体跟随子代理路由——不做半套拼路由。 |
| `reviewReasoningEffort` | `""` | 评审者思考强度，留空由所选模型决定。 |
| `lastReview` | `""` | 最近一次评审的 `{ verdict, target, at }` 摘要，由插件写入、面板只读。 |
| `allowedTools` | 11 项内置白名单 | 白名单式驱动：主代理仅可使用列表内的工具，其余宿主/MCP/插件工具自动隐藏并禁用；面板右侧 Allowed Tools 可直接勾选放行或取消勾选禁用，下一条消息即刻生效。 |
| `superviseEnabled` | `true` | 子代理后台巡检总开关。 |
| `superviseIntervalSeconds` | `600` | 巡检间隔（秒），范围 10–86400，运行中修改立即生效。 |
| `superviseMaxNoticesPerChild` | `3` | 每个子代理最多发送几次巡检通知（0–20，`0` 表示不限）。 |
| `superviseNotifyOnNoProgress` | `false` | 子代理日志无新活动时是否仍然发送通知。 |
| `masterMemoryEnabled` | `false` | AI 记忆层：打开存储域并注入紧凑索引。**挂载时读取**，改动需重载插件。 |
| `masterPanelEnabled` | `false` | Master 状态面板。关闭时按钮不渲染，服务端端点只返回空投影。 |
| `masterSessionEnabled` | `false` | 常驻 master 会话（无 cwd 根会话）。**挂载时读取**，改动需重载插件。 |
| `masterMessagingEnabled` | `false` | 跨会话消息开关。逐次读取；关闭时投递以 `disabled` 拒绝，不碰接收方。 |
| `masterInboundPolicy` | `accept` | 入站策略：`accept` / `hold` / `refuse`；未知值判 `unknown-policy` 拒绝，不悄悄当成 `accept`。 |

> 注：主代理的默认模型保存在宿主的 `agent-default-model` 中，由同一个「调度模式」面板直接读写，对新创建的会话生效；子代理模型改动从下一次委派起立即生效。

## License

[MIT](LICENSE) © 2026 [SShiRkiT](https://github.com/SShiRkiT)
