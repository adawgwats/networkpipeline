import { strict as assert } from "node:assert";
import { describe, it, after } from "node:test";
import { JobEvaluationsRepository } from "../repositories/job_evaluations.js";
import type { JobEvaluationInsert } from "../schema/job_evaluations.js";
import { makeTestDb } from "./helpers.js";

function baseEvaluation(
  overrides: Partial<JobEvaluationInsert> = {}
): JobEvaluationInsert {
  return {
    id: "eval-1",
    input_hash: "h-abc",
    criteria_version_id: "cv-1",
    extractor_version: "extract_v1",
    verdict: "accepted",
    reason_code: "",
    short_circuited_at_stage: null,
    stages_run_json: JSON.stringify([
      "extract",
      "hard_gate",
      "values_check",
      "soft_score"
    ]),
    facts_json: JSON.stringify({ title: "Engineer", company: "Acme" }),
    hard_gate_result_json: JSON.stringify({ pass: true }),
    values_result_json: null,
    soft_score_result_json: null,
    mcp_invocation_id: null,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

describe("JobEvaluationsRepository — basic CRUD", () => {
  const conn = makeTestDb();
  const repo = new JobEvaluationsRepository(conn.db);
  after(() => conn.close());

  it("insert + findById", () => {
    repo.insert(baseEvaluation());
    const out = repo.findById("eval-1");
    assert.ok(out);
    assert.equal(out!.verdict, "accepted");
    assert.equal(out!.input_hash, "h-abc");
  });

  it("listByVerdict filters and orders newest first", () => {
    repo.insert(
      baseEvaluation({
        id: "eval-rej-old",
        verdict: "rejected",
        reason_code: "hard_gate:company:anduril",
        created_at: "2026-01-01T00:00:00Z"
      })
    );
    repo.insert(
      baseEvaluation({
        id: "eval-rej-new",
        verdict: "rejected",
        reason_code: "values:autonomous_lethal",
        created_at: "2026-01-05T00:00:00Z"
      })
    );
    const rows = repo.listByVerdict("rejected", 10);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, "eval-rej-new");
  });

  it("countByVerdict aggregates correctly", () => {
    repo.insert(
      baseEvaluation({ id: "eval-low", verdict: "below_threshold" })
    );
    const counts = repo.countByVerdict();
    assert.ok(counts["accepted"] >= 1);
    assert.ok(counts["rejected"] >= 2);
    assert.ok(counts["below_threshold"] >= 1);
  });

  it("listByCriteriaVersion filters by version id", () => {
    repo.insert(
      baseEvaluation({
        id: "eval-cv1",
        criteria_version_id: "cv-target"
      })
    );
    const rows = repo.listByCriteriaVersion("cv-target");
    assert.equal(rows.length, 1);
  });
});

describe("JobEvaluationsRepository — dedup lookup", () => {
  const conn = makeTestDb();
  const repo = new JobEvaluationsRepository(conn.db);
  after(() => conn.close());

  it("returns most recent match for a complete dedup key", () => {
    repo.insert(
      baseEvaluation({
        id: "old",
        input_hash: "deadbeef",
        criteria_version_id: "cv-7",
        extractor_version: "extract_v1",
        created_at: "2026-01-01T00:00:00Z"
      })
    );
    repo.insert(
      baseEvaluation({
        id: "new",
        input_hash: "deadbeef",
        criteria_version_id: "cv-7",
        extractor_version: "extract_v1",
        created_at: "2026-01-05T00:00:00Z"
      })
    );
    const out = repo.findByDedupKey({
      input_hash: "deadbeef",
      criteria_version_id: "cv-7",
      extractor_version: "extract_v1"
    });
    assert.equal(out?.id, "new");
  });

  it("does NOT match across different criteria_version_ids", () => {
    repo.insert(
      baseEvaluation({
        id: "cv-7-eval",
        input_hash: "different",
        criteria_version_id: "cv-7",
        extractor_version: "extract_v1"
      })
    );
    const out = repo.findByDedupKey({
      input_hash: "different",
      criteria_version_id: "cv-99",
      extractor_version: "extract_v1"
    });
    assert.equal(out, undefined);
  });

  it("does NOT match across different extractor versions", () => {
    repo.insert(
      baseEvaluation({
        id: "ext-v1",
        input_hash: "ext-mismatch",
        criteria_version_id: "cv-7",
        extractor_version: "extract_v1"
      })
    );
    const out = repo.findByDedupKey({
      input_hash: "ext-mismatch",
      criteria_version_id: "cv-7",
      extractor_version: "extract_v2"
    });
    assert.equal(out, undefined);
  });

  it("matches null criteria_version_id explicitly (not implicitly)", () => {
    repo.insert(
      baseEvaluation({
        id: "no-cv",
        input_hash: "no-cv-hash",
        criteria_version_id: null,
        extractor_version: "extract_v1"
      })
    );
    const out = repo.findByDedupKey({
      input_hash: "no-cv-hash",
      criteria_version_id: null,
      extractor_version: "extract_v1"
    });
    assert.equal(out?.id, "no-cv");
    // And does NOT match when caller provides a non-null id.
    const miss = repo.findByDedupKey({
      input_hash: "no-cv-hash",
      criteria_version_id: "cv-x",
      extractor_version: "extract_v1"
    });
    assert.equal(miss, undefined);
  });
});
