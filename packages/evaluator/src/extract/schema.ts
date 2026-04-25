import { z } from "zod";
import {
  clearanceLevelSchema,
  employmentTypeSchema,
  seniorityBandSchema
} from "@networkpipeline/criteria";

/**
 * Controlled vocabulary for industry tags. Extend only via a versioned
 * release — changes here alter extraction outputs and invalidate any
 * cached evaluations keyed by extractor_version.
 */
export const industryTagSchema = z.enum([
  "software",
  "ai_ml",
  "research",
  "infra",
  "security",
  "fintech",
  "crypto_only",
  "defense_weapons",
  "autonomous_lethal_systems",
  "surveillance_for_state_actors",
  "gambling",
  "adtech_targeting",
  "healthcare",
  "biotech",
  "ecommerce",
  "saas",
  "robotics",
  "hardware",
  "devtools",
  "consumer",
  "enterprise",
  "other"
]);
export type IndustryTag = z.infer<typeof industryTagSchema>;

/**
 * Extractor output version. Increment when:
 *   - the system prompt changes in a way that can alter outputs
 *   - the schema adds a required field
 *   - the controlled vocabulary changes
 *
 * Never decrement. This acts as a cache-invalidation key for
 * job_evaluations and a reproducibility key for eval snapshots.
 */
export const EXTRACTOR_VERSION = "extract_v1";

export const requiredYoeSchema = z.object({
  min: z.number().int().gte(0).nullable(),
  max: z.number().int().gte(0).nullable()
});
export type RequiredYoe = z.infer<typeof requiredYoeSchema>;

export const requiredOnsiteSchema = z.object({
  is_required: z.boolean(),
  locations: z.array(z.string().min(1))
});
export type RequiredOnsite = z.infer<typeof requiredOnsiteSchema>;

/**
 * ExtractedJobFacts is the output of stage 1 (extract) of the evaluation
 * pipeline defined in docs/criteria.md §10.
 *
 * Design rules:
 * - No field depends on the user's criteria. Extraction is criteria-agnostic.
 * - Unknown values use `null` (optional scalars) or `[]` (arrays). Never
 *   fabricate defaults — downstream stages rely on absence-is-informative.
 * - Every field maps 1:1 to the posting text. Extractor does no reasoning
 *   across fields.
 */
export const extractedJobFactsSchema = z
  .object({
    extractor_version: z.literal(EXTRACTOR_VERSION),
    title: z.string().min(1),
    company: z.string().min(1),
    seniority_signals: z.array(seniorityBandSchema),
    required_clearance: clearanceLevelSchema.nullable(),
    required_yoe: requiredYoeSchema,
    industry_tags: z.array(industryTagSchema),
    required_onsite: requiredOnsiteSchema,
    employment_type: employmentTypeSchema.nullable(),
    work_authorization_constraints: z.array(z.string().min(1)),
    stack: z.array(z.string().min(1)),
    raw_text_excerpt: z.string()
  })
  .strict();

export type ExtractedJobFacts = z.infer<typeof extractedJobFactsSchema>;
