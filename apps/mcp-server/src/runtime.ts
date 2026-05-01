import { randomUUID } from "node:crypto";
import { loadCriteriaFromFile } from "@networkpipeline/criteria";
import type { CandidateCriteria } from "@networkpipeline/criteria";
import {
  CandidateCriteriaVersionsRepository,
  DiscoveredPostingsRepository,
  JobEvaluationsRepository,
  McpInvocationsRepository,
  PendingEvaluationsRepository,
  ProviderRunsRepository,
  SavedSearchesRepository,
  SearchRunsRepository,
  openDb,
  type Connection
} from "@networkpipeline/db";
import {
  AnthropicJsonOutputProvider,
  type JsonOutputProvider
} from "@networkpipeline/evaluator";

export type Repositories = {
  mcpInvocations: McpInvocationsRepository;
  providerRuns: ProviderRunsRepository;
  jobEvaluations: JobEvaluationsRepository;
  criteriaVersions: CandidateCriteriaVersionsRepository;
  savedSearches: SavedSearchesRepository;
  searchRuns: SearchRunsRepository;
  discoveredPostings: DiscoveredPostingsRepository;
  pendingEvaluations: PendingEvaluationsRepository;
};

export type Runtime = {
  /** Validated, in-memory candidate criteria. */
  criteria: CandidateCriteria;
  /** Path the criteria was loaded from. */
  criteriaPath: string;
  /**
   * Optional in-process LLM provider. Non-null only on the "anthropic"
   * (API-key) path; null on the default "callback" path where LLM
   * round-trips happen via MCP tool callbacks (record_llm_result).
   *
   * Tools that need a provider check this for null and either run the
   * synchronous evaluateJob flow (when set) or return a
   * `pending_llm_call` payload (when null).
   */
  provider: JsonOutputProvider | null;
  /** SQLite connection. Caller closes on shutdown. */
  connection: Connection;
  /** Typed repositories backed by the same connection. */
  repositories: Repositories;
  /**
   * ID of the candidate_criteria_versions row matching the in-memory
   * criteria. Threaded into every job_evaluations row so dedup and
   * eval-harness analysis can be scoped per criteria version.
   */
  criteriaVersionId: string;
};

/**
 * Provider selection strategy.
 *
 *   - "callback" (default): no in-process LLM provider. Evaluation
 *     pipelines pause and return `pending_llm_call` payloads to Claude
 *     Code, which generates the JSON in its normal conversation and
 *     resumes via the `record_llm_result` tool. This is the path that
 *     works under Claude Code today and bills against the user's Max
 *     subscription rather than per-token API spend.
 *   - "anthropic": call the Anthropic API directly with an API key.
 *     Preserved for CI / automation / multi-user contexts where there is
 *     no Claude Code session driving the work.
 *   - "auto": pick "anthropic" when ANTHROPIC_API_KEY is set, else
 *     "callback". Default for environments that don't pin the kind.
 */
export type ProviderKind = "callback" | "anthropic" | "auto";

export type LoadRuntimeOptions = {
  /** Override criteria file path. */
  criteriaPath?: string;
  /** Override Anthropic API key. Falls back to env. */
  anthropicApiKey?: string;
  /** Override Anthropic default model. Falls back to evaluator default. */
  anthropicModel?: string;
  /**
   * Provider selection. Defaults to "auto" — see {@link ProviderKind}.
   * "anthropic" requires a key. "callback" is the in-Claude-Code path.
   */
  providerKind?: ProviderKind;
  /**
   * Inject a provider instead of constructing one. Used by tests to
   * avoid real API calls. When passed, the runtime uses it regardless
   * of `providerKind` (matching the previous semantics).
   */
  providerOverride?: JsonOutputProvider;
  /**
   * Inject an already-opened DB connection. Used by tests for
   * in-memory DBs and for fixture seeding.
   */
  connectionOverride?: Connection;
  /** Override the on-disk DB path (only used when no connectionOverride). */
  dbPath?: string;
};

/**
 * Loads criteria from disk, opens the SQLite database, builds typed
 * repositories, mirrors the loaded criteria into
 * candidate_criteria_versions if it isn't already there, and constructs
 * the LLM provider once. The returned Runtime is held for the duration
 * of an MCP session.
 *
 * Construction failures (missing API key, missing criteria, invalid
 * YAML) surface here so the server boot fails fast with a useful
 * message rather than failing on the first user invocation.
 */
export async function loadRuntime(
  options: LoadRuntimeOptions = {}
): Promise<Runtime> {
  const { criteria, path, yamlText } = await loadCriteriaFromFile(
    options.criteriaPath
  );

  const provider = options.providerOverride ?? buildProvider(options);

  const connection =
    options.connectionOverride ?? openDb({ path: options.dbPath });

  const repositories: Repositories = {
    mcpInvocations: new McpInvocationsRepository(connection.db),
    providerRuns: new ProviderRunsRepository(connection.db),
    jobEvaluations: new JobEvaluationsRepository(connection.db),
    criteriaVersions: new CandidateCriteriaVersionsRepository(connection.db),
    savedSearches: new SavedSearchesRepository(connection.db),
    searchRuns: new SearchRunsRepository(connection.db),
    discoveredPostings: new DiscoveredPostingsRepository(connection.db),
    pendingEvaluations: new PendingEvaluationsRepository(connection.db)
  };

  const criteriaVersionId = mirrorCriteriaToDb(
    criteria,
    yamlText,
    repositories.criteriaVersions
  );

  return {
    criteria,
    criteriaPath: path,
    provider,
    connection,
    repositories,
    criteriaVersionId
  };
}

/**
 * Resolve the in-process LLM provider, if any, from LoadRuntimeOptions.
 *
 * Returns null on the "callback" path (the default in Claude Code): no
 * in-process LLM is used; pipelines pause via `pending_llm_call`
 * payloads and resume on `record_llm_result`.
 *
 * Returns a real provider on the "anthropic" path (CI/automation), and
 * on "auto" when `ANTHROPIC_API_KEY` is present.
 *
 * Exported for unit tests; production callers go through `loadRuntime`.
 */
export function buildProvider(
  options: LoadRuntimeOptions
): JsonOutputProvider | null {
  const kind: ProviderKind = options.providerKind ?? "auto";

  if (kind === "callback") return null;

  if (kind === "anthropic") {
    return new AnthropicJsonOutputProvider({
      apiKey: options.anthropicApiKey,
      defaultModel: options.anthropicModel
    });
  }

  // auto: prefer Anthropic when a key is set; otherwise fall back to
  // callback (no in-process provider; LLM round-trips via Claude Code).
  const hasKey = (options.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY) !== undefined &&
    (options.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? "").length > 0;
  if (hasKey) {
    return new AnthropicJsonOutputProvider({
      apiKey: options.anthropicApiKey,
      defaultModel: options.anthropicModel
    });
  }
  return null;
}

/**
 * Idempotent mirror: ensures a candidate_criteria_versions row exists
 * for the given criteria's `version`. If one already does, returns its
 * id (preserving the original snapshot — never overwrites). If not,
 * inserts a fresh row with the YAML verbatim and returns the new id.
 *
 * Exposed for tests; production calls it via loadRuntime.
 */
export function mirrorCriteriaToDb(
  criteria: CandidateCriteria,
  yamlText: string,
  repo: CandidateCriteriaVersionsRepository
): string {
  const existing = repo.findByVersion(criteria.version);
  if (existing) return existing.id;

  const id = randomUUID();
  repo.insert({
    id,
    version: criteria.version,
    schema_version: criteria.schema_version,
    yaml_snapshot: yamlText,
    change_summary: `Mirrored on boot from ${criteria.updated_via}`,
    triggered_by_evaluation_id: null,
    created_at: criteria.updated_at,
    created_via: createdViaFromUpdatedVia(criteria.updated_via)
  });
  return id;
}

/**
 * Maps the criteria.yaml's free-form `updated_via` string to the DB
 * column's controlled vocabulary. Unknown values fall through to
 * "manual_edit" so we never reject a valid criteria file at boot.
 */
function createdViaFromUpdatedVia(
  updated_via: string
): "criteria_init" | "conversation_with_claude" | "manual_edit" | "active_learning" {
  const normalized = updated_via.toLowerCase();
  if (normalized === "criteria_init") return "criteria_init";
  if (normalized === "conversation_with_claude") return "conversation_with_claude";
  if (normalized === "active_learning") return "active_learning";
  return "manual_edit";
}
