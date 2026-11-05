
/**
 * 任务卡：一次派发的最小单位（ADR 0004）。字段缺一即判 high，高风险派发必须先过评审。
 * 纯函数、不依赖运行时，便于在 DSH 之外单测。
 */

export const REQUIRED_FIELDS = ['goal', 'doneDefinition', 'files', 'deps', 'verify', 'fallback']
export const FANOUT_LIMIT = 4

const STRING_FIELDS = new Set(['goal', 'doneDefinition', 'verify', 'fallback'])
const ARRAY_FIELDS = new Set(['files', 'deps'])

/** 只保留已知字段并补默认值；完整性由 missingFields 判。 */
export function normalizeCard(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('task card must be a plain object')
  }
  const card = {}
  for (const [key, value] of Object.entries(input)) {
    if (STRING_FIELDS.has(key)) card[key] = typeof value === 'string' ? value.trim() : value
    else if (ARRAY_FIELDS.has(key)) card[key] = Array.isArray(value) ? value.slice() : value
    else if (key === 'items' || key === 'irreversible') card[key] = value
  }
  if (card.items === undefined) card.items = 1
  return card
}

/** 缺失（未出现、空串、类型不对）的必填字段。 */
export function missingFields(card) {
  const missing = []
  for (const key of REQUIRED_FIELDS) {
    const value = card[key]
    if (value === undefined || value === null) { missing.push(key); continue }
    if (typeof value === 'string') { if (value.trim() === '') missing.push(key); continue }
    if (Array.isArray(value)) continue
    missing.push(key)
  }
  return missing
}

/** 三条判据任一成立即 high：缺字段、不可逆写、条目数超过扇出上限。 */
export function riskTier(card, { irreversible, fanoutLimit = FANOUT_LIMIT } = {}) {
  if (missingFields(card).length > 0) return 'high'
  if (irreversible ?? card.irreversible) return 'high'
  if (Number(card.items ?? 1) > fanoutLimit) return 'high'
  return 'low'
}

/** 缺字段时给主代理的原话：告诉他补哪几项，而不是只说参数错误。 */
export function cardRefusal(card) {
  const missing = missingFields(card)
  if (missing.length === 0) return null
  return (
    'Dispatch refused: the task card is missing ' + missing.join(', ') + '. ' +
    'A card needs goal, doneDefinition, files, deps, verify and fallback before a worker starts.'
  )
}

/** 从派发参数里取卡；缺什么由 missingFields 说，不在别处补默认值。 */
export function cardFromArgs(args) {
  const pick = (key) => (args?.[key] === undefined ? undefined : args[key])
  const card = {}
  for (const key of ['goal', 'doneDefinition', 'files', 'deps', 'verify', 'fallback']) {
    const value = pick(key)
    if (value !== undefined) card[key] = value
  }
  if (args?.items !== undefined) card.items = args.items
  if (args?.irreversible !== undefined) card.irreversible = args.irreversible
  return normalizeCard(card)
}
