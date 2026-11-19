/** Isomorphic alias layer: the host aggregate builds member rows from superagent's roster. */

/** One roster member as the alias layer reads it (superagent's `/team` row). */
export interface AliasMemberInput {
  id: string
  name: string
  role: string
  /** Durable lifecycle phase when the caller has one: provisioning, active or failed. */
  phase?: string
  /** Live state from the roster: working, idle, stored or unknown. */
  state?: string
  /** The DSH Session that runs this teammate; the member menu opens it. */
  sessionId?: string
  ticketId?: string
  ticketTitle?: string
  ticketEnded?: true
  /** Running direct child agents, when the board host can read them. */
  subagents?: { running: number; items: { id: string; label: string }[] }
}

/** One ticket as the alias layer reads it. */
export interface AliasTicketInput {
  id: string
  title: string
  state: string
  ownerMemberId?: string | null
  updatedAt: string
}

/** One board member row; the browser iframe renders these directly. */
export interface AliasMemberRow {
  id: string
  name: string
  role: string
  phase?: string
  state: string
  displayName: string
  ticketId: string | null
  ticketTitle: string | null
  lastActivityAt: string | null
  sessionId?: string
  subagents?: { running: number; items: { id: string; label: string }[] }
}

/** Ticket states that mean their owner is currently working on the board. */
export const ACTIVE_TICKET_STATES = new Set(['evaluating', 'executing', 'review'])

/** The ids a ticket's `ownerMemberId` may carry for one roster member. */
const ownerKeys = (member: Pick<AliasMemberInput, 'id' | 'name' | 'sessionId'>): string[] =>
  [member.id, member.name, member.sessionId].filter((key): key is string => typeof key === 'string' && key !== '')

/** One member's newest active ticket, or undefined while it has none. */
export const newestActiveTicket = (tickets: readonly AliasTicketInput[], member: Pick<AliasMemberInput, 'id' | 'name' | 'sessionId'>): AliasTicketInput | undefined => {
  const keys = new Set(ownerKeys(member))
  return tickets
    .filter(ticket => typeof ticket.ownerMemberId === 'string' && keys.has(ticket.ownerMemberId) && ACTIVE_TICKET_STATES.has(ticket.state))
    .reduce<AliasTicketInput | undefined>((newest, ticket) => !newest || ticket.updatedAt > newest.updatedAt ? ticket : newest, undefined)
}

/** The board's member states; superagent's roster says `running` for the state the board calls `working`. */
const boardState = (state: string): string => state === 'running' ? 'working' : state

/**
 * Builds one member row. The roster owns the display name, the role and the live state; the newest active ticket
 * only fills the "当前工单" fields, and a member without one reads `idle` when the roster gave no state.
 */
export const aliasMember = (member: AliasMemberInput, tickets: readonly AliasTicketInput[], boardAvailable = true): AliasMemberRow => {
  const latest = newestActiveTicket(tickets, member)
  const state = member.state !== undefined && member.state !== ''
    ? boardState(member.state)
    : latest ? 'working' : boardAvailable ? 'idle' : 'unknown'
  const row: AliasMemberRow = {
    id: member.id,
    name: member.name,
    role: member.role,
    state,
    displayName: member.name.trim() === '' ? member.id : member.name,
    ticketId: latest?.id ?? null,
    ticketTitle: latest?.title ?? null,
    lastActivityAt: latest?.updatedAt ?? null,
  }
  return {
    ...row,
    ...(member.phase === undefined ? {} : { phase: member.phase }),
    ...(member.sessionId === undefined || member.sessionId === '' ? {} : { sessionId: member.sessionId }),
    ...(member.ticketId === undefined ? {} : { ticketId: member.ticketId }),
    ...(member.ticketTitle === undefined ? {} : { ticketTitle: member.ticketTitle }),
    ...(member.ticketEnded === undefined ? {} : { ticketEnded: member.ticketEnded }),
    ...(member.subagents === undefined ? {} : { subagents: member.subagents }),
  }
}

/** Builds every member row; the host aggregate and the browser iframe share this exact rule. */
export const aliasMembers = ({ members, tickets, boardAvailable = true }: {
  members: readonly AliasMemberInput[]
  tickets: readonly AliasTicketInput[]
  boardAvailable?: boolean
}): AliasMemberRow[] => members.map(member => aliasMember(member, tickets, boardAvailable))
