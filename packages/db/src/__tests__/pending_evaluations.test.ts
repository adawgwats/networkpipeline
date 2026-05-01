import { strict as assert } from "node:assert";
import { after, describe, it } from "node:test";
import { PendingEvaluationsRepository } from "../repositories/pending_evaluations.js";
import type { PendingEvaluationInsert } from "../schema/pending_evaluations.js";
import { makeTestDb } from "./helpers.js";

function basePending(
  overrides: Partial<PendingEvaluationInsert> = {}
): PendingEvaluationInsert {
  return {
    id: "pe-1",
    posting_text: "Title: SWE\nCompany: Example",
    source_url: null,
    metadata_json: null,
    criteria_version_id: "cv-1",
    criteria_snapshot_json: '{"version":1}',
    search_run_id: null,
    discovered_posting_id: null,
    mcp_invocation_id: null,
    status: "awaiting_extract",
    current_call_id: null,
    current_call_attempts: 0,
    facts_json: null,
    hard_gate_result_json: null,
    values_result_json: null,
    result_json: null,
    error_message: null,
    provider_runs_json: "[]",
    created_at: "2026-04-29T00:00:00Z",
    updated_at: "2026-04-29T00:00:00Z",
    ...overrides
  };
}

describe("PendingEvaluationsRepository — basic CRUD", () => {
  const conn = makeTestDb();
  const repo = new PendingEvaluationsRepository(conn.db);
  after(() => conn.close());

  it("insert + findById round-trips a row", () => {
    repo.insert(basePending());
    const out = repo.findById("pe-1");
    assert.ok(out);
    assert.equal(out!.status, "awaiting_extract");
    assert.equal(out!.posting_text, "Title: SWE\nCompany: Example");
    assert.equal(out!.provider_runs_json, "[]");
  });

  it("findById returns undefined for missing id", () => {
    assert.equal(repo.findById("nope"), undefined);
  });
});

describe("PendingEvaluationsRepository — findByCallId", () => {
  const conn = makeTestDb();
  const repo = new PendingEvaluationsRepository(conn.db);
  after(() => conn.close());

  it("returns the row whose current_call_id matches", () => {
    repo.insert(
      basePending({
        id: "pe-call-1",
        current_call_id: "call-abc"
      })
    );
    const out = repo.findByCallId("call-abc");
    assert.ok(out);
    assert.equal(out!.id, "pe-call-1");
  });

  it("returns undefined when no row matches the call_id", () => {
    assert.equal(repo.findByCallId("missing"), undefined);
  });
});

describe("PendingEvaluationsRepository — listAwaitingForRun", () => {
  const conn = makeTestDb();
  const repo = new PendingEvaluationsRepository(conn.db);
  after(() => conn.close());

  it("returns only awaiting_* statuses for the given search_run, ordered by created_at ASC", () => {
    repo.insert(
      basePending({
        id: "pe-run-1",
        search_run_id: "run-A",
        status: "awaiting_extract",
        created_at: "2026-04-29T00:00:01Z"
      })
    );
    repo.insert(
      basePending({
        id: "pe-run-2",
        search_run_id: "run-A",
        status: "awaiting_values",
        created_at: "2026-04-29T00:00:02Z"
      })
    );
    repo.insert(
      basePending({
        id: "pe-run-3",
        search_run_id: "run-A",
        status: "completed",
        created_at: "2026-04-29T00:00:03Z"
      })
    );
    repo.insert(
      basePending({
        id: "pe-run-other",
        search_run_id: "run-B",
        status: "awaiting_extract",
        created_at: "2026-04-29T00:00:04Z"
      })
    );

    const rows = repo.listAwaitingForRun("run-A");
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => r.id),
      ["pe-run-1", "pe-run-2"]
    );
  });
});

describe("PendingEvaluationsRepository — update / markFailed / markCompleted", () => {
  const conn = makeTestDb();
  const repo = new PendingEvaluationsRepository(conn.db);
  after(() => conn.close());

  it("update applies a partial patch and bumps updated_at", () => {
    repo.insert(basePending({ id: "pe-up-1" }));
    repo.update(
      "pe-up-1",
      {
        status: "awaiting_values",
        current_call_id: "call-xyz",
        current_call_attempts: 1,
        facts_json: '{"title":"x"}',
        provider_runs_json: '[{"provider":"callback"}]'
      },
      "2026-04-30T00:00:00Z"
    );
    const out = repo.findById("pe-up-1");
    assert.equal(out!.status, "awaiting_values");
    assert.equal(out!.current_call_id, "call-xyz");
    assert.equal(out!.current_call_attempts, 1);
    assert.equal(out!.facts_json, '{"title":"x"}');
    assert.equal(out!.updated_at, "2026-04-30T00:00:00Z");
    // unspecified fields untouched
    assert.equal(out!.values_result_json, null);
  });

  it("markFailed clears current_call_id and writes the error message", () => {
    repo.insert(
      basePending({
        id: "pe-fail-1",
        current_call_id: "call-pre-fail"
      })
    );
    repo.markFailed("pe-fail-1", "stage exhausted", "2026-04-30T00:00:00Z");
    const out = repo.findById("pe-fail-1");
    assert.equal(out!.status, "failed");
    assert.equal(out!.current_call_id, null);
    assert.equal(out!.error_message, "stage exhausted");
  });

  it("markCompleted clears current_call_id and stores the result_json", () => {
    repo.insert(
      basePending({
        id: "pe-done-1",
        current_call_id: "call-pre-done"
      })
    );
    repo.markCompleted(
      "pe-done-1",
      '{"verdict":"accepted"}',
      "2026-04-30T00:00:00Z"
    );
    const out = repo.findById("pe-done-1");
    assert.equal(out!.status, "completed");
    assert.equal(out!.current_call_id, null);
    assert.equal(out!.result_json, '{"verdict":"accepted"}');
  });
});

describe("PendingEvaluationsRepository — listByRun returns terminal rows too", () => {
  const conn = makeTestDb();
  const repo = new PendingEvaluationsRepository(conn.db);
  after(() => conn.close());

  it("includes completed and failed rows alongside awaiting", () => {
    repo.insert(
      basePending({
        id: "pe-mix-1",
        search_run_id: "run-X",
        status: "completed",
        created_at: "2026-04-29T00:00:01Z"
      })
    );
    repo.insert(
      basePending({
        id: "pe-mix-2",
        search_run_id: "run-X",
        status: "awaiting_extract",
        created_at: "2026-04-29T00:00:02Z"
      })
    );
    repo.insert(
      basePending({
        id: "pe-mix-3",
        search_run_id: "run-X",
        status: "failed",
        created_at: "2026-04-29T00:00:03Z"
      })
    );
    const rows = repo.listByRun("run-X");
    assert.equal(rows.length, 3);
  });
});
