import type { CandidateCriteria } from "@networkpipeline/criteria";

/**
 * Stable instruction block. NEVER mutate without bumping
 * SOFT_SCORE_PROMPT_ID. The criteria-specific block below is appended;
 * the whole composed system prompt is cache_control: ephemeral, so a
 * criteria version bump cleanly invalidates cache (which is what we want).
 */
const SOFT_SCORE_INSTRUCTIONS = `You are a calibrated scoring function for technical job postings.

Given a posting and the user's preferences and calibration anchors, call the \`submit_soft_score\` tool exactly once with:

- score: float in [0, 1]
- contributions: per-topic breakdown
- rationale: 2-3 sentence overall summary

# Scoring rules

- 0.0 → clear non-fit. Posting hits no positives AND/OR triggers strong negatives.
- 0.5 → neutral. Posting is plausible but does not strongly match the user's preferences.
- 0.85+ → strong fit. Multiple positives matched, no negatives triggered.
- 1.0 → reserved for postings that clearly hit MULTIPLE positive preferences with substantive evidence.

# Method

For each entry in the user's positive preferences:
- contribution: 0 (topic absent from posting) to +1 (clear, substantial match)
- Magnitude reflects how strongly the posting matches the topic, not how much the user cares (caring is the weight).

For each entry in the user's negative preferences:
- contribution: 0 (negative not triggered) to -1 (negative clearly triggered)

Combine into a single score weighted by the user-provided weights, then anchor against the calibration examples — they show you what 0.95 and 0.50 look like for THIS user. Interpolate accordingly.

# Output rules

- contributions[].topic must echo the user's exact topic strings verbatim.
- contributions[].weight must echo the user's exact weight values verbatim.
- contributions[].rationale must be one sentence and grounded in the posting (not generic).
- contributions must include EVERY user preference (positive and negative). If a topic is not represented in the posting, set contribution: 0 and explain why in rationale.
- score is a single float, not a string.

Do not emit prose outside the tool call.`;

export function buildSoftScoreSystemPrompt(criteria: CandidateCriteria): string {
  const positives = criteria.soft_preferences.positive;
  const negatives = criteria.soft_preferences.negative;
  const acceptedAnchors = criteria.calibration.accepted_examples;
  const rejectedValuesAnchors = criteria.calibration.rejected_examples.filter(
    (r) => r.rejection_reason.startsWith("values:")
  );

  return [
    SOFT_SCORE_INSTRUCTIONS,
    "",
    "# User's positive preferences",
    positives.length === 0
      ? "(none configured)"
      : positives
          .map((p, i) => {
            const evidence = p.evidence ? ` — evidence: ${p.evidence}` : "";
            const boost =
              p.companies_boost && p.companies_boost.length > 0
                ? ` — companies_boost: ${p.companies_boost.join(", ")}`
                : "";
            return `${i + 1}. (weight ${p.weight}) ${p.topic}${evidence}${boost}`;
          })
          .join("\n"),
    "",
    "# User's negative preferences",
    negatives.length === 0
      ? "(none configured)"
      : negatives
          .map((p, i) => {
            const evidence = p.evidence ? ` — evidence: ${p.evidence}` : "";
            return `${i + 1}. (weight ${p.weight}) ${p.topic}${evidence}`;
          })
          .join("\n"),
    "",
    "# Calibration: user-accepted examples (anchor your scores against these)",
    acceptedAnchors.length === 0
      ? "(none configured)"
      : acceptedAnchors
          .map((a) => `- score ${a.score}: ${a.why}${a.url ? ` (${a.url})` : ""}`)
          .join("\n"),
    "",
    "# Calibration: user-rejected examples (values-based)",
    rejectedValuesAnchors.length === 0
      ? "(none configured)"
      : rejectedValuesAnchors
          .map(
            (r) =>
              `- ${r.why}${r.url ? ` (${r.url})` : ""} — rejected for ${r.rejection_reason}`
          )
          .join("\n")
  ].join("\n");
}
