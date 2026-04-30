import { strict as assert } from "node:assert";
import { describe, it, after } from "node:test";
import { SavedSearchesRepository } from "../repositories/saved_searches.js";
import type { SavedSearchInsert } from "../schema/saved_searches.js";
import { makeTestDb } from "./helpers.js";

function baseSearch(
  overrides: Partial<SavedSearchInsert> = {}
): SavedSearchInsert {
  return {
    id: "ss-1",
    label: "Frontier ML eval roles",
    sources_json: JSON.stringify(["indeed", "greenhouse"]),
    queries_json: JSON.stringify([
      { source: "indeed", query: "ml evaluation engineer", location: "Remote" },
      { source: "greenhouse", query: "evaluations engineer" }
    ]),
    criteria_overlay_path: null,
    cadence: "on_demand",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    last_run_at: null,
    ...overrides
  };
}

describe("SavedSearchesRepository — basic CRUD", () => {
  const conn = makeTestDb();
  const repo = new SavedSearchesRepository(conn.db);
  after(() => conn.close());

  it("insert + findById round-trips a row", () => {
    repo.insert(baseSearch());
    const out = repo.findById("ss-1");
    assert.ok(out);
    assert.equal(out!.label, "Frontier ML eval roles");
    assert.equal(out!.cadence, "on_demand");
    assert.equal(out!.last_run_at, null);
    // JSON round-trip preserved
    const sources = JSON.parse(out!.sources_json) as string[];
    assert.deepEqual(sources, ["indeed", "greenhouse"]);
  });

  it("preserves criteria_overlay_path when set", () => {
    repo.insert(
      baseSearch({
        id: "ss-overlay",
        label: "Overlay search",
        criteria_overlay_path: "overlays/ml_eval.yaml"
      })
    );
    const out = repo.findById("ss-overlay");
    assert.equal(out?.criteria_overlay_path, "overlays/ml_eval.yaml");
  });

  it("findByLabel returns the matching row", () => {
    const out = repo.findByLabel("Frontier ML eval roles");
    assert.equal(out?.id, "ss-1");
  });

  it("findByLabel returns undefined for unknown label", () => {
    assert.equal(repo.findByLabel("nope"), undefined);
  });

  it("deleteById removes a row", () => {
    repo.insert(baseSearch({ id: "ss-del", label: "to delete" }));
    assert.ok(repo.findById("ss-del"));
    repo.deleteById("ss-del");
    assert.equal(repo.findById("ss-del"), undefined);
  });
});

describe("SavedSearchesRepository — list ordering (NULLS LAST)", () => {
  const conn = makeTestDb();
  const repo = new SavedSearchesRepository(conn.db);
  after(() => conn.close());

  it("orders by last_run_at desc with NULLs at the end", () => {
    repo.insert(
      baseSearch({
        id: "never-run",
        label: "Never run",
        created_at: "2026-01-10T00:00:00Z",
        updated_at: "2026-01-10T00:00:00Z",
        last_run_at: null
      })
    );
    repo.insert(
      baseSearch({
        id: "ran-old",
        label: "Ran old",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        last_run_at: "2026-01-02T00:00:00Z"
      })
    );
    repo.insert(
      baseSearch({
        id: "ran-new",
        label: "Ran new",
        created_at: "2026-01-05T00:00:00Z",
        updated_at: "2026-01-05T00:00:00Z",
        last_run_at: "2026-01-15T00:00:00Z"
      })
    );

    const rows = repo.list(10);
    const ids = rows.map((r) => r.id);
    const newIdx = ids.indexOf("ran-new");
    const oldIdx = ids.indexOf("ran-old");
    const nullIdx = ids.indexOf("never-run");

    assert.ok(newIdx < oldIdx, "ran-new should come before ran-old");
    assert.ok(oldIdx < nullIdx, "non-null last_run_at should come before NULL");
  });

  it("falls back to created_at desc when both rows have null last_run_at", () => {
    const conn2 = makeTestDb();
    const repo2 = new SavedSearchesRepository(conn2.db);
    try {
      repo2.insert(
        baseSearch({
          id: "older",
          label: "older",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          last_run_at: null
        })
      );
      repo2.insert(
        baseSearch({
          id: "newer",
          label: "newer",
          created_at: "2026-01-10T00:00:00Z",
          updated_at: "2026-01-10T00:00:00Z",
          last_run_at: null
        })
      );
      const rows = repo2.list(10);
      assert.equal(rows[0].id, "newer");
      assert.equal(rows[1].id, "older");
    } finally {
      conn2.close();
    }
  });
});

describe("SavedSearchesRepository — updateLastRunAt", () => {
  it("bumps last_run_at and updated_at", () => {
    const conn = makeTestDb();
    const repo = new SavedSearchesRepository(conn.db);
    try {
      repo.insert(
        baseSearch({
          id: "ss-bump",
          label: "to bump",
          last_run_at: null,
          updated_at: "2026-01-01T00:00:00Z"
        })
      );
      repo.updateLastRunAt("ss-bump", "2026-02-01T12:00:00Z");
      const out = repo.findById("ss-bump");
      assert.equal(out?.last_run_at, "2026-02-01T12:00:00Z");
      assert.equal(out?.updated_at, "2026-02-01T12:00:00Z");
    } finally {
      conn.close();
    }
  });

  it("re-listing after updateLastRunAt reflects the new ordering", () => {
    const conn = makeTestDb();
    const repo = new SavedSearchesRepository(conn.db);
    try {
      repo.insert(
        baseSearch({
          id: "ss-a",
          label: "a",
          last_run_at: "2026-01-01T00:00:00Z",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z"
        })
      );
      repo.insert(
        baseSearch({
          id: "ss-b",
          label: "b",
          last_run_at: "2026-01-02T00:00:00Z",
          created_at: "2026-01-02T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z"
        })
      );
      // ss-a now becomes the most recent
      repo.updateLastRunAt("ss-a", "2026-03-01T00:00:00Z");
      const rows = repo.list(10);
      assert.equal(rows[0].id, "ss-a");
      assert.equal(rows[1].id, "ss-b");
    } finally {
      conn.close();
    }
  });
});
