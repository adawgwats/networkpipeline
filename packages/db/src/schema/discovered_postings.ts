/**
 * discovered_postings — staging table for postings returned by source
 * connectors before they're either pre-filter-rejected or fully
 * evaluated.
 *
 * Status lifecycle:
 *   queued -> pre_filter_rejected | evaluated | duplicate | stale
 *
 * `raw_metadata_json` carries the unmodified connector payload so we
 * can replay extractions later without re-hitting the source. Title /
 * company are denormalized for cheap listing in the discovery UI.
 *
 * Dedup paths:
 *   - (source, external_ref) — primary, when the connector exposes a
 *     stable id.
 *   - url — fallback, useful for cross-source dedup when the same
 *     posting surfaces from multiple aggregators.
 *
 * Both `saved_search_id` and `search_run_id` are FK to their respective
 * tables; constraints are enforced at the application layer (matching
 * the convention of the existing trace/eval tables). `job_evaluation_id`
 * points into `job_evaluations` once the posting has been fully
 * evaluated.
 */

export type SourceId =
  | "indeed"
  | "greenhouse"
  | "lever"
  | "ashby"
  | "career_page"
  | "recruiter_email"
  | "manual_paste";

export type DiscoveredPostingStatus =
  | "queued"
  | "pre_filter_rejected"
  | "evaluated"
  | "duplicate"
  | "stale";

export type DiscoveredPostingRow = {
  id: string;
  saved_search_id: string;
  search_run_id: string;
  source: SourceId;
  /** Source-specific id, e.g. Indeed job_id. */
  external_ref: string | null;
  /** Canonical posting URL. */
  url: string | null;
  /** Denormalized for cheap listing. */
  title: string | null;
  /** Denormalized for cheap listing. */
  company: string | null;
  /** JSON of full metadata as returned by the connector. */
  raw_metadata_json: string;
  status: DiscoveredPostingStatus;
  /** Non-null when status="pre_filter_rejected". */
  pre_filter_reason_code: string | null;
  /** FK to job_evaluations.id, non-null when status="evaluated". */
  job_evaluation_id: string | null;
  /** ISO-8601. */
  discovered_at: string;
  /** ISO-8601, updated when the same posting reappears in a later run. */
  last_seen_at: string;
};

export type DiscoveredPostingInsert = DiscoveredPostingRow;
