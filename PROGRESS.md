# Secretary 交接

> 本轮复核时间 2026-11-06；复核时的 HEAD 是 `c35554d`（分支 `feat/master-session`，领先 `upstream/main` 29 个提交，`git rev-list --count` 实测）。这份交接单独提交为 `docs: refresh the PROGRESS handoff after the dshgo and authority work`，所以提交后 HEAD 会晚一个提交，哈希以 `git log -1` 为准。
> 文中每个数字都来自本轮实跑，不是记忆。

## Goal

把 dsh-orchestrator 从「状态面板」推进到「秘书」：登记制跟踪 orchestrator 会话，每 3 分钟按模板写一份进度报告落盘，只在实质变化时向 Master 会话冒泡，卡点生成催办草稿且必须人工确认才发；客户端给一个独立秘书视图（总览 / 差异与历史 / 设置三页签）；dsh-Go 原生侧用同一个读函数出单面板五页签视图。

验收标准：
1. 全量 `node --test --test-isolation=none` 全绿（本轮 615 / 0 fail；只跑 `test/*.test.mjs` 是 606）；
2. 真实宿主里能打开秘书视图：登记 / 取消登记、三页签刷新、从树跳会话、`confirmDraft` 真的投递成功；
3. 节拍在真实宿主里跑过至少三拍：落盘三份、只冒泡实质变化、2 小时封顶与「结束即停」生效；
4. dsh-Go 原生视图已落地并通过真实校验器（面板 1），但**没有在真机 App 里打开过**（见 Next 1）。

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
14. **评审处置** / 6 条被否方案、7 条已知限制、1 条未验证全部落档 / 证据：`docs/adr/0010-secretary-registered-orchestrator-watcher.md` 57 行，「替代方案与不选的理由」列全 6 条。
15. **CONTEXT.md 秘书层与基线行** / 证据：`039f411` `CONTEXT.md` +38 行（现 142 行），秘书层 9 个模块逐条定义；第 141 行仍是旧基线（滞后，见 Open questions）。
16. **dsh-Go 调研与两版草图** / 证据：`.scratch/master-secretary/dshgo/sketch-a`（1 个 panel、61 节点）与 `sketch-b`（2 个 panel、主视图 30 节点 + 日志 7 节点）；硬限制原文取自 `sdk/plugin-kit` 的 `lib/bridge/limits.js`（panels 4、viewNodes 120、viewBytes 32768）。
17. **dshGo 适配落地** / `2822951`：`package.json` 的 `dshGo` 段 + `lib/dshgo.js` 614 行 + `cordis.patch.yml` 5 行 + `test/dshgo.test.mjs` 355 行 / 证据：`git show --stat` = 1036 insertions。
18. **按真实 schema 修正并通过校验** / `aec2628`：清单 `dshGo.v` = 1（与视图根是两个数，写 2 会被 App 拒）、视图根写 `"v": 2`（`tabs`/`timeline` 属 `version2Only`）、`tabs`/`keyValue`/`list`/`timeline`/`actions` 的 items 形状对齐宿主方言 / 证据：`lib/dshgo.js` 69 行改动 + `package.json` 4 行；真实校验器 `check.mjs`（取 `C:\Users\admin\dsh-Go-latest\sdk\plugin-kit`）exit 0，输出「dsh-orchestrator 0.6.6 / 原生界面能显示（面板 1）」。
19. **调度指挥权限层** / `a3587e3`：主会话（`secretaryMasterSessionId`）拿到 dispatch-command —— 写入类工具按名单拒绝、读保持开放；取消开关或改指派即恢复默认闸门 / 证据：`lib/secretary-authority.js` 480 行 + `lib/index.js` +282 + 两个测试文件 447 行，净 +1191/−18。
20. **Master 三个调度工具 + 卡点唤醒** / `c35554d`：`secretary_command` / `secretary_interrupt` / `secretary_state`（非主会话一律拒绝为错误对象、不抛），加 `secretaryWakeOnBlocked`（默认关，每会话每原因只投一次） / 证据：`lib/secretary-tools.js` 429 行 + `test/secretary-tools.test.mjs` 327 行 + `lib/index.js` 174 行，净 +912/−18；测试 605 → 606（子集口径）。
21. **最新 schema 比对结论** / `D:\DSH-go-t36`（`776f76c`）与 `C:\Users\admin\dsh-Go-latest`（`def5d69`）的 `sdk/plugin-kit/schema/view.schema.json` 换行归一后 SHA256 完全相同（`9B175788448C61AF0B41382AF7617AC7720151F2F4041FA8F72A03AD7F023153`）；实际差异只有 CRLF（latest 1191 处、t36 0 处）。`x-dsh-go.version2Only`（latest 第 1153 行）仍含 `tabs` 与 `timeline`，所以视图根仍必须 `"v": 2`。
22. **本轮基线实测** / `git status --porcelain=v1` 空；全量 615 pass / 0 fail（3.3 s），`test/*.test.mjs` 子集 606 / 0 fail（3.2 s）；`test/` 下 36 个测试文件；`lib/secretary-*.js` 12 个 + `lib/dshgo.js`（24,029 B）；`package.json` 版本仍 0.6.6，已有 `dshGo` 与 `engines` 段。
23. **探测途中被并行 worker 提交** / 本轮第一次 `git status` 看到 `M lib/index.js` + `?? lib/secretary-tools.js` + `?? test/secretary-tools.test.mjs`；几分钟后再查已是 `c35554d`、工作区干净。所以第 20 条是**已入库**状态，不是未提交改动。

## Next

1. **下一步该做什么**：在真机 dsh-Go App 里打开「秘书」面板，五个页签逐个点一遍 —— 这是唯一还没验证过的关键假设（视图根 `"v": 2` 是否被 App 吃下来，点一次就有答案）。
2. 决定发布路径：`feat/master-session` 比 `upstream/main` 多 29 个提交、版本仍是 0.6.6、远端无推送凭据；先定「合回 main 再发版」还是「先本机验收再合」。
3. 真实宿主跑节拍三拍：ADR 0010 记着 `createBeat` 在 `lib/` 内无调用方，`index.js` 只接线了触发 + 规划首报 + 归档 + 端点 + 草稿。
4. 网页视图视觉验收：三页签、从树跳会话、`confirmDraft` 真实投递仍是**未验证**（ADR 0010 原文）。
5. 把 `.scratch/master-secretary` 的 requirements / spec / 十张票 / dshGo 草图搬进仓库，或明确写「不搬」。
6. 补票 11 的 issue 文件（`.scratch/.../issues/` 只有 01–10，票 11 只存在于提交 `a14fc85`）。

## Open questions

- **发布路径（无推送凭据）**。改什么：29 个提交合入 `main` 并发版，还是留在 feature 分支。证据：`package.json` 仍 0.6.6；`git push --dry-run` 报 `could not read Username for 'https://github.com'`（exit 128）。风险：无凭据时任何「推送」都只是本机动作，别在文档里写成已发布。建议：先本机验收，再定远端方式。
- **`.scratch` 未纳入 git**。改什么：`D:\DSH orchestrator\.scratch\master-secretary` 在仓库外（`git rev-parse --show-toplevel` = `D:/DSH orchestrator/repo`），克隆仓库拿不到 requirements / spec / 十张票 / 两版 dshGo 草图。风险：换机或重克隆即丢交接链。建议：把定稿文档搬进 `docs/`，草图留在仓库外。
- **真机视觉未验**。改什么：网页三页签与 dshGo 面板都只在测试与校验器里验过，没在真机点过。证据：ADR 0010 的「未验证」段仍成立；`check.mjs --load` 只证明宿主半侧能加载（0 项可用、注册工具 `dispatch`），不证明面板画得出来。风险：`selectPanel` 切面与 App 端渲染失败只会在真机暴露。建议：Next 1 之前别把这条写成已完成。
- **驱动器（唤醒默认关闭）**。改什么：`secretaryWakeOnBlocked` 默认 `false`（`lib/index.js:310`），卡点不会主动唤醒 Main，只有人工开开关后每会话每原因投一次。证据：本轮 grep 实测默认值，测试覆盖「关着时一次都不投递」。风险：默认关等于「卡住了没人知道」，与秘书的定位有张力。建议：当产品决策定，别当默认值细节。
- **归档根目录**。改什么：确认 `<工作区>/.scratch/master-secretary/reports/<会话id>/<HH-mm>.md` 是否就是要的落点。证据：requirements §10 列为未决。风险：路径上线后不会迁移。建议：确认目录名用 id，并接受同分钟两拍互相覆盖的粒度。
- **CONTEXT.md 基线行滞后**。改什么：`CONTEXT.md` 第 141 行仍写「HEAD `27e9e94`」与「573」，应改为 `c35554d` / 606。证据：本轮 `git rev-parse --short HEAD` = `c35554d`、子集 606。（本轮按任务约束只写 PROGRESS.md，未改。）

## Key facts

- **插件是软链安装**：`C:\Users\admin\.dsh\profiles\superagent\package.json` 里 `"dsh-orchestrator": "link:D:/DSH orchestrator/repo"`，profile 的 `node_modules/dsh-orchestrator` 是指向本仓的 SymbolicLink。服务端 `lib/*.js` 走宿主 HMR 即时生效；客户端注入代码（`lib/client.js`）要刷新页面才看得到。（宿主 watch 配置本轮未复验。）
- **全量测试两条口径**：裸 `node --test --test-isolation=none` = 615 pass / 0 fail；只跑 `test/*.test.mjs` = 606（少 `blueprint/test/pipeline.test.js` 的 9 个）。改动后按任务口径跑子集，但别把 606 写成「全量」。
- **本机两份 dsh-Go 检出**：`D:\DSH-go-t36`（HEAD `776f76c`，工作区干净，完整检出）与 `C:\Users\admin\dsh-Go-latest`（HEAD `def5d69`，工作区干净）。校验器用后者的 `sdk/plugin-kit`。
- **网络不稳只能稀疏克隆**：`git -C C:\Users\admin\dsh-Go-latest rev-parse --is-shallow-repository` = `true`，`remote -v` 带 `[blob:none]`（`--filter=blob:none` 部分克隆），所以那份检出不能当完整历史用；需要原文时优先 `D:\DSH-go-t36`。
- **两份 schema 只差换行**：两个 `view.schema.json` LF 归一后 SHA256 相同；`version2Only` 仍含 `tabs`/`timeline`，视图根必须 `"v": 2`；清单 `dshGo.v` 是另一个数，固定 1。
- **票不在 git 里**：`D:\DSH orchestrator\.scratch\master-secretary` 是仓库**外面**的目录，克隆拿不到 requirements / spec / 十张票 / 两张草图。
- **远端只读**：只有 `upstream` = `https://github.com/SShiRkiT/dsh-orchestrator.git`，`main` 跟踪 `upstream/main`；推送无凭据（`git push --dry-run` → `fatal: could not read Username`，exit 128）。
- **dsh-Go 原生视图硬限制**：每插件 panels ≤ 4；单面板 32 KiB / 120 节点 / 8 层 / 每 stack 32 子节点；`tabs` 在 `version2Only` 里（`schema/view.schema.json:1153`），需要视图根 `"v": 2`；原生侧不出现 settings-input 组件（设置留在网页侧）。
- **Config 自动渲染**：草图 B 依据的「Config 由宿主原生渲染」这一条在 `D:\DSH-go-t36` 的跟踪文件里仍没找到原文，属**草图引述、未复核**。
- **已被否决的做法**（`docs/adr/0010` 写了理由，别重提）：客户端按句式解析差异；读端点顺带建草稿；每 3 分钟让模型写汇报；秘书自动发催办；跟踪本机全部会话；把视图塞回 `conversation.input.right`。
- **改一处要连带改多处**（ADR 0010 后果段）：报告小节标题 ↔ `lib/secretary-panel.js` 的 `KIND_BY_HEADING`/`KIND_BY_LABEL`/`DIFF_GROUPS`；五类变化 ↔ `secretary-constants.js` 的 `NOTIFY_SWITCHES` + `secretary-deliver.js` 的 `KIND_LABELS` + `lib/client.js` 的 `SECRETARY_NOTIFY_NAMES`（客户端不能 import 服务端模块，镜像由 `test/client.test.mjs` 断言）；节拍缺省 ↔ beat 常量 + Config 默认值 + 端点 policy 三处。

## Verify

写完后执行这四条，原始输出贴进回报：

```powershell
git status --porcelain=v1
git log --oneline -8
node --test --test-isolation=none (Get-ChildItem test/*.test.mjs | ForEach-Object { $_.FullName })
node 'C:\Users\admin\dsh-Go-latest\sdk\plugin-kit\bin\check.mjs' 'D:\DSH orchestrator\repo'
```
