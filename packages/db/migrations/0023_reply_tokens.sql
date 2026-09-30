-- Candidate replies come back to the product (docs/spec/21 F12; docs/runbooks/candidate-replies.md). When the inbound
-- mail domain is configured, every email a candidate receives carries a per-application Reply-To address,
-- reply-<token>@<intake domain>, and the Postmark inbound webhook records the reply on the application and tells the
-- team. The token is random, lowercase (mail servers may lowercase an address) and belongs to the application only: it
-- is never the status token, so an address seen in a mail header cannot open the candidate's status page.
--
-- Rows that exist already get a token here, so the team can write to those candidates from the sheet as well; new
-- rows get theirs from the application code at creation. The default stays so that a direct insert always has one.
-- It draws from gen_random_uuid(), a cryptographic source (random() is not), and keeps the first sixteen hex digits.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS reply_token text NOT NULL DEFAULT substr(replace(gen_random_uuid()::text, '-', ''), 1, 16);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS applications_reply_token_idx ON applications (reply_token);
