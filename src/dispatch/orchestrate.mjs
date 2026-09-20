import { createRouter } from '../router/index.mjs';
import { resolveDispatch, nextTierForEscalation } from '../router/tier-policy.mjs';
import { runWorker } from '../worker/run.mjs';
import { verify, applicableChecks, summarizeVerification, failureExcerpt, VERDICT } from '../verify/index.mjs';
import { classifyAttempt, FAILURE } from './classify.mjs';
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

    const task = {
      task: request.task,
      contextSummary: request.context ?? null,
      contextFiles: request.contextFiles ?? [],
      expectedOutput: request.expectedOutput ?? null,
      taskType: request.taskType ?? null,
      riskFlags: request.riskFlags ?? [],
      verification: request.verification ?? null,
      cwd,
    };

    // Whether a deterministic check exists is a routing input, so it is computed
    // before the first route rather than discovered after the worker has run.
    const verificationAvailable = applicableChecks(this.config, task).length > 0;

    this.store?.openDelegation({ taskId, sessionId, task: task.task, taskType: task.taskType });

    const maxAttempts = Math.max(1, this.config.escalation.maxAttemptsPerTask);
    const attempts = [];
    let escalatedTo = null;
    let sameTierRetries = 0;
    let previous = null;
    let escalated = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const routingInput = {
        ...task,
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
        return this.#finish({ taskId, attempts, escalated, status: 'completed', outcome, verification });
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
          return this.#finish({ taskId, attempts, escalated, status: 'failed', outcome, verification });
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
      return this.#finish({ taskId, attempts, escalated, status, outcome, verification });
    }

    const last = attempts[attempts.length - 1];
    return this.#finish({
      taskId, attempts, escalated, status: 'failed',
      outcome: last?.outcome ?? { failureReason: FAILURE.UNKNOWN, detail: 'retry budget exhausted' },
      verification: { verdict: VERDICT.UNCERTAIN, reason: 'retry budget exhausted', checks: [] },
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

  #finish({ taskId, attempts, escalated, status, outcome, verification }) {
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
      $internal: { summary, attempts },
    };
  }
}
