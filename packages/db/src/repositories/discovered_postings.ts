import type { AppDatabase } from "../connection.js";
import type {
  DiscoveredPostingInsert,
  DiscoveredPostingRow,
  DiscoveredPostingStatus,
  SourceId
} from "../schema/discovered_postings.js";

export type UpdateStatusOpts = {
  preFilterReasonCode?: string;
  jobEvaluationId?: string;
};

export type FindByInputHashOpts = {
  /**
   * When set, restricts results to rows whose linked job_evaluation
   * matches this extractor_version. Used by the cache lookup to
   * ensure facts_json was produced by a compatible extractor.
   */
  extractorVersion?: string;
};

const ALL_STATUSES: readonly DiscoveredPostingStatus[] = [
  "queued",
  "pre_filter_rejected",
  "evaluated",
  "duplicate",
  "stale"
];

const INSERT_SQL = `
INSERT INTO discovered_postings (
  id, saved_search_id, search_run_id, source, external_ref, url,
  title, company, raw_metadata_json, status,
  pre_filter_reason_code, job_evaluation_id,
  cached_job_evaluation_id, input_hash,
  discovered_at, last_seen_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const FIND_BY_ID_SQL = `SELECT * FROM discovered_postings WHERE id = ?`;
const FIND_BY_EXTERNAL_REF_SQL = `
SELECT * FROM discovered_postings
WHERE source = ? AND external_ref = ?
ORDER BY discovered_at DESC
LIMIT 1
`;
const FIND_BY_URL_SQL = `
SELECT * FROM discovered_postings
WHERE url = ?
ORDER BY discovered_at DESC
LIMIT 1
`;
const LIST_BY_SEARCH_RUN_SQL = `
SELECT * FROM discovered_postings
WHERE search_run_id = ?
ORDER BY discovered_at DESC
`;
const LIST_BY_SAVED_SEARCH_SQL = `
SELECT * FROM discovered_postings
WHERE saved_search_id = ?
ORDER BY discovered_at DESC
LIMIT ?
`;
const LIST_BY_STATUS_SQL = `
SELECT * FROM discovered_postings
WHERE status = ?
ORDER BY discovered_at DESC
LIMIT ?
`;
const UPDATE_STATUS_SQL = `
UPDATE discovered_postings
SET status = ?, pre_filter_reason_code = ?, job_evaluation_id = ?
WHERE id = ?
`;
const TOUCH_LAST_SEEN_SQL = `
UPDATE discovered_postings SET last_seen_at = ? WHERE id = ?
`;
const SET_CACHED_JOB_EVAL_SQL = `
UPDATE discovered_postings SET cached_job_evaluation_id = ? WHERE id = ?
`;
const COUNT_BY_STATUS_FOR_RUN_SQL = `
SELECT status, COUNT(*) AS n
FROM discovered_postings
WHERE search_run_id = ?
GROUP BY status
`;

export class DiscoveredPostingsRepository {
  private readonly insertStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly findByIdStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly findByExternalRefStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly findByUrlStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly listBySearchRunStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly listBySavedSearchStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly listByStatusStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly updateStatusStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly touchLastSeenStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly setCachedJobEvalStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly countByStatusForRunStmt: ReturnType<AppDatabase["prepare"]>;

  constructor(private readonly db: AppDatabase) {
    this.insertStmt = db.prepare(INSERT_SQL);
    this.findByIdStmt = db.prepare(FIND_BY_ID_SQL);
    this.findByExternalRefStmt = db.prepare(FIND_BY_EXTERNAL_REF_SQL);
    this.findByUrlStmt = db.prepare(FIND_BY_URL_SQL);
    this.listBySearchRunStmt = db.prepare(LIST_BY_SEARCH_RUN_SQL);
    this.listBySavedSearchStmt = db.prepare(LIST_BY_SAVED_SEARCH_SQL);
    this.listByStatusStmt = db.prepare(LIST_BY_STATUS_SQL);
    this.updateStatusStmt = db.prepare(UPDATE_STATUS_SQL);
    this.touchLastSeenStmt = db.prepare(TOUCH_LAST_SEEN_SQL);
    this.setCachedJobEvalStmt = db.prepare(SET_CACHED_JOB_EVAL_SQL);
    this.countByStatusForRunStmt = db.prepare(COUNT_BY_STATUS_FOR_RUN_SQL);
  }

  insert(row: DiscoveredPostingInsert): void {
    this.insertStmt.run(
      row.id,
      row.saved_search_id,
      row.search_run_id,
      row.source,
      row.external_ref,
      row.url,
      row.title,
      row.company,
      row.raw_metadata_json,
      row.status,
      row.pre_filter_reason_code,
      row.job_evaluation_id,
      row.cached_job_evaluation_id,
      row.input_hash,
      row.discovered_at,
      row.last_seen_at
    );
  }

  findById(id: string): DiscoveredPostingRow | undefined {
    return this.findByIdStmt.get(id) as DiscoveredPostingRow | undefined;
  }

  /**
   * Dedup lookup by (source, external_ref). Different sources can
   * legitimately reuse the same external_ref string; this query
   * disambiguates by source.
   */
  findByExternalRef(
    source: SourceId,
    externalRef: string
  ): DiscoveredPostingRow | undefined {
    return this.findByExternalRefStmt.get(source, externalRef) as
      | DiscoveredPostingRow
      | undefined;
  }

  /**
   * Cross-source dedup fallback when external_ref isn't reliable
   * (e.g., aggregator pages, recruiter-email forwards).
   */
  findByUrl(url: string): DiscoveredPostingRow | undefined {
    return this.findByUrlStmt.get(url) as DiscoveredPostingRow | undefined;
  }

  listBySearchRun(searchRunId: string): DiscoveredPostingRow[] {
    return this.listBySearchRunStmt.all(
      searchRunId
    ) as DiscoveredPostingRow[];
  }

  listBySavedSearch(
    savedSearchId: string,
    limit = 100
  ): DiscoveredPostingRow[] {
    return this.listBySavedSearchStmt.all(
      savedSearchId,
      limit
    ) as DiscoveredPostingRow[];
  }

  listByStatus(
    status: DiscoveredPostingStatus,
    limit = 100
  ): DiscoveredPostingRow[] {
    return this.listByStatusStmt.all(status, limit) as DiscoveredPostingRow[];
  }

  /**
   * Transition status with side-channel data. Enforces invariants the
   * DB cannot:
   *   - status="pre_filter_rejected" requires preFilterReasonCode
   *   - status="evaluated" requires jobEvaluationId
   * Other statuses pass through any provided opts unchanged so the
   * caller can clear stale columns explicitly if it wants to.
   */
  updateStatus(
    id: string,
    status: DiscoveredPostingStatus,
    opts: UpdateStatusOpts = {}
  ): void {
    if (status === "pre_filter_rejected" && !opts.preFilterReasonCode) {
      throw new Error(
        "DiscoveredPostingsRepository.updateStatus: status=pre_filter_rejected requires opts.preFilterReasonCode"
      );
    }
    if (status === "evaluated" && !opts.jobEvaluationId) {
      throw new Error(
        "DiscoveredPostingsRepository.updateStatus: status=evaluated requires opts.jobEvaluationId"
      );
    }
    this.updateStatusStmt.run(
      status,
      opts.preFilterReasonCode ?? null,
      opts.jobEvaluationId ?? null,
      id
    );
  }

  /**
   * Bumps last_seen_at only — used when the same posting reappears in
   * a later search run without status changing.
   */
  touchLastSeen(id: string, isoTimestamp: string): void {
    this.touchLastSeenStmt.run(isoTimestamp, id);
  }

  /**
   * Set the `cached_job_evaluation_id` FK on a row. Used by the
   * orchestrator's three-branch dedup logic when a prior evaluation's
   * `facts_json` is reusable across criteria versions. The evaluator
   * loop reads this column to skip the extract LLM call.
   */
  setCachedJobEvaluationId(id: string, jobEvaluationId: string): void {
    this.setCachedJobEvalStmt.run(jobEvaluationId, id);
  }

  /**
   * Count of postings per status for a given run. Returns a fully
   * zero-filled record so callers don't need to defensively check
   * for missing keys.
   */
  countByStatusForRun(
    searchRunId: string
  ): Record<DiscoveredPostingStatus, number> {
    const rows = this.countByStatusForRunStmt.all(searchRunId) as Array<{
      status: DiscoveredPostingStatus;
      n: number;
    }>;
    const counts: Record<DiscoveredPostingStatus, number> = {
      queued: 0,
      pre_filter_rejected: 0,
      evaluated: 0,
      duplicate: 0,
      stale: 0
    };
    for (const r of rows) {
      // Defensive: silently ignore unexpected status strings rather
      // than corrupting the typed return shape.
      if (ALL_STATUSES.includes(r.status)) {
        counts[r.status] = Number(r.n);
      }
    }
    return counts;
  }
}
