-- The Cancelled column (founder decisions 1A to 4A, 9 October 2026). One row each time a candidate cancels a booked
-- interview from their schedule page (with their choice: new times later, or no longer interested), or the team records
-- that the candidate did not show. The row carries the one automatic set of new times and how it ended, and when, how and
-- by whom the person left the column. A team cancel, an exit, a member removal and a privacy deletion never write here.
-- kind, choice, auto_state, auto_reason, last_sent_via and resolved_how are text with CHECKs. No candidate words are stored
-- (they stay on interviews.cancel_reason, as today). Rows are resolved (resolved_at), never deleted.
CREATE TABLE IF NOT EXISTS interview_followups (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  application_id uuid NOT NULL REFERENCES applications(id),
  interview_id uuid NOT NULL REFERENCES interviews(id),
  interview_attempt integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('candidate_cancelled', 'candidate_no_show')),
  choice text CHECK (choice IN ('new_times', 'not_interested')),
  auto_state text NOT NULL DEFAULT 'none' CHECK (auto_state IN ('none', 'waiting', 'waiting_check', 'preparing', 'sent', 'not_sent')),
  auto_reason text,
  auto_working_days integer CHECK (auto_working_days BETWEEN 1 AND 10),
  auto_due_at timestamptz,
  auto_run_id uuid,
  auto_sent_at timestamptz,
  current_interview_id uuid REFERENCES interviews(id),
  times_sent_count integer NOT NULL DEFAULT 0,
  last_sent_at timestamptz,
  last_sent_via text CHECK (last_sent_via IN ('auto', 'person', 'batch')),
  last_sent_by jsonb,
  -- `slots:{interviewId}:{attempt}` of the last offer counted, so an offer step that runs twice counts once.
  last_offer_key text,
  resolved_at timestamptz,
  resolved_how text CHECK (resolved_how IN ('rebooked', 'moved_by_team', 'team_cancelled', 'left_process', 'superseded')),
  resolved_by jsonb,
  created_by jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT interview_followups_choice_by_kind CHECK ((kind = 'candidate_cancelled' AND choice IS NOT NULL) OR (kind = 'candidate_no_show' AND choice IS NULL)),
  CONSTRAINT interview_followups_auto_only_when_asked CHECK (auto_state = 'none' OR (kind = 'candidate_cancelled' AND choice = 'new_times')),
  CONSTRAINT interview_followups_waiting_has_due CHECK (auto_state NOT IN ('waiting', 'waiting_check') OR (auto_due_at IS NOT NULL AND auto_working_days IS NOT NULL)),
  CONSTRAINT interview_followups_sent_has_time CHECK (auto_state <> 'sent' OR auto_sent_at IS NOT NULL),
  CONSTRAINT interview_followups_resolved_has_how CHECK ((resolved_at IS NULL) = (resolved_how IS NULL))
);
--> statement-breakpoint
-- The same cancel pressed twice writes one row.
CREATE UNIQUE INDEX IF NOT EXISTS interview_followups_entry_idx ON interview_followups (company_id, interview_id, interview_attempt);
--> statement-breakpoint
-- Someone is in the column once.
CREATE UNIQUE INDEX IF NOT EXISTS interview_followups_open_idx ON interview_followups (company_id, application_id) WHERE resolved_at IS NULL;
--> statement-breakpoint
-- One automatic set of new times per person, ever: being prepared, or sent. A set that never went (not_sent) is not used.
CREATE UNIQUE INDEX IF NOT EXISTS interview_followups_one_auto_idx ON interview_followups (company_id, application_id) WHERE auto_state IN ('preparing', 'sent');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS interview_followups_due_idx ON interview_followups (company_id, auto_due_at) WHERE auto_state IN ('waiting', 'waiting_check');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS interview_followups_application_idx ON interview_followups (application_id, created_at);
--> statement-breakpoint
ALTER TABLE interview_followups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON interview_followups
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid OR (current_setting('app.platform', true) = 'on' AND current_user <> 'app_tenant'))
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid OR (current_setting('app.platform', true) = 'on' AND current_user <> 'app_tenant'));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON interview_followups TO app_tenant, ros_app, ros_worker;
--> statement-breakpoint
-- Resolved, never deleted (app_tenant gets DELETE by default privileges, 0001_rls_and_grants.sql:17).
REVOKE DELETE ON interview_followups FROM app_tenant, ros_app, ros_worker;
--> statement-breakpoint
-- Backfill: someone the team recorded as a candidate no-show, still undecided, still at "interview done", with no newer
-- interview, no private mark and an open role, goes under Cancelled as a no-show. Nothing is armed and nothing is sent.
-- Earlier candidate cancellations are NOT backfilled: nobody asked them the choice the column shows.
-- Each backfilled row is recorded in the history as application.moved_to_cancelled (as 0026 records its changes).
WITH added AS (
  INSERT INTO interview_followups (id, company_id, application_id, interview_id, interview_attempt, kind, choice, auto_state, auto_reason, created_by, created_at, updated_at)
  SELECT gen_random_uuid(), i.company_id, i.application_id, i.id, i.attempt, 'candidate_no_show', NULL, 'none', 'no_show', '{"kind":"system","id":"migration_0035","name":"The Cancelled column (founder decision 4A)"}'::jsonb, now(), now()
  FROM interviews i
  JOIN applications a ON a.id = i.application_id
  JOIN roles r ON r.id = a.role_id
  WHERE i.status = 'no_show' AND i.outcome = 'no_show_candidate' AND i.decision IS NULL
    AND a.stage = 'interview_complete' AND r.status NOT IN ('closed', 'filled')
    AND NOT EXISTS (SELECT 1 FROM interviews n WHERE n.application_id = i.application_id AND (n.created_at, n.id) > (i.created_at, i.id))
    AND NOT EXISTS (SELECT 1 FROM application_marks m WHERE m.application_id = a.id AND m.cleared_at IS NULL)
  ON CONFLICT DO NOTHING
  RETURNING id, company_id, application_id, interview_id
)
INSERT INTO events (company_id, type, actor, subject_type, subject_id, payload)
SELECT company_id, 'application.moved_to_cancelled', '{"kind":"system","id":"migration_0035","name":"The Cancelled column (founder decision 4A)"}'::jsonb, 'application', application_id::text,
  jsonb_build_object('followUpId', id, 'interviewId', interview_id, 'reason', 'no_show', 'auto', jsonb_build_object('state', 'none'), 'backfill', true)
FROM added;
