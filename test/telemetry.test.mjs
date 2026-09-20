import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sanitizeTitle, redactText, taskHash, rawTaskIfEnabled, safeFailureDetail } from '../src/telemetry/privacy.mjs';
import { parseMetrics } from '../src/telemetry/otlp.mjs';
import { TelemetryStore } from '../src/telemetry/store.mjs';
import { overview, policyComparison, cacheCostView, confidenceView, policyView } from '../src/telemetry/queries.mjs';
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
