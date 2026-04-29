export type {
  CandidateCriteriaVersionInsert,
  CandidateCriteriaVersionRow,
  CreatedVia
} from "./candidate_criteria_versions.js";

export type {
  JobEvaluationInsert,
  JobEvaluationRow,
  ShortCircuitStage,
  Verdict
} from "./job_evaluations.js";

export type {
  McpInvocationInsert,
  McpInvocationRow,
  ResultKind
} from "./mcp_invocations.js";

export type {
  ProviderRunInsert,
  ProviderRunRow
} from "./provider_runs.js";

/**
 * Idempotent schema-apply DDL. Runs at startup (or in test setup) to
 * ensure every table + index exists. SQLite's "IF NOT EXISTS" makes
 * this safe to call repeatedly without a migrations folder.
 *
 * When schema changes land we'll graduate to a real migrations system
 * (drizzle-kit + journaled files). Until then this is the minimum
 * viable thing that lets us iterate without ceremony.
 */
export const APPLY_SCHEMA_DDL = [
  // mcp_invocations
  `CREATE TABLE IF NOT EXISTS mcp_invocations (
    id TEXT PRIMARY KEY,
    tool_name TEXT NOT NULL,
    args_hash TEXT NOT NULL,
    result_kind TEXT NOT NULL,
    result_summary TEXT NOT NULL,
    started_at TEXT NOT NULL,
    latency_ms INTEGER NOT NULL,
    meta_json TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mcp_invocations_started_at ON mcp_invocations(started_at)`,
  `CREATE INDEX IF NOT EXISTS idx_mcp_invocations_tool_name ON mcp_invocations(tool_name)`,

  // provider_runs
  `CREATE TABLE IF NOT EXISTS provider_runs (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    latency_ms INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_creation_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL,
    cost_usd_cents REAL,
    stop_reason TEXT NOT NULL,
    retries INTEGER NOT NULL,
    mcp_invocation_id TEXT,
    job_evaluation_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_provider_runs_started_at ON provider_runs(started_at)`,
  `CREATE INDEX IF NOT EXISTS idx_provider_runs_mcp_invocation_id ON provider_runs(mcp_invocation_id)`,
  `CREATE INDEX IF NOT EXISTS idx_provider_runs_job_evaluation_id ON provider_runs(job_evaluation_id)`,
  `CREATE INDEX IF NOT EXISTS idx_provider_runs_prompt_id ON provider_runs(prompt_id)`,

  // job_evaluations
  `CREATE TABLE IF NOT EXISTS job_evaluations (
    id TEXT PRIMARY KEY,
    input_hash TEXT NOT NULL,
    criteria_version_id TEXT,
    extractor_version TEXT NOT NULL,
    verdict TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    short_circuited_at_stage TEXT,
    stages_run_json TEXT NOT NULL,
    facts_json TEXT NOT NULL,
    hard_gate_result_json TEXT NOT NULL,
    values_result_json TEXT,
    soft_score_result_json TEXT,
    mcp_invocation_id TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_job_evaluations_input_hash ON job_evaluations(input_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_job_evaluations_criteria_version ON job_evaluations(criteria_version_id)`,
  `CREATE INDEX IF NOT EXISTS idx_job_evaluations_verdict ON job_evaluations(verdict)`,
  `CREATE INDEX IF NOT EXISTS idx_job_evaluations_created_at ON job_evaluations(created_at)`,

  // candidate_criteria_versions
  `CREATE TABLE IF NOT EXISTS candidate_criteria_versions (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    schema_version TEXT NOT NULL,
    yaml_snapshot TEXT NOT NULL,
    change_summary TEXT NOT NULL,
    triggered_by_evaluation_id TEXT,
    created_at TEXT NOT NULL,
    created_via TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uniq_candidate_criteria_versions_version ON candidate_criteria_versions(version)`,
  `CREATE INDEX IF NOT EXISTS idx_candidate_criteria_versions_created_at ON candidate_criteria_versions(created_at)`
] as const;
