/**
 * Pure state machine for the callback-pipeline architecture.
 *
 * Drives an evaluation through extract → hard_gate → values → score
 * one LLM round-trip at a time. NO database access; the MCP-side glue
 * (apps/mcp-server) maps results back into pending_evaluations rows.
 *
 * Re-uses every existing prompt + Zod schema from the synchronous
 * pipeline. Adding a new stage means: new prompt module, new schema,
 * new branch in nextStep / applyLLMResult — nothing else.
 */

import { randomUUID } from "node:crypto";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { CandidateCriteria } from "@networkpipeline/criteria";
import {
  EXTRACTOR_VERSION,
  EXTRACT_PROMPT_ID,
  EXTRACT_SYSTEM_PROMPT,
  buildExtractUserPrompt,
  extractedJobFactsSchema,
  hashPostingText,
  type ExtractedJobFacts
} from "../extract/index.js";
import {
  hardGateCheck,
  type DiscoveredPostingMetadata,
  type GateResult
} from "../gates/index.js";
import {
  applyThreshold as applySoftScoreThreshold,
  buildSoftScoreSystemPrompt,
  buildSoftScoreUserPrompt,
  NO_PREFERENCES_NEUTRAL_SCORE,
  SOFT_SCORE_PROMPT_ID,
  softScoreVerdictRawSchema,
  type SoftScoreResult,
  type SoftScoreVerdictRaw
} from "../score/index.js";
import {
  applyThresholds as applyValuesThresholds,
  buildValuesUserPrompt,
  VALUES_PROMPT_ID,
  VALUES_SYSTEM_PROMPT,
  valuesVerdictRawSchema,
  type ValuesCheckResult,
  type ValuesVerdictRaw
} from "../values/index.js";
import type { ProviderRun } from "../provider/index.js";
import type { EvaluationResult, EvaluationStage } from "./evaluate.js";
import {
  composeSystemPromptWithSchema,
  type PendingLLMCall,
  type PendingLLMStage
} from "./pending.js";

/**
 * Subset of `pending_evaluations` columns the state machine needs.
 * Production code reads these from the row; tests pass them inline.
 *
 * `status` and the `_json` fields are optional because tests typically
 * construct them progressively. The state machine treats absence of a
 * field as "stage not yet completed" rather than as an error.
 */
export type PendingEvalState = {
  /** Required for building the extract prompt. */
  posting_text: string;
  source_url?: string | null;
  status:
    | "awaiting_extract"
    | "awaiting_values"
    | "awaiting_score"
    | "completed"
    | "failed";
  current_call_id?: string | null;
  current_call_attempts?: number;
  /** Parsed facts after the extract round-trip. */
  facts?: ExtractedJobFacts | null;
  /** Result of deterministic hard-gate stage. */
  hard_gate_result?: GateResult | null;
  /** Parsed result after the values round-trip. */
  values_result?: ValuesCheckResult | null;
  /** Accumulated synthetic ProviderRuns for observability. */
  provider_runs?: ProviderRun[];
};

export type StepInput = {
  pending: PendingEvalState;
  criteria: CandidateCriteria;
  metadata?: DiscoveredPostingMetadata;
};

export type NextStatus =
  | "awaiting_extract"
  | "awaiting_values"
  | "awaiting_score";

export type StepResult =
  | { kind: "needs_llm"; call: PendingLLMCall; nextStatus: NextStatus }
  | { kind: "completed"; result: EvaluationResult }
  | { kind: "failed"; reason: string };

/**
 * Maximum extra retries on Zod-validation failure for a single stage's
 * LLM result. After this many retries the row is marked failed.
 */
export const MAX_RECORD_RETRIES = 1;

/**
 * Inspect the pending state and return either the next LLM-call
 * request, a final EvaluationResult, or a failure. Pure.
 *
 * Stage transitions:
 *   pending.status='awaiting_extract' AND no facts
 *     → emit extract pending_llm_call
 *   facts present, no hard_gate_result
 *     → run hard gates (deterministic). On reject → completed
 *       (rejected). On pass → emit values pending_llm_call
 *       (or skip values stage if no refusals, then emit score
 *       pending_llm_call, or skip score stage if no preferences).
 *   values_result present, no soft_score_result
 *     → emit score pending_llm_call (or short-circuit + complete on
 *       values reject / needs_review).
 */
export function nextStep(input: StepInput): StepResult {
  const { pending, criteria, metadata } = input;

  // ── Stage 1: extract ─────────────────────────────────────────────
  if (!pending.facts) {
    return {
      kind: "needs_llm",
      nextStatus: "awaiting_extract",
      call: buildExtractCall({
        posting_text: pending.posting_text,
        source_url: pending.source_url ?? null
      })
    };
  }

  // ── Stage 2: hard gates (pure code) ─────────────────────────────
  let gateResult = pending.hard_gate_result ?? null;
  if (!gateResult) {
    gateResult = hardGateCheck(pending.facts, criteria, metadata);
  }
  if (!gateResult.pass) {
    return {
      kind: "completed",
      result: composeResult({
        verdict: "rejected",
        reason_code: gateResult.reason_code,
        short_circuited_at_stage: "hard_gate",
        stages_run: ["extract", "hard_gate"],
        facts: pending.facts,
        hard_gate_result: gateResult,
        values_result: null,
        soft_score_result: null,
        provider_runs: pending.provider_runs ?? [],
        criteria_version: criteria.version,
        posting_text: pending.posting_text
      })
    };
  }

  // ── Stage 2b: values_check ──────────────────────────────────────
  if (!pending.values_result) {
    // Short-circuit when criteria has no refusals (mirrors valuesCheck).
    if (criteria.values_refusals.length === 0) {
      const synthetic: ValuesCheckResult = {
        decision: "clear",
        raw: {
          violation: false,
          matched_refusal: null,
          excerpt: null,
          confidence: 1.0,
          rationale: "No values refusals configured."
        },
        reason_code: ""
      };
      // Recurse — values now considered "done"; immediately try score.
      return nextStep({
        pending: {
          ...pending,
          values_result: synthetic,
          provider_runs: [
            ...(pending.provider_runs ?? []),
            valuesSkippedRun()
          ],
          hard_gate_result: gateResult
        },
        criteria,
        metadata
      });
    }
    return {
      kind: "needs_llm",
      nextStatus: "awaiting_values",
      call: buildValuesCall({
        facts: pending.facts,
        refusals: criteria.values_refusals
      })
    };
  }

  // values_result present — branch on its decision.
  if (pending.values_result.decision === "reject") {
    return {
      kind: "completed",
      result: composeResult({
        verdict: "rejected",
        reason_code: pending.values_result.reason_code,
        short_circuited_at_stage: "values_check",
        stages_run: ["extract", "hard_gate", "values_check"],
        facts: pending.facts,
        hard_gate_result: gateResult,
        values_result: pending.values_result,
        soft_score_result: null,
        provider_runs: pending.provider_runs ?? [],
        criteria_version: criteria.version,
        posting_text: pending.posting_text
      })
    };
  }
  if (pending.values_result.decision === "needs_review") {
    return {
      kind: "completed",
      result: composeResult({
        verdict: "needs_review",
        reason_code: "values:needs_review",
        short_circuited_at_stage: "values_check",
        stages_run: ["extract", "hard_gate", "values_check"],
        facts: pending.facts,
        hard_gate_result: gateResult,
        values_result: pending.values_result,
        soft_score_result: null,
        provider_runs: pending.provider_runs ?? [],
        criteria_version: criteria.version,
        posting_text: pending.posting_text
      })
    };
  }

  // ── Stage 3: soft_score ─────────────────────────────────────────
  // Short-circuit when criteria has no preferences (mirrors softScore).
  const totalPrefs =
    criteria.soft_preferences.positive.length +
    criteria.soft_preferences.negative.length;
  if (totalPrefs === 0) {
    const syntheticRaw: SoftScoreVerdictRaw = {
      score: NO_PREFERENCES_NEUTRAL_SCORE,
      contributions: [],
      rationale:
        "No soft preferences configured; returning neutral score (0.5)."
    };
    const result = applySoftScoreThreshold(syntheticRaw, criteria);
    return {
      kind: "completed",
      result: composeResult({
        verdict: result.below_threshold ? "below_threshold" : "accepted",
        reason_code: result.below_threshold ? result.reason_code : "",
        short_circuited_at_stage: result.below_threshold
          ? "soft_score"
          : null,
        stages_run: ["extract", "hard_gate", "values_check", "soft_score"],
        facts: pending.facts,
        hard_gate_result: gateResult,
        values_result: pending.values_result,
        soft_score_result: result,
        provider_runs: [
          ...(pending.provider_runs ?? []),
          softScoreSkippedRun()
        ],
        criteria_version: criteria.version,
        posting_text: pending.posting_text
      })
    };
  }

  return {
    kind: "needs_llm",
    nextStatus: "awaiting_score",
    call: buildSoftScoreCall({
      facts: pending.facts,
      criteria
    })
  };
}

/**
 * Apply an LLM result to a pending state. Returns the patch to apply
 * to the pending row plus the next StepResult (which the caller maps
 * onto either another `needs_llm` / `completed` / `failed` outcome).
 *
 * Validates the result against the stage's Zod schema before mutating
 * state. On validation failure, increments the retry counter and
 * returns a fresh PendingLLMCall with the same call_id and the
 * validation errors embedded in the user prompt. After
 * MAX_RECORD_RETRIES, returns `kind: "failed"` so the caller can mark
 * the row failed.
 */
export function applyLLMResult(
  input: StepInput,
  llmResult: unknown
): {
  /**
   * Patch to apply to the pending row. Combine with input.pending to
   * get the next state. Includes provider_runs accumulation so the
   * caller can persist them on completion.
   */
  patch: Partial<PendingEvalState> & {
    /** Always set; bump even on retry so observability tracks attempts. */
    current_call_attempts: number;
  };
  next: StepResult;
} {
  const { pending, criteria, metadata } = input;
  const stage = inferStageFromStatus(pending.status);
  if (stage === null) {
    return {
      patch: { current_call_attempts: pending.current_call_attempts ?? 0 },
      next: {
        kind: "failed",
        reason: `applyLLMResult: pending status ${pending.status} is not awaiting an LLM result`
      }
    };
  }

  const attempts = (pending.current_call_attempts ?? 0) + 1;
  const provider_runs = pending.provider_runs ?? [];

  switch (stage) {
    case "extract": {
      const parsed = extractedJobFactsSchema.safeParse(llmResult);
      if (!parsed.success) {
        return handleValidationFailure({
          pending,
          attempts,
          stage,
          issues: parsed.error.issues,
          buildRetry: () =>
            buildExtractCall(
              {
                posting_text: pending.posting_text,
                source_url: pending.source_url ?? null
              },
              { feedbackIssues: parsed.error.issues }
            ),
          retryStatus: "awaiting_extract"
        });
      }
      const newRun = syntheticProviderRun(EXTRACT_PROMPT_ID, attempts - 1);
      const updatedPending: PendingEvalState = {
        ...pending,
        facts: parsed.data,
        provider_runs: [...provider_runs, newRun]
      };
      const next = nextStep({
        pending: updatedPending,
        criteria,
        metadata
      });
      return {
        patch: {
          facts: parsed.data,
          provider_runs: updatedPending.provider_runs,
          current_call_attempts: 0
        },
        next
      };
    }
    case "values": {
      const parsed = valuesVerdictRawSchema.safeParse(llmResult);
      if (!parsed.success) {
        return handleValidationFailure({
          pending,
          attempts,
          stage,
          issues: parsed.error.issues,
          buildRetry: () =>
            buildValuesCall(
              {
                facts: pending.facts!,
                refusals: criteria.values_refusals
              },
              { feedbackIssues: parsed.error.issues }
            ),
          retryStatus: "awaiting_values"
        });
      }
      const result: ValuesCheckResult = applyValuesThresholds(
        parsed.data,
        criteria.values_refusals
      );
      const newRun = syntheticProviderRun(VALUES_PROMPT_ID, attempts - 1);
      const updatedPending: PendingEvalState = {
        ...pending,
        values_result: result,
        provider_runs: [...provider_runs, newRun]
      };
      const next = nextStep({
        pending: updatedPending,
        criteria,
        metadata
      });
      return {
        patch: {
          values_result: result,
          provider_runs: updatedPending.provider_runs,
          current_call_attempts: 0
        },
        next
      };
    }
    case "soft_score": {
      const parsed = softScoreVerdictRawSchema.safeParse(llmResult);
      if (!parsed.success) {
        return handleValidationFailure({
          pending,
          attempts,
          stage,
          issues: parsed.error.issues,
          buildRetry: () =>
            buildSoftScoreCall(
              { facts: pending.facts!, criteria },
              { feedbackIssues: parsed.error.issues }
            ),
          retryStatus: "awaiting_score"
        });
      }
      const result: SoftScoreResult = applySoftScoreThreshold(
        parsed.data,
        criteria
      );
      const newRun = syntheticProviderRun(SOFT_SCORE_PROMPT_ID, attempts - 1);
      // Compose the final EvaluationResult.
      const final = composeResult({
        verdict: result.below_threshold ? "below_threshold" : "accepted",
        reason_code: result.below_threshold ? result.reason_code : "",
        short_circuited_at_stage: result.below_threshold
          ? "soft_score"
          : null,
        stages_run: ["extract", "hard_gate", "values_check", "soft_score"],
        facts: pending.facts!,
        hard_gate_result: pending.hard_gate_result ?? {
          pass: true,
          gates_evaluated: []
        },
        values_result: pending.values_result ?? null,
        soft_score_result: result,
        provider_runs: [...provider_runs, newRun],
        criteria_version: criteria.version,
        posting_text: pending.posting_text
      });
      return {
        patch: {
          provider_runs: [...provider_runs, newRun],
          current_call_attempts: 0
        },
        next: { kind: "completed", result: final }
      };
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────

function inferStageFromStatus(
  status: PendingEvalState["status"]
): PendingLLMStage | null {
  switch (status) {
    case "awaiting_extract":
      return "extract";
    case "awaiting_values":
      return "values";
    case "awaiting_score":
      return "soft_score";
    default:
      return null;
  }
}

type RetryArgs = {
  pending: PendingEvalState;
  attempts: number;
  stage: PendingLLMStage;
  issues: unknown;
  buildRetry: () => PendingLLMCall;
  retryStatus: NextStatus;
};

function handleValidationFailure(args: RetryArgs): {
  patch: Partial<PendingEvalState> & { current_call_attempts: number };
  next: StepResult;
} {
  if (args.attempts > MAX_RECORD_RETRIES) {
    return {
      patch: { current_call_attempts: args.attempts },
      next: {
        kind: "failed",
        reason: `${args.stage} stage exhausted ${args.attempts} attempts; validation issues: ${JSON.stringify(args.issues)}`
      }
    };
  }
  const retry = args.buildRetry();
  return {
    patch: { current_call_attempts: args.attempts },
    next: { kind: "needs_llm", call: retry, nextStatus: args.retryStatus }
  };
}

type ExtractCallInput = {
  posting_text: string;
  source_url: string | null;
};

function buildExtractCall(
  input: ExtractCallInput,
  feedback?: { feedbackIssues?: unknown }
): PendingLLMCall {
  const jsonSchema = zodToJsonSchema(extractedJobFactsSchema, {
    $refStrategy: "none",
    target: "openApi3"
  }) as Record<string, unknown>;
  const baseUser = buildExtractUserPrompt({
    text: input.posting_text,
    sourceUrl: input.source_url ?? undefined
  });
  const userPrompt = feedback?.feedbackIssues
    ? appendValidationFeedback(baseUser, feedback.feedbackIssues)
    : baseUser;
  return {
    call_id: randomUUID(),
    prompt_id: EXTRACT_PROMPT_ID,
    stage: "extract",
    system_prompt: composeSystemPromptWithSchema(
      EXTRACT_SYSTEM_PROMPT,
      jsonSchema
    ),
    user_prompt: userPrompt,
    json_schema: jsonSchema,
    instructions: `Generate the extract_job_facts JSON for this posting (extractor_version: ${EXTRACTOR_VERSION}). Then call the record_llm_result tool with this call_id.`
  };
}

type ValuesCallInput = {
  facts: ExtractedJobFacts;
  refusals: readonly string[];
};

function buildValuesCall(
  input: ValuesCallInput,
  feedback?: { feedbackIssues?: unknown }
): PendingLLMCall {
  const jsonSchema = zodToJsonSchema(valuesVerdictRawSchema, {
    $refStrategy: "none",
    target: "openApi3"
  }) as Record<string, unknown>;
  const baseUser = buildValuesUserPrompt(input.facts, input.refusals);
  const userPrompt = feedback?.feedbackIssues
    ? appendValidationFeedback(baseUser, feedback.feedbackIssues)
    : baseUser;
  return {
    call_id: randomUUID(),
    prompt_id: VALUES_PROMPT_ID,
    stage: "values",
    system_prompt: composeSystemPromptWithSchema(
      VALUES_SYSTEM_PROMPT,
      jsonSchema
    ),
    user_prompt: userPrompt,
    json_schema: jsonSchema,
    instructions:
      "Generate the values_check verdict JSON for this posting. Then call the record_llm_result tool with this call_id."
  };
}

type SoftScoreCallInput = {
  facts: ExtractedJobFacts;
  criteria: CandidateCriteria;
};

function buildSoftScoreCall(
  input: SoftScoreCallInput,
  feedback?: { feedbackIssues?: unknown }
): PendingLLMCall {
  const jsonSchema = zodToJsonSchema(softScoreVerdictRawSchema, {
    $refStrategy: "none",
    target: "openApi3"
  }) as Record<string, unknown>;
  const systemPrompt = buildSoftScoreSystemPrompt(input.criteria);
  const baseUser = buildSoftScoreUserPrompt(input.facts);
  const userPrompt = feedback?.feedbackIssues
    ? appendValidationFeedback(baseUser, feedback.feedbackIssues)
    : baseUser;
  return {
    call_id: randomUUID(),
    prompt_id: SOFT_SCORE_PROMPT_ID,
    stage: "soft_score",
    system_prompt: composeSystemPromptWithSchema(systemPrompt, jsonSchema),
    user_prompt: userPrompt,
    json_schema: jsonSchema,
    instructions:
      "Generate the soft_score JSON for this posting. Then call the record_llm_result tool with this call_id."
  };
}

function appendValidationFeedback(
  baseUser: string,
  issues: unknown
): string {
  return `${baseUser}\n\nYour previous JSON response did not match the required schema. Validation errors:\n${JSON.stringify(
    issues,
    null,
    2
  )}\n\nReply again with a single JSON object that satisfies every constraint. No prose, no markdown fences.`;
}

/**
 * Synthetic ProviderRun for an LLM round-trip the server doesn't have
 * direct token accounting for (Claude Code does not surface usage to
 * MCP servers). Mirrors the "callback" provider sentinel so cost
 * aggregation can filter these the same way it filters "skipped".
 */
function syntheticProviderRun(
  promptId: string,
  retries: number
): ProviderRun {
  return {
    provider: "callback",
    model: "claude-code-session",
    prompt_id: promptId,
    started_at: new Date().toISOString(),
    latency_ms: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    cost_usd_cents: null,
    stop_reason: "callback",
    retries
  };
}

function valuesSkippedRun(): ProviderRun {
  return {
    provider: "skipped",
    model: "",
    prompt_id: VALUES_PROMPT_ID,
    started_at: new Date(0).toISOString(),
    latency_ms: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    cost_usd_cents: 0,
    stop_reason: "skipped_no_refusals",
    retries: 0
  };
}

function softScoreSkippedRun(): ProviderRun {
  return {
    provider: "skipped",
    model: "",
    prompt_id: SOFT_SCORE_PROMPT_ID,
    started_at: new Date(0).toISOString(),
    latency_ms: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    cost_usd_cents: 0,
    stop_reason: "skipped_no_preferences",
    retries: 0
  };
}

type ComposeArgs = {
  verdict: EvaluationResult["verdict"];
  reason_code: string;
  short_circuited_at_stage: EvaluationStage | null;
  stages_run: EvaluationStage[];
  facts: ExtractedJobFacts;
  hard_gate_result: GateResult;
  values_result: ValuesCheckResult | null;
  soft_score_result: SoftScoreResult | null;
  provider_runs: ProviderRun[];
  criteria_version: number;
  posting_text: string;
};

function composeResult(args: ComposeArgs): EvaluationResult {
  return {
    verdict: args.verdict,
    reason_code: args.reason_code,
    short_circuited_at_stage: args.short_circuited_at_stage,
    stages_run: args.stages_run,
    facts: args.facts,
    hard_gate_result: args.hard_gate_result,
    values_result: args.values_result,
    soft_score_result: args.soft_score_result,
    provider_runs: args.provider_runs,
    // Hash the same `posting_text` the synchronous pipeline would have
    // fed to extract — keeps `input_hash` byte-equivalent across paths
    // so dedup against `job_evaluations` continues to work.
    input_hash: hashPostingText(args.posting_text),
    extractor_version: EXTRACTOR_VERSION,
    criteria_version: args.criteria_version
  };
}
