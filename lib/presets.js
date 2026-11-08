/**
 * 角色预设仓储（engineer-assistants 1.0.0 票 03）。
 *
 * 一句话：十套内置预设 + 一层用户覆盖。预设决定 worker 的**工具面**、**system prompt 段**
 * 与**模型档位**（spec 第 5 节），插件自管，不靠宿主（ADR 0013）。
 *
 * 四条规矩：
 *
 * - **内置只可覆盖，不可删除。** 删掉一套内置等于让某个角色派不出去；允许保留 id 但改内容，
 *   所以升级后用户改过的字段仍在。
 * - **覆盖是逐字段的。** 只给 `tools.allow` 就只换允许名单，`deny`、`prompt`、`modelTier`
 *   保持原样；`tools` 内部同理。
 * - **非法值当场拒绝。** 工具名、模型档位、类别写错时抛错，而不是悄悄降级——预设是安全边界，
 *   静默放行会让 reviewer 这类「只读」预设拿到写权限。
 * - **归一化不抛错。** 存档里的坏行丢掉，永远返回一张可用的表。
 *
 * 本模块不碰宿主、不读时钟、不写文件。
 *
 * @module
 */

/** 模型档位：只用两档，预设是给人看的名字，不是模型 id。 */
export const MODEL_TIERS = Object.freeze(['cheap', 'strong'])

/** 类别（与登记表同一套）。 */
export const CATEGORIES = Object.freeze(['code', 'maybe-code', 'non-code'])

/**
 * 预设可引用的工具名。名字取宿主工具面的常用写法；`terminal` 是「能跑命令」的抽象，
 * 具体落到哪个 shell 工具由派发时决定。
 */
export const TOOL_NAMES = Object.freeze([
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'terminal',
  'web_search',
  'web_fetch',
  'request_dispatch',
  'todo_write',
])

const READ_ONLY = Object.freeze(['read', 'glob', 'grep'])

/**
 * 十套内置预设（spec 第 5 节）。`mayRequestDispatch` 只给动代码的四套：
 * 只有它们有「试一步、发现还得再派一个」的场景（ADR 0017）。
 */
export const BUILTIN_PRESETS = Object.freeze([
  { id: 'researcher', label: 'Researcher', category: 'non-code', modelTier: 'cheap', mayRequestDispatch: false,
    tools: { allow: ['read', 'glob', 'grep', 'web_search', 'web_fetch'], deny: [] },
    prompt: 'Investigate the question and report sources. Do not modify files.' },
  { id: 'scout', label: 'Scout', category: 'non-code', modelTier: 'cheap', mayRequestDispatch: false,
    tools: { allow: ['read', 'glob', 'grep'], deny: [] },
    prompt: 'Map the code quickly: where things live, what calls what. No edits.' },
  { id: 'implementer', label: 'Implementer', category: 'code', modelTier: 'strong', mayRequestDispatch: true,
    tools: { allow: ['read', 'write', 'edit', 'glob', 'grep', 'terminal'], deny: [] },
    prompt: 'Make the smallest change that meets the card. Prove it with a real command.' },
  { id: 'verifier', label: 'Verifier', category: 'non-code', modelTier: 'strong', mayRequestDispatch: false,
    tools: { allow: ['read', 'glob', 'grep', 'terminal'], deny: ['write', 'edit'] },
    prompt: 'Run the checks and report what actually happened. Never edit the code under test.' },
  { id: 'reviewer', label: 'Reviewer', category: 'non-code', modelTier: 'cheap', mayRequestDispatch: false,
    tools: { allow: ['read', 'glob', 'grep'], deny: ['write', 'edit', 'terminal'] },
    prompt: 'Propose concrete changes. You cannot write: the output is a list of findings the caller applies.' },
  { id: 'debugger', label: 'Debugger', category: 'code', modelTier: 'strong', mayRequestDispatch: true,
    tools: { allow: ['read', 'write', 'edit', 'glob', 'grep', 'terminal'], deny: [] },
    prompt: 'Reproduce the failure first, then fix the cause rather than the symptom.' },
  { id: 'refactorer', label: 'Refactorer', category: 'code', modelTier: 'strong', mayRequestDispatch: true,
    tools: { allow: ['read', 'write', 'edit', 'glob', 'grep', 'terminal'], deny: [] },
    prompt: 'Reshape the code without changing behaviour. Keep the test suite green.' },
  { id: 'writer', label: 'Writer', category: 'non-code', modelTier: 'cheap', mayRequestDispatch: false,
    tools: { allow: ['read', 'write', 'edit'], deny: ['terminal'] },
    prompt: 'Write prose. No shell: if a fact needs checking, ask for it.' },
  { id: 'operator', label: 'Operator', category: 'maybe-code', modelTier: 'strong', mayRequestDispatch: true,
    tools: { allow: ['terminal', 'read'], deny: ['write', 'edit'] },
    prompt: 'Run the operation. Anything destructive or outward-facing needs the danger confirmation first.' },
  { id: 'synthesizer', label: 'Synthesizer', category: 'non-code', modelTier: 'cheap', mayRequestDispatch: false,
    tools: { allow: [...READ_ONLY], deny: [] },
    prompt: 'Fold several reports into one account. Say what is proven and what is only claimed.' },
].map((preset) => Object.freeze({
  ...preset,
  builtin: true,
  // 数组也要冻住：只冻外层的话，一次 tools.allow.push 就会改掉整份内置数据，
  // 而这个对象在进程里是共享的。
  tools: Object.freeze({
    allow: Object.freeze([...preset.tools.allow]),
    deny: Object.freeze([...preset.tools.deny]),
  }),
})))

const BUILTIN_IDS = Object.freeze(BUILTIN_PRESETS.map((preset) => preset.id))

/** 非空、去空白的字符串。 */
function readText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function readProp(source, key) {
  try {
    if (source === null || source === undefined || typeof source !== 'object') return undefined
    return source[key]
  } catch {
    return undefined
  }
}

function requireToolName(fn, name) {
  if (!TOOL_NAMES.includes(name)) {
    throw new TypeError(`${fn}: unknown tool "${String(name)}" (known: ${TOOL_NAMES.join(', ')})`)
  }
  return name
}

function requireTier(fn, tier) {
  if (!MODEL_TIERS.includes(tier)) {
    throw new TypeError(`${fn}: modelTier must be one of ${MODEL_TIERS.join(', ')} (got ${String(tier)})`)
  }
  return tier
}

function requireCategory(fn, category) {
  if (!CATEGORIES.includes(category)) {
    throw new TypeError(`${fn}: category must be one of ${CATEGORIES.join(', ')} (got ${String(category)})`)
  }
  return category
}

/** 一张工具名单：数组、去重、逐个校验。 */
function readTools(fn, value, label) {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new TypeError(`${fn}: tools.${label} must be an array`)
  const out = []
  for (const name of value) {
    const tool = requireToolName(fn, readText(name))
    if (!out.includes(tool)) out.push(tool)
  }
  return out
}

/** 只有这四套能申请再派发（ADR 0017）；其它预设一律不许。 */
const DISPATCH_PRESETS = Object.freeze(['implementer', 'debugger', 'refactorer', 'operator'])

/** 只读预设：允许名单里不许出现这些。 */
const READ_ONLY_PRESETS = Object.freeze(['reviewer'])
const READ_ONLY_FORBIDDEN = Object.freeze(['write', 'edit', 'terminal'])

/**
 * 预设是安全边界：覆盖不能把「只读」改写成「能写」，也不能给没资格的角色开再派发。
 * 违反就抛错——归一化会把这一行丢掉，设置页会拿到一条明确的拒绝。
 */
function assertInvariants(fn, preset) {
  const allow = preset.tools?.allow ?? []
  if (READ_ONLY_PRESETS.includes(preset.id)) {
    const bad = allow.filter((name) => READ_ONLY_FORBIDDEN.includes(name))
    if (bad.length > 0) {
      throw new TypeError(`${fn}: "${preset.id}" is read-only and cannot allow ${bad.join(', ')}`)
    }
  }
  if (preset.mayRequestDispatch === true && !DISPATCH_PRESETS.includes(preset.id)) {
    throw new TypeError(`${fn}: only ${DISPATCH_PRESETS.join('/')} may request a re-dispatch (got "${preset.id}")`)
  }
  return preset
}

/**
 * 把一条覆盖应用到一个预设上；只覆盖给了的字段。
 *
 * 工具面在**这里**收敛，而不是把优先级留给调用方：有效 allow = (新 allow 或原 allow) 减去
 * 最终 deny。否则一条只改 allow 的补丁会让同一个工具同时出现在两边，谁赢取决于使用方。
 */
function applyOverride(base, override, fn) {
  const tools = readProp(override, 'tools') ?? {}
  const allow = readTools(fn, readProp(tools, 'allow'), 'allow')
  const deny = readTools(fn, readProp(tools, 'deny'), 'deny')
  const category = readProp(override, 'category')
  const modelTier = readProp(override, 'modelTier')
  const label = readProp(override, 'label')
  const prompt = readProp(override, 'prompt')
  const mayRequest = readProp(override, 'mayRequestDispatch')
  const next = { ...base }
  const nextAllow = allow === undefined ? [...(base.tools?.allow ?? [])] : allow
  const nextDeny = deny === undefined ? [...(base.tools?.deny ?? [])] : deny
  next.tools = { allow: nextAllow.filter((name) => !nextDeny.includes(name)), deny: nextDeny }
  if (category !== undefined) next.category = requireCategory(fn, category)
  if (modelTier !== undefined) next.modelTier = requireTier(fn, modelTier)
  if (label !== undefined) next.label = readText(label)
  if (prompt !== undefined) next.prompt = readText(prompt)
  if (mayRequest !== undefined) next.mayRequestDispatch = mayRequest === true
  return assertInvariants(fn, next)
}

/** 归一化一条自定义预设：id 必须给，其余字段按默认补。 */
function readCustom(fn, id, raw) {
  const base = {
    id,
    label: readText(readProp(raw, 'label')) || id,
    category: 'non-code',
    modelTier: 'cheap',
    mayRequestDispatch: false,
    tools: { allow: [], deny: [] },
    prompt: '',
    builtin: false,
  }
  return applyOverride(base, raw, fn)
}

/**
 * 把存储面读成一张可用的预设表；任何输入都有答案。
 *
 * 形状：`{ [id]: preset }`。内置先铺满，再用存档里的同 id 行逐字段覆盖；存档里 id 不在
 * 内置列表中的，当成自定义预设（删内置只会在 `overridePresets` 里被拒，读的时候不炸）。
 */
export function normalizePresets(raw) {
  const table = {}
  for (const preset of BUILTIN_PRESETS) {
    // 每次都给新数组：表里的行与内置常量不能共享同一个数组对象。
    table[preset.id] = { ...preset, tools: { allow: [...preset.tools.allow], deny: [...preset.tools.deny] } }
  }
  const source = readProp(raw, 'presets') ?? raw
  const entries = Array.isArray(source)
    ? source.map((row) => [readText(readProp(row, 'id')), row])
    : source !== null && typeof source === 'object'
      ? Object.entries(source)
      : []
  for (const [rawId, row] of entries) {
    const id = rawId || readText(readProp(row, 'id'))
    if (id === '') continue
    const fn = 'normalizePresets'
    try {
      const next = Object.hasOwn(table, id)
        ? { ...applyOverride(table[id], row ?? {}, fn), builtin: true, id }
        : readCustom(fn, id, row ?? {})
      // 必须写成自有属性：`table['__proto__'] = x` 会走原型 setter，把整张表的原型换掉，
      // 于是这条预设既不在 keys 里、又会被 getPreset('__proto__') 取出来。
      Object.defineProperty(table, id, { value: next, enumerable: true, writable: true, configurable: true })
    } catch {
      // 坏行丢掉：一张能用的表比一次加载失败重要。
      continue
    }
  }
  return table
}

/** 读一套预设；没有就是 undefined。 */
export function getPreset(presets, id) {
  const key = readText(id)
  if (key === '') return undefined
  return normalizePresets(presets)[key]
}

/** 全部预设，按 id 排序，内置在前。 */
export function listPresets(presets) {
  const table = normalizePresets(presets)
  return Object.values(table).sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.id.localeCompare(b.id))
}

/**
 * 覆盖一套预设（内置或自定义）。校验失败抛错；成功返回新表，入参一个字段都不改。
 * 覆盖不会让内置变成自定义：`builtin` 保持原值。
 */
export function overridePresets(presets, id, patch) {
  const current = normalizePresets(presets)
  const key = readText(id)
  if (key === '' || current[key] === undefined) {
    throw new TypeError(`overridePresets: no preset "${key}"`)
  }
  if (patch === null || typeof patch !== 'object') {
    throw new TypeError('overridePresets: the patch must be an object')
  }
  const next = applyOverride(current[key], patch, 'overridePresets')
  return { ...current, [key]: { ...next, id: key, builtin: current[key].builtin } }
}

/** 删除一套自定义预设。内置 id 不可删除，只能覆盖。 */
export function deletePreset(presets, id) {
  const current = normalizePresets(presets)
  const key = readText(id)
  if (BUILTIN_IDS.includes(key)) {
    throw new Error(`deletePreset: "${key}" is built in; override it instead of removing it`)
  }
  if (current[key] === undefined) return current
  const next = { ...current }
  delete next[key]
  return next
}

/** 该预设是否被允许申请再派发（只有动代码的四套）。 */
export function mayRequestDispatch(presets, id) {
  const preset = getPreset(presets, id)
  return preset !== undefined && preset.mayRequestDispatch === true
}

/** 内置 id 列表（只读）。 */
export function builtinPresetIds() {
  return [...BUILTIN_IDS]
}
