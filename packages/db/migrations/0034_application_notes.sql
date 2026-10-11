-- Interviews to hire (plan Wave H).
--
-- application_notes: private team notes on a candidate (founder decision Q24; plan H3). One note per person per
-- application, edited only by the person who wrote it; each change keeps the words it replaced in previous_versions.
-- starter is the prompt the note began from ('before_interview', 'after_interview', 'for_and_against', or null; text,
-- not an enum, like every other kind column). Owners, admins, hiring managers, HR and an ITS recruiter while they have
-- access read them; an interviewer writes their own note on people they interviewed and reads nobody else's. Notes
-- never reach the candidate or any AI prompt. Removing a note sets deleted_at; a privacy deletion also empties body and
-- previous_versions (the counsel default, register item 25). Rows are never deleted: who wrote a note, and when, stays.
CREATE TABLE IF NOT EXISTS application_notes (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  application_id uuid NOT NULL REFERENCES applications(id),
  author_user_id uuid NOT NULL REFERENCES users(id),
  starter text,
  body text NOT NULL,
  previous_versions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
--> statement-breakpoint
-- One live note per person per application; a removed one makes room for a new one.
CREATE UNIQUE INDEX IF NOT EXISTS application_notes_author_idx ON application_notes (company_id, application_id, author_user_id) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS application_notes_application_idx ON application_notes (application_id, created_at);
--> statement-breakpoint
ALTER TABLE application_notes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON application_notes
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid OR (current_setting('app.platform', true) = 'on' AND current_user <> 'app_tenant'))
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid OR (current_setting('app.platform', true) = 'on' AND current_user <> 'app_tenant'));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON application_notes TO app_tenant, ros_app, ros_worker;
--> statement-breakpoint
-- A note is removed (deleted_at) or emptied by a privacy deletion, never deleted.
REVOKE DELETE ON application_notes FROM app_tenant, ros_app, ros_worker;
--> statement-breakpoint
-- "Offer made" (founder decision Q29; plan H2): a person records that an offer was made outside the app. The offers
-- row carries no terms (terms stays '{}'); made_outside marks such a record, made_on is the day the person gave.
ALTER TABLE offers ADD COLUMN IF NOT EXISTS made_outside boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE offers ADD COLUMN IF NOT EXISTS made_on date;
