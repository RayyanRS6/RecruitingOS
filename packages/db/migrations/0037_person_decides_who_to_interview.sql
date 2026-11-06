-- A person decides who to interview (the owner, 6 November 2026): "application.recommend_interview" now defaults to "Only
-- a person", so the assistant moves nobody after the AI interview unless the company chose it. This puts back the people it
-- moved under the old default, so they read New and can be shortlisted. Data only; it sends nothing and tells nobody.
-- Only someone at "Interview to set up" whose last move there was the assistant's, who has never had an interview and has no
-- open follow-up, at a company whose rule for this job does not still say "Do it" or "Do it and tell me": a company that chose
-- that keeps it. Someone a person moved there stays. stage_changed_at stays too, so nobody's waiting time starts again.
-- Each person moved is recorded once in their history (as 0035 records its changes).
WITH moved AS (
  UPDATE applications a SET stage = 'screen_complete'
  WHERE a.stage = 'interview_recommended'
    AND NOT EXISTS (SELECT 1 FROM interviews i WHERE i.application_id = a.id)
    AND NOT EXISTS (SELECT 1 FROM interview_followups f WHERE f.application_id = a.id AND f.resolved_at IS NULL)
    AND (SELECT e.actor->>'id' FROM events e
         WHERE e.subject_type = 'application' AND e.subject_id = a.id::text
           AND e.type = 'application.stage_changed' AND e.payload->>'to' = 'interview_recommended'
         ORDER BY e.id DESC LIMIT 1) = 'workflow:screen'
    AND COALESCE(
      (SELECT p.level FROM policies p WHERE p.company_id = a.company_id AND p.role_id = a.role_id AND p.action_type = 'application.recommend_interview' LIMIT 1),
      (SELECT p.level FROM policies p WHERE p.company_id = a.company_id AND p.role_id IS NULL AND p.action_type = 'application.recommend_interview' LIMIT 1),
      'human_only'
    ) NOT IN ('auto', 'auto_notify')
  RETURNING a.id, a.company_id
)
INSERT INTO events (company_id, type, actor, subject_type, subject_id, payload)
SELECT company_id, 'application.stage_changed', '{"kind":"system","id":"migration_0037","name":"A person decides who to interview"}'::jsonb, 'application', id::text,
  jsonb_build_object('from', 'interview_recommended', 'to', 'screen_complete', 'reason', 'A person decides who to interview', 'backfill', true)
FROM moved;
