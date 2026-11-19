/** The board payload's schema version, its ticket-state vocabulary, and the mapping from stored ticket states. */

/** Version of the read-only `board.json` payload; bump it when a field change breaks the board plugin. */
export const BOARD_SCHEMA_VERSION = 1

/** Ticket states the board groups and colours; an unrecognised stored state reads as `new`. */
export type TicketState = 'new' | 'evaluating' | 'executing' | 'review' | 'done' | 'blocked' | 'failed' | 'stopped'

/** Stored ticket states (including the trigger-style words) mapped to the board vocabulary. */
const MAP: Record<string, TicketState> = {
  working: 'executing',
  idle: 'new',
  blocked: 'blocked',
  failed: 'failed',
  review: 'review',
  done: 'done',
  stopped: 'stopped',
  evaluating: 'evaluating',
  executing: 'executing',
}

/** Maps one stored ticket state to the board's `TicketState`, falling back to `new`. */
export const toTicketState = (state: string): TicketState => MAP[state] ?? 'new'