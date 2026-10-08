-- Approving and publishing a role (plan Wave D, items D3, D4, D6 and D7; founder decisions Q10, Q11 and Q12).
--
-- roles.publish_channels: the job boards a person ticked for the role (linkedin_basic, indeed, ziprecruiter). Null
-- means nobody chose yet, and the publish workflow uses the default: the boards the role plan names
-- (packet.sourcing.channels), with ZipRecruiter only for a company with its own ZipRecruiter plan. The careers page,
-- Google and applications by email are never in the list: every open role has them.
--
-- roles.applications_close_on: the last day new applications are taken, in the company's own time zone. At the end of
-- that day applications stop (the accepting switch, reason "closing date"); nobody is rejected, people part-way through
-- may finish, and closing the role stays a person's decision. Colorado roles get a default date at opening.
--
-- postings.board_version: the packet version a job board listing was posted with, so the role page can say which
-- boards still show an older version after an approved edit (item D4). Null for listings posted before this column.
--
-- recruiter_escalations.posting_id: the posting an ITS posting task is about (post_job, update_job, take_down_job;
-- item D3). Null for every other request.
--
-- Every table here already has row-level security, its tenant policy and its grants (0001, 0020); nothing changes there.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS publish_channels text[];
--> statement-breakpoint
ALTER TABLE roles ADD COLUMN IF NOT EXISTS applications_close_on date;
--> statement-breakpoint
ALTER TABLE postings ADD COLUMN IF NOT EXISTS board_version integer;
--> statement-breakpoint
ALTER TABLE recruiter_escalations ADD COLUMN IF NOT EXISTS posting_id uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS recruiter_escalations_posting_idx ON recruiter_escalations (posting_id) WHERE posting_id IS NOT NULL;
