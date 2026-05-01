import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { CandidateCriteria } from "@networkpipeline/criteria";
import {
  applyLLMResult,
  EXTRACTOR_VERSION,
  nextStep,
  type ExtractedJobFacts,
  type PendingEvalState,
  type ValuesCheckResult
} from "../index.js";

function baseCriteria(
  overrides: Partial<CandidateCriteria> = {}
): CandidateCriteria {
  return {
    version: 1,
    schema_version: "1.0.0",
    updated_at: "2026-04-29T00:00:00Z",
    updated_via: "criteria_init",
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
    values_refusals: [],
    soft_preferences: { positive: [], negative: [], min_soft_score: 0.55 },
    calibration: { accepted_examples: [], rejected_examples: [] },
    ...overrides
  };
}

function basePending(
  overrides: Partial<PendingEvalState> = {}
): PendingEvalState {
  return {
    posting_text: "Title: SWE\nCompany: Example",
    source_url: null,
    status: "awaiting_extract",
    current_call_id: null,
    current_call_attempts: 0,
    facts: null,
    hard_gate_result: null,
    values_result: null,
    provider_runs: [],
    ...overrides
  };
}

function validExtract(
  overrides: Partial<ExtractedJobFacts> = {}
): ExtractedJobFacts {
  return {
    extractor_version: EXTRACTOR_VERSION,
    title: "SWE",
    company: "Example",
    seniority_signals: [],
    required_clearance: null,
    required_yoe: { min: null, max: null },
    industry_tags: [],
    required_onsite: { is_required: false, locations: [] },
    employment_type: "full_time",
    work_authorization_constraints: [],
    stack: [],
    raw_text_excerpt: "Example posting body.",
    ...overrides
  };
}

describe("nextStep — initial state issues an extract call", () => {
  it("returns needs_llm with stage=extract for a fresh pending row", () => {
    const out = nextStep({
      pending: basePending(),
      criteria: baseCriteria()
    });
    assert.equal(out.kind, "needs_llm");
    if (out.kind !== "needs_llm") return;
    assert.equal(out.call.stage, "extract");
    assert.equal(out.call.prompt_id, "extract_job_facts@v1");
    assert.equal(out.nextStatus, "awaiting_extract");
    assert.ok(out.call.system_prompt.includes("# Output format"));
    assert.ok(out.call.user_prompt.includes("Posting:"));
    assert.ok(typeof out.call.json_schema === "object");
    assert.ok(out.call.call_id.length > 0);
  });
});

describe("applyLLMResult — extract stage", () => {
  it("on valid facts and no refusals/preferences, short-circuits values+score and completes", () => {
    const pending = basePending();
    // min_soft_score < neutral 0.5 so the empty-preferences fast path
    // resolves to accepted rather than below_threshold.
    const criteria = baseCriteria({
      soft_preferences: { positive: [], negative: [], min_soft_score: 0.4 }
    });
    const applied = applyLLMResult(
      { pending, criteria },
      validExtract()
    );
    assert.equal(applied.next.kind, "completed");
    if (applied.next.kind !== "completed") return;
    assert.equal(applied.next.result.verdict, "accepted");
    // No preferences; soft_score short-circuited.
    assert.equal(
      applied.next.result.short_circuited_at_stage,
      null
    );
    // provider_runs include the extract callback run + skipped values + skipped score.
    assert.equal(applied.next.result.provider_runs.length, 3);
    assert.equal(applied.next.result.provider_runs[0].provider, "callback");
    assert.equal(applied.next.result.provider_runs[1].provider, "skipped");
    assert.equal(applied.next.result.provider_runs[2].provider, "skipped");
  });

  it("on invalid facts, returns needs_llm with attempts=1 and feedback embedded", () => {
    const pending = basePending();
    const criteria = baseCriteria();
    const applied = applyLLMResult(
      { pending, criteria },
      { extractor_version: EXTRACTOR_VERSION, title: "" /* invalid: min(1) */ }
    );
    assert.equal(applied.next.kind, "needs_llm");
    if (applied.next.kind !== "needs_llm") return;
    assert.equal(applied.next.call.stage, "extract");
    assert.equal(applied.patch.current_call_attempts, 1);
    assert.ok(
      applied.next.call.user_prompt.includes(
        "Your previous JSON response did not match"
      )
    );
  });

  it("after MAX_RECORD_RETRIES exhausted, returns failed", () => {
    const pending = basePending({ current_call_attempts: 1 });
    const criteria = baseCriteria();
    const applied = applyLLMResult(
      { pending, criteria },
      { not: "even_close" }
    );
    assert.equal(applied.next.kind, "failed");
  });
});

describe("nextStep — hard-gate rejection short-circuits to completed", () => {
  it("rejects on company blocklist after extract completes", () => {
    const criteria = baseCriteria({
      hard_gates: {
        must_have: [],
        must_not_have: [
          { kind: "company", any_of: ["Anduril"], reason: "values" }
        ],
        must_not_contain_phrases: []
      }
    });
    const facts = validExtract({ company: "Anduril" });
    const out = nextStep({
      pending: basePending({ facts, status: "awaiting_extract" }),
      criteria
    });
    assert.equal(out.kind, "completed");
    if (out.kind !== "completed") return;
    assert.equal(out.result.verdict, "rejected");
    assert.equal(out.result.short_circuited_at_stage, "hard_gate");
    assert.ok(out.result.reason_code.startsWith("hard_gate:company"));
  });
});

describe("nextStep — values stage transitions", () => {
  const valuesCriteria = baseCriteria({
    values_refusals: ["autonomous lethal systems"]
  });
  const facts = validExtract();

  it("with refusals configured and no values_result yet, issues a values pending_llm_call", () => {
    const out = nextStep({
      pending: basePending({ facts }),
      criteria: valuesCriteria
    });
    assert.equal(out.kind, "needs_llm");
    if (out.kind !== "needs_llm") return;
    assert.equal(out.call.stage, "values");
    assert.equal(out.nextStatus, "awaiting_values");
    assert.equal(out.call.prompt_id, "values_check@v1");
  });

  it("on values_result decision=reject, short-circuits to rejected verdict", () => {
    const valuesResult: ValuesCheckResult = {
      decision: "reject",
      raw: {
        violation: true,
        matched_refusal: "autonomous lethal systems",
        excerpt: null,
        confidence: 0.9,
        rationale: "."
      },
      reason_code: "values:autonomous_lethal_systems"
    };
    const out = nextStep({
      pending: basePending({
        facts,
        values_result: valuesResult,
        status: "awaiting_values"
      }),
      criteria: valuesCriteria
    });
    assert.equal(out.kind, "completed");
    if (out.kind !== "completed") return;
    assert.equal(out.result.verdict, "rejected");
    assert.equal(out.result.short_circuited_at_stage, "values_check");
  });

  it("on values_result decision=needs_review, completes with verdict=needs_review", () => {
    const valuesResult: ValuesCheckResult = {
      decision: "needs_review",
      raw: {
        violation: true,
        matched_refusal: "autonomous lethal systems",
        excerpt: null,
        confidence: 0.5,
        rationale: "."
      },
      reason_code: ""
    };
    const out = nextStep({
      pending: basePending({
        facts,
        values_result: valuesResult,
        status: "awaiting_values"
      }),
      criteria: valuesCriteria
    });
    assert.equal(out.kind, "completed");
    if (out.kind !== "completed") return;
    assert.equal(out.result.verdict, "needs_review");
    assert.equal(out.result.reason_code, "values:needs_review");
  });
});

describe("applyLLMResult — values stage", () => {
  const criteria = baseCriteria({
    values_refusals: ["autonomous lethal systems"],
    // Lower threshold so the empty-preferences neutral score (0.5)
    // doesn't trigger below_threshold and obscure the values-side
    // logic this test cares about.
    soft_preferences: { positive: [], negative: [], min_soft_score: 0.4 }
  });
  const facts = validExtract();

  it("on valid clear verdict and no preferences, short-circuits soft_score and completes accepted", () => {
    const applied = applyLLMResult(
      {
        pending: basePending({
          facts,
          status: "awaiting_values"
        }),
        criteria
      },
      {
        violation: false,
        matched_refusal: null,
        excerpt: null,
        confidence: 0.05,
        rationale: "Not a violation."
      }
    );
    assert.equal(applied.next.kind, "completed");
    if (applied.next.kind !== "completed") return;
    assert.equal(applied.next.result.verdict, "accepted");
  });

  it("on invalid values verdict, returns retry with attempts=1", () => {
    const applied = applyLLMResult(
      {
        pending: basePending({
          facts,
          status: "awaiting_values"
        }),
        criteria
      },
      { violation: "not a boolean" }
    );
    assert.equal(applied.next.kind, "needs_llm");
    assert.equal(applied.patch.current_call_attempts, 1);
  });
});

describe("nextStep — soft_score stage", () => {
  it("with preferences configured and no soft_score result, issues a score pending_llm_call", () => {
    const criteria = baseCriteria({
      soft_preferences: {
        positive: [{ topic: "x", weight: 1 }],
        negative: [],
        min_soft_score: 0.55
      }
    });
    const valuesResult: ValuesCheckResult = {
      decision: "clear",
      raw: {
        violation: false,
        matched_refusal: null,
        excerpt: null,
        confidence: 0.0,
        rationale: "."
      },
      reason_code: ""
    };
    const out = nextStep({
      pending: basePending({
        facts: validExtract(),
        values_result: valuesResult,
        status: "awaiting_values"
      }),
      criteria
    });
    assert.equal(out.kind, "needs_llm");
    if (out.kind !== "needs_llm") return;
    assert.equal(out.call.stage, "soft_score");
    assert.equal(out.nextStatus, "awaiting_score");
    assert.equal(out.call.prompt_id, "soft_score@v1");
    // Schema docs the per-topic contribution.
    assert.ok(JSON.stringify(out.call.json_schema).includes("contributions"));
  });
});

describe("applyLLMResult — soft_score stage", () => {
  const criteria = baseCriteria({
    soft_preferences: {
      positive: [{ topic: "AI/ML", weight: 1 }],
      negative: [],
      min_soft_score: 0.55
    }
  });
  const valuesResult: ValuesCheckResult = {
    decision: "clear",
    raw: {
      violation: false,
      matched_refusal: null,
      excerpt: null,
      confidence: 0.0,
      rationale: "."
    },
    reason_code: ""
  };

  it("on valid above-threshold score, completes accepted", () => {
    const applied = applyLLMResult(
      {
        pending: basePending({
          facts: validExtract(),
          values_result: valuesResult,
          status: "awaiting_score"
        }),
        criteria
      },
      {
        score: 0.9,
        contributions: [
          { topic: "AI/ML", weight: 1, contribution: 0.9, rationale: "match" }
        ],
        rationale: "Strong fit."
      }
    );
    assert.equal(applied.next.kind, "completed");
    if (applied.next.kind !== "completed") return;
    assert.equal(applied.next.result.verdict, "accepted");
    assert.equal(applied.next.result.short_circuited_at_stage, null);
    assert.equal(applied.next.result.soft_score_result?.raw.score, 0.9);
  });

  it("on valid below-threshold score, completes below_threshold with §11 reason code", () => {
    const applied = applyLLMResult(
      {
        pending: basePending({
          facts: validExtract(),
          values_result: valuesResult,
          status: "awaiting_score"
        }),
        criteria
      },
      {
        score: 0.2,
        contributions: [
          { topic: "AI/ML", weight: 1, contribution: 0.2, rationale: "weak" }
        ],
        rationale: "Below the bar."
      }
    );
    assert.equal(applied.next.kind, "completed");
    if (applied.next.kind !== "completed") return;
    assert.equal(applied.next.result.verdict, "below_threshold");
    assert.equal(applied.next.result.short_circuited_at_stage, "soft_score");
    assert.ok(
      applied.next.result.reason_code.startsWith("soft:below_threshold:")
    );
  });
});

describe("applyLLMResult — guards on bad statuses", () => {
  it("returns failed when called against a completed status", () => {
    const applied = applyLLMResult(
      {
        pending: basePending({ status: "completed" }),
        criteria: baseCriteria()
      },
      {}
    );
    assert.equal(applied.next.kind, "failed");
  });
});
