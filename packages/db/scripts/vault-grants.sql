-- Supabase Vault access (founder decision F1, D21). Applied by packages/db/src/cli/provision.ts as the project owner,
-- after the migrations. The API role may store, rotate and delete secrets but never read decrypted values; only the
-- worker may read. Statements are separated by the same marker the migrations use. The EXECUTE grants resolve the
-- functions' real signatures at run time: Supabase's Vault declares create_secret with a fourth, defaulted key
-- argument and may change the list again; a grant written with a guessed signature fails as "function does not exist".
GRANT USAGE ON SCHEMA vault TO ros_app, ros_worker;
--> statement-breakpoint
DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace = 'vault'::regnamespace AND p.proname IN ('create_secret', 'update_secret') LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ros_app, ros_worker', f);
  END LOOP;
END $$;
--> statement-breakpoint
GRANT DELETE ON vault.secrets TO ros_app, ros_worker;
--> statement-breakpoint
GRANT SELECT ON vault.decrypted_secrets TO ros_worker;
--> statement-breakpoint
REVOKE SELECT ON vault.decrypted_secrets FROM ros_app;
