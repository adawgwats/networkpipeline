import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { CandidateCriteria } from "@networkpipeline/criteria";
import {
  applyThreshold,
  buildSoftScoreSystemPrompt,
  MockJsonOutputProvider,
  NO_PREFERENCES_NEUTRAL_SCORE,
  softScore,
  SOFT_SCORE_PROMPT_ID,
  type SoftScoreVerdictRaw
} from "../index.js";
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
      display_name: "Test",
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
    values_refusals: [],
    soft_preferences: {
      positive: [
        { topic: "AI/ML evaluation systems", weight: 1.0 },
        {
          topic: "Frontier AI labs",
          weight: 1.0,
          companies_boost: ["Anthropic", "OpenAI"]
        }
      ],
      negative: [{ topic: "crypto/web3-only roles", weight: -0.6 }],
      min_soft_score: 0.55
    },
    calibration: {
      accepted_examples: [
        {
          why: "Anthropic Research Engineer — dead-center fit",
          score: 0.95
        }
      ],
      rejected_examples: [
        {
          why: "Anduril targeting work",
          rejection_reason: "values:autonomous_lethal"
        }
      ]
    },
    ...overrides
  };
}

function rawVerdict(
  overrides: Partial<SoftScoreVerdictRaw> = {}
): SoftScoreVerdictRaw {
  return {
    score: 0.7,
    contributions: [
      {
        topic: "AI/ML evaluation systems",
        weight: 1.0,
        contribution: 0.8,
        rationale: "Posting describes building eval harnesses."
      },
      {
        topic: "Frontier AI labs",
        weight: 1.0,
        contribution: 0.9,
        rationale: "Anthropic listed in preferences."
      },
      {
        topic: "crypto/web3-only roles",
        weight: -0.6,
        contribution: 0.0,
        rationale: "Not crypto-related."
      }
    ],
    rationale: "Strong fit with two positive matches.",
    ...overrides
  };
}

describe("buildSoftScoreSystemPrompt", () => {
  it("includes positive preferences with weight, evidence, and companies_boost", () => {
    const criteria = baseCriteria();
    criteria.soft_preferences.positive[0].evidence = "VegaTitan, MAESTRO";
    const prompt = buildSoftScoreSystemPrompt(criteria);
    assert.ok(prompt.includes("AI/ML evaluation systems"));
    assert.ok(prompt.includes("VegaTitan, MAESTRO"));
    assert.ok(prompt.includes("Anthropic, OpenAI"));
    assert.ok(prompt.includes("(weight 1)"));
  });

  it("includes negative preferences", () => {
    const prompt = buildSoftScoreSystemPrompt(baseCriteria());
    assert.ok(prompt.includes("crypto/web3-only roles"));
    assert.ok(prompt.includes("(weight -0.6)"));
  });

  it("includes accepted calibration anchors with their scores", () => {
    const prompt = buildSoftScoreSystemPrompt(baseCriteria());
    assert.ok(prompt.includes("score 0.95"));
    assert.ok(prompt.includes("Anthropic Research Engineer"));
  });

  it("includes only values-based rejected calibration anchors", () => {
    const c = baseCriteria();
    c.calibration.rejected_examples.push({
      why: "Wrong seniority",
      rejection_reason: "hard_gate:role_seniority:staff"
    });
    const prompt = buildSoftScoreSystemPrompt(c);
    assert.ok(
      prompt.includes("values:autonomous_lethal"),
      "values-based rejection should appear"
    );
    assert.ok(
      !prompt.includes("Wrong seniority"),
      "hard-gate rejections should NOT be in the soft-score prompt"
    );
  });

  it("renders '(none configured)' for empty sections so the prompt remains stable", () => {
    const c = baseCriteria();
    c.soft_preferences.positive = [];
    c.soft_preferences.negative = [];
    c.calibration.accepted_examples = [];
    c.calibration.rejected_examples = [];
    const prompt = buildSoftScoreSystemPrompt(c);
    assert.ok(prompt.includes("(none configured)"));
  });

  it("is byte-stable across calls with the same input", () => {
    const c = baseCriteria();
    assert.equal(buildSoftScoreSystemPrompt(c), buildSoftScoreSystemPrompt(c));
  });

  it("changes when criteria changes (so cache key invalidates correctly)", () => {
    const a = buildSoftScoreSystemPrompt(baseCriteria());
    const c2 = baseCriteria();
    c2.soft_preferences.positive.push({ topic: "robotics", weight: 0.7 });
    const b = buildSoftScoreSystemPrompt(c2);
    assert.notEqual(a, b);
  });
});

describe("applyThreshold", () => {
  it("marks below_threshold and emits reason code when score < min_soft_score", () => {
    const out = applyThreshold(rawVerdict({ score: 0.4 }), baseCriteria());
    assert.equal(out.below_threshold, true);
    assert.equal(out.reason_code, "soft:below_threshold:0.40");
  });

  it("does not mark below_threshold when score equals min_soft_score", () => {
    const c = baseCriteria();
    c.soft_preferences.min_soft_score = 0.55;
    const out = applyThreshold(rawVerdict({ score: 0.55 }), c);
    assert.equal(out.below_threshold, false);
    assert.equal(out.reason_code, "");
  });

  it("formats reason code score to 2 decimals consistently", () => {
    const out = applyThreshold(rawVerdict({ score: 0.123456 }), baseCriteria());
    assert.equal(out.reason_code, "soft:below_threshold:0.12");
  });
});

describe("softScore — empty preferences short-circuit", () => {
  it("does not call the provider when both positive and negative are empty", async () => {
    const c = baseCriteria();
    c.soft_preferences.positive = [];
    c.soft_preferences.negative = [];

    const provider = new MockJsonOutputProvider(); // no responses queued
    const out = await softScore(provider, {
      facts: baseValidFacts(),
      criteria: c
    });
    assert.equal(provider.invocations.length, 0);
    assert.equal(out.result.raw.score, NO_PREFERENCES_NEUTRAL_SCORE);
    assert.equal(out.result.raw.contributions.length, 0);
    assert.equal(out.run.provider, "skipped");
    assert.equal(out.run.stop_reason, "skipped_no_preferences");
  });

  it("DOES call the provider when only one of positive/negative is non-empty", async () => {
    const c = baseCriteria();
    c.soft_preferences.negative = [];
    const provider = new MockJsonOutputProvider([rawVerdict({ score: 0.7 })]);
    await softScore(provider, { facts: baseValidFacts(), criteria: c });
    assert.equal(provider.invocations.length, 1);
  });
});

describe("softScore — provider invocation contract", () => {
  it("passes the composed system prompt and the versioned id", async () => {
    const provider = new MockJsonOutputProvider([rawVerdict()]);
    await softScore(provider, {
      facts: baseValidFacts(),
      criteria: baseCriteria()
    });
    const call = provider.invocations[0];
    assert.equal(call?.promptId, SOFT_SCORE_PROMPT_ID);
    assert.equal(call?.toolName, "submit_soft_score");
    assert.ok(call?.systemPrompt.includes("AI/ML evaluation systems"));
    assert.ok(call?.systemPrompt.includes("score 0.95"));
  });

  it("user prompt includes posting facts and the extractor version", async () => {
    const provider = new MockJsonOutputProvider([rawVerdict()]);
    await softScore(provider, {
      facts: baseValidFacts({
        title: "Research Engineer, Agents",
        company: "Anthropic"
      }),
      criteria: baseCriteria()
    });
    const userPrompt = provider.invocations[0]?.userPrompt ?? "";
    assert.ok(userPrompt.includes("Research Engineer, Agents"));
    assert.ok(userPrompt.includes("Anthropic"));
    assert.ok(userPrompt.includes("extract_v1"));
  });
});

describe("softScore — end-to-end", () => {
  it("returns a passing verdict above threshold with full contributions", async () => {
    const provider = new MockJsonOutputProvider([rawVerdict({ score: 0.91 })]);
    const out = await softScore(provider, {
      facts: baseValidFacts(),
      criteria: baseCriteria()
    });
    assert.equal(out.result.raw.score, 0.91);
    assert.equal(out.result.below_threshold, false);
    assert.equal(out.result.reason_code, "");
    assert.ok(out.result.raw.contributions.length >= 1);
  });

  it("returns a below-threshold verdict with the §11 reason code", async () => {
    const provider = new MockJsonOutputProvider([rawVerdict({ score: 0.31 })]);
    const out = await softScore(provider, {
      facts: baseValidFacts(),
      criteria: baseCriteria()
    });
    assert.equal(out.result.below_threshold, true);
    assert.equal(out.result.reason_code, "soft:below_threshold:0.31");
  });

  it("propagates ProviderRun observability fields", async () => {
    const provider = new MockJsonOutputProvider([rawVerdict({ score: 0.7 })]);
    const out = await softScore(provider, {
      facts: baseValidFacts(),
      criteria: baseCriteria()
    });
    assert.equal(out.run.provider, "mock");
    assert.equal(out.run.prompt_id, SOFT_SCORE_PROMPT_ID);
    assert.equal(out.run.stop_reason, "tool_use");
  });
});
