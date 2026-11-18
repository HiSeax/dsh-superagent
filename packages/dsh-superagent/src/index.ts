/** Main plugin entry: mounts the Runtime, its board server and the restart callback for deployment account changes. */
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { Runtime, waitForStateLock } from './app/runtime.ts'
import { buildBoard } from './app/board.ts'
import { boardActions } from './app/board-actions.ts'
import { startBoardServer } from './app/board-server.ts'
import type { Ticket } from './core/model.ts'
import { ticketStage } from './core/stage.ts'
import { Config, machineOf, type DeploymentConfig } from './deployment.ts'

export const name = 'dsh-superagent'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'skills', 'webServer', 'llm', 'subprocess']
export { Config }

/** The loopback board port; an environment override keeps it movable without touching the deployment schema. */
const BOARD_PORT = Number(process.env.DSH_SUPERAGENT_BOARD_PORT ?? '8916')

/** Reads the board token, creating a 32-byte hex one with owner-only permissions when the file is missing or empty. */
function boardToken(stateDir: string): string {
  const path = join(stateDir, 'board-token')
  try {
    const stored = readFileSync(path, 'utf8').trim()
    if (stored) {
      chmodSync(path, 0o600)
      return stored
    }
  } catch {
    // Missing or unreadable: create it below.
  }
  const token = randomBytes(32).toString('hex')
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  writeFileSync(path, `${token}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
  return token
}

/**
 * The board's state for a stored ticket. A ticket waiting on a person is `blocked` (the board's 待人工 group) for both a
 * structured question and a failed delivery, so a ticket nobody answered does not stay among the running ones; `delivery`
 * was the only person stage mapped to `blocked` before, which left `attention` looking like active work.
 */
export function boardTicketState(ticket: Ticket): string {
  if (ticket.ended) return ticket.ended.outcome === 'stopped' ? 'stopped' : 'done'
  const stage = ticketStage(ticket)
  if (stage.stage === 'person') return stage.action === 'answer' || stage.action === 'delivery' ? 'blocked' : stage.action
  return stage.stage === 'working' ? 'executing' : 'new'
}

export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  const machine = machineOf(config)
  // The management panel provides its own settings UI, so disable DSH's auto-generated settings page.
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // Volatile limits update in place without a restart; account changes restart dsh-superagent. DSH's settings service stops
  // serving this entry while dsh-superagent restarts and rereads it only on a configuration write, so trigger `describe()`
  // after restart to keep open configuration forms editable without a page reload.
  // TODO: drop the read once DSH's settings service rereads an entry whose plugin becomes active again.
  const restart = (): void => {
    ctx.fiber.restart().then(() => { ctx.get('settings')?.describe() }).catch((error: unknown) => { ctx.logger.error('dsh-superagent restart failed: %s', String(error)) })
  }
  // A killed previous host keeps its lock for proper-lockfile's stale window; wait it out so a fast restart still activates.
  await waitForStateLock(machine.stateDir)
  const runtime = new Runtime(ctx, machine, restart, { bootNotice: config.bootNotice, heartbeat: config.heartbeat })
  ctx.effect(() => async () => { await runtime.stop() })
  await runtime.ready
  ctx.logger.info(runtime.configured() ? 'dsh-superagent ready; the Superagent sidebar entry opens the management panel' : `dsh-superagent is waiting for setup: ${runtime.setupProblem?.detail ?? ''}`)
  // The board snapshot: stored tickets and the live team roster, so the board shows a teammate the runtime added
  // or hides one the runtime removed without a restart. A ticket dispatched to a teammate is that member's, and a
  // self-created one without an owner is the main Session's own.
  const snapshot = async (): Promise<unknown> => {
    const roster = await runtime.team.list()
    const names = new Map(roster.map(teammate => [teammate.id, teammate.name]))
    return buildBoard({
      tickets: runtime.store.tickets.list().map(ticket => {
        const self = ticket.origin.kind === 'self'
        const memberName = ticket.owner === undefined ? undefined : names.get(ticket.owner)
        return {
          id: ticket.id,
          title: ticket.title,
          state: boardTicketState(ticket),
          owner: ticket.owner ?? (self ? 'main' : null),
          ownerKind: ticket.owner === undefined && self ? 'main' as const : 'member' as const,
          ...(memberName !== undefined ? { ownerLabel: memberName } : self ? { ownerLabel: '主会话自建' } : {}),
          updatedAt: ticket.updatedAt,
          summary: ticket.assignments.reduce((summary, assignment) => assignment.report?.summary ?? summary, ''),
          origin: self ? 'self' as const : 'trigger' as const,
        }
      }),
      members: roster.map(teammate => ({ id: teammate.id, name: teammate.name, role: teammate.role, state: teammate.state })),
    })
  }
  try {
    const board = await startBoardServer({
      port: BOARD_PORT,
      token: boardToken(machine.stateDir),
      snapshot,
      action: boardActions(runtime.store, runtime.engine),
      team: runtime.team,
    })
    ctx.effect(() => async () => { await board.close() })
    ctx.logger.info('dsh-superagent board listening on 127.0.0.1:%d', BOARD_PORT)
  } catch (error) {
    ctx.logger.error('dsh-superagent board did not start: %s', String(error))
  }
}
export type { Deployment, DeploymentConfig } from './deployment.ts'
export * from './core/index.ts'
