import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dbPath } from '../util/paths.mjs';
import { log } from '../util/log.mjs';
import {
  safeFailureDetail,
  safeVerificationDetail,
  sanitizeTitle,
  taskHash,
  rawTaskIfEnabled,
} from './privacy.mjs';

const SCHEMA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');
const SCHEMA_VERSION = '2';

const bool = (value) => (value ? 1 : 0);
const json = (value) => (value == null ? null : JSON.stringify(value));

/**
 * Local-first telemetry store: one SQLite file, no external services, no network.
 * Built on node:sqlite so the whole plugin stays dependency-free.
 */
export class TelemetryStore {
  constructor(config, file = dbPath(config), { prune = true } = {}) {
    this.config = config;
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    this.migrate();
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('schema_version', SCHEMA_VERSION);
    // Pruning scans the whole table, so short-lived openers (the per-subagent
    // hook) skip it and leave retention to session boundaries.
    if (prune) this.pruneOldData();
  }

  close() {
    try { this.db.close(); } catch { /* already closed */ }
  }

  /**
   * Additive migrations.
   *
   * CREATE TABLE IF NOT EXISTS leaves an existing table alone, so a database
   * written by an earlier version has the old columns and none of the new ones.
   * Adding them here — and only ever adding — means an old database opens and
   * keeps its rows, which matters because those rows are experiment results.
   */
  migrate() {
    const columns = new Set(this.db.prepare('PRAGMA table_info(dispatches)').all().map((row) => row.name));
    const additions = [
      ['evaluator_provider', 'TEXT'],
      ['evaluator_model', 'TEXT'],
      ['evaluator_latency_ms', 'INTEGER'],
      ['evaluator_input_tokens', 'INTEGER DEFAULT 0'],
      ['evaluator_output_tokens', 'INTEGER DEFAULT 0'],
      ['evaluator_metadata', 'TEXT'],
    ].filter(([name]) => !columns.has(name));

    for (const [name, type] of additions) {
      this.db.exec(`ALTER TABLE dispatches ADD COLUMN ${name} ${type}`);
    }
    // After the columns exist, never in schema.sql: on an existing database
    // CREATE TABLE IF NOT EXISTS is a no-op, so an index over a new column
    // would be asked for before the column was there.
    this.db.exec('CREATE INDEX IF NOT EXISTS dispatches_evaluator ON dispatches(evaluator_provider, policy_version)');
    if (additions.length > 0) {
      // Rows written before the rename came from Jev; say so rather than leaving
      // them unattributed and uncomparable.
      //
      // Identified by evaluator_provider IS NULL rather than by COALESCE on each
      // field: ALTER TABLE gives existing rows the column's DEFAULT, so the token
      // columns arrive as 0 rather than NULL and COALESCE would keep the zero.
      this.db.exec(
        `UPDATE dispatches SET
           evaluator_provider = CASE WHEN router = 'jev-direct' THEN 'jev-direct'
                                     WHEN router = 'policy-graph' THEN 'jev' END,
           evaluator_latency_ms = jev_latency_ms,
           evaluator_input_tokens = jev_input_tokens,
           evaluator_output_tokens = jev_output_tokens
         WHERE evaluator_provider IS NULL AND router IN ('policy-graph', 'jev-direct')`,
      );
      log.info('telemetry schema migrated', { added: additions.map(([name]) => name) });
    }
  }

  /** Drop rows older than the retention window. Runs at open, like otel-agent. */
  pruneOldData() {
    const days = this.config.telemetry.retentionDays;
    if (!(days > 0)) return;
    const cutoff = Date.now() - days * 86_400_000;
    const stale = this.db.prepare('SELECT task_id FROM delegations WHERE created_at < ?').all(cutoff);
    this.db.exec('BEGIN');
    try {
      for (const { task_id: taskId } of stale) {
        for (const table of ['dispatches', 'predicate_evaluations', 'executions', 'escalations']) {
          this.db.prepare(`DELETE FROM ${table} WHERE task_id = ?`).run(taskId);
        }
        this.db.prepare('DELETE FROM delegations WHERE task_id = ?').run(taskId);
      }
      this.db.prepare('DELETE FROM subagent_events WHERE ts < ?').run(cutoff);
      this.db.prepare('DELETE FROM sessions WHERE started_at < ? AND ended_at IS NOT NULL').run(cutoff);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      log.warn('retention prune failed', { error: error.message });
    }
    if (stale.length > 0) log.debug('pruned old delegations', { count: stale.length, days });
  }

  // ------------------------------------------------------------------ sessions

  recordSessionStart({ sessionId, model, cwd }) {
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, started_at, model, cwd, routing_mode, policy_version)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET model = excluded.model, cwd = excluded.cwd`,
      )
      .run(sessionId, Date.now(), model ?? null, cwd ?? null, this.config.routing.mode, null);
  }

  recordSessionEnd(sessionId) {
    this.db.prepare('UPDATE sessions SET ended_at = ? WHERE session_id = ?').run(Date.now(), sessionId);
  }

  recordSubagentEvent({ sessionId, agentId, agentType, event }) {
    this.db
      .prepare('INSERT INTO subagent_events (ts, session_id, agent_id, agent_type, event) VALUES (?, ?, ?, ?, ?)')
      .run(Date.now(), sessionId ?? null, agentId ?? null, agentType ?? null, event);
  }

  // --------------------------------------------------------------- delegations

  openDelegation({ taskId, sessionId, task, taskType, specification, verificationAvailable }) {
    // Specification signals are counts and flags, never the plan text itself.
    const spec = specification ?? {};
    this.db
      .prepare(
        `INSERT INTO delegations (
           task_id, created_at, session_id, routing_mode, task_hash, title, task_type,
           has_plan, plan_chars, plan_document_count, has_acceptance_criteria,
           has_edit_sites, has_constraints, fully_specified, verification_available, raw_task
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        taskId,
        Date.now(),
        sessionId ?? null,
        this.config.routing.mode,
        taskHash(task),
        sanitizeTitle(task, this.config),
        taskType ?? null,
        bool(spec.hasPlan),
        spec.planChars ?? 0,
        spec.planDocumentCount ?? 0,
        bool(spec.hasAcceptanceCriteria),
        bool(spec.hasEditSites),
        bool(spec.hasConstraints),
        bool(spec.hasPlan && spec.hasEditSites && (spec.hasAcceptanceCriteria || spec.hasExpectedOutput)),
        bool(verificationAvailable),
        rawTaskIfEnabled(task, this.config),
      );
  }

  /** Record a routing decision and its full predicate traversal. Returns dispatch id. */
  recordDispatch({ taskId, attempt, sessionId, decision, resolved, previousTier }) {
    // Read the evaluator from the one place that holds it. The router also
    // exposes flattened aliases for convenience, but anything else that builds a
    // decision — the seeder, a future replay — would have to remember to set
    // them, and a forgotten alias shows up as a silently empty column.
    const evaluator = decision.evaluator ?? null;
    const evaluatorLatencyMs = evaluator?.latencyMs ?? decision.evaluatorLatencyMs ?? null;
    const evaluatorUsage = evaluator?.usage ?? decision.evaluatorUsage ?? null;
    const info = this.db
      .prepare(
        `INSERT INTO dispatches (
           task_id, attempt, created_at, session_id, router, routing_mode, policy_version,
           required_tier, selected_tier, selected_worker, worker_model, previous_tier, policy_reason,
           confidence, probabilities, traversal_path, routing_latency_ms,
           jev_latency_ms, jev_input_tokens, jev_output_tokens,
           evaluator_provider, evaluator_model, evaluator_latency_ms,
           evaluator_input_tokens, evaluator_output_tokens, evaluator_metadata,
           degraded, router_error
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        taskId,
        attempt,
        Date.now(),
        sessionId ?? null,
        decision.router,
        this.config.routing.mode,
        decision.policyVersion,
        decision.requiredTier,
        resolved.selectedTier,
        resolved.worker.name,
        resolved.worker.model ?? null,
        previousTier ?? null,
        resolved.policyReason ?? null,
        decision.confidence,
        json(decision.probabilities),
        json(decision.trail.map((step) => ({ node: step.nodeId, branch: step.branch, tier: step.tier }))),
        decision.routingLatencyMs,
        // jev_* still written so a reader on schema 1 sees the same numbers.
        evaluatorLatencyMs,
        evaluatorUsage?.input_tokens ?? 0,
        evaluatorUsage?.output_tokens ?? 0,
        evaluator?.engine ?? null,
        evaluator?.model ?? null,
        evaluatorLatencyMs,
        evaluatorUsage?.input_tokens ?? 0,
        evaluatorUsage?.output_tokens ?? 0,
        json(evaluator?.metadata ?? null),
        bool(decision.degraded),
        safeFailureDetail(decision.error),
      );
    const dispatchId = Number(info.lastInsertRowid);

    // Every predicate the router evaluated, used or not.
    const insert = this.db.prepare(
      `INSERT INTO predicate_evaluations (
         task_id, attempt, dispatch_id, policy_version, node_id, type, predicate,
         result, answered, confidence, probabilities, threshold, used, uncertain, order_index, branch_tier
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const usedByNode = new Map(decision.trail.map((step) => [step.nodeId, step]));

    for (const step of decision.trail) {
      insert.run(
        taskId, attempt, dispatchId, decision.policyVersion, step.nodeId, step.type, step.predicate ?? null,
        step.result ?? null, step.answered ?? null, step.confidence, json(step.probabilities),
        step.threshold ?? null, 1, bool(step.uncertain), step.order ?? null, step.tier ?? null,
      );
    }
    for (const evaluation of decision.semanticEvaluations) {
      if (usedByNode.has(evaluation.nodeId)) continue;
      insert.run(
        taskId, attempt, dispatchId, decision.policyVersion, evaluation.nodeId, 'semantic', null,
        null, evaluation.result, evaluation.confidence, json(evaluation.probabilities),
        null, 0, 0, null, null,
      );
    }
    return dispatchId;
  }

  recordExecution({ taskId, attempt, dispatchId, tier, execution, verification, outcome }) {
    this.db
      .prepare(
        `INSERT INTO executions (
           task_id, attempt, dispatch_id, started_at, duration_ms, tier, worker, worker_kind,
           worker_model, worker_session_id, status, success, num_turns, schema_honoured,
           self_report_mismatch, verification_verdict, verification_detail, failure_reason,
           failure_detail, changed_files_count, exit_code, timed_out,
           cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        taskId, attempt, dispatchId, execution.startedAt, execution.durationMs, tier,
        execution.worker, execution.workerKind, execution.workerModel, execution.workerSessionId,
        execution.output.status, bool(outcome.success), execution.usage.numTurns,
        bool(execution.output.schemaHonoured), bool(outcome.selfReportMismatch),
        verification.verdict, safeVerificationDetail(verification), outcome.failureReason,
        safeFailureDetail(outcome.detail), execution.output.changedFiles.length,
        execution.exitCode, bool(execution.timedOut),
        execution.usage.costUsd, execution.usage.inputTokens, execution.usage.outputTokens,
        execution.usage.cacheReadTokens, execution.usage.cacheCreationTokens,
      );
  }

  recordEscalation({ taskId, fromTier, toTier, reason, attempt, policyVersion }) {
    this.db
      .prepare(
        'INSERT INTO escalations (task_id, created_at, from_tier, to_tier, reason, attempt, policy_version) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(taskId, Date.now(), fromTier, toTier, reason, attempt, policyVersion ?? null);
  }

  /** Close out a delegation by rolling up its attempts. */
  closeDelegation({ taskId, summary }) {
    const rollup = this.db
      .prepare(
        `SELECT COUNT(*) AS attempts,
                COALESCE(SUM(cost_usd), 0) AS cost,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cache_read_tokens), 0) AS cache_read,
                COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation
         FROM executions WHERE task_id = ?`,
      )
      .get(taskId);
    const routing = this.db
      .prepare(
        `SELECT COALESCE(SUM(evaluator_input_tokens), 0) AS jev_in,
                COALESCE(SUM(evaluator_output_tokens), 0) AS jev_out,
                COALESCE(SUM(routing_latency_ms), 0) AS latency,
                MIN(attempt) AS first_attempt
         FROM dispatches WHERE task_id = ?`,
      )
      .get(taskId);
    const firstDispatch = this.db
      .prepare('SELECT selected_tier, router, policy_version FROM dispatches WHERE task_id = ? ORDER BY attempt ASC LIMIT 1')
      .get(taskId);

    this.db
      .prepare(
        `UPDATE delegations SET
           finished_at = ?, policy_version = ?, router = ?, attempt_count = ?,
           first_route_tier = ?, final_tier = ?, final_worker = ?, first_route_success = ?,
           final_status = ?, final_success = ?, unverified = ?, escalated = ?, frontier_used = ?,
           final_failure_reason = ?,
           total_cost_usd = ?, total_input_tokens = ?, total_output_tokens = ?,
           total_cache_read_tokens = ?, total_cache_creation_tokens = ?,
           routing_input_tokens = ?, routing_output_tokens = ?, routing_latency_ms = ?
         WHERE task_id = ?`,
      )
      .run(
        Date.now(), firstDispatch?.policy_version ?? null, firstDispatch?.router ?? null, rollup.attempts,
        firstDispatch?.selected_tier ?? null, summary.finalTier, summary.finalWorker,
        bool(summary.firstRouteSuccess), summary.status, bool(summary.success),
        bool(summary.unverified), bool(summary.escalated), bool(summary.frontierUsed),
        summary.failureReason ?? null,
        rollup.cost, rollup.input_tokens, rollup.output_tokens, rollup.cache_read, rollup.cache_creation,
        routing.jev_in, routing.jev_out, routing.latency,
        taskId,
      );
  }

  // ---------------------------------------------------------------------- otel

  /** Upsert a cumulative OTel counter observation, keeping the highest value seen. */
  recordOtelCounter({ metric, sessionId, model, querySource, tokenType, agentName, value }) {
    const key = [metric, sessionId ?? '', model ?? '', querySource ?? '', tokenType ?? '', agentName ?? ''].join('|');
    this.db
      .prepare(
        `INSERT INTO otel_counters (key, ts, session_id, model, query_source, metric, token_type, agent_name, value)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET ts = excluded.ts, value = MAX(otel_counters.value, excluded.value)`,
      )
      .run(key, Date.now(), sessionId ?? null, model ?? null, querySource ?? null, metric, tokenType ?? null, agentName ?? null, value);
  }

  query(sql, params = []) {
    return this.db.prepare(sql).all(...params);
  }

  queryOne(sql, params = []) {
    return this.db.prepare(sql).get(...params);
  }
}

let shared = null;

export function openStore(config) {
  if (!shared) shared = new TelemetryStore(config);
  return shared;
}
