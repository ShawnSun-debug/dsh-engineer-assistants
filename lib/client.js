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
        'denied.title': 'Denied Tools',
        'denied.search': '搜索工具…',
        'denied.empty': '没有匹配的工具',
        'denied.reset': '恢复默认',
        'denied.hint': '勾选 = 主代理不可使用；取消勾选 = 允许使用。',
        'supervise.label': '子代理巡检间隔（秒）',
        'supervise.hint': '默认 600 秒（10 分钟）。主代理会按此间隔检查运行中的子代理，运行中修改立即生效。范围 10–86400。',
        'supervise.invalid': '请输入 10–86400 之间的整数',
        'supervise.saveFailed': '保存失败',
        'supervise.readonly': '当前不可写，无法保存',
        'master.button': 'Master 状态',
        'master.title': 'Master 状态面板',
        'master.loading': '正在读取 worker 状态…',
        'master.failed': '无法读取 worker 状态',
        'master.empty': '暂无 worker',
        'master.summaryEmpty': '（无摘要）',
        'master.note': '只读：按会话投影的六态分组，摘要是会话的一行标题。',
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
        'denied.title': 'Denied Tools',
        'denied.search': 'Search tools…',
        'denied.empty': 'No matching tools',
        'denied.reset': 'Reset to defaults',
        'denied.hint': 'Checked = the main agent may not use the tool; unchecked = allowed.',
        'supervise.label': 'Subagent check interval (seconds)',
        'supervise.hint': 'Default 600 seconds (10 minutes). The main agent checks running subagents at this interval; changes apply immediately. Range 10–86400.',
        'supervise.invalid': 'Enter an integer between 10 and 86400',
        'supervise.saveFailed': 'Could not save',
        'supervise.readonly': 'Not writable right now, cannot save',
        'master.button': 'Master status',
        'master.title': 'Master status panel',
        'master.loading': 'Reading worker status…',
        'master.failed': 'Could not read worker status',
        'master.empty': 'No workers yet',
        'master.summaryEmpty': '(no summary)',
        'master.note': 'Read-only: six projection states per worker; the summary is the session title.',
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

      // ---- Denied tools ---------------------------------------------------------------------
      // The shipped deny list, mirrored from the host (DEFAULT_DENIED_TOOLS in lib/index.js).
      // A web client plugin has no API that enumerates host tools — the session remote offers
      // session/model/skill methods only, and configForms exposes this plugin's own config — so
      // the plugin's server half collects the live catalog and publishes it as the volatile
      // `toolCatalog` field of that same config (lib/catalog.js). The panel renders the union
      // of that catalog, this shipped list and the two config keys; the shipped copy is also
      // the fallback on a host that publishes nothing. A unit test keeps this copy equal to the
      // host constant, so the two cannot drift apart.
      const DEFAULT_DENIED_TOOLS = [
        'edit',
        'write',
        'str_replace_editor',
        'apply_patch',
        'read',
        'grep',
        'glob',
        'list',
        'ops_read_files',
        'ops_discover_tools',
        'ops_bash',
        'pwsh',
        'bash',
        'shell',
        'web_search',
        'web_fetch',
        'read_image',
        'acp_read_original_image',
        'acp_status',
        'acp_cache',
        'present',
        'sidebar_open',
        'job_output',
        'job_kill',
        'job_list',
        'schedule_create',
        'schedule_update',
        'schedule_delete',
        'schedule_list',
        'subagent',
        'subagent_fork',
        'workflow',
        'ralph',
        'create_worktree',
        'working_directory',
        'list_agents',
        'create_goal',
        'update_goal',
        'get_goal',
        'skill',
        'decompress',
        'search_context',
      ]
      /** The two config keys the panel reads and writes. */
      const DENY_KEYS = { denied: 'deniedTools', allowed: 'allowedTools' }
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
       * empty list and drop back to its 42-name fallback. An empty read is never a real
       * catalog, so the last non-empty one stands in for it.
       */
      function catalogFor(value, remembered) {
        const live = catalogOf(value)
        return live.length > 0 ? live : remembered ?? []
      }

      /**
       * Every row: built-ins in shipped order, then every other name the live catalog or
       * either config key knows, alphabetically. A catalog name is shown even when the
       * shipped list does not know it, and is unchecked unless the config denies it — new
       * tools default to available. No name is exempt: any of them can be denied.
       */
      function toolListOf(value, catalog) {
        const listed = [...DEFAULT_DENIED_TOOLS]
        const seen = new Set(listed)
        const extras = new Set()
        for (const name of catalog ?? catalogOf(value)) {
          if (seen.has(name)) continue
          extras.add(name)
        }
        for (const key of [DENY_KEYS.denied, DENY_KEYS.allowed]) {
          for (const name of namesOf(value, key)) {
            if (seen.has(name)) continue
            extras.add(name)
          }
        }
        return [...listed, ...[...extras].sort()]
      }

      /** The effective deny set, mirroring the host's effectiveDenied(). */
      function deniedSetOf(value) {
        const denied = new Set(DEFAULT_DENIED_TOOLS)
        for (const name of namesOf(value, DENY_KEYS.denied)) denied.add(name)
        for (const name of namesOf(value, DENY_KEYS.allowed)) denied.delete(name)
        return denied
      }

      /** Case-insensitive substring match on the tool name; an empty query keeps every row. */
      function filterTools(names, query) {
        const needle = String(query ?? '').trim().toLowerCase()
        if (needle === '') return names
        return names.filter((name) => name.toLowerCase().includes(needle))
      }

      /**
       * The two config writes that reproduce a checkbox state. Only differences from the
       * built-in list are stored: `deniedTools` holds extra names and `allowedTools` the
       * built-in names the user unchecked, so a profile that never touched the panel keeps
       * the exact 0.4.6 behaviour, including a legacy deniedTools-only override.
       */
      function denyOps(checked) {
        const on = new Set([...checked].filter((name) => typeof name === 'string' && name !== ''))
        const denied = [...on].filter((name) => !DEFAULT_DENIED_TOOLS.includes(name)).sort()
        const allowed = DEFAULT_DENIED_TOOLS.filter((name) => !on.has(name)).sort()
        return [
          denied.length === 0
            ? { op: 'unset', path: [DENY_KEYS.denied] }
            : { op: 'set', path: [DENY_KEYS.denied], value: denied },
          allowed.length === 0
            ? { op: 'unset', path: [DENY_KEYS.allowed] }
            : { op: 'set', path: [DENY_KEYS.allowed], value: allowed },
        ]
      }

      /** Back to the shipped list: both keys cleared, so the schema defaults apply again. */
      function resetDenyOps() {
        return [
          { op: 'unset', path: [DENY_KEYS.denied] },
          { op: 'unset', path: [DENY_KEYS.allowed] },
        ]
      }

      const h = React.createElement
      // The popover is two columns: the original panel keeps its width, padding and
      // outline, and its own right border separates it from the denied-tools column.
      const panelStyle = {
        position: 'absolute',
        // Anchored by its left column: the original panel keeps the exact place it had
        // (`right: 0` with width 340), and the denied-tools column grows to its right
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
      const deniedColumnStyle = {
        width: '232px',
        padding: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        minHeight: 0,
        boxSizing: 'border-box',
      }
      // The rows live in a card that mirrors the model dropdown: a search row on top and a
      // scrolling option list under it. The cap keeps 42 rows from stretching the popover.
      const deniedListBoxStyle = {
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
      const deniedListStyle = {
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
      const deniedRowStyle = (denied) => ({
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '4px 8px',
        borderRadius: '6px',
        cursor: 'pointer',
        fontWeight: denied ? 600 : 400,
        // The row is a grid item with an automatic minimum size, which long content would
        // otherwise widen past the column; zero lets the name truncate instead.
        minWidth: 0,
      })
      const deniedNameStyle = {
        flex: '1 1 auto',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }
      const deniedCheckboxStyle = (editable) => ({
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
       * Checked means the main agent may not use the tool, and no name is exempt. Every
       * change writes both config keys, computed from the checkbox state, so the stored
       * config always describes exactly what the panel shows.
       */
      function DeniedToolsPanel({ scope, t }) {
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
        const denied = deniedSetOf(snapshot.value)
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
          const next = new Set(denied)
          if (on) next.add(name)
          else next.delete(name)
          return write(denyOps(next))
        }

        return h(
          'div',
          { style: deniedColumnStyle, 'data-panel': 'denied-tools' },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' } },
            h('span', { style: { fontWeight: 600 }, title: t('denied.hint') }, t('denied.title')),
            h(
              'button',
              {
                type: 'button',
                style: resetLinkStyle(editable && !saving),
                disabled: saving || !editable,
                onClick: () => write(resetDenyOps()),
              },
              t('denied.reset'),
            ),
          ),
          h(
            'div',
            { style: deniedListBoxStyle },
            h('input', {
              type: 'search',
              value: query,
              placeholder: t('denied.search'),
              'aria-label': t('denied.search'),
              'data-search': 'denied-tools',
              // `searchStyle` grows inside the dropdown's flex row; here it sits in a flex
              // column, so an explicit height keeps it a one-line box instead of stretching.
              style: Object.assign({}, searchStyle, { flex: 'none', height: '28px', width: '100%' }),
              onChange: (event) => setQuery(event.target.value),
            }),
            h(
              'div',
              { style: deniedListStyle, role: 'group', 'aria-label': t('denied.title') },
              visible.length === 0
                ? h(
                    'div',
                    { style: { padding: '6px 8px', color: 'var(--dsw-alias-label-tertiary, inherit)', lineHeight: 1.4 } },
                    t('denied.empty'),
                  )
                : visible.map((name) =>
                    h(
                      'label',
                      { key: name, style: deniedRowStyle(denied.has(name)), 'data-tool': name },
                      h('input', {
                        type: 'checkbox',
                        checked: denied.has(name),
                        disabled: saving || !editable,
                        'aria-label': name,
                        style: deniedCheckboxStyle(!saving && editable),
                        onChange: (event) => toggle(name, event.target.checked),
                      }),
                      h('span', { style: deniedNameStyle, title: name }, name),
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
                h(DeniedToolsPanel, { scope: scopes.orch, t }),
              )
            : null,
        )
      }

      // ---- Master 状态面板（票 03） ---------------------------------------------------------
      // The six projection states, in ticket order. The client cannot import the host module
      // (it is a separate bundle), so the fixed vocabulary is restated here and the client
      // test pins it to the same six values.
      const MASTER_STATES = ['Working', 'Needs input', 'Idle', 'Completed', 'Failed', 'Stopped']

      /** While the panel is open it re-reads at this cadence, so a long look is not frozen. */
      const MASTER_POLL_MS = 10000

      /**
       * The ticket-02 projection is one row per session and one session per worker, so the
       * endpoint returns { enabled, byState, workers }. This pure helper turns it into the six
       * groups the panel renders; an unknown or missing count reads as zero, and a worker whose
       * state is outside the vocabulary is not shown.
       */
      function masterGroups(value) {
        const byState = value !== null && typeof value === 'object' && value.byState !== null && typeof value.byState === 'object' ? value.byState : {}
        const workers = value !== null && typeof value === 'object' && Array.isArray(value.workers) ? value.workers : []
        return MASTER_STATES.map((state) => ({
          state,
          count: typeof byState[state] === 'number' ? byState[state] : 0,
          workers: workers.filter((worker) => worker?.state === state),
        }))
      }

      /**
       * The hand-written Remote contribution. The host side is a plain Service (SRC mode),
       * so no generated artifact exists for this endpoint; $mount only needs the descriptor
       * shape. The result codec must be `src-json`: every mounted result codec is validated,
       * and a strict codec needs its own create() factory, which no hand-written contribution
       * can supply — only generated ones can. SRC serializes the raw JSON both ways.
       */
      const MASTER_CONTRIBUTION = {
        package: 'dsh-orchestrator-master',
        descriptors: [
          {
            id: 'dsh-orchestrator-master#orchestratorMaster/masterState',
            service: 'orchestratorMaster',
            namespace: 'orchestratorMaster',
            method: 'masterState',
            invocation: { kind: 'direct' },
            parameters: [],
            result: { mode: 'src-json' },
            sourceLocation: { file: 'lib/master-panel.js', line: 1, column: 1 },
          },
        ],
      }

      // Mount once per remote: mounting installs the remote.orchestratorMaster namespace,
      // and a second mount of the same package would be rejected as a duplicate. The cache
      // is keyed by the remote object (one per web boot) instead of a module-level slot, so
      // a rejected mount is retried on the next read rather than poisoning the whole page.
      const masterMounts = new WeakMap()
      function mountMasterRemote(remote) {
        if (remote === null || (typeof remote !== 'object' && typeof remote !== 'function')) {
          return Promise.reject(new Error('remote.$mount is unavailable'))
        }
        const cached = masterMounts.get(remote)
        if (cached !== undefined) return cached
        let pending
        pending = Promise.resolve()
          .then(() => {
            if (typeof remote.$mount !== 'function') throw new Error('remote.$mount is unavailable')
            return remote.$mount(MASTER_CONTRIBUTION)
          })
          .catch((error) => {
            // A failed mount is retryable (the host may not be ready yet); keeping the
            // rejection cached would make the panel permanently blind for this page.
            if (masterMounts.get(remote) === pending) masterMounts.delete(remote)
            throw error
          })
        masterMounts.set(remote, pending)
        return pending
      }

      /** One read of the endpoint; a failed RemoteResult becomes a rejection the panel shows. */
      async function loadMasterState(remote) {
        await mountMasterRemote(remote)
        const namespace = remote?.orchestratorMaster
        if (namespace === undefined || namespace === null || typeof namespace.masterState !== 'function') {
          throw new Error('orchestratorMaster/masterState is unavailable')
        }
        const result = await namespace.masterState()
        if (result === null || typeof result !== 'object' || result.ok !== true) {
          const message = result?.error?.message
          throw new Error(typeof message === 'string' && message !== '' ? message : 'master state request failed')
        }
        return result.value
      }

      const masterPanelStyle = {
        position: 'absolute',
        right: 0,
        bottom: 'calc(100% + 8px)',
        zIndex: 50,
        width: '300px',
        maxHeight: '360px',
        overflowY: 'auto',
        padding: '12px',
        borderRadius: '12px',
        border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 22%, transparent))',
        background: 'var(--dsw-alias-bg-layer-2, Canvas)',
        color: 'inherit',
        boxShadow: '0 12px 32px rgba(0, 0, 0, .3)',
        fontSize: '12px',
        display: 'grid',
        gap: '8px',
      }
      const masterGroupStyle = { display: 'grid', gap: '2px' }
      const masterGroupHeadStyle = {
        color: 'var(--dsw-alias-label-tertiary, inherit)',
        fontSize: '11px',
        fontWeight: 600,
      }
      const masterRowStyle = {
        display: 'flex',
        gap: '6px',
        minWidth: 0,
        lineHeight: 1.4,
      }
      const masterIdStyle = {
        flex: 'none',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        color: 'var(--dsw-alias-label-tertiary, inherit)',
      }
      const masterSummaryStyle = {
        flex: '1 1 auto',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }

      /**
       * Read-only master panel: six state groups, one count per group, one line per worker.
       * It renders nothing while the switch is off and never calls the endpoint in that case;
       * a failed mount or call shows an alert instead of crashing the input toolbar.
       */
      function MasterPanel({ t, orch, loadState }) {
        const plugin = useScope(orch)
        const enabled = plugin.value?.masterPanelEnabled === true
        const [open, setOpen] = React.useState(false)
        const [snapshot, setSnapshot] = React.useState({ status: 'idle', value: null, error: null })
        const loader = React.useRef(loadState)
        loader.current = loadState

        // Read on every expansion, not once per mount: the slot mounts when the session opens
        // (long before the button is pressed), so a mount-time snapshot would always be stale.
        // While the panel stays open it re-reads on a slow timer, and closing it stops both.
        React.useEffect(() => {
          if (!enabled || !open) return undefined
          let live = true
          let timer
          const read = () => {
            if (!live) return
            // Keep the last good rows on screen while refreshing; a prior failure goes back
            // to loading so the retry is visible.
            setSnapshot((current) => (current.status === 'ready' ? current : { status: 'loading', value: null, error: null }))
            Promise.resolve()
              .then(() => loader.current())
              .then(
                (value) => {
                  if (live) setSnapshot({ status: 'ready', value, error: null })
                },
                (reason) => {
                  if (!live) return
                  const message = typeof reason?.message === 'string' && reason.message !== '' ? reason.message : t('master.failed')
                  setSnapshot({ status: 'failed', value: null, error: message })
                },
              )
              .then(() => {
                if (live) timer = setTimeout(read, MASTER_POLL_MS)
              })
          }
          read()
          return () => {
            live = false
            if (timer !== undefined) clearTimeout(timer)
          }
        }, [enabled, open])

        if (!enabled) return null

        const ready = snapshot.status === 'ready'
        const empty = ready && (snapshot.value?.workers ?? []).length === 0
        const groups = ready ? masterGroups(snapshot.value) : []
        const body =
          snapshot.status === 'loading' || snapshot.status === 'idle'
            ? h('div', null, t('master.loading'))
            : snapshot.status === 'failed'
              ? h('div', { style: { color: 'var(--dsw-alias-label-error, #ff7b72)' }, role: 'alert' }, t('master.failed') + ': ' + snapshot.error)
              : empty
                ? h('div', { 'data-testid': 'orchestrator-master-empty' }, t('master.empty'))
                : groups.map((group) =>
                    h(
                      'div',
                      { key: group.state, style: masterGroupStyle },
                      h('div', { style: masterGroupHeadStyle }, group.state + ' · ' + group.count),
                      group.workers.map((worker) =>
                        h(
                          'div',
                          { key: group.state + ':' + worker.id, style: masterRowStyle, title: worker.id + (worker.summary ? ' · ' + worker.summary : '') },
                          h('span', { style: masterIdStyle }, String(worker.id).slice(0, 8)),
                          h('span', { style: masterSummaryStyle }, worker.summary === '' ? t('master.summaryEmpty') : worker.summary),
                        ),
                      ),
                    ),
                  )

        return h(
          'span',
          { style: { position: 'relative', display: 'inline-flex' } },
          h(
            'button',
            {
              type: 'button',
              style: Object.assign({}, baseStyle, open ? onStyle : null),
              onClick: () => setOpen(!open),
              title: t('master.title'),
              'aria-label': t('master.title'),
              'aria-expanded': open,
              'data-testid': 'orchestrator-master-panel',
            },
            h('span', null, t('master.button')),
          ),
          open
            ? h(
                'div',
                { style: masterPanelStyle, role: 'dialog', 'aria-label': t('master.title') },
                h('div', { style: { fontWeight: 600 } }, t('master.title')),
                body,
                h('div', { style: { color: 'var(--dsw-alias-label-tertiary, inherit)', lineHeight: 1.4 } }, t('master.note')),
              )
            : null,
        )
      }
      /** Service names, not package names: these are the `ctx.*` members used below. */
      const inject = ['slots', 'locale', 'remote', 'remote.commands', 'remote.session', 'configForms']

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
        // The master panel sits next to the route picker. It is read-only, so the slot
        // gets one loader and the config scope; the panel itself decides whether to render.
        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.right',
              id: 'orchestrator-master-panel',
              order: 12,
              locale: NS,
              inject: () => ({
                orch: scopes.orch,
                loadState: () => loadMasterState(ctx.remote),
              }),
            },
            MasterPanel,
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
        DEFAULT_DENIED_TOOLS,
        DENY_KEYS,
        CATALOG_KEY,
        namesOf,
        catalogOf,
        catalogFor,
        toolListOf,
        popupPlacement,
        dropdownStyleOf,
        RouteRow,
        deniedSetOf,
        filterTools,
        denyOps,
        resetDenyOps,
        EnableSwitch,
        DeniedToolsPanel,
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
        MasterPanel,
        MASTER_STATES,
        MASTER_CONTRIBUTION,
        masterGroups,
        loadMasterState,
      }
    })(module, module.exports, (id) => load(id))
    return module.exports
  },
})
