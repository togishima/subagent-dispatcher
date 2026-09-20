import { normalizeResult, normalizeAnswer, EvaluatorError } from './index.mjs';

/**
 * A fixed-answer engine.
 *
 * Useful for two things a real backend cannot do: running the policy graph with
 * no model at all, and proving that the graph reaches the same tier from the
 * same answers regardless of which engine supplied them.
 */
export function createMockEngine(config) {
  const settings = config.routing.semanticEvaluator?.mock ?? {};
  const answers = settings.answers ?? {};
  const fallback = settings.defaultProbability ?? 0.5;

  return {
    name: 'mock',

    describe() {
      return {
        provider: 'mock',
        model: null,
        local: true,
        dataLeavesMachine: false,
      };
    },

    stateOptions() {
      return { sendPlan: false, maxPlanChars: 0 };
    },

    async evaluate({ predicates }) {
      if (settings.fail) throw new EvaluatorError(String(settings.fail), { provider: 'mock' });

      const started = Date.now();
      const out = {};
      for (const predicate of predicates) {
        const configured = answers[predicate.id];
        const probability = typeof configured === 'number' ? configured : fallback;
        out[predicate.id] = normalizeAnswer(probability);
      }
      return normalizeResult({
        answers: out,
        latencyMs: Date.now() - started,
        usage: null,
        engine: 'mock',
        model: null,
        metadata: { predicateCount: predicates.length },
      });
    },
  };
}
