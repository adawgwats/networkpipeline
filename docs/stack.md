# NetworkPipeline V1 Stack

## 1. Decision Summary

The V1 reference implementation should use:

- `TypeScript` across web, API, worker, and shared packages
- `npm workspaces` for the monorepo
- `Next.js` for the web app
- `Fastify` for the API service
- `SQLite` as the default local datastore
- a schema that remains portable to `PostgreSQL`
- `Drizzle ORM` for schema, queries, and migrations
- `Zod` for shared validation and contract definitions
- local file storage for raw artifacts and exports
- a connector layer with `read-only Gmail API` as the preferred first email connector
- native localhost deployment as the default quick-start path

## 2. Why This Stack

### 2.1 TypeScript First

Reasons:

- one language across UI, API, worker, and shared contracts
- easy sharing of schemas and status enums
- low friction for open-source contributors building web-first tooling
- good fit for HTTP-based AI adapters and job orchestration

### 2.2 npm Workspaces

Reasons:

- no extra package manager requirement for contributors
- Node is already available in the target environment
- simple enough for a small modular monolith

`pnpm` is still a reasonable future option, but it is not required to start.

### 2.3 Next.js For Web

Reasons:

- strong default for a web-first product
- handles routing, data fetching, and server rendering well
- easy path to an operator-console style UI
- large contributor familiarity

V1 usage:

- CRM screens
- outreach review flows
- prep dashboard
- settings and provider configuration

### 2.4 Fastify For API

Reasons:

- lighter than NestJS
- clearer separation than hiding domain logic in the Next.js app
- strong performance with minimal framework overhead
- good fit for modular route registration

V1 usage:

- CRUD endpoints
- command endpoints for ranking, drafting, and approvals
- auth and settings endpoints
- health and provider diagnostics

### 2.5 SQLite Default, PostgreSQL-Compatible

The product should be `SQL-first`, but not `PostgreSQL-first`.

Recommended storage shape:

- `SQLite` default for local and solo-user deployments
- `PostgreSQL` optional for higher-concurrency and server-style deployments
- local filesystem for large raw artifacts

Why `SQLite` is the right default:

- zero extra services to install
- good fit for a single-user workflow app
- very strong portability across modern PCs
- easier backup and migration for local-first users

Why keep `PostgreSQL` compatibility:

- preserves an upgrade path
- supports more concurrent write-heavy deployments later
- allows a separate worker process without redesigning the data model

### 2.6 Storage Tradeoffs

| Option | Strengths | Weaknesses | Decision |
|---|---|---|---|
| `SQLite` | Zero-config, local-first, single-file backup, strong relational support | Weaker for heavy multi-process concurrency | `Default` |
| `PostgreSQL` | Better concurrency, richer extension ecosystem, stronger server deployment story | Higher setup and ops cost for solo users | `Optional upgrade path` |
| `DuckDB` | Great local analytics | Not a good primary transactional store | `Analytics/export only if needed later` |
| `MongoDB` | Flexible document storage | Poorer fit for relational workflow state and approvals | `Not primary` |
| `Graph DB` | Good for graph traversal | Overkill for V1, most state is relational | `Not primary` |
| `Vector DB` | Useful for semantic retrieval | Not a system-of-record database | `Not primary` |
| `JSON/files only` | Very portable | Weak integrity, querying, and auditability | `Use only for raw artifact storage` |

### 2.7 AI-Oriented Storage Pattern

The schema should separate three kinds of data:

1. `canonical records`: approved entities used by the product
2. `staging records`: imports, extraction proposals, and review decisions
3. `trace records`: provider runs, prompts, outputs, and outcome labels

This matters because AI-generated facts should not go straight into canonical business tables without review.

### 2.8 Drizzle ORM

Reasons:

- SQL-friendly rather than hiding the database shape
- good fit for a relational domain model
- easy to keep schema close to the actual database design
- low-friction TypeScript integration

### 2.9 Background Jobs

V1 should not hard-require a queue technology that depends on `PostgreSQL`.

Recommended approach:

- local mode: in-process background job runner
- upgraded server mode: separate worker process behind the same job interface
- defer `pg-boss` or other queue-specific decisions until the upgraded deployment path is actually needed

### 2.10 Deployment Strategy

Deployment priority for V1:

1. `native localhost` as the default user and contributor quick start
2. `Docker Compose` as the supported secondary path
3. hosted/server deployment later

Why native first:

- lowest-friction path for solo users
- best fit for embedded `SQLite` and local file storage
- simpler OAuth flows for local connectors such as Gmail

Why Docker second:

- more reproducible for contributors
- useful when optional services are introduced
- better fit for advanced or server-style deployments

### 2.11 Connector Strategy

Connector priority for V1:

1. `Gmail API read-only` for bulk and incremental ingestion of application-related email history
2. fallback connectors for uploaded exports, pasted content, or forwarded intake mail

Why this order:

- Gmail read-only sync is the lowest-effort path for users with large recent application history
- fallback connectors are still required because some school or work accounts may block OAuth app access
- all connector outputs should reuse the same staging and review pipeline

### 2.12 Zod

Reasons:

- shared runtime validation between API and UI
- useful for provider adapter contracts
- good fit for command payload validation and import parsing

## 3. What We Are Not Choosing For V1

Not chosen for now:

- microservices
- Kubernetes as a required deployment path
- Redis as a required dependency
- a separate vector database
- Postgres-only local deployment assumptions
- a Python-first backend
- a vendor-specific agent framework as the core runtime

These can still be added later if the problem justifies them.

## 4. Repo Shape

The repository should follow this structure:

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
```

## 5. Immediate Build Plan

1. Create the workspace skeleton.
2. Add shared domain schemas and enums.
3. Add a portable SQL schema and migration tooling.
4. Implement CRM resources first.
5. Add connector abstractions and the first Gmail read-only connector.
6. Add draft generation and approval flows.
7. Add prep planning and evidence ingestion after the CRM and outreach baseline works.
