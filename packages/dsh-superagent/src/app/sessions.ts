/** Lifecycle, prompt/tool/skill decoration, message delivery, and budget retry tracking for orchestrator and worker DSH sessions. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { scopeOf, scopeParentOf } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import { z } from 'zod'
import { key, liveTicket, UserError, type Ticket } from '../core/index.ts'
import { mandateInstructions, ticketOfSession } from '../executor/dsh.ts'
import type { HealthEntry } from '../infra/health.ts'
import { AgentDelivery, messageId } from './delivery.ts'
import type { Effects } from './effects.ts'
import type { Variable } from './execution-environment.ts'
import { RetryHealth, type RetryHealthEvent } from './retry-health.ts'
import { initializeRoleModel } from './role-models.ts'
import { bundledSkills } from './skill-files.ts'
import { SKILL_PREFIX, type PromptVersion, type Prompts } from './prompts.ts'
import type { Store } from './store.ts'
import type { TeamReports, TeammateBrief } from './team.ts'
import { KV } from '../kv.ts'
import type { RegisterTool, Tool } from './tools/tool.ts'

/** Host dependencies used by `Sessions`. */
export interface SessionsHost {
  /** DSH Cordis context: sessions, agents, persistence, and their events. */
  readonly context: Context
  readonly store: Pick<Store, 'tickets' | 'settings' | 'get' | 'set' | 'keys'>
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'compose' | 'skills'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle' | 'idle' | 'pending'>
  /** The `models` health entry, which reports managed sessions waiting on a model-budget retry. */
  readonly health: HealthEntry
  readonly masterId: string
  readonly lifetime: AbortSignal
  closing(): boolean
  /** Execution environment variables for `ticket`, rendered into its worker's system prompt. */
  environment(ticket: Ticket): Variable[]
  /** Tools to register on the main Session (`ticket === undefined`) or on `ticket`'s worker Session. */
  tools(agent: Agent, ticket?: Ticket): Tool[]
  /** The brief of the team teammate a Session runs, when `Team` manages it; read on every request and decoration. */
  teammate?(sessionId: string): TeammateBrief | undefined
  /** The durable teammate report queue, when the runtime manages a team. */
  team?(): TeamReports
}

/**
 * What Sessions registered for an agent it decorated: the releases of its prompt section, tools and skill scope, the scope
 * its skills are registered in, and the skills of one prompt revision; for a worker's subagent, only its tool limits.
 */
interface SessionBinding { disposers: (() => void)[]; scope?: Context; skills?: { revision: number; dispose: () => void }; subagent?: true
  /** This Session is a team teammate, so its turns are watched for a report the main Session never received. */
  teammate?: true }

/** The agent presets Executor Sessions and the main Session are created with, which the bundle's patch defines. */
export const WORKER_PRESET = 'dsh-superagent-worker', ROUTER_PRESET = 'dsh-superagent-router'
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** DSH's agent preset registry selected `agentPreset` for a Session. */
    'agent-preset/selected'(sessionId: string, agentPreset: string): void
  }
}
/**
 * The DSH tools an Executor Session works with: files, search, the shell and its jobs, the web, skills, its todo list and
 * subagents. It gets no other tool the profile has, whenever it was registered: none that asks or shows a person something,
 * changes the profile, schedules work or starts goals outside the worker slots, the pause and a person's hold, starts or
 * messages other Sessions, or edits documents.
 */
const WORK_TOOLS = ['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash', 'pwsh', 'job_output', 'job_list', 'job_kill', 'web_search',
  'web_fetch', 'skill', 'todo_write', 'subagent', 'list_subagent_models', 'send_message', 'list_agents', 'interrupt_agent']
/**
 * The tools whose call means a teammate turn produced something a person could use: a file written or edited, or a command
 * run. A turn of reads asks nothing of the main Session, so it needs no report.
 */
const PRODUCING_TOOLS = ['write', 'edit', 'bash', 'pwsh']
/** One teammate turn as the report guard sees it, kept so a turn that ends without a report still reaches the main Session. */
export interface TeammateTurn {
  turn: number
  /** The turn wrote, edited or ran something, so its conclusion belongs in the main Session. */
  worked: boolean
  /** The turn called `orchestrator_team_report`, which is what reaches the main Session by itself. */
  reported: boolean
  /** The producing tools the turn called, named once each. */
  tools: string[]
  /** The turn's last assistant text, clipped, so a fallback report says what it concluded. */
  lastText: string
}
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
/**
 * Folds one session event into the teammate turn being tracked: a turn starts tracking, a producing tool call marks the turn
 * as worked, a report marks it as told, and the last assistant text is kept for a fallback report. Events of no interest, and
 * events after a turn ended, leave the turn unchanged.
 */
export function foldTeammateTurn(turn: TeammateTurn | undefined, event: RetryHealthEvent): TeammateTurn | undefined {
  const data = asRecord(event.data)
  if (event.type === 'turn/start' && typeof data?.turn === 'number') {
    return { turn: data.turn, worked: false, reported: false, tools: [], lastText: '' }
  }
  if (!turn || event.type === 'turn/end') return turn
  if (event.type === 'tool/call') {
    const name = typeof data?.name === 'string' ? data.name : ''
    if (!name) return turn
    if (name === 'orchestrator_team_report') return { ...turn, reported: true }
    if (!PRODUCING_TOOLS.includes(name) || turn.tools.includes(name)) return turn
    return { ...turn, worked: true, tools: [...turn.tools, name] }
  }
  if (event.type === 'assistant/message') {
    const message = asRecord(data?.message)
    const content = Array.isArray(message?.content) ? message.content : []
    const text = content.map(part => { const item = asRecord(part); return item?.type === 'text' ? String(item.text ?? '') : '' }).join('').trim()
    return text ? { ...turn, lastText: text.slice(-400) } : turn
  }
  return turn
}
/**
 * The shell tool an agent can use. DSH registers `pwsh` on Windows and `bash` elsewhere, and `tools.restrict` refuses a
 * name no tool registers, so prefer whichever one the agent actually inherits and fall back to the platform's own.
 */
function shellToolOf(agent: Agent): string {
  const parent = scopeParentOf(agent)
  const registered = (name: string): boolean => Boolean(agent.ctx.tools.get(name, parent))
  if (registered('pwsh')) return 'pwsh'
  if (registered('bash')) return 'bash'
  return process.platform === 'win32' ? 'pwsh' : 'bash'
}
/** What the main Session is told when it would wait: what it waits for comes to it, and a waiting step holds back the next. */
const NO_WAIT = 'Reports, follow_up notices, new candidates and a background job\'s end with its output arrive by themselves as messages; '
  + 'end the turn instead of waiting for them.'
/**
 * The fixed four-part shape of a teammate's report to the main Session: its conclusion, the evidence that backs it, what
 * is unfinished or blocked, and the decision the main Session or the user must make. The teammate system prompt and the
 * report tool's description both end with it, so the model reads the same receipt where it is told to report and where it
 * calls the tool; the two cannot drift apart.
 */
export const TEAM_REPORT_TEMPLATE = '1. 结论：一句话说清做成了什么，或当前状态。'
  + '\n2. 证据：能验证结论的命令、数字或文件路径。'
  + '\n3. 未完成/阻塞：还剩什么、卡在哪里；没有就写“无”。'
  + '\n4. 需要拍板：需要主会话或用户决定的事；没有就写“无”。'
/** The report tool's description, exported so a test can assert the template above reaches the tool surface. */
export const TEAM_REPORT_DESCRIPTION = 'Report progress or a result to the dsh-superagent main Session, which decides what to do with it. '
  + 'The summary follows this fixed four-part template, in order:\n' + TEAM_REPORT_TEMPLATE
/** The tool a teammate Session reports to the main Session with; its flattest description keeps the surface small. */
const TEAM_REPORT = {
  description: TEAM_REPORT_DESCRIPTION,
  schema: z.object({
    state: z.enum(['progress', 'ready', 'blocked']).describe('progress while working, ready for a finished result, blocked when a decision is needed.'),
    summary: z.string().trim().min(1).max(2000).describe('What happened, what was produced, or what blocks it.'),
    question: z.string().trim().min(1).max(500).optional().describe('When blocked: the one decision needed.'),
  }).strict(),
  /** Pre-built JSON Schema: Zod's toJSONSchema output can carry non-lossless fields that make DSH drop the tool. */
  parameters: {
    type: 'object',
    properties: {
      state: { type: 'string', enum: ['progress', 'ready', 'blocked'], description: 'progress while working, ready for a finished result, blocked when a decision is needed.' },
      summary: { type: 'string', minLength: 1, maxLength: 2000, description: 'What happened, what was produced, or what blocks it.' },
      question: { type: 'string', minLength: 1, maxLength: 500, description: 'When blocked: the one decision needed.' },
    },
    required: ['state', 'summary'],
    additionalProperties: false,
  },
}
/** What a teammate is told when a turn produced work but ended without the report the main Session hears through. */
const TEAM_REPORT_REMINDER = 'This turn produced work but ended without orchestrator_team_report, so the main Session never saw '
  + 'its result. Call orchestrator_team_report now: state progress, or ready when the work is finished, with a short summary of '
  + 'this turn (files changed, commands run, what is left). Do not redo the work.'
/** The system prompt of a teammate Session: who it is, what it is responsible for, and how it reports back. */
export function teammateText(brief: TeammateBrief): string {
  return `[dsh-superagent teammate ${brief.name}]\nYou are ${brief.name}, a teammate of the dsh-superagent main Session, working in the shared workspace.`
    + `\nYour responsibility: ${brief.role}`
    + (brief.brief ? `\n${brief.brief}` : '')
    + '\nPrefer subagents for work that can be split or run in parallel instead of grinding through it serially; verify their results yourself before adopting them. Do not hand the whole document close-out to a subagent; process documents yourself.'
    + '\nReport progress, a ready result or a blocked decision to the main Session with orchestrator_team_report; keep reports short.'
    + `\nEvery orchestrator_team_report summary follows this fixed four-part template, in order:\n${TEAM_REPORT_TEMPLATE}`
}
/**
 * Builds a teammate's prompt section from a roster lookup. When the roster no longer names the Session the section is empty,
 * and the first such composition reports it once: the 2026-11-11 logs held four system messages with the whole teammate
 * section missing and nothing saying why, so the next occurrence names the Session instead of staying unexplained. A lookup
 * that finds the teammate again re-arms the report.
 */
export function teammateSection(brief: () => TeammateBrief | undefined, warn: () => void): () => string {
  let missing = false
  return () => {
    const current = brief()
    if (current) { missing = false; return teammateText(current) }
    if (!missing) { missing = true; warn() }
    return ''
  }
}
/** What a main Session under `standard` is told when its command would wait the shell's default. */
const DEFAULT_WAIT = 'This shell waits up to 60 seconds by default: pass timeoutMs of at most 30000, or run_in_background, '
  + 'as a waiting step holds back new candidates.'
/** `sleep` at a command position: the start, after ; & | ( { ! ` or a newline, or after a keyword or a command that runs it. */
const SLEEP = /(?:^|[;&|({!`\n]|\b(?:do|then|else|elif|if|while|until|time|exec|nohup|command|env)\s)\s*(?:\S*\/)?sleep\b/
/**
 * The main Session's guard: it refuses a bash command that runs sleep or asks to hold the step longer than 30 seconds, and a
 * job wait longer than 5 seconds. Under `standard`, as a main Session created before the router preset runs, the shell holds
 * a command 60 seconds and a job wait lasts 30 seconds by default, so a command needs a timeout or the background, and a
 * job wait its timeout; the router preset ends both after 5 seconds.
 */
function noWait({ name, arguments: input }: { name: string; arguments: unknown }, routed: () => boolean, shell: string): string | undefined {
  const args = (input ?? {}) as { command?: unknown; timeoutMs?: unknown; run_in_background?: unknown; wait?: unknown; timeout_ms?: unknown }
  if (name === shell) {
    const sleeps = typeof args.command === 'string' && SLEEP.test(args.command)
    if (sleeps || typeof args.timeoutMs === 'number' && args.timeoutMs > 30_000) return NO_WAIT
    if (args.timeoutMs === undefined && args.run_in_background !== true && !routed()) return DEFAULT_WAIT
  }
  if (name === 'job_output' && args.wait === true && (typeof args.timeout_ms === 'number' ? args.timeout_ms > 5_000 : !routed())) return NO_WAIT
  return undefined
}

/**
 * Creates and decorates orchestrator and worker DSH `Agent` sessions with role models, system prompt sections from `Prompts`, runtime skills, and restricted tool sets.
 * `Runtime`, `DshExecutor`, `MasterAssessor`, `Settings`, and management routes/tools use it to ensure sessions, deliver deduplicated messages via `AgentDelivery`, and process ordered `relay` and `notice` effects.
 * Feeds session events into `RetryHealth` to report model budget waits on the `models` `HealthEntry`, and durably records which prompt revisions each session has worked under in `Store` (`KV.sessions.prompts`) to authorize prompt version reads.
 */
export class Sessions {
  private readonly agentDelivery: AgentDelivery
  /** Decorated agents mapped to their registered disposers and skill scope until the agent is disposed or `Sessions.dispose()` runs. */
  private readonly bindings = new Map<Agent, SessionBinding>()
  private readonly retryHealth = new RetryHealth()
  /** The teammate turn each Session is in, and the turns whose reminder went out, so one turn is reminded at most once. */
  private readonly teammateTurns = new Map<string, TeammateTurn>()
  private readonly remindedTurns = new Map<string, Set<number>>()
  private readonly ctx: Context
  /** Registers ordered `relay` and `notice` effect handlers that deliver to the main Session. */
  constructor(private readonly host: SessionsHost) {
    this.ctx = host.context
    this.agentDelivery = new AgentDelivery(host.context)
    // Deliver relays and notices to the main Session in the order they were queued.
    host.effects.handle('relay', ({ text }, requestId) => this.prompt(host.masterId, requestId, text, 'steer'), { ordered: true })
    host.effects.handle('notice', ({ value, summary }, name) => this.inject(name, value, summary), { ordered: true })
  }
  /** Subscribes to host agent and session events so newly created sessions are decorated and model-budget retries are reflected in health. Call once at startup. */
  install(): void {
    const ctx = this.ctx
    ctx.on('agent/disposed', ({ agent }) => {
      this.release(agent)
      this.retryHealth.clear(agent.id); this.updateModelHealth()
    })
    ctx.on('session/event', (session, event) => {
      const agent = ctx.agents.get(session.id)
      const binding = agent && agent.session === session ? this.bindings.get(agent) : undefined
      if (!agent || !binding || binding.subagent) return
      this.retryHealth.observe(agent.id, event)
      this.updateModelHealth()
      // A teammate's turn is tracked here, so one that ends without a report can still be told to the main Session.
      if (binding.teammate) {
        const turn = foldTeammateTurn(this.teammateTurns.get(agent.id), event as RetryHealthEvent)
        if (turn) this.teammateTurns.set(agent.id, turn)
      }
    })
    ctx.on('agent/created', async ({ agent }) => { await this.decorate(agent); return undefined })
    // Repair a teammate whose report tool was unregistered by an earlier lifecycle before it takes another step.
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      if (agent.id !== this.host.masterId && this.host.teammate?.(agent.id) && !this.hasTeammateReport(agent)) {
        this.ctx.logger.warn('dsh-superagent teammate %s lost orchestrator_team_report; re-decorating before its step', agent.id)
        await this.decorate(agent)
      }
      const decision = await next()
      if (agent.id !== this.host.masterId || decision.kind !== 'enter') return decision
      const reports = this.host.team?.().takePendingReports() ?? []
      if (reports.length === 0) return decision
      const text = '[dsh-superagent] Teammate reports queued while this Session was away:\n\n'
        + reports.map(report => `team-report ${report.id} · ${report.name} · ${report.state}\n${report.summary}`
          + (report.question ? `\nQuestion: ${report.question}` : '')).join('\n\n')
      const message = freezeMessage({ id: MessageId(`dsh-superagent:team-reports:${reports[0]!.id}:${reports.length}`),
        role: 'user', content: [{ type: 'text', text }], source: { kind: 'dsh-superagent', form: 'relay' } })
      return { ...decision, messages: [...decision.messages, message] }
    })
    // Opening a Session in DSH's Web UI before its first turn may select the default preset for it: select ours again. After
    // its first turn DSH refuses any selection, which leaves it as it is.
    ctx.inject(['agentPresets'], child => {
      child.on('agent-preset/selected', (sessionId, preset) => {
        const ticketId = ticketOfSession(sessionId), agent = ctx.agents.get(sessionId as SessionId)
        const ours = sessionId === this.host.masterId ? ROUTER_PRESET : ticketId && this.host.store.tickets.get(ticketId) ? WORKER_PRESET : undefined
        if (!ours || preset === ours || !agent) return
        const presets = child.get('agentPresets') as { select(agent: Agent, preset: string): Promise<string> }
        presets.select(agent, ours).catch(() => {})
      })
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle' && !this.host.closing()) { this.retryHealth.clear(agent.id); this.updateModelHealth() }
      if (status === 'idle') this.settleTeammateTurn(agent)
    })
  }
  /** Resolves or creates session `id` in workspace `cwd`, initializes its role model, decorates it with prompts/skills/tools, sets `danger-full-access` permissions, and renames it to `title`. */
  async ensure(id: string, cwd: string, title: string, role: 'orchestrator' | 'worker' | 'teammate'): Promise<Agent> {
    const ctx = this.ctx
    let result = await ctx.sessionController.resolveAgent(id as SessionId)
    if ('error' in result && result.error.code === 'session/not-found') {
      const workspace = await ctx.workspaceRegistry.create(cwd)
      // A Session keeps the preset it was created with, one of the bundle's own (cordis.patch.yml).
      await ctx.sessionController.create({ sessionId: id as SessionId, workspaceId: workspace.id,
        agentPreset: role === 'orchestrator' ? ROUTER_PRESET : WORKER_PRESET })
      result = await ctx.sessionController.resolveAgent(id as SessionId)
    }
    if ('error' in result) throw result.error
    const settings = this.host.store.settings()
    await initializeRoleModel(ctx, result.agent, role === 'orchestrator' ? settings.eval.model : settings.executor.model)
    await this.decorate(result.agent)
    ctx.permissionPresets.set(result.agent.session, 'danger-full-access')
    await ctx.sessionController.rename({ sessionId: id as SessionId, title })
    return result.agent
  }
  /** Adopts an existing Session as a teammate: decorates it with its brief and report tool, grants full access and renames it, creating nothing. */
  async adopt(id: string, title: string): Promise<Agent> {
    if (id === this.host.masterId || ticketOfSession(id) !== undefined) throw new UserError('teammateNotAdoptable', { sessionId: id })
    const result = await this.ctx.sessionController.resolveAgent(id as SessionId)
    if ('error' in result) throw result.error
    await this.decorate(result.agent)
    this.ctx.permissionPresets.set(result.agent.session, 'danger-full-access')
    await this.ctx.sessionController.rename({ sessionId: id as SessionId, title })
    return result.agent
  }
  /** Returns whether `sessionId` already holds the message delivered under `requestId`, or `false` if the session does not exist. */
  async holds(sessionId: string, requestId: string): Promise<boolean> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    return !('error' in result) && await this.agentDelivery.holds(result.agent, key(requestId))
  }
  /** Resolves and resumes a stored Session through DSH's public session controller, requiring a live Agent before messaging it. */
  async wake(sessionId: string): Promise<Agent> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    if ('error' in result) throw new Error(`DSH could not load Session ${sessionId}: ${result.error.code}`)
    const live = this.ctx.agents.get(sessionId as SessionId)
    if (live === undefined) throw new Error(`DSH loaded Session ${sessionId} but no live Agent is attached`)
    // Resuming a stored Session does not guarantee another agent/created decoration in every DSH lifecycle;
    // decorate here too so a teammate never resumes with only the preset's tools.
    await this.decorate(live)
    return live
  }

  /** Deliver a message once per request id: to the next turn, the current one, or `inject`ed with its label without waking the agent. */
  async prompt(sessionId: string, requestId: string, text: string, mode: 'queue' | 'steer' | { inject: string }, authorize?: () => void,
    accepted?: () => void): Promise<void> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    if ('error' in result) throw result.error
    await this.agentDelivery.send(result.agent, key(requestId), text, mode, this.host.lifetime, authorize, accepted)
  }
  /** The id of the message `prompt` delivers under `requestId`, which DSH's inbox events name it by. */
  promptedId(requestId: string): MessageId { return messageId(key(requestId)) }
  /** Enqueues a steering relay to the main Session; relays are durable and retried by `Effects` until delivered, at most once per `requestId`. */
  relay(requestId: string, text: string): void { this.host.effects.enqueue('relay', requestId, { text }) }
  /** Enqueues a durable background notice for injection into the main Session; a new notice with the same `name` replaces a still-waiting notice of that `name`. */
  notify(name: string, value: Record<string, unknown>, summary: string): void { this.host.effects.enqueue('notice', name, { value, summary }) }
  /** Waits for currently runnable `notice` effects to settle and returns `'injected'` if notice `name` has reached the main Session or `'pending'` if it is still queued. */
  async delivery(name: string): Promise<'injected' | 'pending'> {
    await this.host.effects.idle('notice')
    return this.host.effects.pending('notice', name) ? 'pending' : 'injected'
  }
  /** Injects a notice into the main Session without waking it; no-op if the main Session does not exist yet. */
  private async inject(name: string, value: Record<string, unknown>, summary: string): Promise<void> {
    const resolved = await this.ctx.sessionController.resolveAgent(this.host.masterId as SessionId)
    if ('error' in resolved) return
    // Deduplicate by notice name and payload hash so retries are idempotent while updated payloads still deliver.
    const text = JSON.stringify(value)
    await this.agentDelivery.send(resolved.agent, `notice:${name}:${key(text)}`, text, { inject: summary }, this.host.lifetime)
  }
  /** Returns the current prompt revision, the active prompt revision of each loaded Session, and whether the main Session still has a pending `'prompts'` notice. */
  status() {
    const { store, prompts, effects } = this.host
    const sessions = store.keys(KV.sessions.prompts).flatMap(name => {
      const sessionId = name.slice(KV.sessions.prompts.prefix.length), revision = store.get(name)?.at(-1)
      return this.ctx.agents.get(sessionId as SessionId) && revision !== undefined ? [{ sessionId, revision }] : []
    })
    return { revision: prompts.current().revision, sessions, notificationPending: effects.pending('notice', 'prompts') }
  }
  /** Returns the prompt version a Session runs under (the one bound on its latest model request, or the current version). */
  promptVersion(sessionId: string): PromptVersion {
    const revision = this.host.store.get(KV.sessions.prompts(sessionId))?.at(-1)
    return revision === undefined ? this.host.prompts.current() : this.host.prompts.version(revision)
  }
  /** Whether a Session is authorized to read `revision` (its active revision or any revision it previously ran under). */
  mayRead(sessionId: string, revision: number): boolean {
    return revision === this.promptVersion(sessionId).revision || (this.host.store.get(KV.sessions.prompts(sessionId)) ?? []).includes(revision)
  }
  /** Returns a tool registrar for `agent` that renders tool output as JSON text and attaches `output.image` as an image when present. */
  private registerTool(agent: Agent, binding: SessionBinding): RegisterTool {
    return (name, description, schema, execute) => {
      binding.disposers.push(agent.ctx.tools.register({ name, description, parameters: z.toJSONSchema(schema),
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => {
          const text = { type: 'text' as const, text: JSON.stringify(value) }
          const image = value && typeof value === 'object' && 'image' in value ? (value as { image: never }).image : undefined
          return image ? [text, { type: 'image' as const, attachment: image }] : [text]
        } },
        execute: (args, execution) => execute(schema.parse(args), execution.signal) }))
    }
  }
  /** Returns `sessionId`'s active model-budget retry state (`{ model_retry }`) for status listings, or `{}` when not waiting on one. */
  modelRetry(sessionId: string | undefined) {
    const retry = sessionId ? this.retryHealth.get(sessionId) : undefined
    return retry ? { model_retry: retry } : {}
  }
  private updateModelHealth(): void {
    const retries = this.retryHealth.list()
    this.host.health.set(retries.length
      ? { state: 'error', detail: retries.slice(0, 5).map(item => `${item.sessionId}: ${item.provider} is over its model budget; retried ${item.attempts} times, waiting since ${item.since}; the model and retry policy are unchanged`).join('; ') + (retries.length > 5 ? `; ${retries.length - 5} more Sessions` : ''), at: retries.at(-1)!.lastAt }
      : { state: 'ready', detail: 'No managed Session is waiting on a model budget retry' })
  }
  private ticketOf(agent: Agent): Ticket | undefined {
    const ticketId = ticketOfSession(agent.id)
    return ticketId === undefined ? undefined : this.host.store.tickets.get(ticketId)
  }
  /**
   * Decorates a teammate Session: its brief as a system prompt section that re-reads the roster on every request, so a
   * name, responsibility or brief edit reaches the next turn, and the one tool it reports to the main Session with.
   */
  private decorateTeammate(agent: Agent, brief: TeammateBrief): void {
    const binding: SessionBinding = { disposers: [], teammate: true }
    this.bindings.set(agent, binding)
    binding.disposers.push(agent.ctx.systemPrompt.section({ name: 'dsh-superagent-teammate', order: 9_000, interpolate: false,
      text: teammateSection(() => this.host.teammate?.(agent.id),
        () => this.ctx.logger.warn('dsh-superagent teammate %s is missing from the roster while its prompt section composes; its teammate section is empty', agent.id)) }))
    const execute = async (args: z.infer<typeof TEAM_REPORT.schema>) => {
      const current = this.host.teammate?.(agent.id) ?? brief
      const reports = this.host.team?.()
      if (reports !== undefined) {
        const report = reports.queueReport({ teammateId: current.id, name: current.name, sessionId: agent.id,
          state: args.state, summary: args.summary, ...(args.question ? { question: args.question } : {}) })
        return { ok: true, queued: true, reportId: report.id }
      }
      this.relay(`team-report:${agent.id}:${randomBytes(8).toString('hex')}`,
        JSON.stringify({ kind: 'teammate_report', teammate: { id: current.id, name: current.name }, ...args }))
      return { ok: true }
    }
    this.registerRawTool(agent, binding, 'orchestrator_team_report', TEAM_REPORT.description, TEAM_REPORT.parameters, execute)
  }
  /** Registers a tool from an already lossless JSON Schema, avoiding a Zod projection that DSH may reject. */
  private registerRawTool(agent: Agent, binding: SessionBinding, name: string, description: string, parameters: Record<string, unknown>,
    execute: (args: z.infer<typeof TEAM_REPORT.schema>, signal: AbortSignal) => unknown): void {
    binding.disposers.push(agent.ctx.tools.register({ name, description, parameters: parameters as never,
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => {
        const text = { type: 'text' as const, text: JSON.stringify(value) }
        const image = value && typeof value === 'object' && 'image' in value ? (value as { image: never }).image : undefined
        return image ? [text, { type: 'image' as const, attachment: image }] : [text]
      } },
      execute: async (args, execution) => execute(TEAM_REPORT.schema.parse(args), execution.signal) }))
  }
  /** Whether the live teammate tool surface still exposes the report tool after decoration. */
  private hasTeammateReport(agent: Agent): boolean {
    try {
      const scope = scopeOf(agent.ctx)
      return agent.ctx.tools.schemas(scope).some(tool => tool.name === 'orchestrator_team_report')
    } catch {
      return agent.ctx.tools.get('orchestrator_team_report', scopeOf(agent.ctx)) !== undefined
    }
  }
  /**
   * Tells the main Session when a teammate turn produced work but never reported, then wakes the teammate to report itself.
   * A report queued here means the main Session is never blind to a finished turn, even when the teammate never calls the
   * tool; the reminder asks for that report once per turn, and only after a turn that wrote, edited or ran something, so a
   * turn of reads asks nothing of the main Session.
   */
  private settleTeammateTurn(agent: Agent): void {
    if (!this.bindings.get(agent)?.teammate) return
    const brief = this.host.teammate?.(agent.id)
    const turn = this.teammateTurns.get(agent.id)
    if (!brief || !turn || !turn.worked || turn.reported) return
    const reminded = this.remindedTurns.get(agent.id) ?? new Set<number>()
    if (reminded.has(turn.turn)) return
    // Record the reminder before acting, so a second idle event for the same turn cannot send it twice.
    reminded.add(turn.turn)
    this.remindedTurns.set(agent.id, reminded)
    const last = turn.lastText.replace(/\s+/g, ' ').trim().slice(0, 600)
    const summary = `Auto-report: ${brief.name} ended a turn that produced work without calling orchestrator_team_report, so the main Session never saw its conclusion.`
      + `\nTools: ${turn.tools.join(', ')}` + (last ? `\nLast text: ${last}` : '')
    try {
      this.host.team?.().queueReport({ teammateId: brief.id, name: brief.name, sessionId: agent.id, state: 'progress',
        summary: summary.slice(0, 2000) })
      this.ctx.logger.warn('dsh-superagent teammate %s ended turn %d without a report; queued a fallback report', agent.id, turn.turn)
    } catch (error) {
      this.ctx.logger.warn('dsh-superagent could not queue a fallback report for %s: %s', agent.id, String(error))
    }
    void this.prompt(agent.id, `team-report-reminder:${turn.turn}`, TEAM_REPORT_REMINDER, 'steer')
      .catch((error: unknown) => this.ctx.logger.warn('dsh-superagent could not remind %s to report: %s', agent.id, String(error)))
  }

  private async decorate(agent: Agent): Promise<void> {
    // Re-decorate idempotently: a stale binding must not suppress the rebuild that re-registers the report tool.
    if (this.bindings.has(agent)) this.release(agent)
    const host = this.host
    const master = agent.id === host.masterId
    const ticket = master ? undefined : this.ticketOf(agent)
    const teammate = master || ticket ? undefined : host.teammate?.(agent.id)
    if (teammate) {
      this.decorateTeammate(agent, teammate)
      if (!this.hasTeammateReport(agent)) {
        this.ctx.logger.warn('dsh-superagent teammate %s is missing orchestrator_team_report after decorate; retrying once', agent.id)
        this.release(agent)
        this.decorateTeammate(agent, teammate)
        if (!this.hasTeammateReport(agent)) {
          this.ctx.logger.error('dsh-superagent teammate %s still has no orchestrator_team_report after a retry', agent.id)
        }
      }
      return
    }
    if (!master && !ticket) { this.limitSubagent(agent); return }
    const binding: SessionBinding = { disposers: [] }
    this.bindings.set(agent, binding)
    this.retryHealth.restore(agent.id, agent.session.snapshotEvents())
    if (agent.status === 'idle') this.retryHealth.clear(agent.id)
    this.updateModelHealth()
    // Disable variable interpolation so literal ${{ ... }} expressions in team prompts are preserved.
    binding.disposers.push(agent.ctx.systemPrompt.section({ name: 'dsh-superagent-policy', order: 9999, interpolate: false, text: context => {
      const version = this.promptFor(agent, context.signal !== undefined)
      const current = ticket && host.store.tickets.get(ticket.id)
      const composed = host.prompts.compose(version.config, master ? 'orchestrator' : 'worker', current ? host.environment(current) : undefined)
      return `[dsh-superagent prompt revision ${version.revision}]\n${composed}\n${current ? mandateInstructions(current.mandate) : ''}`
    }, ...(master ? { complete: true } : {}) }))
    // A recreated skill scope (e.g. after the skills service restarts) starts empty, so reset `binding.skills` before rebinding.
    const skillScope = agent.ctx.inject(['skills'], scope => {
      binding.scope = scope
      binding.skills = undefined
      this.bindSkills(binding, host.prompts.current())
    })
    binding.disposers.push(() => { skillScope.dispose().catch((error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release a skill scope: %s', String(error)) }) })
    await skillScope
    // Bail out if the agent was disposed while awaiting the skill scope.
    if (this.bindings.get(agent) !== binding) return
    const register = this.registerTool(agent, binding)
    for (const tool of host.tools(agent, ticket)) register(tool.name, tool.description, tool.schema, tool.execute)
    if (master) {
      const shell = shellToolOf(agent)
      // The main Session asks a person with the official `ask_user_question` card (preset row `tool-ask-user`); workers never do.
      binding.disposers.push(agent.ctx.tools.restrict({ allow: ['skill', shell, 'read', 'read_image', 'job_output', 'job_list', 'job_kill', 'ask_user_question'] }),
        agent.ctx.tools.guard(execution => noWait(execution, () => this.routed(agent), shell)))
    } else {
      // An Executor Session keeps the profile's work tools it has, which DSH requires to be known; its own tools are not masked.
      binding.disposers.push(...this.workOnly(agent, ticket!.id))
    }
  }
  /**
   * Whether a Session runs the router preset: as DSH's preset registry last selected it, read through the session projection
   * on a DSH whose registry has no `presetForSession`, else as it was created; `standard`, the safer caps, when unreadable.
   */
  private routed(agent: Agent): boolean {
    try {
      const presets = this.ctx.get('agentPresets') as { presetForSession?: (session: Agent['session']) => string | null } | undefined
      const projections = this.ctx.get('sessionProjections') as { stateOf?: (session: Agent['session'], key: string) => unknown } | undefined
      const selected = typeof presets?.presetForSession === 'function' ? presets.presetForSession(agent.session)
        : projections?.stateOf?.(agent.session, 'agentPreset')
      return (selected ?? agent.session.header.agentPreset) === ROUTER_PRESET
    } catch { return false }
  }
  /**
   * An Executor Session's tools: only the profile's work tools, which DSH requires to be known, and none once its ticket
   * ended. A failed or blocked worker keeps its tools, so a person may continue it in its Session; only automated input waits
   * (see the executor). Read inherited tools through the parent scope, which includes the preset's tools. The global view
   * misses preset tools; the agent's own view also includes local tools such as subagent, which restrict refuses to name.
   */
  private workOnly(agent: Agent, ticketId: string): (() => void)[] {
    const store = this.host.store
    const parent = scopeParentOf(agent)
    const allow = WORK_TOOLS.filter(name => agent.ctx.tools.get(name, parent))
    return [agent.ctx.tools.restrict({ allow }), agent.ctx.tools.guard(() => {
      const current = store.tickets.get(ticketId)
      return !current || !liveTicket(current) ? 'Ticket ended; new work needs a new authorized ticket' : undefined
    })]
  }
  /**
   * A subagent of an Executor Session, or of one of its subagents, which runs under DSH's `standard` preset with the worker's
   * permissions, gets the same work tools as the worker, and none once the worker's ticket ended. Any other agent is left as
   * it is.
   */
  private limitSubagent(agent: Agent): void {
    let parent = agent.session.header.parentSession
    // Up the subagents' parents to the worker, which are loaded while their subagents run.
    for (let depth = 0; parent !== undefined && ticketOfSession(parent) === undefined && depth < 8; depth++) {
      parent = this.ctx.agents.get(parent)?.session.header.parentSession
    }
    const ticketId = parent === undefined ? undefined : ticketOfSession(parent)
    if (ticketId === undefined || !this.host.store.tickets.get(ticketId)) return
    this.bindings.set(agent, { disposers: this.workOnly(agent, ticketId), subagent: true })
  }
  /** Register the skills of a prompt version in the agent's skill scope, in place of an earlier version's. */
  private bindSkills(binding: SessionBinding, version: PromptVersion): void {
    const { scope, skills: previous } = binding
    if (!scope || previous?.revision === version.revision) return
    previous?.dispose()
    const disposers: (() => void)[] = []
    for (const [name, content] of this.host.prompts.skills(version.config)) {
      const bundled = Object.hasOwn(bundledSkills, name) ? bundledSkills[name as keyof typeof bundledSkills] : undefined
      const body = version.config.skills[name] ?? ''
      const description = bundled?.description ?? (body.replace(/\s+/g, ' ').slice(0, 120) || 'Custom dsh-superagent operational skill.')
      disposers.push(scope.skills.register({ name: `${SKILL_PREFIX}${name}`, description, content, source: 'runtime',
        ...(bundled ? { resourceBase: { kind: 'directory' as const, path: dirname(bundled.path) } } : {}) }))
    }
    binding.skills = { revision: version.revision, dispose: () => { disposers.forEach(dispose => dispose()) } }
  }
  /** Return the current prompt version, updating the agent's skills and recording the revision in Store when bound to a model request. */
  private promptFor(agent: Agent, bind: boolean): PromptVersion {
    const version = this.host.prompts.current()
    if (!bind) return version
    const binding = this.bindings.get(agent)
    if (binding) this.bindSkills(binding, version)
    const { store } = this.host
    const revisions = store.get(KV.sessions.prompts(agent.id)) ?? []
    const bound = [...revisions.filter(revision => revision !== version.revision), version.revision]
    if (revisions.at(-1) !== version.revision) store.set(KV.sessions.prompts(agent.id), bound)
    return version
  }
  /** Releases registrations for `agent` in reverse order (LIFO); disposing its skill scope releases its skills as well. */
  private release(agent: Agent): void {
    this.teammateTurns.delete(agent.id)
    this.remindedTurns.delete(agent.id)
    const binding = this.bindings.get(agent)
    if (!binding) return
    this.bindings.delete(agent)
    binding.skills?.dispose()
    for (const dispose of binding.disposers.splice(0).reverse()) {
      try { dispose() } catch (error) { this.ctx.logger.warn('dsh-superagent could not release what it registered for a Session: %s', String(error)) }
    }
  }
  /** Releases prompt sections, skills, and tools registered by `Sessions` across all decorated agents. */
  dispose(): void { for (const agent of [...this.bindings.keys()]) this.release(agent) }
}
