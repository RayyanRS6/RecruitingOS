-- Supabase hosts the database behind a Data API (PostgREST) whose roles anon, authenticated and service_role receive
-- privileges on every table created in public through the project's default privileges. This application never uses
-- the Data API: it connects to Postgres as ros_app and ros_worker, and its platform tables have no row-level security
-- because the application role is the only one meant to reach them. Take those privileges away, now and for future
-- tables, so nothing is readable with the publishable key. A no-op where the roles do not exist (PGlite, plain Postgres).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated';
    EXECUTE 'REVOKE USAGE ON SCHEMA public FROM anon, authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM service_role';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM service_role';
    EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM service_role';
    EXECUTE 'REVOKE USAGE ON SCHEMA public FROM service_role';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM service_role';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM service_role';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM service_role';
  END IF;
END $$;
