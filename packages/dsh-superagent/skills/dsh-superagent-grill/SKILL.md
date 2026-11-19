---
name: dsh-superagent-grill
description: Grill a person relentlessly about a plan, decision or idea, one round of decision questions at a time, using the ask_user_question card.
---

Interview the person relentlessly until you share one understanding. Map the subject as a **design tree**: every decision branches into the decisions that hang off it.

## Where this runs

This skill belongs to the **main Session** of dsh-superagent — the one that talks to the person and routes work. Only that Session has the `ask_user_question` tool; Executor (worker) Sessions and teammates deliberately never get it, because they work unattended. If you are a worker and this text reached you, do not try to ask a person: put the unresolved question or decision in your report to the main Session instead.

## Work in rounds

- The **frontier** is every decision whose prerequisites are already settled: the questions you can ask *now* without guessing answers you have not heard.
- **Ask the whole frontier in one round.** Each round of answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier, then ask the next round.
- **Dependencies stay ordered.** A question whose answer depends on another question still open in this round belongs to a later round.
- **Facts are your job, decisions are the person's.** When a frontier question needs a fact from the environment (files, tools, logs, docs, code), look it up — a subagent, `read`, `grep`, a shell command — and never ask the person something you could find out yourself. Do not block on it: only the questions downstream of that lookup wait; ask the rest of the frontier now.
- **Stop condition.** The session is done when the frontier is empty: every branch visited, nothing silently assumed. Do not act on the subject until the person confirms the shared understanding.

## Ask with the tool, not prose

Ask each round by calling the `ask_user_question` tool. Do not write the questions as chat text and wait for a typed reply: the tool renders the question card and returns the answers.

- **One call per round**: put the whole current frontier into one `questions[]` call so the person answers the round together.
- **Each question**: a stable `id`, a clear `question` body, and `options[]` when there are concrete choices. Use `header` for a short heading such as `Scope` or `Timing`, and `multi_select: true` only when several choices may hold at once.
- **Options**: each one a real, distinct choice with a short `label` and, when it helps, a one-sentence `description` of the trade-off. Put the **recommended** option **first** and mark it in its text (for example append `(Recommended)`), so accepting the recommendation is an explicit pick.
- **Leave the free-input path open**: the card always offers the person their own words. Phrase options so none of them forces an answer that forecloses a valid one.
- **Recover the answers**: read the tool result — `{"answers":[{"id","selected":[...],"custom":"..."}]}` per question (an item with an empty `selected` and no `custom` is a skip) — then recompute the frontier for the next round. If a result is ambiguous, ask one focused follow-up round instead of guessing.

## Example shape

```json
{
  "questions": [
    { "id": "scope", "header": "Scope", "question": "Which migration scope?",
      "options": [
        { "label": "Rewrite all call sites (Recommended)", "description": "One semantics; the largest change." },
        { "label": "Patch only the public entry points", "description": "Small, but older paths stay ambiguous." }
      ] },
    { "id": "timing", "header": "Timing", "question": "When should it take effect?",
      "options": [
        { "label": "Next release (Recommended)", "description": "Rides the normal release train." },
        { "label": "Immediately", "description": "Data from the current period spans both semantics." }
      ] }
  ]
}
```

Ask the whole frontier, in one call, every round — and stop only when the tree is exhausted.
