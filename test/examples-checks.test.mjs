import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * The example checks are documentation that runs, so the part worth testing is
 * the part that is easy to get wrong: what they do where they do not apply.
 *
 * Only the 127 path is exercised. Running their positive path would mean this
 * suite invoking itself through npm, or requiring cargo and pytest on the
 * machine — the opposite of what these tests are for.
 */

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'checks');
const scripts = ['git-hygiene.sh', 'node-tests.sh', 'python-tests.sh', 'rust-tests.sh'];

test('an example check that does not apply exits 127, and so is not evidence', () => {
  // An empty directory: no repository, no package.json, no Cargo.toml, no tests.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-checks-'));
  try {
    for (const name of scripts) {
      const result = spawnSync(path.join(dir, name), { cwd: empty, encoding: 'utf8' });
      assert.equal(result.status, 127, `${name} judged an empty directory instead of standing down`);
    }
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('the example checks are executable', () => {
  for (const name of scripts) {
    const mode = fs.statSync(path.join(dir, name)).mode;
    assert.ok(mode & 0o111, `${name} is not executable, so it would exit 127 everywhere`);
  }
});
