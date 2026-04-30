import type { SeniorityBand } from "@networkpipeline/criteria";

export type SourceId =
  | "indeed"
  | "greenhouse"
  | "lever"
  | "ashby"
  | "career_page"
  | "recruiter_email"
  | "manual_paste";

/**
 * Per-source query shape stored inside SavedSearch.queries_json.
 * Connectors interpret their own slice; the discriminated union lets
 * the orchestrator route correctly.
 */
export type SourceQuery =
  | { source: "indeed"; query: string; location?: string }
  | { source: "greenhouse"; company_slug: string }
  | { source: "lever"; company_slug: string }
  | { source: "ashby"; org_slug: string }
  | { source: "career_page"; url: string }
  | { source: "recruiter_email"; gmail_query: string }
  | { source: "manual_paste"; urls: string[] };

/**
 * IngestInstruction is what NetworkPipeline returns to Claude when the
 * connector cannot fetch directly (Indeed via Claude MCP, Gmail via
 * Claude MCP, WebFetch for career pages). Claude executes per-item
 * work and calls back with results.
 *
 * Connectors that CAN fetch directly (Greenhouse, Lever, Ashby HTTP)
 * return a synchronous result instead — see `DirectFetchResult`.
 */
export type IngestInstruction = {
  kind: "ingest_instruction";
  source: SourceId;
  /**
   * Per-item work the orchestrator (Claude) should execute. Each entry
   * names the MCP tool or HTTP fetch to call and the args. The
   * callback function tells Claude which NetworkPipeline tool to call
   * with the results.
   */
  work_items: WorkItem[];
  /** Tool to call back with normalized results. */
  callback_tool: "record_discovered_postings";
  /** Opaque correlation id; passed through callback verbatim. */
  search_run_id: string;
};

export type WorkItem =
  | {
      kind: "claude_mcp_tool";
      tool: string; // e.g. "mcp__claude_ai_Indeed__search_jobs"
      args: Record<string, unknown>;
    }
  | { kind: "http_get"; url: string; headers?: Record<string, string> }
  | {
      kind: "http_post";
      url: string;
      body: unknown;
      headers?: Record<string, string>;
    }
  | { kind: "web_fetch"; url: string };

export type DirectFetchResult = {
  kind: "direct_fetch_result";
  source: SourceId;
  postings: NormalizedDiscoveredPosting[];
  /** Errors per work-item, keyed by index. Connectors emit partial results on per-item failure. */
  errors: Array<{ work_item_index: number; message: string }>;
};

/**
 * NormalizedDiscoveredPosting is the connector-output shape. The
 * orchestrator persists these as `discovered_postings` rows and feeds
 * them into the pre-extraction gate pipeline (which expects
 * DiscoveredPostingMetadata). The metadata is a subset of this type.
 */
export type NormalizedDiscoveredPosting = {
  source: SourceId;
  external_ref: string | null; // source-native job id
  url: string | null;
  title: string;
  company: string;
  description_excerpt: string | null;
  onsite_locations: string[];
  is_onsite_required: boolean | null;
  employment_type:
    | "full_time"
    | "contract_to_hire"
    | "contract"
    | "internship"
    | null;
  inferred_seniority_signals: SeniorityBand[];
  /** Verbatim source response, JSON-serializable. Persisted to discovered_postings.raw_metadata_json. */
  raw_metadata: Record<string, unknown>;
};

/**
 * SourceConnector is the contract every connector implements. Two
 * shapes coexist:
 *
 *   - `discoverInstruction(query, run_id)` — for connectors that route
 *     through Claude (Indeed, RecruiterEmail, CareerPage WebFetch).
 *     Returns an IngestInstruction; the callback will call
 *     `recordResults(rawCallbackPayload)` to normalize.
 *
 *   - `discoverDirect(query)` — for HTTP-fetchable public APIs
 *     (Greenhouse, Lever, Ashby). Returns DirectFetchResult.
 *
 * A connector implements ONE of these (not both). The orchestrator
 * uses runtime type discrimination on the kind field.
 */
export interface SourceConnector {
  id(): SourceId;
  description(): string;
}

export interface InstructionSourceConnector extends SourceConnector {
  kind: "instruction";
  discoverInstruction(query: SourceQuery, runId: string): IngestInstruction;
  /**
   * Called by the orchestrator with the raw payload Claude returns
   * after executing the instruction. Returns the normalized postings.
   */
  recordResults(payload: unknown): NormalizedDiscoveredPosting[];
}

export interface DirectFetchSourceConnector extends SourceConnector {
  kind: "direct";
  discoverDirect(query: SourceQuery): Promise<DirectFetchResult>;
}

export type AnyConnector =
  | InstructionSourceConnector
  | DirectFetchSourceConnector;

/** A pluggable fetch implementation for testability. Defaults to globalThis.fetch. */
export type FetchImpl = typeof globalThis.fetch;
