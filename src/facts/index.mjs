import path from 'node:path';
import { FACT_STATUS, runSemgrep, scanTargets } from './semgrep.mjs';

/**
 * Fact acquisition: the step between "a task arrived" and "route it".
 *
 * Routing reads facts; it does not gather them. Everything that touches the
 * filesystem or spawns a process to learn something about the code happens
 * here, once, before the first route — which is what keeps `traverse()` a pure
 * function of (policy, input, answers) and a routing decision reproducible from
 * the facts recorded alongside it.
 *
 * Today there is one provider, Semgrep. Another one — git diff shape, test
 * impact, ownership — would be added next to it and would widen `matched`
 * without policy traversal learning anything new: a policy asks whether a fact
 * is present, never who found it.
 */

export { FACT_STATUS };

const EMPTY = Object.freeze([]);

/**
 * Normalized evidence about the code this subtask touches.
 *
 * `matched` holds logical fact names, not tool output. `status` distinguishes
 * the three states that matter — facts collected, collection switched off, or
 * collection failed — because "Semgrep found nothing" and "Semgrep never ran"
 * are different claims and collapsing them would let a broken installation
 * silently change routing.
 */
export function emptyFacts(status = FACT_STATUS.DISABLED, detail = {}) {
  return {
    matched: EMPTY,
    status,
    unavailable: status !== FACT_STATUS.OK && status !== FACT_STATUS.DISABLED,
    semgrep: { status, matchCount: 0, latencyMs: 0, ...detail },
  };
}

/**
 * Collect deterministic code facts for a task.
 *
 * Never throws and never fails a dispatch: a provider that cannot answer leaves
 * its evidence out, and routing proceeds on whatever remains. Absence of a fact
 * is not evidence of its opposite, so nothing here ever routes anything upward
 * by itself.
 */
export async function collectFacts(config, task, { signal, runners = {} } = {}) {
  const settings = config?.facts?.semgrep ?? {};
  if (!settings.enabled) return emptyFacts(FACT_STATUS.DISABLED);

  const cwd = task?.cwd ?? process.cwd();
  const run = runners.semgrep ?? runSemgrep;
  let result;
  try {
    result = await run({
      binary: settings.binary ?? 'semgrep',
      configPath: settings.config ? path.resolve(cwd, settings.config) : null,
      cwd,
      targets: scanTargets(task?.contextFiles, cwd),
      timeoutMs: settings.timeoutMs ?? 10_000,
      ruleFacts: settings.ruleFacts ?? {},
      signal,
    });
  } catch (error) {
    // A provider throwing is the same kind of event as a provider timing out.
    return emptyFacts(FACT_STATUS.ERROR, { error: String(error?.message ?? error) });
  }

  if (result.status !== FACT_STATUS.OK) {
    return emptyFacts(result.status, { latencyMs: result.latencyMs ?? 0 });
  }
  return {
    matched: result.facts,
    status: FACT_STATUS.OK,
    unavailable: false,
    semgrep: { status: FACT_STATUS.OK, matchCount: result.matchCount, latencyMs: result.latencyMs },
  };
}
