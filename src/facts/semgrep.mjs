import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../util/log.mjs';

/**
 * Semgrep as a fact extractor.
 *
 * Semgrep is not a router and not a semantic evaluator: it runs once, before
 * routing, and turns whatever it matched into logical fact names the policy
 * graph can read. Nothing here is reachable from traversal — the CLI is spawned
 * in this module and nowhere else, so `traverse()` stays a pure loop.
 *
 * Semgrep is optional evidence. Missing binary, timeout, unparseable output or
 * a crash all mean *unknown*, never *true* and never a routing failure: the
 * dispatcher must route exactly as it did before whenever Semgrep cannot speak.
 */

/** Why a run produced no evidence. `ok` is the only status that carries facts. */
export const FACT_STATUS = {
  OK: 'ok',
  DISABLED: 'disabled',
  MISSING: 'missing',
  TIMEOUT: 'timeout',
  MALFORMED: 'malformed',
  ERROR: 'error',
};

/**
 * Semgrep JSON is read whole, so it cannot be tail-truncated the way a
 * verification log is — half a JSON document is garbage, not a shorter one. A
 * run that produces more than this is treated as unparseable instead.
 */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Cap on how many paths are passed as scan targets on the command line. */
const MAX_TARGETS = 100;

const asArray = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]);

const isFactName = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * The fact names a single Semgrep result stands for.
 *
 * Two sources, in order:
 *
 *   1. `facts.semgrep.ruleFacts` in configuration — an explicit id → fact
 *      mapping, for rules you cannot annotate.
 *   2. `metadata.dispatcher.fact` on the rule itself, which Semgrep echoes back
 *      under `extra.metadata`.
 *
 * Metadata is the one to reach for. The rule and the fact it means travel
 * together, and the name written in the rule is the name that arrives.
 *
 * `ruleFacts` is keyed on `check_id`, which is *not* the `id:` in the rule file:
 * Semgrep prefixes it with the rules file's directory path relative to the scan
 * directory (`.semgrep/rules.yml` → `semgrep.<id>`). A mapping written from the
 * rule file alone therefore never matches, and never says so — which is why it
 * is the fallback here rather than the recommended path. Matching on the raw id
 * instead is not a fix: it would make two rules of the same name in different
 * packs indistinguishable.
 *
 * Neither source is required: a match that maps to no fact is still counted but
 * contributes nothing to routing. What is deliberately *not* supported is a
 * policy naming a Semgrep rule id directly, which would couple routing policy
 * to a rule pack's internal names — and, given the above, to a file path.
 */
function factsForResult(result, ruleFacts) {
  const ruleId = result?.check_id;
  const configured = ruleId == null ? undefined : ruleFacts?.[ruleId];
  if (configured !== undefined) return asArray(configured).filter(isFactName).map((fact) => fact.trim());
  const declared = result?.extra?.metadata?.dispatcher?.fact;
  return asArray(declared).filter(isFactName).map((fact) => fact.trim());
}

/**
 * The paths to scan.
 *
 * Scanning a whole repository does not fit in a routing budget, and the files
 * the caller named are the ones the subtask is about — so those are the targets
 * when there are any, and the working directory only when there are none.
 * Paths that escape the working directory are dropped, as they are for plan
 * documents: a delegation must not be able to point a scanner outside its repo.
 */
export function scanTargets(contextFiles, cwd) {
  const root = path.resolve(cwd);
  const targets = [];
  for (const entry of asArray(contextFiles).slice(0, MAX_TARGETS)) {
    if (typeof entry !== 'string' || entry.trim() === '') continue;
    const resolved = path.resolve(root, entry);
    if (!resolved.startsWith(root + path.sep)) continue;
    if (!fs.existsSync(resolved)) continue;
    targets.push(resolved);
  }
  return targets.length > 0 ? targets : [root];
}

function outcome(status, { latencyMs = 0, error = null } = {}) {
  return { status, facts: [], matchCount: 0, latencyMs, error };
}

/**
 * Run Semgrep once and normalize what it found.
 *
 * Returns `{ status, facts, matchCount, latencyMs, error }`. `facts` is sorted
 * and deduplicated; raw findings, matched source lines and rule messages are
 * dropped here and never leave this function — the caller cannot leak what it
 * never receives.
 *
 * `spawn` is injectable so the unit tests can exercise every failure mode
 * without Semgrep installed.
 */
export function runSemgrep(options = {}, { spawn = nodeSpawn } = {}) {
  const {
    binary = 'semgrep',
    configPath,
    cwd = process.cwd(),
    targets = [cwd],
    timeoutMs = 10_000,
    ruleFacts = {},
    signal,
  } = options;

  const args = ['scan', '--json', '--quiet', '--metrics=off', '--disable-version-check'];
  if (configPath) args.push('--config', configPath);
  args.push(...targets);

  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      // No shell: the targets are caller-influenced paths, and a shell would
      // make them a command line.
      child = spawn(binary, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], signal });
    } catch (error) {
      resolve(outcome(FACT_STATUS.ERROR, { error: String(error?.message ?? error) }));
      return;
    }

    let stdout = '';
    let overflowed = false;
    let timedOut = false;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish(outcome(FACT_STATUS.TIMEOUT, { latencyMs: Date.now() - started }));
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      if (overflowed) return;
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_BYTES) {
        overflowed = true;
        stdout = '';
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    });
    // stderr is drained and discarded: it carries rule messages and source
    // excerpts, which must not reach telemetry or the routing state.
    child.stderr?.on('data', () => {});

    child.on('error', (error) => {
      const missing = error?.code === 'ENOENT';
      finish(outcome(missing ? FACT_STATUS.MISSING : FACT_STATUS.ERROR, {
        latencyMs: Date.now() - started,
        error: String(error?.message ?? error),
      }));
    });

    child.on('close', (code) => {
      if (timedOut) return;
      const latencyMs = Date.now() - started;
      // Semgrep's exit code is 0 for no findings and 1 for findings; anything
      // from 2 up means the run itself went wrong — a missing rules file, an
      // invalid config, a bad pattern. Those still print a well-formed JSON
      // document with an empty results array, so trusting the parse alone would
      // report a broken installation as a clean scan, which is exactly the
      // collapse of "unavailable" into "no match" this layer must not make.
      if (code >= 2) {
        finish(outcome(FACT_STATUS.ERROR, { latencyMs, error: `semgrep exited ${code}` }));
        return;
      }
      if (overflowed) {
        finish(outcome(FACT_STATUS.MALFORMED, { latencyMs, error: 'semgrep output exceeded the size limit' }));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        finish(outcome(FACT_STATUS.MALFORMED, { latencyMs, error: 'semgrep output was not JSON' }));
        return;
      }
      if (!Array.isArray(parsed?.results)) {
        finish(outcome(FACT_STATUS.MALFORMED, { latencyMs, error: 'semgrep output had no results array' }));
        return;
      }

      // 0 and 1 are both successful runs: whether Semgrep found anything is not
      // the question, only whether it was able to look.
      const facts = new Set();
      for (const result of parsed.results) {
        for (const fact of factsForResult(result, ruleFacts)) facts.add(fact);
      }
      finish({
        status: FACT_STATUS.OK,
        facts: [...facts].sort(),
        matchCount: parsed.results.length,
        latencyMs,
        error: null,
      });
    });
  }).then((result) => {
    if (result.status !== FACT_STATUS.OK) {
      log.debug('semgrep produced no facts', { status: result.status, error: result.error });
    }
    return result;
  });
}
