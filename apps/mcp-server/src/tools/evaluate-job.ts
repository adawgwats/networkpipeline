import { z } from "zod";
import { evaluateJob, type EvaluationResult } from "@networkpipeline/evaluator";
import type { Runtime } from "../runtime.js";
import { persistEvaluationResult } from "../persistence.js";
import { objectInput, type ToolDefinition } from "../registry.js";

const inputSchema = objectInput({
  text: z.string().min(1, "posting text must be non-empty"),
  source_url: z.string().url().optional()
});
type Input = z.infer<typeof inputSchema>;

/**
 * evaluate_job tool — runs the full filter pipeline:
 *   extract → hard_gate → values_check → soft_score
 *
 * Returns the EvaluationResult verbatim so consumers (Claude Code,
 * review UI) can render the explainable verdict, all gate evidence,
 * and the per-stage provider runs.
 *
 * Persists:
 *   - one job_evaluations row, linked to ctx.invocationId and the
 *     active criteria_version_id for snapshot reproducibility
 *   - one provider_runs row per stage (including "skipped" placeholders)
 *
 * No persistence on validation failure — the registry short-circuits
 * before this handler runs in that case.
 */
export function makeEvaluateJobTool(
  runtime: Runtime
): ToolDefinition<Input, EvaluationResult> {
  return {
    name: "evaluate_job",
    description:
      "Run the candidate's criteria filter against a job posting. Returns a structured verdict (accepted | rejected | below_threshold | needs_review) with gate evidence, values check verdict, soft score with per-topic contributions, and provider observability.",
    inputSchema,
    handler: async (input, ctx) => {
      const result = await evaluateJob(
        runtime.provider,
        { text: input.text, sourceUrl: input.source_url },
        runtime.criteria
      );

      persistEvaluationResult(runtime.repositories, result, {
        mcpInvocationId: ctx.invocationId,
        criteriaVersionId: runtime.criteriaVersionId
      });

      return result;
    }
  };
}
