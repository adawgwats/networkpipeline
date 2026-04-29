import { strict as assert } from "node:assert";
import { describe, it, after } from "node:test";
import { ProviderRunsRepository } from "../repositories/provider_runs.js";
import type { ProviderRunInsert } from "../schema/provider_runs.js";
import { makeTestDb } from "./helpers.js";

function baseRun(overrides: Partial<ProviderRunInsert> = {}): ProviderRunInsert {
  return {
    id: "run-1",
    provider: "anthropic",
    model: "claude-opus-4-7",
    prompt_id: "extract_job_facts@v1",
    started_at: "2026-01-01T00:00:00Z",
    latency_ms: 1234,
    input_tokens: 400,
    output_tokens: 200,
    cache_creation_tokens: 800,
    cache_read_tokens: 0,
    cost_usd_cents: 1.23,
    stop_reason: "tool_use",
    retries: 0,
    mcp_invocation_id: null,
    job_evaluation_id: null,
    ...overrides
  };
}

describe("ProviderRunsRepository — basic CRUD", () => {
  const conn = makeTestDb();
  const repo = new ProviderRunsRepository(conn.db);
  after(() => conn.close());

  it("inserts and retrieves by id", () => {
    repo.insert(baseRun());
    const out = repo.findById("run-1");
    assert.ok(out);
    assert.equal(out!.provider, "anthropic");
    assert.equal(out!.cache_creation_tokens, 800);
  });

  it("links runs to MCP invocations and job evaluations", () => {
    repo.insert(baseRun({ id: "r-mcp", mcp_invocation_id: "inv-x" }));
    repo.insert(baseRun({ id: "r-eval", job_evaluation_id: "eval-y" }));

    const byMcp = repo.listByMcpInvocation("inv-x");
    const byEval = repo.listByJobEvaluation("eval-y");
    assert.equal(byMcp.length, 1);
    assert.equal(byEval.length, 1);
    assert.equal(byMcp[0].id, "r-mcp");
    assert.equal(byEval[0].id, "r-eval");
  });

  it("filters by prompt_id with most-recent-first ordering", () => {
    repo.insert(
      baseRun({
        id: "r-old",
        prompt_id: "values_check@v1",
        started_at: "2026-01-01T00:00:00Z"
      })
    );
    repo.insert(
      baseRun({
        id: "r-new",
        prompt_id: "values_check@v1",
        started_at: "2026-01-05T00:00:00Z"
      })
    );
    const rows = repo.listByPromptId("values_check@v1", 5);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, "r-new");
  });
});

describe("ProviderRunsRepository — cacheStats", () => {
  const conn = makeTestDb();
  const repo = new ProviderRunsRepository(conn.db);
  after(() => conn.close());

  it("computes cache_hit_ratio and excludes 'skipped' runs", () => {
    // 3 anthropic runs: cache MISS / HIT / HIT
    repo.insert(
      baseRun({
        id: "r1",
        cache_creation_tokens: 800,
        cache_read_tokens: 0,
        input_tokens: 400,
        output_tokens: 200,
        cost_usd_cents: 1.5
      })
    );
    repo.insert(
      baseRun({
        id: "r2",
        cache_creation_tokens: 0,
        cache_read_tokens: 800,
        input_tokens: 400,
        output_tokens: 200,
        cost_usd_cents: 0.3
      })
    );
    repo.insert(
      baseRun({
        id: "r3",
        cache_creation_tokens: 0,
        cache_read_tokens: 800,
        input_tokens: 400,
        output_tokens: 200,
        cost_usd_cents: 0.3
      })
    );
    // 1 skipped run that should NOT pollute cost / cache metrics
    repo.insert(
      baseRun({
        id: "r-skipped",
        provider: "skipped",
        model: "",
        cache_creation_tokens: 999,
        cache_read_tokens: 999,
        input_tokens: 999,
        output_tokens: 999,
        cost_usd_cents: 999
      })
    );

    const stats = repo.cacheStats();
    assert.equal(stats.total_calls, 3);
    assert.equal(stats.total_cache_creation_tokens, 800);
    assert.equal(stats.total_cache_read_tokens, 1600);
    // ratio = 1600 / (1600 + 800) = 2/3
    assert.ok(
      Math.abs((stats.cache_hit_ratio ?? 0) - 2 / 3) < 1e-9,
      `cache_hit_ratio=${stats.cache_hit_ratio}`
    );
    assert.ok(Math.abs(stats.total_cost_usd_cents - 2.1) < 1e-9);
  });

  it("returns null cache_hit_ratio when no cacheable inputs exist", () => {
    const conn2 = makeTestDb();
    const r2 = new ProviderRunsRepository(conn2.db);
    try {
      r2.insert(
        baseRun({
          id: "r-only-input",
          cache_creation_tokens: 0,
          cache_read_tokens: 0,
          input_tokens: 100,
          output_tokens: 100,
          cost_usd_cents: 0.5
        })
      );
      const stats = r2.cacheStats();
      assert.equal(stats.cache_hit_ratio, null);
    } finally {
      conn2.close();
    }
  });

  it("filters by promptId when provided", () => {
    const stats = repo.cacheStats({ promptId: "extract_job_facts@v1" });
    assert.equal(stats.total_calls, 3);
    const otherStats = repo.cacheStats({ promptId: "no_such_prompt" });
    assert.equal(otherStats.total_calls, 0);
  });
});
