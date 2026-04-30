import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { indeedConnector } from "../connectors/indeed.js";

describe("indeedConnector", () => {
  it("identifies as 'indeed'", () => {
    const c = indeedConnector();
    assert.equal(c.id(), "indeed");
    assert.equal(c.kind, "instruction");
  });

  it("emits a single MCP tool work item", () => {
    const c = indeedConnector();
    const inst = c.discoverInstruction(
      { source: "indeed", query: "ML engineer", location: "Remote" },
      "run-1"
    );
    assert.equal(inst.kind, "ingest_instruction");
    assert.equal(inst.source, "indeed");
    assert.equal(inst.search_run_id, "run-1");
    assert.equal(inst.work_items.length, 1);
    const wi = inst.work_items[0];
    assert.equal(wi.kind, "claude_mcp_tool");
    if (wi.kind !== "claude_mcp_tool") throw new Error("unreachable");
    assert.equal(wi.tool, "mcp__claude_ai_Indeed__search_jobs");
    assert.equal(wi.args.query, "ML engineer");
    assert.equal(wi.args.location, "Remote");
    assert.equal(wi.args.limit, 25);
  });

  it("omits location arg when not provided", () => {
    const c = indeedConnector();
    const inst = c.discoverInstruction(
      { source: "indeed", query: "ML engineer" },
      "run-1"
    );
    const wi = inst.work_items[0];
    if (wi.kind !== "claude_mcp_tool") throw new Error("unreachable");
    assert.equal("location" in wi.args, false);
  });

  it("respects custom limit", () => {
    const c = indeedConnector({ limit: 50 });
    const inst = c.discoverInstruction(
      { source: "indeed", query: "x" },
      "run-1"
    );
    const wi = inst.work_items[0];
    if (wi.kind !== "claude_mcp_tool") throw new Error("unreachable");
    assert.equal(wi.args.limit, 50);
  });

  it("throws when query.source is wrong", () => {
    const c = indeedConnector();
    assert.throws(() => {
      c.discoverInstruction(
        { source: "lever", company_slug: "acme" },
        "run-1"
      );
    }, /expected query\.source/);
  });

  it("normalizes a typical Indeed response payload", () => {
    const payload = {
      jobs: [
        {
          job_id: "abc123",
          title: "Senior Software Engineer",
          company_name: "Acme Corp",
          location: "San Francisco, CA",
          snippet: "Full-time role building distributed systems.",
          salary: "$200k-$250k",
          formatted_relative_time: "3 days ago",
          url: "https://www.indeed.com/viewjob?jk=abc123"
        },
        {
          job_id: "def456",
          title: "Staff or Principal Engineer",
          company_name: "Beta LLC",
          location: "Remote",
          snippet: "Contract role.",
          url: "https://www.indeed.com/viewjob?jk=def456"
        }
      ]
    };
    const c = indeedConnector();
    const out = c.recordResults(payload);
    assert.equal(out.length, 2);

    const a = out[0];
    assert.equal(a.source, "indeed");
    assert.equal(a.external_ref, "abc123");
    assert.equal(a.url, "https://www.indeed.com/viewjob?jk=abc123");
    assert.equal(a.title, "Senior Software Engineer");
    assert.equal(a.company, "Acme Corp");
    assert.deepEqual(a.onsite_locations, ["San Francisco, CA"]);
    assert.equal(a.is_onsite_required, true);
    assert.equal(a.employment_type, "full_time");
    assert.deepEqual(a.inferred_seniority_signals, ["senior"]);

    const b = out[1];
    assert.equal(b.is_onsite_required, false);
    assert.deepEqual(b.onsite_locations, []);
    assert.equal(b.employment_type, "contract");
    assert.deepEqual(
      b.inferred_seniority_signals.sort(),
      ["principal", "staff"].sort()
    );
  });

  it("handles missing optional fields", () => {
    const payload = {
      jobs: [
        {
          job_id: "x",
          title: "Software Engineer",
          company_name: "Co",
          url: "https://example.com/j/x"
        }
      ]
    };
    const c = indeedConnector();
    const out = c.recordResults(payload);
    assert.equal(out.length, 1);
    const p = out[0];
    assert.equal(p.description_excerpt, null);
    assert.deepEqual(p.onsite_locations, []);
    assert.equal(p.is_onsite_required, null);
    assert.equal(p.employment_type, null);
    assert.deepEqual(p.inferred_seniority_signals, []);
  });

  it("returns empty array on malformed payload", () => {
    const c = indeedConnector();
    assert.deepEqual(c.recordResults(null), []);
    assert.deepEqual(c.recordResults({}), []);
    assert.deepEqual(c.recordResults({ jobs: "not-an-array" }), []);
    assert.deepEqual(c.recordResults({ jobs: [{ no_id: true }] }), []);
  });

  it("preserves raw_metadata verbatim", () => {
    const payload = {
      jobs: [
        {
          job_id: "x",
          title: "Engineer",
          company_name: "Co",
          url: "https://example.com/j/x",
          location: "NYC",
          snippet: "snip"
        }
      ]
    };
    const c = indeedConnector();
    const out = c.recordResults(payload);
    assert.equal(out[0].raw_metadata.job_id, "x");
    assert.equal(out[0].raw_metadata.snippet, "snip");
  });
});
