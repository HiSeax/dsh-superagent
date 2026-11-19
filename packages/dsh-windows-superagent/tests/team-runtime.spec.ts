/** The team's state on a running Runtime: a live subagent keeps its teammate `running` after the teammate's turn ended. */
import { describe, expect, it } from 'vitest'
import { startRuntime } from './fixtures/host.ts'
import { TEAM_REPORT_TEMPLATE } from '../src/app/sessions.ts'

describe('Team on the Runtime', () => {
  it('registers the report tool with the fixed four-part template in its description', async () => {
    const h = await startRuntime()
    try {
      const row = await h.runtime.team.add({ name: '模板验证', role: '验证回执模板进工具说明' })
      expect(h.tools.get(row.sessionId)?.get('orchestrator_team_report')?.description).toContain(TEAM_REPORT_TEMPLATE)
    } finally {
      await h.stop()
    }
  })
  it('queues an orchestrator_team_report until the main Session takes it', async () => {
    const h = await startRuntime()
    try {
      const row = await h.runtime.team.add({ name: '回执验证', role: '验证持久报告队列' })
      const result = await h.runTool(row.sessionId, 'orchestrator_team_report', { state: 'progress', summary: '隔离回执测试 RPT-20261111-01' })
      expect(result).toMatchObject({ ok: true, queued: true })
      expect(h.runtime.team.status().pendingReports).toBe(1)
      expect(h.runtime.team.takePendingReports()).toEqual([expect.objectContaining({ name: '回执验证', summary: '隔离回执测试 RPT-20261111-01', state: 'progress' })])
      expect(h.runtime.team.status().pendingReports).toBe(0)
    } finally {
      await h.stop()
    }
  })

  it('injects pending reports when the main Session starts a step', async () => {
    const h = await startRuntime()
    try {
      const row = await h.runtime.team.add({ name: '回执注入', role: '验证主会话补投' })
      await h.runTool(row.sessionId, 'orchestrator_team_report', { state: 'blocked', summary: '需要主会话裁决', question: '继续还是停止？' })
      const agent = h.agents.get(h.runtime.masterId)
      expect(agent).toBeDefined()
      const decision = await (h.ctx as any).waterfall('agent/pre-step', { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ kind: 'enter', messages: [] })) as { kind: string; messages: { content: { type: string; text?: string }[] }[] }
      expect(decision).toMatchObject({ kind: 'enter' })
      if (decision.kind !== 'enter') throw new Error('the main pre-step rejected the report injection')
      expect(decision.messages).toHaveLength(1)
      const block = decision.messages[0]?.content[0]
      if (block?.type !== 'text') throw new Error('the report injection did not carry text')
      expect(block.text).toContain('需要主会话裁决')
      expect(block.text).toContain('Question: 继续还是停止？')
      expect(h.runtime.team.status().pendingReports).toBe(0)
    } finally {
      await h.stop()
    }
  })

  it('keeps the report tool across repeated re-decorations', async () => {
    const h = await startRuntime()
    try {
      const row = await h.runtime.team.add({ name: '重复装饰', role: '验证工具不被摘掉' })
      const agent = h.agents.get(row.sessionId)
      if (agent === undefined) throw new Error('the added teammate has no Agent')
      for (let round = 0; round < 3; round += 1) {
        await (h.ctx as any).parallel('agent/created', { agent, source: 'startup' })
        const result = await h.runTool(row.sessionId, 'orchestrator_team_report', { state: 'progress', summary: `第 ${round + 1} 轮仍可报告` })
        expect(result).toMatchObject({ ok: true, queued: true })
      }
      const visible = (await h.runtime.team.list()).find(item => item.sessionId === row.sessionId)
      expect(visible?.tools.hasReport).toBe(true)
      expect(visible?.tools.count).toBeGreaterThan(0)
      h.runtime.team.takePendingReports()
    } finally {
      await h.stop()
    }
  })

  it('reports running while a teammate subagent is live after the teammate turn ended', async () => {
    const h = await startRuntime()
    try {
      const row = await h.runtime.team.add({ name: '子代理验收', role: '验收子代理状态' })
      const agent = h.agents.get(row.sessionId)
      expect(agent).toBeDefined()
      if (agent === undefined) throw new Error('the added teammate has no Agent')
      agent.status = 'idle'
      const teamRow = async () => (await h.runtime.team.list()).find(item => item.sessionId === row.sessionId)
      expect(await teamRow()).toMatchObject({ state: 'idle' })

      const child = h.subagents.spawn(row.sessionId)
      expect(h.agents.get(child)?.status).toBe('running')
      expect(await teamRow()).toMatchObject({ state: 'running' })

      // Settling the child wakes the idle teammate, whose own result turn keeps it running; once that turn ends it is idle.
      h.subagents.settle(child)
      expect(h.agents.get(child)).toBeUndefined()
      expect(await teamRow()).toMatchObject({ state: 'running' })
      agent.status = 'idle'
      expect(await teamRow()).toMatchObject({ state: 'idle' })
    } finally {
      await h.stop()
    }
  })
})
