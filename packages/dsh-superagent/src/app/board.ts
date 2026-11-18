/** Assembles the read-only `board.json` payload from stored tickets and the current team roster. */
import { BOARD_SCHEMA_VERSION, toTicketState } from './board-types.ts'

/** One stored ticket as the board reads it (the Store's ticket record or a test fixture). */
export interface BoardTicketInput {
  id: string
  title: string
  state: string
  owner: string | null
  updatedAt: string
  summary?: string
  origin?: 'self' | 'trigger'
  ownerKind?: 'main' | 'member'
  ownerLabel?: string
}

/**
 * Builds the board payload: schema version, generation time, no degradation, the main agent,
 * the team roster, and every ticket with its board state, owner, update time, and 200-character summary.
 */
export const buildBoard = ({ tickets, members }: { tickets: BoardTicketInput[]; members: unknown[] }) => ({
  schemaVersion: BOARD_SCHEMA_VERSION,
  generatedAt: new Date().toISOString(),
  degraded: null,
  main: { id: 'lead', name: 'lead', role: 'lead', state: 'working' },
  members,
  tickets: tickets.map(ticket => ({
    id: ticket.id,
    title: ticket.title,
    state: toTicketState(ticket.state),
    ownerMemberId: ticket.owner,
    updatedAt: ticket.updatedAt,
    summary: (ticket.summary ?? '').slice(0, 200),
    origin: ticket.origin ?? 'trigger',
    ...(ticket.ownerKind ? { ownerKind: ticket.ownerKind } : {}),
    ...(ticket.ownerLabel ? { ownerLabel: ticket.ownerLabel } : {}),
  })),
})