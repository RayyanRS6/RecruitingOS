-- The two posts on a job's Share tab: one for LinkedIn and one for Indeed.
--
-- roles.posts: what the AI stage job.posts wrote for a published job and where that writing stands, as one JSON value
-- (RolePosts in packages/contracts): { linkedin, indeed, state, version }, each post { text, edited, writtenAt }. A post
-- a person edited is never replaced by an automatic rewrite. NULL on a job never published. Additive, with no default
-- and no backfill: a job published before this column has no posts until someone presses "Write again" on its Share tab.
--
-- roles already has row-level security, its tenant policy and its grants (0001, 0020); nothing changes there.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS posts jsonb;
