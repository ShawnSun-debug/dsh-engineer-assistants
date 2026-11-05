/**
 * 评审：零上下文、四字段、三态、每卡一次预算。
 * @typedef {'BLOCK'|'IMPROVE'|'PASS'} Verdict
 * @typedef {Object} ReviewResult
 * @property {Verdict} verdict
 * @property {string} target
 * @property {string} fix
 * @property {string} failureMode
 * @property {string[]} checked
 */

export const CHECKED = ['完成定义', '写白名单', '验收命令', '回退策略']
export const VERDICTS = new Set(['BLOCK', 'IMPROVE', 'PASS'])

export class ReviewShapeError extends Error {
  constructor(message) { super(message); this.name = 'ReviewShapeError' }
}

/** 三态之外、PASS 不列 checked、BLOCK/IMPROVE 缺 failureMode 的输出都算无效评审。 */
export function assertReviewShape(result) {
  if (result === null || typeof result !== 'object') throw new ReviewShapeError('review is not an object')
  if (!VERDICTS.has(result.verdict)) throw new ReviewShapeError('bad verdict: ' + String(result.verdict))
  if (!Array.isArray(result.checked) || result.checked.length === 0) {
    throw new ReviewShapeError('checked must be a non-empty list')
  }
  if (result.verdict !== 'PASS') {
    for (const key of ['target', 'fix', 'failureMode']) {
      if (typeof result[key] !== 'string' || result[key].trim() === '') {
        throw new ReviewShapeError('missing ' + key + ' for ' + result.verdict)
      }
    }
  }
  return result
}

/** 盲的是推理链：只喂任务卡与真实路径，不喂对话历史。 */
export function buildReviewPrompt(card) {
  return [
    'You review a task card before it is dispatched. You did not write it and you will not execute it.',
    'Return strict JSON: {verdict, target, fix, failureMode, checked}.',
    'verdict is BLOCK, IMPROVE or PASS. PASS is allowed and must list what you checked.',
    'For BLOCK/IMPROVE, failureMode must name the concrete mechanism by which the plan fails, not a generic risk.',
    '',
    JSON.stringify(card, null, 2),
  ].join('\n')
}

/** complete({route, prompt}) -> string（JSON）。拿不到合法 JSON 即抛错，不静默放行。 */
export async function reviewCard(route, card, { complete }) {
  if (typeof complete !== 'function') throw new TypeError('reviewCard needs a complete function')
  const raw = await complete({ route, prompt: buildReviewPrompt(card) })
  let parsed
  try { parsed = JSON.parse(String(raw).trim()) } catch { throw new ReviewShapeError('review is not JSON') }
  return assertReviewShape(parsed)
}

/** 分级：high 档 BLOCK 即拦；low 档放行并记账（补审走 followup，不阻塞）。 */
export function shouldBlock(result, tier) {
  return tier === 'high' && result.verdict === 'BLOCK'
}