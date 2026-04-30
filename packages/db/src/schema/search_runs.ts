/**
 * search_runs — one row per execution of a saved search.
 *
 * Aggregated counters answer "how did this run pan out?" without
 * scanning `discovered_postings`. They are progressively updated as
 * the run advances through pre-filter and full-pipeline evaluation.
 *
 * `total_cost_usd_cents` is the sum of `provider_runs.cost_usd_cents`
 * for every LLM call this run kicked off. Stored denormalized to
 * avoid a hot join on the dashboard.
 *
 * Status lifecycle:
 *   in_progress -> completed | failed | cancelled
 *
 * The `saved_search_id` FK is enforced at the application layer, not
 * via SQLite FK constraints, matching the convention of the existing
 * trace/eval tables.
 */

export type SearchRunStatus =
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

export type SearchRunRow = {
  id: string;
  saved_search_id: string;
  /** ISO-8601. */
  started_at: string;
  /** ISO-8601, nullable until run completes / fails / cancels. */
  completed_at: string | null;
  status: SearchRunStatus;
  /** Total returned by all source connectors. */
  results_found: number;
  /** Rejected by pre-extraction gates. */
  results_pre_filtered: number;
  /** Ran through the full filter pipeline. */
  results_evaluated: number;
  /** verdict=accepted. */
  results_accepted: number;
  /** verdict=below_threshold. */
  results_below_threshold: number;
  /** verdict=rejected (post-extraction). */
  results_rejected: number;
  /** verdict=needs_review. */
  results_needs_review: number;
  /** Sum of all `provider_runs.cost_usd_cents` in this run. */
  total_cost_usd_cents: number | null;
  /** Non-null when status="failed". */
  error_message: string | null;
};

export type SearchRunInsert = SearchRunRow;
