import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { CandidateCriteria } from "@networkpipeline/criteria";
import { GATE_ORDER, hardGateCheck } from "../gates/index.js";
import type { GateRejectResult } from "../gates/result.js";
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

function expectReject(result: ReturnType<typeof hardGateCheck>): GateRejectResult {
  if (result.pass) {
    throw new Error("expected rejection but gate passed");
  }
  return result;
}

describe("hardGateCheck — pass-through", () => {
  it("passes when all gates run without violation", () => {
    const result = hardGateCheck(baseValidFacts(), baseCriteria());
    assert.equal(result.pass, true);
    assert.deepEqual(result.gates_evaluated, [...GATE_ORDER]);
  });
});

describe("hardGateCheck — must_not_contain_phrases", () => {
  it("rejects when raw_text_excerpt contains a blocklisted phrase", () => {
    const facts = baseValidFacts({
      raw_text_excerpt:
        "We require an Active Security Clearance Required for this role."
    });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [],
        must_not_have: [],
        must_not_contain_phrases: ["active security clearance required"]
      }
    });
    const reject = expectReject(hardGateCheck(facts, criteria));
    assert.equal(reject.gate, "must_not_contain_phrases");
    assert.ok(
      reject.reason_code.startsWith(
        "hard_gate:must_not_contain_phrases:active_security_clearance_required"
      )
    );
  });

  it("is case-insensitive", () => {
    const facts = baseValidFacts({
      raw_text_excerpt: "ON-SITE 5 days a week."
    });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [],
        must_not_have: [],
        must_not_contain_phrases: ["on-site 5 days"]
      }
    });
    assert.equal(hardGateCheck(facts, criteria).pass, false);
  });
});

describe("hardGateCheck — company blocklist", () => {
  it("rejects exact company match", () => {
    const facts = baseValidFacts({ company: "Anduril" });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [],
        must_not_have: [
          {
            kind: "company",
            any_of: ["Anduril", "Palantir"],
            reason: "Values-based refusal"
          }
        ],
        must_not_contain_phrases: []
      }
    });
    const reject = expectReject(hardGateCheck(facts, criteria));
    assert.equal(reject.gate, "company");
    assert.equal(reject.reason_code, "hard_gate:company:anduril");
  });

  it("does not match partial substrings", () => {
    const facts = baseValidFacts({ company: "Anduril Industries" });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [],
        must_not_have: [
          {
            kind: "company",
            any_of: ["Anduril"],
            reason: "Values"
          }
        ],
        must_not_contain_phrases: []
      }
    });
    // Spec calls for exact match. "Anduril Industries" != "Anduril".
    assert.equal(hardGateCheck(facts, criteria).pass, true);
  });
});

describe("hardGateCheck — industry blocklist", () => {
  it("rejects when posting carries a blocked industry tag", () => {
    const facts = baseValidFacts({
      industry_tags: ["software", "autonomous_lethal_systems"]
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
    const reject = expectReject(hardGateCheck(facts, criteria));
    assert.equal(reject.gate, "industry");
    assert.ok(reject.reason_code.includes("autonomous_lethal_systems"));
  });
});

describe("hardGateCheck — required_clearance", () => {
  it("rejects required clearance posting matching the blocklist", () => {
    const facts = baseValidFacts({ required_clearance: "secret" });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [],
        must_not_have: [
          {
            kind: "required_clearance",
            any_of: ["secret", "top_secret", "ts_sci", "dod_clearance_required"],
            reason: "No DOD background"
          }
        ],
        must_not_contain_phrases: []
      }
    });
    const reject = expectReject(hardGateCheck(facts, criteria));
    assert.equal(reject.gate, "required_clearance");
    assert.equal(reject.reason_code, "hard_gate:required_clearance:secret");
  });

  it("ignores postings with required_clearance: null", () => {
    const facts = baseValidFacts({ required_clearance: null });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [],
        must_not_have: [
          {
            kind: "required_clearance",
            any_of: ["secret"],
            reason: "test"
          }
        ],
        must_not_contain_phrases: []
      }
    });
    assert.equal(hardGateCheck(facts, criteria).pass, true);
  });
});

describe("hardGateCheck — role_seniority", () => {
  it("rejects when ALL posting signals are in the blocked set", () => {
    const facts = baseValidFacts({
      seniority_signals: ["staff", "principal"]
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
    const reject = expectReject(hardGateCheck(facts, criteria));
    assert.equal(reject.gate, "role_seniority");
  });

  it("passes when at least one posting signal is acceptable", () => {
    const facts = baseValidFacts({
      seniority_signals: ["senior", "staff"]
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
    // "senior" is acceptable, so the posting may still be a fit.
    assert.equal(hardGateCheck(facts, criteria).pass, true);
  });

  it("does not reject when posting has zero signals", () => {
    const facts = baseValidFacts({ seniority_signals: [] });
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
    // No signals means we cannot assess; downstream stages (soft score)
    // handle ambiguity. Don't reject on absence of evidence.
    assert.equal(hardGateCheck(facts, criteria).pass, true);
  });
});

describe("hardGateCheck — location_requirement", () => {
  it("rejects onsite postings whose locations are outside the allowed list", () => {
    const facts = baseValidFacts({
      required_onsite: { is_required: true, locations: ["Denver, CO"] }
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
    const reject = expectReject(hardGateCheck(facts, criteria));
    assert.equal(reject.gate, "location_requirement");
  });

  it("passes when posting onsite location matches an allowed list entry", () => {
    // V1 location matching is substring-based (see docs/criteria.md and
    // gates/check.ts comments). Aliases like "NYC" → "New York" are V2.
    const facts = baseValidFacts({
      required_onsite: { is_required: true, locations: ["NYC, NY"] }
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
    assert.equal(hardGateCheck(facts, criteria).pass, true);
  });
});

describe("hardGateCheck — work_authorization", () => {
  it("rejects 'no sponsorship' postings when user requires sponsorship", () => {
    const facts = baseValidFacts({
      work_authorization_constraints: ["No visa sponsorship available"]
    });
    const criteria = baseCriteria({
      profile: {
        display_name: "Test User",
        years_experience: 4,
        primary_locations: ["remote"],
        work_authorization: "requires_sponsorship",
        seniority_band: ["mid"]
      }
    });
    const reject = expectReject(hardGateCheck(facts, criteria));
    assert.equal(reject.gate, "work_authorization");
  });

  it("accepts sponsorship-declining postings when user is a citizen/PR", () => {
    const facts = baseValidFacts({
      work_authorization_constraints: ["No sponsorship available"]
    });
    const criteria = baseCriteria(); // citizen-or-PR by default
    assert.equal(hardGateCheck(facts, criteria).pass, true);
  });
});

describe("hardGateCheck — location_allowed", () => {
  it("rejects onsite postings whose locations don't intersect primary_locations", () => {
    const facts = baseValidFacts({
      required_onsite: { is_required: true, locations: ["Austin, TX"] }
    });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [{ kind: "location_allowed" }],
        must_not_have: [],
        must_not_contain_phrases: []
      }
    });
    const reject = expectReject(hardGateCheck(facts, criteria));
    assert.equal(reject.gate, "location_allowed");
    assert.equal(reject.reason_code, "hard_gate:location_allowed:none_match");
  });

  it("accepts fully remote postings unconditionally", () => {
    const facts = baseValidFacts({
      required_onsite: { is_required: false, locations: [] }
    });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [{ kind: "location_allowed" }],
        must_not_have: [],
        must_not_contain_phrases: []
      }
    });
    assert.equal(hardGateCheck(facts, criteria).pass, true);
  });

  it("passes when at least one onsite location matches a primary_location", () => {
    const facts = baseValidFacts({
      required_onsite: {
        is_required: true,
        locations: ["Washington, DC", "Austin, TX"]
      }
    });
    const criteria = baseCriteria({
      profile: {
        display_name: "Test",
        years_experience: 4,
        primary_locations: ["Washington, DC"],
        work_authorization: "us_citizen",
        seniority_band: ["mid"]
      },
      hard_gates: {
        must_have: [{ kind: "location_allowed" }],
        must_not_have: [],
        must_not_contain_phrases: []
      }
    });
    assert.equal(hardGateCheck(facts, criteria).pass, true);
  });
});

describe("hardGateCheck — employment_type", () => {
  it("rejects postings whose employment_type is not in must_have list", () => {
    const facts = baseValidFacts({ employment_type: "contract" });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [
          {
            kind: "employment_type",
            value_in: ["full_time", "contract_to_hire"]
          }
        ],
        must_not_have: [],
        must_not_contain_phrases: []
      }
    });
    const reject = expectReject(hardGateCheck(facts, criteria));
    assert.equal(reject.gate, "employment_type");
    assert.equal(reject.reason_code, "hard_gate:employment_type:contract");
  });

  it("ignores ambiguous (null) employment_type — defers to soft score", () => {
    const facts = baseValidFacts({ employment_type: null });
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [{ kind: "employment_type", value_in: ["full_time"] }],
        must_not_have: [],
        must_not_contain_phrases: []
      }
    });
    assert.equal(hardGateCheck(facts, criteria).pass, true);
  });
});

describe("hardGateCheck — years_experience", () => {
  it("rejects when posting min exceeds candidate YOE", () => {
    const facts = baseValidFacts({
      required_yoe: { min: 8, max: null }
    });
    const criteria = baseCriteria(); // years_experience: 4
    // Add the must_have so the gate becomes active.
    criteria.hard_gates.must_have.push({
      kind: "years_experience",
      op: ">=",
      value: 3
    });
    const reject = expectReject(hardGateCheck(facts, criteria));
    assert.equal(reject.gate, "years_experience");
    assert.equal(
      reject.reason_code,
      "hard_gate:years_experience:required_8_have_4"
    );
  });

  it("passes when posting min is below candidate YOE", () => {
    const facts = baseValidFacts({
      required_yoe: { min: 3, max: null }
    });
    const criteria = baseCriteria();
    criteria.hard_gates.must_have.push({
      kind: "years_experience",
      op: ">=",
      value: 3
    });
    assert.equal(hardGateCheck(facts, criteria).pass, true);
  });

  it("ignores postings with no minimum", () => {
    const facts = baseValidFacts({
      required_yoe: { min: null, max: null }
    });
    const criteria = baseCriteria();
    criteria.hard_gates.must_have.push({
      kind: "years_experience",
      op: ">=",
      value: 3
    });
    assert.equal(hardGateCheck(facts, criteria).pass, true);
  });
});

describe("hardGateCheck — execution order", () => {
  it("short-circuits on the FIRST failing gate per GATE_ORDER", () => {
    // Construct a posting that violates BOTH must_not_contain_phrases and
    // company. must_not_contain_phrases runs first, so its reason should
    // be reported.
    const facts = baseValidFacts({
      company: "Anduril",
      raw_text_excerpt: "Active Security Clearance Required for this role."
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
    const reject = expectReject(hardGateCheck(facts, criteria));
    assert.equal(reject.gate, "must_not_contain_phrases");
    assert.deepEqual(reject.gates_evaluated, ["must_not_contain_phrases"]);
  });

  it("pass result lists all 10 gates in canonical order", () => {
    const result = hardGateCheck(baseValidFacts(), baseCriteria());
    assert.equal(result.pass, true);
    assert.equal(result.gates_evaluated.length, 10);
    assert.deepEqual(result.gates_evaluated, [...GATE_ORDER]);
  });
});

describe("hardGateCheck — determinism", () => {
  it("produces identical results across repeated invocations", () => {
    const facts = baseValidFacts({
      company: "Anduril",
      industry_tags: ["software"],
      seniority_signals: ["senior"]
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
    const r1 = hardGateCheck(facts, criteria);
    const r2 = hardGateCheck(facts, criteria);
    const r3 = hardGateCheck(facts, criteria);
    assert.deepEqual(r1, r2);
    assert.deepEqual(r2, r3);
  });
});
