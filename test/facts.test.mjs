import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectFacts, FACT_STATUS } from '../src/facts/index.mjs';
import { runSemgrep, scanTargets } from '../src/facts/semgrep.mjs';
import { PREDICATES, evaluateDeterministic } from '../src/policy/predicates.mjs';
import { traverse } from '../src/policy/traverse.mjs';
import { validatePolicy } from '../src/policy/graph.mjs';
import { buildRoutingState } from '../src/router/state.mjs';
import { DatabaseSync } from 'node:sqlite';
import { TelemetryStore } from '../src/telemetry/store.mjs';
import { testConfig, tempDir } from './helpers.mjs';

/**
 * Semgrep is an optional deterministic evidence provider, so the properties
 * worth testing are mostly about what it must *not* do: never require its own
 * installation, never fail a dispatch, never turn "nobody looked" into "yes",
 * and never carry source code into routing state or telemetry.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = testConfig();

/** A fake child process that replays a canned semgrep run. */
function fakeSpawn({ stdout = '', stderr = '', code = 0, error = null, hang = false, calls = [] } = {}) {
  return (binary, args, options) => {
    calls.push({ binary, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; };
    if (hang) return child; // never emits: the caller's timeout must fire
    setImmediate(() => {
      if (error) { child.emit('error', error); return; }
      if (stdout) child.stdout.emit('data', stdout);
      if (stderr) child.stderr.emit('data', stderr);
      child.emit('close', code);
    });
    return child;
  };
}

const semgrepJson = (results) => JSON.stringify({ version: '1.0.0', results, errors: [], paths: {} });

const match = (checkId, fact, extra = {}) => ({
  check_id: checkId,
  path: 'src/auth.ts',
  start: { line: 12 }, end: { line: 14 },
  extra: {
    message: 'Authentication-sensitive code',
    lines: 'const token = signJwt(secret)',
    severity: 'WARNING',
    ...(fact === undefined ? {} : { metadata: { dispatcher: { fact } } }),
    ...extra,
  },
});

// --- the adapter ------------------------------------------------------------

test('semgrep disabled collects nothing and never spawns anything', async () => {
  assert.equal(config.facts.semgrep.enabled, false, 'the shipped default must leave Semgrep off');

  let spawned = false;
  const facts = await collectFacts(config, { cwd: root }, {
    runners: { semgrep: async () => { spawned = true; return null; } },
  });

  assert.equal(spawned, false);
  assert.equal(facts.status, FACT_STATUS.DISABLED);
  assert.equal(facts.unavailable, false, 'switched off is not the same as unavailable');
  assert.deepEqual(facts.matched, []);
});

test('a missing semgrep binary is unavailable, not a routing failure', async () => {
  const enoent = Object.assign(new Error('spawn semgrep ENOENT'), { code: 'ENOENT' });
  const result = await runSemgrep({ cwd: root }, { spawn: fakeSpawn({ error: enoent }) });
  assert.equal(result.status, FACT_STATUS.MISSING);
  assert.deepEqual(result.facts, []);

  const facts = await collectFacts(testConfig({ facts: { semgrep: { enabled: true } } }), { cwd: root }, {
    runners: { semgrep: () => runSemgrep({ cwd: root }, { spawn: fakeSpawn({ error: enoent }) }) },
  });
  assert.equal(facts.status, FACT_STATUS.MISSING);
  assert.equal(facts.unavailable, true);
  assert.deepEqual(facts.matched, []);
});

test('a semgrep run that overruns its timeout yields no facts', async () => {
  const result = await runSemgrep({ cwd: root, timeoutMs: 20 }, { spawn: fakeSpawn({ hang: true }) });
  assert.equal(result.status, FACT_STATUS.TIMEOUT);
  assert.deepEqual(result.facts, []);
});

test('malformed semgrep output is unavailable rather than half-believed', async () => {
  for (const stdout of ['not json at all', '{"errors": []}', '{"results": {}}']) {
    const result = await runSemgrep({ cwd: root }, { spawn: fakeSpawn({ stdout }) });
    assert.equal(result.status, FACT_STATUS.MALFORMED, stdout);
    assert.deepEqual(result.facts, []);
  }
});

test('a clean scan is available with zero matches, which is different from unavailable', async () => {
  const result = await runSemgrep({ cwd: root }, { spawn: fakeSpawn({ stdout: semgrepJson([]) }) });
  assert.equal(result.status, FACT_STATUS.OK);
  assert.equal(result.matchCount, 0);
  assert.deepEqual(result.facts, []);

  const facts = await collectFacts(testConfig({ facts: { semgrep: { enabled: true } } }), { cwd: root }, {
    runners: { semgrep: () => runSemgrep({ cwd: root }, { spawn: fakeSpawn({ stdout: semgrepJson([]) }) }) },
  });
  assert.equal(facts.unavailable, false, 'a clean scan is evidence, not an absence of it');
  assert.deepEqual(facts.matched, []);
});

test('one rule carrying dispatcher metadata becomes one logical fact', async () => {
  const result = await runSemgrep({ cwd: root }, {
    spawn: fakeSpawn({ stdout: semgrepJson([match('auth-sensitive-change', 'auth_sensitive')]) }),
  });
  assert.deepEqual(result.facts, ['auth_sensitive']);
  assert.equal(result.matchCount, 1);
});

test('several matches of the same rule deduplicate into one fact', async () => {
  const results = [
    match('auth-sensitive-change', 'auth_sensitive'),
    match('auth-sensitive-change', 'auth_sensitive'),
    match('auth-sensitive-change', 'auth_sensitive'),
  ];
  const result = await runSemgrep({ cwd: root }, { spawn: fakeSpawn({ stdout: semgrepJson(results) }) });
  assert.deepEqual(result.facts, ['auth_sensitive']);
  assert.equal(result.matchCount, 3, 'the match count still reflects what was found');
});

test('different rules produce several facts, sorted and without unmapped noise', async () => {
  const results = [
    match('auth-sensitive-change', 'auth_sensitive'),
    match('db-migration', 'database_migration'),
    match('some-third-party-rule', undefined), // no dispatcher metadata at all
  ];
  const result = await runSemgrep({ cwd: root }, { spawn: fakeSpawn({ stdout: semgrepJson(results) }) });
  assert.deepEqual(result.facts, ['auth_sensitive', 'database_migration']);
  assert.equal(result.matchCount, 3);
});

test('configured ruleFacts map rule ids a rule pack owner cannot annotate', async () => {
  const results = [match('r2c.owasp.sql-injection', undefined), match('auth-sensitive-change', 'auth_sensitive')];
  const result = await runSemgrep(
    { cwd: root, ruleFacts: { 'r2c.owasp.sql-injection': 'security_sensitive' } },
    { spawn: fakeSpawn({ stdout: semgrepJson(results) }) },
  );
  assert.deepEqual(result.facts, ['auth_sensitive', 'security_sensitive']);
});

test('config-supplied rule mapping wins over rule metadata', async () => {
  const result = await runSemgrep(
    { cwd: root, ruleFacts: { 'auth-sensitive-change': 'security_sensitive' } },
    { spawn: fakeSpawn({ stdout: semgrepJson([match('auth-sensitive-change', 'auth_sensitive')]) }) },
  );
  assert.deepEqual(result.facts, ['security_sensitive']);
});

test('the adapter keeps no source, no messages and no raw findings', async () => {
  const result = await runSemgrep({ cwd: root }, {
    spawn: fakeSpawn({ stdout: semgrepJson([match('auth-sensitive-change', 'auth_sensitive')]) }),
  });
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('signJwt'), 'matched source must not survive normalization');
  assert.ok(!serialized.includes('Authentication-sensitive code'), 'rule messages must not survive');
  assert.ok(!serialized.includes('src/auth.ts'));
  assert.deepEqual(Object.keys(result).sort(), ['error', 'facts', 'latencyMs', 'matchCount', 'status']);
});

test('semgrep is invoked as argv without a shell, scanning the named files', async () => {
  const calls = [];
  const dir = tempDir('jev-facts-');
  fs.writeFileSync(path.join(dir, 'auth.ts'), 'export const x = 1;\n');
  await runSemgrep(
    { cwd: dir, configPath: path.join(dir, 'rules.yml'), targets: scanTargets(['auth.ts', '../escape.ts'], dir) },
    { spawn: fakeSpawn({ stdout: semgrepJson([]), calls }) },
  );

  const [call] = calls;
  assert.equal(call.binary, 'semgrep');
  assert.ok(call.args.includes('--json'));
  assert.equal(call.options.shell, undefined, 'no shell: targets are caller-influenced paths');
  assert.deepEqual(call.args.slice(-1), [path.join(dir, 'auth.ts')]);
  assert.ok(!call.args.some((arg) => arg.includes('escape.ts')), 'paths outside the cwd are refused');
});

// --- the predicate ----------------------------------------------------------

test('code_fact_present is true when a requested fact was matched', () => {
  const input = { codeFacts: { matched: ['auth_sensitive', 'database_migration'], status: 'ok', unavailable: false } };
  assert.equal(PREDICATES.code_fact_present(input, { facts: ['auth_sensitive'] }), true);
  assert.equal(PREDICATES.code_fact_present(input, { facts: ['nope', 'database_migration'] }), true);
});

test('code_fact_present is false when the fact was looked for and not found', () => {
  const input = { codeFacts: { matched: ['database_migration'], status: 'ok', unavailable: false } };
  assert.equal(PREDICATES.code_fact_present(input, { facts: ['auth_sensitive'] }), false);
});

test('unavailable evidence never produces a positive match', () => {
  for (const codeFacts of [
    undefined,
    { matched: [], status: FACT_STATUS.DISABLED, unavailable: false },
    { matched: [], status: FACT_STATUS.MISSING, unavailable: true },
    { matched: [], status: FACT_STATUS.TIMEOUT, unavailable: true },
    { matched: [], status: FACT_STATUS.MALFORMED, unavailable: true },
  ]) {
    assert.equal(PREDICATES.code_fact_present({ codeFacts }, { facts: ['auth_sensitive'] }), false);
    assert.equal(PREDICATES.code_fact_present({ codeFacts }, {}), false, 'not even the empty request matches');
  }
});

test('code_facts_available separates "no such code" from "nobody looked"', () => {
  assert.equal(PREDICATES.code_facts_available({ codeFacts: { matched: [], status: 'ok' } }), true);
  assert.equal(PREDICATES.code_facts_available({ codeFacts: { matched: [], status: 'missing' } }), false);
  assert.equal(PREDICATES.code_facts_available({}), false);
});

test('a policy can route on a code fact, and routes as before without one', () => {
  const graph = validatePolicy({
    version: 'facts-test',
    entry: 'auth_sensitive',
    fallbackTier: 'medium',
    nodes: [
      {
        id: 'auth_sensitive',
        type: 'deterministic',
        predicate: 'code_fact_present',
        args: { facts: ['auth_sensitive'] },
        yes: { tier: 'high' },
        no: { goto: 'verifiable' },
      },
      { id: 'verifiable', type: 'deterministic', predicate: 'verification_available', yes: { tier: 'low' }, no: { tier: 'medium' } },
    ],
  }, config);

  const withFact = traverse(graph, { codeFacts: { matched: ['auth_sensitive'], status: 'ok' }, verificationAvailable: true }, {});
  assert.equal(withFact.tier, 'high');

  // Semgrep absent: the route is the one the rest of the policy would have taken.
  for (const codeFacts of [undefined, { matched: [], status: FACT_STATUS.MISSING, unavailable: true }]) {
    const walk = traverse(graph, { codeFacts, verificationAvailable: true }, {});
    assert.equal(walk.tier, 'low', 'an unavailable provider must not over-route by itself');
  }
});

// --- what the semantic evaluator sees ---------------------------------------

test('routing state carries normalized fact names for the semantic evaluator', () => {
  const state = buildRoutingState({
    task: 'Rotate the signing key',
    codeFacts: { matched: ['auth_sensitive', 'database_migration'], status: 'ok', unavailable: false },
  });
  assert.deepEqual(state.code_facts, ['auth_sensitive', 'database_migration']);
});

test('routing state carries no semgrep output, findings or source', () => {
  const state = buildRoutingState({
    task: 'Rotate the signing key',
    codeFacts: {
      matched: ['auth_sensitive'],
      status: 'ok',
      unavailable: false,
      semgrep: { status: 'ok', matchCount: 3, latencyMs: 142 },
    },
  });
  const serialized = JSON.stringify(state);
  for (const leak of ['signJwt', 'src/auth.ts', 'check_id', 'matchCount', 'semgrep', 'WARNING']) {
    assert.ok(!serialized.includes(leak), `routing state leaked ${leak}`);
  }
  assert.deepEqual(Object.keys(state.code_facts), ['0'], 'only the names, as a flat list');
});

test('no facts means no code_facts key at all', () => {
  for (const codeFacts of [undefined, { matched: [], status: FACT_STATUS.MISSING, unavailable: true }]) {
    const state = buildRoutingState({ task: 'x', codeFacts });
    assert.ok(!('code_facts' in state));
  }
});

// --- the invariant ----------------------------------------------------------

test('traversal acquires no evidence: no I/O, no subprocess, synchronous', () => {
  for (const file of ['src/policy/traverse.mjs', 'src/policy/predicates.mjs']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const forbidden of ['child_process', 'node:fs', 'node:net', 'node:http', 'fetch(', 'await ']) {
      assert.ok(!source.includes(forbidden), `${file} must not contain ${forbidden}`);
    }
  }

  const graph = validatePolicy({
    version: 'sync-test',
    entry: 'a',
    fallbackTier: 'medium',
    nodes: [{ id: 'a', type: 'deterministic', predicate: 'code_fact_present', args: { facts: ['x'] }, yes: { tier: 'high' }, no: { tier: 'low' } }],
  }, config);
  const walk = traverse(graph, { codeFacts: { matched: ['x'], status: 'ok' } }, {});
  assert.ok(!(walk instanceof Promise), 'traverse() must stay synchronous');
  assert.equal(walk.tier, 'high');
});

test('an unknown fact provider status still evaluates as a plain predicate', () => {
  const node = { id: 'n', type: 'deterministic', predicate: 'code_fact_present', args: { facts: ['auth_sensitive'] } };
  assert.equal(evaluateDeterministic(node, { codeFacts: { matched: null, status: 'weird' } }), false);
});

// --- end to end -------------------------------------------------------------

test('a real spawn of a stub semgrep produces facts through collectFacts', async () => {
  const dir = tempDir('jev-facts-e2e-');
  const binary = path.join(dir, 'semgrep-stub');
  fs.writeFileSync(
    binary,
    `#!/usr/bin/env node\n` +
      `process.stdout.write(JSON.stringify({ results: [\n` +
      `  { check_id: 'auth-sensitive-change', path: 'a.ts', extra: { lines: 'secret', metadata: { dispatcher: { fact: 'auth_sensitive' } } } },\n` +
      `  { check_id: 'db-migration', path: 'b.sql', extra: { metadata: { dispatcher: { fact: 'database_migration' } } } },\n` +
      `], errors: [] }));\n` +
      // Semgrep exits non-zero when it has findings under some flag combinations;
      // parsed output is still evidence, so this must not matter.
      `process.exit(1);\n`,
  );
  fs.chmodSync(binary, 0o755);

  const facts = await collectFacts(
    testConfig({ facts: { semgrep: { enabled: true, binary, config: null } } }),
    { cwd: dir, contextFiles: [] },
  );
  assert.equal(facts.status, FACT_STATUS.OK);
  assert.deepEqual(facts.matched, ['auth_sensitive', 'database_migration']);
  assert.equal(facts.semgrep.matchCount, 2);
});

test('telemetry records fact names and no semgrep output', () => {
  const dir = tempDir('jev-facts-db-');
  const store = new TelemetryStore(testConfig(), path.join(dir, 'facts.db'));
  store.openDelegation({
    taskId: 't1',
    task: 'Rotate the signing key',
    specification: {},
    verificationAvailable: false,
    codeFacts: {
      matched: ['auth_sensitive', 'database_migration'],
      status: FACT_STATUS.OK,
      unavailable: false,
      semgrep: { status: FACT_STATUS.OK, matchCount: 3, latencyMs: 142 },
    },
  });
  const [row] = store.query('SELECT code_facts, code_fact_count, semgrep_status, semgrep_match_count, semgrep_latency_ms FROM delegations');

  // Names, because a decision is only reproducible from what the router read.
  assert.deepEqual(JSON.parse(row.code_facts), ['auth_sensitive', 'database_migration']);
  assert.equal(row.code_fact_count, 2);
  assert.equal(row.semgrep_status, FACT_STATUS.OK);
  assert.equal(row.semgrep_match_count, 3);
  assert.equal(row.semgrep_latency_ms, 142);
  store.close();
});

test('an unavailable provider is recorded as unavailable, never as matched', () => {
  const dir = tempDir('jev-facts-db-');
  const store = new TelemetryStore(testConfig(), path.join(dir, 'facts.db'));
  store.openDelegation({
    taskId: 't1', task: 'x', specification: {}, verificationAvailable: false,
    codeFacts: { matched: [], status: FACT_STATUS.TIMEOUT, unavailable: true, semgrep: { status: FACT_STATUS.TIMEOUT, matchCount: 0, latencyMs: 10_000 } },
  });
  const [row] = store.query('SELECT code_facts, code_fact_count, semgrep_status FROM delegations');
  assert.equal(row.code_facts, null);
  assert.equal(row.code_fact_count, 0);
  assert.equal(row.semgrep_status, FACT_STATUS.TIMEOUT);
  store.close();
});

test('a semgrep run that failed outright is unavailable, not a clean scan', async () => {
  // A missing rules file exits 7 and still prints well-formed JSON with an
  // empty results array. Believing the parse alone would report a broken
  // installation as "looked, found nothing".
  for (const code of [2, 4, 5, 7]) {
    const result = await runSemgrep({ cwd: root }, {
      spawn: fakeSpawn({ stdout: JSON.stringify({ results: [], errors: [{ level: 'error' }] }), code }),
    });
    assert.equal(result.status, FACT_STATUS.ERROR, `exit ${code}`);
    assert.deepEqual(result.facts, []);
  }

  // 0 and 1 are both successful runs: findings or not, Semgrep was able to look.
  for (const code of [0, 1]) {
    const result = await runSemgrep({ cwd: root }, {
      spawn: fakeSpawn({ stdout: semgrepJson([match('auth-sensitive-change', 'auth_sensitive')]), code }),
    });
    assert.equal(result.status, FACT_STATUS.OK, `exit ${code}`);
    assert.deepEqual(result.facts, ['auth_sensitive']);
  }
});

test('a delegations table written before code facts gains the columns and keeps its rows', () => {
  const dir = tempDir('jev-facts-legacy-');
  const file = path.join(dir, 'legacy.db');
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE delegations (
      task_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, finished_at INTEGER, session_id TEXT,
      routing_mode TEXT, policy_version TEXT, router TEXT, task_hash TEXT, title TEXT, task_type TEXT,
      has_plan INTEGER DEFAULT 0, plan_chars INTEGER DEFAULT 0, plan_document_count INTEGER DEFAULT 0,
      has_acceptance_criteria INTEGER DEFAULT 0, has_edit_sites INTEGER DEFAULT 0,
      has_constraints INTEGER DEFAULT 0, fully_specified INTEGER DEFAULT 0,
      verification_available INTEGER DEFAULT 0, attempt_count INTEGER DEFAULT 0,
      first_route_tier TEXT, final_tier TEXT, final_worker TEXT, first_route_success INTEGER,
      final_status TEXT, final_success INTEGER, unverified INTEGER DEFAULT 0,
      escalated INTEGER DEFAULT 0, frontier_used INTEGER DEFAULT 0, final_failure_reason TEXT,
      total_cost_usd REAL DEFAULT 0, total_input_tokens INTEGER DEFAULT 0,
      total_output_tokens INTEGER DEFAULT 0, total_cache_read_tokens INTEGER DEFAULT 0,
      total_cache_creation_tokens INTEGER DEFAULT 0, routing_input_tokens INTEGER DEFAULT 0,
      routing_output_tokens INTEGER DEFAULT 0, routing_latency_ms INTEGER DEFAULT 0, raw_task TEXT
    );
    INSERT INTO delegations (task_id, created_at, task_hash) VALUES ('old-task', ${Date.now()}, 'abc');
  `);
  legacy.close();

  const store = new TelemetryStore(testConfig(), file);
  const columns = store.query('PRAGMA table_info(delegations)').map((row) => row.name);
  for (const added of ['code_facts', 'code_fact_count', 'semgrep_status', 'semgrep_match_count', 'semgrep_latency_ms']) {
    assert.ok(columns.includes(added), `${added} should have been added`);
  }
  const [row] = store.query("SELECT task_id, code_facts FROM delegations WHERE task_id = 'old-task'");
  assert.equal(row.task_id, 'old-task', 'rows written before the fact layer are experiment results, not scratch');
  assert.equal(row.code_facts, null, 'a delegation routed before facts existed claims no facts');
  store.close();
});
