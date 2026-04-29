/**
 * candidate_criteria_versions — append-only history of every criteria
 * version the user has had on disk.
 *
 * Per docs/criteria.md §13, the source of truth is the YAML file on
 * disk. This table is the mirror. The `version` integer (monotonic)
 * has a unique index — every accepted change increments it; rollbacks
 * are NEW rows, never destructive edits.
 *
 * `triggered_by_evaluation_id` is set when the version was produced
 * via `propose_criteria_change` from a thumbs-down on a specific
 * evaluation, threading the active-learning loop's provenance.
 */

export type CreatedVia =
  | "criteria_init"
  | "conversation_with_claude"
  | "manual_edit"
  | "active_learning";

export type CandidateCriteriaVersionRow = {
  id: string;
  /** Monotonic integer version. Unique. */
  version: number;
  schema_version: string;
  yaml_snapshot: string;
  change_summary: string;
  triggered_by_evaluation_id: string | null;
  /** ISO-8601. */
  created_at: string;
  created_via: CreatedVia;
};

export type CandidateCriteriaVersionInsert = CandidateCriteriaVersionRow;
