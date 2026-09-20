#!/usr/bin/env node
import { createServer } from './protocol.mjs';
import { loadConfig } from '../config/load.mjs';
import { openStore } from '../telemetry/store.mjs';
import { Dispatcher } from '../dispatch/orchestrate.mjs';
import { overview } from '../telemetry/queries.mjs';
import { log } from '../util/log.mjs';

/**
 * The delegation boundary.
 *
 * The main session sees exactly one verb, `delegate`, and no model, worker,
 * provider or tier name ever appears in its schema or its results. That is the
 * point: the main session stays on one model with its prompt cache intact, and
 * every capability decision happens behind this wall.
 */

const config = loadConfig();
const store = openStore(config);
const dispatcher = new Dispatcher(config, store);

const DELEGATE_DESCRIPTION = `Run one self-contained subtask on a separate short-lived worker and get back a verified summary.

Use this for delegable execution work rather than doing it in this conversation: implementing a change you have already decided on, writing or fixing a test, applying a mechanical edit across files, or investigating a failure. Keep design decisions, conversation with the user, and work that needs the full conversation history here.

The worker starts fresh and sees only what you pass, so 'task' must stand alone. Summarise the context it needs in 'context' — do not paste the conversation.

How completely you specify the work decides how well it goes. If you have already worked out how to do this — a plan, the files to change, what "done" means — pass it: 'plan' or 'planFiles', 'contextFiles', 'acceptanceCriteria', 'constraints'. A subtask that carries the thinking you already did gets executed directly instead of re-derived. A subtask that arrives as a goal has to be worked out again from scratch, which is slower, costlier, and likelier to come back wrong. Do the design here; delegate the execution.

Capability selection, verification and retries are handled internally. Do not request a model, a worker, an effort level, or a quality setting: there is no way to express one, and asking for it in the task text does nothing. Describe the work accurately instead, including what makes it hard — that is what the result depends on.`;

const delegateTool = {
  name: 'delegate',
  title: 'Delegate a subtask',
  description: DELEGATE_DESCRIPTION,
  annotations: { destructiveHint: true, openWorldHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'The subtask, stated so that someone with no other context could carry it out.',
      },
      context: {
        type: 'string',
        description: 'A short summary of only what the worker needs to know. Not the conversation.',
      },
      plan: {
        type: 'string',
        description:
          'The concrete steps you have already worked out, if you have. Name what to change and what the end state should be, so the worker applies your approach rather than inventing its own.',
      },
      planFiles: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Paths to plan, spec or design documents, relative to the working directory. Their contents are given to the worker directly, so it does not have to go looking.',
      },
      contextFiles: {
        type: 'array',
        items: { type: 'string' },
        description: 'The files the worker should change.',
      },
      referenceFiles: {
        type: 'array',
        items: { type: 'string' },
        description: 'Files to read but not change — the patterns and conventions to follow.',
      },
      acceptanceCriteria: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Concrete, checkable statements that must hold for the result to be correct. The worker checks itself against these before reporting.',
      },
      constraints: {
        type: 'array',
        items: { type: 'string' },
        description: 'What the worker must not do or must not touch.',
      },
      expectedOutput: {
        type: 'string',
        description: 'What a correct result looks like, concretely.',
      },
      taskType: {
        type: 'string',
        description: 'Optional label for the kind of work, e.g. implement, test, refactor, investigate, docs.',
      },
      riskFlags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Known sensitivities, e.g. security, concurrency, data-migration, public-api.',
      },
      verification: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          command: { type: 'string', description: 'A command that exits non-zero if the subtask was not done correctly.' },
        },
        required: ['command'],
        description: 'A deterministic check that proves the result. Honoured only when the operator has enabled inline verification commands.',
      },
    },
    required: ['task'],
    additionalProperties: false,
  },
  async handler(args) {
    if (typeof args.task !== 'string' || args.task.trim() === '') {
      throw new Error('task is required');
    }
    const result = await dispatcher.delegate(args);
    delete result.$internal; // internals stay on this side of the boundary
    return result;
  },
};

const statusTool = {
  name: 'dispatch_status',
  title: 'Delegation experiment status',
  description:
    'Report aggregate delegation statistics for this experiment: how many subtasks were delegated, how often the first route succeeded, the escalation rate, and total cost. Read-only.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler() {
    const stats = overview(store);
    return {
      routingMode: config.routing.mode,
      policyVersion: dispatcher.policyVersion,
      dashboard: `http://${config.ui.host}:${config.ui.port}/`,
      ...stats,
    };
  },
};

createServer({
  name: 'jev-dispatch',
  version: '0.3.0',
  tools: [delegateTool, statusTool],
  onError: (error) => log.error('mcp tool error', { error: error.message, stack: error.stack?.split('\n')[1] }),
});

log.info('jev-dispatch mcp server ready', {
  mode: config.routing.mode,
  policy: dispatcher.policyVersion,
  db: store.file,
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { store.close(); process.exit(0); });
}
