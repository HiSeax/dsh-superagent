# Board acceptance checklist

This is what proves the board on a real DSH host. The offline part runs here without DSH; the restart part
needs the user.

## 0. Offline (already runnable)

```powershell
cd C:\Projects\superagent-board
npm install
npm run build
npm test
npm run smoke
```

`npm run smoke` starts fake superagent (8916) and aggregate (8917) servers plus a same-origin static proxy,
opens the real page in headless Chromium, and checks the team cards, ticket groups, inline confirmation,
200/409 action results and the degradation drill. It writes `artifacts/board.png`. Set `CHROME_PATH` if
Chromium is not at the default location.

`npm run smoke:workers` targets the temporary workers shown under the lead: three running workers render as
**临时工A/B/C** with their ticket titles and nothing else, ending one converges the remaining letters, a later
worker takes the last letter, and no active worker hides the block (no placeholder). It writes
`artifacts/temp-workers.png`.

### Isolated-instance gate (worker-session filter)

Before a restart that ships a changed client bundle, run the isolated gate on a throwaway profile — never the
desktop profile. The `hide-worker-sessions-self-9ae86a9` ticket's verify directory holds the script that ran
the accepted gate (16/16): `dsh web --profile boardtest --port 18080 --no-open` (with
`DSH_SUPERAGENT_BOARD_PORT` moved off 8917), headless Chromium over CDP, asserting: clean startup log (no
`did not activate` beyond the profile's known pending `dsh-windows-superagent-github`, no `SyntaxError`, no
`Cannot use import`), the served board bundle carries the filter with no bare import, the style element is
in the GUI, and — against the real, shared session store, creating nothing — the host list holds worker
sessions while none of their rows render and teammate/user rows still do.

## 1. Link into the desktop profile (user action)

1. In `<your-home>\.dsh\profiles\desktop\package.json` add:
   ```json
   "dsh-windows-superagent-board": "link:C:/Projects/superagent-board"
   ```
2. Install:
   ```powershell
   cd <your-home>\.dsh\profiles\desktop
   pnpm install
   ```
3. In `<your-home>\.dsh\profiles\desktop\cordis.patch.yml` add:
   ```yaml
   - insert:
       - id: superagent-board
         name: 'dsh-windows-superagent-board'
   ```
4. Restart DSH (desktop shortcut **重启生产 DSH** or Ctrl+Alt+R).

## 2. Verify after the restart

- [ ] The sidebar shows **看板**; selecting it opens the shell (title / 最近更新 / 刷新) with the iframe.
- [ ] No `worker-…` Session row appears in the sidebar's session list, and no worker hit appears in its
      search; teammate and ordinary user rows still render. (Two fail-open client layers hide them — see
      the README's worker-session section; a DSH upgrade that breaks both makes worker rows reappear,
      never a broken list.)
- [ ] With an agent-team Lead Session: team cards render; a member's task line shows the ticket title
      (alias), or the roster name while idle. Without the projection the team area reads
      **未获取到团队成员** and the ticket area still renders.
- [ ] With self-created tickets running: the lead card is followed by **临时工A/B/C…** rows, each showing only
      its letter and the current ticket title; the letters follow start order, a finished worker's row
      disappears and the remaining letters converge, and with no running worker the block is absent.
- [ ] Tickets are grouped by state; clicking a row opens the detail panel.
- [ ] On a working member card, **停止** first shows **确认执行？**; the second click disables with a spinner
      and then shows **已停止** inline (no system dialog).
- [ ] On a completed ticket, **重试** shows the server message **工单已结束** inline (the 409 body).
- [ ] **移出焦点** shows the cost in its title and confirmation hint:
      **移出后该工单不再接收这些线程的新消息**.
- [ ] Degradation: stop superagent (or make it unreachable); the page stays non-blank, shows
      **数据源中断**, the team area shows **未获取到团队成员**, and the ticket area keeps the last snapshot visible.
      Restart superagent and the next poll recovers.
- [ ] No regression: better-sidebar and the superagent management panel still work.

## 3. Rollback

1. Remove the `superagent-board` insert row from `cordis.patch.yml`.
2. Remove `"dsh-windows-superagent-board": "link:C:/Projects/superagent-board"` from the profile's `package.json`.
3. Run `pnpm install` in the profile (prunes the link).
4. Restart DSH.

The repository itself can stay; nothing in DSH or superagent is modified.

## 4. Known risks to check on the real host

- **iframe CSP**: the page is served by the host's own web server at `/superagent-board/` (same origin). If a
  deployment's CSP forbids framing, Task 6's fallback is to render without the iframe (shell draws directly).
- **slots API version**: registration follows DSH 0.2.x (`ctx.slots.inject/register`, `main` keyed slot +
  `sidebar.panellist`). A host release that changes the slot contract needs a matching update.
- **roster projection**: `agentTeam` exists only when the experimental agent-team layer is mounted and the
  root session leads a team; otherwise the board is ticket-only.
- **ports**: 8917 is fixed (override `DSH_SUPERAGENT_BOARD_PORT` if needed); 8916/token belong to superagent.
  Running two board instances would collide on 8917.
- **token**: 8917 reads `~/.dsh/state/superagent/board-token` (600). Missing/unreadable token degrades the
  board; it must be the same stateDir superagent uses.