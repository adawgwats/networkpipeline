# NetworkPipeline V1 Architecture

## 1. Goals

The V1 architecture should satisfy four constraints at the same time:

1. stay easy to self-host for solo users
2. preserve clean boundaries between domain logic and AI providers
3. support long-running background work such as research and draft generation
4. remain simple enough to ship as a modular monolith first

## 2. Recommended Shape

V1 should start as a modular monolith with separately deployable components:

- `web`: browser UI for CRM, outreach, prep, review, and settings
- `api`: main application server and domain boundary
- `jobs`: background execution for AI tasks, evidence ingestion, ranking refreshes, and async imports
- `db`: SQL database with `SQLite` as the default local mode and `PostgreSQL` as the higher-concurrency option
- `artifact_store`: local disk by default, with optional S3-compatible storage for upgraded deployments
- `connector_layer`: source-specific ingestion adapters, with Gmail API read-only as the preferred first email connector

This is intentionally not a microservice architecture. V1 does not need the operational cost.

Recommended deployment modes:

- `default local mode`: native localhost run with web + api + in-process jobs + SQLite + local filesystem
- `docker mode`: Docker Compose with the same app modules, optionally adding PostgreSQL and a separate worker
- `upgraded mode`: server-style deployment with PostgreSQL + optional object storage

## 3. Top-Level Component Diagram

```text
+---------+      HTTPS      +---------+      SQL      +------------+
| Browser | <-------------> |   API   | <-----------> | SQL Store  |
+---------+                 +---------+               +------------+
                                |
                                | job dispatch
                                v
                           +--------------+
                           | Jobs Runtime |
                           +--------------+
                                |
                    +----------+------------+-----------+
                    |                       |           |
                    v                       v           v
              +------------+        +-------------+ +------------+
              | AI Adapter |        | Source Fetch| | Connectors |
              +------------+        +-------------+ +------------+
                    |                       |           |
                    v                       v           v
             hosted/local LLMs       public/user data   Gmail/fallback inputs
```

## 4. Core Modules

The codebase should be split into domain-driven modules inside the API and worker:

- `crm`
- `outreach`
- `prep`
- `research`
- `evaluation`
- `ai_runtime`
- `connectors`
- `tasks`
- `settings`

Each module should own:

- domain entities
- validation rules
- commands and queries
- persistence mappings
- public service interfaces

## 5. Data Storage

### 5.1 Primary Database

Use a portable SQL-first design.

Recommended choice:

- `SQLite` as the default canonical database for solo-user and local-first deployments
- `PostgreSQL` as an optional upgrade path for higher write concurrency, multi-process worker execution, or hosted deployments

Why SQL:

- the core product is relational and stateful
- approvals, outreach state, prep state, and evidence links need strong integrity
- SQL is a better fit than document or graph stores for the primary system of record

Why `SQLite` by default:

- zero extra service to install or operate
- excellent fit for a solo-user workflow product
- fast enough for the expected V1 workload on modern PCs
- simple backup, portability, and local-first ergonomics

Why keep the schema `PostgreSQL`-compatible:

- preserves an upgrade path without redesigning the data model
- supports a future dedicated worker and higher-concurrency deployment mode
- allows optional use of richer database capabilities later without making them mandatory now

Why not make `PostgreSQL` the default:

- it adds setup and operational burden for solo users
- it is unnecessary for most expected V1 local workloads
- it would make the self-hosting story worse on the machines most users already own

### 5.2 Files And Exports

Support either:

- local file storage for default local and self-hosted single-node setups
- S3-compatible object storage for upgraded deployments

Initial uses:

- CSV imports and exports
- generated report exports
- optional attachments

### 5.3 Search And Retrieval

V1 should avoid introducing a separate search cluster unless required.

Suggested path:

1. use SQL-native filtering plus `SQLite FTS5` or PostgreSQL text search depending on the selected database
2. add embedding support only when evidence retrieval quality requires it
3. delay external vector databases until usage proves they are necessary

## 6. Request And Job Flow

### 6.1 Synchronous Flows

Keep these synchronous in V1:

- CRUD operations on core entities
- filtering and list views
- basic task updates
- draft approval
- lightweight ranking reads from cached scores

### 6.2 Asynchronous Flows

Run these in the jobs runtime:

- outreach draft generation
- prep plan generation
- evidence ingestion and summarization
- ranking recomputation
- import jobs
- connector sync jobs
- export jobs

This keeps the web UI responsive and makes provider failures easier to isolate.

V1 local-mode note:

- in `SQLite` local mode, these jobs can run in-process without a separate external queue service
- in upgraded deployments, the same job interface can be backed by a separate worker process

## 7. AI Runtime Boundary

The most important architecture rule is that model providers stay behind a stable adapter layer.

### 7.1 Adapter Interface

Each provider adapter should implement a common contract similar to:

```text
generate(task_type, prompt, context, options) -> result
embed(texts, options) -> vectors
healthcheck() -> status
```

The domain layer should not know vendor-specific request shapes.

### 7.2 Supported Provider Types

V1 target adapters:

- OpenAI-compatible HTTP endpoints
- Anthropic-style adapter
- Ollama or similar local runtime
- generic HTTP adapter for self-hosted inference

### 7.3 Task Profiles

The runtime should support task-specific model selection:

- `contact_ranking`
- `outreach_draft`
- `prep_plan`
- `research_synthesis`
- `evaluation_summary`

This lets users route different tasks to different models without changing domain code.

## 7.5 Connector Boundary

External data ingestion should sit behind a connector layer with a stable interface.

Suggested connector contract:

```text
connect() -> connection_state
sync(cursor, options) -> import_batch
disconnect() -> connection_state
healthcheck() -> status
```

V1 connector priority:

1. `Gmail API read-only` for email-based application and outreach ingestion
2. fallback import connectors such as uploaded export files, pasted content, or forwarded intake mail

Important rule:

- all connectors must feed the same staging, extraction, and review pipeline

## 8. Evidence And Freshness Pipeline

Research and freshness should be handled as a first-class subsystem.

Suggested flow:

1. create or import a `Source`
2. fetch or store source content
3. extract one or more `EvidenceItem` records
4. assign freshness and confidence metadata
5. link evidence to relevant `Role`, `Company`, `Person`, or `PrepTopic`
6. use evidence in ranking, drafting, and prep recommendations

Important rule:

- every time-sensitive recommendation should be traceable to one or more evidence items

## 8.5 Candidate Context Intake Pipeline

Before outreach or prep recommendations become trustworthy, the system needs a canonical view of the user.

Suggested flow:

1. user uploads or pastes resumes, cover letters, application logs, outreach logs, or exported chat history
2. API stores raw artifacts and creates `ConversationImport` or `ApplicationAsset` records
3. worker extracts candidate facts, applications, contacts, and prior outreach context
4. extracted facts are written as pending structured updates to `CandidateProfile`, `ExperienceRecord`, and related entities
5. user reviews, edits, and approves the extracted facts
6. only approved facts are used by ranking, drafting, and prep recommendations

Important rule:

- the system should not silently treat raw imported chat context as canonical truth without user review

## 8.6 Email Connector Strategy

Preferred first path:

1. user authorizes a read-only Gmail connector
2. connector performs an initial recent-history sync
3. connector stores raw message metadata and extracted text as imported context
4. extraction produces candidate facts, application hints, outreach hints, and recruiter/contact hints
5. user reviews proposals before canonical records are updated

Fallback paths:

- uploaded export files
- pasted message content
- forwarded intake mailbox

Design rule:

- fallback methods should reuse the same downstream review pipeline instead of creating parallel business logic

## 9. Outreach Safety Pipeline

Outbound messaging should remain draft-only in V1.

Suggested flow:

1. user selects a role and candidate contacts
2. API creates or updates `OutreachThread`
3. worker generates one or more `MessageDraft` records
4. UI shows rationale, evidence, and any cooldown warnings
5. user edits and approves a draft
6. system records approval, but external sending remains manual
7. user records whether the message was sent and whether a reply was received

Safety checks should run before a draft is shown as ready:

- contact is not marked `do_not_contact`
- cooldown window has passed
- follow-up cap has not been exceeded
- evidence used for personalization is not stale or unsupported

## 10. Prep Engine Shape

The prep engine should be hybrid by design.

Deterministic layer:

- coverage tracking
- session scheduling
- spaced revisit rules
- due dates
- confidence tracking
- struggle-signal accumulation

LLM-assisted layer:

- plan generation
- next-best-action suggestions
- topic explanations
- synthesis of recent interview reports
- creation of practice sets from evidence and target roles

This keeps the system auditable while still benefiting from flexible synthesis.

## 11. Integration Strategy

### 11.1 Practice Tools

Practice integrations should be low-risk and replaceable.

V1 should start with:

- link-based references to external practice items
- user-entered progress and notes
- import adapters when a stable official or user-controlled path exists

The architecture should not depend on fragile automation against third-party platforms.

### 11.2 External Messaging Surfaces

Messaging surfaces such as LinkedIn or email should be treated as external execution layers.

V1 should support:

- copy-ready message drafts
- exportable message histories
- manual sent and reply logging

V1 should not require:

- automated browser control
- scraping-based graph extraction
- autonomous direct messaging

### 11.3 Email Ingestion Connectors

V1 should prioritize:

- read-only Gmail API access as the preferred email connector

V1 should also support fallback ingestion when the preferred route fails:

- uploaded archives or exports
- pasted message content
- forwarded copies to an intake address

## 12. Observability And Evaluation

The system should log:

- provider runs
- prompt versions
- user edits
- approvals
- outcome labels
- errors and retries

V1 trace storage can live in the primary SQL database. If needed later, the project can add a dedicated tracing backend without changing the domain model.

## 13. Auth And Multi-Tenancy

V1 should optimize for solo users.

Suggested approach:

- local account bootstrap or simple single-user auth
- one owner workspace by default
- explicit domain separation so multi-user workspaces can be added later

Avoid early complexity from:

- RBAC
- team invites
- per-org billing
- multi-tenant isolation layers

## 14. Deployment Model

Recommended initial deployment options:

- native local development with embedded `SQLite`
- native self-hosted single-node production with embedded `SQLite`
- optional Docker Compose deployment for standardized local or upgraded setups
- optional later support for Kubernetes, not required for V1

Minimum services for a default deployment:

- web
- api
- embedded SQL database
- in-process jobs runtime

Optional services:

- separate worker
- PostgreSQL
- local model runtime
- object storage

Deployment recommendation order:

1. native localhost quick start
2. Docker Compose
3. hosted or server-style deployment

## 15. Suggested Repository Layout

```text
apps/
  web/
  api/
  worker/
packages/
  domain/
  ai-adapters/
  config/
  ui/
docs/
  requirements.md
  domain-model.md
  architecture.md
```

This keeps UI, runtime, and shared domain code clearly separated.

## 16. Build Order

Recommended implementation order:

1. shared domain package with schemas and status enums
2. portable SQL schema and migrations
3. API for CRM entities and tasks
4. web UI for people, roles, and outreach threads
5. jobs runtime with one OpenAI-compatible adapter
6. draft-generation and approval workflow
7. prep topics, sessions, and practice items
8. evidence ingestion and freshness tracking

## 17. Deferred Decisions

These can wait until after the first code skeleton:

- whether embeddings are needed in V1
- whether a separate queue backend is necessary beyond local in-process jobs
- whether PostgreSQL mode needs a dedicated job runner such as `pg-boss`

Reference stack decisions are captured in [stack.md](./stack.md).
