import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { z } from "zod";
import { MockJsonOutputProvider } from "@networkpipeline/evaluator";
import type { CandidateCriteria } from "@networkpipeline/criteria";
import {
  CandidateCriteriaVersionsRepository,
  DiscoveredPostingsRepository,
  JobEvaluationsRepository,
  McpInvocationsRepository,
  ProviderRunsRepository,
  SavedSearchesRepository,
  SearchRunsRepository,
  openDb
} from "@networkpipeline/db";
import { objectInput, ToolRegistry } from "../registry.js";
import { makeEvaluateJobTool } from "../tools/evaluate-job.js";
import type { Runtime } from "../runtime.js";

function baseCriteria(): CandidateCriteria {
  return {
    version: 1,
    schema_version: "1.0.0",
    updated_at: new Date(0).toISOString(),
    updated_via: "test",
    extends: [],
    overlays: [],
    profile: {
      display_name: "Test",
      years_experience: 4,
      primary_locations: ["remote"],
      work_authorization: "us_citizen_or_permanent_resident",
      seniority_band: ["mid"]
    },
    hard_gates: {
      must_have: [],
      must_not_have: [],
      must_not_contain_phrases: []
    },
    values_refusals: [],
    soft_preferences: { positive: [], negative: [], min_soft_score: 0.55 },
    calibration: { accepted_examples: [], rejected_examples: [] }
  };
}

function makeRuntime(provider: MockJsonOutputProvider): Runtime {
  const connection = openDb({ path: ":memory:" });
  const repositories = {
    mcpInvocations: new McpInvocationsRepository(connection.db),
    providerRuns: new ProviderRunsRepository(connection.db),
    jobEvaluations: new JobEvaluationsRepository(connection.db),
    criteriaVersions: new CandidateCriteriaVersionsRepository(connection.db),
    savedSearches: new SavedSearchesRepository(connection.db),
    searchRuns: new SearchRunsRepository(connection.db),
    discoveredPostings: new DiscoveredPostingsRepository(connection.db)
  };
  return {
    criteria: baseCriteria(),
    criteriaPath: "/tmp/test-criteria.yaml",
    provider,
    connection,
    repositories,
    criteriaVersionId: "cv-test-1"
  };
}

describe("ToolRegistry — dispatch", () => {
  it("returns unknown_tool for an unregistered tool", async () => {
    const registry = new ToolRegistry();
    const out = await registry.dispatch("nope", {}, { invocationId: "1" });
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.error.kind, "unknown_tool");
  });

  it("returns validation_error for input that fails the Zod schema", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "echo",
      description: "echo",
      inputSchema: objectInput({ msg: z.string() }),
      handler: async (input) => input
    });
    const out = await registry.dispatch(
      "echo",
      { msg: 123 },
      { invocationId: "1" }
    );
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.error.kind, "validation_error");
  });

  it("calls the handler with validated input on success", async () => {
    const registry = new ToolRegistry();
    let captured: unknown = null;
    registry.register({
      name: "echo",
      description: "echo",
      inputSchema: objectInput({ msg: z.string() }),
      handler: async (input, ctx) => {
        captured = { input, ctx };
        return input.msg.toUpperCase();
      }
    });
    const out = await registry.dispatch(
      "echo",
      { msg: "hello" },
      { invocationId: "abc" }
    );
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.output, "HELLO");
    assert.deepEqual(captured, {
      input: { msg: "hello" },
      ctx: { invocationId: "abc" }
    });
  });

  it("returns handler_error when the handler throws", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "boom",
      description: "boom",
      inputSchema: objectInput({}),
      handler: async () => {
        throw new Error("kaboom");
      }
    });
    const out = await registry.dispatch("boom", {}, { invocationId: "1" });
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.error.kind, "handler_error");
    assert.ok(
      "message" in out.error && (out.error as { message: string }).message === "kaboom"
    );
  });

  it("forbids registering the same tool twice", () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "x",
      description: "",
      inputSchema: objectInput({}),
      handler: async () => null
    });
    assert.throws(() =>
      registry.register({
        name: "x",
        description: "",
        inputSchema: objectInput({}),
        handler: async () => null
      })
    );
  });
});

describe("evaluate_job tool — wiring against the registry", () => {
  it("dispatches a hard-gate rejection through the registry", async () => {
    const provider = new MockJsonOutputProvider([
      // extract returns an Anduril posting
      {
        extractor_version: "extract_v1",
        title: "SWE",
        company: "Anduril",
        seniority_signals: ["senior"],
        required_clearance: null,
        required_yoe: { min: null, max: null },
        industry_tags: ["software"],
        required_onsite: { is_required: false, locations: [] },
        employment_type: "full_time",
        work_authorization_constraints: [],
        stack: [],
        raw_text_excerpt: "Anduril is hiring."
      }
    ]);

    const runtime = makeRuntime(provider);
    runtime.criteria.hard_gates.must_not_have.push({
      kind: "company",
      any_of: ["Anduril"],
      reason: "values"
    });

    const registry = new ToolRegistry();
    registry.register(makeEvaluateJobTool(runtime));

    const out = await registry.dispatch(
      "evaluate_job",
      { text: "Anduril job posting" },
      { invocationId: "test-1" }
    );

    assert.equal(out.ok, true);
    if (!out.ok) return;
    const verdict = out.output as { verdict: string; reason_code: string };
    assert.equal(verdict.verdict, "rejected");
    assert.ok(verdict.reason_code.startsWith("hard_gate:company"));
  });

  it("rejects empty text via the input schema, not the handler", async () => {
    const provider = new MockJsonOutputProvider();
    const runtime = makeRuntime(provider);

    const registry = new ToolRegistry();
    registry.register(makeEvaluateJobTool(runtime));

    const out = await registry.dispatch(
      "evaluate_job",
      { text: "" },
      { invocationId: "1" }
    );
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.error.kind, "validation_error");
    // Provider should never have been called.
    assert.equal(provider.invocations.length, 0);
  });
});
