import { spawn } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pluginRoot } from '../../util/paths.mjs';
import { log } from '../../util/log.mjs';
import { normalizeResult, normalizeAnswer, EvaluatorError } from './index.mjs';

/**
 * Laya as a semantic decision engine: the same boolean predicates as Jev,
 * answered by a ~300–400M model running locally on Apple silicon.
 *
 * Laya has no server mode and its CLI reloads the model per invocation, so a
 * small persistent Python process holds the loaded model and answers over
 * stdio. The process starts on the first evaluation and lives as long as the
 * dispatcher does, which in practice is the session: model load once, many
 * routing evaluations, then exit with the parent.
 *
 * No inference is reimplemented here. This file starts a process, frames JSON,
 * and applies a timeout — the least it can be and still keep a model warm.
 */

/**
 * Laya's noul answers come back as a bare probability, where Jev returns an
 * object. Both spellings are accepted so a checkpoint that reports confidence
 * of its own is used, and one that reports only P(true) still works.
 */
export function readNoul(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { probability: value, confidence: undefined };
  }
  if (value && typeof value === 'object') {
    for (const key of ['noul', 'probability', 'p_true', 'value', 'score']) {
      const candidate = value[key];
      if (typeof candidate === 'number' && Number.isFinite(candidate)) {
        const confidence = typeof value.confidence === 'number' ? value.confidence : undefined;
        return { probability: candidate, confidence };
      }
    }
  }
  return null;
}

class LayaProcess {
  constructor(settings) {
    this.settings = settings;
    this.child = null;
    this.pending = new Map();
    this.buffer = '';
    this.ready = null;
    this.info = null;
  }

  /** Start the process and wait for its ready line, at most once concurrently. */
  start() {
    if (this.ready) return this.ready;

    this.ready = new Promise((resolve, reject) => {
      const script = this.settings.script ?? path.join(pluginRoot, 'runtime', 'laya_server.py');
      const command = this.settings.python ?? 'python3';
      const child = spawn(command, [script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          LAYA_MODEL: this.settings.model,
          LAYA_RUNTIME: this.settings.runtime,
          LAYA_DTYPE: this.settings.dtype,
        },
      });
      this.child = child;

      const startTimer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new EvaluatorError(
          `laya did not become ready within ${this.settings.startupTimeoutMs}ms (model load can be slow on a cold cache)`,
          { provider: 'laya' },
        ));
      }, this.settings.startupTimeoutMs);

      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        if (stderr.length > 8000) stderr = stderr.slice(-8000);
      });

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        this.buffer += chunk;
        let index;
        while ((index = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, index).trim();
          this.buffer = this.buffer.slice(index + 1);
          if (line === '') continue;
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (message.ready !== undefined) {
            clearTimeout(startTimer);
            if (!message.ready) {
              reject(new EvaluatorError(`laya failed to load its model: ${message.error}`, { provider: 'laya' }));
              return;
            }
            this.info = message;
            log.info('laya ready', {
              model: message.model, runtime: message.runtime,
              modelLoadMs: message.modelLoadMs, rssMiB: message.rssMiB,
            });
            resolve(message);
            continue;
          }
          const waiter = this.pending.get(message.id);
          if (waiter) {
            this.pending.delete(message.id);
            waiter.resolve(message);
          }
        }
      });

      const fail = (reason) => {
        clearTimeout(startTimer);
        const error = new EvaluatorError(reason, { provider: 'laya' });
        // Everything in flight fails with the same reason; the next evaluation
        // starts a fresh process rather than talking to a dead one.
        for (const waiter of this.pending.values()) waiter.reject(error);
        this.pending.clear();
        this.ready = null;
        this.child = null;
        this.info = null;
        reject(error);
      };

      child.on('error', (error) => fail(`could not start "${command}": ${error.message}`));
      child.on('exit', (code, signal) => {
        fail(`laya process exited (${signal ?? `code ${code}`})${stderr ? `: ${stderr.slice(-400)}` : ''}`);
      });
    });

    // A failed start must not be cached as a permanent failure.
    this.ready.catch(() => { this.ready = null; });
    return this.ready;
  }

  async request(payload, timeoutMs) {
    await this.start();
    const id = randomUUID();
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A timed-out model leaves the process in an unknown state; restarting
        // is cheaper to reason about than guessing whether it recovered.
        this.stop();
        reject(new EvaluatorError(`laya did not answer within ${timeoutMs}ms`, { provider: 'laya' }));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (message) => { clearTimeout(timer); resolve(message); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
    this.child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
    return response;
  }

  stop() {
    const child = this.child;
    this.ready = null;
    this.child = null;
    this.info = null;
    if (!child) return;
    child.removeAllListeners('exit');
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 2000).unref?.();
  }
}

const DEFAULTS = {
  model: 'aac6fef/laya-mlx',
  runtime: 'auto',
  dtype: 'float16',
  python: 'python3',
  script: null,
  timeoutMs: 5000,
  startupTimeoutMs: 120_000,
};

export function createLayaEngine(config, { processFactory } = {}) {
  const settings = { ...DEFAULTS, ...(config.routing.semanticEvaluator?.laya ?? {}) };
  const proc = processFactory ? processFactory(settings) : new LayaProcess(settings);

  return {
    name: 'laya',
    process: proc,

    describe() {
      return {
        provider: 'laya',
        model: settings.model,
        runtime: proc.info?.runtime ?? settings.runtime,
        local: true,
        // The whole point of a local engine: the routing state, including the
        // plan, is read by a model on this machine and goes nowhere else.
        dataLeavesMachine: false,
        modelLoadMs: proc.info?.modelLoadMs ?? null,
        rssMiB: proc.info?.rssMiB ?? null,
      };
    },

    stateOptions() {
      // Nothing is billed and nothing leaves the machine, so the plan is sent in
      // full unless the operator says otherwise.
      const laya = config.routing.semanticEvaluator?.laya ?? {};
      return { sendPlan: laya.sendPlan !== false, maxPlanChars: laya.maxPlanChars ?? 16_000 };
    },

    async evaluate({ state, predicates, signal }) {
      const questions = {};
      for (const node of predicates) {
        questions[node.id] = {
          type: 'noul',
          instructions: node.question,
          criteria: node.criteria ?? {
            true: 'The statement in the question holds for this subtask.',
            false: 'The statement in the question does not hold for this subtask.',
          },
        };
      }

      const started = Date.now();
      // One request carrying every predicate: Laya batches internally, and
      // asking once per predicate would forfeit that.
      const message = await proc.request({ op: 'evaluate', state, questions }, settings.timeoutMs);
      if (signal?.aborted) throw new EvaluatorError('aborted', { provider: 'laya' });
      if (!message.ok) throw new EvaluatorError(`laya: ${message.error}`, { provider: 'laya' });

      const answers = {};
      for (const node of predicates) {
        const parsed = readNoul(message.answers?.[node.id]);
        if (!parsed) {
          throw new EvaluatorError(
            `laya returned no usable answer for predicate "${node.id}"`,
            { provider: 'laya' },
          );
        }
        answers[node.id] = normalizeAnswer(parsed.probability, parsed.confidence);
      }

      return normalizeResult({
        answers,
        // The model's own timing when it reported it, the round trip otherwise.
        latencyMs: message.latencyMs ?? Date.now() - started,
        usage: message.usage ?? null,
        engine: 'laya',
        model: settings.model,
        metadata: {
          runtime: proc.info?.runtime ?? settings.runtime,
          predicateCount: predicates.length,
          batched: true,
          modelLoadMs: proc.info?.modelLoadMs ?? null,
          rssMiB: message.rssMiB ?? proc.info?.rssMiB ?? null,
          roundTripMs: Date.now() - started,
        },
      });
    },

    async close() {
      proc.stop();
    },
  };
}
