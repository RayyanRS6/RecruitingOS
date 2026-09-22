-- Slice 1 security (founder decision F1, 14 September 2026).
-- The application never connects as a superuser or a role that bypasses row-level security.
-- Two non-privileged group roles: `ros_app` (API) and `ros_worker` (workflow and integration worker).
-- Operators turn them into login roles (see docs/spec/10 and packages/db/scripts/provision-roles.sql).
-- Platform paths (auth, webhooks, admin, candidate pages) run with `app.platform = 'on'`, which the policies
-- honour only for roles other than `app_tenant`; tenant transactions switch to `app_tenant` and are isolated
-- by `app.company_id` regardless of any setting.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ros_app') THEN
    CREATE ROLE ros_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ros_worker') THEN
    CREATE ROLE ros_worker NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO ros_app, ros_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ros_app, ros_worker;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ros_app, ros_worker;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ros_app, ros_worker;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ros_app, ros_worker;
--> statement-breakpoint
-- Tenant transactions switch to app_tenant; both application roles may do so.
GRANT app_tenant TO ros_app, ros_worker;
--> statement-breakpoint
-- Only the worker claims and completes jobs; the API may only enqueue and inspect.
REVOKE UPDATE, DELETE ON jobs FROM ros_app;
--> statement-breakpoint
-- Migrations are not the application's business.
REVOKE ALL ON _migrations FROM ros_app, ros_worker, app_tenant;
--> statement-breakpoint

-- Row-level security on every table that carries a company_id, with the platform clause.
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables tb ON tb.table_name = c.table_name AND tb.table_schema = c.table_schema
    WHERE c.table_schema = 'public' AND c.column_name = 'company_id' AND tb.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ('
      || 'company_id = NULLIF(current_setting(''app.company_id'', true), '''')::uuid '
      || 'OR (current_setting(''app.platform'', true) = ''on'' AND current_user <> ''app_tenant'')'
      || ') WITH CHECK ('
      || 'company_id = NULLIF(current_setting(''app.company_id'', true), '''')::uuid '
      || 'OR (current_setting(''app.platform'', true) = ''on'' AND current_user <> ''app_tenant'')'
      || ')',
      t
    );
  END LOOP;
END $$;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_self ON companies;
--> statement-breakpoint
CREATE POLICY tenant_self ON companies
  USING (id = NULLIF(current_setting('app.company_id', true), '')::uuid OR (current_setting('app.platform', true) = 'on' AND current_user <> 'app_tenant'))
  WITH CHECK (id = NULLIF(current_setting('app.company_id', true), '')::uuid OR (current_setting('app.platform', true) = 'on' AND current_user <> 'app_tenant'));
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_members ON users;
--> statement-breakpoint
CREATE POLICY tenant_members ON users USING (
  EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)
  OR (current_setting('app.platform', true) = 'on' AND current_user <> 'app_tenant')
);
--> statement-breakpoint
-- Platform-only tables stay out of the tenant role's reach (restated so this migration is self-contained).
REVOKE ALL ON sessions, magic_links FROM app_tenant;
