import { z } from "zod";
import {
  evaluateAllSurvivors,
  type EvaluateAllResult
} from "@networkpipeline/discovery";
import type { PendingLLMCall } from "@networkpipeline/evaluator";
import type { Runtime } from "../runtime.js";
import { type ToolDefinition } from "../registry.js";
import {
  advancePending,
  createPendingEvaluation,
  preExtractionRejectionResult,
  runPreExtractionGates
} from "../callback_pipeline.js";
import {
  inferRoleKindsFromTitle,
  inferSeniorityFromTitle
} from "@networkpipeline/discovery";
import { persistEvaluationResult } from "../persistence.js";
import type { DiscoveredPostingMetadata } from "@networkpipeline/evaluator";

const inputSchema = z
  .object({
    search_run_id: z.string().min(1),
    discovered_posting_ids: z.array(z.string().min(1)).min(1)
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

/**
 * Output union. On the API path the digest comes back synchronously
 * (same shape as before). On the callback path, only the FIRST
 * pending_llm_call is returned; Claude Code drives the rest of the
 * loop via record_llm_result.
 */
export type BulkEvaluateJobsOutput =
  | (EvaluateAllResult & {
      kind: "completed";
      search_run_id: string;
    })
  | {
      kind: "needs_llm";
      search_run_id: string;
      pending_evaluation_ids: string[];
      next_call: PendingLLMCall | null;
      immediate_rejections: number;
    };

/**
 * bulk_evaluate_jobs — drive the full evaluator pipeline over a batch
 * of discovered_postings.
 *
 * API path: synchronous loop, persist as we go (unchanged).
 *
 * Callback path: insert pending_evaluations rows for each posting.
 * Pre-extraction rejections short-circuit immediately into
 * job_evaluations + status=evaluated, never touching pending. Survivors
 * land in pending_evaluations status='awaiting_extract'; the FIRST
 * survivor gets its first call_id issued and the call returned to
 * Claude.
 */
export function makeBulkEvaluateJobsTool(
  runtime: Runtime
): ToolDefinition<Input, BulkEvaluateJobsOutput> {
  return {
    name: "bulk_evaluate_jobs",
    description:
      "Run the full evaluation pipeline over a list of discovered_posting_ids. With the in-Claude-Code provider, returns the first pending_llm_call so Claude can begin generating; subsequent results flow through record_llm_result. With an API-key provider, runs synchronously and returns the digest.",
    inputSchema,
    handler: async (input, ctx) => {
      const run = runtime.repositories.searchRuns.findById(input.search_run_id);
      if (!run) {
        throw new Error(`search_run not found: ${input.search_run_id}`);
      }

      // ── API path ─────────────────────────────────────────────────
      if (runtime.provider !== null) {
        const result = await evaluateAllSurvivors(runtime.repositories, {
          savedSearchId: run.saved_search_id,
          runId: run.id,
          discoveredPostingIds: input.discovered_posting_ids,
          criteria: runtime.criteria,
          criteriaVersionId: runtime.criteriaVersionId,
          provider: runtime.provider,
          mcpInvocationId: ctx.invocationId
        });
        return { kind: "completed", search_run_id: run.id, ...result };
      }

      // ── Callback path ────────────────────────────────────────────
      const pending_evaluation_ids: string[] = [];
      let immediate_rejections = 0;

      for (const dpId of input.discovered_posting_ids) {
        const dp = runtime.repositories.discoveredPostings.findById(dpId);
        if (!dp) continue;
        const raw =
          dp.raw_metadata_json && dp.raw_metadata_json.length > 0
            ? (JSON.parse(dp.raw_metadata_json) as Record<string, unknown>)
            : {};
        const text = synthesizePostingText(dp.title, dp.company, raw);

        // Reconstruct metadata for pre-extraction gates.
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

        const gate = runPreExtractionGates(metadata, runtime.criteria);
        if (gate && !gate.pass) {
          // Short-circuit: synthesize a rejection and persist.
          const synthetic = preExtractionRejectionResult({
            metadata,
            gate,
            criteriaVersion: runtime.criteria.version,
            postingText: text
          });
          const persisted = persistEvaluationResult(
            runtime.repositories,
            synthetic,
            {
              mcpInvocationId: ctx.invocationId,
              criteriaVersionId: runtime.criteriaVersionId
            }
          );
          runtime.repositories.discoveredPostings.updateStatus(
            dp.id,
            "evaluated",
            { jobEvaluationId: persisted.jobEvaluationId }
          );
          immediate_rejections += 1;
          continue;
        }

        // Survivor → pending row, status awaiting_extract.
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
        pending_evaluation_ids.push(created.id);
      }

      // Issue the first call (if any survivor exists).
      let next_call: PendingLLMCall | null = null;
      if (pending_evaluation_ids.length > 0) {
        const firstRow = runtime.repositories.pendingEvaluations.findById(
          pending_evaluation_ids[0]
        )!;
        const advanced = advancePending(
          runtime.repositories,
          firstRow,
          undefined
        );
        if (advanced.kind === "needs_llm") {
          next_call = advanced.call;
        }
      }

      return {
        kind: "needs_llm",
        search_run_id: run.id,
        pending_evaluation_ids,
        next_call,
        immediate_rejections
      };
    }
  };
}

/**
 * Reproduce the same posting-text synthesis the discovery
 * orchestrator uses, so dedup hashes match across both paths.
 */
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
