# 0010 秘书：登记制编排会话观察者

## 状态

已决定（2026-11-06）

## 背景

master 层已经能回答「现在有哪些 worker、各自什么状态」，但它是**查表**不是**汇报**：要用户自己切到面板去看，跨工作区尤其看不全，也不会主动说进度、指出卡点、告诉用户该做什么。用户要的是秘书：盯住他登记过的 orchestrator 会话，按固定节拍写出进度，只在有实质变化时打扰，把「需要你拍板」的事单独拎出来。

方向来自 2026-11-06 的六轮 grill（结论落在 `.scratch/master-secretary/requirements.md` 与 `spec.md`）。它与 handoff 文档里的两条旧决策冲突，以 requirements §9 为准：跟踪范围从「本机全部会话」改为登记制；视图从「删掉面板只靠会话承载」改为独立秘书视图。汇报要有固定节奏与固定形状，而控件的形状（常驻开关、催办、差异分组）又决定了「什么时候能说、说什么、说给谁」——这几件事一旦定错，后面每一份汇报都会带着错的口径。所以先把决策记下来。

## 决定

1. **跟踪范围用登记制。** 登记表存在插件 Config 里（`secretaryMasterSessionId` 与 `secretaryOrchestrators[{sessionId, workspace, title, trackedAt}]`，两者都 volatile），规则集中在 `lib/secretary-registry.js`：归一化永不抛错、Master 与 orchestrator 互斥、每个函数不可变。未登记的会话不读、不报、不碰。被否的方案见下第 1 条。
2. **汇报文本由模板生成。** `lib/secretary-report.js` 用固定六段（状态、步骤、worker、差异、产出、耗时与异常）拼 Markdown，规划首报换成步骤、验收点、触发依据、已派 worker、预计耗时；缺数据写「无」或「未提供」，不调模型。被否的方案见下第 2 条。
3. **节拍 3 分钟 + 2 小时上限 + 结束即停。** `lib/secretary-beat.js` 是注入时钟与定时器的纯定时器：180 秒一拍；到点的这一刻若已越过 7200 秒，先自停（原因 `max-run`）再不回调；`stop()` 幂等且保留第一个原因；`start()` 运行中幂等、停后重启重置计数。全部相关 worker 结束时由调用方 `stop()`，停后不再回调。被否的方案见下第 3 条。
4. **差异必须是结构而非文字。** `lib/secretary-diff.js` 的 `diffSummaries` 恒返回 `{ completed, blocked, flipped }` 三组短句，`classifyChanges` 恒返回命中的五类之一数组；报告把它们写成三个固定小节（`### 新完成` / `### 新卡住` / `### 状态翻转`），视图端 `lib/secretary-panel.js` 按同样的小节分组读回同一形状。被否的方案见下第 4 条。
5. **催办必须人工确认。** `lib/secretary-nudge.js` 只攒不送：草稿状态仅 `pending` / `sent` / `discarded`，只有 `pending` 能迁移一次，正文 ≤300 字由固定模板生成；去重键是「同会话 + 同原因」的 pending 草稿。`SecretaryRemote.confirmDraft` 是唯一投递路径，目标恒为登记过的 Master 会话；投递失败保持 `pending` 并带回原因，`discardDraft` 归档不发。被否的方案见下第 5 条。
6. **视图座位是 main + sidebar.panellist。** 客户端把同一个 id `secretary` 同时注册到 `main`（keyed）与 `sidebar.panellist`（order 40）：侧栏行按钮走 `layout.selectPanel(id)`，从树跳会话前先 `selectPanel(null)`，避免选中的面板挡住刚打开的会话。三页签（总览 / 差异与历史 / 设置）共用一条 10 秒轮询与只读端点 `orchestratorSecretary/secretaryState`。被否的方案见下第 6 条。

## 替代方案与不选的理由

**1. 跟踪本机全部会话。** handoff 的原决策就是这一条。问题有两层：**隐私**——等于允许秘书把用户从没授权过的对话读进汇报、写进磁盘；**噪音**——每个会话都会触发节拍、生成汇报，而没有 dispatch 的会话本来没有可报的进展。登记制把「读谁」变成用户显式做过的一次动作，未登记即读不到，这条边界在端点里也一样成立：报告只去登记行声明的工作区里找。

**2. 每 3 分钟让模型写一次汇报。** 成本随节拍线性增长，且长跑没有上界；更关键的是**不可断言**：同一份状态两次让模型写，出来的是两段不同的文字，测试只能测「有输出」，测不了六段是否齐、缺数据是否写成「未提供」、差异是否按三组分。模板是纯函数，时间由调用方传入，同一输入永远同一份文本，三分钟一次的节奏才守得住成本与可测性。

**3. 「有变化才推」。** 这会把「没消息」变成两种互斥含义：没变化，或者秘书已经死了——用户分不开，而这恰好是最需要确定性的一件事。用户要的是固定节奏：报告每三分钟落盘（可回看），冒泡才按变化节流（五类开关）。同时也否掉无限 `setInterval`：卡死的运行会一直写报告，所以必须有 2 小时封顶与「结束即停」。

**4. 客户端解析句式。** 视图要从归档里恢复差异分组，如果靠解析句子（「完成」「等确认」「→」）来分桶，模板改一句措辞，客户端就静默少行——报告看起来还是成功的，用户看到的却少了内容。改成结构化三组后，模板改文案不必改分桶；早于该结构的归档保留扁平数组并标成降级，不猜、不丢。

**5. 秘书自动发催办。** 跨会话投递不可逆：消息进了对方会话、可能唤醒一轮新回合，发出去收不回；而卡点正是最需要人拍板的地方。自动发等于把「要不要说、对谁说」的判断从用户手里拿走，还让秘书在用户睡觉时替他说了话。草稿 + 确认把不可逆动作留在最后一步，并且失败不标已发。

**6. 塞回输入区右侧（`conversation.input.right`）。** 那个座位已被调度模式选择器占着（order 11），旧 master 面板按钮也已下线（票 10 删了客户端 301 行、保留路由选择器）；而且输入区右侧的一个按钮弹层放不下登记树、差异分组、汇报历史与草稿确认。旧面板本身是「查表」不是「汇报」，把它扩容等于把两件事混在一个控件里。

## 后果

**以后改动要连带改什么：**

- 改报告小节标题或「类型」标签 → `lib/secretary-panel.js` 的 `KIND_BY_HEADING` / `KIND_BY_LABEL` / `DIFF_GROUPS` 必须同步；否则历史行被读成 `unknown`、差异降级回扁平数组。
- 改五类变化的判定或顺序 → `lib/secretary-constants.js` 的 `NOTIFY_SWITCHES`（`CHANGE_KINDS` 由它派生）、`lib/secretary-deliver.js` 的 `KIND_LABELS`、`lib/client.js` 的 `SECRETARY_NOTIFY_NAMES` 三处一起改；客户端不能 import 服务端模块，`test/client.test.mjs` 会断言镜像一致。配置里 `secretaryNotifyOn` 存的是这些名字，是持久化值。
- 改登记表字段或配置键 → registry 归一化、视图端点、设置页、Config schema 四处；`orchestrators` 的行形状是视图契约。
- 改节拍 / 上限缺省 → `secretary-beat.js` 的两个常量、Config 里 `secretaryBeatSeconds` / `secretaryMaxRunSeconds` 的默认值、端点 policy 段三处一起改。
- 改归档根或文件名粒度 → `lib/master-state.js` 的 `DEFAULT_REPORTS_ROOT`（及派生的 `REPORT_ROOT`）、`secretary-archive.js` 的文件名粒度、policy 与读取方一起改；已落盘的路径不会迁移。
- 改视图座位 id → `main` 的 key 与 `sidebar.panellist` 的 id 必须同一个字符串（`selectPanel` 靠它），三页签 id 是客户端契约。
- 下线 `lib/master-panel.js` 或 `orchestratorMaster/masterState` 时，Config 里的 `masterPanelEnabled` 与 `apply()` 里的 `ctx.provide` 要一起删；票 10 的原始范围包含这一步。

**已知限制：**

- **会话隔离依赖 `AssembleContext` 能取到 agent 身份。** 秘书口径的 `text()` 先读 `context.agent.id`、再读不透明 `scope.id`；两个都读不到时返回空串并记一条 warn——宁可 Master 少一段口径，也不把口径注入每个子代理的 system prompt。
- **草稿由节拍与挂载初始化生成。** `applyDraftTriggers` 不再挂在端点读函数里：挂载后跑一次，之后每一拍刷新一次；视图不开也照样攒，读端点只取快照。草稿是插件实例的内存态，重启即失；没有节拍的被跟踪会话，新卡点要等到下一次挂载或起表才会变成草稿。
- **`step` 与 `lastError` 暂无数据来源。** 六态投影没有步骤进度与错误字段，端点不再返回这两项（假字段会让视图的步骤与错误分支永远不可达）；等有票接入真实来源再接。
- **`lib/master-panel.js` 端点目前无客户端消费者。** `lib/client.js` 里 `orchestratorMaster` / `masterState` 都是 0 处；宿主端服务与 `masterPanelEnabled` 开关仍在，保留只为兼容与既有测试。
- **节拍、增量报告与冒泡投递目前只有库导出。** `createBeat` 在 `lib/` 内没有调用方；`index.js` 只接线了「触发 + 规划首报 + 归档 + 视图端点 + 草稿」。三分钟的节奏与「只在实质变化时冒泡」尚未在真实宿主里跑过。
- **报告时间粒度到分钟。** 文件名是 `HH-mm.md`，同一分钟内两拍会互相覆盖；`_summary.md` 是滚动的一份，不保留历史版本。
- **对话目录名用会话 id。** 标题会重名、会变，id 是唯一稳定的那个（requirements §10 的未决项按 id 落地）。
- **未验证**：秘书视图在真实宿主里的渲染与 `selectPanel` 切面、`confirmDraft` 的真实投递（目前只有单测与假 ctx）。
