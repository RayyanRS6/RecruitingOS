-- Team invitations as rows of their own (docs/spec/21, area A). An invitation names the company, the address it was
-- sent to, the role it carries and who sent it; the emailed link holds a random token whose hash is kept here. It is
-- accepted by signing in with Google or Microsoft (or the email link, where a deployment enables it) using the invited
-- address: the sign-in never opens a session on the strength of the link alone. One open invitation per address and
-- company: a newer one replaces the older. Rows are never deleted; they end as accepted, revoked or expired.
--
-- magic_links.invite_company_id and magic_links.invite_role are no longer written or read: the email link used to carry
-- the invitation itself, which meant acceptance opened a single-factor session. The columns stay (migrations are
-- append-only) and hold nothing new.
CREATE TABLE IF NOT EXISTS invitations (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  email text NOT NULL,
  role text NOT NULL,
  name text,
  invited_by jsonb NOT NULL,
  token_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_user_id uuid,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS invitations_token_hash_idx ON invitations (token_hash);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS invitations_company_status_idx ON invitations (company_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS invitations_email_status_idx ON invitations (email, status);
--> statement-breakpoint
-- Tenant transactions see and write their own company's invitations; the sign-in path (platform side, before any
-- tenant is known) reads the one a browser carries and accepts every pending one for the verified address.
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON invitations
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid OR (current_setting('app.platform', true) = 'on' AND current_user <> 'app_tenant'))
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid OR (current_setting('app.platform', true) = 'on' AND current_user <> 'app_tenant'));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON invitations TO app_tenant, ros_app, ros_worker;
--> statement-breakpoint
-- An invitation is revoked or expires, never deleted: the record of who was invited, by whom, stays.
REVOKE DELETE ON invitations FROM app_tenant, ros_app, ros_worker;
