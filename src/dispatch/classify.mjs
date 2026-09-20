import { VERDICT } from '../verify/index.mjs';

/**
 * Failure classification.
 *
 * Escalation is only sound if a failure is actually a capability failure. A
 * missing binary, an ambiguous spec, or a verifier that could not run are all
 * failures that a stronger model will not fix — escalating them just spends
 * frontier tokens on the same wall.
 */
export const FAILURE = {
  CAPABILITY: 'CAPABILITY_FAILURE',
  SPEC: 'SPEC_FAILURE',
  ENVIRONMENT: 'ENVIRONMENT_FAILURE',
  VERIFICATION: 'VERIFICATION_FAILURE',
  UNKNOWN: 'UNKNOWN',
};

const ENVIRONMENT_SIGNS = [
  /command not found/i,
  /ENOENT/,
  /EACCES/,
  /no such file or directory/i,
  /could not start "/i,
  /getaddrinfo|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i,
  /rate.?limit|overloaded|529|503/i,
  /exceeded its \d+ms time budget/i,
];

/**
 * Decide the outcome of one attempt: whether it succeeded, and if not, why.
 * Returns { success, failureReason, detail }.
 */
export function classifyAttempt({ execution, verification, config }) {
  const output = execution.output;

  // The process itself did not complete: infrastructure, not capability.
  if (execution.processError) {
    const environmental = ENVIRONMENT_SIGNS.some((sign) => sign.test(execution.processError));
    return {
      success: false,
      failureReason: environmental ? FAILURE.ENVIRONMENT : FAILURE.UNKNOWN,
      detail: execution.processError,
    };
  }
  if (execution.apiErrorStatus) {
    return { success: false, failureReason: FAILURE.ENVIRONMENT, detail: `model API error ${execution.apiErrorStatus}` };
  }

  // The worker says the specification is unusable. A stronger model reads the
  // same ambiguous spec, so this goes back to the caller instead of escalating.
  if (output.status === 'needs_clarification') {
    return {
      success: false,
      failureReason: FAILURE.SPEC,
      detail: output.blockers[0] ?? output.summary ?? 'worker asked for clarification',
    };
  }

  // The verifier could not run at all.
  if (verification.verdict === VERDICT.UNCERTAIN && verification.environmentProblem) {
    return { success: false, failureReason: FAILURE.ENVIRONMENT, detail: verification.reason };
  }

  if (verification.verdict === VERDICT.FAIL) {
    // A check failed. Whether or not the worker claimed success, a stronger
    // worker is the remedy, which is what makes FAIL the escalation trigger.
    return {
      success: false,
      failureReason: FAILURE.CAPABILITY,
      detail: verification.reason,
    };
  }

  // A deterministic check that passed outranks the worker's opinion of its own
  // work, including a worker that under-reports. This ordering matters: judging
  // a verified-good result by the self-report escalates work that was already
  // correct, which is the exact waste this project exists to measure. The
  // disagreement is still recorded, because a worker that habitually
  // under-reports is expensive in its own right.
  if (verification.verdict === VERDICT.PASS) {
    return {
      success: true,
      failureReason: null,
      detail: verification.reason,
      selfReportMismatch: output.status !== 'completed',
    };
  }

  if (output.status === 'failed') {
    const blocker = output.blockers.join(' ');
    if (ENVIRONMENT_SIGNS.some((sign) => sign.test(blocker))) {
      return { success: false, failureReason: FAILURE.ENVIRONMENT, detail: blocker.slice(0, 400) };
    }
    return {
      success: false,
      failureReason: FAILURE.CAPABILITY,
      detail: blocker.slice(0, 400) || output.summary?.slice(0, 400) || 'worker reported failure',
    };
  }

  // Worker claims completion and nothing could check it. Whether that counts is
  // an experiment parameter, not a truth: `uncertainCountsAsPass` decides.
  if (verification.verdict === VERDICT.UNCERTAIN || verification.verdict === VERDICT.SKIPPED) {
    if (config.escalation.uncertainCountsAsPass) {
      return { success: true, failureReason: null, detail: `unverified: ${verification.reason}`, unverified: true };
    }
    return { success: false, failureReason: FAILURE.VERIFICATION, detail: verification.reason };
  }

  return { success: false, failureReason: FAILURE.UNKNOWN, detail: 'unclassified outcome' };
}
