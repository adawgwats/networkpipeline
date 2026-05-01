import type { CandidateCriteria } from "@networkpipeline/criteria";
import type { ExtractedJobFacts } from "../extract/schema.js";
import type { DiscoveredPostingMetadata } from "./metadata.js";
import {
  buildReasonCode,
  GATE_ORDER,
  type GateName,
  type GateRejectResult,
  type GateResult
} from "./result.js";

/**
 * hard_gate_check — stage 2 of the evaluation pipeline (docs/criteria.md §10).
 *
 * Pure code. No LLM. Same inputs always produce the same output.
 *
 * Runs all 11 gates in the order documented in §6.4, short-circuiting on
 * the first failure with a stable reason code from §11.
 *
 * The optional `metadata` parameter forwards title-classifier values
 * (notably `inferred_role_kinds`) from the discovery layer. When
 * provided, the `role_kind` gate uses those tags. When absent (e.g.
 * the manual-paste path with no title), the gate defers — same
 * defer-on-ambiguity contract as role_seniority.
 */
export function hardGateCheck(
  facts: ExtractedJobFacts,
  criteria: CandidateCriteria,
  metadata?: DiscoveredPostingMetadata
): GateResult {
  const evaluated: GateName[] = [];

  for (const gate of GATE_ORDER) {
    evaluated.push(gate);
    const verdict = runGate(gate, facts, criteria, metadata);
    if (verdict !== null) {
      return { ...verdict, gates_evaluated: evaluated };
    }
  }

  return { pass: true, gates_evaluated: evaluated };
}

type GateFailure = Omit<GateRejectResult, "gates_evaluated">;

function runGate(
  gate: GateName,
  facts: ExtractedJobFacts,
  criteria: CandidateCriteria,
  metadata: DiscoveredPostingMetadata | undefined
): GateFailure | null {
  switch (gate) {
    case "must_not_contain_phrases":
      return checkPhraseBlocklist(facts, criteria);
    case "company":
      return checkCompanyBlocklist(facts, criteria);
    case "industry":
      return checkIndustryBlocklist(facts, criteria);
    case "role_kind":
      return checkRoleKind(metadata, criteria);
    case "required_clearance":
      return checkRequiredClearance(facts, criteria);
    case "role_seniority":
      return checkRoleSeniority(facts, criteria);
    case "location_requirement":
      return checkLocationRequirement(facts, criteria);
    case "work_authorization":
      return checkWorkAuthorization(facts, criteria);
    case "location_allowed":
      return checkLocationAllowed(facts, criteria);
    case "employment_type":
      return checkEmploymentType(facts, criteria);
    case "years_experience":
      return checkYearsExperience(facts, criteria);
    default: {
      const _exhaustive: never = gate;
      throw new Error(`unhandled gate: ${String(_exhaustive)}`);
    }
  }
}

function checkRoleKind(
  metadata: DiscoveredPostingMetadata | undefined,
  criteria: CandidateCriteria
): GateFailure | null {
  const conditions = criteria.hard_gates.must_not_have.filter(
    (c) => c.kind === "role_kind"
  );
  if (conditions.length === 0) return null;

  // Defer when no metadata (e.g., manual_paste path, evaluator unit
  // tests calling hardGateCheck directly without a discovery upstream)
  // or when the title-classifier returned only "other"/empty.
  const kinds = metadata?.inferred_role_kinds ?? [];
  if (kinds.length === 0) return null;
  const onlyOther = kinds.every((k) => k === "other");
  if (onlyOther) return null;

  for (const cond of conditions) {
    const blocked = new Set(cond.any_of);
    const matched = kinds.find((k) => blocked.has(k));
    if (matched !== undefined) {
      return {
        pass: false,
        gate: "role_kind",
        reason_code: buildReasonCode("role_kind", matched),
        message: `Posting role_kind tags [${kinds.join(
          ", "
        )}] overlap the blocklist [${cond.any_of.join(", ")}] (matched: ${matched}). Reason: ${cond.reason}`,
        details: {
          posting_role_kinds: kinds,
          blocked_kinds: cond.any_of,
          matched_kind: matched,
          reason: cond.reason
        }
      };
    }
  }
  return null;
}

// ---------- gate implementations ----------

function checkPhraseBlocklist(
  facts: ExtractedJobFacts,
  criteria: CandidateCriteria
): GateFailure | null {
  const phrases = criteria.hard_gates.must_not_contain_phrases;
  if (phrases.length === 0) return null;

  const haystack = facts.raw_text_excerpt.toLowerCase();
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
  facts: ExtractedJobFacts,
  criteria: CandidateCriteria
): GateFailure | null {
  const companyConditions = criteria.hard_gates.must_not_have.filter(
    (c) => c.kind === "company"
  );
  if (companyConditions.length === 0) return null;

  const factCompany = facts.company.trim().toLowerCase();
  for (const cond of companyConditions) {
    for (const blocked of cond.any_of) {
      if (factCompany === blocked.toLowerCase()) {
        return {
          pass: false,
          gate: "company",
          reason_code: buildReasonCode("company", blocked),
          message: `Company "${facts.company}" is in the must_not_have.company list. Reason: ${cond.reason}`,
          details: { matched_company: blocked, reason: cond.reason }
        };
      }
    }
  }
  return null;
}

function checkIndustryBlocklist(
  facts: ExtractedJobFacts,
  criteria: CandidateCriteria
): GateFailure | null {
  const industryConditions = criteria.hard_gates.must_not_have.filter(
    (c) => c.kind === "industry"
  );
  if (industryConditions.length === 0) return null;

  const factTags = new Set(facts.industry_tags.map((t) => t.toLowerCase()));
  for (const cond of industryConditions) {
    for (const blocked of cond.any_of) {
      if (factTags.has(blocked.toLowerCase())) {
        return {
          pass: false,
          gate: "industry",
          reason_code: buildReasonCode("industry", blocked),
          message: `Posting tagged with blocked industry "${blocked}". Reason: ${cond.reason}`,
          details: { matched_tag: blocked, reason: cond.reason }
        };
      }
    }
  }
  return null;
}

function checkRequiredClearance(
  facts: ExtractedJobFacts,
  criteria: CandidateCriteria
): GateFailure | null {
  if (facts.required_clearance === null) return null;

  const clearanceConditions = criteria.hard_gates.must_not_have.filter(
    (c) => c.kind === "required_clearance"
  );
  if (clearanceConditions.length === 0) return null;

  for (const cond of clearanceConditions) {
    if (cond.any_of.includes(facts.required_clearance)) {
      return {
        pass: false,
        gate: "required_clearance",
        reason_code: buildReasonCode(
          "required_clearance",
          facts.required_clearance
        ),
        message: `Posting requires "${facts.required_clearance}" clearance. Reason: ${cond.reason}`,
        details: {
          required_clearance: facts.required_clearance,
          reason: cond.reason
        }
      };
    }
  }
  return null;
}

function checkRoleSeniority(
  facts: ExtractedJobFacts,
  criteria: CandidateCriteria
): GateFailure | null {
  const seniorityConditions = criteria.hard_gates.must_not_have.filter(
    (c) => c.kind === "role_seniority"
  );
  if (seniorityConditions.length === 0) return null;

  if (facts.seniority_signals.length === 0) {
    // Cannot assess; let downstream stages handle it. Don't reject on absence.
    return null;
  }

  // Reject if EVERY signal in the posting falls inside the blocked set.
  // If even one signal is acceptable, the posting may still be a fit.
  for (const cond of seniorityConditions) {
    const blocked = new Set(cond.any_of);
    const allBlocked = facts.seniority_signals.every((s) => blocked.has(s));
    if (allBlocked) {
      const matched = facts.seniority_signals.filter((s) => blocked.has(s));
      return {
        pass: false,
        gate: "role_seniority",
        reason_code: buildReasonCode("role_seniority", matched[0] ?? "unknown"),
        message: `Posting seniority signals [${matched.join(", ")}] are all out of band. Reason: ${cond.reason}`,
        details: {
          posting_signals: facts.seniority_signals,
          blocked_bands: cond.any_of,
          reason: cond.reason
        }
      };
    }
  }
  return null;
}

function checkLocationRequirement(
  facts: ExtractedJobFacts,
  criteria: CandidateCriteria
): GateFailure | null {
  if (!facts.required_onsite.is_required) return null;
  if (facts.required_onsite.locations.length === 0) return null;

  const locConditions = criteria.hard_gates.must_not_have.filter(
    (c) => c.kind === "location_requirement"
  );
  if (locConditions.length === 0) return null;

  for (const cond of locConditions) {
    const allowed = cond.requires_onsite_in_not.map(normalizeLocation);
    const offending = facts.required_onsite.locations.find(
      (loc) => !locationMatchesAny(loc, allowed)
    );
    if (offending !== undefined) {
      return {
        pass: false,
        gate: "location_requirement",
        reason_code: buildReasonCode("location_requirement", offending),
        message: `Posting requires onsite at "${offending}", which is not in the allowed list. Reason: ${cond.reason}`,
        details: {
          posting_locations: facts.required_onsite.locations,
          allowed_locations: cond.requires_onsite_in_not,
          reason: cond.reason
        }
      };
    }
  }
  return null;
}

function checkWorkAuthorization(
  facts: ExtractedJobFacts,
  criteria: CandidateCriteria
): GateFailure | null {
  // Posting-side hint: if the posting's work_authorization_constraints
  // mention "sponsorship" and the user requires sponsorship, that's a fail.
  const userAuth = criteria.profile.work_authorization;
  const userMustHave = criteria.hard_gates.must_have.find(
    (c) => c.kind === "work_authorization"
  );
  const requiredAuth =
    userMustHave?.kind === "work_authorization" ? userMustHave.value : userAuth;

  if (requiredAuth !== "requires_sponsorship") {
    // User does not need sponsorship. Posting constraints are usually fine.
    // We still fail if posting explicitly excludes the user's status, which
    // for V1 we approximate with a phrase scan over constraints.
    return null;
  }

  // User requires sponsorship. Look for "no sponsorship" / "no visa" hints.
  const declines = ["no sponsorship", "no visa", "us citizens only"];
  for (const constraint of facts.work_authorization_constraints) {
    const c = constraint.toLowerCase();
    if (declines.some((d) => c.includes(d))) {
      return {
        pass: false,
        gate: "work_authorization",
        reason_code: buildReasonCode("work_authorization", "no_sponsorship"),
        message: `Posting declines sponsorship ("${constraint}") but user requires it.`,
        details: {
          posting_constraint: constraint,
          user_authorization: userAuth
        }
      };
    }
  }
  return null;
}

function checkLocationAllowed(
  facts: ExtractedJobFacts,
  criteria: CandidateCriteria
): GateFailure | null {
  const userMustHave = criteria.hard_gates.must_have.find(
    (c) => c.kind === "location_allowed"
  );
  if (!userMustHave) return null;

  const userLocations = criteria.profile.primary_locations.map(normalizeLocation);

  // Fully-remote posting always satisfies the gate.
  if (!facts.required_onsite.is_required) {
    return null;
  }
  if (facts.required_onsite.locations.length === 0) {
    return null;
  }

  // Posting must require onsite in at least one allowed location.
  const anyMatch = facts.required_onsite.locations.some((loc) =>
    locationMatchesAny(loc, userLocations)
  );
  if (!anyMatch) {
    return {
      pass: false,
      gate: "location_allowed",
      reason_code: buildReasonCode("location_allowed", "none_match"),
      message: `Posting onsite locations [${facts.required_onsite.locations.join(
        ", "
      )}] do not intersect user's primary_locations [${criteria.profile.primary_locations.join(
        ", "
      )}].`,
      details: {
        posting_locations: facts.required_onsite.locations,
        user_locations: criteria.profile.primary_locations
      }
    };
  }
  return null;
}

function checkEmploymentType(
  facts: ExtractedJobFacts,
  criteria: CandidateCriteria
): GateFailure | null {
  const userMustHave = criteria.hard_gates.must_have.find(
    (c) => c.kind === "employment_type"
  );
  if (!userMustHave || userMustHave.kind !== "employment_type") return null;

  if (facts.employment_type === null) return null; // ambiguous; let soft score handle

  if (!userMustHave.value_in.includes(facts.employment_type)) {
    return {
      pass: false,
      gate: "employment_type",
      reason_code: buildReasonCode("employment_type", facts.employment_type),
      message: `Posting employment_type "${facts.employment_type}" is not in user's allowed set [${userMustHave.value_in.join(
        ", "
      )}].`,
      details: {
        posting_type: facts.employment_type,
        allowed: userMustHave.value_in
      }
    };
  }
  return null;
}

function checkYearsExperience(
  facts: ExtractedJobFacts,
  criteria: CandidateCriteria
): GateFailure | null {
  const userMustHave = criteria.hard_gates.must_have.find(
    (c) => c.kind === "years_experience"
  );
  if (!userMustHave || userMustHave.kind !== "years_experience") return null;

  // The must_have condition is asserted on the candidate's profile YOE
  // against the posting's required minimum. If the posting requires more
  // experience than the candidate has, that's a fail.
  //
  // Spec interpretation (docs/criteria.md §6.1):
  //   must_have:
  //     - kind: years_experience
  //       op: ">="
  //       value: 3
  // means "candidate's YOE must be >= 3" (a self-assertion). The op/value
  // pair is therefore validated against profile.years_experience, not
  // against the posting. The relevant POSTING-side check is whether the
  // posting's required minimum exceeds the candidate's actual YOE.
  const candidateYoe = criteria.profile.years_experience;

  // First, validate the self-assertion isn't violated (defensive check).
  if (!compareNumbers(candidateYoe, userMustHave.op, userMustHave.value)) {
    return {
      pass: false,
      gate: "years_experience",
      reason_code: buildReasonCode(
        "years_experience",
        `self_assertion_${userMustHave.op}_${userMustHave.value}`
      ),
      message: `Candidate profile years_experience (${candidateYoe}) violates the self-assertion ${userMustHave.op} ${userMustHave.value}.`,
      details: {
        candidate_yoe: candidateYoe,
        op: userMustHave.op,
        value: userMustHave.value
      }
    };
  }

  // Then check posting's required minimum against the candidate.
  const requiredMin = facts.required_yoe.min;
  if (requiredMin === null) return null;
  if (candidateYoe >= requiredMin) return null;

  return {
    pass: false,
    gate: "years_experience",
    reason_code: buildReasonCode(
      "years_experience",
      `required_${requiredMin}_have_${candidateYoe}`
    ),
    message: `Posting requires ${requiredMin}+ years; candidate has ${candidateYoe}.`,
    details: { required_min: requiredMin, candidate_yoe: candidateYoe }
  };
}

// ---------- helpers ----------

function compareNumbers(
  left: number,
  op: ">=" | ">" | "<=" | "<" | "==",
  right: number
): boolean {
  switch (op) {
    case ">=":
      return left >= right;
    case ">":
      return left > right;
    case "<=":
      return left <= right;
    case "<":
      return left < right;
    case "==":
      return left === right;
  }
}

function normalizeLocation(loc: string): string {
  return loc
    .toLowerCase()
    .replace(/[\s,]+/g, " ")
    .trim();
}

/**
 * Loose location match. Either side may contain the other as a substring
 * after normalization. Examples:
 *   "Denver, CO" matches "Denver"
 *   "DC-metro" matches "Washington, DC" (nope — explicit value match needed)
 *
 * Intentionally simple. For V1 we accept that fuzzy location semantics will
 * occasionally need a values-refusal or overlay correction. Geographic
 * resolution is V2 territory.
 */
function locationMatchesAny(value: string, allowed: string[]): boolean {
  const normValue = normalizeLocation(value);
  // "remote" in user's primary_locations always matches.
  if (allowed.some((a) => a === "remote") && /\bremote\b/.test(normValue)) {
    return true;
  }
  return allowed.some((a) => {
    if (!a) return false;
    return normValue.includes(a) || a.includes(normValue);
  });
}
