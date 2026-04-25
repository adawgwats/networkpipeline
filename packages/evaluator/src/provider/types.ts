import type { ZodType } from "zod";

/**
 * ProviderRun captures one LLM invocation's observability metadata.
 *
 * Every stage of the evaluation pipeline emits one of these per LLM call.
 * Persisted to the `provider_runs` table by downstream storage layers.
 *
 * Token fields align with Anthropic's messages.create response shape so
 * the Anthropic adapter can pass through usage stats verbatim.
 */
export type ProviderRun = {
  provider: "anthropic" | "mock" | (string & {});
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
};

export type JsonOutputRequest<T> = {
  /**
   * Stable identifier for this prompt version. Bundled into ProviderRun for
   * reproducibility and cache-invalidation tracking.
   */
  promptId: string;
  /**
   * Cacheable system prompt. The Anthropic adapter marks this with
   * `cache_control: { type: "ephemeral" }`.
   */
  systemPrompt: string;
  /** Variable user content. Not cached. */
  userPrompt: string;
  /** Zod schema the tool_use output is validated against. */
  outputSchema: ZodType<T>;
  /** Name of the tool Claude is instructed to call. */
  toolName: string;
  /** Human-readable description of the tool (visible to Claude). */
  toolDescription: string;
  /** Model ID override. Defaults to the adapter's configured model. */
  model?: string;
  /** Maximum tokens for completion. Defaults to 4096. */
  maxTokens?: number;
  /** Retry count on Zod validation failure. Defaults to 1. */
  maxRetries?: number;
};

export type JsonOutputResult<T> = {
  data: T;
  run: ProviderRun;
};

/**
 * Provider abstraction. Implementations:
 *   - anthropic.ts — real Claude API call with prompt caching and tool-use
 *   - mock.ts      — deterministic in-process implementation for tests
 */
export interface JsonOutputProvider {
  generateJsonObject<T>(request: JsonOutputRequest<T>): Promise<JsonOutputResult<T>>;
}

export class ProviderValidationError extends Error {
  readonly attempts: number;
  readonly lastRaw: unknown;
  readonly issues: unknown;

  constructor(message: string, attempts: number, lastRaw: unknown, issues: unknown) {
    super(message);
    this.name = "ProviderValidationError";
    this.attempts = attempts;
    this.lastRaw = lastRaw;
    this.issues = issues;
  }
}
