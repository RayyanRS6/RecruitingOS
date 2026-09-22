# Release 1 readiness register

Maintained by the production team; last updated 21 September 2026. Status vocabulary (the founder's): **Not started** · **Built with mocks** · **Verified in staging** · **Counsel approved** · **Ready for production** · **Blocked**. Nothing built against a fake provider is labelled ready for production. "Evidence" names the test, document, or record that proves the status.

## A. Product workflow

| Item | Status | Evidence | To reach the next status |
|---|---|---|---|
| Sign-up, company, team, plan (Design Partner) | Built with mocks | `apps/api/src/app.test.ts`, `tests/scenario`, `tests/e2e/specs/routes.spec.ts` | staging: real Supabase Auth sign-in |
| Intake conversation and role packet (fake AI) | Built with mocks | `packages/evals` 7 suites; scenario steps 1 to 3 | staging: Anthropic key; eval suites on the live model |
| Posting (careers page, Google for Jobs, email-in, feeds) | Built with mocks | scenario step 4; five channel states | staging: Postmark inbound; Google verification |
| Application, acknowledgment, eligibility, triage, no automatic rejection | Built with mocks | scenario steps 5 to 9; `app.test.ts` hold/decline test | staging: real email delivery |
| Text screening with disclosure and human alternative | Built with mocks | scenario step 10; `agents.test.ts` | staging: Twilio 10DLC (SMS stays off until approved) |
| Interview approval and scheduling (declared hours, calendar, ICS, reminders, reschedule, cancel) | Built with mocks | `scheduling.test.ts` (9), `core/scheduling.test.ts`, scenario steps 11 to 13, e2e journey | staging: Google Cloud OAuth client verified against a real calendar |
| Audit history, timeline, human decisions | Built with mocks | `security-coverage.test.ts`, `core.test.ts` | staging: run the same suites |
| ITS recruiter escalation, scoped access, queue preview, customer-initiated revocation | Built with mocks | `staff-access.test.ts`, `queue-preview.test.ts` | staging: real staff accounts with MFA |
| Human-recorded hiring outcomes (hire, withdrawal, declines, role closed with its outcome; audited admin correction) | Built with mocks | `outcomes.test.ts` | staging: run the same suite; founder confirms the wording on the candidate sheet |
| Intake conversation announcements for screen readers | Built with mocks | e2e journey (live region) | staging: manual check with VoiceOver |

## B. Platform and security

| Item | Status | Evidence | To reach the next status |
|---|---|---|---|
| Database roles, RLS, tenant isolation | Built with mocks (PGlite) | `rls.test.ts`, `tenancy.test.ts`, `security-coverage.test.ts` | staging: `provision-roles.sql`, `vault-grants.sql` on Supabase; rerun suites |
| Delegated sign-in (Google, Microsoft), staff MFA rule, break-glass | Built with mocks (fake issuer) | `identity.test.ts`, e2e staff test | staging: Supabase Auth with the Entra sign-in registration (`13` §4a) |
| Platform administrators through a ledger; one-time bootstrap; MFA on admin routes; self-grant refused; two-person acknowledgement | Built with mocks | `platform-roles.test.ts`; `docs/readiness/13` | staging: first sign-in, bootstrap variable removed, second administrator granted in the console |
| Rate limiting: provider-neutral store, per-user/tenant/token/address policies, security events, webhook retries safe | Built with mocks (memory and fake shared counter) | `rate-limit.test.ts`; `docs/readiness/15` | founder selects the shared-store provider; staging: connect it, verify the "not shared" alert disappears |
| Content-security policy with nonces on candidate pages and the application; report endpoint; review before enforcement | Built with mocks (report-only) | `csp.test.ts`, `apps/shell/lib/csp.test.ts`, e2e header check; `docs/readiness/18` | staging: two weeks report-only, reports reviewed, then enforce |
| Candidate link trust boundary for privacy requests (derived from the token, idempotent, tokens redacted from logs) | Built with mocks | `privacy-requests.test.ts`; `docs/readiness/14` | staging: run the same suite |
| Continuous integration (lockfile, types, tests, evals, build, e2e + axe, audit, secret scan, migration validation) | Built with mocks (checked on a laptop, not yet run on GitHub) | `.github/workflows/ci.yml`, `scripts/ci-local.sh` | GitHub account: first green run |
| Secret lifecycle (audited reads, deletion on disconnect, alerts, scrubbing) | Built with mocks (memory store) | `secret-lifecycle.test.ts`, `secrets.test.ts` | staging: Supabase Vault; revoke a real Google token |
| Email delivery, bounce and complaint handling, suppression | Built with mocks | `email-failures.test.ts` | staging: Postmark server, webhooks with the secret, a real bounce |
| Product analytics (server-side, keyed) | Built with mocks | `integrations.test.ts`, coverage test | staging: PostHog project key |
| Error tracking scrubber | Built with mocks | `integrations.test.ts` observability | staging: Sentry DSN, verify a scrubbed event |
| Business calendar and SLAs | Built with mocks | `business-calendar.test.ts`, `core.test.ts` | staging: administrator publishes the real calendar |
| Next.js shell on Vercel with Hono mounted | Built with mocks (local build) | `next build` passes; `apps/shell/lib/hono.test.ts`; e2e | staging: Vercel project, environment variables, preview deployment |
| Durable workflows (own engine; Trigger.dev migration D22) | Built with mocks | engine tests inside every suite | staging: worker process with `WORKER_DATABASE_URL`; Trigger.dev later, one workflow at a time |
| Backups and recovery | Not started (plan written) | `05-backup-and-recovery.md` | staging: PITR enabled, restore drill |
| Incident response | Not started (plan written) | `04-incident-response.md` | tabletop with Nadine and Paul |
| Credential rotation | Not started (plan written) | `06-credential-rotation.md` | first rotation drill in staging |

## C. Privacy and legal

| Item | Status | Evidence | To reach the next status |
|---|---|---|---|
| Privacy-request workflow (access, correction, deletion by anonymization, opt-out, human review, withdrawal) | Built with mocks | `privacy-requests.test.ts`; admin console tab; runbook | Counsel approved: deadlines, anonymization scope (register item 6, 9) |
| Retention periods and automatic deletion | Blocked (counsel) | `09-data-retention-matrix.md`; no automatic deletion exists | counsel decision on the matrix |
| Design Partner pilot agreement | Not started (draft for counsel) | `docs/legal-drafts/01` | Counsel approved; signed by each partner before real data |
| Candidate privacy notice, AI-use disclosure, SMS consent | Built with mocks (product text) + draft for counsel | notices in `packages/core/src/compliance.ts`; `docs/legal-drafts/02` to `04` | Counsel approved |
| Eligibility-question policy; human-review and rejection policy | Built with mocks + draft for counsel | policies in code; `docs/legal-drafts/05`, `06` | Counsel approved |
| Subprocessor list | Not started (draft for counsel) | `07-subprocessor-register.md`, `docs/legal-drafts/09` | Counsel approved; accounts exist |

## D. Accounts and infrastructure (all outside the code)

| Item | Status | Owner | Evidence when done |
|---|---|---|---|
| Microsoft 365 confirmation, GoDaddy access, MFA, DNS zone export | Blocked (in progress by Nadine and Paul) | Nadine, Paul | `13` §0, §1 verifications recorded |
| 1Password Business, GitHub, Supabase, Vercel, Trigger.dev, Postmark, Google Cloud, Sentry, PostHog, Anthropic, Twilio | 1Password Business done (founder, 22 Sep: Nadine and Paul owners, MFA, five vaults); GitHub organization `identified-talent-solutions` and private repository `recruiting-os` created 22 Sep (Nadine sole owner by founder decision; risk R-OWN-1 in `docs/spec/00` section Q); the rest Blocked (accounts not created); whether Twilio and Trigger.dev are created now or later is the founder's decision (gate 1.9 of `docs/readiness/16`) | Nadine, Paul | `docs/spec/17-staging-handoff.md` **Evidence** lines |

## E. Gates before a design partner's real candidate data

1. Every row in sections A and B at **Verified in staging**. Two provisions **proposed by the production team on 21 September 2026, not yet decided by the founder**, to be adopted or struck at sign-off (`docs/spec/00` section O): that the text-screening row counts as verified with texting off (decision M2 keeps texting off), and that Google's outside reviews (job listings, calendar registration) may still be pending if the founder accepts that in writing.
2. Section C: pilot agreement, privacy notice, and privacy-request runbook **Counsel approved**; retention matrix decided.
3. Accessibility checklist (`11`) signed off on the staging URL.
4. Incident-response tabletop and one restore drill completed.
5. Founder sign-off recorded in `docs/spec/00`.
