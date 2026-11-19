import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const client = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8')
const shared = readFileSync(new URL('../src/shared/internal-sessions.ts', import.meta.url), 'utf8')

describe('internal worker sessions', () => {
  it('hides only worker-* rows in the Workspace sidebar', () => {
    expect(shared).toContain('export const INTERNAL_SESSION_SELECTOR = \'[data-row-key^="session:worker-"]\'')
    expect(client).toContain('style.textContent = INTERNAL_SESSION_SELECTOR + \'{display:none!important}\'')
    expect(client).toContain('hideInternalSessionRows()')
  })

  it('marks worker rows for the core sidebar and search through the sessions service', () => {
    expect(client).toContain("export const inject = ['betterSidebar', 'uiWorkspace', 'sessions']")
    expect(client).toContain('wrapSessionsList(ctx.sessions)')
    expect(shared).toContain("row.origin !== 'subagent'")
    expect(shared).toContain("{ ...row, origin: 'subagent' }")
  })
})
