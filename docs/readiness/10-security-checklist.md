# Security checklist (release 1)

Status per line uses the founder's vocabulary. "BM" = Built with mocks (implemented and tested locally); "VS" = Verified in staging; "NS" = Not started; "B" = Blocked.

| # | Control | Status | Evidence |
|---|---|---|---|
| 1 | Application never connects as a superuser or an RLS-bypassing role; boot refuses | BM | `container.ts` boot check; `rls.test.ts` |
| 2 | Row-level security on every table with a company id; tenant transactions as `app_tenant` | BM | `rls.test.ts` (generic check), migrations 0001 to 0010 |
| 3 | Tenancy only from a verified membership; no header can choose a company | BM | `tenancy.test.ts`, `security-coverage.test.ts` |
| 4 | Delegated sign-in with verified tokens; staff Microsoft + second factor; short staff sessions | BM (fake issuer) | `identity.test.ts` |
| 5 | Break-glass requires a fresh second factor, a reason, ≤60 minutes, audit | BM | `identity.test.ts`, `staff-access.test.ts` |
| 6 | ITS access scoped and time-limited; every request recorded; preview minimized | BM | `staff-access.test.ts`, `queue-preview.test.ts` |
| 7 | Service-role key absent from the application; guard test | BM | `tests/policy/service-role-guard.test.ts` |
| 8 | Secrets only in the managed store; audited reads; deletion on disconnect; failed deletion alerts | BM (memory store) | `secret-lifecycle.test.ts` |
| 9 | No credential in logs, errors, events, audit, analytics, error tracking | BM | `secrets.test.ts`, `integrations.test.ts` observability |
| 10 | Candidate links: 192-bit tokens, single purpose, expiring where applicable | BM | `security-coverage.test.ts` |
| 11 | Rate limits on every public and authenticated surface; shared store interface; security events | BM (memory + fake shared counter) | `rate-limit.test.ts`; provider selection pending (`docs/readiness/15`) |
| 12 | Webhooks authenticated (Postmark secret, Twilio signature), idempotent | BM | `email-failures.test.ts`, Twilio tests |
| 13 | Uploads limited by size and type; stored under tenant prefix | BM | `app.test.ts` |
| 14 | Human-only decisions enforced in code (reject, offer, adverse action); interview approval never below approval | BM | `core.test.ts`, `scheduling.test.ts`, scenario |
| 15 | No automatic rejection; hold, remind, escalate only | BM | `app.test.ts` hold test |
| 16 | Email suppression consulted on every send; complaints stop email | BM | `email-failures.test.ts` |
| 17 | Privacy requests: admin-only, verified, audited, no automatic deletion | BM | `privacy-requests.test.ts` |
| 18 | Analytics: allow-listed, keyed, no candidate pages | BM | coverage test |
| 19 | Security headers, CORS to the app origin, same-site cookies; CSP with per-request nonces on candidate pages and the application (report-only until reviewed) | BM | `app.ts`, `apps/shell/middleware.ts`, `csp.test.ts`; enforcement gate in `docs/readiness/18` |
| 20 | Dependency audit, secret scanning, migration validation and tenant-isolation checks in CI | BM (workflow written, dry run locally) | `.github/workflows/ci.yml`; first run needs the GitHub account |
| 23 | Platform authority only through the `platform_role_grants` ledger; one-time bootstrap; admin routes need a second factor; self-grant refused; two-person acknowledgement | BM | `platform-roles.test.ts`, `docs/readiness/13` |
| 24 | Customers can end a recruiter's access at once; audited; recruiter told; request back in the queue | BM | `staff-access.test.ts` |
| 21 | Backups, restore drill, incident tabletop, rotation drill | NS | readiness docs 04 to 06 |
| 22 | Penetration test before general availability | NS | release 2 |
