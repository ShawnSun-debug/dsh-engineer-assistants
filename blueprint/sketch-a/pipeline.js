import { normalizeCard, riskTier } from './card.js'
import { reviewCard, shouldBlock, assertReviewShape } from './review.js'

/**
 * @typedef {Object} Deps
 * @property {(card:Object, opts:Object)=>Promise<{dispatchId:string}>} dispatch
 * @property {(dispatchId:string, review:Object|null)=>Promise<void>} settle
 * @property {{route:string, complete:Function}} [review]
 * @property {{irreversible?:boolean, fanoutLimit?:number}} [risk]
 */

export const PHASES = ['plan', 'review', 'dispatch', 'settle']

/** 从草图 B 吸收过来的显式转移表：非法转移直接抛错，不静默留在原状态。 */
export const TRANSITIONS = Object.freeze({
  plan: { planned: 'review' },
  review: { pass: 'dispatch', blocked: 'plan' },
  dispatch: { dispatched: 'settle' },
  settle: { settled: 'done' },
})

export function nextPhase(phase, outcome) {
  const row = TRANSITIONS[phase]
  if (!row || !Object.prototype.hasOwnProperty.call(row, outcome)) {
    throw new Error('illegal transition: ' + phase + ' + ' + outcome)
  }
  return row[outcome]
}

/** 线性四段：推进主流程，每次转移都经 nextPhase，BLOCK 在 review 段提前返回。 */
export async function runPipeline(deps, rawCard) {
  let phase = 'plan'
  const card = normalizeCard(rawCard)
  const tier = riskTier(card, deps.risk ?? {})
  phase = nextPhase(phase, 'planned')

  let review = null
  if (tier === 'high' && deps.review) {
    review = await reviewCard(deps.review.route, card, deps.review)
    assertReviewShape(review)
    if (shouldBlock(review, tier)) {
      return { phase, tier, verdict: review.verdict, failureMode: review.failureMode }
    }
  }
  phase = nextPhase(phase, 'pass')

  const { dispatchId } = await deps.dispatch(card, { tier, review })
  phase = nextPhase(phase, 'dispatched')

  await deps.settle(dispatchId, review)
  phase = nextPhase(phase, 'settled')
  return { phase, tier, dispatchId, verdict: review?.verdict ?? 'skipped' }
}