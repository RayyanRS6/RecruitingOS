-- Slice 5 step 3 (correction 10, 18 September 2026): secret lifecycle. Credentials live only in the managed secret store;
-- the application keeps an opaque reference; disconnecting deletes the secret; a failed deletion raises an operator alert.

ALTER TABLE integrations ADD COLUMN IF NOT EXISTS secret_ref text;
--> statement-breakpoint
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS secret_deleted_at timestamptz;
--> statement-breakpoint
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
--> statement-breakpoint
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS disconnected_at timestamptz;
--> statement-breakpoint
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS disconnect_reason text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS admin_alerts (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  severity text NOT NULL DEFAULT 'high',
  title text NOT NULL,
  body text NOT NULL,
  company_id uuid,
  target jsonb,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open',
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS admin_alerts_status_idx ON admin_alerts (status, created_at);
--> statement-breakpoint
-- Operator-only. The tenant role has no access; the standard tenant policy is present so the isolation check covers the table.
ALTER TABLE admin_alerts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON admin_alerts
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid OR (current_setting('app.platform', true) = 'on' AND current_user <> 'app_tenant'))
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid OR (current_setting('app.platform', true) = 'on' AND current_user <> 'app_tenant'));
--> statement-breakpoint
REVOKE ALL ON admin_alerts FROM app_tenant;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON admin_alerts TO ros_app, ros_worker;
