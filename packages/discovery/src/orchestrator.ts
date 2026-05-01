import { randomUUID } from "node:crypto";
import type { CandidateCriteria } from "@networkpipeline/criteria";
import type {
  DiscoveredPostingsRepository,
  JobEvaluationsRepository,
  SavedSearchesRepository,
  SearchRunsRepository
} from "@networkpipeline/db";
import type {
  DiscoveredPostingMetadata,
  EvaluationResult,
  JsonOutputProvider
} from "@networkpipeline/evaluator";
import {
  EXTRACTOR_VERSION,
  evaluateJob,
  evaluateJobWithCachedFacts,
  hashPostingText,
  preExtractionGateCheck
} from "@networkpipeline/evaluator";
import type { ExtractedJobFacts } from "@networkpipeline/evaluator";
import { inferRoleKindsFromTitle } from "./connector/role_kind.js";
import { inferSeniorityFromTitle } from "./connector/seniority.js";
import type {
  AnyConnector,
  IngestInstruction,
  NormalizedDiscoveredPosting,
  SourceId,
  SourceQuery
} from "./connector/types.js";

function extractStringField(
  raw: Record<string, unknown>,
  key: string
): string | null {
  const v = raw[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

export type DiscoveryRepositories = {
  savedSearches: SavedSearchesRepository;
  searchRuns: SearchRunsRepository;
  discoveredPostings: DiscoveredPostingsRepository;
  jobEvaluations: JobEvaluationsRepository;
  /**
   * provider_runs and mcp_invocations are referenced via duck-typed
   * shape — we want this package to depend only on what it needs.
   * Production callers pass the same repository instances exposed in
   * @networkpipeline/db.
   */
  providerRuns: {
    insert(row: ProviderRunInsertShape): void;
  };
};

/**
 * The minimal shape of a provider_runs insert. Mirrors
 * `ProviderRunInsert` from @networkpipeline/db verbatim. Inlined here
 * so the orchestrator can write rows without importing the schema
 * type directly (keeps the package coupling cleaner).
 */
export type ProviderRunInsertShape = {
  id: string;
  provider: string;
  model: string;
  prompt_id: string;
  started_at: string;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd_cents: number | null;
  stop_reason: string;
  retries: number;
  mcp_invocation_id: string | null;
  job_evaluation_id: string | null;
};

export type StartDiscoveryOptions = {
  savedSearchId: string;
  /** Pre-allocated run id; orchestrator inserts the SearchRun row. */
  runId: string;
  queries: SourceQuery[];
  /** Connector lookup; tests inject mocks. */
  connectorById: (id: SourceId) => AnyConnector | undefined;
  /**
   * Per-search result cap, forwarded to every connector. Caps direct
   * fetches via `discoverDirect(query, maxResults)` and instructions
   * via `discoverInstruction(query, runId, maxResults)`. Defaults to
   * the connector-side fallback (DEFAULT_MAX_RESULTS = 50).
   */
  maxResults?: number;
  /** Override new Date() for deterministic tests. Defaults to () => new Date(). */
  now?: () => Date;
};

export type StartDiscoveryResult = {
  /** Direct postings ready for pre-extraction gates. */
  direct_postings: NormalizedDiscoveredPosting[];
  /** Instructions Claude must execute for InstructionSourceConnectors. */
  instructions: IngestInstruction[];
  /** Per-query errors during direct fetch. */
  direct_errors: Array<{ source: SourceId; query: SourceQuery; message: string }>;
};

/**
 * startDiscovery: pure pipeline step.
 *  - Inserts the SearchRun row with status=in_progress.
 *  - For DirectFetchSourceConnectors, fetches synchronously and
 *    returns NormalizedDiscoveredPosting[] for downstream pre-filter.
 *  - For InstructionSourceConnectors, returns IngestInstructions; the
 *    MCP tool layer hands these to Claude which executes and calls
 *    back via record_discovered_postings.
 *
 * Does NOT run pre-extraction gates here — that lives in
 * recordDiscoveredPostings (where direct results also flow) so the
 * pre-filter path is uniform across direct/instruction sources.
 */
export async function startDiscovery(
  repos: DiscoveryRepositories,
  options: StartDiscoveryOptions
): Promise<StartDiscoveryResult> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();

  // Insert the SearchRun row up-front. Counters all start at 0.
  repos.searchRuns.insert({
    id: options.runId,
    saved_search_id: options.savedSearchId,
    started_at: startedAt,
    completed_at: null,
    status: "in_progress",
    results_found: 0,
    results_pre_filtered: 0,
    results_evaluated: 0,
    results_accepted: 0,
    results_below_threshold: 0,
    results_rejected: 0,
    results_needs_review: 0,
    total_cost_usd_cents: 0,
    error_message: null
  });

  const direct_postings: NormalizedDiscoveredPosting[] = [];
  const instructions: IngestInstruction[] = [];
  const direct_errors: StartDiscoveryResult["direct_errors"] = [];

  for (const query of options.queries) {
    const connector = options.connectorById(query.source);
    if (!connector) {
      direct_errors.push({
        source: query.source,
        query,
        message: `unknown source id: ${query.source}`
      });
      continue;
    }
    if (connector.kind === "direct") {
      const result = await connector.discoverDirect(query, options.maxResults);
      direct_postings.push(...result.postings);
      for (const e of result.errors) {
        direct_errors.push({
          source: query.source,
          query,
          message: e.message
        });
      }
    } else {
      instructions.push(
        connector.discoverInstruction(query, options.runId, options.maxResults)
      );
    }
  }

  return { direct_postings, instructions, direct_errors };
}

export type RecordOptions = {
  savedSearchId: string;
  runId: string;
  postings: NormalizedDiscoveredPosting[];
  criteria: CandidateCriteria;
  /**
   * Current criteria_version_id. When supplied, recordDiscoveredPostings
   * checks for prior job_evaluations with this exact criteria version
   * (treats those as "duplicate, skip evaluation"). When omitted, the
   * cross-criteria-version cache lookup still runs but the
   * same-criteria-skip path is disabled.
   */
  criteriaVersionId?: string | null;
  /** Override Date.now for deterministic tests. */
  now?: () => Date;
};

export type RecordResult = {
  inserted_postings: number;
  pre_filter_rejected: number;
  duplicates_skipped: number;
  passed_to_eval: number;
  /**
   * Count of postings staged with `cached_job_evaluation_id` set.
   * These survive `ready_for_eval_ids` (they still need scoring
   * against the new criteria) but skip the extract LLM call.
   */
  cached_facts_reused: number;
  /** IDs of discovered_postings rows that need full evaluation. */
  ready_for_eval_ids: string[];
};

/**
 * recordDiscoveredPostings — persistence + pre-filter + dedup.
 *
 *  - Persists each posting into discovered_postings with status=queued.
 *  - For each, runs preExtractionGateCheck against the criteria.
 *    Failure → updateStatus(pre_filter_rejected, reason_code).
 *  - For survivors, computes the dedup key (input_hash, criteria
 *    version, extractor_version) using the SAME hashing as the
 *    evaluator's extract stage and looks up findByDedupKey to skip
 *    already-evaluated postings. Match → updateStatus(duplicate,
 *    job_evaluation_id link).
 *  - Remaining survivors are returned as ready_for_eval_ids.
 *
 * SearchRun counters are bumped: results_found += inserted,
 * results_pre_filtered += rejects.
 *
 * NOTE on dedup: we don't yet have an `input_hash` for the posting
 * (no extraction has run). The cheap pre-extraction dedup is on
 * (source, external_ref) and url. That's sufficient at this stage —
 * full evaluation-cache dedup (input_hash) is handled inside
 * evaluateJob downstream.
 */
export function recordDiscoveredPostings(
  repos: DiscoveryRepositories,
  options: RecordOptions
): RecordResult {
  const now = options.now ?? (() => new Date());
  const ts = now().toISOString();

  let inserted_postings = 0;
  let pre_filter_rejected = 0;
  let duplicates_skipped = 0;
  let cached_facts_reused = 0;
  const ready_for_eval_ids: string[] = [];

  for (const posting of options.postings) {
    // Hash the SYNTHESIZED posting text (the same body the evaluator
    // would feed to extract) so this matches `job_evaluations.input_hash`
    // produced by `extractJobFacts`. computePostingInputHash exists
    // for cases where we want a connector-only canonical hash, but
    // for cache lookup we need byte-equivalence with extract's hash.
    const synthText = synthesizePostingText(
      posting.title,
      posting.company,
      posting.raw_metadata
    );
    const inputHash = hashPostingText(synthText);

    // Cache lookup: any prior evaluation with the same input_hash AND
    // extractor_version, regardless of criteria_version_id. We
    // distinguish three cases below.
    const priorEval = repos.jobEvaluations.findByInputHash(
      inputHash,
      EXTRACTOR_VERSION
    );

    const id = randomUUID();
    repos.discoveredPostings.insert({
      id,
      saved_search_id: options.savedSearchId,
      search_run_id: options.runId,
      source: posting.source,
      external_ref: posting.external_ref,
      url: posting.url,
      title: posting.title,
      company: posting.company,
      raw_metadata_json: JSON.stringify(posting.raw_metadata),
      status: "queued",
      pre_filter_reason_code: null,
      job_evaluation_id: null,
      cached_job_evaluation_id: null,
      input_hash: inputHash,
      discovered_at: ts,
      last_seen_at: ts
    });
    inserted_postings += 1;

    if (priorEval) {
      const sameCriteria =
        options.criteriaVersionId !== undefined &&
        options.criteriaVersionId !== null &&
        priorEval.criteria_version_id === options.criteriaVersionId;
      const verdictTerminal =
        priorEval.verdict !== "needs_review";

      if (sameCriteria && verdictTerminal) {
        // Branch 1 (same criteria, terminal verdict): skip everything.
        duplicates_skipped += 1;
        repos.discoveredPostings.updateStatus(id, "duplicate", {
          jobEvaluationId: priorEval.id
        });
        continue;
      }
      // Branch 2 (different criteria, OR same criteria but
      // needs_review): reuse facts, re-run gates+values+score.
      cached_facts_reused += 1;
      // Use raw SQL update via a private path: we need to set
      // cached_job_evaluation_id on the just-inserted row. The repo's
      // updateStatus only manages status transitions, not auxiliary
      // FKs, so we run a one-off statement here.
      repos.discoveredPostings.setCachedJobEvaluationId(id, priorEval.id);
      // Posting still goes through pre-extraction gates and (if it
      // survives) into ready_for_eval_ids; the eval loop checks the
      // cached_job_evaluation_id column to skip extract.
    }

    // Pre-extraction gates over the metadata subset.
    const metadata: DiscoveredPostingMetadata = {
      title: posting.title,
      company: posting.company,
      description_excerpt: posting.description_excerpt,
      onsite_locations: posting.onsite_locations,
      is_onsite_required: posting.is_onsite_required,
      employment_type: posting.employment_type,
      inferred_seniority_signals: posting.inferred_seniority_signals,
      inferred_role_kinds: posting.inferred_role_kinds
    };
    const gate = preExtractionGateCheck(metadata, options.criteria);
    if (!gate.pass) {
      pre_filter_rejected += 1;
      repos.discoveredPostings.updateStatus(id, "pre_filter_rejected", {
        preFilterReasonCode: gate.reason_code
      });
      continue;
    }

    ready_for_eval_ids.push(id);
  }

  // Bump SearchRun counters. Use the existing row's values to support
  // multiple recordDiscoveredPostings calls per run (direct then
  // instruction-callback).
  const existing = repos.searchRuns.findById(options.runId);
  const baseFound = existing?.results_found ?? 0;
  const basePreFiltered = existing?.results_pre_filtered ?? 0;
  repos.searchRuns.updateProgress(options.runId, {
    results_found: baseFound + inserted_postings,
    results_pre_filtered: basePreFiltered + pre_filter_rejected
  });

  return {
    inserted_postings,
    pre_filter_rejected,
    duplicates_skipped,
    cached_facts_reused,
    passed_to_eval: ready_for_eval_ids.length,
    ready_for_eval_ids
  };
}

export type EvaluateAllOptions = {
  savedSearchId: string;
  runId: string;
  discoveredPostingIds: string[];
  criteria: CandidateCriteria;
  criteriaVersionId: string;
  provider: JsonOutputProvider;
  /** Optional MCP invocation id for tying provider_runs to the call. */
  mcpInvocationId?: string | null;
  /** Override clock for deterministic tests. */
  now?: () => Date;
};

export type EvaluateAllResult = {
  evaluated: number;
  by_verdict: Record<EvaluationResult["verdict"], number>;
  total_cost_usd_cents: number;
  outcomes: Array<{
    discovered_posting_id: string;
    job_evaluation_id: string;
    verdict: EvaluationResult["verdict"];
    score?: number;
    company: string;
    title: string;
    url: string | null;
    reason_code: string;
  }>;
};

/**
 * evaluateAllSurvivors — runs evaluateJob over each ready posting,
 * persists job_evaluations + provider_runs rows directly through the
 * repos, updates discovered_postings.status to evaluated and links
 * job_evaluation_id, and updates SearchRun counters by verdict.
 *
 * Persistence is inlined here (rather than importing
 * apps/mcp-server/persistence.ts) to keep the dependency graph
 * pointing one direction: apps depend on packages, never the reverse.
 * The row construction mirrors apps/mcp-server/src/persistence.ts
 * exactly.
 *
 * Returns the digest. SearchRun.total_cost_usd_cents is also written.
 */
export async function evaluateAllSurvivors(
  repos: DiscoveryRepositories,
  options: EvaluateAllOptions
): Promise<EvaluateAllResult> {
  const now = options.now ?? (() => new Date());

  const by_verdict: Record<EvaluationResult["verdict"], number> = {
    accepted: 0,
    rejected: 0,
    below_threshold: 0,
    needs_review: 0
  };
  let total_cost_usd_cents = 0;
  const outcomes: EvaluateAllResult["outcomes"] = [];

  for (const id of options.discoveredPostingIds) {
    const row = repos.discoveredPostings.findById(id);
    if (!row) continue;

    // Reconstruct posting text for the evaluator from the stored
    // metadata. This is the same source the connectors built; we use
    // the JSON field to avoid re-deriving.
    let raw: Record<string, unknown> = {};
    try {
      raw = JSON.parse(row.raw_metadata_json);
    } catch {
      raw = {};
    }
    const text = synthesizePostingText(row.title, row.company, raw);

    // Reconstruct DiscoveredPostingMetadata from the persisted columns
    // + raw_metadata so the post-extraction `role_kind` gate has the
    // same title-classifier values pre-extraction used. We re-run the
    // classifier here to avoid storing it twice (the alternative is
    // adding a column on discovered_postings; the regex is cheap so
    // recomputing is fine). The value is used for gating only.
    const inferredRoleKinds = inferRoleKindsFromTitle(row.title ?? "");
    const inferredSeniority = inferSeniorityFromTitle(row.title ?? "");
    const metadata: DiscoveredPostingMetadata = {
      title: row.title ?? "",
      company: row.company ?? "",
      description_excerpt: extractStringField(raw, "description_excerpt"),
      onsite_locations: [],
      is_onsite_required: null,
      employment_type: null,
      inferred_seniority_signals: inferredSeniority,
      inferred_role_kinds: inferredRoleKinds
    };

    // Cached-facts branch: if a prior evaluation against a different
    // criteria version produced reusable facts_json, skip the extract
    // LLM call. The result still gets a fresh job_evaluations row
    // scoped to the CURRENT criteria_version_id; we only reuse the
    // expensive extracted facts.
    let result: EvaluationResult;
    const cachedEvalId = row.cached_job_evaluation_id;
    if (cachedEvalId) {
      const cachedEval = repos.jobEvaluations.findById(cachedEvalId);
      if (cachedEval) {
        try {
          const cachedFacts = JSON.parse(
            cachedEval.facts_json
          ) as ExtractedJobFacts;
          result = await evaluateJobWithCachedFacts(
            options.provider,
            {
              facts: cachedFacts,
              inputHash: cachedEval.input_hash,
              extractorVersion: cachedEval.extractor_version
            },
            options.criteria,
            metadata
          );
        } catch {
          // Defensive: malformed facts_json should never happen, but
          // if it does, fall back to a full re-extract rather than
          // crashing the run.
          result = await evaluateJob(
            options.provider,
            { text, sourceUrl: row.url ?? undefined },
            options.criteria,
            metadata
          );
        }
      } else {
        // FK pointed to a row that no longer exists. Fall back.
        result = await evaluateJob(
          options.provider,
          { text, sourceUrl: row.url ?? undefined },
          options.criteria,
          metadata
        );
      }
    } else {
      result = await evaluateJob(
        options.provider,
        { text, sourceUrl: row.url ?? undefined },
        options.criteria,
        metadata
      );
    }

    // Persist job_evaluations + provider_runs (mirrors
    // apps/mcp-server/src/persistence.ts exactly).
    const jobEvaluationId = randomUUID();
    const createdAt = now().toISOString();
    repos.jobEvaluations.insert({
      id: jobEvaluationId,
      input_hash: result.input_hash,
      criteria_version_id: options.criteriaVersionId,
      extractor_version: result.extractor_version,
      verdict: result.verdict,
      reason_code: result.reason_code,
      short_circuited_at_stage: result.short_circuited_at_stage,
      stages_run_json: JSON.stringify(result.stages_run),
      facts_json: JSON.stringify(result.facts),
      hard_gate_result_json: JSON.stringify(result.hard_gate_result),
      values_result_json: result.values_result
        ? JSON.stringify(result.values_result)
        : null,
      soft_score_result_json: result.soft_score_result
        ? JSON.stringify(result.soft_score_result)
        : null,
      mcp_invocation_id: options.mcpInvocationId ?? null,
      created_at: createdAt
    });

    for (const run of result.provider_runs) {
      const runId = randomUUID();
      repos.providerRuns.insert({
        id: runId,
        provider: run.provider,
        model: run.model,
        prompt_id: run.prompt_id,
        started_at: run.started_at,
        latency_ms: run.latency_ms,
        input_tokens: run.input_tokens,
        output_tokens: run.output_tokens,
        cache_creation_tokens: run.cache_creation_tokens,
        cache_read_tokens: run.cache_read_tokens,
        cost_usd_cents: run.cost_usd_cents,
        stop_reason: run.stop_reason,
        retries: run.retries,
        mcp_invocation_id: options.mcpInvocationId ?? null,
        job_evaluation_id: jobEvaluationId
      });
      if (run.cost_usd_cents !== null && run.provider !== "skipped") {
        total_cost_usd_cents += run.cost_usd_cents;
      }
    }

    repos.discoveredPostings.updateStatus(id, "evaluated", {
      jobEvaluationId
    });

    by_verdict[result.verdict] += 1;
    outcomes.push({
      discovered_posting_id: id,
      job_evaluation_id: jobEvaluationId,
      verdict: result.verdict,
      score: result.soft_score_result?.raw.score,
      company: row.company ?? "",
      title: row.title ?? "",
      url: row.url ?? null,
      reason_code: result.reason_code
    });
  }

  // Update the SearchRun counters with the new tallies. Sum onto any
  // pre-existing values so multiple bulk_evaluate_jobs calls compose.
  const existing = repos.searchRuns.findById(options.runId);
  repos.searchRuns.updateProgress(options.runId, {
    results_evaluated:
      (existing?.results_evaluated ?? 0) + outcomes.length,
    results_accepted: (existing?.results_accepted ?? 0) + by_verdict.accepted,
    results_below_threshold:
      (existing?.results_below_threshold ?? 0) + by_verdict.below_threshold,
    results_rejected: (existing?.results_rejected ?? 0) + by_verdict.rejected,
    results_needs_review:
      (existing?.results_needs_review ?? 0) + by_verdict.needs_review,
    total_cost_usd_cents:
      (existing?.total_cost_usd_cents ?? 0) + total_cost_usd_cents
  });

  return {
    evaluated: outcomes.length,
    by_verdict,
    total_cost_usd_cents,
    outcomes
  };
}

/**
 * Synthesize the posting body from the connector's normalized output
 * for the evaluator. Connectors often store a description excerpt in
 * raw_metadata; preferring it keeps extraction precision high.
 *
 * Falls back to title + company alone — minimal but sufficient for
 * evaluator unit tests; production callers pass richer raw_metadata.
 */
function synthesizePostingText(
  title: string | null,
  company: string | null,
  raw: Record<string, unknown>
): string {
  const parts: string[] = [];
  if (title) parts.push(`Title: ${title}`);
  if (company) parts.push(`Company: ${company}`);

  // Common excerpt-bearing fields across connectors. First non-empty wins.
  const excerptKeys = [
    "description",
    "descriptionPlain",
    "snippet",
    "content",
    "body",
    "description_excerpt"
  ];
  for (const key of excerptKeys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim().length > 0) {
      parts.push(value);
      break;
    }
  }

  // For manual_paste (only `url` in raw_metadata) and other thin
  // payloads, ensure we always pass something non-empty.
  if (parts.length === 0) {
    parts.push("(empty posting body)");
  }
  return parts.join("\n\n");
}

export type FinalizeOptions = {
  savedSearchId: string;
  runId: string;
  status: "completed" | "failed" | "cancelled";
  errorMessage?: string;
  totalCostUsdCents?: number;
  /** Override clock for deterministic tests. */
  now?: () => Date;
};

/**
 * finalizeSearchRun — terminal SearchRun state transition.
 *  - status "completed": markCompleted, then bump SavedSearch.last_run_at.
 *  - status "failed": markFailed with the error_message preserved.
 *  - status "cancelled": writes status directly (no markCancelled
 *    helper exists; we use updateProgress + raw status update). For
 *    V1 this path is unused; included for completeness.
 */
export function finalizeSearchRun(
  repos: DiscoveryRepositories,
  options: FinalizeOptions
): void {
  const now = options.now ?? (() => new Date());
  const ts = now().toISOString();

  if (options.totalCostUsdCents !== undefined) {
    repos.searchRuns.updateProgress(options.runId, {
      total_cost_usd_cents: options.totalCostUsdCents
    });
  }

  if (options.status === "completed") {
    repos.searchRuns.markCompleted(options.runId, ts);
    repos.savedSearches.updateLastRunAt(options.savedSearchId, ts);
    return;
  }
  if (options.status === "failed") {
    const msg = options.errorMessage?.trim();
    if (!msg) {
      throw new Error(
        "finalizeSearchRun: status=failed requires a non-empty errorMessage"
      );
    }
    repos.searchRuns.markFailed(options.runId, msg, ts);
    return;
  }
  // cancelled — V1 unused. The SearchRunsRepository does not yet expose
  // a markCancelled helper; rather than introduce one in this phase,
  // we route through markFailed with a sentinel error_message that
  // makes the cancellation cause auditable.
  repos.searchRuns.markFailed(
    options.runId,
    `cancelled: ${options.errorMessage?.trim() || "user_cancelled"}`,
    ts
  );
}
