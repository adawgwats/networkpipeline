import { z } from "zod";

/**
 * values_check raw output as returned by the narrow LLM call.
 *
 * The model is instructed to emit a single tool call matching exactly this
 * shape. Keep the schema strict — drift here is a quality regression on the
 * filter, and we'd rather retry than absorb soft fields.
 */
export const valuesVerdictRawSchema = z
  .object({
    violation: z.boolean(),
    matched_refusal: z.string().nullable(),
    excerpt: z.string().nullable(),
    confidence: z.number().gte(0).lte(1),
    rationale: z.string().min(1)
  })
  .strict();

export type ValuesVerdictRaw = z.infer<typeof valuesVerdictRawSchema>;

/**
 * Decision after threshold logic is applied.
 *
 * Threshold semantics from docs/criteria.md §7.1:
 *   - violation && confidence >= REJECT_THRESHOLD  → reject
 *   - violation && confidence in [REVIEW_THRESHOLD, REJECT_THRESHOLD) → flag needs_review
 *   - everything else → clear
 */
export type ValuesDecision = "reject" | "needs_review" | "clear";

export type ValuesCheckResult = {
  decision: ValuesDecision;
  raw: ValuesVerdictRaw;
  /**
   * Stable reason code used when decision === "reject".
   * Shape: `values:<slugified_refusal>`. Matches docs/criteria.md §11.
   * Empty string when decision !== "reject".
   */
  reason_code: string;
};

/**
 * Confidence thresholds. Tuned conservatively: a borderline call is more
 * costly when we OVER-reject (a fit role lost) than when we ask the user
 * to weigh in via the active-learning loop. Numbers track the spec in
 * docs/criteria.md §7.1.
 */
export const VALUES_REJECT_CONFIDENCE = 0.6;
export const VALUES_REVIEW_CONFIDENCE = 0.4;

/**
 * Versioned prompt id surfaced on every ProviderRun for snapshot
 * reproducibility. Bump when the prompt text or threshold values change.
 */
export const VALUES_PROMPT_ID = "values_check@v1";
