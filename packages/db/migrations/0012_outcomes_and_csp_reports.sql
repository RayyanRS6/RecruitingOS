-- Human-recorded hiring outcomes (founder instruction of 21 September 2026, item 4) and content-security-policy
-- violation reports (item 6). Outcomes are records of decisions made by people, often outside the platform; nothing
-- here generates, approves or transmits an offer, and no payroll, tax, identity or banking field exists.

ALTER TABLE hiring_outcomes ALTER COLUMN application_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE hiring_outcomes ADD COLUMN IF NOT EXISTS role_id uuid;
--> statement-breakpoint
ALTER TABLE hiring_outcomes ADD COLUMN IF NOT EXISTS hire_date date;
--> statement-breakpoint
ALTER TABLE hiring_outcomes ADD COLUMN IF NOT EXISTS offer_accepted_at date;
--> statement-breakpoint
ALTER TABLE hiring_outcomes ADD COLUMN IF NOT EXISTS details jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE hiring_outcomes ADD COLUMN IF NOT EXISTS correction_of uuid;
--> statement-breakpoint
ALTER TABLE hiring_outcomes ADD COLUMN IF NOT EXISTS corrected_at timestamptz;
--> statement-breakpoint
ALTER TABLE hiring_outcomes ADD COLUMN IF NOT EXISTS corrected_by jsonb;
--> statement-breakpoint
ALTER TABLE hiring_outcomes ADD COLUMN IF NOT EXISTS correction_reason text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS hiring_outcomes_role_idx ON hiring_outcomes (role_id);
--> statement-breakpoint
-- Outcome rows are facts about decisions: never deleted, only corrected by a later audited row.
REVOKE DELETE ON hiring_outcomes FROM app_tenant, ros_app, ros_worker;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS csp_reports (
  id uuid PRIMARY KEY,
  mode text NOT NULL,
  surface text NOT NULL,
  document_path text NOT NULL,
  violated_directive text NOT NULL,
  effective_directive text,
  blocked_origin text,
  source_file text,
  line_number integer,
  user_agent text,
  count integer NOT NULL DEFAULT 1,
  first_at timestamptz NOT NULL DEFAULT now(),
  last_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid,
  disposition text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS csp_reports_dedupe_idx ON csp_reports (surface, document_path, violated_directive, blocked_origin, source_file);
--> statement-breakpoint
REVOKE ALL ON csp_reports FROM app_tenant;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON csp_reports TO ros_app, ros_worker;
