/**
 * The state handed to Jev.
 *
 * Deliberately small and structured: the main conversation's history never goes
 * here. The caller supplies a summary, and everything else is metadata the
 * dispatcher already knows. Keeping this small is both a cost and a privacy
 * property — Jev is billed per input token, and the state is the only place task
 * text leaves the machine.
 */
export function buildRoutingState(input, jevConfig = {}) {
  const state = {
    subtask: input.task,
    expected_output: input.expectedOutput ?? null,
    context_summary: input.contextSummary ?? null,
    task_type: input.taskType ?? null,
    deterministic_verification_available: Boolean(input.verificationAvailable),
    risk_flags: input.riskFlags?.length ? input.riskFlags : null,
    relevant_file_count: input.contextFiles?.length ?? null,
  };

  // Judging whether a plan is concrete enough to follow means reading it, so the
  // plan goes to the evaluator — truncated, and only when the operator allows
  // it. This is the one place plan text leaves the machine.
  const specification = input.specification;
  if (specification) {
    state.specification = {
      plan_provided: specification.hasPlan,
      acceptance_criteria_provided: specification.hasAcceptanceCriteria,
      files_to_change_named: specification.hasEditSites,
      constraints_stated: specification.hasConstraints,
    };
    if (specification.hasPlan && jevConfig.sendPlan !== false) {
      const limit = jevConfig.maxPlanChars ?? 4000;
      const plan = [input.plan, ...(input.planDocuments ?? []).map((doc) => doc.content)]
        .filter(Boolean)
        .join('\n\n');
      state.plan = plan.length > limit ? `${plan.slice(0, limit)}\n[… truncated]` : plan;
    }
    if (specification.hasAcceptanceCriteria) state.acceptance_criteria = input.acceptanceCriteria;
  }
  if ((input.attempt ?? 1) > 1) {
    state.previous_attempt = {
      attempt: input.attempt,
      tier: input.previousTier ?? null,
      failure_reason: input.previousFailureReason ?? null,
      verification: input.previousVerification ?? null,
    };
  }
  for (const key of Object.keys(state)) if (state[key] === null) delete state[key];
  return state;
}
