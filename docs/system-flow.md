# System and Flow Diagrams

This doc collects mermaid diagrams for NetworkPipeline at multiple levels of zoom:

1. [System topology](#1-system-topology) — who runs where, what depends on what
2. [Evaluation flow](#2-evaluation-flow) — discovery preamble + one posting through the filter pipeline
3. [Intro-path flow](#3-intro-path-flow) — target role → ranked warm paths → drafted outreach
4. [Full lifecycle](#4-full-lifecycle) — discover → filter → intro → outreach → reply detection
5. [Provider cache lifecycle](#5-provider-cache-lifecycle) — how the Anthropic prompt cache amortizes
6. [Data model overview](#6-data-model-overview) — canonical / staging / trace separation
7. [Discovery sequence](#7-discovery-sequence) — connector-callback round-trip per source

Each diagram annotates with issue numbers (`#N`) for unbuilt pieces and `✓` for the parts already on `main`.

## 1. System topology

The architectural rule: **NetworkPipeline holds no third-party credentials.** Gmail, Calendar, and other external service access lives inside Claude Code's MCP sandbox; NetworkPipeline orchestrates via structured callbacks.

```mermaid
graph TB
    User([User in terminal])

    subgraph CC["Claude Code (single LLM driver)"]
        CCBuiltin["Anthropic-hosted MCP tools<br/>Gmail · Calendar · Indeed<br/>Scholar Gateway · WebFetch"]
        CCCustom["NetworkPipeline MCP tools<br/>run_saved_search · evaluate_job<br/>discover_jobs · record_*<br/>find_intro_paths · draft_*"]
    end

    subgraph External["External services"]
        Gmail[Gmail API]
        Cal[Google Calendar]
        Indeed[Indeed]
        GH[Greenhouse boards-api]
        Lever[Lever postings API]
        Ashby[Ashby posting-api]
        CPSites[Company career pages]
        Scholar[Semantic Scholar]
        Web[Public web]
    end

    subgraph NP["NetworkPipeline MCP server #22"]
        Registry["Tool registry<br/>Zod-validated"]

        subgraph Connectors["Source Connectors (discovery #NN)"]
            ConIndeed["indeed<br/>via Claude Indeed MCP"]
            ConGH["greenhouse<br/>HTTP boards-api"]
            ConLever["lever<br/>HTTP postings API"]
            ConAshby["ashby<br/>HTTP posting-api"]
            ConCP["career_page<br/>WebFetch + extractor"]
            ConRecr["recruiter_email<br/>via Claude Gmail MCP"]
            ConPaste["manual_paste<br/>shim for V0 path"]
        end

        subgraph Pkgs["Domain packages"]
            CriteriaPkg["@networkpipeline/criteria ✓<br/>YAML schema · validator<br/>extends/overlays #7<br/>versioning #8"]
            DiscoveryPkg["@networkpipeline/discovery #NN<br/>connectors · dedup<br/>pre-extraction gates<br/>SavedSearch · SearchRun"]
            EvaluatorPkg["@networkpipeline/evaluator ✓<br/>extract ✓ #9<br/>gates ✓ #10 (bipartite split #NN)<br/>values_check #11 · soft_score #12<br/>provider {anthropic, mock}"]
            GraphPkg["@networkpipeline/graph<br/>#15 #17 #18"]
            IngestPkg["@networkpipeline/ingest<br/>#14 #16<br/>(graph-side: Gmail/Cal interactions)"]
            OutreachPkg["@networkpipeline/outreach<br/>#19 #20 #21"]
        end

        subgraph Storage["Local-first storage"]
            DB[("SQLite #3<br/>canonical · staging · traces<br/>+ saved_searches · search_runs<br/>+ discovered_postings")]
            FS[("Local filesystem<br/>criteria.yaml · artifacts/<br/>db.sqlite")]
        end
    end

    WebUI["Optional review UI<br/>apps/web (deferred)"]

    User -->|prompts| CC
    CCBuiltin -.->|user-authorized,<br/>credentials in Claude sandbox| Gmail
    CCBuiltin -.-> Cal
    CCBuiltin -.-> Indeed
    CCBuiltin -.-> Scholar
    CCBuiltin -.-> Web

    CCCustom -->|stdio default<br/>HTTP for review UI| Registry
    Registry --> CriteriaPkg
    Registry --> DiscoveryPkg
    Registry --> EvaluatorPkg
    Registry --> GraphPkg
    Registry --> IngestPkg
    Registry --> OutreachPkg

    DiscoveryPkg --> ConIndeed
    DiscoveryPkg --> ConGH
    DiscoveryPkg --> ConLever
    DiscoveryPkg --> ConAshby
    DiscoveryPkg --> ConCP
    DiscoveryPkg --> ConRecr
    DiscoveryPkg --> ConPaste

    ConIndeed -.->|IngestInstruction<br/>routed via Claude| CCBuiltin
    ConRecr -.->|IngestInstruction<br/>routed via Claude| CCBuiltin
    ConCP -.->|WebFetch via Claude| CCBuiltin
    ConGH --> GH
    ConLever --> Lever
    ConAshby --> Ashby
    ConCP --> CPSites
    CCBuiltin -.-> Indeed
    CCBuiltin -.-> Gmail

    EvaluatorPkg -->|provider/anthropic<br/>direct API call| CCBuiltin
    CriteriaPkg --> DB
    CriteriaPkg --> FS
    DiscoveryPkg --> DB
    EvaluatorPkg --> DB
    GraphPkg --> DB
    IngestPkg --> DB
    OutreachPkg --> DB

    WebUI -->|HTTP localhost| Registry

    classDef built fill:#1f7a1f,stroke:#0a3d0a,color:#fff
    classDef pending fill:#7a5b1f,stroke:#3d2d0a,color:#fff
    classDef external fill:#1f4e7a,stroke:#0a253d,color:#fff
    class CriteriaPkg,EvaluatorPkg built
    class GraphPkg,IngestPkg,OutreachPkg,Registry,DB,WebUI,DiscoveryPkg,ConIndeed,ConGH,ConLever,ConAshby,ConCP,ConRecr,ConPaste pending
    class Gmail,Cal,Indeed,Scholar,Web,GH,Lever,Ashby,CPSites external
```

### Key boundaries

- **Claude Code is the only LLM caller** for orchestration. The evaluator package also makes a direct Claude API call from the Node process (the AnthropicJsonOutputProvider) — that's a separate API key from Claude Code's own session.
- **Gmail/Calendar credentials never enter NetworkPipeline.** The flow is: NetworkPipeline returns an instruction payload → Claude Code runs the Gmail MCP tool → Claude calls back into NetworkPipeline with structured results.
- **SQLite + local filesystem is the entire persistence layer.** No Redis, no Postgres, no S3 in V1.

## 2. Evaluation flow

What happens to one posting through the filter pipeline. The diagram below is unchanged from V0; it describes the *back half* of the full flow. The discovery preamble (`docs/discovery.md` §8) prepends to this:

```mermaid
flowchart TD
    UStart([User: "Run my morning searches"]) --> RSS["Claude calls<br/>run_saved_search(saved_search_id)"]
    RSS --> Disc["NetworkPipeline returns<br/>IngestInstruction (per-source work_items)"]
    Disc --> Fan["Claude fans out:<br/>Indeed MCP · Gmail MCP · WebFetch ·<br/>HTTP to Greenhouse/Lever/Ashby"]
    Fan --> Cb["Claude callback:<br/>record_discovered_postings(saved_search_id, postings[])"]
    Cb --> Norm["NetworkPipeline normalizes per connector<br/>(NormalizedDiscoveredPosting)"]
    Norm --> Pre["Pre-extraction gates (§5.1 of discovery.md)<br/>company · phrases · location · employment_type<br/>+ partial role_seniority via title regex"]
    Pre --> Dedup["Dedup by input_hash<br/>(within run + cross-run)"]
    Dedup --> SurvA{Survivor?}
    SurvA -->|rejected at pre-filter| WriteDP[("DiscoveredPosting<br/>pre_filter_status=rejected<br/>+ reason_code")]
    SurvA -->|dedup_existing| LinkPrior[("DiscoveredPosting<br/>pre_filter_status=dedup_existing<br/>links to prior job_evaluation_id")]
    SurvA -->|passed_for_eval| Survivors([Survivors → bulk_evaluate_jobs])
    Survivors --> EvalEnter

    classDef pending fill:#7a5b1f,stroke:#3d2d0a,color:#fff
    classDef reject fill:#7a1f1f,stroke:#3d0a0a,color:#fff
    classDef accept fill:#1f7a4e,stroke:#0a3d25,color:#fff
    class RSS,Disc,Fan,Cb,Norm,Pre,Dedup pending
    class WriteDP,LinkPrior reject
    class Survivors accept
```

The single-paste flow (V0) skips the discovery preamble — Claude calls `evaluate_job(text)` directly, which is `EvalEnter` below. Either way, the same filter pipeline runs:

```mermaid
flowchart TD
    EvalEnter([survivor or single-paste]) --> Claude["Claude Code calls<br/>evaluate_job(text)"]
    Start([User pastes posting URL or text]) --> Claude
    Claude --> Extract["extractJobFacts<br/>packages/evaluator/src/extract/extract.ts"]

    Extract --> EmptyCheck{Empty<br/>text?}
    EmptyCheck -->|yes| FailFast([Throw — no provider call])
    EmptyCheck -->|no| Hash["SHA-256 first 8 KiB normalized<br/>→ input_hash"]

    Hash --> CacheLookup[("Persisted job_evaluations<br/>{input_hash, criteria_version,<br/>extractor_version}")]
    CacheLookup --> CacheHit{Cached?}
    CacheHit -->|yes| Return([Return persisted verdict])
    CacheHit -->|no| Provider["JsonOutputProvider.generateJsonObject<br/>provider/anthropic.ts"]

    Provider --> AnthropicAPI["client.messages.create<br/>system: cache_control: ephemeral<br/>tools: zodToJsonSchema<br/>tool_choice: forced"]
    AnthropicAPI --> ToolBlock{tool_use<br/>block<br/>present?}
    ToolBlock -->|no| RetryNoTool[Retry with reminder]
    RetryNoTool -->|attempts left| AnthropicAPI
    RetryNoTool -->|exhausted| ProviderErr([ProviderValidationError])
    ToolBlock -->|yes| Zod["Zod safeParse<br/>extractedJobFactsSchema"]
    Zod --> ZodValid{Valid?}
    ZodValid -->|no| RetryZod["Retry: feed errors back<br/>into user message"]
    RetryZod -->|attempts left| AnthropicAPI
    RetryZod -->|exhausted| ProviderErr
    ZodValid -->|yes| BuildRun["Build ProviderRun<br/>tokens · cache_creation · cache_read<br/>cost_usd_cents · latency · retries"]

    BuildRun --> Facts["ExtractedJobFacts<br/>+ input_hash<br/>+ extractor_version"]

    Facts --> Gates["hardGateCheck<br/>packages/evaluator/src/gates/check.ts<br/>PURE CODE — no LLM"]

    Gates --> G1{1. must_not_<br/>contain_phrases}
    G1 -->|hit| Reject1[REJECT hard_gate:must_not_contain_phrases]
    G1 -->|pass| G2{2. company}
    G2 -->|hit| Reject2[REJECT hard_gate:company]
    G2 -->|pass| G3{3. industry}
    G3 -->|hit| Reject3[REJECT hard_gate:industry]
    G3 -->|pass| G4{4. required_<br/>clearance}
    G4 -->|hit| Reject4[REJECT hard_gate:required_clearance]
    G4 -->|pass| G5{5. role_seniority<br/>ALL signals blocked?}
    G5 -->|hit| Reject5[REJECT hard_gate:role_seniority]
    G5 -->|pass| G6{6-10. location_req,<br/>work_auth, location_allowed,<br/>employment_type, years_exp}
    G6 -->|any hit| RejectN[REJECT with stable reason_code]

    G6 -->|all pass| Values["values_check<br/>narrow LLM call #11"]
    Values --> ValuesOK{violation?<br/>confidence ≥ 0.6}
    ValuesOK -->|yes| RejectVal[REJECT values:slug]
    ValuesOK -->|no| Soft["soft_score #12<br/>LLM with calibration anchors"]

    Soft --> Score["score 0..1<br/>+ contributions[]<br/>+ rationale"]
    Score --> ThresholdCheck{score ≥<br/>min_soft_score?}
    ThresholdCheck -->|no| BelowThresh[Mark below_threshold]
    ThresholdCheck -->|yes| Accept[ACCEPTED]

    Accept --> Persist[("Persist to job_evaluations<br/>with criteria_version_id<br/>+ all provider_runs")]
    Reject1 --> Persist
    Reject2 --> Persist
    Reject3 --> Persist
    Reject4 --> Persist
    Reject5 --> Persist
    RejectN --> Persist
    RejectVal --> Persist
    BelowThresh --> Persist

    Persist --> Verdict([Return verdict + facts + reasons<br/>to Claude Code])

    classDef built fill:#1f7a1f,stroke:#0a3d0a,color:#fff
    classDef pending fill:#7a5b1f,stroke:#3d2d0a,color:#fff
    classDef pure fill:#1f4e7a,stroke:#0a253d,color:#fff
    classDef reject fill:#7a1f1f,stroke:#3d0a0a,color:#fff
    classDef accept fill:#1f7a4e,stroke:#0a3d25,color:#fff

    class Extract,Provider,AnthropicAPI,BuildRun,Facts,Zod built
    class Gates,G1,G2,G3,G4,G5,G6 pure
    class Values,Soft,Score,Persist,CacheLookup pending
    class Reject1,Reject2,Reject3,Reject4,Reject5,RejectN,RejectVal,BelowThresh,FailFast,ProviderErr reject
    class Accept,Verdict accept
```

### Why three stages

- **Hard gates** are deterministic code — auditable, free, and they catch the bulk of obvious rejects (clearance requirements, blocked companies, wrong seniority bands) without spending an LLM call.
- **Values check** is a narrow LLM call with a binary output. It catches semantic refusals that keyword filters can't (e.g., "this company makes ad-tech for adolescent gambling" wouldn't trigger any phrase blocklist).
- **Soft score** is the only stage that produces a float. Anchored by the user's calibration examples so it doesn't drift over time.

## 3. Intro-path flow

For any role that passes the filter, the intro-path engine answers "who do I know who can help me reach this?" with explainable ranking.

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant CC as Claude Code
    participant NP as NetworkPipeline MCP
    participant Gmail as Gmail MCP (Anthropic-hosted)
    participant Cal as Calendar MCP
    participant DB as SQLite

    U->>CC: "Evaluate this Anthropic posting"
    CC->>NP: evaluate_job(text)
    NP-->>CC: PASS, score 0.91

    CC->>NP: find_intro_paths(company, title, k=5)
    NP->>DB: load people, edges,<br/>warmth_components
    DB-->>NP: graph data

    Note over NP: BFS up to 3 hops<br/>score = warmth + edge + relevance<br/>+ willingness − length_penalty<br/>apply hard_multiplier

    NP-->>CC: 3 ranked paths + explanations<br/>strategy: ask_bridge

    U->>CC: "Draft the message to Sarah"
    CC->>NP: draft_bridge_message(path_id)

    Note over NP: Build double-draft:<br/>1. message to bridge<br/>2. forward-ready blurb<br/>Apply guardrails (no "huge fan", etc)

    NP->>NP: safety preflight<br/>(do_not_contact, cooldown,<br/>follow-up cap, values check)
    NP-->>CC: {to_bridge, forward_ready_blurb,<br/>rationale, evidence_used}

    U->>CC: "Approve, save as Gmail draft"
    CC->>NP: approve_and_stage_gmail_draft(draft_id)
    NP-->>CC: Gmail-ready payload

    CC->>Gmail: mcp__claude_ai_Gmail__create_draft(payload)
    Gmail-->>CC: gmail_thread_id
    CC->>Gmail: mcp__claude_ai_Gmail__label_thread<br/>networkpipeline/bridge-ask/path_id
    CC->>NP: record_gmail_draft_staged(thread_id)

    NP->>DB: bridge_asks: drafted → staged_in_gmail<br/>gmail_label_bindings row

    U->>U: sends from Gmail manually

    Note over U,Gmail: ... time passes ...

    U->>CC: "Sync replies"
    CC->>NP: ingest_gmail_interactions(since)
    NP-->>CC: instruction: query Gmail with<br/>label:networkpipeline/bridge-ask/* newer_than:7d

    CC->>Gmail: search_threads + get_thread per query
    Gmail-->>CC: thread bodies + metadata

    CC->>NP: record_gmail_interactions(extracted_facts)
    NP->>DB: person_interactions ++<br/>warmth_components recompute<br/>bridge_asks state advance

    NP-->>CC: "Sarah replied positively 2h ago.<br/>Bridge ask advanced to bridge_committed."
    CC-->>U: status update
```

### Why double-draft

The "forward-ready blurb" is the difference between an intro that happens and an intro that gets stuck in your bridge's mental TODO list. It's a complete, paste-ready message they can forward verbatim — removes the friction that causes "I'll introduce you when I get a chance" to drag on.

## 4. Full lifecycle

The end-to-end loop a user runs across days or weeks: criteria refinement, evaluation, intro-path discovery, outreach, reply detection, and active learning.

```mermaid
stateDiagram-v2
    [*] --> Onboarding

    Onboarding --> Discovering: criteria.yaml v1 saved
    note right of Onboarding
        criteria-init #8
        Conversational interview
        produces first criteria.yaml
    end note

    state Discovering {
        [*] --> Idle
        Idle --> Searching: run_saved_search /<br/>"Run my morning searches"
        Searching --> PreFiltering: connector callbacks land
        PreFiltering --> QueueingForFilter: survivors with<br/>pre_filter_status=passed_for_eval
        PreFiltering --> ReturningDigest: nothing survived /<br/>only dedup_existing
        QueueingForFilter --> ReturningDigest: bulk_evaluate_jobs done
        ReturningDigest --> Idle: digest delivered
    }

    Discovering --> Filtering: any survivor reaches evaluator

    state Filtering {
        [*] --> Evaluate
        Evaluate --> Reject: hard_gate or values
        Evaluate --> BelowThreshold: soft < min
        Evaluate --> Pass: score ≥ min
        Reject --> ThumbsCheck
        BelowThreshold --> ThumbsCheck
        ThumbsCheck --> ProposeChange: user thumbs up/down
        ProposeChange --> CriteriaBumped: user accepts diff
        CriteriaBumped --> [*]
    }

    Filtering --> IntroPaths: posting passes filter

    state IntroPaths {
        [*] --> ComputePaths
        ComputePaths --> RankExplain: BFS + score
        RankExplain --> AskBridge: top path is 2-hop
        RankExplain --> MessageDirect: top path is 1-hop strong
        RankExplain --> NoPath: nobody close enough
        NoPath --> ColdAlternative: surface as low-priority
    }

    IntroPaths --> Drafting

    state Drafting {
        [*] --> SafetyPreflight
        SafetyPreflight --> Blocked: do_not_contact / cooldown / cap
        SafetyPreflight --> Generate: clear
        Generate --> DoubleDraft: bridge case
        Generate --> SingleDraft: target case
        DoubleDraft --> Review
        SingleDraft --> Review
        Review --> Edited: user edits
        Edited --> Approved
        Review --> Approved: as-is
        Review --> Discarded: user rejects
    }

    Drafting --> GmailStaging: approved

    state GmailStaging {
        [*] --> StageDraft
        StageDraft --> ApplyLabels
        ApplyLabels --> AwaitSend: networkpipeline/bridge-ask/*
        AwaitSend --> SentManually: user sends from Gmail
    }

    GmailStaging --> AwaitingReply

    state AwaitingReply {
        [*] --> Quiet
        Quiet --> SyncCheck: user runs Sync replies
        SyncCheck --> NoChange: no reply yet
        NoChange --> Quiet
        SyncCheck --> Replied: positive
        SyncCheck --> Declined: negative
        SyncCheck --> Ghosted: 3 follow-ups, no reply
    }

    AwaitingReply --> Outcome

    state Outcome {
        Replied --> BridgeCommitted: bridge case
        BridgeCommitted --> IntroMade: bridge forwards
        IntroMade --> TargetConversation
        Replied --> RecruiterScreen: target case
        Declined --> Closed
        Ghosted --> WillingnessExhausted: bridge case
        WillingnessExhausted --> Closed
    }

    Outcome --> Discovering: log_outcome feeds back<br/>(criteria refinement → next search)
    note right of Outcome
        Outcomes update:
        - bridge_willingness_estimate
        - candidate calibration
        - eval-harness ground truth
    end note

    Outcome --> [*]
```

### Why this loop matters for evals

Every state transition writes a row somewhere — `outreach_events`, `bridge_asks` lifecycle, `outcome_labels` — that becomes ground truth for the eval harness (`docs/evaluation.md` §3). Reply rates, intro success rates, bridge-willingness calibration all flow from this lifecycle data.

## 5. Provider cache lifecycle

How `cache_control: ephemeral` actually saves money in practice.

```mermaid
sequenceDiagram
    autonumber
    participant E1 as Eval call 1
    participant E2 as Eval call 2 (within 5min)
    participant E3 as Eval call 3 (after 5min)
    participant E4 as Eval call after prompt bump
    participant Anthropic as Anthropic API + cache

    E1->>Anthropic: messages.create<br/>system: [{text: SYSTEM_PROMPT, cache_control: ephemeral}]<br/>messages: [posting #1]
    Note over Anthropic: Cache MISS<br/>cache_creation_input_tokens ≈ 800<br/>input_tokens ≈ 400 (posting)
    Anthropic-->>E1: tool_use + usage stats

    E2->>Anthropic: messages.create<br/>same system prompt<br/>messages: [posting #2]
    Note over Anthropic: Cache HIT (sliding 5-min TTL refreshed)<br/>cache_read_input_tokens ≈ 800 (10× cheaper)<br/>input_tokens ≈ 400 (only the new posting)
    Anthropic-->>E2: tool_use + usage stats

    Note over E2,E3: 6 minutes idle...

    E3->>Anthropic: messages.create<br/>same system prompt<br/>messages: [posting #3]
    Note over Anthropic: Cache MISS (TTL expired)<br/>cache_creation_input_tokens ≈ 800<br/>cache re-warmed
    Anthropic-->>E3: tool_use + usage stats

    Note over E4: Developer bumps EXTRACT_PROMPT_ID<br/>→ system prompt text changes by 1 byte

    E4->>Anthropic: messages.create<br/>NEW system prompt content<br/>messages: [posting #4]
    Note over Anthropic: Cache MISS (key invalidated by content change)<br/>fresh entry under new prompt key
    Anthropic-->>E4: tool_use + usage stats
```

### Why this matters operationally

- **Bulk evaluation of 10 postings within 5 minutes:** 1 cache-creation + 9 cache-reads. ~10× cost reduction on the cached prefix.
- **Walking away for an hour:** next call eats one cache-creation. Negligible.
- **Prompt versioning via `EXTRACT_PROMPT_ID`:** any deliberate prompt change forces re-warming, which is what we want — old cached entries reflect old behavior.
- **Cache is opportunistic, not load-bearing.** Correctness is independent of hit rate. Cost and latency are not. We measure both via `cache_creation_tokens` and `cache_read_tokens` on every `ProviderRun`.

## 6. Data model overview

The schema separates three logical layers (full spec in `docs/schema.md`).

```mermaid
erDiagram
    CANDIDATE_PROFILES ||--o{ CANDIDATE_EXPERIENCE_RECORDS : has
    CANDIDATE_PROFILES ||--o{ CANDIDATE_EDUCATION_RECORDS : has
    CANDIDATE_PROFILES ||--o{ APPLICATION_ASSETS : owns

    CANDIDATE_CRITERIA_VERSIONS ||--o{ JOB_EVALUATIONS : "scoped_by"
    CANDIDATE_CRITERIA_VERSIONS ||--o{ SEARCH_RUNS : "scoped_by"

    JOB_EVALUATIONS }o--|| CRITERIA_FILE : "validated_against"
    JOB_EVALUATIONS ||--o{ PROVIDER_RUNS : "trace"
    JOB_EVALUATIONS ||--o{ MCP_INVOCATIONS : "originated_from"

    SAVED_SEARCHES ||--o{ SEARCH_RUNS : "executed_as"
    SEARCH_RUNS ||--o{ DISCOVERED_POSTINGS : "produces"
    DISCOVERED_POSTINGS }o--o| JOB_EVALUATIONS : "links_to_when_evaluated"

    PEOPLE ||--o{ PERSON_ATTRIBUTES : has
    PEOPLE ||--o{ PERSON_INTERACTIONS : "interacted_with_user"
    PEOPLE ||--o{ WARMTH_COMPONENTS : "scored_by"
    PEOPLE ||--o{ PERSON_TO_PERSON_EDGES : "connects_via"

    INTRO_PATHS }o--|| PEOPLE : "routes_through"
    INTRO_PATHS }o--|| ROLES : "targets"
    INTRO_PATHS }o--|| CANDIDATE_CRITERIA_VERSIONS : "scoped_by"

    BRIDGE_ASKS }o--|| INTRO_PATHS : "implements"
    BRIDGE_ASKS }o--|| PEOPLE : "to_bridge"
    BRIDGE_ASKS }o--|| PEOPLE : "for_target"

    MESSAGE_DRAFTS }o--|| OUTREACH_THREADS : "belongs_to"
    MESSAGE_DRAFTS ||--o{ PROVIDER_RUNS : "generated_by"
    OUTREACH_THREADS ||--o{ OUTREACH_EVENTS : "log"

    APPLICATIONS }o--|| ROLES : "for"
    ROLES }o--|| COMPANIES : "at"

    GMAIL_LABEL_BINDINGS }o--|| OUTREACH_THREADS : "tags"

    CONVERSATION_IMPORTS ||--o{ FACT_PROPOSALS : "produces"
    FACT_PROPOSALS ||--o{ REVIEW_DECISIONS : "resolved_by"

    CANDIDATE_PROFILES {
        ulid id PK
        string display_name
        string current_title
        int years_experience
        text professional_summary
    }

    JOB_EVALUATIONS {
        ulid id PK
        string input_hash
        ulid criteria_version_id FK
        string verdict
        string reason_code
        json extracted_facts
        json gate_verdict
        float soft_score
    }

    PEOPLE {
        ulid id PK
        string full_name
        string linkedin_url
        bool do_not_contact
    }

    PERSON_TO_PERSON_EDGES {
        ulid id PK
        ulid from_person_id FK
        ulid to_person_id FK
        string edge_kind
        json evidence
        float confidence
    }

    INTRO_PATHS {
        ulid id PK
        string target_company
        ulid criteria_version_id FK
        json hops
        float path_score
        json score_components
    }

    BRIDGE_ASKS {
        ulid id PK
        ulid intro_path_id FK
        ulid bridge_person_id FK
        ulid target_person_id FK
        string status
    }

    PROVIDER_RUNS {
        ulid id PK
        string provider
        string model
        string prompt_id
        int input_tokens
        int output_tokens
        int cache_creation_tokens
        int cache_read_tokens
        float cost_usd_cents
    }

    CANDIDATE_CRITERIA_VERSIONS {
        ulid id PK
        int version
        string schema_version
        text yaml_snapshot
        string change_summary
        ulid triggered_by_evaluation_id FK
    }

    MCP_INVOCATIONS {
        ulid id PK
        string tool_name
        string args_hash
        string result_hash
        int latency_ms
    }

    CONVERSATION_IMPORTS {
        ulid id PK
        string source_type
        text raw_text
        string review_status
    }

    FACT_PROPOSALS {
        ulid id PK
        ulid conversation_import_id FK
        string target_table
        json proposed_payload
        float confidence
        string status
    }

    SAVED_SEARCHES {
        ulid id PK
        string label
        json sources
        string criteria_overlay_path
        string cadence
        bool is_active
    }

    SEARCH_RUNS {
        ulid id PK
        ulid saved_search_id FK
        ulid criteria_version_id FK
        string status
        int n_discovered
        int n_pre_filter_rejected
        int n_dedup_existing
        int n_evaluated
        int n_accepted
        float cost_usd_cents
    }

    DISCOVERED_POSTINGS {
        ulid id PK
        ulid search_run_id FK
        string source_id
        string source_external_id
        string url_canonical
        string input_hash
        string pre_filter_status
        string pre_filter_reason_code
        ulid job_evaluation_id FK
        json dedup_aliases
        json raw_metadata
    }
```

### Three-layer separation

- **Canonical** (people, roles, applications, message_drafts, bridge_asks, intro_paths, candidate_profiles) — the approved system of record the product reads from for ranking, drafting, and UI.
- **Staging** (conversation_imports, fact_proposals, review_decisions) — raw imports and AI proposals waiting for user approval. Never used directly by recommendation logic.
- **Trace** (provider_runs, mcp_invocations, candidate_criteria_versions, job_evaluations, outcome_labels) — observability and reproducibility data. The eval harness reads from here to compute precision/recall and ablation tables.

The rule: AI extractions land in staging, get reviewed, then flow to canonical. Trace tables are append-only and never gate behavior.

## 7. Discovery sequence

The full connector-callback round-trip from `run_saved_search` through digest delivery. Shows the per-source fan-out parallelism and the bipartite gate split (pre-extraction inside NetworkPipeline before `bulk_evaluate_jobs` fires).

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant CC as Claude Code
    participant NP as NetworkPipeline MCP
    participant Indeed as Indeed MCP
    participant GH as Greenhouse HTTP
    participant Lever as Lever HTTP
    participant Ashby as Ashby HTTP
    participant CP as Career page (WebFetch)
    participant Gmail as Gmail MCP
    participant DB as SQLite

    U->>CC: "Run my morning searches"
    CC->>NP: run_saved_search(saved_search_id)
    NP->>DB: insert SearchRun(status=running,<br/>criteria_version_id)
    NP-->>CC: IngestInstruction<br/>{ work_items: per-source }

    par Indeed
        CC->>Indeed: search_jobs(q, l, fromage_days)
        Indeed-->>CC: [job_keys]
        CC->>Indeed: get_job_details(selected)
        Indeed-->>CC: postings
    and Greenhouse boards (per slug, ≤4 conc)
        CC->>GH: GET /boards-api/.../jobs?content=true
        GH-->>CC: postings[]
    and Lever boards
        CC->>Lever: GET /v0/postings/{slug}?mode=json
        Lever-->>CC: postings[]
    and Ashby boards
        CC->>Ashby: GET /posting-api/job-board/{slug}
        Ashby-->>CC: postings[]
    and Career page
        CC->>CP: WebFetch(careers_url, extract_schema)
        CP-->>CC: extracted postings[]
    and Recruiter email
        CC->>Gmail: search_threads + get_thread<br/>label:networkpipeline/inbound/recruiter
        Gmail-->>CC: threads with embedded postings
    end

    CC->>NP: record_discovered_postings(saved_search_id, postings[])

    Note over NP: Normalize per connector<br/>NormalizedDiscoveredPosting

    NP->>NP: Pre-extraction gates (§5.1 of discovery.md)
    NP->>NP: Dedup by input_hash<br/>(within run + cross-run vs job_evaluations)
    NP->>DB: insert DiscoveredPosting rows<br/>(rejected · dedup_existing · passed_for_eval)

    NP-->>CC: SearchRunResult{<br/>survivors_for_eval,<br/>rejected_summary{by_reason_code},<br/>dedup_collapsed_count<br/>}

    CC->>NP: bulk_evaluate_jobs(survivors_for_eval)

    Note over NP: For each survivor:<br/>extract → post-extraction gates →<br/>values_check → soft_score<br/>(unchanged from §2)

    NP->>DB: insert JobEvaluation per survivor<br/>link to DiscoveredPosting
    NP->>DB: update SearchRun(status=completed,<br/>n_*, cost_usd_cents)

    NP-->>CC: digest {<br/>accepted: [...], near_threshold: [...],<br/>rejected: [...],<br/>cost_summary, time_to_first_accepted<br/>}
    CC-->>U: morning digest
```

### Why fan-out, not pipeline

Each source's wall-clock latency is dominated by network round-trips (1–10 s per board API; 30+ s for Indeed's two-phase fetch). Pipelining across sources would block on the slowest. Parallel fan-out drops `time_to_first_accepted` (`docs/evaluation.md` §3) closer to the slowest *single* connector instead of the *sum*.

### Why pre-extraction inside NetworkPipeline, not Claude

The pre-extraction gate decisions are deterministic, cheap, and benefit from direct DB access (cross-run dedup against `job_evaluations`). Doing this in Claude would add a second round-trip for no gain. Claude's role is fan-out and credentialed source access; NetworkPipeline's role is normalization, filtering, and persistence.

## Where to look in code

| Diagram concept | File |
|---|---|
| `extractJobFacts` flow | [packages/evaluator/src/extract/extract.ts](../packages/evaluator/src/extract/extract.ts) |
| Anthropic adapter + caching | [packages/evaluator/src/provider/anthropic.ts](../packages/evaluator/src/provider/anthropic.ts) |
| Hard-gate pipeline | [packages/evaluator/src/gates/check.ts](../packages/evaluator/src/gates/check.ts) |
| Gate ordering and reason codes | [packages/evaluator/src/gates/result.ts](../packages/evaluator/src/gates/result.ts) |
| Criteria YAML schema | [packages/criteria/src/schema.ts](../packages/criteria/src/schema.ts) |
| Criteria load + path resolution | [packages/criteria/src/load.ts](../packages/criteria/src/load.ts) |
| Provider abstraction | [packages/evaluator/src/provider/types.ts](../packages/evaluator/src/provider/types.ts) |
| `SourceConnector` interface (#NN) | `packages/discovery/src/connectors/types.ts` |
| Indeed connector (#NN) | `packages/discovery/src/connectors/indeed.ts` |
| Greenhouse connector (#NN) | `packages/discovery/src/connectors/greenhouse.ts` |
| Lever connector (#NN) | `packages/discovery/src/connectors/lever.ts` |
| Ashby connector (#NN) | `packages/discovery/src/connectors/ashby.ts` |
| Career-page connector (#NN) | `packages/discovery/src/connectors/career_page.ts` |
| Recruiter-email connector (#NN) | `packages/discovery/src/connectors/recruiter_email.ts` |
| Manual-paste shim (#NN) | `packages/discovery/src/connectors/manual_paste.ts` |
| Pre-extraction gate dispatch (#NN) | `packages/discovery/src/pre_extraction_gates.ts` |
| Dedup helpers (#NN) | `packages/discovery/src/dedup.ts` |
| Saved-search lifecycle (#NN) | `packages/discovery/src/saved_search.ts` |

## Related docs

- [Architecture](./architecture.md) — narrative version of these diagrams
- [Criteria System](./criteria.md) — the YAML schema and gate semantics; §6.5 documents the bipartite gate split
- [Discovery Layer](./discovery.md) — source connectors, dedup, saved searches
- [Intro Path Engine](./intro-paths.md) — ranking math and outreach contracts
- [Evaluation Harness](./evaluation.md) — how every flow above gets measured
