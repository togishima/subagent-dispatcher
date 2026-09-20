import { log } from '../util/log.mjs';
import { resolveProvider, unwrapPayload, describeUnknownPayload } from './providers.mjs';
import { resolveApiKey } from '../config/plugin-options.mjs';

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
 *
 * Jev is also served through gateways, which vary the URL, the auth header and
 * whether the answer arrives wrapped in an envelope. Those differences live in
 * providers.mjs; everything below works on the unwrapped payload.
 */

export class JevError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'JevError';
    this.status = status;
  }
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);

function apiKey(provider, jevConfig) {
  const { key } = resolveApiKey(provider, jevConfig);
  if (!key) {
    throw new JevError(
      `no Jev API key for ${provider.label}: enter one with "/plugin" (it is stored in your keychain), ` +
        `or set ${provider.apiKeyEnv} in the environment. Never put it in the config file.`,
    );
  }
  return key;
}

/**
 * POST a Jev request and return the unwrapped payload.
 *
 * `raw` is returned alongside so a diagnostic command can show exactly what came
 * back — the gateway shapes here are inferred, and being able to see the real
 * response is the difference between fixing a config line and guessing.
 */
export async function post(jevConfig, body, externalSignal) {
  const provider = resolveProvider(jevConfig);
  const key = apiKey(provider, jevConfig);
  const headers = provider.buildHeaders(key);
  const payload = provider.buildBody(body);
  let lastError;

  for (let attempt = 0; attempt < Math.max(1, jevConfig.maxRetries); attempt += 1) {
    const timeout = AbortSignal.timeout(jevConfig.timeoutMs);
    const signal = externalSignal ? AbortSignal.any([timeout, externalSignal]) : timeout;
    try {
      const response = await fetch(provider.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new JevError(`${provider.label} ${response.status}: ${detail.slice(0, 300)}`, response.status);
      }
      const raw = await response.json();
      const unwrapped = unwrapPayload(raw);
      if (!unwrapped) {
        // A 200 with no `answers` anywhere usually means the endpoint is wrong or
        // the gateway rejected the request in its own envelope. Say which.
        throw new JevError(
          `${provider.label} returned no Jev answers: ${describeUnknownPayload(raw)}. ` +
            `Check routing.jev.endpoint and routing.jev.model, or run "jev-dispatch check-router" to see the full response.`,
        );
      }
      // `raw` contains `unwrapped`, so attaching it as an ordinary property
      // makes the payload circular and unserialisable. Non-enumerable keeps it
      // reachable for diagnostics while JSON.stringify walks only the answers.
      Object.defineProperty(unwrapped, '$raw', { value: raw, enumerable: false, configurable: true });
      Object.defineProperty(unwrapped, '$provider', { value: provider.name, enumerable: false, configurable: true });
      return unwrapped;
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

/**
 * One live request against the configured provider, for diagnostics. Returns the
 * raw response so a wrong endpoint or envelope can be seen rather than guessed.
 */
export async function probeProvider(jevConfig, signal) {
  const provider = resolveProvider(jevConfig);
  const started = Date.now();
  const body = {
    state: { subtask: 'Rename a local variable from `tmp` to `total` in one function.' },
    model: jevConfig.model,
    questions: {
      probe_mechanical: {
        type: 'noul',
        instructions: 'Is this subtask a single mechanical edit with no design decision left open?',
        criteria: { true: 'A direct, well-specified edit.', false: 'Judgement is required.' },
      },
    },
  };
  const payload = await post(jevConfig, body, signal);
  return {
    provider: provider.name,
    label: provider.label,
    endpoint: provider.endpoint,
    apiKeyEnv: provider.apiKeyEnv,
    source: provider.source,
    latencyMs: Date.now() - started,
    answer: payload.answers?.probe_mechanical ?? null,
    usage: payload.usage ?? null,
    raw: payload.$raw,
  };
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
