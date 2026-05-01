import { createHash } from "node:crypto";
import type { JsonOutputProvider, ProviderRun } from "../provider/types.js";
import {
  EXTRACTOR_VERSION,
  extractedJobFactsSchema,
  type ExtractedJobFacts
} from "./schema.js";
import { EXTRACT_PROMPT_ID, EXTRACT_SYSTEM_PROMPT } from "./prompt.js";

export type ExtractJobFactsInput = {
  /** Raw posting text. Can be pasted by the user or extracted from HTML. */
  text: string;
  /** Optional source URL for traceability. Never used in extraction. */
  sourceUrl?: string;
  /** Optional per-call model override. */
  model?: string;
  /** Optional per-call retry override. Defaults to 1. */
  maxRetries?: number;
};

export type ExtractJobFactsResult = {
  facts: ExtractedJobFacts;
  run: ProviderRun;
  /** SHA-256 of the trimmed posting text. Stable identifier for dedup. */
  input_hash: string;
  /** Stable extractor version echoed for convenience. */
  extractor_version: typeof EXTRACTOR_VERSION;
};

const TOOL_NAME = "submit_extracted_facts";
const TOOL_DESCRIPTION =
  "Submit the extracted structured facts about this job posting. Must be called exactly once with fields matching the input schema.";

/**
 * Hash the trimmed, lower-cased first 8 KiB of the posting as a dedup key.
 * Uses the first 8 KiB rather than the full text so minor editorial changes
 * (typo fixes, edit footers) don't force re-extraction.
 *
 * Exported so the discovery orchestrator can compute the same hash for
 * its cache lookup BEFORE the LLM extract call — letting it short-circuit
 * the extract stage when a prior evaluation already produced facts for
 * this exact posting body.
 */
export function hashPostingText(text: string): string {
  const normalized = text.trim().slice(0, 8192).toLowerCase();
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * extractJobFacts — stage 1 of the evaluation pipeline.
 *
 * Wraps a JsonOutputProvider with:
 *   - versioned prompt and extractor-version stamping
 *   - strict Zod validation of the tool output
 *   - stable input hashing for dedup
 *   - error surface that fails loudly rather than producing partial facts
 *
 * This function is deliberately criteria-agnostic. It does not depend on
 * the user's criteria file; extraction happens once per posting regardless
 * of which criteria version the downstream gates will use.
 */
export async function extractJobFacts(
  provider: JsonOutputProvider,
  input: ExtractJobFactsInput
): Promise<ExtractJobFactsResult> {
  if (!input.text || input.text.trim().length === 0) {
    throw new Error("extractJobFacts: posting text is empty");
  }

  const userPrompt = buildUserPrompt(input);

  const { data, run } = await provider.generateJsonObject<ExtractedJobFacts>({
    promptId: EXTRACT_PROMPT_ID,
    systemPrompt: EXTRACT_SYSTEM_PROMPT,
    userPrompt,
    outputSchema: extractedJobFactsSchema,
    toolName: TOOL_NAME,
    toolDescription: TOOL_DESCRIPTION,
    model: input.model,
    maxRetries: input.maxRetries ?? 1
  });

  return {
    facts: data,
    run,
    input_hash: hashPostingText(input.text),
    extractor_version: EXTRACTOR_VERSION
  };
}

/**
 * Build the variable per-posting suffix for the extract stage. Exposed
 * (rather than kept private) so the callback-pipeline state machine
 * can reuse the exact same wording without prompt duplication.
 */
export function buildExtractUserPrompt(input: ExtractJobFactsInput): string {
  const header = input.sourceUrl
    ? `Source URL: ${input.sourceUrl}\n\n`
    : "";
  return `${header}Posting:\n\n${input.text.trim()}`;
}

function buildUserPrompt(input: ExtractJobFactsInput): string {
  return buildExtractUserPrompt(input);
}
