import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPolicy, validatePolicy, semanticNodes } from '../src/policy/graph.mjs';
import { traverse, pathConfidence } from '../src/policy/traverse.mjs';
import { PREDICATES, evaluateDeterministic } from '../src/policy/predicates.mjs';
import { testConfig } from './helpers.mjs';

const config = testConfig();
const answer = (result, confidence) => ({
  result,
  confidence,
  probability: result === 'yes' ? confidence : 1 - confidence,
  probabilities: { yes: result === 'yes' ? confidence : 1 - confidence, no: result === 'yes' ? 1 - confidence : confidence },
});

const GRAPH = {
  version: 'test',
  entry: 'a',
  fallbackTier: 'medium',
  nodes: [
    { id: 'a', type: 'semantic', question: 'q a?', onUncertain: 'no', yes: { goto: 'b' }, no: { goto: 'c' } },
    { id: 'b', type: 'deterministic', predicate: 'verification_available', yes: { tier: 'low' }, no: { tier: 'medium' } },
    { id: 'c', type: 'semantic', question: 'q c?', yes: { tier: 'high' }, no: { tier: 'medium' } },
  ],
};

test('the shipped policy loads and is internally consistent', () => {
  const policy = loadPolicy(config);
  assert.equal(policy.version, 'v2');
  assert.ok(policy.nodes.size >= 4);
  assert.ok(semanticNodes(policy).length >= 1);
  for (const node of semanticNodes(policy)) {
    assert.ok(node.$safer === 'yes' || node.$safer === 'no', `${node.id} has no safer branch`);
  }
});

test('every shipped policy version validates, so v1 stays runnable for comparison', () => {
  for (const version of ['v1', 'v2']) {
    const policy = loadPolicy(testConfig({ routing: { policyGraph: { path: `policies/${version}.json` } } }));
    assert.equal(policy.version, version);
  }
});

test('v2 routes a complete brief cheaply and a bare goal expensively', () => {
  const policy = loadPolicy(config);
  const options = config.routing.policyGraph;
  const brief = {
    task: 'implement the thing',
    verificationAvailable: true,
    specification: { hasPlan: true, hasEditSites: true, hasAcceptanceCriteria: true },
  };
  // A concrete, executable plan is the route to the cheapest worker.
  assert.equal(traverse(policy, brief, { plan_is_executable: answer('yes', 0.9) }, options).tier, 'low');
  // The same brief with a vague plan falls through to the judgement questions.
  assert.equal(
    traverse(policy, brief, {
      plan_is_executable: answer('no', 0.9),
      cross_cutting: answer('yes', 0.9),
      high_stakes_judgment: answer('yes', 0.9),
    }, options).tier,
    'high',
  );
  // No brief at all, and the work needs judgement: the caller left the thinking undone.
  assert.equal(
    traverse(policy, { task: 'make auth better', specification: { hasPlan: false } }, {
      mechanical: answer('no', 0.9),
      cross_cutting: answer('yes', 0.9),
      high_stakes_judgment: answer('yes', 0.9),
    }, options).tier,
    'high',
  );
});

test('v2 accepts acceptance criteria in place of a runnable check', () => {
  const policy = loadPolicy(config);
  const options = config.routing.policyGraph;
  const base = { task: 'x', verificationAvailable: false, specification: { hasPlan: true, hasEditSites: true, hasAcceptanceCriteria: true } };
  // Nothing to run, but the worker can still check itself against stated criteria.
  assert.equal(traverse(policy, base, { plan_is_executable: answer('yes', 0.9) }, options).tier, 'low');
  // A complete brief with neither a runnable check nor stated criteria: there is
  // nothing to catch a bad cheap result, so it does not go to the cheapest worker.
  const unchecked = {
    ...base,
    specification: { hasPlan: true, hasEditSites: true, hasExpectedOutput: true, hasAcceptanceCriteria: false },
  };
  assert.equal(traverse(policy, unchecked, { plan_is_executable: answer('yes', 0.9) }, options).tier, 'medium');
});

test('a brief missing its definition of done is not treated as complete', () => {
  const policy = loadPolicy(config);
  const options = config.routing.policyGraph;
  // No acceptance criteria and no expected output: the caller left something open,
  // so routing falls through to the judgement questions rather than to execution.
  const walk = traverse(
    policy,
    { task: 'x', verificationAvailable: true, specification: { hasPlan: true, hasEditSites: true } },
    { mechanical: answer('no', 0.9), cross_cutting: answer('no', 0.9), root_cause_unknown: answer('no', 0.9) },
    options,
  );
  assert.equal(walk.trail.find((step) => step.nodeId === 'has_brief').result, 'no');
  assert.equal(walk.tier, 'medium');
});

test('the safer branch is derived from reachable tiers when not declared', () => {
  const policy = validatePolicy(GRAPH, config);
  // c's yes-branch reaches high, its no-branch reaches medium, so yes over-routes.
  assert.equal(policy.nodes.get('c').$safer, 'yes');
  assert.equal(policy.nodes.get('c').$saferSource, 'derived');
  // a declares its own, which wins over derivation.
  assert.equal(policy.nodes.get('a').$safer, 'no');
  assert.equal(policy.nodes.get('a').$saferSource, 'declared');
});

test('a policy whose branches are indistinguishable is refused at load time', () => {
  // Both branches end at the same tier, so nothing says which way to fall.
  assert.throws(
    () =>
      validatePolicy(
        {
          version: 'ambiguous',
          entry: 'a',
          nodes: [{ id: 'a', type: 'semantic', question: 'q?', yes: { tier: 'medium' }, no: { tier: 'medium' } }],
        },
        config,
      ),
    /set "onUncertain" explicitly/,
  );
});

test('structural errors are caught before any task is routed', () => {
  const cases = [
    [{ version: 'v', entry: 'a', nodes: [{ id: 'a', type: 'semantic', question: 'q', yes: { goto: 'a' }, no: { tier: 'low' } }] }, /cycle/],
    [{ version: 'v', entry: 'a', nodes: [{ id: 'a', type: 'semantic', question: 'q', yes: { goto: 'ghost' }, no: { tier: 'low' } }] }, /not a node/],
    [{ version: 'v', entry: 'a', nodes: [{ id: 'a', type: 'deterministic', predicate: 'made_up', yes: { tier: 'low' }, no: { tier: 'high' } }] }, /unknown deterministic predicate/],
    [{ version: 'v', entry: 'a', nodes: [{ id: 'a', type: 'semantic', question: 'q', yes: { tier: 'nope' }, no: { tier: 'low' } }] }, /not a defined tier/],
    [{ version: 'v', entry: 'a', nodes: [{ id: 'a', type: 'semantic', question: 'q', yes: { tier: 'low', goto: 'a' }, no: { tier: 'high' } }] }, /exactly one/],
    [{ version: 'v', entry: 'a', nodes: [
        { id: 'a', type: 'semantic', question: 'q', yes: { tier: 'low' }, no: { tier: 'high' } },
        { id: 'orphan', type: 'semantic', question: 'q', yes: { tier: 'low' }, no: { tier: 'high' } },
      ] }, /unreachable/],
  ];
  for (const [graph, pattern] of cases) assert.throws(() => validatePolicy(graph, config), pattern);
});

test('traversal follows confident answers', () => {
  const policy = validatePolicy(GRAPH, config);
  const options = { defaultMinConfidence: 0.6, overRouteOnUncertain: true };

  assert.equal(traverse(policy, { verificationAvailable: true }, { a: answer('yes', 0.95) }, options).tier, 'low');
  assert.equal(traverse(policy, { verificationAvailable: false }, { a: answer('yes', 0.95) }, options).tier, 'medium');
  assert.equal(
    traverse(policy, {}, { a: answer('no', 0.9), c: answer('yes', 0.9) }, options).tier,
    'high',
  );
});

test('uncertainty over-routes instead of under-routing', () => {
  const policy = validatePolicy(GRAPH, config);
  const options = { defaultMinConfidence: 0.6, overRouteOnUncertain: true };
  // Jev says "yes" (which would reach low), but only just — so the safer "no" wins.
  const walk = traverse(policy, { verificationAvailable: true }, { a: answer('yes', 0.52), c: answer('no', 0.9) }, options);
  assert.equal(walk.tier, 'medium');
  const step = walk.trail[0];
  assert.equal(step.answered, 'yes');
  assert.equal(step.result, 'no');
  assert.equal(step.uncertain, true);
  assert.equal(step.uncertainReason, 'below-threshold');
});

test('turning off over-routing honours the raw answer', () => {
  const policy = validatePolicy(GRAPH, config);
  const walk = traverse(policy, { verificationAvailable: true }, { a: answer('yes', 0.52) }, {
    defaultMinConfidence: 0.6,
    overRouteOnUncertain: false,
  });
  assert.equal(walk.tier, 'low');
  assert.equal(walk.trail[0].uncertain, true);
  assert.equal(walk.trail[0].uncertainReason, 'below-threshold-accepted');
});

test('a missing semantic answer takes the safer branch', () => {
  const policy = validatePolicy(GRAPH, config);
  const walk = traverse(policy, { verificationAvailable: true }, {}, { defaultMinConfidence: 0.6 });
  assert.equal(walk.tier, 'high'); // a -> no (safer), c -> yes (safer)
  assert.ok(walk.trail.every((step) => step.type !== 'semantic' || step.uncertain));
  assert.equal(walk.trail[0].uncertainReason, 'no-answer');
});

test('path confidence is the weakest link that decided the route', () => {
  const policy = validatePolicy(GRAPH, config);
  const walk = traverse(policy, {}, { a: answer('no', 0.91), c: answer('yes', 0.73) }, { defaultMinConfidence: 0.6 });
  assert.equal(pathConfidence(walk.trail), 0.73);
});

test('specification predicates read what the caller supplied', () => {
  const specified = {
    task: 'x',
    specification: {
      hasPlan: true, planChars: 900, hasAcceptanceCriteria: true,
      hasEditSites: true, hasConstraints: true, hasExpectedOutput: true,
    },
  };
  assert.equal(PREDICATES.plan_provided(specified, {}), true);
  assert.equal(PREDICATES.plan_at_least(specified, { chars: 500 }), true);
  assert.equal(PREDICATES.plan_at_least(specified, { chars: 5000 }), false);
  assert.equal(PREDICATES.acceptance_criteria_provided(specified, {}), true);
  assert.equal(PREDICATES.edit_sites_specified(specified, {}), true);
  assert.equal(PREDICATES.constraints_provided(specified, {}), true);
  assert.equal(PREDICATES.fully_specified(specified, {}), true);

  const bare = { task: 'x', specification: { hasPlan: false } };
  for (const name of ['plan_provided', 'acceptance_criteria_provided', 'edit_sites_specified', 'fully_specified']) {
    assert.equal(PREDICATES[name](bare, {}), false, name);
  }
  // A missing specification block must not crash routing.
  assert.equal(PREDICATES.fully_specified({ task: 'x' }, {}), false);
});

test('a plan without somewhere to apply it is not a complete brief', () => {
  assert.equal(
    PREDICATES.fully_specified({ specification: { hasPlan: true, hasEditSites: false, hasAcceptanceCriteria: true } }, {}),
    false,
  );
  assert.equal(
    PREDICATES.fully_specified({ specification: { hasPlan: true, hasEditSites: true, hasExpectedOutput: true } }, {}),
    true,
  );
});

test('deterministic predicates decide what code safely can', () => {
  const input = {
    task: 'rename the helper and update the changelog',
    taskType: 'refactor',
    verificationAvailable: true,
    contextFiles: ['a.ts', 'b.ts'],
    riskFlags: ['security'],
    attempt: 2,
    previousFailureReason: 'CAPABILITY_FAILURE',
  };
  assert.equal(PREDICATES.verification_available(input, {}), true);
  assert.equal(PREDICATES.task_matches(input, { patterns: ['\\brename\\b'] }), true);
  assert.equal(PREDICATES.task_matches(input, { patterns: ['\\bdeploy\\b'] }), false);
  assert.equal(PREDICATES.task_type_is(input, { values: ['refactor', 'docs'] }), true);
  assert.equal(PREDICATES.risk_flag_present(input, { flags: ['security'] }), true);
  assert.equal(PREDICATES.risk_flag_present(input, { flags: ['concurrency'] }), false);
  assert.equal(PREDICATES.context_files_at_most(input, { count: 1 }), false);
  assert.equal(PREDICATES.context_files_at_least(input, { count: 2 }), true);
  assert.equal(PREDICATES.previous_attempt_failed(input), true);
  assert.equal(PREDICATES.previous_failure_reason_is(input, { reasons: ['CAPABILITY_FAILURE'] }), true);
});

test('a malformed pattern never decides routing', () => {
  const result = PREDICATES.task_matches({ task: 'anything' }, { patterns: ['([unclosed'] });
  assert.equal(result, false);
});

test('an unknown predicate fails loudly at evaluation', () => {
  assert.throws(
    () => evaluateDeterministic({ id: 'x', predicate: 'nope' }, {}),
    /unknown deterministic predicate/,
  );
});
