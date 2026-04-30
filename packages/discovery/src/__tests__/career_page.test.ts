import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { careerPageConnector } from "../connectors/career_page.js";

describe("careerPageConnector", () => {
  it("identifies as 'career_page'", () => {
    const c = careerPageConnector();
    assert.equal(c.id(), "career_page");
    assert.equal(c.kind, "instruction");
  });

  it("emits a single web_fetch work item", () => {
    const c = careerPageConnector();
    const inst = c.discoverInstruction(
      { source: "career_page", url: "https://anthropic.com/careers" },
      "run-1"
    );
    assert.equal(inst.kind, "ingest_instruction");
    assert.equal(inst.source, "career_page");
    assert.equal(inst.search_run_id, "run-1");
    assert.equal(inst.work_items.length, 1);
    const wi = inst.work_items[0];
    assert.equal(wi.kind, "web_fetch");
    if (wi.kind !== "web_fetch") throw new Error("unreachable");
    assert.equal(wi.url, "https://anthropic.com/careers");
  });

  it("throws when query.source is wrong", () => {
    const c = careerPageConnector();
    assert.throws(() => {
      c.discoverInstruction(
        { source: "lever", company_slug: "acme" },
        "run-1"
      );
    }, /expected query\.source/);
  });

  it("normalizes Anthropic-style payload with explicit company", () => {
    const payload = {
      postings: [
        {
          title: "Senior Research Engineer",
          url: "https://www.anthropic.com/jobs/research-engineer",
          company: "Anthropic",
          description: "<p>Build evaluation harnesses.</p>",
          locations: "San Francisco",
          employment_type_hint: "Full-time"
        }
      ]
    };
    const c = careerPageConnector();
    const out = c.recordResults(payload);
    assert.equal(out.length, 1);
    const p = out[0];
    assert.equal(p.source, "career_page");
    assert.equal(p.external_ref, null);
    assert.equal(p.company, "Anthropic");
    assert.equal(p.url, "https://www.anthropic.com/jobs/research-engineer");
    assert.equal(p.title, "Senior Research Engineer");
    assert.deepEqual(p.onsite_locations, ["San Francisco"]);
    assert.equal(p.is_onsite_required, true);
    assert.equal(p.employment_type, "full_time");
    assert.deepEqual(p.inferred_seniority_signals, ["senior"]);
    assert.equal(p.description_excerpt, "Build evaluation harnesses.");
  });

  it("normalizes a Greenhouse-embed-style payload (just title + url)", () => {
    const payload = {
      postings: [
        {
          title: "Staff Software Engineer",
          url: "https://boards.greenhouse.io/acme/jobs/123",
          company: "Acme"
        }
      ]
    };
    const c = careerPageConnector();
    const out = c.recordResults(payload);
    assert.equal(out.length, 1);
    assert.equal(out[0].company, "Acme");
    assert.deepEqual(out[0].inferred_seniority_signals, ["staff"]);
    assert.equal(out[0].description_excerpt, null);
    assert.equal(out[0].is_onsite_required, null);
  });

  it("falls back to URL host when company is missing", () => {
    const payload = {
      postings: [
        {
          title: "Engineer",
          url: "https://anthropic.com/careers/engineer-123"
        }
      ]
    };
    const c = careerPageConnector();
    const out = c.recordResults(payload);
    assert.equal(out.length, 1);
    assert.equal(out[0].company, "Anthropic");
  });

  it("strips careers.* and jobs.* subdomains in URL fallback", () => {
    const payload = {
      postings: [
        { title: "Eng", url: "https://careers.openai.com/role/x" },
        { title: "Eng", url: "https://jobs.netflix.com/positions/y" }
      ]
    };
    const c = careerPageConnector();
    const out = c.recordResults(payload);
    assert.equal(out[0].company, "Openai");
    assert.equal(out[1].company, "Netflix");
  });

  it("uses defaultCompany option when posting lacks company", () => {
    const c = careerPageConnector({ defaultCompany: "FallbackCo" });
    const out = c.recordResults({
      postings: [{ title: "Eng", url: "https://example.com/x" }]
    });
    assert.equal(out[0].company, "FallbackCo");
  });

  it("returns empty array on malformed payload (postings not array)", () => {
    const c = careerPageConnector();
    assert.deepEqual(c.recordResults(null), []);
    assert.deepEqual(c.recordResults({}), []);
    assert.deepEqual(c.recordResults({ postings: "nope" }), []);
    assert.deepEqual(c.recordResults({ postings: [{ no_title: true }] }), []);
  });

  it("returns empty array on empty postings", () => {
    const c = careerPageConnector();
    assert.deepEqual(c.recordResults({ postings: [] }), []);
  });

  it("treats fully-remote as is_onsite_required=false", () => {
    const payload = {
      postings: [
        {
          title: "SWE",
          url: "https://example.com/r",
          company: "Example",
          locations: ["Remote"]
        }
      ]
    };
    const c = careerPageConnector();
    const out = c.recordResults(payload);
    assert.equal(out[0].is_onsite_required, false);
    assert.deepEqual(out[0].onsite_locations, []);
  });

  it("accepts both string and array for locations", () => {
    const c = careerPageConnector();
    const stringLoc = c.recordResults({
      postings: [
        {
          title: "SWE",
          url: "https://example.com/a",
          company: "Co",
          locations: "New York, NY"
        }
      ]
    });
    assert.deepEqual(stringLoc[0].onsite_locations, ["New York, NY"]);

    const arrayLoc = c.recordResults({
      postings: [
        {
          title: "SWE",
          url: "https://example.com/b",
          company: "Co",
          locations: ["NYC", "Austin", "Remote"]
        }
      ]
    });
    assert.equal(arrayLoc[0].is_onsite_required, false);
    assert.deepEqual(arrayLoc[0].onsite_locations, ["NYC", "Austin"]);
  });
});
