# dsh-superagent (release snapshot)

> **Research prototype for reference only — not an official DeepSeek product.** This
> code grew out of day-to-day development work, with much of the engineering done by
> coding agents. Treat it as research code, not production-ready software. Review and
> adapt it before using it in your own environment. It is derived from the upstream
> research prototype and is **not** identical to the internal version or to the
> implementation described in *Exploring Super-agent Design: Towards a More
> Autonomous Agent System*.
>
> 中文文档（默认）：**[README.md](README.md)**

`dsh-superagent` is a **proactive coding agent for one GitHub repository**, packaged as
a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/) **0.2+**. It listens
to GitHub and, optionally, Feishu, a local DSH Session, or a personal WeChat account
through its iLink bot. When someone allowed asks the agent for work, it opens a work item
(a **ticket**), works on it in its own agent session and directory, and answers in the
original conversation — for example with a pull request. A web **board** shows what needs
a person.

The working principle: **take as little human attention as possible, and give as much
value as possible.** It acts only when asked, or when a rule the team wrote allows it, and
it speaks only when someone must act or can use a result.

---

## Screenshots

All screenshots come from an **isolated demo instance** (separate profile, separate port,
temporary `stateDir`) running **fabricated** data — fictional teammates, fictional tickets,
no credentials, no real project names.

| Board overview — team at work and ticket spread | Ticket detail — mandate, assignment, report |
| --- | --- |
| ![Board overview](docs/screenshots/board-overview.png) | ![Ticket detail](docs/screenshots/board-ticket-card.png) |

| Teammates — who is working on what | Blocked / needs a person |
| --- | --- |
| ![Teammates](docs/screenshots/board-teammates.png) | ![Needs a person](docs/screenshots/board-needs-person.png) |

### WeChat channel (real usage, sanitized)

The board shots above are a demo instance with fabricated data. The next one is a
**real** WeChat conversation through the iLink bot channel: a person asks for work in
chat and the agent replies with its plan in the same chat.

![WeChat channel — a request in, a plan back](docs/screenshots/weixin-channel-demo.png)

*Real usage screenshot. Cropped to the conversation bubbles only — the phone status bar,
the app top bar (account / bot name) and the input bar are removed. No credentials,
paths, phone numbers or personal names are visible.*

## What's in this repository

```
dsh-superagent-release/
├── README.md (中文) / README.en.md (English)      bilingual overview (this file)
├── LICENSE                          MIT, shared by both packages
├── SETUP.md                         deployment walkthrough (start here)
├── docs/
│   ├── concepts.md                  the pipeline: eval → dispatch → ticket → teammate → report
│   ├── screenshots/                 demo-instance screenshots (fabricated data)
├── examples/
│   ├── profiles/desktop/cordis.patch.example.yml   sanitized profile mount example
│   ├── policy.admission.example.md                 admission table, accept modes, rules
│   └── walkthrough.md                              one message → one ticket → one PR
└── packages/
    ├── dsh-superagent/              the orchestrator plugin (Sources, Engine, Policy,
    │                                prompts, executor, channels, docs 000–008, tests)
    └── dsh-superagent-board/        the read-only board panel (DSH 0.2.x client plugin)
```

The two packages are independent DSH plugins. `dsh-superagent-board` does not fork or
replace `dsh-better-sidebar`; it registers its own sidebar entry and main panel.

## How it works

One message travels through five stages. Each stage is described in depth in
[`packages/dsh-superagent/docs/`](packages/dsh-superagent/docs/002-authorization.md) and
[`docs/concepts.md`](docs/concepts.md).

1. **Source → Trigger.** A channel (GitHub, Feishu, local DSH Session, Weixin) records a
   message as a **Trigger** and whether it addresses the agent (`mention` / `direct`).
2. **Eval (the gate).** The gate checks the sender and the Source's **Policy**: an allowed
   person addressing the agent is an **explicit request**; other messages go through the
   **admission table** (per receiving scope, up to three cells: explicit / inferred /
   ignore) and the **accept mode**:
   - `off` — nothing inferred becomes a candidate;
   - `observe` *(default)* — inferred candidates are assessed, a positive assessment is
     recorded as *ignore — "would accept"*, nothing is accepted;
   - `auto` — a positive assessment of an inferred candidate accepts it.
3. **Dispatch.** The main Session routes explicit candidates with `orchestrator_route`
   (accept / attach / stop / ignore, several per call). **Accept** creates, atomically, a
   **Ticket**, its **Mandate** (the matched rule), **Subscriptions** to the thread, the
   first **Assignment**, and an acknowledgement reply.
4. **Ticket → Executor → Teammates.** Each Ticket gets its own Executor Session
   (`worker-<ticketId>`) and its own directory. It can spawn **teammate** sub-sessions for
   parallel subtasks. Work is reported back as Assignments; a question for a person marks
   the Ticket `blocked`.
5. **Report / Reply.** The Executor reports and the channel writes an **acknowledgement**,
   an **answer**, a **result**, or an **attention** message — each only by the rule that
   allows it. The board surfaces what needs a person.

## How this differs from the official baseline

There is no "official superagent" product to compare against; the honest baselines are
(a) **DeepSeek Harness 0.2 base** — the host, which has no proactive orchestration — and
(b) **the upstream research prototype** this code is derived from
([`vHao11/dsh-superagent@windows-adapt`](https://github.com/vHao11/dsh-superagent/tree/windows-adapt)),
which is Unix-only in practice. What this release adds on top of those:

| Area | Baseline (DSH 0.2 host / upstream prototype) | This release |
| --- | --- | --- |
| Proactive orchestration | None in the host: sessions are started by a person | Source → Eval → Ticket → Executor → Report pipeline with policy-gated accept |
| Operating system | Upstream prototype is Unix-only in practice (`fcntl`, `tmux`, `#!/bin/sh` shims, `bash` tool, `/…`-only paths) | **Windows adaptation**: drive/UNC paths, `PATHEXT`, `pwsh` shell tool, `windowsHide`, case-insensitive paths, `waitForStateLock()`, tmux/fcntl-free service manager (`scripts/dsh-superagent.mjs`/`.cmd`), `install-windows.ps1` |
| Service lifecycle on Windows | Upstream service manager targets tmux | PID identity check before `taskkill /T /F` (fail-closed), DSH ≥ 0.2 version gate, explicit-profiles-only installer |
| Channels | GitHub + Feishu in the upstream prototype | GitHub, Feishu, **local DSH Session**, and **personal WeChat via iLink bot** |
| Human surface | Terminal / logs | **Board panel** in the DSH sidebar: team cards, grouped tickets, stop / retry / unfocus with inline confirmation |
| Authorization | Ad-hoc allow-lists | Versioned **Policy**: admission table per receiving scope, accept modes `off`/`observe`/`auto`, proactive rules, Mandate recording the matched rules and Policy version |
| Assessment tooling | — | **Eval toolchain**: batching, gate strength, assessment per enabled rule, re-queue on Policy change, `candidate` / `decide` commands |
| Packaging | Research checkout | Monorepo release snapshot: orchestrator + board + sanitized config/policy examples + bilingual docs |

## Why you might pick this (and the pain it removes)

| Capability | Pain it removes |
| --- | --- |
| **Windows-friendly** | Upstream prototype practically requires Unix. Here the drive/UNC paths, `PATHEXT`, `pwsh` shell tool and hidden console windows mean it runs on a normal Windows workstation without WSL. Pain removed: "it installs on Windows and then fails at runtime". |
| **WeChat (iLink bot) channel** | Team chat is where requests actually happen. A personal WeChat account can hand work to the agent and get the result back in the same chat. Pain removed: copy-pasting between chat and terminal. |
| **Board panel** | Long-running agent work is invisible. The board shows the team, the ticket spread, and what is blocked. Pain removed: "what is the agent doing right now?" |
| **Ticket / dispatch / report orchestration** | One giant chat loses context and authority. Each ticket has its own session, directory, Mandate and thread subscriptions; reports come back as structured Assignments. Pain removed: "which conversation owned this change?" |
| **Policy-gated accept (`off` / `observe` / `auto`)** | An agent that can act for a whole team can also waste a whole team's attention. `observe` records *would accept* without acting; `auto` acts only on a matching rule; Mandates record why. Pain removed: "why did it do that?" and "can I let it act without watching?" |
| **Eval toolchain** | Proactive work needs an auditable decision, not a vibe. Every assessment judges each enabled rule exactly once, decisions are recorded, and a Policy change re-queues affected work. Pain removed: no audit trail for proactive actions. |

## When to use it — and when not to

**Good fit**

- One repository, one team, and a channel people already use (GitHub, Feishu, WeChat).
- You want an agent that opens branches and pull requests, and reports back in the same
  conversation.
- You are willing to review `observe`-mode decisions before enabling `auto`.
- Windows workstation, DSH 0.2+.

**Not a good fit**

- You want a polished, supported product — this is a research prototype with rough edges
  (see the disclaimer and the known limitations in
  [`packages/dsh-superagent/WINDOWS-ADAPT.md`](packages/dsh-superagent/WINDOWS-ADAPT.md)).
- You need multi-repo orchestration — the design is one repository per agent.
- You cannot accept that worker sessions run commands as your OS user, or that on Windows
  `blockedCommands` is not enforced for workers (use a dedicated OS account and the agent's
  own GitHub account if that isolation matters).

## Install

Prerequisites: **DeepSeek Harness 0.2+** (the `dsh` CLI), **Node.js ≥ 18**, **pnpm**.

```powershell
# 1) Build both packages (typecheck + tests + build)
pnpm install
pnpm --filter dsh-superagent check
pnpm --filter dsh-superagent-board build

# 2) Create a dedicated profile and point the plugin at a state directory
#    (full walkthrough: SETUP.md, or ask your coding agent to follow SETUP.md)
$dsh = "C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh superagent --from-default-profile web
powershell -ExecutionPolicy Bypass -File packages\dsh-superagent\scripts\install-windows.ps1 -Profile superagent -Dsh $dsh -DryRun
powershell -ExecutionPolicy Bypass -File packages\dsh-superagent\scripts\install-windows.ps1 -Profile superagent -Dsh $dsh

# 3) Set `stateDir` in <DSH_HOME>\profiles\superagent\cordis.patch.yml
#    (see examples/profiles/desktop/cordis.patch.example.yml)

# 4) Start the service and open the panel (the one-time panel URL is printed to
#    .artifacts\dsh-superagent-superagent-*.log)
node packages\dsh-superagent\scripts\dsh-superagent.mjs status --profile superagent   # 0 healthy / 1 down / 2 part failed / 3 waiting for setup
node packages\dsh-superagent\scripts\dsh-superagent.mjs start  --profile superagent
```

Unix-shaped environments can follow the upstream-style path in
[`packages/dsh-superagent/SETUP.md`](packages/dsh-superagent/SETUP.md) instead.

## Configuration reference

| What | Where | Example |
| --- | --- | --- |
| Plugin mount, `stateDir`, heartbeat, projects, channels | `<DSH_HOME>\profiles\<profile>\cordis.patch.yml` | [`examples/profiles/desktop/cordis.patch.example.yml`](examples/profiles/desktop/cordis.patch.example.yml) |
| Admission table, accept mode, proactive rules | the orchestrator Policy (Settings schemas / Source cards) | [`examples/policy.admission.example.md`](examples/policy.admission.example.md) |
| Executor environment | set per Assignment | `DSH_SUPERAGENT_DIR`, `DSH_SUPERAGENT_NAME`, `DSH_SUPERAGENT_TICKET`, `DSH_SUPERAGENT_BLOCKED_COMMANDS` |
| Heartbeat (proactive follow-up) | plugin `config.heartbeat` | `enabled`, `intervalMinutes`, `activeFrom`, `activeTo`, `brief` |

> Windows caveat: `blockedCommands` is **not** enforced for workers on Windows (the worker
> shim is a `#!/bin/sh` script). Use the agent's own GitHub account and a dedicated OS
> account if command isolation matters.

## Skills

The orchestrator works with **any DSH skill library** — it does not ship or require a
particular set of skills; point your DSH profile at whichever skills you already use.

## Board and MCP tools

- **Board** (`packages/dsh-superagent-board`): a read-only-at-a-glance panel that merges the
  host roster with the orchestrator's `board.json`, renders team cards and grouped tickets,
  and runs stop / retry / unfocus with inline confirmation. It hides `worker-*` sessions
  from the sidebar (fail-open, two layers).
- **Engine commands** (used by the main Session and the panel): `candidate`, `decide`,
  `attach`, `requestStatus`, `note`, `reply`, `stopTicket`, `retryTicket`, `reevaluate`,
  `unsubscribe`, `dismiss`, `receive`, `bindThread`, `threadClosed`, `evaluateDue`,
  `policyChanged`, and the Executor-side `assignmentStarted`, `inputsRead`, `turnEnded`,
  `deliveryFailed`, `report`, `markUnrelated`, `followForContext`, `handback`,
  `assignmentInterrupted`.
- **Related DSH plugins** (not part of this repository): MCP tool providers such as a
  specification search server or an outputs reader can be mounted alongside it.

## Development

```powershell
pnpm --filter dsh-superagent check        # typecheck + vitest + build
pnpm --filter dsh-superagent-board typecheck
pnpm --filter dsh-superagent-board test
pnpm --filter dsh-superagent-board smoke
```

Some upstream tests are environment-bound on Windows (symlinks, `chmod` modes, the
tmux-based service-script spec) and fail there by construction — see the known limitations
in [`packages/dsh-superagent/WINDOWS-ADAPT.md`](packages/dsh-superagent/WINDOWS-ADAPT.md).

## Disclaimer and license

- **Research prototype, reference only.** It may contain bugs; coding style and engineering
  practices may be inconsistent. It is adapted for publication and is not identical to any
  internal version.
- **Not an official DeepSeek product.** DeepSeek Harness itself is a separate product and is
  **not** included here; this repository only contains the two plugins and their docs.
- **Fabricated demo data.** All screenshots use fictional teammates, tickets and projects.
- License: **MIT** for both packages — see [`LICENSE`](LICENSE). Third-party dependencies
  carry their own licenses (see each package's manifest).
