/** The loopback board server: the read-only board snapshot behind a Bearer token, the ticket actions, and the team actions. */
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { UserError } from '../core/errors.ts'

const KINDS = ['stop', 'retry', 'unfocus'] as const
const MAX_BODY_BYTES = 64 * 1024

/** The outcome of one board action; when `ok` is false its `code` becomes the HTTP status. */
export interface BoardActionResult {
  ok: boolean
  message?: string
  code?: number
}

/** The team operations the board's team routes call; the routes add no rules of their own. */
export interface BoardTeam {
  list(): unknown[] | Promise<unknown[]>
  add(input: { name: string; role: string; brief?: string; sessionId?: string }): Promise<unknown>
  update(teammate: string, patch: { name?: string; role?: string; brief?: string }): Promise<unknown>
  remove(teammate: string): Promise<unknown>
  message(teammate: string, text: string, mode: 'queue' | 'steer'): Promise<unknown>
  /** Wake/report health; omitted by older/standalone callers. */
  status?(): { lastWakeAt: string | null; pendingReports: number }
}

const NAME = z.string().trim().min(1).max(40)
const ROLE = z.string().trim().min(1).max(200)
const BRIEF = z.string().trim().max(4000)
const TEAMMATE = z.string().trim().min(1).max(80)
/** One team action's body, checked before the team runs it. */
const TeamAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add'), name: NAME, role: ROLE, brief: BRIEF.optional(), sessionId: TEAMMATE.optional() }).strict(),
  z.object({ action: z.literal('update'), id: TEAMMATE, name: NAME.optional(), role: ROLE.optional(), brief: BRIEF.optional() }).strict(),
  z.object({ action: z.literal('remove'), id: TEAMMATE }).strict(),
  z.object({ action: z.literal('message'), id: TEAMMATE, text: z.string().trim().min(1).max(20000), mode: z.enum(['queue', 'steer']).default('queue') }).strict(),
])

/** A running board server: its loopback base URL and the close that releases the port. */
export interface BoardServerHandle {
  url: string
  close: () => Promise<void>
}

const isKind = (value: unknown): value is (typeof KINDS)[number] =>
  typeof value === 'string' && (KINDS as readonly string[]).includes(value)

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
  })
  response.end(text)
}

const readJson = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Runs one validated team action and returns the response body; `Team` owns every rule. */
async function runTeamAction(team: BoardTeam, action: z.infer<typeof TeamAction>): Promise<Record<string, unknown>> {
  switch (action.action) {
    case 'add':
      return { teammate: await team.add({ name: action.name, role: action.role,
        ...(action.brief !== undefined ? { brief: action.brief } : {}), ...(action.sessionId ? { sessionId: action.sessionId } : {}) }) }
    case 'update':
      return { teammate: await team.update(action.id, { ...(action.name !== undefined ? { name: action.name } : {}),
        ...(action.role !== undefined ? { role: action.role } : {}), ...(action.brief !== undefined ? { brief: action.brief } : {}) }) }
    case 'remove':
      return { removed: await team.remove(action.id) }
    case 'message':
      return { message: await team.message(action.id, action.text, action.mode) }
  }
}

/**
 * Starts the board server on 127.0.0.1. `snapshot` supplies `board.json`; `action` runs one ticket
 * action and its `code` becomes the HTTP status when it fails. `team`, when set, serves the runtime team
 * management routes. Port 0 asks the OS for a free port.
 */
export async function startBoardServer({ port, token, snapshot, action, team }: {
  port: number
  token: string
  snapshot: () => Promise<unknown>
  action: (kind: string, ticketId: string) => Promise<BoardActionResult>
  team?: BoardTeam
}): Promise<BoardServerHandle> {
  const authorized = (request: IncomingMessage): boolean => request.headers.authorization === `Bearer ${token}`

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (request.method === 'GET' && path === '/board.json') {
      if (!authorized(request)) return sendJson(response, 401, { ok: false, message: 'unauthorized' })
      try {
        sendJson(response, 200, await snapshot())
      } catch {
        sendJson(response, 500, { ok: false, message: 'snapshot failed' })
      }
      return
    }
    if (request.method === 'POST' && path === '/board/action') {
      if (!authorized(request)) return sendJson(response, 401, { ok: false, message: 'unauthorized' })
      let body: unknown
      try {
        body = await readJson(request)
      } catch {
        sendJson(response, 400, { ok: false, message: 'request body must be a JSON object' })
        return
      }
      const kind = (body as { kind?: unknown } | null)?.kind
      const ticketId = (body as { ticketId?: unknown } | null)?.ticketId
      if (!isKind(kind) || typeof ticketId !== 'string' || ticketId === '') {
        sendJson(response, 400, { ok: false, message: 'kind must be stop, retry or unfocus, and ticketId is required' })
        return
      }
      const result = await action(kind, ticketId)
      sendJson(response, result.ok ? 200 : (result.code ?? 400), result)
      return
    }
    if (request.method === 'GET' && path === '/team') {
      if (!authorized(request)) return sendJson(response, 401, { ok: false, message: 'unauthorized' })
      if (!team) return sendJson(response, 404, { ok: false, message: 'the team is not managed here' })
      sendJson(response, 200, { ok: true, teammates: await team.list(), ...(team.status?.() ?? {}) })
      return
    }
    if (request.method === 'POST' && path === '/team/action') {
      if (!authorized(request)) return sendJson(response, 401, { ok: false, message: 'unauthorized' })
      if (!team) return sendJson(response, 404, { ok: false, message: 'the team is not managed here' })
      let body: unknown
      try {
        body = await readJson(request)
      } catch {
        sendJson(response, 400, { ok: false, message: 'request body must be a JSON object' })
        return
      }
      const parsed = TeamAction.safeParse(body)
      if (!parsed.success) {
        sendJson(response, 400, { ok: false, message: parsed.error.issues[0]?.message ?? 'invalid team action' })
        return
      }
      try {
        sendJson(response, 200, { ok: true, ...await runTeamAction(team, parsed.data) })
      } catch (error) {
        if (!(error instanceof UserError)) throw error
        sendJson(response, error.missing ? 404 : 409, { ok: false, message: error.message })
      }
      return
    }
    sendJson(response, 404, { ok: false, message: 'not found' })
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { ok: false, message: 'internal error' })
      else response.destroy()
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  const boundPort = typeof address === 'object' && address !== null ? address.port : port

  return {
    url: `http://127.0.0.1:${boundPort}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
      server.closeAllConnections?.()
    }),
  }
}