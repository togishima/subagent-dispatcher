PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id   TEXT PRIMARY KEY,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  model        TEXT,
  cwd          TEXT,
  routing_mode TEXT,
  policy_version TEXT
);

-- One row per delegate() call: the unit the experiment is scored on.
CREATE TABLE IF NOT EXISTS delegations (
  task_id                   TEXT PRIMARY KEY,
  created_at                INTEGER NOT NULL,
  finished_at               INTEGER,
  session_id                TEXT,
  routing_mode              TEXT,
  policy_version            TEXT,
  router                    TEXT,
  task_hash                 TEXT,
  title                     TEXT,
  task_type                 TEXT,
  has_plan                  INTEGER DEFAULT 0,
  plan_chars                INTEGER DEFAULT 0,
  plan_document_count       INTEGER DEFAULT 0,
  has_acceptance_criteria   INTEGER DEFAULT 0,
  has_edit_sites            INTEGER DEFAULT 0,
  has_constraints           INTEGER DEFAULT 0,
  fully_specified           INTEGER DEFAULT 0,
  verification_available    INTEGER DEFAULT 0,
  -- Deterministic code facts that were routing input. Logical fact names only,
  -- chosen by whoever wrote the rules: no source, no findings, no rule text.
  code_facts                TEXT,
  code_fact_count           INTEGER DEFAULT 0,
  semgrep_status            TEXT,
  semgrep_match_count       INTEGER DEFAULT 0,
  semgrep_latency_ms        INTEGER DEFAULT 0,
  attempt_count             INTEGER DEFAULT 0,
  first_route_tier          TEXT,
  final_tier                TEXT,
  final_worker              TEXT,
  first_route_success       INTEGER,
  final_status              TEXT,
  final_success             INTEGER,
  unverified                INTEGER DEFAULT 0,
  escalated                 INTEGER DEFAULT 0,
  frontier_used             INTEGER DEFAULT 0,
  final_failure_reason      TEXT,
  total_cost_usd            REAL DEFAULT 0,
  total_input_tokens        INTEGER DEFAULT 0,
  total_output_tokens       INTEGER DEFAULT 0,
  total_cache_read_tokens   INTEGER DEFAULT 0,
  total_cache_creation_tokens INTEGER DEFAULT 0,
  routing_input_tokens      INTEGER DEFAULT 0,
  routing_output_tokens     INTEGER DEFAULT 0,
  routing_latency_ms        INTEGER DEFAULT 0,
  raw_task                  TEXT
);
CREATE INDEX IF NOT EXISTS delegations_created ON delegations(created_at DESC);
CREATE INDEX IF NOT EXISTS delegations_policy ON delegations(policy_version, routing_mode);
CREATE INDEX IF NOT EXISTS delegations_spec ON delegations(fully_specified, first_route_tier);

-- One row per routing decision. There is one per attempt, so escalations appear
-- here as a second dispatch with a higher selected_tier.
CREATE TABLE IF NOT EXISTS dispatches (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id            TEXT NOT NULL,
  attempt            INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,
  session_id         TEXT,
  router             TEXT,
  routing_mode       TEXT,
  policy_version     TEXT,
  required_tier      TEXT,
  selected_tier      TEXT,
  selected_worker    TEXT,
  worker_model       TEXT,
  previous_tier      TEXT,
  policy_reason      TEXT,
  confidence         REAL,
  probabilities      TEXT,
  traversal_path     TEXT,
  routing_latency_ms INTEGER,
  -- jev_* are schema version 1 and kept so existing databases still read. New
  -- rows write both these and the evaluator_* columns below, which is what the
  -- dashboard and every query use.
  jev_latency_ms     INTEGER,
  jev_input_tokens   INTEGER DEFAULT 0,
  jev_output_tokens  INTEGER DEFAULT 0,
  evaluator_provider TEXT,
  evaluator_model    TEXT,
  evaluator_latency_ms   INTEGER,
  evaluator_input_tokens INTEGER DEFAULT 0,
  evaluator_output_tokens INTEGER DEFAULT 0,
  evaluator_metadata TEXT,
  degraded           INTEGER DEFAULT 0,
  router_error       TEXT
);
CREATE INDEX IF NOT EXISTS dispatches_task ON dispatches(task_id, attempt);
CREATE INDEX IF NOT EXISTS dispatches_created ON dispatches(created_at DESC);

-- One row per predicate evaluated for a dispatch, whether or not traversal used
-- it. Storing the unused ones too is what lets a policy be re-scored offline
-- against decisions it never actually made.
CREATE TABLE IF NOT EXISTS predicate_evaluations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT NOT NULL,
  attempt       INTEGER NOT NULL,
  dispatch_id   INTEGER,
  policy_version TEXT,
  node_id       TEXT NOT NULL,
  type          TEXT NOT NULL,
  predicate     TEXT,
  result        TEXT,
  answered      TEXT,
  confidence    REAL,
  probabilities TEXT,
  threshold     REAL,
  used          INTEGER DEFAULT 0,
  uncertain     INTEGER DEFAULT 0,
  order_index   INTEGER,
  branch_tier   TEXT
);
CREATE INDEX IF NOT EXISTS predicates_task ON predicate_evaluations(task_id, attempt);
CREATE INDEX IF NOT EXISTS predicates_node ON predicate_evaluations(policy_version, node_id);

-- One row per worker execution.
CREATE TABLE IF NOT EXISTS executions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id               TEXT NOT NULL,
  attempt               INTEGER NOT NULL,
  dispatch_id           INTEGER,
  started_at            INTEGER NOT NULL,
  duration_ms           INTEGER,
  tier                  TEXT,
  worker                TEXT,
  worker_kind           TEXT,
  worker_model          TEXT,
  worker_session_id     TEXT,
  status                TEXT,
  success               INTEGER,
  num_turns             INTEGER,
  schema_honoured       INTEGER,
  self_report_mismatch  INTEGER DEFAULT 0,
  verification_verdict  TEXT,
  verification_detail   TEXT,
  failure_reason        TEXT,
  failure_detail        TEXT,
  changed_files_count   INTEGER DEFAULT 0,
  exit_code             INTEGER,
  timed_out             INTEGER DEFAULT 0,
  cost_usd              REAL DEFAULT 0,
  input_tokens          INTEGER DEFAULT 0,
  output_tokens         INTEGER DEFAULT 0,
  cache_read_tokens     INTEGER DEFAULT 0,
  cache_creation_tokens INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS executions_task ON executions(task_id, attempt);
CREATE INDEX IF NOT EXISTS executions_started ON executions(started_at DESC);

CREATE TABLE IF NOT EXISTS escalations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  from_tier  TEXT,
  to_tier    TEXT,
  reason     TEXT,
  attempt    INTEGER,
  policy_version TEXT
);
CREATE INDEX IF NOT EXISTS escalations_task ON escalations(task_id);

-- Claude Code OTel counters, kept as a latest-value snapshot per attribute set.
-- The metrics are cumulative, so the newest export already carries the running
-- total; upserting the maximum avoids double counting across export intervals.
CREATE TABLE IF NOT EXISTS otel_counters (
  key          TEXT PRIMARY KEY,
  ts           INTEGER NOT NULL,
  session_id   TEXT,
  model        TEXT,
  query_source TEXT,
  metric       TEXT,
  token_type   TEXT,
  agent_name   TEXT,
  value        REAL
);
CREATE INDEX IF NOT EXISTS otel_source ON otel_counters(metric, query_source);

-- Native subagent lifecycle, from SubagentStart/SubagentStop hooks. These are
-- delegations that did not go through delegate(), which is itself a measurement.
CREATE TABLE IF NOT EXISTS subagent_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  session_id TEXT,
  agent_id   TEXT,
  agent_type TEXT,
  event      TEXT
);
CREATE INDEX IF NOT EXISTS subagent_events_ts ON subagent_events(ts DESC);
