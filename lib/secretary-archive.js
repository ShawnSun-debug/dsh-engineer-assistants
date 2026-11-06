/**
 * 报告归档（秘书 spec 票 04）。
 *
 * 报告落在 `<工作区>/.scratch/master-secretary/reports/<对话>/<HH-mm>.md`；同一次节拍
 * 有多个会话时，另外在 reports 根写一份 `_summary.md` 汇总。目录按需创建，写盘失败
 * 必须带着路径抛出去——报告没写成而秘书看起来还在跑，比直接报错更糟。
 *
 * 纯逻辑的边缘：路径由参数算，不读时钟；文件系统通过 `fs` 注入（`node:fs/promises`
 * 的形状：`mkdir` / `writeFile`），所以测试用临时目录和会抛错的假实现都能覆盖到。
 * 这里只有 `node:path` 一个内置依赖，不 import 任何宿主模块。
 *
 * @module
 */
import { dirname, join } from 'node:path'
import { REPORT_ROOT } from './master-state.js'

function pad(value) {
  return String(value).padStart(2, '0')
}

/** 本地时间戳，与报告头部同一粒度。 */
function formatStamp(date) {
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  ].join(' ')
}

function readDate(fn, value) {
  let time = Number.NaN
  if (value instanceof Date) time = value.getTime()
  else if (typeof value === 'number') time = value
  else if (typeof value === 'string' && value.trim() !== '') time = new Date(value).getTime()
  if (!Number.isFinite(time)) {
    throw new TypeError(`${fn}: at must be a valid date (Date, epoch ms or ISO string)`)
  }
  return new Date(time)
}

function requireText(fn, field, value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') throw new TypeError(`${fn}: ${field} must be a non-empty string`)
  return text
}

/**
 * 对话名是路径里的一段，不是路径：标题里偶尔带 `/`、`?` 或控制字符，直接拼会把
 * 报告写进不该去的地方。这里把它们换成 `-`，畸形结果退回 `session`。
 */
function conversationSegment(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') throw new TypeError('reportDir: conversation must be a non-empty string')
  const segment = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/^\.+$/, '')
  return segment === '' ? 'session' : segment
}

/** 一个会话的报告目录。 */
export function reportDir(options = {}) {
  const { workspace, conversation } = options ?? {}
  const root = requireText('reportDir', 'workspace', workspace)
  return join(root, ...REPORT_ROOT, conversationSegment(conversation))
}

/** 一份报告的文件名：HH-mm.md，本地时间，两位补零。 */
export function reportPath(options = {}) {
  const { workspace, conversation, at } = options ?? {}
  const dir = reportDir({ workspace, conversation })
  const date = readDate('reportPath', at)
  return join(dir, `${pad(date.getHours())}-${pad(date.getMinutes())}.md`)
}

/**
 * 汇总文件固定在 reports 根，是一份滚动的 `_summary.md`。签名里保留 `at` 只为与
 * reportPath 对齐，不参与命名。
 */
export function summaryPath(options = {}) {
  const { workspace } = options ?? {}
  const root = requireText('summaryPath', 'workspace', workspace)
  return join(root, ...REPORT_ROOT, '_summary.md')
}

function requireFs(fn, fs) {
  if (fs === null || fs === undefined || typeof fs.mkdir !== 'function' || typeof fs.writeFile !== 'function') {
    throw new TypeError(`${fn}: fs must provide mkdir and writeFile`)
  }
  return fs
}

function writeFailure(fn, path, error) {
  const reason = error instanceof Error ? error.message : String(error)
  const failure = new Error(`${fn}: 写盘失败：${path}（${reason}）`)
  failure.cause = error
  return failure
}

/**
 * 写一份报告：先递归建父目录，再以 UTF-8 写全文，返回路径与实际字节数。
 *
 * 任何一步失败都抛出带路径的错误（原始错误挂在 `cause` 上），绝不吞掉——调用方
 * 必须知道这份报告没落盘。
 */
export async function writeReport(options = {}) {
  const { fs, path, text } = options ?? {}
  const io = requireFs('writeReport', fs)
  const target = requireText('writeReport', 'path', path)
  if (typeof text !== 'string') throw new TypeError('writeReport: text must be a string')

  try {
    await io.mkdir(dirname(target), { recursive: true })
  } catch (error) {
    throw writeFailure('writeReport', target, error)
  }
  try {
    await io.writeFile(target, text, 'utf8')
  } catch (error) {
    throw writeFailure('writeReport', target, error)
  }
  return { path: target, bytes: Buffer.byteLength(text, 'utf8') }
}

/** perSession 的每一行都必须自带会话名与全文；缺了是程序错误，不静默跳过。 */
function readRows(perSession) {
  if (!Array.isArray(perSession)) throw new TypeError('writeBeat: perSession must be an array')
  return perSession.map((raw) => {
    const row = raw !== null && typeof raw === 'object' ? raw : {}
    const conversation = typeof row.conversation === 'string' ? row.conversation.trim() : ''
    if (conversation === '') {
      throw new TypeError('writeBeat: each perSession row needs a non-empty conversation')
    }
    if (typeof row.text !== 'string') {
      throw new TypeError(`writeBeat: the report text for ${conversation} must be a string`)
    }
    return { conversation, text: row.text }
  })
}

/** 汇总正文：时间与会话数，然后按会话原样收入各自全文（多会话时一个文件看全）。 */
function renderSummary(at, rows) {
  const date = readDate('writeBeat', at)
  const lines = ['# 秘书汇总', '', `- 时间：${formatStamp(date)}`, `- 会话数：${rows.length}`, '']
  if (rows.length === 0) {
    lines.push('本次节拍没有会话。')
  } else {
    for (const row of rows) {
      lines.push(`## ${row.conversation}`, '', row.text.trim(), '')
    }
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}

/**
 * 一次节拍的归档：每个会话一份分文件，外加 reports 根的一份汇总，共 N+1 个文件。
 * 返回的 `files` 按写入顺序排列，最后一个是汇总文件。
 */
export async function writeBeat(options = {}) {
  const { fs, workspace, at, perSession } = options ?? {}
  const io = requireFs('writeBeat', fs)
  const rows = readRows(perSession)
  const files = []

  for (const row of rows) {
    const path = reportPath({ workspace, conversation: row.conversation, at })
    const written = await writeReport({ fs: io, path, text: row.text })
    files.push(written.path)
  }

  const summary = summaryPath({ workspace, at })
  const written = await writeReport({ fs: io, path: summary, text: renderSummary(at, rows) })
  files.push(written.path)

  return { files }
}
