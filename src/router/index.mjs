import { loadPolicy, semanticNodes } from '../policy/graph.mjs';
import { traverse, pathConfidence } from '../policy/traverse.mjs';
import { buildRoutingState } from './state.mjs';
import { evaluateSemanticPredicates, classifyTierDirectly, JevError } from './jev-client.mjs';
import { orderedTiers } from '../config/load.mjs';
import { log } from '../util/log.mjs';

/**
 * A Router turns a delegation task into a required capability tier.
 *
 *   interface Router { route(input): Promise<RouteDecision> }
 *
 * Three implementations ship, and they are the three arms of the experiment:
 *   policy-graph  deterministic graph, Jev answers only semantic predicates (C)
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
    jevLatencyMs: fields.jevLatencyMs ?? null,
    jevUsage: fields.jevUsage ?? null,
    reason: fields.reason,
    degraded: fields.degraded ?? false,
    error: fields.error ?? null,
  };
}

// ---------------------------------------------------------------- policy-graph

registerRouter('policy-graph', (config) => {
  const policy = loadPolicy(config);
  const semantic = semanticNodes(policy);
  const options = config.routing.policyGraph;

  return {
    mode: 'policy-graph',
    policy,
    async route(input) {
      const started = Date.now();
      let answers = {};
      let jevLatencyMs = null;
      let jevUsage = null;
      let error = null;
      let degraded = false;

      if (semantic.length > 0) {
        try {
          const state = buildRoutingState(input, config.routing.jev);
          const result = await evaluateSemanticPredicates(semantic, state, config.routing.jev, input.signal);
          answers = result.answers;
          jevLatencyMs = result.latencyMs;
          jevUsage = result.usage;
        } catch (cause) {
          // Jev being unavailable must not stop a delegation. Traversal then takes
          // the safer branch at every semantic node, which over-routes by design.
          error = cause instanceof JevError ? cause.message : String(cause?.message ?? cause);
          degraded = true;
          log.warn('jev unavailable, traversing policy with safer branches', { error });
        }
      }

      // A Jev outage otherwise sends every task to the safest branch, which for a
      // policy that ends in HIGH means every task becomes a frontier task. Deployments
      // that would rather cap the blast radius can fall back to a fixed tier instead.
      if (degraded && options.onEvaluatorUnavailable === 'fallback-tier') {
        return decision({
          router: 'policy-graph',
          policyVersion: policy.version,
          requiredTier: config.routing.fallbackTierOnRouterError,
          routingLatencyMs: Date.now() - started,
          jevLatencyMs,
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
          // A used step can differ from Jev's answer when the confidence floor
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
        jevLatencyMs,
        jevUsage,
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
        const state = buildRoutingState(input, config.routing.jev);
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
          jevLatencyMs: result.latencyMs,
          jevUsage: result.usage,
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
