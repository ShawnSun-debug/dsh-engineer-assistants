import assert from 'node:assert/strict'
import test from 'node:test'
import { bubbleText, deliver, pickTarget } from '../lib/secretary-deliver.js'

/**
 * 票 05 的投递层只有三件事：挑接收方、拼一句话、把投递变成可记录的返回值。
 * 三种情况分别钉住——挑错接收方比不说更糟；冒泡不能长成一份报告；投递失败绝不
 * 抛进节拍（报告已经落盘，这一拍不说话而已）。
 */

test('pickTarget uses the declared master session and never guesses', () => {
  assert.equal(
    pickTarget({ registry: { masterSessionId: 'master-1' }, config: {}, triggerSessionId: 'orch-1' }),
    'master-1',
  )
  // registry 没写时，config 里同一个值仍然算「已声明的 Master」。
  assert.equal(
    pickTarget({ registry: {}, config: { secretaryMasterSessionId: 'master-2' }, triggerSessionId: 'orch-1' }),
    'master-2',
  )
  // 没有 Master：返回 null，绝不拿触发会话或名单里的 orchestrator 顶替。
  assert.equal(pickTarget({ registry: { masterSessionId: '' }, config: {}, triggerSessionId: 'orch-1' }), null)
  assert.equal(pickTarget({ registry: { masterSessionId: '   ' }, config: {} }), null)
  assert.equal(pickTarget({}), null)
  assert.equal(pickTarget(), null)
})

test('bubbleText lists the hit kinds plus one key fact, and stays under 300 characters', () => {
  const text = bubbleText({
    changes: ['state-flip', 'step-advance'],
    summary: { state: 'Working', step: { index: 2, total: 3 }, workers: [], artifacts: [] },
  })
  assert.match(text, /状态翻转/)
  assert.match(text, /步骤推进/)
  assert.match(text, /第 2 步 \/ 共 3 步/)
  assert.ok(text.length <= 300, text)

  // 未知类别被忽略；超长内容被截断：冒泡永远是一条短消息。
  const long = bubbleText({
    changes: ['nope'],
    summary: { state: 'Working', artifacts: [`D:/out/${'x'.repeat(400)}.png`] },
  })
  assert.ok(long.length <= 300, String(long.length))
  assert.match(long, /暂无可报的变化/)
  assert.ok(bubbleText().length <= 300)
})

test('deliver reports the outcome and never throws', async () => {
  const calls = []
  const ok = await deliver({
    messaging: {
      deliver: async (target, text) => {
        calls.push([target, text])
        return { delivered: true }
      },
    },
    target: 'master-1',
    text: '秘书：状态翻转｜Working',
  })
  assert.deepEqual(ok, { delivered: true })
  assert.deepEqual(calls, [['master-1', '秘书：状态翻转｜Working']])

  // 接收方为空：一次都不调用投递器。
  assert.deepEqual(
    await deliver({
      messaging: {
        deliver: () => {
          throw new Error('must not run')
        },
      },
      target: null,
      text: 'x',
    }),
    { delivered: false, reason: 'no-target' },
  )

  // 投递器说没送出去：原样采信；投递器直接抛错：变成 reason。
  assert.deepEqual(
    await deliver({ messaging: { deliver: async () => ({ delivered: false, reason: 'target-missing' }) }, target: 'm', text: 'x' }),
    { delivered: false, reason: 'target-missing' },
  )
  assert.deepEqual(
    await deliver({
      messaging: {
        deliver: async () => {
          throw new Error('flush failed')
        },
      },
      target: 'm',
      text: 'x',
    }),
    { delivered: false, reason: 'flush failed' },
  )

  // 根本没有投递器：也不抛。
  assert.deepEqual(await deliver({ target: 'm', text: 'x' }), { delivered: false, reason: 'no-messaging' })
})
