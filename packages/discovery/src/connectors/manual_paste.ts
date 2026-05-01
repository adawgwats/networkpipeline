import { canonicalizeUrl } from "../dedup.js";
import {
  DEFAULT_MAX_RESULTS,
  type DirectFetchResult,
  type DirectFetchSourceConnector,
  type NormalizedDiscoveredPosting,
  type SourceQuery
} from "../connector/types.js";

/**
 * manual_paste connector. Accepts a list of URLs the user pastes in
 * (V0 path). Synthesizes minimal `NormalizedDiscoveredPosting` rows
 * without any network call.
 *
 * Rationale: `evaluate_job` is called per URL via Claude's WebFetch
 * (the orchestrator pulls the body), so manual_paste exists primarily
 * as a dedup-bookkeeping record and a search-run accounting target.
 * The synthesized title/company are placeholders — downstream
 * extraction overrides them once Claude fetches the URL.
 */
export function manualPasteConnector(): DirectFetchSourceConnector {
  return {
    kind: "direct",
    id() {
      return "manual_paste";
    },
    description() {
      return "Manual-paste connector. Synthesizes discovered_postings rows from user-supplied URLs without fetching them — Claude pulls bodies via WebFetch during evaluation.";
    },
    async discoverDirect(
      query: SourceQuery,
      maxResults: number = DEFAULT_MAX_RESULTS
    ): Promise<DirectFetchResult> {
      if (query.source !== "manual_paste") {
        return {
          kind: "direct_fetch_result",
          source: "manual_paste",
          postings: [],
          errors: [
            {
              work_item_index: 0,
              message: `manualPasteConnector: expected query.source === "manual_paste", got "${query.source}"`
            }
          ]
        };
      }
      const postings: NormalizedDiscoveredPosting[] = [];
      const errors: DirectFetchResult["errors"] = [];

      query.urls.forEach((rawUrl, index) => {
        // Validate by parsing — `URL` throws on malformed input.
        try {
          // eslint-disable-next-line no-new
          new URL(rawUrl);
        } catch (err) {
          errors.push({
            work_item_index: index,
            message: `malformed URL "${rawUrl}": ${
              err instanceof Error ? err.message : String(err)
            }`
          });
          return;
        }
        const canonical = canonicalizeUrl(rawUrl);
        postings.push(buildManualPastePosting(canonical));
      });

      return {
        kind: "direct_fetch_result",
        source: "manual_paste",
        postings: postings.slice(0, maxResults),
        errors
      };
    }
  };
}

function buildManualPastePosting(url: string): NormalizedDiscoveredPosting {
  return {
    source: "manual_paste",
    external_ref: null,
    url,
    title: "Manual paste — see URL",
    company: "Unknown",
    description_excerpt: null,
    onsite_locations: [],
    is_onsite_required: null,
    employment_type: null,
    inferred_seniority_signals: [],
    // Manual paste has no title beyond the placeholder; defer.
    inferred_role_kinds: ["other"],
    raw_metadata: { url }
  };
}
