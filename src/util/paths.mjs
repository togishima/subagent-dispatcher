import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Plugin root: the directory holding .claude-plugin/, agents/, src/ ... */
export const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT
  ? path.resolve(process.env.CLAUDE_PLUGIN_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Where user-owned state lives. ${CLAUDE_PLUGIN_DATA} survives plugin updates,
 * so prefer it; fall back to ~/.jev-dispatch for standalone runs.
 */
export const dataDir = process.env.JEV_DISPATCH_DATA_DIR
  ? path.resolve(process.env.JEV_DISPATCH_DATA_DIR)
  : process.env.CLAUDE_PLUGIN_DATA
    ? path.join(path.resolve(process.env.CLAUDE_PLUGIN_DATA), 'jev-dispatch')
    : path.join(homedir(), '.jev-dispatch');

export const defaultConfigPath = path.join(pluginRoot, 'config', 'default.json');
export const uiDir = path.join(pluginRoot, 'ui');

/** Candidate user config files, in precedence order. */
export function userConfigCandidates() {
  if (process.env.JEV_DISPATCH_CONFIG) return [path.resolve(process.env.JEV_DISPATCH_CONFIG)];
  const names = ['config.json', 'config.yaml', 'config.yml'];
  const dirs = [dataDir, path.join(homedir(), '.jev-dispatch')];
  const seen = new Set();
  const out = [];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (!seen.has(candidate)) { seen.add(candidate); out.push(candidate); }
    }
  }
  return out;
}

export function dbPath(config) {
  if (process.env.JEV_DISPATCH_DB_PATH) return path.resolve(process.env.JEV_DISPATCH_DB_PATH);
  if (config?.telemetry?.dbPath) return path.resolve(config.telemetry.dbPath);
  return path.join(dataDir, 'telemetry.db');
}
