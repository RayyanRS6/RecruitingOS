-- Slice 5 steps 7 to 9 (18 September 2026): declared availability, per-person calendar connections, interview scheduling.

CREATE TABLE IF NOT EXISTS interviewer_availability (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  user_id uuid NOT NULL REFERENCES users(id),
  timezone text NOT NULL,
  windows jsonb NOT NULL DEFAULT '[]'::jsonb,
  buffer_minutes integer NOT NULL DEFAULT 15,
  max_per_day integer NOT NULL DEFAULT 3,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS interviewer_availability_user_idx ON interviewer_availability (company_id, user_id);
--> statement-breakpoint
ALTER TABLE interviewer_availability ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON interviewer_availability
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid OR (current_setting('app.platform', true) = 'on' AND current_user <> 'app_tenant'))
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid OR (current_setting('app.platform', true) = 'on' AND current_user <> 'app_tenant'));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON interviewer_availability TO app_tenant, ros_app, ros_worker;
--> statement-breakpoint
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS user_id uuid;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS integrations_company_provider_kind_user_idx ON integrations (company_id, provider, kind, user_id) NULLS NOT DISTINCT;
--> statement-breakpoint
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS schedule_token text;
--> statement-breakpoint
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS schedule_token_expires_at timestamptz;
--> statement-breakpoint
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS scheduling_window jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS offered_slots jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS selected_slot jsonb;
--> statement-breakpoint
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS candidate_availability jsonb;
--> statement-breakpoint
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS link_source text NOT NULL DEFAULT 'calendar';
--> statement-breakpoint
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS reschedule_count_candidate integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS cancel_reason text;
--> statement-breakpoint
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS outcome text;
--> statement-breakpoint
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS decision text;
--> statement-breakpoint
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS decision_note text;
--> statement-breakpoint
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS reminders jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS workflow_run_id uuid;
--> statement-breakpoint
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS created_by jsonb;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS interviews_schedule_token_idx ON interviews (schedule_token) WHERE schedule_token IS NOT NULL;
