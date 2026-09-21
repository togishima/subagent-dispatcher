import { evaluateDeterministic } from './predicates.mjs';

/**
 * Walk the policy graph. Every semantic answer is already in hand (one batched
 * Jev call happens before traversal), so this is a plain deterministic loop with
 * no I/O — which is what makes a routing decision reproducible from telemetry.
 */
export function traverse(policy, input, semanticAnswers, options = {}) {
  const defaultMinConfidence = options.defaultMinConfidence ?? 0;
  const overRouteOnUncertain = options.overRouteOnUncertain !== false;
  const maxSteps = options.maxTraversalSteps ?? 32;

  const trail = [];
  let nodeId = policy.entry;
  let value = null;
  let steps = 0;

  while (nodeId && steps < maxSteps) {
    steps += 1;
    const node = policy.nodes.get(nodeId);
    if (!node) throw new Error(`policy "${policy.version}": traversal reached unknown node "${nodeId}"`);

    const step = { order: trail.length, nodeId: node.id, type: node.type, uncertain: false };
    let branch;

    if (node.type === 'deterministic') {
      branch = evaluateDeterministic(node, input) ? 'yes' : 'no';
      step.predicate = node.predicate;
      step.result = branch;
      step.confidence = 1;
      step.probabilities = null;
    } else {
      const answer = semanticAnswers[node.id];
      if (!answer) {
        // No semantic answer (Jev unavailable, or the predicate was not asked):
        // take the safer branch rather than guessing.
        branch = node.$safer ?? 'yes';
        step.result = branch;
        step.confidence = null;
        step.probabilities = null;
        step.uncertain = true;
        step.uncertainReason = 'no-answer';
      } else {
        const threshold = node.minConfidence ?? defaultMinConfidence;
        const belowThreshold = answer.confidence < threshold;
        if (belowThreshold && overRouteOnUncertain) {
          branch = node.$safer;
          step.uncertain = true;
          step.uncertainReason = 'below-threshold';
        } else {
          branch = answer.result;
          step.uncertain = belowThreshold;
          if (belowThreshold) step.uncertainReason = 'below-threshold-accepted';
        }
        step.result = branch;
        step.answered = answer.result;
        step.confidence = answer.confidence;
        step.probabilities = answer.probabilities;
        step.threshold = threshold;
      }
      step.question = node.question;
    }

    const edge = node[branch];
    step.branch = branch;
    step.next = edge.goto ?? null;
    step.value = edge.value ?? null;
    step.tier = step.value; // Compatibility alias for telemetry.
    trail.push(step);

    if (edge.value) { value = edge.value; break; }
    nodeId = edge.goto;
  }

  if (!value) {
    return {
      value: policy.fallback,
      tier: policy.fallback, // Compatibility alias for legacy callers.
      trail,
      exhausted: true,
      reason: steps >= maxSteps ? 'traversal-step-limit' : 'no-terminal-branch',
    };
  }
  return { value, tier: value, trail, exhausted: false, reason: 'policy-graph' };
}

/** The lowest confidence of any semantic step that actually decided the route. */
export function pathConfidence(trail) {
  const confidences = trail
    .filter((step) => step.type === 'semantic' && typeof step.confidence === 'number')
    .map((step) => step.confidence);
  return confidences.length === 0 ? null : Math.min(...confidences);
}
