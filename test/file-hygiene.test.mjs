import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

// 收口一类反复出现的评审 nit：文件末尾少了换行。第三次出现之后不再靠人盯，用一条测试钉住。
// 只查换行：尾随空格另有既有代码风格，混进来只会让这条测试变成噪音。
const root = new URL('../', import.meta.url)

function sourcesOf(dir) {
  const abs = new URL(dir + '/', root)
  return fs
    .readdirSync(abs, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(js|mjs)$/.test(entry.name))
    .map((entry) => new URL(entry.name, abs))
}

test('every source file ends with exactly one newline', () => {
  const files = [...sourcesOf('lib'), ...sourcesOf('test')]
  assert.ok(files.length > 50, 'the scan is looking at the real tree')
  const offenders = []
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8')
    if (!text.endsWith('\n')) offenders.push(path.basename(file.pathname) + ': no final newline')
    else if (text.endsWith('\n\n')) offenders.push(path.basename(file.pathname) + ': more than one final newline')
  }
  assert.deepEqual(offenders, [], 'these files need their final newline fixed')
})
