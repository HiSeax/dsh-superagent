#!/usr/bin/env node
/**
 * Capture the full-window "DSH Harness + Superagent" demo composition.
 *
 * The window is assembled from three columns:
 *   - left   (~20%)  a DSH-style sidebar: new-session button, projects, recent demo sessions, plugins;
 *   - centre (~50%)  a dispatcher conversation: one user instruction bubble + one rich-text receipt bubble;
 *   - right  (~30%)  the **real** board panel, loaded from this same demo origin in an iframe
 *                    (teammate cards, edges and ticket groups), compacted with injected CSS.
 *
 * Isolation, like tools/capture-demo-screenshots.mjs:
 *   - a fake superagent `/team` endpoint (fictional demo roster) on a random 127.0.0.1 port,
 *   - the real built board server `lib/server.js` on a random port, fed a fictional board payload,
 *   - a same-origin site that serves `/harness.html`, the board's static assets and relays its endpoints,
 *   - headless Chromium over CDP with a throw-away profile, at deviceScaleFactor 2.
 *
 * All data is fabricated: teammates Atlas / Nova / Orion / Vega / Helios, projects demo-widgets /
 * example-service, generic ticket copy. No production DSH (port 3080) is touched, no host process is
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
const PACKAGE = join(REPO, 'packages', 'dsh-superagent-board')
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
  --bg: #eef0f4;
  --ink: #1d1d1f;
  --muted: #6e6e73;
  --faint: #96969c;
  --line: rgba(0, 0, 0, .07);
  --line-soft: rgba(0, 0, 0, .055);
  --accent: #1a73e8;
  --green: #188038;
}
* { box-sizing: border-box; }
html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
body {
  background: var(--bg);
  color: var(--ink);
  font: 13px/1.5 "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
svg { display: block; }
.topbar {
  height: 42px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 0 16px;
  background: rgba(252, 252, 253, .94);
  border-bottom: 1px solid var(--line);
  box-shadow: 0 1px 0 rgba(255, 255, 255, .6) inset;
  position: relative;
  z-index: 10;
}
.brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
.brand-mark {
  width: 22px; height: 22px; border-radius: 7px; flex: none;
  background: linear-gradient(145deg, #30353e, #131519);
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 1px 2px rgba(0, 0, 0, .18);
}
.brand-mark svg { width: 12px; height: 12px; fill: #fff; }
.brand-title { font-size: 13px; font-weight: 600; letter-spacing: .005em; white-space: nowrap; }
.brand-title .demo { color: var(--faint); font-weight: 500; }
.topbar-right { display: flex; align-items: center; gap: 9px; font-size: 10.5px; color: var(--muted); white-space: nowrap; }
.live-dot { width: 6px; height: 6px; border-radius: 50%; background: #2e9e5b; box-shadow: 0 0 0 3px rgba(46, 158, 91, .12); }
.top-tag { padding: 2px 7px; border-radius: 999px; background: #f1f2f4; border: 1px solid rgba(0, 0, 0, .05); color: #74747a; font-size: 10px; }
.workspace { height: calc(100vh - 42px); display: grid; grid-template-columns: 20% 50% 30%; overflow: hidden; }
.sidebar {
  display: flex; flex-direction: column; min-width: 0;
  padding: 14px 12px 12px;
  background: linear-gradient(180deg, #f9fafc 0%, #f2f3f6 100%);
  border-right: 1px solid var(--line);
  overflow: hidden;
}
.new-session {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  width: 100%; height: 34px; border: 0; border-radius: 9px;
  background: linear-gradient(180deg, #2f80ed, #1a73e8);
  color: #fff; font: inherit; font-size: 12.5px; font-weight: 600;
  box-shadow: 0 1px 2px rgba(26, 115, 232, .3), 0 5px 14px rgba(26, 115, 232, .16);
}
.new-session .plus { font-size: 16px; line-height: 1; font-weight: 400; margin-top: -1px; }
.workspace-switch {
  display: flex; align-items: center; gap: 9px;
  margin-top: 12px; padding: 9px;
  background: #fff; border: 1px solid rgba(0, 0, 0, .06); border-radius: 10px;
  box-shadow: 0 1px 2px rgba(16, 24, 40, .04);
}
.ws-mark {
  width: 26px; height: 26px; border-radius: 8px; flex: none;
  display: flex; align-items: center; justify-content: center;
  background: linear-gradient(145deg, #dbe8ff, #f0f6ff);
  border: 1px solid #d3e2fb;
  color: var(--accent); font-size: 11px; font-weight: 700;
}
.ws-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.ws-text strong { font-size: 12px; font-weight: 600; }
.ws-text span { font-size: 10px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ws-chevron { color: #a1a1a6; font-size: 11px; }
.side-scroll { flex: 1; overflow: hidden; margin-top: 2px; }
.side-label {
  display: flex; align-items: center; justify-content: space-between;
  margin: 15px 8px 5px;
  font-size: 10.5px; font-weight: 600; letter-spacing: .06em; color: var(--faint);
}
.side-label .count { font-weight: 500; letter-spacing: 0; color: #b0b0b6; }
.side-item {
  display: flex; align-items: center; gap: 8px;
  height: 31px; padding: 0 8px; border-radius: 7px;
  color: #3c3c43; font-size: 12px; white-space: nowrap;
}
.side-item.active {
  background: #fff; color: var(--ink); font-weight: 550;
  box-shadow: 0 1px 2px rgba(16, 24, 40, .06), inset 0 0 0 1px rgba(0, 0, 0, .04);
}
.proj-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.proj-dot.blue { background: var(--accent); box-shadow: 0 0 0 3px rgba(26, 115, 232, .1); }
.proj-dot.green { background: #2e9e5b; box-shadow: 0 0 0 3px rgba(46, 158, 91, .1); }
.side-item .badge {
  margin-left: auto; min-width: 18px; height: 18px; padding: 0 5px;
  border-radius: 9px; background: #ececf0; color: #74747a;
  font-size: 10px; display: flex; align-items: center; justify-content: center;
}
.side-item .time { margin-left: auto; font-size: 10px; color: #a8a8ae; font-variant-numeric: tabular-nums; }
.session-ico { width: 13px; height: 13px; border: 1.5px solid #b0b0b6; border-radius: 4px; position: relative; flex: none; }
.session-ico::after { content: ""; position: absolute; left: 3.5px; top: 3.5px; width: 3px; height: 3px; border-radius: 50%; background: #b0b0b6; }
.side-item.active .session-ico { border-color: var(--accent); }
.side-item.active .session-ico::after { background: var(--accent); }
.plug-ico {
  width: 18px; height: 18px; border-radius: 5px; flex: none;
  display: flex; align-items: center; justify-content: center;
  background: #e8f0fe; border: 1px solid #d7e5fd; color: var(--accent);
  font-size: 10px; font-weight: 700;
}
.plug-ico.alt { background: #f3ecff; border-color: #e9defb; color: #7b4bd8; }
.on-dot { margin-left: auto; width: 6px; height: 6px; border-radius: 50%; background: #2e9e5b; box-shadow: 0 0 0 3px rgba(46, 158, 91, .12); }
.side-foot {
  display: flex; align-items: center; gap: 9px;
  margin-top: 8px; padding: 11px 6px 2px;
  border-top: 1px solid rgba(0, 0, 0, .06);
}
.neutral-avatar {
  width: 26px; height: 26px; border-radius: 50%; flex: none;
  display: flex; align-items: center; justify-content: center;
  background: linear-gradient(145deg, #e1e5ec, #c7cdd7);
  color: #5c6472; font-size: 10.5px; font-weight: 700;
}
.foot-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.foot-text strong { font-size: 11px; font-weight: 600; }
.foot-text span { font-size: 10px; color: var(--faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chat {
  display: flex; flex-direction: column; min-width: 0;
  background: linear-gradient(180deg, #ffffff 0%, #fdfdff 60%, #fafbfc 100%);
  border-right: 1px solid var(--line);
  overflow: hidden;
}
.chat-head {
  flex: none; height: 58px;
  display: flex; align-items: center; gap: 11px;
  padding: 0 22px;
  border-bottom: 1px solid rgba(0, 0, 0, .06);
  background: rgba(255, 255, 255, .82);
}
.agent-badge {
  width: 32px; height: 32px; border-radius: 10px; flex: none;
  display: flex; align-items: center; justify-content: center;
  background: linear-gradient(145deg, #2c323b, #14171c);
  box-shadow: 0 2px 6px rgba(15, 20, 30, .18);
}
.agent-badge svg { width: 15px; height: 15px; fill: #fff; }
.chat-title { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.chat-title strong { font-size: 13.5px; font-weight: 600; }
.chat-title span { display: flex; align-items: center; gap: 5px; font-size: 10.5px; color: var(--muted); }
.pulse { width: 6px; height: 6px; border-radius: 50%; background: #2e9e5b; box-shadow: 0 0 0 3px rgba(46, 158, 91, .12); }
.chat-chip { margin-left: auto; padding: 2px 8px; border-radius: 999px; background: #f3f4f6; border: 1px solid rgba(0, 0, 0, .05); color: #8a8a90; font-size: 10px; }
.chat-body { flex: 1; overflow: hidden; padding: 22px 28px 8px; display: flex; flex-direction: column; }
.chat-thread { width: 100%; max-width: 640px; margin: 0 auto; display: flex; flex-direction: column; gap: 18px; }
.day-divider { display: flex; align-items: center; gap: 10px; color: #a8a8ae; font-size: 10.5px; }
.day-divider::before, .day-divider::after { content: ""; height: 1px; flex: 1; background: var(--line-soft); }
.msg.user { align-self: flex-end; max-width: 78%; display: flex; flex-direction: column; align-items: flex-end; gap: 5px; }
.bubble.user {
  padding: 11px 15px; border-radius: 14px 14px 4px 14px;
  background: linear-gradient(180deg, #2f80ed, #1a73e8);
  color: #fff; font-size: 13px; line-height: 1.65;
  box-shadow: 0 4px 14px rgba(26, 115, 232, .18);
}
.bubble.user code { background: rgba(255, 255, 255, .2); color: #fff; border-radius: 4px; padding: 1px 4px; font-size: 11.5px; }
.msg-meta { font-size: 10px; color: #a1a1a6; padding-right: 3px; }
.msg.agent { display: flex; align-items: flex-start; gap: 10px; max-width: 90%; }
.avatar.small {
  width: 28px; height: 28px; border-radius: 50%; flex: none; margin-top: 2px;
  display: flex; align-items: center; justify-content: center;
  background: linear-gradient(145deg, #eaf2ff, #f9fbff);
  border: 1px solid #d6e4fb; color: var(--accent);
  font-size: 11px; font-weight: 700;
}
.msg-main { min-width: 0; }
.msg-name { display: flex; align-items: baseline; gap: 7px; margin: 0 0 5px 2px; font-size: 10.5px; color: #8e8e93; }
.msg-time { color: #b3b3b8; font-size: 9.5px; }
.bubble.agent {
  padding: 15px 17px 14px;
  background: #fff; border: 1px solid rgba(0, 0, 0, .07);
  border-radius: 14px 14px 14px 4px;
  box-shadow: 0 1px 2px rgba(16, 24, 40, .04), 0 10px 30px rgba(16, 24, 40, .045);
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
.receipt-foot { display: flex; flex-wrap: wrap; gap: 6px; padding-top: 10px; border-top: 1px solid rgba(0, 0, 0, .06); }
.pill {
  display: inline-flex; align-items: center; height: 21px; padding: 0 9px;
  border-radius: 999px; background: #f3f4f6; color: #5f6368;
  border: 1px solid rgba(0, 0, 0, .04); font-size: 10.5px;
}
.pill.ok { background: #e6f4ea; border-color: #ceead6; color: #137333; font-weight: 600; }
.pill.mono { font-variant-numeric: tabular-nums; }
.sync-line { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 2px 0; color: #8e8e93; font-size: 10.5px; }
.sync-line .ok { color: var(--green); font-weight: 700; }
.composer { flex: none; padding: 10px 28px 16px; }
.composer-inner { max-width: 640px; margin: 0 auto; }
.composer-box {
  height: 44px; display: flex; align-items: center; gap: 9px;
  padding: 0 9px 0 11px;
  background: #fff; border: 1px solid rgba(0, 0, 0, .09); border-radius: 12px;
  box-shadow: 0 1px 2px rgba(16, 24, 40, .04), 0 6px 18px rgba(16, 24, 40, .05);
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
  box-shadow: 0 1px 3px rgba(26, 115, 232, .3);
}
.composer-hint { margin-top: 7px; text-align: center; font-size: 9.5px; color: #b3b3b8; }
.board-panel { display: flex; flex-direction: column; min-width: 0; background: #eef1f5; overflow: hidden; }
.board-head {
  flex: none; height: 46px;
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 0 14px;
  background: rgba(248, 249, 251, .88);
  border-bottom: 1px solid rgba(0, 0, 0, .06);
}
.board-head-left { display: flex; align-items: center; gap: 7px; min-width: 0; }
.board-head strong { font-size: 12px; font-weight: 600; white-space: nowrap; }
.live-pill {
  display: inline-flex; align-items: center; gap: 4px;
  height: 18px; padding: 0 7px;
  border-radius: 999px; background: #e6f4ea; border: 1px solid #ceead6;
  color: #137333; font-size: 9.5px; font-weight: 600;
}
.live-pill i { width: 5px; height: 5px; border-radius: 50%; background: var(--green); }
.board-head-sub { font-size: 9.5px; color: var(--faint); white-space: nowrap; }
.board-frame-wrap {
  flex: 1; margin: 9px;
  border-radius: 11px; overflow: hidden;
  background: #fff; border: 1px solid rgba(0, 0, 0, .08);
  box-shadow: 0 2px 6px rgba(16, 24, 40, .05), 0 16px 40px rgba(16, 24, 40, .06);
}
.board-frame-wrap iframe { display: block; width: 100%; height: 100%; border: 0; background: #f5f5f7; }
</style>
<style id="board-compact-style" media="not all">
/* Compact the real board for a ~410px-wide side panel: same DOM, same edges, tighter geometry. */
html, body { overflow: hidden !important; background: #f7f8fa !important; }
body { font-size: 11px !important; }
main { max-width: none !important; margin: 0 !important; padding: 10px 10px 12px !important; }
.board-summary { display: none !important; }
section { margin-bottom: 12px !important; }
section > h2 { margin: 0 0 6px !important; font-size: 11px !important; font-weight: 600 !important; color: #74747a !important; }
#team.team-tree {
  display: flex !important; align-items: center !important; justify-content: space-between !important;
  gap: 18px !important; padding: 0 2px !important; min-height: 0 !important;
}
#team.team-tree .team-lead, #team.team-tree .team-members { flex: 0 0 158px !important; width: 158px !important; }
.team-members { display: flex !important; flex-direction: column !important; gap: 7px !important; width: 158px !important; padding: 0 !important; }
.card, .card.card-lead {
  width: 158px !important; min-height: 92px !important;
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
.team-edges .edge-dot { r: 1.5px; }
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
<header class="topbar">
  <div class="brand">
    <span class="brand-mark">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.35 7.05L21.6 11.4l-7.25 2.35L12 21l-2.35-7.25L2.4 11.4l7.25-2.35z"/></svg>
    </span>
    <span class="brand-title">DSH Harness · Superagent<span class="demo">（演示）</span></span>
  </div>
  <div class="topbar-right">
    <span class="live-dot"></span>
    <span>本地隔离演示实例</span>
    <span class="top-tag">虚构数据</span>
  </div>
</header>

<main class="workspace">
  <aside class="sidebar">
    <div class="new-session"><span class="plus">+</span><span>新会话</span></div>

    <div class="workspace-switch">
      <span class="ws-mark">D</span>
      <div class="ws-text"><strong>演示工作区</strong><span>本地 · 隔离运行</span></div>
      <span class="ws-chevron">⌄</span>
    </div>

    <div class="side-scroll">
      <div class="side-label">项目 <span class="count">2</span></div>
      <div class="side-item"><span class="proj-dot blue"></span><span>demo-widgets</span><span class="badge">2</span></div>
      <div class="side-item"><span class="proj-dot green"></span><span>example-service</span><span class="badge">1</span></div>

      <div class="side-label">最近会话</div>
      <div class="side-item active"><span class="session-ico"></span><span>demo-widgets</span><span class="time">14:18</span></div>
      <div class="side-item"><span class="session-ico"></span><span>example-service</span><span class="time">13:42</span></div>
      <div class="side-item"><span class="session-ico"></span><span>playground</span><span class="time">11:05</span></div>
      <div class="side-item"><span class="session-ico"></span><span>scratch</span><span class="time">昨天</span></div>

      <div class="side-label">插件</div>
      <div class="side-item"><span class="plug-ico">S</span><span>Superagent 调度器</span><span class="on-dot"></span></div>
      <div class="side-item"><span class="plug-ico alt">B</span><span>团队任务板</span><span class="on-dot"></span></div>
    </div>

    <div class="side-foot">
      <span class="neutral-avatar">D</span>
      <div class="foot-text"><strong>本地演示</strong><span>演示数据 · 不含真实账号</span></div>
    </div>
  </aside>

  <section class="chat">
    <header class="chat-head">
      <span class="agent-badge">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.35 7.05L21.6 11.4l-7.25 2.35L12 21l-2.35-7.25L2.4 11.4l7.25-2.35z"/></svg>
      </span>
      <div class="chat-title">
        <strong>Superagent 调度器</strong>
        <span><i class="pulse"></i> 在线 · 已连接团队任务板</span>
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

  <section class="board-panel">
    <header class="board-head">
      <div class="board-head-left">
        <strong>团队任务板</strong>
        <span class="live-pill"><i></i>实时</span>
      </div>
      <span class="board-head-sub" id="board-count">5 位 teammate · 7 工单</span>
    </header>
    <div class="board-frame-wrap">
      <iframe id="board-frame" src="/superagent-board/" title="团队任务板（演示）"></iframe>
    </div>
  </section>
</main>

<script>
(function () {
  var frame = document.getElementById('board-frame')
  var count = document.getElementById('board-count')
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
      var members = doc.querySelectorAll('.team-members .card').length
      var tickets = doc.querySelectorAll('.ticket-row').length
      if (count && members > 0) count.textContent = members + ' 位 teammate · ' + tickets + ' 工单'
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
</html>`

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
    if (pathname === '/harness.html' && request.method === 'GET') {
      const body = Buffer.from(HARNESS_HTML, 'utf8')
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(body.length), 'cache-control': 'no-store' })
      response.end(body)
      return
    }
    if (pathname === '/superagent-board/aliases.json' && request.method === 'GET') {
      sendJson(response, 200, {})
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
          cards: doc.querySelectorAll('#team .card').length,
          edges: doc.querySelectorAll('.team-edges .edge').length,
          tickets: doc.querySelectorAll('.ticket-row').length,
          skeleton: doc.querySelectorAll('.skeleton-card, .skeleton-column').length,
        },
      }
    })()`)
    console.log('geometry ' + JSON.stringify(geometry))
    if (geometry.board.content.height > geometry.board.viewport.height + 1) {
      throw new Error('board content is taller than its panel: ' + geometry.board.content.height + ' > ' + geometry.board.viewport.height)
    }
    if (geometry.shell.scrollWidth > geometry.shell.width || geometry.shell.scrollHeight > geometry.shell.height) {
      throw new Error('shell page overflows the viewport')
    }

    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height, scale: SCALE },
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
  }
}

main().catch(error => {
  console.error('CAPTURE FAILED:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
