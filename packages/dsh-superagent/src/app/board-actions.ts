/** Thin adapter between the board's three actions and the Engine's existing commands; it adds no business rules. */
import { UserError } from '../core/errors.ts'

/** The Store reads the adapter needs: the ticket it acts on and the threads that ticket subscribes to. */
export interface BoardActionStore {
  tickets: { get(id: string): { ended?: unknown } | undefined }
  threads: { list(): Array<{ key: string; subscriptions: string[] }> }
}

/** The Engine commands the adapter composes: the existing stop, retry and thread-unsubscribe paths. */
export interface BoardActionEngine {
  stopTicket(ticketId: string, reason?: string): unknown
  retryTicket(ticketId: string): unknown
  unsubscribe(thread: string): boolean
}

/** One board action's outcome; `code` becomes the HTTP status when `ok` is false, and `unsubscribed` counts threads. */
export interface BoardActionResult {
  ok: boolean
  message?: string
  code?: number
  unsubscribed?: number
}

/**
 * Builds the `action` that `startBoardServer` injects. Unknown tickets map to 404 and every refusal, such as an
 * ended ticket or a ticket that cannot retry, to 409; these are status mappings, not new rules. `unfocus` drops the
 * ticket's thread subscriptions by calling the existing thread-granular `unsubscribe` once per subscribed thread.
 */
export const boardActions = (store: BoardActionStore, engine: BoardActionEngine) =>
  async (kind: string, ticketId: string): Promise<BoardActionResult> => {
    const ticket = store.tickets.get(ticketId)
    if (!ticket) return { ok: false, code: 404, message: '工单不存在' }
    if (kind !== 'stop' && kind !== 'retry' && kind !== 'unfocus') return { ok: false, code: 400, message: '未知动作' }
    if (ticket.ended) return { ok: false, code: 409, message: '工单已结束' }
    try {
      if (kind === 'stop') {
        engine.stopTicket(ticketId)
        return { ok: true, message: '已停止' }
      }
      if (kind === 'retry') {
        engine.retryTicket(ticketId)
        return { ok: true, message: '已重试' }
      }
      const threads = store.threads.list()
        .filter(thread => thread.subscriptions.includes(ticketId))
        .map(thread => thread.key)
      if (!threads.length) return { ok: true, unsubscribed: 0, message: '该工单没有订阅线程' }
      const unsubscribed = threads.filter(thread => engine.unsubscribe(thread)).length
      return { ok: true, unsubscribed, message: `已取消 ${unsubscribed} 个线程的订阅` }
    } catch (error) {
      if (error instanceof UserError) return { ok: false, code: error.missing ? 404 : 409, message: error.message }
      throw error
    }
  }