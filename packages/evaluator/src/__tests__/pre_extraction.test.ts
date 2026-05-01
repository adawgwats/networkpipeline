import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { CandidateCriteria } from "@networkpipeline/criteria";
import {
  hardGateCheck,
  preExtractionGateCheck,
  PRE_EXTRACTION_GATES,
  type DiscoveredPostingMetadata
} from "../gates/index.js";
import type { GateRejectResult } from "../gates/result.js";
import type { ExtractedJobFacts } from "../extract/schema.js";
import { baseValidFacts } from "./fixtures.js";

function baseCriteria(
  overrides: Partial<CandidateCriteria> = {}
): CandidateCriteria {
  return {
    version: 1,
    schema_version: "1.0.0",
    updated_at: new Date(0).toISOString(),
    updated_via: "test",
    extends: [],
    overlays: [],
    profile: {
      display_name: "Test User",
      years_experience: 4,
      primary_locations: ["DC-metro", "NYC", "remote"],
      work_authorization: "us_citizen_or_permanent_resident",
      seniority_band: ["mid", "senior"]
    },
    hard_gates: {
      must_have: [],
      must_not_have: [],
      must_not_contain_phrases: []
    },
    values_refusals: [],
    soft_preferences: {
      positive: [],
      negative: [],
      min_soft_score: 0.55
    },
    calibration: {
      accepted_examples: [],
      rejected_examples: []
    },
    ...overrides
  };
}

function baseMetadata(
  overrides: Partial<DiscoveredPostingMetadata> = {}
): DiscoveredPostingMetadata {
  return {
    title: "Software Engineer",
    company: "Acme",
    description_excerpt: "Build great software.",
    onsite_locations: [],
    is_onsite_required: false,
    employment_type: "full_time",
    inferred_seniority_signals: ["mid"],
    ...overrides
  };
}

function expectReject(
  result: ReturnType<typeof preExtractionGateCheck>
): GateRejectResult {
  if (result.pass) {
    throw new Error("expected rejection but gate passed");
  }
  return result;
}

// ---------- pass-through ----------

describe("preExtractionGateCheck — pass-through", () => {
  it("passes with all 7 gates evaluated in canonical order when nothing trips", () => {
    const result = preExtractionGateCheck(baseMetadata(), baseCriteria());
    assert.equal(result.pass, true);
    assert.deepEqual(result.gates_evaluated, [...PRE_EXTRACTION_GATES]);
    assert.equal(result.gates_evaluated.length, 7);
  });

  it("PRE_EXTRACTION_GATES contains exactly the 7 metadata-decidable gates in canonical (GATE_ORDER) order", () => {
    assert.deepEqual([...PRE_EXTRACTION_GATES], [
      "must_not_contain_phrases",
      "company",
      "role_kind",
      "role_seniority",
      "location_requirement",
      "location_allowed",
      "employment_type"
    ]);
  });
});

// ---------- must_not_contain_phrases ----------

describe("preExtractionGateCheck — must_not_contain_phrases", () => {
  it("rejects on phrase in title", () => {
    const metadata = baseMetadata({
      title: "Senior Engineer (Active Security Clearance Required)"
    });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [],
        must_not_have: [],
        must_not_contain_phrases: ["active security clearance required"]
      }
    });
    const reject = expectReject(preExtractionGateCheck(metadata, criteria));
    assert.equal(reject.gate, "must_not_contain_phrases");
    assert.ok(
      reject.reason_code.startsWith(
        "hard_gate:must_not_contain_phrases:active_security_clearance_required"
      )
    );
  });

  it("rejects on phrase in description_excerpt", () => {
    const metadata = baseMetadata({
      title: "Software Engineer",
      description_excerpt: "We require an active security clearance required."
    });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [],
        must_not_have: [],
        must_not_contain_phrases: ["active security clearance required"]
      }
    });
    const reject = expectReject(preExtractionGateCheck(metadata, criteria));
    assert.equal(reject.gate, "must_not_contain_phrases");
  });

  it("is case-insensitive", () => {
    const metadata = baseMetadata({
      title: "Software Engineer",
      description_excerpt: "ON-SITE 5 DAYS A WEEK."
    });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [],
        must_not_have: [],
        must_not_contain_phrases: ["on-site 5 days"]
      }
    });
    assert.equal(preExtractionGateCheck(metadata, criteria).pass, false);
  });

  it("handles null description_excerpt without throwing", () => {
    const metadata = baseMetadata({
      title: "Software Engineer",
      description_excerpt: null
    });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [],
        must_not_have: [],
        must_not_contain_phrases: ["unrelated phrase"]
      }
    });
    assert.equal(preExtractionGateCheck(metadata, criteria).pass, true);
  });
});

// ---------- company ----------

describe("preExtractionGateCheck — company", () => {
  it("rejects exact company match", () => {
    const metadata = baseMetadata({ company: "Anduril" });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [],
        must_not_have: [
          { kind: "company", any_of: ["Anduril"], reason: "Values" }
        ],
        must_not_contain_phrases: []
      }
    });
    const reject = expectReject(preExtractionGateCheck(metadata, criteria));
    assert.equal(reject.gate, "company");
    assert.equal(reject.reason_code, "hard_gate:company:anduril");
  });

  it("does NOT match partial substrings (Anduril Industries != Anduril)", () => {
    const metadata = baseMetadata({ company: "Anduril Industries" });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [],
        must_not_have: [
          { kind: "company", any_of: ["Anduril"], reason: "Values" }
        ],
        must_not_contain_phrases: []
      }
    });
    assert.equal(preExtractionGateCheck(metadata, criteria).pass, true);
  });
});

// ---------- location_requirement ----------

describe("preExtractionGateCheck — location_requirement", () => {
  it("rejects onsite postings whose locations are outside the allowed list", () => {
    const metadata = baseMetadata({
      is_onsite_required: true,
      onsite_locations: ["Denver, CO"]
    });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [],
        must_not_have: [
          {
            kind: "location_requirement",
            requires_onsite_in_not: ["DC-metro", "NYC", "remote"],
            reason: "geo constraint"
          }
        ],
        must_not_contain_phrases: []
      }
    });
    const reject = expectReject(preExtractionGateCheck(metadata, criteria));
    assert.equal(reject.gate, "location_requirement");
  });

  it("accepts onsite postings whose location is in the allowed list", () => {
    const metadata = baseMetadata({
      is_onsite_required: true,
      onsite_locations: ["NYC, NY"]
    });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [],
        must_not_have: [
          {
            kind: "location_requirement",
            requires_onsite_in_not: ["NYC", "DC-metro"],
            reason: "test"
          }
        ],
        must_not_contain_phrases: []
      }
    });
    assert.equal(preExtractionGateCheck(metadata, criteria).pass, true);
  });
});

// ---------- location_allowed ----------

describe("preExtractionGateCheck — location_allowed", () => {
  it("accepts fully remote postings unconditionally", () => {
    const metadata = baseMetadata({
      is_onsite_required: false,
      onsite_locations: []
    });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [{ kind: "location_allowed" }],
        must_not_have: [],
        must_not_contain_phrases: []
      }
    });
    assert.equal(preExtractionGateCheck(metadata, criteria).pass, true);
  });

  it("rejects when no onsite location matches profile.primary_locations", () => {
    const metadata = baseMetadata({
      is_onsite_required: true,
      onsite_locations: ["Austin, TX"]
    });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [{ kind: "location_allowed" }],
        must_not_have: [],
        must_not_contain_phrases: []
      }
    });
    const reject = expectReject(preExtractionGateCheck(metadata, criteria));
    assert.equal(reject.gate, "location_allowed");
    assert.equal(reject.reason_code, "hard_gate:location_allowed:none_match");
  });
});

// ---------- employment_type ----------

describe("preExtractionGateCheck — employment_type", () => {
  it("rejects type not in must_have list", () => {
    const metadata = baseMetadata({ employment_type: "contract" });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [
          { kind: "employment_type", value_in: ["full_time", "contract_to_hire"] }
        ],
        must_not_have: [],
        must_not_contain_phrases: []
      }
    });
    const reject = expectReject(preExtractionGateCheck(metadata, criteria));
    assert.equal(reject.gate, "employment_type");
    assert.equal(reject.reason_code, "hard_gate:employment_type:contract");
  });

  it("defers on null employment_type (does not reject)", () => {
    const metadata = baseMetadata({ employment_type: null });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [{ kind: "employment_type", value_in: ["full_time"] }],
        must_not_have: [],
        must_not_contain_phrases: []
      }
    });
    assert.equal(preExtractionGateCheck(metadata, criteria).pass, true);
  });
});

// ---------- role_kind ----------

describe("preExtractionGateCheck — role_kind", () => {
  it("rejects when an inferred role_kind is in the blocklist", () => {
    const metadata = baseMetadata({
      title: "Account Executive, Enterprise",
      inferred_role_kinds: ["sales"]
    });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [],
        must_not_have: [
          {
            kind: "role_kind",
            any_of: ["sales", "marketing"],
            reason: "Targeting engineering roles"
          }
        ],
        must_not_contain_phrases: []
      }
    });
    const reject = expectReject(preExtractionGateCheck(metadata, criteria));
    assert.equal(reject.gate, "role_kind");
    assert.equal(reject.reason_code, "hard_gate:role_kind:sales");
  });

  it("passes when role_kind is in blocklist but a non-blocked kind also tags", () => {
    // "Solutions Engineer" tags BOTH sales AND engineering. If the
    // blocklist contains 'sales' we still reject — ANY blocked kind
    // is enough. This is the intentional behavior from the spec.
    // The complementary case: a posting ONLY tagged engineering should
    // pass even when other kinds (sales) are blocked.
    const metadata = baseMetadata({
      title: "Software Engineer",
      inferred_role_kinds: ["engineering"]
    });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [],
        must_not_have: [
          {
            kind: "role_kind",
            any_of: ["sales", "marketing", "recruiting"],
            reason: "engineering only"
          }
        ],
        must_not_contain_phrases: []
      }
    });
    assert.equal(preExtractionGateCheck(metadata, criteria).pass, true);
  });

  it("rejects when ANY tag is blocked (Solutions Engineer with sales blocked)", () => {
    const metadata = baseMetadata({
      title: "Solutions Engineer",
      inferred_role_kinds: ["engineering", "sales"]
    });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [],
        must_not_have: [
          {
            kind: "role_kind",
            any_of: ["sales"],
            reason: "Targeting engineering"
          }
        ],
        must_not_contain_phrases: []
      }
    });
    const reject = expectReject(preExtractionGateCheck(metadata, criteria));
    assert.equal(reject.gate, "role_kind");
  });

  it("passes when overlapping tags are not blocked (Senior Security Engineer with only sales blocked)", () => {
    const metadata = baseMetadata({
      title: "Senior Security Engineer",
      inferred_role_kinds: ["engineering", "security"]
    });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [],
        must_not_have: [
          {
            kind: "role_kind",
            any_of: ["sales"],
            reason: "Targeting engineering"
          }
        ],
        must_not_contain_phrases: []
      }
    });
    assert.equal(preExtractionGateCheck(metadata, criteria).pass, true);
  });

  it("defers when inferred_role_kinds is empty", () => {
    const metadata = baseMetadata({ inferred_role_kinds: [] });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [],
        must_not_have: [
          {
            kind: "role_kind",
            any_of: ["sales"],
            reason: "test"
          }
        ],
        must_not_contain_phrases: []
      }
    });
    assert.equal(preExtractionGateCheck(metadata, criteria).pass, true);
  });

  it("defers when inferred_role_kinds contains only 'other'", () => {
    const metadata = baseMetadata({ inferred_role_kinds: ["other"] });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [],
        must_not_have: [
          {
            kind: "role_kind",
            any_of: ["sales"],
            reason: "test"
          }
        ],
        must_not_contain_phrases: []
      }
    });
    assert.equal(preExtractionGateCheck(metadata, criteria).pass, true);
  });

  it("does nothing when criteria has no role_kind blocklist", () => {
    const metadata = baseMetadata({ inferred_role_kinds: ["sales"] });
    const criteria = baseCriteria(); // empty must_not_have
    assert.equal(preExtractionGateCheck(metadata, criteria).pass, true);
  });
});

// ---------- role_seniority ----------

describe("preExtractionGateCheck — role_seniority", () => {
  it("rejects when ALL inferred signals are blocked", () => {
    const metadata = baseMetadata({
      inferred_seniority_signals: ["staff", "principal"]
    });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [],
        must_not_have: [
          {
            kind: "role_seniority",
            any_of: ["staff", "principal", "director", "vp"],
            reason: "out of band"
          }
        ],
        must_not_contain_phrases: []
      }
    });
    const reject = expectReject(preExtractionGateCheck(metadata, criteria));
    assert.equal(reject.gate, "role_seniority");
  });

  it("passes when at least one inferred signal is acceptable", () => {
    const metadata = baseMetadata({
      inferred_seniority_signals: ["senior", "staff"]
    });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [],
        must_not_have: [
          {
            kind: "role_seniority",
            any_of: ["staff", "principal"],
            reason: "out of band"
          }
        ],
        must_not_contain_phrases: []
      }
    });
    assert.equal(preExtractionGateCheck(metadata, criteria).pass, true);
  });

  it("defers when inferred_seniority_signals is empty (post-extraction will infer)", () => {
    const metadata = baseMetadata({ inferred_seniority_signals: [] });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [],
        must_not_have: [
          {
            kind: "role_seniority",
            any_of: ["staff"],
            reason: "out of band"
          }
        ],
        must_not_contain_phrases: []
      }
    });
    assert.equal(preExtractionGateCheck(metadata, criteria).pass, true);
  });
});

// ---------- execution order ----------

describe("preExtractionGateCheck — execution order", () => {
  it("short-circuits on the first failing gate per PRE_EXTRACTION_GATES", () => {
    // Posting violates BOTH must_not_contain_phrases AND company.
    // must_not_contain_phrases runs first.
    const metadata = baseMetadata({
      company: "Anduril",
      title: "Senior Engineer (Active Security Clearance Required)"
    });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [],
        must_not_have: [
          { kind: "company", any_of: ["Anduril"], reason: "values" }
        ],
        must_not_contain_phrases: ["active security clearance required"]
      }
    });
    const reject = expectReject(preExtractionGateCheck(metadata, criteria));
    assert.equal(reject.gate, "must_not_contain_phrases");
    assert.deepEqual(reject.gates_evaluated, ["must_not_contain_phrases"]);
  });

  it("does not run gates after a failure (location_allowed before employment_type)", () => {
    // Trip location_allowed (4th in subset). employment_type (5th) would
    // also fail, but should not be evaluated.
    const metadata = baseMetadata({
      is_onsite_required: true,
      onsite_locations: ["Austin, TX"],
      employment_type: "contract"
    });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [
          { kind: "location_allowed" },
          { kind: "employment_type", value_in: ["full_time"] }
        ],
        must_not_have: [],
        must_not_contain_phrases: []
      }
    });
    const reject = expectReject(preExtractionGateCheck(metadata, criteria));
    assert.equal(reject.gate, "location_allowed");
    assert.deepEqual(reject.gates_evaluated, [
      "must_not_contain_phrases",
      "company",
      "role_kind",
      "role_seniority",
      "location_requirement",
      "location_allowed"
    ]);
  });
});

// ---------- determinism ----------

describe("preExtractionGateCheck — determinism", () => {
  it("produces identical results across 3 invocations", () => {
    const metadata = baseMetadata({
      company: "Anduril",
      inferred_seniority_signals: ["senior"]
    });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [],
        must_not_have: [
          { kind: "company", any_of: ["Anduril"], reason: "values" }
        ],
        must_not_contain_phrases: []
      }
    });
    const r1 = preExtractionGateCheck(metadata, criteria);
    const r2 = preExtractionGateCheck(metadata, criteria);
    const r3 = preExtractionGateCheck(metadata, criteria);
    assert.deepEqual(r1, r2);
    assert.deepEqual(r2, r3);
  });
});

// ---------- bipartite property ----------
//
// For any (metadata, criteria) pair where pre-extraction REJECTS, the
// equivalent post-extraction `hardGateCheck` must also reject with the
// same reason code. We assemble matching `ExtractedJobFacts` from the
// metadata, populate the LLM-only fields with sensible neutral values
// (null clearance, no extra industry tags, no auth constraints, no YOE
// minimum), and compare verdicts.

function factsFromMetadata(
  metadata: DiscoveredPostingMetadata,
  overrides: Partial<ExtractedJobFacts> = {}
): ExtractedJobFacts {
  return baseValidFacts({
    title: metadata.title,
    company: metadata.company,
    seniority_signals: metadata.inferred_seniority_signals,
    employment_type: metadata.employment_type,
    required_onsite: {
      is_required: metadata.is_onsite_required === true,
      locations: metadata.onsite_locations
    },
    raw_text_excerpt:
      metadata.title + " " + (metadata.description_excerpt ?? ""),
    ...overrides
  });
}

describe("preExtractionGateCheck — bipartite invariant: pre-reject => post-reject", () => {
  it("must_not_contain_phrases: pre-extraction rejection implies post-extraction rejection (same code)", () => {
    const metadata = baseMetadata({
      title: "Active Security Clearance Required - Engineer",
      description_excerpt: "Engineer role"
    });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [],
        must_not_have: [],
        must_not_contain_phrases: ["active security clearance required"]
      }
    });
    const preReject = expectReject(preExtractionGateCheck(metadata, criteria));

    const facts = factsFromMetadata(metadata);
    const postResult = hardGateCheck(facts, criteria);
    assert.equal(postResult.pass, false);
    if (postResult.pass) return;
    assert.equal(postResult.gate, preReject.gate);
    assert.equal(postResult.reason_code, preReject.reason_code);
  });

  it("company: pre-extraction rejection implies post-extraction rejection (same code)", () => {
    const metadata = baseMetadata({ company: "Anduril" });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [],
        must_not_have: [
          { kind: "company", any_of: ["Anduril"], reason: "Values" }
        ],
        must_not_contain_phrases: []
      }
    });
    const preReject = expectReject(preExtractionGateCheck(metadata, criteria));

    const facts = factsFromMetadata(metadata);
    const postResult = hardGateCheck(facts, criteria);
    assert.equal(postResult.pass, false);
    if (postResult.pass) return;
    assert.equal(postResult.gate, preReject.gate);
    assert.equal(postResult.reason_code, preReject.reason_code);
  });

  it("employment_type: pre-extraction rejection implies post-extraction rejection (same code)", () => {
    const metadata = baseMetadata({ employment_type: "contract" });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [
          { kind: "employment_type", value_in: ["full_time", "contract_to_hire"] }
        ],
        must_not_have: [],
        must_not_contain_phrases: []
      }
    });
    const preReject = expectReject(preExtractionGateCheck(metadata, criteria));

    const facts = factsFromMetadata(metadata);
    const postResult = hardGateCheck(facts, criteria);
    assert.equal(postResult.pass, false);
    if (postResult.pass) return;
    assert.equal(postResult.gate, preReject.gate);
    assert.equal(postResult.reason_code, preReject.reason_code);
  });

  it("location_allowed: pre-extraction rejection implies post-extraction rejection (same code)", () => {
    const metadata = baseMetadata({
      is_onsite_required: true,
      onsite_locations: ["Austin, TX"]
    });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [{ kind: "location_allowed" }],
        must_not_have: [],
        must_not_contain_phrases: []
      }
    });
    const preReject = expectReject(preExtractionGateCheck(metadata, criteria));

    const facts = factsFromMetadata(metadata);
    const postResult = hardGateCheck(facts, criteria);
    assert.equal(postResult.pass, false);
    if (postResult.pass) return;
    assert.equal(postResult.gate, preReject.gate);
    assert.equal(postResult.reason_code, preReject.reason_code);
  });
});

// ---------- post-extraction may reject what pre-extraction passes ----------

describe("preExtractionGateCheck — post-extraction may reject what pre-extraction passes", () => {
  it("industry tag inferred only post-extraction triggers rejection that pre-extraction missed", () => {
    // Metadata has no industry signal; pre-extraction passes.
    const metadata = baseMetadata({
      title: "Software Engineer",
      company: "Stealthco",
      description_excerpt: "Working on autonomous systems"
    });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [],
        must_not_have: [
          {
            kind: "industry",
            any_of: ["autonomous_lethal_systems", "defense_weapons"],
            reason: "Values refusal"
          }
        ],
        must_not_contain_phrases: []
      }
    });
    const preResult = preExtractionGateCheck(metadata, criteria);
    assert.equal(preResult.pass, true);

    // Post-extraction with LLM-inferred industry tag rejects.
    const facts = factsFromMetadata(metadata, {
      industry_tags: ["software", "autonomous_lethal_systems"]
    });
    const postReject = hardGateCheck(facts, criteria);
    assert.equal(postReject.pass, false);
    if (postReject.pass) return;
    assert.equal(postReject.gate, "industry");
  });

  it("years_experience extracted only post-extraction triggers rejection that pre-extraction missed", () => {
    // Pre-extraction has no YOE info; passes.
    const metadata = baseMetadata({
      title: "Senior Software Engineer",
      inferred_seniority_signals: ["senior"]
    });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [{ kind: "years_experience", op: ">=", value: 3 }],
        must_not_have: [],
        must_not_contain_phrases: []
      }
    });
    const preResult = preExtractionGateCheck(metadata, criteria);
    assert.equal(preResult.pass, true);

    // Post-extraction discovers posting requires 8+ YOE; candidate has 4.
    const facts = factsFromMetadata(metadata, {
      required_yoe: { min: 8, max: null }
    });
    const postReject = hardGateCheck(facts, criteria);
    assert.equal(postReject.pass, false);
    if (postReject.pass) return;
    assert.equal(postReject.gate, "years_experience");
  });

  it("required_clearance extracted only post-extraction triggers rejection that pre-extraction missed", () => {
    const metadata = baseMetadata({
      title: "Software Engineer",
      description_excerpt: "Mission-critical work"
    });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [],
        must_not_have: [
          {
            kind: "required_clearance",
            any_of: ["secret", "top_secret", "ts_sci"],
            reason: "no DOD background"
          }
        ],
        must_not_contain_phrases: []
      }
    });
    const preResult = preExtractionGateCheck(metadata, criteria);
    assert.equal(preResult.pass, true);

    const facts = factsFromMetadata(metadata, {
      required_clearance: "secret"
    });
    const postReject = hardGateCheck(facts, criteria);
    assert.equal(postReject.pass, false);
    if (postReject.pass) return;
    assert.equal(postReject.gate, "required_clearance");
  });
});
