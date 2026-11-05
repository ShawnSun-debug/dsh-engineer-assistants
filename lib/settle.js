
/**
 * 结算账本（ADR 0005 的 settle 段）。
 *
 * 只记「这次派发已经落定」，不删任何会话日志——日志留在宿主侧，重试与复盘还要读它。
 * 结算幂等：同一个 childId 第二次落定不改变结论，也不新增一行。
 * 有界：一个长跑宿主不会因为结算记录无限增长。
 */

export function createSettlements({ now = () => Date.now(), max = 256 } = {}) {
  const rows = new Map()

  return {
    /** @returns {{changed:boolean, row:object|null}} */
    settle(dispatchId, { ok, reason } = {}) {
      if (typeof dispatchId !== 'string' || dispatchId === '') return { changed: false, row: null }
      const existing = rows.get(dispatchId)
      if (existing !== undefined) return { changed: false, row: existing }
      const row = {
        dispatchId,
        ok: ok !== false,
        reason: typeof reason === 'string' ? reason : '',
        at: now(),
      }
      rows.set(dispatchId, row)
      while (rows.size > max) rows.delete(rows.keys().next().value)
      return { changed: true, row }
    },
    get: (dispatchId) => rows.get(dispatchId) ?? null,
    has: (dispatchId) => rows.has(dispatchId),
    get size() {
      return rows.size
    },
  }
}
