import { describe, expect, it } from 'vitest'
import { TEAM_REPORT_DESCRIPTION, TEAM_REPORT_TEMPLATE, teammateSection, teammateText } from '../src/app/sessions.ts'
import type { TeammateBrief } from '../src/app/team.ts'

describe('teammate system prompt', () => {
  it('ends with the fixed four-part report template, the same one its report tool describes', () => {
    const text = teammateText({ id: 't-template', name: '回执', role: '回执模板' })
    expect(text.endsWith(TEAM_REPORT_TEMPLATE)).toBe(true)
    for (const part of ['1. 结论：', '2. 证据：', '3. 未完成/阻塞：', '4. 需要拍板：']) expect(text).toContain(part)
    // The report tool's description ends with the same constant, so the prompt and the tool cannot describe different receipts.
    expect(TEAM_REPORT_DESCRIPTION.endsWith(TEAM_REPORT_TEMPLATE)).toBe(true)
  })
  it('encourages subagents and keeps document close-out with the teammate', () => {
    const text = teammateText({ id: 't-test', name: '验收', role: '验收任务' })
    expect(text).toContain('Prefer subagents')
    expect(text).toContain('verify their results yourself')
    expect(text).toContain('Do not hand the whole document close-out to a subagent')
  })
  it('renders the teammate section, and reports one warning while the roster misses the Session', () => {
    const brief: TeammateBrief = { id: 't-1', name: '甲', role: '角色' }
    let current: TeammateBrief | undefined = brief
    let warnings = 0
    const text = teammateSection(() => current, () => { warnings++ })
    expect(text()).toBe(teammateText(brief))
    current = undefined
    expect(text()).toBe('')
    expect(text()).toBe('')
    // One warning per absence, not one per prompt composition.
    expect(warnings).toBe(1)
    current = brief
    expect(text()).toBe(teammateText(brief))
    current = undefined
    expect(text()).toBe('')
    expect(warnings).toBe(2)
  })
})
