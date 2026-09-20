/**
 * Deterministic predicate registry.
 *
 * Deterministic-first: anything ordinary code can decide safely must be decided
 * here rather than sent to Jev. Each predicate gets the routing input plus the
 * node's `args` and returns a boolean.
 *
 * Adding a predicate is the supported way to extend routing without touching the
 * policy graph traversal. Predicates must be pure and cheap — they run inline on
 * every dispatch, before any network call.
 */

const asArray = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]);

function taskText(input) {
  return [input.task, input.expectedOutput, input.contextSummary].filter(Boolean).join('\n');
}

export const PREDICATES = {
  /** Always true. Useful for pinning a branch while authoring or testing a policy. */
  always: () => true,

  /** Always false. */
  never: () => false,

  /**
   * True when some deterministic check can judge the result: either the caller
   * supplied a verification command, or a configured check applies to this task.
   */
  verification_available: (input) => Boolean(input.verificationAvailable),

  /** True when the task text matches any of `args.patterns` (case-insensitive regex). */
  task_matches: (input, args) => {
    const text = taskText(input);
    return asArray(args.patterns).some((pattern) => {
      try {
        return new RegExp(pattern, args.flags ?? 'i').test(text);
      } catch {
        return false; // a malformed pattern must not decide routing
      }
    });
  },

  /** True when the caller-declared task type is one of `args.values`. */
  task_type_is: (input, args) =>
    Boolean(input.taskType) && asArray(args.values).map(String).includes(String(input.taskType)),

  /** True when the task text is at least `args.chars` characters long. */
  task_length_at_least: (input, args) => taskText(input).length >= (args.chars ?? 0),

  /** True when the caller flagged any of `args.flags` as a risk on this task. */
  risk_flag_present: (input, args) => {
    const flags = new Set(asArray(input.riskFlags).map((flag) => String(flag).toLowerCase()));
    const wanted = asArray(args.flags).map((flag) => String(flag).toLowerCase());
    return wanted.length === 0 ? flags.size > 0 : wanted.some((flag) => flags.has(flag));
  },

  /** True when the caller named at most `args.count` files as relevant context. */
  context_files_at_most: (input, args) => asArray(input.contextFiles).length <= (args.count ?? 0),

  /** True when the caller named at least `args.count` files as relevant context. */
  context_files_at_least: (input, args) => asArray(input.contextFiles).length >= (args.count ?? 1),

  /** True on any attempt after the first. */
  previous_attempt_failed: (input) => (input.attempt ?? 1) > 1,

  /** True when the previous attempt failed for one of `args.reasons`. */
  previous_failure_reason_is: (input, args) =>
    Boolean(input.previousFailureReason) && asArray(args.reasons).includes(input.previousFailureReason),

  /** True when a previous attempt already ran at `args.tier` or stronger. */
  previous_tier_at_least: (input, args) => {
    if (!input.previousTierOrder || !args.tier) return false;
    return input.previousTierOrder >= (input.tierOrders?.[args.tier] ?? Infinity);
  },
};

export function evaluateDeterministic(node, input) {
  const fn = PREDICATES[node.predicate];
  if (!fn) throw new Error(`policy node "${node.id}": unknown deterministic predicate "${node.predicate}"`);
  return Boolean(fn(input, node.args ?? {}));
}

export const predicateNames = () => Object.keys(PREDICATES);
