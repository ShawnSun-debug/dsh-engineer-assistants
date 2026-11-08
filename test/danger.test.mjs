import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DANGER_CATEGORIES,
  DEFAULT_TIMEOUT_MS,
  classifyDanger,
  createDangerGate,
  dangerKey,
} from '../lib/danger.js'

const positives = [
  ['file-destruction', { command: 'rm -rf build' }],
  ['file-destruction', { command: 'Remove-Item -Recurse -Force dist' }],
  ['file-destruction', { command: 'echo x > config/prod.yml' }],
  ['file-destruction', { command: 'Set-Content -Path src/index.js -Value ""' }],
  ['file-destruction', { command: 'cp build/app.js dist/app.js' }],
  ['file-destruction', { command: 'robocopy src dst /MIR' }],
  ['file-destruction', { intent: '删除这个目录' }],
  ['history-rewrite', { command: 'git push --force-with-lease assistants main' }],
  ['history-rewrite', { command: 'git reset --hard HEAD~3' }],
  ['history-rewrite', { intent: '强制推送到 main' }],
  ['deploy', { command: 'kubectl apply -f prod.yaml' }],
  ['deploy', { command: 'npm run deploy' }],
  ['deploy', { intent: '发布到生产' }],
  ['host-config', { command: 'edit ~/.dsh/profiles/ihateu/cordis.patch.yml' }],
  ['host-config', { command: 'git config --global user.name x' }],
  ['host-config', { command: 'npm config set registry https://x' }],
  ['host-config', { command: 'Set-ItemProperty -Path HKCU:\\Software\\x -Name y -Value z' }],
  ['host-config', { command: 'choco install nodejs' }],
  ['production-data', { command: 'psql -c "DROP TABLE users"' }],
  ['production-data', { intent: '清理生产数据' }],
  ['production-data', { intent: 'delete production data' }],
  ['production-data', { intent: 'drop the production table' }],
  ['production-data', { intent: 'purge prod users' }],
  ['outbound', { command: 'curl -X POST https://api.example.com/hooks' }],
  ['outbound', { command: 'git push assistants main' }],
  ['outbound', { intent: '把改动发到群里' }],
]

test('each of the six categories is recognised, including the awkward phrasings', () => {
  assert.equal(DANGER_CATEGORIES.length, 6)
  const seen = new Set()
  for (const [category, input] of positives) {
    const plan = classifyDanger(input)
    assert.equal(plan.danger, true, JSON.stringify(input))
    assert.ok(plan.categories.includes(category), category + ' for ' + JSON.stringify(input) + ' got ' + JSON.stringify(plan.categories))
    seen.add(category)
  }
  assert.deepEqual([...seen].sort(), [...DANGER_CATEGORIES].sort())
})

test('ordinary work is not dangerous, including paths that merely contain a dangerous word', () => {
  for (const input of [
    { command: 'node --test test/*.test.mjs' },
    { command: 'node --test test/release.test.mjs' },
    { command: 'git status' },
    { command: 'cat package.json' },
    { command: 'rm build/tmp.log' },
    { command: 'npm run build' },
    { command: 'edit docs/deploy.md' },
    { command: '' },
    {},
  ]) {
    assert.equal(classifyDanger(input).danger, false, JSON.stringify(input))
  }
})

test('a line break does not join one sentence to another', () => {
  const plan = classifyDanger({ command: 'cat prod.log', intent: '删除陈旧的注释' })
  assert.equal(plan.categories.includes('production-data'), false, JSON.stringify(plan.categories))
})

test('intent can make an otherwise ordinary command dangerous', () => {
  assert.equal(classifyDanger({ command: 'psql < script.sql' }).danger, false)
  assert.equal(classifyDanger({ command: 'psql < script.sql', intent: 'drop table orders' }).danger, true)
})

test('a confirmed action runs once without asking again, but a new intent asks again', async () => {
  let asked = 0
  const gate = createDangerGate({ ask: () => { asked += 1; return true } })
  assert.equal((await gate.check({ command: 'node scripts/migrate.mjs', intent: 'drop table orders' })).reason, 'confirmed')
  assert.equal((await gate.check({ command: 'node scripts/migrate.mjs', intent: 'drop table orders' })).reason, 'already-confirmed')
  const second = await gate.check({ command: 'node scripts/migrate.mjs', intent: 'drop table users (production)' })
  assert.equal(second.approved, true)
  assert.equal(second.reason, 'confirmed')
  assert.equal(asked, 2, 'the intent is part of the key, so this must ask again')
})

test('silence for the whole window means no, and the timeout verdict actually fires', async () => {
  const notified = []
  const gate = createDangerGate({
    ask: () => new Promise(() => {}),
    timeoutMs: 25,
    onTimeout: async (plan) => { notified.push(plan.command) },
  })
  const result = await gate.check({ command: 'git push --force origin main' })
  assert.equal(result.approved, false)
  assert.equal(result.reason, 'timeout')
  assert.deepEqual(notified, ['git push --force origin main'])
})

test('malformed input is declined, never approved and never thrown', async () => {
  const gate = createDangerGate({ ask: () => true })
  for (const input of [null, undefined, 42, ['rm', '-rf', '/'], { command: ['rm', '-rf'] }]) {
    const result = await gate.check(input)
    assert.equal(result.approved, false, JSON.stringify(input))
    assert.equal(result.reason, 'invalid-input', JSON.stringify(input))
  }
})

test('a rejection from the channel is a decline, not an approval', async () => {
  const gate = createDangerGate({ ask: () => Promise.reject(new Error('channel down')) })
  assert.equal((await gate.check({ command: 'rm -rf build' })).approved, false)
})

test('no channel means the destructive action is refused', async () => {
  const gate = createDangerGate({})
  assert.equal((await gate.check({ command: 'rm -rf build' })).approved, false)
})

test('a safe action never asks', async () => {
  let asked = 0
  const gate = createDangerGate({ ask: () => { asked += 1; return true } })
  const result = await gate.check({ command: 'node --test' })
  assert.equal(result.reason, 'not-dangerous')
  assert.equal(asked, 0)
})

test('the key includes the intent and is stable regardless of category order', () => {
  const a = classifyDanger({ command: 'git push --force origin main' })
  const b = classifyDanger({ command: 'git push --force origin main', intent: 'force push' })
  assert.notEqual(dangerKey(a), dangerKey(b), 'the intent must change the key')
  assert.notEqual(dangerKey(a), dangerKey(classifyDanger({ command: 'git push --force origin dev' })))
  assert.equal(DEFAULT_TIMEOUT_MS, 600000)
})
test('shell plumbing is not an overwrite', () => {
  for (const input of [
    { command: 'node --test 2>&1' },
    { command: 'npm test 2>&1 | tail' },
    { command: 'git fetch > /dev/null 2>&1' },
    { command: 'node -e "const r = arr.map(x => x * 2)"' },
    { command: "git log --format='%h -> %s'" },
    { command: 'node --test test/cp.test.mjs' },
    { command: 'edit docs/部署.md' },
    { command: 'git commit -m "更新部署脚本的路径"' },
  ]) {
    const plan = classifyDanger(input)
    assert.equal(plan.categories.includes('file-destruction'), false, JSON.stringify(input) + ' -> ' + JSON.stringify(plan.categories))
    assert.equal(plan.categories.includes('deploy'), false, JSON.stringify(input) + ' -> ' + JSON.stringify(plan.categories))
  }
})

test('a multi-line command is still one command', () => {
  assert.equal(classifyDanger({ command: 'curl.exe -X\nPOST https://api.example.com/x' }).categories.includes('outbound'), true)
})

test('a non-string intent is invalid input, not an empty intent', async () => {
  const gate = createDangerGate({ ask: () => true })
  for (const intent of [['drop table orders'], { text: 'drop it' }, 42]) {
    const result = await gate.check({ command: 'psql < script.sql', intent })
    assert.equal(result.approved, false, JSON.stringify(intent))
    assert.equal(result.reason, 'invalid-input', JSON.stringify(intent))
  }
})
test('Chinese deploy covers verb-first phrasing and still skips documents', () => {
  for (const intent of ['部署新版本', '发布这个包', '上线', '重新部署', '发布到生产', '部署服务', '部署新版本并更新文档', '把新版本部署到服务器并更新文档']) {
    assert.equal(classifyDanger({ intent }).categories.includes('deploy'), true, intent)
  }
  for (const input of [
    { command: 'edit docs/部署.md' },
    { command: 'git commit -m "更新部署脚本的路径"' },
    { intent: '看一下部署文档' },
  ]) {
    assert.equal(classifyDanger(input).categories.includes('deploy'), false, JSON.stringify(input))
  }
})

test('an explicit null field means absent, not invalid', async () => {
  const gate = createDangerGate({ ask: () => true })
  assert.equal((await gate.check({ command: 'git status', intent: null })).reason, 'not-dangerous')
  assert.equal((await gate.check({ command: 'rm -rf build', intent: null })).reason, 'confirmed')
})
