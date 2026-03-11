# NetworkPipeline V1 Domain Model

## 1. Scope

This document turns the product requirements into a concrete V1 domain model.

This is the logical model. The proposed physical table layout, including portability decisions for `SQLite` and `PostgreSQL`, is documented in [schema.md](./schema.md).

V1 assumptions:

- single-user first
- web-first UX
- one primary owner per deployment
- relationship pipeline, outreach workflow, and prep workflow share one source of truth

The model is designed to stay simple enough for a modular monolith while preserving clear boundaries for future extraction.

## 2. Bounded Contexts

The V1 domain is divided into five contexts:

1. `CRM`: people, companies, roles, applications, education, and referral paths
2. `Outreach`: threads, drafts, approvals, follow-ups, and do-not-contact controls
3. `Prep`: interview loops, prep topics, sessions, practice items, and study plans
4. `Research`: sources, evidence items, freshness, and provenance
5. `Evaluation`: AI runs, edits, approvals, and downstream outcome labels

## 3. Entity Overview

### 3.1 User

Represents the deployment owner.

Key fields:

- `id`
- `display_name`
- `email`
- `timezone`
- `default_ai_profile`
- `created_at`
- `updated_at`

V1 note:

- V1 can treat this as a singleton owner record even if the schema keeps it explicit.

### 3.1.1 CandidateProfile

Represents the user's canonical professional profile inside the system.

Key fields:

- `id`
- `user_id`
- `professional_summary`
- `current_title`
- `current_company`
- `years_experience`
- `primary_location`
- `dream_job_description`
- `acceptable_job_description`
- `target_roles`
- `target_industries`
- `location_preferences`
- `compensation_preferences`
- `constraints`
- `notes`
- `created_at`
- `updated_at`

Design note:

- this is the canonical profile used for outreach personalization, role prioritization, and prep planning

### 3.1.2 ExperienceRecord

Represents the user's work history.

Key fields:

- `id`
- `candidate_profile_id`
- `company_name`
- `title`
- `start_date`
- `end_date`
- `is_current`
- `summary`
- `skills`
- `achievements`
- `notes`

### 3.1.3 ApplicationAsset

Represents a versioned user-owned artifact used in job applications.

Key fields:

- `id`
- `candidate_profile_id`
- `asset_type`
- `label`
- `storage_path`
- `source_format`
- `text_content`
- `is_default`
- `created_at`
- `updated_at`

Examples of `asset_type`:

- `resume`
- `cover_letter`
- `portfolio`
- `referral_note`
- `case_study`

### 3.1.4 ConversationImport

Represents imported unstructured context such as a pasted chat session or historical note thread.

Key fields:

- `id`
- `candidate_profile_id`
- `source_type`
- `source_label`
- `raw_text`
- `parse_status`
- `review_status`
- `imported_at`
- `created_at`
- `updated_at`

Examples of `source_type`:

- `chat_export`
- `manual_note`
- `spreadsheet_import`
- `application_log`
- `outreach_log`

### 3.1.5 ConnectorAccount

Represents an external ingestion connection owned by the candidate.

Key fields:

- `id`
- `candidate_profile_id`
- `connector_type`
- `account_identifier`
- `access_mode`
- `status`
- `connected_at`
- `disconnected_at`
- `last_successful_sync_at`
- `created_at`
- `updated_at`

Examples of `connector_type`:

- `gmail_readonly`
- `forwarded_intake`
- `upload_import`

### 3.1.6 ConnectorSyncState

Represents connector sync progress.

Key fields:

- `id`
- `connector_account_id`
- `cursor_kind`
- `cursor_value`
- `last_synced_at`
- `last_error`
- `created_at`
- `updated_at`

### 3.1.7 ConnectorMessage

Represents a raw message imported through a connector before it is normalized into reviewed job-search context.

Key fields:

- `id`
- `connector_account_id`
- `external_message_id`
- `external_thread_id`
- `source_timestamp`
- `direction`
- `from_address`
- `to_addresses`
- `subject`
- `body_text`
- `raw_metadata`
- `ingest_status`
- `conversation_import_id`
- `created_at`
- `updated_at`

### 3.2 Person

Represents a contact in the user's job-search network.

Key fields:

- `id`
- `full_name`
- `headline`
- `primary_email`
- `linkedin_url`
- `location`
- `relationship_strength`
- `connection_source`
- `notes`
- `do_not_contact`
- `last_contacted_at`
- `last_replied_at`
- `created_at`
- `updated_at`

Examples of `connection_source`:

- `linkedin`
- `alumni`
- `former_coworker`
- `recruiter`
- `friend`
- `event`
- `manual`

### 3.3 EducationRecord

Represents school affiliation for either the candidate or a contact.

Key fields:

- `id`
- `person_id`
- `candidate_profile_id`
- `institution_name`
- `program_name`
- `degree_type`
- `start_year`
- `end_year`
- `is_current`
- `student_groups`
- `honors`
- `notes`

V1 note:

- exactly one of `person_id` or `candidate_profile_id` should be set
- `student_groups` and `honors` can be stored as JSON arrays or normalized later.

### 3.4 Company

Represents a target employer, current employer, or historical employer tied to people or roles.

Key fields:

- `id`
- `name`
- `company_type`
- `industry`
- `headquarters`
- `website_url`
- `careers_url`
- `notes`
- `created_at`
- `updated_at`

### 3.5 PersonCompanyAffiliation

Represents a person's relationship to a company.

Key fields:

- `id`
- `person_id`
- `company_id`
- `title`
- `affiliation_type`
- `start_date`
- `end_date`
- `is_current`
- `notes`

Examples of `affiliation_type`:

- `employee`
- `former_employee`
- `recruiter`
- `hiring_manager`
- `contractor`

### 3.6 Role

Represents a job target or known opening.

Key fields:

- `id`
- `company_id`
- `title`
- `employment_type`
- `location`
- `level`
- `job_posting_url`
- `job_posting_source`
- `salary_range_text`
- `status`
- `notes`
- `created_at`
- `updated_at`

Suggested `status` values:

- `prospecting`
- `targeting`
- `active`
- `paused`
- `closed`
- `archived`

### 3.7 Application

Represents one application attempt for a role.

Key fields:

- `id`
- `role_id`
- `applied_at`
- `application_source`
- `status`
- `resume_asset_id`
- `cover_letter_asset_id`
- `external_application_id`
- `notes`
- `created_at`
- `updated_at`

Suggested `status` values:

- `draft`
- `submitted`
- `screen`
- `interview`
- `offer`
- `rejected`
- `withdrawn`
- `archived`

### 3.8 RoleContact

Represents a person's relevance to a target role.

Key fields:

- `id`
- `role_id`
- `person_id`
- `relationship_to_role`
- `warmth_score`
- `education_overlap_score`
- `referral_likelihood`
- `priority_reason`
- `created_at`
- `updated_at`

Examples of `relationship_to_role`:

- `recruiter`
- `hiring_manager`
- `teammate`
- `alumni`
- `referrer`
- `friend_of_friend`

### 3.9 ReferralPath

Represents a route from the user to a role through one or more people.

Key fields:

- `id`
- `role_id`
- `path_summary`
- `path_length`
- `strength_score`
- `status`
- `notes`
- `created_at`
- `updated_at`

Suggested `status` values:

- `candidate`
- `requested`
- `in_progress`
- `successful`
- `blocked`
- `expired`

### 3.10 OutreachThread

Represents a conversation track with one person for a specific role or purpose.

Key fields:

- `id`
- `person_id`
- `role_id`
- `company_id`
- `intent`
- `channel`
- `status`
- `cooldown_until`
- `follow_up_count`
- `max_follow_ups`
- `last_message_at`
- `last_reply_at`
- `notes`
- `created_at`
- `updated_at`

Examples of `intent`:

- `advice`
- `context`
- `referral`
- `recruiter_handoff`
- `networking`

Suggested `status` values:

- `drafting`
- `ready_for_review`
- `waiting_to_send`
- `waiting_for_reply`
- `replied`
- `closed`
- `paused`

### 3.11 MessageDraft

Represents a generated or manually created draft message.

Key fields:

- `id`
- `thread_id`
- `provider_run_id`
- `draft_kind`
- `status`
- `subject`
- `body_text`
- `rationale`
- `tone`
- `approved_at`
- `discard_reason`
- `created_at`
- `updated_at`

Suggested `status` values:

- `generated`
- `edited`
- `approved`
- `sent_externally`
- `discarded`

Examples of `draft_kind`:

- `initial_outreach`
- `follow_up`
- `thank_you`
- `referral_request`

### 3.12 InterviewLoop

Represents an interview process for an application or target role.

Key fields:

- `id`
- `role_id`
- `application_id`
- `loop_name`
- `status`
- `scheduled_start_at`
- `scheduled_end_at`
- `notes`
- `created_at`
- `updated_at`

Suggested `status` values:

- `anticipated`
- `scheduled`
- `active`
- `completed`
- `cancelled`

### 3.13 PrepTopic

Represents a topic the user needs to study.

Key fields:

- `id`
- `role_id`
- `interview_loop_id`
- `category`
- `name`
- `priority`
- `confidence`
- `coverage_state`
- `notes`
- `created_at`
- `updated_at`

Examples of `category`:

- `coding`
- `systems_design`
- `behavioral`
- `domain`
- `company_specific`

Suggested `coverage_state` values:

- `unstarted`
- `in_progress`
- `covered`
- `needs_revisit`

### 3.14 PracticeItem

Represents an external or internal practice artifact, such as a LeetCode problem.

Key fields:

- `id`
- `prep_topic_id`
- `source_name`
- `external_url`
- `external_identifier`
- `title`
- `difficulty`
- `tags`
- `relevance_score`
- `notes`
- `created_at`
- `updated_at`

Examples of `source_name`:

- `leetcode`
- `neetcode`
- `internal_note`

### 3.15 PrepSession

Represents an actual study session.

Key fields:

- `id`
- `prep_topic_id`
- `practice_item_id`
- `scheduled_for`
- `started_at`
- `ended_at`
- `duration_minutes`
- `confidence_before`
- `confidence_after`
- `outcome`
- `notes`
- `created_at`
- `updated_at`

Suggested `outcome` values:

- `completed`
- `partial`
- `blocked`
- `skipped`

### 3.16 Task

Represents an actionable item across CRM, outreach, and prep.

Key fields:

- `id`
- `task_type`
- `status`
- `title`
- `due_at`
- `priority`
- `related_entity_type`
- `related_entity_id`
- `notes`
- `created_at`
- `updated_at`

Examples of `task_type`:

- `follow_up`
- `apply`
- `prep`
- `research`
- `review_draft`

Suggested `status` values:

- `todo`
- `in_progress`
- `done`
- `skipped`

### 3.17 Source

Represents a source of evidence or research.

Key fields:

- `id`
- `source_type`
- `title`
- `url`
- `publisher`
- `retrieved_at`
- `published_at`
- `trust_level`
- `notes`
- `created_at`
- `updated_at`

Examples of `source_type`:

- `public_web`
- `user_note`
- `recruiter_note`
- `company_page`
- `practice_platform`

### 3.18 EvidenceItem

Represents an atomic claim, note, or observation used for recommendations.

Key fields:

- `id`
- `source_id`
- `role_id`
- `company_id`
- `person_id`
- `topic`
- `summary`
- `evidence_kind`
- `freshness_state`
- `confidence`
- `retrieved_at`
- `expires_at`
- `created_at`
- `updated_at`

Examples of `evidence_kind`:

- `interview_pattern`
- `role_signal`
- `company_signal`
- `outreach_context`
- `prep_recommendation_input`

Suggested `freshness_state` values:

- `fresh`
- `aging`
- `stale`
- `unknown`

### 3.19 ProviderRun

Represents one AI execution.

Key fields:

- `id`
- `provider_name`
- `model_name`
- `task_type`
- `prompt_version`
- `input_hash`
- `output_text`
- `status`
- `latency_ms`
- `token_usage_json`
- `created_at`

Examples of `task_type`:

- `outreach_draft`
- `contact_ranking`
- `prep_plan`
- `research_synthesis`

### 3.20 OutcomeLabel

Represents user- or system-applied labels for evaluation.

Key fields:

- `id`
- `label_type`
- `label_value`
- `target_entity_type`
- `target_entity_id`
- `created_at`

Examples of `label_value`:

- `reply`
- `no_reply`
- `too_generic`
- `too_aggressive`
- `stale`
- `high_value`

## 4. Key Relationships

Core relationships:

- one `User` to one `CandidateProfile`
- one `CandidateProfile` to many `ExperienceRecord`
- one `CandidateProfile` to many `EducationRecord`
- one `CandidateProfile` to many `ApplicationAsset`
- one `CandidateProfile` to many `ConversationImport`
- one `CandidateProfile` to many `ConnectorAccount`
- one `ConnectorAccount` to many `ConnectorSyncState`
- one `ConnectorAccount` to many `ConnectorMessage`
- one `Person` to many `EducationRecord`
- one `Person` to many `PersonCompanyAffiliation`
- one `Company` to many `Role`
- one `Role` to many `Application`
- one `Role` to many `RoleContact`
- one `Person` to many `RoleContact`
- one `Role` to many `ReferralPath`
- one `Person` to many `OutreachThread`
- one `Role` to many `OutreachThread`
- one `OutreachThread` to many `MessageDraft`
- one `Role` or `Application` to many `InterviewLoop`
- one `PrepTopic` to many `PracticeItem`
- one `PrepTopic` to many `PrepSession`
- one `Source` to many `EvidenceItem`
- one `ProviderRun` to many `MessageDraft` or recommendation records
- one `Application` to zero or more `ApplicationAsset` references
- one `ConnectorMessage` to zero or one `ConversationImport`

## 5. Derived Signals

The system should compute but not hardcode the following signals:

- `candidate_role_fit_score`
- `warmth_score`
- `education_overlap_score`
- `reply_propensity_score`
- `referral_likelihood_score`
- `prep_priority_score`
- `topic_struggle_score`
- `evidence_freshness_score`

These should be derived from explicit inputs so the user can inspect why a contact or prep topic is ranked highly.

## 6. State Transitions

### 6.1 Application

Typical flow:

`draft -> submitted -> screen -> interview -> offer`

Terminal or alternate paths:

- `submitted -> rejected`
- `screen -> rejected`
- `interview -> rejected`
- `draft -> withdrawn`
- any active state -> `archived`

### 6.2 OutreachThread

Typical flow:

`drafting -> ready_for_review -> waiting_to_send -> waiting_for_reply -> replied`

Alternate paths:

- any active state -> `paused`
- `waiting_for_reply -> ready_for_review` for follow-up generation
- any state -> `closed`

### 6.3 MessageDraft

Typical flow:

`generated -> edited -> approved -> sent_externally`

Alternate paths:

- `generated -> discarded`
- `edited -> discarded`

### 6.4 PrepTopic

Typical flow:

`unstarted -> in_progress -> covered`

Adaptive revisit path:

- `covered -> needs_revisit`
- `needs_revisit -> in_progress`

## 7. Ranking Inputs

### 7.1 Contact Ranking

Important ranking features:

- shared company history
- shared education
- recruiter or hiring-manager relevance
- relationship strength
- recency of contact
- prior response behavior
- target role alignment
- referral path length
- do-not-contact and cooldown constraints

### 7.2 Prep Ranking

Important ranking features:

- upcoming interview date
- confidence gap
- repeated misses
- rising solve time
- topic coverage level
- relevance to the current target role
- freshness and confidence of supporting evidence

## 8. Minimal API Surface

The first API surface should expose resources for:

- `/people`
- `/companies`
- `/roles`
- `/applications`
- `/outreach-threads`
- `/message-drafts`
- `/interview-loops`
- `/prep-topics`
- `/practice-items`
- `/prep-sessions`
- `/tasks`
- `/sources`
- `/evidence-items`
- `/provider-runs`
- `/outcome-labels`

It should also expose command-style endpoints for:

- contact ranking
- outreach draft generation
- draft approval
- prep plan generation
- evidence ingestion

## 9. V1 Simplifications

To keep V1 buildable:

- store one deployment owner rather than full multi-user workspaces
- let imported chat sessions and notes remain mostly raw text after extraction rather than forcing full structured normalization on day one
- treat social graph acquisition as manual import, export, or user-entered records
- prioritize `gmail_readonly` as the first email connector and keep fallback import paths available when connector access fails
- start with a single relational database
- keep attachment handling optional
- store AI traces in the primary database before introducing dedicated observability infrastructure

## 10. Future Extensions

Likely future additions:

- multi-user workspaces
- coach or recruiter collaboration
- richer attachment handling
- calendar and email syncing
- more formal graph traversal and intro-path discovery
- dedicated ranking models and offline evaluation pipelines
