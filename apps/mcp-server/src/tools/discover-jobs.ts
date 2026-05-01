import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  connectorById,
  recordDiscoveredPostings,
  startDiscovery,
  type IngestInstruction,
  type SourceQuery
} from "@networkpipeline/discovery";
import type { Runtime } from "../runtime.js";
import { type ToolDefinition } from "../registry.js";

/**
 * SourceQuery validator. Mirrors the discriminated union exactly.
 * Each variant validates its source-specific fields up-front so we
 * can reject malformed requests before the handler runs.
 */
const sourceQuerySchema: z.ZodType<SourceQuery> = z.union([
  z.object({
    source: z.literal("indeed"),
    query: z.string().min(1),
    location: z.string().optional()
  }),
  z.object({
    source: z.literal("greenhouse"),
    company_slug: z.string().min(1)
  }),
  z.object({
    source: z.literal("lever"),
    company_slug: z.string().min(1)
  }),
  z.object({
    source: z.literal("ashby"),
    org_slug: z.string().min(1)
  }),
  z.object({
    source: z.literal("career_page"),
    url: z.string().url()
  }),
  z.object({
    source: z.literal("recruiter_email"),
    gmail_query: z.string()
  }),
  z.object({
    source: z.literal("manual_paste"),
    urls: z.array(z.string()).min(1)
  })
]);

const inputSchema = z
  .object({
    saved_search_id: z.string().min(1).optional(),
    ad_hoc_queries: z.array(sourceQuerySchema).optional(),
    /**
     * Optional per-search cap. When omitted with a saved_search_id,
     * inherits the SavedSearch.max_results column. When omitted on
     * the ad-hoc path, falls back to connector-side
     * DEFAULT_MAX_RESULTS (50).
     */
    max_results: z.number().int().positive().max(500).optional()
  })
  .strict()
  .refine(
    (v) =>
      Boolean(v.saved_search_id) ||
      (v.ad_hoc_queries && v.ad_hoc_queries.length > 0),
    {
      message:
        "discover_jobs requires either saved_search_id or non-empty ad_hoc_queries"
    }
  );

type Input = z.infer<typeof inputSchema>;

export type DiscoverJobsOutput = {
  search_run_id: string;
  direct_results: {
    inserted: number;
    pre_filter_rejected: number;
    duplicates_skipped: number;
    cached_facts_reused: number;
    passed_to_eval: number;
    ready_for_eval_ids: string[];
  };
  instructions: IngestInstruction[];
  /** True when no instructions remain — caller can immediately invoke bulk_evaluate_jobs. */
  fully_resolved: boolean;
  /** Direct-fetch errors surfaced for caller observability. */
  errors: Array<{ source: string; message: string }>;
};

/**
 * discover_jobs — kicks off a search run.
 *
 * - Resolves queries from the SavedSearch row (saved_search_id) or
 *   uses the supplied ad_hoc_queries verbatim. For ad-hoc, no
 *   SavedSearch row is created — the SearchRun row is parented under
 *   a synthetic id (the runId itself) so search_runs FKs stay valid
 *   without needing a phantom SavedSearch.
 * - Calls orchestrator.startDiscovery to fan out to connectors.
 * - For direct results, immediately calls
 *   orchestrator.recordDiscoveredPostings (no Claude round-trip).
 * - Returns the IngestInstructions for InstructionSourceConnectors so
 *   Claude can execute them and call back via record_discovered_postings.
 */
export function makeDiscoverJobsTool(
  runtime: Runtime
): ToolDefinition<Input, DiscoverJobsOutput> {
  return {
    name: "discover_jobs",
    description:
      "Kick off a search run by either a saved_search_id or ad-hoc queries. Returns direct-fetch results and any Claude-executed instructions for instruction-based sources (Indeed, recruiter_email, career_page).",
    inputSchema,
    handler: async (input) => {
      const { savedSearchId, queries, maxResults } = resolveQueries(
        runtime,
        input
      );
      const runId = randomUUID();

      const start = await startDiscovery(runtime.repositories, {
        savedSearchId,
        runId,
        queries,
        connectorById,
        maxResults
      });

      const recorded = recordDiscoveredPostings(runtime.repositories, {
        savedSearchId,
        runId,
        postings: start.direct_postings,
        criteria: runtime.criteria,
        criteriaVersionId: runtime.criteriaVersionId
      });

      return {
        search_run_id: runId,
        direct_results: {
          inserted: recorded.inserted_postings,
          pre_filter_rejected: recorded.pre_filter_rejected,
          duplicates_skipped: recorded.duplicates_skipped,
          cached_facts_reused: recorded.cached_facts_reused,
          passed_to_eval: recorded.passed_to_eval,
          ready_for_eval_ids: recorded.ready_for_eval_ids
        },
        instructions: start.instructions,
        fully_resolved: start.instructions.length === 0,
        errors: start.direct_errors.map((e) => ({
          source: e.source,
          message: e.message
        }))
      };
    }
  };
}

/**
 * Resolve the query set + saved_search_id parent for the run.
 *
 *  - If `saved_search_id` is supplied, load and parse `queries_json`.
 *  - Else (`ad_hoc_queries`), use them verbatim and parent under the
 *    synthetic id "ad_hoc:<uuid>" so search_runs.saved_search_id has
 *    a stable non-null value the dashboard can group by.
 */
function resolveQueries(
  runtime: Runtime,
  input: Input
): {
  savedSearchId: string;
  queries: SourceQuery[];
  maxResults: number | undefined;
} {
  if (input.saved_search_id) {
    const row = runtime.repositories.savedSearches.findById(
      input.saved_search_id
    );
    if (!row) {
      throw new Error(`saved_search not found: ${input.saved_search_id}`);
    }
    let queries: SourceQuery[];
    try {
      queries = JSON.parse(row.queries_json) as SourceQuery[];
    } catch (err) {
      throw new Error(
        `saved_search ${input.saved_search_id} has malformed queries_json: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    // Explicit input override > SavedSearch.max_results > undefined.
    const maxResults = input.max_results ?? row.max_results ?? undefined;
    return { savedSearchId: row.id, queries, maxResults };
  }
  // Ad-hoc — synthesize a parent id to keep FK shape clean.
  return {
    savedSearchId: `ad_hoc:${randomUUID()}`,
    queries: input.ad_hoc_queries ?? [],
    maxResults: input.max_results
  };
}
