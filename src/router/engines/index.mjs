import { createJevEngine } from './jev.mjs';
import { createMockEngine } from './mock.mjs';

/**
 * Semantic decision engines.
 *
 * The policy graph asks narrow boolean questions and walks its branches in
 * ordinary code. Who answers those questions is a separate concern: Jev over the
 * network, Laya locally on Apple silicon, or a fixed set of answers for testing.
 *
 *   interface SemanticDecisionEngine {
 *     name: string
 *     evaluate({ state, predicates, signal }): Promise<SemanticDecisionResult>
 *     stateOptions(): { sendPlan, maxPlanChars }
 *     describe(): { provider, model, local, dataLeavesMachine }
 *     close?(): Promise<void>
 *   }
 *
 * Jev was the first engine, which is why the package is named for it. It is now
 * one implementation of this interface rather than the interface itself.
 *
 * This is a registry of three named strategies, not a plugin system.
 */

const ENGINES = new Map();

export function registerEngine(name, factory) {
  ENGINES.set(name, factory);
}

registerEngine('jev', createJevEngine);
registerEngine('mock', createMockEngine);

export const engineNames = () => [...ENGINES.keys()];

/** Which engine the configuration selects. Absent settings mean Jev, as before. */
export function selectedEngineName(config) {
  return config.routing?.semanticEvaluator?.provider ?? 'jev';
}

export function createEngine(config) {
  const name = selectedEngineName(config);
  const factory = ENGINES.get(name);
  if (!factory) {
    throw new Error(
      `unknown semantic evaluator "${name}" (known: ${engineNames().join(', ')})`,
    );
  }
  return factory(config);
}

/**
 * The shape every engine returns. Normalising here rather than in each backend
 * keeps the difference between them to the wire format alone, and keeps
 * telemetry comparable across engines.
 */
export function normalizeResult({ answers, latencyMs, usage, engine, model, metadata }) {
  return {
    answers,
    latencyMs: Math.max(0, Math.round(latencyMs ?? 0)),
    usage: usage ?? null,
    engine,
    model: model ?? null,
    metadata: metadata ?? null,
  };
}

/**
 * One predicate answer, in the form traversal reads.
 *
 * `result` stays a 'yes'/'no' string because those are the graph's branch names;
 * a boolean here would mean every caller translating it back.
 */
export function normalizeAnswer(probability, confidence) {
  const p = Math.min(1, Math.max(0, probability));
  return {
    result: p >= 0.5 ? 'yes' : 'no',
    probability: p,
    // For a boolean, confidence is the distance from the coin flip unless the
    // engine reports its own calibrated figure.
    confidence: typeof confidence === 'number' && Number.isFinite(confidence)
      ? Math.min(1, Math.max(0, confidence))
      : Math.max(p, 1 - p),
    probabilities: { yes: p, no: 1 - p },
  };
}

/** An engine failing must never stop a delegation; the graph over-routes instead. */
export class EvaluatorError extends Error {
  constructor(message, { provider, cause } = {}) {
    super(message);
    this.name = 'EvaluatorError';
    this.provider = provider;
    this.cause = cause;
  }
}
