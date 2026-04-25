import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { EXTRACT_PROMPT_ID, EXTRACT_SYSTEM_PROMPT } from "../extract/prompt.js";
import { EXTRACTOR_VERSION } from "../extract/schema.js";

describe("extract prompt", () => {
  it("has a versioned ID suitable for ProviderRun.prompt_id", () => {
    assert.match(EXTRACT_PROMPT_ID, /^extract_job_facts@v\d+$/);
  });

  it("embeds the EXTRACTOR_VERSION literal in the system prompt", () => {
    // Keeps the prompt instruction in sync with the schema's locked literal.
    assert.ok(
      EXTRACT_SYSTEM_PROMPT.includes(EXTRACTOR_VERSION),
      "system prompt must reference the EXTRACTOR_VERSION constant verbatim"
    );
  });

  it("enumerates every seniority band the criteria package accepts", () => {
    const expected = [
      "intern",
      "new_grad",
      "junior",
      "mid",
      "senior",
      "staff",
      "principal",
      "director",
      "vp"
    ];
    for (const band of expected) {
      assert.ok(
        EXTRACT_SYSTEM_PROMPT.includes(band),
        `seniority band "${band}" must appear in the extraction prompt`
      );
    }
  });

  it("enumerates every clearance level the criteria package accepts", () => {
    const expected = [
      "secret",
      "top_secret",
      "ts_sci",
      "dod_clearance_required"
    ];
    for (const clearance of expected) {
      assert.ok(
        EXTRACT_SYSTEM_PROMPT.includes(clearance),
        `clearance level "${clearance}" must appear in the extraction prompt`
      );
    }
  });

  it("lists all values-sensitive industry tags", () => {
    const valuesTags = [
      "defense_weapons",
      "autonomous_lethal_systems",
      "surveillance_for_state_actors",
      "crypto_only",
      "gambling",
      "adtech_targeting"
    ];
    for (const tag of valuesTags) {
      assert.ok(
        EXTRACT_SYSTEM_PROMPT.includes(tag),
        `values-sensitive tag "${tag}" must appear in the extraction prompt`
      );
    }
  });

  it("is stable across imports (byte-for-byte identical)", async () => {
    const prompt1 = (await import("../extract/prompt.js")).EXTRACT_SYSTEM_PROMPT;
    const prompt2 = (await import("../extract/prompt.js")).EXTRACT_SYSTEM_PROMPT;
    assert.equal(prompt1, prompt2);
  });
});
