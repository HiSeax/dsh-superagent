# Example: Policy — admission table, accept modes and proactive rules

> Illustrative, sanitized example. Real policy lives in the orchestrator's Policy
> version (`src/policy.ts` + the Settings schemas) and is edited from the DSH
> settings UI / the Source cards. See
> [`packages/dsh-windows-superagent/docs/002-authorization.md`](../../packages/dsh-windows-superagent/docs/002-authorization.md)
> for the normative description.

## 1. Accept mode

| Mode | Effect |
| --- | --- |
| `off` | Nothing inferred becomes a candidate (an unaddressed message, a bot message, a non-listed person's follow-up) |
| `observe` *(default)* | Inferred candidates are assessed; a positive assessment is recorded as ignore marked "would accept" — nothing is accepted |
| `auto` | A positive assessment of an inferred candidate accepts it |

Explicit requests (a listed person addressing the agent) work in every mode.
Recommended path: start in `observe`, review the recorded Decisions, then switch
to `auto`.

## 2. Admission table (per Source, by receiving scope)

Each row has up to three cells. A cell decides whether a message becomes an
**explicit request**, an **inferred candidate**, or **nothing**.

| Receiving scope | On the list, not addressing | Not on the list, addressing | Not on the list, not addressing |
| --- | --- | --- | --- |
| Feishu: project chat (receives all messages) | `inferred` (default) | `explicit` ← open this for a support chat | `ignore` (default) |
| Feishu: other chats (仅 @) | — | `explicit` | — |
| GitHub: new Issues / PRs / comments / default-branch CI | `inferred` | `explicit` | `ignore` |
| Local DSH Session (orchestrator main Session) | — | `explicit` | — |
| Weixin (iLink bot, direct chats only) | — | `explicit` | — |

Notes:

- Cells for unaddressed messages only exist where the Source receives **every**
  message (a Feishu chat set to 全部消息, or a GitHub scope with receive-all on).
- Weakening a cell does not immediately stop open Tickets; it can revoke their
  Mandates when revalidated before resuming.

## 3. Proactive rules (what "auto" is allowed to accept)

Each rule describes a kind of proactive work. A proactive accept requires at
least one matching rule; the Ticket's Mandate records the matched rules.

| Rule | Matches when… | Process requirements the rule can add |
| --- | --- | --- |
| `triage-new-issue` | A new Issue asks for a change the repo owns | Open a branch named after the ticket; post an acknowledgement |
| `review-requested` | A review is requested on a PR the ticket follows | Name the required reviewer and approval before merge |
| `ci-red-default-branch` | Default-branch CI fails on a change the ticket owns | Investigate, then report; never force-push |
| `weekly-digest` | A scheduled digest is due | Post one summary; silence rule may suppress the ack |

## 4. Versioning

Rules, accept mode and each Source's Policy form the **Policy version**. Every
Mandate records the version it was accepted under. A version change discards
running Evals, re-queues their Triggers, and notifies each affected live Ticket.
