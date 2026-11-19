#!/usr/bin/env node
/**
 * Acceptance smoke for the temporary workers under the lead card, runnable without DSH.
 *
 * Starts a fake superagent `/team` endpoint that returns three temporary workers plus the real board server
 * (built `lib/server.js`, with an injected board payload), serves the page from the same origin, opens it in
 * headless Chromium over CDP and checks the requested behaviour:
 *
 *   1. three running workers render as 临时工A/B/C card shells under the lead, each with its own ticket title
 *      and a visibly smaller, plainer look than a member card;
 *   2. ending one worker recomputes the remaining letters (the chosen rule: converge, never a gap or duplicate);
 *   3. a new worker then takes the last letter, so the current set is always A..N;
 *   4. no active worker means no temporary-worker block at all (no empty row, no reserved space).
 *
 * Data path exercised here: superagent `/team` `workers[]` → board `fetchSuperagentTeam` → aggregate
 * `workers` → `GET /team.json` → the iframe's 3 s roster poll → `renderTeam()`.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ARTIFACT = join(ROOT, 'artifacts', 'temp-workers.png')
const TOKEN = 'temp-workers-token'
const CHROME = [
  process.env.CHROME_PATH,
  '<your-home>/.cloakbrowser/chromium-146.0.7680.177.5/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(candidate => candidate !== undefined && existsSync(candidate))

const results = []
const check = (ok, label) => {
  results.push({ ok, label })
  console.log(ok ? 'PASS ' + label : 'FAIL ' + label)
  if (!ok) throw new Error(label)
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const listen = (server, port = 0) => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(port, '127.0.0.1', () => {
    server.off('error', reject)
    resolve(server.address().port)
  })
})
const listenPreferred = async (server, preferred) => {
  try {
    return await listen(server, preferred)
  } catch (error) {
    if (error.code === 'EADDRINUSE') return await listen(server, 0)
    throw error
  }
}
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

/** A free TCP port for Chrome's DevTools endpoint; the socket closes before Chrome binds it. */
const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer()
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => resolve(port))
  })
})

const TEAM_MAIN = { id: 'lead', name: 'lead', role: 'lead', state: 'working' }
const ROSTER = [
  { id: 't-1', name: '成员甲', role: '专项', state: 'idle', sessionId: 'teammate-1' },
]
const TICKETS = [
  { id: 'self-a', title: '临时任务 A：整理工单', state: 'executing', ownerMemberId: 'main', ownerKind: 'main', origin: 'self', updatedAt: '2026-11-11T08:00:00Z' },
  { id: 'self-b', title: '临时任务 B：修复分页', state: 'executing', ownerMemberId: 'main', ownerKind: 'main', origin: 'self', updatedAt: '2026-11-11T08:01:00Z' },
  { id: 'self-c', title: '临时任务 C：补截图', state: 'executing', ownerMemberId: 'main', ownerKind: 'main', origin: 'self', updatedAt: '2026-11-11T08:02:00Z' },
  { id: 'self-done', title: '临时任务 D：已完成', state: 'done', ownerMemberId: 'main', ownerKind: 'main', origin: 'self', updatedAt: '2026-11-11T07:00:00Z' },
]
const BOARD = {
  schemaVersion: 1,
  generatedAt: '2026-11-11T08:05:00Z',
  degraded: null,
  main: TEAM_MAIN,
  members: [],
  tickets: TICKETS,
}
const workerOf = (letter, startedAt) => ({
  sessionId: 'worker-self-' + letter,
  ticketId: 'self-' + letter,
  ticketTitle: TICKETS.find(ticket => ticket.id === 'self-' + letter).title,
  startedAt,
})
/** The running temporary workers the fake superagent `/team` reports; the page polls this every 3 s. */
let workers = [
  workerOf('a', '2026-11-11T08:00:00Z'),
  workerOf('b', '2026-11-11T08:01:00Z'),
  workerOf('c', '2026-11-11T08:02:00Z'),
]

const superagent = createServer(async (request, response) => {
  if (request.headers.authorization !== 'Bearer ' + TOKEN) {
    sendJson(response, 401, { ok: false, message: 'unauthorized' })
    return
  }
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  if (request.method === 'GET' && pathname === '/team') {
    sendJson(response, 200, { ok: true, teammates: ROSTER, workers })
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

async function waitFor(cdp, expression, predicate = value => value === true, timeout = 10000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await evaluate(cdp, expression)
    if (predicate(value)) return value
    await delay(100)
  }
  throw new Error('timed out: ' + expression)
}

/** The rendered temporary-worker cards: visible name, ticket, the row's own text and its shape. */
const readRows = cdp => evaluate(cdp, `Array.from(document.querySelectorAll('#team .temporary-workers .temp-card')).map(row => ({
  name: row.querySelector('.temp-card-name')?.textContent ?? '',
  title: row.querySelector('.temp-card-ticket')?.textContent ?? '',
  spans: row.querySelectorAll('span').length,
  buttons: row.querySelectorAll('button').length,
  avatars: row.querySelectorAll('.avatar').length,
  text: row.innerText.replace(/\\s+/g, ' ').trim(),
}))`)

async function main() {
  if (CHROME === undefined) throw new Error('no Chromium executable found; set CHROME_PATH')
  await mkdir(join(ROOT, 'artifacts'), { recursive: true })

  const superagentPort = await listenPreferred(superagent, 8916)
  const tokenFile = join(tmpdir(), 'board-temp-workers-token-' + process.pid)
  await writeFile(tokenFile, TOKEN + '\n', { mode: 0o600 })
  process.env.DSH_SUPERAGENT_ORIGIN = 'http://127.0.0.1:' + superagentPort
  process.env.DSH_SUPERAGENT_TOKEN_FILE = tokenFile
  const { startBoardServer } = await import(pathToFileURL(join(ROOT, 'lib/server.js')).href)
  const boardServer = await startBoardServer({ port: 0, fetchBoard: async () => BOARD })

  // Data path assertion before the page: the board endpoint forwards the worker rows unchanged.
  const teamJson = await (await fetch(boardServer.url + '/team.json')).json()
  check(Array.isArray(teamJson.workers) && teamJson.workers.length === 3, '/team.json carries the three runner rows')
  check(teamJson.workers.map(worker => worker.ticketId).join(',') === 'self-a,self-b,self-c', '/team.json keeps the host start order')
  const boardJson = await (await fetch(boardServer.url + '/board.json')).json()
  check(Array.isArray(boardJson.workers) && boardJson.workers.length === 3, '/board.json aggregate carries the same rows')

  const site = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (pathname === '/superagent-board/team.json') {
      await relay(await fetch(boardServer.url + '/team.json'), response)
      return
    }
    if (pathname === '/superagent-board/board.json') {
      await relay(await fetch(boardServer.url + '/board.json'), response)
      return
    }
    const asset = ASSETS[pathname]
    if (asset === undefined) { response.writeHead(404); response.end(); return }
    try {
      const data = await readFile(join(ROOT, asset[0]))
      response.writeHead(200, { 'content-type': asset[1], 'cache-control': 'no-store' })
      response.end(data)
    } catch {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('run npm run build first')
    }
  })
  const sitePort = await listen(site)
  const pageUrl = 'http://127.0.0.1:' + sitePort + '/superagent-board/'
  console.log('page ' + pageUrl + ' assets ' + JSON.stringify(Object.keys(ASSETS)))
  console.log('fake superagent :' + superagentPort + ', board ' + boardServer.url + ', page ' + pageUrl)

  const profile = await mkdtemp(join(tmpdir(), 'board-temp-workers-'))
  const debugPort = await freePort()
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, '--window-size=1280,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'] })

  let cdp
  try {
    let target
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await fetch('http://127.0.0.1:' + debugPort + '/json/new?url=' + encodeURIComponent('about:blank'), { method: 'PUT' })
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
    await cdp.send('Page.navigate', { url: pageUrl })
    await waitFor(cdp, "document.readyState === 'complete' && location.href.indexOf('/superagent-board/') !== -1")
    await waitFor(cdp, "document.querySelectorAll('#team .temp-card').length", value => value === 3)

    // 1. Three running workers: 临时工A/B/C under the lead, each a small card carrying its own ticket title.
    const rows = await readRows(cdp)
    check(rows.map(row => row.name).join(',') === '临时工A,临时工B,临时工C', 'three runners read 临时工A/B/C in start order')
    check(rows.map(row => row.title).join('|') === TICKETS.slice(0, 3).map(ticket => ticket.title).join('|'), 'each card shows its own ticket title')
    check(rows.every(row => row.avatars === 0 && row.buttons === 0), 'each card has no avatar or controls, only the letter and ticket title')
    check(rows.every(row => !/worker-self|self-[a-z]|\d{2}:\d{2}/.test(row.text)), 'no session id, clock or other extra text')
    const shape = await evaluate(cdp, `(() => {
      const box = element => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return { w: rect.width, h: rect.height, radius: style.borderTopLeftRadius, border: style.borderTopStyle, background: style.backgroundColor } }
      const cards = Array.from(document.querySelectorAll('#team .temporary-workers .temp-card'))
      const member = document.querySelector('#team .team-members .card')
      return { workers: cards.map(box), member: member === null ? null : box(member) }
    })()`)
    console.log('shape ' + JSON.stringify(shape))
    check(shape.workers.every(card => parseFloat(card.radius) > 0 && card.border === 'dashed'), 'each worker keeps a rounded card shell of its own')
    check(shape.member !== null && shape.workers.every(card => card.w <= shape.member.w + 0.5 && card.h < shape.member.h), 'the worker cards are no wider and visibly shorter than a member card')
    const stack = await evaluate(cdp, `(() => {
      const lead = document.querySelector('#team .team-lead .card').getBoundingClientRect()
      const rows = Array.from(document.querySelectorAll('#team .temporary-workers .temp-card')).map(row => row.getBoundingClientRect())
      return { leadBottom: lead.bottom, tops: rows.map(rect => rect.top), lefts: rows.map(rect => rect.left), leadLeft: lead.left }
    })()`)
    console.log('geometry ' + JSON.stringify(stack))
    // The lead card and the block share an edge; subpixel rounding can differ by a fraction between elements.
    check(stack.tops.every(top => top >= stack.leadBottom - 0.5), 'the runner block sits below the lead card')
    check(stack.tops.every((top, index) => index === 0 || top > stack.tops[index - 1]), 'cards stack in A, B, C order')
    const leadRect = await evaluate(cdp, `(() => { const rect = document.querySelector('#team .team-lead .card').getBoundingClientRect(); return { left: rect.left, width: rect.width } })()`)
    check(stack.lefts.every(left => left >= leadRect.left - 0.5 && left + 160 <= leadRect.left + leadRect.width + 20), 'the worker cards hang inside the lead column (' + JSON.stringify(leadRect) + ')')
    const gap = stack.tops[0] - stack.leadBottom
    check(gap >= 18, 'the first worker card keeps a clear gap under the lead (' + gap.toFixed(1) + ' px)')
    const branch = await evaluate(cdp, `(() => {
      const tree = document.querySelector('#team.team-tree')
      const box = tree.getBoundingClientRect()
      const lead = document.querySelector('#team .team-lead .card').getBoundingClientRect()
      const cards = Array.from(document.querySelectorAll('#team .temp-card')).map(card => card.getBoundingClientRect())
      const paths = Array.from(tree.querySelectorAll('.team-edges .edge-worker'))
      const box2 = path => { const rect = path.getBBox(); return { x: rect.x, y: rect.y, w: rect.width, h: rect.height, d: path.getAttribute('d') } }
      const ds = paths.map(path => path.getAttribute('d'))
      return {
        ds,
        lanes: cards.map(rect => Math.round(rect.top + rect.height / 2 - box.top)),
        leadBottom: lead.bottom - box.top,
        leadCentre: lead.left - box.left + lead.width / 2,
        cardLeft: cards[0].left - box.left,
        segmentLength: paths.reduce((sum, path) => sum + path.getTotalLength(), 0),
        cardLeft: cards[0].left - box.left,
        centres: cards.map(rect => Math.round(rect.left - box.left + rect.width / 2)),
        leadWidth: lead.width,
      }
    })()`)
    console.log('branch ' + JSON.stringify(branch))
    check(branch.ds.some(d => d.startsWith('M ' + branch.leadCentre.toFixed(1) + ' ')), 'the line leaves the lead bottom centre')
    // The run must stay on one x while it passes the rows above the deepest card, so no card is cut off.
    const runX = d => { const points = Array.from(d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)).map(match => ({ x: Number(match[1]), y: Number(match[2]) })); return { x: points[0].x, ys: points.map(point => point.y) } }
    check(new Set(branch.centres).size === 1, 'the worker cards share one centre line (' + JSON.stringify(branch.centres) + ')')
    check(Math.abs(branch.centres[0] - branch.leadCentre) < 2, 'the worker cards are centred on the lead column (' + branch.centres[0] + ' vs ' + branch.leadCentre.toFixed(1) + ')')
    const lanePoints = d => Array.from(d.matchAll(/L ([-\d.]+) ([-\d.]+)/g)).map(match => ({ x: Number(match[1]), y: Number(match[2]) }))
    const run = runX(branch.ds[0])
    check(new Set(run.ys.map(String)).size >= 2 && Math.abs(run.x - branch.centres[0]) < 2, 'the connector runs down the cards own centre line (' + run.x.toFixed(1) + ')')
    check(run.ys.some(y => Math.abs(y - branch.lanes[0]) < 1) && run.ys.some(y => Math.abs(y - branch.lanes[branch.lanes.length - 1]) < 1), 'the connector spans the first row to the last (' + JSON.stringify(branch.lanes) + ')')
    check(branch.segmentLength <= (branch.lanes[branch.lanes.length - 1] - branch.leadBottom) + Math.abs(branch.leadCentre - branch.centres[0]) + 24, 'the connector is a shortest-path run, not a detour (' + branch.segmentLength.toFixed(1) + ' px)')
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    await writeFile(ARTIFACT, Buffer.from(shot.data, 'base64'))
    console.log('screenshot ' + ARTIFACT)

    // 2. One worker ends (its ticket is gone): the remaining letters converge to A/B with no gap and no duplicate.
    workers = [workers[0], workers[2]]
    await waitFor(cdp, "document.querySelectorAll('#team .temp-card').length", value => value === 2)
    const afterEnd = await readRows(cdp)
    check(afterEnd.map(row => row.name).join(',') === '临时工A,临时工B', 'ending 临时工B leaves 临时工A/B with no gap')
    check(afterEnd.map(row => row.title).join('|') === [TICKETS[0].title, TICKETS[2].title].join('|'), 'the surviving cards keep their own tickets (C now reads 临时工B)')

    // 3. A new worker appears later: it takes the last letter, so the active set stays A..N.
    workers = [workers[0], workers[1], { sessionId: 'worker-self-e', ticketId: 'self-e', ticketTitle: '临时任务 E：新开工', startedAt: '2026-11-11T09:00:00Z' }]
    await waitFor(cdp, "document.querySelectorAll('#team .temp-card').length", value => value === 3)
    const afterJoin = await readRows(cdp)
    check(afterJoin.map(row => row.name).join(',') === '临时工A,临时工B,临时工C', 'a new runner takes the smallest free label after the active set')
    check(afterJoin[2].title === '临时任务 E：新开工', 'the newest card renders last with its ticket title')

    // 4. No active worker: the whole block disappears and leaves no placeholder or empty row.
    workers = []
    await waitFor(cdp, "document.querySelectorAll('#team .temp-card').length", value => value === 0)
    const empty = await evaluate(cdp, `({
      block: document.querySelectorAll('#team .temporary-workers').length,
      emptyText: document.querySelector('#team').innerText.includes('临时工'),
      leadChildren: document.querySelector('#team .team-lead')?.children.length ?? -1,
      cards: document.querySelectorAll('#team .team-lead .card').length,
    })`)
    check(empty.block === 0, 'no active runner means no temporary-worker block node')
    check(empty.emptyText === false && empty.leadChildren === 1 && empty.cards === 1, 'no placeholder, empty row or reserved space under the lead')

    console.log('PASS COUNT ' + results.length)
  } finally {
    if (cdp !== undefined) cdp.close()
    chrome.kill()
    await delay(500)
    await rm(profile, { recursive: true, force: true }).catch(() => {})
    await closeServer(site)
    await boardServer.close()
    await closeServer(superagent)
  }
}

main().catch(error => {
  console.error('SMOKE FAILED:', error instanceof Error ? error.message : error)
  for (const result of results) console.error(result.ok ? 'PASS' : 'FAIL', result.label)
  process.exitCode = 1
})
