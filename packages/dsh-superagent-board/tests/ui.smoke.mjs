#!/usr/bin/env node
/**
 * Acceptance smoke for the board page, runnable without DSH.
 *
 * Starts a fake superagent action endpoint and the real board server (the built lib/server.js, with an injected
 * `/team` roster and board payload), serves the page and its assets from a same-origin proxy, opens it in headless
 * Chromium over CDP, and exercises the roster rows, ticket groups, stop/retry and the degradation drill.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ARTIFACT = join(ROOT, 'artifacts', 'board-roster.png')
const TOKEN = 'smoke-token'
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

/** The same live roster shape superagent's `/team` returns; rows stay raw and the board server aliases them. */
const TEAM = {
  main: { id: 'lead', name: 'lead', role: 'lead', state: 'working' },
  members: [
    { id: 't-2e1ff2bc', name: 'DSH客户端', role: '任务板、侧栏与 DSH 客户端插件的唯一 owner（状态/别名/动效）', state: 'running', sessionId: 'teammate-ffdefb94f5a3' },
    { id: 't-45825318', name: '计算书技能', role: '计算书技能唯一 owner：脚本、模板、批量迁移、验证链', state: 'idle', sessionId: 'teammate-d10dd6a4d224' },
    { id: 't-edb003ec', name: '高斯专项', role: '高斯泼溅项目专项负责（保持原有范围）', state: 'stored', sessionId: 'teammate-c266672e0ef3' },
  ],
}
const BOARD = {
  schemaVersion: 1,
  generatedAt: '2026-11-06T16:40:00+08:00',
  degraded: null,
  main: TEAM.main,
  members: [],
  tickets: [
    { id: 'T1', title: '修微信收图', state: 'executing', ownerMemberId: 't-2e1ff2bc', updatedAt: new Date(Date.now() - 3 * 60 * 1000).toISOString(), summary: '已合并；等待复核' },
    { id: 'T2', title: '整理工单看板', state: 'done', ownerMemberId: 't-45825318', updatedAt: '2026-11-06T15:00:00+08:00', summary: '完成' },
  ],
}

/** The fake superagent's runtime roster; update/remove mutate this array so the page sees the result. */
const roster = TEAM.members.map(member => ({ ...member }))

let superagentUp = true
const superagent = createServer(async (request, response) => {
  if (request.headers.authorization !== 'Bearer ' + TOKEN) {
    sendJson(response, 401, { ok: false, message: 'unauthorized' })
    return
  }
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  if (request.method === 'GET' && pathname === '/team') {
    sendJson(response, 200, { ok: true, teammates: roster })
    return
  }
  if (request.method === 'POST' && pathname === '/team/action') {
    const body = JSON.parse((await readBody(request)).toString('utf8'))
    const index = roster.findIndex(member => member.id === body.id || member.name === body.id)
    if (index === -1) { sendJson(response, 404, { ok: false, message: '未知成员' }); return }
    if (body.action === 'update') {
      if (typeof body.name === 'string' && body.name.trim() !== '') roster[index].name = body.name.trim()
      if (typeof body.role === 'string' && body.role.trim() !== '') roster[index].role = body.role.trim()
      sendJson(response, 200, { ok: true, teammate: roster[index] })
      return
    }
    if (body.action === 'remove') {
      const [removed] = roster.splice(index, 1)
      sendJson(response, 200, { ok: true, removed })
      return
    }
    sendJson(response, 400, { ok: false, message: 'invalid team action' })
    return
  }
  if (request.method === 'POST' && pathname === '/board/action') {
    if (!superagentUp) { response.destroy(); return }
    const body = JSON.parse((await readBody(request)).toString('utf8'))
    if (body.kind === 'stop') sendJson(response, 200, { ok: true, message: '已停止' })
    else if (body.kind === 'retry') sendJson(response, 409, { ok: false, message: '工单已结束' })
    else sendJson(response, 404, { ok: false, message: '工单不存在' })
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

async function main() {
  if (CHROME === undefined) throw new Error('no Chromium executable found; set CHROME_PATH')
  await mkdir(join(ROOT, 'artifacts'), { recursive: true })

  const superagentPort = await listenPreferred(superagent, 8916)
  const tokenFile = join(tmpdir(), 'board-smoke-token-' + process.pid)
  await writeFile(tokenFile, TOKEN + '\n', { mode: 0o600 })
  // The built server reads both at import: point its actions at the fake superagent and its token at a temp file.
  process.env.DSH_SUPERAGENT_ORIGIN = 'http://127.0.0.1:' + superagentPort
  process.env.DSH_SUPERAGENT_TOKEN_FILE = tokenFile
  const { startBoardServer } = await import(pathToFileURL(join(ROOT, 'lib/server.js')).href)
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
      const upstream = await fetch(boardServer.url + '/board/action', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
      })
      await relay(upstream, response)
      return
    }
    if (pathname === '/superagent-board/team/action' && request.method === 'POST') {
      const body = await readBody(request)
      const upstream = await fetch(boardServer.url + '/team/action', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
      })
      await relay(upstream, response)
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
  console.log('fake superagent :' + superagentPort + ', board :' + boardServer.url + ', page ' + pageUrl)

  const profile = await mkdtemp(join(tmpdir(), 'board-smoke-'))
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=9223', '--user-data-dir=' + profile, '--window-size=1280,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'] })

  let cdp
  try {
    let target
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await fetch('http://127.0.0.1:9223/json/new?url=' + encodeURIComponent('about:blank'), { method: 'PUT' })
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
    await waitFor(cdp, "document.querySelectorAll('#team .card').length", value => value === 4)

    const teamText = await evaluate(cdp, "document.querySelector('#team').innerText")
    check((await evaluate(cdp, "document.querySelectorAll('#team .card').length")) === 4, 'roster renders the lead and three teammates')
    check(teamText.includes('DSH客户端') && teamText.includes('计算书技能') && teamText.includes('高斯专项'), 'member cards show the /team display names')
    check(teamText.includes('任务板、侧栏与 DSH 客户端插件'), 'member card shows the /team role')
    check(teamText.includes('修微信收图'), 'the active ticket fills 当前工单')
    check(teamText.includes('运行中') && teamText.includes('空闲') && teamText.includes('未启动'), 'running / idle / stored read from the roster')
    check(!teamText.includes('lodestar-owner') && !teamText.includes('local-source-dev'), 'old DSH agentTeam members are gone')
    check((await evaluate(cdp, "document.querySelector('#summary').textContent")) === '团队 3 成员 · 2 工单', 'summary counts the roster only')
    check(await evaluate(cdp, "document.querySelectorAll('.ticket-row').length") === 2, 'ticket rows render')

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    await writeFile(ARTIFACT, Buffer.from(shot.data, 'base64'))
    console.log('screenshot ' + ARTIFACT)

    check((await evaluate(cdp, "document.querySelector('#tickets').innerText")).includes('进行中') && (await evaluate(cdp, "document.querySelector('#tickets').innerText")).includes('待人工') && (await evaluate(cdp, "document.querySelector('#tickets').innerText")).includes('已结束'), 'tickets use the three task groups')
    check((await evaluate(cdp, "document.querySelector('#updated').textContent")).match(/^更新于 \d{2}:\d{2}:\d{2}$/) !== null, 'updated clock is HH:mm:ss')

    await evaluate(cdp, "document.querySelector('.ticket-row[data-ticket-id=\"T1\"]').click()")
    await waitFor(cdp, "document.querySelector('#detail').hidden === false")
    check(await evaluate(cdp, "document.querySelector('#detail').innerText.includes('修微信收图')"), 'clicking a row opens the detail panel')
    check(await evaluate(cdp, "document.querySelector('#detail [data-action=\"stop\"]') !== null && document.querySelector('#detail [data-action=\"retry\"]') === null"), 'active ticket only offers stop')
    await evaluate(cdp, "document.querySelector('#detail [data-action=\"stop\"]').click()")
    check((await evaluate(cdp, "document.querySelector('#detail [data-action=\"stop\"]').textContent")).includes('确认执行？'), 'first stop click arms the inline confirmation')
    await evaluate(cdp, "document.querySelector('#detail [data-action=\"stop\"]').click()")
    await waitFor(cdp, "document.querySelector('#detail [data-action=\"stop\"]').closest('.action-slot').querySelector('.action-result')?.textContent === '已停止'")
    check(true, 'second stop click returns 200 已停止 inline')

    await evaluate(cdp, "document.querySelector('.ticket-row[data-ticket-id=\"T2\"]').click()")
    check(await evaluate(cdp, "document.querySelector('#detail [data-action=\"retry\"]') !== null && document.querySelector('#detail [data-action=\"stop\"]') === null"), 'ended ticket only offers retry/result')
    await evaluate(cdp, "document.querySelector('#detail [data-action=\"retry\"]').click()")
    await evaluate(cdp, "document.querySelector('#detail [data-action=\"retry\"]').click()")
    await waitFor(cdp, "document.querySelector('#detail [data-action=\"retry\"]').closest('.action-slot').querySelector('.action-result')?.textContent === '工单已结束'")
    check(true, 'retry on a done ticket returns 409 工单已结束 inline')

    // Two roster polls must not rebuild the team DOM or leak intervals.
    BOARD.tickets[1].state = 'executing'
    BOARD.tickets[1].updatedAt = new Date().toISOString()
    // The row itself only shows the state word (执行中); the group bucket is what proves it moved.
    await waitFor(cdp, "document.querySelector('.group[data-bucket=\"active\"] .ticket-row[data-ticket-id=\"T2\"]') !== null", undefined, 7000)
    check(true, 'the 3s board poll refreshes a changed ticket state without a page reload')
    const before = await evaluate(cdp, "document.querySelectorAll('#team .card').length")
    await delay(3800)
    check(before === 4 && (await evaluate(cdp, "document.querySelectorAll('#team .card').length")) === 4, 'the 3s roster poll keeps four cards and never duplicates them')
    check(await evaluate(cdp, "(() => { const card = document.querySelector('#team .card.is-running'); const halo = getComputedStyle(card, '::after'); return halo.backgroundImage.includes('conic-gradient') && halo.animationName.includes('holoSpin') && halo.animationName.includes('haloBreath') && halo.animationDuration.includes('3.2s') && halo.filter.includes('blur') && !getComputedStyle(card).animationName.includes('holoPulse') })()"), 'the running card halo follows the holo border and breathes slowly')
    check(await evaluate(cdp, "(() => { const card = document.querySelector('#team .card.is-running'); const aura = card.querySelector('.card-aura'); const style = getComputedStyle(aura); return style.backgroundImage.includes('conic-gradient') && style.animationName.includes('holoSpin') && style.animationName.includes('innerBreath') && style.filter.includes('blur') })()"), 'the same holo colours wash the inside card edge')
    check(await evaluate(cdp, "(() => { const edge = document.querySelector('.edge.edge-live'); return edge !== null && getComputedStyle(edge).stroke === 'rgb(251, 188, 5)' && document.querySelectorAll('.edge-comet').length === 0 })()"), 'running lines are solid Google yellow and the old comet is gone')
    await waitFor(cdp, "document.querySelector('.edge-signal') !== null", undefined, 8000)
    check(await evaluate(cdp, "(() => { const signal = document.querySelector('.edge-signal'); if (signal === null) return false; const path = signal.querySelector('textPath'); const fill = path?.getAttribute('fill') ?? ''; const id = fill.match(/#([^)]+)/)?.[1]; const gradient = id ? document.getElementById(id) : null; const stops = gradient ? Array.from(gradient.querySelectorAll('stop')).map(stop => stop.getAttribute('stop-color')) : []; return /^[01]+$/.test(signal.textContent) && signal.textContent.length >= 12 && getComputedStyle(signal).fontSize === '11px' && signal.getBBox().width > 0 && signal.querySelector('tspan') !== null && stops.length === 5 && stops[0] === stops[4] })()"), 'random long 0/1 signal strings travel on running lines with a seamless gradient')

    // No permanent member buttons; the right-click menu owns rename/delete.
    check(await evaluate(cdp, "document.querySelectorAll('#team .member-actions').length === 0 && document.querySelectorAll('#team [data-team-action]').length === 0"), 'member cards carry no permanent rename/delete buttons')
    const emulation = async width => {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
      await delay(150)
    }
    const leadMemberGap = () => evaluate(cdp, "(() => { const lead = document.querySelector('.card-lead').getBoundingClientRect(); const member = document.querySelector('.team-members .card').getBoundingClientRect(); return Math.round(member.left - lead.right) })()")
    await emulation(1024)
    const narrowGap = await leadMemberGap()
    await emulation(1600)
    const wideGap = await leadMemberGap()
    check(wideGap > narrowGap + 10, 'the lead↔members horizontal gap grows with the window')
    await emulation(1280)

    await evaluate(cdp, "(() => { const card = document.querySelector('.card[data-member-id=\"t-2e1ff2bc\"]'); const r = card.getBoundingClientRect(); return card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 30 })) })()")
    await waitFor(cdp, "document.querySelector('#context-menu').hidden === false")
    await evaluate(cdp, "document.querySelector('#context-menu [data-menu-action=\"rename\"]').click()")
    await waitFor(cdp, "document.querySelector('#rename-dialog').hidden === false")
    check((await evaluate(cdp, "document.querySelector('#rename-name').value")) === 'DSH客户端', 'rename dialog prefills the roster name')
    await evaluate(cdp, "document.querySelector('#rename-name').value = 'DSH客户端改'; document.querySelector('#rename-role').value = '任务板 owner（已改）'; document.querySelector('#rename-form').requestSubmit()")
    await waitFor(cdp, "document.querySelector('#team').innerText.includes('DSH客户端改')")
    check((await evaluate(cdp, "document.querySelector('#team').innerText")).includes('任务板 owner（已改）'), 'rename applies through /team update immediately')
    check((await evaluate(cdp, "document.querySelector('#rename-dialog').hidden")) === true, 'rename dialog closes after success')
    check((await evaluate(cdp, "document.querySelector('#toast').textContent")) === '已重命名', 'rename shows the success toast')

    await evaluate(cdp, "(() => { const card = document.querySelector('.card[data-member-id=\"t-edb003ec\"]'); const r = card.getBoundingClientRect(); return card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 30 })) })()")
    await waitFor(cdp, "document.querySelector('#context-menu').hidden === false")
    await evaluate(cdp, "document.querySelector('#context-menu [data-menu-action=\"delete\"]').click()")
    await waitFor(cdp, "document.querySelector('#delete-dialog').hidden === false")
    check((await evaluate(cdp, "document.querySelector('#delete-dialog').innerText")).includes('高斯专项'), 'delete dialog names the target member')
    await evaluate(cdp, "document.querySelector('#delete-confirm').click()")
    await waitFor(cdp, "document.querySelectorAll('#team .card').length", value => value === 3)
    check(!(await evaluate(cdp, "document.querySelector('#team').innerText")).includes('高斯专项'), 'delete removes the member from the board')
    check((await evaluate(cdp, "document.querySelector('#summary').textContent")) === '团队 2 成员 · 2 工单', 'summary follows the roster after delete')

    superagentUp = false
    await evaluate(cdp, "document.querySelector('#refresh').click()")
    await delay(1500)
    check((await evaluate(cdp, "document.body.innerText")).includes('数据源中断'), 'degraded banner appears when the ticket source is down')
    check((await evaluate(cdp, "document.querySelectorAll('#team .card').length")) === 3, 'the roster stays visible while tickets are down')
    check(await evaluate(cdp, "document.querySelectorAll('.ticket-row').length") === 2, 'stale ticket rows remain visible during degradation')

    superagentUp = true
    await evaluate(cdp, "document.querySelector('#refresh').click()")
    await delay(1500)
    check(!(await evaluate(cdp, "document.body.innerText")).includes('数据源中断'), 'refresh recovers after the ticket source returns')

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
