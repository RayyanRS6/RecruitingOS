-- Slice 5 step 4 (decision D19, correction 4 of 18 September 2026): sign-in is delegated to a managed identity service.
-- The application links users to the provider's subject, records how each session was opened, and keeps the time a
-- second factor was verified so break-glass (D25) can require it.

ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider text;
--> statement-breakpoint
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_subject text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS users_auth_subject_idx ON users (auth_provider, auth_subject);
--> statement-breakpoint
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS identity_provider text;
--> statement-breakpoint
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS aal text;
--> statement-breakpoint
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS mfa_verified_at timestamptz;
