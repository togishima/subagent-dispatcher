#!/usr/bin/env node
/**
 * Telemetry hook. One script handles every event and dispatches on
 * `hook_event_name`, so the plugin registers one command rather than four.
 *
 * Hooks are the only place the plugin observes the main session: they record which
 * model the session is running (the cache-locality hypothesis depends on it not
 * changing) and any native subagent that ran without going through delegate().
 * Hooks carry no token or cost data — that comes from OTel and from each worker's
 * own result payload.
 *
 * A hook must never break a session, so every failure here exits 0 quietly.
 */
import { loadConfig } from '../src/config/load.mjs';
import { TelemetryStore } from '../src/telemetry/store.mjs';

const CONTRACT_NUDGE =
  'Delegable execution subtasks in this session go through the `delegate` tool rather than being done inline; read the delegation-contract skill before the first call.';

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text === '' ? {} : JSON.parse(text);
}

function emit(event, fields) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, ...fields } }));
}

const input = await readInput().catch(() => ({}));
const event = input.hook_event_name;

let store = null;
let config = null;
try {
  config = loadConfig();
  store = new TelemetryStore(config);

  switch (event) {
    case 'SessionStart':
      store.recordSessionStart({ sessionId: input.session_id, model: input.model, cwd: input.cwd });
      break;
    case 'SubagentStart':
    case 'SubagentStop':
      store.recordSubagentEvent({
        sessionId: input.session_id,
        agentId: input.agent_id,
        agentType: input.agent_type,
        event,
      });
      break;
    case 'SessionEnd':
      store.recordSessionEnd(input.session_id);
      break;
    default:
      break;
  }
} catch {
  // Telemetry is not worth a broken session.
} finally {
  store?.close();
}

// A one-time, ~40-token nudge at session start is the whole standing context cost
// of the contract; the skill body loads only when the model actually needs it.
if (event === 'SessionStart' && config?.contract?.sessionStartNudge !== false) {
  emit('SessionStart', { additionalContext: CONTRACT_NUDGE });
}
process.exit(0);
