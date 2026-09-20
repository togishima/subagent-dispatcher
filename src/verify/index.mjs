import { spawn } from 'node:child_process';
import { log } from '../util/log.mjs';

/**
 * Verification. A worker saying "done" is not evidence, so a dispatch is judged
 * by deterministic checks wherever any exist: tests, lint, typecheck, build, or a
 * task-specific command.
 *
 * Verdicts are PASS / FAIL / UNCERTAIN / SKIPPED. UNCERTAIN is a real outcome,
 * not a soft pass: it means nothing could judge the work, and it is recorded so
 * the experiment can separate "verified good" from "nobody checked".
 */

export const VERDICT = { PASS: 'PASS', FAIL: 'FAIL', UNCERTAIN: 'UNCERTAIN', SKIPPED: 'SKIPPED' };

/** Does this configured check apply to this task? */
export function checkApplies(check, task) {
  const when = check.when ?? 'always';
  if (when === 'always' || when == null) return true;
  if (typeof when !== 'object') return false;

  if (Array.isArray(when.taskTypeIn)) {
    if (!task.taskType || !when.taskTypeIn.includes(task.taskType)) return false;
  }
  if (when.changedFilesMatch) {
    const files = task.changedFiles ?? task.contextFiles ?? [];
    // A regex, not a glob: no glob engine is worth the dependency here.
    let pattern;
    try {
      pattern = new RegExp(when.changedFilesMatch);
    } catch {
      return false;
    }
    if (!files.some((file) => pattern.test(file))) return false;
  }
  return true;
}

/**
 * The checks that would judge this task. Used both to verify and — before any
 * worker runs — to answer the `verification_available` policy predicate.
 */
export function applicableChecks(config, task) {
  const checks = [];
  if (!config.verification.enabled) return checks;

  if (task.verification?.command) {
    if (config.verification.allowInlineCommands) {
      checks.push({ name: task.verification.name ?? 'task-check', command: task.verification.command, source: 'task' });
    } else {
      log.warn('ignoring caller-supplied verification command', {
        reason: 'verification.allowInlineCommands is false',
      });
    }
  }
  for (const check of config.verification.checks ?? []) {
    if (checkApplies(check, task)) checks.push({ ...check, source: 'config' });
  }
  return checks;
}

function runCheck(check, task, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(check.command, {
      shell: true,
      cwd: check.cwd ?? task.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, check.timeoutMs ?? timeoutMs);

    const append = (chunk) => {
      output += chunk;
      if (output.length > 32_000) output = output.slice(-32_000);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ name: check.name, exitCode: null, durationMs: Date.now() - started, output: error.message, runnable: false, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // 127 is the shell's "command not found": the check never ran, so it cannot
      // be evidence that the work is wrong.
      const runnable = code !== 127 && !timedOut;
      resolve({ name: check.name, exitCode: code, durationMs: Date.now() - started, output, runnable, timedOut });
    });
  });
}

/** Run every applicable check and reduce them to one verdict. */
export async function verify(config, task) {
  if (!config.verification.enabled) {
    return { verdict: VERDICT.SKIPPED, checks: [], reason: 'verification disabled' };
  }
  const checks = applicableChecks(config, task);
  if (checks.length === 0) {
    return { verdict: VERDICT.UNCERTAIN, checks: [], reason: 'no deterministic check applies to this task' };
  }

  const results = [];
  for (const check of checks) {
    const result = await runCheck(check, task, config.verification.timeoutMs);
    results.push({ ...result, command: check.name });
    // Stop at the first genuine failure: later checks add latency, not information.
    if (result.runnable && result.exitCode !== 0) break;
  }

  const unrunnable = results.filter((result) => !result.runnable);
  const failed = results.filter((result) => result.runnable && result.exitCode !== 0);

  if (failed.length > 0) {
    return { verdict: VERDICT.FAIL, checks: results, reason: `${failed[0].name} failed`, failedCheck: failed[0] };
  }
  if (unrunnable.length === results.length) {
    return {
      verdict: VERDICT.UNCERTAIN,
      checks: results,
      reason: `no check could run (${unrunnable[0].timedOut ? 'timed out' : 'command not found'})`,
      environmentProblem: true,
    };
  }
  return { verdict: VERDICT.PASS, checks: results, reason: `${results.length} check(s) passed` };
}

/** A short, non-secret summary of a verification run, safe to store and to show. */
export function summarizeVerification(verification) {
  return {
    verdict: verification.verdict,
    reason: verification.reason,
    checks: verification.checks.map((check) => ({
      name: check.name,
      exitCode: check.exitCode,
      durationMs: check.durationMs,
      timedOut: check.timedOut ?? false,
    })),
  };
}

/** The failing check's tail, for feeding the next attempt. Truncated, never stored raw. */
export function failureExcerpt(verification, limit = 2000) {
  const failed = verification.failedCheck ?? verification.checks.find((check) => check.exitCode !== 0);
  if (!failed?.output) return null;
  return `${failed.name} exited ${failed.exitCode}:\n${String(failed.output).slice(-limit)}`;
}
