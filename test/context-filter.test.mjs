import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { loadPolicy, semanticNodes } from '../src/policy/graph.mjs';
import { traverse } from '../src/policy/traverse.mjs';
import { PREDICATES } from '../src/policy/predicates.mjs';
import { createMockEngine } from '../src/router/engines/mock.mjs';
import { filterContextItem } from '../src/context-filter/index.mjs';
import { buildFilterState } from '../src/context-filter/state.mjs';

const policy = loadPolicy({
  path: 'policies/context-filter-v1.json',
  values: ['drop', 'keep'],
  fallback: 'keep',
});
const task = 'Fix the login redirect';
const item = { id: 'note-1', kind: 'note', summary: 'Login redirect details' };
/** What an evaluator is allowed to see: the item's id is not part of it. */
const sent = { kind: item.kind, summary: item.summary };

function engineFor(probability = 0.95, extra = {}) {
  const engine = createMockEngine({ routing: { semanticEvaluator: {
    mock: { answers: { item_relevant: probability }, ...extra },
  } } });
  mock.method(engine, 'evaluate');
  return engine;
}

function filter(engine, overrides = {}, options) {
  return filterContextItem({ policy, engine, task, item, ...overrides }, options);
}

test('constraints are kept without evaluating semantic predicates', async () => {
  const engine = engineFor();
  const result = await filter(engine, { item: { ...item, kind: 'constraint' } });
  assert.equal(result.value, 'keep');
  assert.equal(engine.evaluate.mock.callCount(), 0);
  assert.equal(result.semanticSkipped, true);
  assert.equal(result.engine, null);
  assert.ok(result.trail.every((step) => step.type === 'deterministic'));
});

test('explicitly obsolete items are dropped without evaluation', async () => {
  const engine = engineFor();
  const result = await filter(engine, { item: { ...item, summary: '[obsolete] Old redirect' } });
  assert.equal(result.value, 'drop');
  assert.equal(result.semanticSkipped, true);
  assert.equal(engine.evaluate.mock.callCount(), 0);
});

for (const [probability, value] of [[0.95, 'keep'], [0.05, 'drop']]) {
  test(`semantic relevance decides ${value} through the shared core`, async () => {
    const engine = engineFor(probability);
    const result = await filter(engine);
    assert.equal(result.value, value);
    assert.equal(result.engine, 'mock');
    assert.equal(result.semanticSkipped, false);
    assert.equal(engine.evaluate.mock.callCount(), 1);
    const request = engine.evaluate.mock.calls[0].arguments[0];
    assert.deepEqual(request.predicates, semanticNodes(policy));
    assert.deepEqual(request.state, { task, item: sent });
    assert.equal(result.trail.at(-1).nodeId, 'item_relevant');
    assert.equal(result.trail.at(-1).uncertain, false);
  });
}

test('missing semantic answers keep context', async () => {
  const engine = { name: 'empty', evaluate: mock.fn(async () => ({ answers: {} })) };
  const result = await filter(engine);
  assert.equal(result.value, 'keep');
  assert.equal(engine.evaluate.mock.callCount(), 1);
  assert.equal(result.trail.at(-1).uncertainReason, 'no-answer');
});

test('low confidence answers keep context instead of dropping it', async () => {
  const result = await filter(engineFor(0.4));
  assert.equal(result.value, 'keep');
  assert.equal(result.trail.at(-1).answered, 'no');
  assert.equal(result.trail.at(-1).uncertainReason, 'below-threshold');
});

test('an unavailable evaluator keeps context and reports its error', async () => {
  const result = await filter(engineFor(0.05, { fail: 'offline' }));
  assert.equal(result.value, 'keep');
  assert.equal(result.error, 'offline');
  assert.equal(result.semanticSkipped, false);
});

test('only summaries and selected metadata enter the state or engine request', async () => {
  const privateItem = {
    ...item, content: 'SECRET_CONTENT', body: 'SECRET_BODY',
    metadata: { content: 'SECRET_NESTED' },
  };
  const state = buildFilterState({ task, item: privateItem });
  assert.deepEqual(state, { task, item: sent });
  for (const secret of ['SECRET_CONTENT', 'SECRET_BODY', 'SECRET_NESTED', item.id]) {
    assert.equal(JSON.stringify(state).includes(secret), false);
  }
  const engine = engineFor();
  await filter(engine, { item: privateItem });
  assert.deepEqual(engine.evaluate.mock.calls[0].arguments[0].state, state);
});

test('item summaries do not become task text and task text does not match items', async () => {
  const input = { task: 'Fix login', item: { ...item, summary: '[obsolete] unrelated' } };
  assert.equal(PREDICATES.task_matches(input, { patterns: ['obsolete'] }), false);
  assert.equal(PREDICATES.item_matches(input, { patterns: ['login'] }), false);
  assert.equal(PREDICATES.item_matches(input, { patterns: ['['] }), false);
  assert.equal(PREDICATES.item_matches(input, { patterns: ['obsolete'] }), true);
  const result = await filter(engineFor(), { task: '[obsolete] task', item });
  assert.equal(result.semanticSkipped, false);
});

test('fixed answers reproduce the same value and complete trail', async () => {
  const engine = engineFor(0.05);
  const first = await filter(engine);
  const second = await filter(engine);
  assert.deepEqual(first, second);
  const answers = (await engine.evaluate({ predicates: semanticNodes(policy) })).answers;
  const replay = traverse(policy, { task, item }, answers);
  assert.equal(first.value, replay.value);
  assert.deepEqual(first.trail, replay.trail);
});

test('the ordered values derive keep as the safer branch and fallback', async () => {
  assert.equal(policy.fallback, 'keep');
  assert.equal(policy.nodes.get('item_relevant').$safer, 'yes');
  const result = await filter(engineFor(), {}, { maxTraversalSteps: 0 });
  assert.equal(result.value, 'keep');
  assert.equal(result.exhausted, true);
});
