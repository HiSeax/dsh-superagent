/**
 * Regression gate for the Weixin Source's lifecycle: a long poll that ends without a stale-token error must not leave the
 * Source silently dead. `poll()` returns `'aborted'` when its signal aborts, but any other end of the loop (a stopped
 * wait, a socket the loop swallowed) reaches the same return, and `run()` then ends the whole Source. On 2026-11-11 that
 * left the WeChat channel silent for hours behind a stale `ready` health entry, with nothing to restart it.
 *
 * The gate drives `superviseWeixin` — the lifecycle wrapper `apply()` installs — and asserts:
 *   1. a run that ends while the signal is still live is restarted, so a second poll happens;
 *   2. the restart shows on the poll health entry and in the log, so it is visible outside the process;
 *   3. a run that ended waiting for a scan (no saved login) is left to the person scanning, not restarted.
 *
 * Network and disk: none. `poll()` and `connect()` are replaced on the instance, and the supervisor's wait is a stub.
 * See `docs/weixin-loop-liveness.md` for the production incident and the patch that made this pass.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { Health, SourceContext, SourceHost } from '../src/sources/host.ts'
import { WeixinApi, type Fetcher } from '../src/sources/weixin-api.ts'
import { WEIXIN_POLL, WeixinBot } from '../src/sources/weixin-bot.ts'
import { WeixinConfigSchema, type WeixinConfig } from '../src/sources/weixin-config.ts'
import { apply, superviseWeixin, type WeixinSupervisor } from '../src/sources/weixin.ts'
import { SOURCE } from '../src/sources/weixin-trigger.ts'

const CONFIG: WeixinConfig = WeixinConfigSchema.parse({})
const NOW = Date.parse('2026-11-11T12:00:00Z')
const LOGIN = { token: 'token-1', botId: 'bot-1', baseUrl: 'https://ilinkai.weixin.qq.com' }

/** A Source context over an in-memory state map and a temporary state directory (mirrors tests/weixin.spec.ts). */
function host(directory: string, reports: Record<string, Health>) {
  const state = new Map<string, unknown>()
  const context = {
    ready: Promise.resolve(),
    configured: () => true,
    deployment: { stateDir: directory },
    config: (id: string) => id === SOURCE ? CONFIG : undefined,
    state: {
      get: (name: string) => state.get(name),
      set: (name: string, value: unknown) => { if (value === undefined) state.delete(name); else state.set(name, value) },
    },
    receive: async () => 'stored' as const,
    report: (entry: string, health: Health) => { reports[entry] = health },
  }
  return { context: context as unknown as SourceContext, state }
}

/** A fetcher that must never be reached: this spec drives the poll loop directly. */
const offline: Fetcher = async () => { throw new Error('the offline lifecycle spec must not touch the network') }

/** A bot whose `connect()` supplies what `run()` reads from a real connection, and whose login was already confirmed. */
function connectedBot(context: SourceContext) {
  const bot = new WeixinBot({ fetcher: offline, now: () => NOW, wait: async () => {} })
  vi.spyOn(bot, 'login').mockResolvedValue(true)
  vi.spyOn(bot, 'connect').mockImplementation(() => {
    const internals = bot as unknown as { credentials?: unknown; api?: unknown }
    internals.credentials = LOGIN
    internals.api = { notify: async () => {} }
    return true
  })
  bot.attach(context)
  return bot
}

/** The supervisor `apply()` installs, with the parts a test replaces: the wait and the log. */
function supervisorOf(bot: WeixinBot, signalSource: AbortController, reports: Record<string, Health>,
  loggedIn: () => boolean, lines: string[]): WeixinSupervisor {
  return {
    run: signal => bot.run(signal),
    loggedIn,
    report: health => { reports[WEIXIN_POLL] = health },
    warn: line => { lines.push(line) },
    wait: async () => {},
  }
}

describe('weixin source lifecycle', () => {
  it('keeps polling when a poll returns "aborted" while the signal is still live', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'weixin-loop-'))
    const reports: Record<string, Health> = {}, lines: string[] = []
    const { context } = host(directory, reports)
    const bot = connectedBot(context)
    const controller = new AbortController()
    let polls = 0
    // The fault under test: a poll ends as 'aborted' even though nobody aborted the signal. Before the supervisor, `run()`
    // returned here and the Source disappeared until the plugin restarted.
    vi.spyOn(bot, 'poll').mockImplementation(async () => {
      polls += 1
      if (polls >= 2) controller.abort()
      return 'aborted'
    })

    await superviseWeixin(supervisorOf(bot, controller, reports, () => true, lines), controller.signal)

    expect(polls, 'the supervisor must not let one ended run end the Source').toBeGreaterThanOrEqual(2)
    expect(reports[WEIXIN_POLL]).toMatchObject({ state: 'starting' })
    expect(String(reports[WEIXIN_POLL]!.detail)).toContain('restarting')
    // The host watchdog judges staleness from this timestamp, so a restart report without it would read as "no timestamp".
    expect(Number.isFinite(Date.parse(String(reports[WEIXIN_POLL]!.at)))).toBe(true)
    expect(lines.join('\n')).toContain('restarting')
  })
  it('reports a loop that ends three times in a row as an error, so the host watchdog can alert', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'weixin-loop-'))
    const reports: Record<string, Health> = {}, lines: string[] = []
    const { context } = host(directory, reports)
    const bot = connectedBot(context)
    const controller = new AbortController()
    let polls = 0
    vi.spyOn(bot, 'poll').mockImplementation(async () => {
      polls += 1
      // Four polls, so the third ended run is reported before the abort that stops the supervisor.
      if (polls >= 4) controller.abort()
      return 'aborted'
    })

    await superviseWeixin(supervisorOf(bot, controller, reports, () => true, lines), controller.signal)

    expect(polls).toBeGreaterThanOrEqual(3)
    expect(reports[WEIXIN_POLL], 'each restart would otherwise refresh the timestamp of a flapping loop')
      .toMatchObject({ state: 'error' })
    expect(String(reports[WEIXIN_POLL]!.detail)).toContain('keeps ending')
  })
  it('leaves a run that ended waiting for a scan to the person scanning', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'weixin-loop-'))
    const reports: Record<string, Health> = {}, lines: string[] = []
    const { context } = host(directory, reports)
    const bot = connectedBot(context)
    const controller = new AbortController()
    let polls = 0
    vi.spyOn(bot, 'poll').mockImplementation(async () => { polls += 1; return 'aborted' })

    await superviseWeixin(supervisorOf(bot, controller, reports, () => false, lines), controller.signal)

    expect(polls, 'without a saved login a restart would only issue QR codes nobody scans').toBe(1)
    expect(lines.join('\n')).toContain('without a saved login')
  })
  it('installs that supervisor in the plugin entry, so the running Source survives an ended run', async () => {
    // Guards the wiring itself: a supervisor nothing installs would leave production exactly as broken as before, while the
    // two tests above still passed. The plugin entry is driven with a minimal Cordis context.
    const directory = mkdtempSync(join(tmpdir(), 'weixin-wire-'))
    writeFileSync(join(directory, 'weixin-bot.json'), JSON.stringify(LOGIN))
    const reports: Record<string, Health> = {}
    const { context } = host(directory, reports)
    const sourceHost = { sources: { register: () => () => {} }, context: () => context } as unknown as SourceHost
    const effects: Array<() => unknown> = []
    const ctx = {
      orchestrator: sourceHost,
      effect: (callback: () => unknown) => { effects.push(callback) },
      logger: { warn: () => {} },
    } as unknown as Context

    let polls = 0
    let dispose: (() => Promise<void>) | undefined
    let disposed: Promise<void> | undefined
    const pollSpy = vi.spyOn(WeixinBot.prototype, 'poll').mockImplementation(async () => {
      polls += 1
      if (polls >= 2) disposed = dispose?.()
      return 'aborted'
    })
    const notifySpy = vi.spyOn(WeixinApi.prototype, 'notify').mockResolvedValue(undefined)
    try {
      apply(ctx)
      // Cordis runs an effect's callback when it is installed; the second effect is the bot lifecycle.
      dispose = effects[1]!() as () => Promise<void>
      await vi.waitFor(() => { expect(polls).toBeGreaterThanOrEqual(2) }, { timeout: 5000, interval: 25 })
      // The poll that asked to stop also disposes the effect, which aborts the signal the supervisor waits on.
      await disposed
    } finally {
      pollSpy.mockRestore()
      notifySpy.mockRestore()
    }
    expect(reports[WEIXIN_POLL]).toMatchObject({ state: 'starting' })
  })
})
