import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../src/web/app.js', import.meta.url), 'utf8')
const page = readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8')
const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8')

describe('board page auto-refresh', () => {
  it('polls board.json every 3 seconds and skips hidden pages', () => {
    expect(source).toContain('void pollBoard() }, 3000')
    expect(source).toContain('if (document.hidden || boardPolling) return')
    expect(source).toContain("document.addEventListener('visibilitychange'")
  })
  it('replaces ticket rows and the detail only when their data changed', () => {
    expect(source).toContain('container.dataset.signature === signature')
    expect(source).toContain('const signature = JSON.stringify({ ticket: ticket ?? null, actions: actionChanges })')
  })
  it('does not render or fetch the removed workflow block', () => {
    expect(page).not.toContain('工作流')
    expect(page).not.toContain('work-note')
    expect(source).not.toContain('work.json')
    expect(source).not.toContain('loadWork')
    expect(source).not.toContain('工作流')
  })
  it('renders at most three running subagents as little working faces plus +N', () => {
    const css = readFileSync(new URL('../src/web/tokens.css', import.meta.url), 'utf8')
    expect(source).toContain('function subagentOrbs')
    expect(source).toContain('data.items.slice(0, 3)')
    expect(source).toContain("class=\"subagent-more\"")
    // Each running helper is a small character at work, not a plain status dot.
    expect(source).toContain('subagent-eye')
    expect(source).toContain('subagent-mouth')
    expect(source).toContain('--sa-delay')
    expect(css).toContain('.member-subagents')
    expect(css).toMatch(/\.subagent-orb \{[\s\S]*?width: 14px/)
    expect(css).toContain('.subagent-mouth')
    // The at-work animation: a lean-in and an arm swing, chatter, darting eyes — never a hop off the card.
    expect(css).toContain('@keyframes subagentWork')
    expect(css).toContain('@keyframes subagentArm')
    expect(css).toContain('@keyframes subagentChatter')
    expect(css).not.toContain('@keyframes subagentWork {\n  0%, 100% { transform: translateY(0)')
    expect(css).toContain('@media (prefers-reduced-motion: reduce) {\n  .subagent-orb, .subagent-eye, .subagent-mouth, .subagent-orb::before { animation: none; }')
  })
  it('keeps the orbs absolutely placed on running cards', () => {
    // The running card stacks its children above the halo; a bare `> *` rule outranks `.member-subagents` and would
    // turn the orbs into in-flow boxes pinned to the card's top-left corner instead of the top-right.
    const css = readFileSync(new URL('../src/web/tokens.css', import.meta.url), 'utf8')
    expect(css).toContain('.member-subagents { position: absolute; top: 8px; right: 9px;')
    expect(css).toContain('.card.is-running > *:not(.card-aura):not(.member-subagents)')
    expect(css).not.toContain('.card.is-running > *:not(.card-aura) { position: relative;')
  })
  it('renders temporary workers as small cards carrying a letter and the ticket title', () => {
    const css = readFileSync(new URL('../src/web/tokens.css', import.meta.url), 'utf8')
    expect(source).toContain('temporaryWorkers.map(')
    expect(source).toContain('function temporaryLabel(index)')
    expect(source).toContain('function temporaryWorkerCard(worker, index)')
    expect(source).toContain('temp-card-ticket')
    expect(source).not.toContain('temporary-worker-session')
    expect(source).not.toContain('temp-card-state')
    expect(source).not.toContain('temp-card .avatar')
    expect(css).toContain('.temporary-workers')
    expect(css).toContain('.temp-card')
    expect(css).toMatch(/\.temp-card \{[^}]*border-radius/)
    expect(source).toContain("querySelectorAll('.team-lead .temp-card')")
    expect(css).toContain('.team-edges .edge.edge-worker')
  })
  it('draws worker branches even when there are no regular members', () => {
    expect(source).toContain('(members.length > 0 || temporaryWorkers.length > 0)')
    expect(source).toContain('edge-worker is-live')
    const css = readFileSync(new URL('../src/web/tokens.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.team-edges \.edge\.edge-worker/)
  })
  it('does not let a stale failed poll overwrite a newer result', () => {
    expect(source).toContain('const request = ++boardRequest')
    expect(source).toContain('const request = ++teamRequest')
    expect(source).toContain('if (request !== boardRequest) return')
    expect(source).toContain('if (request !== teamRequest) return')
  })
  it('allows enough time for the aggregate to reach both local endpoints', () => {
    expect(server).toContain('const FETCH_TIMEOUT_MS = 15000')
    expect(server).toContain('await Promise.allSettled([team(), fetchBoard()])')
  })
  it('debounces the interrupted banner and serializes the roster poll', () => {
    expect(source).toContain('degradedStreak >= 2')
    expect(source).toContain('if (teamPolling) return')
    expect(source).toContain('teamPolling = true')
  })
})
