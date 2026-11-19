# Concepts: how one message becomes one pull request

This is the short version. The normative description lives in the orchestrator's own docs —
start with [`packages/dsh-windows-superagent/docs/002-authorization.md`](../packages/dsh-windows-superagent/docs/002-authorization.md)
(authorization) and [`packages/dsh-windows-superagent/docs/007-architecture.md`](../packages/dsh-windows-superagent/docs/007-architecture.md)
(the Engine and its five parts).

```
 Channel (Source)          Gate (Eval)              Engine                     Executor             You
 ─────────────────         ──────────────           ───────────────────────    ─────────────────    ─────────────
 GitHub / Feishu /   ──▶   explicit? inferred?  ──▶ accept ─▶ Ticket     ──▶  worker-<id>    ──▶  acknowledgement
 local DSH Session         admission table          + Mandate + Subscriptions  + teammates          answer / result
 Weixin (iLink)            accept: off/observe/auto                            Report / blocked     attention (needs you)
```

## The five parts of the Engine

| Part | Responsibility |
| --- | --- |
| `Intake` | Stores a Source's Trigger once with its disposition, records it on its Threads, fans it out to subscribed Tickets, and queues it for Eval unless a person's message already reached a Ticket. |
| `Evals` | Batching, gate strength (explicit / inferred / not admitted), actor and basis, deadlines and re-queues, candidates, replays and hand-backs, and the Decision each Eval ends with: accept, stop, ignore or unavailable. |
| `Tickets` | The Ticket lifecycle: creation from an accept with its Mandate and Subscriptions, the Threads it follows, attached and context Threads, Inputs and notes, resume, retry, restart, stop and end, and the notice of a Policy change. |
| `Assignments` | What the Executor and its teammates report: an Assignment started, Inputs reached it or failed to, a restart interrupted it, and a worker's Report with its question for a person. |
| `Replies` | Channel writes through the Outbox: acknowledgement, answer, result and attention — each by the rule that allows it. |

## The three ideas that make it safe to let it act

1. **Mandate.** Every Ticket is created with a Mandate that records *why* it exists: the
   matched rule, the requester, and the Policy version it was accepted under. A Policy
   change can revoke it on revalidation.
2. **Strength.** A message is either an **explicit request** (a listed person addressing
   the agent), an **inferred candidate** (assessed; only accepted in `auto` mode), or
   **not admitted**. `observe` mode records *would accept* without acting, so you can tune
   the rules by reading decisions instead of watching it work.
3. **Ownership.** While a Ticket is live it owns its Thread. Follow-ups go to its Executor
   to decide; the main Session may only stop it on a person's request. When the Ticket ends
   it releases the follow-ups nobody read.

## Ticket states you will see on the board

`working` (an Executor owns it), `blocked` / `failed` (it needs a person), `waiting`
(a turn ended and it is waiting for review or CI), `ended` (its Threads closed and the work
reported `ready`), plus `stopped` and `merged`/`closed`.

## Where to read next

| Topic | Document |
| --- | --- |
| Philosophy: as little attention as possible | [`packages/dsh-windows-superagent/docs/000-philosophy.md`](../packages/dsh-windows-superagent/docs/000-philosophy.md) |
| Domain model: Trigger, Ticket, Thread, Mandate | [`packages/dsh-windows-superagent/docs/001-domain.md`](../packages/dsh-windows-superagent/docs/001-domain.md) |
| Authorization: Eval, admission, accept modes, rules | [`packages/dsh-windows-superagent/docs/002-authorization.md`](../packages/dsh-windows-superagent/docs/002-authorization.md) |
| Execution: Executor, teammates, recovery, delivery | [`packages/dsh-windows-superagent/docs/003-execution.md`](../packages/dsh-windows-superagent/docs/003-execution.md) |
| Prompts: what the main Session and workers are told | [`packages/dsh-windows-superagent/docs/004-prompts.md`](../packages/dsh-windows-superagent/docs/004-prompts.md) |
| Panel: the web board | [`packages/dsh-windows-superagent/docs/005-panel.md`](../packages/dsh-windows-superagent/docs/005-panel.md) |
| Deployment: manual setup, configuration, upgrades | [`packages/dsh-windows-superagent/docs/006-deployment.md`](../packages/dsh-windows-superagent/docs/006-deployment.md) |
| Architecture: the Engine, command by command | [`packages/dsh-windows-superagent/docs/007-architecture.md`](../packages/dsh-windows-superagent/docs/007-architecture.md) |
| Cookbook: adding a Source | [`packages/dsh-windows-superagent/docs/008-cookbook.md`](../packages/dsh-windows-superagent/docs/008-cookbook.md) |
