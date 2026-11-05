/** 评审在 B 方案里不是一段，而是 dispatch 入口的一道准入检查。 */
export function gateAtEntry(card, { tier, budgetLeft }) {
  throw new Error('not implemented')
}

/** 每卡一次预算：返回剩余额度，BLOCK 后不再恢复。 */
export function consumeBudget(budgetLeft) {
  throw new Error('not implemented')
}

/** 评审类派发不再触发评审——自指终止。 */
export function isReviewDispatch(card) {
  throw new Error('not implemented')
}