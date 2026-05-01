import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { randomUUID } from "node:crypto";
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
import { ToolRegistry } from "../registry.js";
import { makeBulkEvaluateJobsTool } from "../tools/bulk-evaluate-jobs.js";
import { makeCreateSavedSearchTool } from "../tools/create-saved-search.js";
import { makeEvaluateJobTool } from "../tools/evaluate-job.js";
import { makeRecordLlmResultTool } from "../tools/record-llm-result.js";
import { makeRunSavedSearchTool } from "../tools/run-saved-search.js";
import type { Repositories, Runtime } from "../runtime.js";

function baseCriteria(
  overrides: Partial<CandidateCriteria> = {}
): CandidateCriteria {
  return {
    version: 1,
    schema_version: "1.0.0",
    updated_at: "2026-04-29T00:00:00Z",
    updated_via: "criteria_init",
    extends: [],
    overlays: [],
    profile: {
      display_name: "Test User",
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
    // Permissive threshold so the no-preferences neutral score (0.5)
    // resolves to accepted rather than below_threshold.
    soft_preferences: { positive: [], negative: [], min_soft_score: 0.4 },
    calibration: { accepted_examples: [], rejected_examples: [] },
    ...overrides
  };
}

function buildRepos(connection: Connection): Repositories {
  return {
    mcpInvocations: new McpInvocationsRepository(connection.db),
    providerRuns: new ProviderRunsRepository(connection.db),
    jobEvaluations: new JobEvaluationsRepository(connection.db),
    criteriaVersions: new CandidateCriteriaVersionsRepository(connection.db),
    savedSearches: new SavedSearchesRepository(connection.db),
    searchRuns: new SearchRunsRepository(connection.db),
    discoveredPostings: new DiscoveredPostingsRepository(connection.db),
    pendingEvaluations: new PendingEvaluationsRepository(connection.db)
  };
}

function makeCallbackRuntime(
  connection: Connection,
  criteriaOverrides: Partial<CandidateCriteria> = {}
): Runtime {
  const repos = buildRepos(connection);
  const versionId = randomUUID();
  repos.criteriaVersions.insert({
    id: versionId,
    version: 1,
    schema_version: "1.0.0",
    yaml_snapshot: "yaml",
    change_summary: "test",
    triggered_by_evaluation_id: null,
    created_at: "2026-04-29T00:00:00Z",
    created_via: "criteria_init"
  });
  return {
    criteria: baseCriteria(criteriaOverrides),
    criteriaPath: "/tmp/criteria.yaml",
    // No in-process provider — exercises the callback path.
    provider: null,
    connection,
    repositories: repos,
    criteriaVersionId: versionId
  };
}

function buildRegistry(runtime: Runtime): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(makeEvaluateJobTool(runtime));
  reg.register(makeRecordLlmResultTool(runtime));
  reg.register(makeBulkEvaluateJobsTool(runtime));
  reg.register(makeCreateSavedSearchTool(runtime));
  reg.register(makeRunSavedSearchTool(runtime));
  return reg;
}

function validExtract(overrides: Record<string, unknown> = {}): unknown {
  return {
    extractor_version: "extract_v1",
    title: "Software Engineer",
    company: "Example",
    seniority_signals: [],
    required_clearance: null,
    required_yoe: { min: null, max: null },
    industry_tags: [],
    required_onsite: { is_required: false, locations: [] },
    employment_type: "full_time",
    work_authorization_constraints: [],
    stack: [],
    raw_text_excerpt: "Posting body excerpt.",
    ...overrides
  };
}

type EvaluateJobOk =
  | {
      kind: "completed";
      result: { verdict: string; reason_code: string };
    }
  | {
      kind: "needs_llm";
      pending_evaluation_id: string;
      call: { call_id: string; stage: string; prompt_id: string };
    };

type RecordLlmResultOk =
  | {
      kind: "completed";
      pending_evaluation_id: string;
      result: { verdict: string };
    }
  | {
      kind: "needs_llm";
      pending_evaluation_id: string;
      call: { call_id: string; stage: string };
    }
  | {
      kind: "search_run_completed";
      search_run_id: string;
      digest: { evaluated: number };
    };

describe("callback pipeline — single posting via evaluate_job + record_llm_result", () => {
  it("walks through extract → values → score → completed", async () => {
    const conn = openDb({ path: ":memory:" });
    try {
      const runtime = makeCallbackRuntime(conn, {
        values_refusals: ["autonomous lethal systems"],
        soft_preferences: {
          positive: [{ topic: "AI/ML", weight: 1 }],
          negative: [],
          min_soft_score: 0.55
        }
      });
      const registry = buildRegistry(runtime);

      // 1. evaluate_job → returns needs_llm with extract call.
      const out1 = await registry.dispatch(
        "evaluate_job",
        { text: "An ML engineering posting" },
        { invocationId: "inv-1" }
      );
      assert.equal(out1.ok, true);
      if (!out1.ok) return;
      const r1 = out1.output as EvaluateJobOk;
      assert.equal(r1.kind, "needs_llm");
      if (r1.kind !== "needs_llm") return;
      assert.equal(r1.call.stage, "extract");
      assert.ok(r1.call.call_id.length > 0);

      // 2. record_llm_result(extract output) → returns needs_llm with values.
      const out2 = await registry.dispatch(
        "record_llm_result",
        { call_id: r1.call.call_id, output: validExtract() },
        { invocationId: "inv-2" }
      );
      assert.equal(out2.ok, true);
      if (!out2.ok) return;
      const r2 = out2.output as RecordLlmResultOk;
      assert.equal(r2.kind, "needs_llm");
      if (r2.kind !== "needs_llm") return;
      assert.equal(r2.call.stage, "values");

      // 3. record_llm_result(values clear) → returns needs_llm with score.
      const out3 = await registry.dispatch(
        "record_llm_result",
        {
          call_id: r2.call.call_id,
          output: {
            violation: false,
            matched_refusal: null,
            excerpt: null,
            confidence: 0.05,
            rationale: "."
          }
        },
        { invocationId: "inv-3" }
      );
      assert.equal(out3.ok, true);
      if (!out3.ok) return;
      const r3 = out3.output as RecordLlmResultOk;
      assert.equal(r3.kind, "needs_llm");
      if (r3.kind !== "needs_llm") return;
      assert.equal(r3.call.stage, "soft_score");

      // 4. record_llm_result(score above threshold) → returns completed.
      const out4 = await registry.dispatch(
        "record_llm_result",
        {
          call_id: r3.call.call_id,
          output: {
            score: 0.9,
            contributions: [
              {
                topic: "AI/ML",
                weight: 1,
                contribution: 0.9,
                rationale: "match"
              }
            ],
            rationale: "Strong fit."
          }
        },
        { invocationId: "inv-4" }
      );
      assert.equal(out4.ok, true);
      if (!out4.ok) return;
      const r4 = out4.output as RecordLlmResultOk;
      assert.equal(r4.kind, "completed");
      if (r4.kind !== "completed") return;
      assert.equal(r4.result.verdict, "accepted");

      // pending_evaluations row marked completed.
      const row = runtime.repositories.pendingEvaluations.findById(
        r4.pending_evaluation_id
      );
      assert.equal(row!.status, "completed");
      assert.equal(row!.current_call_id, null);

      // job_evaluations + provider_runs persisted.
      const evals = runtime.repositories.jobEvaluations.listByCriteriaVersion(
        runtime.criteriaVersionId
      );
      assert.equal(evals.length, 1);
      assert.equal(evals[0].verdict, "accepted");
    } finally {
      conn.close();
    }
  });

  it("hard-gate rejection completes immediately on the first record_llm_result call", async () => {
    const conn = openDb({ path: ":memory:" });
    try {
      const runtime = makeCallbackRuntime(conn, {
        hard_gates: {
          must_have: [],
          must_not_have: [
            { kind: "company", any_of: ["Anduril"], reason: "values" }
          ],
          must_not_contain_phrases: []
        }
      });
      const registry = buildRegistry(runtime);

      const out1 = await registry.dispatch(
        "evaluate_job",
        { text: "Anduril posting" },
        { invocationId: "inv-1" }
      );
      assert.equal(out1.ok, true);
      if (!out1.ok) return;
      const r1 = out1.output as EvaluateJobOk;
      assert.equal(r1.kind, "needs_llm");
      if (r1.kind !== "needs_llm") return;

      // Submit extract that puts company=Anduril → hard-gate reject.
      const out2 = await registry.dispatch(
        "record_llm_result",
        {
          call_id: r1.call.call_id,
          output: validExtract({ company: "Anduril" })
        },
        { invocationId: "inv-2" }
      );
      assert.equal(out2.ok, true);
      if (!out2.ok) return;
      const r2 = out2.output as RecordLlmResultOk;
      assert.equal(r2.kind, "completed");
      if (r2.kind !== "completed") return;
      assert.equal(r2.result.verdict, "rejected");
    } finally {
      conn.close();
    }
  });

  it("validation failure on extract triggers a retry with the same pending row", async () => {
    const conn = openDb({ path: ":memory:" });
    try {
      const runtime = makeCallbackRuntime(conn);
      const registry = buildRegistry(runtime);

      const out1 = await registry.dispatch(
        "evaluate_job",
        { text: "any text" },
        { invocationId: "inv-1" }
      );
      assert.equal(out1.ok, true);
      if (!out1.ok) return;
      const r1 = out1.output as EvaluateJobOk;
      if (r1.kind !== "needs_llm") return;

      // Bogus extract output.
      const out2 = await registry.dispatch(
        "record_llm_result",
        { call_id: r1.call.call_id, output: { not: "valid" } },
        { invocationId: "inv-2" }
      );
      assert.equal(out2.ok, true);
      if (!out2.ok) return;
      const r2 = out2.output as RecordLlmResultOk;
      assert.equal(r2.kind, "needs_llm");
      if (r2.kind !== "needs_llm") return;
      assert.equal(r2.call.stage, "extract");
      assert.equal(
        r2.pending_evaluation_id,
        r1.pending_evaluation_id,
        "retry stays on the same pending row"
      );
      // retry call should embed the validation feedback.
    } finally {
      conn.close();
    }
  });
});

describe("callback pipeline — bulk via run_saved_search (manual_paste, 3 URLs)", () => {
  it("walks through 3 postings × 3 stages and finalizes the search_run", async () => {
    const conn = openDb({ path: ":memory:" });
    try {
      const runtime = makeCallbackRuntime(conn, {
        values_refusals: ["autonomous lethal systems"],
        soft_preferences: {
          positive: [{ topic: "AI/ML", weight: 1 }],
          negative: [],
          min_soft_score: 0.55
        }
      });
      const registry = buildRegistry(runtime);

      const created = await registry.dispatch(
        "create_saved_search",
        {
          label: "callback-bulk",
          sources_json: JSON.stringify(["manual_paste"]),
          queries_json: JSON.stringify([
            {
              source: "manual_paste",
              urls: [
                "https://example.com/job/1",
                "https://example.com/job/2",
                "https://example.com/job/3"
              ]
            }
          ])
        },
        { invocationId: "inv-c" }
      );
      assert.equal(created.ok, true);
      if (!created.ok) return;
      const ssId = (created.output as { id: string }).id;

      const run = await registry.dispatch(
        "run_saved_search",
        { saved_search_id: ssId },
        { invocationId: "inv-r" }
      );
      assert.equal(run.ok, true);
      if (!run.ok) return;
      const r0 = run.output as {
        search_run_id: string;
        next_call: { call_id: string; stage: string } | null;
        finalized: boolean;
        pending_evaluation_count: number;
      };
      assert.equal(r0.pending_evaluation_count, 3);
      assert.equal(r0.finalized, false);
      assert.ok(r0.next_call);
      assert.equal(r0.next_call!.stage, "extract");

      // Walk all 3 postings × (extract + values + score) = 9 calls.
      let nextCallId: string | null = r0.next_call!.call_id;
      let stage: string | undefined = r0.next_call!.stage;
      let lastResult: RecordLlmResultOk | null = null;

      for (let i = 0; i < 9; i += 1) {
        let output: unknown;
        if (stage === "extract") output = validExtract();
        else if (stage === "values")
          output = {
            violation: false,
            matched_refusal: null,
            excerpt: null,
            confidence: 0.05,
            rationale: "."
          };
        else if (stage === "soft_score")
          output = {
            score: 0.9,
            contributions: [
              { topic: "AI/ML", weight: 1, contribution: 0.9, rationale: "x" }
            ],
            rationale: "."
          };
        else throw new Error(`unexpected stage: ${stage}`);

        const r = await registry.dispatch(
          "record_llm_result",
          { call_id: nextCallId, output },
          { invocationId: `inv-${i}` }
        );
        assert.equal(r.ok, true, `step ${i}: ${JSON.stringify(r)}`);
        if (!r.ok) return;
        lastResult = r.output as RecordLlmResultOk;
        if (lastResult.kind === "needs_llm") {
          nextCallId = lastResult.call.call_id;
          stage = lastResult.call.stage;
          continue;
        }
        if (lastResult.kind === "completed") {
          // Mid-walk completion (shouldn't happen until step 8 here).
          // After single posting completes, the bulk loop advances to
          // the next posting, returning needs_llm. Only the LAST
          // completion finalizes the search_run.
          nextCallId = null;
          stage = undefined;
          continue;
        }
        if (lastResult.kind === "search_run_completed") {
          assert.equal(i, 8, "search_run_completed should fire on step 8");
          assert.equal(lastResult.digest.evaluated, 3);
          break;
        }
      }
      assert.ok(lastResult);
      assert.equal(lastResult!.kind, "search_run_completed");

      // Search run finalized.
      const sr = runtime.repositories.searchRuns.findById(r0.search_run_id);
      assert.equal(sr!.status, "completed");
      assert.equal(sr!.results_evaluated, 3);
      assert.equal(sr!.results_accepted, 3);

      // 3 job_evaluations rows persisted.
      const evals = runtime.repositories.jobEvaluations.listByCriteriaVersion(
        runtime.criteriaVersionId
      );
      assert.equal(evals.length, 3);
      // Discovered postings linked.
      const dps = runtime.repositories.discoveredPostings.listBySearchRun(
        r0.search_run_id
      );
      assert.equal(dps.length, 3);
      for (const dp of dps) {
        assert.equal(dp.status, "evaluated");
        assert.ok(dp.job_evaluation_id);
      }
    } finally {
      conn.close();
    }
  });
});
