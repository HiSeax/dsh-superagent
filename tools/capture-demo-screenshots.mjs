#!/usr/bin/env node
/**
 * Capture demo screenshots of the board page for the public GitHub repo.
 *
 * Runs fully isolated on this machine:
 *   - a fake superagent `/team` endpoint (fictional demo roster) on a random 127.0.0.1 high port,
 *   - the real built board server `lib/server.js` on a random port, fed a fictional board payload,
 *   - a same-origin proxy that serves the page + its static assets and relays the JSON endpoints,
 *   - headless Chromium driven over CDP (no visible window), capturing PNGs into docs/screenshots.
 *
 * All data is fabricated and clearly demo-flavoured (teammates Atlas / Nova / Orion / Vega, project
 * `demo-widgets`, generic ticket titles). Nothing real, no production DSH (port 3080) is touched and
 * no host process is killed: every temp dir and server is torn down in the `finally` block.
 *
 * Output (4 PNGs, deviceScaleFactor 2):
 *   board-overview.png      lead card + teammate cards + grouped tickets
 *   board-ticket-card.png   one ticket selected -> detail panel (title / state / id / owner / scope)
 *   board-teammates.png     the teammates list region (Nova / Orion / Vega cards)
 *   board-needs-person.png  the ticket groups with the 待人工 column holding blocked tickets
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const PACKAGE = join(REPO, 'packages', 'dsh-superagent-board')
const OUT_DIR = join(REPO, 'docs', 'screenshots')
const TOKEN = 'demo-capture-token'
const VIEWPORT = { width: 1440, height: 1200 }
const SCALE = 2

const CHROME = [
  process.env.CHROME_PATH,
  '<your-home>/.cloakbrowser/chromium-146.0.7680.177.5/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(candidate => candidate !== undefined && existsSync(candidate))

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const listen = (server, port = 0) => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(port, '127.0.0.1', () => {
    server.off('error', reject)
    resolve(server.address().port)
  })
})
const closeServer = server => new Promise(resolve => server.close(() => resolve()))
const readBody = request => new Promise((resolve, reject) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => resolve(Buffer.concat(chunks)))
  request.on('error', reject)
})
const sendJson = (response, status, body) => {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)) })
  response.end(text)
}
const relay = async (upstream, response) => {
  const body = Buffer.from(await upstream.arrayBuffer())
  response.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
    'content-length': String(body.length),
  })
  response.end(body)
}

/* ------------------------------------------------------------------ *
 * Fictional demo data (nothing real). Project: demo-widgets.         *
 * ------------------------------------------------------------------ */

const TEAM_MAIN = { id: 'lead', name: 'lead', role: 'lead', state: 'working' }

const ROSTER = [
  { id: 'demo-atlas', name: 'Atlas', role: 'Frontend owner · board widgets', state: 'running', sessionId: 'teammate-demo-atlas' },
  { id: 'demo-nova', name: 'Nova', role: 'Backend owner · export service', state: 'idle', sessionId: 'teammate-demo-nova' },
  { id: 'demo-orion', name: 'Orion', role: 'CI & release owner', state: 'running', sessionId: 'teammate-demo-orion' },
  { id: 'demo-vega', name: 'Vega', role: 'QA owner', state: 'stored', sessionId: 'teammate-demo-vega' },
]

const hoursAgo = hours => new Date(Date.now() - hours * 3600 * 1000).toISOString()

const TICKETS = [
  {
    id: 'DEMO-101', title: 'Fix timezone handling in export button', state: 'executing',
    ownerMemberId: 'demo-atlas', updatedAt: hoursAgo(0.2),
    summary: 'Auth scope: demo-widgets:read,write. Rewriting the export button to use UTC internally and the viewer locale on render.',
  },
  {
    id: 'DEMO-102', title: 'Add retry button to board', state: 'done',
    ownerMemberId: 'demo-nova', updatedAt: hoursAgo(3),
    summary: 'Auth scope: demo-widgets:write. Retry action shipped behind the board action endpoint; covered by unit tests.',
  },
  {
    id: 'DEMO-103', title: 'Investigate flaky CI on main', state: 'blocked',
    ownerMemberId: 'demo-orion', updatedAt: hoursAgo(1),
    summary: 'Auth scope: demo-widgets:read. Needs a human call on whether to quarantine or split the failing suite.',
  },
  {
    id: 'DEMO-104', title: 'Fix wrong date shown in export preview', state: 'blocked',
    ownerMemberId: 'demo-vega', updatedAt: hoursAgo(2),
    summary: 'Auth scope: demo-widgets:read. Blocked on missing demo-widgets fixture credentials — needs a human to provision.',
  },
  {
    id: 'DEMO-105', title: 'Investigate slow board refresh', state: 'executing',
    ownerMemberId: 'main', ownerKind: 'main', origin: 'self', updatedAt: hoursAgo(0.5),
    summary: 'Auth scope: demo-widgets:read. Profiling the 3 s poll path on a local demo instance.',
  },
  {
    id: 'DEMO-106', title: 'Write onboarding guide for demo-widgets', state: 'review',
    ownerMemberId: 'main', ownerKind: 'main', origin: 'self', updatedAt: hoursAgo(6),
    summary: 'Auth scope: demo-widgets:read. Draft ready — waiting on a human reviewer.',
  },
]

const BOARD = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  degraded: null,
  main: TEAM_MAIN,
  members: ROSTER.map(member => ({ ...member })),
  tickets: TICKETS,
}

/** The live roster the fake superagent reports; the page polls it every 3 s. */
const roster = ROSTER.map(member => ({ ...member }))
let superagentUp = true

const superagent = createServer(async (request, response) => {
  if (request.headers.authorization !== 'Bearer ' + TOKEN) {
    sendJson(response, 401, { ok: false, message: 'unauthorized' })
    return
  }
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  if (request.method === 'GET' && pathname === '/team') {
    sendJson(response, 200, { ok: true, teammates: roster, workers: [] })
    return
  }
  if (request.method === 'POST' && pathname === '/team/action') {
    const body = JSON.parse((await readBody(request)).toString('utf8'))
    const index = roster.findIndex(member => member.id === body.id || member.name === body.id)
    if (index === -1) { sendJson(response, 404, { ok: false, message: 'unknown member' }); return }
    if (body.action === 'update') {
      if (typeof body.name === 'string' && body.name.trim() !== '') roster[index].name = body.name.trim()
      if (typeof body.role === 'string' && body.role.trim() !== '') roster[index].role = body.role.trim()
      sendJson(response, 200, { ok: true, teammate: roster[index] })
      return
    }
    sendJson(response, 400, { ok: false, message: 'invalid team action' })
    return
  }
  sendJson(response, 404, { ok: false, message: 'not found' })
})

const ASSETS = {
  '/superagent-board/': ['src/web/index.html', 'text/html; charset=utf-8'],
  '/superagent-board/index.html': ['src/web/index.html', 'text/html; charset=utf-8'],
  '/superagent-board/app.js': ['src/web/app.js', 'text/javascript; charset=utf-8'],
  '/superagent-board/tokens.css': ['src/web/tokens.css', 'text/css; charset=utf-8'],
}

/* ------------------------------------------------------------------ *
 * Minimal CDP client over the DevTools WebSocket.                    *
 * ------------------------------------------------------------------ */

class Cdp {
  constructor(url) {
    this.next = 1
    this.pending = new Map()
    this.socket = new WebSocket(url)
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true })
      this.socket.addEventListener('error', reject, { once: true })
    })
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      const pending = this.pending.get(message.id)
      if (pending === undefined) return
      this.pending.delete(message.id)
      if (message.error === undefined) pending.resolve(message.result)
      else pending.reject(new Error(message.error.message))
    })
  }
  send(method, params = {}) {
    const id = this.next++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  close() { this.socket.close() }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails !== undefined) throw new Error('page exception: ' + JSON.stringify(result.exceptionDetails))
  return result.result.value
}

async function waitFor(cdp, expression, predicate = value => value === true, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await evaluate(cdp, expression)
    if (predicate(value)) return value
    await delay(100)
  }
  throw new Error('timed out: ' + expression)
}

/** Wait until the page is complete and the skeleton placeholders are gone, then let animations settle. */
async function networkIdle(cdp, settleMs = 500, timeout = 10000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const busy = await evaluate(cdp, `document.readyState !== 'complete' || document.querySelectorAll('.skeleton-card, .skeleton-column').length > 0`)
    if (!busy) {
      await delay(settleMs)
      return
    }
    await delay(100)
  }
  throw new Error('page never reached an idle, skeleton-free state')
}

/** Screenshot a CSS-pixel box (clipped to the document) at the configured device scale factor. */
async function shoot(cdp, clip, file, label) {
  const params = { format: 'png', captureBeyondViewport: true }
  if (clip !== null) {
    const box = await evaluate(cdp, `(() => {
      const de = document.documentElement
      return { sw: de.scrollWidth, sh: de.scrollHeight }
    })()`)
    const x = Math.max(0, clip.x)
    const y = Math.max(0, clip.y)
    const width = Math.min(clip.width, box.sw - x)
    const height = Math.min(clip.height, box.sh - y)
    if (width <= 0 || height <= 0) throw new Error('empty clip for ' + label)
    params.clip = { x, y, width, height, scale: SCALE }
  } else {
    params.captureBeyondViewport = true
  }
  const shot = await cdp.send('Page.captureScreenshot', params)
  await writeFile(file, Buffer.from(shot.data, 'base64'))
  const bytes = (await stat(file)).size
  console.log('captured ' + label + ' -> ' + file + ' (' + bytes + ' bytes)')
  return file
}

/** Bounding box of an element, in CSS pixels, relative to the document. */
const rectOf = (cdp, selector) => evaluate(cdp, `(() => {
  const el = document.querySelector(${JSON.stringify(selector)})
  if (el === null) throw new Error('missing ' + ${JSON.stringify(selector)})
  const r = el.getBoundingClientRect()
  return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height }
})()`)

async function main() {
  if (CHROME === undefined) throw new Error('no Chromium executable found; set CHROME_PATH')
  await mkdir(OUT_DIR, { recursive: true })

  const superagentPort = await listen(superagent)
  const tokenFile = join(tmpdir(), 'board-demo-token-' + process.pid)
  await writeFile(tokenFile, TOKEN + '\n', { mode: 0o600 })
  // The built server reads both at import: point its actions at the fake superagent and its token at a temp file.
  process.env.DSH_SUPERAGENT_ORIGIN = 'http://127.0.0.1:' + superagentPort
  process.env.DSH_SUPERAGENT_TOKEN_FILE = tokenFile
  const { startBoardServer } = await import(pathToFileURL(join(PACKAGE, 'lib', 'server.js')).href)
  const boardServer = await startBoardServer({
    port: 0,
    fetchBoard: async () => superagentUp ? BOARD : null,
  })

  const site = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (pathname === '/superagent-board/board.json' && request.method === 'GET') {
      await relay(await fetch(boardServer.url + '/board.json'), response)
      return
    }
    if (pathname === '/superagent-board/team.json' && request.method === 'GET') {
      await relay(await fetch(boardServer.url + '/team.json'), response)
      return
    }
    if (pathname === '/superagent-board/work.json' && request.method === 'GET') {
      await relay(await fetch(boardServer.url + '/work.json'), response)
      return
    }
    if (pathname === '/superagent-board/action' && request.method === 'POST') {
      const body = await readBody(request)
      await relay(await fetch(boardServer.url + '/board/action', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
      }), response)
      return
    }
    if (pathname === '/superagent-board/team/action' && request.method === 'POST') {
      const body = await readBody(request)
      await relay(await fetch(boardServer.url + '/team/action', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
      }), response)
      return
    }
    const asset = ASSETS[pathname]
    if (asset === undefined) { response.writeHead(404); response.end(); return }
    try {
      const data = await readFile(join(PACKAGE, asset[0]))
      response.writeHead(200, { 'content-type': asset[1], 'cache-control': 'no-store' })
      response.end(data)
    } catch {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('run npm run build first')
    }
  })
  const sitePort = await listen(site)
  const pageUrl = 'http://127.0.0.1:' + sitePort + '/superagent-board/'

  const profile = await mkdtemp(join(tmpdir(), 'board-demo-capture-'))
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--remote-debugging-port=18322', '--user-data-dir=' + profile,
    '--window-size=' + VIEWPORT.width + ',' + VIEWPORT.height, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'] })

  let cdp
  try {
    let target
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await fetch('http://127.0.0.1:18322/json/new?url=' + encodeURIComponent('about:blank'), { method: 'PUT' })
        target = await response.json()
        break
      } catch {
        await delay(100)
      }
    }
    if (target === undefined) throw new Error('chromium did not open a debugging endpoint')

    cdp = new Cdp(target.webSocketDebuggerUrl)
    await cdp.open()
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: SCALE, mobile: false })
    await cdp.send('Page.navigate', { url: pageUrl })
    await waitFor(cdp, "document.readyState === 'complete' && location.href.indexOf('/superagent-board/') !== -1")
    // The roster poll renders the lead + four teammates; the board poll renders the ticket rows.
    await waitFor(cdp, "document.querySelectorAll('#team .card').length", value => value === 5)
    await waitFor(cdp, "document.querySelectorAll('.ticket-row').length", value => value === 6)
    await networkIdle(cdp)

    // Tickets render at boot before the /team roster poll lands, and the ticket render signature does not
    // include the roster, so owner labels would otherwise stay 未分配. Nudge one ticket's updatedAt so the
    // 3 s board poll re-renders the ticket groups once the roster is known, resolving owners to demo names.
    BOARD.tickets[0].updatedAt = new Date().toISOString()
    await waitFor(cdp, "document.querySelector('.ticket-row[data-ticket-id=\"DEMO-101\"] .ticket-owner').textContent",
      value => typeof value === 'string' && value.includes('Atlas'), 12000)
    await networkIdle(cdp)
    await delay(600)

    // 1. Board overview: lead card + teammate cards + the three ticket groups.
    await shoot(cdp, null, join(OUT_DIR, 'board-overview.png'), 'board-overview')

    // 2. Ticket card focus: select the blocked CI ticket and open its detail panel.
    await evaluate(cdp, "document.querySelector('.ticket-row[data-ticket-id=\"DEMO-103\"]').click()")
    await waitFor(cdp, "document.querySelector('#detail').hidden === false")
    await waitFor(cdp, "document.querySelector('#detail h3').textContent", value => value === 'Investigate flaky CI on main')
    await networkIdle(cdp)
    await delay(400)
    await shoot(cdp, null, join(OUT_DIR, 'board-ticket-card.png'), 'board-ticket-card')
    // Close the panel so later shots are unaffected.
    await evaluate(cdp, "document.querySelector('#detail [data-close-detail]').click()")
    await waitFor(cdp, "document.querySelector('#detail').hidden === true")

    // 3. Teammates list view: crop the #team region (lead + four teammate cards).
    const teamRect = await rectOf(cdp, '#team')
    await shoot(cdp, teamRect, join(OUT_DIR, 'board-teammates.png'), 'board-teammates')

    // 4. Needs-person view: the ticket groups, with the 待人工 column holding the two blocked tickets.
    const ticketsRect = await rectOf(cdp, '#tickets')
    await shoot(cdp, ticketsRect, join(OUT_DIR, 'board-needs-person.png'), 'board-needs-person')

    console.log('DONE 4 screenshots in ' + OUT_DIR)
  } finally {
    if (cdp !== undefined) cdp.close()
    chrome.kill()
    await delay(500)
    await rm(profile, { recursive: true, force: true }).catch(() => {})
    await closeServer(site)
    await boardServer.close()
    await closeServer(superagent)
    await rm(tokenFile, { force: true }).catch(() => {})
  }
}

main().catch(error => {
  console.error('CAPTURE FAILED:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
