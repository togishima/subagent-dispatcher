import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { WORKER_OUTPUT_SCHEMA, buildWorkerPrompt, normalizeWorkerOutput } from './contract.mjs';
import { inlineAgentSpec } from './agent-defs.mjs';
import { snapshotWorktree, resolveChangedFiles } from './changed-files.mjs';
import { PROVIDERS } from '../router/providers.mjs';
import { log } from '../util/log.mjs';

/**
 * Worker execution.
 *
 * A worker is a short-lived `claude -p` process running one of this plugin's
 * agent definitions at the model its tier maps to. That reuses Claude Code's own
 * agent runtime rather than reimplementing one, and `--output-format json` hands
 * back exact per-invocation cost and token counts — including cache reads — so
 * worker spend is measured, not estimated.
 *
 * The worker gets no MCP servers and no Agent/Task tool, so it cannot recurse
 * back into delegate(), and it is handed a filtered environment so router
 * credentials never reach it.
 */

/** Build the child environment: an allowlist, minus anything secret to this plugin. */
export function workerEnv(worker, config) {
  const env = {};
  for (const key of worker.passEnv ?? []) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // The routing credential belongs to the router alone; a worker has no reason to
  // hold it. Every provider's variable is stripped, not just the configured one:
  // apiKeyEnv may be null (the provider supplies the default), and an operator
  // who switches providers should not have to remember to revisit this.
  for (const provider of Object.values(PROVIDERS)) delete env[provider.apiKeyEnv];
  if (config.routing.jev.apiKeyEnv) delete env[config.routing.jev.apiKeyEnv];
  // Install-time answers reach this process as CLAUDE_PLUGIN_OPTION_*, one of
  // which is the key itself. None of them is a worker's business.
  for (const name of Object.keys(env)) {
    if (name.startsWith('CLAUDE_PLUGIN_OPTION_')) delete env[name];
  }
  // Workers must not inherit the parent's telemetry export or session identity.
  env.CLAUDE_CODE_ENABLE_TELEMETRY = '0';
  env.JEV_DISPATCH_WORKER = '1';
  return env;
}

/**
 * Permission rules letting a worker run the very checks that will judge it.
 *
 * Without this a worker is told to verify its own work and then denied the
 * shell to do it with, so it reports blind and the first it hears of a mistake
 * is an escalation. The grant is exactly the configured check commands — the
 * ones the dispatcher is about to run anyway — and nothing else.
 */
export function verificationPermissions(worker, checks) {
  if (worker.allowVerificationCommands === false) return [];
  return [...new Set((checks ?? []).map((check) => check.command))]
    .filter((command) => typeof command === 'string' && command.trim() !== '')
    .map((command) => `Bash(${command.trim()})`);
}

export function buildClaudeArgs(worker, prompt, sessionId, checks = []) {
  const args = ['-p', prompt, '--output-format', 'json', '--session-id', sessionId];
  if (worker.agent) {
    const spec = inlineAgentSpec(worker);
    if (spec) args.push('--agents', JSON.stringify(spec));
    args.push('--agent', worker.agent);
  }
  if (worker.model) args.push('--model', worker.model);
  if (worker.maxTurns) args.push('--max-turns', String(worker.maxTurns));
  if (worker.permissionMode) args.push('--permission-mode', worker.permissionMode);
  args.push('--permission-prompts', 'none');
  const allowedTools = [...(worker.allowedTools ?? []), ...verificationPermissions(worker, checks)];
  if (allowedTools.length) args.push('--allowedTools', allowedTools.join(','));
  if (worker.disallowedTools?.length) args.push('--disallowedTools', worker.disallowedTools.join(','));
  if (worker.strictMcpConfig) args.push('--strict-mcp-config');
  if (worker.bare) args.push('--bare');
  args.push('--json-schema', JSON.stringify(WORKER_OUTPUT_SCHEMA));
  if (worker.extraArgs?.length) args.push(...worker.extraArgs);
  return args;
}

function spawnCollect(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 5000).unref?.();
        }, options.timeoutMs)
      : null;

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
    });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      resolve({ spawnError: error, stdout, stderr, code: null, timedOut });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
  });
}

const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** Pull the usage figures out of a `claude -p --output-format json` result. */
export function extractUsage(result) {
  const usage = result?.usage ?? {};
  return {
    costUsd: number(result?.total_cost_usd),
    inputTokens: number(usage.input_tokens),
    outputTokens: number(usage.output_tokens),
    cacheReadTokens: number(usage.cache_read_input_tokens),
    cacheCreationTokens: number(usage.cache_creation_input_tokens),
    numTurns: number(result?.num_turns),
    models: Object.keys(result?.modelUsage ?? {}),
  };
}

/** Run one worker attempt. Never throws: every failure comes back as a result. */
export async function runWorker({ worker, task, config, checks = [] }) {
  const started = Date.now();
  const prompt = buildWorkerPrompt(task);
  const sessionId = randomUUID();
  const base = {
    worker: worker.name,
    workerKind: worker.kind,
    workerModel: worker.model ?? null,
    workerSessionId: sessionId,
    startedAt: started,
  };

  if (worker.kind === 'command') {
    return runCommandWorker({ worker, task, prompt, base, config });
  }

  const args = buildClaudeArgs(worker, prompt, sessionId, checks);
  const command = process.env.JEV_DISPATCH_CLAUDE_BIN || 'claude';
  log.debug('spawning worker', { worker: worker.name, model: worker.model, agent: worker.agent, sessionId });

  const before = await snapshotWorktree(task.cwd);
  const run = await spawnCollect(command, args, {
    cwd: task.cwd,
    env: workerEnv(worker, config),
    timeoutMs: worker.timeoutMs,
  });
  const durationMs = Date.now() - started;

  if (run.spawnError) {
    return {
      ...base,
      durationMs,
      processError: `could not start "${command}": ${run.spawnError.message}`,
      output: normalizeWorkerOutput(null, ''),
      usage: extractUsage(null),
      exitCode: null,
      timedOut: false,
    };
  }
  if (run.timedOut) {
    return {
      ...base,
      durationMs,
      processError: `worker exceeded its ${worker.timeoutMs}ms time budget`,
      timedOut: true,
      output: normalizeWorkerOutput(null, ''),
      usage: extractUsage(null),
      exitCode: run.code,
    };
  }

  let result = null;
  try {
    result = JSON.parse(run.stdout.trim().split('\n').filter(Boolean).pop() ?? '');
  } catch {
    // fall through: handled as a process error below
  }

  if (!result) {
    return {
      ...base,
      durationMs,
      processError: `worker produced no parseable JSON result (exit ${run.code}): ${run.stderr.slice(-500) || run.stdout.slice(-500)}`,
      output: normalizeWorkerOutput(null, ''),
      usage: extractUsage(null),
      exitCode: run.code,
      timedOut: false,
    };
  }

  const output = normalizeWorkerOutput(result.structured_output, result.result);
  if (result.is_error) {
    output.status = 'failed';
    if (result.result) output.blockers.push(String(result.result).slice(0, 400));
  }

  // Prefer what git observed over what the worker claimed.
  const changed = await resolveChangedFiles({ cwd: task.cwd, before, reported: output.changedFiles });
  output.changedFiles = changed.files ?? output.changedFiles;
  output.changedFilesSource = changed.source;

  return {
    ...base,
    durationMs,
    exitCode: run.code,
    timedOut: false,
    apiErrorStatus: result.api_error_status ?? null,
    permissionDenials: (result.permission_denials ?? []).length,
    output,
    usage: extractUsage(result),
    processError: null,
  };
}

/**
 * A worker that is an arbitrary command rather than a Claude Code agent. This is
 * the seam for a local model or another CLI: the prompt arrives on stdin, and a
 * JSON object matching the worker contract is expected on stdout.
 */
async function runCommandWorker({ worker, task, prompt, base, config }) {
  const [command, ...args] = worker.command;
  const child = spawn(command, args, {
    cwd: task.cwd,
    env: { ...workerEnv(worker, config), JEV_DISPATCH_PROMPT_BYTES: String(Buffer.byteLength(prompt)) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(prompt);

  const collected = await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const timer = worker.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), worker.timeoutMs) : null;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { if (timer) clearTimeout(timer); resolve({ stdout, stderr, spawnError: error }); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ stdout, stderr, code }); });
  });

  const durationMs = Date.now() - base.startedAt;
  if (collected.spawnError) {
    return {
      ...base,
      durationMs,
      processError: `could not start "${command}": ${collected.spawnError.message}`,
      output: normalizeWorkerOutput(null, ''),
      usage: extractUsage(null),
      exitCode: null,
      timedOut: false,
    };
  }
  return {
    ...base,
    durationMs,
    exitCode: collected.code,
    timedOut: false,
    output: normalizeWorkerOutput(null, collected.stdout),
    // A command worker reports its own cost if it can; otherwise spend is unknown.
    usage: extractUsage(null),
    processError: collected.code === 0 ? null : `worker exited ${collected.code}: ${collected.stderr.slice(-400)}`,
  };
}
