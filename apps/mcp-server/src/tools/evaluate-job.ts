import { z } from "zod";
import { evaluateJob, type EvaluationResult } from "@networkpipeline/evaluator";
import type { Runtime } from "../runtime.js";
import { persistEvaluationResult } from "../persistence.js";
import {
  advancePending,
  createPendingEvaluation
} from "../callback_pipeline.js";
import type { PendingLLMCall } from "@networkpipeline/evaluator";
import { objectInput, type ToolDefinition } from "../registry.js";

const inputSchema = objectInput({
  text: z.string().min(1, "posting text must be non-empty"),
  source_url: z.string().url().optional()
});
type Input = z.infer<typeof inputSchema>;

/**
 * Output union: either the full pipeline ran synchronously (API path)
 * and we return the verdict directly, or we paused at extract and
 * returned a `pending_llm_call` for Claude Code to satisfy.
 */
export type EvaluateJobOutput =
  | { kind: "completed"; result: EvaluationResult }
  | {
      kind: "needs_llm";
      pending_evaluation_id: string;
      call: PendingLLMCall;
    };

/**
 * evaluate_job tool — runs the filter pipeline against a posting.
 *
 * Two paths:
 *
 *   1. CALLBACK (default in Claude Code): runtime.provider is null.
 *      Insert a pending_evaluations row, immediately drive the state
 *      machine to the first `pending_llm_call`, return it. Claude Code
 *      generates the JSON and resumes via `record_llm_result`.
 *
 *   2. ANTHROPIC API: runtime.provider is non-null. Run the
 *      synchronous evaluateJob flow and return the EvaluationResult
 *      verbatim. Persists job_evaluations + provider_runs as before.
 *      Preserved for CI / automation contexts without a Claude Code
 *      session driving the work.
 */
export function makeEvaluateJobTool(
  runtime: Runtime
): ToolDefinition<Input, EvaluateJobOutput> {
  return {
    name: "evaluate_job",
    description:
      "Run the candidate's criteria filter against a job posting. With the in-Claude-Code provider, returns a pending_llm_call payload that Claude Code generates and submits via record_llm_result. With an Anthropic API key, returns the verdict synchronously.",
    inputSchema,
    handler: async (input, ctx) => {
      // ── API path ─────────────────────────────────────────────────
      if (runtime.provider !== null) {
        const result = await evaluateJob(
          runtime.provider,
          { text: input.text, sourceUrl: input.source_url },
          runtime.criteria
        );
        persistEvaluationResult(runtime.repositories, result, {
          mcpInvocationId: ctx.invocationId,
          criteriaVersionId: runtime.criteriaVersionId
        });
        return { kind: "completed", result };
      }

      // ── Callback path ────────────────────────────────────────────
      // No metadata for the manual-paste evaluate_job entry — the
      // pre-extraction gate set is metadata-decidable, so without it
      // we skip pre-gates and go straight to extract. Hard gates run
      // post-extraction in the state machine like usual.
      const { id } = createPendingEvaluation(runtime.repositories, {
        postingText: input.text,
        sourceUrl: input.source_url ?? null,
        criteria: runtime.criteria,
        criteriaVersionId: runtime.criteriaVersionId,
        mcpInvocationId: ctx.invocationId
      });
      const row = runtime.repositories.pendingEvaluations.findById(id)!;
      const advanced = advancePending(runtime.repositories, row, undefined);

      if (advanced.kind === "needs_llm") {
        return {
          kind: "needs_llm",
          pending_evaluation_id: advanced.pending_evaluation_id,
          call: advanced.call
        };
      }
      if (advanced.kind === "completed") {
        return { kind: "completed", result: advanced.result };
      }
      throw new Error(
        `evaluate_job: unexpected pending state failed at startup — ${advanced.reason}`
      );
    }
  };
}
