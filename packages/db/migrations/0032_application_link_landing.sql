-- Where a tracked application link lands (plan Wave D, item D8). A link someone shares (a referral, a school, a
-- community group, a message, a social post) opens the job page first, so the person reads the job before the form;
-- a job board's link goes straight to the apply form, because the board already showed the job. Existing board links
-- (the ones with a posting) keep going to the form; every other existing link now opens the job page.
ALTER TABLE application_links ADD COLUMN IF NOT EXISTS landing text NOT NULL DEFAULT 'job';
--> statement-breakpoint
UPDATE application_links SET landing = 'apply' WHERE posting_id IS NOT NULL;
