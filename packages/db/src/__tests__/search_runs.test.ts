import { strict as assert } from "node:assert";
import { describe, it, after } from "node:test";
import { SearchRunsRepository } from "../repositories/search_runs.js";
import type { SearchRunInsert } from "../schema/search_runs.js";
import { makeTestDb } from "./helpers.js";

function baseRun(overrides: Partial<SearchRunInsert> = {}): SearchRunInsert {
  return {
    id: "run-1",
    saved_search_id: "ss-1",
    started_at: "2026-01-01T00:00:00Z",
    completed_at: null,
    status: "in_progress",
    results_found: 0,
    results_pre_filtered: 0,
    results_evaluated: 0,
    results_accepted: 0,
    results_below_threshold: 0,
    results_rejected: 0,
    results_needs_review: 0,
    total_cost_usd_cents: null,
    error_message: null,
    ...overrides
  };
}

describe("SearchRunsRepository — basic CRUD", () => {
  const conn = makeTestDb();
  const repo = new SearchRunsRepository(conn.db);
  after(() => conn.close());

  it("insert + findById round-trips a row", () => {
    repo.insert(baseRun());
    const out = repo.findById("run-1");
    assert.ok(out);
    assert.equal(out!.saved_search_id, "ss-1");
    assert.equal(out!.status, "in_progress");
    assert.equal(out!.results_found, 0);
    assert.equal(out!.completed_at, null);
    assert.equal(out!.total_cost_usd_cents, null);
  });

  it("listBySavedSearch orders by started_at desc", () => {
    repo.insert(
      baseRun({
        id: "run-old",
        started_at: "2026-01-01T00:00:00Z"
      })
    );
    repo.insert(
      baseRun({
        id: "run-new",
        started_at: "2026-01-10T00:00:00Z"
      })
    );
    const rows = repo.listBySavedSearch("ss-1", 10);
    const ids = rows.map((r) => r.id);
    const newIdx = ids.indexOf("run-new");
    const oldIdx = ids.indexOf("run-old");
    assert.ok(newIdx >= 0 && oldIdx >= 0);
    assert.ok(newIdx < oldIdx, "newer run must come first");
  });

  it("listBySavedSearch filters by saved_search_id", () => {
    repo.insert(baseRun({ id: "other-ss", saved_search_id: "ss-other" }));
    const rows = repo.listBySavedSearch("ss-other", 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "other-ss");
  });
});

describe("SearchRunsRepository — updateProgress", () => {
  it("updates only the supplied counter fields", () => {
    const conn = makeTestDb();
    const repo = new SearchRunsRepository(conn.db);
    try {
      repo.insert(
        baseRun({
          id: "run-progress",
          results_found: 0,
          results_pre_filtered: 0,
          results_evaluated: 0
        })
      );
      repo.updateProgress("run-progress", {
        results_found: 100,
        results_pre_filtered: 30
      });
      const out = repo.findById("run-progress");
      assert.equal(out?.results_found, 100);
      assert.equal(out?.results_pre_filtered, 30);
      assert.equal(out?.results_evaluated, 0); // untouched
    } finally {
      conn.close();
    }
  });

  it("can update total_cost_usd_cents incrementally", () => {
    const conn = makeTestDb();
    const repo = new SearchRunsRepository(conn.db);
    try {
      repo.insert(
        baseRun({ id: "run-cost", total_cost_usd_cents: null })
      );
      repo.updateProgress("run-cost", { total_cost_usd_cents: 12.5 });
      const out = repo.findById("run-cost");
      assert.equal(out?.total_cost_usd_cents, 12.5);
    } finally {
      conn.close();
    }
  });

  it("is a no-op when partialCounters is empty", () => {
    const conn = makeTestDb();
    const repo = new SearchRunsRepository(conn.db);
    try {
      repo.insert(baseRun({ id: "run-noop", results_found: 7 }));
      repo.updateProgress("run-noop", {});
      const out = repo.findById("run-noop");
      assert.equal(out?.results_found, 7);
    } finally {
      conn.close();
    }
  });
});

describe("SearchRunsRepository — lifecycle helpers", () => {
  it("markCompleted sets status and completed_at", () => {
    const conn = makeTestDb();
    const repo = new SearchRunsRepository(conn.db);
    try {
      repo.insert(baseRun({ id: "run-done" }));
      repo.markCompleted("run-done", "2026-01-01T00:05:00Z");
      const out = repo.findById("run-done");
      assert.equal(out?.status, "completed");
      assert.equal(out?.completed_at, "2026-01-01T00:05:00Z");
    } finally {
      conn.close();
    }
  });

  it("markFailed populates error_message and completed_at", () => {
    const conn = makeTestDb();
    const repo = new SearchRunsRepository(conn.db);
    try {
      repo.insert(baseRun({ id: "run-fail" }));
      repo.markFailed(
        "run-fail",
        "indeed connector returned 503",
        "2026-01-01T00:05:00Z"
      );
      const out = repo.findById("run-fail");
      assert.equal(out?.status, "failed");
      assert.equal(out?.error_message, "indeed connector returned 503");
      assert.equal(out?.completed_at, "2026-01-01T00:05:00Z");
    } finally {
      conn.close();
    }
  });

  it("markFailed throws when errorMessage is empty", () => {
    const conn = makeTestDb();
    const repo = new SearchRunsRepository(conn.db);
    try {
      repo.insert(baseRun({ id: "run-fail-bad" }));
      assert.throws(() =>
        repo.markFailed("run-fail-bad", "", "2026-01-01T00:05:00Z")
      );
    } finally {
      conn.close();
    }
  });
});

describe("SearchRunsRepository — aggregateCostBySavedSearch", () => {
  it("sums total_cost_usd_cents across runs", () => {
    const conn = makeTestDb();
    const repo = new SearchRunsRepository(conn.db);
    try {
      repo.insert(
        baseRun({ id: "r1", saved_search_id: "ss-cost", total_cost_usd_cents: 10 })
      );
      repo.insert(
        baseRun({
          id: "r2",
          saved_search_id: "ss-cost",
          total_cost_usd_cents: 5.5
        })
      );
      // null cost should be ignored
      repo.insert(
        baseRun({
          id: "r3",
          saved_search_id: "ss-cost",
          total_cost_usd_cents: null
        })
      );
      const total = repo.aggregateCostBySavedSearch("ss-cost");
      assert.equal(total, 15.5);
    } finally {
      conn.close();
    }
  });

  it("returns 0 (not undefined) when no runs exist", () => {
    const conn = makeTestDb();
    const repo = new SearchRunsRepository(conn.db);
    try {
      const total = repo.aggregateCostBySavedSearch("ss-empty");
      assert.equal(total, 0);
    } finally {
      conn.close();
    }
  });
});
