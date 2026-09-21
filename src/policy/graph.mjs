import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from '../util/yaml.mjs';
import { pluginRoot } from '../util/paths.mjs';
import { PREDICATES } from './predicates.mjs';
import { policyOptions } from './compat.mjs';

/**
 * A decision policy is a small decision graph held as data, not code. Each node
 * asks one boolean question — deterministic (ordinary code) or semantic (Jev) —
 * and each branch either jumps to another node or names a terminal value.
 *
 * This is deliberately not a general rule or DAG engine: nodes are boolean, edges
 * are `yes`/`no`, the graph must be acyclic, and traversal is a plain loop.
 */

export function resolvePolicyPath(options) {
  const { path: configured, configDir } = policyOptions(options);
  if (path.isAbsolute(configured)) return configured;
  // Resolve relative to the user's config directory first, then the plugin.
  const candidates = [
    configDir ? path.join(configDir, configured) : null,
    path.join(pluginRoot, configured),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[candidates.length - 1];
}

export function loadPolicy(options) {
  options = policyOptions(options);
  const inline = options.graph;
  if (inline) return validatePolicy(inline, options, '<inline>');
  const file = resolvePolicyPath(options);
  let raw;
  try {
    const text = fs.readFileSync(file, 'utf8');
    raw = /\.ya?ml$/i.test(file) ? parseYaml(text) : JSON.parse(text);
  } catch (error) {
    throw new Error(`failed to read routing policy ${file}: ${error.message}`);
  }
  const policy = validatePolicy(raw, options, file);
  policy.$source = file;
  return policy;
}

const BRANCHES = ['yes', 'no'];

export function validatePolicy(raw, options, source = '<inline>') {
  const problems = [];
  const { values, fallback: defaultFallback } = policyOptions(options) ?? {};
  if (!Array.isArray(values) || values.length === 0
      || values.some((value) => typeof value !== 'string' || value === '')
      || new Set(values).size !== values.length) {
    throw new Error('policy values must be a non-empty ordered list of unique non-empty strings');
  }
  const valueOrder = new Map(values.map((value, index) => [value, index]));
  const fallback = raw.fallback ?? raw.fallbackTier ?? defaultFallback;

  if (typeof raw.version !== 'string' || raw.version === '') problems.push('version must be a non-empty string');
  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) problems.push('nodes must be a non-empty array');

  const nodes = new Map();
  const terminalKeys = new WeakMap();
  for (const node of raw.nodes ?? []) {
    if (typeof node.id !== 'string' || node.id === '') { problems.push('every node needs a string id'); continue; }
    if (nodes.has(node.id)) problems.push(`duplicate node id "${node.id}"`);
    const normalized = { ...node };
    for (const branch of BRANCHES) {
      const edge = node[branch];
      if (!edge || typeof edge !== 'object') continue;
      const { tier, ...canonical } = edge;
      terminalKeys.set(canonical, edge.value === undefined && tier !== undefined ? 'tier' : 'value');
      if (tier !== undefined && canonical.value !== undefined && tier !== canonical.value) {
        problems.push(`node "${node.id}".${branch}: value and tier aliases disagree`);
      }
      if (canonical.value === undefined && tier !== undefined) canonical.value = tier;
      normalized[branch] = canonical;
    }
    nodes.set(node.id, normalized);
  }

  if (!valueOrder.has(fallback)) {
    problems.push(`fallback "${fallback}" must be an explicitly defined value`);
  }
  if (raw.fallback !== undefined && raw.fallbackTier !== undefined
      && raw.fallback !== raw.fallbackTier) {
    problems.push('fallback and fallbackTier aliases disagree');
  }
  const entry = raw.entry ?? raw.nodes?.[0]?.id;
  if (!nodes.has(entry)) problems.push(`entry "${entry}" is not a node`);

  for (const node of nodes.values()) {
    if (node.type === 'semantic') {
      if (typeof node.question !== 'string' || node.question.trim() === '') {
        problems.push(`node "${node.id}": semantic nodes need a question`);
      }
      if (node.onUncertain && !BRANCHES.includes(node.onUncertain)) {
        problems.push(`node "${node.id}": onUncertain must be "yes" or "no"`);
      }
    } else if (node.type === 'deterministic') {
      if (!PREDICATES[node.predicate]) {
        problems.push(`node "${node.id}": unknown deterministic predicate "${node.predicate}"`);
      }
    } else {
      problems.push(`node "${node.id}": type must be "semantic" or "deterministic"`);
    }

    for (const branch of BRANCHES) {
      const edge = node[branch];
      if (!edge || typeof edge !== 'object') { problems.push(`node "${node.id}": missing "${branch}" branch`); continue; }
      const hasGoto = typeof edge.goto === 'string';
      const hasValue = typeof edge.value === 'string';
      if (hasGoto === hasValue) {
        problems.push(`node "${node.id}".${branch} must set exactly one of "goto" or "value"`);
      }
      if (hasGoto && !nodes.has(edge.goto)) {
        problems.push(`node "${node.id}".${branch}.goto "${edge.goto}" is not a node`);
      }
      if (hasValue && !valueOrder.has(edge.value)) {
        const key = terminalKeys.get(edge);
        problems.push(`node "${node.id}".${branch}.${key} "${edge.value}" is not a defined ${key}`);
      }
    }
  }

  if (problems.length === 0) {
    problems.push(...findCycles(nodes, entry));
    problems.push(...findUnreachable(nodes, entry));
  }

  const policy = {
    version: raw.version,
    description: raw.description ?? '',
    entry,
    fallback,
    get fallbackTier() { return this.fallback; }, // Compatibility alias for the legacy CLI.
    nodes,
    source,
  };

  if (problems.length === 0) {
    // Pre-compute the safer branch of every semantic node so traversal never has
    // to reason about the graph, and so an ambiguous policy fails at load time
    // rather than silently under-routing at 3am.
    for (const node of nodes.values()) {
      if (node.type !== 'semantic') continue;
      const derived = saferBranch(policy, node, valueOrder);
      if (node.onUncertain) {
        node.$safer = node.onUncertain;
        node.$saferSource = 'declared';
      } else if (derived) {
        node.$safer = derived;
        node.$saferSource = 'derived';
      } else {
        problems.push(
          `node "${node.id}": both branches reach the same value range, so the safer branch cannot be derived — set "onUncertain" explicitly`,
        );
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`Invalid routing policy (${source}):\n  - ${problems.join('\n  - ')}`);
  }
  return policy;
}

function findCycles(nodes, entry) {
  const state = new Map();
  const problems = [];
  const walk = (id, trail) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'open') {
      problems.push(`cycle in policy graph: ${[...trail, id].join(' -> ')}`);
      return;
    }
    state.set(id, 'open');
    const node = nodes.get(id);
    for (const branch of BRANCHES) {
      const next = node?.[branch]?.goto;
      if (next) walk(next, [...trail, id]);
    }
    state.set(id, 'done');
  };
  walk(entry, []);
  return problems;
}

function findUnreachable(nodes, entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length > 0) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const node = nodes.get(id);
    for (const branch of BRANCHES) {
      const next = node?.[branch]?.goto;
      if (next) stack.push(next);
    }
  }
  return [...nodes.keys()]
    .filter((id) => !seen.has(id))
    .map((id) => `node "${id}" is unreachable from entry`);
}

/** The value range a branch can end at, as [minOrder, maxOrder]. */
function reachableRange(policy, edge, valueOrder, seen = new Set()) {
  if (edge.value) {
    const order = valueOrder.get(edge.value);
    return [order, order];
  }
  if (seen.has(edge.goto)) return [Infinity, -Infinity];
  seen.add(edge.goto);
  const node = policy.nodes.get(edge.goto);
  let min = Infinity;
  let max = -Infinity;
  for (const branch of BRANCHES) {
    const [innerMin, innerMax] = reachableRange(policy, node[branch], valueOrder, seen);
    min = Math.min(min, innerMin);
    max = Math.max(max, innerMax);
  }
  return [min, max];
}

/**
 * Which branch over-routes? The one whose reachable values have strictly higher indexes.
 * Returns null when the two branches are indistinguishable, so the policy author
 * has to say which way to fall.
 */
export function saferBranch(policy, node, valueOrder) {
  const [yesMin, yesMax] = reachableRange(policy, node.yes, valueOrder);
  const [noMin, noMax] = reachableRange(policy, node.no, valueOrder);
  if (yesMin !== noMin) return yesMin > noMin ? 'yes' : 'no';
  if (yesMax !== noMax) return yesMax > noMax ? 'yes' : 'no';
  return null;
}

/** Every semantic node in the graph, in declaration order. */
export function semanticNodes(policy) {
  return [...policy.nodes.values()].filter((node) => node.type === 'semantic');
}
