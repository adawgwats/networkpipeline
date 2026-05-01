/**
 * Pending-LLM-call types shared between the evaluator state machine
 * and the MCP tool layer that surfaces them to Claude Code.
 *
 * The architectural shift: instead of routing LLM calls through a
 * server-side `JsonOutputProvider`, the evaluator pauses mid-pipeline
 * and returns a `PendingLLMCall` as part of its tool result. Claude
 * Code generates the JSON in its normal conversation, then calls
 * `record_llm_result(call_id, output)` to resume the pipeline.
 *
 * This module is the lingua franca for that protocol.
 */

export type PendingLLMStage = "extract" | "values" | "soft_score";

/**
 * Returned to Claude Code as part of an MCP tool result. Claude Code
 * generates the JSON; the user then calls `record_llm_result(call_id,
 * output)`.
 *
 * Field rules:
 * - `call_id`: ULID-ish; matches `pending_evaluations.current_call_id`.
 *   The `record_llm_result` tool resolves the pending row by this.
 * - `prompt_id`: e.g. "extract_job_facts@v1"; provenance for ProviderRuns.
 * - `system_prompt`: the cacheable instruction prefix (extract / values
 *   / score) PLUS the schema-output discipline appended by
 *   `composeSystemPromptWithSchema`.
 * - `user_prompt`: the per-posting variable suffix.
 * - `json_schema`: zod-to-json-schema output of the stage's Zod schema.
 *   Embedded in the system prompt; surfaced separately so the client
 *   can choose to validate before calling back.
 * - `instructions`: short hint Claude Code surfaces verbatim alongside
 *   the request — telling the user what's happening.
 */
export type PendingLLMCall = {
  call_id: string;
  prompt_id: string;
  stage: PendingLLMStage;
  system_prompt: string;
  user_prompt: string;
  json_schema: Record<string, unknown>;
  instructions: string;
};

/**
 * Append the schema-output discipline to a stage's cacheable system
 * prompt. The wrapper is identical to the one the deleted
 * sampling.ts used; centralizing it here means the evaluator state
 * machine and any future MCP-sampling-capable adapter both speak the
 * same dialect.
 *
 * The discipline:
 *   - "respond with a single JSON object that conforms to the schema"
 *   - no prose, no markdown fences
 *   - first char `{`, last char `}`
 *
 * Stable wording on purpose; if you change it, bump the relevant stage
 * prompt id (extract_job_facts@v1 → @v2 etc.) so cached evaluations
 * under the old wording aren't silently mixed with new ones.
 */
export function composeSystemPromptWithSchema(
  systemPrompt: string,
  jsonSchema: Record<string, unknown>
): string {
  return `${systemPrompt}

# Output format

You MUST respond with a single JSON object that conforms to the JSON Schema below. Output ONLY the JSON object — no prose, no markdown code fences, no commentary, no explanations. The first character of your response must be \`{\` and the last must be \`}\`.

JSON Schema for the response object:
\`\`\`json
${JSON.stringify(jsonSchema, null, 2)}
\`\`\``;
}
