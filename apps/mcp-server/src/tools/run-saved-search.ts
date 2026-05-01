import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  connectorById,
  evaluateAllSurvivors,
  finalizeSearchRun,
  inferRoleKindsFromTitle,
  inferSeniorityFromTitle,
  recordDiscoveredPostings,
  startDiscovery,
  type EvaluateAllResult,
  type IngestInstruction,
  type SourceQuery
} from "@networkpipeline/discovery";
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

const inputSchema = z
  .object({
    saved_search_id: z.string().min(1)
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export type RunSavedSearchOutput = {
  search_run_id: string;
  /** Postings inserted by the direct-fetch connectors. */
  discovered_count: number;
  /** Postings rejected at pre-extraction (cheap deterministic filter). */
  pre_filter_rejected: number;
  /** Postings already-seen and skipped at the dedup stage. */
  duplicates_skipped: number;
  /** Number of pending_evaluations rows created (callback path). */
  pending_evaluation_count: number;
  pending_instructions: IngestInstruction[];
  /**
   * First pending_llm_call when running in callback mode AND survivors
   * exist. Null when no survivors or when the API path runs the loop
   * synchronously.
   */
  next_call: PendingLLMCall | null;
  /**
   * Optional digest. Populated only when the API path ran synchronously
   * to completion. On the callback path it stays null until the queue
   * drains via record_llm_result.
   */
  digest: EvaluateAllResult | null;
  /**
   * True only when the run completed end-to-end (no instructions
   * pending AND no pending_evaluations awaiting LLM). When false on the
   * callback path, the caller iterates record_llm_result. When false
   * AND pending_instructions is non-empty, the caller executes those
   * via record_discovered_postings first.
   */
  finalized: boolean;
};

/**
 * run_saved_search — the user-facing composer.
 *
 * Pipeline (callback path):
 *  1. Load the SavedSearch, parse its queries.
 *  2. startDiscovery fans out across configured sources.
 *  3. recordDiscoveredPostings on direct results (synchronous; pre-filters
 *     and dedups).
 *  4. For each survivor, insert a pending_evaluations row. Issue the
 *     FIRST row's first pending_llm_call to Claude Code. Subsequent
 *     postings are advanced as Claude calls back via record_llm_result.
 *  5. If pending instructions remain, return them — Claude executes
 *     them, calls record_discovered_postings, which itself returns the
 *     next pending_llm_call so the loop continues seamlessly.
 *
 * Pipeline (API path): unchanged. Synchronous evaluateAllSurvivors,
 * finalize on completion.
 */
export function makeRunSavedSearchTool(
  runtime: Runtime
): ToolDefinition<Input, RunSavedSearchOutput> {
  return {
    name: "run_saved_search",
    description:
      "Run a saved search end-to-end: fan out across configured sources, pre-filter, dedupe, and either (callback path) return the first pending_llm_call so Claude can begin the per-posting evaluation loop, or (API path) drive it synchronously and return a digest.",
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

      const start = await startDiscovery(runtime.repositories, {
        savedSearchId: ss.id,
        runId,
        queries,
        connectorById,
        maxResults: ss.max_results ?? undefined
      });

      const recorded = recordDiscoveredPostings(runtime.repositories, {
        savedSearchId: ss.id,
        runId,
        postings: start.direct_postings,
        criteria: runtime.criteria,
        criteriaVersionId: runtime.criteriaVersionId
      });

      // ── API path ─────────────────────────────────────────────────
      if (runtime.provider !== null) {
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
          discovered_count: recorded.inserted_postings,
          pre_filter_rejected: recorded.pre_filter_rejected,
          duplicates_skipped: recorded.duplicates_skipped,
          pending_evaluation_count: 0,
          pending_instructions: start.instructions,
          next_call: null,
          digest,
          finalized
        };
      }

      // ── Callback path ────────────────────────────────────────────
      // Stage every survivor in pending_evaluations. The orchestrator
      // already inserted discovered_postings rows and decided which IDs
      // survived pre-extraction; we only stage those.
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
          searchRunId: runId,
          discoveredPostingId: dp.id,
          mcpInvocationId: ctx.invocationId
        });
        pendingIds.push(created.id);
      }

      // Issue first call.
      let nextCall: PendingLLMCall | null = null;
      if (pendingIds.length > 0) {
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

      // Finalized iff there are no pending_instructions AND no pending
      // evaluations awaiting LLM. The latter only holds when the
      // saved-search has zero direct survivors and zero instructions.
      const finalized =
        start.instructions.length === 0 && pendingIds.length === 0;
      if (finalized) {
        finalizeSearchRun(runtime.repositories, {
          savedSearchId: ss.id,
          runId,
          status: "completed"
        });
      }

      return {
        search_run_id: runId,
        discovered_count: recorded.inserted_postings,
        pre_filter_rejected: recorded.pre_filter_rejected,
        duplicates_skipped: recorded.duplicates_skipped,
        pending_evaluation_count: pendingIds.length,
        pending_instructions: start.instructions,
        next_call: nextCall,
        digest: null,
        finalized
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
