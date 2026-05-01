/**
 * saved_searches — named, persisted searches the user can re-run.
 *
 * Each row captures the user-facing label, the set of source connectors
 * to query, the per-source query payloads, and an optional criteria
 * overlay path (see docs/criteria.md #7) that scopes pre-extraction
 * gates and downstream filters to this search's intent.
 *
 * `last_run_at` is updated on each `search_runs` execution and drives
 * the recency-first listing in the discovery UI.
 *
 * `cadence` is "on_demand" for V1; "daily" / "weekly" are reserved for
 * the post-V1 scheduler. The column is wider than V1 needs so the
 * scheduler can slot in without a migration.
 *
 * Shapes of the JSON columns:
 *   sources_json: SourceId[]
 *     e.g. ["indeed", "greenhouse", "lever"]
 *   queries_json: Array<{
 *     source: SourceId;
 *     query: string;
 *     location?: string;
 *     // ...source-specific fields (radius, remote-only, etc.)
 *   }>
 */

export type Cadence = "on_demand" | "daily" | "weekly";

export type SavedSearchRow = {
  id: string;
  label: string;
  /** JSON array of `SourceId` strings. */
  sources_json: string;
  /** JSON array of per-source query objects. */
  queries_json: string;
  /** Optional relative path or template id for a criteria overlay. */
  criteria_overlay_path: string | null;
  cadence: Cadence;
  /**
   * Optional per-search result cap. When non-null, each connector
   * truncates its result list to at most this many postings (default
   * 50, max 500). Drives the cost-engineering "don't burn 30 minutes
   * on a 443-posting board" gate.
   */
  max_results: number | null;
  /** ISO-8601. */
  created_at: string;
  /** ISO-8601. */
  updated_at: string;
  /** ISO-8601, nullable until first run. */
  last_run_at: string | null;
};

export type SavedSearchInsert = SavedSearchRow;
