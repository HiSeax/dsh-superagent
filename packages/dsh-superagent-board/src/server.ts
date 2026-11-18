/** The board's loopback HTTP endpoint: `GET /board.json`, `GET /team.json`, `GET /work.json`, `GET /healthz` and actions. */
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { aggregate, type BoardData, type BoardPayload, type TeamInput, type TeamMemberInput } from './aggregate.ts'

/** The board endpoint the page fetches; the sidebar page itself is rendered by the client half. */
export const DEFAULT_PORT = 8917
/** superagent's loopback origin; the env override keeps the smoke test off the real ports. */
const SUPERAGENT_ORIGIN = process.env.DSH_SUPERAGENT_ORIGIN ?? 'http://127.0.0.1:8916'
const SUPERAGENT_BOARD_URL = `${SUPERAGENT_ORIGIN}/board.json`
const SUPERAGENT_TEAM_URL = `${SUPERAGENT_ORIGIN}/team`
const SUPERAGENT_TEAM_ACTION_URL = `${SUPERAGENT_ORIGIN}/team/action`
const TOKEN_PATH = process.env.DSH_SUPERAGENT_TOKEN_FILE ?? join(homedir(), '.dsh', 'state', 'superagent', 'board-token')
const WORK_FILE = process.env.DSH_SUPERAGENT_WORK_FILE ?? join(homedir(), '.dsh', 'state', 'superagent', 'work-status.json')
const WORK_LIMIT = 6

/** Reads the controller's per-round status file; missing or malformed files mean "no work yet". */
async function readWorkStatus(): Promise<unknown[]> {
  try {
    const parsed = JSON.parse(await readFile(WORK_FILE, 'utf8')) as unknown
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { items?: unknown }).items)
        ? (parsed as { items: unknown[] }).items
        : Array.isArray((parsed as { history?: unknown }).history)
          ? (parsed as { history: unknown[] }).history
          : [parsed]
    return list
      .filter(item => item !== null && typeof item === 'object')
      .sort((a, b) => String((b as { startedAt?: string }).startedAt ?? '').localeCompare(String((a as { startedAt?: string }).startedAt ?? '')))
      .slice(0, WORK_LIMIT)
  } catch {
    return []
  }
}
/** The aggregate calls two local superagent endpoints plus subagent lookups; a cold /team + /board pair was >7 s. */
const FETCH_TIMEOUT_MS = 15000

/** The board's main-Session card until the roster's own main row exists; teammates come from `/team`. */
const DEFAULT_TEAM: TeamInput = {
  main: { id: 'lead', name: 'lead', role: 'lead', state: 'working' },
  members: [],
}

/** The subset of DSH's subagent runtime the board needs; absent when the host does not expose it. */
export interface SubagentEntry {
  kind: 'child' | 'diagnostic'
  id: string
  parentId?: string
  depth?: number
  activity?: 'running' | 'inactive'
  label?: string
}
export interface SubagentsReader {
  listDescendants(sessionId: string): Promise<SubagentEntry[]>
}

/** The seam tests and the plugin entry use: inject a roster, a board fetcher, a clock or a subagent reader. */
export interface BoardServerOptions {
  port?: number
  host?: string
  team?: () => Promise<TeamInput | null> | TeamInput | null
  fetchBoard?: () => Promise<BoardPayload | null>
  teamAction?: (body: unknown) => Promise<ForwardResult>
  now?: () => Date
  subagents?: SubagentsReader
}

/** A running board server: its loopback base URL and the stop that releases the port. */
export interface BoardServerHandle {
  url: string
  close: () => Promise<void>
}

/** Reads the superagent board token written by the superagent plugin; any failure means no board source. */
function boardToken(): string | null {
  try {
    return readFileSync(TOKEN_PATH, 'utf8').trim() || null
  } catch {
    return null
  }
}

/** One action's forwarded answer: the superagent status and body, passed through unchanged. */
export interface ForwardResult {
  status: number
  body: unknown
}

/** The seam tests use to replace the superagent transport and its token. */
export interface ForwardOptions {
  fetcher?: (input: string, init?: RequestInit) => Promise<Response>
  token?: string | null
}

/** The seam the team tests use to replace the `/team` transport and its token. */
export interface TeamFetchOptions {
  fetcher?: (input: string, init?: RequestInit) => Promise<Response>
  token?: string | null
}

/** superagent's live state word for a teammate; the board keeps its own working/idle vocabulary. */
const teamState = (value: unknown): string =>
  value === 'running' ? 'working' : value === 'idle' ? 'idle' : value === 'stored' ? 'stored' : 'unknown'

/** One `/team` row, or null when the payload is not a teammate. */
function teammateOf(value: unknown): TeamMemberInput | null {
  if (value === null || typeof value !== 'object') return null
  const row = value as { id?: unknown; name?: unknown; role?: unknown; sessionId?: unknown; state?: unknown; ticketId?: unknown;
    ticketTitle?: unknown; ticketEnded?: unknown }
  if (typeof row.id !== 'string' || row.id === '' || typeof row.name !== 'string' || row.name === '') return null
  return {
    id: row.id,
    name: row.name,
    role: typeof row.role === 'string' ? row.role : '',
    state: teamState(row.state),
    ...(typeof row.sessionId === 'string' && row.sessionId !== '' ? { sessionId: row.sessionId } : {}),
    ...(typeof row.ticketId === 'string' && row.ticketId !== '' ? { ticketId: row.ticketId } : {}),
    ...(typeof row.ticketTitle === 'string' && row.ticketTitle !== '' ? { ticketTitle: row.ticketTitle } : {}),
    ...(row.ticketEnded === true ? { ticketEnded: true as const } : {}),
  }
}

/**
 * Fetches superagent's runtime roster (`GET /team`) with the same Bearer token as the board. A missing token, a failed
 * request or a non-2xx answer means the roster is unavailable and the caller reports `teamDown`.
 */
export async function fetchSuperagentTeam(options: TeamFetchOptions = {}): Promise<TeamInput | null> {
  const token = options.token === undefined ? boardToken() : options.token
  if (!token) return null
  const fetcher = options.fetcher ?? fetch
  try {
    const response = await fetcher(SUPERAGENT_TEAM_URL, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const payload = await response.json() as { teammates?: unknown; workers?: unknown }
    const rows = Array.isArray(payload.teammates) ? payload.teammates : []
    const workers = Array.isArray(payload.workers) ? payload.workers.flatMap(value => {
      if (value === null || typeof value !== 'object') return []
      const row = value as { sessionId?: unknown; ticketId?: unknown; ticketTitle?: unknown; startedAt?: unknown }
      return typeof row.sessionId === 'string' && typeof row.ticketId === 'string' && typeof row.ticketTitle === 'string'
        ? [{ sessionId: row.sessionId, ticketId: row.ticketId, ticketTitle: row.ticketTitle,
          startedAt: typeof row.startedAt === 'string' ? row.startedAt : '' }] : []
    }) : []
    return {
      main: DEFAULT_TEAM.main,
      members: rows.map(teammateOf).filter((row): row is TeamMemberInput => row !== null),
      workers,
    }
  } catch {
    return null
  }
}

/** Fetches superagent's `board.json`; a missing token, a failed request or a non-2xx answer degrades the board. */
export async function fetchSuperagentBoard(): Promise<BoardPayload | null> {
  const token = boardToken()
  if (!token) return null
  try {
    const response = await fetch(SUPERAGENT_BOARD_URL, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    return response.ok ? await response.json() as BoardPayload : null
  } catch {
    return null
  }
}

/**
 * Forwards one board action to superagent's loopback endpoint with the same Bearer token the board reads.
 * The superagent status and body pass through, so the iframe shows the server's own message for a refusal.
 */
export async function forwardAction(kind: string, ticketId: string, options: ForwardOptions = {}): Promise<ForwardResult> {
  const token = options.token === undefined ? boardToken() : options.token
  if (!token) return { status: 502, body: { ok: false, message: 'superagent 未就绪（缺少 board token）' } }
  const fetcher = options.fetcher ?? fetch
  try {
    const response = await fetcher(`${SUPERAGENT_ORIGIN}/board/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ kind, ticketId }),
      signal: AbortSignal.timeout(5000),
    })
    const body = await response.json().catch(() => ({ ok: false, message: `superagent 返回 ${response.status}` }))
    return { status: response.status, body }
  } catch {
    return { status: 502, body: { ok: false, message: 'superagent 动作接口不可达' } }
  }
}

/**
 * Forwards one team action (update/remove) to superagent's `POST /team/action` with the same Bearer token. The
 * superagent status and body pass through, so a 404/409 message reaches the dialog unchanged.
 */
export async function forwardTeamAction(body: unknown, options: ForwardOptions = {}): Promise<ForwardResult> {
  const token = options.token === undefined ? boardToken() : options.token
  if (!token) return { status: 502, body: { ok: false, message: 'superagent 未就绪（缺少 board token）' } }
  const fetcher = options.fetcher ?? fetch
  try {
    const response = await fetcher(SUPERAGENT_TEAM_ACTION_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    })
    const answer = await response.json().catch(() => ({ ok: false, message: `superagent 返回 ${response.status}` }))
    return { status: response.status, body: answer }
  } catch {
    return { status: 502, body: { ok: false, message: 'superagent 团队接口不可达' } }
  }
}

/** The team area's own payload: the roster rows plus whether the `/team` source is reachable. */
export interface TeamView {
  generatedAt: string
  main: TeamMemberInput
  members: BoardData['members']
  workers: BoardData['workers']
  teamDown: boolean
  boardDown: boolean
}

/** Reads a bounded JSON request body for the action route. */
const readJson = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.length
    if (size > 16 * 1024) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
  })
  response.end(text)
}

/**
 * Starts the loopback board endpoint on 127.0.0.1:8917 (override with `DSH_SUPERAGENT_BOARD_PORT`). The roster comes
 * from superagent's `/team` and the tickets from its `board.json`, both read with the board token; a roster failure
 * reports `teamDown` while the ticket area keeps working.
 */
export async function startBoardServer(options: BoardServerOptions = {}): Promise<BoardServerHandle> {
  const port = options.port ?? Number(process.env.DSH_SUPERAGENT_BOARD_PORT ?? String(DEFAULT_PORT))
  const host = options.host ?? '127.0.0.1'
  const team = options.team ?? fetchSuperagentTeam
  const fetchBoard = options.fetchBoard ?? fetchSuperagentBoard
  const teamAction = options.teamAction ?? forwardTeamAction
  const now = options.now ?? (() => new Date())
  const subagents = options.subagents
  const subagentCache = new Map<string, { at: number; value: TeamMemberInput['subagents'] }>()
  /** Adds running direct children to working members; a missing reader or a failing call simply omits the field. */
  const attachSubagents = async (roster: TeamInput): Promise<TeamInput> => {
    if (!subagents) return roster
    const members = await Promise.all((roster.members ?? []).map(async member => {
      if (member.state !== 'working' || !member.sessionId) return member
      const cached = subagentCache.get(member.sessionId)
      if (cached && Date.now() - cached.at < 2000) return cached.value ? { ...member, subagents: cached.value } : member
      try {
        const entries = await subagents.listDescendants(member.sessionId)
        const running = entries.filter(entry => entry.kind === 'child' &&
          (entry.parentId === member.sessionId || entry.depth === 1) && entry.activity === 'running' &&
          !String(entry.label ?? '').startsWith('Side: '))
        const value = running.length === 0 ? undefined : { running: running.length,
          items: running.slice(0, 12).map(entry => ({ id: entry.id, label: entry.label ?? '' })) }
        subagentCache.set(member.sessionId, { at: Date.now(), value })
        return value ? { ...member, subagents: value } : member
      } catch {
        return member
      }
    }))
    return { ...roster, members }
  }
  const snapshot = async (): Promise<{ data: BoardData; teamDown: boolean }> => {
    // The roster and ticket feeds are independent; a serial pair doubled the cold latency behind the 3 s poll.
    const [teamResult, boardResult] = await Promise.allSettled([team(), fetchBoard()])
    let roster = teamResult.status === 'fulfilled' ? teamResult.value : null
    if (roster) {
      try { roster = await attachSubagents(roster) } catch { /* keep the roster; tickets still render */ }
    }
    const board = boardResult.status === 'fulfilled' ? boardResult.value : null
    const teamDown = roster === null
    return { data: aggregate({ team: roster ?? DEFAULT_TEAM, board, now: now(), teamDown }), teamDown }
  }
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', `http://${host}`).pathname
    if (request.method === 'POST' && path === '/board/action') {
      let body: { kind?: unknown; ticketId?: unknown }
      try {
        body = await readJson(request) as { kind?: unknown; ticketId?: unknown }
      } catch {
        sendJson(response, 400, { ok: false, message: 'request body must be a JSON object' })
        return
      }
      const kind = body.kind
      const ticketId = body.ticketId
      if (typeof kind !== 'string' || !['stop', 'retry', 'unfocus'].includes(kind) || typeof ticketId !== 'string' || ticketId === '') {
        sendJson(response, 400, { ok: false, message: 'kind must be stop, retry or unfocus, and ticketId is required' })
        return
      }
      const result = await forwardAction(kind, ticketId)
      sendJson(response, result.status, result.body)
      return
    }
    if (request.method === 'GET' && path === '/board.json') {
      try {
        sendJson(response, 200, (await snapshot()).data)
      } catch {
        sendJson(response, 500, { error: 'aggregate failed' })
      }
      return
    }
    if (request.method === 'GET' && path === '/team.json') {
      try {
        const { data, teamDown } = await snapshot()
        const view: TeamView = {
          generatedAt: data.generatedAt,
          main: data.main,
          members: data.members,
          workers: data.workers,
          teamDown,
          boardDown: data.degraded !== null,
        }
        sendJson(response, 200, view)
      } catch {
        sendJson(response, 500, { error: 'team aggregate failed' })
      }
      return
    }
    if (request.method === 'POST' && path === '/team/action') {
      let body: unknown
      try {
        body = await readJson(request)
      } catch {
        sendJson(response, 400, { ok: false, message: 'request body must be a JSON object' })
        return
      }
      const record = body !== null && typeof body === 'object' && !Array.isArray(body)
        ? body as { action?: unknown; id?: unknown }
        : null
      if (record === null || (record.action !== 'update' && record.action !== 'remove') || typeof record.id !== 'string' || record.id === '') {
        sendJson(response, 400, { ok: false, message: 'action must be update or remove, and id is required' })
        return
      }
      const result = await teamAction(body)
      sendJson(response, result.status, result.body)
      return
    }
    if (request.method === 'GET' && path === '/work.json') {
      sendJson(response, 200, await readWorkStatus())
      return
    }
    if (request.method === 'GET' && path === '/healthz') {
      sendJson(response, 200, { ok: true, service: 'superagent-board' })
      return
    }
    sendJson(response, 404, { error: 'not found' })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  const boundPort = typeof address === 'object' && address !== null ? address.port : port
  return {
    url: `http://${host}:${boundPort}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()))
      server.closeAllConnections?.()
    }),
  }
}
