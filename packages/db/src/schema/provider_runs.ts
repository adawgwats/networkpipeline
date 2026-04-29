/**
 * provider_runs — one row per LLM call.
 *
 * Schema mirrors the in-memory ProviderRun type from
 * @networkpipeline/evaluator/provider/types.ts so the persistence
 * layer is a thin pass-through. Cost/cache token columns enable the
 * eval-harness `prompt_cache_hit_ratio` and `cost_per_evaluation`
 * metrics from docs/evaluation.md §3.4.
 *
 * Linkage:
 * - mcp_invocation_id (nullable): when the run originated from an MCP
 *   tool dispatch.
 * - job_evaluation_id (nullable): when the run is one stage of a
 *   filter pipeline.
 *
 * Both are nullable because future callers may invoke providers
 * outside both contexts (e.g., draft generation, criteria refinement
 * dialogues).
 */

export type ProviderRunRow = {
  id: string;
  /** "anthropic" | "mock" | "skipped" | (future providers) */
  provider: string;
  model: string;
  prompt_id: string;
  /** ISO-8601. */
  started_at: string;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd_cents: number | null;
  stop_reason: string;
  retries: number;
  mcp_invocation_id: string | null;
  job_evaluation_id: string | null;
};

export type ProviderRunInsert = ProviderRunRow;
