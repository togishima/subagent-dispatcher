/**
 * The state handed to Jev.
 *
 * Deliberately small and structured: the main conversation's history never goes
 * here. The caller supplies a summary, and everything else is metadata the
 * dispatcher already knows. Keeping this small is both a cost and a privacy
 * property — Jev is billed per input token, and the state is the only place task
 * text leaves the machine.
 */
export function buildRoutingState(input) {
  const state = {
    subtask: input.task,
    expected_output: input.expectedOutput ?? null,
    context_summary: input.contextSummary ?? null,
    task_type: input.taskType ?? null,
    deterministic_verification_available: Boolean(input.verificationAvailable),
    risk_flags: input.riskFlags?.length ? input.riskFlags : null,
    relevant_file_count: input.contextFiles?.length ?? null,
  };
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
