import { describe, expect, it, vi } from 'vitest'
import { INTERNAL_SESSION_PREFIX, isInternalSessionRow, markedSnapshot, wrapSessionsList } from '../src/shared/internal-sessions.ts'

const row = (id: string, origin?: string): { id: string, origin?: string } => ({ id, ...(origin === undefined ? {} : { origin }) })

describe('isInternalSessionRow', () => {
  it('classifies only dsh-superagent worker rows', () => {
    expect(isInternalSessionRow(row('worker-self-9ae86a9'))).toBe(true)
    expect(isInternalSessionRow(row('worker-'))).toBe(true)
    expect(isInternalSessionRow(row('teammate-ffdefb94'))).toBe(false)
    expect(isInternalSessionRow(row('session-6f0d5f0e'))).toBe(false)
    expect(isInternalSessionRow(row('orchestrator-abc123'))).toBe(false)
    expect(isInternalSessionRow(row('workerlike-x'))).toBe(false)
    expect(isInternalSessionRow({ origin: 'subagent' })).toBe(false)
    expect(INTERNAL_SESSION_PREFIX).toBe('worker-')
  })
})

describe('markedSnapshot', () => {
  it('marks worker rows with the subagent origin and passes every other row through by reference', () => {
    const plain = row('session-6f0d5f0e')
    const subagent = row('session-child', 'subagent')
    const snapshot = { ids: ['worker-t1', 'session-6f0d5f0e', 'session-child'], byId: { 'worker-t1': row('worker-t1'), 'session-6f0d5f0e': plain, session_child: subagent } }
    const marked = markedSnapshot(snapshot)
    expect(marked.byId['worker-t1']).toEqual({ id: 'worker-t1', origin: 'subagent' })
    expect(marked.byId['worker-t1']).not.toBe(snapshot.byId['worker-t1'])
    expect(marked.byId['session-6f0d5f0e']).toBe(plain)
    expect(marked.byId.session_child).toBe(subagent)
    expect(marked.ids).toBe(snapshot.ids)
  })

  it('returns the same snapshot when there is nothing to mark', () => {
    const snapshot = { ids: [], byId: { 'session-6f0d5f0e': row('session-6f0d5f0e') } }
    expect(markedSnapshot(snapshot)).toBe(snapshot)
  })

  it('keeps already-marked rows by reference', () => {
    const markedRow = row('worker-t1', 'subagent')
    const snapshot = { ids: ['worker-t1'], byId: { 'worker-t1': markedRow } }
    expect(markedSnapshot(snapshot)).toBe(snapshot)
  })
})

describe('wrapSessionsList', () => {
  const fakeStore = (initial: { ids: string[], byId: Record<string, { id: string, origin?: string }> }) => {
    const listeners = new Set<() => void>()
    let snapshot: { ids: string[], byId: Record<string, { id: string, origin?: string }> } = initial
    return {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      set: (next: typeof snapshot) => {
        snapshot = next
        for (const listener of listeners) listener()
      },
    }
  }

  it('serves marked snapshots and forwards every other member to the real store', () => {
    const store = fakeStore({ ids: ['worker-t1'], byId: { 'worker-t1': row('worker-t1') } })
    const sessions = { list: store }
    const dispose = wrapSessionsList(sessions)
    expect(sessions.list).not.toBe(store)
    expect(sessions.list.getSnapshot().byId['worker-t1']).toEqual({ id: 'worker-t1', origin: 'subagent' })
    // The manager's own writes still land on the real store and flow through the proxy.
    const seen: string[] = []
    sessions.list.subscribe(() => { seen.push('notified') })
    sessions.list.set({ ids: ['worker-t1', 'plain'], byId: { 'worker-t1': row('worker-t1'), plain: row('plain') } })
    expect(seen).toEqual(['notified'])
    expect(sessions.list.getSnapshot().byId.plain).toEqual({ id: 'plain' })
    expect(sessions.list.getSnapshot().byId['worker-t1']).toEqual({ id: 'worker-t1', origin: 'subagent' })
    dispose()
  })

  it('memoizes the marked snapshot per underlying snapshot', () => {
    const store = fakeStore({ ids: [], byId: {} })
    const sessions = { list: store }
    const dispose = wrapSessionsList(sessions)
    const first = sessions.list.getSnapshot()
    expect(sessions.list.getSnapshot()).toBe(first)
    dispose()
  })

  it('restores the original property on dispose', () => {
    const store = fakeStore({ ids: [], byId: {} })
    const sessions = { list: store }
    const dispose = wrapSessionsList(sessions)
    expect(sessions.list).not.toBe(store)
    dispose()
    expect(sessions.list).toBe(store)
  })

  it('declines fail-open without touching a service whose list is not a rebindable data property', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const accessorStore = fakeStore({ ids: [], byId: {} })
      const accessor = { get list() { return accessorStore } }
      wrapSessionsList(accessor as never)()
      expect(accessor.list).toBe(accessorStore)

      const frozen = Object.freeze({ list: fakeStore({ ids: [], byId: {} }) })
      wrapSessionsList(frozen)()
      expect(frozen.list).toBeDefined()

      const missing = { list: {} }
      wrapSessionsList(missing as never)()
      expect(missing.list).toEqual({})

      wrapSessionsList(undefined)()
      expect(info).toHaveBeenCalledTimes(4)
    } finally {
      info.mockRestore()
    }
  })
})
