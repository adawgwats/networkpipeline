import { z } from "zod";
import { htmlToText } from "../connector/html.js";
import { inferSeniorityFromTitle } from "../connector/seniority.js";
import type {
  IngestInstruction,
  InstructionSourceConnector,
  NormalizedDiscoveredPosting,
  SourceQuery
} from "../connector/types.js";

/**
 * Default per-search result cap. Tunable via factory options later.
 */
const DEFAULT_LIMIT = 25;

/**
 * Schema for the Indeed MCP tool response. The Anthropic-hosted
 * `mcp__claude_ai_Indeed__search_jobs` returns a `jobs` array. Field
 * names mirror Indeed's public structure where possible. All fields
 * besides `job_id`, `title`, `company_name`, `url` are best-effort
 * (the Indeed MCP can return abbreviated payloads).
 */
const indeedJobSchema = z.object({
  job_id: z.string(),
  title: z.string(),
  company_name: z.string(),
  location: z.string().optional().nullable(),
  snippet: z.string().optional().nullable(),
  salary: z.string().optional().nullable(),
  formatted_relative_time: z.string().optional().nullable(),
  url: z.string()
});

const indeedSearchResponseSchema = z.object({
  jobs: z.array(indeedJobSchema)
});

export type IndeedConnectorOptions = {
  /** Per-search result cap forwarded to the Indeed MCP. Default 25. */
  limit?: number;
};

/**
 * Indeed connector. Routes through Claude's hosted Indeed MCP — we
 * never hold credentials. Returns an IngestInstruction for the
 * orchestrator to dispatch; results come back through `recordResults`.
 */
export function indeedConnector(
  opts: IndeedConnectorOptions = {}
): InstructionSourceConnector {
  const limit = opts.limit ?? DEFAULT_LIMIT;

  return {
    kind: "instruction",
    id() {
      return "indeed";
    },
    description() {
      return "Indeed job search via Claude's hosted Indeed MCP (mcp__claude_ai_Indeed__search_jobs).";
    },
    discoverInstruction(
      query: SourceQuery,
      runId: string
    ): IngestInstruction {
      if (query.source !== "indeed") {
        throw new Error(
          `indeedConnector: expected query.source === "indeed", got "${query.source}"`
        );
      }
      const args: Record<string, unknown> = {
        query: query.query,
        limit
      };
      if (query.location !== undefined) args.location = query.location;
      return {
        kind: "ingest_instruction",
        source: "indeed",
        work_items: [
          {
            kind: "claude_mcp_tool",
            tool: "mcp__claude_ai_Indeed__search_jobs",
            args
          }
        ],
        callback_tool: "record_discovered_postings",
        search_run_id: runId
      };
    },
    recordResults(payload: unknown): NormalizedDiscoveredPosting[] {
      const parsed = indeedSearchResponseSchema.safeParse(payload);
      if (!parsed.success) return [];
      return parsed.data.jobs.map(normalizeIndeedJob);
    }
  };
}

function normalizeIndeedJob(
  job: z.infer<typeof indeedJobSchema>
): NormalizedDiscoveredPosting {
  const locationText = (job.location ?? "").trim();
  const isRemote = /\bremote\b/i.test(locationText);
  const onsiteLocations =
    locationText.length === 0 || isRemote ? [] : [locationText];
  const isOnsiteRequired =
    locationText.length === 0 ? null : isRemote ? false : true;

  const snippet = job.snippet ?? "";
  const descriptionExcerpt =
    snippet.length > 0 ? htmlToText(snippet) : null;

  return {
    source: "indeed",
    external_ref: job.job_id,
    url: job.url,
    title: job.title,
    company: job.company_name,
    description_excerpt: descriptionExcerpt,
    onsite_locations: onsiteLocations,
    is_onsite_required: isOnsiteRequired,
    employment_type: inferEmploymentType(snippet, job.title),
    inferred_seniority_signals: inferSeniorityFromTitle(job.title),
    raw_metadata: { ...job }
  };
}

/**
 * Best-effort employment-type detection from Indeed snippet/title.
 * Returns null if the snippet doesn't contain an unambiguous match.
 * Maps to the four-value enum from `EmploymentType`.
 */
function inferEmploymentType(
  snippet: string,
  title: string
): NormalizedDiscoveredPosting["employment_type"] {
  const haystack = `${title} ${snippet}`.toLowerCase();
  if (/\binternship\b|\bintern\b/.test(haystack)) return "internship";
  if (/\bcontract[\s-]?to[\s-]?hire\b/.test(haystack))
    return "contract_to_hire";
  if (/\bcontract\b|\bcontractor\b/.test(haystack)) return "contract";
  if (/\bfull[\s-]?time\b/.test(haystack)) return "full_time";
  return null;
}
