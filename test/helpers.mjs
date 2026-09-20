import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, deepMerge } from '../src/config/load.mjs';

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
    if (previous === undefined) delete process.env.JEV_DISPATCH_CONFIG;
    else process.env.JEV_DISPATCH_CONFIG = previous;
  }
}

/** Write an executable stub worker that prints a fixed JSON contract result. */
export function stubWorker(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}
