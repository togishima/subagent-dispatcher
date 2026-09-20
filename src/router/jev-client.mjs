import { log } from '../util/log.mjs';

/**
 * Jev client. Jev is used as a semantic predicate evaluator, not as a resource
 * scheduler: the policy graph decides the tier, Jev only answers the narrow
 * boolean questions the graph cannot decide in code.
 *
 * TypeSafe evaluates every question in one request in parallel, so all of a
 * policy's semantic predicates go out as a single call sharing one state object.
 *
 * Wire format (POST {endpoint}):
 *   { state, model, questions: { <id>: { type, instructions, criteria } } }
 *   -> { answers: { <id>: { noul | choice, confidence, probabilities } }, usage }
 */

export class JevError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'JevError';
    this.status = status;
  }
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);

function apiKey(jevConfig) {
  const key = process.env[jevConfig.apiKeyEnv];
  if (!key) {
    throw new JevError(
      `no Jev API key: set ${jevConfig.apiKeyEnv} in the environment (never in the config file)`,
    );
  }
  return key;
}

async function post(jevConfig, body, externalSignal) {
  const key = apiKey(jevConfig);
  let lastError;
  for (let attempt = 0; attempt < Math.max(1, jevConfig.maxRetries); attempt += 1) {
    const timeout = AbortSignal.timeout(jevConfig.timeoutMs);
    const signal = externalSignal ? AbortSignal.any([timeout, externalSignal]) : timeout;
    try {
      const response = await fetch(jevConfig.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new JevError(`TypeSafe ${response.status}: ${detail.slice(0, 300)}`, response.status);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      const status = error instanceof JevError ? error.status : undefined;
      const retryable = status === undefined ? error.name === 'TimeoutError' || error.name === 'AbortError' : RETRYABLE.has(status);
      if (!retryable || externalSignal?.aborted) break;
      await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
    }
  }
  throw lastError instanceof JevError ? lastError : new JevError(String(lastError?.message ?? lastError));
}

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/**
 * Ask Jev every semantic predicate of a policy in one request.
 * Returns a map of node id -> { result, probability, confidence, probabilities }.
 */
export async function evaluateSemanticPredicates(nodes, state, jevConfig, signal) {
  if (nodes.length === 0) return { answers: {}, latencyMs: 0, usage: null };

  const questions = {};
  for (const node of nodes) {
    questions[node.id] = {
      type: 'noul',
      instructions: node.question,
      criteria: node.criteria ?? {
        true: 'The statement in the question holds for this subtask.',
        false: 'The statement in the question does not hold for this subtask.',
      },
    };
  }

  const started = Date.now();
  const payload = await post(jevConfig, { state, model: jevConfig.model, questions }, signal);
  const latencyMs = Date.now() - started;

  const answers = {};
  for (const node of nodes) {
    const raw = payload?.answers?.[node.id];
    const probability = finite(raw?.noul) ?? finite(raw?.noul_score) ?? finite(raw?.probability);
    if (probability === undefined) {
      throw new JevError(`Jev returned no usable answer for predicate "${node.id}"`);
    }
    answers[node.id] = {
      result: probability >= 0.5 ? 'yes' : 'no',
      probability,
      // For a boolean, confidence is the distance from the coin flip.
      confidence: finite(raw?.confidence) ?? Math.max(probability, 1 - probability),
      probabilities: { yes: probability, no: 1 - probability },
    };
  }

  log.debug('jev semantic predicates evaluated', { count: nodes.length, latencyMs });
  return { answers, latencyMs, usage: payload?.usage ?? null };
}

/**
 * Ask Jev for the worker tier directly. This is the `jev-direct` baseline arm —
 * the arm the policy-graph mode is being measured against — not the default path.
 */
export async function classifyTierDirectly(state, tiers, jevConfig, signal) {
  const criteria = {};
  for (const [name, tier] of Object.entries(tiers)) criteria[name] = tier.description;

  const started = Date.now();
  const payload = await post(
    jevConfig,
    {
      state,
      model: jevConfig.model,
      questions: {
        required_tier: {
          type: 'choice',
          instructions:
            'What is the minimum worker capability required to complete this subtask reliably? Judge the work itself, not how much any worker costs. Pick the weakest capability that would still produce a correct result.',
          criteria,
        },
      },
    },
    signal,
  );
  const latencyMs = Date.now() - started;

  const answer = payload?.answers?.required_tier ?? {};
  const tier = typeof answer.choice === 'string' ? answer.choice : null;
  if (!tier || !tiers[tier]) throw new JevError(`Jev returned an unknown tier: ${JSON.stringify(answer.choice)}`);

  const probabilities = answer.probabilities ?? {};
  const maxProbability = Object.values(probabilities).reduce((max, value) => Math.max(max, value), 0);
  return {
    tier,
    confidence: finite(answer.confidence) ?? maxProbability,
    maxProbability: maxProbability || (finite(answer.confidence) ?? 0),
    probabilities,
    latencyMs,
    usage: payload?.usage ?? null,
  };
}
