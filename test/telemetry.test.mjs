import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sanitizeTitle, redactText, taskHash, rawTaskIfEnabled, safeFailureDetail } from '../src/telemetry/privacy.mjs';
import { parseMetrics } from '../src/telemetry/otlp.mjs';
import { DatabaseSync } from 'node:sqlite';
import { TelemetryStore } from '../src/telemetry/store.mjs';
import { overview, policyComparison, cacheCostView, confidenceView, policyView, evaluatorView, predicateAgreement, evaluatorsSeen } from '../src/telemetry/queries.mjs';
import { createTelemetryServer } from '../src/telemetry/server.mjs';
import { redact } from '../src/util/log.mjs';
import { testConfig, tempDir } from './helpers.mjs';

test('secrets are stripped from anything that reaches the database', () => {
  const samples = [
    ['use sk-ant-api03-abcdefghijklmnop to call it', 'sk-ant'],
    ['token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', 'ghp_'],
    ['mail alice@example.com about it', '@example.com'],
    ['Authorization: Bearer abc.def.ghi', 'Bearer abc'],
    ['AWS key AKIAIOSFODNN7EXAMPLE here', 'AKIAIOSFODNN7EXAMPLE'],
  ];
  for (const [input, secret] of samples) {
    assert.ok(!redactText(input).includes(secret), input);
    assert.ok(redactText(input).includes('[redacted]'), input);
  }
});

test('log output redacts secret-shaped keys at any depth', () => {
  const redacted = redact({ headers: { authorization: 'Bearer x' }, nested: { api_key: 'sk-1', safe: 'keep' } });
  assert.equal(redacted.headers.authorization, '[redacted]');
  assert.equal(redacted.nested.api_key, '[redacted]');
  assert.equal(redacted.nested.safe, 'keep');
});

test('only a hash and a short sanitized title are stored by default', () => {
  const config = testConfig();
  const task = '# Heading\n\nFix the login bug, the key is sk-ant-api03-SECRETSECRETSECRET\nmore lines';
  const title = sanitizeTitle(task, config);
  assert.ok(!title.includes('sk-ant'));
  assert.ok(!title.includes('\n'));
  assert.ok(title.length <= config.telemetry.titleMaxLength + 1);
  assert.match(taskHash(task), /^[0-9a-f]{64}$/);
  assert.equal(rawTaskIfEnabled(task, config), null);
});

test('raw capture is opt-in, and still redacted when on', () => {
  const config = testConfig({ telemetry: { debugStoreRawInput: true } });
  const raw = rawTaskIfEnabled('key sk-ant-api03-SECRETSECRETSECRET rest', config);
  assert.ok(raw.includes('rest'));
  assert.ok(!raw.includes('sk-ant'));
  assert.equal(sanitizeTitle('x', testConfig({ telemetry: { storeTitles: false } })), null);
});

test('failure details are truncated and single-line', () => {
  const detail = safeFailureDetail(`${'x'.repeat(900)}\nsecond line`);
  assert.ok(detail.length <= 500);
  assert.ok(!detail.includes('\n'));
});

test('OTLP/JSON metrics are parsed, and unrelated metrics ignored', () => {
  const rows = parseMetrics({
    resourceMetrics: [{
      scopeMetrics: [{
        metrics: [
          { name: 'claude_code.token.usage', sum: { dataPoints: [
            { attributes: [
              { key: 'type', value: { stringValue: 'cacheRead' } },
              { key: 'query_source', value: { stringValue: 'main' } },
              { key: 'session.id', value: { stringValue: 's1' } },
            ], asInt: '4096' },
          ] } },
          { name: 'claude_code.cost.usage', sum: { dataPoints: [{ attributes: [], asDouble: 2.5 }] } },
          { name: 'claude_code.session.count', sum: { dataPoints: [{ asInt: '1' }] } },
        ],
      }],
    }],
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    metric: 'token', sessionId: 's1', model: null, querySource: 'main',
    tokenType: 'cacheRead', agentName: null, value: 4096,
  });
  assert.equal(rows[1].metric, 'cost');
  assert.equal(rows[1].value, 2.5);
  assert.deepEqual(parseMetrics({}), []);
  assert.deepEqual(parseMetrics(null), []);
});

test('cumulative counters are not double counted across exports', () => {
  const dir = tempDir();
  const config = testConfig();
  const store = new TelemetryStore(config, path.join(dir, 't.db'));
  const row = { metric: 'token', sessionId: 's', model: 'm', querySource: 'main', tokenType: 'cacheRead' };
  // The same counter, exported three times as it climbs.
  store.recordOtelCounter({ ...row, value: 100 });
  store.recordOtelCounter({ ...row, value: 250 });
  store.recordOtelCounter({ ...row, value: 400 });
  assert.equal(store.query('SELECT * FROM otel_counters').length, 1);
  assert.equal(cacheCostView(store).main.cacheRead, 400);
  // A late-arriving stale export must not lower the total.
  store.recordOtelCounter({ ...row, value: 250 });
  assert.equal(cacheCostView(store).main.cacheRead, 400);
  store.close();
});

test('cache read ratio separates main from subagents', () => {
  const dir = tempDir();
  const store = new TelemetryStore(testConfig(), path.join(dir, 't.db'));
  const write = (source, type, value) =>
    store.recordOtelCounter({ metric: 'token', sessionId: 's', model: 'm', querySource: source, tokenType: type, value });
  write('main', 'cacheRead', 900);
  write('main', 'input', 100);
  write('subagent', 'cacheRead', 20);
  write('subagent', 'input', 80);
  const view = cacheCostView(store);
  assert.equal(view.main.cacheReadRatio, 0.9);
  assert.equal(view.subagent.cacheReadRatio, 0.2);
  assert.equal(view.otelAvailable, true);
  store.close();
});

test('queries run on an empty database without throwing', () => {
  const dir = tempDir();
  const store = new TelemetryStore(testConfig(), path.join(dir, 'empty.db'));
  const stats = overview(store);
  assert.equal(stats.delegations, 0);
  assert.equal(stats.taskSuccessRate, null);
  assert.equal(stats.estimatedFrontierAvoidedUsd, null);
  assert.deepEqual(policyComparison(store), []);
  assert.equal(confidenceView(store).length, 4);
  assert.equal(policyView(store).predicates.length, 0);
  assert.equal(cacheCostView(store).otelAvailable, false);
  store.close();
});

test('retention prunes a delegation and everything hanging off it', () => {
  const dir = tempDir();
  const config = testConfig({ telemetry: { retentionDays: 1 } });
  const store = new TelemetryStore(config, path.join(dir, 't.db'));
  store.openDelegation({ taskId: 'old-task', sessionId: 's', task: 'x', taskType: null });
  store.db.prepare('UPDATE delegations SET created_at = ? WHERE task_id = ?').run(Date.now() - 5 * 86_400_000, 'old-task');
  store.recordEscalation({ taskId: 'old-task', fromTier: 'low', toTier: 'medium', reason: 'x', attempt: 1 });
  store.pruneOldData();
  assert.equal(store.query('SELECT * FROM delegations').length, 0);
  assert.equal(store.query('SELECT * FROM escalations').length, 0);
  store.close();
});

test('the dashboard refuses to leave the loopback interface', () => {
  const dir = tempDir();
  const store = new TelemetryStore(testConfig(), path.join(dir, 't.db'));
  // Bypass config validation to prove the server checks independently.
  const smuggled = { ...testConfig(), ui: { host: '0.0.0.0', port: 4319 } };
  assert.throws(() => createTelemetryServer(smuggled, store), /loopback-only/);
  store.close();
});

// --- schema 2: generic evaluator columns, added without disturbing schema 1

test('evaluator telemetry is written from the decision, not from a flattened alias', () => {
  const dir = tempDir();
  const store = new TelemetryStore(testConfig(), path.join(dir, 't.db'));
  store.openDelegation({ taskId: 't1', sessionId: 's', task: 'x', taskType: null, specification: {}, verificationAvailable: true });
  store.recordDispatch({
    taskId: 't1', attempt: 1, sessionId: 's',
    decision: {
      router: 'policy-graph', policyVersion: 'v2', requiredTier: 'low',
      confidence: 0.8, probabilities: null, trail: [], semanticEvaluations: [],
      routingLatencyMs: 40, degraded: false, error: null,
      // Only the nested object: no evaluatorLatencyMs alias in sight.
      evaluator: {
        engine: 'laya', model: 'aac6fef/laya-mlx', latencyMs: 14,
        usage: { input_tokens: 130, output_tokens: 0 },
        metadata: { runtime: 'laya_mlx', modelLoadMs: 812, batched: true },
      },
    },
    resolved: { selectedTier: 'low', worker: { name: 'haiku', model: 'haiku' }, policyReason: 'policy-graph' },
    previousTier: null,
  });

  const row = store.queryOne('SELECT * FROM dispatches WHERE task_id = ?', ['t1']);
  assert.equal(row.evaluator_provider, 'laya');
  assert.equal(row.evaluator_model, 'aac6fef/laya-mlx');
  assert.equal(row.evaluator_latency_ms, 14);
  assert.equal(row.evaluator_input_tokens, 130);
  assert.equal(JSON.parse(row.evaluator_metadata).modelLoadMs, 812);
  // The version-1 columns carry the same numbers, so an older reader still works.
  assert.equal(row.jev_latency_ms, 14);
  assert.equal(row.jev_input_tokens, 130);
  store.close();
});

test('evaluator comparison scores each engine on the same policy', () => {
  const dir = tempDir();
  const store = new TelemetryStore(testConfig(), path.join(dir, 't.db'));
  const record = (taskId, provider, latency, success, escalated) => {
    store.openDelegation({ taskId, sessionId: 's', task: taskId, taskType: null, specification: {}, verificationAvailable: true });
    store.recordDispatch({
      taskId, attempt: 1, sessionId: 's',
      decision: {
        router: 'policy-graph', policyVersion: 'v2', requiredTier: 'low', confidence: 0.8,
        probabilities: null, trail: [], semanticEvaluations: [], routingLatencyMs: latency,
        degraded: false, error: null,
        evaluator: { engine: provider, model: 'm', latencyMs: latency, usage: null, metadata: null },
      },
      resolved: { selectedTier: 'low', worker: { name: 'haiku', model: 'haiku' }, policyReason: 'r' },
      previousTier: null,
    });
    store.closeDelegation({
      taskId,
      summary: {
        status: success ? 'completed' : 'failed', success, finalTier: 'low', finalWorker: 'haiku',
        firstRouteSuccess: success && !escalated, unverified: false, escalated,
        frontierUsed: false, failureReason: null,
      },
    });
  };
  record('a', 'laya', 14, true, false);
  record('b', 'laya', 18, true, true);
  record('c', 'jev', 190, true, false);

  const view = evaluatorView(store);
  const laya = view.find((row) => row.provider === 'laya');
  const jev = view.find((row) => row.provider === 'jev');

  assert.equal(laya.delegations, 2);
  assert.equal(laya.local, true, 'a local engine is marked local, for the privacy column');
  assert.equal(laya.escalation_rate, 0.5);
  assert.equal(laya.latency.median, 18);
  assert.equal(laya.latency.samples, 2);
  assert.equal(jev.local, false);
  assert.equal(jev.latency.median, 190);

  // Predicate agreement groups by node and reports the spread between engines.
  assert.deepEqual(predicateAgreement(store), []);
  assert.deepEqual(evaluatorsSeen(store).sort(), ['jev', 'laya']);
  store.close();
});

test('a database written before the rename opens and keeps its rows', () => {
  // Build a real version-1 database: the old table, the old columns, a row in it.
  const dir = tempDir();
  const file = path.join(dir, 'legacy.db');
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE dispatches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, attempt INTEGER NOT NULL,
      created_at INTEGER NOT NULL, session_id TEXT, router TEXT, routing_mode TEXT,
      policy_version TEXT, required_tier TEXT, selected_tier TEXT, selected_worker TEXT,
      worker_model TEXT, previous_tier TEXT, policy_reason TEXT, confidence REAL,
      probabilities TEXT, traversal_path TEXT, routing_latency_ms INTEGER,
      jev_latency_ms INTEGER, jev_input_tokens INTEGER DEFAULT 0,
      jev_output_tokens INTEGER DEFAULT 0, degraded INTEGER DEFAULT 0, router_error TEXT
    );
    INSERT INTO meta VALUES ('schema_version', '1');
    INSERT INTO dispatches (task_id, attempt, created_at, router, jev_latency_ms, jev_input_tokens)
      VALUES ('old-task', 1, 1000, 'policy-graph', 212, 280);
    INSERT INTO dispatches (task_id, attempt, created_at, router, jev_latency_ms, jev_input_tokens)
      VALUES ('old-direct', 1, 1000, 'jev-direct', 150, 190);
  `);
  legacy.close();

  const store = new TelemetryStore(testConfig(), file);

  const columns = store.query('PRAGMA table_info(dispatches)').map((row) => row.name);
  for (const added of ['evaluator_provider', 'evaluator_model', 'evaluator_latency_ms', 'evaluator_metadata']) {
    assert.ok(columns.includes(added), `${added} should have been added`);
  }
  // The version-1 columns are kept: dropping them would discard experiment results.
  for (const kept of ['jev_latency_ms', 'jev_input_tokens', 'jev_output_tokens']) {
    assert.ok(columns.includes(kept), `${kept} must not be dropped`);
  }
  assert.equal(store.queryOne("SELECT value FROM meta WHERE key = 'schema_version'").value, '3');

  // Rows written before the rename came from Jev; they are attributed rather
  // than left unattributed and uncomparable.
  const rows = store.query('SELECT task_id, evaluator_provider, evaluator_latency_ms, evaluator_input_tokens FROM dispatches ORDER BY task_id');
  assert.deepEqual(rows.map((row) => row.evaluator_provider), ['jev-direct', 'jev']);
  assert.deepEqual(rows.map((row) => row.evaluator_latency_ms), [150, 212]);
  assert.deepEqual(rows.map((row) => row.evaluator_input_tokens), [190, 280]);

  store.close();

  // Opening again is a no-op, not a second migration.
  const reopened = new TelemetryStore(testConfig(), file);
  assert.equal(reopened.query('SELECT * FROM dispatches').length, 2);
  reopened.close();
});
