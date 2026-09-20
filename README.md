# jev-dispatch

A Claude Code plugin that keeps your main session on one frontier model and
routes only the *delegated* subtasks to cheap, normal or frontier workers — then
measures whether that actually saved anything.

It is an experiment platform, not a model router. Routing, verification,
escalation, cost and cache behaviour are all recorded locally and read back from
a dashboard on `127.0.0.1`.

## The question

> Can a frontier-authored deterministic routing policy, with Jev used only for
> semantic predicates, preserve task quality while reducing frontier subagent
> usage and keeping the main session cache-local?

And, because it is not obvious:

> Is that more reliable and interpretable than asking Jev to classify the worker
> tier directly?

The plugin ships all three arms so the question is measured rather than argued:

| Arm | `routing.mode` | What decides the tier |
|---|---|---|
| A | `fixed-high` | nothing — always the strongest worker |
| B | `jev-direct` | Jev, in one choice question over the tiers |
| C | `policy-graph` | a deterministic graph; Jev answers only its boolean predicates |

## How it works

```
Main Claude Code session  (Fable / Opus — model never changes, cache intact)
        │
        │  delegate({ task, context, expectedOutput, verification? })
        ▼
   Routing policy graph            ← data, versioned, not code
        ├── deterministic predicates   (ordinary code, no model call)
        └── semantic predicates        → one batched Jev call
        ▼
   deterministic traversal → LOW | MEDIUM | HIGH
        ▼
   tier → worker mapping           ← configuration
        ▼
   short-lived worker  (claude -p, its own model, its own context)
        ▼
   verifier  (tests / lint / typecheck / task command)
        ├── PASS → summary + evidence back to the main session
        └── FAIL → classify the failure
                     └── CAPABILITY_FAILURE only → escalate one tier, retry
```

Four properties hold that together.

**The main session never changes model.** Nothing here switches the model
per turn. Workers are separate processes with their own context windows, so the
main session's prompt cache is never invalidated by delegation, and worker
transcripts never enter its context — only a summary comes back.

**The main session cannot choose a worker.** Its entire interface is one MCP
tool, `delegate`, whose schema contains no model, provider, tier or effort
parameter. There is no knob, so there is no wrong setting.

**Jev never sees a model name either.** It is a semantic predicate evaluator,
not a scheduler. It answers narrow boolean questions — *is this primarily
mechanical? does it require cross-cutting reasoning? is the root cause
unknown?* — over a small structured state. The tier is then decided by ordinary
deterministic code walking the graph, which means every routing decision is
reproducible from telemetry.

**Uncertainty over-routes.** When a predicate's confidence falls below its
threshold, traversal takes the safer branch instead of the answered one. Which
branch is safer is derived from the graph at load time, and a policy where it
cannot be derived is refused rather than guessed at.

## Install

```bash
/plugin marketplace add togishima/subagent-dispatcher
/plugin install jev-dispatch@jev-dispatch-marketplace
```

Then set the routing credential — in your environment, never in a config file:

```bash
export TYPESAFE_API_KEY=...        # https://typesafe.ai
```

Check the installation:

```bash
jev-dispatch doctor
```

Requires Node 22.5+ (for `node:sqlite`) and the `claude` CLI on `PATH`. The
plugin itself has **no npm dependencies**.

To uninstall: `/plugin uninstall jev-dispatch`. That removes the tool, the
agents, the hooks and the MCP server. The telemetry database is left alone —
delete it with `jev-dispatch purge --yes` if you want it gone.

## Set up verification first

This is the one setup step that matters. Without a deterministic check, every
result is `UNCERTAIN`, and the policy will never route anything to the cheapest
worker — because sending work to a cheap worker is only safe when something can
catch a bad result.

`~/.jev-dispatch/config.yaml`:

```yaml
verification:
  checks:
    - name: typecheck
      command: npm run -s typecheck
      when:
        changedFilesMatch: \.tsx?$
    - name: tests
      command: npm test
```

`when` is optional (`always` by default) and takes `changedFilesMatch` (a
regular expression, not a glob) and `taskTypeIn`. Changed files are read from
git, not from what the worker claims it did.

## Use it

From a Claude Code session, delegable execution work goes through the tool:

```
delegate({
  task: "Make LruCache in cache.mjs a real least-recently-used cache that evicts,
         following docs/PLAN.md.",
  planFiles: ["docs/PLAN.md"],          // the plan you already wrote
  contextFiles: ["cache.mjs"],          // the files to change
  referenceFiles: ["src/ttl-cache.mjs"],// patterns to follow, not change
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

### The brief is the job

This is the part that decides how well delegation works, and it is worth being
explicit about.

A worker starts from nothing. Handed a **plan**, it applies your approach —
mechanical work, done quickly and cheaply. Handed a **goal**, it has to derive
the approach again, which is slower, costs more, and is likelier to come back
wrong. The reasoning to decide *how* belongs in the main session, which has the
conversation and the context. What gets delegated is the carrying out.

Concretely: the LRU cache above is not a trivial task, and a cheap worker asked
to "make the cache an LRU" would struggle with it. Given `docs/PLAN.md` naming
the steps, the same worker implements it correctly on the first attempt.

That makes specification a routing input, not prompt decoration — and the policy
graph reads it. Whether a plan was supplied is decided in code
(`fully_specified`); whether the plan is actually *followable* is the one thing
worth asking a model (`plan_is_executable`). A vague brief routes higher,
because someone still has to make the decisions.

The dashboard's **Specification** view scores this directly: complete briefs
against thin ones, on routing, escalation, success and cost. If a better brief
is not buying a cheaper worker, the policy is not reading specification well —
which is a finding, and the reason the view exists.

What comes back:

```json
{
  "status": "completed",
  "summary": "...",
  "evidence": ["src/auth/session.ts:42 now compares seconds to seconds"],
  "changedFiles": ["src/auth/session.ts", "test/session.test.ts"],
  "verification": { "verdict": "PASS", "reason": "2 check(s) passed" },
  "attempts": 1,
  "escalated": false
}
```

Read `verification.verdict` first. `PASS` means a deterministic check agreed —
and it outranks the worker's own opinion, including a worker that finishes the
job and then reports failure.
`UNCERTAIN` means nothing could check the work — the worker's claim is
unconfirmed. `FAIL` means retries and escalation already happened and stronger
workers failed too.

The bundled `delegation-contract` skill explains how to scope a subtask well;
its body loads only when the model needs it, so it costs nothing per turn.

## The dashboard

```bash
jev-dispatch ui       # http://127.0.0.1:4319/
```

Eight views: overview KPIs, the routing timeline (escalations shown as indented
retries), policy effectiveness, specification effectiveness, confidence against
outcome, worker performance, cache & cost, and the arm comparison.

Loopback only. A non-loopback bind address is refused outright, not merely
defaulted away from, and nothing is ever sent anywhere.

To see it before spending anything:

```bash
JEV_DISPATCH_DB_PATH=/tmp/demo.db node --experimental-sqlite scripts/seed-demo.mjs 80
JEV_DISPATCH_DB_PATH=/tmp/demo.db jev-dispatch ui
```

### Main-session cache locality

The headline measurement needs Claude Code's own telemetry, which the dashboard
receives locally:

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4319
```

`claude_code.token.usage` carries a `query_source` attribute of `main`,
`subagent` or `auxiliary`, which is what separates the main session's cache read
ratio from its workers'. Only `http/json` is accepted; parsing protobuf would
mean a dependency. Log events are acknowledged and discarded — their payloads
can carry prompt and tool content, and this database is not a place for either.

Worker cost and tokens need none of this: they come from each worker's own
result payload, exactly, per invocation.

## Running the experiment

Run the same set of tasks under each arm. Every arm writes the same schema, so
the comparison is a query, not a rewrite:

```bash
jev-dispatch config set routing.mode fixed-high     # A
jev-dispatch config set routing.mode jev-direct     # B
jev-dispatch config set routing.mode policy-graph   # C
jev-dispatch compare
```

The metrics the platform is built to answer with: tier distribution,
first-route success, escalation rate, frontier invocation rate, task success,
main-session cache read ratio, total cost, cost per successful delegation, Jev
routing latency, and confidence against success.

`Est. frontier avoided` is an empirical counterfactual, not a price table: it
compares against what top-tier delegations in *this* database actually cost.
With no top-tier runs recorded it shows `—` rather than a guess, which is
another reason to run arm A.

## The routing policy

The policy is data. Two versions ship: `v1` asks only what the work is like,
`v2` (the default) asks first whether the caller already did the thinking. Both
stay runnable so they can be compared.

`policies/v2.json`, abridged:

```json
{
  "version": "v1",
  "entry": "exact_mechanical",
  "fallbackTier": "medium",
  "nodes": [
    { "id": "mechanical", "type": "semantic",
      "question": "Is this subtask primarily mechanical and well specified — …?",
      "criteria": { "true": "…", "false": "…" },
      "onUncertain": "no",
      "yes": { "goto": "verifiable" },
      "no":  { "goto": "cross_cutting" } },

    { "id": "verifiable", "type": "deterministic",
      "predicate": "verification_available",
      "yes": { "tier": "low" },
      "no":  { "tier": "medium" } }
  ]
}
```

Every node asks one boolean question and each branch either jumps (`goto`) or
terminates (`tier`). The graph must be acyclic, fully reachable, and every tier
must exist — all checked at load time, so a broken policy fails before it routes
anything.

`type: deterministic` names a predicate from a small registry
(`jev-dispatch predicates`). Anything ordinary code can decide safely belongs
here rather than in a model call: verification availability, whether a plan and
acceptance criteria were supplied, task-text patterns, declared task type, file
counts, risk flags, previous attempts and their failure reasons.

`type: semantic` is a question for Jev. Every semantic node in the policy goes
out in **one** request with a shared state — TypeSafe evaluates them in
parallel — and the full probability distribution for each is stored, including
the ones traversal never reached. Those unused answers are what let a policy be
re-scored offline against decisions it did not make.

Inspect the active policy with `jev-dispatch policy`, and dry-run it without
dispatching anything:

```console
$ jev-dispatch route "the session refresh returns 401 intermittently under load"
mode         policy-graph
policy       v1
tier         high → opus
confidence   0.781
latency      214ms (Jev 198ms)

traversal
   1. exact_mechanical       deterministic  no               → mechanical
   2. mechanical             semantic       no   conf=0.94   → cross_cutting
   3. cross_cutting          semantic       yes  conf=0.78   → high_stakes_judgment
   4. high_stakes_judgment   semantic       yes  conf=0.81   tier high
```

### Authoring a new policy

Runtime routing and policy improvement are separate on purpose. A frontier model
designs the graph once, offline; it never runs in the routing path.

```bash
jev-dispatch export > history.json
```

That dump carries each delegation's traversal, predicate distributions, outcome,
escalations and cost — and no task or code text. Hand it to Opus or Fable along
with `policies/v1.json` and ask for `v2`. Point at it with
`routing.policyGraph.path` and both versions stay in the same database, tagged
by `policy_version`, so the comparison view scores them side by side.

`docs/policy-authoring.md` has the longer version.

## Tiers and workers

Routing intelligence and provider policy are separable. A router picks a tier; a
tier maps to a worker; a worker names a model. Only the last part is
configuration:

```yaml
tiers:
  low:    { order: 1, worker: haiku,  description: "Mechanical and local: …" }
  medium: { order: 2, worker: sonnet, description: "Ordinary engineering: …" }
  high:   { order: 3, worker: opus,   description: "Hard or high-stakes: …" }

workers:
  haiku:  { kind: claude-agent, model: haiku,  agent: low-worker,    frontier: false }
  sonnet: { kind: claude-agent, model: sonnet, agent: medium-worker, frontier: false }
  opus:   { kind: claude-agent, model: opus,   agent: high-worker,   frontier: true }
```

Swapping a worker changes no routing logic:

```yaml
workers:
  local: { kind: command, command: ["./local-model.sh"] }
tiers:
  low: { order: 1, worker: local, description: "…" }
```

A `command` worker receives the prompt on stdin and returns the worker contract
as JSON on stdout. Tiers themselves are configuration too — add a `specialist`
tier and point a policy branch at it.

A worker is a `claude -p` process running one of this plugin's agent definitions
at the model its tier maps to. The definition is passed inline with `--agents`,
so the worker resolves it whether or not the plugin is installed in that
directory, and nothing else from the plugin is loaded into it. Workers get no
MCP servers and no Agent tool, so they cannot recurse back into `delegate`.

A worker is permitted to run exactly the configured check commands — the same
ones the dispatcher is about to run against it — and nothing else. Without that,
a worker is told to verify its own work and then denied the shell to do it with,
so it reports blind and first hears of a mistake as an escalation. Set
`workerDefaults.allowVerificationCommands: false` to withhold it.

A worker is never told which tier it is. It would calibrate its effort to its
own price tag.

## Escalation

Escalating a failure that a stronger model cannot fix just spends frontier
tokens on the same wall, so failures are classified before anything is retried:

| Reason | Meaning | Default |
|---|---|---|
| `CAPABILITY_FAILURE` | a real attempt was made and verification failed | escalate one tier |
| `SPEC_FAILURE` | the subtask cannot be acted on as written | return to the caller |
| `ENVIRONMENT_FAILURE` | missing binary, network, timeout, model API error | retry once, same tier |
| `VERIFICATION_FAILURE` | the verifier itself could not produce a verdict | report |
| `UNKNOWN` | unclassified | report |

```yaml
escalation:
  maxAttemptsPerTask: 3
  escalateOn: [CAPABILITY_FAILURE]
  retrySameTierOn: [ENVIRONMENT_FAILURE]
  uncertainCountsAsPass: true    # does an unchecked "done" count? an experiment parameter
```

The retry budget is absolute. At the strongest tier there is nowhere to escalate
to, and the dispatcher stops rather than paying twice for the same failure.

## Privacy

Local-first, and nothing leaves the machine except the routing state Jev needs.

Plan text is the exception worth stating plainly: judging whether a plan is
followable means reading it, so the plan goes to Jev along with the routing
state — truncated to `routing.jev.maxPlanChars`, and only while
`routing.jev.sendPlan` is true. Turn it off and `plan_is_executable` degrades to
its safer branch like any other unanswered predicate.

The database stores a task id, a SHA-256 hash, an optional short sanitized
title, and specification *flags and counts* — never the plan text, prompts,
code, diffs or command output. Titles are stripped of
API-key, token, JWT and email shapes; set `telemetry.storeTitles: false` to drop
them entirely. Raw capture (`telemetry.debugStoreRawInput`, default off) is
opt-in and still redacted, and the dashboard says so in its header when it is on.

Workers receive a filtered environment allowlist with `TYPESAFE_API_KEY`
explicitly removed. Nothing is sent to any external analytics service.

## Configuration

`jev-dispatch config path` shows where it is read from —
`~/.jev-dispatch/config.json`, `.yaml` or `.yml`, deep-merged over
`config/default.json`. `jev-dispatch config` prints the effective result.

YAML support is a deliberately small subset (block mappings and sequences,
scalars, comments). Anchors, tags, block scalars and flow mappings are refused
with an error rather than misread, because silently misparsing a config would
route real work to the wrong worker. JSON is the safe choice if you want
everything.

Keys worth knowing:

```yaml
routing:
  mode: policy-graph                      # policy-graph | jev-direct | fixed-low|medium|high
  fallbackTierOnRouterError: medium
  policyGraph:
    path: policies/v1.json
    defaultMinConfidence: 0.6             # below this, take the safer branch
    overRouteOnUncertain: true
    onEvaluatorUnavailable: safer-branch  # or fallback-tier, to cap the blast radius
  jevDirect:
    confidencePolicy:
      enabled: true
      minMaxProbability: 0.6              # below this, floor the tier
      floorTier: medium
  jev:
    endpoint: https://api.typesafe.ai/v1/systemone
    model: jev-latest
    timeoutMs: 8000
    sendPlan: true                        # the plan is needed to judge whether it is followable
    maxPlanChars: 4000

workerDefaults:
  permissionMode: acceptEdits
  allowVerificationCommands: true         # let a worker run the checks that judge it
  timeoutMs: 900000
  bare: false                             # cuts worker startup cost; needs ANTHROPIC_API_KEY

telemetry:
  retentionDays: 100
  storeTitles: true
  debugStoreRawInput: false

ui:
  host: 127.0.0.1                         # anything else is refused
  port: 4319
```

Note `onEvaluatorUnavailable`. The default, `safer-branch`, follows the
over-route rule — which means a Jev outage sends *everything* to the frontier
worker. That is the safe failure, not the cheap one. Set `fallback-tier` if you
would rather cap the cost.

## Honest limitations

- **Each worker pays a fresh cache-creation cost.** A `claude -p` worker starts
  cold; expect ~15–25k cache-creation tokens per invocation before it does any
  work. `workerDefaults.bare: true` cuts that substantially but skips
  `CLAUDE.md`, hooks and skills, and needs `ANTHROPIC_API_KEY`. The dashboard
  shows the figure per worker so you can judge it rather than assume it.
- **Delegation has latency.** Process startup plus routing is a few seconds
  before the worker begins.
- **A long delegation moves to a background task.** Claude Code backgrounds an
  MCP call that runs past two minutes, so a substantial subtask returns as a
  notification rather than inline. That is normal; raise
  `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` if you would rather wait.
- **`UNCERTAIN` is not success.** With no verification configured, everything
  passes unverified by default and the cost numbers mean much more than the
  quality numbers. The dashboard reports the unverified rate for this reason.
- **The OTel counter store is a snapshot, not a time series.** It answers "what
  is the cache read ratio", not "how did it move over the last hour".

## Commands

```
jev-dispatch ui                        serve the dashboard
jev-dispatch doctor                    check config, policy, workers, key, telemetry
jev-dispatch route <task…>             dry-run the router and print the traversal
jev-dispatch policy                    print the active routing policy
jev-dispatch predicates                list deterministic predicates
jev-dispatch status                    headline metrics as JSON
jev-dispatch compare                   one row per experiment arm
jev-dispatch export [--since <hours>]  historical decisions for offline authoring
jev-dispatch config [path|set k v]     read or write configuration
jev-dispatch purge --yes               delete the telemetry database
```

## Not what this is

Not a general multi-agent framework, a workflow engine, a rule engine, a policy
DSL compiler, a per-turn main-model router, or anything that self-modifies its
own policy. The graph is small and hand-readable on purpose. What is worth
building here is the delegation boundary, the capability routing, the escalation
policy, the experiment telemetry and the local visualization — everything else
is Claude Code's, and is used rather than rebuilt.

## Development

```bash
npm test                 # 75 tests, no network, no model calls
node --experimental-sqlite scripts/seed-demo.mjs 80
```

Storage and UI design follow [otel-agent](https://github.com/togishima/otel-agent):
zero dependencies, `node:http` plus `node:sqlite`, retention-based pruning, and
a dashboard served from the same local process that receives the telemetry.

MIT.
