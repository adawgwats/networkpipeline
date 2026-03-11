# NetworkPipeline V1 Schema Strategy

## 1. Goal

The V1 schema should support a solo-user, local-first product while staying compatible with a future PostgreSQL deployment.

The schema must support:

- canonical workflow data
- imported raw context
- AI-generated fact proposals
- user review and approval of extracted facts
- provider-run traces and outcome labels
- connector accounts, sync state, and connector-imported messages

## 2. Storage Principles

### 2.1 SQL Is The Source Of Truth

Use SQL for the canonical system of record because the product is fundamentally relational:

- people relate to companies and roles
- applications relate to assets and interview loops
- outreach threads relate to contacts, roles, drafts, and outcomes
- prep topics relate to evidence, sessions, and practice items

### 2.2 Raw Artifacts Do Not Belong Entirely In Tables

Large or unstructured content such as resumes, cover letters, and chat exports should be stored as files, with metadata and extracted text referenced from SQL tables.

### 2.3 AI Needs Staging Tables

AI extraction and recommendation flows should not write directly into canonical product tables.

The schema should explicitly separate:

- `canonical tables`
- `staging tables`
- `trace tables`

## 3. Portability Rules

To stay portable between `SQLite` and `PostgreSQL`, V1 should:

- use application-generated string IDs such as `ULID` or `UUID`
- avoid PostgreSQL-only enums in the core schema
- prefer `TEXT` status fields with application-level validation
- avoid array types as required core fields
- treat structured JSON as optional payload fields rather than the primary data model
- avoid vendor-specific indexing assumptions in core migrations

Acceptable V1 type families:

- `TEXT`
- `INTEGER`
- `REAL`
- `BOOLEAN`
- `TIMESTAMP` or ISO timestamp text via ORM mapping

## 4. Schema Layers

### 4.1 Canonical Tables

These are approved records the product actually relies on.

Candidate and assets:

- `candidate_profiles`
- `candidate_experience_records`
- `candidate_education_records`
- `application_assets`
- `connector_accounts`
- `connector_sync_states`

CRM:

- `people`
- `person_education_records`
- `person_company_affiliations`
- `companies`
- `roles`
- `applications`
- `role_contacts`
- `referral_paths`

Outreach:

- `outreach_threads`
- `message_drafts`
- `outreach_events`

Prep:

- `interview_loops`
- `prep_topics`
- `practice_items`
- `prep_sessions`

Research and evaluation:

- `sources`
- `evidence_items`
- `provider_runs`
- `outcome_labels`
- `tasks`

### 4.2 Staging Tables

These hold imported and AI-extracted content before it becomes canonical.

- `connector_messages`
- `conversation_imports`
- `fact_proposals`
- `review_decisions`

These tables are critical for AI safety and auditability.

### 4.3 Linking Tables

Use explicit linking tables instead of polymorphic foreign keys where practical.

Recommended V1 links:

- `application_asset_links`
- `referral_path_people`
- `message_draft_evidence_links`
- `prep_topic_evidence_links`
- `role_evidence_links`
- `company_evidence_links`
- `person_evidence_links`

This keeps joins explicit and portable.

## 5. Suggested Physical Tables

### 5.1 Candidate Tables

`candidate_profiles`

- `id`
- `user_id`
- `professional_summary`
- `current_title`
- `current_company`
- `years_experience`
- `primary_location`
- `dream_job_description`
- `acceptable_job_description`
- `target_roles_json`
- `target_industries_json`
- `location_preferences_json`
- `compensation_preferences_json`
- `constraints_json`
- `notes`
- `created_at`
- `updated_at`

`candidate_experience_records`

- `id`
- `candidate_profile_id`
- `company_name`
- `title`
- `start_date`
- `end_date`
- `is_current`
- `summary`
- `skills_json`
- `achievements_json`
- `notes`

`candidate_education_records`

- `id`
- `candidate_profile_id`
- `institution_name`
- `program_name`
- `degree_type`
- `start_year`
- `end_year`
- `is_current`
- `student_groups_json`
- `honors_json`
- `notes`

`application_assets`

- `id`
- `candidate_profile_id`
- `asset_type`
- `label`
- `file_path`
- `source_format`
- `extracted_text`
- `checksum`
- `is_default`
- `created_at`
- `updated_at`

`connector_accounts`

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

`connector_sync_states`

- `id`
- `connector_account_id`
- `cursor_kind`
- `cursor_value`
- `last_synced_at`
- `last_error`
- `created_at`
- `updated_at`

### 5.2 Import And Review Tables

`connector_messages`

- `id`
- `connector_account_id`
- `external_message_id`
- `external_thread_id`
- `source_timestamp`
- `direction`
- `from_address`
- `to_addresses_json`
- `subject`
- `body_text`
- `raw_metadata_json`
- `ingest_status`
- `conversation_import_id`
- `created_at`
- `updated_at`

`conversation_imports`

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

`fact_proposals`

- `id`
- `conversation_import_id`
- `provider_run_id`
- `target_table`
- `target_record_id`
- `proposal_type`
- `proposed_payload_json`
- `confidence`
- `status`
- `created_at`
- `updated_at`

`review_decisions`

- `id`
- `fact_proposal_id`
- `decision`
- `reviewed_payload_json`
- `review_notes`
- `reviewed_at`

This is the key AI schema pattern:

`raw import -> fact proposal -> review decision -> canonical record`

Connector-specific variant:

`connector sync -> connector message -> conversation import -> fact proposal -> review decision -> canonical record`

### 5.3 CRM Tables

`people`

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

`person_education_records`

- `id`
- `person_id`
- `institution_name`
- `program_name`
- `degree_type`
- `start_year`
- `end_year`
- `is_current`
- `student_groups_json`
- `honors_json`
- `notes`

`person_company_affiliations`

- `id`
- `person_id`
- `company_id`
- `title`
- `affiliation_type`
- `start_date`
- `end_date`
- `is_current`
- `notes`

`companies`

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

`roles`

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

`applications`

- `id`
- `role_id`
- `applied_at`
- `application_source`
- `status`
- `external_application_id`
- `notes`
- `created_at`
- `updated_at`

`application_asset_links`

- `id`
- `application_id`
- `application_asset_id`
- `link_type`

Examples of `link_type`:

- `resume`
- `cover_letter`
- `referral_note`

`role_contacts`

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

`referral_paths`

- `id`
- `role_id`
- `path_summary`
- `path_length`
- `strength_score`
- `status`
- `notes`
- `created_at`
- `updated_at`

`referral_path_people`

- `id`
- `referral_path_id`
- `person_id`
- `position_index`

### 5.4 Outreach Tables

`outreach_threads`

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

`message_drafts`

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

`outreach_events`

- `id`
- `thread_id`
- `event_type`
- `occurred_at`
- `notes`

Examples of `event_type`:

- `draft_generated`
- `approved`
- `sent`
- `reply_received`
- `closed`

### 5.5 Prep Tables

`interview_loops`

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

`prep_topics`

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

`practice_items`

- `id`
- `prep_topic_id`
- `source_name`
- `external_url`
- `external_identifier`
- `title`
- `difficulty`
- `tags_json`
- `relevance_score`
- `notes`
- `created_at`
- `updated_at`

`prep_sessions`

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

### 5.6 Research And AI Tables

`sources`

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

`evidence_items`

- `id`
- `source_id`
- `topic`
- `summary`
- `evidence_kind`
- `freshness_state`
- `confidence`
- `retrieved_at`
- `expires_at`
- `created_at`
- `updated_at`

`role_evidence_links`

- `id`
- `role_id`
- `evidence_item_id`

`company_evidence_links`

- `id`
- `company_id`
- `evidence_item_id`

`person_evidence_links`

- `id`
- `person_id`
- `evidence_item_id`

`prep_topic_evidence_links`

- `id`
- `prep_topic_id`
- `evidence_item_id`

`message_draft_evidence_links`

- `id`
- `message_draft_id`
- `evidence_item_id`

`provider_runs`

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

`outcome_labels`

- `id`
- `label_type`
- `label_value`
- `target_table`
- `target_record_id`
- `created_at`

`tasks`

- `id`
- `task_type`
- `status`
- `title`
- `due_at`
- `priority`
- `related_table`
- `related_record_id`
- `notes`
- `created_at`
- `updated_at`

## 6. Why This Schema Works For AI Tooling

It gives AI three clean operating surfaces:

1. `read canonical records` for recommendations
2. `write proposals and traces` without corrupting canonical data
3. `observe outcomes` for later evaluation

That matters because AI will be used for:

- extracting facts from chat history and application artifacts
- drafting outreach
- ranking contacts
- synthesizing interview evidence
- adapting prep recommendations

The schema must let those tasks happen without making AI outputs automatically trusted.

Connector-specific AI path:

1. connector sync writes `connector_messages`
2. selected messages are normalized into `conversation_imports`
3. extraction creates `fact_proposals`
4. user review creates `review_decisions`
5. approved facts update canonical records

## 7. Recommended V1 Default

Default local deployment:

- `SQLite` database file
- local filesystem artifact storage
- portable SQL migrations

Upgraded deployment:

- `PostgreSQL`
- optional object storage
- same logical schema, with only compatibility-layer differences
