import { strict as assert } from "node:assert";
import { describe, it, after } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildInvocationRecord,
  InMemorySink,
  JsonlFileSink,
  resolveLogPath
} from "../observability.js";

describe("buildInvocationRecord", () => {
  it("builds an ok record with verdict summary", () => {
    const rec = buildInvocationRecord({
      id: "inv-1",
      toolName: "evaluate_job",
      argsHash: "abc",
      startedAt: new Date(0),
      finishedAt: new Date(150),
      outcome: { ok: true, output: { verdict: "accepted" } }
    });
    assert.equal(rec.result_kind, "ok");
    assert.equal(rec.result_summary, "verdict=accepted");
    assert.equal(rec.latency_ms, 150);
    assert.equal(rec.tool_name, "evaluate_job");
  });

  it("builds a validation_error record summarizing issue count", () => {
    const rec = buildInvocationRecord({
      id: "inv-2",
      toolName: "evaluate_job",
      argsHash: "abc",
      startedAt: new Date(0),
      finishedAt: new Date(5),
      outcome: {
        ok: false,
        error: {
          kind: "validation_error",
          tool: "evaluate_job",
          issues: [{ path: ["text"], message: "required" }]
        }
      }
    });
    assert.equal(rec.result_kind, "validation_error");
    assert.match(rec.result_summary, /1 issue/);
  });

  it("builds an unknown_tool record", () => {
    const rec = buildInvocationRecord({
      id: "inv-3",
      toolName: "ghost",
      argsHash: "abc",
      startedAt: new Date(0),
      finishedAt: new Date(1),
      outcome: {
        ok: false,
        error: { kind: "unknown_tool", tool: "ghost" }
      }
    });
    assert.equal(rec.result_kind, "unknown_tool");
    assert.equal(rec.result_summary, "unknown tool");
  });

  it("builds a handler_error record with truncated message", () => {
    const long = "x".repeat(500);
    const rec = buildInvocationRecord({
      id: "inv-4",
      toolName: "evaluate_job",
      argsHash: "abc",
      startedAt: new Date(0),
      finishedAt: new Date(1),
      outcome: {
        ok: false,
        error: {
          kind: "handler_error",
          tool: "evaluate_job",
          message: long
        }
      }
    });
    assert.equal(rec.result_kind, "handler_error");
    assert.ok(rec.result_summary.length <= 200);
  });
});

describe("resolveLogPath", () => {
  it("prefers explicit override", () => {
    const p = resolveLogPath("/tmp/np-log.jsonl");
    assert.ok(p.endsWith("np-log.jsonl"));
  });

  it("uses NETWORKPIPELINE_LOG_PATH when set and no override", () => {
    const prev = process.env.NETWORKPIPELINE_LOG_PATH;
    process.env.NETWORKPIPELINE_LOG_PATH = "/tmp/np-from-env.jsonl";
    try {
      const p = resolveLogPath();
      assert.ok(p.endsWith("np-from-env.jsonl"));
    } finally {
      if (prev === undefined) delete process.env.NETWORKPIPELINE_LOG_PATH;
      else process.env.NETWORKPIPELINE_LOG_PATH = prev;
    }
  });
});

describe("InMemorySink", () => {
  it("accumulates records in invocation order", () => {
    const sink = new InMemorySink();
    sink.record({
      id: "1",
      tool_name: "x",
      args_hash: "h",
      result_kind: "ok",
      result_summary: "ok",
      started_at: new Date(0).toISOString(),
      latency_ms: 0
    });
    sink.record({
      id: "2",
      tool_name: "y",
      args_hash: "h",
      result_kind: "validation_error",
      result_summary: "1 issue",
      started_at: new Date(0).toISOString(),
      latency_ms: 0
    });
    assert.equal(sink.invocations.length, 2);
    assert.equal(sink.invocations[0].id, "1");
    assert.equal(sink.invocations[1].id, "2");
  });
});

describe("JsonlFileSink", () => {
  const dir = mkdtempSync(join(tmpdir(), "np-mcp-obs-"));
  const path = join(dir, "log.jsonl");

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends one JSON line per record", () => {
    const sink = new JsonlFileSink(path);
    sink.record({
      id: "1",
      tool_name: "evaluate_job",
      args_hash: "h",
      result_kind: "ok",
      result_summary: "verdict=accepted",
      started_at: new Date(0).toISOString(),
      latency_ms: 42
    });
    sink.record({
      id: "2",
      tool_name: "evaluate_job",
      args_hash: "h",
      result_kind: "validation_error",
      result_summary: "1 issue",
      started_at: new Date(0).toISOString(),
      latency_ms: 1
    });

    const content = readFileSync(path, "utf-8");
    const lines = content.trim().split("\n");
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    assert.equal(first.id, "1");
    assert.equal(first.result_kind, "ok");
    assert.equal(first.latency_ms, 42);
  });
});
