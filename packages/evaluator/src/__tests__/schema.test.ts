import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  EXTRACTOR_VERSION,
  extractedJobFactsSchema,
  industryTagSchema
} from "../extract/schema.js";
import { baseValidFacts } from "./fixtures.js";

describe("extractedJobFactsSchema", () => {
  it("accepts a fully-valid base object", () => {
    const parsed = extractedJobFactsSchema.parse(baseValidFacts());
    assert.equal(parsed.extractor_version, EXTRACTOR_VERSION);
  });

  it("rejects an unknown extractor_version (locked to the constant)", () => {
    const input = baseValidFacts({
      extractor_version: "extract_v2" as "extract_v1"
    });
    const result = extractedJobFactsSchema.safeParse(input);
    assert.equal(result.success, false);
  });

  it("rejects industry tags outside the controlled vocabulary", () => {
    const input = baseValidFacts({
      industry_tags: ["software", "imaginary_industry" as never]
    });
    const result = extractedJobFactsSchema.safeParse(input);
    assert.equal(result.success, false);
  });

  it("allows null for required_clearance and null min/max YoE", () => {
    const parsed = extractedJobFactsSchema.parse(
      baseValidFacts({
        required_clearance: null,
        required_yoe: { min: null, max: null }
      })
    );
    assert.equal(parsed.required_clearance, null);
    assert.equal(parsed.required_yoe.min, null);
    assert.equal(parsed.required_yoe.max, null);
  });

  it("rejects negative YoE bounds", () => {
    const input = baseValidFacts({ required_yoe: { min: -1, max: null } });
    const result = extractedJobFactsSchema.safeParse(input);
    assert.equal(result.success, false);
  });

  it("rejects unknown extra fields (strict mode)", () => {
    const input = {
      ...baseValidFacts(),
      extra_field: "surprise"
    };
    const result = extractedJobFactsSchema.safeParse(input);
    assert.equal(result.success, false);
  });

  it("industryTagSchema is aligned with the extractor schema", () => {
    // If a values-refusal overlay lists a tag, that tag MUST exist in the
    // extractor vocabulary. Guardrail: the schema exports the enum for reuse.
    const required = [
      "defense_weapons",
      "autonomous_lethal_systems",
      "surveillance_for_state_actors",
      "crypto_only",
      "gambling",
      "adtech_targeting"
    ];
    for (const tag of required) {
      assert.doesNotThrow(() => industryTagSchema.parse(tag));
    }
  });

  it("strips out forbidden seniority bands", () => {
    const input = baseValidFacts({
      seniority_signals: ["mid", "senior", "bogus" as never]
    });
    const result = extractedJobFactsSchema.safeParse(input);
    assert.equal(result.success, false);
  });
});
