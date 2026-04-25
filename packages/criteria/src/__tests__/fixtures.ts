import type { CandidateCriteria } from "../schema.js";

export const validMinimalCriteriaYaml = `
version: 1
schema_version: "1.0.0"
updated_at: "2026-04-24T00:00:00Z"
updated_via: conversation_with_claude
profile:
  display_name: "Andrew Watson"
  years_experience: 4
  primary_locations: [DC-metro, NYC, remote]
  work_authorization: us_citizen_or_permanent_resident
  seniority_band: [mid, senior]
values_refusals:
  - "Autonomous lethal systems or weapon targeting"
`;

export const validRichCriteriaYaml = `
version: 7
schema_version: "1.0.0"
updated_at: "2026-04-24T00:00:00Z"
updated_via: conversation_with_claude
extends: []
overlays:
  - "@networkpipeline/overlays/no-defense-companies"
profile:
  display_name: "Andrew Watson"
  years_experience: 4
  primary_locations: [DC-metro, NYC, remote, Fredericksburg-VA]
  work_authorization: us_citizen_or_permanent_resident
  seniority_band: [mid, senior]
hard_gates:
  must_have:
    - kind: years_experience
      op: ">="
      value: 3
    - kind: employment_type
      value_in: [full_time, contract_to_hire]
    - kind: work_authorization
      value: us_citizen_or_permanent_resident
  must_not_have:
    - kind: required_clearance
      any_of: [secret, top_secret, ts_sci, dod_clearance_required]
      reason: "No DOD background; clearance roles auto-reject"
    - kind: industry
      any_of: [defense_weapons, autonomous_lethal_systems]
      reason: "Values-based refusal"
    - kind: role_seniority
      any_of: [staff, principal, director, vp, intern, new_grad]
      reason: "4 YoE — outside seniority band"
  must_not_contain_phrases:
    - "active security clearance required"
    - "on-site 5 days"
values_refusals:
  - "Autonomous lethal systems or weapon targeting"
  - "Mass surveillance tooling sold to state actors"
soft_preferences:
  positive:
    - topic: "AI/ML evaluation systems"
      weight: 1.0
      evidence: "VegaTitan, MAESTRO at Amazon"
    - topic: "Frontier AI labs"
      weight: 1.0
      companies_boost: [Anthropic, OpenAI, Scale AI]
  negative:
    - topic: "crypto/web3-only roles"
      weight: -0.6
  min_soft_score: 0.55
calibration:
  accepted_examples:
    - url: "https://example.com/role-1"
      why: "Dead-center fit"
      score: 0.95
  rejected_examples:
    - url: "https://example.com/role-2"
      why: "Values refusal"
      rejection_reason: "values:autonomous_lethal_systems"
    - url: "https://example.com/role-3"
      why: "Wrong seniority"
      rejection_reason: "hard_gate:role_seniority:staff"
`;

export const invalidBadSchemaVersion = `
version: 1
schema_version: "9.0.0"
updated_at: "2026-04-24T00:00:00Z"
updated_via: test
profile:
  display_name: "X"
  years_experience: 2
  primary_locations: [remote]
  work_authorization: us_citizen
  seniority_band: [junior]
values_refusals: []
`;

export const invalidMissingProfile = `
version: 1
schema_version: "1.0.0"
updated_at: "2026-04-24T00:00:00Z"
updated_via: test
values_refusals: []
`;

export const invalidBadReasonCode = `
version: 1
schema_version: "1.0.0"
updated_at: "2026-04-24T00:00:00Z"
updated_via: test
profile:
  display_name: "X"
  years_experience: 2
  primary_locations: [remote]
  work_authorization: us_citizen
  seniority_band: [junior]
values_refusals: []
calibration:
  rejected_examples:
    - why: "Whatever"
      rejection_reason: "just_because"
`;

export const invalidBadDatetime = `
version: 1
schema_version: "1.0.0"
updated_at: "not-a-date"
updated_via: test
profile:
  display_name: "X"
  years_experience: 2
  primary_locations: [remote]
  work_authorization: us_citizen
  seniority_band: [junior]
values_refusals: []
`;

export const invalidNegativeWeight = `
version: 1
schema_version: "1.0.0"
updated_at: "2026-04-24T00:00:00Z"
updated_via: test
profile:
  display_name: "X"
  years_experience: 2
  primary_locations: [remote]
  work_authorization: us_citizen
  seniority_band: [junior]
values_refusals: []
soft_preferences:
  positive:
    - topic: "Something"
      weight: 1.5
`;

export const invalidUnknownField = `
version: 1
schema_version: "1.0.0"
updated_at: "2026-04-24T00:00:00Z"
updated_via: test
profile:
  display_name: "X"
  years_experience: 2
  primary_locations: [remote]
  work_authorization: us_citizen
  seniority_band: [junior]
values_refusals: []
typoed_top_level_field: true
`;

export function assertIsCandidateCriteria(
  value: unknown
): asserts value is CandidateCriteria {
  if (typeof value !== "object" || value === null) {
    throw new Error("expected a CandidateCriteria object");
  }
}
