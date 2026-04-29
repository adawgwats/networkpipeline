import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { CandidateCriteria } from "@networkpipeline/criteria";
import { evaluateJob, MockJsonOutputProvider } from "../index.js";
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
      primary_locations: ["remote"],
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

describe("evaluateJob — accepted path (full pipeline)", () => {
  it("runs all 4 stages and accepts a valid posting", async () => {
    const provider = new MockJsonOutputProvider([
      // 1. extract
      baseValidFacts({
        title: "Research Engineer",
        company: "Anthropic",
        industry_tags: ["ai_ml", "research"]
      }),
      // 2. values_check (refusals empty → short-circuits, no enqueued response needed)
      // 3. soft_score
      {
        score: 0.9,
        contributions: [
          {
            topic: "AI/ML evaluation systems",
            weight: 1.0,
            contribution: 0.9,
            rationale: "Posting describes eval work."
          }
        ],
        rationale: "Strong positive match."
      }
    ]);

    const criteria = baseCriteria();
    criteria.soft_preferences.positive.push({
      topic: "AI/ML evaluation systems",
      weight: 1.0
    });

    const out = await evaluateJob(provider, { text: "posting body" }, criteria);

    assert.equal(out.verdict, "accepted");
    assert.equal(out.reason_code, "");
    assert.equal(out.short_circuited_at_stage, null);
    assert.deepEqual(out.stages_run, [
      "extract",
      "hard_gate",
      "values_check",
      "soft_score"
    ]);
    assert.ok(out.values_result);
    assert.ok(out.soft_score_result);
    assert.equal(out.criteria_version, criteria.version);
  });
});

describe("evaluateJob — hard_gate short-circuit", () => {
  it("rejects on company blocklist without calling values or score", async () => {
    const provider = new MockJsonOutputProvider([
      baseValidFacts({ company: "Anduril" })
    ]);

    const criteria = baseCriteria({
      hard_gates: {
        must_have: [],
        must_not_have: [
          { kind: "company", any_of: ["Anduril"], reason: "Values" }
        ],
        must_not_contain_phrases: []
      }
    });

    const out = await evaluateJob(provider, { text: "posting" }, criteria);

    assert.equal(out.verdict, "rejected");
    assert.ok(out.reason_code.startsWith("hard_gate:company"));
    assert.equal(out.short_circuited_at_stage, "hard_gate");
    assert.deepEqual(out.stages_run, ["extract", "hard_gate"]);
    assert.equal(out.values_result, null);
    assert.equal(out.soft_score_result, null);
    // Provider was called only for extract.
    assert.equal(provider.invocations.length, 1);
  });
});

describe("evaluateJob — values_check rejection", () => {
  it("rejects on a high-confidence values violation, skips score", async () => {
    const provider = new MockJsonOutputProvider([
      // 1. extract
      baseValidFacts({
        company: "Acme Defense",
        industry_tags: ["defense_weapons"]
      }),
      // 2. values_check returns a clear violation
      {
        violation: true,
        matched_refusal: "Autonomous lethal systems or weapon targeting",
        excerpt: "build target-acquisition models",
        confidence: 0.92,
        rationale: "Clear violation"
      }
    ]);

    const criteria = baseCriteria({
      values_refusals: ["Autonomous lethal systems or weapon targeting"]
    });

    const out = await evaluateJob(provider, { text: "posting" }, criteria);

    assert.equal(out.verdict, "rejected");
    assert.ok(out.reason_code.startsWith("values:"));
    assert.equal(out.short_circuited_at_stage, "values_check");
    assert.deepEqual(out.stages_run, ["extract", "hard_gate", "values_check"]);
    assert.ok(out.values_result);
    assert.equal(out.soft_score_result, null);
    // Provider called for extract + values_check (2 total).
    assert.equal(provider.invocations.length, 2);
  });
});

describe("evaluateJob — values_check needs_review", () => {
  it("flags needs_review for ambiguous values verdicts", async () => {
    const provider = new MockJsonOutputProvider([
      baseValidFacts(),
      {
        violation: true,
        matched_refusal: "Mass surveillance tooling sold to state actors",
        excerpt: "law-enforcement workflows",
        confidence: 0.5,
        rationale: "Ambiguous"
      }
    ]);

    const criteria = baseCriteria({
      values_refusals: ["Mass surveillance tooling sold to state actors"]
    });

    const out = await evaluateJob(provider, { text: "posting" }, criteria);

    assert.equal(out.verdict, "needs_review");
    assert.equal(out.reason_code, "values:needs_review");
    assert.equal(out.short_circuited_at_stage, "values_check");
    assert.equal(out.soft_score_result, null);
  });
});

describe("evaluateJob — soft_score below threshold", () => {
  it("flags below_threshold when score < min_soft_score", async () => {
    const provider = new MockJsonOutputProvider([
      baseValidFacts(),
      // values_check short-circuits since refusals empty
      {
        score: 0.3,
        contributions: [
          {
            topic: "AI/ML evaluation systems",
            weight: 1.0,
            contribution: 0.2,
            rationale: "Weak match"
          }
        ],
        rationale: "Below threshold"
      }
    ]);

    const criteria = baseCriteria();
    criteria.soft_preferences.positive.push({
      topic: "AI/ML evaluation systems",
      weight: 1.0
    });

    const out = await evaluateJob(provider, { text: "posting" }, criteria);

    assert.equal(out.verdict, "below_threshold");
    assert.equal(out.reason_code, "soft:below_threshold:0.30");
    assert.equal(out.short_circuited_at_stage, "soft_score");
    assert.deepEqual(out.stages_run, [
      "extract",
      "hard_gate",
      "values_check",
      "soft_score"
    ]);
  });
});

describe("evaluateJob — observability", () => {
  it("aggregates provider_runs across all stages including skipped ones", async () => {
    const provider = new MockJsonOutputProvider([
      baseValidFacts(),
      // values_check + soft_score both short-circuit (empty refusals + empty preferences)
    ]);

    const out = await evaluateJob(
      provider,
      { text: "posting" },
      baseCriteria()
    );

    // 1 real run (extract) + 2 "skipped" runs from values + score.
    assert.equal(out.provider_runs.length, 3);
    assert.equal(out.provider_runs[0].provider, "mock");
    assert.equal(out.provider_runs[1].provider, "skipped");
    assert.equal(out.provider_runs[2].provider, "skipped");
  });

  it("threads input_hash, extractor_version, and criteria_version through the verdict", async () => {
    const provider = new MockJsonOutputProvider([baseValidFacts()]);

    const criteria = baseCriteria();
    criteria.version = 42;
    criteria.hard_gates.must_not_have.push({
      kind: "company",
      any_of: ["AcmeBlocked"],
      reason: "test"
    });
    // Cause a hard-gate reject so we keep the test deterministic.
    const out = await evaluateJob(
      provider,
      { text: "posting" },
      criteria
    );

    assert.equal(out.criteria_version, 42);
    assert.ok(out.input_hash.length > 0);
    assert.equal(out.extractor_version, "extract_v1");
  });
});
