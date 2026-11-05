
/**
 * 评审段（ADR 0004）：一个零上下文的评审者判一次任务卡。
 *
 * 纯函数 + 注入的 run，便于在 DSH 之外单测；真实实现由 index.js 注入一个
 * 走 worker 路由的 run（见 createReviewRunner）。
 */

export const CHECKED = ['完成定义', '写白名单', '验收命令', '回退策略']
export const VERDICTS = new Set(['BLOCK', 'IMPROVE', 'PASS'])

export class ReviewShapeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ReviewShapeError'
  }
}

/** 三态之外、PASS 不列 checked、BLOCK/IMPROVE 缺字段的输出都算无效评审。 */
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
    'You cannot see the author\'s reasoning or the conversation; judge the card on its own.',
    'Return strict JSON only: {verdict, target, fix, failureMode, checked}.',
    'verdict is BLOCK, IMPROVE or PASS. PASS is allowed and must list what you checked in "checked".',
    'For BLOCK/IMPROVE: target quotes the card field or sentence, fix says what it should say,',
    'and failureMode names the concrete mechanism by which the plan fails (not a generic risk).',
    'Write verdicts and messages in Simplified Chinese.',
    '',
    'card:',
    JSON.stringify(card, null, 2),
  ].join('\n')
}

/** 从一段文本里抠出第一个 JSON 对象；评审者常在 JSON 外套一句话。 */
export function parseReviewText(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') throw new ReviewShapeError('review text is empty')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) throw new ReviewShapeError('review text has no JSON object')
  let parsed
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    throw new ReviewShapeError('review JSON does not parse')
  }
  return assertReviewShape(parsed)
}

/** run(card) -> 评审者的原始文本。形状错误向上抛，绝不静默放行。 */
export async function reviewCard(card, { run }) {
  if (typeof run !== 'function') throw new TypeError('reviewCard needs a run function')
  return parseReviewText(await run(card))
}

/** 分级：只有 high 档的 BLOCK 才拦；low 档放行并记账（补审走通知，不阻塞）。 */
export function shouldBlock(verdict, tier) {
  return tier === 'high' && verdict?.verdict === 'BLOCK'
}

/** 打回主代理时说的话：给失败机制，不给改写稿。 */
export function blockMessage(card, verdict) {
  return (
    'Dispatch refused by review: ' + verdict.failureMode + '. ' +
    'Target: ' + verdict.target + '. Nothing was started. Replan the card and dispatch again.'
  )
}

/** 评审类派发不再触发评审（自指终止）。 */
export function isReviewDispatch(args) {
  return args?.review === true
}
