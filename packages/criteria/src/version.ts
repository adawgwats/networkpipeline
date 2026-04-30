import type { CandidateCriteria } from "./schema.js";

export type UpdatedVia =
  | "criteria_init"
  | "conversation_with_claude"
  | "manual_edit"
  | "active_learning"
  | (string & {});

export type BumpVersionOptions = {
  /**
   * Free-form provenance string written to the criteria file's
   * `updated_via` field. Should match the controlled vocabulary used
   * by the DB column where reasonable; values outside that vocabulary
   * are persisted as `manual_edit` by the runtime mirror helper.
   */
  updatedVia: UpdatedVia;
  /**
   * Override the timestamp used for `updated_at`. Defaults to "now".
   * Tests pin this for determinism; production passes nothing.
   */
  now?: Date;
};

/**
 * Pure function: returns a new CandidateCriteria with `version + 1`,
 * a fresh `updated_at`, and the caller-specified `updated_via`. The
 * input is NOT mutated.
 *
 * Does not validate the result here — callers route through
 * serializeCriteriaToYaml or writeCriteriaToFile, both of which do
 * full validation as part of their contract. Keeping this pure means
 * the active-learning loop can compose it with proposed-diff helpers
 * without paying for validation on every step.
 */
export function bumpVersion(
  criteria: CandidateCriteria,
  options: BumpVersionOptions
): CandidateCriteria {
  const now = (options.now ?? new Date()).toISOString();
  return {
    ...criteria,
    version: criteria.version + 1,
    updated_at: now,
    updated_via: options.updatedVia
  };
}
