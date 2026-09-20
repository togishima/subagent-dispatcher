import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pluginOption, pluginOptionOverrides, resolveApiKey } from '../src/config/plugin-options.mjs';
import { resolveProvider, PROVIDERS } from '../src/router/providers.mjs';
import { workerEnv } from '../src/worker/run.mjs';
import { workerForTier, loadConfig } from '../src/config/load.mjs';
import { selectedEngineName } from '../src/router/engines/index.mjs';
import { testConfig } from './helpers.mjs';

/** Set CLAUDE_PLUGIN_OPTION_* for the duration of one test. */
function withOptions(options, fn) {
  const names = Object.keys(options).map((key) => `CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`);
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const [key, value] of Object.entries(options)) {
    process.env[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`] = value;
  }
  try {
    return fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('the manifest asks for what a first run actually needs', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'));
  const options = manifest.userConfig;
  assert.ok(options, 'plugin.json must declare userConfig, or nothing is ever asked');
  assert.deepEqual(Object.keys(options).sort(),
    ['jev_account_id', 'jev_api_key', 'jev_endpoint', 'jev_provider', 'semantic_evaluator']);

  // The credential must be masked and kept out of settings.json.
  assert.equal(options.jev_api_key.sensitive, true);
  // Nothing is required: the fixed-tier baseline arms make no routing calls, and
  // a plugin that refuses to install without a key would block them.
  for (const option of Object.values(options)) {
    assert.notEqual(option.required, true);
    assert.ok(option.title && option.description, 'every prompt needs a label and help text');
  }
  assert.deepEqual(options.jev_provider.options, ['typesafe', 'cloudflare', 'vercel', 'passthrough', 'custom']);
  assert.deepEqual(options.semantic_evaluator.options, ['jev', 'laya', 'mock']);
  // No default: leaving the prompt alone must mean jev because the code says so,
  // not because the manifest keeps restating it on every run.
  assert.equal(options.semantic_evaluator.default, undefined);
});

test('the MCP server is handed the answers under the names the code reads', () => {
  const servers = JSON.parse(fs.readFileSync(new URL('../mcp/servers.json', import.meta.url), 'utf8'));
  const env = servers.mcpServers['jev-dispatch'].env;
  for (const key of ['JEV_PROVIDER', 'JEV_API_KEY', 'JEV_ACCOUNT_ID', 'JEV_ENDPOINT', 'SEMANTIC_EVALUATOR']) {
    assert.equal(env[`CLAUDE_PLUGIN_OPTION_${key}`], `\${user_config.${key.toLowerCase()}}`);
  }
});

test('an unanswered option is not a value', () => {
  withOptions({ jev_api_key: '' }, () => assert.equal(pluginOption('jev_api_key'), undefined));
  withOptions({ jev_api_key: '   ' }, () => assert.equal(pluginOption('jev_api_key'), undefined));
  // If substitution never ran, the placeholder itself arrives. That is not a key.
  withOptions({ jev_api_key: '${user_config.jev_api_key}' }, () =>
    assert.equal(pluginOption('jev_api_key'), undefined));
  withOptions({ jev_api_key: ' real-key ' }, () => assert.equal(pluginOption('jev_api_key'), 'real-key'));
});

test('install answers become configuration', () => {
  withOptions({ jev_provider: 'cloudflare', jev_account_id: 'acct-1' }, () => {
    assert.deepEqual(pluginOptionOverrides(), { routing: { jev: { provider: 'cloudflare', accountId: 'acct-1' } } });
    const config = loadConfig({ reload: true });
    assert.equal(config.routing.jev.provider, 'cloudflare');
    assert.equal(resolveProvider(config.routing.jev).endpoint.includes('acct-1'), true);
    assert.ok(config.$sources.includes('plugin install options'));
  });
  assert.deepEqual(pluginOptionOverrides(), {});
  loadConfig({ reload: true });
});

test('the evaluator can be chosen at install, without touching a config file', () => {
  withOptions({ semantic_evaluator: 'laya' }, () => {
    assert.deepEqual(pluginOptionOverrides(), { routing: { semanticEvaluator: { provider: 'laya' } } });
    assert.equal(selectedEngineName(loadConfig({ reload: true })), 'laya');
  });
  // Unanswered, the engine is whatever the code falls back to, and the answer
  // contributes nothing to the configuration.
  assert.deepEqual(pluginOptionOverrides(), {});
  assert.equal(selectedEngineName(loadConfig({ reload: true })), 'jev');
});

test('a config file overrides what was answered at install', () => {
  withOptions({ jev_provider: 'cloudflare', jev_account_id: 'from-install' }, () => {
    const config = testConfig({ routing: { jev: { provider: 'vercel' } } });
    assert.equal(config.routing.jev.provider, 'vercel', 'the file is the later, more specific statement');
  });
  loadConfig({ reload: true });
});

test('the credential is found, and says where it came from', () => {
  const provider = resolveProvider({ provider: 'typesafe' });
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    assert.deepEqual(resolveApiKey(provider, {}), { key: null, source: null });

    withOptions({ jev_api_key: 'from-prompt' }, () => {
      const found = resolveApiKey(provider, {});
      assert.equal(found.key, 'from-prompt');
      assert.match(found.source, /entered when enabling the plugin/);
    });

    process.env.TYPESAFE_API_KEY = 'from-env';
    const fromEnv = resolveApiKey(provider, {});
    assert.equal(fromEnv.key, 'from-env');
    assert.match(fromEnv.source, /TYPESAFE_API_KEY/);

    // A variable named explicitly in the config file is the most specific of all.
    process.env.MY_OWN_KEY = 'from-named-var';
    withOptions({ jev_api_key: 'from-prompt' }, () => {
      const named = resolveApiKey(provider, { apiKeyEnv: 'MY_OWN_KEY' });
      assert.equal(named.key, 'from-named-var');
      assert.match(named.source, /named in config/);
    });
  } finally {
    if (saved === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = saved;
    delete process.env.MY_OWN_KEY;
  }
});

test('an install answer is chosen over a stale ambient variable', () => {
  const provider = resolveProvider({ provider: 'typesafe' });
  const saved = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'ambient';
  try {
    withOptions({ jev_api_key: 'answered-at-install' }, () => {
      assert.equal(resolveApiKey(provider, {}).key, 'answered-at-install');
    });
  } finally {
    if (saved === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = saved;
  }
});

test('no install answer reaches a worker, key or otherwise', () => {
  const config = testConfig();
  withOptions({ jev_api_key: 'secret', jev_provider: 'cloudflare', jev_account_id: 'acct' }, () => {
    const names = ['CLAUDE_PLUGIN_OPTION_JEV_API_KEY', 'CLAUDE_PLUGIN_OPTION_JEV_PROVIDER', 'CLAUDE_PLUGIN_OPTION_JEV_ACCOUNT_ID'];
    // Ask for them explicitly: the allowlist must not be the only thing stopping this.
    const env = workerEnv({ ...workerForTier(config, 'low'), passEnv: ['PATH', ...names] }, config);
    for (const name of names) assert.equal(env[name], undefined, `${name} leaked to the worker`);
    assert.ok(env.PATH);
  });
});

test('every provider key variable is still stripped from a worker', () => {
  const config = testConfig();
  const keyVars = [...new Set(Object.values(PROVIDERS).map((provider) => provider.apiKeyEnv))];
  const saved = Object.fromEntries(keyVars.map((name) => [name, process.env[name]]));
  for (const name of keyVars) process.env[name] = 'secret';
  try {
    const env = workerEnv({ ...workerForTier(config, 'low'), passEnv: ['PATH', ...keyVars] }, config);
    for (const name of keyVars) assert.equal(env[name], undefined, name);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
