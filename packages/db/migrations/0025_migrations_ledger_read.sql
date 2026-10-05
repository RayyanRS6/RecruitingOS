-- The production boot compares the database with the migration files and refuses to start while one is pending
-- (docs/14-deployment-and-environment.md, docs/runbooks/release-migrations.md). That check runs as the process's own
-- role, so both application roles may read the ledger's file names. Writing it stays the owner's alone (0003 revoked
-- everything; this gives back reading only): applying migrations is still not the application's business.
GRANT SELECT ON _migrations TO ros_app, ros_worker;
