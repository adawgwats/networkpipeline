import type { CandidateCriteria } from "@networkpipeline/criteria";
import {
  extractJobFacts,
  type ExtractedJobFacts,
  type ExtractJobFactsInput
} from "../extract/index.js";
import { hardGateCheck, type GateResult } from "../gates/index.js";
import type { JsonOutputProvider, ProviderRun } from "../provider/types.js";
import { softScore, type SoftScoreResult } from "../score/index.js";
import { valuesCheck, type ValuesCheckResult } from "../values/index.js";

export type EvaluationVerdict =
  | "accepted"
  | "rejected"
  | "below_threshold"
  | "needs_review";

export type EvaluationStage =
  | "extract"
  | "hard_gate"
  | "values_check"
  | "soft_score";

export type EvaluationResult = {
  verdict: EvaluationVerdict;
  /**
   * Stable reason code per docs/criteria.md §11. Empty string when
   * the verdict is "accepted".
   */
  reason_code: string;
  /**
   * Stage at which the pipeline short-circuited, if any. Always set
   * for rejects and below_threshold/needs_review verdicts. Set to
   * `null` only on accepted verdicts that ran the full pipeline.
   */
  short_circuited_at_stage: EvaluationStage | null;
  /** Stages that were actually executed in this evaluation. */
  stages_run: EvaluationStage[];
  facts: ExtractedJobFacts;
  hard_gate_result: GateResult;
  values_result: ValuesCheckResult | null;
  soft_score_result: SoftScoreResult | null;
  input_hash: string;
  extractor_version: string;
  criteria_version: number;
  /**
   * Every LLM call made during this evaluation. Skipped stages
   * contribute "skipped" runs so the count is stable per verdict shape.
   */
  provider_runs: ProviderRun[];
};

/**
 * evaluateJob — the full pipeline orchestrator.
 *
 * Composes the four stages with short-circuit semantics:
 *   extract → hard_gate (pure code, may reject)
 *           → values_check (LLM, may reject or flag needs_review)
 *           → soft_score (LLM, may flag below_threshold)
 *
 * No persistence here — this is pure pipeline composition. The MCP
 * server (apps/mcp-server) is responsible for persisting the returned
 * EvaluationResult to job_evaluations and writing provider_runs rows.
 */
export async function evaluateJob(
  provider: JsonOutputProvider,
  input: ExtractJobFactsInput,
  criteria: CandidateCriteria
): Promise<EvaluationResult> {
  const provider_runs: ProviderRun[] = [];
  const stages_run: EvaluationStage[] = [];

  // ── Stage 1: extract ───────────────────────────────────────────────
  stages_run.push("extract");
  const extracted = await extractJobFacts(provider, input);
  provider_runs.push(extracted.run);

  const baseShape = {
    facts: extracted.facts,
    input_hash: extracted.input_hash,
    extractor_version: extracted.extractor_version,
    criteria_version: criteria.version
  } as const;

  // ── Stage 2: hard gates (pure code) ───────────────────────────────
  stages_run.push("hard_gate");
  const gateResult = hardGateCheck(extracted.facts, criteria);
  if (!gateResult.pass) {
    return {
      verdict: "rejected",
      reason_code: gateResult.reason_code,
      short_circuited_at_stage: "hard_gate",
      stages_run,
      hard_gate_result: gateResult,
      values_result: null,
      soft_score_result: null,
      provider_runs,
      ...baseShape
    };
  }

  // ── Stage 2b: values_check (narrow LLM) ───────────────────────────
  stages_run.push("values_check");
  const valuesOut = await valuesCheck(provider, {
    facts: extracted.facts,
    criteria
  });
  provider_runs.push(valuesOut.run);

  if (valuesOut.result.decision === "reject") {
    return {
      verdict: "rejected",
      reason_code: valuesOut.result.reason_code,
      short_circuited_at_stage: "values_check",
      stages_run,
      hard_gate_result: gateResult,
      values_result: valuesOut.result,
      soft_score_result: null,
      provider_runs,
      ...baseShape
    };
  }
  if (valuesOut.result.decision === "needs_review") {
    return {
      verdict: "needs_review",
      reason_code: "values:needs_review",
      short_circuited_at_stage: "values_check",
      stages_run,
      hard_gate_result: gateResult,
      values_result: valuesOut.result,
      soft_score_result: null,
      provider_runs,
      ...baseShape
    };
  }

  // ── Stage 3: soft_score ───────────────────────────────────────────
  stages_run.push("soft_score");
  const scoreOut = await softScore(provider, {
    facts: extracted.facts,
    criteria
  });
  provider_runs.push(scoreOut.run);

  if (scoreOut.result.below_threshold) {
    return {
      verdict: "below_threshold",
      reason_code: scoreOut.result.reason_code,
      short_circuited_at_stage: "soft_score",
      stages_run,
      hard_gate_result: gateResult,
      values_result: valuesOut.result,
      soft_score_result: scoreOut.result,
      provider_runs,
      ...baseShape
    };
  }

  return {
    verdict: "accepted",
    reason_code: "",
    short_circuited_at_stage: null,
    stages_run,
    hard_gate_result: gateResult,
    values_result: valuesOut.result,
    soft_score_result: scoreOut.result,
    provider_runs,
    ...baseShape
  };
}
