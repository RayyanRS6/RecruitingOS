-- Every stored row in a state the code knows today.
--
-- The product was simplified: nine stages, four job statuses, three team roles, one platform role, one company gate, two
-- workflows and one AI interview engine. This migration moves the rows that still say something else. After it nobody
-- who can use the app is locked out and nobody has access they did not have. It deletes no row of any table but the
-- queue; migration 0041 drops the storage of the removed features. Apart from one new column it changes data only.
--
-- 1. screens.packet_version (new, nullable): the job version an AI interview asks about, kept to its end. Rows that
--    exist get the version their application was sent against, which is the one they asked about.
-- 2. AI interviews. Statuses that are gone: abandoned, unfinished and paused (closed without the answers) become
--    expired; human_requested (they asked for a person instead) becomes declined_by_candidate; anything else unknown
--    becomes cancelled. An interview still open that today's chat cannot carry on is closed as expired, so the team
--    can send a new link: one by text message, or one begun before the chat had its plan (screens.progress.chat).
-- 3. Stages. Everything between the AI interview and hiring (interview_recommended, interview_scheduled,
--    interview_complete, debrief, finalist, reference_check, offer_draft, offer_approval, offer_sent, negotiation,
--    accepted, onboarding) becomes screen_complete when the person sent an AI interview, otherwise triaged.
--    ineligible and eligible become triaged. talent_pool becomes rejected, with the time of that move as its
--    rejected_at. declined (the candidate declined an offer) becomes withdrawn. No event is written for any of these:
--    the history keeps the moves as they happened, under their old names.
-- 4. An AI interview is open only for someone Shortlisted (screen_invited, screening) whose job is not closed. One left
--    open elsewhere is cancelled, the status the code gives an interview a person cancels or a closing job closes: its
--    link reads as closed. Nobody is moved by it.
-- 5. Emails that waited and must never go are cancelled, each recorded as message.cancelled: one held for the company
--    check (a status that is gone), one queued for a template today's code does not write (among them every decision
--    email of the old wordings, disposition:<wording>), and one queued for a text message.
-- 6. Told states. told_in_person and before_tracking become sent. Someone still in the process was told no decision
--    (not_told). A decision whose email no longer waits is not_told again, so the team can press "Email the decision".
-- 7. Job statuses. pending_approval becomes draft (nobody approves a job); filled becomes closed; any other unknown
--    status becomes closed.
-- 8. Team roles. recruiter was the access of ITS staff to a customer's company: such a membership is ended the way the
--    code ends one (removed, recorded as member.removed and membership.changed, audited, and the person's sessions in
--    that company ended). hr, interviewer and any other unknown role become hiring_manager ("Member"), on memberships
--    and on invitations. A membership still "invited" (a status unused since invitations became rows) is removed.
-- 9. The platform role its_recruiter. Its grants are ended the way the code ends a grant: the ledger row is marked
--    revoked with who and why (the ledger is never deleted from), the cached role on the user is cleared, and it is
--    audited as platform_role.revoked. No alert is raised for a role that no longer exists.
-- 10. The one company gate. A company whose people can work today (an active membership) and that has no
--    settings.verifiedAt is made live, from the best stored date: the time an administrator last accepted it
--    (company.access_accepted), else when its first active member joined, else when the company was created. A company
--    that is waiting or declined has no active member and stays as it is.
-- 11. Company settings: the keys nothing reads are removed (verifiedBy, applyFlowDefault, applyFlowSetBy,
--    candidateScoreShown, candidateScoreSetBy, newTimesAfterCancel, zipRecruiterPlan, boardPosting, onboarding,
--    businessHours, brief, retention).
-- 12. Workflow runs still going. An application_intake run of the old definition starts again at "receive", which
--    skips whatever is already done and reads anyone not read yet. A screen run of the old definition goes on at the
--    step of today's that fits its interview (invite, remind, close or score). Every other run still going (a removed
--    workflow, or an old screen run with nothing left to do) is cancelled the way the engine cancels one, with its
--    workflow.cancelled event.
-- 13. Queued jobs of a kind no handler runs today are deleted (posting.verify, publishing.backfill,
--    interview.cancel_events, email.fallback_sms, integration.revoke_and_delete and any other).
-- 14. An AI run of the chat a repeat application had before its address was confirmed named only that conversation
--    (input_ref.unconfirmedScreenId), whose table goes in 0041. Each gets its application's id beside it, so a deletion
--    request still finds the run and removes the person's words from it. Nothing else of an AI run is changed.
--
-- The release: the build before this one still writes the old states, so its app and worker are stopped before this
-- migration runs (docs/runbooks/production-setup.md, "The release").

ALTER TABLE screens ADD COLUMN IF NOT EXISTS packet_version integer;
--> statement-breakpoint
UPDATE screens s SET packet_version = a.packet_version FROM applications a WHERE a.id = s.application_id AND s.packet_version IS NULL;
--> statement-breakpoint
UPDATE screens SET status = 'expired', completed_at = COALESCE(completed_at, updated_at) WHERE status IN ('abandoned', 'unfinished', 'paused');
--> statement-breakpoint
UPDATE screens SET status = 'declined_by_candidate', completed_at = COALESCE(completed_at, human_requested_at, updated_at) WHERE status = 'human_requested';
--> statement-breakpoint
UPDATE screens SET status = 'cancelled', completed_at = COALESCE(completed_at, updated_at)
  WHERE status NOT IN ('invited', 'reminded', 'in_progress', 'completed', 'expired', 'declined_by_candidate', 'cancelled');
--> statement-breakpoint
UPDATE screens SET status = 'expired', completed_at = COALESCE(completed_at, now())
  WHERE status IN ('invited', 'reminded', 'in_progress')
    AND (channel <> 'web' OR (NOT (progress ? 'chat') AND (status = 'in_progress' OR transcript @> '[{"role":"assistant"}]'::jsonb)));
--> statement-breakpoint
UPDATE applications a
  SET stage = CASE WHEN EXISTS (SELECT 1 FROM screens s WHERE s.application_id = a.id AND s.status = 'completed') THEN 'screen_complete' ELSE 'triaged' END
  WHERE a.stage IN ('interview_recommended', 'interview_scheduled', 'interview_complete', 'debrief', 'finalist', 'reference_check', 'offer_draft', 'offer_approval', 'offer_sent', 'negotiation', 'accepted', 'onboarding');
--> statement-breakpoint
UPDATE applications SET stage = 'triaged' WHERE stage IN ('ineligible', 'eligible');
--> statement-breakpoint
UPDATE applications SET stage = 'rejected', rejected_at = COALESCE(rejected_at, stage_changed_at) WHERE stage = 'talent_pool';
--> statement-breakpoint
UPDATE applications SET stage = 'withdrawn' WHERE stage = 'declined';
--> statement-breakpoint
UPDATE roles SET status = 'draft' WHERE status = 'pending_approval';
--> statement-breakpoint
UPDATE roles SET status = 'closed', closed_at = COALESCE(closed_at, updated_at) WHERE status NOT IN ('draft', 'open', 'paused', 'closed');
--> statement-breakpoint
UPDATE screens s SET status = 'cancelled', completed_at = COALESCE(s.completed_at, now())
  FROM applications a JOIN roles r ON r.id = a.role_id
  WHERE a.id = s.application_id AND s.status IN ('invited', 'reminded', 'in_progress')
    AND (a.stage NOT IN ('screen_invited', 'screening') OR r.status = 'closed');
--> statement-breakpoint
WITH stopped AS (
  UPDATE communications SET status = 'cancelled', error = 'written before the simple product and never sent'
  WHERE direction = 'outbound'
    AND (status = 'held' OR (status = 'queued' AND (channel <> 'email' OR COALESCE(template_key, '') NOT IN (
      'acknowledgment', 'disposition', 'screen_invite', 'screen_reminder', 'screen_expired', 'close_out', 'status_link_new', 'status_link_repeat',
      'status_link_request', 'invite', 'notification_alert', 'privacy_ack', 'privacy_done', 'retry'))))
  RETURNING id, company_id, template_key, channel, application_id
)
INSERT INTO events (company_id, type, actor, subject_type, subject_id, payload)
SELECT company_id, 'message.cancelled', '{"kind":"system","id":"migration_0040","name":"The simple product"}'::jsonb, 'communication', id::text,
  jsonb_build_object('template', template_key, 'channel', channel, 'applicationId', application_id, 'reason', 'written before the simple product and never sent')
FROM stopped;
--> statement-breakpoint
UPDATE applications SET told_state = 'sent' WHERE told_state IN ('told_in_person', 'before_tracking');
--> statement-breakpoint
UPDATE applications SET told_state = 'not_told', candidate_told_at = NULL
  WHERE stage IN ('applied', 'received', 'triaged', 'screen_invited', 'screening', 'screen_complete') AND (told_state <> 'not_told' OR candidate_told_at IS NOT NULL);
--> statement-breakpoint
UPDATE applications a SET told_state = 'not_told'
  WHERE a.told_state = 'queued'
    AND NOT EXISTS (SELECT 1 FROM communications c WHERE c.application_id = a.id AND c.template_key = 'disposition' AND c.status IN ('queued', 'sending'));
--> statement-breakpoint
UPDATE sessions s SET revoked_at = now()
  WHERE s.revoked_at IS NULL
    AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = s.user_id AND m.role = 'recruiter' AND m.status NOT IN ('removed', 'declined') AND (s.active_company_id IS NULL OR s.active_company_id = m.company_id));
--> statement-breakpoint
WITH ended AS (
  UPDATE memberships SET status = 'removed', updated_at = now()
  WHERE role = 'recruiter' AND status NOT IN ('removed', 'declined')
  RETURNING company_id, user_id
), removed AS (
  INSERT INTO events (company_id, type, actor, subject_type, subject_id, payload)
  SELECT company_id, 'member.removed', '{"kind":"system","id":"migration_0040","name":"The simple product"}'::jsonb, 'user', user_id::text, jsonb_build_object('role', 'recruiter')
  FROM ended
), changed AS (
  INSERT INTO events (company_id, type, actor, subject_type, subject_id, payload)
  SELECT company_id, 'membership.changed', '{"kind":"system","id":"migration_0040","name":"The simple product"}'::jsonb, 'user', user_id::text, jsonb_build_object('role', 'recruiter', 'status', 'removed')
  FROM ended
)
INSERT INTO audit_records (id, company_id, actor, action, target, reason, details)
SELECT gen_random_uuid(), company_id, '{"kind":"system","id":"migration_0040","name":"The simple product"}'::jsonb, 'membership.changed', jsonb_build_object('type', 'user', 'id', user_id),
  'removed from the team: the recruiter role was ITS staff working in a customer''s company, which no longer exists', jsonb_build_object('role', 'recruiter')
FROM ended;
--> statement-breakpoint
UPDATE memberships SET role = 'hiring_manager', updated_at = now() WHERE role NOT IN ('owner', 'admin', 'hiring_manager');
--> statement-breakpoint
UPDATE memberships SET status = 'removed', updated_at = now() WHERE status NOT IN ('active', 'removed', 'requested', 'declined');
--> statement-breakpoint
UPDATE invitations SET role = 'hiring_manager', updated_at = now() WHERE role NOT IN ('owner', 'admin', 'hiring_manager');
--> statement-breakpoint
WITH revoked AS (
  UPDATE platform_role_grants
  SET revoked_at = now(), revoked_by = '{"kind":"system","id":"migration_0040","name":"The simple product"}'::jsonb, revoke_reason = 'the ITS recruiter role no longer exists'
  WHERE role <> 'platform_admin' AND revoked_at IS NULL
  RETURNING id, user_id, role
)
INSERT INTO audit_records (id, company_id, actor, action, target, reason, details)
SELECT gen_random_uuid(), NULL, '{"kind":"system","id":"migration_0040","name":"The simple product"}'::jsonb, 'platform_role.revoked', jsonb_build_object('type', 'user', 'id', r.user_id),
  'the ITS recruiter role no longer exists', jsonb_build_object('grantId', r.id, 'role', r.role, 'granteeEmail', u.email)
FROM revoked r JOIN users u ON u.id = r.user_id;
--> statement-breakpoint
UPDATE users SET platform_role = 'none', updated_at = now() WHERE platform_role NOT IN ('none', 'platform_admin');
--> statement-breakpoint
UPDATE companies c
  SET settings = COALESCE(c.settings, '{}'::jsonb) || jsonb_build_object('verifiedAt', to_char(COALESCE(
    (SELECT max(e.occurred_at) FROM events e WHERE e.company_id = c.id AND e.type = 'company.access_accepted'),
    (SELECT min(m.created_at) FROM memberships m WHERE m.company_id = c.id AND m.status = 'active'),
    c.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  WHERE COALESCE(c.settings->>'verifiedAt', '') = ''
    AND EXISTS (SELECT 1 FROM memberships m WHERE m.company_id = c.id AND m.status = 'active');
--> statement-breakpoint
UPDATE companies
  SET settings = settings - ARRAY['verifiedBy', 'applyFlowDefault', 'applyFlowSetBy', 'candidateScoreShown', 'candidateScoreSetBy', 'newTimesAfterCancel', 'zipRecruiterPlan', 'boardPosting', 'onboarding', 'businessHours', 'brief', 'retention']
  WHERE settings ?| ARRAY['verifiedBy', 'applyFlowDefault', 'applyFlowSetBy', 'candidateScoreShown', 'candidateScoreSetBy', 'newTimesAfterCancel', 'zipRecruiterPlan', 'boardPosting', 'onboarding', 'businessHours', 'brief', 'retention'];
--> statement-breakpoint
WITH restarted AS (
  UPDATE workflow_runs
  SET workflow_version = 2, status = 'running', current_step = 'receive', wait = NULL, attempts = 0, last_error = NULL, updated_at = now()
  WHERE workflow_key = 'application_intake' AND workflow_version < 2 AND status NOT IN ('completed', 'failed', 'cancelled')
  RETURNING id
)
INSERT INTO jobs (kind, payload, run_at) SELECT 'workflow.tick', jsonb_build_object('runId', id), now() FROM restarted;
--> statement-breakpoint
WITH old AS (
  SELECT r.id, s.id AS screen_id, s.status AS screen_status, s.reminded_at, s.expires_at
  FROM workflow_runs r LEFT JOIN screens s ON s.id::text = r.state->>'screenId'
  WHERE r.workflow_key = 'screen' AND r.workflow_version < 2 AND r.status NOT IN ('completed', 'failed', 'cancelled')
), moved AS (
  UPDATE workflow_runs r
  SET workflow_version = 2, status = 'running', wait = NULL, attempts = 0, last_error = NULL, updated_at = now(),
    current_step = CASE
      WHEN o.screen_id IS NULL THEN 'invite'
      WHEN o.screen_status = 'completed' THEN 'score'
      WHEN o.reminded_at IS NULL AND (o.expires_at IS NULL OR o.expires_at > now()) THEN 'remind'
      ELSE 'close' END
  FROM old o
  WHERE r.id = o.id AND (o.screen_id IS NULL OR o.screen_status IN ('completed', 'invited', 'reminded', 'in_progress'))
  RETURNING r.id
)
INSERT INTO jobs (kind, payload, run_at) SELECT 'workflow.tick', jsonb_build_object('runId', id), now() FROM moved;
--> statement-breakpoint
WITH cancelled AS (
  UPDATE workflow_runs
  SET status = 'cancelled', wait = NULL, last_error = 'this workflow is not part of the simple product', updated_at = now()
  WHERE status NOT IN ('completed', 'failed', 'cancelled')
    AND (workflow_key NOT IN ('application_intake', 'screen', 'role_closing_date') OR (workflow_key = 'screen' AND workflow_version < 2))
  RETURNING id, company_id
)
INSERT INTO events (company_id, type, actor, subject_type, subject_id, correlation_id, payload)
SELECT company_id, 'workflow.cancelled', '{"kind":"system","id":"migration_0040","name":"The simple product"}'::jsonb, 'workflow_run', id::text, id::text,
  jsonb_build_object('reason', 'this workflow is not part of the simple product')
FROM cancelled;
--> statement-breakpoint
DELETE FROM jobs
  WHERE status = 'queued' AND kind NOT IN (
    'workflow.tick', 'workflow.ai_hold_check', 'notification.email', 'document.discard_object', 'privacy.deadline_check', 'candidates.close_out_notes',
    'maintenance.daily', 'ops.health_check', 'alert.email', 'communication.send', 'candidate.link_request', 'email.retry', 'job.write_posts');
--> statement-breakpoint
UPDATE ai_runs r SET input_ref = r.input_ref || jsonb_build_object('applicationId', u.application_id)
  FROM unconfirmed_screens u
  WHERE NOT (r.input_ref ? 'applicationId') AND (r.input_ref->>'unconfirmedScreenId' = u.id::text OR r.input_ref->>'screenId' = u.id::text);
