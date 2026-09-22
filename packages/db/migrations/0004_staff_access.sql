-- Slice 2 (founder decision F10): explicit, role-scoped, time-limited access for ITS staff; per-request audit detail;
-- response-time and effort tracking on escalations (F12).

CREATE TABLE IF NOT EXISTS staff_access_grants (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  company_id uuid NOT NULL REFERENCES companies(id),
  kind text NOT NULL,
  escalation_id uuid,
  role_id uuid,
  application_id uuid,
  purpose text NOT NULL,
  granted_by jsonb NOT NULL,
  mfa_verified boolean NOT NULL DEFAULT false,
  starts_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS staff_access_grants_user_company_idx ON staff_access_grants (user_id, company_id, expires_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS staff_access_grants_escalation_idx ON staff_access_grants (escalation_id);
--> statement-breakpoint
-- Customers may see who was granted access to their data; only the platform writes grants.
ALTER TABLE staff_access_grants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON staff_access_grants
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid OR (current_setting('app.platform', true) = 'on' AND current_user <> 'app_tenant'))
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid OR (current_setting('app.platform', true) = 'on' AND current_user <> 'app_tenant'));
--> statement-breakpoint
GRANT SELECT ON staff_access_grants TO app_tenant;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON staff_access_grants FROM app_tenant;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON staff_access_grants TO ros_app, ros_worker;
--> statement-breakpoint
ALTER TABLE audit_records ADD COLUMN IF NOT EXISTS details jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE recruiter_escalations ADD COLUMN IF NOT EXISTS first_response_at timestamptz;
--> statement-breakpoint
ALTER TABLE recruiter_escalations ADD COLUMN IF NOT EXISTS minutes_spent integer;
--> statement-breakpoint
ALTER TABLE recruiter_escalations ADD COLUMN IF NOT EXISTS access_expires_at timestamptz;
