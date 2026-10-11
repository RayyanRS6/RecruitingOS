-- Applying and the screening conversation in one visit (plan Wave E, item E1; founder decision B1/Q15).
--
-- roles.apply_mode: how a role's applicants meet the screening conversation. 'one_visit': everyone who passes the yes/no
-- eligibility questions is offered the conversation straight after sending the form (Start, Do this later, or talk to a
-- person). 'form_then_screen': the form now, and an invitation by email later, as before. NULL follows the company's
-- default (companies.settings.applyFlowDefault, 'form_then_screen' when it is not set): the one-visit flow runs on pilot
-- roles first, switched on by ITS for a role or a company. Only ITS changes either. Roles that exist before this
-- migration keep the flow they were opened with; new roles start as NULL.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS apply_mode text;
--> statement-breakpoint
UPDATE roles SET apply_mode = 'form_then_screen' WHERE apply_mode IS NULL;
--> statement-breakpoint
-- screens.invited_via: 'apply' when the conversation was offered in the same visit as the application, 'confirmed_repeat'
-- when answers given after a repeat submission were added once the address owner confirmed them, NULL for an invitation
-- sent by email (the later path). "Still applying" on the owner's list is read from it (item E6).
ALTER TABLE screens ADD COLUMN IF NOT EXISTS invited_via text;
--> statement-breakpoint
-- The one reminder sent to someone who started the conversation and stopped part-way (item E4).
ALTER TABLE screens ADD COLUMN IF NOT EXISTS idle_reminded_at timestamptz;
--> statement-breakpoint
-- The plan's allowance now counts a conversation at the candidate's first answer (item E9, progress.countedAt), where it
-- used to count it at the invitation. Every screen that exists before this migration was counted when it was invited,
-- so it is marked as counted: one still waiting for its first answer is never counted a second time.
UPDATE screens SET progress = progress || jsonb_build_object('countedAt', to_jsonb(coalesce(invited_at, created_at)))
  WHERE progress IS NOT NULL AND NOT (progress ? 'countedAt');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS screens_company_via_status_idx ON screens (company_id, invited_via, status);
--> statement-breakpoint
-- A repeat submission (Q14 x Q15). Anyone can type anyone's address into a public form, so a second application from an
-- address that already applied for the role must look exactly like a first one without touching the real application.
-- Its conversation runs here, detached: nothing in it reaches the application, the candidate, the team's lists or the
-- history. When it ends, the address on file gets an email; the answers are added to the application only if the owner
-- of that address opens the link and confirms (its token is kept as a hash). Unconfirmed, the words are wiped after
-- seven days (expires_at). Rows are never deleted: a wiped row keeps only that something happened and when.
--
-- status: the conversation, in the screens vocabulary (invited, in_progress, paused, completed, human_requested,
-- abandoned, declined_by_candidate, expired). confirmation: NULL (nothing to confirm), 'sent', 'confirmed', 'not_added'
-- (confirmed, but the application already had answers or had moved on) or 'discarded'. intent: what the address owner is
-- asked to confirm ('answers', 'person' or 'withdraw').
CREATE TABLE IF NOT EXISTS unconfirmed_screens (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  role_id uuid NOT NULL REFERENCES roles(id),
  application_id uuid NOT NULL REFERENCES applications(id),
  packet_version integer NOT NULL,
  first_name text NOT NULL,
  token text NOT NULL,
  status text NOT NULL DEFAULT 'invited',
  intent text,
  confirmation text,
  confirm_token_hash text,
  transcript jsonb NOT NULL DEFAULT '[]'::jsonb,
  answers jsonb NOT NULL DEFAULT '{}'::jsonb,
  progress jsonb NOT NULL DEFAULT '{"askedKeys":[],"currentQuestionKey":null,"followUps":{},"confusedTurns":0,"failures":0}'::jsonb,
  started_at timestamptz,
  last_candidate_message_at timestamptz,
  finished_at timestamptz,
  confirm_sent_at timestamptz,
  confirmed_at timestamptz,
  merged_screen_id uuid,
  discarded_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS unconfirmed_screens_token_idx ON unconfirmed_screens (token);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS unconfirmed_screens_confirm_idx ON unconfirmed_screens (confirm_token_hash) WHERE confirm_token_hash IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS unconfirmed_screens_application_idx ON unconfirmed_screens (application_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS unconfirmed_screens_expiry_idx ON unconfirmed_screens (company_id, expires_at) WHERE discarded_at IS NULL;
--> statement-breakpoint
-- The conversation pages read a row by its link (like a screen); the company's own transactions write it; the daily
-- sweep that wipes expired rows runs per company.
ALTER TABLE unconfirmed_screens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON unconfirmed_screens
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid OR (current_setting('app.platform', true) = 'on' AND current_user <> 'app_tenant'))
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid OR (current_setting('app.platform', true) = 'on' AND current_user <> 'app_tenant'));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON unconfirmed_screens TO app_tenant, ros_app, ros_worker;
--> statement-breakpoint
-- Wiped, never deleted: that a repeat submission happened, and when, stays.
REVOKE DELETE ON unconfirmed_screens FROM app_tenant, ros_app, ros_worker;
