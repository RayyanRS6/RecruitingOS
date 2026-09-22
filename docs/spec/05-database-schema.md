# 05. Database schema (release 1)

Postgres 16 with pgvector; PGlite locally and in tests. Drizzle schema in `packages/db/src/schema/*.ts`; SQL migrations in `packages/db/migrations/` (0000 base, 0001 RLS and grants, 0002 screens). Conventions: UUIDv7 primary keys; `timestamptz`; JSON columns validated by Zod schemas in `packages/contracts`; every tenant table has `company_id` and the `tenant_isolation` RLS policy; events and jobs use bigserial.

## 1. Tables by status

| Table | Release-1 status | Notes |
|---|---|---|
| companies, users, memberships, sessions, magic_links, plans, entitlements, usage_events | existing | `plans` gains the `pilot` row (D9) |
| playbooks, roles, role_packets, intake_sessions, postings, candidates, documents, applications, assessments, screens, communications | existing | `candidates.timezone` added; `postings.channel` limited by the channel flag |
| interviews, interview_participants | existing, **modified** | scheduling columns added |
| calendar_connections | **new** | per user per provider |
| interviewer_availability | **new** | declared windows |
| data_requests | **new** | access, correction, deletion intake |
| rate_limits | **new**, platform-level | sliding-window counters (S5) |
| business_calendar_versions | **new**, platform-level (built 18 Sep) | immutable versions of the ITS business calendar: `calendar_key, version, effective_from date, time_zone, hours jsonb {sun..sat: [{start,end}]}, holidays jsonb, closures jsonb, coverage_changes jsonb, note, created_by`; readable by the tenant role, insert-only for the platform roles (migration 0005) |
| interviewer_availability | **new** (built 18 Sep) | as designed in §3; RLS `tenant_isolation` (migration 0008) |
| interviews | existing, **modified** (built 18 Sep) | scheduling columns as designed in §2 plus `candidate_availability jsonb` (note, preferred parts of day, accessibility note) and `attempt integer` (each re-offer, reschedule or cancellation increments it; a workflow run belongs to one attempt) |
| integrations (calendar) | existing, **modified** (built 18 Sep) | `user_id` for per-person connections; unique on (company, provider, kind, user) with nulls not distinct; `calendar_connections` from §3 is **not** created: the credential lives in the managed store per correction 10 and the connection is an `integrations` row of kind `calendar` with `config {calendarId, timeZone, scopes, consecutiveFailures}` |
| data_requests | **new** (built 18 Sep) | as designed in §3 plus channel, verification status and note, assignee, notes, counsel escalation and decision, confirmation, deadline alerts, escalation link; no tenant access (migration 0009); `candidates.anonymized_at` |
| email_suppressions, webhook_receipts | **new**, platform-level (built 18 Sep) | do-not-send list by address (reason, source, count, release) readable by the tenant role; one receipt per provider event id; `communications.failure_type/retry_of/retry_attempt` (migration 0010) |
| users, sessions | existing, **modified** (built 18 Sep) | `users.auth_provider`, `users.auth_subject` (unique together; the identity service's subject); `sessions.identity_provider`, `sessions.aal`, `sessions.mfa_verified_at` (migration 0007, D19) |
| integrations | existing, **modified** (built 18 Sep) | `secret_ref` (opaque reference into the managed store; null once deleted), `secret_deleted_at`, `revoked_at`, `disconnected_at`, `disconnect_reason`; `credentials_ciphertext` is unused and dropped next release (correction 10, migration 0006) |
| admin_alerts | **new**, platform-level (built 18 Sep) | operator alerts: `kind, severity, title, body, company_id?, target, details, status open|acknowledged|resolved, acknowledged_by/at, resolved_at`; no tenant access (migration 0006) |
| recruiter_escalations | existing, **modified** (built 18 Sep) | `urgency text default 'normal'`, `required_expertise text`, `summary text` (template text by category; never free text or candidate data) for the pre-acceptance preview (correction 11) |
| policies, approval_requests, workflow_runs, workflow_steps, jobs, ai_runs, recruiter_escalations, takeovers, interventions, notifications, inbound_emails, integrations, audit_records, events | existing | `ai_runs` unchanged; spend cap is computed from it |
| scorecards, debriefs, offers, onboardings, hiring_outcomes | existing, unused | kept for release 2 and 3 (P11) |

## 2. Modified tables

### interviews (existing → modified)

```sql
ALTER TABLE interviews
  ADD COLUMN schedule_token text,
  ADD COLUMN schedule_token_expires_at timestamptz,
  ADD COLUMN scheduling_window jsonb NOT NULL DEFAULT '{}',   -- {fromDate, toDate, businessDaysOnly, candidateTimezone?}
  ADD COLUMN offered_slots jsonb NOT NULL DEFAULT '[]',        -- OfferedSlot[]
  ADD COLUMN selected_slot jsonb,                              -- OfferedSlot | null
  ADD COLUMN link_source text NOT NULL DEFAULT 'calendar',     -- calendar | pasted
  ADD COLUMN reschedule_count_candidate integer NOT NULL DEFAULT 0,
  ADD COLUMN cancel_reason text,
  ADD COLUMN outcome text,                                     -- happened | no_show_candidate | no_show_interviewer | null
  ADD COLUMN decision text,                                    -- next_round | finalist | hired | not_moving_forward | null (D10)
  ADD COLUMN decision_note text,
  ADD COLUMN reminders jsonb NOT NULL DEFAULT '{}',            -- {slots48h?: ts, before24h?: ts, before2h?: ts}
  ADD COLUMN workflow_run_id uuid,
  ADD COLUMN created_by jsonb;                                 -- Actor (the approving human)
CREATE UNIQUE INDEX interviews_schedule_token_idx ON interviews (schedule_token) WHERE schedule_token IS NOT NULL;
CREATE INDEX interviews_company_status_idx ON interviews (company_id, status, starts_at);
```

`status` values (existing column, values now fixed): `proposed` → `scheduling` → `scheduled` → `completed` | `cancelled` | `no_show`; plus `offer_expired` (no slot chosen). `calendar_refs` (existing jsonb) holds `{ [userId]: { provider, eventId, calendarId, htmlLink?, conferenceUrl? } }`. `meeting_url` (existing) holds the join link. `timezone` (existing) holds the company timezone used for display; the candidate's timezone lives on `candidates.timezone` and inside `scheduling_window`.

JSON shapes (Zod in `packages/contracts/src/domain/interview.ts`, new file):

```ts
OfferedSlot = { id: string; startsAt: string; endsAt: string; interviewerUserIds: string[]; source: "calendar" | "declared" }
InterviewSummary (API) = { id, roundKey, title, format, durationMinutes, status, startsAt, endsAt, timezone, meetingUrl, participants[], candidate: {name, timezone}, decision, outcome }
```

### interview_participants (existing → modified)

```sql
ALTER TABLE interview_participants
  ADD COLUMN availability_source text NOT NULL DEFAULT 'none',  -- calendar | declared | none
  ADD COLUMN calendar_event_id text,
  ADD COLUMN response text;                                     -- accepted | declined | tentative | null (from the provider, when available)
```

### candidates (existing → modified)

```sql
ALTER TABLE candidates ADD COLUMN timezone text;   -- IANA, set when the candidate picks a slot; used for reminders and quiet hours
```

### applications (existing, no change)

Stages used in release 1: applied, received, ineligible, eligible, triaged, screen_invited, screening, screen_complete, interview_recommended, interview_scheduled, interview_complete, finalist, hired, withdrawn, rejected, talent_pool. The rest of the enum stays for later releases.

### plans (seed change)

Add `{ key: "pilot", name: "Design partner pilot", prices: { monthlyUsd: 0 }, limits: { active_roles: 5, text_screens: 500, voice_minutes: 0, sourcing_contacts: 0, recruiter_asks: 10, seats: null } }` (D9).

## 3. New tables

### calendar_connections

```sql
CREATE TABLE calendar_connections (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  user_id uuid NOT NULL REFERENCES users(id),
  provider text NOT NULL,                      -- google | microsoft
  external_account_email text,
  calendar_id text,                            -- the calendar used for free/busy and events
  scopes jsonb NOT NULL DEFAULT '[]',
  credentials_ciphertext text NOT NULL,        -- AES-256-GCM envelope: key id prefix + iv + tag + ciphertext (refresh token, access token, expiry)
  status text NOT NULL DEFAULT 'connected',    -- connected | needs_attention | disconnected
  timezone text,                               -- from the provider's settings when available
  connected_at timestamptz NOT NULL DEFAULT now(),
  last_health_at timestamptz,
  last_error text,
  disconnected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX calendar_connections_user_provider_idx ON calendar_connections (company_id, user_id, provider);
```

RLS: `tenant_isolation`. Ciphertext is never returned by any API; only status, account email, calendar id, scopes, and health.

### interviewer_availability

```sql
CREATE TABLE interviewer_availability (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  user_id uuid NOT NULL REFERENCES users(id),
  timezone text NOT NULL,
  windows jsonb NOT NULL DEFAULT '[]',         -- [{day: 1..7, start: "09:00", end: "17:00"}]
  buffer_minutes integer NOT NULL DEFAULT 15,
  max_per_day integer NOT NULL DEFAULT 3,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX interviewer_availability_user_idx ON interviewer_availability (company_id, user_id);
```

Used alone when no calendar is connected, and as constraints (working hours, buffers, daily max) when one is.

### data_requests

```sql
CREATE TABLE data_requests (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  candidate_id uuid REFERENCES candidates(id),
  application_id uuid,
  kind text NOT NULL,                          -- access | correct | delete
  details text,
  requester_email text NOT NULL,
  verification_token_hash text,
  verified_at timestamptz,
  status text NOT NULL DEFAULT 'received',     -- received | verified | in_progress | fulfilled | declined
  sla_due_at timestamptz NOT NULL,             -- 30 days
  handled_by uuid,
  resolution text,
  fulfilled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX data_requests_company_status_idx ON data_requests (company_id, status, sla_due_at);
```

RLS: `tenant_isolation`. Platform admins fulfil deletions through an audited runbook in release 1 (D15).

### rate_limits (platform-level; no company_id; not granted to app_tenant)

```sql
CREATE TABLE rate_limits (
  key text NOT NULL,                           -- e.g. apply:<ip>, magic:<ip>, screen:<token>, intake_address:<token>
  window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);
```

A daily job deletes windows older than 24 hours.

## 4. Audit and events

New `audit_records.action` values: `tenant.viewed_by_staff` (D11), `platform_role.changed`, `plan.changed`, `data_request.fulfilled`, `calendar.credentials_deleted`, `session.revoked_by_admin`.

Event types already in the enum and used newly: `interview.requested`, `interview.scheduling_started`, `interview.slots_offered`, `interview.scheduled`, `interview.rescheduled`, `interview.cancelled`, `interview.no_show`, `interview.completed`, `integration.connected`, `integration.failed`, `candidate.data_request`, `plan.changed`. Added to the enum: `interview.offer_expired`, `interview.decision_recorded`, `calendar.disconnected`, `session.revoked`, `data_request.fulfilled`.

## 5. Indexes added

`interviews (company_id, status, starts_at)`; `interviews (schedule_token)` unique partial; `calendar_connections (company_id, user_id, provider)` unique; `interviewer_availability (company_id, user_id)` unique; `data_requests (company_id, status, sla_due_at)`; `communications (company_id, template_key, created_at)` for reminder idempotency checks; `events (company_id, type, occurred_at)` already exists.

## 6. Retention (proposed conservative defaults pending counsel; counsel register item 9)

These are not legal conclusions. Counsel approves the period, the anonymization method, the deletion exceptions, and the litigation-hold process per category. No irreversible automatic deletion runs in production until then.

| Category | Tables and stores | Proposed default | Anonymization method (proposed) |
|---|---|---|---|
| Candidate application data | candidates, applications (answers), documents + object storage | 4 years after the application closes | Replace name, contact, location, free text with tokens; delete files and extracted text |
| Automated-assessment inputs and outputs | applications.extraction, assessments, ai_runs (structured output, input refs) | 4 years | Remove quotes and personal fields; keep scores, findings by key, prompt version |
| Human decision records | events (stage changes, human.override), applications.reject_reason and note, approval_requests | 4 years | Keep decision, reason code, actor; remove free-text notes naming the person |
| Consent records | candidates.consent, consent events | 4 years after the last interaction | Keep purpose, version, timestamp; remove ip |
| Communications | communications, inbound_emails | 4 years | Remove bodies; keep template, direction, timestamps, status |
| Interview recordings (when introduced) | documents (transcripts), recordings store | shortest period counsel allows | Delete media; transcript per assessment rule |
| Security logs | sessions, magic_links, rate limits, sign-in monitoring | 90 days after expiry (sessions); 30 days (links) | Delete |
| Access logs | audit_records with staff access details | 7 years proposed | Never deleted; personal fields in details anonymized on request |
| Operational audit events | events (workflow, approval, ai), workflow_runs, workflow_steps, jobs | events with the subject's category; runs and jobs 180 days after completion | Delete runs and jobs; events per subject category |
| Billing records | plans, entitlements, usage_events, plan-change audit | 7 years proposed | Not anonymized (no candidate data) |
| Data-subject requests | data_requests (when built), the manual log | 3 years after completion | Keep outcome; remove requester contact after the period |

Release 1 fulfils deletions and anonymizations manually per `docs/runbooks/privacy-requests.md`; purge automation is release 2 and only after approval.

## 7. Migration plan

- `0003_pilot_plan_and_channels.sql`: plans seed handled in code; `postings` unchanged; adds `candidates.timezone`.
- `0004_scheduling.sql`: interviews and interview_participants columns; calendar_connections; interviewer_availability; indexes; RLS policies and grants for the new tables.
- `0005_data_requests_and_rate_limits.sql`: data_requests (RLS); rate_limits (platform-only grants).
- `0006_db_roles.sql` (production only, run by the migration role): `ros_app` login role with `NOBYPASSRLS`, grants; documented in `10`.

All migrations are additive and backward-compatible for one release; each ships with a PGlite test that applies it from empty and from the previous state.

## 8. Entity relationships (release 1)

```
companies 1─* memberships *─1 users 1─* calendar_connections, interviewer_availability
companies 1─* roles 1─* role_packets ; roles 1─* postings ; roles 1─* applications *─1 candidates
applications 1─* assessments, screens, communications, interviews
interviews 1─* interview_participants *─1 users
candidates 1─* data_requests
companies 1─* policies, approval_requests, workflow_runs, ai_runs, recruiter_escalations, interventions, notifications, audit_records, events
```
