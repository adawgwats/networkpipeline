import { z } from "zod";
import { htmlToText } from "../connector/html.js";
import { inferSeniorityFromTitle } from "../connector/seniority.js";
import type {
  DirectFetchResult,
  DirectFetchSourceConnector,
  FetchImpl,
  NormalizedDiscoveredPosting,
  SourceQuery
} from "../connector/types.js";

/**
 * Ashby posting-api job-board response. Real responses contain many
 * more fields; passthrough preserves them.
 */
const ashbyJobSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    location: z.string().optional().nullable(),
    department: z.string().optional().nullable(),
    team: z.string().optional().nullable(),
    employmentType: z.string().optional().nullable(),
    isRemote: z.boolean().optional().nullable(),
    jobUrl: z.string().optional().nullable(),
    applyUrl: z.string().optional().nullable(),
    descriptionHtml: z.string().optional().nullable(),
    descriptionPlain: z.string().optional().nullable()
  })
  .passthrough();

const ashbyResponseSchema = z.object({
  jobs: z.array(ashbyJobSchema)
});

export type AshbyConnectorOptions = {
  fetchImpl?: FetchImpl;
};

export function ashbyConnector(
  opts: AshbyConnectorOptions = {}
): DirectFetchSourceConnector {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  return {
    kind: "direct",
    id() {
      return "ashby";
    },
    description() {
      return "Ashby public job-board posting-api connector (https://api.ashbyhq.com/posting-api/job-board).";
    },
    async discoverDirect(query: SourceQuery): Promise<DirectFetchResult> {
      if (query.source !== "ashby") {
        return {
          kind: "direct_fetch_result",
          source: "ashby",
          postings: [],
          errors: [
            {
              work_item_index: 0,
              message: `ashbyConnector: expected query.source === "ashby", got "${query.source}"`
            }
          ]
        };
      }
      const slug = query.org_slug;
      const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(
        slug
      )}`;

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ includeCompensation: true })
        });
      } catch (err) {
        return {
          kind: "direct_fetch_result",
          source: "ashby",
          postings: [],
          errors: [
            {
              work_item_index: 0,
              message: `network error fetching ${url}: ${errorMessage(err)}`
            }
          ]
        };
      }
      if (!response.ok) {
        return {
          kind: "direct_fetch_result",
          source: "ashby",
          postings: [],
          errors: [
            {
              work_item_index: 0,
              message: `HTTP ${response.status} from ${url}`
            }
          ]
        };
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch (err) {
        return {
          kind: "direct_fetch_result",
          source: "ashby",
          postings: [],
          errors: [
            {
              work_item_index: 0,
              message: `JSON parse failed for ${url}: ${errorMessage(err)}`
            }
          ]
        };
      }
      const parsed = ashbyResponseSchema.safeParse(body);
      if (!parsed.success) {
        return {
          kind: "direct_fetch_result",
          source: "ashby",
          postings: [],
          errors: [
            {
              work_item_index: 0,
              message: `malformed Ashby payload for slug "${slug}": ${parsed.error.message}`
            }
          ]
        };
      }
      const postings = parsed.data.jobs.map((job) =>
        normalizeAshbyJob(job, slug)
      );
      return {
        kind: "direct_fetch_result",
        source: "ashby",
        postings,
        errors: []
      };
    }
  };
}

function normalizeAshbyJob(
  job: z.infer<typeof ashbyJobSchema>,
  slug: string
): NormalizedDiscoveredPosting {
  const isRemote = job.isRemote === true;
  const locationText = (job.location ?? "").trim();
  const onsiteLocations =
    !isRemote && locationText.length > 0 ? [locationText] : [];
  const isOnsiteRequired =
    locationText.length === 0 && job.isRemote == null
      ? null
      : isRemote
        ? false
        : true;

  const descriptionPlain = job.descriptionPlain ?? "";
  let descriptionExcerpt: string | null = null;
  if (descriptionPlain.length > 0) {
    descriptionExcerpt = descriptionPlain.slice(0, 1500);
  } else if (job.descriptionHtml && job.descriptionHtml.length > 0) {
    descriptionExcerpt = htmlToText(job.descriptionHtml);
  }

  return {
    source: "ashby",
    external_ref: job.id,
    url: job.jobUrl ?? job.applyUrl ?? null,
    title: job.title,
    company: slug,
    description_excerpt: descriptionExcerpt,
    onsite_locations: onsiteLocations,
    is_onsite_required: isOnsiteRequired,
    employment_type: mapAshbyEmploymentType(job.employmentType ?? null),
    inferred_seniority_signals: inferSeniorityFromTitle(job.title),
    raw_metadata: { ...job }
  };
}

/**
 * Ashby's employmentType is one of:
 *   FullTime, PartTime, Contract, Intern, Temporary
 * (PascalCase). We map directly:
 *   FullTime -> full_time
 *   Contract -> contract
 *   Intern   -> internship
 * PartTime/Temporary are not in our 4-value enum -> null.
 */
function mapAshbyEmploymentType(
  raw: string | null
): NormalizedDiscoveredPosting["employment_type"] {
  if (!raw) return null;
  const lower = raw.toLowerCase().replace(/[\s-]+/g, "");
  if (lower === "fulltime") return "full_time";
  if (lower === "contract") return "contract";
  if (lower === "intern" || lower === "internship") return "internship";
  if (lower === "contracttohire") return "contract_to_hire";
  return null;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
