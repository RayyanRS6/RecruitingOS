# Staging verification checklist

Run on the staging deployment after the accounts in `docs/spec/13` exist and `docs/spec/17-staging-handoff.md` has been completed. Staging never meets a real applicant: its careers pages are not linked or listed anywhere, its inbound application address is a test address, Google's listing is requested for production only, and every person acting out a role is an ITS-owned test identity (`docs/readiness/16` gate 2.9). Paul does every step that needs a secret or a dashboard login; the production team does the rest and checks every result. Every line is ticked by a person with the date and a link to the evidence (screenshot, log line, test output). Nothing here is done today: every item is **Not started** until staging exists.

## 1. Deployment

- [ ] Vercel project builds `apps/shell` from the private repository; preview and production environments separated.
- [ ] Environment variables set from `docs/spec/13` appendix A, names only checked against `.env.example`; no `NEXT_PUBLIC_*` secret; `AUTH_PROVIDER=supabase`, `SECRET_STORE=vault`, `AI_PROVIDER=anthropic`, `EMAIL_PROVIDER=postmark`, `CALENDAR_PROVIDER=google`, `WORKER_INLINE=false`.
- [ ] Worker process running with `WORKER_DATABASE_URL` (as `ros_worker`); `/healthz` reports `worker: external`.
- [ ] Boot check passes: the API connects as `ros_app`; "refusing to start" never appears.

## 1a. Résumé storage (decision 2; `docs/runbooks/resume-storage.md`)

- [ ] `STORAGE_PROVIDER=supabase` on Vercel and Railway; bucket `resumes` is Private with an 8 MB limit and the four allowed types; `SUPABASE_SERVICE_ROLE_KEY` still absent everywhere.
- [ ] A browser apply with a PDF lands under `quarantine/` and then under the company prefix; the row goes `quarantined` → `clean`; the owner opens it from the candidate page and `document.read` is audited.
- [ ] A renamed program is refused (`executable`), the EICAR file is refused (`infected`), both removed from the bucket; a fulfilled deletion removes the file and audits `document.deleted`.
- [ ] No `connect-src` policy report names the storage origin; no public URL exists for any object.

## 2. Database

- [ ] `scripts/staging-db-setup.sh` run by the founder on her own machine: migrations applied, `ros_app` and `ros_worker` passwords set, Vault grants applied, both roles verified by the script (evidence: the script's `provision:` and `verified:` lines, pasted without the connection strings; `scripts/staging-db-status.sh` output showing no pending migrations and the Vault grants in place).
- [ ] Every migration in `packages/db/migrations` applied with `MIGRATE_DATABASE_URL` from a trusted machine (the runner enforces contiguous numbering); `scripts/staging-db-status.sh` shows none pending.
- [ ] `provision-roles.sql` and `vault-grants.sql` applied; `select current_user` is `ros_app` from the API and `ros_worker` from the worker.
- [ ] `pnpm test` suites `rls.test.ts`, `tenancy.test.ts`, `security-coverage.test.ts`, `outcomes.test.ts`, `privacy-requests.test.ts` and `core.test.ts` run against staging Postgres (test database) and pass.
- [ ] Point-in-time recovery enabled; a restore into a scratch project completed (`05-backup-and-recovery.md`).

## 3. Sign-in

- [ ] The staging project's redirect allow list carries `https://<staging host>/api/v1/auth/callback` and the Site URL is the staging origin (Authentication, URL Configuration); TOTP is enabled under Authentication, Multi-Factor; the Azure provider is enabled with the client id and secret entered by Nadine and an empty tenant URL.
- [ ] The staff second-factor step (built 22 Sep: `apps/api/src/mfa.test.ts`, `tests/e2e/specs/staff-mfa.spec.ts`) works on the staging identity service: enrolment on the first sign-in, the backup offer, a code at every sign-in, five wrong codes ending the attempt, and one dashboard reset recorded as `mfa.reset_detected` (`docs/runbooks/staff-second-factor.md`).
- [ ] Google sign-in as a test customer; Microsoft sign-in as an ITS staff member with TOTP; a staff attempt without a second factor is refused with the plain message.
- [ ] A test company is created through the form, the Design Partner plan applied, and a team member invited and accepted; the owner, hiring-manager and interviewer views differ as the permission table says.
- [ ] `BOOTSTRAP_ADMIN_EMAILS` made the first administrator on that person's first Microsoft sign-in with a second factor (ledger row with source `bootstrap`, audit record present); the variable was then removed; the second administrator was granted in the console by the first; the alert about that grant stays open (neither of the two may acknowledge it) and the email to the queue mailbox is the record until a third administrator exists (`docs/readiness/13-administrator-bootstrap.md`).
- [ ] Break-glass works only inside fifteen minutes of a second factor, is audited, and shows in the customer's access history; an administrator cannot grant themselves a role (the product refuses).
- [ ] A recruiter accepts a request and sees only that role; the customer ends the access from Setup; the recruiter's next request is refused, the recruiter is emailed, and the customer's access history shows who, when and why.
- [ ] Recruiter and administrator routes refuse a session without a second factor; the email link refuses a platform-role holder.

## 4. Email

- [ ] Postmark server token in place; `EMAIL_FROM_ADDRESS=updates@hire.identifiedtalent.com`; SPF, DKIM, DMARC on `hire.` pass (Postmark dashboard shows verified).
- [ ] A test application produces an acknowledgment in a real mailbox with the disclosure text; an eligibility "no" holds the candidate for the owner's decision (nothing is sent), triage places the eligible one in the owner's list, and no rejection happens without a person.
- [ ] The careers page lists the open role, the job page shows the notices, and the job feeds answer with the same roles.
- [ ] Inbound: a forwarded application to the role's intake address becomes an application.
- [ ] Bounce and spam-complaint webhooks configured with `POSTMARK_WEBHOOK_SECRET`; a hard bounce to a test address suppresses it, notifies the owner, texts nothing (SMS off), and shows in the admin console; a spam complaint simulated with Postmark's webhook test button on the staging server suppresses the address the same way (evidence: the suppression row and the console entry).
- [ ] A privacy request from a test candidate's status link is acknowledged by email, appears in the console's Privacy requests tab, is fulfilled, and the completion email arrives; a repeat submission creates nothing new.
- [ ] Google for Jobs: the job page's structured data validates in Google's test tool and the listing request is submitted (verification takes weeks; record the date).

## 5. Calendar

- [ ] Google Cloud OAuth client (Calendar API only, scopes `calendar.events` and `calendar.freebusy`); consent screen in testing mode with the ITS test accounts.
- [ ] A test interviewer connects a real Google calendar; free/busy reflects a real busy block; a booked interview creates exactly one event with a Meet link; cancel removes it; disconnect deletes the credential from Vault (audit `credentials.deleted`).
- [ ] Revoking the app in the Google account settings makes the next scheduling fall back to declared hours and alerts the person.
- [ ] Google's review of the calendar sign-in client is requested (it can take weeks; record the date).

## 6. Secrets and observability

- [ ] Vault holds the calendar credential; `secret.read` audits show purpose and integration; `SUPABASE_SERVICE_ROLE_KEY` is absent from every environment.
- [ ] Sentry DSN set; a forced error arrives scrubbed (no cookie, no token, no email); `sendDefaultPii` false.
- [ ] PostHog receives only the allow-listed events with keyed references; the candidate pages load no analytics script (network tab).
- [ ] The rate-limit provider the founder chose is connected; the console shows no "Rate limits are not shared between processes" alert; a burst of sign-in attempts from one address is refused with a plain 429.
- [ ] The browser-protection policy is in report-only; after the review period, every report in the console carries a disposition; the founder switches staging to enforce and the journeys are repeated.

## 7. Workflows and timers

- [ ] Screening invitation, reminder and expiry timers fire on schedule for a test candidate (clock not faked); replying HUMAN or using "Talk to a person" opens a request for a person and the candidate is told when to expect an answer.
- [ ] Interview reminders at −24 h and −2 h arrive; the interview closes an hour after its end.
- [ ] Recruiter escalation reaches the ITS queue mailbox with the generic summary only; the queue preview shows the generic summary and nothing from the candidate.
- [ ] The seven AI evaluation suites run with `AI_PROVIDER=anthropic` and score at or above their thresholds (report file in `packages/evals/results`).
- [ ] A hire, a withdrawal and a decline are recorded on a test candidate; the outcome statement the founder confirmed on the laptop version reads the same on staging; an administrator corrects one outcome and the correction is recorded.

## 8. Accessibility and browsers

- [ ] `pnpm e2e` against the staging URL (`E2E_BASE_URL`) passes on desktop and phone projects.
- [ ] Manual pass of `11-accessibility-checklist.md` on the staging URL with a screen reader.

## 9. Sign-off

| Area | Verified by | Date | Evidence |
|---|---|---|---|
| Deployment | | | |
| Database | | | |
| Sign-in | | | |
| Email | | | |
| Calendar | | | |
| Secrets and observability | | | |
| Workflows and timers | | | |
| Accessibility | | | |
| Sign-up, company, team and plan | | | |
| Texting off (SMS_PROVIDER=fake; no opt-in offered) | | | |
| Recruiter access and administrators | | | |
| Privacy requests | | | |
| AI evaluations on the live model | | | |
| Outside verifications (Google) requested | | | |
