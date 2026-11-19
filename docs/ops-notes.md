# Ops notes / 运维笔记

Two failures hit while running **isolated replica instances** (a throwaway profile with its own
port and a rewired copy of the state directory) for acceptance runs. Both cost a debugging
round; both are recorded here so the next person does not repeat it.
下面两条是跑**隔离副本实例**（临时 profile、独立端口、改写过的 state 目录副本）做验收时踩到的坑。
都花了一轮调试，记在这里避免重复。

---

## 1. Setup stays `setupPending` with `agentCliSignedOut` after copying a state directory

**Symptom / 现象**：the replica boots, the web UI works, but the runtime health is
`paused / setupPending` and the deployment check reports
`agentCliSignedOut — The agent GitHub CLI cannot read its account` with output like
`spawn <stateDir>\worker-bin\gh ENOENT`. Because orchestration never becomes ready, the
main Session is never created, so the sidebar has no `dsh-windows-superagent orchestrator` entry.

**Cause / 原因**：the settings snapshot inside the copied database still names the
**worker CLI shim** the *original* deployment wrote into its own `stateDir`
(`worker-bin/gh`). The copy has a different `stateDir`, so that shim does not exist there,
and `Setup` refuses to finish. / 复制的数据库里，设置仍然指向**原部署**写在自己
`stateDir` 下的 worker CLI 垫片；副本的 `stateDir` 不同，垫片不存在，`Setup` 就拒绝完成。

**Fix / 处理**：point the GitHub Source's agent CLI at the real CLI binary
(`sources.github.config.cli` → the absolute path of `gh`, e.g. `C:\Program Files\GitHub CLI\gh.exe`),
or let `Setup` run once in the new `stateDir` so it writes its own shims, then restart.
Either way the check passes and the main Session is created.
把 Source 的 agent CLI 指到真实 CLI 可执行文件，或让 `Setup` 在新 `stateDir` 里跑一次让它自己写垫片，然后重启。

---

## 2. Two plugins read `DSH_SUPERAGENT_BOARD_PORT`, and the panel can win the bind

**Symptom / 现象**：the replica's board port answers, but `/team` is 404 and `/board.json`
returns the **other** deployment's data (real tickets/members instead of the copy's), or the
orchestrator logs that its board server did not start.

**Cause / 原因**：both the orchestrator (`packages/dsh-windows-superagent`, default `8916`) and the
board panel plugin (`packages/dsh-windows-superagent-board`, default `8917`) read the same
`DSH_SUPERAGENT_BOARD_PORT` override. Setting it for one instance sets it for both, so one of
them loses the bind (`EADDRINUSE`) while the other serves the port — and the panel, whose
upstream origin defaults to `http://127.0.0.1:8916`, may proxy the *other* deployment's API.
两个插件读同一个环境变量：谁先绑到端口谁赢，另一个 `EADDRINUSE`；面板还会按默认上游去代理解析到另一个部署。

**Fix / 处理**：
- In an **isolated replica**, disable the board panel plugin in that profile's patch
  (`- id: superagent-board` / `disabled: true`) and set `DSH_SUPERAGENT_BOARD_PORT` for the
  orchestrator only; then `/board.json` and `/team` come from the copy.
- In a normal deployment, leave the variable unset (each plugin takes its own default), or
  give the panel an explicit different port so the two never collide.
隔离副本里：在 profile patch 里禁用看板插件、端口变量只留给编排器；常规部署：别设这个变量（各取默认），或给面板另配一个端口。

---

*Both entries are generic: no accounts, tokens, machine paths or project names.*
*两条均为通用描述，不含账号、token、本机路径或项目名。*
