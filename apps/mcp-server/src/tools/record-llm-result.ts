import { z } from "zod";
import type {
  EvaluationResult,
  PendingLLMCall
} from "@networkpipeline/evaluator";
import type { Runtime } from "../runtime.js";
import { advancePending } from "../callback_pipeline.js";
import { finalizeSearchRun, type EvaluateAllResult } from "@networkpipeline/discovery";
import { objectInput, type ToolDefinition } from "../registry.js";

const inputSchema = objectInput({
  call_id: z.string().min(1),
  output: z.unknown()
});
type Input = z.infer<typeof inputSchema>;

/**
 * Output union for `record_llm_result`. The tool may:
 *   - resume the SAME pending_evaluation with a fresh call (next stage,
 *     or a retry on validation failure)
 *   - complete the SAME pending_evaluation and return the final
 *     EvaluationResult (single posting; no search_run linkage)
 *   - complete the same pending_evaluation AND advance to the NEXT
 *     pending_evaluation in the same search_run (bulk loop)
 *   - complete the LAST pending_evaluation in a search_run, finalize
 *     the run, and return a digest
 */
export type RecordLlmResultOutput =
  | {
      kind: "completed";
      result: EvaluationResult;
      pending_evaluation_id: string;
    }
  | {
      kind: "needs_llm";
      pending_evaluation_id: string;
      call: PendingLLMCall;
    }
  | {
      kind: "search_run_completed";
      search_run_id: string;
      digest: EvaluateAllResult;
    };

/**
 * record_llm_result — the callback tool Claude Code invokes after
 * generating JSON for a `pending_llm_call`. Resumes the state machine
 * for the linked pending_evaluations row.
 *
 * Behavior:
 *   1. Find pending_evaluation by call_id. Throw if missing.
 *   2. Apply via state_machine.applyLLMResult. Validation failure
 *      surfaces as a fresh pending_llm_call (same call_id, attempts
 *      bumped, validation issues fed into the user prompt). After 1
 *      retry exhausted, the row is marked failed and the call throws.
 *   3. On `completed`:
 *      - Persist job_evaluations + provider_runs (handled by
 *        advancePending).
 *      - If linked to a search_run, advance the bulk loop:
 *          - Find next 'awaiting_extract' row in same search_run.
 *          - If found → return its first pending_llm_call.
 *          - Else → finalize search_run (markCompleted + bump
 *            SavedSearch.last_run_at) and return a digest aggregated
 *            over completed rows for the run.
 *      - Else (single-posting evaluate_job path) → return the result.
 *   4. On `needs_llm` (mid-pipeline transition: extract → values etc.)
 *      → return the next pending_llm_call.
 */
export function makeRecordLlmResultTool(
  runtime: Runtime
): ToolDefinition<Input, RecordLlmResultOutput> {
  return {
    name: "record_llm_result",
    description:
      "Submit the JSON output for a pending_llm_call returned by an earlier evaluate_job, run_saved_search, bulk_evaluate_jobs, or record_discovered_postings invocation. Resumes the evaluation pipeline server-side.",
    inputSchema,
    handler: async (input) => {
      const row = runtime.repositories.pendingEvaluations.findByCallId(
        input.call_id
      );
      if (!row) {
        throw new Error(
          `record_llm_result: no pending_evaluation found for call_id ${input.call_id}`
        );
      }
      if (row.status === "completed" || row.status === "failed") {
        throw new Error(
          `record_llm_result: pending_evaluation ${row.id} is ${row.status}; cannot record additional results`
        );
      }

      const advanced = advancePending(
        runtime.repositories,
        row,
        input.output
      );

      if (advanced.kind === "failed") {
        throw new Error(
          `record_llm_result: pending_evaluation ${advanced.pending_evaluation_id} failed: ${advanced.reason}`
        );
      }

      if (advanced.kind === "needs_llm") {
        return {
          kind: "needs_llm",
          pending_evaluation_id: advanced.pending_evaluation_id,
          call: advanced.call
        };
      }

      // ── completed ─────────────────────────────────────────────────
      // If this pending row was linked to a search_run, we may need to
      // advance the bulk loop or finalize the run.
      if (row.search_run_id) {
        const next = await advanceSearchRun(runtime, row.search_run_id);
        if (next !== null) return next;
      }

      return {
        kind: "completed",
        result: advanced.result,
        pending_evaluation_id: advanced.pending_evaluation_id
      };
    }
  };
}

/**
 * Move the bulk loop forward for `searchRunId`. Returns:
 *   - { kind: "needs_llm", … } when another pending row is awaiting
 *     its first call.
 *   - { kind: "search_run_completed", … } when the queue is empty;
 *     finalizes the run.
 *   - null when the search_run itself wasn't found, signaling the
 *     caller to fall through to the single-posting completion shape.
 */
async function advanceSearchRun(
  runtime: Runtime,
  searchRunId: string
): Promise<RecordLlmResultOutput | null> {
  const awaiting =
    runtime.repositories.pendingEvaluations.listAwaitingForRun(searchRunId);

  for (const candidate of awaiting) {
    if (candidate.status !== "awaiting_extract") continue;
    if (candidate.current_call_id !== null) continue; // already issued
    const advanced = advancePending(
      runtime.repositories,
      candidate,
      undefined
    );
    if (advanced.kind === "needs_llm") {
      return {
        kind: "needs_llm",
        pending_evaluation_id: advanced.pending_evaluation_id,
        call: advanced.call
      };
    }
    // Otherwise the candidate completed without LLM (shouldn't happen
    // unless every stage short-circuits; keep iterating).
  }
  // Any rows STILL awaiting (e.g. with a call_id already issued) are
  // intentionally left alone — Claude Code is mid-flight on them.
  const stillAwaiting = runtime.repositories.pendingEvaluations
    .listAwaitingForRun(searchRunId)
    .filter((r) => r.current_call_id !== null);
  if (stillAwaiting.length > 0) return null;

  // Nothing left to evaluate — finalize the run.
  const run = runtime.repositories.searchRuns.findById(searchRunId);
  if (!run) return null;

  const digest = aggregateDigest(runtime, searchRunId);
  if (run.status === "in_progress") {
    finalizeSearchRun(runtime.repositories, {
      savedSearchId: run.saved_search_id,
      runId: searchRunId,
      status: "completed"
    });
  }

  return {
    kind: "search_run_completed",
    search_run_id: searchRunId,
    digest
  };
}

/**
 * Aggregate completed pending_evaluations for a search run into the
 * shape `evaluateAllSurvivors` historically returned, so callers see
 * a stable digest no matter which path produced it.
 */
function aggregateDigest(
  runtime: Runtime,
  searchRunId: string
): EvaluateAllResult {
  const rows = runtime.repositories.pendingEvaluations.listByRun(searchRunId);
  const by_verdict: EvaluateAllResult["by_verdict"] = {
    accepted: 0,
    rejected: 0,
    below_threshold: 0,
    needs_review: 0
  };
  let total_cost_usd_cents = 0;
  const outcomes: EvaluateAllResult["outcomes"] = [];

  for (const row of rows) {
    if (row.status !== "completed" || !row.result_json) continue;
    const result = JSON.parse(row.result_json) as EvaluationResult;
    by_verdict[result.verdict] += 1;
    for (const run of result.provider_runs) {
      if (run.cost_usd_cents !== null && run.provider !== "skipped") {
        total_cost_usd_cents += run.cost_usd_cents;
      }
    }
    // Look up the discovered_posting (if any) for company/title/url.
    let company = "";
    let title = "";
    let url: string | null = null;
    if (row.discovered_posting_id) {
      const dp = runtime.repositories.discoveredPostings.findById(
        row.discovered_posting_id
      );
      if (dp) {
        company = dp.company ?? "";
        title = dp.title ?? "";
        url = dp.url ?? null;
      }
    }
    // Find the persisted job_evaluation_id (the one the row's result
    // was persisted under) by hash + criteria_version.
    const persistedEval = runtime.repositories.jobEvaluations.findByDedupKey({
      input_hash: result.input_hash,
      criteria_version_id: row.criteria_version_id,
      extractor_version: result.extractor_version
    });
    const job_evaluation_id = persistedEval?.id ?? "";
    outcomes.push({
      discovered_posting_id: row.discovered_posting_id ?? "",
      job_evaluation_id,
      verdict: result.verdict,
      score: result.soft_score_result?.raw.score,
      company,
      title,
      url,
      reason_code: result.reason_code
    });
  }

  return {
    evaluated: outcomes.length,
    by_verdict,
    total_cost_usd_cents,
    outcomes
  };
}
