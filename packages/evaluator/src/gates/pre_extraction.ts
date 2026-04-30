import type { CandidateCriteria } from "@networkpipeline/criteria";
import type { DiscoveredPostingMetadata } from "./metadata.js";
import {
  buildReasonCode,
  GATE_ORDER,
  type GateName,
  type GateRejectResult,
  type GateResult
} from "./result.js";

/**
 * Subset of GATE_ORDER that is decidable from `DiscoveredPostingMetadata`
 * alone — i.e., before paying for LLM extraction.
 *
 * Listed in canonical execution order (a strict prefix-ordering of
 * GATE_ORDER, filtered to the metadata-decidable gates).
 *
 * The bipartite split:
 * - Pre-extraction (this list): substring/exact/enum checks over fields
 *   source connectors return directly.
 * - Post-extraction (`hardGateCheck`): everything here PLUS gates that
 *   need LLM-inferred facts (industry tags, clearance from full body,
 *   work-authorization constraints, parsed YOE).
 *
 * Invariant: a posting rejected by `preExtractionGateCheck` must also be
 * rejected by `hardGateCheck` over the equivalent fully-extracted facts,
 * with the same reason code. The reverse is NOT true — post-extraction
 * has access to inferred facts pre-extraction lacks.
 */
export const PRE_EXTRACTION_GATES: readonly GateName[] = [
  "must_not_contain_phrases",
  "company",
  "role_seniority",
  "location_requirement",
  "location_allowed",
  "employment_type"
] as const;

/**
 * pre_extraction_gate_check — runs the metadata-only subset of hard
 * gates before LLM extraction. Mirrors `hardGateCheck`'s signature and
 * return shape, but operates on `DiscoveredPostingMetadata`.
 *
 * Pure code. No LLM. Same inputs always produce the same output.
 *
 * Iterates GATE_ORDER, executing only the gates in PRE_EXTRACTION_GATES.
 * Short-circuits on first failure with a stable reason code from §11.
 *
 * Defers (does NOT reject) on ambiguous cases where post-extraction has
 * more info — e.g., role_seniority with empty signals, employment_type
 * null, or any non-metadata gate (industry/clearance/work_auth/yoe).
 */
export function preExtractionGateCheck(
  metadata: DiscoveredPostingMetadata,
  criteria: CandidateCriteria
): GateResult {
  const evaluated: GateName[] = [];
  const subset = new Set<GateName>(PRE_EXTRACTION_GATES);

  for (const gate of GATE_ORDER) {
    if (!subset.has(gate)) continue;
    evaluated.push(gate);
    const verdict = runGate(gate, metadata, criteria);
    if (verdict !== null) {
      return { ...verdict, gates_evaluated: evaluated };
    }
  }

  return { pass: true, gates_evaluated: evaluated };
}

type GateFailure = Omit<GateRejectResult, "gates_evaluated">;

function runGate(
  gate: GateName,
  metadata: DiscoveredPostingMetadata,
  criteria: CandidateCriteria
): GateFailure | null {
  switch (gate) {
    case "must_not_contain_phrases":
      return checkPhraseBlocklist(metadata, criteria);
    case "company":
      return checkCompanyBlocklist(metadata, criteria);
    case "location_requirement":
      return checkLocationRequirement(metadata, criteria);
    case "location_allowed":
      return checkLocationAllowed(metadata, criteria);
    case "employment_type":
      return checkEmploymentType(metadata, criteria);
    case "role_seniority":
      return checkRoleSeniority(metadata, criteria);
    // Gates that require LLM-extracted facts. Defer to post-extraction.
    case "industry":
    case "required_clearance":
    case "work_authorization":
    case "years_experience":
      return null;
    default: {
      const _exhaustive: never = gate;
      throw new Error(`unhandled gate: ${String(_exhaustive)}`);
    }
  }
}

// ---------- gate implementations ----------

function checkPhraseBlocklist(
  metadata: DiscoveredPostingMetadata,
  criteria: CandidateCriteria
): GateFailure | null {
  const phrases = criteria.hard_gates.must_not_contain_phrases;
  if (phrases.length === 0) return null;

  const haystack = (
    metadata.title +
    " " +
    (metadata.description_excerpt ?? "")
  ).toLowerCase();
  for (const phrase of phrases) {
    if (haystack.includes(phrase.toLowerCase())) {
      return {
        pass: false,
        gate: "must_not_contain_phrases",
        reason_code: buildReasonCode("must_not_contain_phrases", phrase),
        message: `Posting contains blocklisted phrase: "${phrase}".`,
        details: { phrase }
      };
    }
  }
  return null;
}

function checkCompanyBlocklist(
  metadata: DiscoveredPostingMetadata,
  criteria: CandidateCriteria
): GateFailure | null {
  const companyConditions = criteria.hard_gates.must_not_have.filter(
    (c) => c.kind === "company"
  );
  if (companyConditions.length === 0) return null;

  const factCompany = metadata.company.trim().toLowerCase();
  for (const cond of companyConditions) {
    for (const blocked of cond.any_of) {
      if (factCompany === blocked.toLowerCase()) {
        return {
          pass: false,
          gate: "company",
          reason_code: buildReasonCode("company", blocked),
          message: `Company "${metadata.company}" is in the must_not_have.company list. Reason: ${cond.reason}`,
          details: { matched_company: blocked, reason: cond.reason }
        };
      }
    }
  }
  return null;
}

function checkLocationRequirement(
  metadata: DiscoveredPostingMetadata,
  criteria: CandidateCriteria
): GateFailure | null {
  if (metadata.is_onsite_required !== true) return null;
  if (metadata.onsite_locations.length === 0) return null;

  const locConditions = criteria.hard_gates.must_not_have.filter(
    (c) => c.kind === "location_requirement"
  );
  if (locConditions.length === 0) return null;

  for (const cond of locConditions) {
    const allowed = cond.requires_onsite_in_not.map(normalizeLocation);
    const offending = metadata.onsite_locations.find(
      (loc) => !locationMatchesAny(loc, allowed)
    );
    if (offending !== undefined) {
      return {
        pass: false,
        gate: "location_requirement",
        reason_code: buildReasonCode("location_requirement", offending),
        message: `Posting requires onsite at "${offending}", which is not in the allowed list. Reason: ${cond.reason}`,
        details: {
          posting_locations: metadata.onsite_locations,
          allowed_locations: cond.requires_onsite_in_not,
          reason: cond.reason
        }
      };
    }
  }
  return null;
}

function checkLocationAllowed(
  metadata: DiscoveredPostingMetadata,
  criteria: CandidateCriteria
): GateFailure | null {
  const userMustHave = criteria.hard_gates.must_have.find(
    (c) => c.kind === "location_allowed"
  );
  if (!userMustHave) return null;

  const userLocations = criteria.profile.primary_locations.map(normalizeLocation);

  // Fully-remote (or unspecified) posting always satisfies the gate.
  if (metadata.is_onsite_required !== true) {
    return null;
  }
  if (metadata.onsite_locations.length === 0) {
    return null;
  }

  const anyMatch = metadata.onsite_locations.some((loc) =>
    locationMatchesAny(loc, userLocations)
  );
  if (!anyMatch) {
    return {
      pass: false,
      gate: "location_allowed",
      reason_code: buildReasonCode("location_allowed", "none_match"),
      message: `Posting onsite locations [${metadata.onsite_locations.join(
        ", "
      )}] do not intersect user's primary_locations [${criteria.profile.primary_locations.join(
        ", "
      )}].`,
      details: {
        posting_locations: metadata.onsite_locations,
        user_locations: criteria.profile.primary_locations
      }
    };
  }
  return null;
}

function checkEmploymentType(
  metadata: DiscoveredPostingMetadata,
  criteria: CandidateCriteria
): GateFailure | null {
  const userMustHave = criteria.hard_gates.must_have.find(
    (c) => c.kind === "employment_type"
  );
  if (!userMustHave || userMustHave.kind !== "employment_type") return null;

  if (metadata.employment_type === null) return null; // ambiguous; defer

  if (!userMustHave.value_in.includes(metadata.employment_type)) {
    return {
      pass: false,
      gate: "employment_type",
      reason_code: buildReasonCode("employment_type", metadata.employment_type),
      message: `Posting employment_type "${metadata.employment_type}" is not in user's allowed set [${userMustHave.value_in.join(
        ", "
      )}].`,
      details: {
        posting_type: metadata.employment_type,
        allowed: userMustHave.value_in
      }
    };
  }
  return null;
}

function checkRoleSeniority(
  metadata: DiscoveredPostingMetadata,
  criteria: CandidateCriteria
): GateFailure | null {
  const seniorityConditions = criteria.hard_gates.must_not_have.filter(
    (c) => c.kind === "role_seniority"
  );
  if (seniorityConditions.length === 0) return null;

  // Empty signals → defer. Post-extraction gets to reason from full body.
  if (metadata.inferred_seniority_signals.length === 0) return null;

  // Only reject when EVERY inferred signal is blocked. Mirrors the
  // post-extraction logic exactly so the bipartite invariant holds.
  for (const cond of seniorityConditions) {
    const blocked = new Set(cond.any_of);
    const allBlocked = metadata.inferred_seniority_signals.every((s) =>
      blocked.has(s)
    );
    if (allBlocked) {
      const matched = metadata.inferred_seniority_signals.filter((s) =>
        blocked.has(s)
      );
      return {
        pass: false,
        gate: "role_seniority",
        reason_code: buildReasonCode("role_seniority", matched[0] ?? "unknown"),
        message: `Posting seniority signals [${matched.join(", ")}] are all out of band. Reason: ${cond.reason}`,
        details: {
          posting_signals: metadata.inferred_seniority_signals,
          blocked_bands: cond.any_of,
          reason: cond.reason
        }
      };
    }
  }
  return null;
}

// ---------- helpers ----------
//
// These helpers are deliberately local copies of the equivalents in
// `check.ts`. The bipartite invariant relies on identical normalization
// and matching semantics; making them private avoids cross-file drift
// risk while keeping check.ts untouched per the discovery refactor plan.

function normalizeLocation(loc: string): string {
  return loc
    .toLowerCase()
    .replace(/[\s,]+/g, " ")
    .trim();
}

function locationMatchesAny(value: string, allowed: string[]): boolean {
  const normValue = normalizeLocation(value);
  if (allowed.some((a) => a === "remote") && /\bremote\b/.test(normValue)) {
    return true;
  }
  return allowed.some((a) => {
    if (!a) return false;
    return normValue.includes(a) || a.includes(normValue);
  });
}
