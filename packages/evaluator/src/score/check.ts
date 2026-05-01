import type { CandidateCriteria } from "@networkpipeline/criteria";
import type { ExtractedJobFacts } from "../extract/schema.js";
import type { JsonOutputProvider, ProviderRun } from "../provider/types.js";
import { buildSoftScoreSystemPrompt } from "./prompt.js";
import {
  NO_PREFERENCES_NEUTRAL_SCORE,
  SOFT_SCORE_PROMPT_ID,
  softScoreVerdictRawSchema,
  type SoftScoreResult,
  type SoftScoreVerdictRaw
} from "./schema.js";

const TOOL_NAME = "submit_soft_score";
const TOOL_DESCRIPTION =
  "Submit the structured soft-score verdict for this posting. Call exactly once with all fields populated.";

export type SoftScoreInput = {
  facts: ExtractedJobFacts;
  criteria: CandidateCriteria;
  /** Optional per-call retry override. Defaults to 1. */
  maxRetries?: number;
  /** Optional per-call model override. */
  model?: string;
};

export type SoftScoreOutput = {
  result: SoftScoreResult;
  run: ProviderRun;
};

/**
 * soft_score — stage 3 of the evaluation pipeline (docs/criteria.md §8 + §10).
 *
 * Runs only if hard gates passed AND values_check cleared. Returns a
 * float score in [0, 1] with per-topic contributions for explainability.
 *
 * Short-circuit: when criteria has no positive AND no negative
 * preferences configured, returns NO_PREFERENCES_NEUTRAL_SCORE without
 * calling the provider. Documents the empty preferences state honestly
 * rather than hallucinating a fit signal.
 */
export async function softScore(
  provider: JsonOutputProvider,
  input: SoftScoreInput
): Promise<SoftScoreOutput> {
  const { soft_preferences } = input.criteria;
  const totalPreferences =
    soft_preferences.positive.length + soft_preferences.negative.length;

  if (totalPreferences === 0) {
    return {
      result: applyThreshold(
        {
          score: NO_PREFERENCES_NEUTRAL_SCORE,
          contributions: [],
          rationale:
            "No soft preferences configured; returning neutral score (0.5)."
        },
        input.criteria
      ),
      run: emptyProviderRun()
    };
  }

  const systemPrompt = buildSoftScoreSystemPrompt(input.criteria);
  const userPrompt = buildUserPrompt(input.facts);

  const { data, run } = await provider.generateJsonObject<SoftScoreVerdictRaw>({
    promptId: SOFT_SCORE_PROMPT_ID,
    systemPrompt,
    userPrompt,
    outputSchema: softScoreVerdictRawSchema,
    toolName: TOOL_NAME,
    toolDescription: TOOL_DESCRIPTION,
    model: input.model,
    maxRetries: input.maxRetries ?? 1,
    maxTokens: 2048
  });

  return { result: applyThreshold(data, input.criteria), run };
}

/**
 * Build the variable per-posting user prompt for soft_score. Exposed
 * (rather than kept private) so the callback-pipeline state machine
 * reuses the exact same wording without prompt duplication.
 */
export function buildSoftScoreUserPrompt(facts: ExtractedJobFacts): string {
  return buildUserPrompt(facts);
}

function buildUserPrompt(facts: ExtractedJobFacts): string {
  return `# Posting facts (extracted, version: ${facts.extractor_version})

Title: ${facts.title}
Company: ${facts.company}
Industry tags: ${facts.industry_tags.join(", ") || "(none)"}
Stack: ${facts.stack.join(", ") || "(none)"}
Seniority signals: ${facts.seniority_signals.join(", ") || "(none)"}
Required clearance: ${facts.required_clearance ?? "(none)"}
Required YoE: ${formatYoe(facts.required_yoe)}
Onsite: ${formatOnsite(facts.required_onsite)}
Employment type: ${facts.employment_type ?? "(unknown)"}

# Posting excerpt

${facts.raw_text_excerpt}`;
}

function formatYoe(yoe: ExtractedJobFacts["required_yoe"]): string {
  if (yoe.min === null && yoe.max === null) return "(unspecified)";
  const min = yoe.min ?? "?";
  const max = yoe.max ?? "?";
  return `${min}–${max} years`;
}

function formatOnsite(onsite: ExtractedJobFacts["required_onsite"]): string {
  if (!onsite.is_required) return "remote / not required";
  if (onsite.locations.length === 0) return "required, locations not specified";
  return `required at ${onsite.locations.join(", ")}`;
}

/**
 * Pure function: applies the min_soft_score threshold to a raw verdict
 * and emits the §11 reason code on below-threshold cases.
 *
 * Reason code shape: `soft:below_threshold:<score>` with score formatted
 * to 2 decimals. Stable across runs of the same evaluation.
 */
export function applyThreshold(
  raw: SoftScoreVerdictRaw,
  criteria: CandidateCriteria
): SoftScoreResult {
  const threshold = criteria.soft_preferences.min_soft_score;
  const below = raw.score < threshold;
  return {
    raw,
    below_threshold: below,
    reason_code: below
      ? `soft:below_threshold:${raw.score.toFixed(2)}`
      : ""
  };
}

function emptyProviderRun(): ProviderRun {
  return {
    provider: "skipped",
    model: "",
    prompt_id: SOFT_SCORE_PROMPT_ID,
    started_at: new Date(0).toISOString(),
    latency_ms: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    cost_usd_cents: 0,
    stop_reason: "skipped_no_preferences",
    retries: 0
  };
}
