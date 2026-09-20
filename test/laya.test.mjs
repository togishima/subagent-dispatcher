import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLayaEngine, readNoul } from '../src/router/engines/laya.mjs';
import { EvaluatorError } from '../src/router/engines/index.mjs';
import { createRouter } from '../src/router/index.mjs';
import { testConfig } from './helpers.mjs';

/**
 * The Laya runtime is not started from unit tests: it needs Apple silicon, a
 * model download, and hundreds of megabytes of RAM. What is tested here is
 * everything this repository actually owns — the framing, the batching, the
 * timeout, the crash handling and the answer normalisation — against a fake
 * process. Real inference is an integration check, run separately.
 */

/** A stand-in for the Python process, recording what it was asked. */
function fakeProcess({ answers = {}, failWith = null, ready = true, delayMs = 0, info = {} } = {}) {
  const calls = [];
  return () => ({
    info: ready ? { modelLoadMs: 812, rssMiB: 943.6, runtime: 'laya_mlx', ...info } : null,
    calls,
    started: 0,
    async start() {
      this.started += 1;
      if (!ready) throw new EvaluatorError('laya failed to load its model: no such checkpoint', { provider: 'laya' });
      return this.info;
    },
    async request(payload, timeoutMs) {
      await this.start();
      calls.push({ payload, timeoutMs });
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (failWith) return { ok: false, error: failWith };
      return {
        ok: true,
        answers: Object.fromEntries(Object.keys(payload.questions).map((id) => [id, answers[id] ?? 0.5])),
        latencyMs: 13.4,
        questionCount: Object.keys(payload.questions).length,
        usage: null,
        rssMiB: 951.2,
      };
    },
    stop() { this.stopped = true; },
  });
}

const layaConfig = (laya = {}) =>
  testConfig({ routing: { semanticEvaluator: { provider: 'laya', laya } } });

test('every predicate goes out in one batched request', async () => {
  const factory = fakeProcess({ answers: { a: 0.9, b: 0.2, c: 0.7 } });
  const engine = createLayaEngine(layaConfig(), { processFactory: factory });
  const predicates = [
    { id: 'a', question: 'Is it mechanical?', criteria: { true: 'yes', false: 'no' } },
    { id: 'b', question: 'Is it cross-cutting?' },
    { id: 'c', question: 'Is the root cause unknown?' },
  ];

  const result = await engine.evaluate({ state: { subtask: 'x' }, predicates });

  assert.equal(engine.process.calls.length, 1, 'one forward pass, not one per predicate');
  const sent = engine.process.calls[0].payload;
  assert.deepEqual(Object.keys(sent.questions).sort(), ['a', 'b', 'c']);
  for (const question of Object.values(sent.questions)) {
    assert.equal(question.type, 'noul');
    assert.ok(question.instructions);
    assert.ok(question.criteria, 'a predicate without criteria still gets a default pair');
  }
  assert.equal(result.metadata.batched, true);
  assert.equal(result.metadata.predicateCount, 3);
});

test('a bare probability becomes the same answer shape Jev produces', async () => {
  const engine = createLayaEngine(layaConfig(), { processFactory: fakeProcess({ answers: { a: 0.91, b: 0.12 } }) });
  const result = await engine.evaluate({
    state: {}, predicates: [{ id: 'a', question: 'q' }, { id: 'b', question: 'q' }],
  });
  assert.equal(result.answers.a.result, 'yes');
  assert.equal(result.answers.a.probability, 0.91);
  assert.equal(result.answers.a.confidence, 0.91);
  assert.equal(result.answers.b.result, 'no');
  assert.equal(Math.round(result.answers.b.confidence * 100) / 100, 0.88);
  assert.deepEqual(Object.keys(result.answers.a).sort(), ['confidence', 'probabilities', 'probability', 'result']);
});

test('both answer spellings are read', () => {
  // Laya returns a bare float for a noul; Jev returns an object. Take either.
  assert.deepEqual(readNoul(0.82), { probability: 0.82, confidence: undefined });
  assert.deepEqual(readNoul({ noul: 0.82, confidence: 0.7 }), { probability: 0.82, confidence: 0.7 });
  assert.equal(readNoul({ p_true: 0.3 }).probability, 0.3);
  for (const junk of ['text', null, undefined, {}, { noul: 'high' }, NaN]) {
    assert.equal(readNoul(junk), null, JSON.stringify(junk));
  }
});

test('latency and load cost are reported for the experiment', async () => {
  const engine = createLayaEngine(layaConfig({ model: 'aac6fef/laya-multilingual-mlx' }), {
    processFactory: fakeProcess({ answers: { a: 0.6 } }),
  });
  const result = await engine.evaluate({ state: {}, predicates: [{ id: 'a', question: 'q' }] });

  assert.equal(result.engine, 'laya');
  assert.equal(result.model, 'aac6fef/laya-multilingual-mlx');
  // The model's own timing, not the round trip, so it compares with Jev's.
  assert.equal(result.latencyMs, 13);
  assert.equal(result.metadata.modelLoadMs, 812);
  assert.equal(result.metadata.rssMiB, 951.2);
  assert.equal(typeof result.metadata.roundTripMs, 'number');
});

test('a malformed answer is refused rather than guessed at', async () => {
  const engine = createLayaEngine(layaConfig(), {
    processFactory: fakeProcess({ answers: { a: 'not a probability' } }),
  });
  await assert.rejects(
    () => engine.evaluate({ state: {}, predicates: [{ id: 'a', question: 'q' }] }),
    (error) => error instanceof EvaluatorError && /no usable answer for predicate "a"/.test(error.message),
  );
});

test('a model that will not load is an evaluator error, not a crash', async () => {
  const engine = createLayaEngine(layaConfig(), { processFactory: fakeProcess({ ready: false }) });
  await assert.rejects(
    () => engine.evaluate({ state: {}, predicates: [{ id: 'a', question: 'q' }] }),
    (error) => error instanceof EvaluatorError && /failed to load its model/.test(error.message),
  );
});

test('a failure inside the process is reported with its reason', async () => {
  const engine = createLayaEngine(layaConfig(), { processFactory: fakeProcess({ failWith: 'RuntimeError: shape mismatch' }) });
  await assert.rejects(
    () => engine.evaluate({ state: {}, predicates: [{ id: 'a', question: 'q' }] }),
    /shape mismatch/,
  );
});

test('the engine says it is local and that nothing leaves the machine', () => {
  const engine = createLayaEngine(layaConfig(), { processFactory: fakeProcess() });
  const described = engine.describe();
  assert.equal(described.provider, 'laya');
  assert.equal(described.local, true);
  assert.equal(described.dataLeavesMachine, false);
  assert.equal(described.modelLoadMs, 812);
});

test('a local engine sends the whole plan, since nothing is billed or shipped', () => {
  const engine = createLayaEngine(layaConfig(), { processFactory: fakeProcess() });
  const options = engine.stateOptions();
  assert.equal(options.sendPlan, true);
  assert.ok(options.maxPlanChars >= 16_000);
  // And an operator can still narrow it.
  const narrowed = createLayaEngine(layaConfig({ sendPlan: false }), { processFactory: fakeProcess() });
  assert.equal(narrowed.stateOptions().sendPlan, false);
});

test('a Laya outage over-routes exactly as a Jev outage does', async () => {
  // Under-routing because the local model died would be the worst possible
  // failure mode: cheap, silent and wrong.
  const config = layaConfig();
  const router = createRouter(config);
  // Replace the engine's process with one that refuses to start.
  router.engine.process.start = async () => { throw new EvaluatorError('laya process exited (SIGKILL)', { provider: 'laya' }); };
  router.engine.process.request = router.engine.process.start;

  const decision = await router.route({
    task: 'x', attempt: 1, verificationAvailable: true, specification: { hasPlan: false },
  });
  assert.equal(decision.degraded, true);
  assert.equal(decision.requiredTier, 'high');
  assert.equal(decision.evaluator.engine, 'laya');
});

test('closing the engine stops the process', async () => {
  const engine = createLayaEngine(layaConfig(), { processFactory: fakeProcess() });
  await engine.close();
  assert.equal(engine.process.stopped, true);
});

test('the adapter script is valid Python and speaks the documented protocol', async () => {
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'laya_server.py');
  assert.ok(fs.existsSync(script));
  const source = fs.readFileSync(script, 'utf8');
  // The properties the design depends on, asserted against the script itself.
  assert.match(source, /LAYA_MODEL/);
  assert.match(source, /agent\.predict\(request\.get\("state"\), questions\)/, 'one predict call per request');
  assert.match(source, /"ready": True/);
  assert.match(source, /modelLoadMs/);

  const compiled = await new Promise((resolve) => {
    execFile('python3', ['-m', 'py_compile', script], (error) => resolve(!error));
  });
  assert.equal(compiled, true, 'laya_server.py must compile');
});

test("the defaults point at the model authors' own package, not a third-party port", () => {
  // `provider: laya` with nothing else said must not reach for a package the
  // model's authors neither publish nor acknowledge. The MLX port stays
  // reachable, but only by asking for it.
  let captured = null;
  const engine = createLayaEngine(
    { routing: { semanticEvaluator: { provider: 'laya' } } },
    { processFactory: (settings) => { captured = settings; return fakeProcess({})(settings); } },
  );
  assert.equal(engine.describe().model, 'convaiinnovations/laya');
  assert.equal(captured.runtime, 'torch');
  // The first load downloads the weights, measured at 79s here. A timeout
  // shorter than the thing it times makes routing take the safer branch on
  // every cold cache.
  assert.ok(captured.startupTimeoutMs >= 300_000, 'startup allowance must cover a first download');
});
