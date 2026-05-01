/**
 * pending_evaluations — state-machine table for the callback-pipeline
 * architecture.
 *
 * Each row represents one in-flight evaluation that is paused mid-pipeline,
 * waiting for the MCP client (Claude Code) to satisfy a `pending_llm_call`
 * via the `record_llm_result` tool. Evaluations walk through stages
 * (extract → values → score) one LLM round-trip at a time; this row
 * carries every piece of state needed to resume.
 *
 * Status lifecycle:
 *   awaiting_extract → awaiting_values → awaiting_score → completed
 *                    ↘ completed (on hard-gate reject after extract)
 *                    ↘ failed (on schema-validation exhaustion or error)
 *
 * `current_call_id` is the ULID of the pending_llm_call Claude must
 * satisfy. It is non-null between stages and null after `completed`/
 * `failed` (or before the first call is issued).
 *
 * `criteria_snapshot_json` freezes the criteria at the moment the
 * evaluation started — same posting evaluated mid-criteria-edit still
 * yields a coherent result rather than a half-old/half-new mix.
 *
 * `provider_runs_json` accumulates synthetic `ProviderRun` rows so the
 * persisted job_evaluation has full per-stage observability without
 * needing an in-process provider.
 */

export type PendingEvaluationStatus =
  | "awaiting_extract"
  | "awaiting_values"
  | "awaiting_score"
  | "completed"
  | "failed";

export type PendingEvaluationRow = {
  id: string;
  // input
  posting_text: string;
  source_url: string | null;
  /** Serialized DiscoveredPostingMetadata or null. */
  metadata_json: string | null;
  // linkage
  criteria_version_id: string;
  /** Frozen CandidateCriteria JSON for this evaluation. */
  criteria_snapshot_json: string;
  search_run_id: string | null;
  discovered_posting_id: string | null;
  mcp_invocation_id: string | null;
  // progress
  status: PendingEvaluationStatus;
  /** ULID-ish id of the pending_llm_call Claude must satisfy. */
  current_call_id: string | null;
  current_call_attempts: number;
  /** Filled after extract LLM round-trip resolves. */
  facts_json: string | null;
  /** Filled after deterministic hard-gate stage runs. */
  hard_gate_result_json: string | null;
  /** Filled after values_check LLM round-trip resolves. */
  values_result_json: string | null;
  // outcome
  /** Final EvaluationResult JSON when status='completed'. */
  result_json: string | null;
  /** When status='failed'. */
  error_message: string | null;
  // accounting
  /** Accumulated synthetic ProviderRun JSON array. */
  provider_runs_json: string;
  created_at: string;
  updated_at: string;
};

export type PendingEvaluationInsert = PendingEvaluationRow;
