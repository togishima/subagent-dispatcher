---
name: delegate
description: Turn a piece of execution work into a brief a delegated worker can carry out, then hand it over with the delegate tool. Covers what is worth delegating, how to write the plan, acceptance criteria and constraints, and how to read the result. Read before the first delegate call of a session, when a delegation comes back failed or needs_clarification, or when deciding whether to delegate at all.
---

# Delegating work

Execution work goes to a worker through `delegate`. You stay on one model with
your context intact; the worker is a separate short-lived process that starts
from nothing and is shut down when it finishes. Only a summary comes back.

**The brief is the job.** A worker handed a plan applies your approach — quick,
cheap, mechanical. A worker handed a goal has to derive the approach again,
which is slower, costs more, and is likelier to come back wrong. You have the
conversation, the context and the design decisions. Do the deciding here; hand
over the carrying out.

## Step 0 — is this worth delegating?

Delegate work that is separable and describable: implementing a change you have
already decided on, writing or fixing tests, a mechanical edit across files,
investigating a specific failure.

Keep work that needs you: talking to the user, deciding *what* to build, judging
whether the overall change is right, anything that only makes sense against the
conversation so far.

The test: could you hand this to a competent colleague who has not been in the
room? If you cannot write it down that way, it is not ready to delegate — or it
is really your work.

## Step 1 — does it need a full brief?

A one-line mechanical change does not. `delegate({ task: "Sort the imports in
src/api/*.ts alphabetically" })` is a complete subtask already; writing a plan
for it wastes your tokens and the user's time.

Everything else does. If the subtask involves more than one edit, or any choice
about *how*, build the brief. The rest of this skill is that.

## Step 2 — find where the work happens

Before writing anything, locate it. Grep for the symbol, read the function, look
at the file that already does the similar thing. You are doing this anyway to
decide the approach — the point is to keep the paths and line numbers rather
than discarding them.

Out of this you get `contextFiles` (what to change) and `referenceFiles` (what
to imitate). Naming an existing file to follow is the cheapest way to get code
that fits the codebase instead of code that merely works.

## Step 3 — write the plan

State the steps concretely enough that someone who has never seen this codebase
could follow them. Name the function, the file and the intended end state.

> 1. In `cache.mjs`, change `get(key)`: return `undefined` when the key is
>    absent; otherwise delete and re-insert the entry so it becomes newest, then
>    return the value.
> 2. In `cache.mjs`, change `set(key, value)`: delete an existing key first, then
>    insert; while `this.map.size > this.limit`, delete `this.map.keys().next().value`.
> 3. Add a `size` getter returning `this.map.size`.

Pass it as `plan`. If you already wrote a design document, point `planFiles` at
it instead and its contents go to the worker directly — do not paste a file you
could reference.

If you cannot write the plan, stop and notice that. It usually means the design
is not settled, and what you have is thinking still to be done here, not a
subtask to delegate.

## Step 4 — say what "done" means

`acceptanceCriteria` are statements that are true or false, not goals:

- ✅ "`get()` on a missing key returns `undefined`"
- ❌ "handles missing keys properly"

The worker checks itself against these before reporting, and they are also what
lets a result be trusted when no test covers the area yet.

`expectedOutput` is the same idea for the change as a whole: the command exits
zero, the test fails before and passes after.

## Step 5 — say what not to touch

`constraints` are cheap to write and prevent the most annoying failure mode: a
correct change plus three uninvited ones.

- "do not change the constructor signature"
- "do not add dependencies"
- "leave `capitalize` alone"

Set `riskFlags` when you know them — `security`, `concurrency`,
`data-migration`, `public-api`. They feed the routing decision.

## Step 6 — make the call

```
delegate({
  task: "Make LruCache in cache.mjs a real LRU that evicts.",
  plan: "1. In cache.mjs, change get(key)… 2. …",
  contextFiles: ["cache.mjs"],
  referenceFiles: ["src/ttl-cache.mjs"],
  acceptanceCriteria: [
    "get() on a missing key returns undefined",
    "set() evicts the least-recently-used key once size exceeds limit",
    "a size getter returns the current entry count",
  ],
  constraints: ["do not change the constructor signature"],
  expectedOutput: "node check.mjs prints \"all checks passed\" and exits 0.",
  taskType: "implement",
})
```

`task` must stand alone — "fix the bug we discussed" is not a subtask.
`context` is for a short summary of a constraint or decision the worker needs;
it is not a place for conversation history, which makes workers slower and
worse, not better.

## What you do not control

Worker capability, model, provider and effort are chosen behind the tool. There
is no parameter for them and asking in the task text does nothing — the worker
is never told which tier it is, precisely so it does not calibrate its effort to
its own price tag.

So do not write "use a strong model for this", and do not pad the task to
compensate for an imagined cheap worker. What you *do* control is how completely
you specify the work, and that is the lever that matters. A vague brief needs
someone to make the decisions, and that costs more however it is routed.

If the work is genuinely hard, say *why* in the task — that is both what routes
it and what the worker needs to know.

## Reading the result

```
{ status, summary, evidence, changedFiles, verification, blockers, attempts, escalated, hint }
```

Read `verification.verdict` first:

- `PASS` — a deterministic check ran and passed. Trust this. It outranks the
  worker's own opinion, including a worker that finishes and then reports
  failure.
- `UNCERTAIN` — nothing could check the work. The claim is unconfirmed; if it
  matters, verify it or delegate a check.
- `FAIL` — retries and escalation already happened. Stronger workers failed too.

`status: "needs_clarification"` is a specification problem, not a worker
problem: read `blockers`, fix the subtask, call again. Sending the same text to
a stronger worker will not help, and the dispatcher deliberately does not try.

`attempts > 1` or `escalated: true` means the first route was too weak — a
signal your description undersold the difficulty. `hint`, when present, names
what the brief was missing; act on it for the next delegation rather than
re-sending the same one.

Treat `evidence` as the result and `summary` as the gloss. If you need more,
delegate a follow-up subtask — there is no transcript to ask for.
