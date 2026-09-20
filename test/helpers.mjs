import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, deepMerge } from '../src/config/load.mjs';
import { PROVIDERS } from '../src/router/providers.mjs';

/**
 * Cut the suite off from the developer's own machine.
 *
 * A real ~/.jev-dispatch/config.yaml used to be loaded by `testConfig`, which
 * silently repointed the tests at whatever provider that config names. The
 * failures were bewildering — a dozen unrelated assertions — and one of them
 * printed the live API key of the substituted provider into the test output,
 * because the key a test plants is only honoured while the expected provider
 * is in play. So: no user config, and no real key in the environment.
 */
for (const provider of Object.values(PROVIDERS)) delete process.env[provider.apiKeyEnv];

/**
 * A config path that cannot exist. Pointing JEV_DISPATCH_CONFIG at it is what
 * keeps ~/.jev-dispatch/config.yaml out of the run: the loader takes this as
 * the sole candidate, so only the shipped defaults apply. Set on the process
 * rather than around each call, because the CLI tests spawn children that
 * inherit the environment and would otherwise read the real file themselves.
 */
const NO_USER_CONFIG = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'jev-no-config-')),
  'absent.json',
);
process.env.JEV_DISPATCH_CONFIG = NO_USER_CONFIG;

/** A temp directory that cleans itself up when the test process exits. */
export function tempDir(prefix = 'jev-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.on('exit', () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  return dir;
}

/** The shipped defaults with an override applied, validated as real config would be. */
export function testConfig(overrides = {}) {
  const base = loadConfig({ reload: true });
  const { $sources, $configDir, ...clean } = base;
  const merged = deepMerge(clean, overrides);
  // Round-trip through the loader so overrides go through validation too.
  const dir = tempDir();
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(merged));
  const previous = process.env.JEV_DISPATCH_CONFIG;
  process.env.JEV_DISPATCH_CONFIG = file;
  try {
    return loadConfig({ reload: true });
  } finally {
    process.env.JEV_DISPATCH_CONFIG = previous ?? NO_USER_CONFIG;
  }
}

/** Write an executable stub worker that prints a fixed JSON contract result. */
export function stubWorker(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}
