<!-- Part of the Recruiting OS product audit (docs/product-audit.md), 14 October 2026. Written by one reader from the code at origin/main dafb730 and checked by a second, skeptical reader who tried to refute every bug and status; corrections are listed under the verification notes. Working files mentioned as 'scratchpad' are not in the repository. -->

# Communications, notifications, recruiter on demand, admin, reports, privacy and operations

Audit of `recruiting-os` on branch `kanvis-reaudit` (= origin/main `dafb730`, 14 Oct 2026). Read-only. Every claim below was traced in code (UI -> API route -> service -> database) unless it is marked as coming from docs or from the project's session notes. Paths are repo-relative.

## 1. Summary

Communications and operations are largely built in code and tested against fake providers, but on staging almost none of the outward-facing channels are live.

- Every email and text to a candidate goes through a transactional **outbox** (`packages/agents/src/outbox.ts`): the message is written as `queued` inside the business transaction, the Railway worker sends it once after commit, a message to a company ITS has not confirmed is `held`, a message that is no longer relevant is `cancelled`, and a send that was interrupted is marked `unknown` and never re-sent automatically.
- On staging `EMAIL_PROVIDER` is `fake` (`docs/runbooks/staging-environment-variables.md` line 86; the project's session notes of 13 and 14 Oct say the same). **No email leaves staging.** Candidates get no status links, screening links or interview times. Team members get no alert emails or morning summaries. ITS gets no queue mail. A standing admin alert "Emails are not being sent" says so (`apps/api/src/email-gate.ts`).
- What is live and what is not:
  - **Off but built:** SMS (Twilio, switched off by founder decision M2), Sentry and PostHog.
  - **Live:** rate limiting on Upstash, and the Railway worker with its heartbeats.
- **The ITS recruiter loop is complete.** A customer asks a recruiter; the ITS queue shows a preview before anyone accepts; accepting gives the recruiter scoped, time-limited access; the two sides write to each other; the recruiter resolves; the customer can reopen; the customer can revoke access.
  - Only requests a customer raises email the ITS mailbox.
  - A candidate's HUMAN reply, a screening hand-off, a failed workflow and an eligibility hold appear only on the `/recruiter/queue` page.
- **The admin console covers:** customers and the ITS company check, workflows, AI runs, failures and alerts, costs, queue, the business calendar, privacy requests, administrators and outcomes.
  - Plan changes and break-glass have an API but no UI.
  - Requeueing a failed job and resolving an alert have no UI and no API.
- **There is no real billing.** Plans are entitlement counters that ITS changes by API. The "monthly" screening-conversation and recruiter-request allowances never reset.
- **Also implemented and tested:** privacy requests, the customer's audit history, team and invitations, sessions and "Confirm it's you", company settings, the role report with audited CSV export, CSP and security headers, and secret handling.
- **The main operational risks:**
  - Alerts live only in the console. Once acknowledged, an alert stops the same alert from ever being raised again.
  - A provider outage longer than about one minute fails every queued message for good.
  - Interrupted sends are swept only once a day.
  - Allowances never reset.
  - Nothing tells ITS when a recruiter request passes its reply-by time (no SLA-breach alert), and most system-raised requests are never emailed to ITS, so a candidate promised a person can wait without anyone at ITS knowing (added in verification).
  - On staging, a company that signs itself up waits unseen: the "[company check]" email goes to the fake adapter, which reports it sent, so no alert is raised either. Its roles stay unpublished and its candidate messages stay held until someone happens to open Admin -> Customers (added in verification; `services/company-trust.ts` 123-126).

## 2. Feature inventory

Status is one of: fully_implemented, partial, ui_not_functional, planned_not_implemented, unknown. "Staging" notes describe the deployed environment as far as docs and session notes show. The deployed environment cannot be verified from code.

| ID | Feature | Status | Who | Evidence |
|---|---|---|---|---|
| OPS-01 | Communications outbox: queued inside the transaction, one `communication.send` job, retry, failed, `unknown` never re-sent | fully_implemented | candidate (receives), owner and hiring manager (see status), ITS (alerts) | `packages/agents/src/outbox.ts` queueCommunication 180-221, sendQueuedCommunication 317-391, sweepStaleSending 426-438; job registered `apps/api/src/container.ts` 182-187; migration `0019_communications_outbox.sql` |
| OPS-02 | Undo window (30 s) for a message a person sent (freeform or decision) | fully_implemented | owner, hiring manager, ITS recruiter under grant | `outbox.ts` heldForUndo 231, undoQueuedMessage 243-257; `apps/api/src/env.ts` MESSAGE_UNDO_SECONDS 160 |
| OPS-03 | Hold candidate messages until ITS confirms a new company, then release them (with stale ones cancelled) | fully_implemented | ITS admin, candidate, owner | `outbox.ts` waitsForCompanyCheck 88, companyConfirmed 99-105, releaseHeldCommunications 268-287, reasonsNotToSend 137-165; `apps/api/src/routes/admin.ts` verification 79-93 |
| OPS-04 | Postmark outbound email adapter | partial (built, never live; staging uses the fake) | everyone who should get email | `packages/integrations/src/email/postmark.ts` 8-42; selected only when `EMAIL_PROVIDER=postmark` `packages/integrations/src/registry.ts` 60 |
| OPS-05 | Fake email/SMS adapters, `/dev/outbox`, and the production "Emails are not being sent" alert | fully_implemented | developers, ITS admin | `packages/integrations/src/email/fake.ts`; `apps/api/src/app.ts` 163-170; `apps/api/src/email-gate.ts` 13-29 |
| OPS-06 | Email suppression list, Postmark bounce/spam/subscription webhooks, soft-bounce retries, SMS fallback, admin release | partial (logic complete; webhooks reachable only once Postmark is configured. Verification: "a spam complaint is never released" is enforced only by a disabled button; the API releases one. The do-not-send list is held in memory, capped at 500 rows and emptied for a moment on each one-minute reload. `emailOptOut` is written but never read) | ITS admin, owner (told candidate unreachable), candidate | `packages/core/src/email-suppression.ts` releaseSuppression 51-57 (no spam check), listSuppressions 59-61 (limit 500); `packages/agents/src/email-failures.ts` handleEmailEvent 18-80, retryCommunication 157-189; `apps/api/src/webhooks/postmark.ts` 260-286; `apps/api/src/services/email-subscriptions.ts`; guard `container.ts` 117-121, 286; admin `admin.ts` 226-241; `Admin.tsx` 389 |
| OPS-07 | SMS by Twilio (send, inbound replies, STOP/START/HELP, signature check, contact hours) | partial (built, switched off: `SMS_ENABLED=false`, `SMS_PROVIDER=fake`, no A2P registration) | candidate | `packages/integrations/src/sms/twilio.ts`; `apps/api/src/webhooks/twilio.ts`; `env.ts` 162; decision M2 in `docs/spec/00-decisions-and-risks.md` 305 |
| OPS-08 | In-app notifications: Updates page, unread on Today, read/unread/read-all | fully_implemented | owner, admin, hiring manager (default); anyone named | `packages/core/src/notifications.ts` notify 33-51; `apps/api/src/routes/notifications.ts` 13-94; `apps/web/src/pages/Updates.tsx` |
| OPS-09 | Email alerts per person and group (as it happens, daily, weekly, off), always-sent kinds, 8:00 summaries, unsubscribe | fully_implemented (code); no email delivered on staging. "Unsubscribe" means a link to Setup -> Notifications plus Postmark's SubscriptionChange event. There is no List-Unsubscribe header or one-click link (`notify-email.ts` 115-117, 141-162) | owner, admin, hiring manager, HR, interviewer (own items) | `packages/core/src/notify-groups.ts`, `notify-email.ts`, `notify-digest.ts`; `packages/workflows/src/definitions/notification-digest.ts`; prefs `routes/notifications.ts` 122-148; `apps/web/src/pages/NotificationsCard.tsx`; migration 0028 |
| OPS-10 | Ask a recruiter (customer side): reply-by estimate, scope, urgency, list on Today, notes, reopen | fully_implemented (customers cannot cancel a request) | owner, admin, hiring manager, HR | `apps/api/src/routes/approvals-escalations-events.ts` POST / 144-177, /estimate 184-198, /mine 206-237, /mine/:id/messages 273-295, /mine/:id/reopen 302-348; `apps/web/src/components/AskRecruiter.tsx`, `RecruiterRequests.tsx` |
| OPS-11 | ITS recruiter queue: preview before accepting, claim with scoped grant, thread, resolve, release, posting tasks | fully_implemented | ITS recruiter, platform admin | `approvals-escalations-events.ts` 378-681; `packages/core/src/escalations.ts`; `apps/web/src/pages/RecruiterQueue.tsx`; migration 0029 |
| OPS-12 | Telling the ITS queue mailbox about new requests | partial | ITS recruiters | Customer requests `escalation-queue.ts` emailItsQueue 22-31 (callers `approvals-escalations-events.ts` 174, `roles.ts` 831, `review-apply.ts` 212); stuck ladder `packages/agents/src/orchestrator.ts` 337. System-raised requests send no email: `packages/core/src/escalations.ts` 18-68. Verification found more silent sources: `schedule-interview.ts` 249, `new-times-reopen.ts` 192, `decision-messages.ts` 304, `privacy-requests.ts` 432 |
| OPS-13 | Automatic recruiter requests (a failed workflow, the stuck-role ladder, HUMAN replies, screening hand-off, eligibility hold; verification adds: three picked interview times all taken, a candidate's cancelled interview while ITS runs the role, the untold-decision safety net, a privacy human review) | fully_implemented | ITS recruiter, owner (Today card) | `packages/workflows/src/engine.ts` failForGood 344-398; `orchestrator.ts` 332; `apps/api/src/services/replies.ts` 175; `packages/agents/src/screening.ts` 696; `application-intake.ts` 189; `schedule-interview.ts` 249; `new-times-reopen.ts` 192; `decision-messages.ts` 304; `privacy-requests.ts` 432 |
| OPS-14 | Customer sees and ends ITS recruiter access | fully_implemented | owner, admin (end); all members (see) | `apps/api/src/routes/companies.ts` 106-174; `apps/web/src/pages/Setup.tsx` 372-377 |
| OPS-15 | Operator alerts (`admin_alerts`): raise, raise-once, acknowledge | partial (no resolve; console-only; an acknowledged alert blocks its kind for good) | platform admin | `packages/core/src/alerts.ts`; `admin.ts` 244-254; `apps/web/src/pages/Admin.tsx` 371-382 |
| OPS-16 | Worker process: poll loop, heartbeats, worker `/healthz`, app `/healthz` with worker status, stale-worker and stale-queue alerts | fully_implemented (restart and uptime-monitor wiring unverified) | ITS admin | `apps/api/src/worker.ts`; `apps/api/src/worker-health.ts`; `apps/api/src/maintenance.ts` 75-130; `app.ts` 97-113; migration 0021; `railway.json` |
| OPS-17 | Recurring jobs `privacy.deadline_check` (daily), `maintenance.daily`, `ops.health_check` (hourly), publishing backfill (per boot) | fully_implemented | ITS admin | `container.ts` 165-179, 259-266; `apps/api/src/recurring-jobs.ts` |
| OPS-18 | Retention sweep | partial (operational rows only; candidate-data retention not automated, pending counsel) | ITS | `maintenance.ts` RETENTION_DAYS 13-27, runMaintenance 41-60; `docs/readiness/09-data-retention-matrix.md` (proposed) |
| OPS-19 | Error reporting to Sentry with scrubbing; the staging test-error route; scrubbed job and step failure reports | partial (built; no DSN, so reporting is off) | ITS | `apps/api/src/observability.ts`, `instrument.ts`, `failure-reports.ts`; `apps/shell/instrumentation.ts`; `routes/observability.ts` |
| OPS-20 | Audit log, the customer's audit history page and its CSV | fully_implemented | owner, admin, hiring manager, HR (events.read) | `packages/core/src/audit.ts` 111-126; `apps/api/src/services/audit-history.ts`; `routes/company-settings.ts` 482-492; `Setup.tsx` 418-442 |
| OPS-21 | Admin console tabs: Customers (ITS check, job boards, apply flow, report), Workflows (+ retry failed), AI runs, Failures (alerts, suppressions, CSP review, credential retry), Costs, Queue, Business calendar, Privacy, Administrators, Outcomes | fully_implemented (for these tabs) | platform admin (MFA aal2) | `apps/web/src/pages/Admin.tsx` 15-26; `apps/api/src/routes/admin.ts` |
| OPS-22 | ITS changes a customer's plan or allowances | partial (API only, no UI) | platform admin | `admin.ts` POST /customers/:id/plan 390-410; no caller in `apps/web` |
| OPS-23 | Break-glass emergency access; staff-access ledger; admin operational view of escalations; manual suppression; admin "sign a person out everywhere" | partial (APIs exist, no console UI) | platform admin | `admin.ts` 360-387, 289-304, 227-233, 494-507 |
| OPS-24 | Platform roles ledger (grant or revoke its_recruiter or platform_admin, the other admins told) | fully_implemented | platform admin | `admin.ts` 416-487; `Admin.tsx` Administrators tab |
| OPS-25 | Team and invitations (invite, resend, withdraw, change role, remove with interview clean-up) | fully_implemented (seat limit not enforced) | owner, admin, HR | `routes/companies.ts` 49-103; `apps/api/src/services/team.ts`; `packages/core/src/invitations.ts`; `apps/web/src/pages/TeamCard.tsx`; migration 0022 |
| OPS-26 | Owner, admin or HR signs a teammate out everywhere | partial (API only, no button; the route checks `members.manage`, which HR also holds, so by API HR can sign an owner out) | owner, admin, HR | `routes/company-settings.ts` 498-516; `permissions.ts` 64; no caller in `apps/web` |
| OPS-27 | Company settings: profile, notices with versions and "Confirm it's you", contact hours, new-times setting, logo, about text (AI draft), hiring contact, who posts on boards | fully_implemented | owner, admin | `routes/company-settings.ts` 77-422; `Setup.tsx` |
| OPS-28 | Sessions: list, sign out one or all others, "Confirm it's you" | fully_implemented | every signed-in person | `apps/api/src/routes/auth-sessions.ts`; `middleware/reauth.ts`; `Setup.tsx` 456-486; migration 0024 |
| OPS-29 | Billing, plans and entitlements | partial (no payments or invoices; counters and alerts only; allowances never reset) | owner (sees usage), ITS (bills by hand) | `packages/core/src/entitlements.ts`; plans `packages/db/src/seed.ts` 8-40; `routes/intake.ts` 134 ("There is nowhere in the product to change plans") |
| OPS-30 | Role report (ten figures) with applicant CSV and summary CSV (audited) | fully_implemented | owner, admin, hiring manager, HR, recruiter under grant | `apps/api/src/routes/reports.ts`; `services/role-report.ts`; `apps/web/src/pages/RoleReport.tsx` 46-56 |
| OPS-31 | Admin's customer report across all roles | fully_implemented | platform admin | `admin.ts` 140-152; `apps/web/src/pages/AdminCustomerReport.tsx` |
| OPS-32 | Product analytics: server-side PostHog funnel events with keyed hashes | partial (built; fake on staging) | ITS | `packages/integrations/src/analytics/adapters.ts`, `mapping.ts`; sink `container.ts` 123-126 |
| OPS-33 | Privacy requests: status-page requests, public form with emailed confirmation, admin workflow, export, correction, deletion by anonymisation after counsel, SMS opt-out, human review, deadline alerts | fully_implemented (completion emails not delivered on staging; verification: on staging the public form path cannot be completed at all, because the confirm link is only ever emailed. Only the status-link path and admin-recorded requests work there) | candidate, platform admin | `packages/core/src/privacy-requests.ts`; `routes/privacy-requests.ts`; `pages/privacy-request.tsx`; `pages/candidate.tsx` 1695; `packages/agents/src/privacy-messages.ts`; migration 0009 |
| OPS-34 | Rate limiting: per-policy limits, shared Upstash store, security events, suspicious-activity alert | fully_implemented (live on staging) | everyone | `apps/api/src/middleware/rate-limit.ts`; `packages/core/src/rate-limit.ts`; `env.ts` 190-192 |
| OPS-35 | Content-security policy (nonce) on candidate pages and the app, report collection and review, X-Frame-Options, nosniff, same-site write check | fully_implemented (report-only on staging) | everyone | `packages/core/src/csp.ts`; `app.ts` 56-94; `apps/shell/middleware.ts`; `apps/shell/next.config.ts` 39-43; `middleware/same-site.ts` |
| OPS-36 | Secrets: Supabase Vault store, audited reads, registry scrubbing, revoke and delete on disconnect, sealed browser payloads | partial (`rotateSecret` never called; the vault holds only calendar credentials, and calendar is fake on staging) | ITS, owner (calendar) | `packages/core/src/secrets.ts`, `sealed.ts`, `connections.ts`; `packages/integrations/src/secrets/vault.ts` |
| OPS-37 | Inbound email (email-in applications, candidate replies, HUMAN by email) | partial (needs a Postmark inbound secret and a real intake domain; not configured) | candidate, owner | `webhooks/postmark.ts` 29-80; `services/replies.ts`; `registry.ts` 62 |
| OPS-38 | AI spend cap per customer, `/admin/spend` | planned_not_implemented | platform admin | Listed in `docs/spec/07-api-specification.md` 190; no route in `admin.ts` |
| OPS-39 | Admin views and actions promised in `docs/16-admin.md` (cross-tenant roles and candidate search, impersonation, entitlement and credit edits, prompt promotion, playbook publish, activity, cancel run) | planned_not_implemented | platform admin | `docs/16-admin.md` 9-22 vs `Admin.tsx` 15-17 |
| OPS-40 | Retry or requeue a failed job from the console | planned_not_implemented | platform admin | Alert text in `engine.ts` 196; `Admin.tsx` 397 lists the jobs with no action; no route |
| OPS-41 | Telling a person when a critical alert fires (email, pager, chat) | planned_not_implemented | ITS | Alerts are only rows in `admin_alerts` shown in the console (`alerts.ts` 7-10); nothing sends them on |
| OPS-42 | Stuck-role nudge ladder: a Today line, then an email to owner/admin/hiring manager (by their setting), then an offer of a recruiter, then an automatic recruiter request (added in verification) | fully_implemented (emails not delivered on staging) | owner, admin, hiring manager, ITS recruiter | `packages/agents/src/orchestrator.ts` runInterventionLadder 261-292, sendIntervention 299-338; `packages/workflows/src/definitions/stuck-role-detector.ts` 29-31; table `interventions` |
| OPS-43 | "Lost your link?" status-link resend for candidates (added in verification) | fully_implemented (email only; not delivered on staging) | candidate | `apps/api/src/pages/candidate.tsx` 572 -> `services/applications.ts` queueLinkRequest 211, emailStatusLinks 220-239; job registered `container.ts` 190-193 |
| OPS-44 | An alert when a recruiter request passes its reply-by time (SLA breach) (added in verification) | planned_not_implemented | ITS recruiter, candidate waiting for a person | Promised in `docs/16-admin.md` "Operational alerts"; code only counts "overdue" in the role report (`services/role-report.ts` 450); no alert or email anywhere |

## 3. Workflows traced step by step

### 3.1 A message to a candidate (any template) through the outbox
Actor: system workflow, or a person pressing Send.
1. A UI action or a workflow step calls a message builder (for example `packages/agents/src/coordinator.ts`, `decision-messages.ts`). It ends in `queueCommunication` inside the caller's tenant transaction.
2. `queueCommunication` (`outbox.ts` 180-221) works as follows:
   - It looks up the idempotency key and returns the existing row if there is one.
   - It decides whether the message must be held: the message is to a candidate, it is not a `privacy_*` template, and the company is not confirmed. "Not confirmed" is checked again under a share lock.
   - It inserts a `communications` row, `queued` or `held`.
   - For a queued message it inserts a `jobs` row `communication.send`. `run_at` is now, or `sendAt` for the Undo window, with `max_attempts` 6.
   - It emits `message.queued` or `message.held`.
3. Once the business transaction commits, the Railway worker (`worker.ts` loop -> `engine.runPending(25)`) claims the job and calls `sendQueuedCommunication` (`outbox.ts` 317-391):
   - `holdIfUnconfirmed`: the company lost its confirmation, so the message is held.
   - `cancelIfUnwanted` (`reasonsNotToSend`): the candidate stopped texts, left the process or was anonymised, the link's step has ended, or the decision was undone. The message is cancelled with the reason.
   - Otherwise the row moves to `sending` and the provider is called outside any transaction. The email adapter is wrapped by the suppression guard (`container.ts` 121).
4. The outcome is recorded:
   - `sent`, with the provider id, `message.sent`, and the decision's told state settled (`settleDecisionTold` 402-413).
   - A retryable failure puts the row back to `queued`, emits `message.retried` and throws. The engine retries with a backoff of 2, 4, 8, 16, 32 s (`engine.ts` 177).
   - The last attempt, or a permanent failure, marks the row `failed`. The team is notified with `candidate.unreachable`, and a high `message.delivery_failed` alert is raised when the provider itself failed.
5. An interrupted send: `maintenance.daily` runs `sweepStaleSending`. Rows `sending` for more than 15 min become `unknown`, a decision goes back to "not told", the team is told to check, and a `message.delivery_unknown` alert is raised. The message is never re-sent automatically.

On staging step 3 calls the fake adapter. The row is marked `sent`, but nothing is delivered.

### 3.2 ITS confirms a new company and held messages go out
1. On sign-up, `POST /api/v1/companies` (`routes/companies.ts` 18-29) creates the company and starts `stuck_role_detector`. `tellItsAboutNewCompany` emails the ITS mailbox directly and raises an alert if the email fails (`services/company-trust.ts` 123-125).
2. The platform admin opens Admin -> Customers. A waiting company is listed first, with its held messages counted (`admin.ts` 31-64). The admin presses Confirm with a reason, which calls `POST /admin/customers/:id/verification` -> `verifyCompany` -> `releaseHeldCommunications`:
   - Stale held messages are cancelled.
   - Emails are queued at once; texts wait for the next allowed hour.
   - Waiting publish runs wake.
3. The owners are told. This alert is always emailed, but on staging it is not delivered.

### 3.3 Email bounce, spam complaint or unsubscribe
1. Postmark posts to `/webhooks/postmark/bounces|spam|events` (`webhooks/postmark.ts` 260-286). Basic auth or a secret header is checked; production fails closed without `POSTMARK_WEBHOOK_SECRET`. A receipt is claimed in the same transaction.
2. `handleEmailEvent` (`email-failures.ts` 18-80) handles each kind:
   - **Delivery:** the row is marked `delivered`.
   - **Hard bounce:** the address is suppressed and a decision goes back to "not told". The team gets `candidate.unreachable`, and a status-link text is sent when the candidate agreed to texts (always "not possible" while SMS is off). A bounce on a team member's address raises an admin alert.
   - **Spam complaint:** the address is suppressed for good, `emailOptOut` is set and a critical alert is raised.
   - **Soft bounce:** a retry after 4 h and another after 24 h (`email.retry` job). Two soft bounces in 7 days suppress the address.
   - **SubscriptionChange** (`email-subscriptions.ts`): the address is suppressed. The candidate's `emailOptOut` is set, or the team member's alert emails are switched off.
3. The admin releases a suppression with a reason (Admin -> Failures; `admin.ts` 234-241). The console disables Release for a spam complaint (`Admin.tsx` 389), but the server does not check: `POST /admin/email-suppressions/:id/release` releases a spam complaint too (`email-suppression.ts` 51-57). The candidate's `emailOptOut` flag set at the complaint is never read anywhere, so after such a release emails to that person go out again.

This flow is not live on staging: Postmark is not configured.

### 3.4 An update for the team: in-app, at once by email, or in the morning summary
1. Any service calls `notify(...)` (`notifications.ts` 33-51). It writes one `notifications` row per active member in the target roles (default owner, admin, hiring_manager) or per named user. For each person whose cadence for that group is `immediate`, or whose update is in an always-sent kind, it queues a `notification.email` job.
2. The job `emailNotifications` (`notification-digest.ts` 113-136) reads each person's setting again. It renders a nameless email: the headline, company, role and a link, never a candidate's name (`notify-email.ts` 141-162). The email goes through the outbox as team mail, which is never held.
3. One `notification_digest` run per company is started by the stuck-role detector or by saving preferences. It wakes at 8:00 company time and sends each person one summary of the updates they have neither read nor been emailed, counted by group and role (weekly groups on Monday) (`notification-digest.ts` 49-106).
4. People read and manage updates on `/updates` and in Setup -> Notifications (`NotificationsCard.tsx` -> `PUT /api/v1/notifications/preferences`, audited `notification.preferences_changed`).

### 3.5 The customer asks for a recruiter and ITS answers
1. Owner, admin, hiring manager or HR opens "Bring in a recruiter" (`AskRecruiter.tsx`). The form first calls `GET /api/v1/escalations/estimate`, which returns the reply-by time in ITS business hours and where the request stands against the plan's recruiter requests. Then `POST /api/v1/escalations` (144-177):
   - `settleScope` decides what the request covers: one candidate, one role, or the whole company. The whole company only when the person chose it.
   - `createEscalation` stores a context snapshot and the reply-by time from the business calendar.
   - The request is counted against the allowance; going over is never refused, and ITS gets a billing alert.
   - `emailItsQueue` sends the ITS mailbox a generic preview, without the customer's words.
2. The ITS recruiter opens `/recruiter/queue`, which needs an MFA session (aal2) (`GET /escalations`). The list is ordered urgent first, then reply-by. Each preview view is audited.
3. **Accept** (`POST /escalations/:id/claim`, 431-477) creates a `staff_access_grants` row scoped to the request and the request's role or candidate, for at most ESCALATION_ACCESS_DAYS. The customer's team is always told what the recruiter can see and until when. A recruiter whose access the customer ended cannot take the request back.
4. While the request is open:
   - The recruiter reads the full context; every page they open is recorded as `staff.tenant_accessed`.
   - The recruiter writes to the team (`/escalations/:id/messages`), which notifies the asker and the owners.
   - The team writes back (`/escalations/mine/:id/messages`). The holder is emailed that a note exists, never its words.
5. **Resolve** (`/escalations/:id/resolve`) does three things: the access is cut to 24 h after resolution, the answer is kept on the thread, and the asker and owners get the answer in full.
6. "This didn't solve it" (`/escalations/mine/:id/reopen`) reopens the request with a new reply-by time. Fresh access goes to the same recruiter, or the request returns to the queue, which is then emailed.
7. The customer can end access at any time (Setup -> Recruiter access -> `POST /companies/current/staff-access/:id/revoke`). The recruiter and the queue mailbox are emailed.

### 3.6 Something stops and needs a person (automatic request)
1. A workflow step fails more times than allowed. `engine.failForGood` (`engine.ts` 344-398) marks the run failed and emits `workflow.failed`, and Sentry hears of it if configured. A run that names a role or candidate gets a `createEscalation` with plain words (`stoppedRunQuestion`). A run that names neither raises an admin alert.
2. Other automatic requests: the candidate replied HUMAN (`replies.ts` 175), asked for a person in screening (`screening.ts` 696), was held on eligibility for too long (`application-intake.ts` 189), the stuck-role ladder reached its last rung (`orchestrator.ts` 332), or a privacy human review (`privacy-requests.ts` 432).
3. The team sees a Today card, "A recruiter will pick this up" (`services/brief.ts` 318-324), and the request appears in the ITS queue page. Only the stuck-role ladder emails the ITS mailbox. Every other automatic request is silent outside the queue page.
4. The customer cannot close or cancel the request. It stays on Today until an ITS recruiter claims and resolves it. A platform admin's "Retry" of the failed run in Admin -> Workflows does not close the request.

### 3.7 Worker health and alerts
1. On every loop the worker writes a `worker_heartbeats` row (queue depth, oldest due job) before it runs up to 25 jobs (`worker.ts` 23-34; `worker-health.ts` 72-79).
   - The worker's own `/healthz` answers 503 once its last poll is older than 3 x poll + 30 s.
   - Railway checks it at deploy time (`railway.json`).
2. The app's `/healthz` reads the newest heartbeat and, at most every 5 min per process, runs `checkOperationalHealth` (`maintenance.ts` 75-130):
   - A heartbeat older than 10 min raises `worker.stale` (critical).
   - A due job waiting more than 30 min raises `queue.stale`.
   - The worker's own hourly `ops.health_check` and the daily sweep run the same checks.
3. `raiseAlertOnce` skips a new alert while one of the same kind is open or acknowledged (`alerts.ts` 18-30). A person can only acknowledge; nothing resolves it.
4. A job that used up its attempts raises `job.failed` and is listed in Admin -> Failures, with no requeue.

### 3.8 Team invitation, role change, removal
1. An owner, admin or HR invites someone (`TeamCard.tsx` -> `POST /companies/current/members/invite`):
   - Only an owner can invite an owner; only an owner or admin can invite an admin; inviting either needs a recent sign-in.
   - ITS staff domains are refused.
   - `createInvitation` writes the row (0022), and the email is queued through the outbox (`team.ts` 46-97).
2. The invitee accepts by signing in with Google or Microsoft using the invited address. A link alone is not enough (`pages/invite.tsx`).
3. Role change or removal (`PATCH /companies/current/members/:userId` -> `updateMember`):
   - The last owner cannot be removed, and nobody can change themselves.
   - On removal the person's calendar is disconnected and its credential deletion queued, they are taken off future interviews, and sole-interviewer interviews are cancelled with the candidate told.
   - The owners are notified, and every session of the person is revoked.

### 3.9 A candidate's privacy request
1. There are three ways in:
   - A candidate with a status link posts `/c/status/:token/privacy`, verified by the link.
   - Anyone uses `/c/privacy-request`. Nothing is recorded: a sealed 24 h link is emailed to the address, one per employer that holds a record, and pressing the button creates a verified request (`pages/privacy-request.tsx` 14-23, 93-200).
   - An admin records an email request (`POST /admin/data-requests`).
2. `createDataRequest` sets a 45-day deadline and audits the request. The customer only learns that a request of a certain kind exists. An acknowledgement email goes through the outbox and is never held.
3. The admin works the request in Admin -> Privacy requests: assign, note, verify, escalate to counsel, record the counsel decision, then fulfil or decline (`routes/privacy-requests.ts`):
   - **Access:** a JSON export is attached to the completion email.
   - **Correction:** the field is updated.
   - **Deletion:** refused unless counsel approved and the admin confirms. Then `anonymizeCandidate` (`privacy-requests.ts` 233-270) ends every process, removes files, transcripts, message bodies and notes, scrubs recruiter copies and notifications, and tokenises identity.
   - **SMS opt-out:** applied at once.
   - **Human review:** opens a recruiter request.
4. `privacy.deadline_check` runs daily and raises an alert 10 days before the deadline and again when it is overdue.

### 3.10 Role report and exports
1. On a role's Report tab, `RoleReport.tsx` calls `GET /api/v1/roles/:id/report`. This needs `role.read` and `application.read`, so interviewers are refused. A recruiter under a grant reaches only the grant's role.
2. "Download the applicant list (CSV)" and "Download the summary (CSV)" call `/report.csv` and `/report/summary.csv`, each audited `report.exported`. Formula injection is neutralised (`role-report.ts` 698-706).
3. Audit history: Setup -> Audit history -> `/companies/current/audit` and `/audit.csv` (5,000 rows max, audited `audit.exported`).
4. The admin sees the same figures across all of a customer's roles (Customers -> Report).

### 3.11 Using up an allowance (the screening conversation)
1. A candidate's first answer calls `entitlements.recordScreenStart` -> `record` (`entitlements.ts` 46-57, 103-111), which adds to `used` in the database.
2. At 80% and at 100% the owner is told and ITS gets a `billing.screens_*` alert. The Admin Customers card shows it as "running low".
3. Once `used >= limit`, new applicants' conversation links wait (`workflows/definitions/screen.ts` 121-145; `services/apply-conversation.ts` 98). The run checks again every 6 hours. After 60 days of waiting (`ALLOWANCE_WAIT_DAYS`, `screen.ts` 39), it gives up. A one-visit applicant is told the conversation is not going ahead. The team is told the person never got it, and the application waits for their review. A Design Partner company is never stopped (`screen.ts` 123-126).
4. Nothing ever resets `used`. `applyPlan` writes `periodStart` and `periodEnd` (30 days) on each entitlement, but no code ever reads them (`entitlements.ts` 71-78). A "top up" is only possible through `POST /admin/customers/:id/plan`, which changes `limit` but leaves `used` alone (`applyPlan` 68-82), and there is no UI for it.

## 4. Routes and screens

**Staff and customer screens (Next.js shell, `apps/shell/app/(app)`)**
- `/` Today: recruiter request list and Today cards (`Home.tsx`, `RecruiterRequests.tsx`, `services/brief.ts`).
- `/updates`: every update, unread filter, mark read or unread.
- `/setup`: Notifications, Team, Recruiter access, Audit history, Your sessions, Company, Candidate notices, How candidates see you, Job boards, When a candidate cancels.
- `/roles/[id]` Report tab: figures and two CSV downloads.
- `/recruiter/queue` and `/recruiter/queue/[id]`: ITS recruiter or platform admin, with an MFA session.
- `/admin`: platform admin, MFA session. Tabs: Customers, Workflows, AI runs, Failures, Costs, Queue, Business calendar, Privacy requests, Administrators, Outcomes.

**Candidate and public pages (Hono)**
- `/c/privacy-request`, `/c/privacy-request/verify/:token`, `/c/status/:token/privacy`, `/privacy`.

**API (`/api/v1`)**
- `notifications`: `/`, `/history`, `/read`, `/unread`, `/read-all`, `/preferences`.
- `escalations`: `/`, `/estimate`, `/mine`, `/mine/:id/messages`, `/mine/:id/reopen`, `/:id`, `/:id/claim`, `/:id/resolve`, `/:id/messages`, `/:id/release`, `/:id/posting/url|verify|updated|removed`.
- `companies/current`: GET, PATCH, `members`, `members/invite`, `invites`, `invitations/:id/resend|revoke`, `members/:userId` (PATCH), `members/:userId/sign-out`, `staff-access`, `staff-access/:grantId/revoke`, `audit`, `audit.csv`, `notices`, `new-times`, `public-profile`, `logo`, `about`, `about/draft`, `about/approve`, `hiring-contact`, `getting-started`.
- `auth`: `/sessions`, `/sessions/revoke-all`, `/sessions/:id/revoke`, `/reauth/start`.
- `roles/:id`: `/report`, `/report.csv`, `/report/summary.csv`.
- `admin/*`: customers, verification, job-boards, apply-flow, report, plan, runs, runs/:id/retry, ai-runs, failures, email-suppressions (+ release), alerts (+ acknowledge), integrations/:id/retry-deletion, costs, escalations, calendar (+ recalculate), queue, break-glass, staff-access, platform-roles (+ revoke), users/:userId/sessions/revoke, outcomes (+ correct), csp-reports (+ review).
- `admin/data-requests/*`, `admin/observability/test-error`.

**Machine endpoints**
- `/healthz` (app; `?strict=1` gives 503 on a stale worker), worker `:PORT/healthz`.
- `/webhooks/postmark/inbound|bounces|spam|events`, `/webhooks/twilio/inbound`, `/api/csp-report`.
- Outside production only: `/dev/outbox`, `/dev/sms-outbox`.

## 5. Data models and dependencies

| Table (migration) | Purpose | Relations |
|---|---|---|
| `communications` (0000, 0019, 0010) | Every inbound and outbound email or text: status queued, held, sending, sent, delivered, failed, bounced, complained, unknown, cancelled; idempotency key, retry links, attachments | company, candidate, application; `retry_of` points to itself |
| `jobs` (0000) | The queue: `communication.send`, `notification.email`, `email.retry`, `email.fallback_sms`, recurring jobs, workflow ticks | read by the worker; swept after 7 days (done) and 30 days (failed) |
| `worker_heartbeats` (0021) | One row per worker id, rewritten on every poll | platform table; the API role reads it, the worker writes it |
| `notifications` (+`emailed_at`, 0028) | One update per person | company, user |
| `notification_preferences` (0028) | Cadence per person, company and group | company, user; never deleted |
| `recruiter_escalations` (0000 and later) | Recruiter requests and ITS posting tasks: kind, urgency, SLA, context snapshot, billing, assignment | company, role, application, posting |
| `escalation_messages` (0029) | Thread: replies, answers, reopen notes | escalation; never deleted, rewritten when a candidate's data is deleted |
| `staff_access_grants` (0004) | Scoped, time-limited recruiter access; break-glass | user, company, escalation; the tenant role reads, the platform writes |
| `admin_alerts` (0006) | Operator alerts (open, acknowledged, resolved) | optional company and target |
| `audit_records` | Who did or looked at what, and why | company (nullable) |
| `events` | Domain facts; feeds analytics | company, subject |
| `email_suppressions` (0010) | The do-not-send list, platform-wide | none |
| `webhook_receipts` | One handling per provider event | none |
| `csp_reports` (0012) | Policy violation reports | none |
| `data_requests` (0009) | Privacy requests with deadline, counsel decision, verification | company, candidate, application, escalation |
| `plans`, `entitlements`, `usage_events` | Plan limits per company, running `used`, usage log | company |
| `invitations` (0022) | Team invitations, hashed token | company |
| `sessions` (+`reauthenticated_at`, 0024), `magic_links` | Sessions, re-authentication | user |
| `integrations` (+`secret_ref`, 0006) | Calendar connections; reference into the Vault | company, user |
| `platform_role_grants` (0011, 0014) | Ledger of platform roles | user |
| business calendar versions (0005) | ITS business hours used for reply-by times | none |
| `inbound_emails` | Email-in and reply intake log | company, application |

Dependencies:
- The worker (Railway) must run for any message, alert email, digest, retry or recurring sweep.
- Postmark is needed for email (outbound, inbound and webhooks); Twilio for SMS; Upstash for production rate limits; Supabase Vault for credentials; Sentry and PostHog are optional.

## 6. Roles and permissions in this area

Permissions come from `packages/core/src/permissions.ts` 44-74, staff and admin gates from `apps/api/src/middleware/session.ts` 75-90.

| Role | Can | Cannot |
|---|---|---|
| Owner | Everything below for admins; also grant or take away the owner role | Change the plan or allowances; cancel a recruiter request; see admin alerts or the content of privacy requests |
| Admin | Ask a recruiter; see and end recruiter access (`staff_access.revoke`); invite, change and remove members (admin and below); company settings and notices (with a recent sign-in); audit history and CSV; role reports and CSV; own notification settings; own sessions | Make someone an owner; change the plan |
| Hiring manager | Ask a recruiter; see the recruiter requests and access list; audit history (events.read); role reports and CSV; receives team updates by default | Manage members, company settings or recruiter access; change notices |
| HR | Ask a recruiter; manage members (not owners or admins); audit history; role reports; by API only, sign any teammate out everywhere, an owner included (`members.manage`, `company-settings.ts` 500) | Company settings; end recruiter access; not a default recipient of team updates (`notify` defaults to owner, admin, hiring manager) |
| Interviewer | Updates addressed to them (their interviews) | Role report (needs application.read), recruiter requests, audit history, team management |
| ITS recruiter (platform role `its_recruiter`, MFA aal2) | Recruiter queue; claim a request, which gives a scoped grant acting as membership role `recruiter`; thread; resolve or release their own requests; posting tasks; reports within the grant | Admin console; the customer's audit history; company settings; notification settings; claiming back a request after the customer revoked them; claiming a company-wide request nobody at the company chose |
| Platform admin (MFA aal2) | The whole admin console and its APIs; every recruiter power; resolve or release any request (by API, without claiming); privacy requests; plan and break-glass APIs; acknowledge alerts (not one about their own platform-role change) | Resolve an alert; requeue a failed job; release a spam-complaint suppression from the console (the API allows it; see bug 23) |
| Candidate | Privacy requests (status link or public form); reply HUMAN or STOP (inbound channels not live) | n/a |

## 7. Integrations and AI behaviour

**Integration status.** Code is the truth for "built". The staging state comes from `docs/runbooks/staging-environment-variables.md` and the project's session notes of 6 to 14 Oct; it cannot be verified from code.

| Integration | Built | Staging |
|---|---|---|
| Postmark outbound email | yes (`email/postmark.ts`) | **fake**: `EMAIL_PROVIDER=fake`; standing `email.fake` alert. A Postmark token was entered on the Railway worker on 6 Oct, but later notes still say email is fake. |
| Postmark inbound (email-in, replies) | yes | **not configured**: no inbound secret or real intake domain; replies go to the ITS mailbox |
| Postmark delivery webhooks (bounces, spam, subscriptions) | yes | **not connected** (needs Postmark) |
| Twilio SMS | yes | **off**: `SMS_PROVIDER=fake`, `SMS_ENABLED=false`, no A2P |
| Sentry | yes (Node and Next SDK, scrubbing) | **off**: no `SENTRY_DSN` |
| PostHog (server-side) | yes | **fake** |
| Upstash rate-limit store | yes | **live** (production boot requires it; staging `/healthz` OK after PR #29) |
| Supabase Vault | yes | configured (`SECRET_STORE=vault`) but holds nothing in practice: calendar is fake |
| ClamAV scanner | yes | **fake**; standing `scanner.fake` alert |
| Google Calendar | yes | **fake** |
| Railway worker | yes | **live and healthy** (session notes 13 and 14 Oct). Each merge needs a manual "Deploy" approval in Railway. |
| External uptime monitor on `/healthz?strict=1` | n/a | **unknown**, no evidence |
| Payments (Stripe or other) | **not built** | none |

**AI in this area is limited.**
- The only model call is the "about the company" draft in company settings (`services/company-settings-profile.ts` draftAbout). It is shown only after a person approves it.
- Notifications, digests, recruiter requests, reports and privacy handling make no AI calls.
- The admin console lists `ai_runs` with tokens and cost (Costs, AI runs). It withholds the output of runs about screening conversations a candidate never sent (`admin.ts` 171-176).
- Alert and digest emails never carry candidate names (`notify-email.ts` 125).

## 8. Tests present and missing

**Present (Vitest, against fake providers).**
- `apps/api/src/`:
  - Outbox and email: outbox (5), email-failures (6), email-gate (4), postmark-subscription (3), postmark-receipt-rollback (1), held-email-replay (2).
  - Notifications and recruiter loop: notifications (14), recruiter-loop (11), recruiter-requests (8), queue-preview (7), staff-access (8).
  - Worker and operations: maintenance (6), worker-health (4), job-failures (3), observability (3), observability-route (3), boot-cleanup, scanner-gate.
  - Privacy: privacy-requests (8), draft-privacy (4).
  - Security: rate-limit (14), csp (8), same-site (10), secret-lifecycle (6), platform-roles (8), mfa, inbound-auth, security-coverage.
  - Team, company and reports: team (13 to 17), company-settings (20), role-report (25).
- Packages: `packages/core/src/notify.test.ts`, `secrets.test.ts`, `recruiter-loop.test.ts`; `packages/integrations/src/email/postmark.test.ts`, `integrations.test.ts`.
- Web helpers: `tests/web/notifications.test.ts`, `recruiter-requests.test.ts`, `allowance.test.ts`, `today.test.ts`.
- Browser specs (CI only, never run on this machine): `tests/e2e/specs/notifications.spec.ts`, `recruiter-requests.spec.ts`, `revoke-access.spec.ts`, `staff-mfa.spec.ts`, `company-check.spec.ts`, `routes.spec.ts`.
- A full-suite run by the designated audit agent (`scratchpad/audit/vitest-baseline.txt`) was still in progress when this was written. The lines seen show rate-limit, role-report, worker-health, team, csp, platform-roles and privacy-requests passing.

**Missing or weak.**
- An acknowledged `worker.stale` or `queue.stale` alert should not block a later one. The tests "resolve" alerts with direct database updates (`maintenance.test.ts` 89-122), which the product cannot do.
- No allowance reset exists (screening conversations, recruiter requests), and no test for one.
- No test that system-raised recruiter requests (HUMAN reply, screening hand-off, failed workflow) reach the ITS mailbox. None do.
- No test of how long an interrupted send stays `sending` before the daily sweep.
- No test of a provider outage longer than the ~1-minute retry window.
- No test that the privacy deletion completion email is not sent when the transaction rolls back.
- No live provider contract tests (Postmark, Twilio, PostHog, Sentry). Everything runs on fakes.
- No UI tests for admin plan change, break-glass or failed-job requeue (none exist).

## 9. Bugs and incomplete features

1. **HIGH: monthly allowances never reset.**
   - `entitlements.record` only adds to `used`, and `applyPlan` keeps `used` (`packages/core/src/entitlements.ts` 46-57, 68-82). No job resets it.
   - Setup and the admin console label screening conversations "this month" (`apps/web/src/pages/Setup.tsx` 506; `Admin.tsx` 97).
   - `periodStart` and `periodEnd` (30 days) are written by `applyPlan` and never read, so a monthly reset was intended but never built.
   - Effect: every company that signs itself up starts on `trial` (`services/companies.ts` 40: 25 conversations, 1 recruiter request). Once a trial company has used its 25 conversations in its whole lifetime, each later applicant's conversation link waits. It is checked every 6 hours and dropped after 60 days. The applicant then gets a "not going ahead" note and the team gets the application to review by hand (`screen.ts` 121-145). Its recruiter requests stay "over" and keep the billing alert standing. The only fix is a database edit or an API plan change that raises `limit`. Design Partner companies are never stopped.
2. **HIGH (operations): an acknowledged alert silences its kind for good.**
   - `raiseAlertOnce` treats `acknowledged` as still standing (`alerts.ts` 21). There is no resolve route or button (`admin.ts` 246-254; `Admin.tsx` 377).
   - Effect: after an admin acknowledges one `worker.stale` (or `queue.stale`, `email.fake`, `scanner.fake`), a later worker outage raises nothing. The `email.fake` alert says "then resolve this alert", which nobody can do.
3. **MEDIUM: a provider outage longer than about one minute fails messages for good.**
   - `SEND_MAX_ATTEMPTS` is 6 (`outbox.ts` 29) and the engine backoff is `min(60 s, 2^n s)` (`engine.ts` 177). The retries span roughly 62 s.
   - Effect: during a short Postmark incident, screening invitations, interview times and status links are marked failed. The team gets one "could not be delivered" notice per candidate and ITS one high alert per message. Nothing is sent again automatically.
4. **MEDIUM: system-raised recruiter requests never reach the ITS mailbox.**
   - `createEscalation` does not email (`packages/core/src/escalations.ts` 18-68). Only the routes `POST /escalations`, `roles.ts` 831, `review-apply.ts` 212 and the stuck-role ladder do.
   - Verification found more silent callers: three interview times all taken at booking (`schedule-interview.ts` 249), a cancelled interview on a role ITS has taken over (`new-times-reopen.ts` 192), the untold-decision safety net (`decision-messages.ts` 304), and a privacy human review (`privacy-requests.ts` 432).
   - Effect: a candidate who replied HUMAN, or asked for a person mid-screening and was promised a person "within four hours", is seen by ITS only if someone happens to open `/recruiter/queue`. The same goes for failed workflows, eligibility holds, failed bookings and untold decisions. Nothing alerts when the reply-by time passes (bug 22).
5. **MEDIUM: interrupted sends are detected only once a day.**
   - `sweepStaleSending` runs only inside `maintenance.daily` (`maintenance.ts` 53), although `SENDING_STALE_MS` is 15 min.
   - Effect: a decision message stuck in `sending` leaves the team seeing "Waiting to go out" and the candidate "not told" for up to a day.
6. **MEDIUM: alerts reach nobody outside the console.**
   - No email, pager or chat is sent for any alert (`alerts.ts` 7-10).
   - `worker.stale` can only be raised from the app's `/healthz`, or by the worker itself, which cannot report its own death. No uptime monitor is evidenced.
   - Effect: a stopped worker, and with it all email, reminders and application processing, can go unnoticed until someone opens Admin -> Failures.
7. **LOW-MEDIUM: direct sends ignore failures and leave no record.**
   - `emailItsQueue` ignores the send result (`services/escalation-queue.ts` 22-31). So do the reopened-request queue email (`approvals-escalations-events.ts` 339-346) and the "access ended" queue email (`routes/companies.ts` 172).
   - None are written to `communications`. A Postmark failure loses the ITS notice silently.
8. **LOW: the deletion completion email can claim a deletion that did not happen.**
   - The email is sent directly inside the platform transaction, before commit (`privacy-messages.ts` 51-55, called inside `withPlatform` in `routes/privacy-requests.ts` 134-137). The result is ignored and `confirmationSentAt` is set anyway.
   - Effect: if the transaction fails afterwards, the candidate is told their data was deleted while the anonymisation rolled back.
   - The stored files are also deleted through `deleteFile` inside the same transaction (`routes/privacy-requests.ts` 135). After a rollback the files are gone but the records still point to them.
9. **LOW: customers cannot cancel or close their own recruiter requests.**
   - Stale requests, including "stopped after N tries" ones, stay on Today until ITS resolves them.
   - Admin "Retry" of a failed run does not close the request it raised (`admin.ts` 190-198).
10. **LOW: a company-wide request not made by a team member is stuck in the UI.**
    - Claiming it is refused with "An ITS administrator can resolve it from the console" (`approvals-escalations-events.ts` 454). The console has no such button; the queue's Resolve card appears only after access is granted (`RecruiterQueue.tsx` 274). It can be resolved by API only.
11. **LOW: failed jobs cannot be requeued.** They are listed with no action, although the `job.failed` alert says "retry or re-queue it" (`engine.ts` 196; `Admin.tsx` 397).
12. **LOW: analytics can count events that never happened.** The event sink fires inside the transaction before commit (`packages/core/src/events.ts` 50-56). Rolled-back or retried steps would send phantom funnel events once PostHog is on.
13. **LOW: an `unknown` delivery is shown as a failure.** The candidate thread shows `unknown` as "Could not be delivered" (`apps/web/src/telling.ts` 294), but the message may have arrived. `complained` falls to the default, so the team sees nothing and the message looks delivered.
14. **LOW: the seat limit is not enforced.** The trial plan's limit of 3 is shown in Setup but nothing counts or enforces it.
15. **LOW: "sign a teammate out everywhere" has no button** (`routes/company-settings.ts` 498-516). It is guarded by `members.manage`, which HR also holds, so by API an HR member can sign an owner or admin out everywhere.
16. **LOW: `/healthz` is public and not rate-limited.** Each call runs a database query, and the answer exposes queue depth and the AI provider id (`app.ts` 97-113).
17. **LOW: false stale-worker alerts.**
    - The heartbeat is written once per loop, before up to 25 jobs (`worker.ts` 26-27). A batch of long AI steps (intake compile took 111 s on staging) can exceed the 10-minute threshold and raise a false `worker.stale`.
    - The worker's own `/healthz` goes 503 during any job longer than about 31 s.
18. **LOW: the customer's audit history omits some actions that concern them.** Examples: message sent or undone, notification preference changes, ITS changing the apply flow, ITS changing the plan (`plan.changed`), escalation previews, and a recruiter opening a request's full context (`escalation.context_viewed`) (`services/audit-history.ts` 8-18). A comment says previews are "audited for the customer" (`approvals-escalations-events.ts` 361).
19. **LOW: a privacy "human review" does not close itself.** It is not closed when its recruiter request resolves, although the comment says it is (`privacy-requests.ts` 420). An admin must fulfil it by hand.
20. **LOW: retention gaps.**
    - The access-request export JSON is kept forever in `communications.attachments`.
    - Unmatched or failed `inbound_emails` keep their parsed text.
    - No candidate-data retention job exists; this waits on counsel.
21. **LOW: no request timeout on the Postmark and Twilio adapters.** They rely on Node defaults (about 5 min), and the worker runs jobs one at a time.
22. **MEDIUM: nothing alerts when a recruiter request passes its reply-by time** (added in verification).
    - The only use of "overdue" is a count in the role report (`services/role-report.ts` 450). No job, alert or email fires when `sla_due_at` passes. `docs/16-admin.md` lists an SLA-breach alert.
    - Effect: together with bug 4, a candidate promised a person within four business hours can wait days, and the ITS team is never prompted.
23. **LOW: the "spam complaint is never released" rule is UI-only, and `emailOptOut` is never read** (added in verification).
    - `releaseSuppression` (`packages/core/src/email-suppression.ts` 51-57) and `POST /admin/email-suppressions/:id/release` (`admin.ts` 234-241) release any active suppression, a spam complaint included. Only the disabled button in `Admin.tsx` 389 stops it.
    - `candidates.preferences.emailOptOut` is set on a complaint or unsubscribe (`email-failures.ts` 49, `email-subscriptions.ts` 29) but no send path reads it.
    - Effect: one API call puts a person who reported spam back on the mailing path, against their wish.
24. **LOW: the in-memory do-not-send list can miss addresses** (added in verification).
    - `listSuppressions` returns at most 500 rows (`email-suppression.ts` 59-61). Each process loads that list into memory and reloads it every minute by clearing the map first and then awaiting the query (`container.ts` 118, 286).
    - Effect: past 500 suppressed addresses, the oldest are emailed again. During every reload there is a short window in which no address is suppressed. This is negligible at pilot scale but grows with volume.
25. **LOW: failed email-in applications are "queued for review" but nobody can see them** (added in verification).
    - `webhooks/postmark.ts` 76-78 marks an inbound email `error` and answers "queued for review". `inbound_emails` is read nowhere outside the webhook and `services/replies.ts`: no admin or customer screen lists unmatched or failed ones.
    - Effect: once email-in is live, an applicant whose emailed application failed to import is lost silently.

## 10. Doc and code drift

- **`docs/16-admin.md` views table (lines 9-22)** promises many views and actions that do not exist:
  - Views: cross-tenant Roles and Candidates search, API failures, Customer activity, Support issues, Prompts and evals, Playbooks.
  - Actions: impersonation, adjusting entitlements and adding credits, cancel or escalate a run, bulk retry, mark resolved, convert to takeover.
- **`docs/16-admin.md` line 3** says every read is audited "with the reason the admin entered". The console always sends the fixed header "admin console" (`Admin.tsx` 16).
- **`docs/16-admin.md` "Operational alerts"** lists queue age above 5 minutes (code: 30 minutes, `maintenance.ts` 30). It also lists escalation SLA breach, AI error spike, cost anomaly, adapter health and unmatched inbound growth alerts; none exist.
- **`docs/spec/07-api-specification.md` 188-191** lists `/admin/users/:id/platform-role` (code: `/admin/platform-roles` and `/:grantId/revoke`), `/admin/spend`, `/admin/customers/:id/spend-cap` and `/admin/calendar-connections/:id/probe`; none exist. Line 192 says break-glass is 403 "until MFA exists"; MFA now exists.
- **`docs/12-api-contracts.md` 229-230** lists `/admin/activity`, `/admin/runs/:id/cancel` and a tenant `/ai-runs/:id`; none exist.
- **"This month" labels for allowances** (Setup, Admin, `docs/16-admin.md` 37-38, `docs/06` 211 "waits for the allowance to be topped up"). Nothing resets the counter, and there is no top-up path in the product.
- **`apps/api/src/worker.ts` header** says "Railway probes it and restarts the worker on 503". `railway.json` sets a deploy-time health check and `ON_FAILURE` restarts, and the loop never exits on error. A worker that stalls is likely not restarted (unverified).
- **Alert texts promise actions the console lacks:** `email.fake` says "resolve this alert" (`email-gate.ts` 21); `job.failed` says "retry or re-queue it" (`engine.ts` 196).
- **`packages/core/src/privacy-requests.ts` 420:** "the request closes when the escalation resolves" is not implemented.
- **`approvals-escalations-events.ts` 361:** "Every preview view is audited for the customer". The record carries the company id, but the customer's audit history does not show it.
- **`docs/customer/02-security-overview.md` 15-20** lists Postmark, Sentry, PostHog and the malware scanner as subprocessors in use. On staging all four are fake or off; line 142 caveats this.
- **`docs/STATUS.md` (9 Oct)** describes the Kanvis and Cancelled work as unmerged branch work "on mocks". The code is merged to main, and staging now runs the real Anthropic model; the email-fake statements still hold.

## 11. Unknowns

- The exact `EMAIL_PROVIDER` value on Vercel and on the Railway worker today. The runbook and the 13-14 Oct notes say fake; a Postmark token was entered on Railway on 6 Oct.
- Whether any external uptime monitor polls `/healthz?strict=1`, and whether anyone at ITS watches Admin -> Failures or the ITS queue mailbox on a schedule.
- Whether Railway restarts the worker on a failing health check after deploy. Its documentation describes health checks as deploy-time only.
- Whether `SENTRY_DSN` has been set anywhere since 22 Sep. The runbook says not.
- Whether the admin audit middleware (`adminRoutes.use("*")`) also covers `/admin/data-requests` and `/admin/observability`, which are mounted as separate sub-apps under the same prefix. Verification: very likely yes. Hono's `app.route("/api/v1/admin", adminRoutes)` registers that middleware at `/api/v1/admin/*`, which also matches the sub-apps mounted later (`app.ts` 136-138). This was not exercised at runtime here.
- The latest CI results for the browser specs in this area. Main requires the `verify` check, so merged PRs passed it.
- Whether any staging or pilot company has been moved off the `trial` plan. This is only possible by API.
- Counsel's retention periods (`docs/readiness/09` is proposed only), which decide candidate-link expiry and data deletion.
- How the Postmark and Twilio adapters behave against the real services (payload shapes, webhook signing URL behind Vercel). They are tested only against fakes and unit fixtures.

## 12. Verification notes

A skeptical second pass (14 Oct 2026) re-read the code behind every bug and every non-complete status, and traced the following end to end from UI to API to service to DB:
- OPS-01 outbox, OPS-02 Undo, OPS-03 company-check hold and release.
- OPS-08 Updates, OPS-09 alert emails and digests.
- OPS-10 Ask a recruiter, OPS-11 queue (claim, resolve, release, thread), OPS-14 revoke recruiter access.
- OPS-20 audit history and CSV, OPS-21 admin tabs (shell `admin/page.tsx` -> `Admin.tsx` -> `admin.ts`).
- OPS-24 platform roles, OPS-25 team, OPS-28 sessions.
- OPS-30 role report and CSV (`RoleDetail.tsx` 278 -> `RoleReport.tsx` 55-56 -> `reports.ts`, mounted `app.ts` 127).
- OPS-31 customer report, OPS-33 privacy requests.
- OPS-16 worker health, OPS-17 recurring jobs.

All of these held. The claimed test files exist with the stated test counts.

**Bugs confirmed as written:** 2, 3, 5, 6, 7, 9, 10, 11, 12, 14, 16, 17, 19, 20, 21. Notes on some of them:
- Bug 2: `raiseAlertOnce` counts `acknowledged` as standing. `resolveAlertsFor` exists but only credential-deletion and privacy code call it.
- Bug 3: 6 attempts with a backoff of `min(60 s, 2^n s)` give about 62 s.
- Bug 6: no Vercel cron, no GitHub Actions check and no uptime monitor in the repo.
- Bug 10: Resolve is available to a platform admin by API (`approvals-escalations-events.ts` 532) but the queue's Resolve card renders only after a grant.

**No bug was refuted.** Changes made:
- **Bug 1, effect corrected.** Conversation links do not wait "for good". They are re-checked every 6 hours and dropped after 60 days with a note to the applicant (one-visit) and the application sent to review. Design Partner companies are never stopped. Added that `periodStart` and `periodEnd` are written and never read. Severity stays high.
- **Bug 4, OPS-12, OPS-13 extended.** Four more silent sources of automatic recruiter requests: failed booking, a cancellation under ITS takeover, the untold-decision safety net and a privacy human review.
- **Bug 8 extended.** Files are also deleted from storage before commit.
- **Bug 13 refined.** `complained` shows as normal or delivered, not just "no label".
- **Bug 15 and OPS-26 corrected.** The route allows HR too (`members.manage`), not only owner and admin.
- **Bug 18 extended.** `plan.changed` and `escalation.context_viewed` are also missing from the customer's history.
- **Section 3.3, the roles table and OPS-06 corrected.** "A spam complaint can never be released" is only a disabled button. The API releases one, and `emailOptOut` is never read (new bug 23).
- **OPS-09 clarified.** "Unsubscribe" is a settings link plus the Postmark event. There is no one-click unsubscribe.
- **OPS-33 note.** On staging the public privacy form cannot be completed, because its confirm link is only emailed.
- **New bugs:** 22 (no SLA-breach alert, medium), 23 (spam release and `emailOptOut`, low), 24 (500-row cap and reload window on the do-not-send list, low), 25 (failed email-in applications "queued for review" with no screen, low).
- **New summary risks:** the SLA-breach gap, and on staging new self-signed-up companies waiting unseen. A fake email reports "sent", so the fallback alert in `company-trust.ts` 124-126 never fires.
- **Features the first pass missed:** OPS-42 stuck-role nudge ladder (fully_implemented), OPS-43 "Lost your link?" resend (fully_implemented, email only), OPS-44 SLA-breach alert (planned_not_implemented).
- **Unknown on the admin audit middleware:** resolved to "very likely yes" from Hono's route merging.
- **Statuses kept.**
  - OPS-04, OPS-07, OPS-19, OPS-32 and OPS-37 stay "partial" in the sense of built but not configured or live. A product audit may prefer to describe them as "built, switched off".
  - OPS-15, OPS-22, OPS-23, OPS-29 and OPS-36 are correctly partial.
  - OPS-38 to OPS-41 are correctly planned_not_implemented: no route or code exists.
