import type { AppDatabase } from "../connection.js";
import type {
  CandidateCriteriaVersionInsert,
  CandidateCriteriaVersionRow
} from "../schema/candidate_criteria_versions.js";

const INSERT_SQL = `
INSERT INTO candidate_criteria_versions (
  id, version, schema_version, yaml_snapshot, change_summary,
  triggered_by_evaluation_id, created_at, created_via
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;

const FIND_BY_ID_SQL = `SELECT * FROM candidate_criteria_versions WHERE id = ?`;
const FIND_BY_VERSION_SQL = `SELECT * FROM candidate_criteria_versions WHERE version = ?`;
const LATEST_SQL = `SELECT * FROM candidate_criteria_versions ORDER BY version DESC LIMIT 1`;
const LIST_SQL = `SELECT * FROM candidate_criteria_versions ORDER BY version DESC LIMIT ?`;
const MAX_VERSION_SQL = `SELECT COALESCE(MAX(version), 0) AS max_v FROM candidate_criteria_versions`;

export class CandidateCriteriaVersionsRepository {
  private readonly insertStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly findByIdStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly findByVersionStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly latestStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly listStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly maxVersionStmt: ReturnType<AppDatabase["prepare"]>;

  constructor(private readonly db: AppDatabase) {
    this.insertStmt = db.prepare(INSERT_SQL);
    this.findByIdStmt = db.prepare(FIND_BY_ID_SQL);
    this.findByVersionStmt = db.prepare(FIND_BY_VERSION_SQL);
    this.latestStmt = db.prepare(LATEST_SQL);
    this.listStmt = db.prepare(LIST_SQL);
    this.maxVersionStmt = db.prepare(MAX_VERSION_SQL);
  }

  insert(row: CandidateCriteriaVersionInsert): void {
    this.insertStmt.run(
      row.id,
      row.version,
      row.schema_version,
      row.yaml_snapshot,
      row.change_summary,
      row.triggered_by_evaluation_id,
      row.created_at,
      row.created_via
    );
  }

  /**
   * Convenience: write a snapshot iff the (version) is not yet
   * persisted. Used at MCP server boot to mirror the on-disk YAML
   * into the DB without duplicating snapshots on every restart.
   *
   * Returns true when a row was inserted, false when it already
   * existed.
   */
  upsertVersion(row: CandidateCriteriaVersionInsert): boolean {
    const existing = this.findByVersion(row.version);
    if (existing) return false;
    this.insert(row);
    return true;
  }

  findById(id: string): CandidateCriteriaVersionRow | undefined {
    return this.findByIdStmt.get(id) as
      | CandidateCriteriaVersionRow
      | undefined;
  }

  findByVersion(version: number): CandidateCriteriaVersionRow | undefined {
    return this.findByVersionStmt.get(version) as
      | CandidateCriteriaVersionRow
      | undefined;
  }

  latest(): CandidateCriteriaVersionRow | undefined {
    return this.latestStmt.get() as CandidateCriteriaVersionRow | undefined;
  }

  list(limit = 50): CandidateCriteriaVersionRow[] {
    return this.listStmt.all(limit) as CandidateCriteriaVersionRow[];
  }

  /**
   * Highest version currently stored, or 0 when the table is empty.
   * Useful for active-learning code that needs to compute "next version
   * = max + 1" without selecting full rows.
   */
  maxVersion(): number {
    const row = this.maxVersionStmt.get() as { max_v: number } | undefined;
    return Number(row?.max_v ?? 0);
  }
}
