import { describe, expect, it } from 'vitest'
import { aggregate } from '../src/aggregate.ts'

const team = {
  main: { id: 'lead', name: 'lead', role: 'lead', state: 'working' },
  members: [{ id: 't-1', name: '引星主线', role: '引星项目总负责', state: 'working', sessionId: 'teammate-1' }],
}
const board = {
  schemaVersion: 1,
  generatedAt: 'x',
  degraded: null,
  main: team.main,
  members: [],
  tickets: [{ id: 'T1', title: '修微信收图', state: 'executing', ownerMemberId: 't-1', updatedAt: '2026-11-06T16:00:00+08:00' }],
}

describe('aggregate', () => {
  it('显示名与角色始终取名册，工单只填当前工单', () => {
    const r = aggregate({ team, board, now: new Date('2026-11-06T16:40:00Z') })
    expect(r.members[0]!.displayName).toBe('引星主线')
    expect(r.members[0]!.role).toBe('引星项目总负责')
    expect(r.members[0]!.ticketId).toBe('T1')
    expect(r.members[0]!.ticketTitle).toBe('修微信收图')
    expect(r.members[0]!.state).toBe('working')
  })

  it('成员可用 id、name 或 sessionId 匹配工单负责人', () => {
    for (const owner of ['t-1', '引星主线', 'teammate-1']) {
      const r = aggregate({ team, board: { ...board, tickets: [{ ...board.tickets[0]!, ownerMemberId: owner }] }, now: new Date() })
      expect(r.members[0]!.ticketId, owner).toBe('T1')
    }
  })

  it('无工单时保留名册名与状态', () => {
    const idleTeam = { ...team, members: [{ ...team.members[0]!, state: 'idle' }] }
    const r = aggregate({ team: idleTeam, board: { ...board, tickets: [] }, now: new Date() })
    expect(r.members[0]!.displayName).toBe('引星主线')
    expect(r.members[0]!.state).toBe('idle')
    expect(r.members[0]!.ticketTitle).toBeNull()
  })

  it('stored 状态原样保留', () => {
    const storedTeam = { ...team, members: [{ ...team.members[0]!, state: 'stored' }] }
    const r = aggregate({ team: storedTeam, board, now: new Date() })
    expect(r.members[0]!.state).toBe('stored')
  })

  it('superagent 不可用时降级但名册状态保留', () => {
    const r = aggregate({ team, board: null, now: new Date() })
    expect(r.degraded!.source).toBe('superagent')
    expect(r.members[0]!.state).toBe('working')
    expect(r.members[0]!.displayName).toBe('引星主线')
  })

  it('多工单取 updatedAt 最新的活跃工单', () => {
    const r = aggregate({
      team,
      board: {
        ...board,
        tickets: [
          { ...board.tickets[0]!, id: 'T-old', title: '旧工单', updatedAt: '2026-11-06T10:00:00+08:00' },
          { ...board.tickets[0]!, id: 'T-new', title: '新工单', state: 'review', updatedAt: '2026-11-06T11:00:00+08:00' },
          { ...board.tickets[0]!, id: 'T-done', title: '已完成', state: 'done', updatedAt: '2026-11-06T12:00:00+08:00' },
        ],
      },
      now: new Date(),
    })
    expect(r.members[0]!.ticketTitle).toBe('新工单')
    expect(r.members[0]!.ticketId).toBe('T-new')
  })

  it('名册不可达时标记 teamDown 且成员为空', () => {
    const r = aggregate({ team: { main: team.main, members: [] }, board, now: new Date(), teamDown: true })
    expect(r.teamDown).toBe(true)
    expect(r.members).toEqual([])
  })
})
