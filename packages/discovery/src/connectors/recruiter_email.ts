import { z } from "zod";
import { htmlToText } from "../connector/html.js";
import { inferRoleKindsFromTitle } from "../connector/role_kind.js";
import { inferSeniorityFromTitle } from "../connector/seniority.js";
import {
  DEFAULT_MAX_RESULTS,
  type IngestInstruction,
  type InstructionSourceConnector,
  type NormalizedDiscoveredPosting,
  type SourceQuery
} from "../connector/types.js";

/**
 * Default Gmail search used when the saved search doesn't override it.
 * Tuned to surface inbound recruiter outreach without flooding the
 * pipeline; keep `newer_than` small so each run is bounded.
 */
export const DEFAULT_RECRUITER_QUERY =
  'subject:(role OR opportunity OR interview OR position) newer_than:30d';

/**
 * Default Gmail thread cap fetched per discovery instruction.
 * Tuned for the morning-digest case — the pipeline pre-filters and
 * dedupes downstream so this is a conservative ceiling.
 */
const DEFAULT_MAX_THREADS = 50;

/**
 * Schema for the recruiter-email callback payload. Claude is expected
 * to call `mcp__claude_ai_Gmail__search_threads` with the supplied
 * query (the work_item below), then per-thread call
 * `mcp__claude_ai_Gmail__get_thread` to extract the body, and finally
 * call back with one entry per thread. Threads without a concrete
 * posting (recruiter chatter, interview-scheduling threads) are
 * expected to come back with `posting: null` and are skipped.
 */
const recruiterEmailPostingSchema = z
  .object({
    title: z.string().min(1),
    url: z.string().optional().nullable(),
    company: z.string().optional().nullable(),
    description: z.string().optional().nullable(),
    locations: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .nullable(),
    employment_type_hint: z.string().optional().nullable()
  })
  .passthrough();

const recruiterEmailThreadSchema = z
  .object({
    thread_id: z.string().min(1),
    from_address: z.string().optional().nullable(),
    subject: z.string().optional().nullable(),
    posting: recruiterEmailPostingSchema.optional().nullable()
  })
  .passthrough();

const recruiterEmailPayloadSchema = z.object({
  threads: z.array(recruiterEmailThreadSchema)
});

export type RecruiterEmailConnectorOptions = {
  /** Override per-run thread cap. Default 50. */
  maxThreads?: number;
};

/**
 * recruiter_email connector. Mines recruiter-forwarded postings from
 * the user's Gmail.
 *
 * The connector returns one work item — the Gmail search call —
 * but Claude is expected to follow up with `get_thread` per result and
 * parse posting links/details from each thread body before calling
 * back. The callback may therefore resolve a single work-item into
 * many normalized postings.
 */
export function recruiterEmailConnector(
  opts: RecruiterEmailConnectorOptions = {}
): InstructionSourceConnector {
  const maxThreads = opts.maxThreads ?? DEFAULT_MAX_THREADS;

  return {
    kind: "instruction",
    id() {
      return "recruiter_email";
    },
    description() {
      return "Gmail recruiter-email mining via the hosted Gmail MCP. Claude searches the inbox for recruiter messages, fetches each thread, parses posting details, and calls back.";
    },
    discoverInstruction(
      query: SourceQuery,
      runId: string,
      maxResults?: number
    ): IngestInstruction {
      if (query.source !== "recruiter_email") {
        throw new Error(
          `recruiterEmailConnector: expected query.source === "recruiter_email", got "${query.source}"`
        );
      }
      const gmailQuery = query.gmail_query?.trim() || DEFAULT_RECRUITER_QUERY;
      // Per-call cap takes precedence over the factory default.
      const effectiveMaxThreads = maxResults ?? maxThreads;
      return {
        kind: "ingest_instruction",
        source: "recruiter_email",
        work_items: [
          {
            kind: "claude_mcp_tool",
            tool: "mcp__claude_ai_Gmail__search_threads",
            args: {
              query: gmailQuery,
              max_threads: effectiveMaxThreads
            }
          }
        ],
        callback_tool: "record_discovered_postings",
        search_run_id: runId
      };
    },
    recordResults(
      payload: unknown,
      maxResults: number = DEFAULT_MAX_RESULTS
    ): NormalizedDiscoveredPosting[] {
      const parsed = recruiterEmailPayloadSchema.safeParse(payload);
      if (!parsed.success) return [];
      const out: NormalizedDiscoveredPosting[] = [];
      for (const thread of parsed.data.threads) {
        if (!thread.posting) continue;
        // Skip threads where the posting object is present but lacks a
        // usable title (defensive — schema requires title.min(1) but
        // upstream payload shapes drift).
        if (!thread.posting.title || thread.posting.title.trim().length === 0)
          continue;
        out.push(normalizeRecruiterEmailPosting(thread));
        if (out.length >= maxResults) break;
      }
      return out;
    }
  };
}

function normalizeRecruiterEmailPosting(
  thread: z.infer<typeof recruiterEmailThreadSchema>
): NormalizedDiscoveredPosting {
  // Schema enforces `posting` non-null at this point, but TS narrowing
  // through the optional() chain doesn't carry the guarantee. Asserting.
  const posting = thread.posting!;

  const company =
    posting.company?.trim() ||
    deriveCompanyFromEmail(thread.from_address ?? null) ||
    "Unknown";

  const locations = coerceLocations(posting.locations ?? null);
  const hasRemote = locations.some((l) => /remote/i.test(l));
  const onsiteLocations = hasRemote
    ? locations.filter((l) => !/remote/i.test(l))
    : locations;
  const isOnsiteRequired =
    locations.length === 0 ? null : hasRemote ? false : true;

  const description = posting.description ? htmlToText(posting.description) : null;

  return {
    source: "recruiter_email",
    external_ref: thread.thread_id,
    url: posting.url ?? null,
    title: posting.title,
    company,
    description_excerpt: description,
    onsite_locations: onsiteLocations,
    is_onsite_required: isOnsiteRequired,
    employment_type: mapEmploymentTypeHint(posting.employment_type_hint ?? null),
    inferred_seniority_signals: inferSeniorityFromTitle(posting.title),
    inferred_role_kinds: inferRoleKindsFromTitle(posting.title),
    raw_metadata: { ...thread }
  };
}

function coerceLocations(
  loc: string | string[] | null | undefined
): string[] {
  if (!loc) return [];
  if (typeof loc === "string") {
    const trimmed = loc.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  return loc.filter((s) => typeof s === "string" && s.trim().length > 0);
}

function mapEmploymentTypeHint(
  hint: string | null
): NormalizedDiscoveredPosting["employment_type"] {
  if (!hint) return null;
  const lower = hint.toLowerCase();
  if (/internship|intern/.test(lower)) return "internship";
  if (/contract[\s-]?to[\s-]?hire/.test(lower)) return "contract_to_hire";
  if (/contract/.test(lower)) return "contract";
  if (/full[\s-]?time/.test(lower)) return "full_time";
  return null;
}

/**
 * Best-effort company derivation from an email "from" address.
 * Strips common boilerplate subdomains and the TLD, capitalizes.
 *   "alice@careers.openai.com" → "Openai"
 *   "Bob <bob@anthropic.com>"  → "Anthropic"
 * Returns null when the address is missing or malformed.
 */
function deriveCompanyFromEmail(fromAddress: string | null): string | null {
  if (!fromAddress) return null;
  const match = fromAddress.match(/[\w._%+-]+@([\w.-]+)/);
  if (!match) return null;
  const host = match[1].toLowerCase();
  const stripped = host
    .replace(/^mail\./, "")
    .replace(/^careers\./, "")
    .replace(/^jobs\./, "")
    .replace(/^talent\./, "")
    .replace(/^hr\./, "");
  const parts = stripped.split(".");
  if (parts.length === 0 || !parts[0]) return null;
  const root = parts[0];
  return root.charAt(0).toUpperCase() + root.slice(1);
}
