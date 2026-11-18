import { describe, expect, it } from 'vitest'
import { fetchSuperagentTeam, forwardTeamAction, startBoardServer } from '../src/server.ts'

const answer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
})

describe('fetchSuperagentTeam', () => {
  it('读 /team 并用 board token 鉴权，running 归一为 working，保留 sessionId', async () => {
    let seenUrl = ''
    let seenAuth = ''
    const fetcher = async (input: string, init?: RequestInit) => {
      seenUrl = input
      seenAuth = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '')
      return new Response(JSON.stringify({
        ok: true,
        teammates: [
          { id: 't-1', name: '引星主线', role: '引星项目总负责', sessionId: 'teammate-1', state: 'running', updatedAt: 'x' },
          { id: 't-2', name: 'DSH客户端', role: '任务板 owner', sessionId: 'teammate-2', state: 'idle', updatedAt: 'x' },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const team = await fetchSuperagentTeam({ token: 'board-token', fetcher })
    expect(seenUrl.endsWith('/team')).toBe(true)
    expect(seenAuth).toBe('Bearer board-token')
    expect(team!.members).toEqual([
      { id: 't-1', name: '引星主线', role: '引星项目总负责', state: 'working', sessionId: 'teammate-1' },
      { id: 't-2', name: 'DSH客户端', role: '任务板 owner', state: 'idle', sessionId: 'teammate-2' },
    ])
  })

  it('stored 保留，非法行被丢弃', async () => {
    const fetcher = answer(200, { ok: true, teammates: [
      { id: 't-3', name: '计算书技能', role: '技能 owner', state: 'stored' },
      { id: '', name: '坏行', role: 'x', state: 'idle' },
      { id: 't-4' },
    ] })
    const team = await fetchSuperagentTeam({ token: 't', fetcher })
    expect(team!.members).toEqual([{ id: 't-3', name: '计算书技能', role: '技能 owner', state: 'stored' }])
  })

  it('保留成员当前工单 id 与标题', async () => {
    const fetcher = answer(200, { ok: true, teammates: [
      { id: 't-5', name: '甲', role: '角色', state: 'running', sessionId: 'teammate-5',
        ticketId: 'ticket-1', ticketTitle: '正在做的工单' },
    ] })
    const team = await fetchSuperagentTeam({ token: 't', fetcher })
    expect(team!.members[0]).toMatchObject({ ticketId: 'ticket-1', ticketTitle: '正在做的工单' })
  })

  it('保留临时工列表及其 worker 会话，供 lead 下方渲染', async () => {
    const fetcher = answer(200, { ok: true, teammates: [], workers: [
      { sessionId: 'worker-self-a', ticketId: 'self-a', ticketTitle: '临时任务 A', startedAt: '2026-11-11T00:00:00Z' },
      { sessionId: 'worker-self-b', ticketId: 'self-b', ticketTitle: '临时任务 B', startedAt: '2026-11-11T01:00:00Z' },
    ] })
    const team = await fetchSuperagentTeam({ token: 't', fetcher })
    expect(team!.workers).toEqual([
      { sessionId: 'worker-self-a', ticketId: 'self-a', ticketTitle: '临时任务 A', startedAt: '2026-11-11T00:00:00Z' },
      { sessionId: 'worker-self-b', ticketId: 'self-b', ticketTitle: '临时任务 B', startedAt: '2026-11-11T01:00:00Z' },
    ])
  })

  it('401 或缺 token 时返回 null 且不调用上游', async () => {
    let called = false
    const team = await fetchSuperagentTeam({ token: 't', fetcher: async () => { called = true; return new Response('{}', { status: 401 }) } })
    expect(team).toBeNull()
    expect(called).toBe(true)
    called = false
    expect(await fetchSuperagentTeam({ token: null, fetcher: async () => { called = true; return new Response('{}') } })).toBeNull()
    expect(called).toBe(false)
  })
})

describe('forwardTeamAction', () => {
  it('POST /team/action 带 token，状态与 body 透传', async () => {
    let seenUrl = ''
    let seenBody = ''
    const fetcher = async (input: string, init?: RequestInit) => {
      seenUrl = input
      seenBody = String(init?.body ?? '')
      return new Response(JSON.stringify({ ok: true, removed: { id: 't-1' } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const result = await forwardTeamAction({ action: 'remove', id: 't-1' }, { token: 't', fetcher })
    expect(seenUrl.endsWith('/team/action')).toBe(true)
    expect(JSON.parse(seenBody)).toEqual({ action: 'remove', id: 't-1' })
    expect(result).toEqual({ status: 200, body: { ok: true, removed: { id: 't-1' } } })
  })

  it('409/404 的 message 原样透传给对话框', async () => {
    const rejected = await forwardTeamAction({ action: 'remove', id: 'gone' }, {
      token: 't',
      fetcher: async () => new Response(JSON.stringify({ ok: false, message: '未知成员' }), { status: 404 }),
    })
    expect(rejected).toEqual({ status: 404, body: { ok: false, message: '未知成员' } })
  })

  it('缺 token 时 502 且不调用上游', async () => {
    let called = false
    const result = await forwardTeamAction({ action: 'update', id: 't-1', name: 'x' }, {
      token: null,
      fetcher: async () => { called = true; return new Response('{}') },
    })
    expect(result.status).toBe(502)
    expect(called).toBe(false)
  })
})

describe('board server routes', () => {
  const team = {
    main: { id: 'lead', name: 'lead', role: 'lead', state: 'working' },
    members: [{ id: 't-1', name: '引星主线', role: '引星项目总负责', state: 'working', sessionId: 'teammate-1' }],
  }
  const board = {
    tickets: [{ id: 'T1', title: '修微信收图', state: 'executing', ownerMemberId: 't-1', updatedAt: '2026-11-06T16:00:00+08:00' }],
  }

  it('GET /team.json 返回名册行；GET /board.json 带成员与工单', async () => {
    const server = await startBoardServer({ port: 0, team: () => team, fetchBoard: async () => board, now: () => new Date('2026-11-09T17:00:00Z') })
    try {
      const teamView = await (await fetch(`${server.url}/team.json`)).json() as {
        teamDown: boolean; boardDown: boolean; main: { id: string }; members: Array<Record<string, unknown>> }
      expect(teamView.teamDown).toBe(false)
      expect(teamView.boardDown).toBe(false)
      expect(teamView.main.id).toBe('lead')
      expect(teamView.members[0]).toMatchObject({ id: 't-1', name: '引星主线', displayName: '引星主线', state: 'working', ticketTitle: '修微信收图', sessionId: 'teammate-1' })

      const boardData = await (await fetch(`${server.url}/board.json`)).json() as { members: unknown[]; tickets: unknown[] }
      expect(boardData.members).toHaveLength(1)
      expect(boardData.tickets).toHaveLength(1)
    } finally {
      await server.close()
    }
  })

  it('名册不可达时 /team.json 报 teamDown，成员为空', async () => {
    const server = await startBoardServer({ port: 0, team: () => null, fetchBoard: async () => board })
    try {
      const view = await (await fetch(`${server.url}/team.json`)).json() as { teamDown: boolean; members: unknown[] }
      expect(view.teamDown).toBe(true)
      expect(view.members).toEqual([])
    } finally {
      await server.close()
    }
  })

  it('给 working 成员附上运行中的直接子代理，并过滤非直接/不活跃/Side 项', async () => {
    const queried: string[] = []
    const subagents = {
      listDescendants: async (sessionId: string) => {
        queried.push(sessionId)
        return [
          { kind: 'child' as const, id: 'a', parentId: sessionId, depth: 1, activity: 'running' as const, label: '代码审查' },
          { kind: 'child' as const, id: 'b', parentId: sessionId, depth: 1, activity: 'inactive' as const, label: '已结束' },
          { kind: 'child' as const, id: 'c', parentId: sessionId, depth: 1, activity: 'running' as const, label: 'Side: 侧聊' },
          { kind: 'child' as const, id: 'd', parentId: 'other', depth: 2, activity: 'running' as const, label: '孙代理' },
          { kind: 'diagnostic' as const, id: 'diag', activity: 'running' as const, label: '坏数据' },
        ]
      },
    }
    const server = await startBoardServer({ port: 0, team: () => team, fetchBoard: async () => board, subagents })
    try {
      const view = await (await fetch(`${server.url}/team.json`)).json() as { members: Array<Record<string, unknown>> }
      expect(view.members[0]!.subagents).toEqual({ running: 1, items: [{ id: 'a', label: '代码审查' }] })
      expect(queried).toEqual(['teammate-1'])
    } finally {
      await server.close()
    }
  })

  it('subagent 服务不可用时名册不带该字段且不报错', async () => {
    const server = await startBoardServer({ port: 0, team: () => team, fetchBoard: async () => board,
      subagents: { listDescendants: async () => { throw new Error('unavailable') } } })
    try {
      const view = await (await fetch(`${server.url}/team.json`)).json() as { members: Array<Record<string, unknown>> }
      expect(view.members[0]!.subagents).toBeUndefined()
    } finally {
      await server.close()
    }
  })

  it('工单源不可达时 /team.json 仍返回名册并报 boardDown', async () => {
    const server = await startBoardServer({ port: 0, team: () => team, fetchBoard: async () => null })
    try {
      const view = await (await fetch(`${server.url}/team.json`)).json() as { teamDown: boolean; boardDown: boolean; members: unknown[] }
      expect(view.teamDown).toBe(false)
      expect(view.boardDown).toBe(true)
      expect(view.members).toHaveLength(1)
    } finally {
      await server.close()
    }
  })

  it('POST /team/action 只放行 update/remove 并透传上游状态', async () => {
    const seen: unknown[] = []
    const server = await startBoardServer({
      port: 0,
      team: () => team,
      fetchBoard: async () => board,
      teamAction: async body => {
        seen.push(body)
        const action = (body as { action: string }).action
        return action === 'remove'
          ? { status: 409, body: { ok: false, message: '成员正忙，暂不能删除' } }
          : { status: 200, body: { ok: true, teammate: { id: 't-1', name: '新名' } } }
      },
    })
    try {
      const post = (body: unknown) => fetch(`${server.url}/team/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect((await post({ action: 'add', id: 't-1' })).status).toBe(400)
      expect((await post({ action: 'update', name: '新名' })).status).toBe(400)
      expect(seen).toHaveLength(0)

      const updated = await post({ action: 'update', id: 't-1', name: '新名' })
      expect(updated.status).toBe(200)
      expect(await updated.json()).toEqual({ ok: true, teammate: { id: 't-1', name: '新名' } })

      const removed = await post({ action: 'remove', id: 't-1' })
      expect(removed.status).toBe(409)
      expect(await removed.json()).toEqual({ ok: false, message: '成员正忙，暂不能删除' })
      expect(seen).toEqual([
        { action: 'update', id: 't-1', name: '新名' },
        { action: 'remove', id: 't-1' },
      ])
    } finally {
      await server.close()
    }
  })
})
