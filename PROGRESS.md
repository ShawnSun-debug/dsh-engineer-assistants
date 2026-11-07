# Secretary 交接

> 本轮复核 2026-11-06（America/Phoenix）；HEAD `664f8d8`，分支 `feat/master-session`，`git rev-list --count upstream/main..HEAD` = 40；`git status --porcelain=v1` 为空（提交本文件前）。本文件单独提交为 `docs: record the rebuilt design and the filled view gaps`，所以提交后 HEAD 会晚一个提交，哈希以 `git log -1` 为准。
> 本轮先按规格重建丢失的 EAC 设计稿，再按它补齐视图六块（`0a9d6da` / `a9f49cf` / `664f8d8`），并把 `npm test` 修成可跑（`def1933`）；本文的行号与数字按这四个提交实读实跑。命中命令列在 Key facts 末条。

## Goal

把 dsh-orchestrator 从「状态面板」推进到「秘书」：登记制跟踪 orchestrator 会话，每 3 分钟按模板写一份进度报告落盘，只在实质变化时向 Master 会话冒泡，卡点生成催办草稿且必须人工确认才发；客户端给独立秘书视图（总览 / 差异与历史 / 设置三页签）；dsh-Go 原生侧用同一个读函数出单面板五页签视图。

验收标准：1. 全量 `node --test --test-isolation=none` 全绿，本轮 655 pass / 0 fail（`npm test` 口径 646，见 Key facts）；2. 真实宿主里能打开秘书视图：登记 / 取消登记、三页签刷新、从树跳会话、`confirmDraft` 真的投递成功；3. 节拍在真实宿主里跑过至少三拍（落盘三份、只冒泡实质变化、2 小时封顶与「结束即停」）；4. dsh-Go 原生视图已通过真实校验器，但**没有在真机 App 里打开过**（见 Open questions 3）。

## Done

1. **需求与规格链** / requirements.md 56 行（六轮 grill）、design-brief.md r3 41 行、spec.md 76 行 28 条 user story、`issues/01`–`10` 全部 implemented / 证据：`Select-String '^\*\*Status:'` 分组 = 10 × implemented。
2. **票 01–11 全部实现**（registry / beat / watch / report / archive / diff / deliver / 只读端点 / 三页签 / 差异与草稿 / 下线旧 master 面板 / 常驻口径 / 三分钟节拍）/ 证据：提交链 `1e97d92`→`a22ce03`→`2a85d1e`→`cb3e31f`→`e17cd3a`→`e6f1729`→`a14fc85`。
3. **两轮硬化 + 常量单一来源** / 纯读端点、规划首报可重试、删假字段、配置键对齐、登记表按 id 编辑 / 证据：`ee9f398`（+480/−73）、`ae2ec15`（+526/−151）、`27e9e94`（新增 `lib/secretary-constants.js` 38 行）。
4. **评审处置与 ADR** / 6 条被否方案、7 条已知限制、1 条未验证全部落档 / 证据：`docs/adr/0010-secretary-registered-orchestrator-watcher.md` 57 行。
5. **dsh-Go 适配** / 两版草图（sketch-a 1 panel/61 节点、sketch-b 2 panel）+ `lib/dshgo.js` 614 行 + `test/dshgo.test.mjs` 355 行 / 证据：`2822951`（1036 insertions）；清单 `dshGo.v` = 1、视图根 `"v": 2` 由 `aec2628` 对齐真实 schema，校验器 exit 0 输出「dsh-orchestrator 0.6.6 / 原生界面能显示（面板 1）」。
6. **调度指挥权限层与三个调度工具** / 主会话（`secretaryMasterSessionId`）拿 dispatch-command、写入类工具按名单拒绝；`secretary_command` / `secretary_interrupt` / `secretary_state`（非主会话一律拒绝为错误对象）；卡点唤醒 `secretaryWakeOnBlocked` 默认关 / 证据：`a3587e3`（净 +1191/−18）、`c35554d`（净 +912/−18），测试 605→606。
7. **合并上游 v0.7.0**（工具闸门与 UI 面板改成白名单驱动的 Allowed Tools）/ 证据：`9fcfb4d`；本仓当时的 `AllowedToolsPanel` 与渲染位在合并后的 `d567989` 里已移到 `client.js:1049`（组件）与 `client.js:1575`（设置页渲染位）。
8. **codec 收口 + PR #1 合并（已完成，从 Next 顺延到此）** / `604e8f5 fix(secretary): keep the nudge remote results JSON strict`（直接坐在 `9fcfb4d` 之上），PR #1 `MERGED`（base `fork/main`），合并提交 `0b67e35`，mergedAt `2026-11-06T17:50:48Z` / 证据：`gh pr view 1 --repo ShawnSun-debug/dsh-orchestrator --json state,mergedAt,mergeCommit`；`git ls-remote fork refs/heads/main` = `0b67e35…`，`refs/pull/1/head` = `604e8f5…`。
9. **设置入口搬进插件设置页** / `d567989 feat(client): move orchestrator settings into the plugin settings page`（+341/−205，只动 `lib/client.js` 与 `test/client.test.mjs`）。`RoutePicker` 整块删除（`test/client.test.mjs:959–960` 断言函数与 `__test` 导出都不在了），输入区从两条注册缩到一条：`conversation.input.left` / `orchestrator-plan-toggle` / order 20（`client.js:3478–3483`），`client.js:3486` 只剩一句注释说明没人再注册 `conversation.input.right`。能力没删，改成设置页整页卡片 `OrchestratorSettingsSection`（`client.js:1415`），四段：启用开关（`:1500–1520`）、三条路由（`:1521–1570`，`RouteRow` 组件在 `:1163`）、Allowed Tools 整宽卡片（`:1571–1576`）、巡检间隔（`:1577–1582`）。
10. **`settings.section` 的宿主契约** / 来源 `@deepseek-ai/dsh-client-ui-settings/lib/types/client/contract/slots.d.ts:62–77`：`kind: 'list'` / `scope: 'root'`，`id` 是导航选中键，`label` 是注册方跟随语言重注册的 thunk（宿主不订阅 locale）；先例是同一批宿主包里的 `ui-agent-preset` → `agent-presets`。注册位 `client.js:3499–3515`：`id: 'orchestrator'`、`order: 30`、`inject` 面 `{ scopes, orch, loadCatalog }`，`scopes = { main, worker, orch }` 由 `ctx.configForms.get(...)` 取（`client.js:3487`）。证据：`test/client.test.mjs:354–394` 断言四条注册的顺序与 id/order、`settings.section` 的 locale/label/组件/inject 面；全量 `node --test --test-isolation=none` **619 pass / 0 fail**（2.3 s），`test/*.test.mjs` 口径 **610 pass / 0 fail**。
11. **本轮基线** / HEAD `664f8d8`，`git rev-list --count upstream/main..HEAD` = 40；`package.json` 版本 0.8.0，最后一个 tag 仍是 `v0.6.5`；`git status --porcelain=v1` 空（提交本文件前）。
12. **设计稿丢失后按规格重建 + 六块补齐 + 测试脚本** / EAC 项目 `14e7a682`、成品 `636039a9`（`secretary-view.html`，r1，58333 字节，SHA256 `1B1119D3…99E6`）按文字规格重建；依它补六块：顶部状态条 `0a9d6da`（+459/−5）、可登记与时间线展开 `a9f49cf`（+631/−48）、权限/模型区 `664f8d8`（+219/−7）；`npm test` 改成 `node --test "test/*.test.mjs"`（`def1933`）/ 证据：`eac_design_state` 实读、三张截图 `.scratch/master-secretary/v4-overview.png` / `v4-diff.png` / `v4-settings.png`（无头浏览器 1100×900 无滚动条）、`npm test` = **646 pass / 0 fail**（2.6 s）。

## Next

1. **真机验收设置页与秘书视图（第一优先）。** `d567989` 与之后三个视图提交都只有单元测试（和设计稿截图）的证明，宿主真机一次都没打开过 —— `check.mjs --load` 只能证明宿主半侧能加载（注册工具 `dispatch`），不证明页面画得出来。动作：打开设置对话框，确认 nav 里出现 `section.title` 那一节（id `orchestrator`、order 30），点进去看四段是否都渲染；再打开秘书视图三页签、从树跳会话、`confirmDraft` 真实投递。判定口径：切进去不白屏、切走再切回状态还在、刷新页面后配置还在；任一项不成立按回归处理，回滚到 `604e8f5`。
2. **Master / Orchestrator sessions 的可行性探查（需求 3 第一步；只做可行性，不写展示）。** 用户原话「会显示 Master 或者 Orchestrator sessions 但是我没想好怎么做」。要回答四问：宿主能否枚举会话、能否区分根会话/子代理、每个会话能否拿到 cwd 与标题、能否列出「无 cwd」的 master 会话；规模上限多少。现有线索（读宿主包得出，**没跑通端到端**）：
   - `ctx.sessionQuery`（`@deepseek-ai/dsh-session-query`，`static inject = ['sessions']`）有异步 `listSessions(signal)`，过滤走 `filterSessionResults`；持久化后端 `dsh-session-query-sqlite`。
   - `cwd` 在会话头里是**可选**的绝对路径（`dsh-session`：`session header cwd must be an absolute path`），创建元数据带 `lineage` → 根 / 子代理可区分，「无 cwd」是合法状态，正好对应 Master 会话。
   - 标题来自 `dsh-session-title`；血缘可查的现成旁证：宿主 `session_search` 工具 schema 已有 `parent_session_ids` 与 `include_root_sessions`。
   - **授权要自己做**：模型侧 `dsh-tool-session-query` 只允许 cwd 完全相同的跨会话访问、无 cwd 的调用者只能看自己；插件服务端走 `ctx.sessionQuery` 绕过这层，所以别把别的会话内容漏进 UI。
   - 上限：`SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY = 4`、`SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE = 5`；模型侧 `maxSearchResults` 默认 100。`listSessions` 本身的上限未知 → 用 100 / 1000 会话实测。
   - 可跑证据：写一个**不提交**的只读探针（`node --test` 或 `node -e`），打印 `listSessions()` 首条记录的字段集与总条数，结论抄回这份文件。
   - 可行性过了再问形态（三选一：插件设置页里列 / 秘书视图加页签 / 单独一页），不先猜着做。
3. 真机 dsh-Go App 里打开「秘书」面板，五个页签逐个点一遍 —— 视图根 `"v": 2` 是否被 App 吃下来，这是唯一还没验过的关键假设。
4. 真实宿主跑节拍三拍：ADR 0010 记着 `createBeat` 在 `lib/` 内无调用方，`index.js` 只接线了触发 + 规划首报 + 归档 + 端点 + 草稿。
5. 把 `.scratch/master-secretary` 的 requirements / spec / 十张票 / dshGo 草图搬进仓库，或明确写「不搬」；补票 11 的 issue 文件（`issues/` 只有 01–10）。

## Open questions

- **README 双语文档与旧截图滞后。** 改什么：`README.md:39` 仍写「输入框下方的**「调度模式」专属面板**」、`:44` 配图 `docs/images/dispatch-panel.png`（`README.en.md:111` 同一张图），而输入区这个面板已经不存在；`README.md:92` 还在描述已删除的 Master 状态面板按钮（`README.en.md:74` 同样）。证据：本轮 grep 实测。风险：只改文字会让旧截图与正文自相矛盾，必须先重截图（或删图）再改；`:92` 那条最省事的处理是删掉，面板已由票 10 下线。建议：先重截「设置页 + 输入区」两张图，再双语一起改。
- **「设置壳只挂载当前选中 section」只有源码依据，没实机点选验证。** 改什么：`client.js:3488–3491` 的注释和 `OrchestratorSettingsSection` 的惰性 `loadCatalog`（`:1429–1445`，`groups === undefined` 才拉一次）都压在这个行为上。证据：宿主 `slots.d.ts:62–72` 只写「Sections render inside the panel content column」；在 `dsh-client-ui-settings/lib/client.js` 里 grep `selected|only|mount` 只得到 5 条无关命中，没找到「选中才挂载」的显式实现。风险：若壳其实一次性挂载全部 section，打开设置对话框就会给每个 section 各拉一次 `modelCatalog`，请求数与体积都会变重。建议：真机打开设置对话框再切 tab，数 `remote.session.modelCatalog` 的调用次数。
- **发布路径。** 改什么：合回 upstream 的方式与 0.8.0 怎么发。证据：PR #1 已 `MERGED` 进 `fork/main`（`0b67e35`，`git ls-remote fork refs/heads/main` 实测），说明 `fork` 可写；`package.json` 已是 0.8.0，而最后一个 tag 是 `v0.6.5` → 还没打 tag。本机 `git push` 的交互凭据本轮未复验。风险：无凭据时任何「推送」都只是本机动作，别在文档里写成已发布。建议：先定「fork/main 合回 upstream」还是「先本机验收」，再打 tag。
- **真机视觉仍未验。** 改什么：网页三页签与 dshGo 面板只在测试、校验器与**设计稿截图**里验过，宿主真机一次都没打开。证据：ADR 0010 的「未验证」段仍成立；`check.mjs --load` 只证明宿主半侧能加载（0 项可用、注册工具 `dispatch`），不证明面板画得出来；设计稿预览 URL 在本实例 404，所以视觉证据只有 `.scratch/master-secretary/v4-*.png`（无头浏览器 1100×900 无滚动条）与 `r1.html` 的 SHA256。风险：`selectPanel` 切面与 App 端渲染失败只会在真机暴露。建议：这几条验完之前别写成已完成。
- **`npm test` 已修好，旧数字还在文档里。** 改什么：`def1933` 把 `npm test` 从在 Node 24 下报错的写法换成 `node --test "test/*.test.mjs"`，现在 646 pass / 0 fail；裸全量 655。证据：`CONTEXT.md:141` 仍写 573/564，`blueprint/README.md:73` 仍是旧证据。风险：引用旧数字会与实跑不符。建议：下次动文档时把这两处一并更新，并写清两条口径。
- **默认开关（唤醒默认关闭）。** 改什么：`secretaryWakeOnBlocked` 默认 `false`（`lib/index.js:283`，读取在 `:1235`），卡点不会主动唤醒 Main，只有人工开开关后每会话每原因投一次。证据：`z.boolean().default(false)` 本轮 grep 实测，测试覆盖「关着时一次都不投递」。风险：默认关等于「卡住了没人知道」，与秘书定位有张力。建议：当产品决策定，别当默认值细节。
- **归档根目录。** 改什么：确认 `<工作区>/.scratch/master-secretary/reports/<会话id>/<HH-mm>.md` 是不是想要的落点。证据：requirements §10 列为未决。风险：路径上线后不会迁移。建议：确认用会话 id，并接受同分钟两拍互相覆盖的粒度。

## Key facts

- **插件是软链安装**：`C:\Users\admin\.dsh\profiles\superagent\package.json` 里 `"dsh-orchestrator": "link:D:/DSH orchestrator/repo"`，`node_modules/dsh-orchestrator` 是指向本仓的 SymbolicLink。服务端 `lib/*.js` 走宿主 HMR 即时生效；客户端注入代码（`lib/client.js`）要刷新页面才看得到。
- **测试两条口径**：`npm test` 现在就是 `node --test "test/*.test.mjs"`（`def1933` 修掉了 Node 24 下跑不起来的写法）= **646 pass / 0 fail**（2.6 s）；裸 `node --test --test-isolation=none` = **655 pass / 0 fail**，多出来的是 `blueprint/test/pipeline.test.js` 的 9 个。写数字时注明口径：`646` 不是全量。
- **设计稿预览 URL 在本实例返回 404**：`/api/design/artifacts/636039a9-…/preview` 本轮 `web_fetch` 实测 `status=404`；视觉证据以三张 `v4-*.png` 加 `r1.html` 的 SHA256 为准，别把预览链接写成能打开的页面。
- **「当前步骤」在六态投影里没有来源**：`client.js:2628–2630` 的注释写明投影今天不送 step，所以线上稳定显示 `secretary.stepNone` = 「未提供」（键在 `client.js:110`，渲染位 `:3629–3630`）；这是既定行为，不是漏填。
- **reports 端点不带正文**：`secRows(payload.reports)` 每行只有元数据，时间线行没有 body 可展开，于是走 `secretary.timelineNeedsArchive` = 「全文需在归档中查看」分支（`client.js:2684` 注释、`:3859` 渲染）。
- **设置页内容 → 配置键（行号是 `d567989` 时的；三个视图提交给 `client.js` 加了约 856 行，现文件 4908 行，行号已漂移，按符号名定位。当前锚点：`OrchestratorSettingsSection` 在 `client.js:2017`、`settings.section` 注册在 `:4765`、计划开关注册在 `:4740`）**：

  | 区块 | 源码位 | 读写的配置键 |
  |---|---|---|
  | 启用调度模式 EnableSwitch | `client.js:1500–1520`（组件 `:995`） | `orchestrator.enabled`（`index.js:153`，默认 true，volatile） |
  | ├ 主代理路由 RouteRow main | `client.js:1533–1541`（组件 `:1163`） | `agent-default-model`：`provider` / `model` / `reasoningEffort`（`client.js:375`） |
  | ├ 子代理路由 RouteRow worker | `client.js:1542–1550` | `orchestrator`：`workerProvider` / `workerModel` / `workerReasoningEffort`（`client.js:379`，`index.js:187`） |
  | ├ 评审者路由 RouteRow review | `client.js:1551–1559` | `orchestrator`：`reviewProvider` / `reviewModel` / `reviewReasoningEffort`（`client.js:385`） |
  | ├ Allowed Tools 整宽卡片 | `client.js:1571–1576`（组件 `:1049`；`:625` 注释写明 full width、无固定列） | `orchestrator.allowedTools`（`index.js:165`）+ 只读易变 `toolCatalog` |
  | └ 巡检间隔 SuperviseIntervalField | `client.js:1581`（组件 `:881`） | `orchestrator.superviseIntervalSeconds`（`index.js:208`，10–86400，默认 600） |
  | 计划开关 PlanToggle（**输入区只剩它**） | `conversation.input.left`，id `orchestrator-plan-toggle`，order 20（`client.js:3478–3483`，组件 `:319`） | 无配置键：`ctx.remote.commands.execute(sessionId, '/plan' \| '/plan off')` |
  | 秘书「设置」页签 | main 面板内 | `secretaryEnabled`（`index.js:244`）等 `secretary*` 键 |

  已经被删的：`RoutePicker`（原 `conversation.input.right`、order 11）连同它的弹层，删后没有任何注册指向 `conversation.input.right`。

- **设置页是插件自绘的，没走宿主原生 Config 表单**：`OrchestratorSettingsSection` 自己渲染四段，数据面是 `ctx.configForms.get(ns)` 取的 scope（`client.js:3487`），保存走 `scope.mutate([{ op: 'set', path: [...], value }], revision)`（`client.js:1469`）。所以之前那条「`.volatile()` 字段会不会被宿主原生表单渲染」的疑虑，对这次搬家不再成立 —— 读写全在插件手里。
- **本机两份 dsh-Go 检出**：`D:\DSH-go-t36`（HEAD `776f76c`，完整检出）与 `C:\Users\admin\dsh-Go-latest`（HEAD `def5d69`，`--filter=blob:none` 浅检出，不能当完整历史）。校验器用后者的 `sdk/plugin-kit`。
- **两份 schema 只差换行**：两个 `view.schema.json` LF 归一后 SHA256 相同（`9B175788448C61AF0B41382AF7617AC7720151F2F4041FA8F72A03AD7F023153`）；`version2Only`（latest 第 1153 行）仍含 `tabs`/`timeline`，视图根必须 `"v": 2`，清单 `dshGo.v` 固定 1。
- **dsh-Go 原生视图硬限制**：每插件 panels ≤ 4；单面板 32 KiB / 120 节点 / 8 层 / 每 stack 32 子节点；原生侧不出现 settings-input 组件（设置留在网页侧）。
- **票不在 git 里**：`D:\DSH orchestrator\.scratch\master-secretary` 在仓库外（`git rev-parse --show-toplevel` = `D:/DSH orchestrator/repo`），克隆拿不到 requirements / spec / 十张票 / 两张草图。
- **远端两个**：`fork` = `https://github.com/ShawnSun-debug/dsh-orchestrator.git`（PR #1 已合，说明可写），`upstream` = `https://github.com/SShiRkiT/dsh-orchestrator.git`；本机 `main` 落后 `upstream/main` 1 个提交（`a47e09f` 对 `a993ffe`）。
- **会话枚举的宿主面（需求 3 用）**：`dsh-session-query` / `dsh-session-query-sqlite`（`ctx.sessionQuery.listSessions`）、`dsh-session-title`（标题）、`dsh-session`（会话头 `cwd` 可选 + 元数据 `lineage`）；模型侧工具在 `dsh-tool-session-query`（带 cwd 授权层）。
- **已被否决的做法**（`docs/adr/0010` 写了理由，别重提）：客户端按句式解析差异；读端点顺带建草稿；每 3 分钟让模型写汇报；秘书自动发催办；跟踪本机全部会话；把视图塞回 `conversation.input.right`。
- **改一处要连带改多处**（ADR 0010 后果段）：报告小节标题 ↔ `secretary-panel.js` 的 `KIND_BY_HEADING`/`KIND_BY_LABEL`/`DIFF_GROUPS`；五类变化 ↔ `secretary-constants.js` 的 `NOTIFY_SWITCHES` + `secretary-deliver.js` 的 `KIND_LABELS` + `client.js` 的 `SECRETARY_NOTIFY_NAMES`（客户端不能 import 服务端模块，镜像由 `test/client.test.mjs` 断言）；节拍缺省 ↔ beat 常量 + Config 默认值 + 端点 policy 三处。
- **CONTEXT.md 基线行仍滞后**：`CONTEXT.md:141` 仍写「HEAD `27e9e94`」「573」「564」，实际是 `664f8d8` / 655（全量）/ 646（`npm test`）；本轮只改 PROGRESS.md，没动它。
- **验证命令**（本轮实际用到的）：`git status --porcelain=v1`、`git rev-parse --short HEAD`、`git rev-list --count upstream/main..HEAD`、`git show --stat d567989`、`node --test --test-isolation=none`、`node --test --test-isolation=none test/*.test.mjs`、`gh pr view <n> --repo ShawnSun-debug/dsh-orchestrator --json number,state,mergeCommit,url`、`gh api repos/SShiRkiT/dsh-orchestrator/branches --jq '.[].name'`、`npm test`、`eac_design_state`、`web_fetch <preview URL>`、`Get-FileHash r1.html -Algorithm SHA256`；dsh-Go 的 `check.mjs --load` 本轮没重跑。
