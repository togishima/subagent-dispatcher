import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, engineNames, normalizeAnswer, normalizeResult, EvaluatorError } from '../src/router/engines/index.mjs';
import { createRouter } from '../src/router/index.mjs';
import { loadPolicy, semanticNodes } from '../src/policy/graph.mjs';
import { traverse } from '../src/policy/traverse.mjs';
import { testConfig } from './helpers.mjs';

/**
 * The point of the abstraction is that the policy graph cannot tell which engine
 * answered it. These tests assert that, not just that each engine runs.
 */

const withMock = (answers, extra = {}) =>
  testConfig({ routing: { semanticEvaluator: { provider: 'mock', mock: { answers, ...extra } } } });

test('the registry names the engines, and jev is the default', () => {
  assert.deepEqual(engineNames().sort(), ['jev', 'mock']);
  // An absent setting must keep the original behaviour.
  assert.equal(createEngine(testConfig()).name, 'jev');
});

test('an unknown engine is rejected at config load', () => {
  assert.throws(
    () => testConfig({ routing: { semanticEvaluator: { provider: 'nonesuch' } } }),
    /semanticEvaluator\.provider/,
  );
});

test('every engine reports what it is and whether data leaves the machine', () => {
  const jev = createEngine(testConfig()).describe();
  assert.equal(jev.local, false);
  assert.match(String(jev.dataLeavesMachine), /routing state/);

  const mock = createEngine(withMock({})).describe();
  assert.equal(mock.local, true);
  assert.equal(mock.dataLeavesMachine, false);
});

test('answers are normalised the same way whatever reported them', () => {
  const confident = normalizeAnswer(0.93);
  assert.equal(confident.result, 'yes');
  assert.equal(confident.confidence, 0.93);
  assert.equal(confident.probabilities.yes, 0.93);
  // 1 - 0.93 is not exactly 0.07 in binary floating point; the pair must still sum to 1.
  assert.ok(Math.abs(confident.probabilities.yes + confident.probabilities.no - 1) < 1e-12);

  const low = normalizeAnswer(0.12);
  assert.equal(low.result, 'no');
  // Confidence is distance from the coin flip, not the raw probability.
  assert.equal(Math.round(low.confidence * 100) / 100, 0.88);

  // A calibrated figure from the engine wins over the derived one.
  assert.equal(normalizeAnswer(0.93, 0.71).confidence, 0.71);
  // Out-of-range values are clamped rather than propagated.
  assert.equal(normalizeAnswer(1.4).probability, 1);
  assert.equal(normalizeAnswer(-0.2).probability, 0);
});

test('the result shape is uniform, so telemetry never branches on engine', () => {
  const result = normalizeResult({ answers: {}, latencyMs: 12.7, engine: 'mock' });
  assert.deepEqual(Object.keys(result).sort(), ['answers', 'engine', 'latencyMs', 'metadata', 'model', 'usage']);
  assert.equal(result.latencyMs, 13, 'latency is rounded to whole milliseconds');
  assert.equal(result.usage, null);
  assert.equal(result.model, null);
  assert.equal(normalizeResult({ answers: {}, engine: 'x' }).latencyMs, 0);
});

test('the mock engine answers every predicate it is given', async () => {
  const config = withMock({ mechanical: 0.9 }, { defaultProbability: 0.3 });
  const engine = createEngine(config);
  const predicates = [{ id: 'mechanical' }, { id: 'cross_cutting' }];
  const result = await engine.evaluate({ state: {}, predicates });

  assert.equal(result.engine, 'mock');
  assert.equal(result.answers.mechanical.result, 'yes');
  assert.equal(result.answers.cross_cutting.result, 'no', 'unlisted predicates take the default');
  assert.equal(result.metadata.predicateCount, 2);
});

test('an engine failure is an EvaluatorError, not a crash', async () => {
  const engine = createEngine(withMock({}, { fail: 'model not loaded' }));
  await assert.rejects(() => engine.evaluate({ state: {}, predicates: [{ id: 'q' }] }), EvaluatorError);
});

test('the same answers reach the same tier whichever engine supplied them', async () => {
  // The graph must have no engine-specific behaviour at all. Run it against the
  // mock engine and against a hand-built answer set and compare the traversal.
  const probabilities = {
    mechanical: 0.2, plan_is_executable: 0.2, cross_cutting: 0.85,
    root_cause_unknown: 0.3, high_stakes_judgment: 0.91,
  };
  const config = withMock(probabilities);
  const router = createRouter(config);
  const input = { task: 'rework the session layer', attempt: 1, verificationAvailable: true, specification: { hasPlan: false } };
  const viaEngine = await router.route(input);

  const policy = loadPolicy(config);
  const direct = {};
  for (const node of semanticNodes(policy)) {
    const p = probabilities[node.id];
    direct[node.id] = normalizeAnswer(p);
  }
  const viaTraversal = traverse(policy, input, direct, config.routing.policyGraph);

  assert.equal(viaEngine.requiredTier, viaTraversal.tier);
  assert.deepEqual(
    viaEngine.trail.map((step) => [step.nodeId, step.result]),
    viaTraversal.trail.map((step) => [step.nodeId, step.result]),
  );
});

test('an engine outage over-routes rather than under-routing', async () => {
  const config = withMock({}, { fail: 'engine down' });
  const decision = await createRouter(config).route({
    task: 'x', attempt: 1, verificationAvailable: true, specification: { hasPlan: false },
  });
  assert.equal(decision.degraded, true);
  // Safer branch everywhere, which for this policy is the strongest tier. A
  // local engine crashing is no more a reason to route cheap than a remote one.
  assert.equal(decision.requiredTier, 'high');
  assert.match(decision.error, /engine down/);
});

test('an outage can still be capped at a fixed tier by configuration', async () => {
  const config = testConfig({
    routing: {
      semanticEvaluator: { provider: 'mock', mock: { fail: 'down' } },
      policyGraph: { onEvaluatorUnavailable: 'fallback-tier' },
      fallbackTierOnRouterError: 'medium',
    },
  });
  const decision = await createRouter(config).route({ task: 'x', attempt: 1, specification: {} });
  assert.equal(decision.requiredTier, 'medium');
  assert.equal(decision.reason, 'router-error-fallback');
});

test('the decision carries who evaluated it, for telemetry', async () => {
  const decision = await createRouter(withMock({ mechanical: 0.9 })).route({
    task: 'x', attempt: 1, verificationAvailable: true, specification: { hasPlan: false },
  });
  assert.equal(decision.evaluator.engine, 'mock');
  assert.equal(typeof decision.evaluatorLatencyMs, 'number');
});

test('jev-direct is untouched and still calls Jev itself', async () => {
  // The arm exists to compare "ask for the tier" against "ask for predicates";
  // pointing it at another engine would destroy that comparison.
  const config = testConfig({
    routing: { mode: 'jev-direct', semanticEvaluator: { provider: 'mock' } },
  });
  const original = globalThis.fetch;
  process.env.TYPESAFE_API_KEY = 'test-key';
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ answers: { required_tier: { choice: 'high', confidence: 0.9, probabilities: { high: 0.9 } } } }),
  });
  try {
    const decision = await createRouter(config).route({ task: 'x', attempt: 1, specification: {} });
    assert.equal(decision.router, 'jev-direct');
    assert.equal(decision.requiredTier, 'high');
    assert.equal(decision.evaluator.engine, 'jev-direct');
  } finally { globalThis.fetch = original; }
});
