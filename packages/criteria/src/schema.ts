import { z } from "zod";

export const CURRENT_SCHEMA_VERSION = "1.0.0";

const semverPattern = /^\d+\.\d+\.\d+$/;

export const seniorityBandSchema = z.enum([
  "intern",
  "new_grad",
  "junior",
  "mid",
  "senior",
  "staff",
  "principal",
  "director",
  "vp"
]);
export type SeniorityBand = z.infer<typeof seniorityBandSchema>;

/**
 * Coarse role-kind taxonomy used by the deterministic title-classifier
 * pre-extraction filter (see packages/discovery/src/connector/role_kind.ts).
 *
 * Lives in @networkpipeline/criteria — alongside SeniorityBand — so both
 * `discovery` (for inference) and `evaluator` (for gating) can import it
 * without forcing a `discovery → evaluator → discovery` cycle.
 *
 * Multi-tag is intentional: a "Solutions Engineer" is both `engineering`
 * and `sales`. The user's blocklist controls which tags reject; the
 * classifier may emit several.
 *
 * `"other"` means "title didn't match any kind". Pre-extraction treats
 * an `["other"]` (or empty) result as a defer, NOT a reject — same
 * defer-on-ambiguity contract as role_seniority.
 */
export const roleKindSchema = z.enum([
  "engineering",
  "research",
  "ml",
  "infrastructure",
  "security",
  "design",
  "product",
  "sales",
  "customer_success",
  "marketing",
  "recruiting",
  "people_ops",
  "finance",
  "legal",
  "operations",
  "support",
  "data",
  "devrel",
  "policy",
  "other"
]);
export type RoleKind = z.infer<typeof roleKindSchema>;

export const ALL_ROLE_KINDS: readonly RoleKind[] = [
  "engineering",
  "research",
  "ml",
  "infrastructure",
  "security",
  "design",
  "product",
  "sales",
  "customer_success",
  "marketing",
  "recruiting",
  "people_ops",
  "finance",
  "legal",
  "operations",
  "support",
  "data",
  "devrel",
  "policy",
  "other"
] as const;

export const workAuthorizationSchema = z.enum([
  "us_citizen",
  "us_citizen_or_permanent_resident",
  "requires_sponsorship",
  "not_applicable"
]);
export type WorkAuthorization = z.infer<typeof workAuthorizationSchema>;

export const employmentTypeSchema = z.enum([
  "full_time",
  "contract_to_hire",
  "contract",
  "internship"
]);
export type EmploymentType = z.infer<typeof employmentTypeSchema>;

export const clearanceLevelSchema = z.enum([
  "secret",
  "top_secret",
  "ts_sci",
  "dod_clearance_required"
]);
export type ClearanceLevel = z.infer<typeof clearanceLevelSchema>;

export const profileSchema = z.object({
  display_name: z.string().min(1),
  years_experience: z.number().int().nonnegative(),
  primary_locations: z.array(z.string().min(1)).min(1),
  work_authorization: workAuthorizationSchema,
  seniority_band: z.array(seniorityBandSchema).min(1)
});
export type Profile = z.infer<typeof profileSchema>;

const mustHaveYearsExperience = z.object({
  kind: z.literal("years_experience"),
  op: z.enum([">=", ">", "<=", "<", "=="]),
  value: z.number().int().nonnegative()
});

const mustHaveEmploymentType = z.object({
  kind: z.literal("employment_type"),
  value_in: z.array(employmentTypeSchema).min(1)
});

const mustHaveWorkAuthorization = z.object({
  kind: z.literal("work_authorization"),
  value: workAuthorizationSchema
});

const mustHaveLocationAllowed = z.object({
  kind: z.literal("location_allowed")
});

export const mustHaveConditionSchema = z.discriminatedUnion("kind", [
  mustHaveYearsExperience,
  mustHaveEmploymentType,
  mustHaveWorkAuthorization,
  mustHaveLocationAllowed
]);
export type MustHaveCondition = z.infer<typeof mustHaveConditionSchema>;

const mustNotHaveRequiredClearance = z.object({
  kind: z.literal("required_clearance"),
  any_of: z.array(clearanceLevelSchema).min(1),
  reason: z.string().min(1)
});

const mustNotHaveIndustry = z.object({
  kind: z.literal("industry"),
  any_of: z.array(z.string().min(1)).min(1),
  reason: z.string().min(1)
});

const mustNotHaveCompany = z.object({
  kind: z.literal("company"),
  any_of: z.array(z.string().min(1)).min(1),
  reason: z.string().min(1)
});

const mustNotHaveRoleSeniority = z.object({
  kind: z.literal("role_seniority"),
  any_of: z.array(seniorityBandSchema).min(1),
  reason: z.string().min(1)
});

const mustNotHaveLocationRequirement = z.object({
  kind: z.literal("location_requirement"),
  requires_onsite_in_not: z.array(z.string().min(1)).min(1),
  reason: z.string().min(1)
});

const mustNotHaveRoleKind = z.object({
  kind: z.literal("role_kind"),
  any_of: z.array(roleKindSchema).min(1),
  reason: z.string().min(1)
});

export const mustNotHaveConditionSchema = z.discriminatedUnion("kind", [
  mustNotHaveRequiredClearance,
  mustNotHaveIndustry,
  mustNotHaveCompany,
  mustNotHaveRoleSeniority,
  mustNotHaveLocationRequirement,
  mustNotHaveRoleKind
]);
export type MustNotHaveCondition = z.infer<typeof mustNotHaveConditionSchema>;

export const hardGatesSchema = z.object({
  must_have: z.array(mustHaveConditionSchema).default([]),
  must_not_have: z.array(mustNotHaveConditionSchema).default([]),
  must_not_contain_phrases: z.array(z.string().min(1)).default([])
});
export type HardGates = z.infer<typeof hardGatesSchema>;

export const valuesRefusalsSchema = z.array(z.string().min(1)).default([]);
export type ValuesRefusals = z.infer<typeof valuesRefusalsSchema>;

export const softPreferenceItemSchema = z.object({
  topic: z.string().min(1),
  weight: z.number().gte(-1).lte(1),
  evidence: z.string().optional(),
  companies_boost: z.array(z.string().min(1)).optional()
});
export type SoftPreferenceItem = z.infer<typeof softPreferenceItemSchema>;

export const softPreferencesSchema = z.object({
  positive: z.array(softPreferenceItemSchema).default([]),
  negative: z.array(softPreferenceItemSchema).default([]),
  min_soft_score: z.number().gte(0).lte(1).default(0.55)
});
export type SoftPreferences = z.infer<typeof softPreferencesSchema>;

export const acceptedCalibrationExampleSchema = z.object({
  url: z.string().url().optional(),
  why: z.string().min(1),
  score: z.number().gte(0).lte(1)
});
export type AcceptedCalibrationExample = z.infer<typeof acceptedCalibrationExampleSchema>;

const reasonCodePattern =
  /^(hard_gate|values|soft):[a-z_][a-z0-9_]*(:.+)?$/i;

export const rejectedCalibrationExampleSchema = z.object({
  url: z.string().url().optional(),
  why: z.string().min(1),
  rejection_reason: z.string().regex(reasonCodePattern, {
    message: "rejection_reason must match reason-code taxonomy (see docs/criteria.md §11)"
  })
});
export type RejectedCalibrationExample = z.infer<typeof rejectedCalibrationExampleSchema>;

export const calibrationSchema = z.object({
  accepted_examples: z.array(acceptedCalibrationExampleSchema).default([]),
  rejected_examples: z.array(rejectedCalibrationExampleSchema).default([])
});
export type Calibration = z.infer<typeof calibrationSchema>;

export const candidateCriteriaSchema = z
  .object({
    version: z.number().int().positive(),
    schema_version: z.string().regex(semverPattern, {
      message: "schema_version must be semver (e.g. 1.0.0)"
    }),
    updated_at: z.string().datetime({
      message: "updated_at must be ISO-8601 datetime (e.g. 2026-04-24T00:00:00Z)"
    }),
    updated_via: z.string().min(1),
    extends: z.array(z.string().min(1)).default([]),
    overlays: z.array(z.string().min(1)).default([]),
    profile: profileSchema,
    hard_gates: hardGatesSchema.default({
      must_have: [],
      must_not_have: [],
      must_not_contain_phrases: []
    }),
    values_refusals: valuesRefusalsSchema,
    soft_preferences: softPreferencesSchema.default({
      positive: [],
      negative: [],
      min_soft_score: 0.55
    }),
    calibration: calibrationSchema.default({
      accepted_examples: [],
      rejected_examples: []
    })
  })
  .strict();

export type CandidateCriteria = z.infer<typeof candidateCriteriaSchema>;
