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

export type {
  Cadence,
  SavedSearchInsert,
  SavedSearchRow
} from "./saved_searches.js";

export type {
  SearchRunInsert,
  SearchRunRow,
  SearchRunStatus
} from "./search_runs.js";

export type {
  DiscoveredPostingInsert,
  DiscoveredPostingRow,
  DiscoveredPostingStatus,
  SourceId
} from "./discovered_postings.js";

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
  `CREATE INDEX IF NOT EXISTS idx_candidate_criteria_versions_created_at ON candidate_criteria_versions(created_at)`,

  // saved_searches
  `CREATE TABLE IF NOT EXISTS saved_searches (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    sources_json TEXT NOT NULL,
    queries_json TEXT NOT NULL,
    criteria_overlay_path TEXT,
    cadence TEXT NOT NULL,
    max_results INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_run_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_saved_searches_label ON saved_searches(label)`,
  `CREATE INDEX IF NOT EXISTS idx_saved_searches_last_run_at ON saved_searches(last_run_at)`,

  // search_runs
  `CREATE TABLE IF NOT EXISTS search_runs (
    id TEXT PRIMARY KEY,
    saved_search_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    status TEXT NOT NULL,
    results_found INTEGER NOT NULL DEFAULT 0,
    results_pre_filtered INTEGER NOT NULL DEFAULT 0,
    results_evaluated INTEGER NOT NULL DEFAULT 0,
    results_accepted INTEGER NOT NULL DEFAULT 0,
    results_below_threshold INTEGER NOT NULL DEFAULT 0,
    results_rejected INTEGER NOT NULL DEFAULT 0,
    results_needs_review INTEGER NOT NULL DEFAULT 0,
    total_cost_usd_cents REAL,
    error_message TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_search_runs_saved_search_id ON search_runs(saved_search_id)`,
  `CREATE INDEX IF NOT EXISTS idx_search_runs_started_at ON search_runs(started_at)`,
  `CREATE INDEX IF NOT EXISTS idx_search_runs_status ON search_runs(status)`,

  // discovered_postings
  `CREATE TABLE IF NOT EXISTS discovered_postings (
    id TEXT PRIMARY KEY,
    saved_search_id TEXT NOT NULL,
    search_run_id TEXT NOT NULL,
    source TEXT NOT NULL,
    external_ref TEXT,
    url TEXT,
    title TEXT,
    company TEXT,
    raw_metadata_json TEXT NOT NULL,
    status TEXT NOT NULL,
    pre_filter_reason_code TEXT,
    job_evaluation_id TEXT,
    cached_job_evaluation_id TEXT,
    input_hash TEXT,
    discovered_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_discovered_postings_saved_search_id ON discovered_postings(saved_search_id)`,
  `CREATE INDEX IF NOT EXISTS idx_discovered_postings_search_run_id ON discovered_postings(search_run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_discovered_postings_status ON discovered_postings(status)`,
  `CREATE INDEX IF NOT EXISTS idx_discovered_postings_source ON discovered_postings(source)`,
  `CREATE INDEX IF NOT EXISTS idx_discovered_postings_url ON discovered_postings(url)`,
  `CREATE INDEX IF NOT EXISTS idx_discovered_postings_external_ref ON discovered_postings(source, external_ref)`,
  `CREATE INDEX IF NOT EXISTS idx_discovered_postings_input_hash ON discovered_postings(input_hash)`
] as const;

/**
 * Additive column migrations applied AFTER `APPLY_SCHEMA_DDL`. SQLite
 * doesn't support `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so each
 * statement is wrapped in a per-statement try/catch in `applySchema`
 * — duplicate-column errors are swallowed; everything else propagates.
 *
 * Pattern: when adding a new nullable column to an existing table, add
 * the column to the CREATE TABLE block above (so fresh DBs get it) AND
 * append the matching ALTER here (so existing on-disk DBs pick it up).
 */
export const ADDITIVE_COLUMN_MIGRATIONS = [
  `ALTER TABLE saved_searches ADD COLUMN max_results INTEGER`,
  `ALTER TABLE discovered_postings ADD COLUMN cached_job_evaluation_id TEXT`,
  `ALTER TABLE discovered_postings ADD COLUMN input_hash TEXT`
] as const;
