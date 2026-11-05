
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeCard, missingFields, riskTier, cardRefusal, REQUIRED_FIELDS, FANOUT_LIMIT } from '../lib/card.js'

const golden = [
  {
    "id": "g01",
    "tier": "low",
    "card": {
      "goal": "列出仓库里的 ADR 标题",
      "doneDefinition": "输出 4 个标题",
      "files": [],
      "deps": [],
      "verify": "grep 到 4 行",
      "fallback": "报告读不到"
    }
  },
  {
    "id": "g02",
    "tier": "high",
    "card": {
      "goal": "重构 gate.js",
      "doneDefinition": "测试通过",
      "files": [
        "lib/gate.js"
      ],
      "deps": [],
      "verify": "",
      "fallback": "回滚"
    }
  },
  {
    "id": "g03",
    "tier": "high",
    "card": {
      "goal": "批量改写 8 个文件头",
      "doneDefinition": "8 个文件都有头",
      "files": [
        "a.js"
      ],
      "deps": [],
      "verify": "node --check",
      "fallback": "逐个回滚",
      "items": 8
    }
  },
  {
    "id": "g04",
    "tier": "high",
    "card": {
      "goal": "修 README",
      "doneDefinition": "段落改好",
      "deps": [],
      "verify": "diff 非空",
      "fallback": "git checkout"
    }
  },
  {
    "id": "g05",
    "tier": "low",
    "card": {
      "goal": "给 4 个测试补用例",
      "doneDefinition": "4 个新用例",
      "files": [
        "test/a.test.mjs"
      ],
      "deps": [],
      "verify": "node --test",
      "fallback": "删除新增用例",
      "items": 4
    }
  },
  {
    "id": "g06",
    "tier": "high",
    "card": {
      "goal": "升级依赖",
      "doneDefinition": "锁定版本",
      "files": [
        "package.json"
      ],
      "deps": [],
      "verify": "npm ci"
    }
  },
  {
    "id": "g07",
    "tier": "low",
    "card": {
      "goal": "读 retry.js 并总结重试窗口",
      "doneDefinition": "给出常量值",
      "files": [],
      "deps": [],
      "verify": "引用行号",
      "fallback": "报告未找到"
    }
  },
  {
    "id": "g08",
    "tier": "high",
    "card": {
      "goal": "清理死代码",
      "files": [
        "lib/stage.js"
      ],
      "deps": [],
      "verify": "node --check",
      "fallback": "git revert"
    }
  },
  {
    "id": "g09",
    "tier": "low",
    "card": {
      "goal": "对比两份 ADR 的取舍",
      "doneDefinition": "两条结论",
      "files": [],
      "deps": [],
      "verify": "引用行号",
      "fallback": "报告缺失",
      "items": 2
    }
  },
  {
    "id": "g10",
    "tier": "high",
    "card": {
      "goal": "清空过期会话日志",
      "doneDefinition": "日志目录为空",
      "files": [
        "state/sessions"
      ],
      "deps": [],
      "verify": "目录为空",
      "fallback": "从备份恢复",
      "irreversible": true
    }
  }
]

test('golden cards: risk tier matches expectation', () => {
  for (const row of golden) {
    const card = normalizeCard(row.card)
    assert.equal(riskTier(card, { irreversible: Boolean(row.card.irreversible) }), row.tier, row.id)
  }
  assert.equal(golden.length, 10)
})

test('normalizeCard trims strings, defaults items, drops unknown keys', () => {
  const card = normalizeCard({ goal: '  x  ', files: ['a'], verify: ' v ', anything: 1 })
  assert.equal(card.goal, 'x')
  assert.equal(card.verify, 'v')
  assert.equal(card.items, 1)
  assert.deepEqual(card.files, ['a'])
  assert.equal('anything' in card, false)
})

test('normalizeCard rejects non-objects', () => {
  assert.throws(() => normalizeCard(null), TypeError)
  assert.throws(() => normalizeCard([]), TypeError)
  assert.throws(() => normalizeCard('x'), TypeError)
})

test('missingFields names every absent or blank required field', () => {
  assert.deepEqual(missingFields({}), REQUIRED_FIELDS)
  assert.deepEqual(missingFields({ goal: 'x', doneDefinition: ' ', files: [], deps: [], verify: 'v', fallback: 'f' }), ['doneDefinition'])
  assert.deepEqual(missingFields(normalizeCard(golden[0].card)), [])
})

test('riskTier: fan-out limit is exclusive at the boundary', () => {
  const base = normalizeCard(golden[0].card)
  assert.equal(riskTier({ ...base, items: FANOUT_LIMIT }), 'low')
  assert.equal(riskTier({ ...base, items: FANOUT_LIMIT + 1 }), 'high')
  assert.equal(riskTier({ ...base, irreversible: true }), 'high')
})

test('cardRefusal speaks the missing fields, or returns null when complete', () => {
  assert.equal(cardRefusal(normalizeCard(golden[0].card)), null)
  const msg = cardRefusal(normalizeCard({ goal: 'x' }))
  assert.match(msg, /missing/)
  assert.match(msg, /doneDefinition/)
  assert.match(msg, /fallback/)
})
