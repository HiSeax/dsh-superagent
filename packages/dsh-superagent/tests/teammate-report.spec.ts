/**
 * The teammate report guard: a teammate turn that produced work must reach the main Session even when the teammate never
 * calls `orchestrator_team_report` (the 2026-11-12 incident: four turns answered in-session, none reported). This spec covers
 * the pure fold that decides whether a turn produced work and whether it reported; the wake and fallback report are wired in
 * `Sessions.install()` and verified against a running instance.
 */
import { describe, expect, it } from 'vitest'
import { foldTeammateTurn } from '../src/app/sessions.ts'
import type { RetryHealthEvent } from '../src/app/retry-health.ts'

let seq = 0
const event = (type: string, data: unknown): RetryHealthEvent => ({ type, seq: seq++, time: Date.now(), data })
const started = (turn = 7) => foldTeammateTurn(undefined, event('turn/start', { turn }))!
const call = (name: string) => event('tool/call', { turn: 7, step: 1, name, arguments: '{}' })
const said = (text: string) => event('assistant/message', { turn: 7, step: 2, message: { role: 'assistant', content: [{ type: 'text', text }] } })

describe('teammate report guard', () => {
  it('starts a turn with nothing worked and nothing reported', () => {
    expect(started()).toEqual({ turn: 7, worked: false, reported: false, tools: [], lastText: '' })
  })
  it('counts a producing tool call as work, once per tool name', () => {
    const turn = [call('write'), call('write'), call('pwsh')].reduce(foldTeammateTurn, started())
    expect(turn).toMatchObject({ worked: true, reported: false, tools: ['write', 'pwsh'] })
  })
  it('does not count reads, searches or a peer message as work', () => {
    const turn = [call('read'), call('grep'), call('send_message'), call('list_agents')].reduce(foldTeammateTurn, started())
    expect(turn).toMatchObject({ worked: false, reported: false, tools: [] })
  })
  it('marks the turn reported when the teammate calls orchestrator_team_report', () => {
    const turn = [call('write'), call('orchestrator_team_report')].reduce(foldTeammateTurn, started())
    expect(turn).toMatchObject({ worked: true, reported: true })
  })
  it('keeps the last assistant text for a fallback report, and the work flag across it', () => {
    const turn = [call('edit'), said('第一段'), said('最后一段结论')].reduce(foldTeammateTurn, started())
    expect(turn).toMatchObject({ worked: true, lastText: '最后一段结论' })
  })
  it('starts a new turn when the next turn/start arrives', () => {
    const first = [call('write')].reduce(foldTeammateTurn, started(7))
    expect(foldTeammateTurn(first, event('turn/start', { turn: 8 }))).toEqual({ turn: 8, worked: false, reported: false, tools: [], lastText: '' })
  })
  it('leaves the turn alone for events it does not read', () => {
    const turn = [call('write')].reduce(foldTeammateTurn, started())
    for (const type of ['step/start', 'step/end', 'job/registered', 'turn/end']) expect(foldTeammateTurn(turn, event(type, { turn: 7 }))).toEqual(turn)
  })
})
