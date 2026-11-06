# Secretary 交接

> 本轮复核时间 2026-11-06；复核时的 HEAD 是 `039f411`（分支 `feat/master-session`，领先 `main` 23 个提交）。这份交接单独提交为 `docs: add PROGRESS handoff for the secretary work`，所以当前 HEAD 比复核点晚一个提交，哈希以 `git log -1` 为准。
> 文中每个数字都来自本轮实跑，不是记忆。

## Goal

把 dsh-orchestrator 从「状态面板」推进到「秘书」：登记制跟踪 orchestrator 会话，每 3 分钟按模板写一份进度报告落盘，只在实质变化时向 Master 会话冒泡，卡点生成催办草稿且必须人工确认才发；客户端给一个独立秘书视图（总览 / 差异与历史 / 设置三页签）。

验收标准：
1. 全量 `node --test --test-isolation=none` 全绿（当前 573 / 0 fail）；
2. 真实宿主里能打开秘书视图：登记 / 取消登记、三页签刷新、从树跳会话、`confirmDraft` 真的投递成功；
3. 节拍在真实宿主里跑过至少三拍：落盘三份、只冒泡实质变化、2 小时封顶与「结束即停」生效；
4. dsh-Go 原生视图路线定稿（两版草图已出，是否落地待定，见 Next 1）。

## Done

1. **需求定稿** / 2026-11-06 六轮 grill 收口 / 证据：`.scratch/master-secretary/requirements.md` 56 行，§1 一句话，§9 明确推翻 handoff 两条旧决策（跟踪范围改登记制、保留独立视图）。
2. **设计简报 r3** / 三页签 + 七区块 + 五段数据字段 / 证据：`design-brief.md` 41 行（座位 main + sidebar.panellist）。
3. **spec 与十张票** / `spec.md` 76 行 28 条 user story + `issues/01`–`10` 十个文件 / 证据：`Select-String '^\*\*Status:'` 分组 → `10 × **Status:** implemented`。
4. **票 01-05 实现**（registry / beat / watch / report / archive / diff / deliver）/ 证据：`1e97d92` 16 文件 +3108 行，全量测试 496。
5. **票 06 只读端点** `orchestratorSecretary/secretaryState` / 证据：`a22ce03` +1371 行（含 `test/secretary-panel.test.mjs` 535 行），测试 515（+19）。
6. **票 07 三页签视图 + 侧栏入口** / 证据：`2a85d1e` `lib/client.js` +1741 行、`test/client.test.mjs` +683 行，测试 539（+24）。
7. **票 08 结构化差异与催办草稿** / 证据：`cb3e31f` +1191/−159，测试 556（+17）。
8. **票 10 下线旧 master 面板按钮** / 证据：`e17cd3a` `lib/client.js` −313 行、测试净减 264 行，测试 544（−12）。
9. **票 09 常驻口径注入** `ctx.systemPrompt.section` / 证据：`e6f1729` `lib/index.js` +150，测试 553（+9）。
10. **票 11 三分钟节拍与增量投递** / 证据：`a14fc85` `lib/index.js` +330、`test/secretary-runtime.test.mjs` 423 行，测试 561（+8）。
11. **硬化第一轮**（纯读端点、规划首报可重试、删掉假字段 step/lastError）/ 证据：`ee9f398` +480/−73、新增 `test/secretary-runtime.test.mjs` 89 行，测试 567（+6）。
12. **硬化第二轮**（配置键对齐、真实开关、登记表按 id 编辑）/ 证据：`ae2ec15` +526/−151（`lib/client.js` 197 行、`test/client.test.mjs` 181 行），测试 572（+5）。
13. **常量单一来源** / 证据：`27e9e94` 新增 `lib/secretary-constants.js` 38 行 + `lib/master-state.js` 25 行，测试 573（+1）。
14. **评审处置** / 6 条被否方案、7 条已知限制、1 条未验证全部落档 / 证据：`docs/adr/0010-secretary-registered-orchestrator-watcher.md` 57 行，「替代方案与不选的理由」列全 6 条（含：跟踪全部会话、模型写汇报、有变化才推、客户端解析句式、自动发催办、塞回输入区右侧）。
15. **CONTEXT.md 秘书层与基线行** / 证据：`039f411` `CONTEXT.md` +38 行（现 142 行），秘书层 9 个模块逐条定义；第 141 行写基线「HEAD `27e9e94`、全量 573（只跑 `test/*.test.mjs` 为 564）」。
16. **dsh-Go 调研与两版草图** / 证据：`.scratch/master-secretary/dshgo/sketch-a`（1 个 panel、`view.json` 8,961 B、61 节点）与 `sketch-b`（2 个 panel、主视图 3,869 B / 30 节点、日志视图 1,122 B / 7 节点，设置交给 Config 不进视图）；限制原文取自 `D:\DSH-go-t36\sdk\plugin-kit`（`lib/bridge/limits.js:7` panels 4、`:10` viewNodes 120、`:9` viewBytes 32768，`schema/view.schema.json:1153` 的 `version2Only` 含 `tabs`）。
17. **本轮基线实测** / `git status --porcelain=v1` 空；全量 `node --test --test-isolation=none` = 573 pass / 0 fail（5.6 s）；`main` 同命令 = 279，即本分支净增 294 个用例；`test/` 下 33 个测试文件，其中 `secretary-*.test.mjs` 11 个；`lib/secretary-*.js` 10 个，**没有** `lib/dshgo.js`，`package.json` 无 `dshGo` 字段、无 `engines`。

## Next

1. **现在做**：确认 dshGo 适配是否已落地并跑全量。已核实**未落地**（`lib/dshgo.js` 不存在、`package.json` 无 `dshGo`），所以这条要么补实现（先验证宿主吃 view 根 `"v": 2`，否则 `tabs` 不可用），要么在发布路径里明确排除；补完再跑 `node --test --test-isolation=none`。
2. 提交 `PROGRESS.md`（本轮已做：`git status` 只有这一个文件时提交）。
3. 决定发布路径：`feat/master-session` 比 `main` 多 23 个提交、版本仍是 0.6.6、远端 `upstream` 无推送凭据；先决定「合回 main 再发版」还是「先在本机验收再合」。
4. 视觉验收：真实宿主打开秘书视图，逐个点三页签、从树跳会话、确认一条催办草稿；ADR 0010 明确记着「秘书视图渲染与 `selectPanel` 切面、`confirmDraft` 真实投递**未验证**」。
5. 真实宿主跑节拍三拍：ADR 0010 记着 `createBeat` 在 `lib/` 内无调用方，`index.js` 只接线了触发 + 规划首报 + 归档 + 端点 + 草稿。
6. 补票 11 的 issue 文件（`.scratch/.../issues/` 只有 01–10，票 11 只存在于提交 `a14fc85`）。

## Open questions

- **dshGo 适配做不做**。改什么：新增 `lib/dshgo.js` + `package.json.dsh` 的 `dshGo` 段。证据：本轮实测文件与字段都不存在；两版草图代价不同（单面板 61 节点 vs 双面板 30+7 节点）。风险：`tabs` 属 `version2Only`，宿主若只支持 v1 则六页签方案整体作废，需重画。建议：先花一次实跑验证宿主 v2，再决定草图 A/B。
- **发布路径**。改什么：把 23 个提交合入 `main` 并发版，还是留在 feature 分支。证据：`package.json` 仍 0.6.6；`git push --dry-run` 报 `could not read Username for 'https://github.com'`（无凭据，exit 128）。风险：无凭据时任何「推送」都只是本机动作，别在文档里写成已发布。建议：先本机验收，再定远端方式。
- **归档根目录**。改什么：确认 `<工作区>/.scratch/master-secretary/reports/<会话id>/<HH-mm>.md` 是否就是要求的落点。证据：requirements §10 列为未决；ADR 0010 后果段已按此落地，对话目录名按 id。风险：路径一旦上线就不会迁移。建议：确认目录名用 id、并接受同分钟两拍互相覆盖的粒度限制。
- **CONTEXT.md 基线行滞后**。改什么：第 141 行的「HEAD `27e9e94`」应改为 `039f411`。证据：本轮 `git rev-parse --short HEAD` = `039f411`；573 这个数字仍然准确。风险：后续文档引用会拿错提交号。建议：提交 PROGRESS.md 时一并改（本轮按任务约束只写 PROGRESS.md，未改）。
- **step / lastError 要不要接真实数据源**。证据：ADR 0010 明确「暂无数据来源，端点不再返回这两项」。风险：视图的步骤与错误分支永远不可达。建议：接真实来源之前不要在前端假装有这两个字段。

## Key facts

- **插件是软链安装**：`C:\Users\admin\.dsh\profiles\superagent\package.json` 里 `"dsh-orchestrator": "link:D:/DSH orchestrator/repo"`，profile 的 `node_modules/dsh-orchestrator` 是指向本仓的 SymbolicLink。服务端 `lib/*.js` 改动走宿主 HMR（监听该链接目录）即时生效；客户端注入代码（`lib/client.js`）要刷新页面才看得到。（「监听 D:/DSH orchestrator/repo」这一条沿用既有事实，本轮未复验宿主 watch 配置。）
- **全量测试**：`node --test --test-isolation=none` = 573 pass / 0 fail（基线）；只跑 `test/*.test.mjs` = 564（少 `blueprint/test/pipeline.test.js` 的 9 个）；`package.json` 的 `npm test` 是 `node --test test/`。改动后必须跑裸命令，别用只跑 `test/` 的写法。
- **票不在 git 里**：`D:\DSH orchestrator\.scratch\master-secretary` 是仓库**外面**的目录（`git rev-parse --show-toplevel` = `D:/DSH orchestrator/repo`，`git check-ignore` 直接报 outside repository），克隆仓库拿不到 requirements / spec / 十张票 / 两版 dsh-Go 草图。
- **远端只读**：只有 `upstream` = `https://github.com/SShiRkiT/dsh-orchestrator.git`，`main` 跟踪 `upstream/main`；推送无凭据（`git push --dry-run` → `fatal: could not read Username`，exit 128）。`feat/master-session` 无 upstream 跟踪。
- **dsh-Go 原生视图硬限制**（`D:\DSH-go-t36\sdk\plugin-kit`）：每插件 panels ≤ 4；单个面板视图 32 KiB / 120 节点 / 8 层 / 每 stack 32 子节点；`tabs` 在 `version2Only` 列表里，需要视图根写 `"v": 2`；官方 SKILL.md 同样写「面板 32 KiB / 120 个组件 / 8 层」。草图 A 六页签按隐藏页签也计数，占 61 节点。
- **Config 自动渲染**：草图 B 的依据是「Config 在 App 里由宿主原生渲染」，本轮在 `D:\DSH-go-t36` 的跟踪文件里没找到该原文（`docs/plugins` 目录不存在），这条属**草图的引述，未复核**。
- **已被否决的做法**（`docs/adr/0010` 明确写了不选的理由，别重新提）：客户端按句式解析差异（模板改一句措辞客户端就静默少行 → 改结构化三组）；读端点顺带建草稿（`applyDraftTriggers` 已从读函数移出，改为挂载跑一次 + 每拍刷新，读只取快照）；每 3 分钟让模型写汇报（不可断言、成本无上界）；秘书自动发催办（跨会话投递不可逆）；跟踪本机全部会话（隐私 + 噪音）；把视图塞回 `conversation.input.right`（座位被调度模式选择器占着）。
- **改一处要连带改多处**（ADR 0010 后果段）：报告小节标题 ↔ `lib/secretary-panel.js` 的 `KIND_BY_HEADING`/`KIND_BY_LABEL`/`DIFF_GROUPS`；五类变化 ↔ `secretary-constants.js` 的 `NOTIFY_SWITCHES` + `secretary-deliver.js` 的 `KIND_LABELS` + `lib/client.js` 的 `SECRETARY_NOTIFY_NAMES`（客户端不能 import 服务端模块，镜像由 `test/client.test.mjs` 断言）；节拍缺省 ↔ beat 常量 + Config 默认值 + 端点 policy 三处。

## Verify

写完后执行这四条，原始输出贴进回报：

```powershell
git status --porcelain=v1
node --test --test-isolation=none 2>&1 | Select-Object -Last 6
(Get-Content PROGRESS.md | Measure-Object -Line).Lines
git show --stat --format='' HEAD
```
