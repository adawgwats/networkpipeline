import type { AppDatabase } from "../connection.js";
import type {
  PendingEvaluationInsert,
  PendingEvaluationRow,
  PendingEvaluationStatus
} from "../schema/pending_evaluations.js";

/**
 * Optional patch fields for `update`. Anything not provided is left
 * untouched. `updated_at` is bumped automatically by `update`.
 */
export type PendingEvaluationUpdate = {
  status?: PendingEvaluationStatus;
  current_call_id?: string | null;
  current_call_attempts?: number;
  facts_json?: string | null;
  hard_gate_result_json?: string | null;
  values_result_json?: string | null;
  result_json?: string | null;
  error_message?: string | null;
  provider_runs_json?: string;
};

const INSERT_SQL = `
INSERT INTO pending_evaluations (
  id, posting_text, source_url, metadata_json,
  criteria_version_id, criteria_snapshot_json,
  search_run_id, discovered_posting_id, mcp_invocation_id,
  status, current_call_id, current_call_attempts,
  facts_json, hard_gate_result_json, values_result_json,
  result_json, error_message, provider_runs_json,
  created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const FIND_BY_ID_SQL = `SELECT * FROM pending_evaluations WHERE id = ?`;
const FIND_BY_CALL_ID_SQL = `
SELECT * FROM pending_evaluations WHERE current_call_id = ? LIMIT 1
`;
const LIST_AWAITING_FOR_RUN_SQL = `
SELECT * FROM pending_evaluations
WHERE search_run_id = ?
  AND status IN ('awaiting_extract', 'awaiting_values', 'awaiting_score')
ORDER BY created_at ASC
`;
const LIST_BY_RUN_SQL = `
SELECT * FROM pending_evaluations
WHERE search_run_id = ?
ORDER BY created_at ASC
`;

export class PendingEvaluationsRepository {
  private readonly insertStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly findByIdStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly findByCallIdStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly listAwaitingForRunStmt: ReturnType<AppDatabase["prepare"]>;
  private readonly listByRunStmt: ReturnType<AppDatabase["prepare"]>;

  constructor(private readonly db: AppDatabase) {
    this.insertStmt = db.prepare(INSERT_SQL);
    this.findByIdStmt = db.prepare(FIND_BY_ID_SQL);
    this.findByCallIdStmt = db.prepare(FIND_BY_CALL_ID_SQL);
    this.listAwaitingForRunStmt = db.prepare(LIST_AWAITING_FOR_RUN_SQL);
    this.listByRunStmt = db.prepare(LIST_BY_RUN_SQL);
  }

  insert(row: PendingEvaluationInsert): void {
    this.insertStmt.run(
      row.id,
      row.posting_text,
      row.source_url,
      row.metadata_json,
      row.criteria_version_id,
      row.criteria_snapshot_json,
      row.search_run_id,
      row.discovered_posting_id,
      row.mcp_invocation_id,
      row.status,
      row.current_call_id,
      row.current_call_attempts,
      row.facts_json,
      row.hard_gate_result_json,
      row.values_result_json,
      row.result_json,
      row.error_message,
      row.provider_runs_json,
      row.created_at,
      row.updated_at
    );
  }

  findById(id: string): PendingEvaluationRow | undefined {
    return this.findByIdStmt.get(id) as PendingEvaluationRow | undefined;
  }

  /**
   * Used by `record_llm_result` to resolve which pending evaluation a
   * caller-supplied `call_id` refers to.
   */
  findByCallId(callId: string): PendingEvaluationRow | undefined {
    return this.findByCallIdStmt.get(callId) as
      | PendingEvaluationRow
      | undefined;
  }

  /**
   * In-flight evaluations for a search run, ordered by insertion time.
   * Used by the bulk loop to pick the next posting whose first call
   * Claude should satisfy.
   */
  listAwaitingForRun(searchRunId: string): PendingEvaluationRow[] {
    return this.listAwaitingForRunStmt.all(
      searchRunId
    ) as PendingEvaluationRow[];
  }

  listByRun(searchRunId: string): PendingEvaluationRow[] {
    return this.listByRunStmt.all(searchRunId) as PendingEvaluationRow[];
  }

  /**
   * Apply a partial patch. Builds the UPDATE dynamically from the keys
   * present so unspecified fields are left untouched. Always bumps
   * `updated_at`.
   */
  update(
    id: string,
    patch: PendingEvaluationUpdate,
    updatedAt: string
  ): void {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      args.push(patch.status);
    }
    if (patch.current_call_id !== undefined) {
      sets.push("current_call_id = ?");
      args.push(patch.current_call_id);
    }
    if (patch.current_call_attempts !== undefined) {
      sets.push("current_call_attempts = ?");
      args.push(patch.current_call_attempts);
    }
    if (patch.facts_json !== undefined) {
      sets.push("facts_json = ?");
      args.push(patch.facts_json);
    }
    if (patch.hard_gate_result_json !== undefined) {
      sets.push("hard_gate_result_json = ?");
      args.push(patch.hard_gate_result_json);
    }
    if (patch.values_result_json !== undefined) {
      sets.push("values_result_json = ?");
      args.push(patch.values_result_json);
    }
    if (patch.result_json !== undefined) {
      sets.push("result_json = ?");
      args.push(patch.result_json);
    }
    if (patch.error_message !== undefined) {
      sets.push("error_message = ?");
      args.push(patch.error_message);
    }
    if (patch.provider_runs_json !== undefined) {
      sets.push("provider_runs_json = ?");
      args.push(patch.provider_runs_json);
    }
    sets.push("updated_at = ?");
    args.push(updatedAt);

    if (sets.length === 1) {
      // only updated_at; nothing meaningful to write but keep semantics.
    }
    args.push(id);

    const sql = `UPDATE pending_evaluations SET ${sets.join(", ")} WHERE id = ?`;
    this.db.prepare(sql).run(...(args as never[]));
  }

  /**
   * Convenience: mark the row as failed with a reason. Clears
   * current_call_id so no callback can resume it.
   */
  markFailed(id: string, errorMessage: string, updatedAt: string): void {
    this.update(
      id,
      {
        status: "failed",
        current_call_id: null,
        error_message: errorMessage
      },
      updatedAt
    );
  }

  /**
   * Convenience: mark the row as completed and stash the final
   * EvaluationResult JSON. Clears current_call_id.
   */
  markCompleted(id: string, resultJson: string, updatedAt: string): void {
    this.update(
      id,
      {
        status: "completed",
        current_call_id: null,
        result_json: resultJson
      },
      updatedAt
    );
  }
}
