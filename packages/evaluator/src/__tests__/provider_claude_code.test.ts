import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { z } from "zod";
import {
  ClaudeCodeJsonOutputProvider,
  ProviderValidationError,
  type SamplingDelegate
} from "../provider/index.js";

const schema = z.object({
  title: z.string(),
  count: z.number().int()
});

type FixtureOutput = z.infer<typeof schema>;

function baseRequest(overrides: Partial<{ model: string; maxRetries: number; maxTokens: number }> = {}) {
  return {
    promptId: "test_prompt_v1",
    systemPrompt: "system instructions",
    userPrompt: "user message body",
    outputSchema: schema,
    toolName: "submit_thing",
    toolDescription: "Submit the structured thing.",
    ...overrides
  } as const;
}

describe("ClaudeCodeJsonOutputProvider", () => {
  it("invokes the delegate with the prompt, tool metadata, and converted schema", async () => {
    const calls: Array<Parameters<SamplingDelegate>[0]> = [];
    const delegate: SamplingDelegate = async (req) => {
      calls.push(req);
      return {
        data: { title: "ok", count: 3 } satisfies FixtureOutput,
        usage: {
          input_tokens: 100,
          output_tokens: 25,
          cache_creation_tokens: 5,
          cache_read_tokens: 50,
          model: "claude-opus-4-7",
          stop_reason: "tool_use"
        }
      };
    };
    const provider = new ClaudeCodeJsonOutputProvider({ delegate });
    const result = await provider.generateJsonObject(baseRequest());

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.systemPrompt, "system instructions");
    assert.equal(calls[0]?.userPrompt, "user message body");
    assert.equal(calls[0]?.toolName, "submit_thing");
    assert.equal(calls[0]?.toolDescription, "Submit the structured thing.");
    // The delegate receives a JSON Schema object, not a Zod instance.
    const schemaObj = calls[0]?.inputSchema as Record<string, unknown>;
    assert.equal(schemaObj.type, "object");
    assert.ok(schemaObj.properties);
    // Default maxTokens default is 4096.
    assert.equal(calls[0]?.maxTokens, 4096);

    assert.deepEqual(result.data, { title: "ok", count: 3 });
  });

  it("populates ProviderRun fields from the delegate's usage metadata", async () => {
    const delegate: SamplingDelegate = async () => ({
      data: { title: "ok", count: 3 },
      usage: {
        input_tokens: 100,
        output_tokens: 25,
        cache_creation_tokens: 5,
        cache_read_tokens: 50,
        model: "claude-opus-4-7",
        stop_reason: "end_turn"
      }
    });
    const provider = new ClaudeCodeJsonOutputProvider({ delegate });
    const result = await provider.generateJsonObject(baseRequest());

    assert.equal(result.run.provider, "claude_code");
    assert.equal(result.run.model, "claude-opus-4-7");
    assert.equal(result.run.prompt_id, "test_prompt_v1");
    assert.equal(result.run.input_tokens, 100);
    assert.equal(result.run.output_tokens, 25);
    assert.equal(result.run.cache_creation_tokens, 5);
    assert.equal(result.run.cache_read_tokens, 50);
    assert.equal(result.run.cost_usd_cents, null);
    assert.equal(result.run.stop_reason, "end_turn");
    assert.equal(result.run.retries, 0);
    assert.ok(result.run.latency_ms >= 0);
  });

  it("falls back to defaults when the delegate's usage metadata is empty", async () => {
    const delegate: SamplingDelegate = async () => ({
      data: { title: "ok", count: 3 },
      usage: {}
    });
    const provider = new ClaudeCodeJsonOutputProvider({ delegate });
    const result = await provider.generateJsonObject(baseRequest());

    assert.equal(result.run.provider, "claude_code");
    assert.equal(result.run.model, "claude-code-session");
    assert.equal(result.run.input_tokens, 0);
    assert.equal(result.run.output_tokens, 0);
    assert.equal(result.run.cache_creation_tokens, 0);
    assert.equal(result.run.cache_read_tokens, 0);
    assert.equal(result.run.cost_usd_cents, null);
    assert.equal(result.run.stop_reason, "end_turn");
    assert.equal(result.run.retries, 0);
  });

  it("retries once on Zod validation failure with the schema errors injected into the user prompt", async () => {
    const seenUserPrompts: string[] = [];
    let call = 0;
    const delegate: SamplingDelegate = async (req) => {
      seenUserPrompts.push(req.userPrompt);
      call++;
      if (call === 1) {
        // Bad: count is a string, schema requires int.
        return {
          data: { title: "ok", count: "three" },
          usage: { input_tokens: 10, output_tokens: 5 }
        };
      }
      return {
        data: { title: "ok", count: 3 },
        usage: { input_tokens: 12, output_tokens: 6 }
      };
    };
    const provider = new ClaudeCodeJsonOutputProvider({ delegate });
    const result = await provider.generateJsonObject(baseRequest());

    assert.equal(call, 2);
    assert.equal(result.data.count, 3);
    assert.equal(result.run.retries, 1);
    // Tokens accumulate across attempts.
    assert.equal(result.run.input_tokens, 22);
    assert.equal(result.run.output_tokens, 11);

    // First attempt sees the original prompt.
    assert.equal(seenUserPrompts[0], "user message body");
    // Second attempt sees the original plus error feedback.
    assert.ok(seenUserPrompts[1]?.startsWith("user message body"));
    assert.ok(seenUserPrompts[1]?.includes("did not match the required schema"));
    // The retry prompt instructs the model to reply with corrected JSON
    // (no longer references a tool name now that we use plain-text sampling).
    assert.ok(seenUserPrompts[1]?.includes("single JSON object"));
  });

  it("throws ProviderValidationError after exhausting retries on persistent invalid output", async () => {
    let calls = 0;
    const delegate: SamplingDelegate = async () => {
      calls++;
      return {
        data: { title: 42, count: "nope" },
        usage: {}
      };
    };
    const provider = new ClaudeCodeJsonOutputProvider({ delegate });
    await assert.rejects(
      () => provider.generateJsonObject(baseRequest({ maxRetries: 1 })),
      (err) => {
        assert.ok(err instanceof ProviderValidationError);
        assert.equal((err as ProviderValidationError).attempts, 2);
        return true;
      }
    );
    assert.equal(calls, 2);
  });

  it("respects the per-request maxRetries override", async () => {
    let calls = 0;
    const delegate: SamplingDelegate = async () => {
      calls++;
      return { data: {}, usage: {} };
    };
    const provider = new ClaudeCodeJsonOutputProvider({ delegate });
    await assert.rejects(() =>
      provider.generateJsonObject(baseRequest({ maxRetries: 3 }))
    );
    // 3 retries → 4 total attempts.
    assert.equal(calls, 4);
  });

  it("forwards the per-request model override to the delegate as modelHint", async () => {
    let seenHint: string | undefined;
    const delegate: SamplingDelegate = async (req) => {
      seenHint = req.modelHint;
      return {
        data: { title: "ok", count: 1 },
        usage: { model: "claude-haiku-4" }
      };
    };
    const provider = new ClaudeCodeJsonOutputProvider({ delegate });
    await provider.generateJsonObject(baseRequest({ model: "claude-haiku-4" }));
    assert.equal(seenHint, "claude-haiku-4");
  });
});
