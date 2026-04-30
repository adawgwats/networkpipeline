import { z } from "zod";
import {
  connectorById,
  recordDiscoveredPostings
} from "@networkpipeline/discovery";
import type { SourceId } from "@networkpipeline/discovery";
import type { Runtime } from "../runtime.js";
import { type ToolDefinition } from "../registry.js";

const SOURCE_IDS: readonly SourceId[] = [
  "indeed",
  "greenhouse",
  "lever",
  "ashby",
  "career_page",
  "recruiter_email",
  "manual_paste"
] as const;

const sourceIdSchema = z.enum(
  SOURCE_IDS as unknown as [SourceId, ...SourceId[]]
);

const inputSchema = z
  .object({
    search_run_id: z.string().min(1),
    source: sourceIdSchema,
    payload: z.unknown()
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export type RecordDiscoveredPostingsOutput = {
  search_run_id: string;
  inserted_postings: number;
  pre_filter_rejected: number;
  duplicates_skipped: number;
  passed_to_eval: number;
  ready_for_eval_ids: string[];
};

/**
 * record_discovered_postings — callback Claude calls after executing
 * an IngestInstruction. Routes the raw payload through the source
 * connector's `recordResults` to normalize, then through the
 * orchestrator's `recordDiscoveredPostings` to persist + pre-filter
 * + dedup.
 *
 * Validates that the SearchRun is still in_progress before accepting
 * the callback — completed/failed runs are append-only audit and
 * shouldn't grow new postings.
 *
 * Only InstructionSourceConnectors accept callbacks; rejecting calls
 * for direct-fetch connectors prevents accidental double-bookkeeping
 * (those go through discover_jobs synchronously).
 */
export function makeRecordDiscoveredPostingsTool(
  runtime: Runtime
): ToolDefinition<Input, RecordDiscoveredPostingsOutput> {
  return {
    name: "record_discovered_postings",
    description:
      "Callback for InstructionSourceConnectors (Indeed, recruiter_email, career_page). Claude calls this after executing the per-source MCP tool to deliver raw results back into the pipeline.",
    inputSchema,
    handler: async (input) => {
      const run = runtime.repositories.searchRuns.findById(
        input.search_run_id
      );
      if (!run) {
        throw new Error(`search_run not found: ${input.search_run_id}`);
      }
      if (run.status !== "in_progress") {
        throw new Error(
          `search_run ${input.search_run_id} is not in_progress (status=${run.status}); rejecting callback`
        );
      }

      const connector = connectorById(input.source);
      if (!connector) {
        throw new Error(`unknown source id: ${input.source}`);
      }
      if (connector.kind !== "instruction") {
        throw new Error(
          `source "${input.source}" is direct-fetch; record_discovered_postings only accepts callbacks for instruction sources`
        );
      }

      const postings = connector.recordResults(input.payload);
      const recorded = recordDiscoveredPostings(runtime.repositories, {
        savedSearchId: run.saved_search_id,
        runId: run.id,
        postings,
        criteria: runtime.criteria
      });

      return {
        search_run_id: run.id,
        inserted_postings: recorded.inserted_postings,
        pre_filter_rejected: recorded.pre_filter_rejected,
        duplicates_skipped: recorded.duplicates_skipped,
        passed_to_eval: recorded.passed_to_eval,
        ready_for_eval_ids: recorded.ready_for_eval_ids
      };
    }
  };
}
