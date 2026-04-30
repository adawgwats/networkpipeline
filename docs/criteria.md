# Criteria System

## Status

Status: `proposed`

This document specifies the `candidate_criteria.yaml` file format, the evaluation pipeline that uses it, and the active-learning loop that keeps it sharp.

## 1. Purpose

Most AI job tools rank roles by similarity to a resume. That produces two failure modes:

- Roles the user would never accept show up because the embedding looks right (e.g., defense contractor work recommended to a candidate with no clearance and no interest).
- Roles the user would accept but look superficially different are missed.

The criteria system replaces that single soft-similarity layer with a three-layer pipeline:

1. `hard gates` — deterministic filters (no LLM). A single violation rejects the role.
2. `values refusals` — explicit refusals enforced with a narrow LLM check. Violation rejects the role even at high soft score.
3. `soft preferences` — weighted preferences with LLM-judged scoring anchored by user-provided calibration examples.

Every rejection returns a reason code. Every acceptance returns a score with per-feature contributions. The criteria file is versioned; every change is a diff the user approves.

## 2. File Location And Format

Default path:

- `~/.networkpipeline/criteria.yaml`

Overridable via `NETWORKPIPELINE_CRITERIA_PATH`.

Format:

- `YAML` for authoring and diffs
- Validated against a `Zod`-generated JSON schema on every load
- Versioned with semver in the `version` field
- Every mutation writes a snapshot to `candidate_criteria_versions` in SQLite with a change summary

## 3. Schema Overview

```yaml
version: 1
schema_version: "1.0.0"
updated_at: 2026-04-24T00:00:00Z
updated_via: conversation_with_claude

extends: []
overlays: []

profile:
  display_name: "Andrew Watson"
  years_experience: 4
  primary_locations: [DC-metro, NYC, remote, Fredericksburg-VA]
  work_authorization: us_citizen_or_permanent_resident
  seniority_band: [mid, senior]

hard_gates:
  must_have: []
  must_not_have: []
  must_not_contain_phrases: []

values_refusals: []

soft_preferences:
  positive: []
  negative: []
  min_soft_score: 0.55

calibration:
  accepted_examples: []
  rejected_examples: []
```

Each section is specified below.

## 4. `extends` And `overlays`

### 4.1 `extends`

A list of paths or published template identifiers whose fields are merged in *before* the local file. Local values override. Used to inherit a starter template.

```yaml
extends:
  - "@networkpipeline/templates/ml-engineer-mid-level"
```

### 4.2 `overlays`

A list of paths or published overlays whose fields are merged in *after* the local file. Overlays can only add to `hard_gates.must_not_have`, `values_refusals`, and `soft_preferences.negative`. Overlays cannot weaken a constraint.

```yaml
overlays:
  - "@networkpipeline/overlays/no-defense-companies"
  - "@networkpipeline/overlays/no-crypto-only"
```

The overlay-cannot-weaken rule is enforced by the validator at load time.

## 5. `profile`

Structured facts used by hard gates and soft scoring. Must match the canonical `CandidateProfile` in SQLite.

Fields:

- `display_name`: string
- `years_experience`: integer
- `primary_locations`: list of strings; free-form location tags
- `work_authorization`: enum — one of `us_citizen`, `us_citizen_or_permanent_resident`, `requires_sponsorship`, `not_applicable`
- `seniority_band`: list of enums — any of `intern`, `new_grad`, `junior`, `mid`, `senior`, `staff`, `principal`, `director`, `vp`

## 6. `hard_gates`

Deterministic checks executed in pure code. No LLM involvement.

### 6.1 `must_have`

List of conditions that must all be true. Each is `{kind, op, value | value_in}`.

Supported `kind` values:

- `years_experience` — compares extracted role YOE requirement against `profile.years_experience`
- `employment_type` — expects `value_in: [full_time, contract_to_hire, contract, internship]`
- `work_authorization` — compares extracted posting requirement against `profile.work_authorization`
- `location_allowed` — extracted role location must match at least one `primary_locations` or be fully remote

### 6.2 `must_not_have`

List of conditions where a match rejects the role. Each is `{kind, any_of | value, reason}`.

Supported `kind` values:

- `required_clearance` — `any_of: [secret, top_secret, ts_sci, dod_clearance_required]`
- `industry` — coarse industry tag match; use values-based tags like `defense_weapons`, `autonomous_lethal_systems`, `surveillance_for_state_actors`, `gambling`, `crypto_only`
- `company` — `any_of: [Anduril, Palantir, ...]` — company-level refusal regardless of role content
- `role_seniority` — `any_of` of seniority bands outside `profile.seniority_band`
- `location_requirement` — posting requires onsite in a location not in `primary_locations`

### 6.3 `must_not_contain_phrases`

Raw phrase blocklist. Case-insensitive substring match on the posting text.

```yaml
must_not_contain_phrases:
  - "active security clearance required"
  - "on-site 5 days"
  - "must be a U.S. citizen with a DoD clearance"
```

### 6.4 Gate Execution Order

Gates run in this order. On first failure, pipeline short-circuits.

1. `must_not_contain_phrases` (cheapest, string match)
2. `must_not_have.company` (exact match)
3. `must_not_have.industry` (tag match against extracted facts)
4. `must_not_have.required_clearance`
5. `must_not_have.role_seniority`
6. `must_not_have.location_requirement`
7. `must_have.work_authorization`
8. `must_have.location_allowed`
9. `must_have.employment_type`
10. `must_have.years_experience`

Each gate emits a stable reason code of the form `hard_gate:<gate_name>:<specific_value>` on failure.

### 6.5 Pre-Extraction vs Post-Extraction Gates

The 10 gates in §6.4 split bipartitely on whether they need LLM-extracted facts. Approximately half can decide rejection from connector-supplied posting metadata alone (no `extract_job_facts` call required). The discovery layer (`docs/discovery.md` §5) consumes the pre-extraction subset to drop obvious-reject postings *before* paying for extraction. Same gate code, same reason-code taxonomy (§11) — just dispatched earlier in the pipeline.

#### Pre-extraction (metadata only)

Run on `NormalizedDiscoveredPosting` (`docs/discovery.md` §3) before any LLM call.

- `must_not_contain_phrases` — substring scan over `title + description_text` if the connector returned a description; over `title + location_text + raw_metadata_json` snippet otherwise. Same case-insensitive logic as the post-extraction path; the only difference is the haystack source.
- `must_not_have.company` — exact match (case-insensitive) on the connector-supplied `company` field. Greenhouse / Lever / Ashby return the company slug verbatim; Indeed returns the employer string. This is the highest-value pre-extraction gate.
- `must_not_have.location_requirement` — when the connector populates `location_text` and the criteria gate matches a location string directly. Defers to the post-extraction path when the metadata is ambiguous (e.g., "Multiple locations").
- `must_have.location_allowed` — same fields, opposite polarity.
- `must_have.employment_type` — matches against `employment_type_hint` when the connector exposes it (Greenhouse `metadata`, Lever `categories.commitment`, Ashby `employmentType`). Indeed's metadata is unreliable here — defer.
- `must_not_have.role_seniority` (partial) — title-regex pass for `Senior`, `Sr.`, `Staff`, `Principal`, `Distinguished`, `Lead`, `Director`, `VP`, `Junior`, `Jr.`, `Intern`. When the title yields an unambiguous band signal *and* every signal falls inside the blocked set, reject. When the title is ambiguous, defer to the post-extraction path.

#### Post-extraction (need LLM-extracted facts)

Run inside the existing `evaluate_job` flow (§10) exactly as today. Discovery never relaxes these.

- `must_not_have.industry` — needs `extracted_facts.industry_tags`. The connector's metadata (department / category strings) is too noisy to substitute.
- `must_not_have.required_clearance` — pre-extraction can do an opportunistic first-pass regex over `title + snippet` for "TS/SCI", "Top Secret", "Active Clearance" hits and reject early; full coverage requires `extracted_facts.required_clearance` because clearance language is often body-only.
- `must_have.years_experience` — needs `extracted_facts.required_yoe.min`. No connector reliably exposes this.
- `must_not_have.role_seniority` (full) — when the title is ambiguous (e.g., "Engineer", "ML Practitioner"), the band must come from `extracted_facts.seniority_signals`.
- `must_have.work_authorization` — needs `extracted_facts.work_authorization_constraints`. Sponsorship hints are body-only.

#### Reason-code parity

Pre-extraction rejections write the same `hard_gate:<gate_name>:<value>` reason code that the post-extraction path would have written. A pre-extraction reject also persists to `discovered_postings.pre_filter_status = "rejected"` with no `job_evaluations` row, so eval-harness queries that compute `pre_extraction_rejection_rate` can trace the savings (`docs/evaluation.md` §3, `docs/discovery.md` §5.4).

#### Why this isn't a separate gate set

Gate semantics are unchanged. The bipartite split is a dispatch optimization, not a new policy surface. The same `criteria.yaml`, same reason codes, same overlay rules apply in both phases.

## 7. `values_refusals`

Free-text refusals enforced by a narrow LLM check. Each refusal is one or two sentences.

```yaml
values_refusals:
  - "Autonomous lethal systems or weapon targeting"
  - "Mass surveillance tooling sold to state actors"
  - "Addiction-optimized consumer products such as gambling or loot boxes for minors"
  - "Predatory lending or debt collection technology"
```

### 7.1 Enforcement

After hard gates pass, the evaluator calls a narrow LLM prompt with:

- The full posting text and extracted facts
- The `values_refusals` list
- Instruction to return a structured JSON result: `{violation: bool, matched_refusal: string | null, excerpt: string | null, confidence: 0.0-1.0}`

A violation with confidence ≥ 0.6 rejects the role. Reason code: `values:<slugified_refusal>`.

Violations with confidence 0.4-0.6 are flagged as `needs_review` rather than auto-rejected.

### 7.2 Why Separate From Hard Gates

Values refusals are semantic, not keyword-matched. Hard gates are deterministic. Keeping them separate lets hard gates stay auditable code with no LLM surface, while values refusals get the flexibility of LLM judgment — but narrowly, with a single yes/no output.

## 8. `soft_preferences`

Weighted preferences scored by an LLM using calibration anchors.

### 8.1 `positive`

```yaml
positive:
  - topic: "AI/ML evaluation systems"
    weight: 1.0
    evidence: "VegaTitan, MAESTRO at Amazon; minimax-optimization"
  - topic: "MCP / agent tooling"
    weight: 0.9
  - topic: "Frontier AI labs"
    weight: 1.0
    companies_boost: [Anthropic, OpenAI, Scale AI, Cohere]
```

`weight` is a float in `[-1.0, 1.0]`. `evidence` is optional context the LLM may use to justify the score.

### 8.2 `negative`

Same shape; weights are negative. Violation does not reject, only reduces score.

### 8.3 `min_soft_score`

Float in `[0.0, 1.0]`. Roles scoring below are included in the return but flagged `below_threshold: true`. Consumers (like the `/job-fit` skill) may choose to hide them by default.

## 9. `calibration`

Few-shot anchors that stabilize LLM soft scoring.

```yaml
calibration:
  accepted_examples:
    - url: "https://..."
      why: "Anthropic, Research Engineer, Agents — dead-center fit"
      score: 0.95
  rejected_examples:
    - url: "https://..."
      why: "Staff-level role; I have 4 YoE"
      rejection_reason: "hard_gate:role_seniority:staff"
```

Rules:

- At least 2 accepted and 2 rejected examples recommended (not enforced).
- Accepted examples feed the soft-score prompt as anchor exemplars with their scores.
- Rejected examples feed the values-check prompt when the rejection reason was `values:*`.
- Rejected examples with `hard_gate:*` reasons do not feed any prompt — they are documentation only.

## 10. The Evaluation Pipeline

```
job URL or pasted text
   │
   ▼
┌───────────────────────────────────────┐
│ extract_job_facts (LLM, small model)  │
│   returns structured Zod-typed facts: │
│   title, seniority_signals,           │
│   required_clearance, required_yoe,   │
│   industry_tags, required_onsite,     │
│   phrases_triggered, stack, company   │
└───────────────────────────────────────┘
   │
   ▼
┌───────────────────────────────────────┐
│ hard_gate_check (pure code)           │
│   returns PASS or                     │
│   REJECT(reason_code, gate_name)      │
└───────────────────────────────────────┘
   │ PASS
   ▼
┌───────────────────────────────────────┐
│ values_check (LLM, narrow prompt)     │
│   returns CLEAR or                    │
│   REJECT(reason_code, matched, quote) │
└───────────────────────────────────────┘
   │ CLEAR
   ▼
┌───────────────────────────────────────┐
│ soft_score (LLM, anchored few-shot)   │
│   returns score, contributions[],     │
│   rationale, below_threshold?         │
└───────────────────────────────────────┘
   │
   ▼
JobEvaluation record persisted in SQLite
```

Every intermediate step is logged to `job_evaluations`.

## 11. Reason Code Taxonomy

Rejection reasons use a stable colon-separated format so consumers can programmatically branch:

- `hard_gate:must_not_contain_phrases:<phrase>`
- `hard_gate:company:<company_name>`
- `hard_gate:industry:<industry_tag>`
- `hard_gate:required_clearance:<clearance_type>`
- `hard_gate:role_seniority:<band>`
- `hard_gate:location_requirement:<location>`
- `hard_gate:work_authorization:<required_type>`
- `hard_gate:employment_type:<type>`
- `hard_gate:years_experience:required_<n>_have_<m>`
- `values:<slugified_refusal>`
- `soft:below_threshold:<score>`

Acceptance returns:

- `accepted` with `contributions`, `rationale`, `score`, `criteria_version_id`

## 12. Active Learning Loop

When the user thumbs-down an accepted role or thumbs-up a rejected role, the pipeline runs `propose_criteria_change`:

1. Fetch the `JobEvaluation` and the current criteria version.
2. Run an LLM prompt that summarizes which gate/value/preference was (or wasn't) at play.
3. Produce a YAML-diff proposal — a minimal change to the criteria that would have routed this job correctly.
4. Return the diff plus rationale to the user.
5. On acceptance, apply the change, bump `version`, write a new `candidate_criteria_versions` row with `change_summary` referencing the triggering evaluation.

Example dialogue in Claude Code:

```
User: "This Anduril role shouldn't have come through — thumbs down."

Claude: Inspecting evaluation ev_4f7...
  - hard_gates: PASS (posting did not list clearance)
  - values_check: CLEAR (confidence 0.42)
  - soft_score: 0.71

  Proposed criteria diff:

    hard_gates:
      must_not_have:
   +    - kind: company
   +      any_of: [Anduril, Palantir, Shield AI, Rebellion Defense]
   +      reason: "Company-level values refusal regardless of posting content"

  This will retroactively reject all pending evaluations matching these companies.

  Accept? (y/n)
```

## 13. Versioning Semantics

- `version` — monotonically increasing integer. Bumped on every accepted change.
- `schema_version` — semver. Bumped only when the file format itself changes. V1 ships `1.0.0`.
- A `candidate_criteria_versions` row is written per `version`. Columns: `id`, `version`, `yaml_snapshot`, `change_summary`, `created_at`, `created_via`, `triggered_by_evaluation_id?`.

Rollback is a new version that restores prior content — no destructive edits.

## 14. Storage

- Source of truth: the YAML file on disk.
- Mirror: SQLite `candidate_criteria_versions` table.
- Every `JobEvaluation` stores `criteria_version_id` so results remain reproducible even as the criteria evolves.

## 15. Template Repository

Starter templates and overlays ship in `github.com/<owner>/criteria-templates`:

Starters (`templates/*.yaml`):

- `ml-engineer-mid-level.yaml`
- `backend-senior.yaml`
- `frontend-new-grad.yaml`
- `research-engineer-frontier-labs.yaml`

Overlays (`overlays/*.yaml`):

- `no-defense-companies.yaml`
- `no-crypto-only.yaml`
- `no-gambling-or-addiction.yaml`
- `no-adtech-targeting.yaml`
- `remote-only.yaml`

Each file includes a `README.md` snippet with its assumed audience and the constraints it adds.

## 16. Open Questions

- Should overlays be cryptographically signed to prevent supply-chain attacks on shared refusal lists?
- Should `calibration.accepted_examples` support referencing stored `JobEvaluation` rows by id, so accepted roles automatically become calibration anchors?
- Is `required_yoe` extraction reliable enough to be a hard gate, or should it stay soft-preference only?

## 17. Related Docs

- [Discovery Layer](./discovery.md) — consumes the pre-extraction subset of §6.5
- [Intro Path Engine](./intro-paths.md)
- [Architecture](./architecture.md)
- [Evaluation Harness](./evaluation.md)
