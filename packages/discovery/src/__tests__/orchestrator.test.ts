import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { CandidateCriteria } from "@networkpipeline/criteria";
import {
  CandidateCriteriaVersionsRepository,
  DiscoveredPostingsRepository,
  JobEvaluationsRepository,
  ProviderRunsRepository,
  SavedSearchesRepository,
  SearchRunsRepository,
  openDb,
  type Connection
} from "@networkpipeline/db";
import { MockJsonOutputProvider } from "@networkpipeline/evaluator";
import {
  evaluateAllSurvivors,
  finalizeSearchRun,
  recordDiscoveredPostings,
  startDiscovery,
  type DiscoveryRepositories
} from "../orchestrator.js";
import { manualPasteConnector } from "../connectors/manual_paste.js";
import { indeedConnector } from "../connectors/indeed.js";
import type { AnyConnector, SourceId } from "../connector/types.js";

function makeRepos(conn: Connection): DiscoveryRepositories {
  return {
    savedSearches: new SavedSearchesRepository(conn.db),
    searchRuns: new SearchRunsRepository(conn.db),
    discoveredPostings: new DiscoveredPostingsRepository(conn.db),
    jobEvaluations: new JobEvaluationsRepository(conn.db),
    providerRuns: new ProviderRunsRepository(conn.db)
  };
}

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

function seedSavedSearch(
  conn: Connection,
  overrides: { id?: string; queries_json?: string } = {}
): string {
  const repo = new SavedSearchesRepository(conn.db);
  const id = overrides.id ?? randomUUID();
  repo.insert({
    id,
    label: "test-search",
    sources_json: JSON.stringify(["manual_paste"]),
    queries_json:
      overrides.queries_json ??
      JSON.stringify([
        {
          source: "manual_paste",
          urls: ["https://example.com/j/1"]
        }
      ]),
    criteria_overlay_path: null,
    cadence: "on_demand",
    created_at: "2026-04-29T00:00:00Z",
    updated_at: "2026-04-29T00:00:00Z",
    last_run_at: null
  });
  return id;
}

const FIXED_NOW = () => new Date("2026-04-29T10:00:00Z");

describe("startDiscovery", () => {
  it("routes a DirectFetchSourceConnector query to direct_postings", async () => {
    const conn = openDb({ path: ":memory:" });
    try {
      const repos = makeRepos(conn);
      const ssId = seedSavedSearch(conn);
      const runId = randomUUID();
      const out = await startDiscovery(repos, {
        savedSearchId: ssId,
        runId,
        queries: [
          { source: "manual_paste", urls: ["https://example.com/job/abc"] }
        ],
        connectorById: (id) => (id === "manual_paste" ? manualPasteConnector() : undefined),
        now: FIXED_NOW
      });
      assert.equal(out.direct_postings.length, 1);
      assert.equal(out.instructions.length, 0);
      assert.equal(out.direct_errors.length, 0);

      // SearchRun row is inserted with status=in_progress.
      const sr = repos.searchRuns.findById(runId);
      assert.ok(sr);
      assert.equal(sr!.status, "in_progress");
    } finally {
      conn.close();
    }
  });

  it("routes an InstructionSourceConnector query to instructions", async () => {
    const conn = openDb({ path: ":memory:" });
    try {
      const repos = makeRepos(conn);
      const ssId = seedSavedSearch(conn);
      const runId = randomUUID();
      const out = await startDiscovery(repos, {
        savedSearchId: ssId,
        runId,
        queries: [{ source: "indeed", query: "ml engineer" }],
        connectorById: (id) =>
          id === "indeed" ? indeedConnector() : undefined,
        now: FIXED_NOW
      });
      assert.equal(out.direct_postings.length, 0);
      assert.equal(out.instructions.length, 1);
      assert.equal(out.instructions[0].source, "indeed");
      assert.equal(out.instructions[0].search_run_id, runId);
    } finally {
      conn.close();
    }
  });

  it("emits a direct_errors entry for unknown source ids", async () => {
    const conn = openDb({ path: ":memory:" });
    try {
      const repos = makeRepos(conn);
      const ssId = seedSavedSearch(conn);
      const out = await startDiscovery(repos, {
        savedSearchId: ssId,
        runId: randomUUID(),
        queries: [
          { source: "manual_paste", urls: ["https://x.com/y"] } as never
        ],
        // Connector lookup always returns undefined → unknown source id.
        connectorById: () => undefined,
        now: FIXED_NOW
      });
      assert.equal(out.direct_postings.length, 0);
      assert.equal(out.instructions.length, 0);
      assert.equal(out.direct_errors.length, 1);
      assert.match(out.direct_errors[0].message, /unknown source id/);
    } finally {
      conn.close();
    }
  });
});

describe("recordDiscoveredPostings", () => {
  it("inserts rows with status=queued and bumps results_found", async () => {
    const conn = openDb({ path: ":memory:" });
    try {
      const repos = makeRepos(conn);
      const ssId = seedSavedSearch(conn);
      const runId = randomUUID();
      await startDiscovery(repos, {
        savedSearchId: ssId,
        runId,
        queries: [],
        connectorById: () => undefined,
        now: FIXED_NOW
      });

      const result = recordDiscoveredPostings(repos, {
        savedSearchId: ssId,
        runId,
        criteria: baseCriteria(),
        postings: [
          {
            source: "manual_paste",
            external_ref: null,
            url: "https://example.com/a",
            title: "SWE",
            company: "Example",
            description_excerpt: null,
            onsite_locations: [],
            is_onsite_required: null,
            employment_type: null,
            inferred_seniority_signals: [],
            raw_metadata: { url: "https://example.com/a" }
          }
        ],
        now: FIXED_NOW
      });

      assert.equal(result.inserted_postings, 1);
      assert.equal(result.pre_filter_rejected, 0);
      assert.equal(result.passed_to_eval, 1);
      assert.equal(result.ready_for_eval_ids.length, 1);

      const sr = repos.searchRuns.findById(runId);
      assert.equal(sr!.results_found, 1);
      assert.equal(sr!.results_pre_filtered, 0);

      const rows = repos.discoveredPostings.listBySearchRun(runId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "queued");
    } finally {
      conn.close();
    }
  });

  it("sets pre_filter_reason_code and bumps results_pre_filtered on rejection", async () => {
    const conn = openDb({ path: ":memory:" });
    try {
      const repos = makeRepos(conn);
      const ssId = seedSavedSearch(conn);
      const runId = randomUUID();
      await startDiscovery(repos, {
        savedSearchId: ssId,
        runId,
        queries: [],
        connectorById: () => undefined,
        now: FIXED_NOW
      });

      const criteria = baseCriteria({
        hard_gates: {
          must_have: [],
          must_not_have: [
            {
              kind: "company",
              any_of: ["Anduril"],
              reason: "values"
            }
          ],
          must_not_contain_phrases: []
        }
      });

      const result = recordDiscoveredPostings(repos, {
        savedSearchId: ssId,
        runId,
        criteria,
        postings: [
          {
            source: "greenhouse",
            external_ref: "gh-1",
            url: "https://boards.greenhouse.io/anduril/jobs/1",
            title: "SWE",
            company: "Anduril",
            description_excerpt: null,
            onsite_locations: [],
            is_onsite_required: null,
            employment_type: null,
            inferred_seniority_signals: [],
            raw_metadata: {}
          }
        ],
        now: FIXED_NOW
      });

      assert.equal(result.pre_filter_rejected, 1);
      assert.equal(result.passed_to_eval, 0);

      const rows = repos.discoveredPostings.listBySearchRun(runId);
      assert.equal(rows[0].status, "pre_filter_rejected");
      assert.match(
        rows[0].pre_filter_reason_code ?? "",
        /^hard_gate:company:/
      );

      const sr = repos.searchRuns.findById(runId);
      assert.equal(sr!.results_pre_filtered, 1);
    } finally {
      conn.close();
    }
  });

  it("dedupes by (source, external_ref) and links prior job_evaluation_id", async () => {
    const conn = openDb({ path: ":memory:" });
    try {
      const repos = makeRepos(conn);
      const ssId = seedSavedSearch(conn);
      const runId1 = randomUUID();
      await startDiscovery(repos, {
        savedSearchId: ssId,
        runId: runId1,
        queries: [],
        connectorById: () => undefined,
        now: FIXED_NOW
      });

      const posting = {
        source: "greenhouse" as const,
        external_ref: "gh-42",
        url: "https://example.com/j/42",
        title: "SWE",
        company: "Example",
        description_excerpt: null,
        onsite_locations: [],
        is_onsite_required: null,
        employment_type: null,
        inferred_seniority_signals: [],
        raw_metadata: {}
      };

      const r1 = recordDiscoveredPostings(repos, {
        savedSearchId: ssId,
        runId: runId1,
        criteria: baseCriteria(),
        postings: [posting],
        now: FIXED_NOW
      });
      // Manually link first run's row to a synthetic eval id so we can
      // assert the duplicate-link behavior.
      const firstId = r1.ready_for_eval_ids[0];
      const evalId = randomUUID();
      repos.jobEvaluations.insert({
        id: evalId,
        input_hash: "hash",
        criteria_version_id: null,
        extractor_version: "extract_v1",
        verdict: "accepted",
        reason_code: "",
        short_circuited_at_stage: null,
        stages_run_json: "[]",
        facts_json: "{}",
        hard_gate_result_json: "{}",
        values_result_json: null,
        soft_score_result_json: null,
        mcp_invocation_id: null,
        created_at: FIXED_NOW().toISOString()
      });
      repos.discoveredPostings.updateStatus(firstId, "evaluated", {
        jobEvaluationId: evalId
      });

      const runId2 = randomUUID();
      await startDiscovery(repos, {
        savedSearchId: ssId,
        runId: runId2,
        queries: [],
        connectorById: () => undefined,
        now: FIXED_NOW
      });

      const r2 = recordDiscoveredPostings(repos, {
        savedSearchId: ssId,
        runId: runId2,
        criteria: baseCriteria(),
        postings: [posting],
        now: FIXED_NOW
      });
      assert.equal(r2.duplicates_skipped, 1);
      assert.equal(r2.passed_to_eval, 0);

      const dupRows = repos.discoveredPostings.listBySearchRun(runId2);
      assert.equal(dupRows.length, 1);
      assert.equal(dupRows[0].status, "duplicate");
      assert.equal(dupRows[0].job_evaluation_id, evalId);
    } finally {
      conn.close();
    }
  });
});

describe("evaluateAllSurvivors", () => {
  function newProvider() {
    return new MockJsonOutputProvider([
      {
        extractor_version: "extract_v1",
        title: "Engineer",
        company: "Example",
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
  }

  it("writes job_evaluations + provider_runs and updates discovered_postings", async () => {
    const conn = openDb({ path: ":memory:" });
    try {
      const repos = makeRepos(conn);
      const versions = new CandidateCriteriaVersionsRepository(conn.db);
      const versionId = randomUUID();
      versions.insert({
        id: versionId,
        version: 1,
        schema_version: "1.0.0",
        yaml_snapshot: "yaml",
        change_summary: "test",
        triggered_by_evaluation_id: null,
        created_at: "2026-04-29T00:00:00Z",
        created_via: "criteria_init"
      });

      const ssId = seedSavedSearch(conn);
      const runId = randomUUID();
      await startDiscovery(repos, {
        savedSearchId: ssId,
        runId,
        queries: [],
        connectorById: () => undefined,
        now: FIXED_NOW
      });

      const recorded = recordDiscoveredPostings(repos, {
        savedSearchId: ssId,
        runId,
        criteria: baseCriteria(),
        postings: [
          {
            source: "manual_paste",
            external_ref: null,
            url: "https://example.com/x",
            title: "Engineer",
            company: "Example",
            description_excerpt: null,
            onsite_locations: [],
            is_onsite_required: null,
            employment_type: null,
            inferred_seniority_signals: [],
            raw_metadata: { url: "https://example.com/x" }
          }
        ],
        now: FIXED_NOW
      });

      const out = await evaluateAllSurvivors(repos, {
        savedSearchId: ssId,
        runId,
        discoveredPostingIds: recorded.ready_for_eval_ids,
        criteria: baseCriteria(),
        criteriaVersionId: versionId,
        provider: newProvider(),
        mcpInvocationId: "inv-1",
        now: FIXED_NOW
      });

      assert.equal(out.evaluated, 1);
      assert.equal(out.outcomes.length, 1);
      assert.ok(out.outcomes[0].job_evaluation_id);

      // discovered_postings row updated to evaluated and linked.
      const row = repos.discoveredPostings.findById(
        out.outcomes[0].discovered_posting_id
      );
      assert.equal(row!.status, "evaluated");
      assert.equal(row!.job_evaluation_id, out.outcomes[0].job_evaluation_id);

      // job_evaluations row exists.
      const ev = repos.jobEvaluations.findById(out.outcomes[0].job_evaluation_id);
      assert.ok(ev);
      assert.equal(ev!.criteria_version_id, versionId);

      // provider_runs row exists.
      const pr = (
        repos.providerRuns as unknown as ProviderRunsRepository
      ).listByJobEvaluation(out.outcomes[0].job_evaluation_id);
      assert.ok(pr.length >= 1);
    } finally {
      conn.close();
    }
  });

  it("aggregates cost across postings and writes to SearchRun.total_cost_usd_cents", async () => {
    const conn = openDb({ path: ":memory:" });
    try {
      const repos = makeRepos(conn);
      const versions = new CandidateCriteriaVersionsRepository(conn.db);
      const versionId = randomUUID();
      versions.insert({
        id: versionId,
        version: 1,
        schema_version: "1.0.0",
        yaml_snapshot: "yaml",
        change_summary: "test",
        triggered_by_evaluation_id: null,
        created_at: "2026-04-29T00:00:00Z",
        created_via: "criteria_init"
      });

      const ssId = seedSavedSearch(conn);
      const runId = randomUUID();
      await startDiscovery(repos, {
        savedSearchId: ssId,
        runId,
        queries: [],
        connectorById: () => undefined,
        now: FIXED_NOW
      });

      const r = recordDiscoveredPostings(repos, {
        savedSearchId: ssId,
        runId,
        criteria: baseCriteria(),
        postings: [
          {
            source: "manual_paste",
            external_ref: null,
            url: "https://example.com/a",
            title: "A",
            company: "Co",
            description_excerpt: null,
            onsite_locations: [],
            is_onsite_required: null,
            employment_type: null,
            inferred_seniority_signals: [],
            raw_metadata: {}
          },
          {
            source: "manual_paste",
            external_ref: null,
            url: "https://example.com/b",
            title: "B",
            company: "Co",
            description_excerpt: null,
            onsite_locations: [],
            is_onsite_required: null,
            employment_type: null,
            inferred_seniority_signals: [],
            raw_metadata: {}
          }
        ],
        now: FIXED_NOW
      });

      const provider = new MockJsonOutputProvider([
        {
          extractor_version: "extract_v1",
          title: "A",
          company: "Co",
          seniority_signals: [],
          required_clearance: null,
          required_yoe: { min: null, max: null },
          industry_tags: [],
          required_onsite: { is_required: false, locations: [] },
          employment_type: null,
          work_authorization_constraints: [],
          stack: [],
          raw_text_excerpt: "a"
        },
        {
          extractor_version: "extract_v1",
          title: "B",
          company: "Co",
          seniority_signals: [],
          required_clearance: null,
          required_yoe: { min: null, max: null },
          industry_tags: [],
          required_onsite: { is_required: false, locations: [] },
          employment_type: null,
          work_authorization_constraints: [],
          stack: [],
          raw_text_excerpt: "b"
        }
      ]);

      const out = await evaluateAllSurvivors(repos, {
        savedSearchId: ssId,
        runId,
        discoveredPostingIds: r.ready_for_eval_ids,
        criteria: baseCriteria(),
        criteriaVersionId: versionId,
        provider,
        now: FIXED_NOW
      });

      assert.equal(out.evaluated, 2);
      // Sum is what got written.
      const sr = repos.searchRuns.findById(runId);
      assert.equal(sr!.total_cost_usd_cents, out.total_cost_usd_cents);
    } finally {
      conn.close();
    }
  });

  it("counts outcomes by verdict", async () => {
    const conn = openDb({ path: ":memory:" });
    try {
      const repos = makeRepos(conn);
      const versions = new CandidateCriteriaVersionsRepository(conn.db);
      const versionId = randomUUID();
      versions.insert({
        id: versionId,
        version: 1,
        schema_version: "1.0.0",
        yaml_snapshot: "yaml",
        change_summary: "test",
        triggered_by_evaluation_id: null,
        created_at: "2026-04-29T00:00:00Z",
        created_via: "criteria_init"
      });

      const ssId = seedSavedSearch(conn);
      const runId = randomUUID();
      await startDiscovery(repos, {
        savedSearchId: ssId,
        runId,
        queries: [],
        connectorById: () => undefined,
        now: FIXED_NOW
      });

      // Use criteria that triggers post-extraction rejection: must_not_have company "Anduril".
      const criteria = baseCriteria({
        hard_gates: {
          must_have: [],
          must_not_have: [
            { kind: "company", any_of: ["Anduril"], reason: "values" }
          ],
          must_not_contain_phrases: []
        }
      });

      // Posting itself is for "OtherCo" — so pre-extraction passes,
      // but extracted facts return company="Anduril" so post-extraction
      // rejects.
      const r = recordDiscoveredPostings(repos, {
        savedSearchId: ssId,
        runId,
        criteria,
        postings: [
          {
            source: "manual_paste",
            external_ref: null,
            url: "https://example.com/x",
            title: "Eng",
            company: "OtherCo",
            description_excerpt: null,
            onsite_locations: [],
            is_onsite_required: null,
            employment_type: null,
            inferred_seniority_signals: [],
            raw_metadata: {}
          }
        ],
        now: FIXED_NOW
      });

      const provider = new MockJsonOutputProvider([
        {
          extractor_version: "extract_v1",
          title: "Eng",
          company: "Anduril", // → rejected by post-extraction
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

      const out = await evaluateAllSurvivors(repos, {
        savedSearchId: ssId,
        runId,
        discoveredPostingIds: r.ready_for_eval_ids,
        criteria,
        criteriaVersionId: versionId,
        provider,
        now: FIXED_NOW
      });

      assert.equal(out.evaluated, 1);
      assert.equal(out.by_verdict.rejected, 1);
      assert.equal(out.by_verdict.accepted, 0);

      const sr = repos.searchRuns.findById(runId);
      assert.equal(sr!.results_rejected, 1);
      assert.equal(sr!.results_evaluated, 1);
    } finally {
      conn.close();
    }
  });
});

describe("finalizeSearchRun", () => {
  it("marks completed and bumps SavedSearch.last_run_at on success", async () => {
    const conn = openDb({ path: ":memory:" });
    try {
      const repos = makeRepos(conn);
      const ssId = seedSavedSearch(conn);
      const runId = randomUUID();
      await startDiscovery(repos, {
        savedSearchId: ssId,
        runId,
        queries: [],
        connectorById: () => undefined,
        now: FIXED_NOW
      });

      finalizeSearchRun(repos, {
        savedSearchId: ssId,
        runId,
        status: "completed",
        now: FIXED_NOW
      });

      const sr = repos.searchRuns.findById(runId);
      assert.equal(sr!.status, "completed");
      assert.ok(sr!.completed_at);

      const ss = repos.savedSearches.findById(ssId);
      assert.ok(ss!.last_run_at);
    } finally {
      conn.close();
    }
  });

  it("marks failed with error_message preserved", async () => {
    const conn = openDb({ path: ":memory:" });
    try {
      const repos = makeRepos(conn);
      const ssId = seedSavedSearch(conn);
      const runId = randomUUID();
      await startDiscovery(repos, {
        savedSearchId: ssId,
        runId,
        queries: [],
        connectorById: () => undefined,
        now: FIXED_NOW
      });

      finalizeSearchRun(repos, {
        savedSearchId: ssId,
        runId,
        status: "failed",
        errorMessage: "boom",
        now: FIXED_NOW
      });

      const sr = repos.searchRuns.findById(runId);
      assert.equal(sr!.status, "failed");
      assert.equal(sr!.error_message, "boom");

      // last_run_at NOT bumped on failure.
      const ss = repos.savedSearches.findById(ssId);
      assert.equal(ss!.last_run_at, null);
    } finally {
      conn.close();
    }
  });

  it("rejects status=failed without an errorMessage", async () => {
    const conn = openDb({ path: ":memory:" });
    try {
      const repos = makeRepos(conn);
      const ssId = seedSavedSearch(conn);
      const runId = randomUUID();
      await startDiscovery(repos, {
        savedSearchId: ssId,
        runId,
        queries: [],
        connectorById: () => undefined,
        now: FIXED_NOW
      });

      assert.throws(() => {
        finalizeSearchRun(repos, {
          savedSearchId: ssId,
          runId,
          status: "failed",
          now: FIXED_NOW
        });
      }, /errorMessage/);
    } finally {
      conn.close();
    }
  });
});
