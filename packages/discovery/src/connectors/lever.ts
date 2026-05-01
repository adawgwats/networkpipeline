import { z } from "zod";
import { htmlToText } from "../connector/html.js";
import { inferRoleKindsFromTitle } from "../connector/role_kind.js";
import { inferSeniorityFromTitle } from "../connector/seniority.js";
import {
  DEFAULT_MAX_RESULTS,
  type DirectFetchResult,
  type DirectFetchSourceConnector,
  type FetchImpl,
  type NormalizedDiscoveredPosting,
  type SourceQuery
} from "../connector/types.js";

/**
 * Lever postings API shape (?mode=json). Real responses include many
 * more fields; passthrough preserves them in raw_metadata.
 */
const leverCategoriesSchema = z
  .object({
    team: z.string().optional().nullable(),
    department: z.string().optional().nullable(),
    location: z.string().optional().nullable(),
    commitment: z.string().optional().nullable(),
    allLocations: z.array(z.string()).optional()
  })
  .passthrough();

const leverPostingSchema = z
  .object({
    id: z.string(),
    text: z.string(),
    description: z.string().optional().nullable(),
    descriptionPlain: z.string().optional().nullable(),
    additional: z.string().optional().nullable(),
    additionalPlain: z.string().optional().nullable(),
    categories: leverCategoriesSchema.optional(),
    hostedUrl: z.string().optional().nullable(),
    applyUrl: z.string().optional().nullable(),
    createdAt: z.number().optional().nullable()
  })
  .passthrough();

const leverResponseSchema = z.array(leverPostingSchema);

export type LeverConnectorOptions = {
  fetchImpl?: FetchImpl;
};

export function leverConnector(
  opts: LeverConnectorOptions = {}
): DirectFetchSourceConnector {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  return {
    kind: "direct",
    id() {
      return "lever";
    },
    description() {
      return "Lever public postings API connector (https://api.lever.co/v0/postings).";
    },
    async discoverDirect(
      query: SourceQuery,
      maxResults: number = DEFAULT_MAX_RESULTS
    ): Promise<DirectFetchResult> {
      if (query.source !== "lever") {
        return {
          kind: "direct_fetch_result",
          source: "lever",
          postings: [],
          errors: [
            {
              work_item_index: 0,
              message: `leverConnector: expected query.source === "lever", got "${query.source}"`
            }
          ]
        };
      }
      const slug = query.company_slug;
      const url = `https://api.lever.co/v0/postings/${encodeURIComponent(
        slug
      )}?mode=json`;

      let response: Response;
      try {
        response = await fetchImpl(url);
      } catch (err) {
        return {
          kind: "direct_fetch_result",
          source: "lever",
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
          source: "lever",
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
          source: "lever",
          postings: [],
          errors: [
            {
              work_item_index: 0,
              message: `JSON parse failed for ${url}: ${errorMessage(err)}`
            }
          ]
        };
      }
      const parsed = leverResponseSchema.safeParse(body);
      if (!parsed.success) {
        return {
          kind: "direct_fetch_result",
          source: "lever",
          postings: [],
          errors: [
            {
              work_item_index: 0,
              message: `malformed Lever payload for slug "${slug}": ${parsed.error.message}`
            }
          ]
        };
      }
      const postings = parsed.data
        .map((p) => normalizeLeverPosting(p, slug))
        .slice(0, maxResults);
      return {
        kind: "direct_fetch_result",
        source: "lever",
        postings,
        errors: []
      };
    }
  };
}

function normalizeLeverPosting(
  posting: z.infer<typeof leverPostingSchema>,
  slug: string
): NormalizedDiscoveredPosting {
  const cats = posting.categories ?? {};
  const allLocations = cats.allLocations ?? [];
  const locations =
    allLocations.length > 0
      ? allLocations
      : cats.location
        ? [cats.location]
        : [];
  const hasRemote = locations.some((l) => /remote/i.test(l));
  const onsiteLocations = hasRemote
    ? locations.filter((l) => !/remote/i.test(l))
    : locations;
  const isOnsiteRequired =
    locations.length === 0 ? null : hasRemote ? false : true;

  const descriptionPlain = posting.descriptionPlain ?? "";
  const additionalPlain = posting.additionalPlain ?? "";
  const combined = [descriptionPlain, additionalPlain]
    .filter((s) => s.length > 0)
    .join("\n\n");
  const descriptionExcerpt = combined.length > 0 ? combined.slice(0, 1500) : null;

  return {
    source: "lever",
    external_ref: posting.id,
    url: posting.hostedUrl ?? posting.applyUrl ?? null,
    title: posting.text,
    company: slug,
    description_excerpt: descriptionExcerpt,
    onsite_locations: onsiteLocations,
    is_onsite_required: isOnsiteRequired,
    employment_type: mapLeverCommitment(cats.commitment ?? null),
    inferred_seniority_signals: inferSeniorityFromTitle(posting.text),
    inferred_role_kinds: inferRoleKindsFromTitle(posting.text),
    raw_metadata: { ...posting }
  };
}

/**
 * Lever's `categories.commitment` is a free-form string ("Full-time",
 * "Part-time", "Contract", "Internship", and the occasional custom
 * value). We map only values that fit our 4-value EmploymentType
 * enum; everything else (Part-time, custom) returns null.
 */
function mapLeverCommitment(
  commitment: string | null
): NormalizedDiscoveredPosting["employment_type"] {
  if (!commitment) return null;
  const lower = commitment.toLowerCase();
  if (/internship|intern/.test(lower)) return "internship";
  if (/contract[\s-]?to[\s-]?hire/.test(lower)) return "contract_to_hire";
  if (/contract/.test(lower)) return "contract";
  if (/full[\s-]?time/.test(lower)) return "full_time";
  return null;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
