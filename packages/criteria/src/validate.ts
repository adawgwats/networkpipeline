import { candidateCriteriaSchema, CURRENT_SCHEMA_VERSION, type CandidateCriteria } from "./schema.js";
import { CriteriaSchemaVersionError, CriteriaValidationError } from "./errors.js";

function majorVersion(semver: string): number {
  const [major] = semver.split(".");
  return Number.parseInt(major ?? "0", 10);
}

export function validateCriteria(input: unknown): CandidateCriteria {
  // Check schema_version compatibility before full Zod parse so users get a
  // more actionable error when they bump a major schema they don't support.
  if (
    typeof input === "object" &&
    input !== null &&
    "schema_version" in input &&
    typeof (input as { schema_version: unknown }).schema_version === "string"
  ) {
    const provided = (input as { schema_version: string }).schema_version;
    if (majorVersion(provided) !== majorVersion(CURRENT_SCHEMA_VERSION)) {
      throw new CriteriaSchemaVersionError(provided, CURRENT_SCHEMA_VERSION);
    }
  }

  const parsed = candidateCriteriaSchema.safeParse(input);
  if (!parsed.success) {
    const err = new CriteriaValidationError(
      "Criteria validation failed",
      parsed.error.issues
    );
    throw err;
  }

  return parsed.data;
}

export function tryValidateCriteria(
  input: unknown
):
  | { ok: true; value: CandidateCriteria }
  | { ok: false; error: CriteriaValidationError | CriteriaSchemaVersionError } {
  try {
    return { ok: true, value: validateCriteria(input) };
  } catch (err) {
    if (
      err instanceof CriteriaValidationError ||
      err instanceof CriteriaSchemaVersionError
    ) {
      return { ok: false, error: err };
    }
    throw err;
  }
}
