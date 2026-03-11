# NetworkPipeline Requirements

## 1. Product Summary

`NetworkPipeline` is a fully open-source system for running a relationship-driven job search.

It is intended to help users:

- manage connections, recruiters, referrals, companies, roles, and applications as a unified pipeline
- draft and review outreach safely before sending
- plan and execute technical interview preparation with current, source-backed context
- use whatever AI tooling stack they prefer without coupling the product to one vendor, model, or chat client

## 2. Problem Statement

The standard job application funnel is increasingly ineffective for experienced technical candidates. Cold applications are noisy, recruiter bandwidth is thin, and candidates often need to rely on warm introductions, targeted outreach, and better interview preparation.

The current tooling landscape is fragmented:

- CRMs are not designed for job-search relationships and referrals
- application trackers do not model people and outreach well
- AI productivity tools often optimize for automation instead of trust and review
- interview prep tools are disconnected from role-specific and company-specific context

## 3. Product Goals

1. Help users prioritize the best path into a role, not just log applications.
2. Make outreach more personalized, lower-risk, and easier to review.
3. Reduce the activation energy required to start and sustain technical interview prep.
4. Preserve user trust through transparent, inspectable, human-in-the-loop AI behavior.
5. Keep the core system fully open source and usable across hosted, local, and self-hosted AI stacks.

## 4. Open-Source Requirements

The project must satisfy the following open-source constraints:

- `OS-1`: Core source code must be released under an OSI-approved license.
- `OS-2`: Core product functionality must not require proprietary SaaS services operated by this project.
- `OS-3`: Self-hosting must be a first-class supported deployment path.
- `OS-4`: The product must not depend on source-available-only clauses for core code.
- `OS-5`: Users must be able to swap AI providers without rewriting core business logic.
- `OS-6`: Core schemas, prompts, workflows, and adapters should be inspectable and versionable in plain text.

Initial project defaults:

- `OS-D1`: The initial license choice should be `Apache-2.0` unless project needs change.

## 5. Primary Users

- `U-1`: Software engineers conducting relationship-driven job searches
- `U-2`: Experienced professionals managing recruiter, referral, and hiring-manager outreach
- `U-3`: Privacy-conscious users who want local or self-hosted model support
- `U-4`: Users who want AI assistance but do not want autonomous messaging

## 6. Product Principles

- `P-1`: Human approval before execution on external messaging surfaces
- `P-2`: Recommendation and execution must remain separate concerns
- `P-3`: Time-sensitive interview guidance must preserve source provenance and retrieval dates
- `P-4`: Users must be able to inspect why a recommendation was made
- `P-5`: The system should support incremental adoption instead of requiring one monolithic stack

## 7. Functional Requirements

### 7.1 Career CRM

- `FR-CRM-1`: The system must track people, companies, roles, applications, outreach threads, and referrals as first-class entities.
- `FR-CRM-2`: The system must allow users to record relationship strength, shared context, source of connection, and last interaction date.
- `FR-CRM-3`: The system must support tags or structured attributes for categories such as alumni, former coworker, recruiter, hiring manager, and referrer.
- `FR-CRM-4`: The system must support education history and school-affiliation data for people, including institution, program or degree, graduation year or date range, and optional student organizations or honors.
- `FR-CRM-5`: The system must make shared education context usable in filtering, search, ranking, and outreach drafting.
- `FR-CRM-6`: The system must support separate but linked pipelines for outreach and applications.
- `FR-CRM-7`: The system must support task management for follow-ups, prep tasks, and application milestones.

### 7.2 Outreach Copilot

- `FR-OUT-1`: The system must rank likely high-value contacts for a target role using user-defined and system-defined signals.
- `FR-OUT-2`: The system must draft personalized outreach using stored context, target role information, and optional user voice preferences.
- `FR-OUT-3`: The system must support multiple outreach intents such as advice request, recruiter handoff, referral request, and informational outreach.
- `FR-OUT-4`: The system must recommend follow-up timing, maximum follow-up count, and stop conditions.
- `FR-OUT-5`: The system must require explicit user review before any outbound content is finalized for sending.
- `FR-OUT-6`: The system must allow the user to mark contacts as do-not-contact or paused.
- `FR-OUT-7`: The system must store edits between model output and final approved draft for later evaluation.
- `FR-OUT-8`: The system must be able to use shared education signals such as common school, overlapping years, degree program, student groups, and academic honors when ranking contacts and drafting outreach.

### 7.3 Technical Preparation

- `FR-PREP-1`: The system must create a prep plan linked to a role, company, or interview loop.
- `FR-PREP-2`: The system must support prep topics across coding, systems design, behavioral, domain-specific, and company-specific categories.
- `FR-PREP-3`: The system must maintain a prep backlog with priority, estimated effort, due date, and confidence level.
- `FR-PREP-4`: The system must recommend the next best prep action based on user goals, available time, recent progress, and confidence gaps.
- `FR-PREP-5`: The system must connect prep plans to evidence such as recruiter notes, public interview reports, and user notes.
- `FR-PREP-6`: The system must help users break overwhelming prep goals into smaller sessions and concrete tasks.
- `FR-PREP-7`: The system must support linking to external practice tools such as LeetCode and tracking problem-level progress, notes, tags, and relevance to target roles or companies.
- `FR-PREP-8`: The system must be able to build curated practice sets from internal prep topics and linked external practice resources.
- `FR-PREP-9`: The system must use source-backed research and LLM-assisted synthesis to surface recent, role-relevant interview questions, patterns, and preparation themes.
- `FR-PREP-10`: The system must preserve provenance, retrieval date, and confidence for interview-question research used in prep recommendations.
- `FR-PREP-11`: The system must combine deterministic planning primitives such as backlog structure, time budgeting, spaced revisit rules, and coverage tracking with LLM-assisted recommendation and synthesis.
- `FR-PREP-12`: The system must adapt prep prioritization when struggle signals appear, such as repeated misses, rising solve time, low confidence, skipped topics, or explicit user feedback.

### 7.4 Research And Freshness

- `FR-RES-1`: The system must ingest and store structured and unstructured notes from trusted sources.
- `FR-RES-2`: The system must preserve source URLs, retrieval dates, timestamps, and confidence metadata for time-sensitive claims.
- `FR-RES-3`: The system must distinguish between evergreen guidance and rapidly changing interview information.
- `FR-RES-4`: The system must surface stale, weak, or conflicting evidence when generating recommendations.
- `FR-RES-5`: The system must let users attach personal notes and corrections to evidence items.

### 7.5 AI Portability

- `FR-AI-1`: The system must expose a stable provider interface for model inference tasks.
- `FR-AI-2`: The system must support hosted APIs, local models, and self-hosted inference endpoints.
- `FR-AI-3`: The system must support OpenAI-compatible APIs as the initial baseline adapter and minimum viable provider contract for V1.
- `FR-AI-4`: The system should support Anthropic-style adapters, local runtimes such as Ollama, and generic HTTP-backed model endpoints.
- `FR-AI-5`: The system must not require a specific chat client or branded UI to access core AI functionality.
- `FR-AI-6`: The system should support external tool integrations through HTTP, CLI wrappers, and MCP-compatible tools.
- `FR-AI-7`: The system must allow users to choose different providers for drafting, retrieval, ranking, and evaluation.

### 7.6 Evaluation And Learning

- `FR-EVAL-1`: The system must log prompts, context, outputs, user edits, approvals, and downstream outcomes.
- `FR-EVAL-2`: The system must support outcome labels such as reply, no reply, too generic, too aggressive, inaccurate, and stale.
- `FR-EVAL-3`: The system must allow users to review why a message or prep recommendation was generated.
- `FR-EVAL-4`: The system should support exporting data for offline analysis and future model tuning.

## 8. Safety And Trust Requirements

- `SAFE-1`: External messaging must default to draft-only behavior.
- `SAFE-2`: The system must enforce per-contact cooldowns, follow-up caps, and stop conditions.
- `SAFE-3`: The system must support explicit negative-signal states such as uninterested, not appropriate, and do-not-contact.
- `SAFE-4`: The system must not auto-send repeated outreach without human approval.
- `SAFE-5`: The system must not require unauthorized scraping or platform-policy-evasion techniques.
- `SAFE-6`: The system must clearly indicate when content was generated or revised with AI assistance.
- `SAFE-7`: The system must allow export and deletion of user-owned data.
- `SAFE-8`: The system must preserve an audit trail for recommendations, edits, and approvals.

## 9. Non-Functional Requirements

- `NFR-1`: The product should support local-first development.
- `NFR-2`: The product should support self-hosted deployment for solo users.
- `NFR-3`: The architecture should allow modular deployment of storage, API, worker, and UI components.
- `NFR-4`: The core domain model should be accessible through a documented API.
- `NFR-5`: The system should be usable without GPU requirements for baseline functionality.
- `NFR-6`: The system should degrade gracefully when AI providers are unavailable.
- `NFR-7`: The product should preserve clear data ownership and exportability.
- `NFR-8`: V0 and V1 should optimize for solo-user workflows and deployment simplicity before collaborative or team-oriented features.
- `NFR-9`: The first-party user experience for V1 should be web-first, with API and CLI support treated as secondary interfaces.

## 10. Data Model Requirements

Minimum first-class entities:

- `Person`
- `EducationRecord`
- `Company`
- `Role`
- `Application`
- `ReferralPath`
- `OutreachThread`
- `MessageDraft`
- `InterviewLoop`
- `PrepTopic`
- `PrepSession`
- `Task`
- `Source`
- `EvidenceItem`
- `OutcomeLabel`

Minimum relationship constraints:

- `DM-1`: A person may be linked to multiple companies and roles.
- `DM-2`: A person may be linked to multiple education records.
- `DM-3`: A role may be linked to multiple contacts, applications, and interview loops.
- `DM-4`: Outreach threads must be linkable to people, roles, and companies.
- `DM-5`: Prep topics and sessions must be linkable to roles, interview loops, and evidence items.
- `DM-6`: Evidence items must be usable by both outreach and prep workflows.

## 11. Architecture Requirements

- `ARCH-1`: The system should separate domain logic from model-provider adapters.
- `ARCH-2`: The system should separate retrieval and evidence storage from user-facing workflows.
- `ARCH-3`: The system should support a plugin or adapter model for AI providers and external tools.
- `ARCH-4`: The system should expose prompts and workflow definitions as editable configuration where practical.
- `ARCH-5`: The system should avoid hiding critical logic inside one vendor-specific orchestration product.

## 12. V1 Scope

V1 should include:

- solo-user-first workflows and deployment assumptions
- a web UI for the core CRM, outreach, and prep workflows
- career CRM with core entities and relationship tracking
- outreach ranking and draft generation with manual approval
- technical prep planning with backlog management
- evidence capture with freshness metadata
- provider-agnostic AI adapter layer with at least one OpenAI-compatible path
- audit logging for prompts, outputs, edits, and approvals

V1 should not include:

- direct autonomous sending on LinkedIn or similar platforms
- scraping-based social graph acquisition
- enterprise ATS workflows
- coach, recruiter, or team-collaboration workflows as first-class product surfaces
- multi-tenant SaaS billing or account administration

## 13. Success Metrics

- `MET-1`: Time from target-role selection to first approved outreach draft
- `MET-2`: Reply rate on approved outreach
- `MET-3`: Percentage of AI drafts requiring heavy rewrites
- `MET-4`: Number of prep tasks completed per week
- `MET-5`: User override rate on AI recommendations
- `MET-6`: Percentage of time-sensitive recommendations backed by fresh evidence

## 14. Decisions And Remaining Open Questions

Resolved product decisions:

1. `V0/V1 target user`: The first release should optimize strictly for solo users.
2. `Primary UX`: The first UX should be web-first.
3. `Prep direction`: The prep engine should integrate with practice tools such as LeetCode and use source-backed LLM workflows to find recent, relevant interview questions and themes.
4. `Prep engine behavior`: The prep engine should use a hybrid model with deterministic planning and tracking underneath, plus LLM-assisted recommendation and adaptive reprioritization based on observed struggle signals.

Provisional decisions:

1. `Minimum viable provider interface`: Start with an OpenAI-compatible adapter as the baseline provider contract for V1, then expand with additional adapters.
2. `License`: Default to `Apache-2.0` unless there is a clear reason to choose another OSI-approved license.

Remaining open questions:

- None captured in the current draft.
