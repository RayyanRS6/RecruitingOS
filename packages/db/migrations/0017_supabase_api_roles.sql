-- Supabase hosts the database behind a Data API (PostgREST) whose roles anon, authenticated and service_role may
-- receive privileges on every table created in public through the project's default privileges for the postgres
-- role. This application never uses the Data API: it connects to Postgres as ros_app and ros_worker, and its platform
-- tables have no row-level security because the application role is the only one meant to reach them. Take those
-- privileges away, now and for future objects the postgres role creates, so nothing is readable with the publishable
-- key. Objects owned by other roles (extension functions) are left alone. A no-op where the roles do not exist
-- (PGlite, plain Postgres), and idempotent where they do.
DO $$
DECLARE r text; f regprocedure;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
    FOR f IN SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proowner = current_user::regrole LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r);
    END LOOP;
    EXECUTE format('REVOKE USAGE ON SCHEMA public FROM %I', r);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM %I', current_user, r);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', current_user, r);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', current_user, r);
  END LOOP;
END $$;
