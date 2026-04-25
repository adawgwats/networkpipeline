import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  extractJobFacts,
  MockJsonOutputProvider,
  ProviderValidationError
} from "../index.js";
import {
  baseValidFacts,
  postingAnthropicResearchEngineer,
  postingLockheedClearedRole,
  postingStartupStaff,
  postingVagueIntern
} from "./fixtures.js";
import { EXTRACT_PROMPT_ID, EXTRACT_SYSTEM_PROMPT } from "../extract/prompt.js";

describe("extractJobFacts", () => {
  it("returns validated facts and a ProviderRun for a valid provider response", async () => {
    const expected = baseValidFacts({
      title: "Research Engineer, Agents",
      company: "Anthropic",
      seniority_signals: ["senior"],
      required_yoe: { min: 5, max: null },
      industry_tags: ["ai_ml", "research"],
      required_onsite: {
        is_required: true,
        locations: ["San Francisco, CA"]
      },
      stack: ["Python"],
      raw_text_excerpt: postingAnthropicResearchEngineer.slice(0, 300)
    });
    const provider = new MockJsonOutputProvider([expected]);

    const result = await extractJobFacts(provider, {
      text: postingAnthropicResearchEngineer,
      sourceUrl: "https://example.com/anthropic-re-agents"
    });

    assert.equal(result.facts.company, "Anthropic");
    assert.equal(result.extractor_version, "extract_v1");
    assert.equal(result.run.prompt_id, EXTRACT_PROMPT_ID);
    assert.equal(result.run.provider, "mock");
    assert.equal(result.run.retries, 0);
    assert.equal(result.run.stop_reason, "tool_use");
  });

  it("passes the versioned system prompt to the provider", async () => {
    const provider = new MockJsonOutputProvider([baseValidFacts()]);
    await extractJobFacts(provider, { text: "minimal" });
    const firstCall = provider.invocations[0];
    assert.equal(firstCall?.systemPrompt, EXTRACT_SYSTEM_PROMPT);
    assert.equal(firstCall?.promptId, EXTRACT_PROMPT_ID);
    assert.equal(firstCall?.toolName, "submit_extracted_facts");
  });

  it("prepends the source URL to the user prompt for traceability", async () => {
    const provider = new MockJsonOutputProvider([baseValidFacts()]);
    await extractJobFacts(provider, {
      text: postingStartupStaff,
      sourceUrl: "https://acme.example/staff"
    });
    const firstCall = provider.invocations[0];
    assert.ok(firstCall?.userPrompt.startsWith("Source URL:"));
    assert.ok(firstCall?.userPrompt.includes("https://acme.example/staff"));
    assert.ok(firstCall?.userPrompt.includes("Acme Robotics"));
  });

  it("produces a stable input_hash over the first 8 KiB of trimmed posting text", async () => {
    const provider = new MockJsonOutputProvider([
      baseValidFacts(),
      baseValidFacts()
    ]);
    const r1 = await extractJobFacts(provider, { text: postingStartupStaff });
    const r2 = await extractJobFacts(provider, {
      text: `  ${postingStartupStaff}  \n` // extra whitespace
    });
    assert.equal(r1.input_hash, r2.input_hash);
  });

  it("retries once when the first response fails Zod validation, then succeeds", async () => {
    const invalid = {
      ...baseValidFacts(),
      industry_tags: ["NOT_A_REAL_TAG"]
    };
    const valid = baseValidFacts({ company: "Recovered Inc." });
    const provider = new MockJsonOutputProvider([invalid, valid]);

    const result = await extractJobFacts(provider, {
      text: postingVagueIntern,
      maxRetries: 1
    });
    assert.equal(result.facts.company, "Recovered Inc.");
    assert.equal(result.run.retries, 1);
  });

  it("throws ProviderValidationError when retries are exhausted", async () => {
    const bad1 = { ...baseValidFacts(), industry_tags: ["bogus"] };
    const bad2 = { ...baseValidFacts(), required_yoe: { min: -5, max: null } };
    const provider = new MockJsonOutputProvider([bad1, bad2]);

    await assert.rejects(
      () =>
        extractJobFacts(provider, {
          text: postingLockheedClearedRole,
          maxRetries: 1
        }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderValidationError);
        assert.equal((err as ProviderValidationError).attempts, 2);
        return true;
      }
    );
  });

  it("rejects empty posting text up front without calling the provider", async () => {
    const provider = new MockJsonOutputProvider([baseValidFacts()]);
    await assert.rejects(
      () => extractJobFacts(provider, { text: "   \n  " }),
      /empty/
    );
    assert.equal(provider.invocations.length, 0);
  });

  it("supports a function-style mock response for behavior-parameterized tests", async () => {
    const provider = new MockJsonOutputProvider([
      (req: { model?: string }) =>
        baseValidFacts({
          // Use the request model to prove the function received it.
          company: `company-for-${req.model ?? "default"}`
        })
    ]);
    const result = await extractJobFacts(provider, {
      text: "some posting",
      model: "test-model-x"
    });
    assert.equal(result.facts.company, "company-for-test-model-x");
  });
});
