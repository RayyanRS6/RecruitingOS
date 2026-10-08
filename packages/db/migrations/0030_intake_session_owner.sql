-- The job builder (plan Wave C, items C3 and C7). A draft belongs to the person who started it (founder decision Q6):
-- the drafts list, "continue", and the owner's or admin's take-over all ask who that is, so it is a column with an
-- index instead of a lookup inside the created_by actor. Rows written before this migration take it from created_by
-- when that actor is a user or an ITS recruiter with a well-formed id; anything else stays null and is treated as
-- nobody's own draft (owners and admins still see it).
--
-- server_state holds what the server decides about a draft and never the model: the pay a person set or confirmed,
-- the last market figure, the open question cards, where a pasted job ad sits in the transcript, the values a person
-- removed, and the drafting progress (IntakeServerState in packages/contracts/src/domain/intake.ts).
--
-- intake_sessions already has row-level security, its tenant policy and its grants (0001); nothing changes there.
ALTER TABLE intake_sessions ADD COLUMN IF NOT EXISTS created_by_user_id uuid;
--> statement-breakpoint
ALTER TABLE intake_sessions ADD COLUMN IF NOT EXISTS server_state jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
UPDATE intake_sessions
  SET created_by_user_id = (created_by->>'id')::uuid
  WHERE created_by_user_id IS NULL
    AND created_by->>'kind' IN ('user', 'recruiter')
    AND created_by->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS intake_sessions_owner_idx ON intake_sessions (company_id, created_by_user_id, status);
