/** The runtime team: a persisted roster, the Session each teammate runs in, and the runtime edits no restart needs. */
import { describe, expect, it, vi } from 'vitest'
// Load the tool/resource module chain in the order the application does, as every tool test does.
import '../src/app/cards.ts'
import type { Context } from '@deepseek-ai/cordis'
import { WorkspaceUnknownSessionError } from '@deepseek-ai/dsh-workspace'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { UserError } from '../src/core/errors.ts'
import { KV } from '../src/kv.ts'
import type { Store } from '../src/app/store.ts'
import { Team, isWorkingSelfTicket, type Teammate } from '../src/app/team.ts'
import type { Ticket } from '../src/core/model.ts'
import { teamTools } from '../src/app/tools/team.ts'

/** A Store key-value area over a Map, with the roster typed as `Team` writes it. */
function memory(): Pick<Store, 'get' | 'set'> {
  const records = new Map<string, unknown>()
  return { get: (<V>(name: string) => records.get(name) as V | undefined) as Store['get'],
    set: (<V>(name: string, value: V) => { records.set(name, value) }) as Store['set'] }
}
const rosterOf = (store: Pick<Store, 'get'>): Teammate[] => store.get(KV.team.roster) ?? []

/** A host whose Session lifecycle calls are recorded, with the DSH services `Team` reads. */
function host(options: { ensureFail?: Error; adoptFail?: Error; wakeFail?: Error; archiveFail?: Error; archived?: boolean; noSubagents?: boolean; tickets?: Ticket[] } = {}) {
  const store = memory(), ensured: unknown[][] = [], adopted: unknown[][] = [], prompted: unknown[][] = [], waked: unknown[][] = []
  const renamed: { sessionId: string; title: string }[] = [], archived: { sessionId: string; stopActivity?: boolean }[] = []
  const agents = new Map<string, { status: string }>()
  const children = new Map<string, { parent: string }>()
  const subagents = {
    listChildren: vi.fn(async (parent: string) => [...children].filter(([, child]) => child.parent === parent).map(([id]) => ({ id }))),
  }
  const context = {
    get: (name: string) => name === 'subagents' && options.noSubagents !== true ? subagents : undefined,
    agents: { get: (id: string) => agents.get(id) },
    sessionController: { rename: async (request: { sessionId: string; title: string }) => { renamed.push(request) } },
    workspaceRegistry: {
      archivedSessionIds: options.archived ? ['teammate-known'] as SessionId[] : [] as SessionId[],
      archiveSession: async (sessionId: SessionId, archiveOptions?: { stopActivity?: boolean }) => {
        if (options.archiveFail) throw options.archiveFail
        archived.push({ sessionId, ...archiveOptions })
      },
    },
  } as unknown as Context
  const sessions = {
    ensure: async (...args: unknown[]) => { if (options.ensureFail) throw options.ensureFail; ensured.push(args) },
    adopt: async (...args: unknown[]) => { if (options.adoptFail) throw options.adoptFail; adopted.push(args) },
    wake: async (...args: unknown[]) => { if (options.wakeFail) throw options.wakeFail; waked.push(args) },
    prompt: async (...args: unknown[]) => { prompted.push(args) },
  }
  const withTickets = options.tickets === undefined ? store : { ...store, tickets: { list: () => options.tickets! } }
  const team = new Team({ context, store: withTickets as never, sessions: sessions as never, stateDir: 'C:/work' })
  return { team, store, agents, children, subagents, ensured, adopted, prompted, waked, renamed, archived }
}

describe('Team', () => {
  it('adds a teammate, stores the roster, and creates its Session with the display name', async () => {
    const h = host()
    const row = await h.team.add({ name: '审稿人', role: '审查每个补丁并给出证据' })
    expect(row.name).toBe('审稿人')
    expect(row.state).toBe('stored')
    expect(h.ensured[0]!.slice(0, 2)).toEqual([row.sessionId, 'C:/work'])
    expect(h.ensured[0]!.slice(2)).toEqual(['审稿人', 'teammate'])
    expect(rosterOf(h.store)).toEqual([expect.objectContaining({ id: row.id, name: '审稿人', role: '审查每个补丁并给出证据', sessionId: row.sessionId })])
    expect(h.team.brief(row.sessionId)).toEqual({ id: row.id, name: '审稿人', role: '审查每个补丁并给出证据' })
  })

  it('adopts an existing Session by id instead of creating one', async () => {
    const h = host()
    const row = await h.team.add({ name: '旧队友', role: '接手已有会话', sessionId: 'teammate-known' })
    expect(h.ensured).toEqual([])
    expect(h.adopted[0]).toEqual(['teammate-known', '旧队友'])
    expect(row.sessionId).toBe('teammate-known')
  })

  it('rolls the roster back when the Session cannot be created or adopted', async () => {
    const failed = host({ ensureFail: new Error('creation failed') })
    await expect(failed.team.add({ name: '甲', role: '角色' })).rejects.toThrow('creation failed')
    expect(rosterOf(failed.store)).toEqual([])
    const missing = host({ adoptFail: Object.assign(new Error('no session'), { code: 'session/not-found' }) })
    await expect(missing.team.add({ name: '乙', role: '角色', sessionId: 'teammate-gone' })).rejects.toMatchObject({ code: 'teammateNotAdoptable' })
    expect(rosterOf(missing.store)).toEqual([])
  })

  it('refuses a duplicate name or a Session the team already runs', async () => {
    const h = host()
    const first = await h.team.add({ name: '甲', role: '角色' })
    await expect(h.team.add({ name: '甲', role: '另一个角色' })).rejects.toBeInstanceOf(UserError)
    await expect(h.team.add({ name: '乙', role: '角色', sessionId: first.sessionId })).rejects.toMatchObject({ code: 'teammateNotAdoptable' })
  })

  it('reports the live state of a teammate whose Session is loaded', async () => {
    const h = host()
    const row = await h.team.add({ name: '甲', role: '角色' })
    expect((await h.team.list())[0]!.state).toBe('stored')
    h.agents.set(row.sessionId, { status: 'running' })
    expect((await h.team.list())[0]!.state).toBe('running')
  })

  it('reports the newest live ticket owned by or running in a teammate Session', async () => {
    const h = host()
    const row = await h.team.add({ name: '甲', role: '角色' })
    const base = { ended: undefined, assignments: [{ state: 'running' }] }
    ;(h.store as unknown as { tickets: { list: () => unknown[] } }).tickets = { list: () => [
      { ...base, id: 'old', title: '旧工单', rows: [{ state: 'running' }], updatedAt: '2026-11-11T00:00:00Z', owner: row.id },
      { ...base, id: 'new', title: '新工单', updatedAt: '2026-11-11T01:00:00Z', owner: '甲' },
      { ...base, id: 'ended', title: '已结束', updatedAt: '2026-11-11T02:00:00Z', owner: row.id, ended: { at: 'x', by: 'human', outcome: 'completed' } },
    ] }
    const listed = (await h.team.list())[0]!
    expect(listed).toMatchObject({ ticketId: 'new', ticketTitle: '新工单' })
  })

  it('omits ticket fields when no live ticket belongs to the teammate', async () => {
    const h = host()
    const row = await h.team.add({ name: '乙', role: '角色' })
    ;(h.store as unknown as { tickets: { list: () => unknown[] } }).tickets = { list: () => [] }
    const listed = (await h.team.list())[0]!
    expect(listed.ticketId).toBeUndefined()
    expect(listed.ticketTitle).toBeUndefined()
    expect(row.sessionId).toBeTruthy()
  })

  it('lists live self tickets as temporary workers in active order', async () => {
    const h = host()
    ;(h.store as unknown as { tickets: { list: () => unknown[] } }).tickets = { list: () => [
      { id: 'self-b', title: '第二个', origin: { kind: 'self' }, createdAt: '2026-11-11T01:00:00Z', updatedAt: '2026-11-11T01:00:00Z',
        assignments: [{ state: 'running', startedAt: '2026-11-11T01:00:01Z', createdAt: '2026-11-11T01:00:00Z' }] },
      { id: 'self-a', title: '第一个', origin: { kind: 'self' }, createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-11T00:00:00Z',
        assignments: [{ state: 'running', startedAt: '2026-11-11T00:00:01Z', createdAt: '2026-11-11T00:00:00Z' }] },
      { id: 'self-ended', title: '已结束', origin: { kind: 'self' }, createdAt: '2026-11-11T02:00:00Z', updatedAt: '2026-11-11T02:00:00Z',
        assignments: [{ state: 'running', startedAt: '2026-11-11T02:00:01Z', createdAt: '2026-11-11T02:00:00Z' }],
        ended: { at: 'x', by: 'human', outcome: 'completed' } },
    ] }
    const workers = h.team.status().workers
    expect(workers.map(worker => worker.ticketId)).toEqual(['self-a', 'self-b'])
    expect(workers[0]).toMatchObject({ sessionId: 'worker-self-a', ticketTitle: '第一个' })
  })

  it('reports running while a subagent is live after the teammate turn ended', async () => {
    const h = host()
    const row = await h.team.add({ name: '甲', role: '角色' })
    h.agents.set(row.sessionId, { status: 'idle' })
    expect((await h.team.list())[0]!.state).toBe('idle')

    h.children.set('child-1', { parent: row.sessionId })
    h.agents.set('child-1', { status: 'running' })
    expect((await h.team.list())[0]!.state).toBe('running')
    expect(h.subagents.listChildren).toHaveBeenCalledWith(row.sessionId)

    // A settled child keeps its catalog row but has no Agent.
    h.agents.delete('child-1')
    expect((await h.team.list())[0]!.state).toBe('idle')
  })

  it('reports running for its own turn even when the catalog read fails, and idle after it', async () => {
    const h = host()
    const row = await h.team.add({ name: '甲', role: '角色' })
    h.agents.set(row.sessionId, { status: 'running' })
    h.subagents.listChildren.mockRejectedValueOnce(new Error('sessionQuery unavailable'))
    expect((await h.team.list())[0]!.state).toBe('running')
    h.agents.set(row.sessionId, { status: 'idle' })
    h.subagents.listChildren.mockRejectedValueOnce(new Error('sessionQuery unavailable'))
    expect((await h.team.list())[0]!.state).toBe('idle')
  })

  it('keeps idle when DSH has no subagents service', async () => {
    const h = host({ noSubagents: true })
    const row = await h.team.add({ name: '甲', role: '角色' })
    h.agents.set(row.sessionId, { status: 'idle' })
    expect((await h.team.list())[0]!.state).toBe('idle')
  })

  it('reports stored for an unloaded teammate without reading its child catalog', async () => {
    const h = host()
    const row = await h.team.add({ name: '甲', role: '角色' })
    h.children.set('child-1', { parent: row.sessionId })
    h.agents.set('child-1', { status: 'running' })
    expect((await h.team.list())[0]!.state).toBe('stored')
    expect(h.subagents.listChildren).not.toHaveBeenCalled()
  })

  it('updates the name, the responsibility and the brief; a new name renames the Session', async () => {
    const h = host()
    const row = await h.team.add({ name: '甲', role: '角色', brief: '先读 CHANGELOG' })
    const updated = await h.team.update(row.id, { name: '乙', role: '新角色', brief: '' })
    expect(updated).toMatchObject({ id: row.id, name: '乙', role: '新角色' })
    expect(h.renamed).toEqual([{ sessionId: row.sessionId, title: '乙' }])
    expect(h.team.brief(row.sessionId)).toEqual({ id: row.id, name: '乙', role: '新角色' })
    expect(rosterOf(h.store)[0]).not.toHaveProperty('brief')
  })

  it('refuses an edit to a name another teammate has, and an edit to an unknown teammate', async () => {
    const h = host()
    await h.team.add({ name: '甲', role: '角色' })
    await h.team.add({ name: '乙', role: '角色' })
    await expect(h.team.update('乙', { name: '甲' })).rejects.toMatchObject({ code: 'teammateNameTaken' })
    await expect(h.team.update('丙', { role: '角色' })).rejects.toMatchObject({ code: 'unknownTeammate' })
  })

  it('removes a teammate by archiving its Session with its work stopped, and drops the roster row', async () => {
    const h = host()
    const row = await h.team.add({ name: '甲', role: '角色' })
    expect(await h.team.remove(row.id)).toEqual({ id: row.id, name: '甲', sessionId: row.sessionId, archived: true })
    expect(h.archived).toEqual([{ sessionId: row.sessionId, stopActivity: true }])
    expect(rosterOf(h.store)).toEqual([])
    expect(await h.team.list()).toEqual([])
  })

  it('removes a teammate whose Session is already gone, and one whose Session was archived already', async () => {
    const missing = await host().team.add({ name: '甲', role: '角色' })
    const unknown = new WorkspaceUnknownSessionError(missing.sessionId as SessionId, 'archive')
    const h = host({ archiveFail: unknown })
    const row = await h.team.add({ name: '甲', role: '角色' })
    expect(await h.team.remove(row.id)).toEqual({ id: row.id, name: '甲', sessionId: row.sessionId, archived: false })
    expect(rosterOf(h.store)).toEqual([])
    const archived = host({ archived: true })
    const known = await archived.team.add({ name: '乙', role: '角色', sessionId: 'teammate-known' })
    expect(await archived.team.remove(known.id)).toEqual(expect.objectContaining({ archived: true }))
    expect(archived.archived).toEqual([])
  })

  it('keeps the teammate when archiving fails for a reason other than a missing Session', async () => {
    const h = host({ archiveFail: new Error('storage fault') })
    const row = await h.team.add({ name: '甲', role: '角色' })
    await expect(h.team.remove(row.id)).rejects.toThrow('storage fault')
    expect(await h.team.list()).toHaveLength(1)
  })

  it('sends a message into the teammate Session in the requested mode', async () => {
    const h = host()
    const row = await h.team.add({ name: '甲', role: '角色' })
    expect(await h.team.message(row.id, '看一下这个补丁', 'steer')).toEqual({ id: row.id, sessionId: row.sessionId, mode: 'steer' })
    expect(h.prompted[0]!.slice(0, 2)).toEqual([row.sessionId, expect.stringMatching(/^team-message:/)])
    expect(h.prompted[0]!.slice(2)).toEqual(['看一下这个补丁', 'steer'])
    expect(h.waked).toEqual([[row.sessionId]])
    expect(h.team.status().lastWakeAt).toEqual(expect.any(String))
    await expect(h.team.message('不存在', '嗨', 'queue')).rejects.toMatchObject({ code: 'unknownTeammate' })
  })

  it('wakes a stored teammate before prompting and throws when the wake fails', async () => {
    const h = host()
    const row = await h.team.add({ name: '甲', role: '角色' })
    await h.team.message(row.id, '在吗', 'queue')
    expect(h.waked).toEqual([[row.sessionId]])
    expect(h.prompted).toHaveLength(1)

    const failed = host({ wakeFail: new Error('session/not-found') })
    const row2 = await failed.team.add({ name: '乙', role: '角色' })
    await expect(failed.team.message(row2.id, '在吗', 'queue')).rejects.toThrow(/Could not wake teammate 乙/)
    expect(failed.prompted).toEqual([])
  })

  it('persists teammate reports until the main turn takes them', () => {
    const h = host()
    const first = h.team.queueReport({ teammateId: 't-1', name: '甲', sessionId: 's-1', state: 'ready', summary: '完成了' })
    const second = h.team.queueReport({ teammateId: 't-2', name: '乙', sessionId: 's-2', state: 'blocked', summary: '需要决定', question: '选 A 还是 B' })
    expect(first.id).not.toBe(second.id)
    expect(h.team.status().pendingReports).toBe(2)
    expect(h.team.takePendingReports().map(report => report.id)).toEqual([first.id, second.id])
    expect(h.team.status().pendingReports).toBe(0)
  })
})

describe('teamTools', () => {
  it('offers the main Session the runtime team operations', () => {
    const h = host()
    const names = teamTools({ team: h.team }).map(tool => tool.name).sort()
    expect(names).toEqual(['orchestrator_team_add', 'orchestrator_team_list', 'orchestrator_team_message',
      'orchestrator_team_remove', 'orchestrator_team_update'])
  })
  it('lists the roster through the list tool', async () => {
    const h = host()
    const row = await h.team.add({ name: '甲', role: '角色' })
    const list = teamTools({ team: h.team }).find(tool => tool.name === 'orchestrator_team_list')!
    expect(await list.execute({}, new AbortController().signal)).toEqual({ teammates: [expect.objectContaining({ id: row.id })] })
  })
})

describe('temporary workers', () => {
  const selfTicket = (over: Record<string, unknown> = {}): Ticket => ({
    id: 'self-1', title: '临时任务', decisionId: 'd', mandate: {} as never, channels: [], assignments: [], inputs: [],
    undelivered: [], createdAt: '2026-11-11T10:41:32.680Z', updatedAt: '2026-11-11T10:57:42.531Z',
    origin: { kind: 'self', triggerId: '', triggerIds: [] }, ...over,
  } as unknown as Ticket)
  const running = [{ id: 'a1', state: 'running', createdAt: '2026-11-11T10:41:33.476Z' }]
  it('counts a self ticket whose worker runs, and not one waiting on a person', () => {
    expect(isWorkingSelfTicket(selfTicket({ assignments: running }))).toBe(true)
    // The worker asked a question, so the ticket waits for a person: the board lists it as 待人工, not as a temporary worker.
    expect(isWorkingSelfTicket(selfTicket({ assignments: running, attention: { id: 'q', question: '选 A 还是 B' } }))).toBe(false)
    expect(isWorkingSelfTicket(selfTicket({ assignments: [{ id: 'a1', state: 'pending', createdAt: '2026-11-11T10:41:33.476Z' }] }))).toBe(true)
    expect(isWorkingSelfTicket(selfTicket({ assignments: running, ended: { at: '2026-11-11T11:00:00.000Z', by: 'executor', outcome: 'completed' } }))).toBe(false)
    expect(isWorkingSelfTicket(selfTicket({ assignments: running, origin: { kind: 'trigger', triggerId: 'x', triggerIds: ['x'] } }))).toBe(false)
  })
  it('leaves a ticket dispatched to a teammate to that teammate card, not to the lead temporary workers', () => {
    const h = host({ tickets: [selfTicket({ id: 'self-owned', assignments: running, owner: 't-1' }),
      selfTicket({ id: 'self-free', assignments: running })] })
    expect(h.team.status().workers.map(worker => worker.ticketId)).toEqual(['self-free'])
  })
})
