import type { AppDatabase } from "../connection.js";
import type {
  JobEvaluationInsert,
  JobEvaluationRow,
  Verdict
} from "../schema/job_evaluations.js";

export type DedupKey = {
  input_hash: string;
  criteria_version_id: string | null;
  extractor_version: string;
};

const INSERT_SQL = `
INSERT INTO job_evaluations (
  id, input_hash, criteria_version_id, extractor_version,
  verdict, reason_code, short_circuited_at_stage,
  stages_run_json, facts_json, hard_gate_result_json,
  values_result_json, soft_score_result_json,
  mcp_invocation_id, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const FIND_BY_ID_SQL = `SELECT * FROM job_evaluations WHERE id = ?`;
const BY_VERDICT_SQL = `
SELECT * FROM job_evaluations WHERE verdict = ? ORDER BY created_at DESC LIMIT ?
`;
const BY_CRITERIA_VERSION_SQL = `
SELECT * FROM job_evaluations WHERE criteria_version_id = ? ORDER BY created_at DESC
`;
const COUNT_BY_VERDICT_SQL = `
SELECT verdict, COUNT(*) as n FROM job_evaluations GROUP BY verdict
`;

const DEDUP_NULL_CV_SQL = `
SELECT * FROM job_evaluations
WHERE input_hash = ? AND extractor_version = ? AND criteria_version_id IS NULL
ORDER BY created_at DESC LIMIT 1
`;
const DEDUP_WITH_CV_SQL = `
SELECT * FROM job_evaluations
WHERE input_hash = ? AND extractor_version = ? AND criteria_version_id = ?
ORDER BY created_at DESC LIMIT 1
`;

export class JobEvaluationsRepository {
  private readonly insertStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly findByIdStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly byVerdictStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly byCriteriaVersionStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly countByVerdictStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly dedupNullStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly dedupWithStmt: ReturnType<AppDatabase["prepare"]>;

  constructor(private readonly db: AppDatabase) {
    this.insertStmt = db.prepare(INSERT_SQL);
    this.findByIdStmt = db.prepare(FIND_BY_ID_SQL);
    this.byVerdictStmt = db.prepare(BY_VERDICT_SQL);
    this.byCriteriaVersionStmt = db.prepare(BY_CRITERIA_VERSION_SQL);
    this.countByVerdictStmt = db.prepare(COUNT_BY_VERDICT_SQL);
    this.dedupNullStmt = db.prepare(DEDUP_NULL_CV_SQL);
    this.dedupWithStmt = db.prepare(DEDUP_WITH_CV_SQL);
  }

  insert(row: JobEvaluationInsert): void {
    this.insertStmt.run(
      row.id,
      row.input_hash,
      row.criteria_version_id,
      row.extractor_version,
      row.verdict,
      row.reason_code,
      row.short_circuited_at_stage,
      row.stages_run_json,
      row.facts_json,
      row.hard_gate_result_json,
      row.values_result_json,
      row.soft_score_result_json,
      row.mcp_invocation_id,
      row.created_at
    );
  }

  findById(id: string): JobEvaluationRow | undefined {
    return this.findByIdStmt.get(id) as JobEvaluationRow | undefined;
  }

  /**
   * Dedup lookup: given the natural cache key, return the most recent
   * matching evaluation. Used by `evaluate_job` to skip re-running the
   * pipeline for postings already evaluated against the same criteria
   * and extractor versions.
   *
   * Treats `criteria_version_id: null` explicitly — passing null only
   * matches rows where criteria_version_id IS NULL (not arbitrary
   * non-null versions).
   */
  findByDedupKey(key: DedupKey): JobEvaluationRow | undefined {
    if (key.criteria_version_id === null) {
      return this.dedupNullStmt.get(
        key.input_hash,
        key.extractor_version
      ) as JobEvaluationRow | undefined;
    }
    return this.dedupWithStmt.get(
      key.input_hash,
      key.extractor_version,
      key.criteria_version_id
    ) as JobEvaluationRow | undefined;
  }

  listByVerdict(verdict: Verdict, limit = 50): JobEvaluationRow[] {
    return this.byVerdictStmt.all(verdict, limit) as JobEvaluationRow[];
  }

  listByCriteriaVersion(versionId: string): JobEvaluationRow[] {
    return this.byCriteriaVersionStmt.all(versionId) as JobEvaluationRow[];
  }

  countByVerdict(): Record<string, number> {
    const rows = this.countByVerdictStmt.all() as Array<{
      verdict: string;
      n: number;
    }>;
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.verdict] = Number(r.n);
    return counts;
  }
}
