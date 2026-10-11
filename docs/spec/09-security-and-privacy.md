# 09. Security and privacy design (release 1)

Builds on `docs/08-compliance-and-security.md`; this document is the release-1 commitment with the fixes from the decisions register (S-items) and the counsel questions (C-items). Not legal advice.

## 1. Assets and trust boundaries

Assets: candidate PII (name, contact, location, resume, answers, screen transcripts), assessments, employer data (packets, compensation), calendar credentials, session credentials, AI run records, audit and event logs. Boundaries: public internet → API (candidate pages, webhooks, OAuth callbacks); web app → API (session); API/worker → Postgres (tenant role with RLS); worker → providers (Anthropic, Postmark, Twilio, Google, Microsoft, BLS); platform admin → admin API (audited).

## 2. Identity and sessions

- Delegated sign-in (D19, correction 4; built 18 Sep with a fake issuer): Google and Microsoft (Entra, identity scopes only) are configured in Supabase Auth. The API starts a PKCE authorization-code flow (`GET /auth/start/:provider`; the verifier lives in an httpOnly cookie), receives the single-use code at `GET /auth/callback`, exchanges it server-side, verifies the access token against the issuer (HS256 with the project secret or the project's published RS256/ES256 keys; issuer, audience, expiry, subject all checked; `packages/integrations/src/identity`), applies the sign-in policy, and opens its own session. The provider's token is never stored, logged, or returned. `POST /auth/session` accepts a verified token for native clients and tests.
- Sign-in policy (`packages/core/src/identity.ts`): a verified email is required; ITS staff (platform role `its_recruiter` or `platform_admin`, or an address on `ITS_STAFF_EMAIL_DOMAINS`) must sign in through Microsoft and with a second factor (`aal2`); refusals are audited (`signin.refused`) without the token; staff sessions last eight hours (I8), customer sessions thirty days sliding. The session records the provider, the assurance level and when the second factor was verified; break-glass (D25) now requires that timestamp within fifteen minutes and is exercised end to end with the fake issuer.
- The fake issuer (`FakeIdentityProvider`) mints tokens in the managed service's format and serves a development consent page at `/auth/fake/authorize`; production refuses `AUTH_PROVIDER=fake` and requires `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
- Magic links (kept for development and, where enabled, customer fallback; production defaults to off): 256-bit random, SHA-256 hashed at rest, 15-minute single use, rate-limited per IP and per email, consumed on a top-level navigation that sets the cookie; never issued to a staff domain.
- Sessions: 256-bit random, hashed, 30-day sliding idle expiry, revocation on logout, on role change, on removal, and from the new session list (S11); IP and user agent recorded.
- Re-authentication (fresh link within 10 minutes) required for policy changes, notice edits, member removal, and calendar disconnect of another user (D12).
- Platform roles set only by a platform admin through an audited endpoint; the first admin is seeded from the deployment shell.
- MFA: required for ITS staff from release 1 through the identity service's TOTP (`aal2`); customer administrators before general release; SSO with the Company tier.

## 3. Tenancy and data access

- Row-level security on every tenant table; tenant work runs as `app_tenant` with `app.company_id` set per transaction; cross-tenant tests in `packages/db/src/rls.test.ts` extend to the new tables.
- Production database roles (implemented in `migrations/0003_platform_roles.sql`): the owner role runs migrations only (`MIGRATE_DATABASE_URL`); `ros_app` (API) and `ros_worker` (workflow and integration worker) are `NOSUPERUSER NOBYPASSRLS` login roles that own nothing, may switch to `app_tenant`, and differ in one privilege (only the worker claims jobs; only the worker will read integration secrets); the boot check refuses a superuser or RLS-bypassing connection in production. Platform paths run with `app.platform = 'on'`, a clause every policy honours only for roles other than `app_tenant`; tenant transactions switch to `app_tenant`, clear the flag, and are isolated by `app.company_id` regardless.
- Platform paths (`withPlatform`): auth, webhooks, OAuth callbacks, the worker's queue claim, admin routes. Each admin read writes `audit_records` with a reason that is required in production (S10).
- ITS recruiters (S2, D11): tenant access only while holding a claimed escalation; every tenant read by staff is audited as `tenant.viewed_by_staff` and appears in the customer's timeline.
- Object-level checks: interviewers see only their interviews and those applications; compensation redacted without `compensation.read`; candidate tokens scoped to one application.
- Recruiter queue before acceptance (correction 11): responses, the queue notification email, and the grant purpose carry only the customer name, role title, category, urgency, required expertise, remaining service-level time, and a template summary chosen by category. The customer's words and everything from a candidate record open only under a grant. `packages/core/src/escalation-preview.ts` defines the allowed field list and the forbidden keys; `apps/api/src/queue-preview.test.ts` builds a request that names a candidate, their contacts, pay, and resume and proves every pre-acceptance surface is clean.

## 4. Secrets and credential encryption (S3)

- Platform secrets in the host's secret store; never in images or logs.
- OAuth credentials are stored in a managed key-management service, not with application-side cryptography (founder decision F1; default Supabase Vault, D21): the application keeps only the secret id; only the worker role can read secret values; the API role cannot. Rotation and key custody belong to the service.
- Tokens are decrypted only inside the worker step or the callback that needs them, held in memory, never logged, never returned by any API; deleted on disconnect, on membership removal, and after three failed health probes.
- Secret lifecycle (correction 10, built 18 Sep): every store, read, rotation and deletion goes through `packages/core/src/secrets.ts` and writes an audit record (`secret.stored`, `secret.read`, `secret.rotated`, `secret.deleted`, `secret.delete_failed`) with service, purpose, tenant, integration and time; the record holds a fingerprint of the reference, never the value. Values read in a process are registered so that `guardOutbound` refuses (outside production) or scrubs (in production) any event payload or audit record that would carry them; the error handler, the request logger, the PostHog adapter and the Sentry `beforeSend` scrubber (`packages/integrations/src/observability/sentry.ts`) apply the same redaction by value and by shape (`packages/contracts/src/security/redact.ts`).
- Disconnecting (`POST /integrations/:id/disconnect`) makes the connection unusable immediately (`readConnectionSecret` refuses every purpose except revocation) and queues `integration.revoke_and_delete` for the worker, the only role that can read the value: read (audited, purpose `revocation`), revoke at the provider, delete from the store, clear the reference, audit `credentials.deleted`, emit `integration.credentials_deleted` to the customer. A failed deletion raises an `admin_alerts` row (severity high, critical after the last attempt), sets the connection to `manual_action_required`, emits `integration.deletion_failed`, and retries with backoff; the admin console shows the alert with acknowledge and retry. Tests: `apps/api/src/secret-lifecycle.test.ts`, `packages/core/src/secrets.test.ts`, `packages/integrations/src/integrations.test.ts` (observability scrubbing).
- OAuth scopes: Google `calendar.events` and `calendar.freebusy` (no full calendar read); Microsoft `Calendars.ReadWrite` limited to the chosen calendar plus `User.Read`; the connection card shows the scope in plain words.

## 5. Public surface hardening

- Candidate pages: CSP with nonces (S7), `Referrer-Policy: no-referrer` (Hono's own, see "Referrer policy" below), `X-Robots-Tag: noindex` on token pages, CSRF token on forms (S8), HSTS, secure cookies.
- Referrer policy: the application's pages send `strict-origin-when-cross-origin` (`apps/shell/next.config.ts`). The paths mounted on Hono keep Hono's own value, because Next.js keeps a configured header over the one a route sets, so the shell configures none there: `no-referrer` on candidate pages and API responses, and `same-origin` on the API's own form pages (the sign-in link, the invitation, the second factor, the development consent pages; `apps/api/src/middleware/same-site.ts`), whose posts then carry their real `Origin` (section 6) while nothing is sent to another site. `apps/shell/lib/headers.test.ts` checks that no configured header replaces one Hono sets.
- Framing: no other site may frame the application. Every page of the signed-in application sends `X-Frame-Options: DENY` (`apps/shell/next.config.ts`) beside its policy's `frame-ancestors 'none'`, so the refusal holds while `CSP_MODE` is report-only; nothing frames those pages. The paths mounted on Hono (API, candidate pages, links, webhooks, feeds, files) are left to Hono's own `SAMEORIGIN`, which the résumé framed from `/api` inside the candidate panel needs; `apps/shell/lib/headers.test.ts` checks both against the routes in `apps/shell/app`.
- Tokens (S4): 192-bit; screen and schedule tokens expire; status tokens rotate on request; request logs redact any path segment matching a token pattern; error tracking scrubs URLs.
- Rate limits (S5): fixed windows in the shared Upstash counter (decision 4; `docs/readiness/15`), shared across processes; the production app refuses to start unless `RATE_LIMIT_STORE=upstash` with its address and token (the worker counts no requests), and an Upstash that cannot be reached at run time degrades to per-process counting with an alert, never to no limit; per IP for apply, magic link, schedule, screen; per intake address for email-in; the forwarding header trusted only from the platform proxy.
- Uploads (S6): 8 MB, PDF/DOCX/text by MIME and extension, stored in object storage under a per-tenant prefix, text extraction in the worker with CPU and memory limits, no execution, scanning adapter present with status `disabled` and shown as such.
- Webhooks: Postmark secret in a header only (S12); Twilio signature; Google/Microsoft push tokens; all idempotent.
- Bots: honeypot, timing check, duplicate suppression.

## 6. Application security

Zod on every boundary; parameterized queries through the ORM; output encoding in server-rendered pages; a cross-site check on every change under `/api` (below); dependency lockfile with `pnpm audit` in CI and a monthly upgrade window; least-privilege database grants; no dynamic SQL except the queue claim.

Cross-site request forgery (S8; security review, 11 October 2026): the session cookie is `SameSite=Lax`, and every change under `/api` (POST, PUT, PATCH, DELETE) is refused with 403 `cross_site` before the session is read when the browser's `Sec-Fetch-Site` says `cross-site`, or when an `Origin` header names an address other than the deployment's own (`APP_BASE_URL`, and `JOBS_BASE_URL` once the job pages have their own host), which also stops a sibling host of the same site. `Origin: null` names no site, so it passes only with `Sec-Fetch-Site: same-origin`: a sandboxed frame or a `no-referrer` page on a sibling host sends it too, and a browser without fetch metadata (Safari before 16.4) would otherwise let it through with the Lax cookie. The API's own form pages send `Referrer-Policy: same-origin` (section 5), so every browser posts them with their real origin. A request with neither header passes: older browsers, and callers that are not browsers, which still need the cookie a browser withholds from another site. Reads are never refused, so no GET under `/api` changes anything (the privacy-request deadline check is a POST), and nothing under `/api` is exempt: the sign-in and calendar callbacks are GET, webhooks live under `/webhooks`, and the policy reports come from the deployment's own pages. `apps/api/src/middleware/same-site.ts` (the second-factor step shares the check), tested in `apps/api/src/same-site.test.ts`.

## 7. Logging, monitoring, incidents

Structured logs (pino) with a redaction list (tokens, emails in URLs, authorization headers, OAuth codes); error tracking with PII scrubbing; health endpoints for API and worker; alerts on failed runs, queue age above 5 minutes, adapter health, AI error rate, cost anomalies, escalation SLA breaches, calendar connection failures. Incident response: an on-call owner, a runbook (triage, contain, notify, review), customer notification templates within 72 hours for confirmed personal-data incidents (C7 sets the contractual term).

## 8. Backups and recovery

Managed Postgres point-in-time recovery (RPO 15 minutes, RTO 4 hours); object storage versioning; quarterly restore drill in staging; migrations forward-only and additive within a release.

## 9. Privacy by design

Data inventory (release 1): see `05` §6. Data minimization: no SSN, bank, government ID, health, biometric, or demographic data; resumes stored as file and text only. Purpose limitation: candidate data is used to consider the candidate for the role applied to and, unless opted out, future roles at the same company; never pooled across tenants; never used to train foundation models.

Notices and consent (all versioned, display recorded): AI-use notice on the job page, the apply page, the first screening message, and the privacy page; SMS consent separate and unchecked, shown only when SMS is enabled; privacy notice with retention and rights; pay-transparency line where required; Colorado adverse-decision line (from January 2027).

Candidate rights: status page, one-click withdrawal, text preference, STOP keyword, HUMAN keyword and button, and a privacy-request process that is pilot-ready before real candidate data (correction 7): the published address `privacy@identifiedtalent.com`, a request method on the privacy and status pages, identity verification, a recorded request with a tracked deadline, access, correction, and deletion or anonymization where permitted, a completion record, escalation of employment-record retention conflicts to counsel, and restricted visibility (`docs/runbooks/privacy-requests.md`, tested by tabletop). Retention periods are proposed defaults per category (`05` §6) pending counsel; no irreversible automatic deletion runs in production until approved; a litigation-hold process is part of the counsel review.

Subprocessors (release 1): the hosting provider (D8), the database provider, the object storage provider, Anthropic (model inference; zero data retention terms to confirm), Postmark (email), Twilio (SMS, when enabled), Google and Microsoft (calendar, per interviewer), the U.S. Bureau of Labor Statistics API (no personal data). The design-partner DPA names them (C7).

## 10. Compliance mapping for release 1

| Obligation | Mechanism in release 1 | Open |
|---|---|---|
| Illinois HB 3773 notice; no zip proxies | AI-use notice at apply and screen; eligibility rule types exclude geography except bona fide `location_radius` answered by the candidate; bias-pair evals | C3 text review |
| California ADS regulations; 4-year retention | Assessment stores factors, evidence, prompt version, model; retention class 4 years; no personality or health questions (schema-restricted) | C2 scope; purge automation (release 2) |
| NYC Local Law 144 | Human decision on every advance/reject; assessment is information; audit-ready export by stage available on request | C1 applicability; self-ID collection (C10) |
| Colorado (Jan 2027) | Adverse-decision explanation notice and a review route; evidence recorded with the human decision | before 2027 |
| TCPA / 10DLC | Separate consent, STOP/HELP, quiet hours 8:00–21:00 local, consent recorded with source and version | C5; registration (D6) |
| Title VII, ADEA, ADA; vendor-as-agent theory | Human-only rejection on judgment; evidence-based assessment; fairness rules and evals; contractual allocation | C7, C8 |
| CCPA/CPRA | Notice at collection; privacy request workflow; DPA; no cross-tenant use | C7 |
| Google API Services User Data Policy | Limited use; narrow scopes; privacy policy naming calendar use; tokens encrypted and deletable | C6; OAuth verification submission |
| Accessibility | WCAG 2.2 AA target; statement and contact route | C9 audit |

## 11. Threat model additions for scheduling

| Threat | Control |
|---|---|
| A stolen schedule link books or cancels an interview | Token expiry; cancel and reschedule confirm by email; the team is notified of every change; book-on-behalf audited |
| Calendar event injection (a candidate-supplied string rendered in an interviewer's calendar) | Event text templated from packet and role data only; the candidate's name is escaped; no free text from the candidate in events except an accessibility note shown to the team in the app, not in the event |
| Over-broad calendar access | Narrow scopes; free/busy only for slot proposal; events created only in the chosen calendar |
| Token leakage to the calendar provider | Only event titles, times, attendees, and the join link are sent; no assessment content |
