import { describe, expect, it } from 'vitest'
import { buildBoard } from '../src/app/board.ts'
import { startBoardServer } from '../src/app/board-server.ts'
import { boardActions } from '../src/app/board-actions.ts'
import { UserError } from '../src/core/errors.ts'

describe('buildBoard', () => {
  it('输出 schemaVersion 1 且工单状态映射到枚举', () => {
    const board = buildBoard({
      tickets: [{ id: 'T1', title: 'Fix timezone handling in export button', state: 'working', owner: 'weixin-media-dev', updatedAt: '2026-11-06T16:00:00+08:00', summary: '已合并' }],
      members: [],
    })
    expect(board.schemaVersion).toBe(1)
    expect(board.tickets[0]!.state).toBe('executing')
  })
  it('marks a self-owned ticket with main ownership and the self origin', () => {
    const board = buildBoard({
      tickets: [{ id: 'S1', title: '巡检', state: 'executing', owner: 'main', ownerKind: 'main', ownerLabel: '主会话自建',
        origin: 'self', updatedAt: '2026-11-11T06:15:36Z' }],
      members: [],
    })
    expect(board.tickets[0]).toMatchObject({ ownerMemberId: 'main', ownerKind: 'main', ownerLabel: '主会话自建', origin: 'self' })
  })
})

describe('startBoardServer', () => {
  it('无 token 返回 401，未知工单返回 404，已完成工单重试返回 409', async () => {
    const h = await startBoardServer({
      port: 0,
      token: 't',
      snapshot: async () => ({ schemaVersion: 1 }),
      action: async (_kind, ticketId) => {
        if (ticketId === 'nope') return { ok: false, code: 404, message: '工单不存在' }
        if (ticketId === 'done') return { ok: false, code: 409, message: '已完成工单不能重试' }
        return { ok: true }
      },
    })
    try {
      expect((await fetch(`${h.url}/board.json`)).status).toBe(401)
      const authorized = await fetch(`${h.url}/board.json`, { headers: { authorization: 'Bearer t' } })
      expect(authorized.status).toBe(200)
      expect(await authorized.json()).toEqual({ schemaVersion: 1 })
      const r1 = await fetch(`${h.url}/board/action`, { method: 'POST', headers: { authorization: 'Bearer t' }, body: JSON.stringify({ kind: 'stop', ticketId: 'nope' }) })
      expect(r1.status).toBe(404)
      const r2 = await fetch(`${h.url}/board/action`, { method: 'POST', headers: { authorization: 'Bearer t' }, body: JSON.stringify({ kind: 'retry', ticketId: 'done' }) })
      expect(r2.status).toBe(409)
      const r3 = await fetch(`${h.url}/board/action`, { method: 'POST', headers: { authorization: 'Bearer t' }, body: JSON.stringify({ kind: 'stop', ticketId: 'T1' }) })
      expect(r3.status).toBe(200)
      expect(await r3.json()).toEqual({ ok: true })
    } finally {
      await h.close()
    }
  })

  it('未知 kind 返回 400', async () => {
    const h = await startBoardServer({ port: 0, token: 't', snapshot: async () => ({}), action: async () => ({ ok: true }) })
    try {
      const response = await fetch(`${h.url}/board/action`, { method: 'POST', headers: { authorization: 'Bearer t' }, body: JSON.stringify({ kind: 'explode', ticketId: 'T1' }) })
      expect(response.status).toBe(400)
    } finally {
      await h.close()
    }
  })
})
describe('team routes', () => {
  const calls: string[] = []
  const team = {
    list: () => [{ id: 't-1', name: '审稿人', role: '审查补丁', sessionId: 'teammate-1', state: 'running', updatedAt: 'T' }],
    add: async (input: { name: string; role: string }) => { calls.push(`add:${input.name}`); return { id: 't-2', ...input } },
    update: async (teammate: string, patch: { name?: string }) => { calls.push(`update:${teammate}:${patch.name}`); return { id: teammate, ...patch } },
    remove: async (teammate: string) => { calls.push(`remove:${teammate}`); return { id: teammate, archived: true } },
    message: async (teammate: string, text: string, mode: string) => { calls.push(`message:${teammate}:${mode}`); return { id: teammate, text, mode } },
    status: () => ({ lastWakeAt: '2026-11-11T01:00:00.000Z', pendingReports: 2 }),
  }
  it('无 token 401；列名单与增/改/删/发消息各返回结果', async () => {
    const h = await startBoardServer({ port: 0, token: 't', snapshot: async () => ({}), action: async () => ({ ok: true }), team })
    try {
      expect((await fetch(`${h.url}/team`)).status).toBe(401)
      const list = await fetch(`${h.url}/team`, { headers: { authorization: 'Bearer t' } })
      expect(await list.json()).toEqual({ ok: true, teammates: [expect.objectContaining({ id: 't-1' })], lastWakeAt: '2026-11-11T01:00:00.000Z', pendingReports: 2 })
      const post = (body: unknown) => fetch(`${h.url}/team/action`, { method: 'POST', headers: { authorization: 'Bearer t' }, body: JSON.stringify(body) })
      expect(await (await post({ action: 'add', name: '甲', role: '角色' })).json()).toEqual({ ok: true, teammate: expect.objectContaining({ id: 't-2' }) })
      expect(await (await post({ action: 'update', id: 't-2', name: '乙' })).json()).toEqual({ ok: true, teammate: expect.objectContaining({ name: '乙' }) })
      expect(await (await post({ action: 'remove', id: 't-2' })).json()).toEqual({ ok: true, removed: { id: 't-2', archived: true } })
      expect(await (await post({ action: 'message', id: 't-2', text: '看这个', mode: 'steer' })).json())
        .toEqual({ ok: true, message: expect.objectContaining({ mode: 'steer' }) })
      expect(calls).toEqual(['add:甲', 'update:t-2:乙', 'remove:t-2', 'message:t-2:steer'])
    } finally {
      await h.close()
    }
  })

  it('等待异步名册后再返回，子代理运行态能到达路由', async () => {
    const asyncTeam = { ...team, list: async () => [{ id: 't-1', name: '审稿人', role: '审查补丁', sessionId: 'teammate-1', state: 'running', updatedAt: 'T' }] }
    const h = await startBoardServer({ port: 0, token: 't', snapshot: async () => ({}), action: async () => ({ ok: true }), team: asyncTeam })
    try {
      const response = await fetch(`${h.url}/team`, { headers: { authorization: 'Bearer t' } })
      expect(await response.json()).toEqual({ ok: true, teammates: [expect.objectContaining({ id: 't-1', state: 'running' })], lastWakeAt: '2026-11-11T01:00:00.000Z', pendingReports: 2 })
    } finally {
      await h.close()
    }
  })

  it('非法动作 400，未知成员按 missing 映射 404', async () => {
    const refusing = { ...team, remove: async (teammate: string) => { throw new UserError('unknownTeammate', { teammate }) } }
    const h = await startBoardServer({ port: 0, token: 't', snapshot: async () => ({}), action: async () => ({ ok: true }), team: refusing })
    try {
      const post = (body: unknown) => fetch(`${h.url}/team/action`, { method: 'POST', headers: { authorization: 'Bearer t' }, body: JSON.stringify(body) })
      expect((await post({ action: 'explode' })).status).toBe(400)
      expect((await post({ action: 'add', name: '' })).status).toBe(400)
      const missing = await post({ action: 'remove', id: 'nobody' })
      expect(missing.status).toBe(404)
      expect(await missing.json()).toMatchObject({ ok: false, message: expect.stringContaining('nobody') })
    } finally {
      await h.close()
    }
  })

  it('未托管团队时这些路由返回 404', async () => {
    const h = await startBoardServer({ port: 0, token: 't', snapshot: async () => ({}), action: async () => ({ ok: true }) })
    try {
      expect((await fetch(`${h.url}/team`, { headers: { authorization: 'Bearer t' } })).status).toBe(404)
    } finally {
      await h.close()
    }
  })
})
describe('boardActions', () => {
  const stores = {
    known: {
      tickets: { get: (id: string) => id === 'missing' ? undefined : { id, ended: id === 'done' ? { outcome: 'stopped' } : undefined } },
      threads: { list: () => [{ key: 'threadA', subscriptions: ['T1'] }, { key: 'threadB', subscriptions: ['T1'] }, { key: 'other', subscriptions: ['T2'] }] },
    },
    noThreads: {
      tickets: { get: () => ({ id: 'T1', ended: undefined }) },
      threads: { list: () => [] },
    },
  }
  const calls: string[] = []
  const engine = {
    stopTicket: (id: string) => { calls.push(`stop:${id}`); return { id } },
    retryTicket: (id: string) => { calls.push(`retry:${id}`); return { id } },
    unsubscribe: (thread: string) => { calls.push(`unsubscribe:${thread}`); return true },
  }

  it('不存在 404，已完成 409，正常 200', async () => {
    calls.length = 0
    const action = boardActions(stores.known, engine)
    expect(await action('stop', 'missing')).toMatchObject({ ok: false, code: 404 })
    expect(await action('stop', 'done')).toMatchObject({ ok: false, code: 409 })
    expect(await action('stop', 'T1')).toMatchObject({ ok: true })
    expect(await action('retry', 'T1')).toMatchObject({ ok: true })
    expect(calls).toEqual(['stop:T1', 'retry:T1'])
  })

  it('unfocus 取消该工单所有订阅线程并返回数量', async () => {
    calls.length = 0
    const action = boardActions(stores.known, engine)
    expect(await action('unfocus', 'T1')).toMatchObject({ ok: true, unsubscribed: 2 })
    expect(calls).toEqual(['unsubscribe:threadA', 'unsubscribe:threadB'])
  })

  it('unfocus 无线程时回 200、0 和说明', async () => {
    const action = boardActions(stores.noThreads, engine)
    expect(await action('unfocus', 'T1')).toMatchObject({ ok: true, unsubscribed: 0, message: '该工单没有订阅线程' })
  })

  it('引擎拒绝时按 missing 映射 404，其余 409', async () => {
    const rejecting = {
      stopTicket: () => { throw new UserError('ticketEnded') },
      retryTicket: () => { throw new UserError('notRetryable') },
      unsubscribe: () => true,
    }
    const action = boardActions(stores.known, rejecting)
    expect(await action('stop', 'T1')).toMatchObject({ ok: false, code: 409 })
    expect(await action('retry', 'T1')).toMatchObject({ ok: false, code: 409 })
    const missingEngine = { stopTicket: () => { throw new UserError('unknownTicket') }, retryTicket: () => ({}), unsubscribe: () => true }
    expect(await boardActions(stores.known, missingEngine)('stop', 'T1')).toMatchObject({ ok: false, code: 404 })
  })
})