/**
 * job_evaluations — one row per evaluate_job invocation that produced a
 * verdict.
 *
 * Persistence enables:
 *   - input_hash dedup (skip re-extraction of postings already evaluated
 *     against the same criteria/extractor versions)
 *   - the eval harness's filter precision/recall computations
 *   - the active-learning loop's `propose_criteria_change` lookup of
 *     the offending evaluation
 *
 * Composite uniqueness: (input_hash, criteria_version_id, extractor_version)
 * is the natural cache key. Enforced by a unique index, not the PK,
 * because we want a stable string PK for FKs and we may re-evaluate
 * after schema/extractor bumps.
 */

export type Verdict =
  | "accepted"
  | "rejected"
  | "below_threshold"
  | "needs_review";

export type ShortCircuitStage =
  | "extract"
  | "hard_gate"
  | "values_check"
  | "soft_score";

export type JobEvaluationRow = {
  id: string;
  input_hash: string;
  criteria_version_id: string | null;
  extractor_version: string;
  verdict: Verdict;
  reason_code: string;
  short_circuited_at_stage: ShortCircuitStage | null;
  /** JSON-encoded array of stages that ran. */
  stages_run_json: string;
  facts_json: string;
  hard_gate_result_json: string;
  values_result_json: string | null;
  soft_score_result_json: string | null;
  mcp_invocation_id: string | null;
  /** ISO-8601. */
  created_at: string;
};

export type JobEvaluationInsert = JobEvaluationRow;
