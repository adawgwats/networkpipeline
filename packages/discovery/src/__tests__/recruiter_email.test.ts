import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  recruiterEmailConnector,
  DEFAULT_RECRUITER_QUERY
} from "../connectors/recruiter_email.js";

describe("recruiterEmailConnector", () => {
  it("identifies as 'recruiter_email'", () => {
    const c = recruiterEmailConnector();
    assert.equal(c.id(), "recruiter_email");
    assert.equal(c.kind, "instruction");
  });

  it("emits a Gmail search MCP work item with the user query", () => {
    const c = recruiterEmailConnector();
    const inst = c.discoverInstruction(
      {
        source: "recruiter_email",
        gmail_query: "subject:opportunity newer_than:7d"
      },
      "run-1"
    );
    assert.equal(inst.kind, "ingest_instruction");
    assert.equal(inst.search_run_id, "run-1");
    assert.equal(inst.work_items.length, 1);
    const wi = inst.work_items[0];
    assert.equal(wi.kind, "claude_mcp_tool");
    if (wi.kind !== "claude_mcp_tool") throw new Error("unreachable");
    assert.equal(wi.tool, "mcp__claude_ai_Gmail__search_threads");
    assert.equal(wi.args.query, "subject:opportunity newer_than:7d");
    assert.equal(wi.args.max_threads, 50);
  });

  it("falls back to DEFAULT_RECRUITER_QUERY when gmail_query is empty", () => {
    const c = recruiterEmailConnector();
    const inst = c.discoverInstruction(
      { source: "recruiter_email", gmail_query: "   " },
      "run-1"
    );
    const wi = inst.work_items[0];
    if (wi.kind !== "claude_mcp_tool") throw new Error("unreachable");
    assert.equal(wi.args.query, DEFAULT_RECRUITER_QUERY);
  });

  it("respects custom maxThreads option", () => {
    const c = recruiterEmailConnector({ maxThreads: 10 });
    const inst = c.discoverInstruction(
      { source: "recruiter_email", gmail_query: "x" },
      "run-1"
    );
    const wi = inst.work_items[0];
    if (wi.kind !== "claude_mcp_tool") throw new Error("unreachable");
    assert.equal(wi.args.max_threads, 10);
  });

  it("normalizes valid threads with postings", () => {
    const payload = {
      threads: [
        {
          thread_id: "tid-1",
          from_address: "alice@anthropic.com",
          subject: "Senior Research Engineer role",
          posting: {
            title: "Senior Research Engineer",
            url: "https://anthropic.com/jobs/123",
            company: "Anthropic",
            description: "<p>Eval harnesses.</p>",
            locations: ["San Francisco"],
            employment_type_hint: "Full-time"
          }
        }
      ]
    };
    const c = recruiterEmailConnector();
    const out = c.recordResults(payload);
    assert.equal(out.length, 1);
    const p = out[0];
    assert.equal(p.source, "recruiter_email");
    assert.equal(p.external_ref, "tid-1");
    assert.equal(p.company, "Anthropic");
    assert.equal(p.url, "https://anthropic.com/jobs/123");
    assert.equal(p.title, "Senior Research Engineer");
    assert.equal(p.employment_type, "full_time");
    assert.deepEqual(p.inferred_seniority_signals, ["senior"]);
    assert.equal(p.is_onsite_required, true);
  });

  it("skips threads without a posting (recruiter chatter)", () => {
    const payload = {
      threads: [
        {
          thread_id: "tid-1",
          from_address: "rec@x.com",
          subject: "Just checking in",
          posting: null
        },
        {
          thread_id: "tid-2",
          from_address: "rec@x.com",
          subject: "Position",
          posting: {
            title: "Engineer",
            url: "https://x.com/job/1",
            company: "X"
          }
        }
      ]
    };
    const c = recruiterEmailConnector();
    const out = c.recordResults(payload);
    assert.equal(out.length, 1);
    assert.equal(out[0].external_ref, "tid-2");
  });

  it("falls back to email-from domain when posting.company missing", () => {
    const payload = {
      threads: [
        {
          thread_id: "tid-1",
          from_address: "alice@anthropic.com",
          subject: "Role",
          posting: {
            title: "Engineer",
            url: "https://example.com/j/1"
          }
        }
      ]
    };
    const c = recruiterEmailConnector();
    const out = c.recordResults(payload);
    assert.equal(out.length, 1);
    assert.equal(out[0].company, "Anthropic");
  });

  it("strips careers./jobs./talent. prefixes from from-address fallback", () => {
    const payload = {
      threads: [
        {
          thread_id: "tid-1",
          from_address: "Alice <alice@careers.openai.com>",
          subject: "Role",
          posting: { title: "Eng" }
        }
      ]
    };
    const c = recruiterEmailConnector();
    const out = c.recordResults(payload);
    assert.equal(out[0].company, "Openai");
  });

  it("uses 'Unknown' when neither posting.company nor from_address resolves", () => {
    const payload = {
      threads: [
        {
          thread_id: "tid-1",
          from_address: "garbled-not-an-email",
          subject: "x",
          posting: { title: "Eng" }
        }
      ]
    };
    const c = recruiterEmailConnector();
    const out = c.recordResults(payload);
    assert.equal(out[0].company, "Unknown");
  });

  it("handles multiple threads in one payload", () => {
    const payload = {
      threads: [
        {
          thread_id: "a",
          from_address: "x@y.com",
          subject: "1",
          posting: { title: "A", company: "Y" }
        },
        {
          thread_id: "b",
          from_address: "x@y.com",
          subject: "2",
          posting: null
        },
        {
          thread_id: "c",
          from_address: "x@z.com",
          subject: "3",
          posting: { title: "C", company: "Z" }
        }
      ]
    };
    const c = recruiterEmailConnector();
    const out = c.recordResults(payload);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((p) => p.external_ref), ["a", "c"]);
  });

  it("returns empty array on empty threads", () => {
    const c = recruiterEmailConnector();
    assert.deepEqual(c.recordResults({ threads: [] }), []);
  });

  it("returns empty array on malformed payload", () => {
    const c = recruiterEmailConnector();
    assert.deepEqual(c.recordResults(null), []);
    assert.deepEqual(c.recordResults({ threads: "not-an-array" }), []);
  });
});
