/** The host aggregate: superagent's `board.json` plus the runtime roster (`/team`), with the shared alias layer. */
import { aliasMembers, type AliasMemberRow, type AliasTicketInput } from './shared/alias.ts'

/** One roster member as the aggregate reads it (superagent's `/team` row). */
export interface TeamMemberInput {
  id: string
  name: string
  role: string
  phase?: string
  state?: string
  sessionId?: string
  ticketId?: string
  ticketTitle?: string
  ticketEnded?: true
  /** Direct child agents that are running now; omitted when none or when the host reader is unavailable. */
  subagents?: { running: number; items: { id: string; label: string }[] }
}

/** A live self-created ticket and the worker Session running it; the board derives temporary-worker labels from order. */
export interface TemporaryWorker {
  sessionId: string
  ticketId: string
  ticketTitle: string
  startedAt: string
}

/** The roster face the board shows: the main Session plus the teammates `/team` lists. */
export interface TeamInput {
  main: TeamMemberInput
  members?: TeamMemberInput[]
  workers?: TemporaryWorker[]
}

/** One ticket from superagent's `board.json`; only the fields the board reads are named. */
export interface BoardTicket extends AliasTicketInput {
  summary?: string
}

/** The subset of superagent's `board.json` the aggregate consumes. */
export interface BoardPayload {
  tickets?: BoardTicket[]
}

/** One member row of the board's team area (the shared alias shape). */
export type BoardMemberRow = AliasMemberRow

/** The board payload the iframe fetches. */
export interface BoardData {
  schemaVersion: number
  generatedAt: string
  degraded: { source: string; since: string } | null
  main: TeamMemberInput
  members: BoardMemberRow[]
  tickets: BoardTicket[]
  workers: TemporaryWorker[]
  /** True while superagent's `/team` roster is unreachable; the members then come from a fallback roster. */
  teamDown?: boolean
}

/**
 * Merges the roster with superagent's board: each member keeps the roster's display name, role and live state, and
 * the newest active ticket fills its "current ticket" fields. A missing board degrades the ticket data but keeps the
 * roster visible; a missing roster is reported by `teamDown` and leaves the members empty.
 */
export function aggregate({ team, board, now, teamDown = false }: { team: TeamInput; board: BoardPayload | null; now: Date; teamDown?: boolean }): BoardData {
  const tickets = board?.tickets ?? []
  const degraded = board ? null : { source: 'superagent', since: now.toISOString() }
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    degraded,
    main: team.main,
    members: aliasMembers({ members: team.members ?? [], tickets, boardAvailable: board !== null }),
    tickets,
    workers: team.workers ?? [],
    ...(teamDown ? { teamDown: true } : {}),
  }
}
