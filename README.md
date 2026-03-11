# NetworkPipeline

`NetworkPipeline` is an open-source system for managing a modern job search as a relationship pipeline, outreach workflow, and technical preparation loop.

The product direction combines:

- a private career CRM for people, companies, roles, applications, and referral paths
- human-reviewed AI assistance for outreach drafting, prioritization, and follow-up planning
- technical interview preparation tied to target roles, companies, and recent interview signals
- a provider-agnostic integration layer so users can plug in Codex, Claude, OpenAI-compatible APIs, local models, or self-hosted inference without changing the core product

## Status

The repository is in requirements-definition stage. The immediate goal is to lock the product scope, safety boundaries, and architecture constraints before implementation begins.

## Principles

- Fully open-source core with an OSI-approved license
- Human review before any outbound communication
- Provider-agnostic AI interfaces
- Private-by-default handling of user data
- Source-aware handling of time-sensitive interview information
- Replaceable components rather than one locked stack
- Native localhost quick start before Docker or hosted deployment

## V1 Focus

- Relationship and application tracking
- Outreach drafting, approval, and follow-up management
- Technical prep planning and study workflows
- Logging, tracing, and evaluation of AI outputs

## Non-Goals For V1

- Autonomous sending on LinkedIn or similar platforms
- Unauthorized scraping or policy-evasion workflows
- Proprietary-model-only features
- Building a full enterprise ATS

## Docs

- [Design Proposal](./docs/design.md)
- [Requirements](./docs/requirements.md)
- [Domain Model](./docs/domain-model.md)
- [Architecture](./docs/architecture.md)
- [V1 Stack](./docs/stack.md)
- [Schema Strategy](./docs/schema.md)

## Proposed Next Steps

1. Review and approve the V1 design proposal.
2. Refine the data model or architecture if the design changes.
3. Define the first portable SQL schema and migrations from the approved design.
4. Begin implementation only after design approval.
