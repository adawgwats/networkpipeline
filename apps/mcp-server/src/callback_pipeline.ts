/**
 * Glue between the evaluator's pure state machine and the
 * `pending_evaluations` SQLite table.
 *
 * Owns all the JSON serialization back-and-forth so the state machine
 * itself stays pure. Tools (evaluate_job, record_llm_result,
 * bulk_evaluate_jobs, run_saved_search) call into here.
 */

import { randomUUID } from "node:crypto";
import type { CandidateCriteria } from "@networkpipeline/criteria";
import type {
  PendingEvaluationRow,
  PendingEvaluationStatus
} from "@networkpipeline/db";
import {
  applyLLMResult,
  hashPostingText,
  nextStep,
  preExtractionGateCheck,
  type DiscoveredPostingMetadata,
  type EvaluationResult,
  type ExtractedJobFacts,
  type GateResult,
  type PendingEvalState,
  type PendingLLMCall,
  type ProviderRun,
  type StepResult,
  type ValuesCheckResult
} from "@networkpipeline/evaluator";
import type { Repositories } from "./runtime.js";
import { persistEvaluationResult } from "./persistence.js";

/**
 * Insert a fresh pending_evaluations row in status='awaiting_extract'.
 * Caller is expected to have already short-circuited any deterministic
 * pre-extraction rejection — those should NOT land in pending.
 */
export type CreatePendingArgs = {
  postingText: string;
  sourceUrl?: string | null;
  metadata?: DiscoveredPostingMetadata;
  criteria: CandidateCriteria;
  criteriaVersionId: string;
  searchRunId?: string | null;
  discoveredPostingId?: string | null;
  mcpInvocationId?: string | null;
};

export function createPendingEvaluation(
  repos: Repositories,
  args: CreatePendingArgs,
  now: () => Date = () => new Date()
): { id: string } {
  const id = randomUUID();
  const ts = now().toISOString();
  repos.pendingEvaluations.insert({
    id,
    posting_text: args.postingText,
    source_url: args.sourceUrl ?? null,
    metadata_json: args.metadata ? JSON.stringify(args.metadata) : null,
    criteria_version_id: args.criteriaVersionId,
    criteria_snapshot_json: JSON.stringify(args.criteria),
    search_run_id: args.searchRunId ?? null,
    discovered_posting_id: args.discoveredPostingId ?? null,
    mcp_invocation_id: args.mcpInvocationId ?? null,
    status: "awaiting_extract",
    current_call_id: null,
    current_call_attempts: 0,
    facts_json: null,
    hard_gate_result_json: null,
    values_result_json: null,
    result_json: null,
    error_message: null,
    provider_runs_json: "[]",
    created_at: ts,
    updated_at: ts
  });
  return { id };
}

/**
 * Reconstruct the parsed PendingEvalState the state machine consumes
 * from a row's serialized columns.
 */
export function rowToState(row: PendingEvaluationRow): PendingEvalState {
  return {
    posting_text: row.posting_text,
    source_url: row.source_url,
    status: row.status as PendingEvalState["status"],
    current_call_id: row.current_call_id,
    current_call_attempts: row.current_call_attempts,
    facts: row.facts_json
      ? (JSON.parse(row.facts_json) as ExtractedJobFacts)
      : null,
    hard_gate_result: row.hard_gate_result_json
      ? (JSON.parse(row.hard_gate_result_json) as GateResult)
      : null,
    values_result: row.values_result_json
      ? (JSON.parse(row.values_result_json) as ValuesCheckResult)
      : null,
    provider_runs: row.provider_runs_json
      ? (JSON.parse(row.provider_runs_json) as ProviderRun[])
      : []
  };
}

/**
 * Re-derive metadata from the persisted row's `metadata_json` if any.
 */
export function rowMetadata(
  row: PendingEvaluationRow
): DiscoveredPostingMetadata | undefined {
  if (!row.metadata_json) return undefined;
  return JSON.parse(row.metadata_json) as DiscoveredPostingMetadata;
}

/**
 * Re-derive criteria from the persisted row. Frozen at the time the
 * pending row was created so an in-flight evaluation isn't perturbed
 * by mid-run criteria edits.
 */
export function rowCriteria(row: PendingEvaluationRow): CandidateCriteria {
  return JSON.parse(row.criteria_snapshot_json) as CandidateCriteria;
}

/**
 * Drive the state machine's `nextStep` from a freshly-created or
 * post-record_llm_result row. Persists the resulting transition:
 *   - needs_llm → updates row with new current_call_id + status
 *   - completed → marks row completed, persists job_evaluations +
 *     provider_runs, returns the EvaluationResult
 *   - failed    → marks row failed, returns null
 */
export type AdvanceResult =
  | {
      kind: "needs_llm";
      pending_evaluation_id: string;
      call: PendingLLMCall;
    }
  | {
      kind: "completed";
      pending_evaluation_id: string;
      result: EvaluationResult;
      job_evaluation_id: string;
    }
  | {
      kind: "failed";
      pending_evaluation_id: string;
      reason: string;
    };

/**
 * Advance the state machine for a row. Used both to issue the FIRST
 * pending_llm_call right after row creation and to follow up on
 * record_llm_result. The latter passes `llmResult`; the former passes
 * undefined.
 */
export function advancePending(
  repos: Repositories,
  row: PendingEvaluationRow,
  llmResult: unknown | undefined,
  now: () => Date = () => new Date()
): AdvanceResult {
  const state = rowToState(row);
  const criteria = rowCriteria(row);
  const metadata = rowMetadata(row);
  const ts = now().toISOString();

  let stepResult: StepResult;
  let attemptsToWrite = state.current_call_attempts ?? 0;
  let providerRunsToWrite = state.provider_runs ?? [];
  let factsToWrite: ExtractedJobFacts | null | undefined = undefined;
  let valuesToWrite: ValuesCheckResult | null | undefined = undefined;

  if (llmResult !== undefined) {
    const applied = applyLLMResult({ pending: state, criteria, metadata }, llmResult);
    stepResult = applied.next;
    if (applied.patch.current_call_attempts !== undefined) {
      attemptsToWrite = applied.patch.current_call_attempts;
    }
    if (applied.patch.facts !== undefined) factsToWrite = applied.patch.facts;
    if (applied.patch.values_result !== undefined) {
      valuesToWrite = applied.patch.values_result;
    }
    if (applied.patch.provider_runs !== undefined) {
      providerRunsToWrite = applied.patch.provider_runs;
    }
  } else {
    stepResult = nextStep({ pending: state, criteria, metadata });
  }

  // ── needs_llm ───────────────────────────────────────────────────
  if (stepResult.kind === "needs_llm") {
    const nextStatus: PendingEvaluationStatus = stepResult.nextStatus;
    repos.pendingEvaluations.update(
      row.id,
      {
        status: nextStatus,
        current_call_id: stepResult.call.call_id,
        current_call_attempts: attemptsToWrite,
        facts_json:
          factsToWrite !== undefined
            ? factsToWrite
              ? JSON.stringify(factsToWrite)
              : null
            : undefined,
        values_result_json:
          valuesToWrite !== undefined
            ? valuesToWrite
              ? JSON.stringify(valuesToWrite)
              : null
            : undefined,
        provider_runs_json: JSON.stringify(providerRunsToWrite)
      },
      ts
    );
    return {
      kind: "needs_llm",
      pending_evaluation_id: row.id,
      call: stepResult.call
    };
  }

  // ── failed ──────────────────────────────────────────────────────
  if (stepResult.kind === "failed") {
    repos.pendingEvaluations.markFailed(row.id, stepResult.reason, ts);
    return {
      kind: "failed",
      pending_evaluation_id: row.id,
      reason: stepResult.reason
    };
  }

  // ── completed ───────────────────────────────────────────────────
  // Override input_hash with the canonical hash (the state machine
  // uses posting_text but we want byte-equivalence with the
  // synchronous pipeline's hashPostingText output, which it already
  // is — but make it explicit here for safety).
  const finalResult: EvaluationResult = {
    ...stepResult.result,
    input_hash: hashPostingText(row.posting_text)
  };

  // Persist job_evaluations + provider_runs.
  const persisted = persistEvaluationResult(repos, finalResult, {
    mcpInvocationId: row.mcp_invocation_id,
    criteriaVersionId: row.criteria_version_id
  });

  // Link the discovered_posting (if any) to the new job_evaluation
  // and bump its status to evaluated. SearchRun counters also bump.
  if (row.discovered_posting_id) {
    repos.discoveredPostings.updateStatus(
      row.discovered_posting_id,
      "evaluated",
      { jobEvaluationId: persisted.jobEvaluationId }
    );
  }
  if (row.search_run_id) {
    bumpSearchRunCounters(repos, row.search_run_id, finalResult);
  }

  // Mark the row completed AFTER persisting (so a crash mid-write
  // surfaces as "failed" semantically, not as "evaluated but never
  // persisted").
  repos.pendingEvaluations.markCompleted(
    row.id,
    JSON.stringify(finalResult),
    ts
  );

  return {
    kind: "completed",
    pending_evaluation_id: row.id,
    result: finalResult,
    job_evaluation_id: persisted.jobEvaluationId
  };
}

/**
 * Bump SearchRun counters for a single completed evaluation. Mirrors
 * the per-verdict accounting `evaluateAllSurvivors` writes after each
 * synchronous evaluation, but operates per-row so the bulk loop's
 * counters update as rows complete.
 */
function bumpSearchRunCounters(
  repos: Repositories,
  searchRunId: string,
  result: EvaluationResult
): void {
  const existing = repos.searchRuns.findById(searchRunId);
  if (!existing) return;
  const v = result.verdict;
  const total = result.provider_runs.reduce(
    (acc, r) =>
      r.cost_usd_cents !== null && r.provider !== "skipped"
        ? acc + r.cost_usd_cents
        : acc,
    0
  );
  repos.searchRuns.updateProgress(searchRunId, {
    results_evaluated: (existing.results_evaluated ?? 0) + 1,
    results_accepted:
      (existing.results_accepted ?? 0) + (v === "accepted" ? 1 : 0),
    results_below_threshold:
      (existing.results_below_threshold ?? 0) +
      (v === "below_threshold" ? 1 : 0),
    results_rejected:
      (existing.results_rejected ?? 0) + (v === "rejected" ? 1 : 0),
    results_needs_review:
      (existing.results_needs_review ?? 0) + (v === "needs_review" ? 1 : 0),
    total_cost_usd_cents: (existing.total_cost_usd_cents ?? 0) + total
  });
}

/**
 * Run pre-extraction gates server-side over `metadata`. Returns the
 * GateResult so callers can short-circuit obvious deterministic
 * rejections without paying for a pending_evaluation round-trip.
 *
 * Returns `null` when the caller didn't supply metadata — in that case
 * the metadata-only gate set has nothing to act on; defer to the full
 * post-extraction gate pass.
 */
export function runPreExtractionGates(
  metadata: DiscoveredPostingMetadata | undefined,
  criteria: CandidateCriteria
): GateResult | null {
  if (!metadata) return null;
  return preExtractionGateCheck(metadata, criteria);
}

/**
 * Build a synthetic EvaluationResult for a posting that was rejected
 * at the pre-extraction stage. Persisted via persistEvaluationResult
 * the same as any other rejection so dedup, observability, and the
 * eval harness see uniform records.
 *
 * `facts` is empty-shaped (we never extracted) but conforms to the
 * extractor schema — title/company carry whatever metadata we have.
 */
export function preExtractionRejectionResult(args: {
  metadata: DiscoveredPostingMetadata;
  gate: GateResult;
  criteriaVersion: number;
  postingText: string;
}): EvaluationResult {
  const facts: ExtractedJobFacts = {
    extractor_version: "extract_v1",
    title: args.metadata.title,
    company: args.metadata.company,
    seniority_signals: args.metadata.inferred_seniority_signals ?? [],
    required_clearance: null,
    required_yoe: { min: null, max: null },
    industry_tags: [],
    required_onsite: {
      is_required: args.metadata.is_onsite_required ?? false,
      locations: args.metadata.onsite_locations ?? []
    },
    employment_type: args.metadata.employment_type ?? null,
    work_authorization_constraints: [],
    stack: [],
    raw_text_excerpt:
      args.metadata.description_excerpt ??
      `${args.metadata.title} at ${args.metadata.company}`
  };
  if (args.gate.pass) {
    throw new Error(
      "preExtractionRejectionResult: gate result must not be a pass"
    );
  }
  return {
    verdict: "rejected",
    reason_code: args.gate.reason_code,
    short_circuited_at_stage: "hard_gate",
    stages_run: ["hard_gate"],
    facts,
    hard_gate_result: args.gate,
    values_result: null,
    soft_score_result: null,
    provider_runs: [],
    input_hash: hashPostingText(args.postingText),
    extractor_version: "extract_v1",
    criteria_version: args.criteriaVersion
  };
}
