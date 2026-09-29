-- Worker health (audit remediation H1 and H15, September 2026). The queue worker writes one row here on every poll:
-- when it last looked at the queue, how many jobs were waiting and how old the oldest one was. The worker's own
-- /healthz answers from its memory; the app's /healthz and the daily maintenance check read this table, so a worker
-- that stopped polling is visible from the app and raises an alert. Nothing here is candidate data.

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_id text PRIMARY KEY,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_poll_at timestamptz,
  queue_depth integer NOT NULL DEFAULT 0,
  oldest_queued_at timestamptz,
  version text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Platform table (no company id, no row policy), like admin_alerts in 0006: the tenant role has no access; the API
-- role only reads it (the app's /healthz) and the worker role writes it on every poll and sweeps the rows of workers
-- not seen for a week (the maintenance job runs on the worker). 0003's default privileges would hand the API role all
-- four rights on a new table, so its write rights are revoked here rather than merely not granted.
REVOKE ALL ON worker_heartbeats FROM app_tenant;
--> statement-breakpoint
GRANT SELECT ON worker_heartbeats TO ros_app;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON worker_heartbeats FROM ros_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON worker_heartbeats TO ros_worker;
