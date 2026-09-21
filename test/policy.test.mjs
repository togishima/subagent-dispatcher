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

// Phase A covers the value-independent boundary; context-filter is not implemented.
const VALUE_GRAPH = {
  version: 'values',
  nodes: [{
    id: 'choice', type: 'semantic', question: 'Does the condition hold?',
    yes: { value: 'drop' }, no: { value: 'keep' },
  }],
};
const VALUE_OPTIONS = { values: ['drop', 'keep'], fallback: 'drop' };

test('value terminals validate and traverse with the supplied value list', () => {
  const policy = validatePolicy(VALUE_GRAPH, VALUE_OPTIONS);
  const walk = traverse(policy, {}, { choice: answer('yes', 0.9) });
  assert.equal(walk.value, 'drop');
  assert.equal(walk.tier, walk.value);
  assert.equal(walk.trail[0].value, 'drop');
  assert.equal(walk.trail[0].tier, walk.trail[0].value);
  assert.equal(walk.exhausted, false);
  assert.equal(walk.reason, 'policy-graph');
  assert.deepEqual(traverse(policy, {}, { choice: answer('yes', 0.9) }), walk);
});

test('tier terminals normalize to values with the same result and trail', () => {
  const legacy = structuredClone(VALUE_GRAPH);
  for (const branch of ['yes', 'no']) {
    legacy.nodes[0][branch] = { tier: legacy.nodes[0][branch].value };
  }
  const before = structuredClone(legacy);
  const policy = validatePolicy(legacy, VALUE_OPTIONS);
  assert.deepEqual(legacy, before);
  assert.deepEqual(policy.nodes.get('choice').yes, { value: 'drop' });
  for (const result of ['yes', 'no']) {
    const answers = { choice: answer(result, 0.9) };
    assert.deepEqual(
      traverse(policy, {}, answers),
      traverse(validatePolicy(VALUE_GRAPH, VALUE_OPTIONS), {}, answers),
    );
  }
});

test('the safer branch follows the supplied value order rather than value names', () => {
  const policy = validatePolicy(VALUE_GRAPH, VALUE_OPTIONS);
  assert.equal(policy.nodes.get('choice').$safer, 'no');
  assert.equal(traverse(policy, {}, {}).value, 'keep');
  assert.equal(traverse(policy, {}, { choice: answer('yes', 0.51) }, {
    defaultMinConfidence: 0.8,
  }).value, 'keep');
  const reversed = validatePolicy(VALUE_GRAPH, { ...VALUE_OPTIONS, values: ['keep', 'drop'] });
  assert.equal(reversed.nodes.get('choice').$safer, 'yes');
  assert.equal(traverse(reversed, {}, {}).value, 'drop');
});

test('the generic API requires a fallback and preserves compatibility aliases at the step limit', () => {
  assert.throws(() => validatePolicy(VALUE_GRAPH, { values: ['drop', 'keep'] }), /fallback/);
  assert.throws(() => validatePolicy(VALUE_GRAPH, { ...VALUE_OPTIONS, fallback: 'other' }), /fallback/);
  const policy = validatePolicy({ ...VALUE_GRAPH, fallback: 'keep' }, VALUE_OPTIONS);
  assert.equal(policy.fallback, 'keep');
  assert.equal(policy.fallbackTier, policy.fallback);
  assert.deepEqual(traverse(policy, {}, {}, { maxTraversalSteps: 0 }), {
    value: 'keep', tier: 'keep', trail: [], exhausted: true, reason: 'traversal-step-limit',
  });
  const legacy = validatePolicy({ ...VALUE_GRAPH, fallbackTier: 'keep' }, VALUE_OPTIONS);
  assert.equal(legacy.fallback, 'keep');
});

test('conflicting value and tier aliases and undefined terminal values are rejected', () => {
  const raw = structuredClone(VALUE_GRAPH);
  raw.nodes[0].yes.tier = 'keep';
  assert.throws(() => validatePolicy(raw, VALUE_OPTIONS), /aliases disagree/);
  raw.nodes[0].yes = { value: 'other' };
  assert.throws(() => validatePolicy(raw, VALUE_OPTIONS), /not a defined value/);
  assert.throws(() => validatePolicy({
    ...VALUE_GRAPH, fallback: 'drop', fallbackTier: 'keep',
  }, VALUE_OPTIONS), /aliases disagree/);
  for (const values of [[], ['drop', 'drop'], ['drop', 1]]) {
    assert.throws(() => validatePolicy(VALUE_GRAPH, { ...VALUE_OPTIONS, values }), /ordered list/);
  }
});

test('explicit loadPolicy options match the defaults from legacy config arguments', () => {
  const inline = loadPolicy({ ...VALUE_OPTIONS, graph: VALUE_GRAPH });
  assert.equal(traverse(inline, {}, {}).value, 'keep');
  for (const version of ['v1', 'v2']) {
    const path = `policies/${version}.json`;
    const explicit = loadPolicy({ values: ['low', 'medium', 'high'], fallback: 'medium', path });
    const legacy = loadPolicy(testConfig({ routing: { policyGraph: { path } } }));
    assert.deepEqual(explicit, legacy);
  }
  const raw = { version: 'default', nodes: [{
    id: 'a', type: 'semantic', question: 'Does the condition hold?',
    yes: { tier: 'low' }, no: { tier: 'high' },
  }] };
  assert.equal(validatePolicy(raw, config).fallback, 'medium');
  const single = { ...config, tiers: { low: config.tiers.low } };
  const singleGraph = { ...raw, nodes: [{ ...raw.nodes[0], onUncertain: 'yes', no: { tier: 'low' } }] };
  assert.equal(validatePolicy(singleGraph, single).fallback, 'low');
});
