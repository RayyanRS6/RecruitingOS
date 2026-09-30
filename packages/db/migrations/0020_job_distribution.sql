-- Job distribution (docs/spec/20, founder scope amendment of 22 September 2026). A posting moves through nine states
-- (draft, approved, ready_to_post, posted_manually, submitted_integration, live_verified, paused, failed, closed) and
-- is never called live until its public URL was fetched and matched, or a person said they checked it. Every board
-- gets its own tracked application link; the token never appears in a candidate-facing record. Closing a role marks
-- the boards that still need taking down by hand. Nothing here rejects a candidate.

ALTER TABLE postings ADD COLUMN IF NOT EXISTS public_url_recorded_at timestamptz;
--> statement-breakpoint
ALTER TABLE postings ADD COLUMN IF NOT EXISTS verified_at timestamptz;
--> statement-breakpoint
ALTER TABLE postings ADD COLUMN IF NOT EXISTS verified_by jsonb;
--> statement-breakpoint
ALTER TABLE postings ADD COLUMN IF NOT EXISTS verification_note text;
--> statement-breakpoint
ALTER TABLE postings ADD COLUMN IF NOT EXISTS verification_error text;
--> statement-breakpoint
ALTER TABLE postings ADD COLUMN IF NOT EXISTS verification_attempts integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE postings ADD COLUMN IF NOT EXISTS paused_at timestamptz;
--> statement-breakpoint
ALTER TABLE postings ADD COLUMN IF NOT EXISTS closed_at timestamptz;
--> statement-breakpoint
ALTER TABLE postings ADD COLUMN IF NOT EXISTS closure_required boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE postings ADD COLUMN IF NOT EXISTS closure_confirmed_at timestamptz;
--> statement-breakpoint
ALTER TABLE postings ADD COLUMN IF NOT EXISTS closure_confirmed_by jsonb;
--> statement-breakpoint
ALTER TABLE postings ADD COLUMN IF NOT EXISTS steps jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
-- The five earlier channel states become the nine posting states. A row that was "pending" or "manual action
-- required" is ready to post; "awaiting verification" was Google for Jobs, submitted through the page's structured
-- data; "not connected" was email-in without an inbound domain, which is a failed channel with its error kept.
UPDATE postings SET status = 'ready_to_post' WHERE status IN ('pending', 'manual_action_required');
--> statement-breakpoint
UPDATE postings SET status = 'submitted_integration' WHERE status = 'awaiting_verification';
--> statement-breakpoint
UPDATE postings SET status = 'failed' WHERE status = 'not_connected';
--> statement-breakpoint
ALTER TABLE postings ALTER COLUMN status SET DEFAULT 'draft';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS postings_company_status_idx ON postings (company_id, status);
--> statement-breakpoint
-- Where an application came from, in the source vocabulary (careers_page, email_in, linkedin, indeed, ziprecruiter,
-- referral, direct, other) plus a detail (a referrer's name, a campaign label) and the tracked link that brought it.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS source_detail text;
--> statement-breakpoint
ALTER TABLE applications ADD COLUMN IF NOT EXISTS link_id uuid;
--> statement-breakpoint
-- Tracked application links: one short random token per board (and per referral, direct or other link a person
-- creates). The public redirect resolves the token through the platform role, counts the visit and sets a sealed
-- cookie; the token itself is never written to an application, a candidate, a message or the status page.
CREATE TABLE IF NOT EXISTS application_links (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  role_id uuid NOT NULL REFERENCES roles(id),
  posting_id uuid,
  token text NOT NULL,
  source text NOT NULL,
  source_detail text,
  label text NOT NULL,
  visits integer NOT NULL DEFAULT 0,
  last_visited_at timestamptz,
  created_by jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS application_links_token_idx ON application_links (token);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS application_links_company_role_idx ON application_links (company_id, role_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS application_links_posting_idx ON application_links (posting_id);
--> statement-breakpoint
ALTER TABLE application_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON application_links
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid OR (current_setting('app.platform', true) = 'on' AND current_user <> 'app_tenant'))
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid OR (current_setting('app.platform', true) = 'on' AND current_user <> 'app_tenant'));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON application_links TO app_tenant, ros_app, ros_worker;
--> statement-breakpoint
-- A link is disabled, never deleted: the applications that came through it keep pointing at it.
REVOKE DELETE ON application_links FROM app_tenant, ros_app, ros_worker;
--> statement-breakpoint
-- The "accepting applications" switch is distinct from pausing the role: the job page stays up and says applications
-- are closed, new submissions are refused with no candidate rejected. The volume alert threshold is per role
-- (null means the default of 100 applications a day).
ALTER TABLE roles ADD COLUMN IF NOT EXISTS accepting_applications boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE roles ADD COLUMN IF NOT EXISTS applications_closed_at timestamptz;
--> statement-breakpoint
ALTER TABLE roles ADD COLUMN IF NOT EXISTS applications_closed_reason text;
--> statement-breakpoint
ALTER TABLE roles ADD COLUMN IF NOT EXISTS volume_alert_per_day integer;
