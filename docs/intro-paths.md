# Intro Path Engine

## Status

Status: `proposed`

This document specifies how NetworkPipeline turns a target role into a ranked set of warm-introduction paths, drafts both the bridge-ask and target messages, and hands off to Anthropic's Gmail MCP tool for draft staging.

## 1. Purpose

Cold applications succeed at 0.1–2%. Referrals succeed at ~30%. For any role that passes the [criteria filter](./criteria.md), the highest-leverage next step is not a cold application — it is finding the best path through the user's existing network.

The Intro Path Engine answers three questions:

1. Who do I already know who can help me reach this specific role?
2. If no one is directly useful, who among my connections can reach someone useful?
3. What is the right first message — and is it to the target, or to a bridge?

## 2. Design Principles

- `Leverage don't replace`: connection data stays in LinkedIn; mail stays in Gmail; meetings stay in Calendar. NetworkPipeline orchestrates them through MCP tools.
- `Multi-hop aware`: 2-hop through a warm bridge often beats 1-hop through a cold direct connection.
- `Explainable ranking`: every score component is displayed with its reasoning.
- `Values-aware`: paths routing through `do_not_contact` people or values-blocklisted companies are rejected.
- `Draft-only`: every message — bridge-ask or target — goes through human approval before Gmail drafting.
- `Willingness over proximity`: a close connection who never replies outranks a direct connection who is unreachable.

## 3. Data Model

### 3.1 `people`

Existing CRM entity. Sourced from LinkedIn CSV import, manual entry, or Gmail-derived contacts after review.

### 3.2 `person_attributes`

Enriched attributes per person. Multiple rows per person, one per attribute kind:

- `employment` — company, title, start_date, end_date, is_current
- `education` — institution, program, degree, start_year, end_year
- `public_artifact` — url, kind (paper, talk, post), date

### 3.3 `person_to_person_edges`

Inferred edges between two non-user persons. Used for second-degree path discovery without crawling LinkedIn.

Columns:

- `id`
- `from_person_id`
- `to_person_id`
- `edge_kind` — `shared_employer`, `shared_school`, `co_authorship`, `co_talk`, `public_mention`, `user_entered`
- `evidence_json` — structured facts supporting the edge (e.g., `{company: "Amazon", overlap_years: [2022, 2023]}`)
- `confidence` — float `[0.0, 1.0]`
- `created_at`

Edges are undirected for reasoning but stored as ordered pairs for indexing.

### 3.4 `person_interactions`

Interaction events with the user. Populated from Gmail MCP and Calendar MCP on demand.

Columns:

- `id`
- `person_id`
- `interaction_type` — `email_sent`, `email_received`, `meeting`, `linkedin_dm`, `manual_note`
- `occurred_at`
- `source` — `gmail_mcp`, `calendar_mcp`, `manual`
- `external_ref` — Gmail thread id or Calendar event id for traceability
- `payload_json` — optional structured extras

### 3.5 `warmth_components`

Decomposed warmth score per person, computed from interactions.

Columns:

- `id`
- `person_id`
- `recency_score` — decay function over days since most recent interaction
- `volume_score` — log-scaled interaction count in past 12 months
- `reciprocity_score` — ratio of replies received to messages sent
- `meeting_score` — 1.0 if ≥1 real calendar meeting in past 18 months, else 0.0
- `composite_warmth` — weighted combination
- `computed_at`

Recomputed on every `ingest_gmail_interactions` or `ingest_calendar_interactions` run.

### 3.6 `intro_paths`

Cached ranked paths per (target_company, target_role_title) query.

Columns:

- `id`
- `role_id` — if linked to a canonical Role
- `target_company`
- `target_role_title`
- `target_person_id` — nullable; set if a specific target person was identified
- `hops_json` — ordered list of hops; each hop includes person, edge_to_next, rationale
- `path_score`
- `score_components_json` — warmth, edge_strength, target_relevance, path_length_penalty, willingness_estimate
- `path_explanation_json` — human-readable rationale per component
- `strategy` — `ask_bridge`, `message_target_direct`, `hybrid`
- `computed_at`
- `criteria_version_id` — for reproducibility

### 3.7 `bridge_asks`

First-class outreach entity separate from `outreach_threads` because the lifecycle is different.

States:

- `drafted`
- `staged_in_gmail`
- `sent`
- `bridge_committed` — bridge said yes, intro pending
- `intro_made` — bridge forwarded / connected
- `intro_declined`
- `ghosted`
- `closed`

Columns:

- `id`
- `intro_path_id`
- `bridge_person_id`
- `target_person_id`
- `role_id`
- `status`
- `staged_gmail_draft_id` — external reference
- `sent_at`
- `bridge_response_at`
- `intro_made_at`
- `notes`
- `created_at`
- `updated_at`

## 4. Path Ranking

A path score combines five components:

```
path_score = (
    W_WARMTH      * bridge_warmth
  + W_EDGE        * bridge_to_target_edge_strength
  + W_RELEVANCE   * target_role_relevance_to_role
  + W_WILLINGNESS * bridge_willingness_estimate
  - W_LENGTH      * (path_length - 1)
) * hard_multiplier
```

Default weights (tuned later from eval data):

- `W_WARMTH = 0.30`
- `W_EDGE = 0.25`
- `W_RELEVANCE = 0.25`
- `W_WILLINGNESS = 0.15`
- `W_LENGTH = 0.05`

`hard_multiplier` is `0.0` if the path violates any constraint, `1.0` otherwise.

### 4.1 `bridge_warmth`

`composite_warmth` from `warmth_components` for the bridge person. Direct-connection paths set bridge = user, which means warmth is effectively unused and the component defaults to 1.0.

### 4.2 `bridge_to_target_edge_strength`

Computed from `person_to_person_edges` between bridge and target:

- `shared_employer` currently overlapping: 0.90
- `shared_employer` historical, ≥1 year overlap: 0.70
- `co_authorship` or `co_talk`: 0.85
- `shared_school` same program + overlapping years: 0.75
- `shared_school` same institution only: 0.35
- `public_mention`: 0.25
- `user_entered`: whatever confidence the user set

Multiple edges combine via noisy-OR.

### 4.3 `target_role_relevance_to_role`

How closely the target person's current position matches the sought role:

- Same team / same role title: 1.00
- Same function different team: 0.75
- Same company different function: 0.45
- Adjacent function: 0.30

Uses LLM extraction of the target's public title/team, cached.

### 4.4 `bridge_willingness_estimate`

A willingness signal derived from:

- Historical response rate from the bridge to prior user messages
- Has the user ever received an intro from this bridge before (strong positive)
- Has the bridge ever declined an intro (strong negative, regardless of warmth)
- Default prior: 0.5 for unknown bridges

### 4.5 Path Length Penalty

1-hop: no penalty. 2-hop: `W_LENGTH`. 3-hop: `2 * W_LENGTH`. Paths beyond 3 hops are not considered in V1.

### 4.6 Hard Multiplier (Rejection)

Path is rejected (`hard_multiplier = 0.0`) if any of:

- Any person in the path is marked `do_not_contact`
- Target company is in `criteria.hard_gates.must_not_have.company`
- Target company matches any `criteria.values_refusals` via narrow LLM check
- Bridge is flagged `willingness_exhausted` (too many recent asks without replies)

## 5. MCP Tool Surface

### 5.1 `find_intro_paths`

Signature: `find_intro_paths(target_company: string, target_role_title?: string, k: number = 5) -> IntroPathResult[]`

Behavior:

1. Resolve `target_company` to canonical `Company` record if one exists.
2. Find candidate target persons at that company via:
   - Direct match on `person_attributes.employment` current rows
   - Target role title keyword match for narrowing
3. Enumerate paths up to 3 hops via BFS through first-degree connections and `person_to_person_edges`.
4. Score each path per §4.
5. Apply hard multiplier.
6. Return top `k` paths with full explanation.

Each returned path includes:

```typescript
{
  path_id: string,
  strategy: "ask_bridge" | "message_target_direct" | "hybrid",
  path_score: number,
  hops: [
    {
      degree: 1 | 2 | 3,
      bridge: Person | null,
      connection_to_target: Person,
      edge_evidence: EdgeEvidence,
      rationale: string
    }
  ],
  score_components: {
    bridge_warmth: number,
    bridge_to_target_edge_strength: number,
    target_role_relevance: number,
    bridge_willingness_estimate: number,
    path_length_penalty: number
  },
  path_explanation: string[],
  warnings: string[]
}
```

### 5.2 `draft_bridge_message`

Signature: `draft_bridge_message(path_id: string, intent: "intro" | "advice" | "context") -> BridgeDraft`

The double-draft pattern is critical. Output:

```typescript
{
  message_draft_id: string,
  to_bridge: {
    subject: string,
    body: string,
    tone: string,
    word_count: number
  },
  forward_ready_blurb: {
    subject_suggestion: string,
    body: string,
    note_to_bridge: string
  },
  rationale: string,
  evidence_used: EvidenceRef[]
}
```

`forward_ready_blurb` is a complete, minimal-effort message the bridge can forward verbatim to the target. It removes the friction that causes bridges to say "I should introduce you but never get around to it."

Writing principles applied in the prompt:

- To bridge: warm, specific ask, short (< 120 words), explicit "no pressure if you can't / don't know them well enough" escape clause.
- To target (forward-ready): concise value statement, specific reason for contact, easy yes/no response, no "huge fan" language, no inflated claims.

### 5.3 `draft_target_message`

Signature: `draft_target_message(person_id: string, role_id?: string, intent: "cold_outreach" | "post_intro_followup" | "recruiter_inbound_reply") -> MessageDraft`

Used when:

- 1-hop direct outreach is appropriate
- Following up *after* a bridge intro has been made
- Responding to recruiter inbound

Personalization inputs:

- Path explanation (if coming from an intro path)
- Target's public artifacts (papers via `mcp__claude_ai_Scholar_Gateway__semanticSearch`, public talks, posts)
- User's `criteria.soft_preferences.positive` topics with user-provided evidence
- Shared context from `person_to_person_edges`

Explicit guardrails in the prompt:

- No "I'm a huge fan" openers
- No inflated claims the user hasn't demonstrated
- Must include one specific, role-relevant hook
- Must propose a concrete low-commitment next step (15-min chat, async question, etc.)

### 5.4 `approve_and_stage_gmail_draft`

Signature: `approve_and_stage_gmail_draft(message_draft_id: string) -> GmailStagingPayload`

Returns a payload ready for Claude Code to pass to `mcp__claude_ai_Gmail__create_draft`:

```typescript
{
  to: string[],
  subject: string,
  body: string,
  labels_to_apply: string[],
  networkpipeline_thread_id: string,
  instructions_to_claude: string
}
```

NetworkPipeline never calls Gmail directly. It returns the payload; Claude Code invokes the Gmail MCP tool. This preserves the rule that NetworkPipeline holds no Gmail credentials.

### 5.5 `ingest_gmail_interactions`

Signature: `ingest_gmail_interactions(since: ISO8601, person_hints?: string[]) -> IngestInstruction`

NetworkPipeline cannot call Gmail directly. This tool returns an instruction payload that tells Claude Code what Gmail queries to run and how to report results back.

```typescript
{
  queries: [
    {
      gmail_query: "from:sarah@example.com OR to:sarah@example.com newer_than:180d",
      max_threads: 50,
      person_id: "p_sarah_lee"
    }
  ],
  report_schema_url: "networkpipeline://schemas/gmail_interaction_report.json",
  callback_tool: "record_gmail_interactions"
}
```

Claude Code:

1. Calls `mcp__claude_ai_Gmail__search_threads` per query.
2. Calls `mcp__claude_ai_Gmail__get_thread` for each relevant thread.
3. Extracts structured interaction facts per the report schema.
4. Calls `record_gmail_interactions` on NetworkPipeline with the structured result.

This keeps the round-trip deterministic.

### 5.6 `record_gmail_interactions`

Signature: `record_gmail_interactions(interactions: GmailInteraction[]) -> WarmthRecomputeResult`

Persists to `person_interactions`, triggers `warmth_components` recompute for affected persons, returns summary.

### 5.7 `ingest_calendar_interactions`

Same pattern as `ingest_gmail_interactions` but for `mcp__claude_ai_Google_Calendar__list_events`. Meetings are a strong warmth signal (actual face time vs. async text).

### 5.8 `mark_bridge_ask_outcome`

Signature: `mark_bridge_ask_outcome(bridge_ask_id: string, outcome: BridgeOutcome, notes?: string)`

Advances `bridge_asks.status`. Feeds into future `bridge_willingness_estimate` for that bridge.

## 6. End-To-End Flow

```
User in Claude Code:
  "Evaluate this Anthropic posting: <url>"

Claude:
  [evaluate_job] ✓ PASS score 0.91

  [find_intro_paths("Anthropic", "Research Engineer, Agents", 5)]
  Path 1 (score 0.71): You → Sarah Lee → Marcus Chen
    - bridge_warmth: 0.82 (recent Slack, Amazon teammate)
    - edge_strength: 0.85 (co-presented at AWS re:Invent 2024)
    - target_relevance: 1.00 (same team)
    - willingness_est: 0.75 (Sarah has replied to last 3 of 3 messages)
    - length_penalty: -0.05
  Path 2 (score 0.55): ...
  Path 3 (score 0.48): ...

  Recommended strategy: ask_bridge (Path 1). Want me to draft?

User: "yes"

Claude:
  [draft_bridge_message(p_7a2, "intro")]
  To Sarah (draft):
    Subject: Quick ask re: Anthropic
    Hi Sarah — hope you're well after the move to Seattle.
    I'm exploring Research Eng roles at Anthropic and saw
    you co-presented with Marcus Chen last year. Would you
    feel comfortable making a light intro? No pressure at
    all if not — totally understand.
    I've drafted a forward-ready blurb below to save you
    the trouble if you are up for it.
    — Andrew

  Forward-ready blurb for Marcus:
    Subject: Intro: Andrew Watson (ex-Amazon Devices) re:
    Research Engineer, Agents
    Hi Marcus — Sarah suggested I reach out. I spent 4
    years at Amazon Devices building MCP-backed ML eval
    systems (MAESTRO, VegaTitan). Curious if you'd be
    open to a 15-min chat about the Agents team's
    current work on evaluation harnesses.

User: [edits slightly] "approved"

Claude:
  [approve_and_stage_gmail_draft(md_abc)]
  [mcp__claude_ai_Gmail__create_draft(payload)]
  Draft staged in Gmail. Label applied: networkpipeline/bridge-ask/p_7a2.
  Bridge ask b_kj8 recorded (status: staged_in_gmail).
  I'll watch for Sarah's reply on your next sync.

User: [sends from Gmail manually]
User: [later] "Sync replies"

Claude:
  [ingest_gmail_interactions(since: last_sync, person_hints: [sarah_lee])]
  [searches Gmail, finds Sarah's reply saying yes]
  [record_gmail_interactions([...])]
  [mark_bridge_ask_outcome(b_kj8, "bridge_committed")]
  Sarah replied positively 2 hours ago. Bridge ask advanced.
  Expected next step: wait for intro email from Sarah to
  you + Marcus, which I'll detect on next sync.
```

## 7. Observability

- Every path computation writes to `intro_paths` with inputs, score components, and criteria version.
- Every draft writes to `message_drafts` with `provider_run_id` linking to `mcp_invocations` and `provider_runs`.
- Every Gmail staging writes to `gmail_label_bindings`.
- Every outcome writes to `bridge_asks` state transition, which is queryable for eval.

## 8. Evaluation Metrics

Per quarter, the eval harness reports:

- Path precision: of top-1 paths surfaced, what fraction did the user actually pursue?
- Bridge-ask reply rate: of sent bridge-asks, what fraction got a committed intro?
- Intro-to-conversation rate: of committed intros, what fraction led to a target conversation?
- Conversation-to-interview rate: what fraction of target conversations led to a formal loop?
- Ablation: how much worse does ranking do without `warmth_components`? Without `person_to_person_edges`? Without willingness estimate?

Results ship publicly in `docs/evaluation.md` as they accumulate.

## 9. Privacy And Safety

- Gmail and Calendar data fetched on demand by Claude Code, mediated by user interaction. NetworkPipeline never holds OAuth credentials.
- Raw email bodies default to a 90-day retention window in `conversation_imports`. User-configurable.
- Extracted structured interactions (`person_interactions` rows) are retained indefinitely for warmth scoring.
- Any person can be marked `do_not_contact`. That flag propagates: no paths route through them, no drafts reference them.
- `bridge_asks.willingness_exhausted` is a soft-block: three consecutive asks with no reply silences further routing through that bridge until the user manually reopens.

## 10. Non-Goals V1

- LinkedIn scraping of any kind
- Sending any message without user approval
- Inferring `person_to_person_edges` from pure name-similarity or shared location (too noisy)
- Public graph visualization surface
- Multi-user collaboration on the same graph

## 11. Open Questions

- Is willingness estimation reliable enough to be a ranking input in V1, or should it start as display-only until enough data accumulates?
- Should `forward_ready_blurb` be a separate artifact (own table) so we can track whether bridges actually forward it?
- Is 3 hops the right cap, or should V1 stop at 2?

## 12. Related Docs

- [Criteria System](./criteria.md)
- [Architecture](./architecture.md)
- [Evaluation Harness](./evaluation.md)
