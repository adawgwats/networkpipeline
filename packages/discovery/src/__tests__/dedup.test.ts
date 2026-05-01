import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalizeUrl, computePostingInputHash } from "../dedup.js";
import type { NormalizedDiscoveredPosting } from "../connector/types.js";

describe("canonicalizeUrl", () => {
  it("lowercases the host", () => {
    assert.equal(
      canonicalizeUrl("https://Boards.Greenhouse.IO/acme/jobs/1"),
      "https://boards.greenhouse.io/acme/jobs/1"
    );
  });

  it("strips utm_* tracking params", () => {
    assert.equal(
      canonicalizeUrl(
        "https://example.com/job/123?utm_source=indeed&utm_medium=organic"
      ),
      "https://example.com/job/123"
    );
  });

  it("strips other tracking params (fbclid, gclid, ref, source)", () => {
    assert.equal(
      canonicalizeUrl("https://example.com/x?fbclid=abc&gclid=xyz&ref=foo"),
      "https://example.com/x"
    );
    assert.equal(
      canonicalizeUrl("https://example.com/x?source=newsletter"),
      "https://example.com/x"
    );
  });

  it("preserves non-tracking params", () => {
    const out = canonicalizeUrl("https://example.com/x?id=42&utm_source=ind");
    assert.equal(out, "https://example.com/x?id=42");
  });

  it("removes the URL fragment", () => {
    assert.equal(
      canonicalizeUrl("https://example.com/x#about"),
      "https://example.com/x"
    );
  });

  it("removes a trailing slash from the path", () => {
    assert.equal(
      canonicalizeUrl("https://example.com/jobs/"),
      "https://example.com/jobs"
    );
  });

  it("preserves the root '/'", () => {
    assert.equal(canonicalizeUrl("https://example.com/"), "https://example.com/");
  });

  it("returns the input unchanged on parse failure", () => {
    assert.equal(canonicalizeUrl("not a url"), "not a url");
    assert.equal(canonicalizeUrl(""), "");
  });

  it("combines all transforms", () => {
    const input =
      "https://JOBS.lever.co/Acme/abc-123/?utm_source=x&id=7&fbclid=q#apply";
    assert.equal(
      canonicalizeUrl(input),
      "https://jobs.lever.co/Acme/abc-123?id=7"
    );
  });
});

function basePosting(
  overrides: Partial<NormalizedDiscoveredPosting> = {}
): NormalizedDiscoveredPosting {
  return {
    source: "greenhouse",
    external_ref: "x",
    url: "https://example.com/x",
    title: "Software Engineer",
    company: "Acme",
    description_excerpt: "Build cool things.",
    onsite_locations: [],
    is_onsite_required: null,
    employment_type: null,
    inferred_seniority_signals: [],
    inferred_role_kinds: ["engineering"],
    raw_metadata: {},
    ...overrides
  };
}

describe("computePostingInputHash", () => {
  it("produces a stable hash for identical postings", () => {
    const a = computePostingInputHash(basePosting());
    const b = computePostingInputHash(basePosting());
    assert.equal(a, b);
    assert.equal(a.length, 64); // SHA-256 hex
  });

  it("differs when title changes", () => {
    const a = computePostingInputHash(basePosting({ title: "A" }));
    const b = computePostingInputHash(basePosting({ title: "B" }));
    assert.notEqual(a, b);
  });

  it("differs when company changes", () => {
    const a = computePostingInputHash(basePosting({ company: "Acme" }));
    const b = computePostingInputHash(basePosting({ company: "Beta" }));
    assert.notEqual(a, b);
  });

  it("ignores trailing whitespace and case in title/company", () => {
    const a = computePostingInputHash(
      basePosting({ title: "Software Engineer", company: "Acme" })
    );
    const b = computePostingInputHash(
      basePosting({ title: "  software engineer  ", company: "ACME" })
    );
    assert.equal(a, b);
  });

  it("treats null vs empty description_excerpt as equal", () => {
    const a = computePostingInputHash(
      basePosting({ description_excerpt: null })
    );
    const b = computePostingInputHash(
      basePosting({ description_excerpt: "" })
    );
    assert.equal(a, b);
  });
});
