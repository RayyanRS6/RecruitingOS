-- Supabase Vault access (founder decision F1, D21). Run as the project owner after provision-roles.sql.
-- The API role may store, rotate, and delete secrets but never read decrypted values; only the worker may read.
GRANT USAGE ON SCHEMA vault TO ros_app, ros_worker;
GRANT EXECUTE ON FUNCTION vault.create_secret(text, text, text) TO ros_app, ros_worker;
GRANT EXECUTE ON FUNCTION vault.update_secret(uuid, text, text, text) TO ros_app, ros_worker;
GRANT DELETE ON vault.secrets TO ros_app, ros_worker;
GRANT SELECT ON vault.decrypted_secrets TO ros_worker;
REVOKE SELECT ON vault.decrypted_secrets FROM ros_app;
-- Signature note: Supabase exposes vault.update_secret(id uuid, new_secret text, new_name text, new_description text); the store passes the first two.
