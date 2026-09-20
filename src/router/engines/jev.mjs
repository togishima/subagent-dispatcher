import { evaluateSemanticPredicates, JevError } from '../jev-client.mjs';
import { resolveProvider } from '../providers.mjs';
import { normalizeResult, EvaluatorError } from './index.mjs';

/**
 * Jev as a semantic decision engine.
 *
 * A thin adapter over the existing client: the wire format, retries, provider
 * handling and answer parsing are unchanged, so this backend behaves exactly as
 * it did before the abstraction existed.
 */
export function createJevEngine(config) {
  const jevConfig = config.routing.jev;

  return {
    name: 'jev',

    describe() {
      let endpoint = null;
      try {
        endpoint = resolveProvider(jevConfig).endpoint;
      } catch {
        // A misconfigured provider is reported by doctor, not by describe().
      }
      return {
        provider: 'jev',
        model: jevConfig.model ?? null,
        transport: jevConfig.provider ?? 'typesafe',
        endpoint,
        local: false,
        // The routing state crosses the network. That is the honest answer, and
        // the dashboard shows it next to every delegation this engine routed.
        dataLeavesMachine: 'routing state, including the plan when sendPlan is on',
      };
    },

    stateOptions() {
      return { sendPlan: jevConfig.sendPlan !== false, maxPlanChars: jevConfig.maxPlanChars ?? 4000 };
    },

    async evaluate({ state, predicates, signal }) {
      try {
        const result = await evaluateSemanticPredicates(predicates, state, jevConfig, signal);
        return normalizeResult({
          answers: result.answers,
          latencyMs: result.latencyMs,
          usage: result.usage,
          engine: 'jev',
          model: jevConfig.model ?? null,
          metadata: { transport: jevConfig.provider ?? 'typesafe', predicateCount: predicates.length },
        });
      } catch (cause) {
        throw new EvaluatorError(
          cause instanceof JevError ? cause.message : String(cause?.message ?? cause),
          { provider: 'jev', cause },
        );
      }
    },
  };
}
