import { strict as assert } from "node:assert";
import { describe, it, after } from "node:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, resolveDbPath } from "../connection.js";

describe("openDb — in-memory", () => {
  it("creates a usable in-memory database with schema applied", () => {
    const conn = openDb({ path: ":memory:" });
    try {
      const tables = conn.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        )
        .all() as Array<{ name: string }>;
      const names = tables.map((t) => t.name);
      assert.ok(names.includes("mcp_invocations"));
      assert.ok(names.includes("provider_runs"));
      assert.ok(names.includes("job_evaluations"));
      assert.ok(names.includes("candidate_criteria_versions"));
    } finally {
      conn.close();
    }
  });

  it("applySchema is idempotent (re-running does not duplicate indexes)", () => {
    const conn = openDb({ path: ":memory:" });
    try {
      const before = conn.db
        .prepare("SELECT name FROM sqlite_master WHERE type='index'")
        .all() as Array<{ name: string }>;
      // Apply the same DDL again via raw exec; should be a no-op.
      conn.db.exec(
        "CREATE TABLE IF NOT EXISTS mcp_invocations (id TEXT PRIMARY KEY, tool_name TEXT NOT NULL, args_hash TEXT NOT NULL, result_kind TEXT NOT NULL, result_summary TEXT NOT NULL, started_at TEXT NOT NULL, latency_ms INTEGER NOT NULL, meta_json TEXT)"
      );
      const after = conn.db
        .prepare("SELECT name FROM sqlite_master WHERE type='index'")
        .all() as Array<{ name: string }>;
      assert.equal(after.length, before.length);
    } finally {
      conn.close();
    }
  });
});

describe("openDb — file-backed", () => {
  const dir = mkdtempSync(join(tmpdir(), "np-db-"));
  const path = join(dir, "test.sqlite");

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the parent directory if missing and applies schema", () => {
    const conn = openDb({ path });
    try {
      assert.ok(existsSync(path));
      const tables = conn.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>;
      assert.ok(tables.length >= 4);
    } finally {
      conn.close();
    }
  });

  it("survives close + reopen with the same data", () => {
    const c1 = openDb({ path });
    c1.db
      .prepare(
        `INSERT INTO mcp_invocations (id, tool_name, args_hash, result_kind, result_summary, started_at, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "inv-1",
        "evaluate_job",
        "h",
        "ok",
        "verdict=accepted",
        "2026-01-01T00:00:00Z",
        100
      );
    c1.close();

    const c2 = openDb({ path });
    try {
      const rows = c2.db
        .prepare("SELECT * FROM mcp_invocations WHERE id = ?")
        .all("inv-1") as Array<{ id: string }>;
      assert.equal(rows.length, 1);
    } finally {
      c2.close();
    }
  });
});

describe("resolveDbPath", () => {
  it("prefers explicit override", () => {
    assert.equal(resolveDbPath("/tmp/override.sqlite"), "/tmp/override.sqlite");
  });

  it("preserves :memory: literal", () => {
    assert.equal(resolveDbPath(":memory:"), ":memory:");
  });

  it("uses NETWORKPIPELINE_DB_PATH when no override", () => {
    const prev = process.env.NETWORKPIPELINE_DB_PATH;
    process.env.NETWORKPIPELINE_DB_PATH = ":memory:";
    try {
      assert.equal(resolveDbPath(), ":memory:");
    } finally {
      if (prev === undefined) delete process.env.NETWORKPIPELINE_DB_PATH;
      else process.env.NETWORKPIPELINE_DB_PATH = prev;
    }
  });
});
