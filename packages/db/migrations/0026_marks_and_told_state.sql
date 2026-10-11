-- The stage strip and private decisions (founder decisions B3 and B6; plan items A4 and G1, plan-adjustments sections 2
-- and 4).
--
-- application_marks: a person's private mark on an application: longlist, shortlist, on_hold or not_a_fit_for_now
-- (text, not an enum, like every other kind column). The internal stage machine is unchanged; a mark is an overlay the
-- owner sees on the strip and the candidate never sees. A hold always carries the date it ends (remind_at), when the
-- person comes back to Today. At most one mark is active per application; a newer one clears the older, and every mark
-- clears when the application leaves the process (hired, withdrawn, declined, talent pool). Rows are cleared, never
-- deleted, so the history of who sorted whom, when and why stays.
CREATE TABLE IF NOT EXISTS application_marks (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  application_id uuid NOT NULL REFERENCES applications(id),
  mark text NOT NULL,
  remind_at timestamptz,
  note text,
  set_by jsonb NOT NULL,
  source text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz,
  cleared_by jsonb,
  clear_reason text,
  CONSTRAINT application_marks_hold_has_date CHECK (mark <> 'on_hold' OR remind_at IS NOT NULL)
);
--> statement-breakpoint
-- One active mark per application, and the lookup every list and detail makes.
CREATE UNIQUE INDEX IF NOT EXISTS application_marks_active_idx ON application_marks (company_id, application_id) WHERE cleared_at IS NULL;
--> statement-breakpoint
-- Holds whose date has come: the stuck detector's resurfacing query.
CREATE INDEX IF NOT EXISTS application_marks_hold_due_idx ON application_marks (company_id, remind_at) WHERE cleared_at IS NULL AND mark = 'on_hold';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS application_marks_application_idx ON application_marks (application_id, created_at);
--> statement-breakpoint
ALTER TABLE application_marks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON application_marks
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid OR (current_setting('app.platform', true) = 'on' AND current_user <> 'app_tenant'))
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid OR (current_setting('app.platform', true) = 'on' AND current_user <> 'app_tenant'));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON application_marks TO app_tenant, ros_app, ros_worker;
--> statement-breakpoint
-- A mark is cleared, never deleted (a privacy deletion blanks its note instead).
REVOKE DELETE ON application_marks FROM app_tenant, ros_app, ros_worker;
--> statement-breakpoint
-- Whether the candidate was told a decision (G1, B6). A decision (declined, or moved to the talent pool) is private when
-- it is made: told_state starts at not_told, becomes queued when a person sends the standard message, sent when the
-- outbox delivers it, or told_in_person when someone records that they told the candidate themselves. The status page
-- shows the decision only once the candidate was told.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS told_state text NOT NULL DEFAULT 'not_told';
--> statement-breakpoint
ALTER TABLE applications ADD COLUMN IF NOT EXISTS candidate_told_at timestamptz;
--> statement-breakpoint
-- Decisions made before this migration: a decline message that left (or was delivered) means the candidate was told;
-- one still in the outbox is queued. The rest are settled after these two updates (before_tracking, below).
UPDATE applications a SET told_state = 'sent', candidate_told_at = sent.at
  FROM (
    SELECT application_id, max(coalesce(delivered_at, created_at)) AS at FROM communications
    WHERE direction = 'outbound' AND template_key LIKE 'disposition:%' AND status IN ('sent', 'delivered') AND application_id IS NOT NULL
    GROUP BY application_id
  ) sent
  WHERE a.id = sent.application_id AND a.stage IN ('rejected', 'talent_pool');
--> statement-breakpoint
UPDATE applications a SET told_state = 'queued'
  WHERE a.told_state = 'not_told' AND a.stage IN ('rejected', 'talent_pool') AND EXISTS (
    SELECT 1 FROM communications c WHERE c.application_id = a.id AND c.direction = 'outbound' AND c.template_key LIKE 'disposition:%' AND c.status IN ('queued', 'sending')
  );
--> statement-breakpoint
-- Every other decision made before this migration was already shown on the candidate's status page, which showed each
-- stage as it was (declines the team told by phone, people moved to the talent pool by a role close, messages that
-- failed): it counts as told (before_tracking), so it never shows as "not told yet" or goes out in a bulk Send long
-- after the fact. A decision whose message still waits for an approver stays not_told, so approving it sends it.
UPDATE applications a SET told_state = 'before_tracking', candidate_told_at = a.stage_changed_at
  WHERE a.told_state = 'not_told' AND a.stage IN ('rejected', 'talent_pool') AND NOT EXISTS (
    SELECT 1 FROM approval_requests r WHERE r.application_id = a.id AND r.action_type = 'disposition.send' AND r.status = 'pending'
  );
--> statement-breakpoint
INSERT INTO events (company_id, type, actor, subject_type, subject_id, payload)
  SELECT company_id, 'application.told', '{"kind":"system","id":"migration_0026","name":"Private decisions (founder decision B6)"}'::jsonb, 'application', id::text, jsonb_build_object('how', 'before_tracking')
  FROM applications WHERE told_state = 'before_tracking';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS applications_company_told_idx ON applications (company_id, role_id, told_state) WHERE stage IN ('rejected', 'talent_pool');
--> statement-breakpoint
-- The decision message policy (disposition.send) now governs only the message a person chooses to send: declining
-- never sends anything by itself. The new default is "auto" (the message goes when a person presses Send). Saved
-- settings that sent at once on their own (auto_notify, and any other unattended level) move to it. A company's own
-- choices stay: "Ask me first" (approval: a second person approves each message) and "only a person" (human_only: the
-- product sends no decision messages and the team tells candidates themselves). Each move is recorded.
INSERT INTO events (company_id, type, actor, subject_type, subject_id, payload)
  SELECT company_id, 'policy.changed', '{"kind":"system","id":"migration_0026","name":"Private decisions (founder decision B6)"}'::jsonb, 'policy', id::text,
    jsonb_build_object('actionType', action_type, 'level', 'auto', 'roleId', role_id, 'previous', level, 'reason', 'Declining no longer sends a message by itself; a person sends it later.')
  FROM policies WHERE action_type = 'disposition.send' AND level NOT IN ('auto', 'approval', 'human_only');
--> statement-breakpoint
UPDATE policies SET level = 'auto', updated_at = now() WHERE action_type = 'disposition.send' AND level NOT IN ('auto', 'approval', 'human_only');
