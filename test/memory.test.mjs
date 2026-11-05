import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  MEMORY_DEFAULT_KEEP,
  MEMORY_DOMAIN_NAME,
  MEMORY_DOMAIN_VERSION,
  MEMORY_INDEX_LABEL,
  MEMORY_MAX_ENTRIES,
  MEMORY_MAX_INDEX_BYTES,
  MEMORY_TABLE,
  createMemory,
  memoryDomainSpec,
  openMemoryDomain,
} from '../lib/memory.js'

/**
 * Domain-like fake: the duck type of an opened \`ctx.storageDomain\` domain and its
 * \`KvTable\`. Records live in a Map, so a test can drive every operation without
 * the host. \`persist\` is the hook a file-backed variant uses to write through.
 */
function fakeDomain({ rows = new Map(), persist = async () => {}, onTable } = {}) {
  const table = {
    get: (key) => rows.get(key),
    entries: () => rows.entries(),
    keys: () => rows.keys(),
    get size() {
      return rows.size
    },
    async put(key, value) {
      rows.set(key, value)
      await persist()
    },
    async delete(key) {
      const existed = rows.delete(key)
      if (existed) await persist()
      return existed
    },
    async deleteMany(keys) {
      let removed = 0
      for (const key of keys) if (rows.delete(key)) removed += 1
      if (removed > 0) await persist()
      return removed
    },
    async update(key, fn) {
      const next = fn(rows.get(key))
      rows.set(key, next)
      await persist()
      return next
    },
  }
  let closed = 0
  const domain = {
    name: MEMORY_DOMAIN_NAME,
    table(name) {
      onTable?.(name)
      return table
    },
    async close() {
      closed += 1
    },
    rows,
    get closed() {
      return closed
    },
  }
  const storageDomain = {
    opens: [],
    async open(spec) {
      storageDomain.opens.push(spec)
      return domain
    },
  }
  return { domain, table, storageDomain, rows }
}

/** A domain whose records are one JSON file: a new instance re-reads the medium. */
async function fileDomain(file) {
  let rows = new Map()
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    rows = new Map(Object.entries(parsed))
  } catch {
    rows = new Map()
  }
  return fakeDomain({
    rows,
    persist: async () => {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(file, JSON.stringify(Object.fromEntries(rows)))
    },
  })
}

/** A clock that never returns the same instant twice, so recency order is exact. */
function ticking(start = 1_000) {
  let now = start
  return () => {
    now += 1
    return now
  }
}

test('the domain spec declares one zod-validated table under the domain name', () => {
  const spec = memoryDomainSpec()
  assert.equal(spec.name, MEMORY_DOMAIN_NAME)
  assert.equal(spec.version, MEMORY_DOMAIN_VERSION)
  assert.ok(spec.tables[MEMORY_TABLE], 'the entries table is declared')
  const schema = spec.tables[MEMORY_TABLE].valueSchema
  const record = schema.parse({ id: 'mem-1', text: '事实', tags: ['dsh'], createdAt: 1, updatedAt: 2 })
  assert.equal(record.text, '事实')
  assert.throws(() => schema.parse({ tags: [] }), 'a record without text is rejected')
})

test('openMemoryDomain opens the declared domain and exposes the memory facade', async () => {
  const { storageDomain, domain, rows } = fakeDomain()
  const opened = await openMemoryDomain(storageDomain)
  assert.equal(storageDomain.opens.length, 1)
  assert.equal(storageDomain.opens[0].name, MEMORY_DOMAIN_NAME)
  assert.equal(opened.memory.size, 0)
  await opened.memory.add('跨会话事实')
  assert.equal(rows.size, 1, 'the write reached the table')
  await opened.close()
  assert.equal(domain.closed, 1, 'close is owned by the caller')
})

test('a written entry is read back by a new instance over the same medium', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-memory-'))
  try {
    const file = join(dir, 'memory.json')
    const first = await fileDomain(file)
    const opened = await openMemoryDomain(first.storageDomain)
    await opened.memory.add('用户偏好：worker 必须用简体中文回复')
    await opened.close()

    const second = await fileDomain(file)
    const reopened = await openMemoryDomain(second.storageDomain)
    const entries = reopened.memory.list()
    assert.equal(entries.length, 1)
    assert.equal(entries[0].text, '用户偏好：worker 必须用简体中文回复')
    assert.deepEqual(entries[0].tags, [])
    // The entry is a durable record, not an in-memory artifact: the file has it too.
    assert.match(await readFile(file, 'utf8'), /简体中文/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('list is newest first and search matches text and tags without case', async () => {
  const { table } = fakeDomain()
  const memory = createMemory({ table, now: ticking() })
  await memory.add('Alpha project uses pnpm', { tags: ['build'] })
  await memory.add('用户喜欢简体中文')
  await memory.add('beta bug on Windows', { tags: ['infra', 'win'] })

  assert.deepEqual(
    memory.list().map((entry) => entry.text),
    ['beta bug on Windows', '用户喜欢简体中文', 'Alpha project uses pnpm'],
  )
  assert.deepEqual(memory.search('ALPHA').map((entry) => entry.text), ['Alpha project uses pnpm'])
  assert.deepEqual(memory.search('infra').map((entry) => entry.text), ['beta bug on Windows'])
  assert.deepEqual(memory.search('windows').map((entry) => entry.text), ['beta bug on Windows'])
  assert.deepEqual(memory.search('nothing-here'), [])
  assert.deepEqual(memory.search(''), [], 'an empty query matches nothing')
  assert.equal(memory.search('a', { limit: 1 }).length, 1)
})

test('the entry cap rejects the 201st write with a clear error and keeps all 200', async () => {
  const { table, rows } = fakeDomain()
  const memory = createMemory({ table, now: ticking() })
  for (let index = 0; index < MEMORY_MAX_ENTRIES; index += 1) {
    await memory.add('记忆 ' + index)
  }
  assert.equal(memory.size, MEMORY_MAX_ENTRIES)

  await assert.rejects(memory.add('第 201 条'), (error) => {
    assert.match(error.message, new RegExp(String(MEMORY_MAX_ENTRIES)))
    assert.match(error.message, /prune/)
    return true
  })
  assert.equal(memory.size, MEMORY_MAX_ENTRIES, 'nothing was silently truncated or dropped')
  assert.equal(rows.size, MEMORY_MAX_ENTRIES)
})

test('two concurrent adds cannot both cross the entry cap', async () => {
  const rows = new Map()
  for (let i = 0; i < MEMORY_MAX_ENTRIES - 1; i += 1) {
    const id = 'm-' + i
    rows.set(id, { id, text: 'entry ' + i, tags: [], createdAt: i, updatedAt: i })
  }
  // The host only updates its in-memory table after the write is durable, so the fake
  // does the same: two callers that read before it resolves both see 199.
  const table = {
    entries: () => rows.entries(),
    get size() {
      return rows.size
    },
    async put(key, value) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      rows.set(key, value)
    },
  }
  const memory = createMemory({ table })
  const results = await Promise.allSettled([memory.add('one'), memory.add('two')])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1, 'exactly one fits')
  const rejected = results.filter((result) => result.status === 'rejected')
  assert.equal(rejected.length, 1)
  assert.match(rejected[0].reason.message, /limit/)
  assert.equal(memory.size, MEMORY_MAX_ENTRIES, 'the refused write left nothing behind')
})

test('the byte cap rejects a write that would push the index past 25 KiB', async () => {
  const { table, rows } = fakeDomain()
  const memory = createMemory({ table, now: ticking() })
  await assert.rejects(memory.add('x'.repeat(MEMORY_MAX_INDEX_BYTES + 100)), (error) => {
    assert.match(error.message, /25 KiB/)
    assert.match(error.message, /prune/)
    return true
  })
  assert.equal(rows.size, 0, 'a rejected write never reaches the table')
})

test('prune keeps the most recent N entries and removes the rest from every read', async () => {
  const { table, rows } = fakeDomain()
  const memory = createMemory({ table, now: ticking() })
  for (let index = 0; index < 10; index += 1) {
    await memory.add('条目 ' + index, { tags: index === 0 ? ['ancient'] : [] })
  }

  assert.equal(await memory.prune(3), 7)
  assert.equal(memory.size, 3)
  assert.deepEqual(
    memory.list().map((entry) => entry.text),
    ['条目 9', '条目 8', '条目 7'],
  )
  assert.deepEqual(memory.search('条目 0'), [], 'a pruned entry never appears in search')
  assert.deepEqual(memory.search('ancient'), [])
  assert.equal(rows.size, 3)

  // Keeping more than exists is a no-op, not an error.
  assert.equal(await memory.prune(3), 0)
  assert.equal(await memory.prune(MEMORY_DEFAULT_KEEP), 0)
})

test('the injected index is compact, labelled as AI memory, and one line per entry', async () => {
  const { table } = fakeDomain()
  const memory = createMemory({ table, now: ticking() })
  await memory.add('第一行\n第二行', { tags: ['note'] })
  await memory.add('plain fact')

  const text = memory.indexText()
  assert.ok(text.includes(MEMORY_INDEX_LABEL), 'the label marks it as AI memory, not instructions')
  assert.match(MEMORY_INDEX_LABEL, /AI 记忆/)
  assert.match(MEMORY_INDEX_LABEL, /非用户指令/)
  assert.ok(text.includes('plain fact'))
  assert.ok(text.includes('第一行 第二行'), 'newlines are folded so each entry stays one line')
  const lines = text.split('\n')
  assert.equal(lines.filter((line) => line.startsWith('- ')).length, 2)
  assert.ok(Buffer.byteLength(text, 'utf8') <= MEMORY_MAX_INDEX_BYTES)
})

test('an oversized record already on the medium makes the index fail loudly, not silently', async () => {
  const { table } = fakeDomain()
  const memory = createMemory({ table, now: ticking() })
  await table.put('external', { text: 'x'.repeat(MEMORY_MAX_INDEX_BYTES + 10), tags: [], createdAt: 1, updatedAt: 1 })
  assert.throws(() => memory.indexText(), /25 KiB/)
})

test('add validates its input and generates distinct ids', async () => {
  const { table } = fakeDomain()
  const memory = createMemory({ table, now: ticking() })
  await assert.rejects(memory.add('   '), /empty/)
  await assert.rejects(memory.add('ok', { tags: 'not-an-array' }), /tags/)
  const first = await memory.add('a')
  const second = await memory.add('b')
  assert.notEqual(first.id, second.id)
  assert.equal(first.createdAt, first.updatedAt)
})
