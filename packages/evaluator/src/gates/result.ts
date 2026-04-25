/**
 * Hard gate verdict. Pure code; no LLM involvement.
 *
 * The reason_code follows the stable taxonomy in docs/criteria.md §11 so
 * downstream consumers (UI, eval harness, active-learning loop) can
 * programmatically branch on rejection reasons.
 *
 * Reason code shape: `hard_gate:<gate_name>:<specific_value>`.
 * Examples:
 *   - hard_gate:must_not_contain_phrases:active security clearance required
 *   - hard_gate:company:Anduril
 *   - hard_gate:industry:autonomous_lethal_systems
 *   - hard_gate:required_clearance:secret
 *   - hard_gate:role_seniority:staff
 *   - hard_gate:location_requirement:Denver, CO
 *   - hard_gate:work_authorization:requires_sponsorship
 *   - hard_gate:location_allowed:none_match
 *   - hard_gate:employment_type:contract
 *   - hard_gate:years_experience:required_5_have_3
 */
export type GateName =
  | "must_not_contain_phrases"
  | "company"
  | "industry"
  | "required_clearance"
  | "role_seniority"
  | "location_requirement"
  | "work_authorization"
  | "location_allowed"
  | "employment_type"
  | "years_experience";

/**
 * Stable execution order. Cheaper / more decisive gates run first.
 *
 * 1. must_not_contain_phrases — pure substring match, fastest
 * 2. company                  — exact company-name match
 * 3. industry                 — controlled-vocabulary tag match
 * 4. required_clearance       — clearance enum match
 * 5. role_seniority           — band overlap
 * 6. location_requirement     — onsite-location list check
 * 7. work_authorization       — sponsorship-status check
 * 8. location_allowed         — profile.primary_locations match
 * 9. employment_type          — type membership
 * 10. years_experience        — numeric requirement vs profile YOE
 *
 * Pipeline short-circuits on first failure.
 */
export const GATE_ORDER: readonly GateName[] = [
  "must_not_contain_phrases",
  "company",
  "industry",
  "required_clearance",
  "role_seniority",
  "location_requirement",
  "work_authorization",
  "location_allowed",
  "employment_type",
  "years_experience"
] as const;

export type GatePassResult = {
  pass: true;
  /** All gates that ran (always all 10 in order on a pass). */
  gates_evaluated: GateName[];
};

export type GateRejectResult = {
  pass: false;
  gate: GateName;
  /** docs/criteria.md §11 stable reason code. */
  reason_code: string;
  /**
   * Brief explanation suitable for UI surfacing and eval-harness ground
   * truth. Free-text; do not rely on the wording for branching logic.
   */
  message: string;
  /**
   * Structured details for advanced consumers (active-learning loop,
   * reviewers). Shape varies per gate.
   */
  details: Record<string, unknown>;
  /** All gates that ran before this one short-circuited. */
  gates_evaluated: GateName[];
};

export type GateResult = GatePassResult | GateRejectResult;

/**
 * Slugify a value for inclusion in a reason code. Keeps alphanumeric,
 * dashes, and underscores; replaces everything else with `_` and lowercases.
 * Stable for any string input.
 */
export function slugifyReasonValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

export function buildReasonCode(gate: GateName, value: string): string {
  return `hard_gate:${gate}:${slugifyReasonValue(value)}`;
}
