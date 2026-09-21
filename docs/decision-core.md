# The decision core

The policy engine decides a value. Model routing is one use of that decision;
keeping or dropping a context item is another. The useful boundary is between
making a decision from evidence and doing something with the result. A worker,
a retry budget and a telemetry database belong on the latter side.

## What the core owns

`src/policy/graph.mjs`, `src/policy/traverse.mjs` and
`src/policy/predicates.mjs` provide the shared mechanism: validate a graph,
evaluate ordinary predicates, and follow boolean branches to a terminal value.
The mechanism is independent of the output vocabulary. The predicate registry
still contains application-specific knowledge, as described below.

The terminal key is `value`. `tier` is a compatibility alias normalized at load
time, not a second kind of terminal. If both appear and disagree, loading fails.
The caller supplies the ordered vocabulary and default fallback through
`{ values, fallback }`; a policy can declare its own `fallback`, which must also
belong to that vocabulary. The core does not assign tier semantics to values.

The ordering means exactly one thing: a larger index is the safer, over-route
side of uncertainty. `saferBranch` compares the reachable ranges of the two
branches, first their minimum indexes, then their maximum indexes. It needs no
knowledge of models or context. Equal ranges require an explicit `onUncertain`;
that declaration can also override a derived branch. This belongs at load time
because an ambiguous safety choice should fail before a decision is needed.

Fact acquisition finishes before traversal. The predicates read evidence
already present in the input; they do not collect it. Loading can read a policy
file, and an evaluator can perform I/O, but traversal itself is a pure loop with
no I/O. With the same compiled policy, input, semantic answers and traversal
options, it returns the same result and the same trail. Reproducibility is a
property of consuming fixed evidence, not a promise that a model will answer
the same question identically on a later request.

## Two consumers, one mechanism

These are the two consumers in the repository, not proposed integrations. The
routing column describes the shipped three-tier configuration and policies.

| | Use case A: model routing | Use case B: context filtering |
|---|---|---|
| Ordered values | `['low', 'medium', 'high']` | `['drop', 'keep']` |
| Fallback | `medium` | `keep` |
| Uncertainty | Toward higher tiers | Toward `keep` |
| Entry point | `src/router/index.mjs` | `src/context-filter/index.mjs` |
| Policies | `policies/v1.json`, `policies/v2.json` | `policies/context-filter-v1.json` |

Both use the same graph validation, deterministic predicate dispatch, safer
branch handling and traversal. The context filter's source totals 55 lines:
37 in `src/context-filter/index.mjs` and 18 in `src/context-filter/state.mjs`,
including comments and blank lines. Its application work is to select the
state sent to an injected evaluator and return the decision.

That selection is an allowlist of `kind` and `summary`, so a field added to an
item later cannot reach an evaluator by accident. The item's id is excluded
along with its body: no predicate reads it, the policy's question names only
kind and summary, and one call judges one item, so an id has no addressing role
either. An id is frequently a file path, and the routing state beside it sends
a count of relevant files rather than their names for the same reason.

Adding that second consumer required no changes to the graph loader, traversal
or router. It did add `item_kind_is` and `item_matches` to the shared predicate
registry; saying that every file under `src/policy/` stayed untouched would be
incorrect. The decision mechanism needed no new framework. That is the evidence
for this boundary: a second vocabulary and a small consumer were enough. If the
second use case had required a framework, the abstraction would have been wrong.

The tests in `test/context-filter.test.mjs` exercise deterministic decisions
without evaluation, semantic decisions, missing answers, low confidence,
evaluator failure, fallback and replay of the complete trail. They also show
the explicit loading API that needs no routing configuration:

```js
const policy = loadPolicy({
  path: 'policies/context-filter-v1.json',
  values: ['drop', 'keep'],
  fallback: 'keep',
});
```

## What stays with subagent dispatch

`src/router/` assembles the routing application: it creates the engine, builds
routing state, decides a required tier and shapes the result for telemetry.
`src/router/tier-policy.mjs` maps that tier to a worker and applies the floor
left by an earlier failed attempt. `src/worker/` executes the work,
`src/verify/` judges the result, and `src/telemetry/` records and reports what
happened.

Escalation belongs to this application too. `src/dispatch/orchestrate.mjs`
owns the attempt loop and its budgets, records whether each selected worker is
a frontier worker, and aggregates whether frontier work was used. Those are
consequences of dispatching work, not properties of a boolean decision graph.

The decision core does not know what Opus is. It returns `high`; the application
maps that value to a worker. Changing that mapping does not change what the
policy means, and a consumer returning `keep` has no reason to inherit workers,
verification or frontier accounting.

## Coupling that remains

The predicate registry is shared. `item_kind_is` and `item_matches` live beside
routing predicates in `src/policy/predicates.mjs`. Making that registry
injectable would be a third generalization, beyond parameterizing values and
adding the second consumer. No use case yet forces it, so it is deliberately
unsolved. Output values are generic; the available input predicates are not.

Every caller passes explicit `{ values, fallback, graph, path, configDir }`
options. The routing application derives them from its configuration in
`routingPolicyOptions()`, `src/router/tier-policy.mjs`: it sorts `config.tiers`
by `order` to produce `values`, uses the second value as the fallback (the
first if there is only one), and copies `routing.policyGraph.graph`,
`routing.policyGraph.path` and `$configDir`. The CLI and the routing tests go
through that function. Nothing under `src/policy/` knows the shape of the
configuration any more; the `loadPolicy()` call above, taken from
`test/context-filter.test.mjs`, shows the same options built by hand.

Semantic engine settings still live under `config.routing.*`, including
`routing.jev` and `routing.semanticEvaluator`. The evaluators themselves do not
require routing-shaped state: Jev and Laya forward the state supplied to them.
The coupling is in configuration placement and the default criteria's wording,
"this subtask". The context filter accepts an engine as an argument, so it does
not need to construct one from routing configuration, and its policy supplies
node-level `criteria` about context relevance instead of using those defaults.
Injection bypasses that configuration dependency for the consumer; it does not
remove it from the existing engine factories.

Traversal still returns the compatibility field `tier`, both on each trail
step and alongside the final `value`. The context filter reads `value` and
passes the trail through without consulting `tier`. That alias remains for
existing routing and telemetry consumers, not because values must be tiers.

Relative policy paths still depend on `pluginRoot`. Resolution first checks
`configDir` when supplied, then the plugin root. A consumer outside this plugin
should supply an absolute path or an inline `graph` to avoid relying on that
layout.

## When semantic evaluation is skipped

The context filter first traverses with an empty answer map. If the resulting
trail contains no semantic step, deterministic evidence already decided the
item and the engine is never called. Otherwise it asks the engine for all
semantic nodes and traverses again with the answers. This skips an entire
evaluation when possible; it does not prune individual questions from a batch.

`src/router/index.mjs` instead checks whether the policy contains any semantic
nodes at all. If it does, the router evaluates them before traversal, even when
the eventual path is entirely deterministic. The filter's path-based check is
therefore not yet a shared optimization. It is a candidate for future common
code, with a routing tradeoff to preserve: unused semantic answers are currently
recorded so alternative policies can be scored offline. No common evaluator
orchestration layer has been introduced here.

## What is deliberately out of scope

A natural-language-to-policy compiler is not part of this boundary. Compiled
policies remain hand-authored data, validated before use. A person or a model
can help write that data, but the runtime does not depend on how it was written.
Separating authorship from execution is what lets the same small mechanism
serve both consumers without acquiring either application's workflow.
