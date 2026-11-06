# Secretary 交接

> 本轮复核 2026-11-06（America/Phoenix）；HEAD `604e8f5`，分支 `feat/master-session`，`git rev-list --count upstream/main..HEAD` = 32；`git status --porcelain=v1` 为空（提交本文件前）。本文件单独提交为 `docs: record the UI consolidation and session-listing requirements`，所以提交后 HEAD 会晚一个提交，哈希以 `git log -1` 为准。
> 本轮按任务约束只改这份文件，没动代码。文中每个数字与本轮状态都来自实跑或实读，命中命令列在 Key facts 末条。

## Goal

把 dsh-orchestrator 从「状态面板」推进到「秘书」：登记制跟踪 orchestrator 会话，每 3 分钟按模板写一份进度报告落盘，只在实质变化时向 Master 会话冒泡，卡点生成催办草稿且必须人工确认才发；客户端给独立秘书视图（总览 / 差异与历史 / 设置三页签）；dsh-Go 原生侧用同一个读函数出单面板五页签视图。

验收标准：1. 全量 `node --test --test-isolation=none` 全绿，本轮 616 pass / 0 fail（3.9 s）；2. 真实宿主里能打开秘书视图：登记 / 取消登记、三页签刷新、从树跳会话、`confirmDraft` 真的投递成功；3. 节拍在真实宿主里跑过至少三拍（落盘三份、只冒泡实质变化、2 小时封顶与「结束即停」）；4. dsh-Go 原生视图已通过真实校验器，但**没有在真机 App 里打开过**（见 Open questions 3）。

## Done

1. **需求与规格链** / requirements.md 56 行（六轮 grill）、design-brief.md r3 41 行、spec.md 76 行 28 条 user story、`issues/01`–`10` 全部 implemented / 证据：`Select-String '^\*\*Status:'` 分组 = 10 × implemented。
2. **票 01–11 全部实现**（registry / beat / watch / report / archive / diff / deliver / 只读端点 / 三页签 / 差异与草稿 / 下线旧 master 面板 / 常驻口径 / 三分钟节拍）/ 证据：提交链 `1e97d92`→`a22ce03`→`2a85d1e`→`cb3e31f`→`e17cd3a`→`e6f1729`→`a14fc85`。
3. **两轮硬化 + 常量单一来源** / 纯读端点、规划首报可重试、删假字段、配置键对齐、登记表按 id 编辑 / 证据：`ee9f398`（+480/−73）、`ae2ec15`（+526/−151）、`27e9e94`（新增 `lib/secretary-constants.js` 38 行）。
4. **评审处置与 ADR** / 6 条被否方案、7 条已知限制、1 条未验证全部落档 / 证据：`docs/adr/0010-secretary-registered-orchestrator-watcher.md` 57 行。
5. **dsh-Go 适配** / 两版草图（sketch-a 1 panel/61 节点、sketch-b 2 panel）+ `lib/dshgo.js` 614 行 + `test/dshgo.test.mjs` 355 行 / 证据：`2822951`（1036 insertions）；清单 `dshGo.v` = 1、视图根 `"v": 2` 由 `aec2628` 对齐真实 schema，校验器 exit 0 输出「dsh-orchestrator 0.6.6 / 原生界面能显示（面板 1）」。
6. **调度指挥权限层与三个调度工具** / 主会话（`secretaryMasterSessionId`）拿 dispatch-command、写入类工具按名单拒绝；`secretary_command` / `secretary_interrupt` / `secretary_state`（非主会话一律拒绝为错误对象）；卡点唤醒 `secretaryWakeOnBlocked` 默认关 / 证据：`a3587e3`（净 +1191/−18）、`c35554d`（净 +912/−18），测试 605→606。
7. **合并上游 v0.7.0**（工具闸门与 UI 面板改成白名单驱动的 Allowed Tools）/ 证据：`9fcfb4d`；本仓已有 `client.js:1069` `AllowedToolsPanel`、渲染位 `client.js:1557`。
8. **codec 收口 + PR #1 合并（已完成，从 Next 顺延到此）** / `604e8f5 fix(secretary): keep the nudge remote results JSON strict`（直接坐在 `9fcfb4d` 之上），PR #1 `MERGED`（base `fork/main`），合并提交 `0b67e35`，mergedAt `2026-11-06T17:50:48Z` / 证据：`gh pr view 1 --repo ShawnSun-debug/dsh-orchestrator --json state,mergedAt,mergeCommit`；`git ls-remote fork refs/heads/main` = `0b67e35…`，`refs/pull/1/head` = `604e8f5…`。
9. **本轮基线** / HEAD `604e8f5`；`package.json` 版本 0.8.0，最后一个 tag 仍是 `v0.6.5`；全量 616 pass / 0 fail（3.9 s）；`git status --porcelain=v1` 空。

## Next

1. **先确认需求 1 是 (a) 还是 (b)，再动手（必须确认，不许猜）。** 用户原话：「我不想要原本的这个调度模式再出现了」。输入区有两个候选，先让用户指认哪一个：
   - 「计划」开关：`conversation.input.left`、id `orchestrator-plan-toggle`、order 20（`lib/client.js:3453–3458`，标签 `toggle.label: '计划'` 在 `client.js:13`）。它只是把宿主的 `/plan` 命令做成按钮，宿主自己的 plan chip 占着 `conversation.input.plan`（`client.js:3450–3452` 的注释），删它是纯减法。
   - 「调度模式」按钮：`conversation.input.right`、id `orchestrator-route-picker`、order 11（`client.js:3461–3476`，标签 `route.button: '调度模式'` 在 `client.js:24`）。用户措辞最匹配这个；而它是本插件在输入区**唯一**的设置入口（弹层里是启用开关 + 三条路由 + 巡检间隔 + Allowed Tools）。
   - **(a) 只改界面**：改动点 `lib/client.js`（locale `24`/`44`/`45`/`52`–`56`、控件体 `1396–1561`、注册位 `3461–3476`、`__test` 导出 `3551–3570`）+ `test/client.test.mjs`。删按钮之后必须先回答「启用调度模式」开关去哪：固化常开，还是搬进 Config —— 否则用户就没有地方关这个插件了。
   - **(b) 改范式**（主代理只计划、全部交给 worker 派发）：等于拆插件核心，要重写 `lib/gate.js`、`lib/rules.js`、`lib/dispatch.js` 三处外加 `lib/index.js` 接线，先改设计再谈。
2. **需求 2：把输入区控件收敛到插件设置页。** 用户要「一起在插件设置里设置好和配置好」。控件与配置键已经盘点完（见 Key facts 的控件表）：除计划开关外**全部是 Config 键**，所以这是渲染位置搬家，不是新建存储。步骤：① 先验证宿主原生 Config 表单是否渲染 `.volatile()` 字段（本仓这些键几乎都标了 volatile，本轮未验证）；② 能原生渲染的标量（`enabled`、`superviseIntervalSeconds`、`secretary*`）下沉到 Config，选不动的（路由要模型目录、Allowed Tools 要工具目录）留在秘书视图「设置」页签或新设置页；③ 上游 v0.7.0 的白名单面板**已经合进本仓**（`9fcfb4d`），动手前复核 `client.js:1069` 与 `client.js:1557` 及 `test/client.test.mjs` 里 allowed* 的断言，不要再按「等上游合并」处理。
3. **需求 3 第一步：只做可行性，不写展示。** 用户原话「会显示 Master 或者 Orchestrator sessions 但是我没想好怎么做」，明确要求第一件事是测可行性。要回答四问：宿主能否枚举会话、能否区分根会话/子代理、每个会话能否拿到 cwd 与标题、能否列出「无 cwd」的 master 会话；规模上限多少。现有线索（本轮读宿主包得出，**未跑通端到端**）：
   - `ctx.sessionQuery`（`@deepseek-ai/dsh-session-query`，`static inject = ['sessions']`）有异步 `listSessions(signal)`，过滤走 `filterSessionResults`；持久化后端 `dsh-session-query-sqlite`。
   - `cwd` 在会话头里是**可选**的绝对路径（`dsh-session`：`session header cwd must be an absolute path`），创建元数据带 `lineage` → 根 / 子代理可区分，「无 cwd」是合法状态，正好对应 Master 会话。
   - 标题来自 `dsh-session-title`；血缘可查的现成旁证：宿主 `session_search` 工具 schema 已有 `parent_session_ids` 与 `include_root_sessions`。
   - **授权要自己做**：模型侧 `dsh-tool-session-query` 只允许 cwd 完全相同的跨会话访问、无 cwd 的调用者只能看自己；插件服务端走 `ctx.sessionQuery` 绕过这层，所以别把别的会话内容漏进 UI。
   - 上限：`SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY = 4`、`SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE = 5`；模型侧 `maxSearchResults` 默认 100。`listSessions` 本身的上限未知 → 用 100 / 1000 会话实测。
   - 可跑证据：写一个**不提交**的只读探针（`node --test` 或 `node -e`），打印 `listSessions()` 首条记录的字段集与总条数，结论抄回这份文件。
4. **需求 3 第二步：可行性过了再问形态，不先猜着做。** 要问清三选一：插件设置页里列 / 秘书视图里加页签 / 单独一页；顺带问 Master 与 orchestrator 要不要放进同一个列表、要不要按 cwd 分组。
5. 真机 dsh-Go App 里打开「秘书」面板，五个页签逐个点一遍 —— 视图根 `"v": 2` 是否被 App 吃下来，这是唯一还没验过的关键假设。
6. 真实宿主跑节拍三拍：ADR 0010 记着 `createBeat` 在 `lib/` 内无调用方，`index.js` 只接线了触发 + 规划首报 + 归档 + 端点 + 草稿。
7. 网页三页签、从树跳会话、`confirmDraft` 真实投递仍是**未验证**（ADR 0010 原文）。
8. 把 `.scratch/master-secretary` 的 requirements / spec / 十张票 / dshGo 草图搬进仓库，或明确写「不搬」；补票 11 的 issue 文件（`issues/` 只有 01–10）。

## Open questions

- **调度模式入口的 (a)/(b) 歧义（必须确认，不能默认）。** 改什么：只删界面入口，还是改工作范式。证据：`route.button: '调度模式'`（`client.js:24`）是按钮，`toggle.label: '计划'`（`client.js:13`）是另一个，两条都在输入区，措辞只匹配前者。判断依据：用户只是嫌界面吵 → (a)，改动点见 Next 1 第一条；要改范式 → (b)，得重写 `gate` / `rules` / `dispatch` 三处。风险：猜错方向会把「删一个按钮」变成「拆插件核心」。
- **发布路径。** 改什么：合回 upstream 的方式与 0.8.0 怎么发。证据：PR #1 已 `MERGED` 进 `fork/main`（`0b67e35`，`git ls-remote fork refs/heads/main` 实测），说明 `fork` 可写；`package.json` 已是 0.8.0，而最后一个 tag 是 `v0.6.5` → 还没打 tag。本机 `git push` 的交互凭据本轮未复验。风险：无凭据时任何「推送」都只是本机动作，别在文档里写成已发布。建议：先定「fork/main 合回 upstream」还是「先本机验收」，再打 tag。
- **真机视觉未验。** 改什么：网页三页签与 dshGo 面板都只在测试与校验器里验过。证据：ADR 0010 的「未验证」段仍成立；`check.mjs --load` 只证明宿主半侧能加载（0 项可用、注册工具 `dispatch`），不证明面板画得出来。风险：`selectPanel` 切面与 App 端渲染失败只会在真机暴露。建议：这几条验完之前别写成已完成。
- **默认开关（唤醒默认关闭）。** 改什么：`secretaryWakeOnBlocked` 默认 `false`（`lib/index.js:283`，读取在 `:1235`），卡点不会主动唤醒 Main，只有人工开开关后每会话每原因投一次。证据：`z.boolean().default(false)` 本轮 grep 实测，测试覆盖「关着时一次都不投递」。风险：默认关等于「卡住了没人知道」，与秘书定位有张力。建议：当产品决策定，别当默认值细节。
- **归档根目录。** 改什么：确认 `<工作区>/.scratch/master-secretary/reports/<会话id>/<HH-mm>.md` 是不是想要的落点。证据：requirements §10 列为未决。风险：路径上线后不会迁移。建议：确认用会话 id，并接受同分钟两拍互相覆盖的粒度。

## Key facts

- **插件是软链安装**：`C:\Users\admin\.dsh\profiles\superagent\package.json` 里 `"dsh-orchestrator": "link:D:/DSH orchestrator/repo"`，`node_modules/dsh-orchestrator` 是指向本仓的 SymbolicLink。服务端 `lib/*.js` 走宿主 HMR 即时生效；客户端注入代码（`lib/client.js`）要刷新页面才看得到。
- **测试两条口径**：裸 `node --test --test-isolation=none` = 616 pass / 0 fail；只跑 `test/*.test.mjs` 会少 `blueprint/test/pipeline.test.js` 的 9 个。写数字时注明是哪条口径。
- **输入区控件 → 配置键（需求 2 的盘点结果，全部实读）**：

  | 控件 | 注册位 / 源码 | 读写的配置键 |
  |---|---|---|
  | 调度模式按钮 RoutePicker | `conversation.input.right`，id `orchestrator-route-picker`，order 11（`client.js:3461–3476`） | 自身无键 |
  | ├ 启用调度模式 EnableSwitch | 弹层内（`client.js:1498`） | `orchestrator.enabled`（`index.js:153`，默认 true，volatile） |
  | ├ 主代理路由 | 弹层 `RouteRow` main | `agent-default-model`：`provider` / `model` / `reasoningEffort`（`client.js:375`） |
  | ├ 子代理路由 | 弹层 `RouteRow` worker | `orchestrator`：`workerProvider` / `workerModel` / `workerReasoningEffort`（`client.js:379`，`index.js:187`） |
  | ├ 评审者路由 | 弹层 `RouteRow` review | `orchestrator`：`reviewProvider` / `reviewModel` / `reviewReasoningEffort`（`client.js:385`） |
  | ├ 巡检间隔 SuperviseIntervalField | `client.js:901`，渲染 `:1550` | `orchestrator.superviseIntervalSeconds`（`index.js:208`，10–86400，默认 600） |
  | └ Allowed Tools（上游 v0.7.0 白名单） | `client.js:1069`，渲染 `:1557` | `orchestrator.allowedTools`（`index.js:165`）+ 只读易变 `toolCatalog` |
  | 计划开关 PlanToggle | `conversation.input.left`，id `orchestrator-plan-toggle`，order 20（`client.js:3453–3458`） | 无配置键：`ctx.remote.commands.execute(sessionId, '/plan' \| '/plan off')` |
  | 秘书「设置」页签 | main 面板内 | `secretaryEnabled`（`index.js:244`）等 `secretary*` 键 |

- **Config 自动原生渲染未复核**：草图 B 与需求 2 都建立在「Config 由宿主原生渲染」上，`D:\DSH-go-t36` 的跟踪文件里仍没找到原文；`.volatile()` 字段是否被原生表单渲染，本轮未验证 —— 这是需求 2 的第一个动作。
- **本机两份 dsh-Go 检出**：`D:\DSH-go-t36`（HEAD `776f76c`，完整检出）与 `C:\Users\admin\dsh-Go-latest`（HEAD `def5d69`，`--filter=blob:none` 浅检出，不能当完整历史）。校验器用后者的 `sdk/plugin-kit`。
- **两份 schema 只差换行**：两个 `view.schema.json` LF 归一后 SHA256 相同（`9B175788448C61AF0B41382AF7617AC7720151F2F4041FA8F72A03AD7F023153`）；`version2Only`（latest 第 1153 行）仍含 `tabs`/`timeline`，视图根必须 `"v": 2`，清单 `dshGo.v` 固定 1。
- **dsh-Go 原生视图硬限制**：每插件 panels ≤ 4；单面板 32 KiB / 120 节点 / 8 层 / 每 stack 32 子节点；原生侧不出现 settings-input 组件（设置留在网页侧）。
- **票不在 git 里**：`D:\DSH orchestrator\.scratch\master-secretary` 在仓库外（`git rev-parse --show-toplevel` = `D:/DSH orchestrator/repo`），克隆拿不到 requirements / spec / 十张票 / 两张草图。
- **远端两个**：`fork` = `https://github.com/ShawnSun-debug/dsh-orchestrator.git`（PR #1 已合，说明可写），`upstream` = `https://github.com/SShiRkiT/dsh-orchestrator.git`；本机 `main` 落后 `upstream/main` 1 个提交（`a47e09f` 对 `a993ffe`）。
- **会话枚举的宿主面（需求 3 用）**：`dsh-session-query` / `dsh-session-query-sqlite`（`ctx.sessionQuery.listSessions`）、`dsh-session-title`（标题）、`dsh-session`（会话头 `cwd` 可选 + 元数据 `lineage`）；模型侧工具在 `dsh-tool-session-query`（带 cwd 授权层）。
- **已被否决的做法**（`docs/adr/0010` 写了理由，别重提）：客户端按句式解析差异；读端点顺带建草稿；每 3 分钟让模型写汇报；秘书自动发催办；跟踪本机全部会话；把视图塞回 `conversation.input.right`。
- **改一处要连带改多处**（ADR 0010 后果段）：报告小节标题 ↔ `secretary-panel.js` 的 `KIND_BY_HEADING`/`KIND_BY_LABEL`/`DIFF_GROUPS`；五类变化 ↔ `secretary-constants.js` 的 `NOTIFY_SWITCHES` + `secretary-deliver.js` 的 `KIND_LABELS` + `client.js` 的 `SECRETARY_NOTIFY_NAMES`（客户端不能 import 服务端模块，镜像由 `test/client.test.mjs` 断言）；节拍缺省 ↔ beat 常量 + Config 默认值 + 端点 policy 三处。
- **CONTEXT.md 基线行仍滞后**：`CONTEXT.md:141` 仍写「HEAD `27e9e94`」「573」，实际是 `604e8f5` / 616；本轮按任务约束只改 PROGRESS.md，没动它。
- **验证命令**（本轮实际用到的）：`git status --porcelain=v1`、`git rev-parse --short HEAD`、`git rev-list --count upstream/main..HEAD`、`git ls-remote fork`、`gh pr view 1 --repo ShawnSun-debug/dsh-orchestrator --json state,mergedAt,mergeCommit`、`node --test --test-isolation=none`、`node 'C:\Users\admin\dsh-Go-latest\sdk\plugin-kit\bin\check.mjs' 'D:\DSH orchestrator\repo'`（最后一条本轮未重跑）。
