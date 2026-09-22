-- Privacy requests (correction 7; docs/runbooks/privacy-requests.md), built 18 September 2026 with synthetic data.
-- Operator-only table: the tenant role cannot read it; customers see only a "data request fulfilled" event.

ALTER TABLE candidates ADD COLUMN IF NOT EXISTS anonymized_at timestamptz;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS data_requests (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  candidate_id uuid,
  application_id uuid,
  kind text NOT NULL,
  details text,
  requester_email text NOT NULL,
  channel text NOT NULL DEFAULT 'status_page',
  verification_status text NOT NULL DEFAULT 'pending',
  verification_note text,
  verified_at timestamptz,
  verified_by uuid,
  status text NOT NULL DEFAULT 'received',
  sla_due_at timestamptz NOT NULL,
  assigned_to uuid,
  notes jsonb NOT NULL DEFAULT '[]'::jsonb,
  counsel_escalated_at timestamptz,
  counsel_decision text,
  counsel_note text,
  resolution text,
  resolved_at timestamptz,
  resolved_by uuid,
  confirmation_sent_at timestamptz,
  deadline_alerts jsonb NOT NULL DEFAULT '{}'::jsonb,
  escalation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS data_requests_company_status_idx ON data_requests (company_id, status, sla_due_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS data_requests_candidate_idx ON data_requests (candidate_id);
--> statement-breakpoint
ALTER TABLE data_requests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON data_requests
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid OR (current_setting('app.platform', true) = 'on' AND current_user <> 'app_tenant'))
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid OR (current_setting('app.platform', true) = 'on' AND current_user <> 'app_tenant'));
--> statement-breakpoint
REVOKE ALL ON data_requests FROM app_tenant;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON data_requests TO ros_app, ros_worker;
