import { strict as assert } from "node:assert";
import { describe, it, after } from "node:test";
import { CandidateCriteriaVersionsRepository } from "../repositories/candidate_criteria_versions.js";
import type { CandidateCriteriaVersionInsert } from "../schema/candidate_criteria_versions.js";
import { makeTestDb } from "./helpers.js";

function baseVersion(
  overrides: Partial<CandidateCriteriaVersionInsert> = {}
): CandidateCriteriaVersionInsert {
  return {
    id: `cv-${overrides.version ?? 1}`,
    version: 1,
    schema_version: "1.0.0",
    yaml_snapshot: "version: 1\nschema_version: \"1.0.0\"",
    change_summary: "initial",
    triggered_by_evaluation_id: null,
    created_at: "2026-01-01T00:00:00Z",
    created_via: "criteria_init",
    ...overrides
  };
}

describe("CandidateCriteriaVersionsRepository — basic ops", () => {
  const conn = makeTestDb();
  const repo = new CandidateCriteriaVersionsRepository(conn.db);
  after(() => conn.close());

  it("inserts and retrieves a row by id", () => {
    repo.insert(baseVersion());
    const out = repo.findById("cv-1");
    assert.ok(out);
    assert.equal(out!.version, 1);
    assert.equal(out!.created_via, "criteria_init");
  });

  it("findByVersion looks up by monotonic integer", () => {
    repo.insert(baseVersion({ id: "cv-2", version: 2, change_summary: "v2" }));
    const out = repo.findByVersion(2);
    assert.equal(out?.id, "cv-2");
  });

  it("latest returns the highest-version row", () => {
    repo.insert(baseVersion({ id: "cv-3", version: 3, change_summary: "v3" }));
    const out = repo.latest();
    assert.equal(out?.version, 3);
  });

  it("maxVersion returns the highest version (or 0 when empty)", () => {
    assert.equal(repo.maxVersion(), 3);
  });

  it("list returns rows in descending version order", () => {
    const rows = repo.list(10);
    const versions = rows.map((r) => r.version);
    const sorted = [...versions].sort((a, b) => b - a);
    assert.deepEqual(versions, sorted);
  });
});

describe("CandidateCriteriaVersionsRepository — uniqueness and upsert", () => {
  it("rejects duplicate version inserts (unique index)", () => {
    const conn = makeTestDb();
    const repo = new CandidateCriteriaVersionsRepository(conn.db);
    try {
      repo.insert(baseVersion());
      assert.throws(() => repo.insert(baseVersion()));
    } finally {
      conn.close();
    }
  });

  it("upsertVersion inserts on first call, no-ops on second", () => {
    const conn = makeTestDb();
    const repo = new CandidateCriteriaVersionsRepository(conn.db);
    try {
      const first = repo.upsertVersion(
        baseVersion({ id: "cv-up", version: 42 })
      );
      assert.equal(first, true);

      const second = repo.upsertVersion(
        baseVersion({ id: "cv-up-conflict", version: 42 })
      );
      assert.equal(second, false);

      // Original row, not the conflicting one, persists.
      const out = repo.findByVersion(42);
      assert.equal(out?.id, "cv-up");
    } finally {
      conn.close();
    }
  });

  it("maxVersion returns 0 when table is empty", () => {
    const conn = makeTestDb();
    const repo = new CandidateCriteriaVersionsRepository(conn.db);
    try {
      assert.equal(repo.maxVersion(), 0);
    } finally {
      conn.close();
    }
  });
});

describe("CandidateCriteriaVersionsRepository — active-learning provenance", () => {
  const conn = makeTestDb();
  const repo = new CandidateCriteriaVersionsRepository(conn.db);
  after(() => conn.close());

  it("persists triggered_by_evaluation_id for active-learning rows", () => {
    repo.insert(
      baseVersion({
        id: "cv-al",
        version: 7,
        triggered_by_evaluation_id: "eval-thumbs-down",
        created_via: "active_learning",
        change_summary:
          "Add Anduril to must_not_have.company per thumbs-down"
      })
    );
    const out = repo.findByVersion(7);
    assert.equal(out?.triggered_by_evaluation_id, "eval-thumbs-down");
    assert.equal(out?.created_via, "active_learning");
  });
});
