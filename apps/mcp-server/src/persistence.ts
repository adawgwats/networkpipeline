import { randomUUID } from "node:crypto";
import type { EvaluationResult } from "@networkpipeline/evaluator";
import type { Repositories } from "./runtime.js";

export type PersistEvaluationOptions = {
  /** Foreign key to mcp_invocations. */
  mcpInvocationId: string | null;
  /** Foreign key to candidate_criteria_versions. */
  criteriaVersionId: string | null;
};

export type PersistEvaluationResult = {
  jobEvaluationId: string;
  /**
   * IDs assigned to the persisted provider_runs in the order
   * they appear on `EvaluationResult.provider_runs`. Useful to
   * tests that want to assert FK linkage.
   */
  providerRunIds: string[];
};

/**
 * Persists an EvaluationResult into the trace tables:
 *   - one row in job_evaluations
 *   - N rows in provider_runs (one per stage, including "skipped"
 *     placeholder runs so accounting stays consistent)
 *
 * Pure write. Caller decides whether to dedup BEFORE calling this
 * (via JobEvaluationsRepository.findByDedupKey) — this function does
 * not consult the cache itself.
 *
 * Provider run rows get fresh ULID-style ids (randomUUID for now),
 * linked back to both the parent MCP invocation and this new
 * job_evaluation row for join-friendly observability queries.
 */
export function persistEvaluationResult(
  repos: Repositories,
  result: EvaluationResult,
  opts: PersistEvaluationOptions
): PersistEvaluationResult {
  const jobEvaluationId = randomUUID();
  const createdAt = new Date().toISOString();

  repos.jobEvaluations.insert({
    id: jobEvaluationId,
    input_hash: result.input_hash,
    criteria_version_id: opts.criteriaVersionId,
    extractor_version: result.extractor_version,
    verdict: result.verdict,
    reason_code: result.reason_code,
    short_circuited_at_stage: result.short_circuited_at_stage,
    stages_run_json: JSON.stringify(result.stages_run),
    facts_json: JSON.stringify(result.facts),
    hard_gate_result_json: JSON.stringify(result.hard_gate_result),
    values_result_json: result.values_result
      ? JSON.stringify(result.values_result)
      : null,
    soft_score_result_json: result.soft_score_result
      ? JSON.stringify(result.soft_score_result)
      : null,
    mcp_invocation_id: opts.mcpInvocationId,
    created_at: createdAt
  });

  const providerRunIds: string[] = [];
  for (const run of result.provider_runs) {
    const id = randomUUID();
    providerRunIds.push(id);
    repos.providerRuns.insert({
      id,
      provider: run.provider,
      model: run.model,
      prompt_id: run.prompt_id,
      started_at: run.started_at,
      latency_ms: run.latency_ms,
      input_tokens: run.input_tokens,
      output_tokens: run.output_tokens,
      cache_creation_tokens: run.cache_creation_tokens,
      cache_read_tokens: run.cache_read_tokens,
      cost_usd_cents: run.cost_usd_cents,
      stop_reason: run.stop_reason,
      retries: run.retries,
      mcp_invocation_id: opts.mcpInvocationId,
      job_evaluation_id: jobEvaluationId
    });
  }

  return { jobEvaluationId, providerRunIds };
}
