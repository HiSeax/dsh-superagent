#!/usr/bin/env node
/**
 * Read-only liveness probe for the Weixin (iLink Bot) Source.
 *
 * Why it exists: the Source's own poll loop reports health in memory only, and — as of 2026-11-11 — a long poll that ends
 * without a stale-token error silently ends the Source's lifecycle. That left no evidence outside the host process of
 * whether the bot was still listening. This probe answers "is the saved credential and its long-poll cursor still alive
 * on iLink's side, and is there anything waiting?" without touching the running host, without writing any state, and
 * without consuming messages.
 *
 * Safety:
 * - The cursor is **echoed back unchanged** and its reply is discarded. iLink returns the next cursor in the reply; this
 *   script never persists it, so a probe cannot swallow a message that the running Source's loop would later read with the
 *   stale cursor. It is therefore safe to run while the host is running.
 * - A probe therefore proves that the credential and the cursor are still valid, and whether iLink holds messages beyond
 *   the cursor **at the moment of the probe**; it does not prove the source loop is alive (see `tests/weixin-lifecycle.spec.ts`).
 *
 * Usage (from the repository root, Node >= 22 for `fetch`):
 *   node scripts/weixin-liveness.mjs [--state-dir <dir>] [--timeout <ms>] [--json]
 *
 *   --state-dir  Directory holding `weixin-bot.json` and `orchestrator.sqlite` (default: $DSH_SUPERAGENT_STATE_DIR,
 *                else ~/.dsh/state/superagent). The cursor is read from `orchestrator.sqlite` table `kv`
 *                (`weixin-updates`); the credential from `weixin-bot.json`.
 *   --timeout    Long-poll timeout in ms (default 45000; iLink holds a poll about 35 s).
 *   --json       Print one JSON object instead of the human summary.
 *
 * Exit codes: 0 = live (HTTP 200, ret/errcode zero, cursor echoed), 1 = dead credential (-14 / auth), 2 = transport or
 * other failure, 3 = configuration problem (no credential, no cursor).
 *
 * The negative sample (proving a stale token is *distinguishable* from a silent death) uses a deliberately corrupt token
 * and never alters the saved one:
 *   node scripts/weixin-liveness.mjs --token "$(printf 'x%.0s' {1..32})" --json
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const CURSOR_KEY = 'weixin-updates'

function parseArgs(argv) {
  const options = { stateDir: process.env.DSH_SUPERAGENT_STATE_DIR ?? join(homedir(), '.dsh', 'state', 'superagent'),
    timeout: 45_000, json: false, token: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') options.json = true
    else if (arg === '--state-dir') options.stateDir = argv[++index]
    else if (arg === '--timeout') options.timeout = Number(argv[++index])
    else if (arg === '--token') options.token = argv[++index]
    else if (arg === '--help' || arg === '-h') { options.help = true }
    else throw new Error(`Unknown argument ${arg}`)
  }
  if (!Number.isFinite(options.timeout) || options.timeout < 5_000) options.timeout = 45_000
  return options
}

/** Reads the saved credential; the token is never printed, only whether one exists. */
function readCredential(stateDir) {
  const path = join(stateDir, 'weixin-bot.json')
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  const token = typeof raw.token === 'string' ? raw.token : ''
  const botId = typeof raw.botId === 'string' ? raw.botId : ''
  const baseUrl = typeof raw.baseUrl === 'string' && raw.baseUrl ? raw.baseUrl : 'https://ilinkai.weixin.qq.com'
  return { path, token, botId, baseUrl }
}

/** Reads the long-poll cursor the running Source persisted, without writing to the database. */
function readCursor(stateDir, botId) {
  const path = join(stateDir, 'orchestrator.sqlite')
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(CURSOR_KEY)
    if (!row) return { path, cursor: undefined, reason: 'no cursor row' }
    const stored = JSON.parse(String(row.value))
    if (stored?.botId && botId && stored.botId !== botId) return { path, cursor: undefined, reason: `cursor belongs to ${stored.botId}` }
    return { path, cursor: typeof stored?.buf === 'string' ? stored.buf : '' }
  } finally {
    db.close()
  }
}

/** One `getUpdates` long poll, echoing the given cursor unchanged. */
async function probe({ baseUrl, token, cursor, timeout }) {
  const url = `${baseUrl.replace(/\/+$/, '')}/ilink/bot/getupdates`
  const started = Date.now()
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': Buffer.from(String(Math.floor(Math.random() * 0xFFFF_FFFF)), 'utf8').toString('base64'),
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': '1',
      ...token ? { Authorization: `Bearer ${token}` } : {},
    },
    body: JSON.stringify({ get_updates_buf: cursor, base_info: {} }),
    signal: AbortSignal.timeout(timeout),
  })
  const text = await response.text()
  let reply
  try { reply = JSON.parse(text) } catch { reply = undefined }
  const body = reply && typeof reply === 'object' ? reply : {}
  return {
    httpStatus: response.status,
    elapsedMs: Date.now() - started,
    ret: typeof body.ret === 'number' ? body.ret : null,
    errcode: typeof body.errcode === 'number' ? body.errcode : null,
    errmsg: typeof body.errmsg === 'string' ? body.errmsg : null,
    messages: Array.isArray(body.msgs) ? body.msgs.length : null,
    cursorEchoed: typeof body.get_updates_buf === 'string' ? body.get_updates_buf === cursor : null,
    bodyHead: text.slice(0, 300),
  }
}

function verdictOf(result, httpStatus) {
  if (result.error) return { verdict: 'transport-error', exit: 2 }
  if (result.ret === -14 || result.errcode === -14) return { verdict: 'stale-credential', exit: 1 }
  if (httpStatus < 200 || httpStatus >= 300) return { verdict: 'http-error', exit: 2 }
  if (result.ret !== null && result.ret !== 0) return { verdict: 'api-error', exit: 2 }
  if (result.errcode !== null && result.errcode !== 0) return { verdict: 'api-error', exit: 2 }
  if (result.cursorEchoed === false) return { verdict: 'cursor-moved', exit: 0 }
  return { verdict: 'live', exit: 0 }
}

async function main() {
  let options
  try { options = parseArgs(process.argv.slice(2)) } catch (error) {
    console.error(String(error instanceof Error ? error.message : error))
    return 3
  }
  if (options.help) {
    console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').slice(1, 40).join('\n'))
    return 0
  }
  const stateDir = resolve(options.stateDir)
  let credential
  try { credential = readCredential(stateDir) } catch (error) {
    console.error(`No usable credential at ${join(stateDir, 'weixin-bot.json')}: ${String(error)}`)
    return 3
  }
  const token = options.token ?? credential.token
  if (!token) { console.error('The saved credential carries no token'); return 3 }
  const saved = readCursor(stateDir, credential.botId)
  if (saved.cursor === undefined) {
    console.error(`No usable cursor in ${saved.path}: ${saved.reason ?? 'unknown'}`)
    return 3
  }
  let result
  try {
    result = await probe({ baseUrl: credential.baseUrl, token, cursor: saved.cursor, timeout: options.timeout })
  } catch (error) {
    result = { error: String(error instanceof Error ? error.message : error) }
  }
  const { verdict, exit } = verdictOf(result, result.httpStatus ?? 0)
  const report = {
    probe: 'weixin-getupdates',
    at: new Date().toISOString(),
    stateDir,
    botId: credential.botId,
    credentialSource: options.token ? 'command line override' : credential.path,
    cursorSource: `${saved.path} kv.${CURSOR_KEY}`,
    cursorLength: saved.cursor.length,
    tokenOverride: Boolean(options.token),
    verdict,
    ...result,
  }
  if (options.json) console.log(JSON.stringify(report, null, 2))
  else {
    console.log(`verdict: ${verdict}${report.error ? ` (${report.error})` : ''}`)
    console.log(`  http ${report.httpStatus ?? '-'} in ${report.elapsedMs ?? '-'} ms; ret=${report.ret} errcode=${report.errcode}${report.errmsg ? ` (${report.errmsg})` : ''}`)
    console.log(`  messages waiting beyond the saved cursor: ${report.messages ?? '-'}; cursor echoed unchanged: ${report.cursorEchoed ?? '-'}`)
    console.log(`  credential: ${report.botId || '(no bot id)'} from ${report.credentialSource}`)
    console.log('  note: a live probe proves the credential and cursor are valid; it does not prove the Source loop is running.')
  }
  return exit
}

process.exitCode = await main()
