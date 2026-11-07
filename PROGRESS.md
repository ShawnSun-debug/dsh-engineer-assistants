# Secretary 交接（完整，可独立读）

> 2026-11-07 复核（America/Phoenix）。HEAD 用 `git rev-parse --short HEAD` 现读，不要照抄。分支 `feat/master-session`；`git rev-list --count upstream/main..HEAD` 与 `fork/main..HEAD` 也用命令现读（写这段时即这三笔提交之前，分别是 43 与 2；这三笔提交后各 +3）。本轮 12 个文件已分三笔提交：一笔代码与测试（9 个文件：`lib/client.js`、`lib/dshgo.js`、`lib/index.js`、`lib/secretary-panel.js`、`test/client.test.mjs`、`test/dshgo.test.mjs`、`test/index.test.mjs`、`test/secretary-panel.test.mjs`、`test/secretary-runtime.test.mjs`），两笔文档（第一笔 3 个文档：`PROGRESS.md`、`docs/adr/0010-secretary-registered-orchestrator-watcher.md`、`CONTEXT.md`；第二笔只改 `PROGRESS.md` 里的过期计数与「未提交」表述）；合计 12 个不同文件、13 处改动（`PROGRESS.md` 在第二笔与第三笔各出现一次）；提交前 `git diff --shortstat` 合计 12 个文件 +1247 / −108，提交后工作树干净。接手的新上下文看不到任何对话，只读这份文件与仓库；下面每个数字和行号都是本轮实跑/实读得到的。

## Goal

把 dsh-orchestrator 从「状态面板」推进到「秘书」：登记制跟踪 orchestrator 会话，每 3 分钟按模板落一份报告，只在实质变化时向 Master 冒泡，卡点生成必须人工确认才发的催办草稿；网页侧有秘书视图（总览 / 差异与历史 / 设置）并把设置搬进插件设置页；dsh-Go 原生侧用同一个读函数出单面板五页签。

验收标准（四条同时成立才算完成）：

1. 插件在真实宿主里能跑通秘书链路：登记 / 取消登记、三页签刷新、从树跳会话、`confirmDraft` 真的投递成功。
2. 设置页可操作：设置对话框里出现 id 为 `orchestrator` 的那一节，四段都渲染，改动能存、刷新页面后还在。
3. dsh-Go 原生清单通过校验器：`check.mjs` 与 `check.mjs --load` 都 exit 0。
4. 测试全绿：两条口径都 0 fail（命令与数字见 Key facts）。

状态：3、4 本轮实跑通过（`check.mjs` 与 `check.mjs --load` 都 exit 0；裸全量 688 / 0、glob 口径 679 / 0）。1、2 仍只有单元测试与设计稿的证明，**真机宿主 GUI 一次都没打开过**（见 Open questions 1）。

## Done

1. **需求与规格链** / requirements.md 45 行（首行写明来自 2026-11-06 的六轮 /grill）、design-brief.md 34 行、spec.md 61 行含 28 条 user story；十张票 `issues/01`–`10` 全部 implemented / 证据：`Select-String -Path '..\.scratch\master-secretary\issues\*.md' -Pattern '^\*\*Status:'` 本轮复跑 = 10 行、10 × implemented。票在仓库外：真实路径 `D:\DSH orchestrator\.scratch\master-secretary`，从仓库根看是 `..\.scratch\master-secretary`；**仓库根那个 `.scratch` 是空目录**，拿它找证据会扑空。`git rev-parse --show-toplevel` = `D:/DSH orchestrator/repo`，上一级 `D:\DSH orchestrator` 本身不是 git 仓库，所以这些证据不进版本控制、克隆拿不到。
2. **十张票实现与节拍接线** / 十二个 `lib/secretary-*.js`（registry / beat / watch / report / archive / diff / deliver / nudge / panel / constants / tools / authority）+ `index.js` 接线；`attachSecretary`（index.js:1190）在开关关时 :1191 直接返回，调用点 index.js:2583，一拍 180 s、封顶 7200 s（secretary-beat.js:17、:20）/ 证据：提交链 `1e97d92`（01–05）→`a22ce03`（06）→`2a85d1e`（07）→`cb3e31f`（08）→`e6f1729`（09）→`e17cd3a`（10）。
3. **两轮硬化** / 纯读端点、规划首报可重试、删假字段、配置键对齐、登记表按 id 编辑 / 证据：`ee9f398`（9 文件 +480/−73）、`ae2ec15`（6 文件 +526/−151）。
4. **常量收敛** / 新增 `lib/secretary-constants.js`（38 行）作类别名的单一来源 / 证据：`27e9e94`（12 文件 +164/−68）。
5. **评审处置与 ADR** / 6 条被否方案、7 条已知限制落档 / 证据：`docs/adr/0010-secretary-registered-orchestrator-watcher.md`。
6. **上游 v0.7.0 合并与白名单语义移植** / 取上游的 `installGate({agent,allowed,catalog,enabled})`、`DEFAULT_ALLOWED_TOOLS`、`allowGuard`，把白名单里的 `delegate`/`orchestrate` 换成本 fork 的单一 `dispatch`，拒绝文案与两份 README 跟着改，reviewer / reviewGate / 参数 wire 与 dispatch-command 的认领逻辑保留 / 证据：`9fcfb4d`（21 文件 +1211/−1065）。**上游已到 v0.7.1（`95360de`，patrol count + unlimited supervision），未合**。
7. **调度指挥权限层与三个调度工具** / 主会话拿 dispatch-command，`secretary_command` / `secretary_interrupt` / `secretary_state` 非主会话一律拒绝为错误对象；卡点唤醒 `secretaryWakeOnBlocked` 默认 false（index.js:284）/ 证据：`a3587e3`（+1191/−18）、`c35554d`（+912/−18）。
8. **codec 修复（入参 wire 与 strict codec）** / `confirmDraft` / `discardDraft` 的参数必须带 `wire`、`source: 'json'`、`mode: 'strict'` 的 codec，否则 Gateway 报 `field undefined has no strict codec` 拒收 / 证据：`604e8f5`（3 文件 +189/−6），代码位 `client.js:2304–2368`。
9. **设置页迁移** / 删掉 `RoutePicker` 与 `conversation.input.right` 注册，输入区只剩 `conversation.input.left` / `orchestrator-plan-toggle` / order 20（client.js:4903–4905）；能力搬成整页 `OrchestratorSettingsSection`（client.js:2024），`settings.section` 注册在 client.js:4924–4941（id `orchestrator`、order 30、inject `{ scopes, orch, loadCatalog }`）/ 证据：`d567989`（2 文件 +341/−205）。
10. **会话选择器与 Master 创建** / 设置页里列可登记会话、创建无工作区 Master 并写回 `secretaryMasterSessionId` / 证据：`61b5ce6`（7 文件 +1677/−13），测试 `test/secretary-sessions.test.mjs`。
11. **设计稿重建与六块补齐** / EAC 项目 `14e7a682`、成品 `636039a9`（`secretary-view.html` r1、58333 字节、SHA256 `1B1119D349CFA41C756B1FFF0C640E4449DC6F5DAB0D4ABCE6F630F2FA4799E6`）按文字规格重建；依它补顶部状态条 `0a9d6da`（+459/−5）、可登记 + 时间线展开 `a9f49cf`（+631/−48）、设置页权限/模型 `664f8d8`（+219/−7）/ 证据：`eac_design_state` 实读 + `..\.scratch\master-secretary\v4-{overview,diff,settings}.png`（三张都是 1130×995，无头浏览器截的；2026-11-07 复读 PNG 头确认）。
12. **npm test 修复** / 换成 `node --test "test/*.test.mjs"`，Node v24.21.0 下能跑 / 证据：`def1933`（1 行）；当下 package.json:67 的 `test` 脚本仍是这一行，用例数见 Key facts。
13. **四次 PR 与合并提交** / 全部 `MERGED` 进 `fork/main`：#1 `0b67e35`（2026-11-06T17:50:48Z）、#2 `8200f22`（18:04:06Z）、#3 `e2893e6`（2026-11-07T05:01:53Z）、#4 `f38c98b`（05:37:05Z）/ 证据：`gh pr list --repo ShawnSun-debug/dsh-orchestrator --state all --json number,state,mergeCommit,mergedAt`（上轮实跑，本轮未复跑）。
14. **CONTEXT.md 基线行纠正** / `CONTEXT.md:141` 整行替换成两条测试口径分开记，HEAD 改成「用 `git rev-parse --short HEAD` 现读」而不是写死「当前 HEAD」——写死一次下次提交通行就过期；这一行随 `eb7a517` 入库，本轮又按新数字更新了一次（见 Key facts）/ 证据：`Select-String -Path CONTEXT.md -Pattern '573|564|27e9e94'` 命中 0；`git diff --numstat CONTEXT.md` 当时与现在都是 1 删 1 增；两条口径当时实跑 672 / 681（后一笔补了 7 条用例，现行基线见 Key facts 的 688 / 679）。
15. **报告正文入库** / `secretary-panel.js` 的 `REPORT_CONTENT_LIMIT`（:1036，8192 字节）、`clampContent`（:1050，按 UTF-8 字节截、不劈字符，切点最多回退 3 字节）、`fileRow`（:1068，返回 `content` / `contentTruncated`，:1095–1096）、`composeReport`（:371，暴露 `content` 与 `contentTruncated`，:380–381）；客户端 `reportLinesOf`（client.js:2683）读 `content || body` 与 `contentTruncated`（:2698），时间线渲染截断提示 `secretary.reportTruncated`（文案 client.js:152、渲染 :3879–3887，data-testid `orchestrator-secretary-timeline-truncated-<i>`）/ 证据：`test/secretary-panel.test.mjs` 断言 8 KiB 截断后 `contentTruncated === true`（:808–849 一段）、`test/client.test.mjs:2822–2842` 断言提示只出现在截断行。
16. **步骤来源** / `index.js` 的 `createTodosReader`（:1142）用 registry 级 `stateOf(session, 'todos')` 读宿主 todos 投影（全仓唯一一处读法，:1150），`stepOf`（:1170）钉住语义：total = 列表长度、index = 第一个 `in_progress` 的 1-based 下标、没有 in_progress 时取 completed 条数（不超过 total）；null / undefined / 抛错 / 非数组 / 空列表一律 null，不影响报告落盘与六态投影。`createStepReader`（:1185）是节拍侧（:1374 起；`projectSession` 的 step 在 :1395，原先硬编码 null）与视图端点（:1780、:1873）共用的同一份实现。`secretary-panel.js` 的 `collectOrchestratorRows` 经可选 `stepOf` 适配器填 `step`（:639、:682–689），`composeOrchestrator` 恒带 `step` 键（:340；读不到时值为 null，不是缺键），`composeStep` 归一成 `{index,total}` / 证据：`test/secretary-runtime.test.mjs` 五个用例（:527、:548、:565、:579、:593）覆盖 in_progress、仅 completed、null、undefined、抛错；`test/secretary-panel.test.mjs` 两条（step 到达行、归一化）；`test/index.test.mjs:1679–1746`（同一份 todos 投影、缺投影时键仍在值为 null）。
17. **模型路由三面接通** / `policy.routes = {main, worker, review}`，各 `{provider, model, effort}`（拼装 index.js:1905–1917，归一化 secretary-panel.js:412–415、:436–439），空串表示未设；main 由 `optionalService(ctx,'agentDefaultModel').currentSelection()` 读（index.js:1886，服务缺失 / 抛错 / 非对象只让 main 退化成空串），worker/review 读 Config 的 `workerProvider/workerModel/workerReasoningEffort` 与 `reviewProvider/reviewModel/reviewReasoningEffort`（index.js:188–198；review 留空即跟随 worker）；客户端设置页三行可编辑 `RouteRow`（client.js:1285、:4180–4198，data-testid `orchestrator-secretary-route-<key>`），写的仍是 agent-default-model 的 provider/model/reasoningEffort 与上述六个键，没有新建任何 secretary 专用存储键；同页新增卡点唤醒开关（client.js:4395–4414，读 scope 快照的 `secretaryWakeOnBlocked`、写同一键，默认仍 false）；dshGo 原生总览页三行只读路由（dshgo.js:169–175 归一化、:257–259 渲染）/ 证据：`test/index.test.mjs:2020–2093`（main 读取、缺服务 / 抛错退化）、`test/secretary-panel.test.mjs` 两条 routes 断言、`test/dshgo.test.mjs` 路由行、`test/client.test.mjs` 设置页三行与开关。
18. **复核驱动的两处修正** / ① 8 KiB 上限的注释（secretary-panel.js:1024–1035）原本声称「守住 dsh-Go 的 32 KiB 预算」，50 行满档就是 409,600 字节，因果不成立，已改成「单行上限、不是总量预算」（原文 per-row ceiling, not a total budget）；② `composeOrchestrator` 原本刻意不返 step（理由是没有数据源），ADR 0010 也写着「等有票接入真实来源再接」，现在来源已接入，故把 step 透传进面板行（:340），并把 todos 读法提到模块级 `createStepReader` 共用（index.js:1185）；ADR 0010 第 52 行同步改写 / 证据：注释段原文见 `lib/secretary-panel.js`；`test/secretary-panel.test.mjs`「the step reaches the row ...」；ADR 0010:52 已改写成 step 有 todos 来源、lastError 仍无来源。

## Next

真正剩下的只有三件（原 Next 的 1–4 已全部落在 Done 14–17，不再重复）：

**1. dsh-Go 原生面板显示步骤（先定字节预算，再实现）。**

- 现状：网页侧面板已显示 step（Done 16），原生侧全文 0 处读 step（`Select-String -Path lib/dshgo.js -Pattern 'step'` 命中 0）。别把网页侧的行为当成原生侧已具备。
- 卡点：原生视图字节余量贴边（见 Key facts 已知缺口第 2 条）：病态夹具带 routes 时 32707 字节（上限 32768，余量 61 字节）；不含 routes 时 32659 字节（余量 109 字节），再加字段很可能触发 `fitToBudget`（dshgo.js:237 调用、:458 定义）裁行。
- 文件：`lib/dshgo.js`（orchestrator 行 / timeline 行加 step 文本）+ `test/dshgo.test.mjs`（字节与节点预算用例）。
- 验收：`node --test --test-isolation=none test/dshgo.test.mjs` 绿；病态夹具字节数仍 ≤ 32768、五页签都在（`PANEL_LIMITS` 断言）。实现前先写下字节预算：新增固定字段最多多少字节、超了裁谁。
- 失败：预算定不下来就不加字段，把决定记进本文件；别用删别的行去换「显示了」。

**2. 推进四条 Open questions，重点是第 1 条真机验收。**

- 文件：无代码改动；结论写回本文件 Open questions 各自条目。
- 验收：逐条写出「做了 / 没做 + 实际输出」；真机四项（切进去不白屏、切走再切回状态在、刷新后配置在、`confirmDraft` 真投递）任一未过按回归处理。
- 失败：真机打不开就如实写「仍未验证」，不要拿单测当验收。

**3. 真机验证 `agentDefaultModel` 读取（目前只有假服务）。**

- 文件：写回本文件 Key facts 已知缺口第 4 条；若真实返回形状不同才改 `routeOfSelection`（index.js:354）。
- 验收：真实宿主里秘书视图 `policy.routes.main` 的 provider / model 与宿主自身默认模型一致；宿主未设时是空串，而不是编出来的模型名。
- 失败：若 `currentSelection()` 在真机返回 Promise 或别的形状，按实际值改读取与测试，并把结论记进本文件。

## Open questions

1. **真机验收（用户必须自己点）**：宿主 GUI 里打开设置对话框与秘书视图，一次都没做过。证据：`check.mjs --load` 只证明宿主半侧加载，本轮输出「已加载宿主半侧：0 项可用；注册了工具：dispatch」并提示 `secretary has no view file and no panel("secretary") registration`（面板是运行时按开关注册的，静态检查看不到）。判定口径：切进去不白屏、切走再切回状态还在、刷新页面后配置还在、`confirmDraft` 真的投递成功；任一项不成立按回归处理，回滚到 `604e8f5`。
2. **是否把分支合进 `fork/main`、要不要推 upstream**：`025d778`、`eb7a517`、`6d3cdfb`、`69f4164` 连同之后的两笔（0.8.3 与本次文档）**已经推到 fork 的 `feat/master-session` 分支**，远端 sha 与本地 HEAD 一致（`git ls-remote --heads fork feat/master-session` 与 `git rev-parse HEAD` 对比得到），但**都还没合进 `fork/main`**（`git merge-base --is-ancestor <sha> fork/main` 退出码非 0 即还没进）；两个计数用 `git rev-list --count upstream/main..HEAD` 与 `git rev-list --count fork/main..HEAD` 现读，不要照抄数字。`upstream/main` 停在 `95360de`（v0.7.1，比已合的 v0.7.0 新）。是否合并进 `fork/main` 由用户决定；push 只推 fork，永不碰 upstream，推 upstream 必须由用户决定。
3. **设计稿预览 URL 在本实例 404，要不要修 EAC 侧**：上轮实测 `http://127.0.0.1:3080/api/design/artifacts/636039a9-5080-4420-ade1-7090fcec4397/preview` = 404（body 9 字节，本轮未复跑）；同一条记录里的 `content`/`download` 路径是 EAC 自己的路由。视觉证据暂以 `..\.scratch\master-secretary` 三张 `v4-*.png` 与 r1.html 的 SHA256 为准，别把预览链接写成能打开的页面。
4. **默认开关是否打开（本轮已有决定）**：用户本轮决定**默认值都不动**——`secretaryEnabled` 默认 false（index.js:245）、`secretaryWakeOnBlocked` 默认 false（index.js:284），本轮只补了卡点唤醒的界面开关（Done 17），没有改默认。默认全关 = 卡住了没人知道，与「秘书」定位的张力仍在；要改仍是产品决策，不能顺手改。

## Key facts

- **仓库 / 分支 / 远端**：本地 `D:\DSH orchestrator\repo`（工作目录是它的上一级）；分支 `feat/master-session`；`fork` = ShawnSun-debug/dsh-orchestrator（四个 PR 都合到这里，说明可写），`upstream` = SShiRkiT/dsh-orchestrator（只 fetch）。HEAD 用 `git rev-parse --short HEAD` 现读；`upstream/main..HEAD` 与 `fork/main..HEAD` 用 `git rev-list --count` 现读（本笔已推到 fork 的 `feat/master-session`，但还没合进 `fork/main`）；工作树干净。`package.json` 版本 0.8.3（:3），最后一个 tag 仍是 `v0.6.5`。
- **两条测试口径（本轮实跑，Node v24.21.0）**：裸全量 `node --test --test-isolation=none` = **688 pass / 0 fail**（约 2.1 s）；glob 口径 `node --test --test-isolation=none "test/*.test.mjs"` = **679 pass / 0 fail**，差额 9 条仍全部来自 `blueprint/test/pipeline.test.js`。`package.json:67` 的 `npm test` 脚本是同一份 glob（`node --test "test/*.test.mjs"`，37 个文件），只是没有 `--test-isolation=none`；本轮环境 `npm` 不可用（`npm.ps1: Node.js runtime not found`），没直接跑 npm test。引用数字必须注明口径，679 不是全量。
- **插件以软链装进 profile**：`C:\Users\admin\.dsh\profiles\superagent\node_modules\dsh-orchestrator` 是 SymbolicLink → 本仓（`LinkType: SymbolicLink`）。服务端 `lib/*.js` 走宿主 HMR 即时生效；客户端 `lib/client.js` 要刷新页面才看得到。
- **dsh-Go 面板**：清单 `package.json:34–35` 的 `dshGo.v` = **1**（写成 2 会被 App 当不支持拒掉），视图根 `v: 2`（dshgo.js:222，因为 `tabs`/`timeline` 只在 v2 根下可用）；items 形状：`stack{type,title,children}`、`tabs{items:[{label,children}]}`、`list{items:[{title,subtitle?,trailing?,tone?}]}`、`table{columns,rows}`、`timeline{items:[{label,children?}]}`、`keyValue{items:[{label,value,tone?}]}`、`callout{tone,text}`、`actions{items:[{label,action}]}`。面板**只在 `secretaryEnabled` 为真时挂载**：`attachSecretary` 开关关时在 index.js:1191 直接返回，`mountDshGo`（dshgo.js:567）经 `ctx.inject(['dshGo'])`（:640）注册，所以静态检查看不到 panel 注册是正常的。
- **已知缺口（本轮实际遗留，不要当成已完成）**：
  - **dshGo 原生面板仍不显示步骤**：`lib/dshgo.js` 全文 0 处读取 step（grep 命中 0）；网页侧面板会显示（Done 16），原生侧不会。要补得先在字节预算上做决定。
  - **dshGo 原生面板字节余量已贴边**：本轮新增三行只读路由带来约 +159 字节固定开销；病态夹具（80 会话 + 80 报告 + 80 草稿，`test/dshgo.test.mjs:242–267`）实测带 routes 时 32707 字节（上限 32768，即 `PANEL_LIMITS.bytes`，余量 61 字节）；不含 routes 时 32659 字节（余量 109 字节）。再加内容很可能触发 `fitToBudget`（dshgo.js:458）裁行。
  - **8 KiB 是单行上限，不是总量**：50 行满档的纯正文是 409,600 字节（≈400 KiB）；含行对象开销的 JSON payload 实测 425,439 字节（≈415 KiB；实测一次，未独立复现）；任何消费方的帧预算都比它小；别拿它当总预算依据（注释已写在 secretary-panel.js:1024–1035）。
  - **`agentDefaultModel` 读取只用假服务验证过**：测试 harness 的 fake ctx 走 `ctx.get` 路径（`optionalService` 见 index.js:331），`currentSelection` 返回形状见 `test/index.test.mjs:2020–2093`；真机宿主未验证。
  - **真机 GUI 四项验收至今没做过**：切进秘书视图不白屏、切走再切回状态还在、刷新后配置还在、`confirmDraft` 真的投递成功。
  - **registry 级 `stateOf(session, key)` 是宿主已弃用 API**：首次读取每个 key 会打一条 warn；本仓沿用既有 inbox 读法的先例，未新增违规，但要知道这条告警会出现在日志里。
- **踩过的坑**：① `installGate` / `allowGuard` 只认**纯数组**，传 `{ names: [...] }` 会抛 `(names ?? []) is not iterable`（探针实测）；一旦调用方吞掉这个异常，白名单退化成空集，**所有工具被静默隐藏**（gate.js:10 写明空集等于主代理什么都拿不到）。接线时先确认拿到的是数组。② EAC 的 `.eac` 数据目录曾被覆盖一次，设计稿整份丢失、只能按文字规格重建；不要再删或覆盖 profile 下的 `.eac`。
- **改一处要连带改多处（ADR 0010）**：报告小节标题 ↔ secretary-panel.js 的 `KIND_BY_HEADING`/`KIND_BY_LABEL`/`DIFF_GROUPS`；五类变化 ↔ secretary-constants.js 的 `NOTIFY_SWITCHES` + secretary-deliver.js 的 `KIND_LABELS` + client.js 的 `SECRETARY_NOTIFY_NAMES`（客户端不能 import 服务端模块，镜像由 test/client.test.mjs 断言）；节拍缺省 ↔ beat 常量 + Config 默认值 + 端点 policy 三处；步骤语义 ↔ index.js 的 `stepOf`（total / index / 空）实现 + test/secretary-runtime.test.mjs 五个用例 + 面板 `composeStep` 的归一形状。
- **已被否决的做法（别重提）**：客户端按句式解析差异；读端点顺带建草稿；每 3 分钟让模型写汇报；秘书自动发催办；跟踪本机全部会话；把视图塞回 `conversation.input.right`。
- **验证命令（本轮实际跑过的）**：`git rev-parse --short HEAD`、`git status --porcelain`、`git diff --stat`、`git describe --tags --abbrev=0`、`git log --oneline -6`、`git rev-list --count upstream/main..HEAD` 与 `fork/main..HEAD`、`node -v`（v24.21.0）、`node --test --test-isolation=none`（688 / 0）、`node --test --test-isolation=none "test/*.test.mjs"`（679 / 0）、`node "C:\Users\admin\dsh-Go-latest\sdk\plugin-kit\bin\check.mjs" "D:\DSH orchestrator\repo"` 加 `--load`（都 exit 0）、`Select-String -Path '..\.scratch\master-secretary\issues\*.md' -Pattern '^\*\*Status:'`（10 × implemented）、`grep` 核验旧句子（旧缺口标题、旧测试数字）命中 0、`git diff --stat -- PROGRESS.md docs/adr CONTEXT.md`。上一轮跑过、本轮未复跑：`gh pr list ...`（Done 13）、`Get-Item <profile>/node_modules/dsh-orchestrator | Select-Object LinkType,Target`、`web_fetch <preview URL>`（404）、`npm test`（本轮 npm 不可用）。
