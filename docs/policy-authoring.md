# Authoring a routing policy

Routing policies are written by a frontier model, offline, once. They are then
executed cheaply — deterministic code plus one batched Jev call — thousands of
times. Keeping those two activities apart is the point of the design: nothing
expensive thinks about routing during a dispatch.

This document is the loop for producing `v2` from what `v1` actually did.

## 1. Export what happened

```bash
jev-dispatch export > history.json                 # everything retained
jev-dispatch export --since 168 > last-week.json   # last 7 days
```

Each delegation in the dump carries:

- the decision: `routing_mode`, `policy_version`, `first_route_tier`
- how well the caller specified it: `has_plan`, `plan_chars`,
  `has_acceptance_criteria`, `has_edit_sites`, `fully_specified`,
  `verification_available`
- the full traversal: every predicate with its `result`, `confidence` and
  probability distribution, and whether traversal actually `used` it
- the outcome: `final_success`, `first_route_success`, `escalated`,
  `unverified`, `final_failure_reason`
- the consequences: `attempt_count`, `total_cost_usd`, `routing_latency_ms`
- per attempt: tier, worker, verification verdict, failure reason, duration, cost

It carries no task text, no code and no command output — only a `task_hash` and,
if you kept them, a short sanitized `title`.

The predicates traversal *didn't* reach are in there too. That is the useful
part: it lets a candidate policy be scored against answers it never consumed,
so you can evaluate a reordering without re-running anything.

## 2. Ask for a revision

Give a frontier model three things: `policies/v1.json`, `history.json`, and the
schema below. A prompt along these lines works:

> Here is a routing policy graph, and the history of every decision it made with
> the outcome that followed. Propose `v2`.
>
> Route as cheaply as possible without losing task quality. Concretely:
> - A predicate whose branches have similar success, escalation and frontier
>   rates is not routing anything — remove it or replace the question.
> - A branch with a high escalation rate is under-routing; a branch with a high
>   success rate and a high frontier rate may be over-routing.
> - A predicate with persistently low confidence is a badly posed question, not
>   a hard task. Rewrite the question or replace it with a deterministic check.
> - Anything ordinary code can decide safely must become a deterministic
>   predicate. Only use a semantic predicate where code cannot express it.
> - Uncertainty must resolve toward the more capable tier.
> - How completely the caller specified the work is a routing input. A complete
>   brief that still routes expensively, or a thin one that routes cheaply and
>   then escalates, both mean the policy is reading specification badly.
>
> Return a complete policy JSON document, with a short rationale per change.

The dashboard's **Policy effectiveness** view is the same analysis by eye, and
is worth reading first — it often makes the answer obvious without a model call.

## 3. Install it alongside v1

```bash
cp v2.json policies/v2.json
jev-dispatch policy                                  # validates and prints it
jev-dispatch config set routing.policyGraph.path policies/v2.json
```

Validation runs at load time, so a graph with a cycle, an unreachable node, an
unknown predicate, an undefined tier or an underivable safer branch fails before
it routes anything.

Both versions write to the same database tagged by `policy_version`, so
`jev-dispatch compare` and the dashboard's comparison view score them side by
side. Give `v2` a genuinely new `version` string — reusing `v1` merges two
different policies into one row and loses the comparison.

## Schema

```jsonc
{
  "version": "v2",                  // required, and unique per policy
  "description": "…",
  "entry": "first_node_id",         // defaults to the first node
  "fallbackTier": "medium",         // if traversal somehow terminates without a tier

  "nodes": [
    {
      "id": "mechanical",
      "type": "semantic",           // asked of Jev
      "question": "…?",             // one narrow yes/no question
      "criteria": {                 // optional; what true and false each mean
        "true":  "…",
        "false": "…"
      },
      "minConfidence": 0.7,         // optional; overrides defaultMinConfidence
      "onUncertain": "no",          // optional; which branch to take below threshold
      "yes": { "goto": "verifiable" },
      "no":  { "goto": "cross_cutting" }
    },
    {
      "id": "verifiable",
      "type": "deterministic",      // decided in code, no model call
      "predicate": "verification_available",
      "args": {},                   // predicate-specific
      "yes": { "tier": "low" },
      "no":  { "tier": "medium" }
    }
  ]
}
```

Rules the validator enforces:

- every node has both a `yes` and a `no` branch
- each branch sets exactly one of `goto` (another node) or `tier` (terminate)
- the graph is acyclic and every node is reachable from `entry`
- every named tier exists in configuration
- every named deterministic predicate exists in the registry
- every semantic node has a resolvable safer branch

## Code facts

A policy can route on facts derived from the code itself, not just from what the
caller said about it. Facts are collected once, before routing, by the fact layer
in `src/facts/`; traversal only ever reads them.

```text
Semgrep as verifier:         worker runs → semgrep checks the result → PASS / FAIL
Semgrep as fact extractor:   before routing → semgrep derives code facts → the policy uses them
```

Those are separate uses and both still work. A Semgrep invocation listed under
`verification.checks` judges a finished result; the fact layer described here
produces evidence for a decision that has not been made yet. Neither replaces
the other.

Facts are off by default. Turn them on per repository:

```json
{
  "facts": {
    "semgrep": {
      "enabled": true,
      "config": ".semgrep/dispatcher.yml",
      "timeoutMs": 10000,
      "ruleFacts": {}
    }
  }
}
```

Semgrep is the external CLI, never an npm dependency. With `enabled` false — the
shipped default — it is never invoked and routing is exactly what it was.

### Naming a fact

A rule says which logical fact it stands for, in its own metadata:

```yaml
rules:
  - id: auth-sensitive-change
    languages: [typescript]
    pattern: ...
    message: Authentication-sensitive code
    severity: WARNING
    metadata:
      dispatcher:
        fact: auth_sensitive
```

which normalizes to `auth_sensitive` in `codeFacts.matched`.

Use rule metadata wherever you can. The rule and the fact it means travel
together, so renaming a rule cannot silently break a policy, and the name you
write is the name that arrives — verified against Semgrep 1.176: the nested
`dispatcher.fact` comes back intact under `extra.metadata`.

For rules you cannot annotate — a pack you did not write — `facts.semgrep.ruleFacts`
maps an id to a fact and takes precedence:

```json
{ "ruleFacts": { "semgrep.auth-sensitive-change": "auth_sensitive" } }
```

**The key is not the `id:` from the rule file.** Semgrep prefixes it with the
rules file's directory path relative to the scan directory, dot-separated:

```text
--config rules.yml              →  auth-sensitive-change
--config .semgrep/rules.yml     →  semgrep.auth-sensitive-change
--config /elsewhere/rules.yml   →  elsewhere.auth-sensitive-change
```

So a `ruleFacts` entry written from the rule file alone silently never matches —
it is not an error, just a fact that never appears. For the shipped default
(`.semgrep/dispatcher.yml`, scanned from the repository root) the prefix is
`semgrep.`, and it stays stable as long as the rules file stays put. Moving the
file changes every key. Run `jev-dispatch facts` after adding a mapping and
confirm the fact actually shows up.

That asymmetry is the real reason to prefer metadata: one mechanism carries a
name you chose, the other carries a name Semgrep derives from a path. What is
deliberately not supported either
way is a policy naming a Semgrep rule id: policies name facts, so a rule pack can
be swapped without touching routing.

A match that maps to no fact is counted but contributes nothing to routing.

### The predicate

```json
{
  "id": "auth_sensitive",
  "type": "deterministic",
  "predicate": "code_fact_present",
  "args": { "facts": ["auth_sensitive"] },
  "yes": { "tier": "high" },
  "no": { "goto": "exact_mechanical" }
}
```

`code_fact_present` is true when any requested fact was positively matched. It is
false when the facts were collected and none matched — and also false when
nothing could be collected, because unavailable evidence means unknown, not
true and not false. A dispatcher with no Semgrep installed therefore routes
exactly as it would have without the node.

That asymmetry is the thing to design around: the `no` branch must lead to the
route the policy would take anyway, not to a cheaper tier that only makes sense
once you know the code is harmless. If you need to tell "looked, found nothing"
from "nobody looked", `code_facts_available` says which of the two it was.

Matched fact names also reach the semantic evaluator, as a flat list under
`code_facts` in the routing state — names only, never source, findings, line
contents or rule messages. Jev or Laya can reason from objective evidence without
Semgrep becoming a classifier.

`jev-dispatch facts` runs the fact layer on its own and prints what it found.

## The safer branch

Below its confidence threshold, a semantic node takes the *safer* branch rather
than the answered one. Safer means "reaches higher-capability tiers": the
validator computes the reachable tier range of each branch and picks the higher
one.

When both branches reach the same range, the choice is genuinely ambiguous and
the policy is **refused** unless it declares `onUncertain`. This is deliberate.
Guessing here is exactly the failure the system exists to avoid — silently
under-routing at low confidence — so it fails at load time, loudly, rather than
at dispatch time, quietly.

Declaring `onUncertain` also overrides derivation where you know better than the
graph shape does.

## A note on the evaluator

Everything in this document assumes Jev answers the semantic predicates. Which
service serves it — TypeSafe directly, Cloudflare Workers AI, Vercel's AI
Gateway, a LiteLLM proxy — is `routing.jev.provider` and changes nothing here: a
policy is written against questions, not endpoints.

## Writing a good semantic question

Jev answers a narrow, typed question well. It is not being asked to schedule
anything, and it should never be asked to.

- **Ask about the work, never about the worker.** "Is the root cause currently
  unknown?" is answerable. "Does this need a strong model?" is a scheduling
  decision wearing a question mark — that is arm B, and the point of arm C is
  that the graph makes that call instead.
- **One property per question.** A question with an "and" in it produces a
  confidence number that means nothing, because you cannot tell which half was
  uncertain.
- **Write the criteria.** `criteria.true` and `criteria.false` are where the
  boundary actually gets defined. A question without them relies on the model
  guessing where you would have drawn the line.
- **Prefer code.** If a deterministic predicate can answer it, it is faster,
  free, exactly reproducible, and never uncertain. `plan_is_executable` is the
  model of a question worth asking a model: whether a plan *exists* is a fact
  and is decided in code; whether it is *followable* is a judgement and is not.

Adding a predicate to the registry (`src/policy/predicates.mjs`) is the
supported way to extend routing without touching traversal. Predicates must be
pure and cheap — they run inline on every dispatch, before any network call.

## Beyond three tiers

Tiers are configuration, so a policy can route to more than three. Add the tier
and its worker, then point a branch at it:

```yaml
tiers:
  specialist: { order: 4, worker: security-reviewer, description: "…" }
workers:
  security-reviewer: { kind: claude-agent, model: opus, agent: high-worker, frontier: true }
```

`order` decides what "stronger" means, so it governs both escalation and safer-branch
derivation. A `HUMAN` tier works the same way with a `command` worker that files
a ticket and returns `needs_clarification`.
