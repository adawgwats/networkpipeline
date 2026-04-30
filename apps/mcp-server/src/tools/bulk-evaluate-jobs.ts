import { z } from "zod";
import {
  evaluateAllSurvivors,
  type EvaluateAllResult
} from "@networkpipeline/discovery";
import type { Runtime } from "../runtime.js";
import { type ToolDefinition } from "../registry.js";

const inputSchema = z
  .object({
    search_run_id: z.string().min(1),
    discovered_posting_ids: z.array(z.string().min(1)).min(1)
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export type BulkEvaluateJobsOutput = EvaluateAllResult & {
  search_run_id: string;
};

/**
 * bulk_evaluate_jobs — runs the full evaluator pipeline over a batch
 * of discovered_postings and persists job_evaluations + provider_runs.
 *
 * Used after discover_jobs (or record_discovered_postings) returns a
 * `ready_for_eval_ids` list that survived the pre-extraction gates.
 *
 * Returns the digest verbatim plus the search_run_id so callers can
 * stitch it with the discover_jobs response.
 */
export function makeBulkEvaluateJobsTool(
  runtime: Runtime
): ToolDefinition<Input, BulkEvaluateJobsOutput> {
  return {
    name: "bulk_evaluate_jobs",
    description:
      "Run the full evaluation pipeline over a list of discovered_posting_ids. Persists job_evaluations and provider_runs, updates SearchRun counters, and returns a per-posting digest with verdicts and scores.",
    inputSchema,
    handler: async (input, ctx) => {
      const run = runtime.repositories.searchRuns.findById(input.search_run_id);
      if (!run) {
        throw new Error(`search_run not found: ${input.search_run_id}`);
      }

      const result = await evaluateAllSurvivors(runtime.repositories, {
        savedSearchId: run.saved_search_id,
        runId: run.id,
        discoveredPostingIds: input.discovered_posting_ids,
        criteria: runtime.criteria,
        criteriaVersionId: runtime.criteriaVersionId,
        provider: runtime.provider,
        mcpInvocationId: ctx.invocationId
      });

      return {
        search_run_id: run.id,
        ...result
      };
    }
  };
}
