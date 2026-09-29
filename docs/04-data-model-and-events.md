# 04. Data model and event taxonomy

Postgres 16+, pgvector. Every tenant table carries `company_id` and is protected by row-level security. Primary keys are UUIDv7 (time-ordered) except the append-only `events` and `jobs` tables, which use bigserial. Timestamps are `timestamptz`. JSON columns hold objects validated by Zod schemas in `packages/contracts`; the schema name is noted in brackets.

## Tenancy and identity

| Table | Purpose | Key columns |
|---|---|---|
| `companies` | Tenant | `id`, `name`, `slug` (unique), `vertical`, `size_band`, `timezone`, `locations` [Location[]], `settings` [CompanySettings], `plan_key`, `status` (trial, active, past_due, cancelled), `created_at` |
| `users` | People who log in (owners, staff, ITS recruiters, admins) | `id`, `email` (unique, citext), `name`, `phone`, `platform_role` (none, its_recruiter, platform_admin), `created_at` |
| `memberships` | User ↔ company with a role | `company_id`, `user_id`, `role` (owner, admin, hiring_manager, interviewer, hr, recruiter), `status`; unique (company_id, user_id) |
| `sessions` | Login sessions | `user_id`, `token_hash`, `expires_at`, `last_seen_at`, `ip`, `user_agent` |
| `magic_links` | Passwordless login | `email`, `token_hash`, `expires_at`, `used_at`, `ip` |

## Hiring objects

| Table | Purpose | Key columns |
|---|---|---|
| `playbooks` | Vertical playbooks (platform-level) | `id`, `vertical`, `version`, `content` [Playbook], `status` (draft, published, retired); unique (vertical, version) |
| `roles` | An open position | `company_id`, `title`, `status` (draft, pending_approval, open, paused, filled, closed), `current_packet_version`, `hiring_manager_user_id`, `playbook_id`, `playbook_version`, `opened_at`, `closed_at`, `close_reason`, `created_by` |
| `role_packets` | **Versioned, append-only** packet | `role_id`, `version`, `packet` [RolePacket], `status` (proposed, approved, superseded), `source` (intake_agent, human_edit, playbook, import), `change_summary`, `created_by` [Actor], `approved_by`, `approved_at`; unique (role_id, version) |
| `intake_sessions` | Conversation state for intake | `company_id`, `role_id` (nullable until a packet is compiled), `status` (active, compiled, abandoned), `messages` [IntakeMessage[]], `facts` [IntakeFacts] (what the agent has established), `draft_packet` [RolePacket, nullable], `created_by` |
| `postings` | One row per role per channel | `role_id`, `channel` (careers_page, google_jobs, linkedin_basic, indeed, ziprecruiter, email_in, other), `status` (pending, live, paused, expired, failed, pending_credentials), `external_id`, `external_url`, `intake_token` (email-in address token), `budget` [PostingBudget], `published_at`, `expires_at`, `last_synced_at`, `error` |
| `candidates` | A person known to a tenant | `company_id`, `first_name`, `last_name`, `email` (citext), `phone` (E.164), `location` [Location], `dedupe_key` (normalized email or phone), `first_source`, `consent` [ConsentRecord], `preferences` [CandidatePreferences], `in_talent_pool`, `tags`, `embedding` vector(1024), `merged_into_candidate_id`; unique (company_id, dedupe_key) where dedupe_key is not null |
| `documents` | Files and extracted text | `company_id`, `candidate_id`, `application_id`, `kind` (resume, cover_letter, offer_letter, transcript, attachment, export), `filename`, `mime`, `size_bytes`, `storage_key`, `sha256`, `text_extracted`, `extracted_by_ai_run_id` |
| `applications` | Candidate ↔ role | `company_id`, `role_id`, `candidate_id`, `packet_version` (the version that evaluated them), `source` (careers_page, email_in, indeed, linkedin, ziprecruiter, referral, rediscovery, manual, import), `stage` (state machine, doc 06), `stage_changed_at`, `resume_document_id`, `answers` [ApplicationAnswers], `eligibility` [EligibilityResult], `latest_assessment_id`, `inactive_at`, `withdrawn_at`, `withdraw_reason`, `rejected_at`, `reject_reason` [RejectReason]; unique (role_id, candidate_id) |
| `assessments` | Evidence-based evaluations | `company_id`, `application_id`, `kind` (fit, screen, interview_draft, debrief, rediscovery), `packet_version`, `ai_run_id`, `result` [EvidenceAssessment], `overall` (strong, potential, weak, unknown), `confidence` (high, medium, low), `secondary_score` numeric (nullable), `superseded_by` |
| `screens` | Screening conversations | `company_id`, `application_id`, `channel` (sms, web, voice), `status` (invited, in_progress, completed, abandoned, expired, human_requested), `token`, `invited_at`, `started_at`, `completed_at`, `transcript` [ScreenTranscript], `assessment_id`, `workflow_run_id` |
| `interviews` | One interview instance | `company_id`, `application_id`, `round_key` (from the packet plan), `title`, `format` (video, phone, onsite), `duration_min`, `starts_at`, `ends_at`, `timezone`, `status` (proposed, scheduling, scheduled, completed, cancelled, no_show), `calendar_refs` [CalendarRefs], `meeting_url`, `recording` [RecordingState], `transcript_document_id` |
| `interview_participants` | People in an interview | `interview_id`, `user_id`, `role` (interviewer, shadow, recruiter), `status` |
| `scorecards` | One per interviewer per interview | `company_id`, `interview_id`, `application_id`, `interviewer_user_id`, `status` (pending, draft, submitted), `entries` [ScorecardEntry[]], `recommendation` (strong_yes, yes, no, strong_no), `submitted_at`, `ai_draft_assessment_id`; unique (interview_id, interviewer_user_id) |
| `debriefs` | Decision meeting output | `company_id`, `role_id`, `application_ids`, `summary` [DebriefSummary], `decision` [DebriefDecision], `ai_run_id`, `created_by` |
| `communications` | Every message in or out | `company_id`, `candidate_id`, `application_id`, `direction` (outbound, inbound), `channel` (email, sms, web, voice, note), `from_address`, `to_address`, `subject`, `body_text`, `body_html`, `template_key`, `ai_run_id`, `provider`, `provider_message_id`, `status` (queued, sent, delivered, bounced, failed, received), `disclosure_included`, `sent_by` [Actor], `error`, `delivered_at` |
| `offers` | Offer versions | `company_id`, `application_id`, `version`, `status` (draft, pending_approval, approved, sent, viewed, negotiating, accepted, declined, expired, rescinded), `terms` [OfferTerms], `letter_document_id`, `approval` [ApprovalState], `esign` [EsignState], `sent_at`, `responded_at`, `decline_reason`, `negotiation_log` [NegotiationEntry[]], `created_by` |
| `onboardings` | Post-acceptance | `company_id`, `application_id`, `status` (pending, in_progress, handed_off, completed, failed), `start_date`, `hris` [HrisHandoffState], `tasks` [OnboardingTask[]], `checkins` [CheckinState] |
| `hiring_outcomes` | 30/60/90 and separations | `company_id`, `application_id`, `milestone` (d30, d60, d90, separation), `outcome` (retained, separated_voluntary, separated_involuntary, unknown), `rating` (1 to 5), `notes`, `recorded_by`, `recorded_at` |

## Automation, policy, and human layer

| Table | Purpose | Key columns |
|---|---|---|
| `policies` | Per-company, per-role action policies | `company_id`, `role_id` (nullable = company default), `action_type`, `level` (auto, auto_notify, approval, human_only), `approver_role`, `params`; unique (company_id, role_id, action_type) |
| `approval_requests` | Pending human decisions | `company_id`, `role_id`, `application_id`, `action_type`, `proposal` [ActionProposal], `rationale`, `requested_by` [Actor], `required_role`, `status` (pending, approved, rejected, expired, cancelled), `decided_by`, `decided_at`, `decision_note`, `workflow_run_id`, `expires_at` |
| `workflow_runs` | Durable workflow instances | `company_id`, `workflow_key`, `workflow_version`, `subject` [Subject], `status` (running, waiting, completed, failed, cancelled, paused), `current_step`, `state` (json), `wait` [WaitCondition], `attempts`, `last_error`, `escalation_id`, `started_at`, `completed_at` |
| `workflow_steps` | Step ledger | `run_id`, `step_key`, `seq`, `status` (ok, error, skipped), `input`, `output`, `attempts`, `started_at`, `finished_at`, `error` |
| `jobs` | The queue | `kind`, `run_at`, `locked_at`, `locked_by`, `attempts`, `max_attempts`, `payload`, `status` (queued, done, failed), `last_error` |
| `ai_runs` | Every model call | `company_id`, `agent`, `task`, `provider`, `model`, `model_version`, `prompt_key`, `prompt_version`, `prompt_hash`, `input_ref` [InputRef], `input_tokens`, `output_tokens`, `cache_read_tokens`, `cost_usd`, `latency_ms`, `tool_calls`, `structured_output`, `confidence`, `policy_decision`, `human_override`, `final_outcome`, `status` (ok, error, refused, invalid_output), `error`, `workflow_run_id` |
| `recruiter_escalations` | Ask a recruiter and beyond | `company_id`, `role_id`, `application_id`, `kind` (ask, review, takeover, negotiation, search_support, candidate_issue, stuck_role), `status` (open, claimed, in_progress, resolved, cancelled), `requested_by` [Actor], `question`, `context_snapshot` [EscalationContext], `assigned_to_user_id`, `claimed_at`, `resolved_at`, `resolution`, `billing` [EscalationBilling] |
| `takeovers` | Human-operated periods | `company_id`, `role_id`, `recruiter_user_id`, `started_at`, `ended_at`, `policy_snapshot`, `status` |
| `interventions` | Customer-success nudges | `company_id`, `role_id`, `detector`, `ladder_level` (brief, message, offer_recruiter, escalated), `status`, `sent_at`, `responded_at`, `response` |
| `notifications` | In-app and outbound notices to users | `company_id`, `user_id`, `kind`, `title`, `body`, `action` [NotificationAction], `channel` (in_app, email, sms), `read_at` |
| `inbound_emails` | Raw inbound mail | `company_id`, `to_address`, `from_address`, `subject`, `raw_storage_key`, `parsed` [ParsedInbound], `status` (received, held, matched, unmatched, spam, error), `application_id`, `communication_id` |
| `integrations` | Connected services | `company_id` (nullable for platform-level), `provider`, `kind`, `status` (live, pending_credentials, pending_partner_approval, disabled, error), `config`, `credentials_ciphertext`, `external_account_id`, `connected_by`, `last_health_at`, `last_error` |
| `audit_records` | Access and privileged actions | `company_id`, `actor` [Actor], `action` (candidate.viewed, export.created, policy.changed, membership.changed, data.deleted, admin.bypass, credentials.updated, ...), `target` [Subject], `reason`, `ip` |
| `plans`, `entitlements`, `usage_events` | Billing | doc 03 |
| `events` | The append-only fact log | `id` bigserial, `company_id`, `type`, `occurred_at`, `actor` [Actor], `subject` [Subject], `correlation_id` (workflow run), `causation_id` (event id), `payload`, `schema_version` |

## Relationships (the ones that matter)

```
companies 1─* memberships *─1 users
companies 1─* roles 1─* role_packets (versions)
roles 1─* postings
roles 1─* applications *─1 candidates
applications 1─* assessments, screens, interviews, scorecards, communications, offers
applications 1─1 onboardings 1─* hiring_outcomes
interviews 1─* interview_participants, scorecards
roles 1─* debriefs
companies 1─* policies (role_id null = default) ; roles 1─* policies (overrides)
workflow_runs 1─* workflow_steps ; workflow_runs 1─* ai_runs ; workflow_runs 1─* approval_requests
recruiter_escalations *─1 roles/applications ; takeovers *─1 roles
events: everything, by subject and correlation
```

## Indexes

- Every tenant table: `(company_id)` plus the natural access path, e.g. `applications (company_id, role_id, stage)`, `applications (company_id, candidate_id)`, `candidates (company_id, dedupe_key)` unique partial, `candidates (company_id, email)`, `communications (company_id, candidate_id, created_at desc)`, `events (company_id, occurred_at desc)`, `events (subject_type, subject_id, occurred_at)`, `events (type, occurred_at)`, `workflow_runs (status, updated_at)`, `jobs (status, run_at)` for the poller, `ai_runs (company_id, created_at desc)`, `ai_runs (task, created_at desc)`, `approval_requests (company_id, status)`, `recruiter_escalations (status, created_at)`.
- Full text: `documents.text_extracted` (tsvector generated column) for recruiter search.
- Vector: `candidates.embedding` HNSW (cosine) for rediscovery, created when the table exceeds a few thousand rows; sequential scan is fine before that.

## Tenant boundary and permissions

- RLS policy on every tenant table: `USING (company_id = current_setting('app.company_id', true)::uuid)`. The API sets `app.company_id` per transaction from the session's active membership. Platform admins connect with `app.bypass_rls = on` under a separate database role, and every such query path writes an `audit_records` row.
- Object-level permissions live in `packages/core/src/permissions.ts`: a matrix of role × action × object with predicates (an interviewer may read an application only if they are a participant in one of its interviews; nobody except owner/admin/hr/recruiter reads compensation; candidates access only their own application through signed tokens).
- PGlite runs RLS the same way, so tests assert cross-tenant reads return nothing.

## Lifecycle states

Role: `draft → pending_approval → open ⇄ paused → filled | closed`. Role packet: `proposed → approved → superseded`. Application: doc 06. Offer: `draft → pending_approval → approved → sent → viewed → (negotiating →)* accepted | declined | expired | rescinded`. Workflow run: `running ⇄ waiting → completed | failed | cancelled | paused`. Escalation: `open → claimed → in_progress → resolved | cancelled`.

## Event taxonomy

Naming: `subject.past_tense_verb`. Every event has `actor`, `subject`, `correlation_id`, and a typed payload (`packages/contracts/src/events.ts`).

**Company and users:** `company.created`, `company.updated`, `user.invited`, `user.joined`, `membership.changed`, `member.joined` (an invitation accepted at sign-in), `member.removed`, `invitation.revoked`, `integration.connected`, `integration.failed`, `policy.changed`, `plan.changed`, `entitlement.exceeded`. Invitations are rows of their own (`invitations`, migration 0022): company, lower-cased address, role, who sent it, the token's hash, status pending / accepted / revoked / expired, seven-day expiry.

**Intake and role:** `intake.started`, `intake.turn_completed`, `intake.compiled`, `role.created`, `role_packet.proposed`, `role_packet.approved`, `role_packet.edited`, `role.approved`, `role.opened`, `role.paused`, `role.resumed`, `role.filled`, `role.closed`.

**Posting:** `posting.requested`, `posting.published`, `posting.pending_credentials`, `posting.failed`, `posting.expired`, `posting.spend_recorded`.

**Application:** `application.received`, `application.acknowledged`, `application.duplicate_detected`, `candidate.created`, `candidate.merged`, `resume.ingested`, `resume.extraction_failed`, `eligibility.evaluated`, `application.ineligible`, `application.triaged`, `assessment.created`, `application.stage_changed`, `application.inactive`, `application.withdrawn`, `application.rejected`, `application.moved_to_talent_pool`.

**Screening:** `screen.invited`, `screen.started`, `screen.completed`, `screen.abandoned`, `screen.expired`, `screen.human_requested`, `screen.assessed`.

**Recommendation and interviews:** `candidate.recommended`, `interview.requested`, `interview.scheduling_started`, `interview.slots_offered`, `interview.scheduled`, `interview.rescheduled`, `interview.cancelled`, `interview.no_show`, `interview.brief_sent`, `interview.recording_consented`, `interview.recording_declined`, `interview.completed`, `interview.transcribed`, `scorecard.drafted`, `scorecard.submitted`, `debrief.completed`, `candidate.finalist`, `reference.requested`, `reference.received`, `background_check.ordered`, `background_check.completed`.

**Offer:** `offer.created`, `offer.approval_requested`, `offer.approved`, `offer.rejected_internally`, `offer.sent`, `offer.viewed`, `offer.counter_received`, `offer.revised`, `offer.accepted`, `offer.declined`, `offer.expired`, `offer.rescinded`.

**Onboarding and outcomes:** `onboarding.started`, `handoff.packet_sent`, `employee.created`, `employee.creation_failed`, `onboarding.task_completed`, `onboarding.completed`, `start.confirmed`, `start.no_show`, `outcome.recorded`.

**Communication:** `message.queued`, `message.sent`, `message.delivered`, `message.bounced`, `message.failed`, `message.received`, `consent.granted`, `consent.revoked`, `candidate.opted_out`, `candidate.data_request`, `candidate.complaint`.

**Automation and humans:** `workflow.started`, `workflow.step_completed`, `workflow.waiting`, `workflow.resumed`, `workflow.retried`, `workflow.failed`, `workflow.escalated`, `workflow.cancelled`, `approval.requested`, `approval.granted`, `approval.denied`, `approval.expired`, `ai.run_completed`, `ai.run_failed`, `ai.output_invalid`, `ai.refused`, `human.override`, `recruiter.requested`, `recruiter.claimed`, `recruiter.resolved`, `recruiter.takeover_started`, `recruiter.takeover_ended`, `intervention.sent`, `intervention.responded`, `brief.sent`.

Events are the source for analytics, the admin console, the morning brief, and the candidate status page. They are never updated or deleted; corrections are new events.
