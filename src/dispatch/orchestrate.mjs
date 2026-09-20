import { createRouter } from '../router/index.mjs';
import { resolveDispatch, nextTierForEscalation } from '../router/tier-policy.mjs';
import { runWorker } from '../worker/run.mjs';
import { verify, applicableChecks, summarizeVerification, failureExcerpt, VERDICT } from '../verify/index.mjs';
import { classifyAttempt, FAILURE } from './classify.mjs';
import { normalizeRequest, specificationSignals } from './request.mjs';
import { newId } from '../util/ids.mjs';
import { log } from '../util/log.mjs';

/**
 * The delegation loop: route, run, verify, and escalate under a fixed budget.
 *
 * This is where the experiment's policy lives, and it is deliberately ordinary
 * deterministic code — no model decides whether to retry. The main session sees
 * none of it: it calls delegate() once and gets one summary back.
 */

export class Dispatcher {
  constructor(config, store) {
    this.config = config;
    this.store = store;
    this.router = createRouter(config);
  }

  get policyVersion() {
    return this.router.policy?.version ?? null;
  }

  async delegate(request) {
    const taskId = request.taskId ?? newId();
    const sessionId = request.sessionId ?? process.env.CLAUDE_CODE_SESSION_ID ?? null;
    const cwd = request.cwd ?? process.cwd();

    const task = normalizeRequest(request, cwd);

    // How completely the caller specified the work, and whether anything can
    // check the result, are both routing inputs — so both are computed before
    // the first route rather than discovered after a worker has run.
    const specification = specificationSignals(task);
    const checks = applicableChecks(this.config, task);
    const verificationAvailable = checks.length > 0;

    this.store?.openDelegation({
      taskId, sessionId, task: task.task, taskType: task.taskType, specification, verificationAvailable,
    });

    const maxAttempts = Math.max(1, this.config.escalation.maxAttemptsPerTask);
    const attempts = [];
    let escalatedTo = null;
    let sameTierRetries = 0;
    let previous = null;
    let escalated = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const routingInput = {
        ...task,
        specification,
        verificationAvailable,
        attempt,
        previousTier: previous?.tier ?? null,
        previousFailureReason: previous?.failureReason ?? null,
        previousVerification: previous?.verdict ?? null,
        tierOrders: Object.fromEntries(Object.entries(this.config.tiers).map(([name, tier]) => [name, tier.order])),
        previousTierOrder: previous ? this.config.tiers[previous.tier]?.order : null,
        signal: request.signal,
      };

      const decision = await this.router.route(routingInput);
      const resolved = resolveDispatch(this.config, decision, { escalatedTo });
      const dispatchId = this.store?.recordDispatch({
        taskId, attempt, sessionId, decision, resolved, previousTier: previous?.tier ?? null,
      });

      log.info('dispatching', {
        taskId, attempt, tier: resolved.selectedTier, worker: resolved.worker.name,
        reason: resolved.policyReason, confidence: decision.confidence,
      });

      const execution = await runWorker({
        worker: resolved.worker,
        task: { ...task, attempt, previousFeedback: previous?.feedback ?? null },
        config: this.config,
        checks,
      });

      const verification = await verify(this.config, {
        ...task,
        changedFiles: execution.output.changedFiles,
      });
      const outcome = classifyAttempt({ execution, verification, config: this.config });

      this.store?.recordExecution({
        taskId, attempt, dispatchId, tier: resolved.selectedTier, execution, verification, outcome,
      });

      attempts.push({
        attempt,
        tier: resolved.selectedTier,
        requiredTier: decision.requiredTier,
        worker: resolved.worker.name,
        frontier: Boolean(resolved.worker.frontier),
        durationMs: execution.durationMs,
        cost: execution.usage.costUsd,
        verdict: verification.verdict,
        outcome,
        output: execution.output,
        decision,
      });

      if (outcome.success) {
        return this.#finish({ taskId, attempts, escalated, status: 'completed', outcome, verification, specification, planProblems: task.planProblems });
      }

      const reason = outcome.failureReason;
      const canEscalate =
        this.config.escalation.enabled &&
        this.config.escalation.escalateOn.includes(reason) &&
        attempt < maxAttempts;
      const canRetrySameTier =
        this.config.escalation.retrySameTierOn.includes(reason) &&
        sameTierRetries < this.config.escalation.maxSameTierRetries &&
        attempt < maxAttempts;

      previous = {
        tier: resolved.selectedTier,
        failureReason: reason,
        verdict: verification.verdict,
        feedback: this.#feedback(execution, verification, outcome),
      };

      if (canEscalate) {
        const next = nextTierForEscalation(this.config, resolved.selectedTier);
        if (!next) {
          // Already at the strongest tier: a stronger worker is not available, so
          // retrying would only repeat the same failure at the same price.
          return this.#finish({ taskId, attempts, escalated, status: 'failed', outcome, verification, specification, planProblems: task.planProblems });
        }
        escalatedTo = next;
        escalated = true;
        sameTierRetries = 0;
        this.store?.recordEscalation({
          taskId, fromTier: resolved.selectedTier, toTier: next, reason, attempt,
          policyVersion: this.policyVersion,
        });
        log.info('escalating', { taskId, from: resolved.selectedTier, to: next, reason });
        continue;
      }

      if (canRetrySameTier) {
        sameTierRetries += 1;
        log.info('retrying at same tier', { taskId, tier: resolved.selectedTier, reason });
        continue;
      }

      const status = reason === FAILURE.SPEC ? 'needs_clarification' : 'failed';
      return this.#finish({ taskId, attempts, escalated, status, outcome, verification, specification, planProblems: task.planProblems });
    }

    const last = attempts[attempts.length - 1];
    return this.#finish({
      taskId, attempts, escalated, status: 'failed',
      outcome: last?.outcome ?? { failureReason: FAILURE.UNKNOWN, detail: 'retry budget exhausted' },
      verification: { verdict: VERDICT.UNCERTAIN, reason: 'retry budget exhausted', checks: [] },
      specification, planProblems: task.planProblems,
    });
  }

  /** Feedback for the next attempt: the verifier's own words, never a pep talk. */
  #feedback(execution, verification, outcome) {
    const parts = [];
    if (outcome.failureReason) parts.push(`Classified as ${outcome.failureReason}.`);
    if (outcome.detail) parts.push(outcome.detail);
    const excerpt = failureExcerpt(verification);
    if (excerpt) parts.push(`\nVerification output:\n${excerpt}`);
    if (execution.output.blockers.length > 0) {
      parts.push(`\nThe previous attempt reported: ${execution.output.blockers.join('; ')}`);
    }
    return parts.join('\n');
  }

  #finish({ taskId, attempts, escalated, status, outcome, verification, specification, planProblems }) {
    const last = attempts[attempts.length - 1];
    const success = status === 'completed';
    const summary = {
      status,
      success,
      finalTier: last?.tier ?? null,
      finalWorker: last?.worker ?? null,
      firstRouteSuccess: success && attempts.length === 1,
      unverified: Boolean(outcome?.unverified),
      escalated,
      frontierUsed: attempts.some((entry) => entry.frontier),
      failureReason: success ? null : outcome?.failureReason ?? null,
    };
    this.store?.closeDelegation({ taskId, summary });

    // Under-specification is the caller's to fix, and the only one who can. Say
    // so when it plausibly cost something — without naming a tier or a model,
    // which would put the choice back in the caller's hands.
    const hint = specificationHint({ specification, attempts, status, planProblems });

    // What crosses back into the main session: a summary and evidence, not a
    // transcript, and no model or tier name anywhere.
    return {
      taskId,
      status,
      summary: last?.output.summary ?? 'No worker output.',
      evidence: last?.output.evidence ?? [],
      changedFiles: last?.output.changedFiles ?? [],
      verification: {
        verdict: verification.verdict,
        reason: verification.reason,
        checks: summarizeVerification(verification).checks,
      },
      blockers: last?.output.blockers ?? [],
      attempts: attempts.length,
      escalated,
      needsClarification: status === 'needs_clarification',
      failureReason: summary.failureReason,
      ...(hint ? { hint } : {}),
      $internal: { summary, attempts },
    };
  }
}

/**
 * Feedback the caller can act on.
 *
 * A subtask that arrived as a goal rather than a brief needs someone to make
 * the decisions, and that costs more than executing a plan does. Only the
 * caller can fix that, so it is worth saying — but without naming a tier or a
 * model, which would hand the capability choice back to the caller and undo the
 * whole boundary.
 */
export function specificationHint({ specification, attempts, status, planProblems }) {
  const notes = [];

  if (planProblems?.length > 0) {
    notes.push(`Some plan files could not be read and were left out: ${planProblems.join('; ')}.`);
  }

  const missing = [];
  if (!specification?.hasPlan) missing.push('a concrete plan');
  if (!specification?.hasEditSites) missing.push('the files to change');
  if (!specification?.hasAcceptanceCriteria && !specification?.hasExpectedOutput) {
    missing.push('a checkable definition of done');
  }

  // Only worth raising when the thin brief plausibly cost something: the work
  // needed more than one attempt, or it failed outright.
  const costSomething = attempts.length > 1 || status !== 'completed';
  if (missing.length > 0 && costSomething) {
    notes.push(
      `This subtask arrived without ${missing.join(', ')}. Subtasks that carry the plan you already worked out can be executed directly instead of re-derived, which is faster and cheaper. If you delegate follow-up work here, supply what you have.`,
    );
  }

  return notes.length > 0 ? notes.join(' ') : null;
}
