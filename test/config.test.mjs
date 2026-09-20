import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml } from '../src/config/yaml.mjs';
import { deepMerge, orderedTiers, tierAbove, workerForTier, isLoopback } from '../src/config/load.mjs';
import { testConfig } from './helpers.mjs';

test('yaml: nested mappings, sequences and inline mappings', () => {
  const parsed = parseYaml(`
routing:
  mode: policy-graph     # trailing comment
  policyGraph:
    defaultMinConfidence: 0.6
verification:
  checks:
    - name: tests
      command: npm test
    - name: lint
      command: npm run lint
workerDefaults:
  disallowedTools: [Task, Agent]
  bare: false
empty:
`);
  assert.equal(parsed.routing.mode, 'policy-graph');
  assert.equal(parsed.routing.policyGraph.defaultMinConfidence, 0.6);
  assert.deepEqual(parsed.verification.checks, [
    { name: 'tests', command: 'npm test' },
    { name: 'lint', command: 'npm run lint' },
  ]);
  assert.deepEqual(parsed.workerDefaults.disallowedTools, ['Task', 'Agent']);
  assert.equal(parsed.workerDefaults.bare, false);
  assert.deepEqual(parsed.empty, {});
});

test('yaml: quoted scalars keep their content, and types are coerced', () => {
  const parsed = parseYaml(`
a: "value: with colon"
b: 'it''s quoted'
c: 42
d: 1.5
e: true
f: null
g: plain text
`);
  assert.equal(parsed.a, 'value: with colon');
  assert.equal(parsed.b, "it's quoted");
  assert.equal(parsed.c, 42);
  assert.equal(parsed.d, 1.5);
  assert.equal(parsed.e, true);
  assert.equal(parsed.f, null);
  assert.equal(parsed.g, 'plain text');
});

test('yaml: unsupported syntax is refused rather than misread', () => {
  // Silently misparsing a config would route real work to the wrong worker.
  assert.throws(() => parseYaml('a: &anchor value'), /anchors/);
  assert.throws(() => parseYaml('a: |\n  block'), /block scalars/);
  assert.throws(() => parseYaml('a: {inline: map}'), /flow mappings/);
  assert.throws(() => parseYaml('a: "unterminated'), /unterminated/);
});

test('deepMerge: objects merge, arrays replace', () => {
  const merged = deepMerge(
    { a: { b: 1, c: 2 }, list: [1, 2, 3] },
    { a: { c: 9, d: 4 }, list: [7] },
  );
  assert.deepEqual(merged, { a: { b: 1, c: 9, d: 4 }, list: [7] });
});

test('tier helpers order weakest to strongest', () => {
  const config = testConfig();
  assert.deepEqual(orderedTiers(config), ['low', 'medium', 'high']);
  assert.equal(tierAbove(config, 'low'), 'medium');
  assert.equal(tierAbove(config, 'high'), null);
  assert.equal(workerForTier(config, 'high').model, 'opus');
});

test('tier to worker mapping is configuration, not code', () => {
  const config = testConfig({
    tiers: { low: { order: 1, worker: 'local', description: 'x' } },
    workers: { local: { kind: 'command', command: ['./local-model.sh'] } },
    routing: { mode: 'fixed', fixedTier: 'low', fallbackTierOnRouterError: 'low', policyGraph: { path: null, graph: null } },
    escalation: { escalateOn: [], retrySameTierOn: [] },
  });
  const worker = workerForTier(config, 'low');
  assert.equal(worker.kind, 'command');
  assert.deepEqual(worker.command, ['./local-model.sh']);
});

test('a non-loopback dashboard bind is refused', () => {
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('::1'), true);
  assert.equal(isLoopback('0.0.0.0'), false);
  assert.throws(() => testConfig({ ui: { host: '0.0.0.0' } }), /loopback/);
  assert.throws(() => testConfig({ ui: { host: '192.168.1.5' } }), /loopback/);
});

test('invalid configuration is rejected with a reason', () => {
  assert.throws(() => testConfig({ tiers: { low: { order: 1, worker: 'nope' } } }), /not defined under workers/);
  assert.throws(() => testConfig({ routing: { mode: 'nonsense' } }), /routing\.mode/);
  assert.throws(() => testConfig({ escalation: { maxAttemptsPerTask: 0 } }), /maxAttemptsPerTask/);
  assert.throws(() => testConfig({ escalation: { escalateOn: ['MADE_UP'] } }), /unknown failure reason/);
});

test('fixed-<tier> and jev aliases resolve to canonical routers', () => {
  assert.equal(testConfig({ routing: { mode: 'fixed-high' } }).routing.fixedTier, 'high');
  assert.equal(testConfig({ routing: { mode: 'fixed-high' } }).routing.mode, 'fixed');
  assert.equal(testConfig({ routing: { mode: 'jev' } }).routing.mode, 'jev-direct');
});
