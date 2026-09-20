import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { missingFromBrief, isThin, alreadyPrompted } from '../src/contract/brief.mjs';
import { tempDir } from './helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Run the hook as Claude Code would: JSON on stdin, JSON on stdout. */
function runHook(input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--experimental-sqlite', path.join(root, 'hooks/brief-check.mjs')], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('hook did not finish')); }, 20_000);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output: out.trim() === '' ? null : JSON.parse(out).hookSpecificOutput });
    });
    child.stdin.end(JSON.stringify(input));
  });
}

const delegateCall = (toolInput) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'mcp__plugin_jev-dispatch_jev-dispatch__delegate',
  tool_input: toolInput,
});

function enforceEnv(dir) {
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ contract: { briefCheck: 'enforce' } }));
  return { JEV_DISPATCH_DATA_DIR: dir, JEV_DISPATCH_CONFIG: path.join(dir, 'config.json') };
}

test('a brief is judged by what a worker would actually need', () => {
  assert.equal(missingFromBrief({ task: 'x' }).length, 3);
  assert.equal(missingFromBrief({ task: 'x', plan: '1. do it' }).length, 2);
  assert.equal(
    missingFromBrief({ task: 'x', planFiles: ['PLAN.md'], contextFiles: ['a.ts'], expectedOutput: 'y' }).length,
    0,
  );
  // Either form of each piece counts.
  assert.equal(missingFromBrief({ plan: 'p', contextFiles: ['a'], acceptanceCriteria: ['c'] }).length, 0);
  // Empty values are not values.
  assert.equal(missingFromBrief({ plan: '   ', contextFiles: [], acceptanceCriteria: [] }).length, 3);
});

test('a caller who supplied most of a brief is not nagged', () => {
  assert.equal(isThin(missingFromBrief({ task: 'x' })), true);
  assert.equal(isThin(missingFromBrief({ task: 'x', plan: 'p' })), true);
  assert.equal(isThin(missingFromBrief({ task: 'x', plan: 'p', contextFiles: ['a'] })), false);
});

test('advise mode always lets the call through', async () => {
  const dir = tempDir();
  const { output, code } = await runHook(delegateCall({ task: 'make the cache an LRU' }), {
    JEV_DISPATCH_DATA_DIR: dir,
  });
  assert.equal(code, 0);
  assert.equal(output.permissionDecision, undefined);
  assert.match(output.additionalContext, /cannot see this conversation/);
  assert.match(output.additionalContext, /`plan`/);
});

test('off mode says nothing at all', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ contract: { briefCheck: 'off' } }));
  const { output } = await runHook(delegateCall({ task: 'anything' }), {
    JEV_DISPATCH_DATA_DIR: dir,
    JEV_DISPATCH_CONFIG: path.join(dir, 'config.json'),
  });
  assert.equal(output, null);
});

test('a complete brief passes silently', async () => {
  const dir = tempDir();
  const { output } = await runHook(
    delegateCall({ task: 'x', plan: '1. do it', contextFiles: ['a.mjs'], acceptanceCriteria: ['y'] }),
    enforceEnv(dir),
  );
  assert.equal(output, null, 'a good brief should not be commented on');
});

test('the hook ignores tools that are not delegate', async () => {
  const dir = tempDir();
  const { output } = await runHook(
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
    enforceEnv(dir),
  );
  assert.equal(output, null);
});

test('enforce turns a thin brief back once, and never twice', async () => {
  const dir = tempDir();
  const env = enforceEnv(dir);
  const call = delegateCall({ task: 'make the cache an LRU' });

  const first = await runHook(call, env);
  assert.equal(first.output.permissionDecision, 'deny');
  assert.match(first.output.permissionDecisionReason, /call it again unchanged and it will go through/);

  // A hook that can refuse the same work twice can trap a session.
  for (const attempt of [2, 3]) {
    const again = await runHook(call, env);
    assert.equal(again.output.permissionDecision, undefined, `attempt ${attempt} must not deny`);
    assert.ok(again.output.additionalContext);
  }

  // A different subtask is still worth one prompt.
  const other = await runHook(delegateCall({ task: 'something else entirely' }), env);
  assert.equal(other.output.permissionDecision, 'deny');
});

test('enforce degrades to advice when its state cannot be kept', async () => {
  const dir = tempDir();
  const env = enforceEnv(dir);
  // Point the state at a directory that does not exist: an unenforceable "once"
  // is no "once" at all, so denying would risk repeating.
  const { output, code } = await runHook(delegateCall({ task: 'x' }), {
    ...env,
    JEV_DISPATCH_DATA_DIR: path.join(dir, 'absent', 'deeper'),
  });
  assert.equal(code, 0);
  assert.equal(output.permissionDecision, undefined);
  assert.ok(output.additionalContext);
});

test('the hook never creates its own state directory', () => {
  const dir = tempDir();
  const absent = path.join(dir, 'not-made-by-the-hook', 'state.json');
  assert.equal(alreadyPrompted('k', absent), null);
  assert.equal(fs.existsSync(path.dirname(absent)), false);
});

test('state tracking is a real once, and expires', () => {
  const dir = tempDir();
  const file = path.join(dir, 'state.json');
  assert.equal(alreadyPrompted('a', file), false);
  assert.equal(alreadyPrompted('a', file), true);
  assert.equal(alreadyPrompted('b', file), false);

  // An entry older than the window is forgotten, so a later session can prompt again.
  fs.writeFileSync(file, JSON.stringify({ a: Date.now() - 3 * 60 * 60 * 1000 }));
  assert.equal(alreadyPrompted('a', file), false);
});

test('malformed hook input is survived, not crashed on', async () => {
  const dir = tempDir();
  const child = spawn('node', ['--experimental-sqlite', path.join(root, 'hooks/brief-check.mjs')], {
    env: { ...process.env, JEV_DISPATCH_DATA_DIR: dir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end('this is not json');
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0);
});
