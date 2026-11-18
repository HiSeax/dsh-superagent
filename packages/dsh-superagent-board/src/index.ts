/** Host half: starts the aggregate endpoint and serves the plugin's iframe page over the host web server. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { startBoardServer } from './server.ts'

export const name = 'dsh-superagent-board'

/** The host services this entry needs: the web server serves the iframe page. */
export const inject = ['webServer']

export interface BoardHostContext {
  effect: (factory: () => () => Promise<void>) => void
  logger: { error: (message: string, ...args: unknown[]) => void }
  /** Optional DSH service lookup; the subagent reader is absent in hosts that do not expose it. */
  get?: (name: string) => unknown
  webServer: {
    register(route: { kind: 'prefix'; path: string; handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void }): () => void
  }
}

/** The loopback aggregate port; the plugin host can move it with the same env the server reads. */
const BOARD_PORT = Number(process.env.DSH_SUPERAGENT_BOARD_PORT ?? '8917')
const ALIASES_FILE = process.env.DSH_SUPERAGENT_ALIASES_FILE ?? join(homedir(), '.dsh', 'state', 'superagent', 'aliases.json')

type AliasMap = Record<string, string>

async function readAliases(): Promise<AliasMap> {
  try {
    const parsed = JSON.parse(await readFile(ALIASES_FILE, 'utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: AliasMap = {}
    for (const [id, name] of Object.entries(parsed)) if (typeof name === 'string' && name.trim() !== '') out[id] = name.trim()
    return out
  } catch {
    return {}
  }
}

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  const data = Buffer.from(JSON.stringify(body))
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(data.length), 'cache-control': 'no-store' })
  response.end(data)
}

async function aliasRoute(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === 'GET') { sendJson(response, 200, await readAliases()); return }
  if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
  let body: { id?: unknown; name?: unknown }
  try {
    body = JSON.parse((await readBody(request)).toString('utf8')) as { id?: unknown; name?: unknown }
  } catch {
    sendJson(response, 400, { ok: false, message: 'invalid JSON' })
    return
  }
  const id = typeof body.id === 'string' ? body.id.trim() : ''
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 40) : ''
  if (id === '' || name === '') { sendJson(response, 400, { ok: false, message: 'id and name are required' }); return }
  const aliases = await readAliases()
  aliases[id] = name
  try {
    await mkdir(dirname(ALIASES_FILE), { recursive: true })
    await writeFile(ALIASES_FILE, JSON.stringify(aliases, null, 2) + '\n', { mode: 0o600 })
  } catch {
    sendJson(response, 500, { ok: false, message: 'aliases file is not writable' })
    return
  }
  sendJson(response, 200, aliases)
}

/** Plain assets shipped next to the built bundle; the page renders rows the board server already aliased. */
const PAGE_DIR = new URL('../src/web/', import.meta.url)
const ASSETS: Record<string, { file: URL; type: string }> = {
  '/': { file: new URL('index.html', PAGE_DIR), type: 'text/html; charset=utf-8' },
  '/index.html': { file: new URL('index.html', PAGE_DIR), type: 'text/html; charset=utf-8' },
  '/app.js': { file: new URL('app.js', PAGE_DIR), type: 'text/javascript; charset=utf-8' },
  '/tokens.css': { file: new URL('tokens.css', PAGE_DIR), type: 'text/css; charset=utf-8' },
}

/** Proxies the aggregate endpoint so the iframe can fetch its sibling `board.json` on the same origin. */
const proxy = async (pathname: string, response: ServerResponse): Promise<void> => {
  try {
    const upstream = await fetch(`http://127.0.0.1:${BOARD_PORT}${pathname}`)
    const body = Buffer.from(await upstream.arrayBuffer())
    response.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'no-store',
    })
    response.end(body)
  } catch {
    response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ error: 'board data unavailable' }))
  }
}

/** Reads a bounded JSON body for the action route. */
const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.length
    if (size > 16 * 1024) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/**
 * POST /superagent-board/<route> → the loopback 8917 server's matching route. The 8917 server owns the
 * superagent token and forwards the JSON body; this route only relays status and body.
 */
const postProxy = async (request: IncomingMessage, response: ServerResponse, upstreamPath: string): Promise<void> => {
  if (request.method !== 'POST') {
    response.writeHead(405)
    response.end()
    return
  }
  let body: Buffer
  try {
    body = await readBody(request)
  } catch {
    response.writeHead(413, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ ok: false, message: 'request body too large' }))
    return
  }
  try {
    const upstream = await fetch(`http://127.0.0.1:${BOARD_PORT}${upstreamPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body.toString('utf8'),
      signal: AbortSignal.timeout(8000),
    })
    const data = Buffer.from(await upstream.arrayBuffer())
    response.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
      'content-length': String(data.length),
      'cache-control': 'no-store',
    })
    response.end(data)
  } catch {
    response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ ok: false, message: '动作接口不可达' }))
  }
}

/** `GET /superagent-board/` and its assets; unknown paths fall back to the iframe's index.html. */
const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
  const pathname = (new URL(request.url ?? '/', 'http://127.0.0.1').pathname.replace(/^\/superagent-board/, '') || '/')
  if (pathname === '/alias') {
    await aliasRoute(request, response)
    return
  }
  if (pathname === '/action') {
    await postProxy(request, response, '/board/action')
    return
  }
  if (pathname === '/team/action') {
    await postProxy(request, response, '/team/action')
    return
  }
  if (request.method !== 'GET') {
    response.writeHead(405)
    response.end()
    return
  }
  if (pathname === '/aliases.json') {
    const aliases = await readAliases()
    const data = Buffer.from(JSON.stringify(aliases))
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(data.length), 'cache-control': 'no-store' })
    response.end(data)
    return
  }
  if (pathname === '/board.json' || pathname === '/team.json' || pathname === '/work.json' || pathname === '/healthz') {
    await proxy(pathname, response)
    return
  }
  const asset = ASSETS[pathname] ?? ASSETS['/']!
  try {
    const data = await readFile(fileURLToPath(asset.file))
    response.writeHead(200, { 'content-type': asset.type, 'content-length': String(data.length), 'cache-control': 'no-store' })
    response.end(data)
  } catch {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('dsh-superagent-board: run npm run build to produce the board assets')
  }
}

/** Starts the aggregate endpoint, serves the iframe page, and registers both stops with the plugin fiber. */
export async function apply(ctx: BoardHostContext): Promise<void> {
  try {
    // Resolve the service lazily: the subagent runtime can activate after this plugin applies.
    const subagents = {
      listDescendants: (sessionId: string) => {
        const service = ctx.get?.('subagents') as { listDescendants?: (id: string) => Promise<never[]> } | undefined
        if (!service?.listDescendants) throw new Error('the subagent service is not mounted')
        return service.listDescendants(sessionId)
      },
    }
    const server = await startBoardServer({ subagents })
    const disposeRoute = ctx.webServer.register({ kind: 'prefix', path: '/superagent-board', handler })
    ctx.effect(() => async () => {
      disposeRoute()
      await server.close()
    })
  } catch (error) {
    ctx.logger.error('dsh-superagent-board: board server did not start: %s', String(error))
  }
}