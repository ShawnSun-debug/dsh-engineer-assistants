/**
 * 危险动作与确认（engineer-assistants 1.0.0 票 08）。
 *
 * 一句话：worker 要做的动作先过一遍清单；命中了就在主对话弹一次确认卡，十分钟没人点就算拒绝。
 * **确认只解锁，命令仍由 worker 自己执行**——这里不代替它跑任何东西。
 *
 * 六类（spec 第 8 节）：删/覆盖文件、强推与改写历史、部署发布、改宿主或全局配置、改生产数据、
 * 对外动作。判定输入是「命令 + 意图描述」。
 *
 * 三条规矩：
 *
 * - **逐行匹配。** 命令与意图按行拆开分别判定：`[^|;-]` 这类取反字符类会跨过换行，
 *   把两句不相干的话连成一次命中（`cat prod.log` + `删除陈旧的注释` 曾被判成改生产数据）。
 * - **默认拒绝。** 超时、异常、通道缺失、输入形状不对，一律按拒绝处理。
 * - **一次确认只放行同一件事（含意图）。** 键里必须带意图，否则「确认了 migrate.mjs 加 drop
 *   orders」会连带放行同一命令配 `drop users (production)`。
 *
 * 本模块不碰宿主：审批通道由调用方注入。
 *
 * @module
 */

/** 六类危险动作。 */
export const DANGER_CATEGORIES = Object.freeze([
  'file-destruction',
  'history-rewrite',
  'deploy',
  'host-config',
  'production-data',
  'outbound',
])

/** 默认确认窗口：十分钟（spec 第 8 节）。 */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

const TIMEOUT = Symbol('danger-confirm timeout')

/** 覆盖式写入：单箭头重定向（不是 >>）、Set-Content/Out-File、复制/移动。 */
const OVERWRITE = [
  // 单箭头重定向：排除 >>、2>&1、=>、->，以及后面紧跟 = 的比较。
  /(?<![=>-])>(?!>|&)(?!\s*\/dev\/null)\s*[^\s=&]/,
  /\bset-content\b/i,
  /\bout-file\b/i,
  /\bcopy-item\b/i,
  // cp/mv 只有在命令位置才算：路径里带 /cp./ 的文件名不是覆盖动作。
  /(^|[;&|]\s*)(cp|copy|mv|move|rename-item)\s/i,
  /robocopy\b[^|;]*\/mir/i,
]

const RULES = Object.freeze({
  'file-destruction': [
    /\brm\s+-[a-z]*[rf]/i,
    /remove-item\b[^|;-]*-recurse/i,
    /\bdel\s+\/[fs]/i,
    /\brd\s+\/s/i,
    /\btruncate\b/i,
    ...OVERWRITE,
    // 中文意图
    /(删除|删掉|清空|覆盖|抹掉)[^。；\n]{0,12}(文件|目录|文件夹|整个)/,
    /(整个|全部)(目录|文件)[^。；\n]{0,6}(删|清空|覆盖)/,
  ],
  'history-rewrite': [
    /push\b[^|;-]*--force/i,
    /\breset\s+--hard\b/i,
    /filter-branch|filter-repo/i,
    /\brebase\s+-i\b/i,
    /\bgit\s+clean\s+-[a-z]*[fd]/i,
    /(强制?推|强推|改写历史|重写历史)/,
  ],
  deploy: [
    // 词边界加前后否定：`test/release.test.mjs`、`docs/deploy.md` 不是发布动作。
    /(?<![\/\w.-])(deploy|release)(?![\w.-])/i,
    // 中文没有词边界。用**黑名单**排除「文件/文档/脚本」这类名词性接续：
    // 「部署新版本」「发布这个包」「上线」都要命中；`docs/部署.md`、`更新部署脚本` 不算。
    // 白名单写法（只认「部署到…」）会把动词在前的常见说法全漏掉，那是更糟的假阴性。
    /(发布|上线|部署)(?![^\s]{0,6}(?:\.(?:md|txt|js|json|yml|yaml)|脚本|文档|文件|配置))/,
    /\b(kubectl|helm|terraform)\s+(apply|install|upgrade|delete)\b/i,
    /\bdocker\s+push\b/i,
    /\b(npm|pnpm|yarn)\s+publish\b/i,
  ],
  'host-config': [
    /\.dsh[\\/]/i,
    /cordis\.patch\.yml/i,
    /\bsetx\b|\breg\s+add\b/i,
    /\/etc\//i,
    /\bprofile\b[^|;-]*\.json/i,
    /git\s+config\s+--global/i,
    /(npm|pnpm|yarn)\s+config\s+set/i,
    /set-itemproperty[^|;]*(hkcu|hklm|hkey)/i,
    /\b(choco|scoop|winget)\s+install\b/i,
    /(宿主配置|全局配置|改宿主|注册表)/,
  ],
  'production-data': [
    /\bdrop\s+(table|database|schema)\b/i,
    /\bdelete\s+from\b/i,
    /\btruncate\s+table\b/i,
    // 英文自然语序：动词在前、production 在后。
    /(delete|drop|purge|wipe|truncate|migrat\w*)\b[^.;\n]{0,30}\bprod(uction)?\b/i,
    /\bprod(uction)?\b[^.;\n]{0,30}\b(delete|drop|purge|wipe|truncate|migrat\w*)/i,
    /\b(lose|lost|destroy|wipe)\b[^.;\n]{0,20}\bdata\b/i,
    /生产(环境|数据|数据库|库)/,
    /(删除|清空|清掉|覆盖|迁移|清库|清洗)[^。；\n]{0,10}生产/,
  ],
  outbound: [
    /\bcurl\b[^|;-]*-x\s*(post|put|delete)/i,
    /invoke-webrequest[^|;-]*-method\s*(post|put|delete)/i,
    /\bsend_message\b/i,
    /\bgit\s+push\b/i,
    /\b(npm|pnpm|yarn)\s+publish\b/i,
    /\bgh\s+pr\s+create\b/i,
    /(发消息|发到群|对外发|通知外部)/,
  ],
})

function readText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 拆行：每行独立判定，避免字符类跨行连读。 */
function toLines(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
}

/** 判定一个动作命中了哪些类别。 */
export function classifyDanger(input) {
  const command = readText(input?.command)
  const intent = readText(input?.intent)
  // 命令与意图分开匹配：拼成一段会让一句无害的命令与一句无关的意图连成一次命中。
  // 命令内部的换行则合并——`curl.exe -X` 换行再写 `POST …` 是同一个命令，不是两句。
  const commandLines = toLines(command)
  const candidates = [...commandLines, commandLines.join(' '), ...toLines(intent)]
  const categories = []
  for (const category of DANGER_CATEGORIES) {
    if (candidates.some((line) => RULES[category].some((rule) => rule.test(line)))) categories.push(category)
  }
  return Object.freeze({
    danger: categories.length > 0,
    categories: Object.freeze(categories),
    command,
    intent,
  })
}

/**
 * 同一件事的键：类别 + 命令 + 意图。意图必须进键——否则「确认过一次 migrate」会连带放行
 * 同一命令配另一个意图的动作。
 */
export function dangerKey(plan) {
  return [
    [...plan.categories].sort().join(','),
    plan.command,
    plan.intent,
  ].join('\u0000')
}

/**
 * 建一个确认闸。`ask(plan) => Promise<boolean | {approved}>` 由调用方接主对话的确认卡。
 *
 * `check(input)` 返回 `{ approved, reason, plan }`，reason 是
 * not-dangerous / confirmed / already-confirmed / declined / timeout / invalid-input。
 */
export function createDangerGate({ ask, timeoutMs = DEFAULT_TIMEOUT_MS, onTimeout } = {}) {
  const confirmed = new Set()

  const decide = async (plan) => {
    if (typeof ask !== 'function') return { approved: false, reason: 'declined', plan }
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) return { approved: false, reason: 'declined', plan }

    let timer
    const timeout = new Promise((resolve) => {
      // 不 unref：这条等待就是调用方的全部工作，进程不该提前退出把结论丢掉。
      timer = setTimeout(() => resolve(TIMEOUT), timeoutMs)
    })

    let answer
    try {
      answer = await Promise.race([Promise.resolve(ask(plan)), timeout])
    } catch {
      answer = false
    } finally {
      clearTimeout(timer)
    }

    if (answer === TIMEOUT) {
      if (typeof onTimeout === 'function') {
        try {
          await Promise.resolve(onTimeout(plan))
        } catch {
          // 通知失败不改变拒绝结论。
        }
      }
      return { approved: false, reason: 'timeout', plan }
    }
    const approved = answer === true || (answer !== null && typeof answer === 'object' && answer.approved === true)
    return { approved, reason: approved ? 'confirmed' : 'declined', plan }
  }

  return {
    async check(input) {
      // 形状不对不放行：命令不是字符串时无从判定，静默通过等于把闸门拆掉。
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return { approved: false, reason: 'invalid-input', plan: classifyDanger({}) }
      }
      if (input.command !== undefined && input.command !== null && typeof input.command !== 'string') {
        return { approved: false, reason: 'invalid-input', plan: classifyDanger({}) }
      }
      // null 当作「没给」：显式 null 不该把整道闸门锁死，连安全命令都过不去。
      if (input.intent !== undefined && input.intent !== null && typeof input.intent !== 'string') {
        return { approved: false, reason: 'invalid-input', plan: classifyDanger({}) }
      }
      const plan = classifyDanger(input)
      if (!plan.danger) return { approved: true, reason: 'not-dangerous', plan }
      const key = dangerKey(plan)
      if (confirmed.has(key)) return { approved: true, reason: 'already-confirmed', plan }
      const verdict = await decide(plan)
      if (verdict.approved) confirmed.add(key)
      return verdict
    },
    confirmedKeys() {
      return [...confirmed]
    },
  }
}
