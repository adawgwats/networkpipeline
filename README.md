# NetworkPipeline

A Claude-Code-native assistant for targeted, values-aware job search.

NetworkPipeline encodes your hard constraints and values refusals as versioned YAML, filters postings through a deterministic-gate → values-check → LLM-scored pipeline, and ranks multi-hop warm-intro paths through your LinkedIn graph using Gmail- and Calendar-derived warmth signals via Anthropic's built-in MCP tools. It drafts both the bridge-ask (friend-for-favor) and the target message (with a forward-ready blurb), stages them into Gmail drafts, and never auto-sends.

## Why This Exists

The 2026 job search has two broken loops:

1. **Cold applications don't work.** Offer rates on cold applies sit at 0.1–2%; referrals hire at ~30%. Spraying more applications makes both sides of the market worse.
2. **AI job matchers surface roles you'd never take.** They score embedding similarity and ignore the things that actually matter: clearances you don't have, industries you refuse, seniority bands that don't fit, companies whose work you object to.

NetworkPipeline does the opposite of spray-and-apply. It helps you:

- filter aggressively against a criteria file *you* own and version,
- for every role that passes, find the highest-leverage warm path through your own network,
- and draft the outreach so you're asking for an introduction, not cold-messaging a stranger.

## Core Ideas

- `Criteria as code` — your hard constraints, values refusals, and soft preferences live in a YAML file you edit directly or with Claude. Versioned, diffable, forkable.
- `Deterministic gates` — hard constraints are pure code, not LLM prompts. Values refusals are a narrow LLM check. Soft preferences are LLM-scored with your calibration examples as anchors.
- `Multi-hop intro paths` — if you don't know anyone at the target, NetworkPipeline finds the best 2-hop path through your network and drafts both the bridge-ask and a forward-ready blurb the bridge can send verbatim.
- `Leverage, don't replace` — LinkedIn keeps your connections, Gmail keeps your mail, Calendar keeps your meetings. NetworkPipeline orchestrates them via MCP tools you already have in Claude Code.
- `Human approval on every send` — draft-only, always. No auto-send, no scraping, no policy evasion.
- `Search you've never had` — programmable saved searches aggregate Indeed, Greenhouse/Lever/Ashby boards, company career pages, and recruiter forwards into one stream. Values refusals and hard constraints fire *before* results land, so blocked companies and out-of-band roles never reach your inbox. Compose criteria overlays per search (`no-defense-companies` + `remote-only` + `senior-or-staff-only`) without keyword gymnastics.

## How It Ships

- A **NetworkPipeline MCP server** you register with Claude Code, exposing tools like `run_saved_search`, `evaluate_job`, `find_intro_paths`, `draft_bridge_message`, and `propose_criteria_change`.
- **Source connectors** that aggregate postings into the filter pipeline: Indeed (via Claude Code's built-in Indeed MCP), Greenhouse / Lever / Ashby public board APIs, company career pages via WebFetch, recruiter forwards via the Anthropic Gmail MCP, and a manual URL paste fallback. Spec in [`docs/discovery.md`](./docs/discovery.md).
- A **`/job-fit` Claude Code skill** that wraps the full filter → path → draft workflow in one conversational command.
- A **`/morning` Claude Code skill** that runs your saved searches and returns a digest (`run_saved_search`).
- A **`criteria-templates` repo** with starter criteria files and composable overlays (`no-defense-companies.yaml`, `no-crypto-only.yaml`, etc.) you can fork and combine.
- A **minimal Next.js review UI** on localhost for visually reviewing drafts and the pipeline, optional.

Claude Code is the primary interface. The web UI is a convenience.

## Example Session

```
You:    Run my morning searches.

Claude: [run_saved_search("ai_labs_mid_senior_remote_ok")]
        832 candidates discovered across indeed, greenhouse, lever, ashby,
        career_page (3 companies), recruiter_email (1 thread).
        Pre-extraction gates rejected 487 (company blocklist + seniority).
        Dedup collapsed 88 across-source duplicates + 41 already-seen.
        Evaluated 216. Cost: $1.04.

        Accepted (5):
          1. (0.93) Anthropic — Research Engineer, Agents (greenhouse)
          2. (0.88) Cohere — ML Eng, Tooling (lever)
          3. (0.81) Scale AI — Eval Lead (career_page)
          ...
        Near threshold (3):
          ...
        Want to inspect path #1?

You:    Yes — find intro paths for Anthropic.

Claude: Found 3 intro paths:
          1. (0.71) You → Sarah Lee → Marcus Chen (Research Eng, Agents)
          2. (0.55) You → James Park → Priya S.
          3. (0.48) You → Alice Wong (Designer, adjacent team)

        Recommend asking Sarah for intro to Marcus. Draft?

You:    yes

Claude: [draft to Sarah + forward-ready blurb for Marcus]

You:    approved — save as Gmail draft

Claude: Staged in Gmail. Label: networkpipeline/bridge-ask/p_7a2.
        I'll watch for Sarah's reply on next sync.
```

The single-paste flow is preserved as a secondary path for ad-hoc evaluation:

```
You:    Evaluate this Anthropic posting: https://...

Claude: ✓ PASS score 0.91
        Top factors: AI/ML eval systems, frontier labs, MCP
        Want intro paths?
```

## Principles

- Open-source core under an OSI-approved license (default `Apache-2.0`).
- Human approval before any outbound communication.
- Hard constraints are deterministic code, not LLM judgment.
- Private-by-default handling of user data. NetworkPipeline never holds Gmail or Calendar OAuth credentials.
- Replaceable components, not a locked stack.
- Native localhost quick-start before Docker.

## V1 Scope

- `candidate_criteria.yaml` schema, validator, versioning, overlays/extends
- `criteria-init` conversational onboarding
- Two-stage evaluation pipeline: extract → hard gates → values check → soft score
- Discovery layer: programmable saved searches across multi-source connectors (Indeed, Greenhouse, Lever, Ashby, company career pages, recruiter email, manual paste)
- Pre-extraction gate split: roughly half the hard gates run on connector metadata before any LLM extraction (cost-engineering for daily search)
- Content-hash dedup (`input_hash`) across sources and across runs
- LinkedIn CSV ingest → `people` + first-degree edges + `person_to_person_edges`
- Gmail/Calendar interaction ingest via Anthropic's MCP tools
- Warmth scoring with explainable components
- `find_intro_paths` with ranking and explanations
- `draft_bridge_message` (double-draft pattern) and `draft_target_message`
- Gmail draft staging via `mcp__claude_ai_Gmail__create_draft`
- Active learning loop: thumbs-down → `propose_criteria_change` → versioned accept
- Minimal Next.js review UI
- Evaluation harness with precision/recall snapshots in `docs/evaluation.md`

## V1 Non-Goals

- Technical interview prep (moved to `docs/future/prep.md`)
- Multi-provider AI adapters (Claude Code only in V1)
- Custom Gmail OAuth (replaced by Anthropic's Gmail MCP tool)
- LinkedIn scraping or browser automation. No public LinkedIn job-search API exists; we accept reduced LinkedIn coverage as a feature, not a bug — recruiter forwards into Gmail and user-pasted URLs cover the cases where it matters.
- Scheduling. V1 discovery is user-triggered (`run my morning searches`, `/morning`). Cron and push notifications are V2.
- Auto-apply. Discovery surfaces; user reviews; outreach drafts; user approves; user sends from Gmail.
- Private board APIs (Greenhouse-private, Lever auth, internal Ashby views). V1 only supports public boards.
- Full-fat kanban competing with Huntr/Teal
- Multi-user workspaces, team collaboration, or ATS features
- Auto-send of any message on any platform

## Docs

- [System and Flow Diagrams](./docs/system-flow.md)
- [Criteria System](./docs/criteria.md)
- [Discovery Layer](./docs/discovery.md)
- [Intro Path Engine](./docs/intro-paths.md)
- [Architecture](./docs/architecture.md)
- [Evaluation Harness](./docs/evaluation.md)
- [Requirements](./docs/requirements.md)
- [Design Proposal](./docs/design.md)
- [Domain Model](./docs/domain-model.md)
- [Schema Strategy](./docs/schema.md)
- [V1 Stack](./docs/stack.md)

## Local Run

1. `npm install`
2. `npm run start:local`
3. Register the MCP server with Claude Code:
   ```
   claude mcp add networkpipeline -- npx @networkpipeline/mcp-server
   ```
4. Open the optional review UI at `http://127.0.0.1:3000/dashboard`

Environment setup:

- Copy `.env.example` to `.env`
- `NETWORKPIPELINE_HOME` overrides the default `~/.networkpipeline/` directory
- `NETWORKPIPELINE_CRITERIA_PATH` overrides the criteria file path

Useful commands:

- `npm run typecheck`
- `npm run build`
- `npm run db:reset`

## Contributing

Criteria templates and overlays live in [criteria-templates](https://github.com/adawgwats/criteria-templates) (separate repo). PRs welcome.

## License

`Apache-2.0` (planned for V1 release).
