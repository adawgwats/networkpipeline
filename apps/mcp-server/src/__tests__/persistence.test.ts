import { strict as assert } from "node:assert";
import { describe, it, after } from "node:test";
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
import { MockJsonOutputProvider } from "@networkpipeline/evaluator";
import { mirrorCriteriaToDb } from "../runtime.js";
import { persistEvaluationResult } from "../persistence.js";
import { ToolRegistry } from "../registry.js";
import { makeEvaluateJobTool } from "../tools/evaluate-job.js";
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
    soft_preferences: { positive: [], negative: [], min_soft_score: 0.55 },
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

describe("mirrorCriteriaToDb", () => {
  it("inserts a fresh row when the version is not yet persisted", () => {
    const conn = openDb({ path: ":memory:" });
    try {
      const repos = buildRepos(conn);
      const id = mirrorCriteriaToDb(
        baseCriteria(),
        "yaml content here",
        repos.criteriaVersions
      );
      const stored = repos.criteriaVersions.findById(id);
      assert.ok(stored);
      assert.equal(stored!.version, 1);
      assert.equal(stored!.yaml_snapshot, "yaml content here");
      assert.equal(stored!.created_via, "criteria_init");
    } finally {
      conn.close();
    }
  });

  it("returns the existing id when the version is already persisted", () => {
    const conn = openDb({ path: ":memory:" });
    try {
      const repos = buildRepos(conn);
      const id1 = mirrorCriteriaToDb(
        baseCriteria(),
        "snapshot v1",
        repos.criteriaVersions
      );
      const id2 = mirrorCriteriaToDb(
        baseCriteria(),
        "DIFFERENT snapshot — should be ignored",
        repos.criteriaVersions
      );
      assert.equal(id1, id2);
      const stored = repos.criteriaVersions.findById(id1);
      // Original snapshot is preserved, NOT overwritten.
      assert.equal(stored!.yaml_snapshot, "snapshot v1");
    } finally {
      conn.close();
    }
  });

  it("maps unknown updated_via values to manual_edit", () => {
    const conn = openDb({ path: ":memory:" });
    try {
      const repos = buildRepos(conn);
      const id = mirrorCriteriaToDb(
        baseCriteria({
          version: 2,
          updated_via: "some-future-author-tool"
        }),
        "yaml",
        repos.criteriaVersions
      );
      const stored = repos.criteriaVersions.findById(id);
      assert.equal(stored!.created_via, "manual_edit");
    } finally {
      conn.close();
    }
  });
});

describe("persistEvaluationResult — end-to-end through the registry", () => {
  const conn = openDb({ path: ":memory:" });
  const repos = buildRepos(conn);

  after(() => conn.close());

  it("writes job_evaluations + provider_runs for an end-to-end accepted verdict", async () => {
    const provider = new MockJsonOutputProvider([
      // 1. extract
      {
        extractor_version: "extract_v1",
        title: "Research Engineer",
        company: "Anthropic",
        seniority_signals: ["senior"],
        required_clearance: null,
        required_yoe: { min: null, max: null },
        industry_tags: ["ai_ml", "research"],
        required_onsite: { is_required: false, locations: [] },
        employment_type: "full_time",
        work_authorization_constraints: [],
        stack: ["Python"],
        raw_text_excerpt: "Research Engineer at Anthropic..."
      },
      // 2. values_check skipped (refusals empty)
      // 3. soft_score
      {
        score: 0.9,
        contributions: [
          {
            topic: "AI/ML evaluation systems",
            weight: 1.0,
            contribution: 0.9,
            rationale: "Strong match"
          }
        ],
        rationale: "Dead-center fit"
      }
    ]);

    const criteria = baseCriteria();
    criteria.soft_preferences.positive.push({
      topic: "AI/ML evaluation systems",
      weight: 1.0
    });

    const criteriaVersionId = mirrorCriteriaToDb(
      criteria,
      "yaml",
      repos.criteriaVersions
    );

    const runtime: Runtime = {
      criteria,
      criteriaPath: "/tmp/c.yaml",
      provider,
      connection: conn,
      repositories: repos,
      criteriaVersionId
    };

    const registry = new ToolRegistry();
    registry.register(makeEvaluateJobTool(runtime));

    const out = await registry.dispatch(
      "evaluate_job",
      { text: "Research Engineer at Anthropic — build evaluation harnesses." },
      { invocationId: "inv-test-1" }
    );

    assert.equal(out.ok, true);
    if (!out.ok) return;

    // job_evaluations row written, linked to invocation + criteria version.
    const evals = repos.jobEvaluations.listByCriteriaVersion(criteriaVersionId);
    assert.equal(evals.length, 1);
    assert.equal(evals[0].verdict, "accepted");
    assert.equal(evals[0].mcp_invocation_id, "inv-test-1");
    assert.ok(evals[0].input_hash.length > 0);
    assert.equal(evals[0].extractor_version, "extract_v1");

    // Soft-score result was serialized.
    assert.ok(evals[0].soft_score_result_json);
    const scoreResult = JSON.parse(evals[0].soft_score_result_json!);
    assert.equal(scoreResult.raw.score, 0.9);

    // provider_runs were persisted and link back.
    const runs = repos.providerRuns.listByJobEvaluation(evals[0].id);
    assert.equal(runs.length, 3); // extract + values(skipped) + soft_score
    const promptIds = runs.map((r) => r.prompt_id).sort();
    assert.deepEqual(promptIds, [
      "extract_job_facts@v1",
      "soft_score@v1",
      "values_check@v1"
    ]);
    // All link to the same invocation.
    for (const run of runs) {
      assert.equal(run.mcp_invocation_id, "inv-test-1");
      assert.equal(run.job_evaluation_id, evals[0].id);
    }

    // cacheStats excludes the skipped run from cost/cache aggregation.
    const stats = repos.providerRuns.cacheStats();
    assert.equal(stats.total_calls, 2);
  });

  it("writes a hard-gate rejection without calling values_check or soft_score", async () => {
    const provider = new MockJsonOutputProvider([
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

    const criteria = baseCriteria({
      version: 99,
      hard_gates: {
        must_have: [],
        must_not_have: [
          { kind: "company", any_of: ["Anduril"], reason: "values" }
        ],
        must_not_contain_phrases: []
      }
    });

    const criteriaVersionId = mirrorCriteriaToDb(
      criteria,
      "yaml v99",
      repos.criteriaVersions
    );

    const runtime: Runtime = {
      criteria,
      criteriaPath: "/tmp/c.yaml",
      provider,
      connection: conn,
      repositories: repos,
      criteriaVersionId
    };

    const registry = new ToolRegistry();
    registry.register(makeEvaluateJobTool(runtime));

    const out = await registry.dispatch(
      "evaluate_job",
      { text: "Anduril SWE posting" },
      { invocationId: "inv-test-2" }
    );
    assert.equal(out.ok, true);

    const evals = repos.jobEvaluations.listByCriteriaVersion(criteriaVersionId);
    assert.equal(evals.length, 1);
    assert.equal(evals[0].verdict, "rejected");
    assert.ok(evals[0].reason_code.startsWith("hard_gate:company"));
    assert.equal(evals[0].short_circuited_at_stage, "hard_gate");
    assert.equal(evals[0].values_result_json, null);
    assert.equal(evals[0].soft_score_result_json, null);

    // Only one provider_run (extract), no values or score stage rows.
    const runs = repos.providerRuns.listByJobEvaluation(evals[0].id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].prompt_id, "extract_job_facts@v1");
  });
});

describe("findByDedupKey — full pipeline cache hit", () => {
  it("can retrieve a previously persisted evaluation by (input_hash, criteria_version_id, extractor_version)", async () => {
    const conn = openDb({ path: ":memory:" });
    const repos = buildRepos(conn);
    try {
      const provider = new MockJsonOutputProvider([
        {
          extractor_version: "extract_v1",
          title: "X",
          company: "Y",
          seniority_signals: [],
          required_clearance: null,
          required_yoe: { min: null, max: null },
          industry_tags: [],
          required_onsite: { is_required: false, locations: [] },
          employment_type: null,
          work_authorization_constraints: [],
          stack: [],
          raw_text_excerpt: "x"
        }
      ]);

      const criteria = baseCriteria({ version: 7 });
      const criteriaVersionId = mirrorCriteriaToDb(
        criteria,
        "v7",
        repos.criteriaVersions
      );

      const runtime: Runtime = {
        criteria,
        criteriaPath: "/tmp/c.yaml",
        provider,
        connection: conn,
        repositories: repos,
        criteriaVersionId
      };

      const registry = new ToolRegistry();
      registry.register(makeEvaluateJobTool(runtime));
      const result = await registry.dispatch(
        "evaluate_job",
        { text: "the same posting body" },
        { invocationId: "inv-cached-1" }
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const persisted = repos.jobEvaluations.listByCriteriaVersion(
        criteriaVersionId
      );
      assert.equal(persisted.length, 1);

      const dedup = repos.jobEvaluations.findByDedupKey({
        input_hash: persisted[0].input_hash,
        criteria_version_id: criteriaVersionId,
        extractor_version: "extract_v1"
      });
      assert.ok(dedup);
      assert.equal(dedup!.id, persisted[0].id);
    } finally {
      conn.close();
    }
  });
});
