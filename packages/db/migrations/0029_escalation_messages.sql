-- The conversation on a recruiter request (plan items B4 and B5). Until now a request held one question and one
-- answer (recruiter_escalations.question and .resolution), and the answer reached the team only as a short notice. A
-- request now keeps a thread: a note from the team while a recruiter works on it, the recruiter's replies, every answer
-- given when it was resolved, and the note a person writes when they say "this didn't solve it" and reopen it.
--
-- side: 'customer' (someone at the company) or 'recruiter' (the ITS recruiter holding the request). kind: 'reply' (a
-- note in either direction), 'answer' (what the recruiter wrote when resolving it; .resolution keeps the latest), or
-- 'reopen' (why the team reopened it). Text, not an enum, like every other kind column. Rows are never deleted; a
-- privacy deletion rewrites the words that name the candidate instead (packages/core/src/privacy-requests.ts).
CREATE TABLE IF NOT EXISTS escalation_messages (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  escalation_id uuid NOT NULL REFERENCES recruiter_escalations(id),
  side text NOT NULL,
  kind text NOT NULL DEFAULT 'reply',
  author jsonb NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS escalation_messages_escalation_idx ON escalation_messages (escalation_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS escalation_messages_company_idx ON escalation_messages (company_id, created_at);
--> statement-breakpoint
-- The team reads and writes its own requests' threads in tenant transactions; the recruiter's side (the queue, which
-- runs on the platform side) reads and writes the thread of the request they hold.
ALTER TABLE escalation_messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON escalation_messages
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid OR (current_setting('app.platform', true) = 'on' AND current_user <> 'app_tenant'))
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid OR (current_setting('app.platform', true) = 'on' AND current_user <> 'app_tenant'));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON escalation_messages TO app_tenant, ros_app, ros_worker;
--> statement-breakpoint
-- A message is part of the record of what was asked and answered: never deleted.
REVOKE DELETE ON escalation_messages FROM app_tenant, ros_app, ros_worker;
