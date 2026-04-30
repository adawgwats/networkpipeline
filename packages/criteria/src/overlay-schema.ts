import { z } from "zod";
import {
  mustNotHaveConditionSchema,
  softPreferenceItemSchema
} from "./schema.js";

/**
 * OverlayFragment is the parsed form of an overlay YAML file.
 *
 * Per docs/criteria.md §4.2, overlays may ONLY add to:
 *   - hard_gates.must_not_have
 *   - values_refusals
 *   - soft_preferences.negative
 *
 * The cannot-weaken rule is enforced AT PARSE TIME via strict mode:
 * if an overlay file contains any other top-level field (or any other
 * field within hard_gates / soft_preferences), the parse fails. There
 * is no runtime branch that compares overlay-content to base-content
 * because the schema makes that comparison unnecessary.
 *
 * This also rules out "weaker" overlays by construction: there is no
 * way to express "remove an entry from must_not_have" or "lower
 * min_soft_score" in this schema.
 */
const overlayHardGatesFragmentSchema = z
  .object({
    must_not_have: z.array(mustNotHaveConditionSchema).optional()
  })
  .strict();

const overlaySoftPreferencesFragmentSchema = z
  .object({
    negative: z.array(softPreferenceItemSchema).optional()
  })
  .strict();

export const overlayFragmentSchema = z
  .object({
    hard_gates: overlayHardGatesFragmentSchema.optional(),
    values_refusals: z.array(z.string().min(1)).optional(),
    soft_preferences: overlaySoftPreferencesFragmentSchema.optional()
  })
  .strict();

export type OverlayFragment = z.infer<typeof overlayFragmentSchema>;
