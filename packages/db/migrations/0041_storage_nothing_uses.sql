-- The storage nothing uses any more.
--
-- The simple product removed whole features; their code went first and their tables were left for this migration. A
-- table or a column is dropped here only when no source file outside the schema, the migrations and the tests reads or
-- writes it. Migration 0040 ran first and moved every row that still pointed at one of these features. Dropping a table
-- drops its indexes, its row policy and its grants with it.
--
-- Tables (24):
--   in-person interviews:   interview_followups, interview_participants, scorecards, interviews, interviewer_availability,
--                           debriefs
--   offers and onboarding:  offers, onboardings
--   ITS recruiter work:     escalation_messages, recruiter_escalations, staff_access_grants, takeovers,
--                           business_calendar_versions
--   the rules engine:       policies, approval_requests, interventions
--   marks and notes:        application_marks, application_notes
--   boards, links, email:   postings, application_links, inbound_emails, integrations
--   the repeat conversation: unconfirmed_screens
--   playbooks:              playbooks
--
-- What goes with them and is kept nowhere else:
--   integrations.secret_ref named a secret in the key vault (vault.secrets.id). The secrets themselves are not touched
--   here; count and remove them BEFORE this migration (docs/runbooks/production-setup.md, "The release"):
--     SELECT count(*) FROM integrations WHERE secret_ref IS NOT NULL OR credentials_ciphertext IS NOT NULL;
--   inbound_emails.raw_storage_key named a stored file (inbound/<company>/<id>.<ext>). The files are not touched here;
--   list them BEFORE this migration:
--     SELECT id, company_id, raw_storage_key FROM inbound_emails WHERE raw_storage_key IS NOT NULL;
--   The team's notes and marks, the interviews held and the offers recorded are gone with their tables. What happened
--   to each person stays in the history (events), which is not touched.
--
-- Columns: listed beside each statement. events, audit_records, platform_role_grants, hiring_outcomes, assessments,
-- ai_runs, data_requests, email_suppressions, plans and entitlements lose no row; four of them lose a column that never
-- held anything (hiring_outcomes.rating, ai_runs.model_version, tool_calls, policy_decision), ai_runs loses the
-- confidence copied from a resume's facts, which nothing read, and data_requests and workflow_runs lose the pointer to
-- a recruiter request.
--
-- The release: the build before this one reads and writes these tables and columns, so its app and worker are stopped
-- before this migration runs (docs/runbooks/production-setup.md, "The release").

-- allow-destructive: the Cancelled column of in-person interviews, a removed feature; nothing reads or writes it
DROP TABLE IF EXISTS interview_followups;
--> statement-breakpoint
-- allow-destructive: interviewers of in-person interviews, a removed feature; nothing reads or writes it
DROP TABLE IF EXISTS interview_participants;
--> statement-breakpoint
-- allow-destructive: interviewer scorecards; never written by any build
DROP TABLE IF EXISTS scorecards;
--> statement-breakpoint
-- allow-destructive: in-person interviews and their scheduling, a removed feature; nothing reads or writes it
DROP TABLE IF EXISTS interviews;
--> statement-breakpoint
-- allow-destructive: declared interview hours, part of scheduling; nothing reads or writes it
DROP TABLE IF EXISTS interviewer_availability;
--> statement-breakpoint
-- allow-destructive: debrief summaries; never written by any build
DROP TABLE IF EXISTS debriefs;
--> statement-breakpoint
-- allow-destructive: offers recorded outside the app, a removed feature; nothing reads or writes it
DROP TABLE IF EXISTS offers;
--> statement-breakpoint
-- allow-destructive: onboarding tasks; never written by any build
DROP TABLE IF EXISTS onboardings;
--> statement-breakpoint
-- allow-destructive: the thread on an ITS recruiter request, a removed feature; nothing reads or writes it
DROP TABLE IF EXISTS escalation_messages;
--> statement-breakpoint
-- allow-destructive: ITS recruiter requests and board posting tasks, removed features; nothing reads or writes it
DROP TABLE IF EXISTS recruiter_escalations;
--> statement-breakpoint
-- allow-destructive: time-limited access of ITS staff to a company, a removed feature; every grant and its use stay in audit_records
DROP TABLE IF EXISTS staff_access_grants;
--> statement-breakpoint
-- allow-destructive: an ITS recruiter running a job, a removed feature; never written outside tests
DROP TABLE IF EXISTS takeovers;
--> statement-breakpoint
-- allow-destructive: the ITS business calendar for recruiter response times, a removed feature; nothing reads or writes it
DROP TABLE IF EXISTS business_calendar_versions;
--> statement-breakpoint
-- allow-destructive: saved automation rules, a removed feature; nothing reads or writes it
DROP TABLE IF EXISTS policies;
--> statement-breakpoint
-- allow-destructive: requests waiting for a person's yes (job approval, held messages), a removed feature; nothing reads or writes it
DROP TABLE IF EXISTS approval_requests;
--> statement-breakpoint
-- allow-destructive: the log of nudges about a stuck job, a removed feature; nothing reads or writes it
DROP TABLE IF EXISTS interventions;
--> statement-breakpoint
-- allow-destructive: private marks (longlist, shortlist, on hold, not a fit), a removed feature; nothing reads or writes it
DROP TABLE IF EXISTS application_marks;
--> statement-breakpoint
-- allow-destructive: the team's private notes on a candidate, a removed feature; nothing reads or writes it
DROP TABLE IF EXISTS application_notes;
--> statement-breakpoint
-- allow-destructive: one row per job and board, a removed feature; nothing reads or writes it
DROP TABLE IF EXISTS postings;
--> statement-breakpoint
-- allow-destructive: tracked application links, a removed feature; nothing reads or writes it
DROP TABLE IF EXISTS application_links;
--> statement-breakpoint
-- allow-destructive: applications and replies received by email, a removed feature; nothing reads or writes it
DROP TABLE IF EXISTS inbound_emails;
--> statement-breakpoint
-- allow-destructive: calendar and job board connections, removed features; nothing reads or writes it
DROP TABLE IF EXISTS integrations;
--> statement-breakpoint
-- allow-destructive: the unconfirmed conversation of a repeat application, a removed feature; nothing reads or writes it
DROP TABLE IF EXISTS unconfirmed_screens;
--> statement-breakpoint
-- allow-destructive: playbook text, a removed feature; nothing reads or writes it
DROP TABLE IF EXISTS playbooks;
--> statement-breakpoint
-- allow-destructive: a plan word nothing reads or writes (the plan is companies.plan_key)
ALTER TABLE companies DROP COLUMN IF EXISTS status;
--> statement-breakpoint
-- allow-destructive: never written or read
ALTER TABLE users DROP COLUMN IF EXISTS phone;
--> statement-breakpoint
-- allow-destructive: unused since invitations became rows of their own (migration 0022)
ALTER TABLE magic_links DROP COLUMN IF EXISTS invite_company_id, DROP COLUMN IF EXISTS invite_role;
--> statement-breakpoint
-- allow-destructive: a job's named manager, its playbook, its boards, its apply flow, its volume alert and why it closed: written by removed features or never, and read by nothing
ALTER TABLE roles DROP COLUMN IF EXISTS hiring_manager_user_id, DROP COLUMN IF EXISTS playbook_id, DROP COLUMN IF EXISTS playbook_version, DROP COLUMN IF EXISTS playbook_role_key,
  DROP COLUMN IF EXISTS close_reason, DROP COLUMN IF EXISTS volume_alert_per_day, DROP COLUMN IF EXISTS publish_channels, DROP COLUMN IF EXISTS apply_mode;
--> statement-breakpoint
-- allow-destructive: never written or read
ALTER TABLE intake_sessions DROP COLUMN IF EXISTS workflow_run_id;
--> statement-breakpoint
-- allow-destructive: a structured place, tags, an embedding and a merge pointer never written; the talent pool flag of a removed feature; a first source nothing read
ALTER TABLE candidates DROP COLUMN IF EXISTS location, DROP COLUMN IF EXISTS first_source, DROP COLUMN IF EXISTS in_talent_pool, DROP COLUMN IF EXISTS tags,
  DROP COLUMN IF EXISTS embedding, DROP COLUMN IF EXISTS merged_into_candidate_id;
--> statement-breakpoint
-- allow-destructive: the tracked link and its detail, the eligibility hold, the decline reason and note and the reply address's token of removed features; times and a reason of a withdrawal nothing read (each move and its reason stay in events)
ALTER TABLE applications DROP COLUMN IF EXISTS source_detail, DROP COLUMN IF EXISTS link_id, DROP COLUMN IF EXISTS eligibility, DROP COLUMN IF EXISTS inactive_at,
  DROP COLUMN IF EXISTS withdrawn_at, DROP COLUMN IF EXISTS withdraw_reason, DROP COLUMN IF EXISTS reject_reason, DROP COLUMN IF EXISTS reject_note, DROP COLUMN IF EXISTS reply_token;
--> statement-breakpoint
-- allow-destructive: the channel (web or text message), how it was offered, the request for a person and two reminder times of removed features; the time of the last message, which nothing read
ALTER TABLE screens DROP COLUMN IF EXISTS channel, DROP COLUMN IF EXISTS human_requested_at, DROP COLUMN IF EXISTS last_candidate_message_at, DROP COLUMN IF EXISTS invited_via,
  DROP COLUMN IF EXISTS idle_reminded_at;
--> statement-breakpoint
-- allow-destructive: never anything but its default
ALTER TABLE notifications DROP COLUMN IF EXISTS channel;
--> statement-breakpoint
-- allow-destructive: never anything but its default
ALTER TABLE webhook_receipts DROP COLUMN IF EXISTS outcome;
--> statement-breakpoint
-- allow-destructive: three columns never written, and a confidence copied from a resume's facts that nothing read; no row is touched
ALTER TABLE ai_runs DROP COLUMN IF EXISTS model_version, DROP COLUMN IF EXISTS tool_calls, DROP COLUMN IF EXISTS policy_decision, DROP COLUMN IF EXISTS confidence;
--> statement-breakpoint
-- allow-destructive: a pointer to a recruiter request, a removed feature; no row is touched
ALTER TABLE workflow_runs DROP COLUMN IF EXISTS escalation_id;
--> statement-breakpoint
-- allow-destructive: a pointer to a recruiter request, a removed feature; no row is touched
ALTER TABLE data_requests DROP COLUMN IF EXISTS escalation_id;
--> statement-breakpoint
-- allow-destructive: never written; no row is touched
ALTER TABLE hiring_outcomes DROP COLUMN IF EXISTS rating;
--> statement-breakpoint
DROP INDEX IF EXISTS applications_company_told_idx;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS applications_company_told_idx ON applications (company_id, role_id, told_state) WHERE stage = 'rejected';
