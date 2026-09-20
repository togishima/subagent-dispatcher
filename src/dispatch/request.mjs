import fs from 'node:fs';
import path from 'node:path';
import { log } from '../util/log.mjs';

/**
 * Normalising a delegation request.
 *
 * A worker starts from nothing, so how completely the subtask is specified is
 * the single biggest thing standing between it and a correct result. A cheap
 * worker following a concrete plan does mechanical work; the same worker given
 * a goal has to make design decisions, which is what capability actually buys.
 *
 * So specification is first-class here: a caller can hand over the plan it has
 * already worked out, the criteria the result must meet, the files to edit, the
 * files to imitate, and the things not to touch. Those are then routing inputs,
 * not just prompt filler — the policy graph reads them.
 */

/** Plan and spec text is the instruction, so it is inlined into the worker prompt. */
const MAX_DOCUMENT_CHARS = 24_000;
const MAX_DOCUMENTS_TOTAL_CHARS = 64_000;
const MAX_DOCUMENTS = 10;

const asStringArray = (value, limit = 50) =>
  (Array.isArray(value) ? value : value == null ? [] : [value])
    .filter((item) => typeof item === 'string' && item.trim() !== '')
    .slice(0, limit)
    .map((item) => item.trim());

const asText = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

/**
 * Read the plan documents a caller pointed at.
 *
 * Paths resolve inside the working directory and anything escaping it is
 * refused: a delegation should not be able to splice an arbitrary file of the
 * filesystem into a worker prompt, even though the caller could read it itself.
 */
export function loadPlanDocuments(planFiles, cwd) {
  const documents = [];
  const problems = [];
  let budget = MAX_DOCUMENTS_TOTAL_CHARS;

  for (const entry of asStringArray(planFiles, MAX_DOCUMENTS)) {
    const resolved = path.resolve(cwd, entry);
    if (!resolved.startsWith(path.resolve(cwd) + path.sep)) {
      problems.push(`${entry}: outside the working directory`);
      continue;
    }
    let text;
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) { problems.push(`${entry}: not a file`); continue; }
      text = fs.readFileSync(resolved, 'utf8');
    } catch (error) {
      problems.push(`${entry}: ${error.code ?? error.message}`);
      continue;
    }
    if (budget <= 0) { problems.push(`${entry}: skipped, document budget exhausted`); continue; }

    const limit = Math.min(MAX_DOCUMENT_CHARS, budget);
    const truncated = text.length > limit;
    const content = truncated ? `${text.slice(0, limit)}\n\n[… truncated]` : text;
    budget -= content.length;
    documents.push({ path: path.relative(cwd, resolved), content, truncated });
  }

  if (problems.length > 0) log.warn('some plan files could not be read', { problems });
  return { documents, problems };
}

/** Turn whatever the caller passed into the shape the rest of the dispatcher uses. */
export function normalizeRequest(request, cwd) {
  const { documents, problems } = loadPlanDocuments(request.planFiles, cwd);
  const plan = asText(request.plan);
  const acceptanceCriteria = asStringArray(request.acceptanceCriteria, 20);

  return {
    task: String(request.task).trim(),
    contextSummary: asText(request.context),
    plan,
    planDocuments: documents,
    planProblems: problems,
    acceptanceCriteria,
    constraints: asStringArray(request.constraints, 20),
    contextFiles: asStringArray(request.contextFiles, 100),
    referenceFiles: asStringArray(request.referenceFiles, 100),
    expectedOutput: asText(request.expectedOutput),
    taskType: asText(request.taskType),
    riskFlags: asStringArray(request.riskFlags, 20),
    verification: request.verification ?? null,
    cwd,
  };
}

/**
 * How completely this subtask was specified, as flags the policy graph and the
 * telemetry can both read. Presence is decided here, in code; whether what was
 * supplied is actually *good enough* is a semantic question, and stays one.
 */
export function specificationSignals(task) {
  const planChars = (task.plan?.length ?? 0) + task.planDocuments.reduce((sum, doc) => sum + doc.content.length, 0);
  return {
    hasPlan: Boolean(task.plan) || task.planDocuments.length > 0,
    planChars,
    planDocumentCount: task.planDocuments.length,
    hasAcceptanceCriteria: task.acceptanceCriteria.length > 0,
    acceptanceCriteriaCount: task.acceptanceCriteria.length,
    hasEditSites: task.contextFiles.length > 0,
    hasConstraints: task.constraints.length > 0,
    hasExpectedOutput: Boolean(task.expectedOutput),
  };
}
