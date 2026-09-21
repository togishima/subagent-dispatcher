import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers.mjs';

/**
 * Smoke tests for the CLI.
 *
 * Unit tests cover the modules the CLI calls, which is why a broken import in
 * `bin/jev-dispatch` once sat behind a fully green suite: nothing ever ran the
 * entry point. These do, for every subcommand that works without a network.
 */

const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'jev-dispatch');

function run(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--experimental-sqlite', bin, ...args], {
      env: { ...process.env, JEV_DISPATCH_DATA_DIR: tempDir(), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${args[0]} timed out`)); }, 60_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** Node prints an unhandled throw to stderr; a usage error does not look like that. */
const crashed = (result) => /\b(ReferenceError|TypeError|SyntaxError)\b/.test(result.stderr);

test('every offline subcommand runs without crashing', async () => {
  for (const args of [
    [], ['help'], ['policy'], ['predicates'], ['providers'], ['status'], ['compare'],
    ['config'], ['config', 'path'], ['export'], ['modes'], ['purge'],
  ]) {
    const result = await run(args);
    assert.equal(crashed(result), false, `${args.join(' ') || '(no args)'} crashed:\n${result.stderr.slice(0, 400)}`);
  }
});

test('the policy listing names every terminal branch it prints', async () => {
  // Reading an edge is not a crash when the key moved, so the smoke test above
  // stayed green while every terminating branch printed "undefined".
  const result = await run(['policy']);
  assert.equal(result.code, 0, result.stderr.slice(0, 400));
  assert.equal(/undefined/.test(result.stdout), false, result.stdout.slice(0, 400));
  assert.match(result.stdout, /(tier \w+|→ \w+)/);
});

test('doctor reports on a fresh install without a key', async () => {
  const result = await run(['doctor'], { TYPESAFE_API_KEY: '', CLAUDE_PLUGIN_OPTION_JEV_API_KEY: '' });
  assert.equal(crashed(result), false, result.stderr.slice(0, 400));
  assert.match(result.stdout, /provider typesafe/);
  assert.match(result.stdout, /no API key/);
  // It must say how to fix it, not merely that it is broken.
  assert.match(result.stdout, /\/plugin/);
  assert.equal(result.code, 1, 'a missing key is a problem, and doctor should exit non-zero');
});

test('doctor names where a key came from', async () => {
  const fromPrompt = await run(['doctor'], { CLAUDE_PLUGIN_OPTION_JEV_API_KEY: 'k', TYPESAFE_API_KEY: '' });
  assert.match(fromPrompt.stdout, /entered when enabling the plugin/);

  const fromEnv = await run(['doctor'], { TYPESAFE_API_KEY: 'k', CLAUDE_PLUGIN_OPTION_JEV_API_KEY: '' });
  assert.match(fromEnv.stdout, /TYPESAFE_API_KEY/);
});

test('providers lists each provider with its shape caveat', async () => {
  const result = await run(['providers']);
  for (const name of ['typesafe', 'cloudflare', 'vercel', 'passthrough', 'custom']) {
    assert.match(result.stdout, new RegExp(name));
  }
  assert.match(result.stdout, /not exercised against the service/);
});

test('check-router explains itself and fails cleanly with no key', async () => {
  const result = await run(['check-router'], { TYPESAFE_API_KEY: '', CLAUDE_PLUGIN_OPTION_JEV_API_KEY: '' });
  assert.equal(crashed(result), false, result.stderr.slice(0, 400));
  assert.match(result.stdout, /NOT SET/);
  assert.match(result.stderr, /FAILED/);
  assert.equal(result.code, 1);
});

test('an unknown subcommand exits non-zero with usage', async () => {
  const result = await run(['not-a-command']);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /jev-dispatch —/);
});

test('status is machine-readable', async () => {
  const result = await run(['status']);
  const stats = JSON.parse(result.stdout);
  assert.equal(stats.delegations, 0);
  assert.ok('firstRouteSuccessRate' in stats);
});
