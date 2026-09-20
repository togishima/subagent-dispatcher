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
        │  delegate({ task, plan, contextFiles, acceptanceCriteria, … })
        ▼
   Routing policy graph            ← data, versioned, not code
        ├── deterministic predicates   (ordinary code, no model call)
        └── semantic predicates        → one batched call to a
        │                                semantic decision engine:
        │                                  Laya, locally on Apple silicon
        │                                  Jev, over the network
        │                                  mock, fixed answers
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

**The evaluator never sees a model name either.** It is a semantic predicate
evaluator, not a scheduler. It answers narrow boolean questions — *is this
primarily mechanical? does it require cross-cutting reasoning? is the root cause
unknown?* — over a small structured state. The tier is then decided by ordinary
deterministic code walking the graph, which means every routing decision is
reproducible from telemetry, and the graph cannot tell which engine replied.

**Uncertainty over-routes.** When a predicate's confidence falls below its
threshold, traversal takes the safer branch instead of the answered one. Which
branch is safer is derived from the graph at load time, and a policy where it
cannot be derived is refused rather than guessed at.

## Install

```bash
/plugin marketplace add togishima/subagent-dispatcher
/plugin install jev-dispatch@jev-dispatch-marketplace
```

Claude Code asks for the routing credential as part of enabling the plugin —
which provider, the key, an account ID or endpoint if the provider needs one,
and which engine answers the policy graph's predicates. The key is masked as you type and stored in your keychain (falling back to
`~/.claude/.credentials.json`), never in `settings.json` and never in this
plugin's config file. Change the answers later with `/plugin`.

Nothing is required at that prompt. Leave the key empty to run the fixed-tier
baseline arms, which make no routing calls at all.

If you would rather not answer prompts, the environment still works:

```bash
export TYPESAFE_API_KEY=...        # https://typesafe.ai
```

`doctor` names which source is in play, so there is never a question of which
key is being used:

```
API key found — the key you entered when enabling the plugin
API key found — environment variable TYPESAFE_API_KEY
```

Precedence runs most-specific first: a variable you named yourself in
`routing.jev.apiKeyEnv`, then the install-time answer, then the provider's
default variable.

Jev is also served through gateways. Pick the provider and supply its key:

```yaml
# Cloudflare Workers AI
routing:
  jev:
    provider: cloudflare
    accountId: "<your account id>"     # CLOUDFLARE_API_TOKEN
    model: "typesafe/jev"               # jev-1.13.0 is what the response echoes

# Vercel AI Gateway
routing:
  jev:
    provider: vercel                   # AI_GATEWAY_API_KEY

# LiteLLM or any other pass-through proxy
routing:
  jev:
    provider: passthrough              # JEV_API_KEY
    endpoint: https://litellm.internal/typesafe/v1/systemone
```

Every default a provider supplies — `endpoint`, `apiKeyEnv`, extra `headers` —
is overridable, so a provider whose defaults are wrong is a one-line fix rather
than a code change. `jev-dispatch providers` lists them.

The provider, account ID and endpoint can also be answered at the install prompt
instead of written here. Those answers seed the configuration; a config file
written later overrides them.

> **Confirm your provider before trusting it.** No provider shape in this build
> has been exercised against a running service: the TypeSafe shape was read from
> a working client, and the gateway shapes are inferred from how those gateways
> generally behave. `jev-dispatch check-router` makes one real request and prints
> the raw response, which is how a provider gets confirmed. A 200 carrying no
> answers means the endpoint or the model is wrong, and the response usually says
> which.

Responses are unwrapped by looking for the `answers` object rather than by
assuming a particular envelope, so a gateway that wraps in `result`, `data`,
`response` or `output` — or not at all — works without a code change.

Check the installation:

```bash
jev-dispatch doctor
```

Requires Node 22.5+ (for `node:sqlite`) and the `claude` CLI on `PATH`. The
plugin itself has **no npm dependencies**.

To uninstall: `/plugin uninstall jev-dispatch`. That removes the tool, the
agents, the hooks, the MCP server and the stored credential. The telemetry
database is left alone — delete it with `jev-dispatch purge --yes` if you want
it gone.

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

A check that **exits 127** is read as "this could not judge the work" rather
than as a failure — which is what keeps a repository with no test script from
failing every delegation, without lying about it either: the verdict becomes
`UNCERTAIN`, never `PASS`. `examples/checks/` has four written that way (git
hygiene, node, python, rust), and the commands above are the naive form: `npm
test` in a repository whose `package.json` has no test script exits 1, and every
delegation there is judged a failure.

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

### Getting briefs written in the first place

Two mechanisms, because they fail differently.

The bundled **`delegate` skill** is the procedure: find the edit sites, write
the plan, derive acceptance criteria, state the constraints, call the tool. Its
body loads only when the model reaches for it, so it costs nothing per turn.

But a skill is only read when the model decides to read one — and the call it
would improve is exactly the call that gets made without reading it. So a
**`PreToolUse` hook** fires on every delegate call and says what is missing at
the moment it matters:

```yaml
contract:
  briefCheck: advise    # off | advise | enforce
```

`advise` (the default) never blocks: the call proceeds with a note about what
was missing. `enforce` turns a thin brief back **once**, with specific guidance,
and lets the next attempt at the same subtask through whatever it looks like — a
hook that can refuse the same work twice can trap a session, and no brief is
worth that. Neither mode says anything when a brief is already mostly complete.

## The dashboard

```bash
jev-dispatch ui       # http://127.0.0.1:4319/
```

Nine views: overview KPIs, the routing timeline (escalations shown as indented
retries), policy effectiveness, evaluator comparison, specification
effectiveness, confidence against outcome, worker performance, cache & cost, and
the arm comparison.

The **Evaluators** view is where the local-versus-remote question is answered:
routing quality and latency in one table, a latency chart on one scale, and a
per-predicate agreement table showing how differently two engines answer the
same question. Each row states whether that engine keeps the routing state on
this machine.

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

## Why a local semantic evaluator?

```
Main session
   ↓
policy graph              deterministic, versioned, data
   ↓
semantic predicates       narrow boolean questions
   ↓
Laya local / Jev remote   ← interchangeable
   ↓
deterministic tier        LOW | MEDIUM | HIGH
```

Jev started as the first evaluator, which is why the package is named for it.
Laya is not a replacement: it is the same semantic-predicate role filled by a
~300–400M model running on this machine, so the two can be compared through one
policy graph.

That makes the comparison worth running. A local evaluator answers in
milliseconds instead of hundreds, costs nothing per call, and sends the routing
state nowhere. What is unknown is whether it routes as *well* — and a 15 ms
evaluator that under-routes is worse than a 300 ms one that does not, because
under-routing is paid for twice: once in a failed cheap attempt and again in the
escalation. So the Evaluators view puts first-route success, escalation and
frontier rate beside the latency rather than in another tab.

```yaml
routing:
  mode: policy-graph                  # unchanged
  semanticEvaluator:
    provider: laya                    # jev | laya | mock
    laya:
      python: ~/.jev-dispatch/laya-venv/bin/python
```

Everything else is defaulted in `src/router/engines/laya.mjs`: the model authors'
own package and the `convaiinnovations/laya` weights. `python` is worth naming
explicitly — a Homebrew or system interpreter is externally managed, so the
install below goes into a virtual environment and the adapter has to be told
where it went.

```bash
uv venv ~/.jev-dispatch/laya-venv --python 3.12
uv pip install --python ~/.jev-dispatch/laya-venv/bin/python laya

jev-dispatch evaluators           # what is available and what is selected
jev-dispatch check-evaluator      # one real evaluation, including the model load
```

Measured on an M2 Pro with that setup: **30s model load per process** (79s the
first time, which downloads ~850MB), **3.7 GiB resident**, and **527ms for two
predicates in one batched call**.

An MLX runtime exists and is much faster on Apple silicon, but it is a third
party's port — neither the `laya-mlx` package nor the `aac6fef/laya-mlx`
checkpoint it loads is published or acknowledged by the model's authors — so it
is opt-in rather than the default:

```yaml
      runtime: mlx                    # auto | mlx | torch
      model: aac6fef/laya-mlx         # the port's own checkpoint
```

It has not been run here. The figures its author reports — 13.4 ms P50 for the
421M checkpoint, 7.4 ms for the 322M, on an M3 Max — are theirs.

Laya ships as a library with no server mode, and its CLI reloads the model on
every invocation — which is exactly what must not happen when routing calls it
many times a session. So a small Python process (`runtime/laya_server.py`) holds
the loaded model and answers over stdio: model load once at first use, then many
evaluations, then exit with the session. No inference is reimplemented in Node;
the adapter starts a process, frames JSON and applies a timeout.

Every semantic predicate still goes out in **one** call. Laya batches natively
(16 questions per forward pass by default), so this property is preserved rather
than worked around.

Model load time, resident memory, batch size and predicate count are recorded
alongside each routing decision, because "fast once warm" is only interesting if
the warm-up is accounted for.

**Failure behaviour is identical to Jev's.** A process that will not start, a
model that will not load, a timeout or a malformed answer all take the safer
branch at every semantic node. A local engine crashing is no more a reason to
under-route than a remote one timing out, and `onEvaluatorUnavailable` still
governs whether that means the strongest tier or a capped fallback.

### Comparing them

| Arm | `routing.mode` | `semanticEvaluator.provider` |
|---|---|---|
| A | `fixed-high` | — |
| B | `jev-direct` | — |
| C | `policy-graph` | `jev` |
| D | `policy-graph` | `laya` |

C and D share a policy graph, so a difference between them is a difference in
the evaluator. `jev-direct` is deliberately untouched: it asks Jev for the tier
itself, which is the thing the policy graph is being measured against.

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

Plan text is the exception worth stating plainly, and it depends on the
evaluator. With **Laya**, the routing state and the plan are read by a model on
this machine and go nowhere — the dashboard marks every delegation it routed as
local. With **Jev**, judging whether a plan is followable means sending it, so
the plan goes to the provider along with the routing state — truncated to
`routing.jev.maxPlanChars`, and only while `routing.jev.sendPlan` is true. Turn it off and `plan_is_executable` degrades to
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
    provider: typesafe                    # typesafe | cloudflare | vercel | passthrough | custom
    endpoint: null                        # null = the provider's default
    apiKeyEnv: null                       # null = the provider's default
    accountId: null                       # gateways that scope by account
    headers: {}                           # merged in; a null value removes a default
    model: jev-latest
    timeoutMs: 8000
    sendPlan: true                        # the plan is needed to judge whether it is followable
    maxPlanChars: 4000

workerDefaults:
  permissionMode: acceptEdits
  allowVerificationCommands: true         # let a worker run the checks that judge it
  timeoutMs: 900000
  bare: false                             # cuts worker startup cost; needs ANTHROPIC_API_KEY

contract:
  briefCheck: advise                      # off | advise | enforce; nudges thin briefs
  sessionStartNudge: true

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
- **Laya has been run for real; the MLX runtime has not.** The default
  configuration — the authors' `laya` package and the `convaiinnovations/laya`
  weights — was loaded on an M2 Pro and answered real predicates through
  `jev-dispatch check-evaluator`, which is where the figures above come from.
  The MLX port is still only exercised against a fake process that speaks the
  documented protocol, so its numbers remain its author's claim, not a
  measurement from here. One run of one machine is also not a benchmark.
- **The Jev integration has not been run against a live service either.** Everything
  downstream of routing — worker execution, verification, escalation, telemetry,
  the dashboard — was verified end to end with `fixed-*` modes, which make no
  routing calls. The router itself is covered only by tests that stub `fetch`
  with the wire format described above. Run `jev-dispatch check-router` first; if
  the shape differs, `endpoint`, `headers` and `model` are all configuration.

## Commands

```
jev-dispatch ui                        serve the dashboard
jev-dispatch doctor                    check config, policy, workers, key, telemetry
jev-dispatch route <task…>             dry-run the router and print the traversal
jev-dispatch providers                 list the Jev providers this build knows about
jev-dispatch check-router              make one real Jev request and print the response
jev-dispatch evaluators                list the semantic engines and which is selected
jev-dispatch check-evaluator           run one real evaluation through the selected engine
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
