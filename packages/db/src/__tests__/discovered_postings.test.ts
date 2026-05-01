import { strict as assert } from "node:assert";
import { describe, it, after } from "node:test";
import { DiscoveredPostingsRepository } from "../repositories/discovered_postings.js";
import type { DiscoveredPostingInsert } from "../schema/discovered_postings.js";
import { makeTestDb } from "./helpers.js";

function basePosting(
  overrides: Partial<DiscoveredPostingInsert> = {}
): DiscoveredPostingInsert {
  return {
    id: "dp-1",
    saved_search_id: "ss-1",
    search_run_id: "run-1",
    source: "indeed",
    external_ref: "indeed-job-123",
    url: "https://indeed.com/jobs/123",
    title: "ML Evaluations Engineer",
    company: "Acme",
    raw_metadata_json: JSON.stringify({ raw: true, salary: "$$$" }),
    status: "queued",
    pre_filter_reason_code: null,
    job_evaluation_id: null,
    cached_job_evaluation_id: null,
    input_hash: null,
    discovered_at: "2026-01-01T00:00:00Z",
    last_seen_at: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

describe("DiscoveredPostingsRepository — basic CRUD", () => {
  const conn = makeTestDb();
  const repo = new DiscoveredPostingsRepository(conn.db);
  after(() => conn.close());

  it("insert + findById round-trips a row", () => {
    repo.insert(basePosting());
    const out = repo.findById("dp-1");
    assert.ok(out);
    assert.equal(out!.source, "indeed");
    assert.equal(out!.title, "ML Evaluations Engineer");
    assert.equal(out!.status, "queued");
    const meta = JSON.parse(out!.raw_metadata_json) as { raw: boolean };
    assert.equal(meta.raw, true);
  });

  it("findById returns undefined for missing id", () => {
    assert.equal(repo.findById("nope"), undefined);
  });
});

describe("DiscoveredPostingsRepository — dedup lookups", () => {
  const conn = makeTestDb();
  const repo = new DiscoveredPostingsRepository(conn.db);
  after(() => conn.close());

  it("findByExternalRef returns the row for matching (source, external_ref)", () => {
    repo.insert(
      basePosting({
        id: "dp-ext-1",
        source: "indeed",
        external_ref: "indeed-job-A"
      })
    );
    const out = repo.findByExternalRef("indeed", "indeed-job-A");
    assert.equal(out?.id, "dp-ext-1");
  });

  it("findByExternalRef distinguishes by source for the same external_ref string", () => {
    // Same external_ref string under two different sources.
    repo.insert(
      basePosting({
        id: "dp-collide-indeed",
        source: "indeed",
        external_ref: "shared-id-42",
        url: "https://indeed.com/x"
      })
    );
    repo.insert(
      basePosting({
        id: "dp-collide-greenhouse",
        source: "greenhouse",
        external_ref: "shared-id-42",
        url: "https://boards.greenhouse.io/x"
      })
    );
    const a = repo.findByExternalRef("indeed", "shared-id-42");
    const b = repo.findByExternalRef("greenhouse", "shared-id-42");
    assert.equal(a?.id, "dp-collide-indeed");
    assert.equal(b?.id, "dp-collide-greenhouse");
  });

  it("findByExternalRef returns undefined for unknown ref", () => {
    assert.equal(repo.findByExternalRef("indeed", "missing"), undefined);
  });

  it("findByUrl returns the row for matching url", () => {
    repo.insert(
      basePosting({
        id: "dp-url",
        url: "https://example.com/jobs/cool-role"
      })
    );
    const out = repo.findByUrl("https://example.com/jobs/cool-role");
    assert.equal(out?.id, "dp-url");
  });

  it("findByUrl returns undefined for unknown url", () => {
    assert.equal(repo.findByUrl("https://nowhere"), undefined);
  });
});

describe("DiscoveredPostingsRepository — listings", () => {
  const conn = makeTestDb();
  const repo = new DiscoveredPostingsRepository(conn.db);
  after(() => conn.close());

  it("listBySearchRun filters by run and orders newest first", () => {
    repo.insert(
      basePosting({
        id: "dp-run-old",
        search_run_id: "run-A",
        external_ref: "a-old",
        discovered_at: "2026-01-01T00:00:00Z"
      })
    );
    repo.insert(
      basePosting({
        id: "dp-run-new",
        search_run_id: "run-A",
        external_ref: "a-new",
        discovered_at: "2026-01-05T00:00:00Z"
      })
    );
    repo.insert(
      basePosting({
        id: "dp-other-run",
        search_run_id: "run-B",
        external_ref: "b-1"
      })
    );
    const rows = repo.listBySearchRun("run-A");
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, "dp-run-new");
    assert.equal(rows[1].id, "dp-run-old");
  });

  it("listBySavedSearch filters by saved_search_id", () => {
    repo.insert(
      basePosting({
        id: "dp-ss-other",
        saved_search_id: "ss-other",
        external_ref: "ss-other-1"
      })
    );
    const rows = repo.listBySavedSearch("ss-other", 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "dp-ss-other");
  });

  it("listByStatus filters by status and orders newest first", () => {
    repo.insert(
      basePosting({
        id: "dp-stale-old",
        external_ref: "stale-old",
        status: "stale",
        discovered_at: "2026-01-01T00:00:00Z"
      })
    );
    repo.insert(
      basePosting({
        id: "dp-stale-new",
        external_ref: "stale-new",
        status: "stale",
        discovered_at: "2026-01-10T00:00:00Z"
      })
    );
    const rows = repo.listByStatus("stale", 10);
    const ids = rows.map((r) => r.id);
    const newIdx = ids.indexOf("dp-stale-new");
    const oldIdx = ids.indexOf("dp-stale-old");
    assert.ok(newIdx < oldIdx, "newer should come first");
  });
});

describe("DiscoveredPostingsRepository — updateStatus invariants", () => {
  it("transitions to evaluated with a job_evaluation_id", () => {
    const conn = makeTestDb();
    const repo = new DiscoveredPostingsRepository(conn.db);
    try {
      repo.insert(basePosting({ id: "dp-eval" }));
      repo.updateStatus("dp-eval", "evaluated", {
        jobEvaluationId: "eval-xyz"
      });
      const out = repo.findById("dp-eval");
      assert.equal(out?.status, "evaluated");
      assert.equal(out?.job_evaluation_id, "eval-xyz");
    } finally {
      conn.close();
    }
  });

  it("throws when transitioning to evaluated without jobEvaluationId", () => {
    const conn = makeTestDb();
    const repo = new DiscoveredPostingsRepository(conn.db);
    try {
      repo.insert(basePosting({ id: "dp-eval-bad" }));
      assert.throws(() => repo.updateStatus("dp-eval-bad", "evaluated"));
    } finally {
      conn.close();
    }
  });

  it("transitions to pre_filter_rejected with a reason_code", () => {
    const conn = makeTestDb();
    const repo = new DiscoveredPostingsRepository(conn.db);
    try {
      repo.insert(basePosting({ id: "dp-pf" }));
      repo.updateStatus("dp-pf", "pre_filter_rejected", {
        preFilterReasonCode: "metadata:company:anduril"
      });
      const out = repo.findById("dp-pf");
      assert.equal(out?.status, "pre_filter_rejected");
      assert.equal(out?.pre_filter_reason_code, "metadata:company:anduril");
    } finally {
      conn.close();
    }
  });

  it("throws when transitioning to pre_filter_rejected without reason code", () => {
    const conn = makeTestDb();
    const repo = new DiscoveredPostingsRepository(conn.db);
    try {
      repo.insert(basePosting({ id: "dp-pf-bad" }));
      assert.throws(() =>
        repo.updateStatus("dp-pf-bad", "pre_filter_rejected")
      );
    } finally {
      conn.close();
    }
  });

  it("transitions to duplicate / stale without requiring opts", () => {
    const conn = makeTestDb();
    const repo = new DiscoveredPostingsRepository(conn.db);
    try {
      repo.insert(basePosting({ id: "dp-dup" }));
      repo.updateStatus("dp-dup", "duplicate");
      assert.equal(repo.findById("dp-dup")?.status, "duplicate");

      repo.insert(basePosting({ id: "dp-stale", external_ref: "stale-2" }));
      repo.updateStatus("dp-stale", "stale");
      assert.equal(repo.findById("dp-stale")?.status, "stale");
    } finally {
      conn.close();
    }
  });
});

describe("DiscoveredPostingsRepository — touchLastSeen", () => {
  it("bumps last_seen_at without changing other columns", () => {
    const conn = makeTestDb();
    const repo = new DiscoveredPostingsRepository(conn.db);
    try {
      repo.insert(
        basePosting({
          id: "dp-touch",
          discovered_at: "2026-01-01T00:00:00Z",
          last_seen_at: "2026-01-01T00:00:00Z",
          status: "queued"
        })
      );
      repo.touchLastSeen("dp-touch", "2026-02-01T00:00:00Z");
      const out = repo.findById("dp-touch");
      assert.equal(out?.last_seen_at, "2026-02-01T00:00:00Z");
      // Other columns untouched.
      assert.equal(out?.discovered_at, "2026-01-01T00:00:00Z");
      assert.equal(out?.status, "queued");
    } finally {
      conn.close();
    }
  });
});

describe("DiscoveredPostingsRepository — countByStatusForRun", () => {
  it("returns counts zero-filled for every status", () => {
    const conn = makeTestDb();
    const repo = new DiscoveredPostingsRepository(conn.db);
    try {
      const counts = repo.countByStatusForRun("empty-run");
      assert.deepEqual(counts, {
        queued: 0,
        pre_filter_rejected: 0,
        evaluated: 0,
        duplicate: 0,
        stale: 0
      });
    } finally {
      conn.close();
    }
  });

  it("counts each status correctly for a run", () => {
    const conn = makeTestDb();
    const repo = new DiscoveredPostingsRepository(conn.db);
    try {
      // Two queued, one evaluated, one pre_filter_rejected, one duplicate.
      repo.insert(
        basePosting({
          id: "c1",
          search_run_id: "run-counts",
          external_ref: "c1",
          status: "queued"
        })
      );
      repo.insert(
        basePosting({
          id: "c2",
          search_run_id: "run-counts",
          external_ref: "c2",
          status: "queued"
        })
      );
      repo.insert(
        basePosting({
          id: "c3",
          search_run_id: "run-counts",
          external_ref: "c3",
          status: "evaluated",
          job_evaluation_id: "eval-c3"
        })
      );
      repo.insert(
        basePosting({
          id: "c4",
          search_run_id: "run-counts",
          external_ref: "c4",
          status: "pre_filter_rejected",
          pre_filter_reason_code: "metadata:company"
        })
      );
      repo.insert(
        basePosting({
          id: "c5",
          search_run_id: "run-counts",
          external_ref: "c5",
          status: "duplicate"
        })
      );
      // Different run — should not be counted.
      repo.insert(
        basePosting({
          id: "c6",
          search_run_id: "other-run",
          external_ref: "c6",
          status: "queued"
        })
      );

      const counts = repo.countByStatusForRun("run-counts");
      assert.equal(counts.queued, 2);
      assert.equal(counts.evaluated, 1);
      assert.equal(counts.pre_filter_rejected, 1);
      assert.equal(counts.duplicate, 1);
      assert.equal(counts.stale, 0);
    } finally {
      conn.close();
    }
  });
});
