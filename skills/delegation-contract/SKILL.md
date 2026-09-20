---
name: delegation-contract
description: How to hand execution work to a delegated worker with the delegate tool — what belongs in a subtask, how to scope context, and why worker capability is not yours to choose. Read when writing a delegate call, when a delegation comes back failed or needs_clarification, or when deciding whether work should be delegated at all.
---

# Delegation contract

Execution work goes to a worker through `delegate`. You stay on one model with your
context intact; the worker is a separate short-lived process that starts from
nothing and is shut down when it finishes.

This split is the whole point. Your prompt cache survives because your model never
changes and worker transcripts never enter your context. Only a summary comes back.

## What to delegate

Delegate work that is separable and describable:

- implementing a change you have already decided on
- writing or fixing tests
- a mechanical edit across files
- investigating a specific failure and reporting what is wrong

Keep work that needs you: talking to the user, deciding what to build, judging
whether the overall change is right, and anything that only makes sense against the
conversation so far.

A subtask is worth delegating when you could hand it to a competent colleague who
has not been in the room. If you cannot write it down that way, it is not ready to
delegate — or it is really your work.

## Writing the call

```
delegate({
  task:           "...",   // required, self-contained
  context:        "...",   // a summary, never the conversation
  contextFiles:   ["..."], // where to start
  expectedOutput: "...",   // what correct looks like
  taskType:       "...",   // implement | test | refactor | investigate | docs
  riskFlags:      ["..."], // security | concurrency | data-migration | public-api
})
```

`task` is read by something with no other context. "Fix the bug we discussed" is
not a subtask. "In `src/auth/session.ts`, `refreshToken` treats an expired refresh
token as valid because it compares `exp` in seconds against `Date.now()` in
milliseconds; fix the comparison and add a test for an expired token" is.

`context` should be short. Summarise the constraint the worker needs — the
convention to follow, the decision already made, the thing not to touch. Pasting
conversation history in makes the worker slower and worse, not better.

`expectedOutput` is how the result gets judged. State it concretely: the function
returns X, the test fails before and passes after, the command exits zero.

`riskFlags` are worth setting when you know them. They feed the routing decision.

## What you do not control

Worker capability, model, provider and effort are chosen behind the tool. There is
no parameter for them, and asking in the task text does nothing — the worker is
never told which tier it is, precisely so it does not calibrate its effort to its
own price tag.

So do not write "use a strong model for this", and do not try to compensate for an
imagined cheap worker by padding the task. Describe the work accurately, flag the
risks you know about, and the routing policy handles the rest. If the work is hard,
say *why* it is hard in the task — that is what routes it, and it is also what the
worker needs to know.

## Reading the result

```
{ status, summary, evidence, changedFiles, verification, blockers, attempts, escalated }
```

`verification.verdict` is the one to read first:

- `PASS` — a deterministic check ran and passed. Trust this.
- `UNCERTAIN` — nothing could check the work. The worker's claim is unconfirmed;
  if it matters, verify it yourself or delegate a check.
- `FAIL` — the work did not pass. Retries and escalation have already happened, so
  a `failed` result means stronger workers failed too.

`status: "needs_clarification"` means the subtask could not be acted on as
written. That is a specification problem, not a worker problem: read `blockers`,
fix the subtask, and call again. Sending the same text to a stronger worker will
not help, and the dispatcher deliberately does not try.

`attempts > 1` or `escalated: true` tells you the first route was too weak for the
work. Nothing is needed from you, but it is a signal that your task description
undersold the difficulty.

Treat `evidence` as the result and `summary` as the gloss. If you need more than
`evidence` gives you, delegate a follow-up subtask rather than asking the worker
for its transcript — there isn't one to get.
