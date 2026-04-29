import { loadCriteriaFromFile } from "@networkpipeline/criteria";
import type { CandidateCriteria } from "@networkpipeline/criteria";
import {
  AnthropicJsonOutputProvider,
  type JsonOutputProvider
} from "@networkpipeline/evaluator";

export type Runtime = {
  /** Validated, in-memory candidate criteria. */
  criteria: CandidateCriteria;
  /** Path the criteria was loaded from. */
  criteriaPath: string;
  /** LLM provider for all evaluation stages. */
  provider: JsonOutputProvider;
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
};

/**
 * Loads criteria from disk, constructs the LLM provider once, and
 * returns the long-lived runtime the MCP server holds for the duration
 * of a session.
 *
 * Construction failures (missing API key, missing criteria, invalid
 * YAML) surface here so the server boot fails fast with a useful
 * message rather than failing on the first user invocation.
 */
export async function loadRuntime(options: LoadRuntimeOptions = {}): Promise<Runtime> {
  const { criteria, path } = await loadCriteriaFromFile(options.criteriaPath);

  const provider =
    options.providerOverride ??
    new AnthropicJsonOutputProvider({
      apiKey: options.anthropicApiKey,
      defaultModel: options.anthropicModel
    });

  return { criteria, criteriaPath: path, provider };
}
