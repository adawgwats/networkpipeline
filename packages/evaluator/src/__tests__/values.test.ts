import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { CandidateCriteria } from "@networkpipeline/criteria";
import {
  applyThresholds,
  MockJsonOutputProvider,
  valuesCheck,
  VALUES_PROMPT_ID,
  VALUES_REJECT_CONFIDENCE,
  VALUES_REVIEW_CONFIDENCE,
  VALUES_SYSTEM_PROMPT,
  type ValuesVerdictRaw
} from "../index.js";
import { baseValidFacts } from "./fixtures.js";

const REFUSAL_LETHAL = "Autonomous lethal systems or weapon targeting";
const REFUSAL_SURVEILLANCE =
  "Mass surveillance tooling sold to state actors";

function baseCriteria(refusals: string[] = []): CandidateCriteria {
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
      primary_locations: ["remote"],
      work_authorization: "us_citizen_or_permanent_resident",
      seniority_band: ["mid"]
    },
    hard_gates: {
      must_have: [],
      must_not_have: [],
      must_not_contain_phrases: []
    },
    values_refusals: refusals,
    soft_preferences: {
      positive: [],
      negative: [],
      min_soft_score: 0.55
    },
    calibration: {
      accepted_examples: [],
      rejected_examples: []
    }
  };
}

function rawVerdict(overrides: Partial<ValuesVerdictRaw> = {}): ValuesVerdictRaw {
  return {
    violation: false,
    matched_refusal: null,
    excerpt: null,
    confidence: 0.1,
    rationale: "default test rationale",
    ...overrides
  };
}

describe("applyThresholds — pure post-LLM decision logic", () => {
  it("returns clear when violation is false", () => {
    const out = applyThresholds(rawVerdict({ violation: false, confidence: 0.8 }), [
      REFUSAL_LETHAL
    ]);
    assert.equal(out.decision, "clear");
    assert.equal(out.reason_code, "");
  });

  it("rejects when violation is true and confidence ≥ REJECT threshold", () => {
    const out = applyThresholds(
      rawVerdict({
        violation: true,
        matched_refusal: REFUSAL_LETHAL,
        confidence: VALUES_REJECT_CONFIDENCE,
        rationale: "clear violation"
      }),
      [REFUSAL_LETHAL]
    );
    assert.equal(out.decision, "reject");
    assert.ok(
      out.reason_code.startsWith("values:autonomous_lethal_systems_or_weapon_targeting"),
      `got: ${out.reason_code}`
    );
  });

  it("flags needs_review when violation is true and confidence in ambiguous band", () => {
    const out = applyThresholds(
      rawVerdict({
        violation: true,
        matched_refusal: REFUSAL_LETHAL,
        confidence: VALUES_REVIEW_CONFIDENCE,
        rationale: "ambiguous"
      }),
      [REFUSAL_LETHAL]
    );
    assert.equal(out.decision, "needs_review");
    assert.equal(out.reason_code, "");
  });

  it("clears when violation is true but confidence is below review threshold", () => {
    const out = applyThresholds(
      rawVerdict({
        violation: true,
        matched_refusal: REFUSAL_LETHAL,
        confidence: 0.2,
        rationale: "model contradiction"
      }),
      [REFUSAL_LETHAL]
    );
    assert.equal(out.decision, "clear");
  });

  it("downgrades to needs_review when violation is true but matched_refusal is null", () => {
    const out = applyThresholds(
      rawVerdict({
        violation: true,
        matched_refusal: null,
        confidence: 0.9,
        rationale: "self-inconsistent"
      }),
      [REFUSAL_LETHAL]
    );
    assert.equal(out.decision, "needs_review");
    assert.equal(out.reason_code, "");
  });

  it("downgrades to needs_review when matched_refusal is not in user's list", () => {
    const out = applyThresholds(
      rawVerdict({
        violation: true,
        matched_refusal: "Something the user did NOT list",
        confidence: 0.95,
        rationale: "hallucinated refusal"
      }),
      [REFUSAL_LETHAL]
    );
    assert.equal(out.decision, "needs_review");
  });

  it("matches matched_refusal case-insensitively against the user list", () => {
    const out = applyThresholds(
      rawVerdict({
        violation: true,
        matched_refusal: REFUSAL_LETHAL.toUpperCase(),
        confidence: 0.85,
        rationale: "case insensitive"
      }),
      [REFUSAL_LETHAL]
    );
    assert.equal(out.decision, "reject");
  });
});

describe("valuesCheck — short-circuit when refusals empty", () => {
  it("does not call the provider when criteria.values_refusals is empty", async () => {
    const provider = new MockJsonOutputProvider(); // no responses queued
    const out = await valuesCheck(provider, {
      facts: baseValidFacts(),
      criteria: baseCriteria([])
    });
    assert.equal(out.result.decision, "clear");
    assert.equal(out.result.raw.violation, false);
    assert.equal(out.result.raw.confidence, 1.0);
    assert.equal(provider.invocations.length, 0);
    assert.equal(out.run.provider, "skipped");
    assert.equal(out.run.stop_reason, "skipped_no_refusals");
  });
});

describe("valuesCheck — provider invocation contract", () => {
  it("passes the versioned system prompt and tool name", async () => {
    const provider = new MockJsonOutputProvider([
      rawVerdict({ confidence: 0.05, rationale: "no overlap" })
    ]);
    await valuesCheck(provider, {
      facts: baseValidFacts(),
      criteria: baseCriteria([REFUSAL_LETHAL])
    });
    const call = provider.invocations[0];
    assert.equal(call?.systemPrompt, VALUES_SYSTEM_PROMPT);
    assert.equal(call?.promptId, VALUES_PROMPT_ID);
    assert.equal(call?.toolName, "submit_values_verdict");
    assert.ok(
      call?.userPrompt.includes(REFUSAL_LETHAL),
      "user prompt must include the verbatim refusal text"
    );
    assert.ok(
      call?.userPrompt.includes(`extractor_version: ${baseValidFacts().extractor_version}`) ||
        call?.userPrompt.includes(baseValidFacts().extractor_version),
      "user prompt must reference extractor_version"
    );
  });

  it("returns reject when provider says clear violation with high confidence", async () => {
    const provider = new MockJsonOutputProvider([
      rawVerdict({
        violation: true,
        matched_refusal: REFUSAL_LETHAL,
        excerpt: "build target-acquisition models for autonomous strike systems",
        confidence: 0.92,
        rationale: "Posting describes work directly producing the refused outcome."
      })
    ]);
    const out = await valuesCheck(provider, {
      facts: baseValidFacts({
        company: "Acme Defense",
        industry_tags: ["defense_weapons", "autonomous_lethal_systems"]
      }),
      criteria: baseCriteria([REFUSAL_LETHAL])
    });
    assert.equal(out.result.decision, "reject");
    assert.ok(out.result.reason_code.startsWith("values:"));
    assert.equal(out.run.provider, "mock");
  });

  it("returns clear when provider confirms no overlap", async () => {
    const provider = new MockJsonOutputProvider([
      rawVerdict({
        violation: false,
        confidence: 0.04,
        rationale: "Posting is for a SaaS analytics product."
      })
    ]);
    const out = await valuesCheck(provider, {
      facts: baseValidFacts({ company: "Acme Analytics" }),
      criteria: baseCriteria([REFUSAL_LETHAL, REFUSAL_SURVEILLANCE])
    });
    assert.equal(out.result.decision, "clear");
  });

  it("flags needs_review for ambiguous medium-confidence violations", async () => {
    const provider = new MockJsonOutputProvider([
      rawVerdict({
        violation: true,
        matched_refusal: REFUSAL_SURVEILLANCE,
        excerpt: "law-enforcement integration tier-1 workflows",
        confidence: 0.5,
        rationale: "Touches the area but specifics unclear from posting."
      })
    ]);
    const out = await valuesCheck(provider, {
      facts: baseValidFacts(),
      criteria: baseCriteria([REFUSAL_SURVEILLANCE])
    });
    assert.equal(out.result.decision, "needs_review");
    assert.equal(out.result.reason_code, "");
  });
});

describe("valuesCheck — sanity guards on hallucinated refusals", () => {
  it("does NOT auto-reject when the provider names a refusal not in the user's list", async () => {
    const provider = new MockJsonOutputProvider([
      rawVerdict({
        violation: true,
        matched_refusal: "Something completely fabricated",
        confidence: 0.99,
        rationale: "model hallucination test"
      })
    ]);
    const out = await valuesCheck(provider, {
      facts: baseValidFacts(),
      criteria: baseCriteria([REFUSAL_LETHAL])
    });
    assert.equal(out.result.decision, "needs_review");
  });
});
