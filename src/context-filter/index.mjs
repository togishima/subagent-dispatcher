import { semanticNodes } from '../policy/graph.mjs';
import { traverse } from '../policy/traverse.mjs';
import { buildFilterState } from './state.mjs';

/** Accept a validated policy with ordered values ['drop', 'keep']. */
export async function filterContextItem({ policy, engine, task, item }, options = {}) {
  const input = { task, item };
  const walkOptions = {
    defaultMinConfidence: options.defaultMinConfidence ?? 0.75,
    maxTraversalSteps: options.maxTraversalSteps,
  };
  let walk = traverse(policy, input, {}, walkOptions);
  const semanticSkipped = !walk.trail.some((step) => step.type === 'semantic');
  let error = null;
  if (!semanticSkipped) {
    let answers = {};
    try {
      const state = buildFilterState(input);
      const result = await engine.evaluate({
        state, predicates: semanticNodes(policy), signal: options.signal,
      });
      answers = result.answers ?? {};
    } catch (cause) {
      error = String(cause?.message ?? cause);
    }
    walk = traverse(policy, input, answers, walkOptions);
  }
  return {
    value: walk.value,
    trail: walk.trail,
    reason: walk.reason,
    exhausted: walk.exhausted,
    engine: semanticSkipped ? null : engine.name,
    semanticSkipped,
    error,
  };
}
