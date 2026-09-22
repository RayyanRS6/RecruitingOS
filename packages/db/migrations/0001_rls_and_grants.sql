-- Row-level security and the non-privileged tenant role.
-- Application code runs tenant work as `app_tenant` with `app.company_id` set (see packages/db/src/client.ts).
-- Platform paths (auth, webhooks, admin) run as the connection's own role and are audited.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
    CREATE ROLE app_tenant NOLOGIN;
  END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_tenant;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_tenant;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_tenant;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_tenant;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_tenant;
--> statement-breakpoint

-- Tenant tables: isolate by company_id.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'memberships','entitlements','usage_events','roles','role_packets','intake_sessions','postings','candidates','documents',
    'applications','assessments','screens','interviews','interview_participants','scorecards','debriefs','communications',
    'offers','onboardings','hiring_outcomes','policies','approval_requests','workflow_runs','workflow_steps','ai_runs',
    'recruiter_escalations','takeovers','interventions','notifications','inbound_emails','integrations','audit_records','events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (company_id = current_setting(''app.company_id'', true)::uuid) WITH CHECK (company_id = current_setting(''app.company_id'', true)::uuid)',
      t
    );
  END LOOP;
END $$;
--> statement-breakpoint

-- Companies: a tenant sees only itself.
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_self ON companies;
--> statement-breakpoint
CREATE POLICY tenant_self ON companies USING (id = current_setting('app.company_id', true)::uuid) WITH CHECK (id = current_setting('app.company_id', true)::uuid);
--> statement-breakpoint

-- Users: a tenant sees only users who are members of the current company.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_members ON users;
--> statement-breakpoint
CREATE POLICY tenant_members ON users USING (
  EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.company_id = current_setting('app.company_id', true)::uuid)
);
--> statement-breakpoint

-- Platform-only tables are not readable by the tenant role except where the product needs them read-only.
REVOKE ALL ON sessions, magic_links FROM app_tenant;
--> statement-breakpoint
GRANT SELECT ON plans, playbooks TO app_tenant;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON plans, playbooks FROM app_tenant;
--> statement-breakpoint
-- The job queue is shared infrastructure; the tenant role may enqueue but the worker runs as the platform role.
GRANT SELECT, INSERT ON jobs TO app_tenant;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON jobs FROM app_tenant;
