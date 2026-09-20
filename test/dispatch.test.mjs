import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Dispatcher } from '../src/dispatch/orchestrate.mjs';
import { classifyAttempt, FAILURE } from '../src/dispatch/classify.mjs';
import { VERDICT, verify, applicableChecks, checkApplies } from '../src/verify/index.mjs';
import { TelemetryStore } from '../src/telemetry/store.mjs';
import { testConfig, tempDir, stubWorker } from './helpers.mjs';

const attempt = (overrides = {}) => ({
  execution: {
    processError: null,
    apiErrorStatus: null,
    output: { status: 'completed', blockers: [], summary: '', changedFiles: [] },
    ...overrides.execution,
  },
  verification: { verdict: VERDICT.PASS, reason: 'ok', checks: [], ...overrides.verification },
  config: testConfig(overrides.config ?? {}),
});

test('a passing check is success', () => {
  const result = classifyAttempt(attempt());
  assert.equal(result.success, true);
  assert.equal(result.failureReason, null);
});

test('a failing check is a capability failure, which is what escalation acts on', () => {
  const result = classifyAttempt(attempt({ verification: { verdict: VERDICT.FAIL, reason: 'tests failed' } }));
  assert.equal(result.success, false);
  assert.equal(result.failureReason, FAILURE.CAPABILITY);
});

test('infrastructure problems are not capability failures', () => {
  for (const message of [
    'could not start "claude": spawn ENOENT',
    'npm: command not found',
    'getaddrinfo ENOTFOUND api.example.com',
    'worker exceeded its 900000ms time budget',
  ]) {
    const result = classifyAttempt(attempt({ execution: { processError: message } }));
    assert.equal(result.failureReason, FAILURE.ENVIRONMENT, message);
  }
  assert.equal(
    classifyAttempt(attempt({ execution: { apiErrorStatus: 529 } })).failureReason,
    FAILURE.ENVIRONMENT,
  );
});

test('an unusable specification does not escalate', () => {
  const result = classifyAttempt(
    attempt({ execution: { output: { status: 'needs_clarification', blockers: ['which endpoint?'], changedFiles: [] } } }),
  );
  assert.equal(result.failureReason, FAILURE.SPEC);
  assert.equal(result.detail, 'which endpoint?');
});

test('a verifier that could not run is an environment problem, not evidence of a bad result', () => {
  const result = classifyAttempt(
    attempt({ verification: { verdict: VERDICT.UNCERTAIN, reason: 'command not found', environmentProblem: true } }),
  );
  assert.equal(result.failureReason, FAILURE.ENVIRONMENT);
});

test('whether an unverified pass counts is an experiment parameter', () => {
  const unverified = { verification: { verdict: VERDICT.UNCERTAIN, reason: 'no check applies' } };
  assert.equal(classifyAttempt(attempt({ ...unverified, config: { escalation: { uncertainCountsAsPass: true } } })).success, true);
  const strict = classifyAttempt(attempt({ ...unverified, config: { escalation: { uncertainCountsAsPass: false } } }));
  assert.equal(strict.success, false);
  assert.equal(strict.failureReason, FAILURE.VERIFICATION);
});

test('verification checks apply conditionally', () => {
  const check = { name: 'ts', command: 'tsc', when: { changedFilesMatch: '\\.ts$' } };
  assert.equal(checkApplies(check, { changedFiles: ['src/a.ts'] }), true);
  assert.equal(checkApplies(check, { changedFiles: ['README.md'] }), false);
  assert.equal(checkApplies({ name: 'x', command: 'y' }, {}), true);
  assert.equal(checkApplies({ name: 'x', command: 'y', when: { taskTypeIn: ['test'] } }, { taskType: 'docs' }), false);
});

test('a caller-supplied verification command is ignored unless the operator allows it', () => {
  const task = { verification: { command: 'echo pwned' }, cwd: process.cwd() };
  assert.equal(applicableChecks(testConfig(), task).length, 0);
  const permissive = testConfig({ verification: { allowInlineCommands: true } });
  assert.equal(applicableChecks(permissive, task).length, 1);
});

test('verification distinguishes a failing check from a missing one', async () => {
  const dir = tempDir();
  const failing = testConfig({ verification: { checks: [{ name: 'fail', command: 'exit 3' }] } });
  const missing = testConfig({ verification: { checks: [{ name: 'gone', command: 'definitely-not-a-real-binary-xyz' }] } });

  const failed = await verify(failing, { cwd: dir });
  assert.equal(failed.verdict, VERDICT.FAIL);

  const unrunnable = await verify(missing, { cwd: dir });
  assert.equal(unrunnable.verdict, VERDICT.UNCERTAIN);
  assert.equal(unrunnable.environmentProblem, true);

  const none = await verify(testConfig(), { cwd: dir });
  assert.equal(none.verdict, VERDICT.UNCERTAIN);

  const off = await verify(testConfig({ verification: { enabled: false } }), { cwd: dir });
  assert.equal(off.verdict, VERDICT.SKIPPED);
});

// --- the escalation loop, driven by stub command workers so no model is called

function escalationConfig(dir, { lowSucceeds = false, mediumSucceeds = true } = {}) {
  const marker = path.join(dir, 'marker');
  const emit = (ok) =>
    `const fs=require('fs');fs.appendFileSync(${JSON.stringify(marker)}, process.env.JEV_WORKER_NAME+"\\n");` +
    `process.stdout.write(JSON.stringify({status:${ok ? '"completed"' : '"failed"'},summary:"stub",blockers:${ok ? '[]' : '["did not work"]'}}));`;
  stubWorker(dir, 'low.js', emit(lowSucceeds));
  stubWorker(dir, 'medium.js', emit(mediumSucceeds));
  stubWorker(dir, 'high.js', emit(true));

  // The check passes only once a worker has written the success file.
  const successFile = path.join(dir, 'done');
  return {
    marker,
    successFile,
    config: testConfig({
      routing: { mode: 'fixed', fixedTier: 'low' },
      workers: {
        haiku: { kind: 'command', command: ['node', path.join(dir, 'low.js')], frontier: false },
        sonnet: { kind: 'command', command: ['node', path.join(dir, 'medium.js')], frontier: false },
        opus: { kind: 'command', command: ['node', path.join(dir, 'high.js')], frontier: true },
      },
      workerDefaults: { passEnv: ['PATH', 'HOME', 'JEV_WORKER_NAME'], timeoutMs: 20000 },
      verification: { checks: [{ name: 'done', command: `test -f ${successFile}` }] },
      telemetry: { dbPath: path.join(dir, 'telemetry.db') },
    }),
  };
}

test('a failing cheap worker escalates to the next tier and stops when it passes', async () => {
  const dir = tempDir();
  const { config, successFile } = escalationConfig(dir);
  // The medium stub creates the file the check looks for; the low stub does not.
  fs.writeFileSync(
    path.join(dir, 'medium.js'),
    `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(successFile)},'ok');` +
      `process.stdout.write(JSON.stringify({status:"completed",summary:"fixed it",evidence:["did the thing"]}));\n`,
  );
  fs.chmodSync(path.join(dir, 'medium.js'), 0o755);

  const store = new TelemetryStore(config, path.join(dir, 'telemetry.db'));
  const result = await new Dispatcher(config, store).delegate({ task: 'do the thing', cwd: dir });

  assert.equal(result.status, 'completed');
  assert.equal(result.attempts, 2);
  assert.equal(result.escalated, true);
  assert.equal(result.verification.verdict, VERDICT.PASS);

  const escalations = store.query('SELECT from_tier, to_tier, reason FROM escalations');
  assert.deepEqual(escalations.map((row) => [row.from_tier, row.to_tier, row.reason]), [
    ['low', 'medium', FAILURE.CAPABILITY],
  ]);
  const executions = store.query('SELECT attempt, tier, success FROM executions ORDER BY attempt');
  assert.deepEqual(executions.map((row) => [row.attempt, row.tier, row.success]), [[1, 'low', 0], [2, 'medium', 1]]);

  const delegation = store.queryOne('SELECT * FROM delegations');
  assert.equal(delegation.first_route_success, 0);
  assert.equal(delegation.escalated, 1);
  assert.equal(delegation.frontier_used, 0);
  assert.equal(delegation.final_tier, 'medium');
  store.close();
});

test('the retry budget is finite even when every tier fails', async () => {
  const dir = tempDir();
  const { config } = escalationConfig(dir, { mediumSucceeds: false });
  const store = new TelemetryStore(config, path.join(dir, 'telemetry.db'));
  const result = await new Dispatcher(config, store).delegate({ task: 'impossible', cwd: dir });

  assert.equal(result.status, 'failed');
  assert.ok(result.attempts <= config.escalation.maxAttemptsPerTask);
  assert.equal(result.failureReason, FAILURE.CAPABILITY);

  const tiers = store.query('SELECT tier FROM executions ORDER BY attempt').map((row) => row.tier);
  assert.deepEqual(tiers, ['low', 'medium', 'high']);
  assert.equal(store.queryOne('SELECT frontier_used FROM delegations').frontier_used, 1);
  store.close();
});

test('escalation is disabled by configuration, not by luck', async () => {
  const dir = tempDir();
  const { config: base } = escalationConfig(dir);
  const config = testConfig({
    ...JSON.parse(JSON.stringify({ routing: base.routing, workers: base.workers, workerDefaults: base.workerDefaults, verification: base.verification })),
    escalation: { enabled: false },
  });
  const store = new TelemetryStore(config, path.join(dir, 'no-escalation.db'));
  const result = await new Dispatcher(config, store).delegate({ task: 'do the thing', cwd: dir });
  assert.equal(result.attempts, 1);
  assert.equal(result.escalated, false);
  store.close();
});
