import type { AppDatabase } from "../connection.js";
import type {
  SearchRunInsert,
  SearchRunRow
} from "../schema/search_runs.js";

/**
 * Subset of `SearchRunRow` fields callers can update via
 * `updateProgress`. Excludes id / saved_search_id / timestamps /
 * status / error_message — those are managed by the lifecycle helpers
 * (`markCompleted`, `markFailed`).
 */
export type SearchRunCounters = Partial<
  Pick<
    SearchRunRow,
    | "results_found"
    | "results_pre_filtered"
    | "results_evaluated"
    | "results_accepted"
    | "results_below_threshold"
    | "results_rejected"
    | "results_needs_review"
    | "total_cost_usd_cents"
  >
>;

const INSERT_SQL = `
INSERT INTO search_runs (
  id, saved_search_id, started_at, completed_at, status,
  results_found, results_pre_filtered, results_evaluated,
  results_accepted, results_below_threshold, results_rejected,
  results_needs_review, total_cost_usd_cents, error_message
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const FIND_BY_ID_SQL = `SELECT * FROM search_runs WHERE id = ?`;
const LIST_BY_SAVED_SEARCH_SQL = `
SELECT * FROM search_runs
WHERE saved_search_id = ?
ORDER BY started_at DESC
LIMIT ?
`;
const MARK_COMPLETED_SQL = `
UPDATE search_runs SET status = 'completed', completed_at = ? WHERE id = ?
`;
const MARK_FAILED_SQL = `
UPDATE search_runs
SET status = 'failed', completed_at = ?, error_message = ?
WHERE id = ?
`;
const AGGREGATE_COST_SQL = `
SELECT COALESCE(SUM(total_cost_usd_cents), 0) AS total
FROM search_runs
WHERE saved_search_id = ?
`;

// Allow-list for the UPDATE column names so we never interpolate
// arbitrary user input into SQL. Order intentionally stable.
const UPDATABLE_COUNTER_FIELDS: readonly (keyof SearchRunCounters)[] = [
  "results_found",
  "results_pre_filtered",
  "results_evaluated",
  "results_accepted",
  "results_below_threshold",
  "results_rejected",
  "results_needs_review",
  "total_cost_usd_cents"
];

export class SearchRunsRepository {
  private readonly insertStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly findByIdStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly listBySavedSearchStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly markCompletedStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly markFailedStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly aggregateCostStmt: ReturnType<AppDatabase["prepare"]>;

  constructor(private readonly db: AppDatabase) {
    this.insertStmt = db.prepare(INSERT_SQL);
    this.findByIdStmt = db.prepare(FIND_BY_ID_SQL);
    this.listBySavedSearchStmt = db.prepare(LIST_BY_SAVED_SEARCH_SQL);
    this.markCompletedStmt = db.prepare(MARK_COMPLETED_SQL);
    this.markFailedStmt = db.prepare(MARK_FAILED_SQL);
    this.aggregateCostStmt = db.prepare(AGGREGATE_COST_SQL);
  }

  insert(row: SearchRunInsert): void {
    this.insertStmt.run(
      row.id,
      row.saved_search_id,
      row.started_at,
      row.completed_at,
      row.status,
      row.results_found,
      row.results_pre_filtered,
      row.results_evaluated,
      row.results_accepted,
      row.results_below_threshold,
      row.results_rejected,
      row.results_needs_review,
      row.total_cost_usd_cents,
      row.error_message
    );
  }

  findById(id: string): SearchRunRow | undefined {
    return this.findByIdStmt.get(id) as SearchRunRow | undefined;
  }

  listBySavedSearch(savedSearchId: string, limit = 50): SearchRunRow[] {
    return this.listBySavedSearchStmt.all(
      savedSearchId,
      limit
    ) as SearchRunRow[];
  }

  /**
   * Update only the counter fields supplied in `partialCounters`. Other
   * counters retain their current values. Built dynamically against an
   * allow-list of column names — never interpolates user-controlled
   * strings into SQL.
   */
  updateProgress(id: string, partialCounters: SearchRunCounters): void {
    const setClauses: string[] = [];
    const params: unknown[] = [];
    for (const field of UPDATABLE_COUNTER_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(partialCounters, field)) {
        const value = partialCounters[field];
        if (value === undefined) continue;
        setClauses.push(`${field} = ?`);
        params.push(value);
      }
    }
    if (setClauses.length === 0) return;
    params.push(id);
    const sql = `UPDATE search_runs SET ${setClauses.join(", ")} WHERE id = ?`;
    // Build and run ad-hoc — the SET clause is constructed from the
    // allow-list above, not from user input, so this is safe.
    this.db.prepare(sql).run(...(params as never[]));
  }

  markCompleted(id: string, completedAt: string): void {
    this.markCompletedStmt.run(completedAt, id);
  }

  markFailed(id: string, errorMessage: string, completedAt: string): void {
    if (!errorMessage) {
      throw new Error(
        "SearchRunsRepository.markFailed requires a non-empty errorMessage"
      );
    }
    this.markFailedStmt.run(completedAt, errorMessage, id);
  }

  /**
   * Sum of `total_cost_usd_cents` across every run for a saved search.
   * Returns 0 when the saved search has no runs (never undefined).
   */
  aggregateCostBySavedSearch(savedSearchId: string): number {
    const row = this.aggregateCostStmt.get(savedSearchId) as
      | { total: number | null }
      | undefined;
    return Number(row?.total ?? 0);
  }
}
