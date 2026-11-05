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
 * @property {number} [items]
 */

export const REQUIRED_FIELDS = ['goal', 'doneDefinition', 'files', 'deps', 'verify', 'fallback']

/** @returns {TaskCard} */
export function normalizeCard(input) {
  throw new Error('not implemented')
}

/** @returns {string[]} 缺失的必填字段 */
export function missingFields(card) {
  throw new Error('not implemented')
}

/**
 * 三条判据任一成立即 high。
 * @returns {RiskTier}
 */
export function riskTier(card, { irreversible = false, fanoutLimit = 4 } = {}) {
  throw new Error('not implemented')
}