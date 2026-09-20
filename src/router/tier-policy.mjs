import { orderedTiers, tierAbove, workerForTier } from '../config/load.mjs';

/**
 * Tier policy: the one place a capability tier becomes a concrete worker.
 *
 * Routing intelligence (which tier) and provider policy (which worker/model)
 * are separated here on purpose. A router never names a model, and swapping
 * `tiers.low.worker` from `haiku` to `local-model` needs no routing change.
 */

/** Never go below a tier already tried and failed for a capability reason. */
export function applyAttemptFloor(config, requiredTier, attemptState) {
  const ordered = orderedTiers(config);
  const floor = attemptState?.escalatedTo;
  if (!floor) return { tier: requiredTier, reason: null };
  if (ordered.indexOf(floor) > ordered.indexOf(requiredTier)) {
    return { tier: floor, reason: 'escalation-floor' };
  }
  return { tier: requiredTier, reason: null };
}

export function nextTierForEscalation(config, fromTier) {
  return tierAbove(config, fromTier);
}

/** Resolve the tier a dispatch will actually run at, and the worker that serves it. */
export function resolveDispatch(config, routeDecision, attemptState = {}) {
  const floored = applyAttemptFloor(config, routeDecision.requiredTier, attemptState);
  const worker = workerForTier(config, floored.tier);
  return {
    requiredTier: routeDecision.requiredTier,
    selectedTier: floored.tier,
    policyReason: floored.reason ?? routeDecision.reason,
    worker,
  };
}
