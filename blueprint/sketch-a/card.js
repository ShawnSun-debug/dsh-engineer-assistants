/**
 * 任务卡：一次派发的最小单位。字段缺一即判 high。
 * @typedef {'high'|'low'} RiskTier
 * @typedef {Object} TaskCard
 * @property {string} goal
 * @property {string} doneDefinition
 * @property {string[]} files
 * @property {string[]} deps
 * @property {string} verify
 * @property {string} fallback
 * @property {number} items
 */

export const REQUIRED_FIELDS = ['goal', 'doneDefinition', 'files', 'deps', 'verify', 'fallback']
export const FANOUT_LIMIT = 4

const STRING_FIELDS = new Set(['goal', 'doneDefinition', 'verify', 'fallback', 'reviewKind'])
const ARRAY_FIELDS = new Set(['files', 'deps'])

/** 只保留已知字段并补默认值；不校验完整性，那是 missingFields 的事。 */
export function normalizeCard(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('task card must be a plain object')
  }
  const card = {}
  for (const [key, value] of Object.entries(input)) {
    if (STRING_FIELDS.has(key)) card[key] = typeof value === 'string' ? value.trim() : value
    else if (ARRAY_FIELDS.has(key)) card[key] = Array.isArray(value) ? value.slice() : value
    else if (key === 'items') card[key] = value
    else if (key === 'irreversible') card[key] = Boolean(value)
  }
  if (card.items === undefined) card.items = 1
  return card
}

/** @returns {string[]} 缺失（未出现，或空串）的必填字段 */
export function missingFields(card) {
  const missing = []
  for (const key of REQUIRED_FIELDS) {
    const value = card[key]
    if (value === undefined || value === null) { missing.push(key); continue }
    if (typeof value === 'string' && value.trim() === '') { missing.push(key); continue }
    if (Array.isArray(value)) continue
    if (typeof value !== 'string') { missing.push(key) }
  }
  return missing
}

/** 三条判据任一成立即 high。 */
export function riskTier(card, { irreducible = false, fanoutLimit = FANOUT_LIMIT, irreversible } = {}) {
  if (missingFields(card).length > 0) return 'high'
  if (irreversible ?? card.irreversible ?? irreducible) return 'high'
  if (Number(card.items ?? 1) > fanoutLimit) return 'high'
  return 'low'
}