/**
 * The structured result a worker returns. Workers are asked for this shape via
 * --json-schema, so the dispatcher never has to parse prose, and the main session
 * receives a summary rather than a transcript.
 */
export const WORKER_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: ['completed', 'failed', 'needs_clarification'],
      description:
        'completed: the subtask is done. failed: it was attempted but could not be finished. needs_clarification: the specification is ambiguous or contradictory and no attempt is sensible.',
    },
    summary: { type: 'string', description: 'What was done, in at most a few sentences.' },
    evidence: {
      type: 'array',
      items: { type: 'string' },
      description: 'Short factual citations: file:line references, command names, exact error text.',
    },
    changedFiles: { type: 'array', items: { type: 'string' }, description: 'Repository-relative paths written.' },
    commandsRun: { type: 'array', items: { type: 'string' }, description: 'Commands run to check the work.' },
    blockers: { type: 'array', items: { type: 'string' }, description: 'What prevented completion, if anything.' },
  },
  required: ['status', 'summary'],
  additionalProperties: false,
};

const asStringArray = (value, limit) =>
  (Array.isArray(value) ? value : [])
    .filter((item) => typeof item === 'string' && item.trim() !== '')
    .slice(0, limit)
    .map((item) => item.trim());

/**
 * Coerce whatever a worker produced into the contract. A worker that ignored the
 * schema must not crash a dispatch, so unparseable output becomes a failed result
 * carrying the raw text as its summary.
 */
export function normalizeWorkerOutput(structured, resultText) {
  const source = structured && typeof structured === 'object' ? structured : safeParse(resultText);
  if (!source) {
    const text = String(resultText ?? '').trim();
    return {
      status: text === '' ? 'failed' : 'completed',
      summary: text === '' ? 'Worker produced no output.' : text.slice(0, 2000),
      evidence: [],
      changedFiles: [],
      commandsRun: [],
      blockers: text === '' ? ['worker produced no output'] : [],
      schemaHonoured: false,
    };
  }
  const status = ['completed', 'failed', 'needs_clarification'].includes(source.status) ? source.status : 'failed';
  return {
    status,
    summary: typeof source.summary === 'string' ? source.summary.slice(0, 4000) : '',
    evidence: asStringArray(source.evidence, 20).map((item) => item.slice(0, 400)),
    changedFiles: asStringArray(source.changedFiles, 200),
    commandsRun: asStringArray(source.commandsRun, 40),
    blockers: asStringArray(source.blockers, 20).map((item) => item.slice(0, 400)),
    schemaHonoured: Boolean(structured),
  };
}

function safeParse(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The prompt a worker receives. Only what the subtask needs — never the main
 * conversation. The tier is not mentioned: a worker must not know whether it is
 * the cheap one, or it will calibrate its effort to its own price tag.
 */
export function buildWorkerPrompt(task) {
  const sections = [`# Subtask\n\n${task.task}`];
  if (task.contextSummary) sections.push(`# Context\n\n${task.contextSummary}`);
  if (task.contextFiles?.length) {
    sections.push(`# Relevant files\n\n${task.contextFiles.map((file) => `- ${file}`).join('\n')}`);
  }
  if (task.expectedOutput) sections.push(`# Expected output\n\n${task.expectedOutput}`);
  if (task.verification?.command) {
    sections.push(
      `# Verification\n\nYour work will be checked by running:\n\n    ${task.verification.command}\n\nRun it yourself before you report completion.`,
    );
  }
  if (task.attempt > 1 && task.previousFeedback) {
    sections.push(
      `# A previous attempt at this subtask did not pass\n\n${task.previousFeedback}\n\nDo not repeat the same approach. Diagnose why it failed before changing anything.`,
    );
  }
  return sections.join('\n\n');
}
