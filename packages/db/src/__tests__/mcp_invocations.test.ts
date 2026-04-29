import { strict as assert } from "node:assert";
import { describe, it, after } from "node:test";
import { McpInvocationsRepository } from "../repositories/mcp_invocations.js";
import { makeTestDb } from "./helpers.js";

describe("McpInvocationsRepository", () => {
  const conn = makeTestDb();
  const repo = new McpInvocationsRepository(conn.db);

  after(() => conn.close());

  it("insert + findById round-trips a row", () => {
    repo.insert({
      id: "inv-1",
      tool_name: "evaluate_job",
      args_hash: "h-abc",
      result_kind: "ok",
      result_summary: "verdict=accepted",
      started_at: "2026-01-01T00:00:00Z",
      latency_ms: 250,
      meta_json: null
    });
    const out = repo.findById("inv-1");
    assert.ok(out);
    assert.equal(out!.tool_name, "evaluate_job");
    assert.equal(out!.latency_ms, 250);
    assert.equal(out!.meta_json, null);
  });

  it("listRecent returns rows ordered by started_at desc", () => {
    repo.insert({
      id: "inv-recent-old",
      tool_name: "evaluate_job",
      args_hash: "h",
      result_kind: "ok",
      result_summary: "x",
      started_at: "2026-01-01T00:00:00Z",
      latency_ms: 1,
      meta_json: null
    });
    repo.insert({
      id: "inv-recent-new",
      tool_name: "evaluate_job",
      args_hash: "h",
      result_kind: "ok",
      result_summary: "x",
      started_at: "2026-01-05T00:00:00Z",
      latency_ms: 1,
      meta_json: null
    });
    const rows = repo.listRecent(10);
    const ids = rows.map((r) => r.id);
    const newIdx = ids.indexOf("inv-recent-new");
    const oldIdx = ids.indexOf("inv-recent-old");
    assert.ok(newIdx >= 0 && oldIdx >= 0);
    assert.ok(newIdx < oldIdx, "newer row must come first");
  });

  it("countByResultKind aggregates rows", () => {
    repo.insert({
      id: "inv-2",
      tool_name: "evaluate_job",
      args_hash: "h",
      result_kind: "validation_error",
      result_summary: "1 issue",
      started_at: "2026-01-02T00:00:00Z",
      latency_ms: 1,
      meta_json: null
    });
    const counts = repo.countByResultKind();
    assert.ok(counts["ok"] >= 1);
    assert.ok(counts["validation_error"] >= 1);
  });

  it("insertMany handles empty arrays without erroring", () => {
    repo.insertMany([]);
  });
});
