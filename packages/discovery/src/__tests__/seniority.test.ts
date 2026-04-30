import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inferSeniorityFromTitle } from "../connector/seniority.js";

describe("inferSeniorityFromTitle", () => {
  it("returns empty array for non-matching title", () => {
    assert.deepEqual(inferSeniorityFromTitle("Software Engineer"), []);
    assert.deepEqual(inferSeniorityFromTitle(""), []);
  });

  it("matches each band", () => {
    assert.deepEqual(inferSeniorityFromTitle("Intern, Software"), ["intern"]);
    assert.deepEqual(inferSeniorityFromTitle("New Grad Engineer"), ["new_grad"]);
    assert.deepEqual(
      inferSeniorityFromTitle("Entry-level Engineer"),
      ["new_grad"]
    );
    assert.deepEqual(inferSeniorityFromTitle("Junior Engineer"), ["junior"]);
    assert.deepEqual(inferSeniorityFromTitle("Jr. Engineer"), ["junior"]);
    assert.deepEqual(inferSeniorityFromTitle("Mid-level Engineer"), ["mid"]);
    assert.deepEqual(inferSeniorityFromTitle("Senior Engineer"), ["senior"]);
    assert.deepEqual(inferSeniorityFromTitle("Sr. Engineer"), ["senior"]);
    assert.deepEqual(inferSeniorityFromTitle("Staff Engineer"), ["staff"]);
    assert.deepEqual(
      inferSeniorityFromTitle("Principal Engineer"),
      ["principal"]
    );
    assert.deepEqual(inferSeniorityFromTitle("Director of Engineering"), [
      "director"
    ]);
    assert.deepEqual(inferSeniorityFromTitle("VP, Engineering"), ["vp"]);
    assert.deepEqual(
      inferSeniorityFromTitle("Vice President of Engineering"),
      ["vp"]
    );
  });

  it("returns multiple matches for ambiguous titles", () => {
    const result = inferSeniorityFromTitle("Senior or Staff Software Engineer");
    assert.deepEqual(result.sort(), ["senior", "staff"].sort());
  });

  it("is case insensitive", () => {
    assert.deepEqual(inferSeniorityFromTitle("SENIOR ENGINEER"), ["senior"]);
    assert.deepEqual(inferSeniorityFromTitle("staff engineer"), ["staff"]);
  });

  it("does not match substrings (e.g. 'visa' should not match 'vp')", () => {
    assert.deepEqual(inferSeniorityFromTitle("Visa Compliance Engineer"), []);
  });

  it("does not match 'lead' as a band (out of canonical enum)", () => {
    // 'lead' is intentionally NOT in the SeniorityBand enum
    // (docs/discovery.md §5.1 calls it out for partial matching, but
    // the canonical enum doesn't include it). We don't surface it.
    assert.deepEqual(inferSeniorityFromTitle("Lead Engineer"), []);
  });
});
