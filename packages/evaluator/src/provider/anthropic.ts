import Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  ProviderValidationError,
  type JsonOutputProvider,
  type JsonOutputRequest,
  type JsonOutputResult,
  type ProviderRun
} from "./types.js";

/**
 * Default Claude model. Can be overridden per-request or per-adapter.
 * Opus 4.7 is the current V1 default based on the strict-output quality
 * tradeoff for extraction and evaluation tasks.
 */
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-7";

export type AnthropicAdapterOptions = {
  apiKey?: string;
  defaultModel?: string;
  /** Optional override for the SDK's baseURL (for proxies / test mocks). */
  baseURL?: string;
  /** Optional pricing override for per-million-token USD. */
  pricing?: {
    input_per_million_usd_cents: number;
    output_per_million_usd_cents: number;
    cache_write_per_million_usd_cents: number;
    cache_read_per_million_usd_cents: number;
  };
};

/**
 * Default cost model for Claude Opus 4.7 (USD cents per million tokens).
 * Kept pessimistic: downstream callers can override per-adapter if pricing
 * drifts. Not load-bearing — cost is observability only, not a gating input.
 */
const DEFAULT_PRICING = {
  input_per_million_usd_cents: 1500,
  output_per_million_usd_cents: 7500,
  cache_write_per_million_usd_cents: 1875,
  cache_read_per_million_usd_cents: 150
};

/**
 * AnthropicJsonOutputProvider
 *
 * Production adapter that:
 *   1. Marks the systemPrompt block with `cache_control: { type: "ephemeral" }`
 *      so repeated extractions against the same criteria/prompt hit cache.
 *   2. Forces structured output via tool-use with a tool whose input_schema
 *      is the Zod schema converted to JSON Schema.
 *   3. Validates the tool_use output against the original Zod schema and
 *      retries once on validation failure (with the error fed back).
 *   4. Returns a ProviderRun populated with usage stats, cache metrics,
 *      and an estimated cost.
 */
export class AnthropicJsonOutputProvider implements JsonOutputProvider {
  private readonly client: Anthropic;
  private readonly defaultModel: string;
  private readonly pricing: AnthropicAdapterOptions["pricing"];

  constructor(options: AnthropicAdapterOptions = {}) {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "AnthropicJsonOutputProvider requires an API key via constructor or ANTHROPIC_API_KEY."
      );
    }
    this.client = new Anthropic({
      apiKey,
      baseURL: options.baseURL
    });
    this.defaultModel = options.defaultModel ?? DEFAULT_ANTHROPIC_MODEL;
    this.pricing = options.pricing ?? DEFAULT_PRICING;
  }

  async generateJsonObject<T>(
    request: JsonOutputRequest<T>
  ): Promise<JsonOutputResult<T>> {
    const maxRetries = request.maxRetries ?? 1;
    const model = request.model ?? this.defaultModel;
    const maxTokens = request.maxTokens ?? 4096;

    const inputSchema = zodToJsonSchema(request.outputSchema, {
      $refStrategy: "none",
      target: "openApi3"
    }) as Record<string, unknown>;

    const tool = {
      name: request.toolName,
      description: request.toolDescription,
      input_schema: inputSchema
    };

    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheCreate = 0;
    let totalCacheRead = 0;
    let lastStopReason = "unknown";
    let lastRaw: unknown = null;
    let lastIssues: unknown = null;

    const startedAt = new Date();
    const startTs = Date.now();

    let currentUser = request.userPrompt;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const response = await this.client.messages.create({
        model,
        max_tokens: maxTokens,
        system: [
          {
            type: "text",
            text: request.systemPrompt,
            cache_control: { type: "ephemeral" }
          }
        ],
        tools: [tool as unknown as Anthropic.Tool],
        tool_choice: { type: "tool", name: request.toolName },
        messages: [{ role: "user", content: currentUser }]
      });

      totalInput += response.usage?.input_tokens ?? 0;
      totalOutput += response.usage?.output_tokens ?? 0;
      totalCacheCreate +=
        (response.usage as { cache_creation_input_tokens?: number })
          ?.cache_creation_input_tokens ?? 0;
      totalCacheRead +=
        (response.usage as { cache_read_input_tokens?: number })
          ?.cache_read_input_tokens ?? 0;
      lastStopReason = response.stop_reason ?? "unknown";

      const toolUseBlock = response.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );

      if (!toolUseBlock) {
        lastRaw = response.content;
        if (attempt < maxRetries) {
          currentUser = `${request.userPrompt}\n\nYour previous response did not call the \`${request.toolName}\` tool. Call it now with the extracted facts.`;
          continue;
        }
        break;
      }

      lastRaw = toolUseBlock.input;
      const parsed = request.outputSchema.safeParse(toolUseBlock.input);
      if (parsed.success) {
        return {
          data: parsed.data,
          run: this.buildRun({
            model,
            promptId: request.promptId,
            startedAt,
            startTs,
            totalInput,
            totalOutput,
            totalCacheCreate,
            totalCacheRead,
            stopReason: lastStopReason,
            retries: attempt
          })
        };
      }
      lastIssues = parsed.error.issues;

      if (attempt < maxRetries) {
        currentUser = `${request.userPrompt}\n\nYour previous tool call did not match the required schema. Errors:\n${JSON.stringify(
          parsed.error.issues,
          null,
          2
        )}\n\nCall the \`${request.toolName}\` tool again with corrected input.`;
      }
    }

    throw new ProviderValidationError(
      `Anthropic provider exhausted ${maxRetries + 1} attempts without valid output.`,
      maxRetries + 1,
      lastRaw,
      lastIssues
    );
  }

  private buildRun(args: {
    model: string;
    promptId: string;
    startedAt: Date;
    startTs: number;
    totalInput: number;
    totalOutput: number;
    totalCacheCreate: number;
    totalCacheRead: number;
    stopReason: string;
    retries: number;
  }): ProviderRun {
    const pricing = this.pricing ?? DEFAULT_PRICING;
    const cost_usd_cents =
      (args.totalInput * pricing.input_per_million_usd_cents +
        args.totalOutput * pricing.output_per_million_usd_cents +
        args.totalCacheCreate * pricing.cache_write_per_million_usd_cents +
        args.totalCacheRead * pricing.cache_read_per_million_usd_cents) /
      1_000_000;

    return {
      provider: "anthropic",
      model: args.model,
      prompt_id: args.promptId,
      started_at: args.startedAt.toISOString(),
      latency_ms: Date.now() - args.startTs,
      input_tokens: args.totalInput,
      output_tokens: args.totalOutput,
      cache_creation_tokens: args.totalCacheCreate,
      cache_read_tokens: args.totalCacheRead,
      cost_usd_cents,
      stop_reason: args.stopReason,
      retries: args.retries
    };
  }
}
