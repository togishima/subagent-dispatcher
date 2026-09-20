import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter, availableModes } from '../src/router/index.mjs';
import { resolveDispatch, applyAttemptFloor, nextTierForEscalation } from '../src/router/tier-policy.mjs';
import { buildRoutingState } from '../src/router/state.mjs';
import { evaluateSemanticPredicates, classifyTierDirectly } from '../src/router/jev-client.mjs';
import { testConfig } from './helpers.mjs';

/** Stand in for TypeSafe, and capture exactly what would have been sent. */
function stubJev(responder) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    const result = responder(body);
    if (result instanceof Error) throw result;
    if (result?.status) {
      return { ok: false, status: result.status, text: async () => result.text ?? '' };
    }
    return { ok: true, status: 200, json: async () => result };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const noulAnswers = (values) => ({
  answers: Object.fromEntries(Object.entries(values).map(([id, p]) => [id, { noul: p }])),
  usage: { input_tokens: 120, output_tokens: 0 },
});

test('three routers are registered: the three arms of the experiment', () => {
  for (const mode of ['policy-graph', 'jev-direct', 'fixed']) assert.ok(availableModes().includes(mode));
});

test('every semantic predicate goes out in one batched call', async () => {
  const config = testConfig({ routing: { mode: 'policy-graph' } });
  const stub = stubJev(() => noulAnswers({ mechanical: 0.9, cross_cutting: 0.1, root_cause_unknown: 0.1, high_stakes_judgment: 0.1 }));
  process.env.TYPESAFE_API_KEY = 'test-key';
  try {
    const decision = await createRouter(config).route({ task: 'add a null check', verificationAvailable: true, attempt: 1 });
    assert.equal(stub.calls.length, 1, 'one request, not one per predicate');
    const questions = stub.calls[0].body.questions;
    assert.ok(Object.keys(questions).length >= 4);
    for (const question of Object.values(questions)) {
      assert.equal(question.type, 'noul', 'semantic predicates are narrow booleans');
      assert.ok(question.instructions.length > 20);
    }
    assert.equal(decision.requiredTier, 'low');
    assert.equal(decision.router, 'policy-graph');
    assert.equal(decision.policyVersion, 'v1');
  } finally {
    stub.restore();
  }
});

test('Jev is never shown a model, a worker or a tier name', async () => {
  const config = testConfig({ routing: { mode: 'policy-graph' } });
  const stub = stubJev(() => noulAnswers({ mechanical: 0.2, cross_cutting: 0.2, root_cause_unknown: 0.2, high_stakes_judgment: 0.2 }));
  process.env.TYPESAFE_API_KEY = 'test-key';
  try {
    await createRouter(config).route({ task: 'do a thing', verificationAvailable: false, attempt: 1 });
    const sent = JSON.stringify(stub.calls[0].body);
    for (const forbidden of ['haiku', 'sonnet', 'opus', 'claude-', 'worker']) {
      assert.ok(!sent.toLowerCase().includes(forbidden), `"${forbidden}" leaked into the Jev request`);
    }
  } finally {
    stub.restore();
  }
});

test('the routing state stays small and excludes conversation history', () => {
  const state = buildRoutingState({
    task: 'do X',
    expectedOutput: 'X done',
    contextSummary: 'short summary',
    taskType: 'implement',
    verificationAvailable: true,
    riskFlags: ['security'],
    contextFiles: ['a.ts', 'b.ts'],
    attempt: 2,
    previousTier: 'low',
    previousFailureReason: 'CAPABILITY_FAILURE',
  });
  assert.equal(state.subtask, 'do X');
  assert.equal(state.relevant_file_count, 2);
  assert.equal(state.previous_attempt.tier, 'low');
  // File contents are never sent, only how many there were.
  assert.ok(!JSON.stringify(state).includes('a.ts'));
  assert.ok(JSON.stringify(state).length < 600);
});

test('a Jev outage takes the safer branch rather than guessing', async () => {
  const config = testConfig({ routing: { mode: 'policy-graph' } });
  const stub = stubJev(() => new Error('network down'));
  process.env.TYPESAFE_API_KEY = 'test-key';
  try {
    const decision = await createRouter(config).route({ task: 'x', verificationAvailable: true, attempt: 1 });
    assert.equal(decision.degraded, true);
    assert.equal(decision.requiredTier, 'high', 'uncertainty over-routes');
    assert.ok(decision.error);
  } finally {
    stub.restore();
  }
});

test('an outage can instead be capped at a fixed tier, by configuration', async () => {
  const config = testConfig({
    routing: { mode: 'policy-graph', policyGraph: { onEvaluatorUnavailable: 'fallback-tier' }, fallbackTierOnRouterError: 'medium' },
  });
  const stub = stubJev(() => new Error('network down'));
  process.env.TYPESAFE_API_KEY = 'test-key';
  try {
    const decision = await createRouter(config).route({ task: 'x', verificationAvailable: true, attempt: 1 });
    assert.equal(decision.requiredTier, 'medium');
    assert.equal(decision.reason, 'router-error-fallback');
  } finally {
    stub.restore();
  }
});

test('a missing API key is reported, not silently ignored', async () => {
  const previous = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    await assert.rejects(
      () => evaluateSemanticPredicates([{ id: 'x', question: 'q' }], {}, testConfig().routing.jev),
      /no Jev API key/,
    );
  } finally {
    if (previous !== undefined) process.env.TYPESAFE_API_KEY = previous;
  }
});

test('the key is sent as a bearer token and never logged', async () => {
  process.env.TYPESAFE_API_KEY = 'super-secret';
  const stub = stubJev(() => noulAnswers({ x: 0.8 }));
  try {
    await evaluateSemanticPredicates([{ id: 'x', question: 'q?' }], { a: 1 }, testConfig().routing.jev);
    assert.equal(stub.calls[0].headers.Authorization, 'Bearer super-secret');
    assert.ok(!JSON.stringify(stub.calls[0].body).includes('super-secret'));
  } finally {
    stub.restore();
  }
});

test('jev-direct floors a low-confidence distribution instead of trusting the argmax', async () => {
  const config = testConfig({ routing: { mode: 'jev-direct' } });
  process.env.TYPESAFE_API_KEY = 'test-key';

  const confident = stubJev(() => ({
    answers: { required_tier: { choice: 'low', confidence: 0.91, probabilities: { low: 0.91, medium: 0.07, high: 0.02 } } },
  }));
  try {
    const decision = await createRouter(config).route({ task: 'x', attempt: 1 });
    assert.equal(decision.requiredTier, 'low');
    assert.equal(decision.confidence, 0.91);
    assert.deepEqual(decision.probabilities, { low: 0.91, medium: 0.07, high: 0.02 });
  } finally { confident.restore(); }

  const shaky = stubJev(() => ({
    answers: { required_tier: { choice: 'low', confidence: 0.4, probabilities: { low: 0.4, medium: 0.35, high: 0.25 } } },
  }));
  try {
    const decision = await createRouter(config).route({ task: 'x', attempt: 1 });
    assert.equal(decision.requiredTier, 'medium', 'below threshold must not route to the cheapest tier');
    assert.equal(decision.reason, 'jev-direct-confidence-floor');
  } finally { shaky.restore(); }
});

test('jev-direct rejects a tier it does not recognise', async () => {
  const config = testConfig({ routing: { mode: 'jev-direct' } });
  process.env.TYPESAFE_API_KEY = 'test-key';
  const stub = stubJev(() => ({ answers: { required_tier: { choice: 'ultra', confidence: 0.99 } } }));
  try {
    const decision = await createRouter(config).route({ task: 'x', attempt: 1 });
    assert.equal(decision.degraded, true);
    assert.equal(decision.requiredTier, config.routing.fallbackTierOnRouterError);
  } finally { stub.restore(); }
});

test('jev-direct asks one choice question over the configured tiers', async () => {
  process.env.TYPESAFE_API_KEY = 'test-key';
  const stub = stubJev(() => ({ answers: { required_tier: { choice: 'high', confidence: 0.9, probabilities: { high: 0.9 } } } }));
  try {
    await classifyTierDirectly({ subtask: 'x' }, testConfig().tiers, testConfig().routing.jev);
    const question = stub.calls[0].body.questions.required_tier;
    assert.equal(question.type, 'choice');
    assert.deepEqual(Object.keys(question.criteria).sort(), ['high', 'low', 'medium']);
  } finally { stub.restore(); }
});

test('the fixed router makes no network call at all', async () => {
  const config = testConfig({ routing: { mode: 'fixed-high' } });
  const stub = stubJev(() => { throw new Error('fixed mode must not call Jev'); });
  try {
    const decision = await createRouter(config).route({ task: 'x', attempt: 1 });
    assert.equal(decision.requiredTier, 'high');
    assert.equal(decision.routingLatencyMs, 0);
    assert.equal(stub.calls.length, 0);
  } finally { stub.restore(); }
});

test('escalation floors a later attempt, and never routes back down', () => {
  const config = testConfig();
  assert.equal(applyAttemptFloor(config, 'low', { escalatedTo: 'medium' }).tier, 'medium');
  assert.equal(applyAttemptFloor(config, 'high', { escalatedTo: 'medium' }).tier, 'high');
  assert.equal(applyAttemptFloor(config, 'low', {}).tier, 'low');
  assert.equal(nextTierForEscalation(config, 'medium'), 'high');
  assert.equal(nextTierForEscalation(config, 'high'), null);

  const resolved = resolveDispatch(config, { requiredTier: 'low', reason: 'r' }, { escalatedTo: 'high' });
  assert.equal(resolved.selectedTier, 'high');
  assert.equal(resolved.worker.model, 'opus');
  assert.equal(resolved.policyReason, 'escalation-floor');
});
