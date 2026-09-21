import { orderedTiers } from '../config/load.mjs';

/**
 * Read-only analytics over the telemetry store. These are the experiment's
 * metrics: every number the dashboard shows comes from here, so the CLI, the MCP
 * status tool and the UI cannot disagree about what a rate means.
 */

const ratio = (numerator, denominator) => (denominator > 0 ? numerator / denominator : null);

/** An optional time window, on a named table alias so joined queries can use it. */
function windowClause(sinceMs, column = 'created_at') {
  return sinceMs ? { sql: ` AND ${column} >= ?`, params: [sinceMs] } : { sql: '', params: [] };
}

/** Only finished delegations are scored; an in-flight one has no outcome yet. */
const FINISHED = 'finished_at IS NOT NULL';

export function overview(store, { since = null, policyVersion = null, mode = null } = {}) {
  const filters = [FINISHED];
  const params = [];
  if (since) { filters.push('created_at >= ?'); params.push(since); }
  if (policyVersion) { filters.push('policy_version = ?'); params.push(policyVersion); }
  if (mode) { filters.push('routing_mode = ?'); params.push(mode); }
  const where = `WHERE ${filters.join(' AND ')}`;

  const totals = store.queryOne(
    `SELECT COUNT(*) AS delegations,
            SUM(final_success) AS successes,
            SUM(first_route_success) AS first_route_successes,
            SUM(escalated) AS escalations,
            SUM(frontier_used) AS frontier_invocations,
            SUM(unverified) AS unverified,
            AVG(attempt_count) AS avg_attempts,
            COALESCE(SUM(total_cost_usd), 0) AS total_cost,
            COALESCE(SUM(routing_input_tokens), 0) AS routing_input_tokens,
            AVG(routing_latency_ms) AS avg_routing_latency_ms
     FROM delegations ${where}`,
    params,
  );

  const tierRows = store.query(
    `SELECT final_tier AS tier, COUNT(*) AS n,
            SUM(final_success) AS successes,
            COALESCE(SUM(total_cost_usd), 0) AS cost
     FROM delegations ${where} AND final_tier IS NOT NULL
     GROUP BY final_tier`,
    params,
  );
  const firstTierRows = store.query(
    `SELECT first_route_tier AS tier, COUNT(*) AS n
     FROM delegations ${where} AND first_route_tier IS NOT NULL
     GROUP BY first_route_tier`,
    params,
  );

  const total = totals.delegations ?? 0;
  const topTier = orderedTiers(store.config).at(-1);

  // An empirical counterfactual rather than a hardcoded price table: what a
  // delegation costs at the top tier is measured from the top-tier runs this
  // database has actually observed.
  const frontierBaseline = store.queryOne(
    `SELECT AVG(total_cost_usd) AS avg_cost, COUNT(*) AS n
     FROM delegations WHERE ${FINISHED} AND final_success = 1 AND final_tier = ?`,
    [topTier],
  );
  const avoided = store.queryOne(
    `SELECT COUNT(*) AS n, COALESCE(SUM(total_cost_usd), 0) AS cost
     FROM delegations ${where} AND final_success = 1 AND frontier_used = 0`,
    params,
  );
  const estimatedFrontierAvoidedUsd =
    frontierBaseline?.n > 0 && avoided.n > 0
      ? avoided.n * frontierBaseline.avg_cost - avoided.cost
      : null;

  return {
    delegations: total,
    taskSuccessRate: ratio(totals.successes ?? 0, total),
    firstRouteSuccessRate: ratio(totals.first_route_successes ?? 0, total),
    escalationRate: ratio(totals.escalations ?? 0, total),
    frontierInvocationRate: ratio(totals.frontier_invocations ?? 0, total),
    unverifiedRate: ratio(totals.unverified ?? 0, total),
    averageAttemptsPerTask: totals.avg_attempts ?? null,
    totalCostUsd: totals.total_cost ?? 0,
    costPerSuccessfulDelegation: ratio(totals.total_cost ?? 0, totals.successes ?? 0),
    averageRoutingLatencyMs: totals.avg_routing_latency_ms ?? null,
    routingInputTokens: totals.routing_input_tokens ?? 0,
    estimatedFrontierAvoidedUsd,
    frontierBaselineCostUsd: frontierBaseline?.n > 0 ? frontierBaseline.avg_cost : null,
    frontierBaselineSamples: frontierBaseline?.n ?? 0,
    tierDistribution: distribution(tierRows, store),
    firstRouteTierDistribution: distribution(firstTierRows, store),
  };
}

function distribution(rows, store) {
  const byTier = new Map(rows.map((row) => [row.tier, row]));
  const total = rows.reduce((sum, row) => sum + row.n, 0);
  return orderedTiers(store.config).map((tier) => {
    const row = byTier.get(tier);
    return {
      tier,
      count: row?.n ?? 0,
      share: total > 0 ? (row?.n ?? 0) / total : 0,
      successRate: row ? ratio(row.successes, row.n) : null,
      costUsd: row?.cost ?? 0,
    };
  });
}

/** Dispatch history, newest first, with every attempt of each task. */
export function timeline(store, { limit = 50, since = null } = {}) {
  const win = windowClause(since);
  const tasks = store.query(
    `SELECT task_id, created_at, finished_at, title, task_type, routing_mode, policy_version,
            attempt_count, first_route_tier, final_tier, final_status, final_success,
            escalated, unverified, final_failure_reason, total_cost_usd
     FROM delegations WHERE 1 = 1${win.sql}
     ORDER BY created_at DESC LIMIT ?`,
    [...win.params, limit],
  );
  if (tasks.length === 0) return [];

  const ids = tasks.map((task) => task.task_id);
  const placeholders = ids.map(() => '?').join(',');
  const attempts = store.query(
    `SELECT e.task_id, e.attempt, e.tier, e.worker, e.duration_ms, e.status, e.success,
            e.verification_verdict, e.failure_reason, e.cost_usd,
            d.required_tier, d.policy_reason, d.confidence, d.degraded, d.routing_latency_ms
     FROM executions e
     LEFT JOIN dispatches d ON d.task_id = e.task_id AND d.attempt = e.attempt
     WHERE e.task_id IN (${placeholders})
     ORDER BY e.attempt ASC`,
    ids,
  );
  const byTask = new Map(ids.map((id) => [id, []]));
  for (const attempt of attempts) byTask.get(attempt.task_id)?.push(attempt);
  return tasks.map((task) => ({ ...task, attempts: byTask.get(task.task_id) ?? [] }));
}

export function taskDetail(store, taskId) {
  const delegation = store.queryOne('SELECT * FROM delegations WHERE task_id = ?', [taskId]);
  if (!delegation) return null;
  return {
    delegation,
    dispatches: store.query('SELECT * FROM dispatches WHERE task_id = ? ORDER BY attempt', [taskId]),
    predicates: store.query(
      'SELECT * FROM predicate_evaluations WHERE task_id = ? ORDER BY attempt, used DESC, order_index',
      [taskId],
    ),
    executions: store.query('SELECT * FROM executions WHERE task_id = ? ORDER BY attempt', [taskId]),
    escalations: store.query('SELECT * FROM escalations WHERE task_id = ? ORDER BY attempt', [taskId]),
  };
}

const CONFIDENCE_BUCKETS = [
  { label: '0.95–1.00', min: 0.95, max: 1.01 },
  { label: '0.80–0.95', min: 0.8, max: 0.95 },
  { label: '0.60–0.80', min: 0.6, max: 0.8 },
  { label: '< 0.60', min: 0, max: 0.6 },
];

/**
 * Confidence against outcome. The confidence of a policy-graph route is the
 * weakest semantic link on the path that decided it, which is the number a
 * threshold policy would act on.
 */
export function confidenceView(store, { since = null } = {}) {
  const win = windowClause(since, 'g.created_at');
  const rows = store.query(
    `SELECT d.confidence AS confidence, g.final_success, g.first_route_success, g.escalated
     FROM dispatches d
     JOIN delegations g ON g.task_id = d.task_id
     WHERE d.attempt = 1 AND d.confidence IS NOT NULL AND g.finished_at IS NOT NULL${win.sql}`,
    win.params,
  );
  return CONFIDENCE_BUCKETS.map((bucket) => {
    const inBucket = rows.filter((row) => row.confidence >= bucket.min && row.confidence < bucket.max);
    return {
      bucket: bucket.label,
      count: inBucket.length,
      firstRouteSuccessRate: ratio(inBucket.filter((row) => row.first_route_success).length, inBucket.length),
      escalationRate: ratio(inBucket.filter((row) => row.escalated).length, inBucket.length),
      taskSuccessRate: ratio(inBucket.filter((row) => row.final_success).length, inBucket.length),
    };
  });
}

/** Per-worker and per-tier performance. */
export function workerView(store, { since = null } = {}) {
  const win = since ? ' AND e.started_at >= ?' : '';
  const params = since ? [since] : [];
  const rows = store.query(
    `SELECT e.worker, e.tier, e.worker_model,
            COUNT(*) AS invocations,
            SUM(e.success) AS successes,
            SUM(CASE WHEN e.attempt = 1 THEN 1 ELSE 0 END) AS first_attempts,
            SUM(CASE WHEN e.attempt = 1 AND e.success = 1 THEN 1 ELSE 0 END) AS first_attempt_successes,
            AVG(e.duration_ms) AS avg_duration_ms,
            AVG(e.cost_usd) AS avg_cost_usd,
            COALESCE(SUM(e.cost_usd), 0) AS total_cost_usd,
            COALESCE(SUM(e.input_tokens), 0) AS input_tokens,
            COALESCE(SUM(e.output_tokens), 0) AS output_tokens,
            COALESCE(SUM(e.cache_read_tokens), 0) AS cache_read_tokens,
            COALESCE(SUM(e.cache_creation_tokens), 0) AS cache_creation_tokens
     FROM executions e WHERE 1 = 1${win}
     GROUP BY e.worker, e.tier, e.worker_model
     ORDER BY e.tier`,
    params,
  );
  const escalatedFrom = store.query(
    'SELECT from_tier AS tier, COUNT(*) AS n FROM escalations GROUP BY from_tier',
  );
  const escalatedTo = store.query('SELECT to_tier AS tier, COUNT(*) AS n FROM escalations GROUP BY to_tier');
  const fromByTier = new Map(escalatedFrom.map((row) => [row.tier, row.n]));
  const toByTier = new Map(escalatedTo.map((row) => [row.tier, row.n]));

  return rows.map((row) => ({
    ...row,
    successRate: ratio(row.successes, row.invocations),
    firstAttemptSuccessRate: ratio(row.first_attempt_successes, row.first_attempts),
    escalatedFrom: fromByTier.get(row.tier) ?? 0,
    escalatedTo: toByTier.get(row.tier) ?? 0,
  }));
}

/**
 * Policy effectiveness: how each predicate behaves and what happens downstream of
 * the branches it takes. This is the view that says whether a policy is earning
 * its keep — a predicate that never fires, or whose branches have identical
 * outcomes, is not doing any routing.
 */
export function policyView(store, { policyVersion = null } = {}) {
  const versionFilter = policyVersion ? ' AND p.policy_version = ?' : '';
  const params = policyVersion ? [policyVersion] : [];

  const predicates = store.query(
    `SELECT p.policy_version, p.node_id, p.type, p.predicate,
            COUNT(*) AS evaluations,
            SUM(p.used) AS used,
            SUM(CASE WHEN p.used = 1 AND p.result = 'yes' THEN 1 ELSE 0 END) AS yes_used,
            SUM(CASE WHEN p.used = 1 AND p.result = 'no'  THEN 1 ELSE 0 END) AS no_used,
            SUM(p.uncertain) AS uncertain,
            AVG(p.confidence) AS avg_confidence,
            MIN(p.confidence) AS min_confidence
     FROM predicate_evaluations p
     WHERE 1 = 1${versionFilter}
     GROUP BY p.policy_version, p.node_id, p.type, p.predicate
     ORDER BY used DESC`,
    params,
  );

  // Outcome of every branch actually taken, so a branch can be judged by results.
  const branches = store.query(
    `SELECT p.policy_version, p.node_id, p.result AS branch,
            COUNT(*) AS n,
            SUM(g.final_success) AS successes,
            SUM(g.escalated) AS escalations,
            SUM(g.frontier_used) AS frontier,
            AVG(g.total_cost_usd) AS avg_cost
     FROM predicate_evaluations p
     JOIN delegations g ON g.task_id = p.task_id
     WHERE p.used = 1 AND p.attempt = 1 AND g.finished_at IS NOT NULL${versionFilter}
     GROUP BY p.policy_version, p.node_id, p.result`,
    params,
  );

  const branchesByNode = new Map();
  for (const row of branches) {
    const key = `${row.policy_version}|${row.node_id}`;
    if (!branchesByNode.has(key)) branchesByNode.set(key, []);
    branchesByNode.get(key).push({
      branch: row.branch,
      count: row.n,
      successRate: ratio(row.successes, row.n),
      escalationRate: ratio(row.escalations, row.n),
      frontierRate: ratio(row.frontier, row.n),
      averageCostUsd: row.avg_cost,
    });
  }

  const totalRouted = store.queryOne(
    `SELECT COUNT(*) AS n FROM delegations WHERE ${FINISHED}${policyVersion ? ' AND policy_version = ?' : ''}`,
    params,
  );
  const topTier = orderedTiers(store.config).at(-1);
  const expensive = store.queryOne(
    `SELECT COUNT(*) AS n FROM delegations
     WHERE ${FINISHED} AND first_route_tier = ?${policyVersion ? ' AND policy_version = ?' : ''}`,
    [topTier, ...params],
  );

  return {
    predicates: predicates.map((row) => ({
      ...row,
      fireRate: ratio(row.used, row.evaluations),
      uncertainRate: ratio(row.uncertain, row.used),
      branches: branchesByNode.get(`${row.policy_version}|${row.node_id}`) ?? [],
    })),
    expensiveBranchShare: ratio(expensive?.n ?? 0, totalRouted?.n ?? 0),
    expensiveBranchTier: topTier,
  };
}

/**
 * Policy comparison. The experiment's answer lives in this table: one row per
 * arm, so fixed-high, jev-direct and policy-graph are scored identically.
 */
export function policyComparison(store) {
  const rows = store.query(
    `SELECT routing_mode, COALESCE(policy_version, '—') AS policy_version, router,
            COUNT(*) AS delegations,
            AVG(final_success) AS task_success_rate,
            AVG(first_route_success) AS first_route_success_rate,
            AVG(escalated) AS escalation_rate,
            AVG(frontier_used) AS frontier_invocation_rate,
            AVG(unverified) AS unverified_rate,
            AVG(attempt_count) AS avg_attempts,
            COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd,
            AVG(total_cost_usd) AS avg_cost_usd,
            AVG(routing_latency_ms) AS avg_routing_latency_ms,
            SUM(final_success) AS successes
     FROM delegations WHERE ${FINISHED}
     GROUP BY routing_mode, policy_version, router
     ORDER BY delegations DESC`,
  );
  return rows.map((row) => ({
    ...row,
    costPerSuccess: ratio(row.total_cost_usd, row.successes),
  }));
}

/**
 * Cache and cost, split between the main session and subagents.
 *
 * Main-session figures come from Claude Code's own OTel counters, where the
 * `query_source` attribute separates main from subagent. Worker figures come from
 * each worker's own result payload. The KPI is the main session's cache read
 * ratio: the hypothesis is that delegating leaves it high.
 */
export function cacheCostView(store) {
  const counters = store.query(
    `SELECT metric, query_source, token_type, model, session_id, value
     FROM otel_counters ORDER BY metric, query_source`,
  );

  const sum = (predicate) =>
    counters.filter(predicate).reduce((total, row) => total + (row.value ?? 0), 0);

  const bySource = (source) => {
    const tokens = {
      input: sum((row) => row.metric === 'token' && row.query_source === source && row.token_type === 'input'),
      output: sum((row) => row.metric === 'token' && row.query_source === source && row.token_type === 'output'),
      cacheRead: sum((row) => row.metric === 'token' && row.query_source === source && row.token_type === 'cacheRead'),
      cacheCreation: sum((row) => row.metric === 'token' && row.query_source === source && row.token_type === 'cacheCreation'),
    };
    const readable = tokens.input + tokens.cacheRead + tokens.cacheCreation;
    return {
      source,
      ...tokens,
      costUsd: sum((row) => row.metric === 'cost' && row.query_source === source),
      cacheReadRatio: readable > 0 ? tokens.cacheRead / readable : null,
      models: [...new Set(counters.filter((row) => row.query_source === source && row.model).map((row) => row.model))],
    };
  };

  const workers = store.query(
    `SELECT worker, worker_model,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
            COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
            COALESCE(SUM(cost_usd), 0) AS cost_usd,
            COUNT(*) AS invocations
     FROM executions GROUP BY worker, worker_model ORDER BY cost_usd DESC`,
  );

  const mainSessions = store.query(
    `SELECT session_id, model, started_at, ended_at FROM sessions ORDER BY started_at DESC LIMIT 20`,
  );

  return {
    otelAvailable: counters.length > 0,
    main: bySource('main'),
    subagent: bySource('subagent'),
    auxiliary: bySource('auxiliary'),
    workers,
    sessions: mainSessions,
    nativeSubagents: store.query(
      `SELECT agent_type, event, COUNT(*) AS n FROM subagent_events GROUP BY agent_type, event ORDER BY n DESC LIMIT 20`,
    ),
  };
}

export function policyVersionsSeen(store) {
  return store
    .query('SELECT DISTINCT policy_version FROM delegations WHERE policy_version IS NOT NULL ORDER BY policy_version')
    .map((row) => row.policy_version);
}

/**
 * The dataset for offline policy authoring.
 *
 * Runtime routing and policy improvement are deliberately separate: a frontier
 * model designs the policy graph once, offline, from this export; it never runs
 * in the routing path. Every row is one delegation with the traversal that
 * produced it and the outcome that followed, which is what a policy needs to be
 * re-scored against decisions it did not make.
 *
 * Task text is not included — only the hash and, if the operator kept them, the
 * sanitized title.
 */
export function exportForPolicyAuthoring(store, { since = null, limit = 5000 } = {}) {
  const win = since ? ' AND created_at >= ?' : '';
  const params = since ? [since] : [];
  const delegations = store.query(
    `SELECT task_id, created_at, routing_mode, policy_version, router, task_hash, title, task_type,
            attempt_count, first_route_tier, final_tier, final_worker, first_route_success,
            final_status, final_success, unverified, escalated, frontier_used, final_failure_reason,
            total_cost_usd, routing_latency_ms,
            code_facts, code_fact_count, semgrep_status
     FROM delegations WHERE ${FINISHED}${win} ORDER BY created_at DESC LIMIT ?`,
    [...params, limit],
  );
  if (delegations.length === 0) return { delegations: [], tiers: orderedTiers(store.config) };

  const ids = delegations.map((row) => row.task_id);
  const placeholders = ids.map(() => '?').join(',');
  const byTask = (rows) => {
    const map = new Map(ids.map((id) => [id, []]));
    for (const row of rows) map.get(row.task_id)?.push(row);
    return map;
  };

  const predicates = byTask(
    store.query(
      `SELECT task_id, attempt, node_id, type, predicate, result, answered, confidence,
              probabilities, threshold, used, uncertain, order_index
       FROM predicate_evaluations WHERE task_id IN (${placeholders}) ORDER BY attempt, order_index`,
      ids,
    ),
  );
  const executions = byTask(
    store.query(
      `SELECT task_id, attempt, tier, worker, status, success, verification_verdict,
              failure_reason, duration_ms, cost_usd, changed_files_count
       FROM executions WHERE task_id IN (${placeholders}) ORDER BY attempt`,
      ids,
    ),
  );
  const escalations = byTask(
    store.query(
      `SELECT task_id, attempt, from_tier, to_tier, reason FROM escalations WHERE task_id IN (${placeholders}) ORDER BY attempt`,
      ids,
    ),
  );

  return {
    exportedAt: new Date().toISOString(),
    tiers: orderedTiers(store.config).map((tier) => ({
      name: tier,
      description: store.config.tiers[tier].description,
      frontier: Boolean(store.config.workers[store.config.tiers[tier].worker]?.frontier),
    })),
    delegations: delegations.map((row) => ({
      ...row,
      predicates: (predicates.get(row.task_id) ?? []).map((entry) => ({
        ...entry,
        probabilities: entry.probabilities ? JSON.parse(entry.probabilities) : null,
        used: Boolean(entry.used),
        uncertain: Boolean(entry.uncertain),
      })),
      executions: executions.get(row.task_id) ?? [],
      escalations: escalations.get(row.task_id) ?? [],
    })),
  };
}

/**
 * Does specifying the work better actually move it to a cheaper worker?
 *
 * This is the question the delegation interface exists to make answerable. Each
 * row is a population of delegations sharing a specification property, scored
 * the same way, so a thin brief and a complete one can be read against each
 * other rather than argued about.
 */
export function specificationView(store, { since = null } = {}) {
  const win = windowClause(since);
  const tiers = orderedTiers(store.config);
  const cheapest = tiers[0];
  const topTier = tiers.at(-1);

  const population = (label, predicate, note) => {
    const row = store.queryOne(
      `SELECT COUNT(*) AS n,
              AVG(final_success) AS success,
              AVG(first_route_success) AS first_route,
              AVG(escalated) AS escalated,
              AVG(frontier_used) AS frontier,
              AVG(attempt_count) AS attempts,
              AVG(total_cost_usd) AS avg_cost,
              COALESCE(SUM(total_cost_usd), 0) AS total_cost,
              SUM(final_success) AS successes,
              SUM(CASE WHEN first_route_tier = ? THEN 1 ELSE 0 END) AS routed_cheapest,
              SUM(CASE WHEN first_route_tier = ? THEN 1 ELSE 0 END) AS routed_top
       FROM delegations WHERE ${FINISHED} AND ${predicate}${win.sql}`,
      [cheapest, topTier, ...win.params],
    );
    return {
      population: label,
      note,
      count: row.n ?? 0,
      cheapestRouteRate: ratio(row.routed_cheapest, row.n),
      topRouteRate: ratio(row.routed_top, row.n),
      taskSuccessRate: row.success,
      firstRouteSuccessRate: row.first_route,
      escalationRate: row.escalated,
      frontierInvocationRate: row.frontier,
      averageAttempts: row.attempts,
      averageCostUsd: row.avg_cost,
      costPerSuccess: ratio(row.total_cost, row.successes),
    };
  };

  return {
    cheapestTier: cheapest,
    topTier,
    populations: [
      population('Complete brief', 'fully_specified = 1', 'plan + files to change + a definition of done'),
      population('Plan, but incomplete', 'has_plan = 1 AND fully_specified = 0', 'a plan without the rest'),
      population('No plan', 'has_plan = 0', 'the subtask arrived as a goal'),
    ].filter((row) => row.count > 0),
    signals: [
      { signal: 'Plan supplied', ...population('plan', 'has_plan = 1') },
      { signal: 'Files to change named', ...population('edit sites', 'has_edit_sites = 1') },
      { signal: 'Acceptance criteria given', ...population('criteria', 'has_acceptance_criteria = 1') },
      { signal: 'Constraints stated', ...population('constraints', 'has_constraints = 1') },
      { signal: 'Deterministic check available', ...population('verification', 'verification_available = 1') },
    ].filter((row) => row.count > 0),
  };
}

/**
 * Evaluator comparison: the same policy graph, different engines answering it.
 *
 * This is the experiment the local backend exists for. Latency is the obvious
 * difference and the least interesting one — a 15ms evaluator that under-routes
 * is worse than a 300ms one that does not — so routing quality sits beside it in
 * the same row rather than in a separate view.
 */
export function evaluatorView(store, { since = null, policyVersion = null } = {}) {
  const filters = ["d.attempt = 1", "d.evaluator_provider IS NOT NULL", `g.${FINISHED}`];
  const params = [];
  if (since) { filters.push('g.created_at >= ?'); params.push(since); }
  if (policyVersion) { filters.push('d.policy_version = ?'); params.push(policyVersion); }
  const where = `WHERE ${filters.join(' AND ')}`;

  const rows = store.query(
    `SELECT d.evaluator_provider AS provider,
            COALESCE(d.evaluator_model, '—') AS model,
            COALESCE(d.policy_version, '—') AS policy_version,
            COUNT(*) AS delegations,
            AVG(g.final_success) AS task_success_rate,
            AVG(g.first_route_success) AS first_route_success_rate,
            AVG(g.escalated) AS escalation_rate,
            AVG(g.frontier_used) AS frontier_invocation_rate,
            AVG(d.degraded) AS degraded_rate,
            AVG(d.confidence) AS avg_confidence,
            AVG(g.total_cost_usd) AS avg_delegation_cost_usd,
            COALESCE(SUM(g.total_cost_usd), 0) AS total_cost_usd,
            COALESCE(SUM(d.evaluator_input_tokens), 0) AS evaluator_input_tokens,
            SUM(g.final_success) AS successes
     FROM dispatches d
     JOIN delegations g ON g.task_id = d.task_id
     ${where}
     GROUP BY d.evaluator_provider, d.evaluator_model, d.policy_version
     ORDER BY delegations DESC`,
    params,
  );

  // Percentiles are computed here rather than in SQL: SQLite has no percentile
  // function, and these sets are small enough that sorting them is free.
  const latencies = store.query(
    `SELECT d.evaluator_provider AS provider, d.evaluator_latency_ms AS latency
     FROM dispatches d JOIN delegations g ON g.task_id = d.task_id
     ${where} AND d.evaluator_latency_ms IS NOT NULL`,
    params,
  );
  const byProvider = new Map();
  for (const row of latencies) {
    if (!byProvider.has(row.provider)) byProvider.set(row.provider, []);
    byProvider.get(row.provider).push(row.latency);
  }
  const percentile = (sorted, fraction) =>
    sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];

  return rows.map((row) => {
    const sorted = (byProvider.get(row.provider) ?? []).slice().sort((a, b) => a - b);
    return {
      ...row,
      local: row.provider === 'laya' || row.provider === 'mock',
      costPerSuccess: ratio(row.total_cost_usd, row.successes),
      latency: {
        samples: sorted.length,
        median: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        min: sorted[0] ?? null,
        max: sorted.at(-1) ?? null,
      },
    };
  });
}

/**
 * How two engines answered the same predicate.
 *
 * Not the same task — task text is not stored, so a true replay is impossible
 * without breaking that. This compares the distribution of answers per predicate
 * per engine, which is enough to see one engine systematically calling a
 * predicate differently from another.
 */
export function predicateAgreement(store, { policyVersion = null } = {}) {
  const filter = policyVersion ? ' AND p.policy_version = ?' : '';
  const params = policyVersion ? [policyVersion] : [];
  const rows = store.query(
    `SELECT p.node_id, d.evaluator_provider AS provider,
            COUNT(*) AS evaluations,
            SUM(CASE WHEN p.result = 'yes' THEN 1 ELSE 0 END) AS yes_count,
            AVG(p.confidence) AS avg_confidence,
            SUM(p.uncertain) AS uncertain
     FROM predicate_evaluations p
     JOIN dispatches d ON d.id = p.dispatch_id
     WHERE p.type = 'semantic' AND d.evaluator_provider IS NOT NULL${filter}
     GROUP BY p.node_id, d.evaluator_provider
     ORDER BY p.node_id, d.evaluator_provider`,
    params,
  );

  const byNode = new Map();
  for (const row of rows) {
    if (!byNode.has(row.node_id)) byNode.set(row.node_id, []);
    byNode.get(row.node_id).push({
      provider: row.provider,
      evaluations: row.evaluations,
      yesRate: ratio(row.yes_count, row.evaluations),
      averageConfidence: row.avg_confidence,
      uncertainRate: ratio(row.uncertain, row.evaluations),
    });
  }

  return [...byNode.entries()].map(([nodeId, providers]) => {
    const rates = providers.filter((entry) => entry.yesRate != null).map((entry) => entry.yesRate);
    return {
      nodeId,
      providers,
      // The spread in yes-rate is the headline: a predicate where engines agree
      // is one the policy can trust either of them on.
      yesRateSpread: rates.length > 1 ? Math.max(...rates) - Math.min(...rates) : null,
    };
  });
}

export function evaluatorsSeen(store) {
  return store
    .query('SELECT DISTINCT evaluator_provider AS provider FROM dispatches WHERE evaluator_provider IS NOT NULL ORDER BY provider')
    .map((row) => row.provider);
}
