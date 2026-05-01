import { z } from "zod";
import {
  connectorById,
  inferRoleKindsFromTitle,
  inferSeniorityFromTitle,
  recordDiscoveredPostings
} from "@networkpipeline/discovery";
import type { SourceId } from "@networkpipeline/discovery";
import type {
  DiscoveredPostingMetadata,
  PendingLLMCall
} from "@networkpipeline/evaluator";
import type { Runtime } from "../runtime.js";
import { type ToolDefinition } from "../registry.js";
import {
  advancePending,
  createPendingEvaluation
} from "../callback_pipeline.js";

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
  cached_facts_reused: number;
  passed_to_eval: number;
  ready_for_eval_ids: string[];
  /**
   * Number of pending_evaluations rows freshly created from the
   * survivors of this callback. Mirrors `passed_to_eval` on the
   * callback path; zero on the API path.
   */
  pending_evaluation_count: number;
  /**
   * First pending_llm_call to satisfy. Non-null when there are
   * survivors AND we are running on the callback path AND no other
   * pending_evaluation in the run is already in-flight (those would be
   * awaited via record_llm_result first).
   */
  next_call: PendingLLMCall | null;
};

/**
 * record_discovered_postings — callback Claude calls after executing
 * an IngestInstruction. Routes the raw payload through the source
 * connector's `recordResults` to normalize, then through the
 * orchestrator's `recordDiscoveredPostings` to persist + pre-filter
 * + dedup.
 *
 * On the callback path, survivors land in pending_evaluations. The
 * tool returns the FIRST pending_llm_call so Claude can immediately
 * begin generating, unless an earlier in-flight call exists for the
 * run (in which case Claude continues that one and the new survivors
 * are picked up automatically by record_llm_result's bulk loop).
 */
export function makeRecordDiscoveredPostingsTool(
  runtime: Runtime
): ToolDefinition<Input, RecordDiscoveredPostingsOutput> {
  return {
    name: "record_discovered_postings",
    description:
      "Callback for InstructionSourceConnectors (Indeed, recruiter_email, career_page). Claude calls this after executing the per-source MCP tool to deliver raw results back into the pipeline. On the callback path, returns the first pending_llm_call for the new survivors (when applicable) so Claude continues evaluating without an extra round-trip.",
    inputSchema,
    handler: async (input, ctx) => {
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

      const ss = runtime.repositories.savedSearches.findById(
        run.saved_search_id
      );
      const maxResults = ss?.max_results ?? undefined;
      const postings = connector.recordResults(input.payload, maxResults);
      const recorded = recordDiscoveredPostings(runtime.repositories, {
        savedSearchId: run.saved_search_id,
        runId: run.id,
        postings,
        criteria: runtime.criteria,
        criteriaVersionId: runtime.criteriaVersionId
      });

      // ── API path: nothing else to do; caller will invoke
      //   bulk_evaluate_jobs explicitly. Mirror the original output
      //   shape with new fields zeroed.
      if (runtime.provider !== null) {
        return {
          search_run_id: run.id,
          inserted_postings: recorded.inserted_postings,
          pre_filter_rejected: recorded.pre_filter_rejected,
          duplicates_skipped: recorded.duplicates_skipped,
          cached_facts_reused: recorded.cached_facts_reused,
          passed_to_eval: recorded.passed_to_eval,
          ready_for_eval_ids: recorded.ready_for_eval_ids,
          pending_evaluation_count: 0,
          next_call: null
        };
      }

      // ── Callback path: stage survivors + maybe issue first call.
      const pendingIds: string[] = [];
      for (const dpId of recorded.ready_for_eval_ids) {
        const dp = runtime.repositories.discoveredPostings.findById(dpId);
        if (!dp) continue;
        const raw =
          dp.raw_metadata_json && dp.raw_metadata_json.length > 0
            ? (JSON.parse(dp.raw_metadata_json) as Record<string, unknown>)
            : {};
        const text = synthesizePostingText(dp.title, dp.company, raw);
        const metadata: DiscoveredPostingMetadata = {
          title: dp.title ?? "",
          company: dp.company ?? "",
          description_excerpt:
            typeof raw.description_excerpt === "string"
              ? (raw.description_excerpt as string)
              : null,
          onsite_locations: [],
          is_onsite_required: null,
          employment_type: null,
          inferred_seniority_signals: inferSeniorityFromTitle(dp.title ?? ""),
          inferred_role_kinds: inferRoleKindsFromTitle(dp.title ?? "")
        };
        const created = createPendingEvaluation(runtime.repositories, {
          postingText: text,
          sourceUrl: dp.url ?? null,
          metadata,
          criteria: runtime.criteria,
          criteriaVersionId: runtime.criteriaVersionId,
          searchRunId: run.id,
          discoveredPostingId: dp.id,
          mcpInvocationId: ctx.invocationId
        });
        pendingIds.push(created.id);
      }

      // Only issue the first call if no other pending_evaluation in
      // this run is already in-flight (current_call_id non-null).
      // Otherwise let Claude finish what it's working on; the bulk
      // loop in record_llm_result will pick up the new rows when it
      // exhausts the existing queue.
      let nextCall: PendingLLMCall | null = null;
      if (pendingIds.length > 0) {
        const inFlight = runtime.repositories.pendingEvaluations
          .listAwaitingForRun(run.id)
          .some((r) => r.current_call_id !== null);
        if (!inFlight) {
          const firstRow = runtime.repositories.pendingEvaluations.findById(
            pendingIds[0]
          )!;
          const advanced = advancePending(
            runtime.repositories,
            firstRow,
            undefined
          );
          if (advanced.kind === "needs_llm") {
            nextCall = advanced.call;
          }
        }
      }

      return {
        search_run_id: run.id,
        inserted_postings: recorded.inserted_postings,
        pre_filter_rejected: recorded.pre_filter_rejected,
        duplicates_skipped: recorded.duplicates_skipped,
        cached_facts_reused: recorded.cached_facts_reused,
        passed_to_eval: recorded.passed_to_eval,
        ready_for_eval_ids: recorded.ready_for_eval_ids,
        pending_evaluation_count: pendingIds.length,
        next_call: nextCall
      };
    }
  };
}

function synthesizePostingText(
  title: string | null,
  company: string | null,
  raw: Record<string, unknown>
): string {
  const parts: string[] = [];
  if (title) parts.push(`Title: ${title}`);
  if (company) parts.push(`Company: ${company}`);
  const excerptKeys = [
    "description",
    "descriptionPlain",
    "snippet",
    "content",
    "body",
    "description_excerpt"
  ];
  for (const key of excerptKeys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim().length > 0) {
      parts.push(value);
      break;
    }
  }
  if (parts.length === 0) {
    parts.push("(empty posting body)");
  }
  return parts.join("\n\n");
}
