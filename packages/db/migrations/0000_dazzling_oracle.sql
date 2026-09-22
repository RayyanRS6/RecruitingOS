CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"vertical" text NOT NULL,
	"size_band" text NOT NULL,
	"timezone" text DEFAULT 'America/Los_Angeles' NOT NULL,
	"locations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"plan_key" text DEFAULT 'trial' NOT NULL,
	"status" text DEFAULT 'trial' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entitlements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"limit" integer,
	"used" integer DEFAULT 0 NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"source" text DEFAULT 'plan' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "magic_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"invite_company_id" uuid,
	"invite_role" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"prices" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"active_company_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone,
	"ip" text,
	"user_agent" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit" text NOT NULL,
	"ref" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"phone" text,
	"platform_role" text DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"packet_version" integer NOT NULL,
	"source" text NOT NULL,
	"stage" text DEFAULT 'applied' NOT NULL,
	"stage_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resume_document_id" uuid,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"eligibility" jsonb,
	"extraction" jsonb,
	"latest_assessment_id" uuid,
	"status_token" text NOT NULL,
	"inactive_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"withdraw_reason" text,
	"rejected_at" timestamp with time zone,
	"reject_reason" text,
	"reject_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assessments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"packet_version" integer NOT NULL,
	"ai_run_id" uuid,
	"result" jsonb NOT NULL,
	"overall" text NOT NULL,
	"confidence" text NOT NULL,
	"secondary_score" numeric(5, 2),
	"superseded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text,
	"phone" text,
	"location" jsonb,
	"location_text" text,
	"dedupe_key" text,
	"first_source" text NOT NULL,
	"consent" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"in_talent_pool" boolean DEFAULT false NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"embedding" vector(1024),
	"merged_into_candidate_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "communications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"candidate_id" uuid,
	"application_id" uuid,
	"direction" text NOT NULL,
	"channel" text NOT NULL,
	"from_address" text,
	"to_address" text,
	"subject" text,
	"body_text" text NOT NULL,
	"body_html" text,
	"template_key" text,
	"ai_run_id" uuid,
	"provider" text,
	"provider_message_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"disclosure_included" boolean DEFAULT false NOT NULL,
	"sent_by" jsonb NOT NULL,
	"error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "debriefs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"application_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"decision" jsonb,
	"ai_run_id" uuid,
	"created_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"candidate_id" uuid,
	"application_id" uuid,
	"kind" text NOT NULL,
	"filename" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"text_extracted" text,
	"extracted_by_ai_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hiring_outcomes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"milestone" text NOT NULL,
	"outcome" text NOT NULL,
	"rating" integer,
	"notes" text,
	"recorded_by" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"role_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"facts" jsonb DEFAULT '{"mustHaves":[],"niceToHaves":[],"eligibilityNotes":[],"interviewers":[],"dealBreakers":[],"declinedCriteria":[]}'::jsonb NOT NULL,
	"missing_facts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"draft_packet" jsonb,
	"workflow_run_id" uuid,
	"created_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interview_participants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"interview_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'interviewer' NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"round_key" text NOT NULL,
	"title" text NOT NULL,
	"format" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"timezone" text,
	"status" text DEFAULT 'proposed' NOT NULL,
	"calendar_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"meeting_url" text,
	"recording" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"transcript_document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"terms" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"letter_document_id" uuid,
	"approval" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"esign" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"accept_token" text,
	"sent_at" timestamp with time zone,
	"responded_at" timestamp with time zone,
	"decline_reason" text,
	"negotiation_log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboardings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"start_date" text,
	"hris" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tasks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checkins" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playbooks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"vertical" text NOT NULL,
	"version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"status" text DEFAULT 'published' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "postings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"external_id" text,
	"external_url" text,
	"intake_token" text,
	"instructions" text,
	"budget" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_packets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"packet" jsonb NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"source" text NOT NULL,
	"change_summary" text,
	"created_by" jsonb NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"current_packet_version" integer,
	"hiring_manager_user_id" uuid,
	"playbook_id" uuid,
	"playbook_version" integer,
	"playbook_role_key" text,
	"opened_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"created_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scorecards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"interview_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"interviewer_user_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"entries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recommendation" text,
	"submitted_at" timestamp with time zone,
	"ai_draft_assessment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "screens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"token" text NOT NULL,
	"invited_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"transcript" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"assessment_id" uuid,
	"workflow_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid,
	"agent" text NOT NULL,
	"task" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"model_version" text,
	"prompt_key" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"prompt_hash" text NOT NULL,
	"input_ref" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"structured_output" jsonb,
	"confidence" text,
	"policy_decision" jsonb,
	"human_override" jsonb,
	"final_outcome" jsonb,
	"status" text DEFAULT 'ok' NOT NULL,
	"error" text,
	"workflow_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"role_id" uuid,
	"application_id" uuid,
	"action_type" text NOT NULL,
	"subject" jsonb NOT NULL,
	"proposal" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rationale" text,
	"requested_by" jsonb NOT NULL,
	"required_roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"decision_edits" jsonb,
	"workflow_run_id" uuid,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid,
	"actor" jsonb NOT NULL,
	"action" text NOT NULL,
	"target" jsonb,
	"reason" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" uuid,
	"type" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" jsonb NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"correlation_id" text,
	"causation_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_emails" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid,
	"to_address" text NOT NULL,
	"from_address" text NOT NULL,
	"subject" text,
	"raw_storage_key" text,
	"parsed" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"application_id" uuid,
	"communication_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending_credentials' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credentials_ciphertext" text,
	"external_account_id" text,
	"connected_by" uuid,
	"connected_at" timestamp with time zone,
	"last_health_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interventions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"role_id" uuid,
	"detector" text NOT NULL,
	"ladder_level" text NOT NULL,
	"status" text DEFAULT 'sent' NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	"response" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"action" jsonb,
	"channel" text DEFAULT 'in_app' NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"role_id" uuid,
	"action_type" text NOT NULL,
	"level" text NOT NULL,
	"approver_roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recruiter_escalations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"role_id" uuid,
	"application_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"requested_by" jsonb NOT NULL,
	"question" text NOT NULL,
	"context_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"assigned_to_user_id" uuid,
	"claimed_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"sla_due_at" timestamp with time zone,
	"billing" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "takeovers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"recruiter_user_id" uuid NOT NULL,
	"escalation_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"policy_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid,
	"workflow_key" text NOT NULL,
	"workflow_version" integer DEFAULT 1 NOT NULL,
	"subject" jsonb NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"current_step" text NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"wait" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"escalation_id" uuid,
	"idempotency_key" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_steps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"company_id" uuid,
	"step_key" text NOT NULL,
	"seq" integer NOT NULL,
	"status" text NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debriefs" ADD CONSTRAINT "debriefs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debriefs" ADD CONSTRAINT "debriefs_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_outcomes" ADD CONSTRAINT "hiring_outcomes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_outcomes" ADD CONSTRAINT "hiring_outcomes_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_sessions" ADD CONSTRAINT "intake_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_participants" ADD CONSTRAINT "interview_participants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_participants" ADD CONSTRAINT "interview_participants_interview_id_interviews_id_fk" FOREIGN KEY ("interview_id") REFERENCES "public"."interviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_participants" ADD CONSTRAINT "interview_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboardings" ADD CONSTRAINT "onboardings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboardings" ADD CONSTRAINT "onboardings_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postings" ADD CONSTRAINT "postings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postings" ADD CONSTRAINT "postings_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_packets" ADD CONSTRAINT "role_packets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_packets" ADD CONSTRAINT "role_packets_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scorecards" ADD CONSTRAINT "scorecards_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scorecards" ADD CONSTRAINT "scorecards_interview_id_interviews_id_fk" FOREIGN KEY ("interview_id") REFERENCES "public"."interviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scorecards" ADD CONSTRAINT "scorecards_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scorecards" ADD CONSTRAINT "scorecards_interviewer_user_id_users_id_fk" FOREIGN KEY ("interviewer_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screens" ADD CONSTRAINT "screens_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screens" ADD CONSTRAINT "screens_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interventions" ADD CONSTRAINT "interventions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recruiter_escalations" ADD CONSTRAINT "recruiter_escalations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "takeovers" ADD CONSTRAINT "takeovers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "takeovers" ADD CONSTRAINT "takeovers_recruiter_user_id_users_id_fk" FOREIGN KEY ("recruiter_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "companies_slug_idx" ON "companies" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "entitlements_company_key_idx" ON "entitlements" USING btree ("company_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "magic_links_token_idx" ON "magic_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "magic_links_email_idx" ON "magic_links" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_company_user_idx" ON "memberships" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_idx" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "usage_events_company_idx" ON "usage_events" USING btree ("company_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "applications_role_candidate_idx" ON "applications" USING btree ("role_id","candidate_id");--> statement-breakpoint
CREATE INDEX "applications_company_role_stage_idx" ON "applications" USING btree ("company_id","role_id","stage");--> statement-breakpoint
CREATE INDEX "applications_company_candidate_idx" ON "applications" USING btree ("company_id","candidate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "applications_status_token_idx" ON "applications" USING btree ("status_token");--> statement-breakpoint
CREATE INDEX "assessments_application_idx" ON "assessments" USING btree ("application_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "candidates_company_dedupe_idx" ON "candidates" USING btree ("company_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "candidates_company_email_idx" ON "candidates" USING btree ("company_id","email");--> statement-breakpoint
CREATE INDEX "communications_company_candidate_idx" ON "communications" USING btree ("company_id","candidate_id","created_at");--> statement-breakpoint
CREATE INDEX "communications_application_idx" ON "communications" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "debriefs_role_idx" ON "debriefs" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "documents_company_candidate_idx" ON "documents" USING btree ("company_id","candidate_id");--> statement-breakpoint
CREATE INDEX "documents_application_idx" ON "documents" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "hiring_outcomes_application_idx" ON "hiring_outcomes" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "intake_sessions_company_idx" ON "intake_sessions" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "interview_participants_idx" ON "interview_participants" USING btree ("interview_id","user_id");--> statement-breakpoint
CREATE INDEX "interviews_application_idx" ON "interviews" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "interviews_company_time_idx" ON "interviews" USING btree ("company_id","starts_at");--> statement-breakpoint
CREATE INDEX "offers_application_idx" ON "offers" USING btree ("application_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "onboardings_application_idx" ON "onboardings" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "playbooks_vertical_version_idx" ON "playbooks" USING btree ("vertical","version");--> statement-breakpoint
CREATE UNIQUE INDEX "postings_role_channel_idx" ON "postings" USING btree ("role_id","channel");--> statement-breakpoint
CREATE INDEX "postings_intake_token_idx" ON "postings" USING btree ("intake_token");--> statement-breakpoint
CREATE UNIQUE INDEX "role_packets_role_version_idx" ON "role_packets" USING btree ("role_id","version");--> statement-breakpoint
CREATE INDEX "role_packets_company_idx" ON "role_packets" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "roles_company_status_idx" ON "roles" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "scorecards_interview_interviewer_idx" ON "scorecards" USING btree ("interview_id","interviewer_user_id");--> statement-breakpoint
CREATE INDEX "screens_application_idx" ON "screens" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "screens_token_idx" ON "screens" USING btree ("token");--> statement-breakpoint
CREATE INDEX "ai_runs_company_idx" ON "ai_runs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_runs_task_idx" ON "ai_runs" USING btree ("task","created_at");--> statement-breakpoint
CREATE INDEX "approval_requests_company_status_idx" ON "approval_requests" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "approval_requests_run_idx" ON "approval_requests" USING btree ("workflow_run_id");--> statement-breakpoint
CREATE INDEX "audit_records_company_idx" ON "audit_records" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_records_action_idx" ON "audit_records" USING btree ("action","created_at");--> statement-breakpoint
CREATE INDEX "events_company_time_idx" ON "events" USING btree ("company_id","occurred_at");--> statement-breakpoint
CREATE INDEX "events_subject_idx" ON "events" USING btree ("subject_type","subject_id","occurred_at");--> statement-breakpoint
CREATE INDEX "events_type_idx" ON "events" USING btree ("type","occurred_at");--> statement-breakpoint
CREATE INDEX "events_correlation_idx" ON "events" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "inbound_emails_status_idx" ON "inbound_emails" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_company_provider_idx" ON "integrations" USING btree ("company_id","provider");--> statement-breakpoint
CREATE INDEX "interventions_company_role_idx" ON "interventions" USING btree ("company_id","role_id","sent_at");--> statement-breakpoint
CREATE INDEX "jobs_status_run_at_idx" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","read_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "policies_scope_action_idx" ON "policies" USING btree ("company_id","role_id","action_type");--> statement-breakpoint
CREATE INDEX "recruiter_escalations_status_idx" ON "recruiter_escalations" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "recruiter_escalations_company_idx" ON "recruiter_escalations" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "takeovers_role_idx" ON "takeovers" USING btree ("role_id","status");--> statement-breakpoint
CREATE INDEX "workflow_runs_status_idx" ON "workflow_runs" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "workflow_runs_subject_idx" ON "workflow_runs" USING btree ("workflow_key","status");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_idempotency_idx" ON "workflow_runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "workflow_steps_run_idx" ON "workflow_steps" USING btree ("run_id","seq");