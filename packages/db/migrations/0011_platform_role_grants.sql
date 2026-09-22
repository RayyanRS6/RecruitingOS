-- Platform roles through a ledger, not configuration (founder instruction of 21 September 2026, item 2).
-- Platform-only: the tenant role never reads or writes it. The one-time bootstrap writes the first row; every later
-- change is an audited console action by a named administrator with a second factor and a reason.

CREATE TABLE IF NOT EXISTS platform_role_grants (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL,
  source text NOT NULL,
  granted_by jsonb NOT NULL,
  grant_reason text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by jsonb,
  revoke_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS platform_role_grants_user_idx ON platform_role_grants (user_id, revoked_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS platform_role_grants_role_idx ON platform_role_grants (role, revoked_at);
--> statement-breakpoint
REVOKE ALL ON platform_role_grants FROM app_tenant;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform_role_grants TO ros_app, ros_worker;
--> statement-breakpoint
-- Ledger rows are never deleted; revocation is a new fact on the row.
REVOKE DELETE ON platform_role_grants FROM ros_app, ros_worker;
