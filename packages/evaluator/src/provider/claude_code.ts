import { zodToJsonSchema } from "zod-to-json-schema";
import {
  ProviderValidationError,
  type JsonOutputProvider,
  type JsonOutputRequest,
  type JsonOutputResult,
  type ProviderRun
} from "./types.js";

/**
 * Pluggable hook the runtime injects so this provider has a way to
 * call back into the live MCP server's `sampling/createMessage`
 * primitive. We keep the provider package free of MCP SDK imports —
 * the server (apps/mcp-server) wires this lambda when it constructs
 * the runtime, so packages remain independently testable with mocks.
 *
 * The delegate receives an already-converted JSON schema (Zod →
 * JSON Schema is done once at the provider boundary so retries do
 * not re-pay the conversion). It returns the raw tool_use input
 * (un-validated; the provider validates with Zod) plus best-effort
 * usage metadata for ProviderRun population.
 */
export type SamplingDelegate = (request: {
  systemPrompt: string;
  userPrompt: string;
  toolName: string;
  toolDescription: string;
  inputSchema: Record<string, unknown>;
  modelHint?: string;
  maxTokens?: number;
}) => Promise<{
  /** The raw tool_use input, before Zod validation. */
  data: unknown;
  /** Best-effort observability metadata Claude Code surfaces. */
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_tokens?: number;
    cache_read_tokens?: number;
    model?: string;
    stop_reason?: string;
  };
}>;

export type ClaudeCodeAdapterOptions = {
  delegate: SamplingDelegate;
  /** Optional per-adapter retry override. Defaults to 1. */
  defaultMaxRetries?: number;
};

/**
 * ClaudeCodeJsonOutputProvider — routes LLM calls through the user's
 * Claude Code session via MCP sampling. No Anthropic API key needed;
 * inference is billed against the existing Claude Code subscription.
 *
 * The provider is otherwise identical to AnthropicJsonOutputProvider:
 * Zod validation on the tool output, retry-once-with-error-feedback,
 * structured ProviderRun output. Cost reporting is best-effort because
 * Claude Code doesn't surface dollar amounts to MCP servers — fields
 * remain null where unknown.
 */
export class ClaudeCodeJsonOutputProvider implements JsonOutputProvider {
  private readonly delegate: SamplingDelegate;
  private readonly defaultMaxRetries: number;

  constructor(options: ClaudeCodeAdapterOptions) {
    this.delegate = options.delegate;
    this.defaultMaxRetries = options.defaultMaxRetries ?? 1;
  }

  async generateJsonObject<T>(
    request: JsonOutputRequest<T>
  ): Promise<JsonOutputResult<T>> {
    const maxRetries = request.maxRetries ?? this.defaultMaxRetries;
    const maxAttempts = maxRetries + 1;

    // Convert once outside the loop — the schema is identical across retries.
    const inputSchema = zodToJsonSchema(request.outputSchema, {
      $refStrategy: "none",
      target: "openApi3"
    }) as Record<string, unknown>;

    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheCreate = 0;
    let totalCacheRead = 0;
    let lastModel: string | undefined;
    let lastStopReason: string | undefined;
    let lastRaw: unknown = null;
    let lastIssues: unknown = null;

    const startedAt = new Date();
    const startTs = Date.now();

    let currentUser = request.userPrompt;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const { data: raw, usage } = await this.delegate({
        systemPrompt: request.systemPrompt,
        userPrompt: currentUser,
        toolName: request.toolName,
        toolDescription: request.toolDescription,
        inputSchema,
        modelHint: request.model,
        maxTokens: request.maxTokens ?? 4096
      });

      totalInput += usage.input_tokens ?? 0;
      totalOutput += usage.output_tokens ?? 0;
      totalCacheCreate += usage.cache_creation_tokens ?? 0;
      totalCacheRead += usage.cache_read_tokens ?? 0;
      if (usage.model) lastModel = usage.model;
      if (usage.stop_reason) lastStopReason = usage.stop_reason;

      lastRaw = raw;
      const parsed = request.outputSchema.safeParse(raw);
      if (parsed.success) {
        return {
          data: parsed.data,
          run: this.buildRun({
            promptId: request.promptId,
            startedAt,
            startTs,
            totalInput,
            totalOutput,
            totalCacheCreate,
            totalCacheRead,
            model: lastModel,
            stopReason: lastStopReason,
            retries: attempt
          })
        };
      }
      lastIssues = parsed.error.issues;

      if (attempt < maxAttempts - 1) {
        currentUser = `${request.userPrompt}\n\nYour previous tool call did not match the required schema. Errors:\n${JSON.stringify(
          parsed.error.issues,
          null,
          2
        )}\n\nCall the \`${request.toolName}\` tool again with corrected input.`;
      }
    }

    throw new ProviderValidationError(
      `Claude Code provider exhausted ${maxAttempts} attempts without valid output.`,
      maxAttempts,
      lastRaw,
      lastIssues
    );
  }

  private buildRun(args: {
    promptId: string;
    startedAt: Date;
    startTs: number;
    totalInput: number;
    totalOutput: number;
    totalCacheCreate: number;
    totalCacheRead: number;
    model: string | undefined;
    stopReason: string | undefined;
    retries: number;
  }): ProviderRun {
    return {
      provider: "claude_code",
      // When Claude Code surfaces the model id, use it; otherwise we mark
      // the run with a sentinel so downstream observability can tell it
      // came from a sampling session rather than a direct API call.
      model: args.model ?? "claude-code-session",
      prompt_id: args.promptId,
      started_at: args.startedAt.toISOString(),
      latency_ms: Date.now() - args.startTs,
      input_tokens: args.totalInput,
      output_tokens: args.totalOutput,
      cache_creation_tokens: args.totalCacheCreate,
      cache_read_tokens: args.totalCacheRead,
      // Cost is intentionally null: Claude Code does not surface dollar
      // amounts to MCP servers, and the call is billed against the user's
      // Max subscription rather than per-token API spend.
      cost_usd_cents: null,
      stop_reason: args.stopReason ?? "tool_use",
      retries: args.retries
    };
  }
}
