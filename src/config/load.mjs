import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from './yaml.mjs';
import { defaultConfigPath, userConfigCandidates } from '../util/paths.mjs';
import { PROVIDERS, providerNames, resolveProvider } from '../router/providers.mjs';
import { pluginOptionOverrides } from './plugin-options.mjs';
import { engineNames, selectedEngineName } from '../router/engines/index.mjs';
import { log } from '../util/log.mjs';

export const ROUTING_MODES = [
  'policy-graph',
  'jev-direct',
  'fixed-low',
  'fixed-medium',
  'fixed-high',
  'fixed',
];

/** Spellings accepted in config that resolve to a canonical router name. */
const MODE_ALIASES = { jev: 'jev-direct', 'jev-tier': 'jev-direct', policy: 'policy-graph' };
export const FAILURE_REASONS = [
  'CAPABILITY_FAILURE',
  'SPEC_FAILURE',
  'ENVIRONMENT_FAILURE',
  'VERIFICATION_FAILURE',
  'UNKNOWN',
];

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Deep-merge `override` onto `base`. Arrays replace wholesale, objects merge. */
export function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

function readConfigFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (/\.ya?ml$/i.test(file)) return parseYaml(text);
  return JSON.parse(text);
}

/**
 * Turn the routing mode into an explicit router selection. `fixed-<tier>` is
 * sugar for `mode: fixed, fixedTier: <tier>`, which is what the spec's baseline
 * configuration uses; both spellings resolve to the same router.
 */
function normalizeRouting(routing) {
  const out = { ...routing };
  const mode = String(out.mode ?? '');
  const match = /^fixed-(.+)$/.exec(mode);
  if (match) {
    out.mode = 'fixed';
    out.fixedTier = match[1];
  } else if (MODE_ALIASES[mode]) {
    out.mode = MODE_ALIASES[mode];
  }
  // A confidence policy written at the old top level still applies to jev-direct.
  if (out.confidencePolicy && !routing.jevDirect?.confidencePolicy) {
    out.jevDirect = { ...out.jevDirect, confidencePolicy: out.confidencePolicy };
  }
  return out;
}

function validate(config) {
  const problems = [];
  const tiers = config.tiers ?? {};
  const tierNames = Object.keys(tiers);

  if (tierNames.length === 0) problems.push('tiers: at least one tier must be defined');
  for (const [name, tier] of Object.entries(tiers)) {
    if (!Number.isFinite(tier.order)) problems.push(`tiers.${name}.order must be a number`);
    if (typeof tier.worker !== 'string' || tier.worker === '') {
      problems.push(`tiers.${name}.worker must name a worker`);
    } else if (!config.workers?.[tier.worker]) {
      problems.push(`tiers.${name}.worker "${tier.worker}" is not defined under workers`);
    }
  }
  const orders = Object.values(tiers).map((tier) => tier.order);
  if (new Set(orders).size !== orders.length) problems.push('tiers: order values must be unique');

  for (const [name, worker] of Object.entries(config.workers ?? {})) {
    if (worker.kind === 'command') {
      if (!Array.isArray(worker.command) || worker.command.length === 0) {
        problems.push(`workers.${name}.command must be a non-empty argv array for kind "command"`);
      }
    } else if (worker.kind === 'claude-agent' || worker.kind === undefined) {
      if (typeof worker.model !== 'string' || worker.model === '') {
        problems.push(`workers.${name}.model must be a model name or alias`);
      }
    } else {
      problems.push(`workers.${name}.kind "${worker.kind}" is not supported (use "claude-agent" or "command")`);
    }
  }

  const { mode, fixedTier, fallbackTierOnRouterError } = config.routing ?? {};
  if (!['policy-graph', 'jev-direct', 'fixed'].includes(mode)) {
    problems.push(`routing.mode must be one of ${ROUTING_MODES.join(', ')}`);
  }
  if (mode === 'fixed' && !tiers[fixedTier]) {
    problems.push(`routing.fixedTier "${fixedTier}" is not a defined tier`);
  }
  if (fallbackTierOnRouterError && !tiers[fallbackTierOnRouterError]) {
    problems.push(`routing.fallbackTierOnRouterError "${fallbackTierOnRouterError}" is not a defined tier`);
  }
  const confidencePolicy = config.routing?.jevDirect?.confidencePolicy;
  if (confidencePolicy?.enabled) {
    const { minMaxProbability, floorTier } = confidencePolicy;
    if (!(minMaxProbability >= 0 && minMaxProbability <= 1)) {
      problems.push('routing.jevDirect.confidencePolicy.minMaxProbability must be between 0 and 1');
    }
    if (!tiers[floorTier]) {
      problems.push(`routing.jevDirect.confidencePolicy.floorTier "${floorTier}" is not a defined tier`);
    }
  }

  const evaluator = selectedEngineName(config);
  if (!engineNames().includes(evaluator)) {
    problems.push(`routing.semanticEvaluator.provider must be one of ${engineNames().join(', ')}`);
  }

  // Resolving the provider here means a bad endpoint or a missing accountId is
  // reported at startup rather than on the first delegation. Only the arms that
  // actually call Jev need it: policy-graph may be answered by another engine.
  const jev = config.routing?.jev ?? {};
  const usesJev = mode === 'jev-direct' || (mode === 'policy-graph' && evaluator === 'jev');
  if (jev.provider && !PROVIDERS[jev.provider]) {
    problems.push(`routing.jev.provider must be one of ${providerNames().join(', ')}`);
  } else if (usesJev) {
    try {
      resolveProvider(jev);
    } catch (error) {
      problems.push(error.message);
    }
  }
  if (jev.headers && typeof jev.headers !== 'object') {
    problems.push('routing.jev.headers must be an object of header names to values');
  }

  const briefCheck = config.contract?.briefCheck ?? 'advise';
  if (!['off', 'advise', 'enforce'].includes(briefCheck)) {
    problems.push('contract.briefCheck must be "off", "advise" or "enforce"');
  }

  const policyGraph = config.routing?.policyGraph ?? {};
  const { defaultMinConfidence } = policyGraph;
  if (!(defaultMinConfidence >= 0 && defaultMinConfidence <= 1)) {
    problems.push('routing.policyGraph.defaultMinConfidence must be between 0 and 1');
  }
  if (!(policyGraph.maxTraversalSteps >= 1)) {
    problems.push('routing.policyGraph.maxTraversalSteps must be >= 1');
  }
  if (!['safer-branch', 'fallback-tier'].includes(policyGraph.onEvaluatorUnavailable)) {
    problems.push('routing.policyGraph.onEvaluatorUnavailable must be "safer-branch" or "fallback-tier"');
  }
  if (mode === 'policy-graph' && !policyGraph.path && !policyGraph.graph) {
    problems.push('routing.policyGraph needs either a "path" to a policy file or an inline "graph"');
  }

  const escalation = config.escalation ?? {};
  if (!(escalation.maxAttemptsPerTask >= 1)) problems.push('escalation.maxAttemptsPerTask must be >= 1');
  for (const key of ['escalateOn', 'retrySameTierOn']) {
    for (const reason of escalation[key] ?? []) {
      if (!FAILURE_REASONS.includes(reason)) {
        problems.push(`escalation.${key} contains unknown failure reason "${reason}"`);
      }
    }
  }

  for (const check of config.verification?.checks ?? []) {
    if (typeof check.name !== 'string' || check.name === '') problems.push('verification.checks[].name is required');
    if (typeof check.command !== 'string' || check.command === '') {
      problems.push(`verification.checks[${check.name}].command is required`);
    }
  }

  // The UI must never leave the loopback interface. This is a hard refusal, not
  // a default, so no configuration file can accidentally publish the dashboard.
  const host = config.ui?.host;
  if (!isLoopback(host)) {
    problems.push(`ui.host "${host}" is not a loopback address; jev-dispatch only binds 127.0.0.1, ::1 or localhost`);
  }

  if (problems.length > 0) {
    throw new Error(`Invalid jev-dispatch configuration:\n  - ${problems.join('\n  - ')}`);
  }
  return config;
}

export function isLoopback(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/** Tier names ordered weakest → strongest. */
export function orderedTiers(config) {
  return Object.entries(config.tiers)
    .sort((a, b) => a[1].order - b[1].order)
    .map(([name]) => name);
}

export function tierAbove(config, tier) {
  const ordered = orderedTiers(config);
  const index = ordered.indexOf(tier);
  if (index === -1 || index === ordered.length - 1) return null;
  return ordered[index + 1];
}

/** Resolve the worker definition (with defaults folded in) for a tier. */
export function workerForTier(config, tier) {
  const tierConfig = config.tiers[tier];
  if (!tierConfig) throw new Error(`unknown tier "${tier}"`);
  const worker = config.workers[tierConfig.worker];
  return {
    name: tierConfig.worker,
    kind: worker.kind ?? 'claude-agent',
    ...config.workerDefaults,
    ...worker,
  };
}

let cached = null;

export function loadConfig({ reload = false } = {}) {
  if (cached && !reload) return cached;
  const base = JSON.parse(fs.readFileSync(defaultConfigPath, 'utf8'));
  delete base.$comment;

  // Answers given when the plugin was enabled seed the configuration; a config
  // file written later still overrides them.
  let merged = base;
  const sources = [];
  const fromInstall = pluginOptionOverrides();
  if (Object.keys(fromInstall).length > 0) {
    merged = deepMerge(merged, fromInstall);
    sources.push('plugin install options');
  }
  for (const candidate of userConfigCandidates()) {
    if (!fs.existsSync(candidate)) continue;
    try {
      merged = deepMerge(merged, readConfigFile(candidate));
      sources.push(candidate);
    } catch (error) {
      throw new Error(`failed to read config ${candidate}: ${error.message}`);
    }
    break; // first match wins
  }

  // Env overrides let a single experiment run be re-pointed without editing files.
  if (process.env.JEV_DISPATCH_ROUTING_MODE) {
    merged = deepMerge(merged, { routing: { mode: process.env.JEV_DISPATCH_ROUTING_MODE } });
    sources.push('env:JEV_DISPATCH_ROUTING_MODE');
  }
  if (process.env.JEV_DISPATCH_UI_PORT) {
    merged = deepMerge(merged, { ui: { port: Number(process.env.JEV_DISPATCH_UI_PORT) } });
  }

  merged.routing = normalizeRouting(merged.routing);
  const config = validate(merged);
  config.$sources = sources;
  config.$configDir = sources.length > 0 && !sources[0].startsWith('env:') ? path.dirname(sources[0]) : null;
  log.debug('config loaded', { sources, mode: config.routing.mode });
  cached = config;
  return config;
}
