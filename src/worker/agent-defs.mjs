import fs from 'node:fs';
import path from 'node:path';
import { pluginRoot } from '../util/paths.mjs';

/**
 * Worker agent definitions.
 *
 * The agent markdown files in `agents/` are the worker system prompts. They are
 * passed to each worker process inline via `--agents` rather than relied on being
 * installed, for three reasons: the worker resolves its agent whether or not the
 * plugin is installed in that directory; nothing else from the plugin is loaded
 * into the worker, so it cannot reach back through the delegate MCP tool; and the
 * definition the worker ran under is the one this repository holds, which matters
 * when the telemetry is going to be compared across runs.
 *
 * The model always comes from configuration, never from the file's frontmatter, so
 * that tier-to-model policy stays in one place.
 */

/** Split YAML frontmatter from a markdown body. Frontmatter here is flat key: value. */
export function parseAgentFile(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { frontmatter: {}, body: text.trim() };
  const frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const entry = /^([A-Za-z_][\w.]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!entry) continue;
    const [, key, rawValue] = entry;
    let value = rawValue.trim().replace(/^["'](.*)["']$/, '$1');
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (/^\d+$/.test(value)) value = Number(value);
    frontmatter[key] = value;
  }
  return { frontmatter, body: match[2].trim() };
}

const cache = new Map();

export function loadAgentDefinition(agentName) {
  if (cache.has(agentName)) return cache.get(agentName);
  const file = path.join(pluginRoot, 'agents', `${agentName}.md`);
  if (!fs.existsSync(file)) {
    cache.set(agentName, null);
    return null;
  }
  const parsed = parseAgentFile(fs.readFileSync(file, 'utf8'));
  cache.set(agentName, parsed);
  return parsed;
}

const csv = (value) =>
  typeof value === 'string' ? value.split(',').map((item) => item.trim()).filter(Boolean) : undefined;

/**
 * Build the `--agents` payload for a worker, or null when the agent is not one of
 * ours — in which case the worker falls back to resolving `--agent` by name, which
 * is how a user points a tier at an agent they installed themselves.
 */
export function inlineAgentSpec(worker) {
  const definition = loadAgentDefinition(worker.agent);
  if (!definition) return null;

  const spec = {
    description: definition.frontmatter.description ?? `jev-dispatch ${worker.agent}`,
    prompt: definition.body,
    // Configuration wins over the file: the file describes how the worker behaves,
    // the config decides which model serves the tier.
    model: worker.model ?? definition.frontmatter.model,
  };
  const tools = worker.allowedTools?.length ? worker.allowedTools : csv(definition.frontmatter.tools);
  if (tools?.length) spec.tools = tools;
  const disallowed = worker.disallowedTools?.length
    ? worker.disallowedTools
    : csv(definition.frontmatter.disallowedTools);
  if (disallowed?.length) spec.disallowedTools = disallowed;

  return { [worker.agent]: spec };
}
