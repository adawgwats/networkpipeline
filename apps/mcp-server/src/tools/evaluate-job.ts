import { z } from "zod";
import { evaluateJob, type EvaluationResult } from "@networkpipeline/evaluator";
import type { Runtime } from "../runtime.js";
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
 */
export function makeEvaluateJobTool(
  runtime: Runtime
): ToolDefinition<Input, EvaluationResult> {
  return {
    name: "evaluate_job",
    description:
      "Run the candidate's criteria filter against a job posting. Returns a structured verdict (accepted | rejected | below_threshold | needs_review) with gate evidence, values check verdict, soft score with per-topic contributions, and provider observability.",
    inputSchema,
    handler: async (input) =>
      evaluateJob(
        runtime.provider,
        { text: input.text, sourceUrl: input.source_url },
        runtime.criteria
      )
  };
}
