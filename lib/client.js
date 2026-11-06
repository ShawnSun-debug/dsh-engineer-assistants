window.__ModuleLoader__.load({
  id: 'dsh-orchestrator',
  factory: (load) => {
    const module = { exports: {} }
    ;(function (module, exports, require) {
      'use strict'
      const React = require('react')

      /** Dictionary namespace owned by this plugin. */
      const NS = 'orchestrator'

      const zh = {
        'toggle.label': '计划',
        'toggle.on': '计划模式已开启，点击关闭 (/plan off)',
        'toggle.off': '计划模式已关闭，点击开启 (/plan)',
        'toggle.pending': '，将在下一步生效',
        'toggle.failed': '切换计划模式失败',
        'stage.idle': '默认',
        'stage.clarify': '澄清',
        'stage.planning': '规划',
        'stage.awaiting': '待确认',
        'stage.executing': '执行',
        'stage.na': '不适用',
        'route.button': '调度模式',
        'route.title': '主代理与子代理的默认模型',
        'route.main': '主代理',
        'route.worker': '子代理',
        'route.effort': '推理强度',
        'route.effortDefault': '模型默认',
        'route.unset': '未设置',
        'route.loading': '正在加载模型目录…',
        'route.catalogFailed': '无法加载模型目录',
        'route.readonly': '当前不可写，无法保存',
        'route.saveFailed': '保存失败',
        'route.note': '主代理的改动对新会话生效；子代理的改动从下一次委派起生效。所有子代理共用同一个模型。',
        'route.review': '评审者',
        'route.reviewNote': '留空即跟随子代理模型。评审者只看任务卡与真实路径，不看对话。',
        'route.lastReview': '最近一次评审',
        'route.lastReviewNone': '本次会话还没有评审过',
        'route.search': '搜索模型…',
        'route.noMatch': '没有匹配的模型',
        'route.noMatchHint': '换个关键词，或清空搜索看全部',
        'route.selected': '当前选中',
        'route.enable': '启用调度模式',
        'route.enableNote': '开启后主代理只做规划、由子代理执行；已打开的会话也会立即生效。',
        'route.enableFailed': '切换失败',
        'allowed.title': 'Allowed Tools',
        'allowed.search': '搜索工具…',
        'allowed.empty': '没有匹配的工具',
        'allowed.reset': '重置',
        'allowed.hint': '白名单式驱动：勾选 = 允许主代理使用；未勾选（含新插件工具）= 自动禁用。',
        'supervise.label': '子代理巡检间隔（秒）',
        'supervise.hint': '默认 600 秒（10 分钟）。主代理会按此间隔检查运行中的子代理，运行中修改立即生效。范围 10–86400。',
        'supervise.invalid': '请输入 10–86400 之间的整数',
        'supervise.saveFailed': '保存失败',
        'supervise.readonly': '当前不可写，无法保存',
        'secretary.label': '秘书',
        'secretary.title': '秘书视图',
        'secretary.tab.overview': '总览',
        'secretary.tab.history': '差异与历史',
        'secretary.tab.settings': '设置',
        'secretary.loading': '正在读取秘书状态…',
        'secretary.failed': '无法读取秘书状态',
        'secretary.retry': '重试',
        'secretary.empty': '还没有登记任何会话。到「设置」页签登记一个 orchestrator，秘书才会开始跟踪。',
        'secretary.disabled': '秘书视图未开启。',
        'secretary.disabledHint': '已关闭，保存后视图入口会消失，重新开启需在插件设置里打开。',
        'secretary.enable': '开启秘书',
        'secretary.enabled': '跟踪开关',
        'secretary.readonly': '当前不可写，无法保存',
        'secretary.saveFailed': '保存失败',
        'secretary.saving': '正在保存…',
        'secretary.invalidNumber': '请输入大于 0 的整数',
        'secretary.conflict': '登记冲突：同一个会话同时出现在 Master 与 orchestrator 名单里，后者已被忽略：',
        'secretary.blockers': '卡点',
        'secretary.blockersEmpty': '暂无卡点',
        'secretary.reason.needsInput': '等待确认',
        'secretary.reason.capped': '节拍已停',
        'secretary.reason.draft': '催办待确认',
        'secretary.current': '当前编排',
        'secretary.currentEmpty': '当前没有在跑的编排',
        'secretary.stepNone': '未提供',
        'secretary.workers': 'worker',
        'secretary.workersEmpty': '还没有 worker',
        'secretary.workerId': '名字',
        'secretary.workerState': '状态',
        'secretary.workerSummary': '在做的事',
        'secretary.workerSummaryEmpty': '（无摘要）',
        'secretary.tree': '跟踪树',
        'secretary.treeEmpty': '还没有登记的会话',
        'secretary.workspaceNone': '（未绑定工作区）',
        'secretary.workspaceMissing': '该会话暂无工作区，报告不会列出',
        'secretary.open': '打开会话',
        'secretary.openUnavailable': '当前宿主无法跳转会话',
        'secretary.rowDisabled': '已结束的会话不能跳转',
        'secretary.ended': '已结束',
        'secretary.master': 'Master',
        'secretary.masterEmpty': '未指定',
        'secretary.diff': '差异',
        'secretary.diff.completed': '新完成',
        'secretary.diff.blocked': '新卡住',
        'secretary.diff.flipped': '状态翻转',
        'secretary.diff.other': '其他',
        'secretary.diffNone': '无',
        'secretary.diffEmpty': '还没有汇报，所以还没有差异',
        'secretary.timeline': '汇报时间线',
        'secretary.timelineEmpty': '还没有汇报',
        'secretary.reportKind.plan': '规划',
        'secretary.reportKind.delta': '增量',
        'secretary.reportKind.limit': '超时截断',
        'secretary.reportKind.summary': '汇总',
        'secretary.reportKind.unknown': '未知',
        'secretary.reportPathNone': '（没有路径）',
        'secretary.reportError': '读取失败',
        'secretary.drafts': '催办草稿',
        'secretary.draft.pending': '待确认',
        'secretary.draft.sent': '已发送',
        'secretary.draft.discarded': '已丢弃',
        'secretary.draft.confirm': '确认发送',
        'secretary.draft.discard': '丢弃',
        'secretary.draft.sentAt': '发送于',
        'secretary.draft.failed': '发送失败：',
        'secretary.draft.unavailable': '当前宿主无法发送催办',
        'secretary.degraded': '历史报告的差异来自旧版服务端，只能平铺显示；升级服务端后恢复三组结构。',
        'secretary.policy': '策略',
        'secretary.beatSeconds': '节拍间隔（秒）',
        'secretary.maxRunSeconds': '最长时限（秒）',
        'secretary.notify': '冒泡条件',
        'secretary.notify.state': '状态翻转',
        'secretary.notify.step': '步骤推进',
        'secretary.notify.block': '阻塞待拍板',
        'secretary.notify.deliverable': '产出落地',
        'secretary.notify.timeout': '超时异常',
        'secretary.promptText': '常驻口径文本',
        'secretary.binding': '会话绑定',
        'secretary.bindingEmpty': '还没有登记任何会话',
        'secretary.register': '登记为 orchestrator',
        'secretary.registerId': '会话 ID',
        'secretary.registerTitle': '标题（可选）',
        'secretary.registerMissing': '请先填会话 ID',
        'secretary.unregister': '取消登记',
        'secretary.setMaster': '指定为 Master',
      }
      const en = {
        'toggle.label': 'Plan',
        'toggle.on': 'Plan mode is on, click to turn off (/plan off)',
        'toggle.off': 'Plan mode is off, click to turn on (/plan)',
        'toggle.pending': ', applies from the next step',
        'toggle.failed': 'Could not switch plan mode',
        'stage.idle': 'Default',
        'stage.clarify': 'Clarify',
        'stage.planning': 'Planning',
        'stage.awaiting': 'Review',
        'stage.executing': 'Executing',
        'stage.na': 'N/A',
        'route.button': 'Dispatch',
        'route.title': 'Default models for the main agent and subagents',
        'route.main': 'Main agent',
        'route.worker': 'Subagent',
        'route.effort': 'Reasoning effort',
        'route.effortDefault': 'Model default',
        'route.unset': 'Not set',
        'route.loading': 'Loading the model catalog…',
        'route.catalogFailed': 'Could not load the model catalog',
        'route.readonly': 'Not writable right now, cannot save',
        'route.saveFailed': 'Could not save',
        'route.note': 'A main agent change applies to new sessions; a subagent change applies from the next delegation. All subagents share one model.',
        'route.review': 'Reviewer',
        'route.reviewNote': 'Empty follows the subagent route. The reviewer sees the task card and real paths, never the conversation.',
        'route.lastReview': 'Last review',
        'route.lastReviewNone': 'No review yet in this session',
        'route.search': 'Search models…',
        'route.noMatch': 'No matching models',
        'route.noMatchHint': 'Try another keyword, or clear the search to see everything',
        'route.selected': 'selected',
        'route.enable': 'Enable dispatch mode',
        'route.enableNote': 'The main agent only plans and delegates the work; an open conversation follows the switch immediately.',
        'route.enableFailed': 'Could not switch',
        'allowed.title': 'Allowed Tools',
        'allowed.search': 'Filter tools…',
        'allowed.empty': 'No matching tools',
        'allowed.reset': 'Reset',
        'allowed.hint': 'Whitelist-driven: checked = allowed for the main agent; unchecked (including new plugin tools) = blocked automatically.',
        'supervise.label': 'Subagent check interval (seconds)',
        'supervise.hint': 'Default 600 seconds (10 minutes). The main agent checks running subagents at this interval; changes apply immediately. Range 10–86400.',
        'supervise.invalid': 'Enter an integer between 10 and 86400',
        'supervise.saveFailed': 'Could not save',
        'supervise.readonly': 'Not writable right now, cannot save',
        'secretary.label': 'Secretary',
        'secretary.title': 'Secretary view',
        'secretary.tab.overview': 'Overview',
        'secretary.tab.history': 'Diff & history',
        'secretary.tab.settings': 'Settings',
        'secretary.loading': 'Reading the secretary state…',
        'secretary.failed': 'Could not read the secretary state',
        'secretary.retry': 'Retry',
        'secretary.empty': 'Nothing is registered yet. Register an orchestrator on the Settings tab and the secretary starts tracking it.',
        'secretary.disabled': 'The secretary view is off.',
        'secretary.disabledHint':
          'It is off. Once saved, the view entry disappears; turn it back on in the plugin settings.',
        'secretary.enable': 'Turn the secretary on',
        'secretary.enabled': 'Tracking',
        'secretary.readonly': 'Not writable right now, cannot save',
        'secretary.saveFailed': 'Could not save',
        'secretary.saving': 'Saving…',
        'secretary.invalidNumber': 'Enter an integer greater than 0',
        'secretary.conflict': 'Registry conflict: one session is listed as both Master and orchestrator; the orchestrator row was ignored:',
        'secretary.blockers': 'Blockers',
        'secretary.blockersEmpty': 'No blockers',
        'secretary.reason.needsInput': 'Needs input',
        'secretary.reason.capped': 'Beat stopped',
        'secretary.reason.draft': 'Draft to confirm',
        'secretary.current': 'Current run',
        'secretary.currentEmpty': 'Nothing is running right now',
        'secretary.stepNone': 'not provided',
        'secretary.workers': 'workers',
        'secretary.workersEmpty': 'No workers yet',
        'secretary.workerId': 'Name',
        'secretary.workerState': 'State',
        'secretary.workerSummary': 'Doing',
        'secretary.workerSummaryEmpty': '(no summary)',
        'secretary.tree': 'Tracking tree',
        'secretary.treeEmpty': 'No sessions registered yet',
        'secretary.workspaceNone': '(no workspace)',
        'secretary.workspaceMissing': 'This session has no workspace yet, so its reports are not listed',
        'secretary.open': 'Open the session',
        'secretary.openUnavailable': 'This host cannot open a session',
        'secretary.rowDisabled': 'An ended session cannot be opened',
        'secretary.ended': 'ended',
        'secretary.master': 'Master',
        'secretary.masterEmpty': 'not set',
        'secretary.diff': 'Diff',
        'secretary.diff.completed': 'Newly done',
        'secretary.diff.blocked': 'Newly blocked',
        'secretary.diff.flipped': 'State flips',
        'secretary.diff.other': 'Other',
        'secretary.diffNone': 'none',
        'secretary.diffEmpty': 'No report yet, so no diff yet',
        'secretary.timeline': 'Report timeline',
        'secretary.timelineEmpty': 'No reports yet',
        'secretary.reportKind.plan': 'plan',
        'secretary.reportKind.delta': 'delta',
        'secretary.reportKind.limit': 'timeout',
        'secretary.reportKind.summary': 'summary',
        'secretary.reportKind.unknown': 'unknown',
        'secretary.reportPathNone': '(no path)',
        'secretary.reportError': 'read failed',
        'secretary.drafts': 'Nudge drafts',
        'secretary.draft.pending': 'to confirm',
        'secretary.draft.sent': 'sent',
        'secretary.draft.discarded': 'discarded',
        'secretary.draft.confirm': 'Send',
        'secretary.draft.discard': 'Discard',
        'secretary.draft.sentAt': 'sent at',
        'secretary.draft.failed': 'send failed:',
        'secretary.draft.unavailable': 'this host cannot send a nudge',
        'secretary.degraded': 'The history diff came from an older server in the flat format; the three groups return once the server is upgraded.',
        'secretary.policy': 'Policy',
        'secretary.beatSeconds': 'Beat interval (seconds)',
        'secretary.maxRunSeconds': 'Longest run (seconds)',
        'secretary.notify': 'Notify on',
        'secretary.notify.state': 'State flips',
        'secretary.notify.step': 'Step advances',
        'secretary.notify.block': 'Blocked',
        'secretary.notify.deliverable': 'Deliverables',
        'secretary.notify.timeout': 'Timeouts',
        'secretary.promptText': 'Standing prompt text',
        'secretary.binding': 'Session bindings',
        'secretary.bindingEmpty': 'No sessions registered yet',
        'secretary.register': 'Register as orchestrator',
        'secretary.registerId': 'Session id',
        'secretary.registerTitle': 'Title (optional)',
        'secretary.registerMissing': 'Fill in the session id first',
        'secretary.unregister': 'Unregister',
        'secretary.setMaster': 'Make Master',
      }

      const baseStyle = {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        height: '28px',
        padding: '0 10px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 22%, transparent))',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: 1,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }
      // A lit control borrows the host's brand and ghost-active fills so it reads right in both themes.
      const onStyle = {
        borderColor: 'var(--dsw-alias-brand-primary, #4d8dff)',
        background: 'var(--dsw-alias-button-ghost-active-fill, color-mix(in srgb, #4d8dff 16%, transparent))',
      }
      const dot = (on) => ({
        width: '6px',
        height: '6px',
        borderRadius: '999px',
        background: on ? 'var(--dsw-alias-brand-primary, #4d8dff)' : 'var(--dsw-alias-label-tertiary, color-mix(in srgb, currentColor 45%, transparent))',
      })

      /**
       * Plan-mode toggle. The native plan projection folds the host's committed
       * state; `/plan` during an open turn is queued, so `pending` means the shown
       * target differs from what the host has applied so far.
       */
      function PlanToggle({ useProjection, locked, setPlan, t }) {
        // A blank new conversation has no folded plan state yet; that is plan mode off.
        const plan = useProjection('plan') ?? { active: false, pending: false }
        // Derived by the host from logged events; absent until the first projection arrives.
        const stage = useProjection('orchestrator')?.stage ?? 'idle'
        const [busy, setBusy] = React.useState(false)
        const [error, setError] = React.useState(null)
        const alive = React.useRef(true)
        React.useEffect(() => {
          alive.current = true
          return () => {
            alive.current = false
          }
        }, [])

        const target = plan.pending ? !plan.active : plan.active
        const base = target ? t('toggle.on') : t('toggle.off')
        // The button face only says "Plan" and is lit when on; the stage lives in the hover text.
        const title = error ?? (plan.pending ? base + t('toggle.pending') : base) + ' · ' + t('stage.' + stage)

        const onClick = () => {
          if (busy || locked) return
          setBusy(true)
          setError(null)
          setPlan(!target).then(
            (failure) => {
              if (!alive.current) return
              setBusy(false)
              setError(failure)
            },
            (reason) => {
              if (!alive.current) return
              setBusy(false)
              setError(typeof reason?.message === 'string' && reason.message !== '' ? reason.message : t('toggle.failed'))
            },
          )
        }

        return React.createElement(
          'button',
          {
            type: 'button',
            style: Object.assign({}, baseStyle, target ? onStyle : null, busy || locked ? { opacity: 0.6 } : null),
            disabled: busy || locked,
            onClick,
            title,
            'aria-label': title,
            'aria-pressed': target,
            'data-plan': target ? 'on' : 'off',
            'data-pending': plan.pending ? 'true' : 'false',
            'data-stage': stage,
          },
          React.createElement('span', { style: dot(target), 'aria-hidden': true }),
          React.createElement('span', null, t('toggle.label')),
        )
      }

      // ---- Default routes -------------------------------------------------------------------
      // Two stored routes, each a { provider, model, effort } triple under different field names.
      // The main agent's lives in the host's `agent-default-model` entry (read when an agent is
      // created); the workers' lives in this plugin's own entry (read on every delegation).
      // `clear` says how "no effort" is stored. The main agent's field is optional with no
      // empty value, so its override is removed. The subagent field ships a default in the
      // plugin bundle, and removing the override would bring that default back, so it stores ''.
      const MAIN = {
        ns: 'agent-default-model',
        fields: { provider: 'provider', model: 'model', effort: 'reasoningEffort', clear: 'unset' },
      }
      const WORKER = {
        ns: 'orchestrator',
        fields: { provider: 'workerProvider', model: 'workerModel', effort: 'workerReasoningEffort', clear: 'empty' },
      }

      // ADR 0004：评审者可有自己的路由，留空即跟随 worker（readReviewRoute 就是这么读的）。
      const REVIEW = {
        ns: 'orchestrator',
        fields: { provider: 'reviewProvider', model: 'reviewModel', effort: 'reviewReasoningEffort', clear: 'empty' },
      }

      const routeKey = (provider, model) => JSON.stringify([provider, model])

      function parseRouteKey(key) {
        try {
          const v = JSON.parse(key)
          return Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string'
            ? { provider: v[0], model: v[1] }
            : undefined
        } catch {
          return undefined
        }
      }

      /** Read a stored route out of a config section; absent fields read as empty. */
      function routeOf(fields, value) {
        const get = (name) => (typeof value?.[name] === 'string' ? value[name] : '')
        return { provider: get(fields.provider), model: get(fields.model), effort: get(fields.effort) }
      }

      /** No effort lets the model resolve its own default; `fields.clear` says how that is stored. */
      function routeOps(fields, route) {
        const cleared = fields.clear === 'empty' ? { op: 'set', path: [fields.effort], value: '' } : { op: 'unset', path: [fields.effort] }
        return [
          { op: 'set', path: [fields.provider], value: route.provider },
          { op: 'set', path: [fields.model], value: route.model },
          route.effort === '' ? cleared : { op: 'set', path: [fields.effort], value: route.effort },
        ]
      }

      /** The catalog entry for a stored route, or undefined when it is not offered any more. */
      function findModel(groups, route) {
        for (const group of groups) {
          if (group.id !== route.provider) continue
          const model = group.models.find((m) => m.id === route.model)
          if (model !== undefined) return model
        }
        return undefined
      }

      /**
       * Narrow the catalog to what a free-text query matches. A provider name matches every model it
       * offers; otherwise model ids and display names are matched. An empty query is the whole catalog.
       */
      function filterGroups(groups, query) {
        const needle = query.trim().toLowerCase()
        if (needle === '') return groups
        const hit = (text) => text.toLowerCase().includes(needle)
        const matched = new Map()
        const kept = []
        for (const group of groups) {
          if (hit(group.id) || hit(group.name ?? '')) {
            kept.push(group)
            matched.set(group.id, group.models.length)
            continue
          }
          const models = group.models.filter((model) => hit(model.id) || hit(model.name ?? ''))
          if (models.length === 0) continue
          matched.set(group.id, models.length)
          kept.push(models.length === group.models.length ? group : { ...group, models })
        }
        return kept
      }

      /** How many models a catalog holds, for the match counter next to the filter. */
      function countModels(groups) {
        return groups.reduce((total, group) => total + group.models.length, 0)
      }

      /** Write one route and confirm it landed. Returns an error message, or null on success. */
      async function saveRoute(scope, fields, route, t) {
        const snapshot = scope.getSnapshot()
        if (snapshot.status !== 'ready' || !snapshot.writable) return t('route.readonly')
        try {
          await scope.mutate(routeOps(fields, route), snapshot.revision)
        } catch (reason) {
          // Not `instanceof Error`: remote failures can be plain { code, message } objects.
          return typeof reason?.message === 'string' && reason.message !== '' ? reason.message : t('route.saveFailed')
        }
        const stored = routeOf(fields, scope.getSnapshot().value)
        const landed =
          stored.provider === route.provider && stored.model === route.model && stored.effort === route.effort
        return landed ? null : t('route.saveFailed')
      }

      // ---- Supervision interval -------------------------------------------------------------
      // The host stores `superviseIntervalSeconds` as a number with a schema default, so a
      // missing value, a string, a fraction, or a number out of range all read as the default.
      const INTERVAL = { key: 'superviseIntervalSeconds', min: 10, max: 86400, fallback: 600 }

      /** The stored interval when it is a valid integer, else the schema default of 600. */
      function intervalOf(value) {
        const raw = value?.[INTERVAL.key]
        return typeof raw === 'number' && Number.isInteger(raw) && raw >= INTERVAL.min && raw <= INTERVAL.max
          ? raw
          : INTERVAL.fallback
      }

      /**
       * Parse a typed interval. Trimmed text only: digits, no sign, no decimal point, no
       * exponent. An empty field means "back to the default", which is written as 600.
       */
      function parseInterval(text) {
        const trimmed = String(text ?? '').trim()
        if (trimmed === '') return { ok: true, seconds: INTERVAL.fallback, empty: true }
        if (!/^[0-9]+$/.test(trimmed)) return { ok: false, empty: false }
        const seconds = Number(trimmed)
        if (!Number.isSafeInteger(seconds) || seconds < INTERVAL.min || seconds > INTERVAL.max) {
          return { ok: false, empty: false }
        }
        return { ok: true, seconds, empty: false }
      }

      // ---- Allowed tools --------------------------------------------------------------------
      // Whitelist-driven. The shipped allow list is mirrored from the host
      // (DEFAULT_ALLOWED_TOOLS in lib/index.js): the same names, in the same order.
      // A web client plugin has no API that enumerates host tools — the session remote offers
      // session/model/skill methods only, and configForms exposes this plugin's own config — so
      // the plugin's server half collects the live catalog and publishes it as the volatile
      // `toolCatalog` field of that same config (lib/catalog.js). The panel renders the union
      // of that catalog, this shipped list and the config key; the shipped copy is also
      // the fallback on a host that publishes nothing. A unit test keeps this copy equal to the
      // host constant, so the two cannot drift apart.
      const DEFAULT_ALLOWED_TOOLS = [
        'dispatch',
        'send_message',
        'interrupt_agent',
        'todo_write',
        'ask_user_question',
        'compress',
        'session_search',
        'session_trace',
        'session_event_search',
        'session_event_read',
        'session_event_trace',
      ]
      /** The shipped list as a set, for the "still exactly the default?" comparison. */
      const DEFAULT_ALLOWED_SET = new Set(DEFAULT_ALLOWED_TOOLS)
      /** The config key the panel reads and writes. */
      const ALLOW_KEY = 'allowedTools'
      /** The read-only config field the host publishes the live catalog into. */
      const CATALOG_KEY = 'toolCatalog'

      /** A string array config field, tolerating a missing or oddly shaped value. */
      function namesOf(value, key) {
        const raw = value?.[key]
        return Array.isArray(raw) ? raw.filter((name) => typeof name === 'string' && name !== '') : []
      }

      /**
       * The live catalog the server half published: every tool the running host offers,
       * including the ones other plugins and MCP servers registered. Absent (or empty) on
       * an older host or before the first publish, which leaves the shipped list alone.
       */
      function catalogOf(value) {
        return namesOf(value, CATALOG_KEY)
      }

      /**
       * The catalog to render. A settings write commits the profile's raw value into every
       * volatile field the Loader was handed (lib/catalog.js), so for the instant between
       * that commit and the plugin publishing the catalog again the panel would read an
       * empty list and drop back to its shipped-name fallback. An empty read is never a real
       * catalog, so the last non-empty one stands in for it.
       */
      function catalogFor(value, remembered) {
        const live = catalogOf(value)
        return live.length > 0 ? live : remembered ?? []
      }

      /**
       * Every row: the shipped allow list in its own order first, then every other name the
       * live catalog or the config key knows, alphabetically. A catalog name is shown even
       * when the shipped list does not know it, and starts unchecked — a tool the user never
       * allowed, including one a plugin or MCP server registered later, stays blocked for the
       * main agent until it is checked here.
       */
      function toolListOf(value, catalog) {
        const listed = [...DEFAULT_ALLOWED_TOOLS]
        const seen = new Set(listed)
        const extras = new Set()
        for (const name of catalog ?? catalogOf(value)) {
          if (seen.has(name)) continue
          extras.add(name)
        }
        for (const name of namesOf(value, ALLOW_KEY)) {
          if (seen.has(name)) continue
          extras.add(name)
        }
        return [...listed, ...[...extras].sort((a, b) => a.localeCompare(b))]
      }

      /**
       * The effective allow set, mirroring the host's effectiveAllowed(). An array — including
       * an empty one the user deliberately cleared — is the stored whitelist verbatim; anything
       * else means the field was never set, so the shipped list stands in. The two cases must
       * stay distinct: `[]` means "allow nothing", `undefined` means "ship defaults".
       */
      function allowedSetOf(value) {
        return Array.isArray(value?.[ALLOW_KEY]) ? new Set(namesOf(value, ALLOW_KEY)) : new Set(DEFAULT_ALLOWED_TOOLS)
      }

      /** Case-insensitive substring match on the tool name; an empty query keeps every row. */
      function filterTools(names, query) {
        const needle = String(query ?? '').trim().toLowerCase()
        if (needle === '') return names
        return names.filter((name) => name.toLowerCase().includes(needle))
      }

      /**
       * The single config write that reproduces a checkbox state. A set equal to the shipped
       * list is stored as an unset field, so a profile that never changed anything keeps the
       * schema default instead of pinning a copy of this build's list; anything else — extra
       * names, a removed name, or an emptied whitelist — is stored verbatim.
       */
      function allowOps(checked) {
        const list = [...new Set(checked)]
        const isDefault =
          list.length === DEFAULT_ALLOWED_TOOLS.length && list.every((name) => DEFAULT_ALLOWED_SET.has(name))
        return [isDefault ? { op: 'unset', path: [ALLOW_KEY] } : { op: 'set', path: [ALLOW_KEY], value: list }]
      }

      /** Back to the shipped list: the key cleared, so the schema default applies again. */
      function resetAllowOps() {
        return [{ op: 'unset', path: [ALLOW_KEY] }]
      }

      const h = React.createElement
      // The popover is two columns: the original panel keeps its width, padding and
      // outline, and its own right border separates it from the allowed-tools column.
      const panelStyle = {
        position: 'absolute',
        // Anchored by its left column: the original panel keeps the exact place it had
        // (`right: 0` with width 340), and the allowed-tools column grows to its right
        // instead of pushing the left column under the conversation sidebar.
        left: 'calc(100% - 340px)',
        bottom: 'calc(100% + 8px)',
        zIndex: 50,
        width: 'auto',
        padding: 0,
        borderRadius: '12px',
        border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 22%, transparent))',
        background: 'var(--dsw-alias-bg-layer-2, Canvas)',
        color: 'inherit',
        boxShadow: '0 12px 32px rgba(0, 0, 0, .3)',
        fontSize: '12px',
        display: 'flex',
        alignItems: 'stretch',
        overflow: 'hidden',
      }
      const panelColumnStyle = {
        width: '340px',
        padding: '12px',
        display: 'grid',
        gap: '10px',
        alignContent: 'start',
        boxSizing: 'border-box',
        // The divider is the original panel's own outline, kept as its right border.
        borderRight: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 22%, transparent))',
      }
      const allowedColumnStyle = {
        width: '232px',
        padding: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        minHeight: 0,
        boxSizing: 'border-box',
      }
      // The rows live in a card that mirrors the model dropdown: a search row on top and a
      // scrolling option list under it. The cap keeps the shipped dozen plus any host extras
      // from stretching the popover.
      const allowedListBoxStyle = {
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        padding: '6px',
        borderRadius: '10px',
        border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 22%, transparent))',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        flex: '1 1 auto',
        minHeight: '120px',
        maxHeight: '360px',
        boxSizing: 'border-box',
      }
      const allowedListStyle = {
        display: 'grid',
        // One column pinned to the box's own width: an implicit `auto` track would be sized
        // by the longest unbreakable tool name and scroll the list sideways.
        gridTemplateColumns: 'minmax(0, 1fr)',
        gap: '2px',
        alignContent: 'start',
        flex: '1 1 auto',
        minHeight: 0,
        overflowY: 'auto',
        paddingRight: '2px',
      }
      // One row per tool: the checkbox leads, so a long tool name can never push it out of
      // the 232px column; the name then takes whatever width is left and ellipsises.
      const allowedRowStyle = (allowed) => ({
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '4px 8px',
        borderRadius: '6px',
        cursor: 'pointer',
        fontWeight: allowed ? 600 : 400,
        // The row is a grid item with an automatic minimum size, which long content would
        // otherwise widen past the column; zero lets the name truncate instead.
        minWidth: 0,
      })
      const allowedNameStyle = {
        flex: '1 1 auto',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }
      const allowedCheckboxStyle = (editable) => ({
        flex: 'none',
        margin: 0,
        cursor: editable ? 'pointer' : 'default',
        accentColor: 'var(--dsw-alias-brand-primary, #4d8dff)',
      })
      const resetLinkStyle = (enabled) => ({
        border: 'none',
        background: 'transparent',
        color: enabled ? 'var(--dsw-alias-link, var(--dsw-alias-brand-primary, #4d8dff))' : 'var(--dsw-alias-label-tertiary, inherit)',
        font: 'inherit',
        fontSize: '11px',
        padding: 0,
        cursor: enabled ? 'pointer' : 'default',
        flex: 'none',
      })
      // The switch track: the host's own off-track token keeps the grey readable in both
      // themes; the on-colour is fixed so it reads the same in light and dark.
      const switchTrackStyle = (on, focused, disabled) => ({
        boxSizing: 'border-box',
        position: 'relative',
        display: 'block',
        width: '36px',
        height: '20px',
        padding: '2px',
        borderRadius: '999px',
        background: on
          ? '#C6FFD5'
          : 'var(--dsw-alias-border-l3, color-mix(in srgb, currentColor 26%, transparent))',
        transition: 'background-color 160ms ease',
        boxShadow: focused ? '0 0 0 2px var(--dsw-alias-brand-primary, #4d8dff)' : 'none',
        opacity: disabled ? 0.5 : 1,
      })
      // A white knob with a hairline ring stays visible on the light-green track in the
      // light theme, where a bare white circle would otherwise nearly disappear.
      const switchKnobStyle = (on) => ({
        display: 'block',
        width: '16px',
        height: '16px',
        borderRadius: '50%',
        background: '#fff',
        boxShadow: '0 1px 2px rgba(0, 0, 0, .35), 0 0 0 1px rgba(0, 0, 0, .14)',
        transform: on ? 'translateX(16px)' : 'translateX(0)',
        transition: 'transform 160ms ease',
      })
      const selectStyle = {
        width: '100%',
        height: '28px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 22%, transparent))',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        color: 'inherit',
        font: 'inherit',
        padding: '0 6px',
        colorScheme: 'light dark',
      }
      // The filter sits above the two rows; `colorScheme` keeps the native clear button theme-aware.
      const searchStyle = {
        flex: 1,
        minWidth: 0,
        height: '28px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 22%, transparent))',
        background: 'var(--dsw-alias-fill-tertiary, color-mix(in srgb, currentColor 6%, transparent))',
        color: 'inherit',
        font: 'inherit',
        padding: '0 8px',
        boxSizing: 'border-box',
        colorScheme: 'light dark',
      }

      const modelButtonStyle = {
        width: '100%',
        minHeight: '28px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 22%, transparent))',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        color: 'inherit',
        font: 'inherit',
        padding: '0 8px',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '6px',
        textAlign: 'left',
      }
      // The list hangs off the row button, so it paints above the effort select underneath.
      // Positioned fixed: the popover that hosts it clips its children (`overflow: hidden`),
      // so an absolutely positioned list would be cut off at the popover's edge. The
      // placement is measured per open; this is the fallback for a host without a layout.
      const dropdownStyle = {
        position: 'fixed',
        top: 'calc(100% + 4px)',
        left: 0,
        right: 0,
        zIndex: 60,
        maxHeight: '260px',
        overflowY: 'auto',
        padding: '6px',
        borderRadius: '10px',
        border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 22%, transparent))',
        background: 'var(--dsw-alias-bg-layer-2, Canvas)',
        boxShadow: '0 12px 32px rgba(0, 0, 0, .3)',
        display: 'grid',
        gap: '2px',
      }

      /**
       * Where the model list opens, and how tall it may be.
       *
       * The list hangs off a row button inside a popover that itself sits above the
       * composer, so "always below" runs past the bottom of the window and hides its last
       * options. Given the button's viewport rect, open downward while the preferred height
       * fits there, flip upward when that side has more room, and cap the height to the
       * space that is really available so the list scrolls instead of being clipped. A
       * `null` rect (no layout, as in a unit test) leaves the caller on its static style.
       */
      function popupPlacement(rect, viewportHeight, { gap = 4, margin = 8, preferred = 260, minimum = 80 } = {}) {
        const top = rect?.top
        const bottom = rect?.bottom
        if (!Number.isFinite(top) || !Number.isFinite(bottom) || !Number.isFinite(viewportHeight)) return null
        const below = viewportHeight - bottom - gap - margin
        const above = top - gap - margin
        const side = below >= preferred || below >= above ? 'down' : 'up'
        const room = side === 'down' ? below : above
        return {
          side,
          maxHeight: Math.max(Math.min(preferred, room), minimum),
          top: side === 'down' ? bottom + gap : 'auto',
          bottom: side === 'up' ? viewportHeight - top + gap : 'auto',
          left: rect.left,
          width: rect.width,
        }
      }

      /** The style for a measured placement, or the static fallback when there is none. */
      function dropdownStyleOf(placement) {
        if (placement === null) return dropdownStyle
        return Object.assign({}, dropdownStyle, {
          top: placement.top,
          bottom: placement.bottom,
          left: placement.left,
          right: 'auto',
          width: placement.width,
          maxHeight: placement.maxHeight + 'px',
        })
      }
      const filterRowStyle = {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        position: 'sticky',
        top: 0,
        background: 'var(--dsw-alias-bg-layer-2, Canvas)',
        paddingBottom: '4px',
      }
      const groupStyle = {
        padding: '6px 8px 2px',
        color: 'var(--dsw-alias-label-tertiary, inherit)',
        fontSize: '11px',
        fontWeight: 600,
      }
      const optionStyle = (active, selected) => ({
        border: 'none',
        borderRadius: '6px',
        padding: '5px 8px',
        font: 'inherit',
        textAlign: 'left',
        color: 'inherit',
        cursor: 'pointer',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontWeight: selected ? 600 : 400,
        background: selected
          ? 'var(--dsw-alias-button-ghost-active-fill, color-mix(in srgb, currentColor 12%, transparent))'
          : active
            ? 'var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 8%, transparent))'
            : 'transparent',
      })

      /** Re-render when a config scope changes, and return its current snapshot. */
      function useScope(scope) {
        const [, bump] = React.useReducer((n) => n + 1, 0)
        React.useEffect(() => scope.subscribe(() => bump()), [scope])
        return scope.getSnapshot()
      }

      /**
       * The subagent check interval. Edits stay local until blur or Enter; invalid input is
       * rejected without writing and the shown value snaps back to the stored one. The panel's
       * scope subscription keeps the field in step with a value changed anywhere else.
       */
      function SuperviseIntervalField({ scope, t }) {
        const snapshot = useScope(scope)
        const current = intervalOf(snapshot.value)
        const [draft, setDraft] = React.useState(String(current))
        const [hint, setHint] = React.useState(null)
        const [busy, setBusy] = React.useState(false)
        const alive = React.useRef(true)
        const shown = React.useRef(current)
        const editable = snapshot.status === 'ready' && snapshot.writable === true

        React.useEffect(() => {
          alive.current = true
          return () => {
            alive.current = false
          }
        }, [])
        // Follow the stored value when it changed somewhere else.
        React.useEffect(() => {
          if (shown.current === current) return
          shown.current = current
          setDraft(String(current))
        }, [current])
        // The warning is transient; a successful commit also clears it.
        React.useEffect(() => {
          if (hint === null || typeof setTimeout !== 'function') return undefined
          const timer = setTimeout(() => {
            if (alive.current) setHint(null)
          }, 4000)
          return () => clearTimeout(timer)
        }, [hint])

        const reject = (message) => {
          setHint(message)
          setDraft(String(current))
        }

        const commit = async () => {
          if (busy) return
          const parsed = parseInterval(draft)
          if (!parsed.ok) {
            reject(t('supervise.invalid'))
            return
          }
          // Same value: no mutate, just put the field back in its canonical form.
          if (parsed.seconds === current) {
            setDraft(String(current))
            setHint(null)
            return
          }
          if (!editable) {
            reject(t('supervise.readonly'))
            return
          }
          const live = scope.getSnapshot()
          setBusy(true)
          try {
            await scope.mutate([{ op: 'set', path: [INTERVAL.key], value: parsed.seconds }], live.revision)
            if (!alive.current) return
            if (intervalOf(scope.getSnapshot().value) === parsed.seconds) setHint(null)
            else reject(t('supervise.saveFailed'))
          } catch {
            // A remote failure may be a plain object; the panel only needs a short line.
            if (alive.current) reject(t('supervise.saveFailed'))
          } finally {
            if (alive.current) setBusy(false)
          }
        }

        return h(
          'div',
          { style: { display: 'grid', gap: '4px' } },
          h(
            'label',
            { style: { display: 'grid', gap: '4px' } },
            h('span', { style: { fontWeight: 600 } }, t('supervise.label')),
            h('input', {
              // Plain text keeps non-numeric input observable: a number input sanitizes "abc"
              // to an empty value, which this field would then read as "use the default".
              type: 'text',
              inputMode: 'numeric',
              min: INTERVAL.min,
              max: INTERVAL.max,
              step: 1,
              value: draft,
              disabled: busy || !editable,
              'aria-label': t('supervise.label'),
              style: selectStyle,
              onChange: (event) => setDraft(event.target.value),
              onBlur: () => commit(),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  return commit()
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setDraft(String(current))
                  setHint(null)
                }
                return undefined
              },
            }),
          ),
          h('div', { style: { color: 'var(--dsw-alias-label-tertiary, inherit)', lineHeight: 1.35 } }, t('supervise.hint')),
          hint === null ? null : h('div', { style: { color: 'var(--dsw-alias-label-error, #ff7b72)' }, role: 'alert' }, hint),
        )
      }

      /**
       * The dispatch switch. A real checkbox with role="switch" gives Space-to-toggle and
       * the platform focus semantics for free; Enter is handled explicitly because a native
       * checkbox ignores it. The track and knob are inline styles (this bundle ships no
       * stylesheet), so the focus ring is state-driven rather than a :focus-visible rule.
       */
      function EnableSwitch({ checked, disabled, onChange, label }) {
        const [focused, setFocused] = React.useState(false)
        return h(
          'label',
          {
            style: {
              position: 'relative',
              display: 'inline-flex',
              flex: '0 0 auto',
              alignItems: 'center',
              cursor: disabled ? 'default' : 'pointer',
            },
          },
          h('input', {
            type: 'checkbox',
            role: 'switch',
            'aria-checked': checked ? 'true' : 'false',
            'aria-label': label,
            checked,
            disabled,
            style: {
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              margin: 0,
              opacity: 0,
              cursor: 'inherit',
            },
            onChange: (event) => onChange(event.target.checked),
            onKeyDown: (event) => {
              if (event.key !== 'Enter') return undefined
              event.preventDefault()
              if (!disabled) onChange(!checked)
              return undefined
            },
            onFocus: () => setFocused(true),
            onBlur: () => setFocused(false),
          }),
          h(
            'span',
            { 'aria-hidden': true, 'data-switch': checked ? 'on' : 'off', style: switchTrackStyle(checked, focused, disabled) },
            h('span', { style: switchKnobStyle(checked) }),
          ),
        )
      }

      /**
       * The right-hand column: one checkbox per tool the host offers, searched by name.
       * Whitelist-driven — checked means the main agent may use the tool, and everything
       * else, including a tool some plugin or MCP server registers later, is blocked for it.
       * Every change writes the single allow key from the checkbox state, so the stored
       * config always describes exactly what the panel shows.
       */
      function AllowedToolsPanel({ scope, t }) {
        const snapshot = useScope(scope)
        const [query, setQuery] = React.useState('')
        const [saving, setSaving] = React.useState(false)
        const [problem, setProblem] = React.useState(null)
        const alive = React.useRef(true)
        React.useEffect(() => {
          alive.current = true
          return () => {
            alive.current = false
          }
        }, [])

        // Shipped order first, then the catalog/config extras alphabetically, so a row
        // keeps its place when the live catalog changes. The remembered copy survives the
        // instant a settings write resets the published field (see catalogFor).
        const remembered = React.useRef([])
        const live = catalogFor(snapshot.value, remembered.current)
        if (live.length > 0) remembered.current = live
        const names = toolListOf(snapshot.value, live)
        const allowed = allowedSetOf(snapshot.value)
        const visible = filterTools(names, query)
        const editable = snapshot.status === 'ready' && snapshot.writable === true

        const write = async (ops) => {
          if (saving) return
          const live = scope.getSnapshot()
          if (live.status !== 'ready' || live.writable !== true) {
            setProblem(t('route.readonly'))
            return
          }
          setSaving(true)
          setProblem(null)
          try {
            await scope.mutate(ops, live.revision)
          } catch (reason) {
            if (!alive.current) return
            // Not `instanceof Error`: a remote failure can be a plain { code, message } object.
            setProblem(typeof reason?.message === 'string' && reason.message !== '' ? reason.message : t('route.saveFailed'))
          } finally {
            if (alive.current) setSaving(false)
          }
        }

        const toggle = (name, on) => {
          const next = new Set(allowed)
          if (on) next.add(name)
          else next.delete(name)
          return write(allowOps(next))
        }

        return h(
          'div',
          { style: allowedColumnStyle, 'data-panel': 'allowed-tools' },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' } },
            h('span', { style: { fontWeight: 600 }, title: t('allowed.hint') }, t('allowed.title')),
            h(
              'button',
              {
                type: 'button',
                style: resetLinkStyle(editable && !saving),
                disabled: saving || !editable,
                onClick: () => write(resetAllowOps()),
              },
              t('allowed.reset'),
            ),
          ),
          h(
            'div',
            { style: allowedListBoxStyle },
            h('input', {
              type: 'search',
              value: query,
              placeholder: t('allowed.search'),
              'aria-label': t('allowed.search'),
              'data-search': 'allowed-tools',
              // `searchStyle` grows inside the dropdown's flex row; here it sits in a flex
              // column, so an explicit height keeps it a one-line box instead of stretching.
              style: Object.assign({}, searchStyle, { flex: 'none', height: '28px', width: '100%' }),
              onChange: (event) => setQuery(event.target.value),
            }),
            h(
              'div',
              { style: allowedListStyle, role: 'group', 'aria-label': t('allowed.title') },
              visible.length === 0
                ? h(
                    'div',
                    { style: { padding: '6px 8px', color: 'var(--dsw-alias-label-tertiary, inherit)', lineHeight: 1.4 } },
                    t('allowed.empty'),
                  )
                : visible.map((name) =>
                    h(
                      'label',
                      { key: name, style: allowedRowStyle(allowed.has(name)), 'data-tool': name },
                      h('input', {
                        type: 'checkbox',
                        checked: allowed.has(name),
                        disabled: saving || !editable,
                        'aria-label': name,
                        style: allowedCheckboxStyle(!saving && editable),
                        onChange: (event) => toggle(name, event.target.checked),
                      }),
                      h('span', { style: allowedNameStyle, title: name }, name),
                    ),
                  ),
            ),
          ),
          problem === null ? null : h('div', { role: 'alert', style: { color: 'var(--dsw-alias-label-error, #ff7b72)' } }, problem),
        )
      }

      /** One row: the current model, and the searchable list that opens in place. */
      function RouteRow({ label, route, groups, disabled, onChange, t }) {
        const [open, setOpen] = React.useState(false)
        const [active, setActive] = React.useState(0)
        const [query, setQuery] = React.useState('')
        const [placement, setPlacement] = React.useState(null)
        const box = React.useRef(null)
        const options = React.useRef(new Map())
        const model = findModel(groups, route)
        const known = model !== undefined
        const key = route.provider !== '' && route.model !== '' ? routeKey(route.provider, route.model) : ''
        const efforts = model?.reasoning?.efforts ?? []
        const visible = filterGroups(groups, query)
        const items = []
        if (!known && key !== '') items.push({ kind: 'unknown' })
        items.push({ kind: 'unset' })
        for (const group of visible) {
          items.push({ kind: 'group', group })
          for (const entry of group.models) items.push({ kind: 'model', provider: group.id, model: entry })
        }

        const dismiss = () => {
          setOpen(false)
          setActive(0)
        }
        const choose = (item) => {
          // A different model offers different efforts, so the stored effort is dropped.
          if (item.kind === 'unset') onChange({ provider: '', model: '', effort: '' })
          else if (item.kind === 'model') onChange({ provider: item.provider, model: item.model.id, effort: '' })
          dismiss()
        }
        // Group headers are plain text, so keyboard movement skips them.
        const move = (step) => {
          if (items.length === 0) return
          let next = active
          for (let hop = 0; hop < items.length; hop += 1) {
            next = (next + step + items.length) % items.length
            if (items[next].kind !== 'group') break
          }
          setActive(next)
        }

        React.useEffect(() => {
          setActive(0)
        }, [query])
        React.useEffect(() => {
          if (!open) return undefined
          const outside = (event) => {
            if (box.current !== null && !box.current.contains(event.target)) dismiss()
          }
          document.addEventListener('pointerdown', outside, true)
          return () => document.removeEventListener('pointerdown', outside, true)
        }, [open])
        // Anchor the list to the button and keep it inside the window: it opens upward when
        // there is more room above, and its height is capped to the room on that side so the
        // last option stays reachable by scrolling instead of being clipped by the popover.
        React.useEffect(() => {
          if (!open) {
            setPlacement(null)
            return undefined
          }
          const node = box.current
          const viewport = typeof window === 'undefined' ? undefined : window.innerHeight
          if (node === null || node === undefined || typeof node.getBoundingClientRect !== 'function') return undefined
          const measure = () => {
            const next = popupPlacement(node.getBoundingClientRect(), viewport)
            if (next !== null) setPlacement(next)
          }
          measure()
          if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
          window.addEventListener('resize', measure)
          window.addEventListener('scroll', measure, true)
          return () => {
            window.removeEventListener('resize', measure)
            window.removeEventListener('scroll', measure, true)
          }
        }, [open])
        // Keyboard movement can walk past the visible slice of a capped list.
        React.useEffect(() => {
          if (!open) return
          const node = options.current.get(active)
          if (node !== null && node !== undefined && typeof node.scrollIntoView === 'function') {
            node.scrollIntoView({ block: 'nearest' })
          }
        }, [open, active, query])
        const renderItem = (item, index) => {
          if (item.kind === 'group') {
            return h('div', { key: 'g:' + item.group.id, style: groupStyle }, item.group.name ?? item.group.id)
          }
          const isUnset = item.kind === 'unset'
          const isModel = item.kind === 'model'
          const itemKey = isUnset ? 'unset' : isModel ? routeKey(item.provider, item.model.id) : 'unknown'
          const selected = isUnset ? key === '' : isModel ? key === itemKey : true
          const text = isUnset ? t('route.unset') : isModel ? item.model.name ?? item.model.id : key
          return h(
            'button',
            {
              key: itemKey,
              ref: (node) => {
                if (node === null || node === undefined) options.current.delete(index)
                else options.current.set(index, node)
              },
              type: 'button',
              role: 'option',
              'aria-selected': selected,
              style: optionStyle(active === index, selected),
              onMouseEnter: () => setActive(index),
              onClick: () => choose(item),
            },
            text,
          )
        }
        return h(
          'div',
          { style: { display: 'grid', gap: '4px' } },
          h('div', { style: { fontWeight: 600 } }, label),
          h(
            'div',
            { ref: box, style: { position: 'relative' } },
            h(
              'button',
              {
                type: 'button',
                style: modelButtonStyle,
                disabled,
                'aria-haspopup': 'listbox',
                'aria-expanded': open,
                'aria-label': label,
                onClick: () => (open ? dismiss() : setOpen(true)),
              },
              h(
                'span',
                { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                known
                  ? model.name ?? route.model
                  : route.model !== ''
                    ? route.model
                    : t('route.unset'),
              ),
              h(
                'span',
                { style: { color: 'var(--dsw-alias-label-tertiary, inherit)', flex: 'none' } },
                open ? '▴' : '▾',
              ),
            ),
            open
              ? h(
                  'div',
                  {
                    style: dropdownStyleOf(placement),
                    role: 'listbox',
                    'aria-label': label + ' · ' + t('route.search'),
                    'data-side': placement?.side,
                  },
                  h(
                    'div',
                    { style: filterRowStyle },
                    h('input', {
                      type: 'search',
                      value: query,
                      autoFocus: true,
                      placeholder: t('route.search'),
                      'aria-label': t('route.search'),
                      style: searchStyle,
                      onChange: (event) => setQuery(event.target.value),
                      onKeyDown: (event) => {
                        if (event.key === 'Escape') {
                          event.stopPropagation()
                          dismiss()
                        } else if (event.key === 'ArrowDown') {
                          event.preventDefault()
                          move(1)
                        } else if (event.key === 'ArrowUp') {
                          event.preventDefault()
                          move(-1)
                        } else if (event.key === 'Enter') {
                          event.preventDefault()
                          if (items[active] !== undefined && items[active].kind !== 'group') choose(items[active])
                        }
                      },
                    }),
                    h(
                      'span',
                      { style: { color: 'var(--dsw-alias-label-tertiary, inherit)', whiteSpace: 'nowrap' } },
                      countModels(visible) + '/' + countModels(groups),
                    ),
                  ),
                  items.length === 0
                    ? h(
                        'div',
                        { style: { padding: '6px 8px', color: 'var(--dsw-alias-label-tertiary, inherit)', lineHeight: 1.4 } },
                        t('route.noMatch') + ' · ' + t('route.noMatchHint'),
                      )
                    : items.map(renderItem),
                )
              : null,
          ),
          efforts.length === 0
            ? null
            : h(
                'select',
                {
                  style: selectStyle,
                  value: route.effort,
                  disabled,
                  'aria-label': label + ' · ' + t('route.effort'),
                  onChange: (event) => onChange({ ...route, effort: event.target.value }),
                },
                h('option', { value: '' }, t('route.effortDefault')),
                efforts.map((e) => h('option', { key: e.id, value: e.id }, e.name ?? e.id)),
              ),
        )
      }
      /** Button plus panel: pick the default model and effort for the main agent and for workers. */
      function RoutePicker({ t, scopes, orch, loadCatalog }) {
        const [open, setOpen] = React.useState(false)
        const [groups, setGroups] = React.useState(undefined)
        const [problem, setProblem] = React.useState(null)
        const [saving, setSaving] = React.useState(false)
        const main = useScope(scopes.main)
        const worker = useScope(scopes.worker)
        const plugin = useScope(orch)

        React.useEffect(() => {
          if (!open || groups !== undefined) return undefined
          let live = true
          loadCatalog().then(
            (response) => {
              if (!live) return
              if (response.ok) setGroups(response.value.groups)
              else setProblem(t('route.catalogFailed'))
            },
            () => {
              if (live) setProblem(t('route.catalogFailed'))
            },
          )
          return () => {
            live = false
          }
        }, [open, groups])

        const write = async (which, route) => {
          setSaving(true)
          setProblem(null)
          const target =
            which === 'main' ? { scope: scopes.main, fields: MAIN.fields }
            : which === 'worker' ? { scope: scopes.worker, fields: WORKER.fields }
            : { scope: scopes.orch, fields: REVIEW.fields }
          const failure = await saveRoute(target.scope, target.fields, route, t)
          setSaving(false)
          setProblem(failure)
        }

        const toggleEnabled = async (on) => {
          const snapshot = orch.getSnapshot()
          if (snapshot.status !== 'ready' || !snapshot.writable) {
            setProblem(t('route.readonly'))
            return
          }
          setSaving(true)
          setProblem(null)
          try {
            await orch.mutate([{ op: 'set', path: ['enabled'], value: on }], snapshot.revision)
          } catch (reason) {
            setProblem(typeof reason?.message === 'string' && reason.message !== '' ? reason.message : t('route.enableFailed'))
          }
          setSaving(false)
        }

        // 面板只展示结论与目标，从不展示整段 prompt（那是评审者的输入，不是给用户看的）。
        const lastReview = (() => {
          const raw = typeof plugin.value?.lastReview === 'string' ? plugin.value.lastReview : ''
          if (raw === '') return null
          try {
            const row = JSON.parse(raw)
            return row !== null && typeof row === 'object' && typeof row.verdict === 'string' ? row : null
          } catch {
            return null
          }
        })()

        const writable = main.writable === true && worker.writable === true
        const close = () => {
          setOpen(false)
        }
        return h(
          'span',
          { style: { position: 'relative', display: 'inline-flex' } },
          h(
            'button',
            {
              type: 'button',
              style: Object.assign({}, baseStyle, open ? onStyle : null),
              onClick: () => (open ? close() : setOpen(true)),
              title: t('route.title'),
              'aria-label': t('route.title'),
              'aria-expanded': open,
            },
            h('span', null, t('route.button')),
          ),
          open
            ? h(
                'div',
                { style: panelStyle, role: 'dialog', 'aria-label': t('route.title') },
                h(
                  'div',
                  { style: panelColumnStyle },
                  h(
                    'div',
                    { style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '0 0 8px' } },
                    h(
                      'div',
                      { style: { display: 'grid', gap: '2px', flex: '1 1 auto', minWidth: 0 } },
                      h('span', { style: { fontWeight: 600 } }, t('route.enable')),
                      h('span', { style: { color: 'var(--dsw-alias-label-tertiary, inherit)', lineHeight: 1.35 } }, t('route.enableNote')),
                    ),
                    h(EnableSwitch, {
                      checked: plugin.value?.enabled === true,
                      disabled: saving || plugin.writable !== true,
                      onChange: toggleEnabled,
                      label: t('route.enable'),
                    }),
                  ),
                  groups === undefined && problem === null
                    ? h('div', null, t('route.loading'))
                    : groups === undefined
                      ? null
                      : [
                          h(RouteRow, {
                            key: 'main',
                            label: t('route.main'),
                            route: routeOf(MAIN.fields, main.value),
                            groups,
                            disabled: saving || !writable,
                            onChange: (route) => write('main', route),
                            t,
                          }),
                          h(RouteRow, {
                            key: 'worker',
                            label: t('route.worker'),
                            route: routeOf(WORKER.fields, worker.value),
                            groups,
                            disabled: saving || !writable,
                            onChange: (route) => write('worker', route),
                            t,
                          }),
                          h(RouteRow, {
                            key: 'review',
                            label: t('route.review'),
                            route: routeOf(REVIEW.fields, plugin.value),
                            groups,
                            disabled: saving || !writable,
                            onChange: (route) => write('review', route),
                            t,
                          }),
                          h(
                            'div',
                            { style: { color: 'var(--dsw-alias-label-tertiary, inherit)', lineHeight: 1.4, padding: '2px 0 6px' } },
                            t('route.reviewNote'),
                          ),
                          h(
                            'div',
                            { style: { padding: '0 0 6px' }, 'data-testid': 'orchestrator-last-review' },
                            lastReview === null
                              ? t('route.lastReviewNone')
                              : t('route.lastReview') + ': ' + lastReview.verdict + (lastReview.target ? ' · ' + lastReview.target : ''),
                          ),
                        ],
                  h(SuperviseIntervalField, { scope: scopes.orch, t }),
                  problem === null ? null : h('div', { style: { color: 'var(--dsw-alias-label-error, #ff7b72)' }, role: 'alert' }, problem),
                  !writable && groups !== undefined
                    ? h('div', { style: { color: 'var(--dsw-alias-label-tertiary, inherit)' } }, t('route.readonly'))
                    : null,
                  h('div', { style: { color: 'var(--dsw-alias-label-tertiary, inherit)', lineHeight: 1.4 } }, t('route.note')),
                ),
                h(AllowedToolsPanel, { scope: scopes.orch, t }),
              )
            : null,
        )
      }

      // The Gateway mounts a namespace as the Cordis service `remote.<namespace>`
      // (remoteServiceKey in @deepseek-ai/dsh-api-gateway/lib/client.browser.js). Reading it as
      // a property runs through the host's traced Remote service, which resolves
      // `ctx.remote.<namespace>` through the inject gate and throws
      // `cannot get property "remote.orchestratorSecretary" without inject` for a plugin that did
      // not declare it — and declaring it would park this plugin until the host side exists.
      // `ctx.get(name)` is the inject-free service read the host itself uses (ctx.get("connection")),
      // so the mount and the namespace both go through it.
      const REMOTE_SERVICE = 'remote'

      /** Read a Cordis service without the inject gate; undefined when it is not provided. */
      function readService(ctx, name) {
        if (ctx === null || (typeof ctx !== 'object' && typeof ctx !== 'function')) return undefined
        if (typeof ctx.get !== 'function') return undefined
        try {
          return ctx.get(name)
        } catch {
          return undefined
        }
      }

      /**
       * The Remote service carrying `$mount`: the service lookup first, and the injected
       * `ctx.remote` property as a guarded fallback for a host that does not expose it by name.
       * Nothing here reaches for a `ctx.remote.<namespace>` property, and a fallback that throws
       * stays a fallback instead of bubbling into the view.
       */
      function remoteOf(ctx) {
        const viaGet = readService(ctx, REMOTE_SERVICE)
        if (viaGet !== null && viaGet !== undefined && typeof viaGet.$mount === 'function') return viaGet
        let viaProperty
        try {
          viaProperty = ctx?.remote
        } catch {
          return undefined
        }
        return viaProperty !== null && viaProperty !== undefined && typeof viaProperty.$mount === 'function'
          ? viaProperty
          : undefined
      }

      // ---- 秘书视图（票 07） -----------------------------------------------------------------
      // This bundle loads as one module (window.__ModuleLoader__), so the view is an increment of
      // this file: there is no second client module to import.

      /** The ticket-06 endpoint: the mounted namespace remote.<namespace>, one method. */
      const SECRETARY_SERVICE = 'remote.orchestratorSecretary'
      /** While the view is open it re-reads at this cadence; one timer serves all three tabs. */
      const SECRETARY_POLL_MS = 10000
      /** The three tabs, in render order. The ids are the contract; the labels are dictionary keys. */
      const SECRETARY_TABS = [
        { id: 'overview', labelKey: 'secretary.tab.overview' },
        { id: 'history', labelKey: 'secretary.tab.history' },
        { id: 'settings', labelKey: 'secretary.tab.settings' },
      ]
      /** One id in two seats: the main keyed slot and the sidebar.panellist list row. */
      const SECRETARY_PANEL_ID = 'secretary'
      /**
       * The five notify switches, keyed the way policy.notifyOn reads them; the values are the
       * names config stores. 与 lib/secretary-constants.js 的 NOTIFY_SWITCHES 必须一致（键、值与
       * 顺序）：客户端 bundle 不能 import 服务端模块，所以在这里镜像；test/client.test.mjs 断言
       * 两边相同。
       */
      const SECRETARY_NOTIFY_NAMES = Object.freeze({
        state: 'state-flip',
        step: 'step-advance',
        block: 'blocked',
        deliverable: 'deliverable',
        timeout: 'timeout',
      })
      const SECRETARY_NOTIFY_KEYS = Object.keys(SECRETARY_NOTIFY_NAMES)
      /**
       * 六态的具名常量。与 lib/master-state.js 的 WORKER_STATE 必须一致（键、值与顺序）：客户端
       * bundle 不能 import 服务端模块，所以在这里镜像；test/client.test.mjs 断言两边相同。
       */
      const WORKER_STATE = Object.freeze({
        working: 'Working',
        needsInput: 'Needs input',
        idle: 'Idle',
        completed: 'Completed',
        failed: 'Failed',
        stopped: 'Stopped',
      })
      /**
       * The two policy numbers. 'key' is the full config key a write must name
       * (secretaryBeatSeconds, not the payload's short beatSeconds), 'policyKey' is how the
       * endpoint's payload spells it, and 'labelKey' is the dictionary entry. An
       * abbreviation is never a path segment: a write to beatSeconds reaches no field.
       */
      const SECRETARY_NUMBER_FIELDS = Object.freeze([
        { key: 'secretaryBeatSeconds', policyKey: 'beatSeconds', labelKey: 'secretary.beatSeconds' },
        { key: 'secretaryMaxRunSeconds', policyKey: 'maxRunSeconds', labelKey: 'secretary.maxRunSeconds' },
      ])

      /**
       * The codec of the one Client-supplied field, `draftId`.
       *
       * Why it is declared here at all: the Gateway refuses to mount a contribution whose
       * parameters have no strict codec — `client api: generated Remote
       * orchestratorSecretary/confirmDraft field undefined has no strict codec`
       * (@deepseek-ai/dsh-api-gateway lib/types/client/index.js, requireStrictInputs), and the
       * Typert registry repeats the rule when it stores the descriptor: a strict codec carries
       * a type symbol and a create() factory (@deepseek-ai/dsh-typert-registry
       * lib/client.browser.js, validateCodec). SRC mode has no Client type projection, so this
       * bundle carries the declaration itself: a plain string is the whole contract, and the
       * Host still validates the received value through its own SRC descriptor (JSON safety
       * only, never this schema).
       *
       * `wire` is not decoration: the Gateway builds the request args from it
       * (prepareInvocation), so without it the Host would receive no `draftId` and refuse the
       * call as an unexpected field.
       */
      const SECRETARY_DRAFT_ID_CODEC = Object.freeze({
        mode: 'strict',
        typeSymbol: 'dsh-orchestrator#orchestratorSecretary:draftId',
        jsonSchema: { type: 'string' },
        // A real schema factory, not a placeholder: a unary direct call sends the value without
        // running it, but a projection that asks for the schema must get the real one. zod is
        // in the loader whenever this client runs — the injected @deepseek-ai/dsh-api-remotes
        // client requires it by the same id.
        create: () => require('zod').z.string(),
      })

      /**
       * The hand-written Remote contribution for the ticket-06 Service: a plain JavaScript
       * Service in SRC mode ships no generated artifact, so the three results stay src-json
       * (commit 814d662, master panel): the Host sends them as raw JSON and no generated
       * decoder exists for the view's own shapes. The one Client-supplied field declares a
       * strict codec (SECRETARY_DRAFT_ID_CODEC), because the Gateway refuses inputs it cannot
       * type.
       */
      const SECRETARY_CONTRIBUTION = {
        package: 'dsh-orchestrator-secretary',
        descriptors: [
          {
            id: 'dsh-orchestrator-secretary#orchestratorSecretary/secretaryState',
            service: 'orchestratorSecretary',
            namespace: 'orchestratorSecretary',
            method: 'secretaryState',
            invocation: { kind: 'direct' },
            parameters: [],
            result: { mode: 'src-json' },
            sourceLocation: { file: 'lib/secretary-panel.js', line: 1, column: 1 },
          },
          // Ticket 08: the two draft transitions, one plain draftId each. SRC reflection
          // reads the parameter name from the method source, so it must stay a plain name.
          {
            id: 'dsh-orchestrator-secretary#orchestratorSecretary/confirmDraft',
            service: 'orchestratorSecretary',
            namespace: 'orchestratorSecretary',
            method: 'confirmDraft',
            invocation: { kind: 'direct' },
            parameters: [{ name: 'draftId', wire: 'draftId', source: 'json', codec: SECRETARY_DRAFT_ID_CODEC }],
            result: { mode: 'src-json' },
            sourceLocation: { file: 'lib/secretary-panel.js', line: 1, column: 1 },
          },
          {
            id: 'dsh-orchestrator-secretary#orchestratorSecretary/discardDraft',
            service: 'orchestratorSecretary',
            namespace: 'orchestratorSecretary',
            method: 'discardDraft',
            invocation: { kind: 'direct' },
            parameters: [{ name: 'draftId', wire: 'draftId', source: 'json', codec: SECRETARY_DRAFT_ID_CODEC }],
            result: { mode: 'src-json' },
            sourceLocation: { file: 'lib/secretary-panel.js', line: 1, column: 1 },
          },
        ],
      }

      /** A trimmed display string; anything else is the empty string. */
      function secText(value) {
        return typeof value === 'string' ? value.trim() : ''
      }

      /** The list a segment may hold; anything else is no rows. */
      function secRows(value) {
        return Array.isArray(value) ? value : []
      }

      /** An object or an empty one; arrays and scalars are not objects here. */
      function secObject(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
      }

      /** A non-negative integer, or null. */
      function secCount(value) {
        return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
      }

      /** A positive integer from a number or a digit string; anything else is null. */
      function secPositive(value) {
        if (typeof value === 'number') return Number.isInteger(value) && value > 0 ? value : null
        if (typeof value !== 'string') return null
        const trimmed = value.trim()
        if (!/^[0-9]+$/.test(trimmed)) return null
        const number = Number(trimmed)
        return number > 0 ? number : null
      }

      /** Minute-precision local stamp; an absent or zero time is the empty string. */
      function secTime(value) {
        const stamp = secCount(value)
        if (stamp === null || stamp === 0) return ''
        const date = new Date(stamp)
        const pad = (part) => (part < 10 ? '0' + part : String(part))
        return (
          date.getFullYear() +
          '-' +
          pad(date.getMonth() + 1) +
          '-' +
          pad(date.getDate()) +
          ' ' +
          pad(date.getHours()) +
          ':' +
          pad(date.getMinutes())
        )
      }

      /** The three tabs; a fresh list each call, so a caller cannot reorder the view's vocabulary. */
      function secretaryTabsOf() {
        return SECRETARY_TABS.map((tab) => ({ id: tab.id, labelKey: tab.labelKey }))
      }

      /**
       * The rows of the blocker area: a registered session that waits for the user or had its
       * beat stopped, plus every pending nudge draft.
       *
       * The registry conflict is deliberately not a row here — it is one warning line above the
       * rows, so the overview reads payload.registry.conflict itself.
       */
      function secretaryBlockersOf(payload) {
        const source = secObject(payload)
        const blockers = []
        for (const raw of secRows(source.orchestrators)) {
          const row = secObject(raw)
          const sessionId = secText(row.sessionId)
          if (sessionId === '') continue
          const beats = secObject(row.beats)
          // Only the two conditions the payload can actually report. The old error branch read a
          // field the endpoint no longer sends, so it was dead code that looked supported.
          const reasons = []
          if (row.state === WORKER_STATE.needsInput) reasons.push('needsInput')
          if (beats.capped === true) reasons.push('capped')
          if (reasons.length === 0) continue
          blockers.push({
            sessionId,
            title: secText(row.title) || sessionId,
            reason: reasons[0],
            reasons,
            text: beats.capped === true ? secText(beats.stoppedReason) : '',
          })
        }
        for (const raw of secRows(source.drafts)) {
          const draft = secObject(raw)
          if ((secText(draft.status) || 'pending') !== 'pending') continue
          const sessionId = secText(draft.sessionId) || secText(draft.targetSessionId)
          blockers.push({
            sessionId,
            title: secText(draft.targetTitle) || sessionId,
            reason: 'draft',
            reasons: ['draft'],
            // The generated body is the card; the reason is only the dedupe key.
            text: secText(draft.text) || secText(draft.reason),
            draftId: secText(draft.id),
          })
        }
        return blockers
      }

      /**
       * The tracking tree: one row per registered session, with the live run folded in by id.
       *
       * The registry decides what is tracked, so a run row whose session was never registered does
       * not appear here. A registered session that is gone keeps its row with live:false, so its
       * history does not vanish when the session ends.
       */
      function secretaryRowsOf(payload) {
        const source = secObject(payload)
        const live = new Map()
        for (const raw of secRows(source.orchestrators)) {
          const row = secObject(raw)
          const sessionId = secText(row.sessionId)
          if (sessionId !== '') live.set(sessionId, row)
        }
        return secRows(secObject(source.registry).orchestrators).map((raw) => {
          const entry = secObject(raw)
          const sessionId = secText(entry.sessionId)
          const run = live.get(sessionId)
          const beats = secObject(run === undefined ? undefined : run.beats)
          const report = secObject(run === undefined ? undefined : run.lastReport)
          const beatCount = secCount(beats.count)
          const reportAt = secCount(report.at)
          const workspace = secText(entry.workspace) || secText(run === undefined ? undefined : run.workspace)
          return {
            sessionId,
            title: secText(entry.title) || secText(run === undefined ? undefined : run.title) || sessionId,
            workspace,
            // The endpoint could not resolve a directory for this ledger row, so nothing under
            // it is read: the row says so instead of looking like a session that never reported.
            workspaceMissing: entry.workspaceMissing === true && workspace === '',
            live: run !== undefined && run.live === true,
            state: secText(run === undefined ? undefined : run.state) || WORKER_STATE.idle,
            beats: {
              count: beatCount === null ? 0 : beatCount,
              capped: beats.capped === true,
              stoppedReason: secText(beats.stoppedReason),
            },
            lastReportAt: reportAt === null ? 0 : reportAt,
            lastReportKind: secText(report.kind),
            workers: secRows(run === undefined ? undefined : run.workers).map((item) => {
              const worker = secObject(item)
              return { id: secText(worker.id), state: secText(worker.state) || WORKER_STATE.idle, summary: secText(worker.summary) }
            }),
          }
        })
      }

      /**
       * The three diff groups of one report.
       *
       * Why changed (ticket 08): the endpoint now sends { completed, blocked, flipped }, the
       * same shape lib/secretary-diff.js returns, so the view reads the structure and does
       * not reverse-engineer the writer's sentence shapes. A flat string array can still
       * arrive from a host that predates that field; it is grouped by shape as before and
       * flagged degraded so the settings tab can say so instead of the page guessing.
       */
      function changesOfReport(raw) {
        if (Array.isArray(raw)) {
          return { changes: diffGroupsOf(raw), degraded: true }
        }
        const source = secObject(raw)
        const group = (value) =>
          secRows(value)
            .map((item) => secText(item))
            .filter((item) => item !== '')
        return {
          changes: {
            completed: group(source.completed),
            blocked: group(source.blocked),
            flipped: group(source.flipped),
            other: [],
          },
          degraded: false,
        }
      }

      /** The history rows: the archived reports, in the order the endpoint already sorted them. */
      function reportLinesOf(payload) {
        return secRows(secObject(payload).reports).map((raw) => {
          const report = secObject(raw)
          const at = secCount(report.at)
          const diff = changesOfReport(report.changes)
          return {
            sessionId: secText(report.sessionId),
            at: at === null ? 0 : at,
            kind: secText(report.kind) || 'unknown',
            path: secText(report.path),
            changes: diff.changes,
            degraded: diff.degraded,
            error: secText(report.error),
          }
        })
      }

      /** The nudge drafts: the stuck session, the generated body and the confirm state. */
      function draftRowsOf(payload) {
        return secRows(secObject(payload).drafts).map((raw) => {
          const draft = secObject(raw)
          return {
            id: secText(draft.id),
            // 'targetSessionId' is the pre-ticket-08 field name; reading both keeps an older
            // host's payload renderable instead of losing the row's session.
            sessionId: secText(draft.sessionId) || secText(draft.targetSessionId),
            reason: secText(draft.reason),
            status: secText(draft.status) || 'pending',
            text: typeof draft.text === 'string' ? draft.text : '',
            createdAt: secCount(draft.createdAt) ?? 0,
            sentAt: secCount(draft.sentAt) ?? 0,
          }
        })
      }

      /**
       * The three diff groups of one report, recovered from the flat changes list the endpoint
       * hands over.
       *
       * lib/secretary-diff.js gives every bullet one of three shapes — "…：完成" or "…：等确认"
       * ("会话进入 Needs input") or "名字：A → B" — and lib/secretary-report.js writes them in the
       * fixed 新完成 / 新卡住 / 状态翻转 order. Flattening dropped the headings, so the shapes are
       * what is left to group by. A bullet that matches none of them is kept under "other"
       * instead of being dropped: a template change then shows up in the view rather than
       * silently losing rows.
       */
      function diffGroupsOf(lines) {
        const groups = { completed: [], blocked: [], flipped: [], other: [] }
        for (const line of secRows(lines)) {
          const text = secText(line)
          if (text === '') continue
          if (text.endsWith('：等确认') || text === '会话进入 Needs input') groups.blocked.push(text)
          else if (
            text.endsWith('：完成') ||
            text.startsWith('进度：') ||
            text.startsWith('产出：') ||
            /：首次出现（/.test(text)
          )
            groups.completed.push(text)
          else if (/：.+ → .+/.test(text)) groups.flipped.push(text)
          else groups.other.push(text)
        }
        return groups
      }

      /**
       * The layout: at 1100 and wider the tracker tree sits left and the detail column right;
       * below it the two stack, blockers first. Only the list regions scroll — the root is a
       * clipped frame — so the overview never grows a page scrollbar.
       */
      function secretaryStyleOf(width) {
        const measured = typeof width === 'number' && Number.isFinite(width) ? width : 0
        const wide = measured >= 1100
        return {
          wide,
          root: {
            height: '100%',
            minWidth: 0,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            padding: '12px',
            boxSizing: 'border-box',
            fontSize: '12px',
            color: 'inherit',
          },
          columns: {
            display: 'grid',
            gridTemplateColumns: wide ? 'minmax(0, 2fr) minmax(0, 1fr)' : 'minmax(0, 1fr)',
            gap: '12px',
            minWidth: 0,
            minHeight: 0,
            flex: '1 1 auto',
            overflow: 'hidden',
            alignItems: 'stretch',
          },
          listOverflow: { overflowY: 'auto', overflowX: 'hidden', minWidth: 0, minHeight: 0, maxHeight: '100%' },
        }
      }

      const secMutedStyle = { color: 'var(--dsw-alias-label-tertiary, inherit)', lineHeight: 1.4 }
      const secSectionHeadStyle = {
        color: 'var(--dsw-alias-label-tertiary, inherit)',
        fontSize: '11px',
        fontWeight: 600,
      }
      const secPanelStyle = {
        border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 22%, transparent))',
        borderRadius: '10px',
        padding: '10px',
        display: 'grid',
        gap: '6px',
        minWidth: 0,
      }
      const secBadgeStyle = {
        flex: 'none',
        padding: '0 6px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 22%, transparent))',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        fontSize: '11px',
        lineHeight: '16px',
      }
      const secRowStyle = { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, lineHeight: 1.5 }
      const secButtonStyle = {
        font: 'inherit',
        fontSize: '11px',
        lineHeight: 1.4,
        padding: '2px 8px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 22%, transparent))',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }
      const secTrackRowStyle = Object.assign({}, secButtonStyle, {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        width: '100%',
        textAlign: 'left',
      })
      const secTabStyle = {
        font: 'inherit',
        fontSize: '12px',
        lineHeight: 1,
        height: '26px',
        padding: '0 10px',
        borderRadius: '8px',
        border: '1px solid transparent',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }
      const secTabOnStyle = {
        color: 'inherit',
        background: 'var(--dsw-alias-button-ghost-active-fill, color-mix(in srgb, currentColor 12%, transparent))',
        borderColor: 'var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 22%, transparent))',
      }
      const secErrorStyle = {
        color: 'var(--dsw-alias-label-error, #ff7b72)',
        lineHeight: 1.4,
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flexWrap: 'wrap',
      }
      const secInputStyle = {
        font: 'inherit',
        fontSize: '12px',
        width: '100%',
        boxSizing: 'border-box',
        padding: '4px 6px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 22%, transparent))',
        background: 'transparent',
        color: 'inherit',
      }
      const secLabelStyle = { display: 'grid', gap: '3px', minWidth: 0 }

      /**
       * The sidebar glyph.
       *
       * Decorative on purpose: sidebar.panellist renders this inside the row's own button
       * (dsh-client-ui-sidebar PanelRow), and that button already calls
       * ctx.layout.selectPanel(id) — the seat the plugin manager and the task manager take. A
       * second button here would nest two buttons and fire the selection twice.
       */
      function SecretaryIcon({ size }) {
        const edge = typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : 18
        return h(
          'svg',
          {
            width: edge,
            height: edge,
            viewBox: '0 0 16 16',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.2,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
            focusable: 'false',
            'data-testid': 'orchestrator-secretary-icon',
            style: { display: 'block' },
          },
          h('rect', { key: 'frame', x: 2.25, y: 3, width: 11.5, height: 10, rx: 2 }),
          h('path', { key: 'lines', d: 'M4.75 6.5h4.5M4.75 9h6.5M4.75 11.5h3' }),
        )
      }

      /**
       * The overview tab: the blocker area on top (with the nudge draft cards), the current run
       * under it and the tracking tree in the left column. The only actions are opening a
       * registered session and confirming/discarding a draft.
       */
      function SecretaryOverview({ t, payload, width, openSession, nudge, refresh }) {
        const style = secretaryStyleOf(width)
        const rows = secretaryRowsOf(payload)
        const blockers = secretaryBlockersOf(payload)
        const drafts = draftRowsOf(payload)
        const registry = secObject(secObject(payload).registry)
        const conflict = secObject(registry.conflict)
        const conflictIds = secRows(conflict.conflictingOrchestratorIds)
          .map((id) => secText(id))
          .filter((id) => id !== '')
        const master = secText(registry.masterSessionId)
        const running = secRows(secObject(payload).orchestrators)
          .map((row) => secObject(row))
          .find((row) => row.state === WORKER_STATE.working)
        const openable = typeof openSession === 'function'

        // Group the tree by workspace in registry order; a session with no workspace is a group
        // of its own instead of a row claiming a folder it does not have.
        const groups = []
        const byWorkspace = new Map()
        for (const row of rows) {
          let group = byWorkspace.get(row.workspace)
          if (group === undefined) {
            group = { workspace: row.workspace, rows: [] }
            byWorkspace.set(row.workspace, group)
            groups.push(group)
          }
          group.rows.push(row)
        }

        const trackerRow = (row) => {
          const canOpen = openable && row.live
          const suffix = []
          if (!row.live) suffix.push(t('secretary.ended'))
          if (master !== '' && row.sessionId === master) suffix.push(t('secretary.master'))
          return h(
            'button',
            {
              key: row.sessionId,
              type: 'button',
              'data-testid': 'orchestrator-secretary-row-' + row.sessionId,
              disabled: !canOpen,
              title: canOpen ? t('secretary.open') : t('secretary.rowDisabled'),
              onClick: () => {
                if (canOpen) openSession(row.sessionId)
              },
              style: Object.assign({}, secTrackRowStyle, canOpen ? null : { cursor: 'default', opacity: 0.6 }),
            },
            h(
              'span',
              {
                style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              },
              row.title,
              suffix.length === 0 ? '' : ' · ' + suffix.join(' · '),
            ),
            row.workspaceMissing === true
              ? h(
                  'span',
                  {
                    'data-testid': 'orchestrator-secretary-workspace-missing-' + row.sessionId,
                    style: { flex: 'none', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, inherit)' },
                  },
                  t('secretary.workspaceMissing'),
                )
              : null,
            h('span', { style: secBadgeStyle }, row.state),
            row.lastReportAt === 0
              ? null
              : h(
                  'span',
                  { style: { flex: 'none', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, inherit)' } },
                  secTime(row.lastReportAt),
                ),
          )
        }

        const tracker = h(
          'section',
          { style: secPanelStyle, 'data-testid': 'orchestrator-secretary-tree' },
          h('div', { style: secSectionHeadStyle }, t('secretary.tree')),
          rows.length === 0
            ? h('div', { style: secMutedStyle }, t('secretary.treeEmpty'))
            : h(
                'div',
                { style: { display: 'grid', gap: '8px', minWidth: 0 } },
                groups.map((group) =>
                  h(
                    'div',
                    {
                      key: group.workspace === '' ? '-' : group.workspace,
                      style: { display: 'grid', gap: '2px', minWidth: 0 },
                    },
                    h(
                      'div',
                      {
                        style: {
                          color: 'var(--dsw-alias-label-tertiary, inherit)',
                          fontSize: '11px',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        },
                        title: group.workspace,
                      },
                      group.workspace === '' ? t('secretary.workspaceNone') : group.workspace,
                    ),
                    group.rows.map(trackerRow),
                  ),
                ),
              ),
        )

        // ---- 催办草稿卡（票 08） ----
        // A pending draft is not sent by rendering it. The two buttons call the write endpoint;
        // a refused send keeps the draft pending and only adds the reason under the card.
        const [draftFeedback, setDraftFeedback] = React.useState({})
        const canNudge = typeof nudge === 'function'
        const setFeedback = (draftId, next) => {
          setDraftFeedback((current) => {
            const copy = Object.assign({}, current)
            if (next === null) delete copy[draftId]
            else copy[draftId] = next
            return copy
          })
        }
        const runDraftAction = (draft, action) => {
          if (!canNudge || draft.id === '') return undefined
          setFeedback(draft.id, { busy: true, error: '' })
          return Promise.resolve()
            .then(() => nudge(draft.id, action))
            .then(
              (value) => {
                const result = secObject(value)
                const accepted =
                  action === 'confirm' ? result.delivered === true : secText(secObject(result.draft).id) !== ''
                if (!accepted) {
                  const reason = secText(result.reason) || t('secretary.draft.failed')
                  setFeedback(draft.id, { busy: false, error: t('secretary.draft.failed') + ' ' + reason })
                  return
                }
                setFeedback(draft.id, null)
                // Re-read the endpoint so status, sentAt and the remaining drafts are the host's
                // answer, not a local guess.
                if (typeof refresh === 'function') refresh()
              },
              (reason) => {
                const message =
                  reason !== null && typeof reason === 'object' && typeof reason.message === 'string' ? reason.message : ''
                setFeedback(draft.id, {
                  busy: false,
                  error: t('secretary.draft.failed') + ' ' + (message === '' ? t('secretary.saveFailed') : message),
                })
              },
            )
        }

        const draftCard = (draft) => {
          const feedback = secObject(draftFeedback[draft.id])
          const pending = draft.status === 'pending'
          const busy = feedback.busy === true
          const error = secText(feedback.error)
          return h(
            'div',
            {
              key: 'draft:' + draft.id,
              'data-testid': 'orchestrator-secretary-draft-' + draft.id,
              style: {
                display: 'grid',
                gap: '4px',
                minWidth: 0,
                padding: '6px 8px',
                borderRadius: '8px',
                border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 22%, transparent))',
              },
            },
            h(
              'div',
              { style: secRowStyle },
              h('span', { style: secBadgeStyle }, t('secretary.draft.' + draft.status)),
              h(
                'span',
                {
                  title: draft.sessionId,
                  style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                },
                draft.sessionId === '' ? t('secretary.stepNone') : draft.sessionId,
              ),
            ),
            h('div', { style: { lineHeight: 1.5, whiteSpace: 'pre-wrap', minWidth: 0 } }, draft.text),
            pending
              ? h(
                  'div',
                  { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
                  h(
                    'button',
                    {
                      type: 'button',
                      style: secButtonStyle,
                      disabled: busy || !canNudge,
                      'data-testid': 'orchestrator-secretary-draft-confirm-' + draft.id,
                      onClick: () => runDraftAction(draft, 'confirm'),
                    },
                    t('secretary.draft.confirm'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      style: secButtonStyle,
                      disabled: busy || !canNudge,
                      'data-testid': 'orchestrator-secretary-draft-discard-' + draft.id,
                      onClick: () => runDraftAction(draft, 'discard'),
                    },
                    t('secretary.draft.discard'),
                  ),
                  canNudge ? null : h('span', { style: secMutedStyle }, t('secretary.draft.unavailable')),
                )
              : h(
                  'div',
                  { style: secMutedStyle },
                  draft.status === 'sent'
                    ? t('secretary.draft.sentAt') + ' ' + (secTime(draft.sentAt) || t('secretary.stepNone'))
                    : t('secretary.draft.discarded'),
                ),
            error === '' ? null : h(
              'div',
              {
                role: 'alert',
                'data-testid': 'orchestrator-secretary-draft-error-' + draft.id,
                style: secErrorStyle,
              },
              error,
            ),
          )
        }

        // A pending draft has its own card, so the generic blocker row would only repeat the
        // session line without the body or the buttons.
        const blockerRows = blockers
          .filter((blocker) => blocker.reason !== 'draft')
          .map((blocker) =>
            h(
              'div',
              {
                key: blocker.sessionId + ':' + blocker.reason,
                'data-testid': 'orchestrator-secretary-blocker-' + blocker.sessionId,
                style: Object.assign({}, secRowStyle, { alignItems: 'flex-start' }),
              },
              h('span', { style: secBadgeStyle }, t('secretary.reason.' + blocker.reason)),
              h(
                'span',
                { style: { flex: '1 1 auto', minWidth: 0, display: 'grid', gap: '1px' } },
                h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, blocker.title),
                blocker.text === '' ? null : h('span', { style: secMutedStyle }, blocker.text),
              ),
              h(
                'button',
                {
                  type: 'button',
                  style: secButtonStyle,
                  disabled: !(openable && blocker.sessionId !== ''),
                  title: openable && blocker.sessionId !== '' ? t('secretary.open') : t('secretary.rowDisabled'),
                  onClick: () => {
                    if (openable && blocker.sessionId !== '') openSession(blocker.sessionId)
                  },
                },
                t('secretary.open'),
              ),
            ),
          )

        const draftCards = drafts.map(draftCard)
        const blockerSection = h(
          'section',
          { style: secPanelStyle, 'data-testid': 'orchestrator-secretary-blockers' },
          h('div', { style: secSectionHeadStyle }, t('secretary.blockers')),
          conflictIds.length === 0
            ? null
            : h(
                'div',
                {
                  'data-testid': 'orchestrator-secretary-conflict',
                  style: { color: 'var(--dsw-alias-label-secondary, inherit)', lineHeight: 1.4 },
                },
                t('secretary.conflict') + ' ' + conflictIds.join(', '),
              ),
          blockers.length === 0 && drafts.length === 0
            ? h('div', { style: secMutedStyle }, t('secretary.blockersEmpty'))
            : h(
                'div',
                { style: { display: 'grid', gap: '4px', minWidth: 0 } },
                blockerRows,
                drafts.length === 0
                  ? null
                  : h(
                      'div',
                      { style: { display: 'grid', gap: '4px', minWidth: 0 } },
                      h('div', { style: secSectionHeadStyle }, t('secretary.drafts')),
                      draftCards,
                    ),
              ),
        )

        const workerRow = (worker) =>
          h(
            'div',
            {
              key: worker.id,
              role: 'row',
              'data-testid': 'orchestrator-secretary-worker-' + worker.id,
              style: { display: 'flex', gap: '6px', minWidth: 0, lineHeight: 1.5 },
            },
            h(
              'span',
              {
                role: 'cell',
                title: worker.id,
                style: {
                  flex: '0 0 88px',
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  color: 'var(--dsw-alias-label-tertiary, inherit)',
                },
              },
              worker.id.slice(0, 8),
            ),
            h('span', { role: 'cell', style: { flex: '0 0 76px', minWidth: 0 } }, worker.state),
            h(
              'span',
              {
                role: 'cell',
                title: worker.summary,
                style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              },
              worker.summary === '' ? t('secretary.workerSummaryEmpty') : worker.summary,
            ),
          )

        const workerTable = (workers) =>
          h(
            'div',
            { role: 'table', 'aria-label': t('secretary.workers'), style: { display: 'grid', gap: '2px', minWidth: 0 } },
            h(
              'div',
              {
                role: 'row',
                style: {
                  display: 'flex',
                  gap: '6px',
                  minWidth: 0,
                  fontSize: '11px',
                  color: 'var(--dsw-alias-label-tertiary, inherit)',
                },
              },
              h('span', { role: 'columnheader', style: { flex: '0 0 88px' } }, t('secretary.workerId')),
              h('span', { role: 'columnheader', style: { flex: '0 0 76px' } }, t('secretary.workerState')),
              h('span', { role: 'columnheader', style: { flex: '1 1 auto', minWidth: 0 } }, t('secretary.workerSummary')),
            ),
            workers.length === 0
              ? h('div', { style: secMutedStyle }, t('secretary.workersEmpty'))
              : workers.map(workerRow),
          )

        const currentSection = h(
          'section',
          { style: secPanelStyle, 'data-testid': 'orchestrator-secretary-current' },
          h('div', { style: secSectionHeadStyle }, t('secretary.current')),
          running === undefined
            ? h('div', { style: secMutedStyle }, t('secretary.currentEmpty'))
            : h(
                'div',
                { style: { display: 'grid', gap: '6px', minWidth: 0 } },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'baseline', gap: '6px', minWidth: 0, flexWrap: 'wrap' } },
                  h(
                    'span',
                    {
                      style: {
                        fontWeight: 600,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      },
                    },
                    secText(running.title) || secText(running.sessionId),
                  ),
                  h('span', { style: secBadgeStyle }, secText(running.state) || WORKER_STATE.idle),
                ),
                workerTable(secRows(running.workers).map((item) => secObject(item))),
              ),
        )

        const columnStyle = Object.assign({}, style.listOverflow, {
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
        })
        const trackerColumn = h('div', { key: 'tree', style: columnStyle }, tracker)
        const detailColumn = h('div', { key: 'detail', style: columnStyle }, blockerSection, currentSection)
        const columns = style.wide ? [trackerColumn, detailColumn] : [detailColumn, trackerColumn]

        return h('div', { style: style.columns, 'data-testid': 'orchestrator-secretary-overview' }, columns)
      }

      /** The history tab: the newest report's diff in the writer's three groups, then the timeline. */
      function SecretaryHistory({ t, payload }) {
        const lines = reportLinesOf(payload)
        const newest = lines.length === 0 ? undefined : lines[0]
        // The endpoint already grouped the diff; a legacy row arrives grouped by the fallback.
        const groups = newest === undefined ? undefined : newest.changes

        const groupList = (key, labelKey) =>
          h(
            'div',
            { key, style: { display: 'grid', gap: '1px', minWidth: 0 } },
            h(
              'div',
              { style: { color: 'var(--dsw-alias-label-tertiary, inherit)', fontSize: '11px', fontWeight: 600 } },
              t(labelKey) + ' · ' + String(groups[key].length),
            ),
            groups[key].length === 0
              ? h('div', { style: secMutedStyle }, t('secretary.diffNone'))
              : groups[key].map((item, index) =>
                  h('div', { key: key + ':' + String(index), style: { lineHeight: 1.5, minWidth: 0 } }, '· ' + item),
                ),
          )

        const diffSection = h(
          'section',
          { style: secPanelStyle, 'data-testid': 'orchestrator-secretary-diff' },
          h('div', { style: secSectionHeadStyle }, t('secretary.diff')),
          newest === undefined
            ? h('div', { style: secMutedStyle }, t('secretary.diffEmpty'))
            : h(
                'div',
                {
                  style: {
                    display: 'grid',
                    gap: '10px',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                    minWidth: 0,
                  },
                },
                groupList('completed', 'secretary.diff.completed'),
                groupList('blocked', 'secretary.diff.blocked'),
                groupList('flipped', 'secretary.diff.flipped'),
                groups.other.length === 0 ? null : groupList('other', 'secretary.diff.other'),
              ),
        )

        const timeline = h(
          'section',
          { style: secPanelStyle, 'data-testid': 'orchestrator-secretary-timeline' },
          h('div', { style: secSectionHeadStyle }, t('secretary.timeline')),
          lines.length === 0
            ? h('div', { style: secMutedStyle }, t('secretary.timelineEmpty'))
            : h(
                'div',
                { style: { display: 'grid', gap: '4px', minWidth: 0 } },
                lines.map((line, index) =>
                  h(
                    'div',
                    {
                      key: line.path === '' ? 'report-' + String(index) : line.path,
                      style: Object.assign({}, secRowStyle, { alignItems: 'baseline' }),
                    },
                    h(
                      'span',
                      {
                        style: {
                          flex: 'none',
                          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                          color: 'var(--dsw-alias-label-tertiary, inherit)',
                        },
                      },
                      secTime(line.at),
                    ),
                    h('span', { style: secBadgeStyle }, t('secretary.reportKind.' + line.kind)),
                    h(
                      'span',
                      {
                        title: line.path,
                        style: {
                          flex: '1 1 auto',
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        },
                      },
                      line.path === '' ? t('secretary.reportPathNone') : line.path,
                    ),
                    line.error === ''
                      ? null
                      : h(
                          'span',
                          { title: line.error, style: { flex: 'none', color: 'var(--dsw-alias-label-error, #ff7b72)' } },
                          t('secretary.reportError'),
                        ),
                  ),
                ),
              ),
        )

        return h(
          'div',
          {
            style: {
              display: 'grid',
              gap: '10px',
              minWidth: 0,
              minHeight: 0,
              flex: '1 1 auto',
              overflowY: 'auto',
              alignContent: 'start',
            },
          },
          diffSection,
          timeline,
        )
      }

      /** The stored row ids, in storage order; undefined when the host sends no raw list. */
      function storedOrchestratorIds(registry) {
        const raw = secObject(registry).raw
        if (!Array.isArray(raw)) return undefined
        return raw.map((entry) => secText(secObject(entry).sessionId))
      }

      /** The normalized ledger rows, in the shape the stored list holds. */
      function ledgerRowsOf(registry) {
        return secRows(secObject(registry).orchestrators).map((raw) => {
          const row = secObject(raw)
          return {
            sessionId: secText(row.sessionId),
            workspace: secText(row.workspace),
            title: secText(row.title),
            trackedAt: secCount(row.trackedAt) ?? 0,
          }
        })
      }

      /**
       * The ops that drop 'ids' from the stored orchestrator list.
       *
       * The index has to come from registry.raw, the stored list: registry.orchestrators is
       * normalized (deduped, Master row dropped), so the same index addresses a different row as
       * soon as storage holds a duplicate or a Master-conflicting row — the unset then deletes
       * the wrong session. When an id has no stored row, or the host sends no raw list at all,
       * the whole list is rewritten from the normalized rows instead of guessing an index; one
       * unset per row would also shift every index after the first.
       */
      function removalOps(registry, ids) {
        const wanted = []
        for (const raw of secRows(ids)) {
          const sessionId = secText(raw)
          if (sessionId !== '' && !wanted.includes(sessionId)) wanted.push(sessionId)
        }
        if (wanted.length === 0) return []
        const stored = storedOrchestratorIds(registry)
        const at = stored === undefined || wanted.length !== 1 ? -1 : stored.indexOf(wanted[0])
        if (at >= 0) return [{ op: 'unset', path: ['secretaryOrchestrators', String(at)] }]
        return [
          {
            op: 'set',
            path: ['secretaryOrchestrators'],
            value: ledgerRowsOf(registry).filter((row) => !wanted.includes(row.sessionId)),
          },
        ]
      }

      /**
       * The settings tab: the policy numbers, the five notify switches, the standing prompt, the
       * tracking switch, and the session bindings. Every number shown comes from payload.policy;
       * a write failure stays inside this tab instead of escaping as a toast.
       */
      function SecretarySettings({ t, orch, payload, mutate }) {
        const snapshot = useScope(orch)
        const policy = secObject(secObject(payload).policy)
        const registry = secObject(secObject(payload).registry)
        // A host that predates the structured diff still answers a flat string list; the view
        // keeps rendering it but says here that the grouping was reconstructed, not read.
        const degraded = reportLinesOf(payload).some((line) => line.degraded)
        const notify = secObject(policy.notifyOn)
        const [drafts, setDrafts] = React.useState({})
        const [binding, setBinding] = React.useState({ id: '', title: '' })
        const [error, setError] = React.useState(null)
        const [busy, setBusy] = React.useState(false)
        const writable = snapshot.status === 'ready' && snapshot.writable === true

        // The typed values are a buffer only until the endpoint answers: the numbers and the prompt
        // come from the payload, so a fresh read that disagrees clears the buffer (the host wins)
        // instead of letting a stale draft mask the real policy.
        const seen = React.useRef(null)
        const policyKey = {
          beatSeconds: secCount(policy.beatSeconds),
          maxRunSeconds: secCount(policy.maxRunSeconds),
          promptText: typeof policy.promptText === 'string' ? policy.promptText : '',
        }
        React.useEffect(() => {
          const previous = seen.current
          seen.current = policyKey
          if (previous === null) return
          if (
            previous.beatSeconds === policyKey.beatSeconds &&
            previous.maxRunSeconds === policyKey.maxRunSeconds &&
            previous.promptText === policyKey.promptText
          )
            return
          setDrafts({})
        }, [policyKey.beatSeconds, policyKey.maxRunSeconds, policyKey.promptText])

        const clearDraft = (key) => {
          setDrafts((current) => {
            if (!(key in current)) return current
            const next = Object.assign({}, current)
            delete next[key]
            return next
          })
        }

        // The revision is re-read from the scope at the moment of the write, so a rejected write is
        // retried against what the store holds now instead of the revision this render saw. A
        // failure keeps the local input on screen — nothing typed is dropped silently.
        const write = (ops, fallbackKey) => {
          setError(null)
          const current = typeof orch.getSnapshot === 'function' ? orch.getSnapshot() : undefined
          if (mutate === undefined || current === undefined || current.status !== 'ready' || current.writable !== true) {
            setError(t('secretary.readonly'))
            return Promise.resolve(false)
          }
          setBusy(true)
          return Promise.resolve()
            .then(() => mutate(ops, current.revision))
            .then(
              () => {
                setBusy(false)
                return true
              },
              (reason) => {
                setBusy(false)
                const message =
                  typeof reason === 'object' && reason !== null && typeof reason.message === 'string' ? reason.message : ''
                setError(message !== '' ? message : t(fallbackKey))
                return false
              },
            )
        }

        const numberField = (field) => {
          // The buffer, the write path and the test id all use the config key; only the number
          // shown comes from the payload's shorter name (the mapping lives in the table above).
          const key = field.key
          const stored = secCount(policy[field.policyKey])
          const shown = typeof drafts[key] === 'string' ? drafts[key] : stored === null ? '' : String(stored)
          const commit = () => {
            const draft = drafts[key]
            if (typeof draft !== 'string') return
            if (draft.trim() === '') {
              clearDraft(key)
              return
            }
            const value = secPositive(draft)
            if (value === null) {
              setError(t('secretary.invalidNumber'))
              clearDraft(key)
              return
            }
            if (stored !== null && value === stored) {
              clearDraft(key)
              return
            }
            write([{ op: 'set', path: [key], value }], 'secretary.saveFailed').then((ok) => {
              // The endpoint has not answered yet, so the buffer keeps showing what was written;
              // it drops on its own once a read disagrees (see the effect above).
              if (ok) setDrafts((current) => Object.assign({}, current, { [key]: String(value) }))
            })
          }
          return h(
            'label',
            { key, style: secLabelStyle },
            h('span', { style: secMutedStyle }, t(field.labelKey)),
            h('input', {
              type: 'text',
              inputMode: 'numeric',
              value: shown,
              disabled: !writable || busy,
              'aria-label': t(field.labelKey),
              'data-testid': 'orchestrator-secretary-field-' + key,
              style: secInputStyle,
              onChange: (event) => setDrafts(Object.assign({}, drafts, { [key]: event.target.value })),
              onBlur: commit,
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  commit()
                }
              },
            }),
          )
        }

        const toggleNotify = (key) => {
          const next = {}
          for (const name of SECRETARY_NOTIFY_KEYS) next[name] = name === key ? notify[name] !== true : notify[name] === true
          const names = SECRETARY_NOTIFY_KEYS.filter((name) => next[name] === true).map((name) => SECRETARY_NOTIFY_NAMES[name])
          write([{ op: 'set', path: ['secretaryNotifyOn'], value: names }], 'secretary.saveFailed')
        }

        const promptField = () => {
          const stored = typeof policy.promptText === 'string' ? policy.promptText : ''
          const shown = typeof drafts.promptText === 'string' ? drafts.promptText : stored
          const commit = () => {
            const draft = drafts.promptText
            if (typeof draft !== 'string') return
            if (draft === stored) {
              clearDraft('promptText')
              return
            }
            write([{ op: 'set', path: ['secretaryPromptText'], value: draft }], 'secretary.saveFailed')
          }
          return h(
            'label',
            { style: secLabelStyle },
            h('span', { style: secMutedStyle }, t('secretary.promptText')),
            h('textarea', {
              rows: 3,
              value: shown,
              disabled: !writable || busy,
              'aria-label': t('secretary.promptText'),
              'data-testid': 'orchestrator-secretary-prompt',
              style: Object.assign({}, secInputStyle, { resize: 'vertical' }),
              onChange: (event) => setDrafts(Object.assign({}, drafts, { promptText: event.target.value })),
              onBlur: commit,
            }),
          )
        }

        const setMaster = (sessionId) => {
          // Mutual exclusion is the host's rule (ticket 01); the view sends the new Master and every
          // row that duplicated the old one in the same mutate.
          const conflicts = secRows(secObject(registry.conflict).conflictingOrchestratorIds).map((raw) => secText(raw))
          const ops = [{ op: 'set', path: ['secretaryMasterSessionId'], value: sessionId }]
          ops.push(...removalOps(registry, [sessionId, ...conflicts]))
          write(ops, 'secretary.saveFailed')
        }

        const bindingRows = secRows(registry.orchestrators).map((raw) => {
          const row = secObject(raw)
          const sessionId = secText(row.sessionId)
          const isMaster = sessionId !== '' && sessionId === secText(registry.masterSessionId)
          return h(
            'div',
            { key: sessionId, style: Object.assign({}, secRowStyle, { alignItems: 'baseline' }) },
            h(
              'span',
              {
                title: secText(row.workspace),
                style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              },
              secText(row.title) || sessionId,
            ),
            // Where this row's reports live, per row. The settings tab used to print one report
            // root for all of them, which the endpoint never sent and nothing could change.
            h(
              'span',
              {
                title: secText(row.workspace),
                style: {
                  flex: '0 1 auto',
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: '11px',
                  color: 'var(--dsw-alias-label-tertiary, inherit)',
                },
              },
              secText(row.workspace) || t('secretary.workspaceNone'),
            ),
            isMaster ? h('span', { style: secBadgeStyle }, t('secretary.master')) : null,
            h(
              'button',
              {
                type: 'button',
                style: secButtonStyle,
                disabled: !writable || busy,
                'data-testid': 'orchestrator-secretary-setmaster-' + sessionId,
                onClick: () => setMaster(sessionId),
              },
              t('secretary.setMaster'),
            ),
            h(
              'button',
              {
                type: 'button',
                style: secButtonStyle,
                disabled: !writable || busy,
                'data-testid': 'orchestrator-secretary-unregister-' + sessionId,
                onClick: () => {
                  const ops = removalOps(registry, [sessionId])
                  if (ops.length !== 0) write(ops, 'secretary.saveFailed')
                },
              },
              t('secretary.unregister'),
            ),
          )
        })

        const register = () => {
          const sessionId = secText(binding.id)
          if (sessionId === '') {
            setError(t('secretary.registerMissing'))
            return
          }
          const value = { sessionId, workspace: '', title: secText(binding.title), trackedAt: Date.now() }
          // Append at the stored length: registry.orchestrators is the normalized list, shorter
          // than storage whenever a row was deduped or dropped as the Master — a set at that
          // index would overwrite a row that is really there.
          const stored = storedOrchestratorIds(registry)
          const ops =
            stored === undefined
              ? [{ op: 'set', path: ['secretaryOrchestrators'], value: [...ledgerRowsOf(registry), value] }]
              : [{ op: 'set', path: ['secretaryOrchestrators', String(stored.length)], value }]
          write(ops, 'secretary.saveFailed').then((ok) => {
            if (ok) setBinding({ id: '', title: '' })
          })
        }

        return h(
          'div',
          {
            'data-testid': 'orchestrator-secretary-settings',
            style: {
              display: 'grid',
              gap: '10px',
              minWidth: 0,
              minHeight: 0,
              flex: '1 1 auto',
              overflowY: 'auto',
              alignContent: 'start',
            },
          },
          h(
            'section',
            { style: secPanelStyle, 'data-testid': 'orchestrator-secretary-policy' },
            h('div', { style: secSectionHeadStyle }, t('secretary.policy')),
            h(
              'div',
              {
                style: { display: 'grid', gap: '8px', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', minWidth: 0 },
              },
              SECRETARY_NUMBER_FIELDS.map(numberField),
            ),
            h(
              'div',
              { style: { display: 'grid', gap: '4px', minWidth: 0 } },
              h('div', { style: secSectionHeadStyle }, t('secretary.notify')),
              SECRETARY_NOTIFY_KEYS.map((key) =>
                h(
                  'label',
                  {
                    key: 'notify-' + key,
                    style: Object.assign({}, secRowStyle, { cursor: writable && !busy ? 'pointer' : 'default' }),
                  },
                  h('input', {
                    type: 'checkbox',
                    role: 'switch',
                    checked: notify[key] === true,
                    disabled: !writable || busy,
                    'aria-label': t('secretary.notify.' + key),
                    'data-testid': 'orchestrator-secretary-notify-' + key,
                    onChange: () => toggleNotify(key),
                  }),
                  h('span', null, t('secretary.notify.' + key)),
                ),
              ),
            ),
            promptField(),
            h(
              'label',
              { style: Object.assign({}, secRowStyle, { cursor: writable && !busy ? 'pointer' : 'default' }) },
              h('input', {
                type: 'checkbox',
                role: 'switch',
                // The switch shows the host's own answer, not a constant: a hardwired true could
                // only ever be turned off, and the endpoint stops being registered once it is.
                checked: payload.enabled === true,
                disabled: !writable || busy,
                'aria-label': t('secretary.enabled'),
                'data-testid': 'orchestrator-secretary-enabled',
                onChange: () => {
                  write([{ op: 'set', path: ['secretaryEnabled'], value: payload.enabled !== true }], 'secretary.saveFailed')
                },
              }),
              h('span', null, t('secretary.enabled')),
            ),
            error === null
              ? null
              : h('div', { role: 'alert', 'data-testid': 'orchestrator-secretary-settings-error', style: secErrorStyle }, error),
            writable ? null : h('div', { style: secMutedStyle }, t('secretary.readonly')),
            busy ? h('div', { style: secMutedStyle }, t('secretary.saving')) : null,
          ),
          degraded
            ? h(
                'div',
                { 'data-testid': 'orchestrator-secretary-degraded', style: secMutedStyle },
                t('secretary.degraded'),
              )
            : null,
          h(
            'section',
            { style: secPanelStyle, 'data-testid': 'orchestrator-secretary-binding' },
            h('div', { style: secSectionHeadStyle }, t('secretary.binding')),
            h(
              'div',
              { style: secMutedStyle },
              t('secretary.master') + ': ' + (secText(registry.masterSessionId) || t('secretary.masterEmpty')),
            ),
            bindingRows.length === 0
              ? h('div', { style: secMutedStyle }, t('secretary.bindingEmpty'))
              : h('div', { style: { display: 'grid', gap: '2px', minWidth: 0 } }, bindingRows),
            h(
              'div',
              {
                style: { display: 'grid', gap: '6px', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', minWidth: 0 },
              },
              h(
                'label',
                { style: secLabelStyle },
                h('span', { style: secMutedStyle }, t('secretary.registerId')),
                h('input', {
                  type: 'text',
                  value: binding.id,
                  disabled: !writable || busy,
                  'aria-label': t('secretary.registerId'),
                  'data-testid': 'orchestrator-secretary-register-id',
                  style: secInputStyle,
                  onChange: (event) => setBinding(Object.assign({}, binding, { id: event.target.value })),
                }),
              ),
              h(
                'label',
                { style: secLabelStyle },
                h('span', { style: secMutedStyle }, t('secretary.registerTitle')),
                h('input', {
                  type: 'text',
                  value: binding.title,
                  disabled: !writable || busy,
                  'aria-label': t('secretary.registerTitle'),
                  'data-testid': 'orchestrator-secretary-register-title',
                  style: secInputStyle,
                  onChange: (event) => setBinding(Object.assign({}, binding, { title: event.target.value })),
                }),
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                style: secButtonStyle,
                disabled: !writable || busy,
                'data-testid': 'orchestrator-secretary-register',
                onClick: register,
              },
              t('secretary.register'),
            ),
          ),
        )
      }

      /**
       * The mounted namespace, and only once $mount installed its method (the same read as
       * readService: ctx.get is the inject-free lookup, a property read would be gated).
       */
      function secretaryNamespaceOf(ctx) {
        const namespace = readService(ctx, SECRETARY_SERVICE)
        return namespace !== null && namespace !== undefined && typeof namespace.secretaryState === 'function'
          ? namespace
          : undefined
      }

      // One mount per ctx: a second $mount of one package is rejected as a duplicate, the Remote
      // service is a fresh proxy on every read, and a rejected mount must stay retryable instead
      // of poisoning the page.
      const secretaryMounts = new WeakMap()
      function isSecretaryMounted(ctx) {
        return secretaryNamespaceOf(ctx) !== undefined
      }
      function mountSecretaryRemote(ctx) {
        if (ctx === null || (typeof ctx !== 'object' && typeof ctx !== 'function')) {
          return Promise.reject(new Error('remote.$mount is unavailable'))
        }
        if (isSecretaryMounted(ctx)) return Promise.resolve()
        const cached = secretaryMounts.get(ctx)
        if (cached !== undefined) return cached
        const remote = remoteOf(ctx)
        if (remote === undefined) return Promise.reject(new Error('remote.$mount is unavailable'))
        let pending
        pending = Promise.resolve()
          .then(() => {
            if (isSecretaryMounted(ctx)) return undefined
            return remote.$mount(SECRETARY_CONTRIBUTION)
          })
          .catch((error) => {
            if (secretaryMounts.get(ctx) === pending) secretaryMounts.delete(ctx)
            if (/already mounted/i.test(String(error && error.message ? error.message : error))) return undefined
            throw error
          })
        secretaryMounts.set(ctx, pending)
        return pending
      }

      /** One read of the endpoint; a failed RemoteResult becomes a rejection the view shows. */
      async function loadSecretaryState(ctx) {
        await mountSecretaryRemote(ctx)
        const namespace = secretaryNamespaceOf(ctx)
        if (namespace === undefined) {
          throw new Error('orchestratorSecretary/secretaryState is unavailable')
        }
        const result = await namespace.secretaryState()
        if (result === null || typeof result !== 'object' || result.ok !== true) {
          const failure = result === null || typeof result !== 'object' ? undefined : result.error
          const message = failure === null || failure === undefined ? undefined : failure.message
          throw new Error(typeof message === 'string' && message !== '' ? message : 'secretary state request failed')
        }
        return result.value
      }

      /**
       * One draft transition (ticket 08): confirm sends the draft to the Master, discard archives
       * it. The endpoint answers `{ delivered, draft, reason }`; a refused send keeps the draft
       * pending, so the caller must read `delivered` instead of assuming a resolved promise
       * means "sent".
       */
      async function loadNudge(ctx, draftId, action) {
        await mountSecretaryRemote(ctx)
        const namespace = secretaryNamespaceOf(ctx)
        if (namespace === undefined) {
          throw new Error('orchestratorSecretary/secretaryNudge is unavailable')
        }
        const method = action === 'confirm' ? 'confirmDraft' : action === 'discard' ? 'discardDraft' : ''
        if (method === '') throw new Error('orchestratorSecretary: unknown nudge action ' + String(action))
        if (typeof namespace[method] !== 'function') {
          throw new Error('orchestratorSecretary/' + method + ' is unavailable')
        }
        const result = await namespace[method](draftId)
        if (result === null || typeof result !== 'object' || result.ok !== true) {
          const failure = result === null || typeof result !== 'object' ? undefined : result.error
          const message = failure === null || failure === undefined ? undefined : failure.message
          throw new Error(typeof message === 'string' && message !== '' ? message : 'secretary nudge request failed')
        }
        return result.value
      }

      /**
       * The secretary view shell: the tab strip, one polling read of the endpoint, and the three
       * tab bodies. Everything shown comes from the payload; the local state is only which tab is
       * open, the measured width, the retry counter, and the per-draft busy/error state.
       */
      function SecretaryPanel({ t, orch, loadState, openSession, mutate, nudge }) {
        const plugin = useScope(orch)
        const configured = plugin.value !== null && typeof plugin.value === 'object' ? plugin.value : {}
        const enabled = configured.secretaryEnabled === true
        const [activeTab, setActiveTab] = React.useState(SECRETARY_TABS[0].id)
        const [snapshot, setSnapshot] = React.useState({ status: 'idle', value: null, error: null })
        // Bumped by the retry button; it is the effect's dependency, so a retry really re-reads.
        const [attempt, setAttempt] = React.useState(0)
        const [enableError, setEnableError] = React.useState(null)
        const [width, setWidth] = React.useState(0)
        const root = React.useRef(null)
        const tabNodes = React.useRef({})
        const loader = React.useRef(loadState)
        loader.current = loadState
        const writer =
          typeof mutate === 'function'
            ? mutate
            : orch !== null && orch !== undefined && typeof orch.mutate === 'function'
              ? (ops, revision) => orch.mutate(ops, revision)
              : undefined

        // The panel is the whole main seat, so its own box decides the layout break. A host with no
        // layout engine (a test, a detached render) leaves the width at 0 and gets one column.
        React.useEffect(() => {
          const measure = () => {
            const node = root.current
            const box =
              node !== null && node !== undefined && typeof node.getBoundingClientRect === 'function'
                ? node.getBoundingClientRect()
                : undefined
            const measured =
              box !== undefined && typeof box.width === 'number' && Number.isFinite(box.width) && box.width > 0
                ? box.width
                : undefined
            const fallback =
              typeof window !== 'undefined' && typeof window.innerWidth === 'number' && Number.isFinite(window.innerWidth)
                ? window.innerWidth
                : 0
            setWidth(measured === undefined ? fallback : measured)
          }
          measure()
          const listening = typeof window !== 'undefined' && typeof window.addEventListener === 'function'
          if (listening) window.addEventListener('resize', measure)
          return () => {
            if (listening && typeof window.removeEventListener === 'function') window.removeEventListener('resize', measure)
          }
        }, [])

        // Read on mount and then on the slow cadence; the last good payload stays on screen while
        // refreshing, and a failed read is a visible alert with a retry, never a silent blank.
        React.useEffect(() => {
          if (!enabled) return undefined
          let live = true
          let timer
          const read = () => {
            if (!live) return
            setSnapshot((current) => (current.status === 'ready' ? current : { status: 'loading', value: null, error: null }))
            Promise.resolve()
              .then(() => loader.current())
              .then(
                (value) => {
                  if (live) setSnapshot({ status: 'ready', value, error: null })
                },
                (reason) => {
                  if (!live) return
                  const message =
                    typeof reason === 'object' && reason !== null && typeof reason.message === 'string' && reason.message !== ''
                      ? reason.message
                      : t('secretary.failed')
                  setSnapshot({ status: 'failed', value: null, error: message })
                },
              )
              .then(() => {
                if (live) timer = setTimeout(read, SECRETARY_POLL_MS)
              })
          }
          read()
          return () => {
            live = false
            if (timer !== undefined) clearTimeout(timer)
          }
        }, [enabled, attempt])

        const enable = () => {
          setEnableError(null)
          if (writer === undefined) {
            setEnableError(t('secretary.readonly'))
            return
          }
          const current =
            orch !== null && orch !== undefined && typeof orch.getSnapshot === 'function' ? orch.getSnapshot() : undefined
          if (current === undefined || current.status !== 'ready' || current.writable !== true) {
            setEnableError(t('secretary.readonly'))
            return
          }
          Promise.resolve()
            .then(() => writer([{ op: 'set', path: ['secretaryEnabled'], value: true }], current.revision))
            .then(undefined, (reason) => {
              const message =
                typeof reason === 'object' && reason !== null && typeof reason.message === 'string' ? reason.message : ''
              setEnableError(message !== '' ? message : t('secretary.saveFailed'))
            })
        }

        const onTabKey = (event, index) => {
          const key = event === null || event === undefined ? undefined : event.key
          if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') return
          if (typeof event.preventDefault === 'function') event.preventDefault()
          const count = SECRETARY_TABS.length
          const next =
            key === 'ArrowLeft'
              ? (index + count - 1) % count
              : key === 'ArrowRight'
                ? (index + 1) % count
                : key === 'Home'
                  ? 0
                  : count - 1
          setActiveTab(SECRETARY_TABS[next].id)
          const node = tabNodes.current[SECRETARY_TABS[next].id]
          if (node !== undefined && node !== null && typeof node.focus === 'function') node.focus()
        }

        const style = secretaryStyleOf(width)
        if (!enabled) {
          return h(
            'div',
            { 'data-testid': 'orchestrator-secretary', style: style.root },
            h('div', { style: { fontWeight: 600 } }, t('secretary.title')),
            h('div', { 'data-testid': 'orchestrator-secretary-disabled', style: secMutedStyle }, t('secretary.disabled')),
            // Turning the switch off unregisters the endpoint, so the entry leaves the sidebar
            // and this shell may be the last thing on screen. Say where the way back is.
            h(
              'div',
              { 'data-testid': 'orchestrator-secretary-disabled-hint', style: secMutedStyle },
              t('secretary.disabledHint'),
            ),
            h(
              'div',
              { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
              h(
                'button',
                { type: 'button', style: secButtonStyle, 'data-testid': 'orchestrator-secretary-enable', onClick: enable },
                t('secretary.enable'),
              ),
              enableError === null ? null : h('div', { role: 'alert', style: secErrorStyle }, enableError),
            ),
          )
        }

        const ready = snapshot.status === 'ready'
        const payload = ready ? snapshot.value : null
        const empty = ready && secretaryRowsOf(payload).length === 0
        const body =
          snapshot.status === 'failed'
            ? h(
                'div',
                { 'data-testid': 'orchestrator-secretary-failed', role: 'alert', style: secErrorStyle },
                h('span', null, t('secretary.failed') + ': ' + String(snapshot.error)),
                h(
                  'button',
                  {
                    type: 'button',
                    style: secButtonStyle,
                    'data-testid': 'orchestrator-secretary-retry',
                    onClick: () => setAttempt(attempt + 1),
                  },
                  t('secretary.retry'),
                ),
              )
            : !ready
              ? h('div', { 'data-testid': 'orchestrator-secretary-loading', style: secMutedStyle }, t('secretary.loading'))
              : activeTab === 'settings'
                ? h(SecretarySettings, { key: 'settings', t, orch, payload, mutate: writer })
                : activeTab === 'history'
                  ? h(SecretaryHistory, { key: 'history', t, payload })
                  : // The guide replaces the overview only: the Settings tab it points at must stay
                    // reachable, and the history tab has its own "no reports yet" line.
                    empty
                    ? h('div', { 'data-testid': 'orchestrator-secretary-empty', style: secMutedStyle }, t('secretary.empty'))
                    : h(SecretaryOverview, {
                        key: 'overview',
                        t,
                        payload,
                        openSession,
                        width,
                        nudge,
                        refresh: () => setAttempt(attempt + 1),
                      })

        const tabStrip = h(
          'div',
          { role: 'tablist', 'aria-label': t('secretary.title'), style: { display: 'flex', gap: '2px', minWidth: 0 } },
          SECRETARY_TABS.map((tab, index) => {
            const selected = tab.id === activeTab
            return h(
              'button',
              {
                key: tab.id,
                type: 'button',
                role: 'tab',
                id: 'orchestrator-secretary-tab-' + tab.id,
                'aria-selected': selected,
                'aria-controls': 'orchestrator-secretary-panel-' + tab.id,
                tabIndex: selected ? 0 : -1,
                'data-testid': 'orchestrator-secretary-tab-' + tab.id,
                ref: (node) => {
                  tabNodes.current[tab.id] = node
                },
                onClick: () => setActiveTab(tab.id),
                onKeyDown: (event) => onTabKey(event, index),
                style: Object.assign({}, secTabStyle, selected ? secTabOnStyle : null),
              },
              t(tab.labelKey),
            )
          }),
        )

        return h(
          'div',
          { 'data-testid': 'orchestrator-secretary', style: style.root, ref: root },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', minWidth: 0 } },
            h('span', { style: { fontWeight: 600 } }, t('secretary.title')),
            tabStrip,
          ),
          h(
            'div',
            {
              role: 'tabpanel',
              id: 'orchestrator-secretary-panel-' + activeTab,
              'aria-labelledby': 'orchestrator-secretary-tab-' + activeTab,
              style: { flex: '1 1 auto', minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' },
            },
            body,
          ),
        )
      }

      /** Service names, not package names: these are the `ctx.*` members used below. */
      // uiWorkspace opens a session from the tracking tree; layout leaves the panel seat first
      // and addresses the main panel by id (host precedent: ui-workspace, ui-plugin-manager).
      const inject = ['slots', 'locale', 'remote', 'remote.commands', 'remote.session', 'configForms', 'layout', 'uiWorkspace']

      function apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'orchestrator: dictionaries')

        // Same command channel the native plan chip uses to leave plan mode.
        const setPlanFor = (sessionId) => async (active) => {
          const command = active ? '/plan' : '/plan off'
          const result = await ctx.remote.commands.execute(sessionId, command, [])
          if (!result.ok) return result.error.message + ' (' + result.error.code + ')'
          if (result.value === undefined) return 'unknown command: ' + command
          return null
        }
        // `conversation.input.plan` is a single-occupant slot and the shipped plan package claims
        // it: a second registration makes that package's activation throw, which fails the whole
        // web boot. The toggle takes a seat in the left list slot instead, next to the plan chip.
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            { name: 'conversation.input.left', id: 'orchestrator-plan-toggle', order: 20, locale: NS },
            (props) => h(PlanToggle, Object.assign({}, props, { setPlan: setPlanFor(props.sessionId) })),
          ),
        )

        const scopes = { main: ctx.configForms.get(MAIN.ns), worker: ctx.configForms.get(WORKER.ns), orch: ctx.configForms.get(NS) }
        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.right',
              id: 'orchestrator-route-picker',
              order: 11,
              locale: NS,
              inject: (sessionId) => ({
                scopes,
                orch: scopes.orch,
                loadCatalog: () => ctx.remote.session.modelCatalog(),
              }),
            },
            RoutePicker,
          ),
        )
        // The secretary view takes the main seat under the same id the sidebar row uses: the
        // sidebar's own row button calls ctx.layout.selectPanel(id), and both seats must agree on
        // that one id (host precedent: ui-plugin-manager "plugins", ui-schedule "schedules").
        const secretaryLabel = () => {
          const bound =
            ctx.locale !== null && ctx.locale !== undefined && typeof ctx.locale.bind === 'function'
              ? ctx.locale.bind(NS)
              : undefined
          return typeof bound === 'function' ? bound('secretary.label') : zh['secretary.label']
        }
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: SECRETARY_PANEL_ID,
              locale: NS,
              inject: () => {
                const workspace = readService(ctx, 'uiWorkspace')
                const layout = readService(ctx, 'layout')
                const canOpen = workspace !== undefined && typeof workspace.openSession === 'function'
                return {
                  orch: scopes.orch,
                  loadState: () => loadSecretaryState(ctx),
                  mutate: (ops, revision) => scopes.orch.mutate(ops, revision),
                  nudge: (draftId, action) => loadNudge(ctx, draftId, action),
                  // Leave the panel first: the session view is the main seat's default state, so a
                  // selected panel would hide the session the row just opened.
                  openSession: canOpen
                    ? (sessionId) => {
                        if (layout !== undefined && typeof layout.selectPanel === 'function') {
                          try {
                            layout.selectPanel(null)
                          } catch {
                            // An older host may reject null; opening the session still wins.
                          }
                        }
                        workspace.openSession(sessionId)
                      }
                    : undefined,
                }
              },
            },
            SecretaryPanel,
          ),
        )
        // The sidebar row shows a decorative glyph: the sidebar owns the button, the label and the
        // selection (same seat as the plugin manager and the task manager).
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: SECRETARY_PANEL_ID, order: 40, locale: NS, label: secretaryLabel },
            SecretaryIcon,
          ),
        )
      }

      exports.apply = apply
      exports.inject = inject
      // Pure helpers, exposed so they can be tested without a browser.
      exports.__test = {
        MAIN,
        WORKER,
        REVIEW,
        zh,
        en,
        INTERVAL,
        DEFAULT_ALLOWED_TOOLS,
        ALLOW_KEY,
        CATALOG_KEY,
        namesOf,
        catalogOf,
        catalogFor,
        toolListOf,
        popupPlacement,
        dropdownStyleOf,
        RouteRow,
        allowedSetOf,
        filterTools,
        allowOps,
        resetAllowOps,
        EnableSwitch,
        AllowedToolsPanel,
        RoutePicker,
        routeKey,
        parseRouteKey,
        routeOf,
        routeOps,
        findModel,
        filterGroups,
        countModels,
        saveRoute,
        intervalOf,
        parseInterval,
        SuperviseIntervalField,
        SecretaryPanel,
        SecretaryOverview,
        SecretaryHistory,
        SecretarySettings,
        SecretaryIcon,
        SECRETARY_TABS,
        SECRETARY_CONTRIBUTION,
        SECRETARY_PANEL_ID,
        SECRETARY_POLL_MS,
        SECRETARY_NOTIFY_NAMES,
        WORKER_STATE,
        secretaryTabsOf,
        secretaryBlockersOf,
        secretaryRowsOf,
        reportLinesOf,
        draftRowsOf,
        diffGroupsOf,
        secretaryStyleOf,
        secPositive,
        secTime,
        loadSecretaryState,
        loadNudge,
      }
    })(module, module.exports, (id) => load(id))
    return module.exports
  },
})
