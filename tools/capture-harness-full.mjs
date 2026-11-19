#!/usr/bin/env node
/**
 * Capture the full-window "DSH Harness + Superagent" demo composition.
 *
 * The window is assembled as the real DSH three-column shell:
 *   - left   (280px)  DSH sidebar: deepseek/HARNESS lockup, new-session pill, 插件/Superagent/
 *                     自动化任务/更多 nav, 工作区 tree (demo projects) and neutral demo footer;
 *   - centre (~50%)   DSH conversation: one user instruction bubble + one rich-text receipt bubble,
 *                     a thin session title row and a bottom composer;
 *   - right  (~30%)   the real DSH Superagent panel head (title, search, 打开主 Session, six tabs)
 *                     above the **real** board, loaded from this demo origin in an iframe.
 *
 * Why a shell page: this repository ships the board panel and the orchestrator plugin, not a runnable
 * DSH Web UI fixture. Capturing the live host would mean touching the production port and real session
 * data, so the left sidebar and centre conversation are synthesized here with fictional content. The
 * right column is the real board server + real client app, compacted by injected CSS to fit 30%.
 *
 * Isolation, like tools/capture-demo-screenshots.mjs:
 *   - a fake superagent `/team` endpoint (fictional demo roster) on a random 127.0.0.1 port,
 *   - the real built board server `lib/server.js` on a random port, fed a fictional board payload,
 *   - a same-origin site that serves `/harness.html`, the board's static assets and relays its endpoints,
 *   - headless Chromium over CDP with a throw-away profile, at deviceScaleFactor 2.
 *
 * All data is fabricated: teammates Atlas / Nova / Orion / Vega / Helios, projects demo-widgets /
 * example-service, generic ticket copy. No production DSH host port is touched, no host process is
 * killed, nothing is installed, no git command runs, and every server / temp dir / browser is torn
 * down in the `finally` block.
 *
 * Output: docs/screenshots/harness-full.png (1440x1000 logical, 2880x2000 device pixels).
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const PACKAGE = join(REPO, 'packages', 'dsh-windows-superagent-board')
const OUT_DIR = join(REPO, 'docs', 'screenshots')
const OUT_FILE = join(OUT_DIR, 'harness-full.png')
const TOKEN = 'demo-capture-token'
const VIEWPORT = { width: 1440, height: 1000 }
const SCALE = 2

const CHROME = [
  process.env.CHROME_PATH,
  join(homedir(), '.cloakbrowser', 'chromium-146.0.7680.177.5', 'chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
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
 * Fictional demo data (nothing real).                                *
 * ------------------------------------------------------------------ */

const TEAM_MAIN = { id: 'lead', name: 'lead', role: 'lead', state: 'working' }

const ROSTER = [
  { id: 'demo-atlas', name: 'Atlas', role: 'Frontend owner · board widgets', state: 'running', sessionId: 'teammate-demo-atlas' },
  { id: 'demo-nova', name: 'Nova', role: 'Backend owner · export service', state: 'idle', sessionId: 'teammate-demo-nova' },
  { id: 'demo-orion', name: 'Orion', role: 'CI & release owner', state: 'running', sessionId: 'teammate-demo-orion' },
  { id: 'demo-vega', name: 'Vega', role: 'QA owner', state: 'stored', sessionId: 'teammate-demo-vega' },
  { id: 'demo-helios', name: 'Helios', role: 'Docs & developer experience', state: 'running', sessionId: 'teammate-demo-helios' },
]

const hoursAgo = hours => new Date(Date.now() - hours * 3600 * 1000).toISOString()

const TICKETS = [
  {
    id: 'DEMO-101', title: 'Fix timezone handling in export button', state: 'done',
    ownerMemberId: 'demo-atlas', updatedAt: hoursAgo(0.15),
    summary: 'Auth scope: demo-widgets:read,write. Export button now computes in UTC and renders in the viewer locale; covered by six cross-timezone cases.',
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
    id: 'DEMO-105', title: 'Polish empty state for board list', state: 'executing',
    ownerMemberId: 'demo-atlas', updatedAt: hoursAgo(0.4),
    summary: 'Auth scope: demo-widgets:write. Tightening the empty-state copy and spacing in the board list.',
  },
  {
    id: 'DEMO-106', title: 'Write onboarding guide for demo-widgets', state: 'review',
    ownerMemberId: 'main', ownerKind: 'main', origin: 'self', updatedAt: hoursAgo(6),
    summary: 'Auth scope: demo-widgets:read. Draft ready — waiting on a human reviewer.',
  },
  {
    id: 'DEMO-107', title: 'Speed up board refresh polling', state: 'executing',
    ownerMemberId: 'demo-helios', updatedAt: hoursAgo(0.8),
    summary: 'Auth scope: example-service:read. Measuring the 3 s polling path on the example-service demo instance.',
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

/** The live roster the fake superagent reports; the board polls it every 3 s. */
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
 * The shell page: three columns composed from plain HTML/CSS.        *
 * ------------------------------------------------------------------ */

const HARNESS_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH Harness · Superagent（演示）</title>
<style>
:root {
  --ink: #0f1115;
  --muted: #61666b;
  --faint: #81858c;
  --time: #b3b3b8;
  --line: rgba(15, 17, 21, .08);
  --hairline: rgba(15, 17, 21, .06);
  --sidebar: #f7f7f8;
  --row-active: #eceef0;
  --accent: #3178ff;
  --green: #188038;
  --red: #e5484d;
}
* { box-sizing: border-box; }
html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
body {
  background: #fff;
  color: var(--ink);
  font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
svg { display: block; }
.workspace { height: 100vh; display: grid; grid-template-columns: 280px 50% 1fr; overflow: hidden; }

/* ---------------- left: DSH shell sidebar ---------------- */
.sidebar {
  display: flex; flex-direction: column; min-width: 0;
  padding: 12px 10px 10px;
  background: var(--sidebar);
  border-right: 1px solid var(--hairline);
  overflow: hidden;
}
.side-head { display: flex; align-items: center; gap: 7px; height: 30px; padding: 0 4px; }
.whale { width: 23px; height: 23px; flex: none; color: #111827; }
.logo-text { font-size: 17px; font-weight: 700; letter-spacing: -.03em; color: #101418; }
.logo-badge {
  padding: 3px 5px; border-radius: 4px;
  background: #101418; color: #fff;
  font-size: 8px; font-weight: 600; letter-spacing: .12em; line-height: 1;
  transform: translateY(1px);
}
.collapse { margin-left: auto; width: 16px; height: 16px; color: #8a8a90; flex: none; }
.new-session {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  width: 100%; height: 38px; margin-top: 10px;
  border: 1px solid rgba(15, 17, 21, .1); border-radius: 10px;
  background: #fff; color: var(--ink);
  font: inherit; font-size: 13px;
}
.new-session svg { width: 15px; height: 15px; color: #6b6b72; }
.nav { display: flex; flex-direction: column; gap: 2px; margin-top: 12px; }
.nav-item {
  display: flex; align-items: center; gap: 10px;
  height: 34px; padding: 0 10px; border-radius: 8px;
  font-size: 13px; color: #3c3c43;
}
.nav-item svg { width: 16px; height: 16px; color: #5f6368; flex: none; }
.nav-item.active { background: var(--row-active); color: var(--ink); font-weight: 500; }
.ws-head {
  display: flex; align-items: center; justify-content: space-between;
  margin: 18px 6px 4px;
  font-size: 11.5px; color: #9a9a9f;
}
.ws-actions { display: flex; align-items: center; gap: 9px; color: #8a8a90; }
.ws-actions svg { width: 15px; height: 15px; }
.ws-tree { display: flex; flex-direction: column; }
.ws-row {
  display: flex; align-items: center; gap: 8px;
  height: 30px; padding: 0 8px; border-radius: 6px;
  font-size: 13px; color: #3c3c43; white-space: nowrap;
}
.ws-row svg { width: 15px; height: 15px; flex: none; }
.ws-row.indent { padding-left: 32px; color: var(--ink); }
.ws-row .time { margin-left: auto; font-size: 11px; color: var(--time); font-variant-numeric: tabular-nums; }
.side-foot {
  display: flex; align-items: center; gap: 8px;
  margin-top: auto; padding: 8px 4px 2px;
  border-top: 1px solid var(--hairline);
}
.avatar-neutral {
  width: 24px; height: 24px; border-radius: 50%; flex: none;
  display: flex; align-items: center; justify-content: center;
  background: linear-gradient(145deg, #dfe3ea, #c6ccd8);
  color: #5c6472; font-size: 10px; font-weight: 700;
}
.foot-text { display: flex; flex-direction: column; line-height: 1.3; min-width: 0; }
.foot-text strong { font-size: 11px; font-weight: 600; }
.foot-text span { font-size: 9.5px; color: #9a9a9f; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* ---------------- middle: DSH conversation ---------------- */
.chat {
  display: flex; flex-direction: column; min-width: 0;
  background: #fff;
  border-right: 1px solid var(--hairline);
  overflow: hidden;
}
.chat-head {
  flex: none; height: 46px;
  display: flex; align-items: center; gap: 10px;
  padding: 0 18px;
  border-bottom: 1px solid var(--hairline);
  background: #fff;
}
.chat-title { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.chat-title strong { font-size: 13px; font-weight: 600; }
.chat-title span { display: flex; align-items: center; gap: 5px; font-size: 10.5px; color: var(--muted); }
.pulse { width: 6px; height: 6px; border-radius: 50%; background: #2e9e5b; box-shadow: 0 0 0 3px rgba(46, 158, 91, .12); }
.chat-chip { margin-left: auto; padding: 2px 8px; border-radius: 999px; background: #f2f3f5; border: 1px solid rgba(15, 17, 21, .05); color: #8a8a90; font-size: 10px; }
.chat-body { flex: 1; overflow: hidden; padding: 20px 28px 8px; display: flex; flex-direction: column; }
.chat-thread { width: 100%; max-width: 640px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
.day-divider { display: flex; align-items: center; gap: 10px; color: #a8a8ae; font-size: 10.5px; }
.day-divider::before, .day-divider::after { content: ""; height: 1px; flex: 1; background: var(--hairline); }
.msg.user { align-self: flex-end; max-width: 78%; display: flex; flex-direction: column; align-items: flex-end; gap: 5px; }
.bubble.user {
  padding: 11px 15px; border-radius: 14px 14px 4px 14px;
  background: linear-gradient(180deg, #3d84ff, #3178ff);
  color: #fff; font-size: 13px; line-height: 1.65;
  box-shadow: 0 4px 14px rgba(49, 120, 255, .16);
}
.bubble.user code { background: rgba(255, 255, 255, .2); color: #fff; border-radius: 4px; padding: 1px 4px; font-size: 11.5px; }
.bubble.user b, .bubble.user code { white-space: nowrap; }
.msg-meta { font-size: 10px; color: #a1a1a6; padding-right: 3px; }
.msg.agent { display: flex; align-items: flex-start; gap: 10px; max-width: 92%; }
.avatar.small {
  width: 28px; height: 28px; border-radius: 50%; flex: none; margin-top: 2px;
  display: flex; align-items: center; justify-content: center;
  background: #f1f4f9; border: 1px solid #e3e8f0;
  color: #4b5b72; font-size: 11px; font-weight: 700;
}
.msg-main { min-width: 0; }
.msg-name { display: flex; align-items: baseline; gap: 7px; margin: 0 0 5px 2px; font-size: 10.5px; color: #8e8e93; }
.msg-time { color: #b3b3b8; font-size: 9.5px; }
.bubble.agent {
  padding: 15px 17px 14px;
  background: #fff; border: 1px solid #e8e8ec;
  border-radius: 14px 14px 14px 4px;
  box-shadow: 0 1px 2px rgba(16, 24, 40, .04), 0 10px 30px rgba(16, 24, 40, .04);
}
.bubble.agent h3 { display: flex; align-items: center; gap: 8px; margin: 0 0 7px; font-size: 15px; font-weight: 600; }
.check-badge {
  width: 19px; height: 19px; border-radius: 50%; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  background: #e6f4ea; color: var(--green);
  font-size: 11px; font-weight: 700;
}
.bubble.agent p { margin: 0 0 8px; font-size: 12.5px; line-height: 1.65; color: #3c3c43; }
.bubble.agent code {
  background: #f1f3f4; border-radius: 4px; padding: 1px 5px;
  font-family: "Cascadia Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 11px; color: #3c4043;
}
.receipt-list { display: flex; flex-direction: column; gap: 5px; margin: 2px 0 10px; padding: 0; list-style: none; }
.receipt-list li { position: relative; padding-left: 18px; font-size: 12px; line-height: 1.55; color: #3c3c43; }
.receipt-list li::before { content: "✓"; position: absolute; left: 0; top: 0; color: var(--green); font-size: 10px; font-weight: 700; }
.receipt-list b { font-weight: 600; color: var(--ink); }
.code-block {
  margin: 10px 0 12px; padding: 10px 12px;
  background: #1b1f24; color: #d8dee8;
  border-radius: 8px;
  font: 11px/1.7 "Cascadia Mono", "SFMono-Regular", Consolas, monospace;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .05);
  white-space: pre;
}
.code-block .prompt { color: #8ab4f8; }
.code-block .ok { color: #81c995; }
.receipt-foot { display: flex; flex-wrap: wrap; gap: 6px; padding-top: 10px; border-top: 1px solid rgba(15, 17, 21, .06); }
.pill {
  display: inline-flex; align-items: center; height: 21px; padding: 0 9px;
  border-radius: 999px; background: #f3f4f6; color: #5f6368;
  border: 1px solid rgba(15, 17, 21, .04); font-size: 10.5px;
}
.pill.ok { background: #e6f4ea; border-color: #ceead6; color: #137333; font-weight: 600; }
.pill.mono { font-variant-numeric: tabular-nums; }
.sync-line { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 2px 0; color: #8e8e93; font-size: 10.5px; }
.sync-line .ok { color: var(--green); font-weight: 700; }
.worker-note {
  display: flex; align-items: center; gap: 9px;
  padding: 9px 11px;
  background: #f8f9fb; border: 1px solid rgba(49, 120, 255, .13); border-radius: 10px;
}
.worker-avatar {
  width: 24px; height: 24px; border-radius: 50%; flex: none;
  display: flex; align-items: center; justify-content: center;
  background: #5b8def; color: #fff; font-size: 9.5px; font-weight: 700;
}
.worker-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; font-size: 10.5px; color: #5f6368; }
.worker-line { display: flex; align-items: center; gap: 4px; font-size: 10.5px; color: #5f6368; }
.worker-text strong { font-size: 11px; font-weight: 600; color: var(--ink); }
.worker-text b {
  padding: 0 4px; border: 1px solid rgba(15, 17, 21, .07); border-radius: 4px;
  background: #fff; color: #3c4043;
  font-family: "Cascadia Mono", "SFMono-Regular", Consolas, monospace;
  font-size: 10px; white-space: nowrap;
}
.worker-text span { font-size: 9.5px; color: #8e8e93; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.worker-state {
  flex: none; margin-left: auto; height: 18px; padding: 1px 7px;
  display: inline-flex; align-items: center;
  border: 1px solid #ceead6; border-radius: 999px;
  background: #e6f4ea; color: #137333; font-size: 9px; font-weight: 600;
}
.composer { flex: none; padding: 10px 28px 16px; }
.composer-inner { max-width: 640px; margin: 0 auto; }
.composer-box {
  height: 44px; display: flex; align-items: center; gap: 9px;
  padding: 0 9px 0 11px;
  background: #fff; border: 1px solid rgba(15, 17, 21, .1); border-radius: 12px;
  box-shadow: 0 1px 2px rgba(16, 24, 40, .04), 0 6px 18px rgba(16, 24, 40, .04);
}
.composer-plus {
  width: 20px; height: 20px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: #f1f3f4; color: #5f6368; font-size: 13px;
}
.composer-placeholder { flex: 1; font-size: 12px; color: #a1a1a6; }
.send-btn {
  width: 28px; height: 28px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: var(--accent); color: #fff; font-size: 13px; font-weight: 600;
  box-shadow: 0 1px 3px rgba(49, 120, 255, .3);
}
.composer-hint { margin-top: 7px; text-align: center; font-size: 9.5px; color: #b3b3b8; }

/* ---------------- right: real DSH Superagent panel ---------------- */
.panel { display: flex; flex-direction: column; min-width: 0; background: #fff; overflow: hidden; }
.panel-head { flex: none; padding: 0 12px; }
.panel-top { display: flex; align-items: center; gap: 7px; height: 58px; }
.panel-title { flex: none; font-size: 14px; font-weight: 600; letter-spacing: -.01em; }
.panel-search {
  flex: 1; min-width: 0; max-width: 300px; height: 30px;
  display: flex; align-items: center; gap: 5px;
  margin-left: auto; padding: 0 8px;
  border: 1px solid #d6d6d6; border-radius: 8px; background: #fff;
  color: #b3b3b8; font-size: 10.5px; white-space: nowrap; overflow: hidden;
}
.panel-search svg { width: 13px; height: 13px; color: #8a8a90; flex: none; }
.panel-search span { overflow: hidden; text-overflow: ellipsis; }
.help { width: 18px; height: 18px; color: #5f6368; flex: none; }
.open-session {
  flex: none; display: flex; align-items: center; gap: 5px;
  height: 30px; padding: 0 9px;
  border: 1px solid rgba(15, 17, 21, .13); border-radius: 8px;
  background: #fff; color: var(--ink);
  font: inherit; font-size: 11.5px; white-space: nowrap;
}
.open-session svg { width: 12px; height: 12px; color: #5f6368; flex: none; }
.tabs { display: flex; align-items: flex-end; gap: 24px; height: 34px; border-bottom: 1px solid #e0e0e0; }
.tab { position: relative; padding-bottom: 9px; font-size: 12.5px; color: var(--faint); white-space: nowrap; }
.tab.active { color: var(--ink); font-weight: 600; }
.tab.active::after { content: ""; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; border-radius: 1px; background: var(--ink); }
.board-wrap { flex: 1; min-height: 0; padding: 10px 10px 12px; overflow: hidden; }
.board-wrap iframe { display: block; width: 100%; height: 100%; border: 0; background: #f7f8fa; }
</style>
<style id="board-compact-style" media="not all">
/* Compact the real board for a ~420px-wide side panel: same DOM, same edges, tighter geometry. */
html, body { overflow: hidden !important; background: #f7f8fa !important; }
body { font-size: 11px !important; }
main { max-width: none !important; margin: 0 !important; padding: 12px 12px 14px !important; }
.board-summary { display: none !important; }
section { margin-bottom: 12px !important; }
section > h2 { margin: 0 0 6px !important; font-size: 11px !important; font-weight: 600 !important; color: #74747a !important; }
#team.team-tree {
  display: flex !important; align-items: center !important; justify-content: space-between !important;
  gap: 20px !important; padding: 0 2px !important; min-height: 0 !important;
}
#team.team-tree .team-lead, #team.team-tree .team-members { flex: 0 0 168px !important; width: 168px !important; }
.team-members { display: flex !important; flex-direction: column !important; gap: 7px !important; width: 168px !important; padding: 0 !important; }
.card, .card.card-lead {
  width: 168px !important; min-height: 92px !important;
  padding: 7px 9px !important; gap: 1px !important;
  border-radius: 9px !important;
}
.avatar, .card-lead .avatar { width: 20px !important; height: 20px !important; font-size: 10px !important; }
.member-head { gap: 6px !important; }
.member-name { padding-right: 0 !important; font-size: 12px !important; line-height: 15px !important; }
.member-role { margin-top: 1px !important; font-size: 9px !important; line-height: 12px !important; -webkit-line-clamp: 2 !important; }
.member-line { gap: 4px !important; margin-top: 2px !important; }
.member-line .sub { font-size: 9px !important; line-height: 12px !important; }
.member-meta { gap: 3px !important; }
.member-meta .state-chip { padding: 0 4px !important; font-size: 9px !important; line-height: 13px !important; border-radius: 4px !important; }
.member-meta .dot { width: 5px !important; height: 5px !important; }
.team-edges .edge { stroke-width: 1.4px !important; }
.ticket-groups { display: grid !important; grid-template-columns: repeat(3, minmax(0, 1fr)) !important; gap: 8px !important; overflow: visible !important; }
.group { min-width: 0 !important; margin-bottom: 0 !important; }
.group h3 { margin: 0 0 5px !important; padding: 4px 7px !important; border-radius: 6px !important; font-size: 10px !important; }
.group h3 span { min-width: 15px !important; height: 15px !important; padding: 0 4px !important; border-radius: 8px !important; font-size: 9px !important; }
.ticket-row { margin-bottom: 5px !important; padding: 7px 7px 6px !important; gap: 4px !important; border-radius: 7px !important; }
.ticket-row:last-child { margin-bottom: 0 !important; }
.ticket-row .title {
  display: -webkit-box !important; -webkit-line-clamp: 3 !important; -webkit-box-orient: vertical !important;
  overflow: hidden !important; white-space: normal !important;
  font-size: 10px !important; line-height: 12.5px !important;
}
.ticket-status { gap: 3px !important; }
.ticket-status .state-chip { padding: 0 4px !important; font-size: 9px !important; line-height: 13px !important; }
.ticket-row .ticket-meta { font-size: 8px !important; line-height: 11px !important; }
.ticket-row .ticket-time { display: none !important; }
main > section:last-of-type { display: none !important; }
*, *::before, *::after { animation: none !important; transition: none !important; }
</style>
</head>
<body>
<div class="workspace">
  <aside class="sidebar">
    <div class="side-head">
      <svg class="whale" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M21.2 6.4c-2.4-3.1-6.8-4.1-10.4-2.4C7.4 5.6 5.1 9.4 5.7 13.2c.2 1 .6 2 1.1 2.8-.3 1.2-1 2.2-2 2.9-.4.3-.3.9.2 1.1 2 .9 4.3.9 6.3.2.2.1.4.1.6.1 3.9.2 7.3-2.7 7.7-6.6.2-2.6-.7-5.2-2.4-7.3z"/>
        <circle cx="10" cy="9.3" r="1.1" fill="#fff"/>
      </svg>
      <span class="logo-text">deepseek</span>
      <span class="logo-badge">HARNESS</span>
      <svg class="collapse" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.1">
        <rect x="1.8" y="2.5" width="12.4" height="11" rx="1.6"/><path d="M5.6 2.5v11"/>
      </svg>
    </div>

    <div class="new-session">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
        <circle cx="8" cy="8" r="6.2"/><path d="M8 5.4v5.2M5.4 8h5.2" stroke-linecap="round"/>
      </svg>
      <span>新会话</span>
    </div>

    <div class="nav">
      <div class="nav-item">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round" aria-hidden="true">
          <path d="M6 2h4v4h4v4h-4v4H6v-4H2V6h4z"/>
        </svg>
        <span>插件</span>
      </div>
      <div class="nav-item active">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.15" aria-hidden="true">
          <path d="M8 1.8c-2.1 0-3.7 1.6-3.7 3.6 0 2.7 3.7 9 3.7 9s3.7-6.3 3.7-9c0-2-1.6-3.6-3.7-3.6z"/>
          <circle cx="8" cy="5.3" r="1.25"/>
        </svg>
        <span>Superagent</span>
      </div>
      <div class="nav-item">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
          <circle cx="8" cy="8" r="6.2"/><path d="M8 4.7V8l2.2 1.4" stroke-linecap="round"/>
        </svg>
        <span>自动化任务</span>
      </div>
      <div class="nav-item">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.15" aria-hidden="true">
          <rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/>
          <rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>
        </svg>
        <span>更多</span>
      </div>
    </div>

    <div class="ws-head">
      <span>工作区</span>
      <span class="ws-actions">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><circle cx="7" cy="7" r="4.4"/><path d="M10.3 10.3L14 14" stroke-linecap="round"/></svg>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><path d="M2 5h5M11 5h3M2 11h3M9 11h5" stroke-linecap="round"/><circle cx="9" cy="5" r="1.6"/><circle cx="7" cy="11" r="1.6"/></svg>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><path d="M2 4.5c0-.6.4-1 1-1h3l1.2 1.5H13c.6 0 1 .4 1 1V12c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1V4.5z"/><path d="M8 7v4M6 9h4" stroke-linecap="round"/></svg>
      </span>
    </div>

    <div class="ws-tree">
      <div class="ws-row">
        <svg viewBox="0 0 16 16" fill="none" stroke="#3178ff" stroke-width="1.2" aria-hidden="true"><path d="M2 4.5c0-.6.4-1 1-1h3l1.2 1.5H13c.6 0 1 .4 1 1V12c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1V4.5z"/></svg>
        <span>demo-widgets</span>
      </div>
      <div class="ws-row indent"><span>新会话</span></div>
      <div class="ws-row">
        <svg viewBox="0 0 16 16" fill="none" stroke="#8a8a90" stroke-width="1.2" aria-hidden="true"><path d="M2 4.5c0-.6.4-1 1-1h3l1.2 1.5H13c.6 0 1 .4 1 1V12c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1V4.5z"/></svg>
        <span>example-service</span>
      </div>
      <div class="ws-row">
        <svg viewBox="0 0 16 16" fill="none" stroke="#8a8a90" stroke-width="1.2" aria-hidden="true"><path d="M2 4.5c0-.6.4-1 1-1h3l1.2 1.5H13c.6 0 1 .4 1 1V12c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1V4.5z"/></svg>
        <span>playground</span>
      </div>
      <div class="ws-row">
        <svg viewBox="0 0 16 16" fill="none" stroke="#8a8a90" stroke-width="1.2" aria-hidden="true"><path d="M2 4.5c0-.6.4-1 1-1h3l1.2 1.5H13c.6 0 1 .4 1 1V12c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1V4.5z"/></svg>
        <span>scratch</span>
      </div>
      <div class="ws-row">
        <svg viewBox="0 0 16 16" fill="none" stroke="#8a8a90" stroke-width="1.2" aria-hidden="true"><path d="M2 4.5c0-.6.4-1 1-1h3l1.2 1.5H13c.6 0 1 .4 1 1V12c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1V4.5z"/></svg>
        <span>tmp</span>
      </div>
      <div class="ws-row">
        <svg viewBox="0 0 16 16" fill="none" stroke="#8a8a90" stroke-width="1.2" aria-hidden="true"><path d="M2 4.5c0-.6.4-1 1-1h3l1.2 1.5H13c.6 0 1 .4 1 1V12c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1V4.5z"/></svg>
        <span>未分组</span>
      </div>
    </div>

    <div class="side-foot">
      <span class="avatar-neutral">D</span>
      <div class="foot-text"><strong>本地演示</strong><span>演示数据·不含真实账号</span></div>
    </div>
  </aside>

  <section class="chat">
    <header class="chat-head">
      <div class="chat-title">
        <strong>Superagent 调度器</strong>
        <span><i class="pulse"></i> dispatcher · 在线 · 已连接团队任务板</span>
      </div>
      <span class="chat-chip">演示会话</span>
    </header>

    <div class="chat-body">
      <div class="chat-thread">
        <div class="day-divider"><span>今天 14:20</span></div>

        <div class="msg user">
          <div class="bubble user">收到执行请求：修复 <code>demo-widgets</code> 导出按钮的时区问题，回归通过后把 <b>DEMO-101</b> 同步到看板。</div>
          <div class="msg-meta">你 · 14:20</div>
        </div>

        <div class="msg agent">
          <span class="avatar small">S</span>
          <div class="msg-main">
            <div class="msg-name">Superagent 调度器 <span class="msg-time">14:22</span></div>
            <div class="bubble agent">
              <h3><span class="check-badge">✓</span>已完成</h3>
              <p>已按请求修复 <code>demo-widgets</code> 导出按钮的时区问题，并完成回归验证。</p>
              <ul class="receipt-list">
                <li>内部统一按 UTC 计算，渲染时使用查看者的本地时区</li>
                <li>新增跨时区用例 6 条，全部通过，无回归</li>
                <li><b>DEMO-101</b> 已更新为「完成」，并同步至团队任务板</li>
              </ul>
<pre class="code-block"><span class="prompt">$</span> pnpm test --filter demo-widgets
<span class="ok">✓</span> 42 passed · 0 failed</pre>
              <div class="receipt-foot">
                <span class="pill ok">状态 · 已完成</span>
                <span class="pill mono">耗时 · 2 分 18 秒</span>
                <span class="pill">工单 · DEMO-101</span>
              </div>
            </div>
          </div>
        </div>

        <div class="sync-line"><span class="ok">✓</span> 已同步到团队任务板 · Atlas 领取 DEMO-105 · 演示数据</div>

        <div class="worker-note">
          <span class="worker-avatar">A</span>
          <div class="worker-text">
            <div class="worker-line"><strong>Atlas</strong> 已领取 <b>DEMO-105</b></div>
            <span>Polish empty state for board list · 正在执行</span>
          </div>
          <span class="worker-state">运行中</span>
        </div>
      </div>
    </div>

    <footer class="composer">
      <div class="composer-inner">
        <div class="composer-box">
          <span class="composer-plus">+</span>
          <span class="composer-placeholder">继续给 Superagent 派活…（演示）</span>
          <span class="send-btn">↑</span>
        </div>
        <div class="composer-hint">Enter 发送 · Shift + Enter 换行 · 演示视图</div>
      </div>
    </footer>
  </section>

  <section class="panel">
    <header class="panel-head">
      <div class="panel-top">
        <div class="panel-title">Superagent</div>
        <div class="panel-search">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><circle cx="7" cy="7" r="4.4"/><path d="M10.3 10.3L14 14" stroke-linecap="round"/></svg>
          <span>搜索工单、线程、触发或链接</span>
        </div>
        <svg class="help" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
          <circle cx="9" cy="9" r="7.2"/>
          <path d="M7.2 6.9c.1-1 .9-1.7 1.9-1.6 1.1.1 1.9 1 1.8 2.1-.1 1.3-1.6 1.6-2.1 2.6l-.1.6" stroke-linecap="round"/>
          <circle cx="9" cy="13" r=".7" fill="currentColor" stroke="none"/>
        </svg>
        <button class="open-session" type="button">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
            <rect x="2.5" y="4" width="9" height="9" rx="1.4"/><path d="M9 2.5h4.5V7M13.5 2.5L7.8 8.2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span>打开主 Session</span>
        </button>
      </div>
      <div class="tabs">
        <span class="tab active">概览</span>
        <span class="tab">来源</span>
        <span class="tab">触发</span>
        <span class="tab">评估</span>
        <span class="tab">执行</span>
        <span class="tab">设置</span>
      </div>
    </header>
    <div class="board-wrap">
      <iframe id="board-frame" src="/superagent-board/" title="团队任务板（演示）"></iframe>
    </div>
  </section>
</div>

<script>
(function () {
  var frame = document.getElementById('board-frame')
  var source = document.getElementById('board-compact-style')
  function decorate() {
    try {
      var doc = frame.contentDocument
      if (!doc || !doc.head) return false
      if (source && source.textContent.trim() !== '') {
        var style = doc.getElementById('harness-compact')
        if (!style) {
          style = doc.createElement('style')
          style.id = 'harness-compact'
          doc.head.appendChild(style)
        }
        if (style.textContent !== source.textContent) style.textContent = source.textContent
      }
      frame.contentWindow.dispatchEvent(new Event('resize'))
      return true
    } catch (error) {
      return false
    }
  }
  window.__decorateBoard = decorate
  frame.addEventListener('load', function () {
    decorate()
    setTimeout(decorate, 120)
    setTimeout(decorate, 650)
    setTimeout(decorate, 1600)
  })
  setTimeout(decorate, 300)
})()
</script>
</body>
</html></html>`

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

/** Wait for the iframe document plus a ready board render (cards, edges, no skeletons). */
const boardExpr = expression => `(() => {
  const frame = document.querySelector('#board-frame')
  if (frame === null || frame.contentDocument === null) return null
  return (${expression})
})()`

/* ------------------------------------------------------------------ *
 * Capture.                                                           *
 * ------------------------------------------------------------------ */

async function main() {
  if (CHROME === undefined) throw new Error('no Chromium executable found; set CHROME_PATH')
  await mkdir(OUT_DIR, { recursive: true })

  const superagentPort = await listen(superagent)
  const tokenFile = join(tmpdir(), 'board-harness-token-' + process.pid)
  const workFile = join(tmpdir(), 'board-harness-work-' + process.pid + '.json')
  await writeFile(tokenFile, TOKEN + '\n', { mode: 0o600 })
  // The built server reads both at import: point its actions at the fake superagent and its token at a temp file.
  // The work-status path is a non-existent temp file, so the board cannot read any real host state.
  process.env.DSH_SUPERAGENT_ORIGIN = 'http://127.0.0.1:' + superagentPort
  process.env.DSH_SUPERAGENT_TOKEN_FILE = tokenFile
  process.env.DSH_SUPERAGENT_WORK_FILE = workFile
  const { startBoardServer } = await import(pathToFileURL(join(PACKAGE, 'lib', 'server.js')).href)
  const boardServer = await startBoardServer({
    port: 0,
    fetchBoard: async () => superagentUp ? BOARD : null,
  })

  const site = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (pathname === '/harness.html' && request.method === 'GET') {
      const body = Buffer.from(HARNESS_HTML, 'utf8')
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(body.length), 'cache-control': 'no-store' })
      response.end(body)
      return
    }
    if (pathname === '/superagent-board/aliases.json' && request.method === 'GET') {
      // Only a display alias for the main-session card; every teammate keeps its roster name.
      sendJson(response, 200, { lead: 'Lead' })
      return
    }
    if (pathname === '/superagent-board/board.json' && request.method === 'GET') {
      await relay(await fetch(boardServer.url + '/board.json'), response)
      return
    }
    if (pathname === '/superagent-board/team.json' && request.method === 'GET') {
      await relay(await fetch(boardServer.url + '/team.json'), response)
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
  const pageUrl = 'http://127.0.0.1:' + sitePort + '/harness.html'

  const profile = await mkdtemp(join(tmpdir(), 'board-harness-capture-'))
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--disable-extensions', '--disable-background-networking',
    '--disable-sync', '--metrics-recording-only', '--mute-audio', '--force-color-profile=srgb',
    '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--window-size=' + VIEWPORT.width + ',' + VIEWPORT.height, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'] })

  let cdp
  try {
    // With --remote-debugging-port=0 the port is published in the throw-away profile.
    let debugPort
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        const text = await readFile(join(profile, 'DevToolsActivePort'), 'utf8')
        const first = text.split(/\r?\n/)[0]
        if (first !== undefined && first.trim() !== '') { debugPort = Number(first.trim()); break }
      } catch { /* not written yet */ }
      await delay(100)
    }
    if (debugPort === undefined) throw new Error('chromium did not publish DevToolsActivePort')

    let target
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await fetch('http://127.0.0.1:' + debugPort + '/json/new?url=' + encodeURIComponent('about:blank'), { method: 'PUT' })
        if (!response.ok) throw new Error('debug endpoint not ready')
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
    await waitFor(cdp, "document.readyState === 'complete' && location.href.indexOf('/harness.html') !== -1")
    await waitFor(cdp, "typeof window.__decorateBoard === 'function'")
    await evaluate(cdp, "window.__decorateBoard()")

    // The board iframe must be fully rendered: 6 cards (lead + Atlas/Nova/Orion/Vega/Helios), 5 edges, no skeletons.
    await waitFor(cdp, boardExpr("frame.contentDocument.querySelectorAll('#team .card').length"), value => value === 6)
    await waitFor(cdp, boardExpr("frame.contentDocument.querySelectorAll('.team-edges .edge').length"), value => typeof value === 'number' && value >= 5)
    await waitFor(cdp, boardExpr("frame.contentDocument.querySelectorAll('.skeleton-card, .skeleton-column').length"), value => value === 0)
    await waitFor(cdp, boardExpr("frame.contentDocument.querySelectorAll('.ticket-row').length"), value => value === 7)

    // Tickets render before the /team roster lands; nudge one ticket so the 3 s board poll re-renders owners.
    BOARD.tickets[0].updatedAt = new Date().toISOString()
    await waitFor(cdp, boardExpr("(frame.contentDocument.querySelector('.ticket-row[data-ticket-id=\"DEMO-101\"] .ticket-owner') || {}).textContent || ''"),
      value => typeof value === 'string' && value.includes('Atlas'), 12000)
    await evaluate(cdp, "window.__decorateBoard()")
    await waitFor(cdp, "document.fonts.status === 'loaded'")
    await delay(700)

    // Diagnostics: columns must be 20/50/30 of 1440, and the board must fit its iframe (no clipped content).
    const geometry = await evaluate(cdp, `(() => {
      const columns = Array.from(document.querySelectorAll('.workspace > *')).map(element => element.getBoundingClientRect().width)
      const frame = document.querySelector('#board-frame')
      const doc = frame.contentDocument
      const shell = { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight }
      return {
        columns,
        shell,
        board: {
          viewport: { width: frame.clientWidth, height: frame.clientHeight },
          content: { width: doc.documentElement.scrollWidth, height: doc.documentElement.scrollHeight },
          contentBottom: Math.ceil(Math.max(...Array.from(doc.querySelectorAll('main > section')).map(section => section.getBoundingClientRect().bottom))),
          cards: doc.querySelectorAll('#team .card').length,
          edges: doc.querySelectorAll('.team-edges .edge').length,
          tickets: doc.querySelectorAll('.ticket-row').length,
          skeleton: doc.querySelectorAll('.skeleton-card, .skeleton-column').length,
        },
      }
    })()`)
    console.log('geometry ' + JSON.stringify(geometry))
    if (geometry.board.contentBottom > geometry.board.viewport.height) {
      throw new Error('board content is taller than its panel: ' + geometry.board.contentBottom + ' > ' + geometry.board.viewport.height)
    }
    if (geometry.shell.scrollWidth > geometry.shell.width || geometry.shell.scrollHeight > geometry.shell.height) {
      throw new Error('shell page overflows the viewport')
    }

    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height, scale: 1 },
    })
    await writeFile(OUT_FILE, Buffer.from(shot.data, 'base64'))

    const bytes = (await stat(OUT_FILE)).size
    const png = await readFile(OUT_FILE)
    const width = png.readUInt32BE(16)
    const height = png.readUInt32BE(20)
    if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('output is not a PNG')
    if (bytes < 60 * 1024) throw new Error('screenshot is under 60 KB: ' + bytes)
    console.log('captured harness-full -> ' + OUT_FILE + ' (' + bytes + ' bytes, ' + width + 'x' + height + ')')
    console.log('DONE ' + OUT_FILE)
  } finally {
    if (cdp !== undefined) cdp.close()
    chrome.kill()
    await new Promise(resolve => {
      if (chrome.exitCode !== null) { resolve(); return }
      const timer = setTimeout(() => { try { chrome.kill('SIGKILL') } catch { /* already gone */ } resolve() }, 3000)
      chrome.once('exit', () => { clearTimeout(timer); resolve() })
    })
    await delay(400)
    await rm(profile, { recursive: true, force: true }).catch(() => {})
    await closeServer(site)
    await boardServer.close()
    await closeServer(superagent)
    await rm(tokenFile, { force: true }).catch(() => {})
    await rm(workFile, { force: true }).catch(() => {})
  }
}

main().catch(error => {
  console.error('CAPTURE FAILED:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
