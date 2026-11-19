import { describe, expect, it } from 'vitest'
import { forwardAction } from '../src/server.ts'

const answer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
})

describe('forwardAction', () => {
  it('200：ok 透传', async () => {
    const result = await forwardAction('stop', 'T1', { token: 't', fetcher: answer(200, { ok: true, message: '已停止' }) })
    expect(result).toEqual({ status: 200, body: { ok: true, message: '已停止' } })
  })

  it('409：已完成工单的错误与 message 透传', async () => {
    const result = await forwardAction('retry', 'done', { token: 't', fetcher: answer(409, { ok: false, message: '工单已结束' }) })
    expect(result).toEqual({ status: 409, body: { ok: false, message: '工单已结束' } })
  })

  it('404：不存在工单的状态与 message 透传', async () => {
    const result = await forwardAction('unfocus', 'missing', { token: 't', fetcher: answer(404, { ok: false, message: '工单不存在' }) })
    expect(result).toEqual({ status: 404, body: { ok: false, message: '工单不存在' } })
  })

  it('缺少 token 时 502，不调用上游', async () => {
    let called = false
    const result = await forwardAction('stop', 'T1', {
      token: null,
      fetcher: async () => { called = true; return new Response('{}') },
    })
    expect(result.status).toBe(502)
    expect(called).toBe(false)
  })
})