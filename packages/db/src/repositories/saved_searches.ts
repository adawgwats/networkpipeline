import type { AppDatabase } from "../connection.js";
import type {
  SavedSearchInsert,
  SavedSearchRow
} from "../schema/saved_searches.js";

const INSERT_SQL = `
INSERT INTO saved_searches (
  id, label, sources_json, queries_json, criteria_overlay_path,
  cadence, max_results, created_at, updated_at, last_run_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const FIND_BY_ID_SQL = `SELECT * FROM saved_searches WHERE id = ?`;
const FIND_BY_LABEL_SQL = `SELECT * FROM saved_searches WHERE label = ? LIMIT 1`;
// NULLS LAST emulation: order by (last_run_at IS NULL) so NULLs sort
// after non-null values, then by last_run_at desc, with created_at desc
// as the final tiebreak / fallback for never-run rows.
const LIST_SQL = `
SELECT * FROM saved_searches
ORDER BY (last_run_at IS NULL) ASC, last_run_at DESC, created_at DESC
LIMIT ?
`;
const UPDATE_LAST_RUN_AT_SQL = `
UPDATE saved_searches SET last_run_at = ?, updated_at = ? WHERE id = ?
`;
const DELETE_BY_ID_SQL = `DELETE FROM saved_searches WHERE id = ?`;

export class SavedSearchesRepository {
  private readonly insertStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly findByIdStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly findByLabelStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly listStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly updateLastRunAtStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly deleteByIdStmt: ReturnType<AppDatabase["prepare"]>;

  constructor(private readonly db: AppDatabase) {
    this.insertStmt = db.prepare(INSERT_SQL);
    this.findByIdStmt = db.prepare(FIND_BY_ID_SQL);
    this.findByLabelStmt = db.prepare(FIND_BY_LABEL_SQL);
    this.listStmt = db.prepare(LIST_SQL);
    this.updateLastRunAtStmt = db.prepare(UPDATE_LAST_RUN_AT_SQL);
    this.deleteByIdStmt = db.prepare(DELETE_BY_ID_SQL);
  }

  insert(row: SavedSearchInsert): void {
    this.insertStmt.run(
      row.id,
      row.label,
      row.sources_json,
      row.queries_json,
      row.criteria_overlay_path,
      row.cadence,
      row.max_results,
      row.created_at,
      row.updated_at,
      row.last_run_at
    );
  }

  findById(id: string): SavedSearchRow | undefined {
    return this.findByIdStmt.get(id) as SavedSearchRow | undefined;
  }

  /**
   * Lookup by user-facing label. Labels are intended to be unique by
   * convention; the DB does not enforce uniqueness, so this returns
   * the first match.
   */
  findByLabel(label: string): SavedSearchRow | undefined {
    return this.findByLabelStmt.get(label) as SavedSearchRow | undefined;
  }

  /**
   * Recent first by `last_run_at` (NULLS LAST), with `created_at` as
   * the fallback ordering for never-run rows.
   */
  list(limit = 50): SavedSearchRow[] {
    return this.listStmt.all(limit) as SavedSearchRow[];
  }

  /**
   * Bumps `last_run_at` to the supplied ISO-8601 timestamp and sets
   * `updated_at` to the same value. Used after every search execution.
   */
  updateLastRunAt(id: string, isoTimestamp: string): void {
    this.updateLastRunAtStmt.run(isoTimestamp, isoTimestamp, id);
  }

  deleteById(id: string): void {
    this.deleteByIdStmt.run(id);
  }
}
