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
 * Greenhouse boards-api shape. Real responses include many more
 * fields; we Zod-parse leniently with `passthrough()` so unknowns
 * survive into `raw_metadata`.
 */
const greenhouseOfficeSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    name: z.string().optional(),
    location: z.string().optional().nullable()
  })
  .passthrough();

const greenhouseMetadataEntrySchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    name: z.string(),
    value: z.unknown().optional().nullable()
  })
  .passthrough();

const greenhouseJobSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    title: z.string(),
    content: z.string().optional().nullable(),
    absolute_url: z.string().optional().nullable(),
    location: z
      .object({ name: z.string().optional() })
      .passthrough()
      .optional()
      .nullable(),
    departments: z.array(z.unknown()).optional(),
    offices: z.array(greenhouseOfficeSchema).optional(),
    metadata: z.array(greenhouseMetadataEntrySchema).optional().nullable(),
    updated_at: z.string().optional().nullable()
  })
  .passthrough();

const greenhouseResponseSchema = z.object({
  jobs: z.array(greenhouseJobSchema)
});

export type GreenhouseConnectorOptions = {
  fetchImpl?: FetchImpl;
};

export function greenhouseConnector(
  opts: GreenhouseConnectorOptions = {}
): DirectFetchSourceConnector {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  return {
    kind: "direct",
    id() {
      return "greenhouse";
    },
    description() {
      return "Greenhouse public boards-api connector (https://boards-api.greenhouse.io).";
    },
    async discoverDirect(query: SourceQuery): Promise<DirectFetchResult> {
      if (query.source !== "greenhouse") {
        return {
          kind: "direct_fetch_result",
          source: "greenhouse",
          postings: [],
          errors: [
            {
              work_item_index: 0,
              message: `greenhouseConnector: expected query.source === "greenhouse", got "${query.source}"`
            }
          ]
        };
      }
      const slug = query.company_slug;
      const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(
        slug
      )}/jobs?content=true`;

      let response: Response;
      try {
        response = await fetchImpl(url);
      } catch (err) {
        return {
          kind: "direct_fetch_result",
          source: "greenhouse",
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
          source: "greenhouse",
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
          source: "greenhouse",
          postings: [],
          errors: [
            {
              work_item_index: 0,
              message: `JSON parse failed for ${url}: ${errorMessage(err)}`
            }
          ]
        };
      }
      const parsed = greenhouseResponseSchema.safeParse(body);
      if (!parsed.success) {
        return {
          kind: "direct_fetch_result",
          source: "greenhouse",
          postings: [],
          errors: [
            {
              work_item_index: 0,
              message: `malformed Greenhouse payload for slug "${slug}": ${parsed.error.message}`
            }
          ]
        };
      }
      const postings = parsed.data.jobs.map((job) =>
        normalizeGreenhouseJob(job, slug)
      );
      return {
        kind: "direct_fetch_result",
        source: "greenhouse",
        postings,
        errors: []
      };
    }
  };
}

function normalizeGreenhouseJob(
  job: z.infer<typeof greenhouseJobSchema>,
  slug: string
): NormalizedDiscoveredPosting {
  const description = job.content ? htmlToText(job.content) : null;
  const offices = job.offices ?? [];
  const isRemote =
    offices.some((o) => /remote/i.test(o.location ?? "")) ||
    /remote/i.test(job.location?.name ?? "");
  const locationName = job.location?.name ?? null;
  const onsiteLocations =
    locationName && !isRemote ? [locationName] : [];
  const isOnsiteRequired =
    locationName === null ? null : isRemote ? false : true;

  return {
    source: "greenhouse",
    external_ref: String(job.id),
    url: job.absolute_url ?? null,
    title: job.title,
    company: slug,
    description_excerpt: description,
    onsite_locations: onsiteLocations,
    is_onsite_required: isOnsiteRequired,
    employment_type: extractEmploymentType(job.metadata ?? null),
    inferred_seniority_signals: inferSeniorityFromTitle(job.title),
    raw_metadata: { ...job }
  };
}

function extractEmploymentType(
  metadata: z.infer<typeof greenhouseMetadataEntrySchema>[] | null
): NormalizedDiscoveredPosting["employment_type"] {
  if (!metadata) return null;
  for (const entry of metadata) {
    if (!/employment\s*type/i.test(entry.name)) continue;
    const raw = entry.value;
    const text =
      typeof raw === "string"
        ? raw
        : Array.isArray(raw)
          ? (raw[0] as unknown)
          : raw;
    if (typeof text !== "string") continue;
    const lower = text.toLowerCase();
    if (/internship|intern/.test(lower)) return "internship";
    if (/contract[\s-]?to[\s-]?hire/.test(lower)) return "contract_to_hire";
    if (/contract/.test(lower)) return "contract";
    if (/full[\s-]?time/.test(lower)) return "full_time";
  }
  return null;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
