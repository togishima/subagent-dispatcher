import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildClaudeArgs, workerEnv, extractUsage } from '../src/worker/run.mjs';
import { parseAgentFile, inlineAgentSpec } from '../src/worker/agent-defs.mjs';
import { normalizeWorkerOutput, buildWorkerPrompt } from '../src/worker/contract.mjs';
import { snapshotWorktree, diffSnapshots, resolveChangedFiles } from '../src/worker/changed-files.mjs';
import { workerForTier } from '../src/config/load.mjs';
import { testConfig, tempDir } from './helpers.mjs';

const config = testConfig();

test('a worker cannot recurse back into delegate', () => {
  const worker = workerForTier(config, 'low');
  const args = buildClaudeArgs(worker, 'prompt', '00000000-0000-4000-8000-000000000000');
  // No MCP servers reach the worker, and it has no Agent tool to spawn more.
  assert.ok(args.includes('--strict-mcp-config'));
  const disallowed = args[args.indexOf('--disallowedTools') + 1];
  for (const tool of ['Task', 'Agent', 'mcp__jev-dispatch__delegate', 'mcp__plugin_jev-dispatch_jev-dispatch__delegate']) {
    assert.ok(disallowed.includes(tool), `${tool} should be disallowed`);
  }
});

test('the worker runs the configured model, not whatever the frontmatter says', () => {
  const worker = { ...workerForTier(config, 'low'), model: 'some-other-model' };
  const args = buildClaudeArgs(worker, 'prompt', '00000000-0000-4000-8000-000000000000');
  assert.equal(args[args.indexOf('--model') + 1], 'some-other-model');
  const spec = JSON.parse(args[args.indexOf('--agents') + 1]);
  assert.equal(spec['low-worker'].model, 'some-other-model');
});

test('each worker gets its own session id, so runs never collide', () => {
  const worker = workerForTier(config, 'low');
  const a = buildClaudeArgs(worker, 'p', 'aaaaaaaa-0000-4000-8000-000000000000');
  const b = buildClaudeArgs(worker, 'p', 'bbbbbbbb-0000-4000-8000-000000000000');
  assert.notEqual(a[a.indexOf('--session-id') + 1], b[b.indexOf('--session-id') + 1]);
});

test('the router credential never reaches a worker', () => {
  const previous = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'secret-value';
  try {
    const env = workerEnv({ ...workerForTier(config, 'low'), passEnv: ['PATH', 'TYPESAFE_API_KEY'] }, config);
    assert.equal(env.TYPESAFE_API_KEY, undefined);
    assert.ok(env.PATH);
    assert.equal(env.CLAUDE_CODE_ENABLE_TELEMETRY, '0');
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  }
});

test('only allowlisted environment variables are passed through', () => {
  process.env.JEV_TEST_SECRET_THING = 'do-not-leak';
  try {
    const env = workerEnv(workerForTier(config, 'low'), config);
    assert.equal(env.JEV_TEST_SECRET_THING, undefined);
  } finally {
    delete process.env.JEV_TEST_SECRET_THING;
  }
});

test('all three bundled agents load and pin their tier model', () => {
  for (const [tier, model] of [['low', 'haiku'], ['medium', 'sonnet'], ['high', 'opus']]) {
    const worker = workerForTier(config, tier);
    const spec = inlineAgentSpec(worker);
    const name = `${tier}-worker`;
    assert.ok(spec[name], `${name} should load`);
    assert.equal(spec[name].model, model);
    assert.ok(spec[name].prompt.length > 500);
    // A worker must not be told how cheap it is, or it calibrates effort to price.
    assert.ok(!/\b(haiku|sonnet|opus|cheap|expensive|frontier model)\b/i.test(spec[name].prompt));
  }
});

test('agent frontmatter parses into fields and body', () => {
  const parsed = parseAgentFile('---\nname: x\nmodel: haiku\nmaxTurns: 20\nbackground: false\n---\n\nBody text here.');
  assert.deepEqual(parsed.frontmatter, { name: 'x', model: 'haiku', maxTurns: 20, background: false });
  assert.equal(parsed.body, 'Body text here.');
  assert.equal(parseAgentFile('no frontmatter').body, 'no frontmatter');
});

test('worker output is coerced to the contract even when ignored', () => {
  const good = normalizeWorkerOutput({ status: 'completed', summary: 's', evidence: ['e'], changedFiles: ['a.ts'] }, null);
  assert.equal(good.status, 'completed');
  assert.equal(good.schemaHonoured, true);

  const prose = normalizeWorkerOutput(null, 'I did the thing.');
  assert.equal(prose.status, 'completed');
  assert.equal(prose.schemaHonoured, false);

  const jsonInText = normalizeWorkerOutput(null, '{"status":"failed","summary":"nope","blockers":["x"]}');
  assert.equal(jsonInText.status, 'failed');
  assert.deepEqual(jsonInText.blockers, ['x']);

  const empty = normalizeWorkerOutput(null, '');
  assert.equal(empty.status, 'failed');

  const bogus = normalizeWorkerOutput({ status: 'made-up', summary: 5, evidence: 'not-an-array' }, null);
  assert.equal(bogus.status, 'failed');
  assert.deepEqual(bogus.evidence, []);
});

test('the worker prompt carries the subtask and never the tier', () => {
  const prompt = buildWorkerPrompt({
    task: 'do X',
    contextSummary: 'context here',
    contextFiles: ['a.ts'],
    expectedOutput: 'X is done',
    verification: { command: 'npm test' },
    attempt: 2,
    previousFeedback: 'it failed because Y',
  });
  for (const fragment of ['do X', 'context here', 'a.ts', 'X is done', 'npm test', 'it failed because Y']) {
    assert.ok(prompt.includes(fragment), fragment);
  }
  assert.ok(!/\b(low|medium|high)[- ]worker\b/i.test(prompt));
});

test('usage is read from the worker result, and missing usage is zero not NaN', () => {
  const usage = extractUsage({
    total_cost_usd: 0.05,
    num_turns: 4,
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
    modelUsage: { 'claude-haiku-4-5': {} },
  });
  assert.deepEqual(usage, {
    costUsd: 0.05, inputTokens: 10, outputTokens: 20,
    cacheReadTokens: 30, cacheCreationTokens: 40, numTurns: 4, models: ['claude-haiku-4-5'],
  });
  const empty = extractUsage(null);
  assert.equal(empty.costUsd, 0);
  assert.ok(Object.values(empty).every((value) => Array.isArray(value) || Number.isFinite(value)));
});

test('changed files come from git, not from the worker saying so', async () => {
  const dir = tempDir();
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '.');
  git('config', 'user.email', 't@e.x');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one');
  git('add', '-A');
  git('commit', '-qm', 'init');

  const before = await snapshotWorktree(dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'new');

  const resolved = await resolveChangedFiles({ cwd: dir, before, reported: ['lies.txt'] });
  assert.equal(resolved.source, 'git-worktree');
  assert.deepEqual(resolved.files, ['a.txt', 'b.txt']);
});

test('outside a repository the worker report is the only option', async () => {
  const dir = tempDir();
  const before = await snapshotWorktree(dir);
  assert.equal(before, null);
  const resolved = await resolveChangedFiles({ cwd: dir, before, reported: ['claimed.ts'] });
  assert.equal(resolved.source, 'worker-report');
  assert.deepEqual(resolved.files, ['claimed.ts']);
  assert.equal(diffSnapshots(null, null), null);
});
