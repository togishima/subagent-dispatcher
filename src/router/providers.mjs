/**
 * Where Jev is reached.
 *
 * Jev is served directly by TypeSafe, and also through gateways — Cloudflare
 * Workers AI, Vercel's AI Gateway, and OpenAI-compatible proxies such as
 * LiteLLM. They differ in three small ways: the URL, how the key is presented,
 * and whether the answer arrives wrapped in an envelope.
 *
 * A provider is therefore a handful of values, not a plugin system. Every one of
 * them is overridable from configuration, which matters because none of these
 * shapes has been exercised against a running service. The TypeSafe shape was
 * read from a working client; the gateway shapes are inferred from how those
 * gateways generally behave. `jev-dispatch check-router` makes one real request
 * and prints the response, which is how a provider gets confirmed.
 */

/** How much is actually known about a provider's shape. */
export const SOURCE = {
  CLIENT: 'read from a working client, not exercised against the service',
  INFERRED: 'inferred from how this gateway generally behaves — confirm it',
};

/**
 * Fill `{accountId}`-style placeholders in an endpoint template.
 *
 * Values are inserted raw rather than percent-encoded, because a Workers AI
 * model name is a path of its own — `@typesafe/jev-1.13.0` — and encoding its
 * slash would address a different route. Anything that could restructure the URL
 * is rejected instead, so "not encoded" does not become "not checked".
 */
const UNSAFE_IN_PATH = /[\s?#]|\.\.|^\/\//;

export function renderEndpoint(template, values) {
  const missing = [];
  const unsafe = [];
  const url = template.replace(/\{(\w+)\}/g, (_, key) => {
    const value = values[key];
    if (value === undefined || value === null || value === '') {
      missing.push(key);
      return `{${key}}`;
    }
    const text = String(value);
    if (UNSAFE_IN_PATH.test(text)) {
      unsafe.push(key);
      return `{${key}}`;
    }
    return text;
  });
  if (unsafe.length > 0) {
    throw new Error(
      `routing.jev.${unsafe[0]} contains characters that would change the request URL; remove whitespace, "?", "#" and ".."`,
    );
  }
  if (missing.length > 0) {
    throw new Error(
      `routing.jev.endpoint needs ${missing.map((key) => `"${key}"`).join(', ')}; set routing.jev.${missing[0]} in your configuration`,
    );
  }
  return url;
}

const bearer = (key) => ({ Authorization: `Bearer ${key}` });

export const PROVIDERS = {
  /** TypeSafe's own API. The only shape confirmed against a real client. */
  typesafe: {
    label: 'TypeSafe',
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    apiKeyEnv: 'TYPESAFE_API_KEY',
    headers: bearer,
    body: (request) => request,
    source: SOURCE.CLIENT,
  },

  /**
   * Cloudflare Workers AI. The model is named in the path rather than the body,
   * and results come back under `result` alongside `success` and `errors`.
   */
  cloudflare: {
    label: 'Cloudflare Workers AI',
    endpoint: 'https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/run/{model}',
    apiKeyEnv: 'CLOUDFLARE_API_TOKEN',
    headers: bearer,
    body: ({ state, questions }) => ({ state, questions }),
    modelInPath: true,
    source: SOURCE.INFERRED,
  },

  /** Vercel AI Gateway, which proxies to the upstream provider. */
  vercel: {
    label: 'Vercel AI Gateway',
    endpoint: 'https://ai-gateway.vercel.sh/v1/systemone',
    apiKeyEnv: 'AI_GATEWAY_API_KEY',
    headers: bearer,
    body: (request) => request,
    source: SOURCE.INFERRED,
  },

  /** LiteLLM and other pass-through proxies that keep TypeSafe's own shape. */
  passthrough: {
    label: 'OpenAI-compatible pass-through (LiteLLM and similar)',
    endpoint: null,
    apiKeyEnv: 'JEV_API_KEY',
    headers: bearer,
    body: (request) => request,
    source: SOURCE.INFERRED,
  },

  /** Everything specified by hand. */
  custom: {
    label: 'Custom',
    endpoint: null,
    apiKeyEnv: 'JEV_API_KEY',
    headers: bearer,
    body: (request) => request,
    source: SOURCE.INFERRED,
  },
};

export const providerNames = () => Object.keys(PROVIDERS);

/**
 * Resolve the configured provider into everything a request needs.
 * Configuration always wins over a provider's defaults.
 */
export function resolveProvider(jevConfig) {
  const name = jevConfig.provider ?? 'typesafe';
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new Error(`unknown Jev provider "${name}" (known: ${providerNames().join(', ')})`);
  }

  const template = jevConfig.endpoint ?? provider.endpoint;
  if (!template) {
    throw new Error(`routing.jev.endpoint is required for the "${name}" provider`);
  }
  const endpoint = renderEndpoint(template, { ...jevConfig, model: jevConfig.model });
  const apiKeyEnv = jevConfig.apiKeyEnv ?? provider.apiKeyEnv;

  return {
    name,
    label: provider.label,
    endpoint,
    apiKeyEnv,
    source: provider.source,
    // A provider that names the model in its URL must not also repeat it in the body.
    buildBody: (request) => provider.body(provider.modelInPath ? { ...request, model: undefined } : request),
    buildHeaders(key) {
      const headers = { 'Content-Type': 'application/json', ...provider.headers(key), ...(jevConfig.headers ?? {}) };
      // A configured header set to null removes a default rather than sending "null".
      for (const [header, value] of Object.entries(headers)) {
        if (value === null || value === undefined) delete headers[header];
      }
      return headers;
    },
  };
}

/** Envelope keys gateways commonly wrap a provider response in. */
const ENVELOPE_KEYS = ['result', 'data', 'response', 'output', 'body'];

/**
 * Find the Jev payload inside whatever a gateway returned.
 *
 * Rather than encoding each gateway's envelope as fact — the shapes here are
 * inferred, not confirmed — this unwraps by looking for the thing that is
 * unmistakably a Jev answer: an `answers` object. A gateway that wraps once, or
 * twice, or not at all, all work; one that renames `answers` does not, and says
 * so loudly instead of silently returning nothing.
 */
export function unwrapPayload(payload, depth = 0) {
  if (payload === null || typeof payload !== 'object' || depth > 4) return null;
  if (payload.answers && typeof payload.answers === 'object') return payload;
  for (const key of ENVELOPE_KEYS) {
    const found = unwrapPayload(payload[key], depth + 1);
    if (found) return found;
  }
  return null;
}

/** A short, non-secret description of a response that could not be understood. */
export function describeUnknownPayload(payload) {
  if (payload === null || typeof payload !== 'object') return typeof payload;
  const keys = Object.keys(payload).slice(0, 8);
  const errors = payload.errors ?? payload.error;
  const detail = errors ? ` (errors: ${JSON.stringify(errors).slice(0, 200)})` : '';
  return `object with keys [${keys.join(', ')}]${detail}`;
}
