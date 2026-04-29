import { z } from "zod";

/**
 * Per-topic contribution returned by the LLM.
 *
 * - `topic` echoes the criteria.soft_preferences[].topic verbatim so the
 *   evaluator can join contributions back to user-defined preferences.
 * - `weight` echoes the user-provided weight (range -1..1).
 * - `contribution` is the model's signed magnitude of fit for THAT topic
 *   (range -1..1). Positive means the posting hits the topic in the
 *   user's preferred direction; negative means it hits a negative
 *   preference. Magnitude is "how strongly".
 * - `rationale` is one sentence supporting the judgment. Required: the
 *   product surfaces this in the explain-the-rank panel.
 */
export const softScoreContributionSchema = z
  .object({
    topic: z.string().min(1),
    weight: z.number().gte(-1).lte(1),
    contribution: z.number().gte(-1).lte(1),
    rationale: z.string().min(1)
  })
  .strict();
export type SoftScoreContribution = z.infer<typeof softScoreContributionSchema>;

/**
 * Raw scoring output emitted by the LLM via tool-use. Strict on purpose;
 * any drift triggers the retry-with-errors loop in the provider.
 */
export const softScoreVerdictRawSchema = z
  .object({
    score: z.number().gte(0).lte(1),
    contributions: z.array(softScoreContributionSchema),
    rationale: z.string().min(1)
  })
  .strict();
export type SoftScoreVerdictRaw = z.infer<typeof softScoreVerdictRawSchema>;

/**
 * Final result after threshold logic. `below_threshold` is the only
 * post-LLM derivation; reason_code is empty unless `below_threshold`
 * is true (in which case it follows the §11 taxonomy).
 */
export type SoftScoreResult = {
  raw: SoftScoreVerdictRaw;
  below_threshold: boolean;
  /**
   * Stable code per docs/criteria.md §11. Shape:
   * `soft:below_threshold:<score_two_decimals>`.
   * Empty string when below_threshold is false.
   */
  reason_code: string;
};

/**
 * Versioned prompt id for snapshot reproducibility. Bump when the
 * instruction text or scoring math changes.
 */
export const SOFT_SCORE_PROMPT_ID = "soft_score@v1";

/**
 * Score returned when soft_score short-circuits because the user has
 * configured no positive AND no negative preferences. Documented as
 * "neutral" because we have no preference signal to judge against.
 */
export const NO_PREFERENCES_NEUTRAL_SCORE = 0.5;
