-- Slice 5 step 1 (correction 11, 18 September 2026): the recruiter queue shows only a generic preview before acceptance.
-- Slice 5 step 2 (correction 12): an editable, versioned ITS business calendar replaces the hard-coded holiday list.

ALTER TABLE recruiter_escalations ADD COLUMN IF NOT EXISTS urgency text NOT NULL DEFAULT 'normal';
--> statement-breakpoint
ALTER TABLE recruiter_escalations ADD COLUMN IF NOT EXISTS required_expertise text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE recruiter_escalations ADD COLUMN IF NOT EXISTS summary text NOT NULL DEFAULT '';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS business_calendar_versions (
  id uuid PRIMARY KEY,
  calendar_key text NOT NULL DEFAULT 'its',
  version integer NOT NULL,
  effective_from date NOT NULL,
  time_zone text NOT NULL,
  hours jsonb NOT NULL,
  holidays jsonb NOT NULL DEFAULT '[]'::jsonb,
  closures jsonb NOT NULL DEFAULT '[]'::jsonb,
  coverage_changes jsonb NOT NULL DEFAULT '[]'::jsonb,
  note text NOT NULL DEFAULT '',
  created_by jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS business_calendar_versions_key_version_idx ON business_calendar_versions (calendar_key, version);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS business_calendar_versions_effective_idx ON business_calendar_versions (calendar_key, effective_from);
--> statement-breakpoint
-- Everyone may read the calendar (SLA clocks run inside tenant transactions); only the platform roles write it, and only through the audited admin route.
GRANT SELECT ON business_calendar_versions TO app_tenant;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON business_calendar_versions FROM app_tenant;
--> statement-breakpoint
GRANT SELECT, INSERT ON business_calendar_versions TO ros_app, ros_worker;
--> statement-breakpoint
-- Versions are immutable: corrections are new versions.
REVOKE UPDATE, DELETE ON business_calendar_versions FROM ros_app, ros_worker;
