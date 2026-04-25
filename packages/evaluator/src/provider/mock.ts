import {
  ProviderValidationError,
  type JsonOutputProvider,
  type JsonOutputRequest,
  type JsonOutputResult,
  type ProviderRun
} from "./types.js";

/**
 * Scripted response for a single invocation:
 *   - an object is returned verbatim (the mock assumes the caller knows
 *     the target schema)
 *   - a function receives the request and returns an object; useful for
 *     behavior-parameterized tests
 *   - an Error is thrown (simulates adapter failure)
 */
export type MockResponse =
  | unknown
  | Error
  | ((request: JsonOutputRequest<unknown>) => unknown);

/**
 * Deterministic in-process provider used by tests. Plays back a queue of
 * scripted responses in order. Each call consumes one entry.
 *
 * When a queued response fails Zod validation, the mock counts that as a
 * retry (matching real-adapter behavior). The NEXT queued response must
 * be valid, or the call throws ProviderValidationError after retries run out.
 *
 * Token/cost fields are fixed constants so ProviderRun assertions stay
 * deterministic across test runs.
 */
export class MockJsonOutputProvider implements JsonOutputProvider {
  private readonly responses: MockResponse[];
  public readonly invocations: Array<JsonOutputRequest<unknown>> = [];

  constructor(responses: MockResponse[] = []) {
    this.responses = [...responses];
  }

  enqueue(response: MockResponse): void {
    this.responses.push(response);
  }

  async generateJsonObject<T>(
    request: JsonOutputRequest<T>
  ): Promise<JsonOutputResult<T>> {
    this.invocations.push(request as JsonOutputRequest<unknown>);

    const maxRetries = request.maxRetries ?? 1;
    const maxAttempts = maxRetries + 1;
    let lastIssues: unknown = null;
    let lastRaw: unknown = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const next = this.responses.shift();
      if (next === undefined) {
        throw new Error(
          `MockJsonOutputProvider: no queued response for invocation #${
            this.invocations.length
          } (attempt ${attempt + 1}/${maxAttempts})`
        );
      }

      if (next instanceof Error) {
        throw next;
      }

      const raw =
        typeof next === "function"
          ? (next as (r: JsonOutputRequest<unknown>) => unknown)(
              request as JsonOutputRequest<unknown>
            )
          : next;
      lastRaw = raw;

      const parsed = request.outputSchema.safeParse(raw);
      if (parsed.success) {
        return {
          data: parsed.data,
          run: buildMockRun(request, attempt)
        };
      }
      lastIssues = parsed.error.issues;
    }

    throw new ProviderValidationError(
      `Mock provider exhausted ${maxAttempts} attempts without producing valid output.`,
      maxAttempts,
      lastRaw,
      lastIssues
    );
  }
}

function buildMockRun<T>(
  request: JsonOutputRequest<T>,
  retries: number
): ProviderRun {
  return {
    provider: "mock",
    model: request.model ?? "mock-model",
    prompt_id: request.promptId,
    started_at: new Date(0).toISOString(),
    latency_ms: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    cost_usd_cents: 0,
    stop_reason: "tool_use",
    retries
  };
}
