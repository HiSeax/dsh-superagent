# superagent-board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the DSH subagent tool to implement this plan task-by-task (fresh subagent per task, recommended) or the executing-plans skill for inline execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 DSH 桌面端做一个独立的 `superagent-board` 侧边栏插件，一块页面同时看清团队在干什么与工单分布，并支持 stop/retry/unfocus 三个动作。

**Architecture:** superagent 暴露回环只读 `GET /board.json` 与 `POST /board/action`（Bearer token）；新插件 `superagent-board` 起回环聚合端点，把"宿主团队投影 + superagent 工单 + 别名层"合成一份数据，侧边栏页面用 React 外壳套 iframe 渲染。

**Tech Stack:** TypeScript（superagent 侧沿用现有 ESM + zod 校验）、Cordis 插件（DSH 0.2.x）、React 外壳、原生 ES 模块 iframe 前端、vitest、Playwright（无头截图）。

规格：`docs/specs/2026-11-06-superagent-board-design.md`（提交 29fa660）。

---

## 文件结构

**superagent 仓库（`C:\Projects\superagent`）**

| 文件 | 职责 |
|---|---|
| `src/app/board.ts` | 组装 `board.json`（读现有 store，不改业务） |
| `src/app/board-server.ts` | 回环 HTTP 服务 + token 校验 + 动作路由 |
| `src/app/board-types.ts` | schema 类型与 zod 校验（`schemaVersion: 1`） |
| `tests/board.spec.ts` | 契约测试（schema、降级、动作 404/409/200） |

**新插件仓库（`C:\Projects\superagent-board`）**

| 文件 | 职责 |
|---|---|
| `src/index.ts` | Cordis 插件入口：注册侧边栏页面、启动聚合 HTTP |
| `src/aggregate.ts` | 三源合并 + 别名层（纯函数，好测） |
| `src/server.ts` | `127.0.0.1:8917` HTTP，`GET /board.json` |
| `src/web/index.html` | iframe 主体 |
| `src/web/app.js` | 团队区 + 工单区渲染、动作按钮 |
| `src/web/tokens.css` | 苹果风 token（照 `C:\md文件\design\apple\DESIGN.md`） |
| `tests/aggregate.spec.ts` | 别名层与合并单测 |
| `tests/ui.smoke.mjs` | Playwright 无头截图断言 |

---

### Task 1: superagent 侧 board.json 组装

**Files:**
- Create: `src/app/board-types.ts`
- Create: `src/app/board.ts`
- Test: `tests/board.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/board.spec.ts
import { describe, it, expect } from 'vitest'
import { buildBoard } from '../src/app/board.ts'

describe('buildBoard', () => {
  it('输出 schemaVersion 1 且工单状态映射到枚举', () => {
    const board = buildBoard({
      tickets: [{ id: 'T1', title: 'Fix timezone handling in export button', state: 'working', owner: 'weixin-media-dev', updatedAt: '2026-11-06T16:00:00+08:00', summary: '已合并' }],
      members: []
    })
    expect(board.schemaVersion).toBe(1)
    expect(board.tickets[0].state).toBe('executing')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/board.spec.ts`
Expected: FAIL — `buildBoard is not a function`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/app/board-types.ts
export const BOARD_SCHEMA_VERSION = 1
export type TicketState = 'new' | 'evaluating' | 'executing' | 'review' | 'done' | 'blocked' | 'failed' | 'stopped'

const MAP: Record<string, TicketState> = {
  working: 'executing', idle: 'new', blocked: 'blocked', failed: 'failed',
  review: 'review', done: 'done', stopped: 'stopped', evaluating: 'evaluating', executing: 'executing'
}
export const toTicketState = (s: string): TicketState => MAP[s] ?? 'new'
```

```ts
// src/app/board.ts
import { BOARD_SCHEMA_VERSION, toTicketState } from './board-types.ts'

export interface BoardTicketInput { id: string; title: string; state: string; owner: string | null; updatedAt: string; summary?: string }

export const buildBoard = ({ tickets, members }: { tickets: BoardTicketInput[]; members: unknown[] }) => ({
  schemaVersion: BOARD_SCHEMA_VERSION,
  generatedAt: new Date().toISOString(),
  degraded: null,
  main: { id: 'lead', name: 'lead', role: 'lead', state: 'working' },
  members,
  tickets: tickets.map((t) => ({
    id: t.id, title: t.title, state: toTicketState(t.state),
    ownerMemberId: t.owner, updatedAt: t.updatedAt, summary: (t.summary ?? '').slice(0, 200)
  }))
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/board.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/board-types.ts src/app/board.ts tests/board.spec.ts
git commit -m "feat(board): assemble board.json payload"
```

---

### Task 2: 回环 HTTP + token + 动作路由

**Files:**
- Create: `src/app/board-server.ts`
- Modify: `src/index.ts`（插件启动时挂载）
- Test: `tests/board.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('无 token 返回 401，未知工单返回 404，已完成工单重试返回 409', async () => {
  const h = await startBoardServer({ port: 0, token: 't', action: async () => ({ ok: true }) })
  expect((await fetch(`${h.url}/board.json`)).status).toBe(401)
  const r1 = await fetch(`${h.url}/board/action`, { method: 'POST', headers: { authorization: 'Bearer t' }, body: JSON.stringify({ kind: 'stop', ticketId: 'nope' }) })
  expect(r1.status).toBe(404)
  await h.close()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/board.spec.ts -t '无 token'`
Expected: FAIL — `startBoardServer is not defined`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/app/board-server.ts
import { createServer } from 'node:http'

export async function startBoardServer({ port, token, snapshot, action }: {
  port: number
  token: string
  snapshot: () => Promise<unknown>
  action: (kind: string, ticketId: string) => Promise<{ ok: boolean; message?: string; code?: number }>
}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return }
    if (req.method === 'GET' && url.pathname === '/board.json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(await snapshot())); return
    }
    if (req.method === 'POST' && url.pathname === '/board/action') {
      let body = ''
      for await (const chunk of req) body += chunk
      const { kind, ticketId } = JSON.parse(body || '{}')
      const r = await action(kind, ticketId)
      res.writeHead(r.ok ? 200 : (r.code ?? 400), { 'content-type': 'application/json' })
      res.end(JSON.stringify(r)); return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((ok) => server.listen(port, '127.0.0.1', ok))
  const addr = server.address() as { port: number }
  return { url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((ok) => server.close(() => ok())) }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/board.spec.ts`
Expected: PASS（3 条断言全过）

- [ ] **Step 5: Commit**

```bash
git add src/app/board-server.ts tests/board.spec.ts
git commit -m "feat(board): loopback board server with token and actions"
```

---

### Task 3: 动作语义接线（复用现有 stop/retry/unfocus）

**Files:**
- Modify: `src/app/board-server.ts`（注入 action 实现）
- Modify: `src/index.ts`（把现有 orchestrator 的 stop/retry/移出焦点接进来）
- Test: `tests/board.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('stop 已停止工单返回 409，retry 不存在返回 404', async () => {
  const calls: string[] = []
  const h = await startBoardServer({ port: 0, token: 't',
    snapshot: async () => ({}),
    action: async (kind, id) => {
      calls.push(`${kind}:${id}`)
      if (id === 'missing') return { ok: false, code: 404, message: 'ticket not found' }
      if (id === 'done') return { ok: false, code: 409, message: 'ticket already finished' }
      return { ok: true }
    } })
  expect((await post(h.url, 'stop', 'done')).status).toBe(409)
  expect((await post(h.url, 'retry', 'missing')).status).toBe(404)
  expect(calls).toEqual(['stop:done', 'retry:missing'])
  await h.close()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/board.spec.ts -t 'stop 已停止'`
Expected: FAIL — 404/409 状态未透传或 action 未被调用

- [ ] **Step 3: Write minimal implementation**

在 `src/index.ts` 的插件启动处：读取 token 文件（不存在则生成 32 字节随机 hex，写 `<stateDir>/superagent/board-token`，`chmod 600`），用现有 orchestrator 实例实现 `action`：

```ts
const action = async (kind: string, ticketId: string) => {
  const ticket = orchestrator.getTicket(ticketId)
  if (!ticket) return { ok: false, code: 404, message: 'ticket not found' }
  if (kind === 'stop') return orchestrator.stop(ticketId)
  if (kind === 'retry') return orchestrator.retry(ticketId)
  if (kind === 'unfocus') return orchestrator.unfocus(ticketId)
  return { ok: false, code: 400, message: 'unknown action' }
}
```

`orchestrator.stop/retry/unfocus` 若不存在，**在本任务内**把它们抽成薄封装，内部调用现有 stop/retry 路径（`orchestrator_route` 的 stop、`orchestrator_ticket_retry`），不新写业务规则。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/board.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/app/board-server.ts tests/board.spec.ts
git commit -m "feat(board): wire stop/retry/unfocus actions"
```

---

### Task 4: 新插件骨架 + 侧边栏页面

**Files:**
- Create: `C:\Projects\superagent-board\package.json`
- Create: `C:\Projects\superagent-board\src\index.ts`（宿主半）
- Create: `C:\Projects\superagent-board\src\client.ts`（浏览器半，注册页面）
- Create: `C:\Projects\superagent-board\cordis.patch.yml`（示例，不自动启用）
- Test: `npm run build`（tsc）

- [ ] **Step 1: Create the plugin package**

```json
{
  "name": "dsh-windows-superagent-board",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "scripts": { "build": "tsc -p tsconfig.json", "test": "vitest run" },
  "peerDependencies": { "cordis": "*" }
}
```

- [ ] **Step 2: Register a sidebar page**

宿主 0.2.x **没有** `ctx.client.page`/`ctx.pages.register`。页面由**客户端插件的 slots** 注册（实测 API，见插件 README 的证据）：

```ts
// src/client.ts（浏览器半）
export const inject = ['slots']

export function apply(ctx) {
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: 'superagent-board', order: 50, label: '看板'
  }, Icon))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: 'superagent-board'
  }, Body))
}
```

（以宿主实际 API 为准；页面是 React 组件而非宿主 iframe 页；iframe 只能由组件自行渲染，其 URL 来自插件自己的 `ctx.webServer.register` 路由。\*\*先跑 `npm run build` 与一次 `dsh` 启动验证注册成功，再继续。\*\*）

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: 生成 `lib/index.js`，无 TS 错误

- [ ] **Step 4: Commit**

```bash
git init && git add -A
git commit -m "chore: plugin skeleton with sidebar page"
```

---

### Task 5: 聚合端点 + 别名层

**Files:**
- Create: `src/aggregate.ts`
- Create: `src/server.ts`
- Create: `tests/aggregate.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { aggregate } from '../src/aggregate.ts'

const team = { main: { id: 'lead', name: 'lead', role: 'lead', state: 'working' }, members: [{ id: 'local-source-dev', name: 'local-source-dev', role: 'teammate', state: 'working' }] }
const board = { schemaVersion: 1, generatedAt: 'x', degraded: null, main: team.main, members: [], tickets: [{ id: 'T1', title: 'Fix timezone handling in export button', state: 'executing', ownerMemberId: 'local-source-dev', updatedAt: 'x' }] }

describe('aggregate', () => {
  it('成员显示工单标题作为 displayName', () => {
    const r = aggregate({ team, board, now: new Date('2026-11-06T16:40:00Z') })
    expect(r.members[0].displayName).toBe('Fix timezone handling in export button')
    expect(r.members[0].ticketId).toBe('T1')
  })
  it('无工单时回退 kebab 名，超 24 字截断', () => {
    const long = '一二三四五六七八九十一二三四五六七八九十一二三四五'
    const r = aggregate({ team, board: { ...board, tickets: [{ ...board.tickets[0], title: long }] }, now: new Date() })
    expect(r.members[0].displayName.length).toBeLessThanOrEqual(25)
    expect(r.members[0].displayName.endsWith('…')).toBe(true)
    const idle = aggregate({ team, board: { ...board, tickets: [] }, now: new Date() })
    expect(idle.members[0].displayName).toBe('local-source-dev')
    expect(idle.members[0].state).toBe('idle')
  })
  it('superagent 不可用时降级', () => {
    const r = aggregate({ team, board: null, now: new Date() })
    expect(r.degraded.source).toBe('superagent')
    expect(r.members[0].state).toBe('working')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/aggregate.spec.ts`
Expected: FAIL — `aggregate` 未定义

- [ ] **Step 3: Write minimal implementation**

```ts
// src/aggregate.ts
const ACTIVE = new Set(['evaluating', 'executing', 'review'])
const clip = (s: string, n = 24) => (s.length <= n ? s : s.slice(0, n) + '…')

export function aggregate({ team, board, now }: { team: any; board: any | null; now: Date }) {
  const degraded = board ? null : { source: 'superagent', since: now.toISOString() }
  const tickets = board?.tickets ?? []
  const members = (team.members ?? []).map((m: any) => {
    const t = tickets.find((x: any) => x.ownerMemberId === m.name && ACTIVE.has(x.state))
    return {
      id: m.id, name: m.name, role: m.role,
      displayName: t ? clip(t.title) : m.name,
      state: t ? 'working' : 'idle',
      ticketId: t?.id ?? null, ticketTitle: t?.title ?? null,
      lastActivityAt: t?.updatedAt ?? null
    }
  })
  return { schemaVersion: 1, generatedAt: now.toISOString(), degraded, main: team.main, members, tickets }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/aggregate.spec.ts`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add src/aggregate.ts tests/aggregate.spec.ts
git commit -m "feat: aggregate team, tickets and alias layer"
```

---

### Task 6: iframe 前端（团队卡 + 工单区）

**Files:**
- Create: `src/web/index.html`
- Create: `src/web/app.js`
- Create: `src/web/tokens.css`
- Create: `src/shared/alias.ts`（同构别名层；宿主 `aggregate()` 与 iframe 共用）
- Modify: `src/client.ts`（页面外壳：订阅 `agentTeam` 投影、标题栏、iframe、postMessage）
- Modify: `src/index.ts`（`ctx.webServer.register` 注册 `/superagent-board` 静态路由，并代理 `board.json`/`healthz`）

- [ ] **Step 1: 写 token 与骨架**

`tokens.css` 直接照 `C:\md文件\design\apple\DESIGN.md`：

```css
:root{--canvas:#f5f5f7;--card:#fff;--ink:#1d1d1f;--muted:#7a7a7a;--accent:#0066cc;--hairline:#e0e0e0;--radius:12px}
body{margin:0;background:var(--canvas);color:var(--ink);font:13px/1.4 -apple-system,"SF Pro Text","Segoe UI",system-ui}
.card{background:var(--card);border:1px solid var(--hairline);border-radius:var(--radius);padding:12px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--accent)}
```

- [ ] **Step 2: 渲染逻辑**（外壳用 `ctx.sessions.list.getSnapshot().projectionsBySession[*].values.agentTeam` 读 Lead 的 roster，变化时 `postMessage({ type: 'roster', data: { members } })`；iframe 监听该消息，与 `board.json` 的 tickets 合并，用同构的 `import { aliasMembers } from './alias.js'` 计算 displayName；无 roster 时团队区显示“未获取到团队成员”）

```js
// src/web/app.js
const RENDER = (data) => {
  const team = document.querySelector('#team')
  team.innerHTML = [data.main, ...data.members].map((m) => `
    <div class="card" data-member="${m.id}">
      <div class="row"><span class="dot" data-state="${m.state}"></span><strong>${m.displayName}</strong></div>
      <div class="sub">${m.ticketTitle ?? '空闲'}</div>
    </div>`).join('')
  const tl = document.querySelector('#tickets')
  const groups = Object.groupBy(data.tickets, (t) => t.state)
  tl.innerHTML = Object.entries(groups).map(([k, v]) => `
    <section><h3>${k} (${v.length})</h3>${v.map((t) => `<div class="card" data-ticket="${t.id}">${t.title}</div>`).join('')}</section>`).join('')
}
async function tick() {
  const r = await fetch('board.json', { cache: 'no-store' })
  RENDER(await r.json())
}
tick(); setInterval(tick, 2500)
```

- [ ] **Step 3: 手动验证**（iframe 页面与 `GET /board.json` 必须同源：`src/server.ts` 为 `src/web` 注册静态路由；`fetch('board.json')` 是相对该路由取数）

Run: `npm run build` 后启动 DSH，打开侧边栏「看板」
Expected: 至少一张团队卡显示工单标题；工单区有分组标题

- [ ] **Step 4: Commit**

```bash
git add src/web
git commit -m "feat(web): board UI with apple tokens"
```

---

### Task 7: 动作按钮 + 二次确认 + 错误回显

**Files:**
- Modify: `src/web/app.js`
- Modify: `src/server.ts`（`POST /action` 代理到 superagent）

- [ ] **Step 1: 加按钮与内联确认**

```js
const act = async (kind, id, card) => {
  if (!card.dataset.confirm) { card.dataset.confirm = '1'; card.querySelector('.sub').textContent = '再点一次确认 ' + kind; setTimeout(() => { delete card.dataset.confirm; tick() }, 4000); return }
  const r = await fetch('action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, ticketId: id }) })
  const body = await r.json()
  card.querySelector('.sub').textContent = body.ok ? '已执行' : (body.message ?? '失败')
}
```

- [ ] **Step 2: 手动验证**

Run: 点击「停止」→ 第一次变确认文案 → 第二次执行并在行内显示结果；对已完成工单应显示服务端返回的 409 原因
Expected: 不弹系统对话框，行内回显

- [ ] **Step 3: Commit**

```bash
git add src/web/app.js src/server.ts
git commit -m "feat(web): inline-confirm actions with error display"
```

---

### Task 8: 端到端验收

**Files:**
- Create: `tests/ui.smoke.mjs`

- [ ] **Step 1: 写冒烟断言**

```js
import { chromium } from 'playwright'
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 420, height: 900 } })
await p.goto('http://127.0.0.1:8917/')
await p.waitForSelector('[data-member]')
const main = await p.locator('[data-member="lead"]').count()
const cards = await p.locator('[data-member]').count()
const dots = await p.locator('.dot').count()
const titles = await p.locator('#tickets h3').count()
console.log({ main, cards, dots, titles })
await p.screenshot({ path: 'artifacts/board.png' })
await b.close()
if (!(main === 1 && cards >= 2 && dots >= cards && titles >= 1)) process.exit(1)
```

- [ ] **Step 2: 跑冒烟**

Run: `node tests/ui.smoke.mjs`
Expected: 输出 `{ main: 1, cards: 2+, dots: cards, titles: 1+ }`，`artifacts/board.png` 生成

- [ ] **Step 3: 降级演练**

停掉 superagent 的 board server，重跑冒烟
Expected: 页面仍渲染团队卡，出现"数据源中断"提示条，不白屏

- [ ] **Step 4: 不回归检查**

Run: 打开 DSH → better-sidebar 任务页仍可用；`pnpm test`（superagent）全绿；`/color/`、`/pic/` 不受影响
Expected: 无新增失败

- [ ] **Step 5: Commit**

```bash
git add tests/ui.smoke.mjs artifacts/board.png
git commit -m "test: end-to-end board smoke and degradation drill"
```

---

## 自审

- **Spec 覆盖**：§4 数据通路→Task 1/2/3/5；§5 schema→Task 1；§6 别名层→Task 5；§8 UI→Task 6/7；§9 错误处理→Task 5 降级 + Task 7 回显；§10 验收→Task 8；§2 非目标未实现（符合）
- **占位符**：无 TBD/TODO；Task 4 的页面注册 API 留了"以宿主实际 API 为准 + 先验证"的明确兜底（属必要验证，非占位）
- **类型一致**：`displayName/ticketId/ticketTitle/state` 在 Task 5/6/7 一致；`toTicketState` 枚举在 Task 1 定义、Task 5 复用
