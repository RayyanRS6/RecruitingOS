-- Tenant isolation tightening found by the migration validator (21 September 2026, item 7).
-- Tenant transactions enqueue work (INSERT) but never need to read the job queue; a job payload may belong to another
-- customer. Only the worker role claims, updates, deletes or reads jobs (migration 0003).

REVOKE SELECT, UPDATE, DELETE ON jobs FROM app_tenant;
--> statement-breakpoint
GRANT INSERT ON jobs TO app_tenant;
