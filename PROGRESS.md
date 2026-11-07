# Secretary 交接（完整，可独立读）

> 2026-11-07 复核（America/Phoenix）。本文件由 `docs: rewrite PROGRESS as a standalone handoff` 单独提交，HEAD 请用 `git rev-parse --short HEAD` 现读（复核时的前一提交是 `e3a3ad6`，本文件不改代码）。分支 `feat/master-session`，`git rev-list --count upstream/main..HEAD` = 41（本文件提交前），`fork/main..HEAD` = 0。接手的新上下文看不到任何对话，只读这份文件与仓库；下面每个数字和行号都是本轮实跑/实读得到的，不是回忆。

## Goal

把 dsh-orchestrator 从「状态面板」推进到「秘书」：登记制跟踪 orchestrator 会话，每 3 分钟按模板落一份报告，只在实质变化时向 Master 冒泡，卡点生成必须人工确认才发的催办草稿；网页侧有秘书视图（总览 / 差异与历史 / 设置）并把设置搬进插件设置页；dsh-Go 原生侧用同一个读函数出单面板五页签。

验收标准（四条同时成立才算完成）：

1. 插件在真实宿主里能跑通秘书链路：登记 / 取消登记、三页签刷新、从树跳会话、`confirmDraft` 真的投递成功。
2. 设置页可操作：设置对话框里出现 id 为 `orchestrator` 的那一节，四段都渲染，改动能存、刷新页面后还在。
3. dsh-Go 原生清单通过校验器：`check.mjs` 与 `check.mjs --load` 都 exit 0。
4. 测试全绿：两条口径都 0 fail（命令与数字见 Key facts）。

状态：3、4 本轮实跑通过；1、2 只有单元测试与设计稿截图的证明，**真机宿主 GUI 一次都没打开过**（见 Open questions 1）。

## Done

1. **需求与规格链** / requirements.md 45 行（首行写明来自 2026-11-06 的六轮 /grill）、design-brief.md 34 行、spec.md 61 行含 28 条 user story；十张票 `issues/01`–`10` 全部 implemented / 证据：`Select-String -Path ..\.scratch\master-secretary\issues\*.md -Pattern '^\*\*Status:'` 分组 = 10 × implemented（2026-11-07 复跑确认，文件仍在）。票在仓库外：真实路径 `D:\DSH orchestrator\.scratch\master-secretary`，从仓库根看是 `..\.scratch\master-secretary`；**仓库根那个 `.scratch` 是空目录（0 项）**，拿它找证据会扑空。`git rev-parse --show-toplevel` = `D:/DSH orchestrator/repo`，上一级 `D:\DSH orchestrator` 本身不是 git 仓库，所以这些证据不进版本控制、克隆拿不到。
2. **十张票实现与节拍接线** / 十二个 `lib/secretary-*.js`（registry / beat / watch / report / archive / diff / deliver / nudge / panel / constants / tools / authority）+ `index.js` 接线；`attachSecretary`（index.js:1114）在开关关时 :1115 直接返回，节拍挂载点 index.js:2465，一拍 180 s、封顶 7200 s（secretary-beat.js:17、:20）/ 证据：提交链 `1e97d92`（01–05）→`a22ce03`（06）→`2a85d1e`（07）→`cb3e31f`（08）→`e6f1729`（09）→`e17cd3a`（10）。
3. **两轮硬化** / 纯读端点、规划首报可重试、删假字段、配置键对齐、登记表按 id 编辑 / 证据：`ee9f398`（9 文件 +480/−73）、`ae2ec15`（6 文件 +526/−151）。
4. **常量收敛** / 新增 `lib/secretary-constants.js`（38 行）作类别名的单一来源 / 证据：`27e9e94`（12 文件 +164/−68）。
5. **评审处置与 ADR** / 6 条被否方案、7 条已知限制落档 / 证据：`docs/adr/0010-secretary-registered-orchestrator-watcher.md`。
6. **上游 v0.7.0 合并与白名单语义移植** / 取上游的 `installGate({agent,allowed,catalog,enabled})`、`DEFAULT_ALLOWED_TOOLS`、`allowGuard`，把白名单里的 `delegate`/`orchestrate` 换成本 fork 的单一 `dispatch`，拒绝文案与两份 README 跟着改，reviewer / reviewGate / 参数 wire 与 dispatch-command 的认领逻辑保留 / 证据：`9fcfb4d`（21 文件 +1211/−1065）。**上游已到 v0.7.1（`95360de`，patrol count + unlimited supervision），未合**。
7. **调度指挥权限层与三个调度工具** / 主会话拿 dispatch-command，`secretary_command` / `secretary_interrupt` / `secretary_state` 非主会话一律拒绝为错误对象；卡点唤醒 `secretaryWakeOnBlocked` 默认 false（index.js:284）/ 证据：`a3587e3`（+1191/−18）、`c35554d`（+912/−18）。
8. **codec 修复（入参 wire 与 strict codec）** / `confirmDraft` / `discardDraft` 的参数必须带 `wire`、`source: 'json'`、`mode: 'strict'` 的 codec，否则 Gateway 报 `field undefined has no strict codec` 拒收 / 证据：`604e8f5`（3 文件 +189/−6），代码位 `client.js:2294–2361`。
9. **设置页迁移** / 删掉 `RoutePicker` 与 `conversation.input.right` 注册，输入区只剩 `conversation.input.left` / `orchestrator-plan-toggle` / order 20（client.js:4742）；能力搬成整页 `OrchestratorSettingsSection`（client.js:2017），`settings.section` 注册在 client.js:4761–4778（id `orchestrator`、order 30、inject `{ scopes, orch, loadCatalog }`）/ 证据：`d567989`（2 文件 +341/−205）。
10. **会话选择器与 Master 创建** / 设置页里列可登记会话、创建无工作区 Master 并写回 `secretaryMasterSessionId` / 证据：`61b5ce6`（7 文件 +1677/−13），测试 `test/secretary-sessions.test.mjs`。
11. **设计稿重建与六块补齐** / EAC 项目 `14e7a682`、成品 `636039a9`（`secretary-view.html` r1、58333 字节、SHA256 `1B1119D349CFA41C756B1FFF0C640E4449DC6F5DAB0D4ABCE6F630F2FA4799E6`）按文字规格重建；依它补顶部状态条 `0a9d6da`（+459/−5）、可登记 + 时间线展开 `a9f49cf`（+631/−48）、设置页权限/模型 `664f8d8`（+219/−7）/ 证据：`eac_design_state` 实读 + `..\.scratch\master-secretary\v4-{overview,diff,settings}.png`（三张都是 1130×995，无头浏览器截的；2026-11-07 复读 PNG 头确认）。
12. **npm test 修复** / 换成 `node --test "test/*.test.mjs"`，Node v24.21.0 下能跑 / 证据：`def1933`（1 行），`npm test` = 646 pass / 0 fail。
13. **四次 PR 与合并提交** / 全部 `MERGED` 进 `fork/main`：#1 `0b67e35`（2026-11-06T17:50:48Z）、#2 `8200f22`（18:04:06Z）、#3 `e2893e6`（2026-11-07T05:01:53Z）、#4 `f38c98b`（05:37:05Z）/ 证据：`gh pr list --repo ShawnSun-debug/dsh-orchestrator --state all --json number,state,mergeCommit,mergedAt`。
14. **CONTEXT.md 基线行纠正** / `CONTEXT.md:141` 整行替换成两条测试口径分开记（`npm test` = 646、裸全量 `node --test --test-isolation=none` = 655、差 9 个来自 `blueprint/test/pipeline.test.js`），HEAD 改成「用 `git rev-parse --short HEAD` 现读（写此行时 `025d778`）」而不是写死「当前 HEAD」——写死一次下次提交通行就过期 / 证据：`Select-String -Path CONTEXT.md -Pattern '573|564|27e9e94'` 命中 0（`MATCHES=0`）；`git diff --numstat CONTEXT.md` = `1\t1\tCONTEXT.md`；实跑 `npm test` 646 pass / 0 fail、`node --test --test-isolation=none` 655 pass / 0 fail、`blueprint/test/pipeline.test.js` 单独跑 9 pass（Node v24.21.0，2026-11-07）。两条改动（`CONTEXT.md` 1 行 + 本文件）随本次 `docs: fix the stale baseline and correct the scratch evidence paths` 一起入库，提交后工作树干净——所以别再把「未提交」当成当前状态。

## Next

**1. 修 CONTEXT.md 的过期基线行（先做这条：它是文档里提交号与用例数的基准）。** ✅ 已完成 2026-11-07，见 Done 14；下面留原始改法与验收供核对。

- 文件：`CONTEXT.md:141`。定位命令 `Select-String -Path CONTEXT.md -Pattern '基线|HEAD'`，只命中一行。
- 现状（本轮实读）：写的是「HEAD `27e9e94`」「573 个用例」「只跑后者时为 564」。
- 正确数字：HEAD 用 `git rev-parse --short HEAD` **现读**（提交本文件后已不是 `e3a3ad6`）；全量 `node --test --test-isolation=none` = 655；只跑 `test/*.test.mjs`（即 `npm test`）= 646；多出来的 9 个在 `blueprint/test/pipeline.test.js`。
- 改法：整行替换，保留「改动后请同步这一行」的语义，写明两条口径各自的命令，不要只改数字留旧命令。
- 验收：`Select-String -Path CONTEXT.md -Pattern '573|564|27e9e94'` 无输出；`git diff --numstat CONTEXT.md` 显示 1 删 1 增。
- 失败：若实跑数字与上面不符，以实跑为准，并把新数字抄回本文件 Key facts；不要为了对齐而改测试。

**2. 报告端点在 `reports[]` 里带上正文，让时间线展开有内容。**

- 现状：`lib/secretary-panel.js` 的 `fileRow`（:968–997）已经把文件读进 `body`，但只留 `kind` / `changes`，**正文被丢掉**；`composeReport`（:352–364）没有 `content` 字段，于是视图走 `secretary.timelineNeedsArchive`（client.js:151 文案、:3859 渲染）；客户端 `reportLinesOf` 已经在读 `content || body`（client.js:2686），**客户端不用改**。
- 改法：`fileRow` 保留一个有上限的正文（如 8 KiB，超出截断并带标记），`composeReport` 暴露为 `content`；端点 `listReportRows`（:1063）与拼装路径不动。
- 验收：`node --test --test-isolation=none test/secretary-panel.test.mjs` 绿，且新增一条用例断言 `composeViewState(...).reports[0].content` 含报告首行；再把端点返回里的 `reports[0]` 贴出来确认有正文。
- 失败：超预算就截断并标 `truncated`，不要用「放开上限」换通过（dsh-Go 面板有 32 KiB / 120 节点预算）。

**3. 六态投影补「步骤」来源（先可行性，再实现）。**

- 现状：`index.js:1316` 的 `projectSession` 明确写 `step: null`；`secretary-panel.js:572` 的 composeOrchestrator 刻意不返 step；客户端的 `secretaryStepOf`（client.js:2633）已兼容字符串、`{index,total}`、`{index,totalSteps}` 三种形状，只等数据。
- 唯一候选（已读宿主源码，未跑通）：`@deepseek-ai/dsh-tool-todo` 注册的 `todos` 投影（`key: "todos"`，stateSchema 为 `[{content, status}]` 或 null，`turn/start` 清空）。探针：在同一进程用 `ctx.sessionProjections.stateOf(session, 'todos')` 读一条已登记会话，打印数组、`in_progress` 的下标与总数。
- 验收：探针输出非 null 才动手。实现只在 `index.js:1316` 填 `step: { index, total }`；报告侧（secretary-report.js:115–134）与差异侧（secretary-diff.js:84–85）已经支持这种形状，不需要第二次改动。
- 失败：读不到就保持 `step: null`，把结论追加到这条下面；**不要拿 worker 数或 stage 冒充步骤**——那会让「步骤推进」变成编出来的变化（ADR 0010 已记这条理由）。

**4. 模型选择接线（先定字段形状，再写代码）。**

- 现状：policy 只有四段——`composePolicy`（secretary-panel.js:385–401）的 beatSeconds / maxRunSeconds / notifyOn / promptText，端点拼装在 index.js:1794–1800，**没有模型字段**。真实路由存在 Config 里：主代理是 `agent-default-model` 的 provider/model/reasoningEffort，worker 与 reviewer 是 `orchestrator` 的 workerProvider/workerModel/workerReasoningEffort 与 reviewProvider/reviewModel/reviewReasoningEffort（index.js:188–198，客户端读写位 client.js:499–512）。
- 先定：policy 里是否出现 `routes: { main | worker | review }`，字段名沿用 provider/model/effort，空串表示「跟随 worker」。定了形状再改端点、客户端行与 dshGo 面板（dshgo.js 也要加对应行）。
- 验收：定形状后 `node --test --test-isolation=none test/secretary-panel.test.mjs test/dshgo.test.mjs` 绿，且 `composePolicy` 的输出断言包含新字段；形状没定就**不要**先改端点。
- 失败：若决定「设置页是唯一入口、policy 不暴露路由」，这条降级成一条文档决定，只在本文件记结论，不动代码。

## Open questions

1. **真机验收（用户必须自己点）**：宿主 GUI 里打开设置对话框与秘书视图，一次都没做过。证据：`check.mjs --load` 只证明宿主半侧加载，输出「已加载宿主半侧：0 项可用；注册了工具：dispatch」并提示 `secretary has no view file and no panel("secretary") registration`（面板是运行时按开关注册的，静态检查看不到）。判定口径：切进去不白屏、切走再切回状态还在、刷新页面后配置还在、`confirmDraft` 真的投递成功；任一项不成立按回归处理，回滚到 `604e8f5`。
2. **是否把分支推 upstream**：现在 41 个代码提交全在 `fork`（外加这份文档的提交；本文件提交前 `fork/main` 与 `feat/master-session` 内容一致），`upstream/main` 停在 `95360de`（v0.7.1，比已合的 v0.7.0 新）。push 只推 fork，永不碰 upstream；推 upstream 必须由用户决定。
3. **设计稿预览 URL 在本实例 404，要不要修 EAC 侧**：本轮实测 `http://127.0.0.1:3080/api/design/artifacts/636039a9-5080-4420-ade1-7090fcec4397/preview` = 404（body 9 字节）；同一条记录里的 `content`/`download` 路径是 EAC 自己的路由。视觉证据暂以 `..\.scratch\master-secretary` 三张 `v4-*.png` 与 r1.html 的 SHA256 为准，别把预览链接写成能打开的页面。
4. **默认开关是否打开**：`secretaryEnabled` 默认 false（index.js:245），`secretaryWakeOnBlocked` 默认 false（index.js:284）。默认全关 = 卡住了没人知道，与「秘书」定位有张力；这是产品决策，不该由实现顺手改。

## Key facts

- **仓库 / 分支 / 远端**：本地 `D:\DSH orchestrator\repo`（工作目录是它的上一级）；分支 `feat/master-session`；`fork` = ShawnSun-debug/dsh-orchestrator（四个 PR 都合到这里，说明可写），`upstream` = SShiRkiT/dsh-orchestrator（只 fetch）。`upstream/main..HEAD` 在本文件提交前是 41、提交后 42（多出来的就是这份文档的提交）；`fork/main..HEAD` 同理 0 → 1。`package.json` 版本 0.8.0，最后一个 tag 仍是 `v0.6.5`。
- **两条测试口径**：`npm test`（= `node --test "test/*.test.mjs"`，37 个文件）= **646 pass / 0 fail**（2.6 s）；`node --test --test-isolation=none`（裸全量）= **655 pass / 0 fail**，多出的 9 个是 `blueprint/test/pipeline.test.js`。引用数字必须注明口径，646 不是全量。
- **插件以软链装进 profile**：`C:\Users\admin\.dsh\profiles\superagent\node_modules\dsh-orchestrator` 是 SymbolicLink → 本仓（`LinkType: SymbolicLink`）。服务端 `lib/*.js` 走宿主 HMR 即时生效；客户端 `lib/client.js` 要刷新页面才看得到。
- **dsh-Go 面板**：清单 `package.json` 的 `dshGo.v` = **1**（写成 2 会被 App 当不支持拒掉），视图根 `v: 2`（dshgo.js:202–204，因为 `tabs`/`timeline` 只在 v2 根下可用）；items 形状：`stack{type,title,children}`、`tabs{items:[{label,children}]}`、`list{items:[{title,subtitle?,trailing?,tone?}]}`、`table{columns,rows}`、`timeline{items:[{label,children?}]}`、`keyValue{items:[{label,value,tone?}]}`、`callout{tone,text}`、`actions{items:[{label,action}]}`。面板**只在 `secretaryEnabled` 为真时挂载**：`attachSecretary` 开关关时在 index.js:1115 直接返回，`mountDshGo`（dshgo.js:530）经 `ctx.inject(['dshGo'])` 注册，所以静态检查看不到 panel 注册是正常的。
- **已知缺口（三处，不要当成已完成）**：步骤无来源（index.js:1316 `step: null`）、报告端点无正文（`composeReport` 无 `content`）、模型待接（policy 无模型字段）。
- **踩过的坑**：① `installGate` / `allowGuard` 只认**纯数组**，传 `{ names: [...] }` 会抛 `(names ?? []) is not iterable`（本轮探针实测）；一旦调用方吞掉这个异常，白名单退化成空集，**所有工具被静默隐藏**（gate.js:10 写明空集等于主代理什么都拿不到）。接线时先确认拿到的是数组。② EAC 的 `.eac` 数据目录曾被覆盖一次，设计稿整份丢失、只能按文字规格重建；不要再删或覆盖 profile 下的 `.eac`。
- **改一处要连带改多处（ADR 0010）**：报告小节标题 ↔ secretary-panel.js 的 `KIND_BY_HEADING`/`KIND_BY_LABEL`/`DIFF_GROUPS`；五类变化 ↔ secretary-constants.js 的 `NOTIFY_SWITCHES` + secretary-deliver.js 的 `KIND_LABELS` + client.js 的 `SECRETARY_NOTIFY_NAMES`（客户端不能 import 服务端模块，镜像由 test/client.test.mjs 断言）；节拍缺省 ↔ beat 常量 + Config 默认值 + 端点 policy 三处。
- **已被否决的做法（别重提）**：客户端按句式解析差异；读端点顺带建草稿；每 3 分钟让模型写汇报；秘书自动发催办；跟踪本机全部会话；把视图塞回 `conversation.input.right`。
- **验证命令（本轮实际跑过的）**：`git log --oneline -8`、`git status --porcelain=v1`、`git rev-parse --short HEAD`、`git rev-list --count upstream/main..HEAD`、`npm test`、`node --test --test-isolation=none`、`node --test --test-isolation=none (Get-ChildItem test/*.test.mjs | ForEach-Object { $_.FullName })`、`node "C:\Users\admin\dsh-Go-latest\sdk\plugin-kit\bin\check.mjs" "D:\DSH orchestrator\repo"` 加 `--load`、`gh pr list --repo ShawnSun-debug/dsh-orchestrator --state all --json number,state,mergeCommit,mergedAt`、`Get-Item <profile>/node_modules/dsh-orchestrator | Select-Object LinkType,Target`、`node -v`（v24.21.0）、`web_fetch <preview URL>`（404）。
