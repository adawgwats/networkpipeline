import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  CriteriaSchemaVersionError,
  CriteriaValidationError,
  parseCriteriaFromYaml,
  tryValidateCriteria,
  validateCriteria
} from "../index.js";
import {
  invalidBadDatetime,
  invalidBadReasonCode,
  invalidBadSchemaVersion,
  invalidMissingProfile,
  invalidNegativeWeight,
  invalidUnknownField,
  validMinimalCriteriaYaml,
  validRichCriteriaYaml
} from "./fixtures.js";
import { parse as parseYaml } from "yaml";

describe("validateCriteria", () => {
  it("accepts the minimal valid criteria file", () => {
    const parsed = parseCriteriaFromYaml(validMinimalCriteriaYaml);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.schema_version, "1.0.0");
    assert.equal(parsed.profile.display_name, "Andrew Watson");
    assert.deepEqual(parsed.values_refusals, [
      "Autonomous lethal systems or weapon targeting"
    ]);
    // Defaults are applied for omitted sections
    assert.deepEqual(parsed.hard_gates.must_have, []);
    assert.deepEqual(parsed.extends, []);
    assert.deepEqual(parsed.overlays, []);
    assert.equal(parsed.soft_preferences.min_soft_score, 0.55);
  });

  it("accepts a rich criteria file with all sections populated", () => {
    const parsed = parseCriteriaFromYaml(validRichCriteriaYaml);
    assert.equal(parsed.version, 7);
    assert.equal(parsed.hard_gates.must_not_contain_phrases.length, 2);
    assert.equal(parsed.values_refusals.length, 2);
    assert.equal(parsed.soft_preferences.positive.length, 2);
    assert.equal(parsed.soft_preferences.negative[0].weight, -0.6);
    assert.equal(parsed.calibration.rejected_examples.length, 2);
    assert.equal(
      parsed.calibration.rejected_examples[0].rejection_reason,
      "values:autonomous_lethal_systems"
    );
  });

  it("throws CriteriaSchemaVersionError on major-version mismatch", () => {
    const raw = parseYaml(invalidBadSchemaVersion);
    assert.throws(() => validateCriteria(raw), CriteriaSchemaVersionError);
  });

  it("throws CriteriaValidationError on missing required profile", () => {
    const raw = parseYaml(invalidMissingProfile);
    assert.throws(() => validateCriteria(raw), CriteriaValidationError);
  });

  it("rejects rejection_reason values outside the reason-code taxonomy", () => {
    const raw = parseYaml(invalidBadReasonCode);
    const result = tryValidateCriteria(raw);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.error instanceof CriteriaValidationError);
    const err = result.error as CriteriaValidationError;
    assert.ok(
      err.issues.some((issue) =>
        issue.path.some((segment) => segment === "rejection_reason")
      ),
      "expected an issue on rejection_reason"
    );
  });

  it("rejects non-ISO updated_at", () => {
    const raw = parseYaml(invalidBadDatetime);
    assert.throws(() => validateCriteria(raw), CriteriaValidationError);
  });

  it("rejects soft-preference weights outside [-1, 1]", () => {
    const raw = parseYaml(invalidNegativeWeight);
    assert.throws(() => validateCriteria(raw), CriteriaValidationError);
  });

  it("rejects unknown top-level fields (strict mode)", () => {
    const raw = parseYaml(invalidUnknownField);
    assert.throws(() => validateCriteria(raw), CriteriaValidationError);
  });

  it("tryValidateCriteria returns ok:true on valid input", () => {
    const raw = parseYaml(validMinimalCriteriaYaml);
    const result = tryValidateCriteria(raw);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.version, 1);
  });

  it("tryValidateCriteria returns structured error on invalid input", () => {
    const raw = parseYaml(invalidMissingProfile);
    const result = tryValidateCriteria(raw);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.error instanceof CriteriaValidationError);
    assert.ok(result.error.formatIssues().includes("profile"));
  });

  it("discriminates hard-gate condition kinds", () => {
    const parsed = parseCriteriaFromYaml(validRichCriteriaYaml);
    const kinds = parsed.hard_gates.must_have.map((c) => c.kind);
    assert.ok(kinds.includes("years_experience"));
    assert.ok(kinds.includes("employment_type"));
    assert.ok(kinds.includes("work_authorization"));
  });
});
