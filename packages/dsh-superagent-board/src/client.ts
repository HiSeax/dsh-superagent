/** Browser half: contributes the 看板 tab to better-sidebar and opens a roster teammate's Session on demand. */
import { createElement, useEffect, type ReactElement } from 'react'
import { INTERNAL_SESSION_SELECTOR, wrapSessionsList, type SessionsServiceLike } from './shared/internal-sessions.ts'

export const name = 'dsh-superagent-board'

/** `betterSidebar` hosts the tab; `uiWorkspace` opens the DSH Session a roster row names; `sessions` gets the filter. */
export const inject = ['betterSidebar', 'uiWorkspace', 'sessions']

/** The tab id; better-sidebar rejects a duplicate id, so this stays distinct from its built-in `subagent`. */
export const BOARD_TAB_ID = 'superagent'

/**
 * Sessions dsh-superagent creates for ticket workers. The core Session API has no hidden/system flag (only the
 * subagent origin is filtered), so two client-side layers hide them, each failing open on its own: the Workspace
 * sidebar's stable row key gets a display:none style rule (the floor — any row the list still renders stays
 * invisible), and `wrapSessionsList` marks worker rows with the coarse `subagent` origin the core sidebar and
 * search already hide. Including sessions that already exist and any future one; the persisted Session and its
 * agent stay intact.
 */
function hideInternalSessionRows(): () => void {
  if (typeof document === 'undefined') return () => {}
  const style = document.createElement('style')
  style.dataset.dshSuperagent = 'hide-worker-sessions'
  style.textContent = INTERNAL_SESSION_SELECTOR + '{display:none!important}'
  document.head.appendChild(style)
  return () => { style.remove() }
}

interface BetterSidebarService {
  registerTab(descriptor: Record<string, unknown>): () => void
}

interface WorkspaceService {
  openSession(id: string): void
}

export interface BoardClientContext {
  betterSidebar: BetterSidebarService
  uiWorkspace?: WorkspaceService
  /** The client `sessions` service; the board marks its worker rows for the list filter. */
  sessions?: SessionsServiceLike
  effect?: (factory: () => () => void) => void
}

/**
 * The tab body: a full-height iframe. The page owns its data (the board server reads superagent's `/team` roster and
 * `board.json` with the board token), so the shell posts nothing down; it only relays the member menu's open-session.
 */
function BoardTab({ ctx }: { ctx: BoardClientContext }): ReactElement {
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== window.location.origin) return
      const data = event.data as { type?: unknown; id?: unknown } | null
      if (data !== null && typeof data === 'object' && data.type === 'open-session' && typeof data.id === 'string') {
        try { ctx.uiWorkspace?.openSession(data.id) } catch { /* the session may not be listed; the board keeps working */ }
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [ctx])
  return createElement('iframe', {
    title: '看板',
    src: '/superagent-board/',
    style: { display: 'block', width: '100%', height: '100%', border: 0, background: '#f5f5f7' },
  })
}

/** The tab icon: stacked task layers, matching the built-in Tasks tab's visual role. */
function BoardTabIcon({ size }: { size: number }): ReactElement {
  return createElement('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    createElement('path', { d: 'M12 3 2.5 8 12 13l9.5-5L12 3z' }),
    createElement('path', { d: 'M2.5 16 12 21l9.5-5' }),
    createElement('path', { d: 'M2.5 12 12 17l9.5-5' }))
}

/** Registers the tab; better-sidebar owns the tab chrome, close button and right-dock placement. */
export function apply(ctx: BoardClientContext): void {
  const unhide = hideInternalSessionRows()
  const unmark = wrapSessionsList(ctx.sessions)
  const register = (): (() => void) => ctx.betterSidebar.registerTab({
    id: BOARD_TAB_ID,
    title: () => 'Superagent',
    description: () => '团队任务板与后台任务',
    icon: BoardTabIcon,
    order: 29,
    single: true,
    component: () => createElement(BoardTab, { ctx }),
  })
  if (ctx.effect === undefined) {
    register()
    // No effect scope to dispose with: the tab, the style rule, and the wrap stay for the page lifetime.
    void unhide
    void unmark
  } else {
    ctx.effect(register)
    ctx.effect(() => () => {
      unmark()
      unhide()
    })
  }
}
