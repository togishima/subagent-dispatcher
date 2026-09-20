import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../util/paths.mjs';

/**
 * Judging how complete a delegation brief is.
 *
 * This is the logic behind the PreToolUse brief check, kept out of the hook
 * script so it can be imported and tested without the script's stdin read
 * running — a hook script is an entry point, not a library.
 */

export const SEEN_FILE = path.join(dataDir, 'brief-prompts.json');
const SEEN_TTL_MS = 60 * 60 * 1000;
const SEEN_MAX = 200;

export const DELEGATE_TOOL = /^mcp__.*jev.dispatch.*__delegate$/;

const nonEmpty = (value) =>
  typeof value === 'string' ? value.trim() !== '' : Array.isArray(value) && value.length > 0;

/** What a brief is missing, in the order it is worth supplying. */
export function missingFromBrief(input = {}) {
  const missing = [];
  if (!nonEmpty(input.plan) && !nonEmpty(input.planFiles)) {
    missing.push('`plan` — the steps you already worked out, or `planFiles` pointing at the plan document');
  }
  if (!nonEmpty(input.contextFiles)) {
    missing.push('`contextFiles` — the files the worker should change');
  }
  if (!nonEmpty(input.acceptanceCriteria) && !nonEmpty(input.expectedOutput)) {
    missing.push('`acceptanceCriteria` or `expectedOutput` — a checkable definition of done');
  }
  return missing;
}

/**
 * Thin enough to be worth mentioning. A caller who supplied two of the three has
 * clearly thought about it, and nagging them is noise.
 */
export const isThin = (missing) => missing.length >= 2;

export function guidanceFor(missing) {
  return (
    'This subtask is going to a worker that starts from nothing and cannot see this conversation. It is missing:\n' +
    missing.map((item) => `  - ${item}`).join('\n') +
    '\n\nYou have the context and have already decided the approach; the worker has neither. Supplying what you know turns this from work that has to be re-derived into work that can simply be carried out — which is faster, cheaper and likelier to come back right. The `delegate` skill has the procedure.'
  );
}

/**
 * Has this subtask already been turned back once? Returns null when the answer
 * cannot be established, which callers must treat as "do not deny".
 *
 * This deliberately never creates the state directory. The check runs in front of
 * every delegate call, and a recursive mkdir on a pathological path can block
 * indefinitely — stalling the very call it exists to improve. Somewhere else owns
 * creating that directory; if it is not there yet, the check simply advises.
 */
export function alreadyPrompted(key, file = SEEN_FILE) {
  try {
    if (!fs.existsSync(path.dirname(file))) return null;
    const now = Date.now();
    const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    const fresh = Object.fromEntries(
      Object.entries(raw).filter(([, at]) => now - at < SEEN_TTL_MS).slice(-SEEN_MAX),
    );
    const seen = Object.hasOwn(fresh, key);
    fresh[key] = now;
    fs.writeFileSync(file, JSON.stringify(fresh));
    return seen;
  } catch {
    return null;
  }
}
