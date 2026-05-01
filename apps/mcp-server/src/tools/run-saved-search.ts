import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  connectorById,
  evaluateAllSurvivors,
  finalizeSearchRun,
  recordDiscoveredPostings,
  startDiscovery,
  type EvaluateAllResult,
  type IngestInstruction,
  type SourceQuery
} from "@networkpipeline/discovery";
import type { Runtime } from "../runtime.js";
import { type ToolDefinition } from "../registry.js";

const inputSchema = z
  .object({
    saved_search_id: z.string().min(1)
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export type RunSavedSearchOutput = {
  search_run_id: string;
  digest: EvaluateAllResult;
  pending_instructions: IngestInstruction[];
  /**
   * True only when the run completed end-to-end (no instructions
   * pending). When false, the caller must execute the
   * pending_instructions, call record_discovered_postings for each,
   * then call bulk_evaluate_jobs to finish.
   */
  finalized: boolean;
};

/**
 * run_saved_search — the user-facing composer.
 *
 * Pipeline:
 *  1. Load the SavedSearch, parse its queries.
 *  2. Call orchestrator.startDiscovery to fan out.
 *  3. recordDiscoveredPostings on direct results (synchronous path).
 *  4. evaluateAllSurvivors over the survivors.
 *  5. If pending instructions remain, return the partial digest +
 *     instructions + finalized=false. Caller (Claude) executes the
 *     instructions, calls record_discovered_postings + bulk_evaluate_jobs
 *     to finish.
 *  6. If no instructions, finalize the SearchRun (markCompleted +
 *     SavedSearch.last_run_at bump) and return the full digest.
 */
export function makeRunSavedSearchTool(
  runtime: Runtime
): ToolDefinition<Input, RunSavedSearchOutput> {
  return {
    name: "run_saved_search",
    description:
      "Run a saved search end-to-end: fan out across configured sources, pre-filter, dedupe, evaluate survivors, and return a digest. For mixed direct + instruction-source searches, returns a partial digest plus instructions Claude must execute and then call record_discovered_postings + bulk_evaluate_jobs to complete.",
    inputSchema,
    handler: async (input, ctx) => {
      const ss = runtime.repositories.savedSearches.findById(
        input.saved_search_id
      );
      if (!ss) {
        throw new Error(`saved_search not found: ${input.saved_search_id}`);
      }
      let queries: SourceQuery[];
      try {
        queries = JSON.parse(ss.queries_json) as SourceQuery[];
      } catch (err) {
        throw new Error(
          `saved_search ${ss.id} has malformed queries_json: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }

      const runId = randomUUID();

      // Fan out. Pass through the saved search's max_results cap when
      // present; connectors fall back to DEFAULT_MAX_RESULTS otherwise.
      const start = await startDiscovery(runtime.repositories, {
        savedSearchId: ss.id,
        runId,
        queries,
        connectorById,
        maxResults: ss.max_results ?? undefined
      });

      // Persist + pre-filter direct results. Pass criteriaVersionId
      // so the cache lookup can distinguish "same-criteria duplicate"
      // (skip eval entirely) from "different-criteria, reuse facts".
      const recorded = recordDiscoveredPostings(runtime.repositories, {
        savedSearchId: ss.id,
        runId,
        postings: start.direct_postings,
        criteria: runtime.criteria,
        criteriaVersionId: runtime.criteriaVersionId
      });

      // Evaluate the direct survivors immediately.
      const digest = await evaluateAllSurvivors(runtime.repositories, {
        savedSearchId: ss.id,
        runId,
        discoveredPostingIds: recorded.ready_for_eval_ids,
        criteria: runtime.criteria,
        criteriaVersionId: runtime.criteriaVersionId,
        provider: runtime.provider,
        mcpInvocationId: ctx.invocationId
      });

      const finalized = start.instructions.length === 0;
      if (finalized) {
        finalizeSearchRun(runtime.repositories, {
          savedSearchId: ss.id,
          runId,
          status: "completed"
        });
      }

      return {
        search_run_id: runId,
        digest,
        pending_instructions: start.instructions,
        finalized
      };
    }
  };
}
