import type {
  EmploymentType,
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
};
