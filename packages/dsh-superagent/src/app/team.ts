/** The runtime-managed team: a persisted roster of teammates, each running in its own DSH Session. */
import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import { WorkspaceUnknownSessionError } from '@deepseek-ai/dsh-workspace'
import { UserError } from '../core/errors.ts'
import type { Ticket } from '../core/model.ts'
import { ticketStage } from '../core/stage.ts'
import { KV } from '../kv.ts'
import type { Sessions } from './sessions.ts'
import type { Store } from './store.ts'

/** What the team reads of DSH's subagents: the direct children a Session had; an ended child has no Agent. */
interface SubagentRegistry {
  listChildren(parentSessionId: string): Promise<readonly { id: string }[]>
}

const subagentsOf = (context: Context): SubagentRegistry | undefined => context.get('subagents') as SubagentRegistry | undefined

/** One teammate the main Session manages at runtime: its brief and the DSH Session that runs it. */
export interface Teammate {
  /** Stable identity of the record, which survives renames; tools and the API also accept the current name. */
  readonly id: string
  /** Display name, which is also the Session's title; a person may use any script. */
  readonly name: string
  /** What this teammate is responsible for, in one sentence. */
  readonly role: string
  /** Extra standing instructions the teammate's system prompt includes, when set. */
  readonly brief?: string
  /** The DSH Session id that runs this teammate. */
  readonly sessionId: string
  readonly addedAt: string
  readonly updatedAt: string
}

/** A teammate as tools and the board read it: identity, responsibility, live state (running while its turn or a subagent runs) and last edit. */
export interface TeammateRow {
  id: string
  name: string
  role: string
  sessionId: string
  state: Agent['status'] | 'stored'
  tools: { count: number; hasReport: boolean }
  /** The newest ticket this teammate owns or runs, when one is attributable; ended tickets are marked. */
  ticketId?: string
  ticketTitle?: string
  ticketEnded?: true
  updatedAt: string
}

/** A report a teammate produced, persisted until the main Session's next turn starts. */
export interface TeamReport {
  id: string
  teammateId: string
  name: string
  sessionId: string
  state: 'progress' | 'ready' | 'blocked'
  summary: string
  question?: string
  at: string
}

/** The report queue operations `Sessions` calls when a teammate reports and when the main Session starts a turn. */
export interface TeamReports {
  queueReport(input: Omit<TeamReport, 'id' | 'at'>): TeamReport
  takePendingReports(): TeamReport[]
}

/** What `/team` reports about wake/report health. */
export interface TeamStatus {
  lastWakeAt: string | null
  pendingReports: number
  failedReplies: number
  /** Live self-created tickets and the worker Session each runs, in oldest-active order. */
  workers: { sessionId: string; ticketId: string; ticketTitle: string; startedAt: string }[]
}

/** The teammate facts a Session's system prompt needs, read on every model request so edits apply at the next turn. */
export interface TeammateBrief {
  id: string
  name: string
  role: string
  brief?: string
}
/**
 * Whether a self-created ticket still runs a temporary worker: it is open, an assignment is running or queued, and the ticket
 * is not waiting on a person. A worker that asked a question leaves the ticket waiting for that answer, which the board shows
 * as a ticket needing a person rather than a temporary worker card that stays until somebody answers.
 */
export function isWorkingSelfTicket(ticket: Ticket): boolean {
  return ticket.origin?.kind === 'self' && !ticket.ended
    && ticket.assignments.some(assignment => assignment.state === 'running' || assignment.state === 'pending')
    && ticketStage(ticket).stage === 'working'
}

/** What `Team` needs from the host: DSH services, the Store's key-value area, and Session lifecycle helpers. */
export interface TeamHost {
  readonly context: Context
  readonly store: Pick<Store, 'get' | 'set'> & Partial<Pick<Store, 'tickets'>>
  readonly sessions: Pick<Sessions, 'ensure' | 'adopt' | 'prompt'> & Partial<Pick<Sessions, 'wake'>>
  /** Count of reply effects stuck after repeated delivery failures, for `/team` visibility. */
  readonly failedReplies?: () => number
  /** Absolute working directory new teammate Sessions start in, shared with the main Session. */
  readonly stateDir: string
}

/**
 * Owns the deployment's team roster. A teammate is a record in `KV.team.roster` plus a DSH Session; adding, editing,
 * removing and messaging one are ordinary runtime operations that need no restart and no configuration edit. Edits to a
 * name, a responsibility or a brief reach the Session's next model request, whose system prompt re-reads the roster.
 */
export class Team {
  constructor(private readonly host: TeamHost) {}

  /** The roster rows in roster order; a teammate whose Session is not loaded reports `stored`. */
  async list(): Promise<TeammateRow[]> {
    const subagents = subagentsOf(this.host.context)
    return Promise.all(this.roster().map(teammate => this.row(teammate, subagents)))
  }

  /** The brief of the teammate a Session runs, or `undefined` when the Session is not a teammate. */
  brief(sessionId: string): TeammateBrief | undefined {
    const teammate = this.roster().find(item => item.sessionId === sessionId)
    return teammate && { id: teammate.id, name: teammate.name, role: teammate.role, ...(teammate.brief ? { brief: teammate.brief } : {}) }
  }

  /**
   * Adds a teammate and creates its Session, or adopts an existing Session by id. The record is stored before the
   * Session is created so its first system prompt already reads the brief; a failed creation restores the roster.
   */
  async add(input: { name: string; role: string; brief?: string; sessionId?: string }): Promise<TeammateRow> {
    const name = input.name.trim(), role = input.role.trim(), roster = this.roster()
    if (roster.some(teammate => teammate.name === name)) throw new UserError('teammateNameTaken', { name })
    const sessionId = input.sessionId?.trim() || `teammate-${randomBytes(6).toString('hex')}`
    if (roster.some(teammate => teammate.sessionId === sessionId)) throw new UserError('teammateNotAdoptable', { sessionId })
    const now = new Date().toISOString()
    const teammate: Teammate = { id: `t-${randomBytes(4).toString('hex')}`, name, role,
      ...(input.brief?.trim() ? { brief: input.brief.trim() } : {}), sessionId, addedAt: now, updatedAt: now }
    // Store first: the Session's decoration reads this roster entry when the Session is created or adopted.
    this.save([...roster, teammate])
    try {
      if (input.sessionId?.trim()) await this.host.sessions.adopt(sessionId, name)
      else await this.host.sessions.ensure(sessionId, this.host.stateDir, name, 'teammate')
    } catch (error) {
      this.save(roster)
      if (input.sessionId?.trim() && (error as { code?: unknown }).code === 'session/not-found') {
        throw new UserError('teammateNotAdoptable', { sessionId })
      }
      throw error
    }
    return this.row(teammate, subagentsOf(this.host.context))
  }

  /** Changes a teammate's name, responsibility or brief; a new name also becomes its Session's title. An empty brief clears it. */
  async update(teammate: string, patch: { name?: string; role?: string; brief?: string }): Promise<TeammateRow> {
    const roster = this.roster(), current = this.find(teammate)
    const name = patch.name?.trim() ?? current.name
    if (patch.name !== undefined && roster.some(item => item.id !== current.id && item.name === name)) {
      throw new UserError('teammateNameTaken', { name })
    }
    const role = patch.role?.trim() ?? current.role
    const brief = patch.brief === undefined ? current.brief : patch.brief.trim() || undefined
    const next: Teammate = { ...current, name, role, ...(brief ? { brief } : {}), updatedAt: new Date().toISOString() }
    if (!brief) delete (next as { brief?: string }).brief
    if (name !== current.name) await this.host.context.sessionController.rename({ sessionId: current.sessionId as SessionId, title: name })
    this.save(roster.map(item => item.id === current.id ? next : item))
    return this.row(next, subagentsOf(this.host.context))
  }

  /**
   * Removes a teammate and archives its Session, stopping the work it still runs; the roster drops it either way, and a
   * Session that is already gone counts as archived. The durable archive set hides the Session from grouping surfaces.
   */
  async remove(teammate: string): Promise<{ id: string; name: string; sessionId: string; archived: boolean }> {
    const current = this.find(teammate), sessionId = current.sessionId as SessionId
    let archived = this.host.context.workspaceRegistry.archivedSessionIds.includes(sessionId)
    if (!archived) {
      try {
        await this.host.context.workspaceRegistry.archiveSession(sessionId, { stopActivity: true })
        archived = true
      } catch (error) {
        if (!(error instanceof WorkspaceUnknownSessionError)) throw error
      }
    }
    this.save(this.roster().filter(item => item.id !== current.id))
    return { id: current.id, name: current.name, sessionId: current.sessionId, archived }
  }

  /** Sends one message into a teammate's Session: queued for its next turn, or steered into the current one. */
  async message(teammate: string, text: string, mode: 'queue' | 'steer'): Promise<{ id: string; sessionId: string; mode: 'queue' | 'steer' }> {
    const current = this.find(teammate)
    try {
      // A stored Session has no live Agent: resolve/resume it first so the follow-up below cannot silently no-op.
      await this.host.sessions.wake?.(current.sessionId)
      await this.host.sessions.prompt(current.sessionId, `team-message:${randomBytes(8).toString('hex')}`, text, mode)
      this.host.store.set(KV.team.lastWakeAt, new Date().toISOString())
    } catch (error) {
      throw new Error(`Could not wake teammate ${current.name} (${current.sessionId}): ${error instanceof Error ? error.message : String(error)}`)
    }
    return { id: current.id, sessionId: current.sessionId, mode }
  }

  /** Wake/report health for `/team`: the latest successful wake and how many reports are waiting for the main turn. */
  status(): TeamStatus {
    return { lastWakeAt: this.host.store.get(KV.team.lastWakeAt) ?? null, pendingReports: this.pendingReports().length,
      failedReplies: this.host.failedReplies?.() ?? 0, workers: this.temporaryWorkers() }
  }

  /**
   * The self-created tickets still being worked, plus the deterministic worker Session each runs. A ticket whose worker asked
   * a person a question is not being worked: the board lists it among the tickets waiting for a person, and hanging a
   * temporary worker card under the lead for it would keep that card there until somebody answers. A ticket dispatched to a
   * teammate is that teammate's, shown on its card, not a temporary worker of the lead.
   */
  private temporaryWorkers(): TeamStatus['workers'] {
    return this.activeTickets()
      .filter(ticket => ticket.owner === undefined && isWorkingSelfTicket(ticket))
      .map(ticket => {
        const assignment = ticket.assignments.filter(item => item.state === 'running' || item.state === 'pending')
          .sort((a, b) => (a.startedAt ?? a.createdAt).localeCompare(b.startedAt ?? b.createdAt))[0]
        return { sessionId: `worker-${ticket.id}`, ticketId: ticket.id, ticketTitle: ticket.title,
          startedAt: assignment?.startedAt ?? assignment?.createdAt ?? ticket.createdAt }
      })
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.ticketId.localeCompare(b.ticketId))
  }

  /** Persists one report before it is shown to the main Session; the report id makes redelivery idempotent. */
  queueReport(input: Omit<TeamReport, 'id' | 'at'>): TeamReport {
    const report: TeamReport = { ...input, id: `r-${randomBytes(6).toString('hex')}`, at: new Date().toISOString() }
    this.host.store.set(KV.team.reports, [...this.pendingReports(), report])
    return report
  }

  /** Removes and returns every queued report; the caller injects them into the main Session's turn. */
  takePendingReports(): TeamReport[] {
    const reports = this.pendingReports()
    if (reports.length > 0) this.host.store.set(KV.team.reports, [])
    return reports
  }

  private pendingReports(): TeamReport[] { return this.host.store.get(KV.team.reports) ?? [] }

  private roster(): Teammate[] { return this.host.store.get(KV.team.roster) ?? [] }
  private save(roster: Teammate[]): void { this.host.store.set(KV.team.roster, roster) }
  /** Finds a teammate by id or by its current name. */
  private find(teammate: string): Teammate {
    const found = this.roster().find(item => item.id === teammate || item.name === teammate)
    if (!found) throw new UserError('unknownTeammate', { teammate })
    return found
  }
  private async row(teammate: Teammate, subagents = subagentsOf(this.host.context)): Promise<TeammateRow> {
    const agent = this.host.context.agents.get(teammate.sessionId as SessionId)
    const state: TeammateRow['state'] = agent?.status === 'running' || (agent !== undefined && await this.childrenWork(subagents, teammate.sessionId))
      ? 'running'
      : agent?.status ?? 'stored'
    const tools = agent === undefined ? { count: 0, hasReport: false } : this.toolsOf(agent)
    const ticket = this.ticketOf(teammate)
    return { id: teammate.id, name: teammate.name, role: teammate.role, sessionId: teammate.sessionId,
      state, tools, ...(ticket ? { ticketId: ticket.id, ticketTitle: ticket.title, ...(ticket.ended ? { ticketEnded: true as const } : {}) } : {}),
      updatedAt: teammate.updatedAt }
  }
  /**
   * The teammate's live ticket first, else its most recently attributable ticket. Assignments carry no member field,
   * so only an explicit `owner` or a `worker-*` Session is accepted; an ended ticket is shown weakly, never guessed.
   */
  private ticketOf(teammate: Teammate): Ticket | undefined {
    const workerTicket = teammate.sessionId.startsWith('worker-') ? teammate.sessionId.slice('worker-'.length) : undefined
    const owned = (this.host.store.tickets?.list() ?? []).filter(ticket =>
      ticket.id === workerTicket || [teammate.id, teammate.name, teammate.sessionId]
        .includes((ticket as Ticket & { owner?: string }).owner ?? ''))
    return owned.filter(ticket => !ticket.ended && ticket.assignments.some(assignment => assignment.state === 'running' || assignment.state === 'pending'))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
      ?? owned.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  }
  /** Live tickets with a running or pending assignment, the one shared source for member and temporary-worker lookup. */
  private activeTickets(): Ticket[] {
    return (this.host.store.tickets?.list() ?? [])
      .filter(ticket => !ticket.ended && ticket.assignments.some(assignment => assignment.state === 'running' || assignment.state === 'pending'))
  }
  /** The live tool surface of a teammate, including the report tool whose disappearance users can spot at a glance. */
  private toolsOf(agent: Agent): { count: number; hasReport: boolean } {
    try {
      const tools = agent.ctx?.tools
      if (!tools) return { count: 0, hasReport: false }
      const schemas = tools.schemas(scopeOf(agent.ctx))
      return { count: schemas.length, hasReport: schemas.some(tool => tool.name === 'orchestrator_team_report') }
    } catch {
      return { count: 0, hasReport: false }
    }
  }
  /**
   * Whether any direct child of the Session still has an Agent: DSH's catalog lists the children a Session had, and one
   * that settled has no Agent. A Session that is not loaded runs no subagent, matching the Executor's stop rule.
   */
  private async childrenWork(subagents: SubagentRegistry | undefined, sessionId: string): Promise<boolean> {
    if (subagents === undefined) return false
    try {
      const children = await subagents.listChildren(sessionId)
      return children.some(child => this.host.context.agents.get(child.id as SessionId) !== undefined)
    } catch {
      return false
    }
  }
}
