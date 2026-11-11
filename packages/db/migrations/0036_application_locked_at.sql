-- Locked candidates (the plans of 5 November 2026, Rule 2).
--
-- applications.locked_at: set once, when the application is created, on a job already past its plan's candidates_per_job.
-- NULL means visible. Additive, with no default and no backfill: every application that exists today stays visible, and
-- a default would lock everyone who applies. Nothing writes it yet.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS locked_at timestamptz;
