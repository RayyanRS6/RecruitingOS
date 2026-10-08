-- Email alerts and notification preferences (plan B3). Every update still lands in the app for the person it is for;
-- these rows choose, per person and per group of updates, whether they also hear about it by email: as it happens
-- (immediate), in a summary each morning (daily) or each Monday morning (weekly), or not at all (off). A group with no
-- row uses the product's default for it (packages/core/src/notify-groups.ts), so nobody has to set anything up. A few
-- updates are always emailed at once whatever is chosen here (an ITS recruiter was given access, a candidate asked
-- for a person, someone waits on an eligibility decision); the code holds that list, not this table. The column is
-- group_key, not "group", because GROUP is a reserved word in SQL.
--
-- No alert email names a candidate or carries their details: the role's name and a link only.
CREATE TABLE IF NOT EXISTS notification_preferences (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  user_id uuid NOT NULL REFERENCES users(id),
  group_key text NOT NULL,
  cadence text NOT NULL,
  set_by jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- One setting per person, company and group; a change updates it in place.
CREATE UNIQUE INDEX IF NOT EXISTS notification_preferences_person_group_idx ON notification_preferences (company_id, user_id, group_key);
--> statement-breakpoint
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON notification_preferences
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid OR (current_setting('app.platform', true) = 'on' AND current_user <> 'app_tenant'))
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid OR (current_setting('app.platform', true) = 'on' AND current_user <> 'app_tenant'));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON notification_preferences TO app_tenant, ros_app, ros_worker;
--> statement-breakpoint
-- A setting is changed, never deleted: "back to the default" writes the default.
REVOKE DELETE ON notification_preferences FROM app_tenant, ros_app, ros_worker;
--> statement-breakpoint
-- When an update went out by email, at once or in a summary; a summary takes only updates not emailed yet, so nothing is
-- emailed twice. Updates written before this migration were never emailed and stay that way: the first summaries
-- cover only what arrives from now on (see the backfill below).
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS emailed_at timestamptz;
--> statement-breakpoint
-- Updates that existed before email alerts are treated as already handled, so the first summary is not a backlog of
-- everything that ever happened.
UPDATE notifications SET emailed_at = created_at WHERE emailed_at IS NULL;
--> statement-breakpoint
-- The full history of one person's updates, newest first, page by page.
CREATE INDEX IF NOT EXISTS notifications_person_history_idx ON notifications (company_id, user_id, created_at DESC, id DESC);
--> statement-breakpoint
-- What the next summary may include: not emailed yet and not read yet.
CREATE INDEX IF NOT EXISTS notifications_digest_idx ON notifications (company_id, user_id, created_at) WHERE emailed_at IS NULL AND read_at IS NULL;
