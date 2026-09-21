import { loadPolicy, semanticNodes } from '../policy/graph.mjs';
import { traverse, pathConfidence } from '../policy/traverse.mjs';
import { buildRoutingState } from './state.mjs';
import { classifyTierDirectly } from './jev-client.mjs';
import { createEngine } from './engines/index.mjs';
import { orderedTiers } from '../config/load.mjs';
import { log } from '../util/log.mjs';

/**
 * A Router turns a delegation task into a required capability tier.
 *
 *   interface Router { route(input): Promise<RouteDecision> }
 *
 * Three implementations ship, and they are the three arms of the experiment:
 *   policy-graph  deterministic graph; a semantic engine answers only its
 *                 boolean predicates, and which engine is a separate setting
 *   jev-direct    Jev classifies the tier in one choice question             (B)
 *   fixed         always one tier, the baseline                             (A)
 *
 * Registering another router is a map entry, not a refactor — but this is a
 * registry of three named strategies, not a plugin framework.
 */

const ROUTERS = new Map();

export function registerRouter(mode, factory) {
  ROUTERS.set(mode, factory);
}

export function createRouter(config) {
  const factory = ROUTERS.get(config.routing.mode);
  if (!factory) {
    throw new Error(`unknown routing mode "${config.routing.mode}" (known: ${[...ROUTERS.keys()].join(', ')})`);
  }
  return factory(config);
}

export function availableModes() {
  return [...ROUTERS.keys()];
}

/** Shape every router returns, so telemetry and the UI never branch on mode. */
function decision(fields) {
  return {
    router: fields.router,
    policyVersion: fields.policyVersion ?? null,
    requiredTier: fields.requiredTier,
    confidence: fields.confidence ?? null,
    probabilities: fields.probabilities ?? null,
    trail: fields.trail ?? [],
    semanticEvaluations: fields.semanticEvaluations ?? [],
    routingLatencyMs: fields.routingLatencyMs ?? 0,
    // Who answered the semantic predicates, and what it cost. Named for the role
    // rather than for Jev, which is now one engine among several.
    evaluator: fields.evaluator ?? null,
    evaluatorLatencyMs: fields.evaluator?.latencyMs ?? null,
    evaluatorUsage: fields.evaluator?.usage ?? null,
    reason: fields.reason,
    degraded: fields.degraded ?? false,
    error: fields.error ?? null,
  };
}

// ---------------------------------------------------------------- policy-graph

registerRouter('policy-graph', (config) => {
  const values = orderedTiers(config);
  const policy = loadPolicy({
    values,
    fallback: values[Math.min(1, values.length - 1)],
    graph: config.routing.policyGraph.graph,
    path: config.routing.policyGraph.path,
    configDir: config.$configDir,
  });
  const semantic = semanticNodes(policy);
  const options = config.routing.policyGraph;
  // The graph does not know which engine answers its questions, and must not:
  // the same answers have to produce the same tier whoever supplied them.
  const engine = createEngine(config);

  return {
    mode: 'policy-graph',
    policy,
    engine,
    close: () => engine.close?.(),
    async route(input) {
      const started = Date.now();
      let answers = {};
      let evaluator = null;
      let error = null;
      let degraded = false;

      if (semantic.length > 0) {
        try {
          const state = buildRoutingState(input, engine.stateOptions());
          const result = await engine.evaluate({ state, predicates: semantic, signal: input.signal });
          answers = result.answers;
          evaluator = result;
        } catch (cause) {
          // An engine being unavailable must not stop a delegation, and must not
          // change which way uncertainty falls. Traversal then takes the safer
          // branch at every semantic node, which over-routes by design — a local
          // engine crashing is no more a reason to under-route than a remote one
          // timing out.
          error = String(cause?.message ?? cause);
          degraded = true;
          log.warn('semantic evaluator unavailable, traversing policy with safer branches', {
            engine: engine.name,
            error,
          });
        }
      }

      // An outage otherwise sends every task to the safest branch, which for a
      // policy that ends in HIGH means every task becomes a frontier task. Deployments
      // that would rather cap the blast radius can fall back to a fixed tier instead.
      if (degraded && options.onEvaluatorUnavailable === 'fallback-tier') {
        return decision({
          router: 'policy-graph',
          policyVersion: policy.version,
          requiredTier: config.routing.fallbackTierOnRouterError,
          routingLatencyMs: Date.now() - started,
          evaluator: { engine: engine.name, latencyMs: null, usage: null, model: null },
          reason: 'router-error-fallback',
          degraded: true,
          error,
        });
      }

      const walk = traverse(policy, input, answers, options);
      const evaluations = semantic.map((node) => {
        const answer = answers[node.id];
        const step = walk.trail.find((entry) => entry.nodeId === node.id);
        return {
          nodeId: node.id,
          type: 'semantic',
          result: answer?.result ?? null,
          confidence: answer?.confidence ?? null,
          probabilities: answer?.probabilities ?? null,
          used: Boolean(step),
          // A used step can differ from the engine's answer when the confidence floor
          // forced the safer branch; both are kept so policies can be re-scored.
          branchTaken: step?.branch ?? null,
          uncertain: step?.uncertain ?? null,
        };
      });

      return decision({
        router: 'policy-graph',
        policyVersion: policy.version,
        requiredTier: walk.tier,
        confidence: pathConfidence(walk.trail),
        probabilities: null,
        trail: walk.trail,
        semanticEvaluations: evaluations,
        routingLatencyMs: Date.now() - started,
        evaluator: evaluator ?? { engine: engine.name, latencyMs: null, usage: null, model: null },
        reason: degraded ? 'policy-graph-degraded' : walk.reason,
        degraded,
        error,
      });
    },
  };
});

// ------------------------------------------------------------------ jev-direct

registerRouter('jev-direct', (config) => {
  const policy = config.routing.jevDirect.confidencePolicy;
  return {
    mode: 'jev-direct',
    async route(input) {
      const started = Date.now();
      try {
        const state = buildRoutingState(input, {
          sendPlan: config.routing.jev.sendPlan !== false,
          maxPlanChars: config.routing.jev.maxPlanChars ?? 4000,
        });
        const result = await classifyTierDirectly(state, config.tiers, config.routing.jev, input.signal);

        let tier = result.tier;
        let reason = 'jev-direct';
        if (policy?.enabled && result.maxProbability < policy.minMaxProbability) {
          // Low confidence in the distribution itself: floor the tier rather than
          // trust the argmax. Same over-route-on-uncertainty rule as the graph.
          const ordered = orderedTiers(config);
          if (ordered.indexOf(policy.floorTier) > ordered.indexOf(tier)) {
            tier = policy.floorTier;
            reason = 'jev-direct-confidence-floor';
          }
        }
        return decision({
          router: 'jev-direct',
          requiredTier: tier,
          confidence: result.maxProbability,
          probabilities: result.probabilities,
          routingLatencyMs: Date.now() - started,
          evaluator: {
            engine: 'jev-direct', model: config.routing.jev.model ?? null,
            latencyMs: result.latencyMs, usage: result.usage, metadata: null,
          },
          reason,
        });
      } catch (cause) {
        const fallback = config.routing.fallbackTierOnRouterError;
        log.warn('jev-direct failed, falling back', { error: cause.message, fallback });
        return decision({
          router: 'jev-direct',
          requiredTier: fallback,
          routingLatencyMs: Date.now() - started,
          reason: 'router-error-fallback',
          degraded: true,
          error: cause.message,
        });
      }
    },
  };
});

// ----------------------------------------------------------------------- fixed

registerRouter('fixed', (config) => ({
  mode: 'fixed',
  async route() {
    return decision({
      router: 'fixed',
      requiredTier: config.routing.fixedTier,
      routingLatencyMs: 0,
      reason: `fixed-${config.routing.fixedTier}`,
    });
  },
}));
