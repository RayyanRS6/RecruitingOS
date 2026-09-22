-- Hardening from the adversarial review of 21 September 2026 (item 2 and item 7).
-- (a) Every existing platform role gets a ledger row so it can be seen and revoked in the console; the ledger is the
--     authority on every request from now on.
-- (b) The tenant role may update a member's profile columns but never the cached platform_role column.
-- (c) Audit records are facts: no application role deletes or rewrites them.

INSERT INTO platform_role_grants (id, user_id, role, source, granted_by, grant_reason, granted_at)
SELECT gen_random_uuid(), u.id, u.platform_role, 'migration_backfill',
       '{"kind":"system","id":"migration_0014","name":"migration backfill"}'::jsonb,
       'role held before the ledger existed; review in the console and re-grant or revoke', now()
FROM users u
WHERE u.platform_role IN ('its_recruiter', 'platform_admin')
  AND NOT EXISTS (SELECT 1 FROM platform_role_grants g WHERE g.user_id = u.id AND g.revoked_at IS NULL);
--> statement-breakpoint
REVOKE UPDATE ON users FROM app_tenant;
--> statement-breakpoint
DO $$
DECLARE cols text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ') INTO cols
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'users' AND column_name <> 'platform_role';
  EXECUTE format('GRANT UPDATE (%s) ON users TO app_tenant', cols);
END $$;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON audit_records FROM app_tenant, ros_app, ros_worker;
