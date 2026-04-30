import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalizeUrl } from "../dedup.js";

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
