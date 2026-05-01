import type {
  EmploymentType,
  RoleKind,
  SeniorityBand
} from "@networkpipeline/criteria";

/**
 * Posting metadata available BEFORE LLM extraction.
 *
 * Source connectors (Indeed, Greenhouse, Lever, Ashby, CareerPage)
 * provide most of these directly via their structured APIs. Fields are
 * deliberately a subset of ExtractedJobFacts — anything that would
 * require LLM inference is omitted.
 *
 * `title` and `description_excerpt` may contain phrases the user has
 * blocklisted; both are scanned in `must_not_contain_phrases`.
 *
 * `inferred_seniority_signals` is best-effort regex over the title
 * (Senior, Staff, Principal, Director, VP, intern, etc). Connectors
 * with structured seniority fields populate this directly; others
 * leave it empty and let the post-extraction stage decide.
 */
export type DiscoveredPostingMetadata = {
  title: string;
  company: string;
  description_excerpt: string | null;
  /** Empty array if fully remote / unspecified. */
  onsite_locations: string[];
  is_onsite_required: boolean | null;
  employment_type: EmploymentType | null;
  inferred_seniority_signals: SeniorityBand[];
  /**
   * Best-effort title-classifier output. Drives the deterministic
   * `role_kind` gate (see check.ts / pre_extraction.ts). Empty array
   * or `["other"]` means "title didn't match any kind"; the gate
   * defers in that case (does NOT reject).
   *
   * Optional for backward compatibility with callers that haven't
   * been updated yet (e.g. unit tests pre-dating the gate). Treated
   * as `["other"]` (defer) when absent.
   */
  inferred_role_kinds?: RoleKind[];
};
