import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import * as fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  reportDir,
  reportPath,
  summaryPath,
  writeBeat,
  writeReport,
} from '../lib/secretary-archive.js'

const AT = new Date(2026, 9, 17, 5, 7).getTime()

let root

before(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'secretary-archive-'))
})

after(async () => {
  await fsp.rm(root, { recursive: true, force: true })
})

test('reportDir files reports by workspace and conversation', () => {
  const workspace = path.join(root, 'ws')
  assert.equal(
    reportDir({ workspace, conversation: 'conv-1' }),
    path.join(workspace, '.scratch', 'master-secretary', 'reports', 'conv-1'),
  )
  assert.throws(() => reportDir({ workspace }), /conversation/)
  assert.throws(() => reportDir({ conversation: 'conv-1' }), /workspace/)
})

test('reportPath names the file HH-mm.md with zero padding', () => {
  const workspace = path.join(root, 'ws')
  const expected = path.join(reportDir({ workspace, conversation: 'conv-1' }), '05-07.md')
  assert.equal(reportPath({ workspace, conversation: 'conv-1', at: AT }), expected)

  const afternoon = new Date(2026, 9, 17, 15, 9).getTime()
  assert.equal(
    path.basename(reportPath({ workspace, conversation: 'conv-1', at: afternoon })),
    '15-09.md',
  )
})

test('summaryPath puts _summary.md at the reports root', () => {
  const workspace = path.join(root, 'ws')
  assert.equal(
    summaryPath({ workspace, at: AT }),
    path.join(workspace, '.scratch', 'master-secretary', 'reports', '_summary.md'),
  )
})

test('writeReport creates missing parent directories and reports the byte count', async () => {
  const target = path.join(root, 'deep', 'nested', 'note.md')
  const result = await writeReport({ fs: fsp, path: target, text: '你好，世界' })

  assert.deepEqual(result, { path: target, bytes: Buffer.byteLength('你好，世界', 'utf8') })
  assert.equal(await fsp.readFile(target, 'utf8'), '你好，世界')
  assert.ok((await fsp.stat(path.dirname(target))).isDirectory())
})

test('writeReport rejects with the path when the write fails', async () => {
  const target = path.join(root, 'broken', 'note.md')
  const failing = {
    mkdir: async () => {},
    writeFile: async () => {
      throw new Error('disk full')
    },
  }

  await assert.rejects(
    () => writeReport({ fs: failing, path: target, text: 'x' }),
    (error) => error.message.includes(target) && error.message.includes('disk full'),
  )
})

test('writeBeat writes one file per session plus a summary, N+1 in total', async () => {
  const workspace = path.join(root, 'beat-ws')
  const result = await writeBeat({
    fs: fsp,
    workspace,
    at: AT,
    perSession: [
      { conversation: 'conv-a', text: '# A\n\n内容 A' },
      { conversation: 'conv-b', text: '# B\n\n内容 B' },
    ],
  })

  assert.equal(result.files.length, 3)
  assert.deepEqual(result.files, [
    reportPath({ workspace, conversation: 'conv-a', at: AT }),
    reportPath({ workspace, conversation: 'conv-b', at: AT }),
    summaryPath({ workspace, at: AT }),
  ])

  const reportsRoot = path.join(workspace, '.scratch', 'master-secretary', 'reports')
  assert.deepEqual((await fsp.readdir(reportsRoot)).sort(), ['_summary.md', 'conv-a', 'conv-b'])
  assert.deepEqual(await fsp.readdir(path.join(reportsRoot, 'conv-a')), ['05-07.md'])
  assert.deepEqual(await fsp.readdir(path.join(reportsRoot, 'conv-b')), ['05-07.md'])

  assert.equal(
    await fsp.readFile(reportPath({ workspace, conversation: 'conv-a', at: AT }), 'utf8'),
    '# A\n\n内容 A',
  )
  const summary = await fsp.readFile(summaryPath({ workspace, at: AT }), 'utf8')
  assert.match(summary, /时间：2026-10-17 05:07/)
  assert.match(summary, /会话数：2/)
  assert.match(summary, /## conv-a/)
  assert.match(summary, /内容 A/)
  assert.match(summary, /## conv-b/)
  assert.match(summary, /内容 B/)
})

test('writeBeat with no sessions still writes the summary alone', async () => {
  const workspace = path.join(root, 'empty-ws')
  const result = await writeBeat({ fs: fsp, workspace, at: AT, perSession: [] })

  assert.deepEqual(result.files, [summaryPath({ workspace, at: AT })])
  const summary = await fsp.readFile(summaryPath({ workspace, at: AT }), 'utf8')
  assert.match(summary, /会话数：0/)
})

test('writeBeat refuses a malformed session row instead of skipping it', async () => {
  await assert.rejects(
    () => writeBeat({ fs: fsp, workspace: path.join(root, 'bad-ws'), at: AT, perSession: [{ conversation: '' }] }),
    /conversation/,
  )
})
