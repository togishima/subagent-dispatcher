/**
 * Values collected by Claude Code when the plugin is enabled.
 *
 * `userConfig` in the plugin manifest makes Claude Code prompt for these at
 * install time, mask the API key, and keep it out of `settings.json` — which is
 * the right place for a credential to live, and a better first-run experience
 * than discovering from `doctor` that routing has been silently degrading.
 *
 * They arrive as `CLAUDE_PLUGIN_OPTION_<KEY>` in the environment of hooks, and
 * through `${user_config.*}` substitution for the MCP server, which the server
 * config maps onto the same names so there is only one set to read.
 */

const PREFIX = 'CLAUDE_PLUGIN_OPTION_';

/**
 * Read one install-time option. An option the user skipped can arrive as an
 * empty string, or — if substitution did not run — as the placeholder text
 * itself. Neither is a value.
 */
export function pluginOption(key) {
  const raw = process.env[`${PREFIX}${key.toUpperCase()}`];
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (value === '' || value.includes('${')) return undefined;
  return value;
}

/**
 * The install-time answers, as a partial configuration. This sits between the
 * shipped defaults and the user's config file: answering the prompt seeds the
 * setting, and editing the config file later overrides it.
 */
export function pluginOptionOverrides() {
  const overrides = {};
  const jev = {};

  const provider = pluginOption('jev_provider');
  if (provider) jev.provider = provider;
  const endpoint = pluginOption('jev_endpoint');
  if (endpoint) jev.endpoint = endpoint;
  const accountId = pluginOption('jev_account_id');
  if (accountId) jev.accountId = accountId;

  const mode = pluginOption('routing_mode');
  if (mode) overrides.mode = mode;

  // Which engine answers the policy graph's predicates. Left unanswered, the
  // code's own fallback decides, so nothing is written here.
  const evaluator = pluginOption('semantic_evaluator');
  if (evaluator) overrides.semanticEvaluator = { provider: evaluator };

  if (Object.keys(jev).length > 0) overrides.jev = jev;
  return Object.keys(overrides).length > 0 ? { routing: overrides } : {};
}

/**
 * Where the routing credential comes from, and from where.
 *
 * Precedence runs most-specific first: a variable the operator named in the
 * config file, then the install-time answer, then the provider's own default
 * variable. The source is returned alongside the key because "which key is it
 * using" is the question `doctor` exists to answer.
 */
export function resolveApiKey(provider, jevConfig = {}) {
  if (jevConfig.apiKeyEnv && process.env[jevConfig.apiKeyEnv]) {
    return { key: process.env[jevConfig.apiKeyEnv], source: `environment variable ${jevConfig.apiKeyEnv} (named in config)` };
  }
  const fromPrompt = pluginOption('jev_api_key');
  if (fromPrompt) return { key: fromPrompt, source: 'the key you entered when enabling the plugin' };
  if (process.env[provider.apiKeyEnv]) {
    return { key: process.env[provider.apiKeyEnv], source: `environment variable ${provider.apiKeyEnv}` };
  }
  return { key: null, source: null };
}
