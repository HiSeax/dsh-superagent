# dsh-superagent-board

Read-only **看板** page for the DSH desktop sidebar: one page that shows the team at work and the ticket
spread. This repository is the separate plugin (DSH 0.2.x); it does not fork or replace `dsh-better-sidebar`.

**Status: working board with actions.** The sidebar entry opens a shell (title / last update / refresh)
around the plugin-hosted iframe; the iframe renders team cards and grouped tickets, merges the shell's roster
with superagent's `board.json`, and runs stop / retry / unfocus with inline confirmation and inline results.

## How DSH 0.2.x registers a page (verified)

A client plugin contributes a page through the **slot registry**, not through a URL/page API:

| What | Call | Evidence |
|---|---|---|
| Sidebar entry | `ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id, order, label }, Icon))` | `@deepseek-ai/dsh-client-ui-sidebar/README.md:38`; `@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js:4484` |
| Main panel | `ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: id }, Body))` | `@deepseek-ai/dsh-client-ui-layout/README.md:32`; `@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js:4411,4418` |
| Select it | `ctx.layout.selectPanel(id)` | `@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js` (`openList`), `@deepseek-ai/dsh-client-ui-layout/README.md:32` |

The sidebar list entry and the layout's `main` keyed slot share one `id`; the Plugins page is the reference
implementation (`@deepseek-ai/dsh-client-ui-plugin-manager/README.md:119`).

**Iframe:** there is no iframe page variant. A page is a React component in the shell, so an iframe is only
something the component may render. Its URL must come from a route **the plugin itself registers** with the
host web server (`ctx.webServer.register(...)`, `@deepseek-ai/dsh-host-webserver/README.md:61`), not from a
host static page directory: the host's SPA dist is the single fallback seat owned by `frontend-static`.
Task 5's aggregate server is therefore the natural iframe source for Task 6.

## Hiding dsh-superagent worker sessions from the sidebar (investigation result)

dsh-superagent runs every ticket in its own Session (`worker-<ticketId>`, the `worker-` prefix its
`workerSessionId` mints). The core Session API has **no hidden/system flag**:

- `session.create` accepts only `workspaceId`/`cwd`/`sessionId`/`agentPreset`
  (`@deepseek-ai/dsh-api-session-controller/lib/types/types.d.ts` `SessionCreateRequest`), and
  `SessionHeader` carries no hidden field (`@deepseek-ai/dsh-session/lib/types/types.d.ts`).
- The one display-classification lever, `origin: 'subagent'`, is a trap for workers: any Session so
  marked is fenced out of generic Session routing (`hasApiSessionSubagentOwner` → `resolveAgent` rejects
  with `session/agent-busy` "use subagent delivery"), which would break the executor's prompt delivery
  to its workers. Subagent-origin Sessions are the core's own concept and its sidebar already hides them
  (`sessionVisible` in `@deepseek-ai/dsh-client-ui-workspace/lib/client.js`).

So this plugin filters client-side, in two fail-open layers (`src/shared/internal-sessions.ts`, applied in
`src/client.ts`; takes effect after the next DSH restart and covers already-existing worker sessions):

1. **`wrapSessionsList`** rebinds the `sessions` service's `list` store to a proxy that marks worker rows
   `origin: 'subagent'` — the classification the core sidebar **and its search** already hide. The manager
   keeps writing through the rebound property (every other store member forwards to the real store), and
   every failure mode (missing service, non-rebindable property, frozen instance) declines with a console
   note and leaves the service untouched.
2. **A style rule** hides sidebar rows keyed `session:worker-*` (`display:none!important`) — the floor that
   works even if a DSH upgrade changes the service shape. Fail-open means worker rows reappear, never a
   broken list.

Verified against a real isolated `dsh web --profile boardtest --port 18080` instance: the host list holds
real worker sessions, none of their rows render, teammate and user rows still do, and the style rule still
matches a synthetic worker row. The repeatable script and evidence live with the
`hide-worker-sessions-self-9ae86a9` ticket's verify directory.

**Client bundle:** a package declares `dsh.client` (`platform: 'web'`) and exports `./client`; the host serves
it under `/plugins` and loads it lazily (`@deepseek-ai/dsh-client-modules/README.md`).

## Troubleshooting: transient blank page right after a DSH restart (known phenomenon)

**A DSH restart can blank the web first screen / an open tab for a moment; a refresh or waiting for the
plugin reload restores it. Diagnose a "崩了" report by first asking whether it happened within 1–2 minutes
of a restart.** Confirmed on 2026-11-17 (user: 「现在好了，刚刚重启的时候白屏」— closed as this
phenomenon, no code change, no rollback, no restart). The same incident's evidence, so nobody re-runs it:

- **Build timestamps, not vibes:** every `lib/*` artifact shared one mtime (`2026-11-14 23:33:32`); a filter
  for writes inside the suspected window (`2026-11-17 11:00–11:50`) matched nothing. The host that started
  `11:50:24` therefore loaded the same build that had been live since `2026-11-15 01:02` — a restart alone
  does not change the served bundle.
- **Dual-environment render check:** the board page rendered identically on the desktop host
  (`http://127.0.0.1:<port>/superagent-board/`) and on an isolated instance (`--profile boardtest --port
  18095`, `DSH_SUPERAGENT_BOARD_PORT=18940`), both 11 members / 58 tickets with lead card and edges. The
  board client had also applied (its injected `style[data-dsh-superagent]` was in the DOM).
- **`/orchestrator/api/state` 403 from a bare probe is the same-origin gate, not an auth change**
  (`dsh-superagent` `src\app\http.ts:75-79`: `host` must equal `127.0.0.1:<port>`/`localhost:<port>` **and**
  carry `x-orchestrator-request: 1`). The watchdog's 200 passes because it sends that header.
- **First cold `/board.json` can take the full 15 s fetch timeout** (`FETCH_TIMEOUT_MS` in
  `src/server.ts`); warm calls answer in 77–172 ms. A single slow first call after a restart is expected,
  not a fault.

## Files

| Path | Responsibility |
|---|---|
| `src/index.ts` | Host half: starts the aggregate server, registers the `/superagent-board` web route and proxies `board.json`/`healthz`. |
| `src/client.ts` | Browser half: sidebar entry, shell header, roster subscription and `postMessage` bridge, iframe, worker-session hiding. |
| `src/server.ts` | The loopback HTTP endpoint: superagent `board.json` fetch, team injection, `GET /board.json` and `GET /healthz`. |
| `src/aggregate.ts` | Host aggregate: degraded/main/tickets plus the shared alias rows. |
| `src/shared/internal-sessions.ts` | The one worker-session filter: the id prefix, the sidebar row selector, the snapshot marker and the `sessions.list` wrap (browser only, unit-tested). |
| `src/shared/alias.ts` | The one alias implementation: active set, newest `updatedAt`, 24-character truncation (host + browser). |
| `src/web/index.html`, `app.js`, `tokens.css` | The iframe page: team cards, ticket groups, detail placeholder, apple-style tokens. |
| `cordis.patch.yml` | Example mount row only; nothing applies it automatically. |
| `tsconfig.json` | Same target/module family as `dsh-superagent` (ES2024, NodeNext). |

## Build

```powershell
cd C:\Projects\superagent-board
npm install
npm run build
```

`npm run build` writes `lib/index.js`, `lib/client.js` and `lib/server.js` (all gitignored).

## Acceptance

- Offline smoke: `npm run smoke` (fake 8916/8917 servers + headless Chromium over CDP; writes
  `artifacts/board.png`; set `CHROME_PATH` if Chromium is elsewhere). Run `npm run build` first.
- Card behaviour end to end: `node tests/e2e-board-cards.mjs --url <isolated base> --token-file <one-time token>`
  drives a real browser over the isolated board page and asserts user-select, press-vs-drag, lane reorder,
  persistence across a reload, member reorder with the edge layer redrawn, keyboard reorder and zero console
  errors; it exits non-zero on any failed check. Playwright resolves from `PLAYWRIGHT_ROOT` when the repository
  keeps it out of its own dependencies.
- The full restart checklist, link steps and rollback: [docs/acceptance.md](docs/acceptance.md).

## Page and roster

- The iframe loads `/superagent-board/` from the host web server; the route also serves `/app.js`,
  `/tokens.css`, the compiled shared `/alias.js`, and proxies `/board.json` + `/healthz` to the loopback
  aggregate server (same-origin, so no CORS).
- Team data arrives only through `postMessage` from the shell; with no roster the team area reads
  **未获取到团队成员** and the ticket area keeps rendering.

## Cards, drag and order

- Every card — member cards, ticket rows, temporary-worker cards — is one whole block: `user-select: none` plus
  a grab cursor, so card text cannot be selected; the card body is the drag handle.
- A pointer press lifts a card only after it travels past a 5 px threshold; a shorter press stays a click
  (a finished drag swallows the click underneath). While lifted, the card rides above the page as a fixed block
  and a dashed placeholder holds its slot.
- Dragging reorders **inside one lane only**: the members column, or one ticket bucket (进行中/待处理/已结束).
  Dropping onto another lane is deliberately not implemented — a ticket's bucket is its state, so a cross-lane
  drag would change ticket state, not just order; that stays a second step with its own semantics.
- The order persists in the browser (`localStorage` key `board.order.v1`, one id list per lane) and both renderers
  reapply it on every refresh, so the 3 s feed poll keeps the saved order. LocalStorage keeps the change
  client-side: no new route, no file format, and each browser keeps its own view order, which is what an ordering
  preference is. Unknown ids keep their feed order after the known ones; a lane emptied of cards forgets its
  saved list.
- Keyboard: `Tab` still focuses cards, `ArrowUp`/`ArrowDown` walk a lane, and `Alt+ArrowUp`/`Alt+ArrowDown` move
  the focused card and save the order. Temporary workers keep their A..N start order — their letters come from
  assignment start order, so they are not reorderable.

## Actions

- Member cards show **停止** only while that member is working. Ticket rows show **重试** and **移出焦点**.
- The first click arms **确认执行？** for four seconds (no system `confirm()`); a second click posts the action.
  The button disables with a spinner while it runs, and the result appears inline: **已执行** or the server's
  own message (a 409/404 message is shown verbatim).
- **移出焦点** carries the cost in its title and its confirmation hint:
  **移出后该工单不再接收这些线程的新消息**（恢复需重新订阅）.
- Call chain: iframe `POST /superagent-board/action` → host route relays the same `{ kind, ticketId }` to
  `127.0.0.1:8917/board/action` (status and body unchanged) → the 8917 server adds the superagent Bearer
  token read from `~/.dsh/state/superagent/board-token` and posts `127.0.0.1:8916/board/action`.

## Data endpoint

- `GET /board.json` returns the aggregate payload; `GET /healthz` returns `{ ok: true }`.
- `GET /team.json` also carries `workers[]` as superagent `/team` reports it: one row per live self-created ticket
  with a running/pending assignment, `{ sessionId: 'worker-<ticketId>', ticketId, ticketTitle, startedAt }`, in
  start order. The page renders 临时工A/B/C from that order under the lead card and shows only the letter and
  `ticketTitle`; a released letter is recomputed away, so the active set stays A..N, and an empty array hides
  the block entirely.
- Listen: `127.0.0.1:8917` (`DSH_SUPERAGENT_BOARD_PORT` overrides the port).
- superagent source: read `~/.dsh/state/superagent/board-token` (owned by superagent, mode 600) and fetch
  `http://127.0.0.1:8916/board.json` with `Authorization: Bearer <token>`. A missing token, timeout (1.5 s)
  or non-2xx answer yields `board: null`, which the aggregate reports as
  `degraded: { source: 'superagent', since }` while keeping the roster visible.

## Host team roster (investigation result)

The host half currently passes `members: []` and a default lead identity. This is deliberate:

- DSH exposes `ctx.agentTeams` (`@deepseek-ai/dsh-experimental-agent-team`), but every method is
  **membership-scoped**: it needs an exact live Team member Agent as the caller
  (`membership(agent)`, `listMembers(agent)`; `lib/index.js:1491-1499`). An external plugin has no such
  caller credential, and there is no "list every team" call.
- The roster a browser sees is the **Session projection** `agentTeam`
  (`lib/types/projection.js:320`; package README `:174`), read through `ctx.sessionProjections` with the
  Lead Session handle. The board package owns neither that handle nor a supported way to discover the Lead
  Session.
- `ctx.agents` is the DSH agent registry (session lookup), not a team roster: it carries no role or Team
  membership.

**The browser shell supplies the roster instead.** `src/client.ts` reads
`ctx.sessions.list.getSnapshot().projectionsBySession[sessionId].values.agentTeam` — the same projection
better-sidebar's `team-projection.ts` reads (`lib/client.js:18397-18408`) — and posts
`{ type: 'roster', data: { members: [{ id, name, role, phase, state }] } }` to the iframe. The shell also
posts `{ type: 'refresh' }` from the header button. The iframe merges that roster with `board.json`'s tickets
and computes `displayName` through `src/shared/alias.ts`, so the host half keeps `members: []` (the
`startBoardServer({ team })` injection seam remains for a future supported roster read).

## Link into the desktop profile (not done by this repository)

Nothing below is applied automatically; these are the steps to see the page.

1. Add the local package to `<your-home>\.dsh\profiles\desktop\package.json`:
   ```json
   "dsh-superagent-board": "link:C:/Projects/superagent-board"
   ```
2. Install it in the profile (pnpm, as the other local plugins):
   ```powershell
   cd <your-home>\.dsh\profiles\desktop
   pnpm install
   ```
3. Mount the plugin in `<your-home>\.dsh\profiles\desktop\cordis.patch.yml` (this patch layer does not
   auto-mount a linked package):
   ```yaml
   - insert:
       - id: superagent-board
         name: 'dsh-superagent-board'
   ```
4. Restart DSH (desktop shortcut **重启生产 DSH** or Ctrl+Alt+R).
5. The sidebar shows **看板**; selecting it opens the live board (team cards + grouped tickets).

Alternative installation route (when the CLI supports local paths): `dsh plugin --profile desktop add
C:\Projects\superagent-board`, then restart. This package deliberately does not declare a `dsh.bundle.patch`,
so its `cordis.patch.yml` stays an example rather than something an install applies.

## Next

- Task 8: end-to-end acceptance, real DSH restart check, and any visual polish after the first real run.
- When the host exposes a supported host-side team-roster read, inject it through `startBoardServer({ team })`.