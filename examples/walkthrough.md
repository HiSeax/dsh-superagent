# Example walkthrough: one message → one ticket → one pull request

A sanitized, fabricated end-to-end example. Names, tickets and repos are made up.

## Cast (all fictional)

| Role | Name |
| --- | --- |
| Operator (human, on the list) | `dana` |
| Teammate (human, not on the list) | `sam` |
| Orchestrator main Session | `dsh-windows-superagent` |
| Executor Session for the ticket | `worker-tkt-4f2a` |
| Channel | GitHub (repo `acme/widgets`) |

## 1. Trigger arrives (Source → Intake)

`dana` opens a new Issue: *"The export button ignores the timezone setting."*
The GitHub Source receives it and records a **Trigger**; because `dana` is on the
list and addresses the agent, the gate classifies it as an **explicit request**.

## 2. Eval decides (Evals)

The main Session receives the candidate and assesses it against the enabled
rules. It accepts with `orchestrator_route`. **Accept** creates, atomically:

- a **Ticket** (`tkt-4f2a`) with a **Mandate** recording the matched rule
  (`triage-new-issue`);
- **Subscriptions** to the Issue thread;
- the first **Assignment**;
- an **acknowledgement** reply in the channel.

An **inferred** candidate (say `sam`, not on the list, follows up on a Thread that
already has a Ticket) would be assessed instead; in `observe` mode a positive
assessment is recorded as *ignore — would accept*, and in `auto` mode it is
accepted.

## 3. Dispatch to an Executor (Assignments)

The Ticket is dispatched to its own Executor Session, `worker-tkt-4f2a`, running
in its own directory. The Executor receives the Mandate, the matched rule names
and the team prompt sections. It works in its own Session — it does **not**
inherit the operator's conversation.

## 4. Teammate work and reporting

The Executor may spawn **teammate** sub-sessions for parallel subtasks (reproduce,
fix, test). Reports come back as **Assignments**: `assignmentStarted`, `inputsRead`,
`turnEnded`, and finally a **Report**. If it hits something only a person can
decide, the Ticket shows `blocked` with a question; the board surfaces it.

## 5. Result and close (Replies)

The Executor opens a pull request, posts a **result** reply on the Issue, and the
Ticket follows the PR thread. When the PR merges and no Thread it follows is open,
the Ticket **ends**. A human can `stop`, `retry` or `re-evaluate` at any time from
the board.

## 6. What the operator sees

The DSH sidebar "Superagent" tab (the **board**) shows the team at work and the
ticket spread; only what needs a person is surfaced. See
[`docs/screenshots/`](../docs/screenshots/) and the README.

---

*Everything above is fabricated for documentation. No real ticket, repository or
person is described.*
