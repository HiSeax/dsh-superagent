/** One Session list row as this filter sees it: durable identity and coarse origin. */
export interface SessionListRowLike {
  readonly id?: string
  readonly origin?: string
}

/** The Session list snapshot slice the filter marks; every other field passes through untouched. */
export interface SessionListSnapshotLike {
  readonly byId: Readonly<Record<string, SessionListRowLike>>
  readonly [key: string]: unknown
}

/** The `sessions.list` snapshot store slice this filter wraps (the real store is richer). */
export interface SessionListStoreLike {
  getSnapshot(): SessionListSnapshotLike
  subscribe(listener: () => void): () => void
  readonly [key: string]: unknown
}

/** The client `sessions` service slice this filter wraps (the real service is richer). */
export interface SessionsServiceLike {
  readonly list: SessionListStoreLike
}

/** dsh-windows-superagent prefixes its ticket-worker Session ids with this (`worker-<ticketId>`, see its `workerSessionId`). */
export const INTERNAL_SESSION_PREFIX = 'worker-'

/** The stable Workspace-sidebar row key of a worker Session: the browse list keys rows `session:<sessionId>`. */
export const INTERNAL_SESSION_SELECTOR = '[data-row-key^="session:worker-"]'

/** Whether one Session list row is a dsh-windows-superagent ticket worker. */
export function isInternalSessionRow(row: SessionListRowLike): boolean {
  return typeof row.id === 'string' && row.id.startsWith(INTERNAL_SESSION_PREFIX)
}

/**
 * Marks every worker row with the coarse `subagent` origin — the classification the core Workspace sidebar (and its
 * search) already hides — cloning only worker rows and passing every other row through by reference. A snapshot
 * without worker rows returns unchanged, so the wrap adds no churn when no worker runs. The persisted Session and
 * its agent stay untouched; this is display classification on the client list snapshot only.
 */
export function markedSnapshot<S extends SessionListSnapshotLike>(snapshot: S): S {
  let marked = false
  const byId: Record<string, SessionListRowLike> = {}
  for (const [id, row] of Object.entries(snapshot.byId)) {
    if (row !== undefined && isInternalSessionRow(row) && row.origin !== 'subagent') {
      byId[id] = { ...row, origin: 'subagent' }
      marked = true
    } else {
      byId[id] = row
    }
  }
  return marked ? { ...snapshot, byId } as S : snapshot
}

/**
 * Rebinds the sessions service's `list` store to a proxy that serves `markedSnapshot` of the real snapshot:
 * the core Workspace browser and search then hide worker rows through their own `origin === 'subagent'` rule.
 * Every other store member (including the manager's own `set`) forwards to the real store, and the manager keeps
 * writing through the rebound property untouched. Every failure mode declines with a console note and leaves the
 * service as it was (the style rule in `src/client.ts` stays as the floor), so a DSH upgrade that changes the
 * service shape fails open: worker rows reappear instead of the list breaking.
 *
 * @param sessions - the client `sessions` service (`ctx.sessions`), when this client exposes one.
 * @returns the disposer that restores the original property.
 */
export function wrapSessionsList(sessions: SessionsServiceLike | undefined): () => void {
  const decline = (reason: string): (() => void) => {
    console.info(`[dsh-windows-superagent-board] ${reason}; dsh-windows-superagent worker sessions stay visible to search`)
    return () => {}
  }
  if (sessions === undefined || sessions === null) return decline('the sessions service is absent')
  const descriptor = Object.getOwnPropertyDescriptor(sessions, 'list')
  if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined
    || descriptor.configurable === false) {
    return decline('sessions.list is not a rebindable data property')
  }
  const store = descriptor.value as SessionListStoreLike | undefined
  if (store === null || typeof store !== 'object' || typeof store.getSnapshot !== 'function'
    || typeof store.subscribe !== 'function') {
    return decline('sessions.list is not a snapshot store')
  }
  let last: SessionListSnapshotLike | undefined
  let marked: SessionListSnapshotLike | undefined
  const proxy = new Proxy(store, {
    get(target, property) {
      if (property === 'getSnapshot') {
        return () => {
          const current = target.getSnapshot()
          if (current !== last) {
            last = current
            marked = markedSnapshot(current)
          }
          return marked ?? current
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? (value as (...args: never[]) => unknown).bind(target) : value
    },
  })
  try {
    Object.defineProperty(sessions, 'list', { get: () => proxy, configurable: true, enumerable: descriptor.enumerable })
  } catch (error) {
    return decline(`could not rebind sessions.list (${String(error)})`)
  }
  console.info('[dsh-windows-superagent-board] dsh-windows-superagent worker sessions are hidden from the session list and search')
  return () => {
    try {
      Object.defineProperty(sessions, 'list', descriptor)
    } catch (error) {
      console.info(`[dsh-windows-superagent-board] could not restore sessions.list (${String(error)})`)
    }
  }
}
