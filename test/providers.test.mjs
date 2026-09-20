import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDERS, providerNames, renderEndpoint, resolveProvider, unwrapPayload, describeUnknownPayload,
} from '../src/router/providers.mjs';
import { evaluateSemanticPredicates } from '../src/router/jev-client.mjs';
import { testConfig } from './helpers.mjs';

/** Stand in for a provider, capturing exactly what would have gone over the wire. */
function stubFetch(responder) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const result = responder(calls.length);
    if (result?.status) return { ok: false, status: result.status, text: async () => result.text ?? '' };
    return { ok: true, status: 200, json: async () => result };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const jev = (overrides) => testConfig({ routing: { jev: overrides } }).routing.jev;
const ANSWERS = { answers: { q: { noul: 0.8 } }, usage: { input_tokens: 10, output_tokens: 0 } };

test('every shipped provider declares what is actually known about its shape', () => {
  assert.ok(providerNames().length >= 4);
  for (const [name, provider] of Object.entries(PROVIDERS)) {
    assert.ok(provider.label, `${name} needs a label`);
    assert.ok(provider.apiKeyEnv, `${name} needs a key env var`);
    // No provider claims to be confirmed, because none has been.
    assert.match(provider.source, /not exercised against the service|confirm it/);
  }
});

test('the default provider is TypeSafe, and needs no extra configuration', () => {
  const provider = resolveProvider(jev({}));
  assert.equal(provider.name, 'typesafe');
  assert.equal(provider.endpoint, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(provider.apiKeyEnv, 'TYPESAFE_API_KEY');
});

test('Cloudflare puts the model in the path, and keeps its slash', () => {
  const provider = resolveProvider(jev({ provider: 'cloudflare', accountId: 'acc123', model: '@typesafe/jev-1.13.0' }));
  // Percent-encoding the slash would address a different route entirely.
  assert.equal(provider.endpoint, 'https://api.cloudflare.com/client/v4/accounts/acc123/ai/run/@typesafe/jev-1.13.0');
  assert.equal(provider.apiKeyEnv, 'CLOUDFLARE_API_TOKEN');
  // The model is named once, in the URL — not repeated in the body.
  const body = provider.buildBody({ state: {}, questions: {}, model: '@typesafe/jev-1.13.0' });
  assert.equal(body.model, undefined);
  assert.deepEqual(Object.keys(body).sort(), ['questions', 'state']);
});

test('a placeholder with nothing to fill it is reported, not sent', () => {
  assert.throws(() => resolveProvider(jev({ provider: 'cloudflare', model: 'm' })), /accountId/);
});

test('a path value cannot restructure the request URL', () => {
  for (const value of ['a b', 'x?y=1', 'p#frag', '../../admin']) {
    assert.throws(() => renderEndpoint('https://host/{model}', { model: value }), /change the request URL/, value);
  }
  assert.equal(renderEndpoint('https://host/{model}', { model: '@ns/model-1.2' }), 'https://host/@ns/model-1.2');
});

test('providers with no sensible default endpoint say so', () => {
  for (const name of ['passthrough', 'custom']) {
    assert.throws(() => resolveProvider(jev({ provider: name })), /endpoint is required/);
    const provider = resolveProvider(jev({ provider: name, endpoint: 'https://proxy.internal/v1/systemone' }));
    assert.equal(provider.endpoint, 'https://proxy.internal/v1/systemone');
  }
});

test('configuration overrides every provider default', () => {
  const provider = resolveProvider(jev({
    provider: 'vercel',
    endpoint: 'https://gw.example/v1/jev',
    apiKeyEnv: 'MY_GATEWAY_KEY',
    headers: { 'X-Team': 'platform' },
  }));
  assert.equal(provider.endpoint, 'https://gw.example/v1/jev');
  assert.equal(provider.apiKeyEnv, 'MY_GATEWAY_KEY');
  const headers = provider.buildHeaders('k');
  assert.equal(headers['X-Team'], 'platform');
  assert.equal(headers.Authorization, 'Bearer k');
});

test('a header set to null removes a default instead of sending "null"', () => {
  const headers = resolveProvider(jev({ headers: { Authorization: null, 'X-Api-Key': 'k' } })).buildHeaders('secret');
  assert.equal('Authorization' in headers, false);
  assert.equal(headers['X-Api-Key'], 'k');
});

test('a Jev answer is found however many envelopes a gateway wraps it in', () => {
  const answers = { answers: { q: { noul: 0.8 } } };
  assert.equal(unwrapPayload(answers), answers);
  assert.equal(unwrapPayload({ result: answers, success: true }), answers);
  assert.equal(unwrapPayload({ data: { result: answers } }), answers);
  assert.equal(unwrapPayload({ response: { output: answers } }), answers);
  // A gateway error envelope has no answers anywhere, and must not be mistaken for one.
  assert.equal(unwrapPayload({ success: false, errors: [{ code: 7000 }] }), null);
  assert.equal(unwrapPayload(null), null);
  assert.equal(unwrapPayload('text'), null);
});

test('an unreadable response is described without leaking its contents', () => {
  const described = describeUnknownPayload({ success: false, errors: [{ code: 7000, message: 'No route' }], secret: 'x' });
  assert.match(described, /success/);
  assert.match(described, /7000/);
  assert.ok(!described.includes('"x"'));
});

test('a 200 carrying no answers fails with the config keys to check', async () => {
  process.env.TYPESAFE_API_KEY = 'test-key';
  const stub = stubFetch(() => ({ success: false, errors: [{ code: 7000, message: 'No route for that URI' }] }));
  try {
    await assert.rejects(
      () => evaluateSemanticPredicates([{ id: 'q', question: 'q?' }], {}, jev({})),
      /returned no Jev answers.*routing\.jev\.endpoint/s,
    );
  } finally { stub.restore(); }
});

test('an answer inside a gateway envelope is parsed like a bare one', async () => {
  process.env.CLOUDFLARE_API_TOKEN = 'cf-key';
  const stub = stubFetch(() => ({ result: ANSWERS, success: true, errors: [] }));
  try {
    const config = jev({ provider: 'cloudflare', accountId: 'acc', model: '@typesafe/jev-1.13.0' });
    const result = await evaluateSemanticPredicates([{ id: 'q', question: 'q?' }], { subtask: 'x' }, config);
    assert.equal(result.answers.q.result, 'yes');
    assert.equal(result.answers.q.probability, 0.8);
    assert.equal(stub.calls[0].url, 'https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@typesafe/jev-1.13.0');
    assert.equal(stub.calls[0].headers.Authorization, 'Bearer cf-key');
  } finally { stub.restore(); }
});

test('the error names the provider that actually failed', async () => {
  process.env.AI_GATEWAY_API_KEY = 'v-key';
  const stub = stubFetch(() => ({ status: 404, text: 'not found' }));
  try {
    await assert.rejects(
      () => evaluateSemanticPredicates([{ id: 'q', question: 'q?' }], {}, jev({ provider: 'vercel', maxRetries: 1 })),
      /Vercel AI Gateway 404/,
    );
  } finally { stub.restore(); }
});

test('a missing key names the provider and the variable to set', async () => {
  const previous = process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_API_TOKEN;
  try {
    await assert.rejects(
      () => evaluateSemanticPredicates([{ id: 'q', question: 'q?' }], {}, jev({ provider: 'cloudflare', accountId: 'a' })),
      /Cloudflare Workers AI.*CLOUDFLARE_API_TOKEN/s,
    );
  } finally {
    if (previous !== undefined) process.env.CLOUDFLARE_API_TOKEN = previous;
  }
});

test('an unknown provider is rejected at config load, not at dispatch time', () => {
  assert.throws(() => testConfig({ routing: { jev: { provider: 'made-up' } } }), /routing\.jev\.provider/);
  assert.throws(
    () => testConfig({ routing: { mode: 'policy-graph', jev: { provider: 'cloudflare' } } }),
    /accountId/,
  );
});

test('a fixed-tier experiment needs no working provider at all', () => {
  // Arm A makes no routing calls, so an unconfigured gateway must not block it.
  const config = testConfig({ routing: { mode: 'fixed-high', jev: { provider: 'custom' } } });
  assert.equal(config.routing.mode, 'fixed');
});
