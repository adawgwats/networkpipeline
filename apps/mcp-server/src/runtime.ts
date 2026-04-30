import { randomUUID } from "node:crypto";
import { loadCriteriaFromFile } from "@networkpipeline/criteria";
import type { CandidateCriteria } from "@networkpipeline/criteria";
import {
  CandidateCriteriaVersionsRepository,
  DiscoveredPostingsRepository,
  JobEvaluationsRepository,
  McpInvocationsRepository,
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
};

export type Runtime = {
  /** Validated, in-memory candidate criteria. */
  criteria: CandidateCriteria;
  /** Path the criteria was loaded from. */
  criteriaPath: string;
  /** LLM provider for all evaluation stages. */
  provider: JsonOutputProvider;
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

export type LoadRuntimeOptions = {
  /** Override criteria file path. */
  criteriaPath?: string;
  /** Override Anthropic API key. Falls back to env. */
  anthropicApiKey?: string;
  /** Override Anthropic default model. Falls back to evaluator default. */
  anthropicModel?: string;
  /**
   * Inject a provider instead of constructing the Anthropic adapter.
   * Used by tests to avoid real API calls.
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

  const provider =
    options.providerOverride ??
    new AnthropicJsonOutputProvider({
      apiKey: options.anthropicApiKey,
      defaultModel: options.anthropicModel
    });

  const connection =
    options.connectionOverride ?? openDb({ path: options.dbPath });

  const repositories: Repositories = {
    mcpInvocations: new McpInvocationsRepository(connection.db),
    providerRuns: new ProviderRunsRepository(connection.db),
    jobEvaluations: new JobEvaluationsRepository(connection.db),
    criteriaVersions: new CandidateCriteriaVersionsRepository(connection.db),
    savedSearches: new SavedSearchesRepository(connection.db),
    searchRuns: new SearchRunsRepository(connection.db),
    discoveredPostings: new DiscoveredPostingsRepository(connection.db)
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
