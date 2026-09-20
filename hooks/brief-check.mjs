#!/usr/bin/env node
/**
 * Brief check: a PreToolUse hook on the delegate tool.
 *
 * The `delegate` skill explains how to write a brief, but a skill is only read
 * when the model decides to read one — and the call it would improve is exactly
 * the call that gets made without reading it. This hook fires on every delegate
 * call instead, and says what is missing at the moment it matters.
 *
 * It is a coach, not a gate. In `advise` (the default) the call always proceeds.
 * In `enforce` a thin brief is turned back once, with specific guidance, and the
 * next attempt at the same subtask goes through whatever it looks like — a hook
 * that can refuse the same work twice can trap a session, and no amount of
 * better briefs is worth that.
 *
 * A hook must never break a session, so every failure here exits 0 quietly.
 */
import { loadConfig } from '../src/config/load.mjs';
import { sha256 } from '../src/util/ids.mjs';
import {
  DELEGATE_TOOL, alreadyPrompted, guidanceFor, isThin, missingFromBrief,
} from '../src/contract/brief.mjs';

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text === '' ? {} : JSON.parse(text);
}

const emit = (fields) =>
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...fields } }));

const input = await readInput().catch(() => ({}));
if (!DELEGATE_TOOL.test(input.tool_name ?? '')) process.exit(0);

let mode = 'advise';
try {
  mode = loadConfig().contract?.briefCheck ?? 'advise';
} catch {
  // A broken config is the dispatcher's problem to report, not this hook's.
}
if (mode === 'off') process.exit(0);

const missing = missingFromBrief(input.tool_input ?? {});
if (!isThin(missing)) process.exit(0);

const guidance = guidanceFor(missing);

// A null below means the state is unavailable, and an unenforceable "once" is no
// "once" at all — so it degrades to advice rather than risking a repeated deny.
if (mode === 'enforce' && alreadyPrompted(sha256(String(input.tool_input?.task ?? ''))) === false) {
  emit({
    permissionDecision: 'deny',
    permissionDecisionReason: `${guidance}\n\nFill in what you can and call delegate again. If this subtask genuinely needs none of it, call it again unchanged and it will go through.`,
  });
  process.exit(0);
}

emit({ additionalContext: guidance });
process.exit(0);
