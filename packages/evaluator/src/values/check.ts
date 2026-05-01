import type { CandidateCriteria } from "@networkpipeline/criteria";
import type { JsonOutputProvider, ProviderRun } from "../provider/types.js";
import type { ExtractedJobFacts } from "../extract/schema.js";
import { buildReasonCode, slugifyReasonValue } from "../gates/result.js";
import { VALUES_SYSTEM_PROMPT } from "./prompt.js";
import {
  VALUES_PROMPT_ID,
  VALUES_REJECT_CONFIDENCE,
  VALUES_REVIEW_CONFIDENCE,
  valuesVerdictRawSchema,
  type ValuesCheckResult,
  type ValuesVerdictRaw
} from "./schema.js";

const TOOL_NAME = "submit_values_verdict";
const TOOL_DESCRIPTION =
  "Submit the structured values-check verdict for this posting. Call exactly once with all fields populated.";

export type ValuesCheckInput = {
  facts: ExtractedJobFacts;
  criteria: CandidateCriteria;
  /** Optional per-call retry override. Defaults to 1. */
  maxRetries?: number;
  /** Optional per-call model override. */
  model?: string;
};

export type ValuesCheckOutput = {
  result: ValuesCheckResult;
  run: ProviderRun;
};

/**
 * values_check — stage 2b of the evaluation pipeline (docs/criteria.md §7).
 *
 * Narrow LLM call: yes/no with confidence on whether the posting violates
 * one of the user's explicit values refusals. Runs after hard gates pass.
 *
 * Threshold logic (post-LLM, pure code):
 *   - confidence >= VALUES_REJECT_CONFIDENCE → decision: reject
 *   - confidence in [VALUES_REVIEW_CONFIDENCE, VALUES_REJECT_CONFIDENCE)
 *       → decision: needs_review (do not auto-reject)
 *   - else → decision: clear
 *
 * If criteria.values_refusals is empty, this short-circuits to a CLEAR
 * decision without calling the provider. Saves cost on users who haven't
 * configured refusals.
 */
export async function valuesCheck(
  provider: JsonOutputProvider,
  input: ValuesCheckInput
): Promise<ValuesCheckOutput> {
  const refusals = input.criteria.values_refusals;

  // No refusals configured → no LLM call; cleared by definition.
  if (refusals.length === 0) {
    return {
      result: {
        decision: "clear",
        raw: {
          violation: false,
          matched_refusal: null,
          excerpt: null,
          confidence: 1.0,
          rationale: "No values refusals configured."
        },
        reason_code: ""
      },
      run: emptyProviderRun()
    };
  }

  const userPrompt = buildUserPrompt(input.facts, refusals);

  const { data, run } = await provider.generateJsonObject<ValuesVerdictRaw>({
    promptId: VALUES_PROMPT_ID,
    systemPrompt: VALUES_SYSTEM_PROMPT,
    userPrompt,
    outputSchema: valuesVerdictRawSchema,
    toolName: TOOL_NAME,
    toolDescription: TOOL_DESCRIPTION,
    model: input.model,
    maxRetries: input.maxRetries ?? 1,
    maxTokens: 1024
  });

  const result = applyThresholds(data, refusals);
  return { result, run };
}

/**
 * Build the variable per-posting user prompt for values_check. Exposed
 * (rather than kept private) so the callback-pipeline state machine
 * reuses the same wording without prompt duplication.
 */
export function buildValuesUserPrompt(
  facts: ExtractedJobFacts,
  refusals: readonly string[]
): string {
  return buildUserPrompt(facts, refusals);
}

function buildUserPrompt(
  facts: ExtractedJobFacts,
  refusals: readonly string[]
): string {
  const refusalsBlock = refusals.map((r, i) => `${i + 1}. ${r}`).join("\n");
  return `# User's values refusals

${refusalsBlock}

# Posting facts (extracted, version: ${facts.extractor_version})

Title: ${facts.title}
Company: ${facts.company}
Industry tags: ${facts.industry_tags.join(", ") || "(none)"}
Stack: ${facts.stack.join(", ") || "(none)"}
Required clearance: ${facts.required_clearance ?? "(none)"}

# Posting excerpt

${facts.raw_text_excerpt}`;
}

/**
 * Pure function: maps the raw LLM verdict to a final decision using the
 * documented thresholds. Validates that violation/matched_refusal are
 * consistent (a violation must name the matched refusal).
 */
export function applyThresholds(
  raw: ValuesVerdictRaw,
  refusals: readonly string[]
): ValuesCheckResult {
  // Sanity checks. Even with strict Zod, the model can be self-inconsistent
  // (violation: true with matched_refusal: null, etc). Treat as needs_review
  // rather than silently auto-rejecting on a half-formed verdict.
  if (!raw.violation) {
    return {
      decision: "clear",
      raw,
      reason_code: ""
    };
  }

  if (raw.matched_refusal === null || raw.matched_refusal.length === 0) {
    return {
      decision: "needs_review",
      raw,
      reason_code: ""
    };
  }

  // Verify the matched_refusal is actually one the user listed (or a near
  // paraphrase). The Zod schema doesn't enforce this — we do it here so
  // that hallucinated refusal strings don't masquerade as user values.
  if (!refusalsContain(refusals, raw.matched_refusal)) {
    return {
      decision: "needs_review",
      raw,
      reason_code: ""
    };
  }

  if (raw.confidence >= VALUES_REJECT_CONFIDENCE) {
    return {
      decision: "reject",
      raw,
      reason_code: buildReasonCodeForRefusal(raw.matched_refusal)
    };
  }

  if (raw.confidence >= VALUES_REVIEW_CONFIDENCE) {
    return {
      decision: "needs_review",
      raw,
      reason_code: ""
    };
  }

  return {
    decision: "clear",
    raw,
    reason_code: ""
  };
}

function refusalsContain(refusals: readonly string[], matched: string): boolean {
  const m = matched.trim().toLowerCase();
  return refusals.some((r) => r.trim().toLowerCase() === m);
}

function buildReasonCodeForRefusal(matched: string): string {
  return `values:${slugifyReasonValue(matched)}`;
}

// Internal: avoid an extra import-cycle hop just to reuse the slug helper
// from gates. Re-exported via index.ts for parity with hard-gate codes.
void buildReasonCode;

function emptyProviderRun(): ProviderRun {
  return {
    provider: "skipped",
    model: "",
    prompt_id: VALUES_PROMPT_ID,
    started_at: new Date(0).toISOString(),
    latency_ms: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    cost_usd_cents: 0,
    stop_reason: "skipped_no_refusals",
    retries: 0
  };
}
