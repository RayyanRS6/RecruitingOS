-- Re-authentication before sensitive changes (audit finding A12). A policy or notice change is accepted only from a
-- session younger than thirty minutes or one whose holder confirmed with their sign-in provider again in the last ten
-- minutes; the confirmation is recorded here on the session row, never as a new session and never as a token.
ALTER TABLE sessions ADD COLUMN reauthenticated_at timestamptz;
