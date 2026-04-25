# NetworkPipeline V1 Architecture

## 1. Goals

V1 is a Claude-Code-native assistant that helps a job seeker:

1. Filter postings against a versioned, user-owned criteria file (hard gates + values refusals + soft preferences).
2. Find the highest-leverage warm-intro path into roles that pass the filter.
3. Draft both bridge-ask and target messages, staged into Gmail via Anthropic's built-in Gmail MCP tool.

Architectural constraints:

- `Claude-Code-first`: the primary interface is Claude Code. A minimal web UI exists for review/approval, not as the driver.
- `No credential custody`: Gmail and Calendar access goes through Anthropic's MCP tools, never through NetworkPipeline-held OAuth credentials.
- `Local-first`: SQLite + local filesystem by default. Self-hosting is a first-class path.
- `Draft-only`: no outbound sending without explicit human approval.
- `Leverage not replace`: we orchestrate LinkedIn, Gmail, Calendar, Indeed, Scholar Gateway via MCP — we do not rebuild what they already do.

## 2. Top-Level Shape

```text
┌─────────────────────────────────────────────────────────────┐
│                       Claude Code                           │
│  (primary user interface; orchestrator of all MCP tools)    │
└─────────┬───────────────┬─────────────────┬─────────────────┘
          │               │                 │
          │ stdio         │ MCP             │ MCP
          ▼               ▼                 ▼
┌──────────────────┐  ┌────────────────┐  ┌────────────────────┐
│ NetworkPipeline  │  │ Anthropic      │  │ Other MCP tools    │
│ MCP server       │  │ built-in MCP:  │  │ (user-installed)   │
│ (this project)   │  │  - Gmail       │  │  - Indeed          │
│                  │  │  - Calendar    │  │  - Scholar Gateway │
│                  │  │                │  │  - optional enrich │
└─────────┬────────┘  └────────────────┘  └────────────────────┘
          │
          ▼
┌──────────────────────────────────────────────┐
│ Local SQLite (canonical + staging + traces)  │
│ Local filesystem (criteria.yaml, resumes)    │
└──────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Minimal Next.js review UI (optional, localhost only)        │
│ Connects to NetworkPipeline over HTTP transport             │
└─────────────────────────────────────────────────────────────┘
```

## 3. Transports

NetworkPipeline exposes two MCP transports backed by the same core server:

- `stdio`: default for Claude Code sessions.
- `HTTP on 127.0.0.1`: used by the review UI and by power users who want to drive the server programmatically.

Both transports serve the identical tool surface.

## 4. Core Modules

Inside the API/worker:

- `criteria` — loading, validating, merging (extends/overlays), versioning of `candidate_criteria.yaml`
- `evaluator` — two-stage pipeline: extract → hard gates → values check → soft score
- `graph` — people, edges, warmth components, path enumeration and ranking
- `outreach` — bridge-ask and target drafting, approval gates, Gmail hand-off
- `ingest` — LinkedIn CSV, resume, Gmail/Calendar MCP callbacks, Indeed MCP
- `mcp_server` — tool-surface definitions, argument validation, result shaping
- `observability` — `mcp_invocations`, `provider_runs`, cost/cache tracking
- `settings` — paths, feature flags, retention windows

Each module owns: entities, validation, commands/queries, persistence, service interfaces.

## 5. Data Storage

### 5.1 Primary Database

SQLite by default. Schema is PostgreSQL-compatible but SQLite is the supported V1 target.

Three logical layers:

1. `canonical` — approved records (people, roles, applications, evaluations, bridge_asks)
2. `staging` — raw imports and AI proposals awaiting review (`conversation_imports`, `fact_proposals`, `review_decisions`)
3. `trace` — `mcp_invocations`, `provider_runs`, `candidate_criteria_versions`, `job_evaluations`

See [schema.md](./schema.md) for physical table details.

### 5.2 Files

- `~/.networkpipeline/criteria.yaml` — source-of-truth criteria file
- `~/.networkpipeline/data/networkpipeline.sqlite` — primary DB
- `~/.networkpipeline/artifacts/` — resumes, LinkedIn CSV exports, rendered reports
- `~/.networkpipeline/logs/` — rolling logs for debug

Environment override: `NETWORKPIPELINE_HOME`.

### 5.3 Search And Retrieval

SQL-native filtering is sufficient for V1. Full-text search via SQLite FTS5 for free-text fields (notes, draft bodies). No vector DB.

## 6. Request And Job Flow

### 6.1 Synchronous

Handled on the request thread:

- All MCP tool calls from Claude Code (evaluate_job, find_intro_paths, draft_*, record_*)
- Web UI reads (list views, detail views, approval diffs)
- Criteria file load + validate

### 6.2 Asynchronous

Handled in an in-process job runner (V1) or a separate worker (upgraded deployments):

- `recompute_warmth_components` after interaction ingest
- `recompute_intro_paths` after new edges or new `person_attributes`
- `bulk_evaluate_jobs` for batched evaluation requests
- `draft_generation` when drafting is delegated to an async model call (not always the case)
- `active_learning_proposals` triggered by thumbs-up/down

## 7. MCP Tool Surface

NetworkPipeline exposes one MCP server with these tools (full schemas in [mcp-interface.md](./mcp-interface.md) when that doc lands):

Criteria and evaluation:

- `ingest_resume(path)`
- `get_criteria()` / `explain_criteria()`
- `evaluate_job(url_or_text)` / `bulk_evaluate_jobs(urls)`
- `propose_criteria_change(evaluation_id, user_feedback)`
- `accept_criteria_change(proposal_id)`
- `criteria_history()`

Graph and ingest:

- `ingest_linkedin_csv(path)`
- `ingest_gmail_interactions(since, person_hints?)` — returns instruction payload for Claude
- `record_gmail_interactions(interactions)` — callback from Claude
- `ingest_calendar_interactions(since)` / `record_calendar_interactions(interactions)`
- `find_target_persons(company, role_title?)`

Paths and outreach:

- `find_intro_paths(company, role_title?, k)`
- `draft_bridge_message(path_id, intent)`
- `draft_target_message(person_id, role_id?, intent)`
- `approve_and_stage_gmail_draft(message_draft_id)` — returns payload for Claude to pass to `mcp__claude_ai_Gmail__create_draft`
- `mark_bridge_ask_outcome(bridge_ask_id, outcome)`

Pipeline health:

- `pipeline_status(stale_days?)`
- `advance_application(application_id, status)`
- `log_outcome(thread_id, outcome)`

## 8. Gmail And Calendar Integration

NetworkPipeline does not hold Gmail or Calendar credentials. The integration pattern is:

1. NetworkPipeline returns an `IngestInstruction` describing what Gmail queries or Calendar ranges to fetch.
2. Claude Code calls Anthropic's Gmail/Calendar MCP tools with those queries.
3. Claude Code extracts structured facts against a schema NetworkPipeline publishes.
4. Claude Code calls `record_*` callback tools on NetworkPipeline with the structured result.
5. NetworkPipeline persists and recomputes derived state.

This keeps credentials inside Claude's sandbox and makes the round-trip deterministic.

For draft staging, the flow reverses:

1. User approves a draft in NetworkPipeline (via web UI or conversational approval).
2. Claude calls `approve_and_stage_gmail_draft(message_draft_id)` which returns a Gmail-ready payload.
3. Claude calls `mcp__claude_ai_Gmail__create_draft` with that payload.
4. Claude calls `mcp__claude_ai_Gmail__label_thread` with NetworkPipeline-managed labels.
5. Claude reports back the Gmail thread id to NetworkPipeline via a `record_gmail_draft_staged` callback.

Gmail labels used:

- `networkpipeline/outreach/target`
- `networkpipeline/outreach/bridge-ask`
- `networkpipeline/app/{role_id}`
- `networkpipeline/replied`

Labels are the shared-state handle between Gmail and SQLite.

## 9. Criteria Pipeline

Detailed spec in [criteria.md](./criteria.md).

Important architectural note: `hard_gate_check` is pure code with no LLM involvement. This is an intentional separation — hard gates must be auditable and deterministic. `values_check` is a narrow LLM prompt with a binary output. `soft_score` is an LLM prompt anchored by calibration examples.

Every call through this pipeline writes:

- One `mcp_invocations` row
- Up to three `provider_runs` rows (extract, values, score)
- One `job_evaluations` row with the criteria version used

## 10. Intro Path Engine

Detailed spec in [intro-paths.md](./intro-paths.md).

Key architectural decisions:

- Paths cached per `(target_company, target_role_title, criteria_version_id)`. Cache invalidation on new edges, new interactions, or criteria bump.
- BFS over first-degree connections plus `person_to_person_edges`, capped at 3 hops.
- Ranking is deterministic given inputs; reproducibility matters for evaluation.

## 11. Outreach Safety Pipeline

Every message draft — bridge or target — flows through:

1. Draft generation with rationale and evidence attached.
2. Safety preflight: `do_not_contact`, cooldown, follow-up cap, values check on the target company.
3. Explicit user approval.
4. Payload staging for Claude to hand off to Gmail.
5. Manual send by user in Gmail.
6. Reply detection via next `ingest_gmail_interactions` sync.

No path in the code writes directly to Gmail.

## 12. Observability And Evaluation

Every LLM call writes a `provider_runs` row (V1: all Claude-Code-driven; V2: multi-provider). Every MCP tool call writes an `mcp_invocations` row with input hash, output hash, latency, cost where available.

The eval harness (detailed in [evaluation.md](./evaluation.md) when that doc lands) reports:

- Filter precision/recall against user thumbs-up/down labels, per criteria version.
- Path precision against user-pursued paths.
- Bridge-ask → committed-intro rate.
- Target-message reply rate with path provenance.
- Prompt-cache hit ratios and cost per approved draft.

Evaluation runs are published periodically in the repo as markdown snapshots.

## 13. Auth And Multi-Tenancy

V1 is single-user. The MCP server binds to localhost only on both transports. No auth.

Multi-tenant is explicitly out of scope for V1.

## 14. Deployment

V1 supported deployments, in priority order:

1. Native local install via `npx @networkpipeline/mcp-server` registered with Claude Code.
2. Self-hosted single-node via `npm run start:local` for the full web UI.
3. Docker Compose for contributors who want a reproducible setup.

The only required services are:

- `mcp-server` process
- `sqlite` file
- optional `web` process for the review UI

## 15. Repository Layout

```text
apps/
  mcp-server/       # stdio + HTTP MCP server
  web/              # Next.js review UI (optional)
  worker/           # in-process by default; extractable later
packages/
  criteria/         # schema, validator, merge, versioning
  evaluator/        # extract + gates + values + soft score
  graph/            # people, edges, warmth, path ranking
  outreach/         # drafting, approval, Gmail hand-off
  ingest/           # LinkedIn, Gmail/Calendar callbacks, Indeed
  domain/           # shared entities, enums
  ai-adapters/      # V1: claude_code only; V2+: openai, local
  config/           # settings, paths, env loading
  ui/               # shared UI components
docs/
  requirements.md
  design.md
  domain-model.md
  schema.md
  architecture.md   # this doc
  criteria.md
  intro-paths.md
  stack.md
  future/
    prep.md
    career-ops-integration.md
```

## 16. What V1 Deliberately Excludes

These are out of V1 scope to keep the wedge sharp:

- Technical interview prep engine (moved to `docs/future/prep.md`).
- Multi-provider AI adapter layer (V1 is Claude Code only).
- Custom Gmail OAuth connector (replaced by Anthropic's Gmail MCP).
- LinkedIn scraping or browser automation.
- Full-fat kanban that competes with Huntr/Teal (we ship minimal list views).
- Multi-user workspaces, RBAC, or team collaboration.

## 17. Build Order

1. Shared `domain` and `criteria` packages with Zod schemas and enums.
2. Portable SQL schema and migrations.
3. `evaluator` with `extract_job_facts` + `hard_gate_check` + `values_check` + `soft_score`.
4. MCP server skeleton with `evaluate_job`, `get_criteria`, `criteria_history`.
5. `criteria-init` interview flow (Claude Code skill).
6. `graph` module: LinkedIn CSV ingest, `person_to_person_edges` inference, warmth scaffolding.
7. `ingest_gmail_interactions` callback pattern + `record_gmail_interactions`.
8. `find_intro_paths` with ranking.
9. `draft_bridge_message` and `draft_target_message`.
10. `approve_and_stage_gmail_draft` hand-off.
11. Minimal Next.js review UI.
12. Evaluation harness and first published snapshot.

## 18. Deferred Decisions

- Whether to sign community criteria overlays to prevent supply-chain issues.
- Whether to promote the `/job-fit` skill into its own repo separate from the MCP server.
- Whether willingness estimation is reliable enough to be a V1 ranking input or starts display-only.
- When to introduce a second AI provider for eval comparison (V2+).

Reference stack decisions live in [stack.md](./stack.md).
