# 10. Test and deployment plan (release 1)

Current state: 71 automated tests (unit, integration on PGlite, two end-to-end scenarios), 7 eval suites, zero type errors; no CI pipeline; nothing deployed. This plan takes the product to a staged private beta.

## 1. Test levels and what release 1 adds

| Level | Tooling | Exists | Release-1 additions |
|---|---|---|---|
| Unit | vitest per package | schemas, policy, stages, eligibility, dedupe, prompts, adapters | slot computation (windows, buffers, daily max, DST, timezones); calendar adapters with recorded fixtures; token expiry; CSRF; rate-limit windows; credential encryption round trip and key rotation; packet diff |
| Integration | vitest + `app.request()` on PGlite | auth, companies, intake, roles, applications, screens, approvals, escalations, admin, RLS | interviews and calendar routes; OAuth callback with a fake provider; sessions list/revoke; reauth; data requests; platform-role and plan endpoints; ITS scoped access (D11); channel flag; RLS on new tables; migration from previous state |
| Workflow | engine driven synchronously (`runUntilIdle`) with a pinned clock | role_approval, publish_role, application_intake, screen, stuck_role_detector | schedule_interview: happy path; conflict at booking → re-offer; provider outage → retry then fallback; no slot → reminder → expiry; reschedule by candidate (limit 2) and by team; cancel; completion and no-show; reminders idempotent; withdrawal cancels events; calendar_health |
| Scenario | `tests/scenario/*.test.ts` | dental steps 1–10c; consumer steps 1–5 | Step 11 (interview approval and scheduling) and 11b (failure paths) in both scenarios; Step 11c (decision recording, D10); the founder's "perfect workflow" from `FOUNDER-CONTEXT.md` §27 as the consumer scenario's acceptance path |
| Evals | `pnpm eval` | 7 suites | 6 new suites (`08` §5); live-model gate; signed results |
| UI (built 18 Sep) | Playwright + axe-core against the Next.js shell (`apps/shell`, D20; `pnpm e2e`; the Vite entry was retired with the route port, see `16`) and the API on PGlite, on a desktop and an iPhone viewport; every visited page must pass WCAG 2.1 A/AA and best-practice rules and must not scroll sideways on a phone | none | smoke journeys: sign in → company → intake → approve → apply (candidate page) → review → interview approval → connect declared availability → candidate picks a slot → Interviews view; accessibility checks with axe on every page; mobile viewport |
| Failure injection | scenario variants | email fails once; invalid AI output once; worker crash; duplicate application; withdrawal mid-screen | calendar conflict at booking; provider 5xx; token expired; DST boundary; spend cap reached |
| Load | k6 or autocannon | none | job page and apply at 50 rps; brief at 10 rps for a 2,000-application tenant; worker throughput 100 applications in 10 minutes |
| Security | scripted | RLS cross-tenant tests | dependency audit in CI; token-redaction test on logs; CSP header tests; an external penetration test before general availability (not release 1) |

Definition of done per pull request (from `docs/13`): UI, backend, database, permissions, error handling, audit events, tests, edge cases, failure states, human escalation, documentation; plus for AI changes an eval run; plus for schema changes a migration test.

## 2. Continuous integration (GitHub Actions or the platform's equivalent)

1. On every pull request: `pnpm install --frozen-lockfile`, `pnpm typecheck`, lint, `pnpm test` (unit, integration, workflow, scenario on PGlite), `pnpm eval` with the fake provider, Playwright smoke, `pnpm audit --audit-level high`, migration test from the previous tag.
2. Nightly on main: eval suites with the real provider (cost-capped), results uploaded; a failing suite opens an issue and blocks the next release.
3. On tag: build images for API and worker, build the web bundle, run migrations against a disposable Postgres to verify, then deploy to staging.

## 3. Environments

| Environment | Database | Adapters | Purpose |
|---|---|---|---|
| Local | PGlite | fake AI, fake email, fake SMS, fake calendar, live BLS | development and tests |
| Staging | managed Postgres (separate project) | real Anthropic (cost-capped), Postmark sandbox stream, Twilio test credentials, Google and Microsoft OAuth apps in testing mode, S3-compatible bucket | rehearsal of the pilot with synthetic candidates; weekly restore drill |
| Production | managed Postgres with PITR | real everything, external channels flagged per D5 | design partners |

Configuration by environment variable (see `docs/14`); production boot refuses dev secrets, the fake AI provider, and a superuser database role.

## 4. Infrastructure (pending D8)

- API: one container, autoscaled 1–3 instances, health check `/healthz`.
- Worker: one container, `WORKER_INLINE=false`, autoscaled on queue depth (1–2 instances for the pilot).
- Web: static build on the platform's CDN with `VITE_API_URL`; API and app under one site (`app.` and `api.` subdomains) with `COOKIE_DOMAIN`.
- Database: Postgres 16 with pgvector, PITR, 7-day backups; connection pooling from the platform.
- Storage: S3-compatible bucket, versioning, private; per-tenant key prefixes.
- Email: Postmark server with a verified sending domain (SPF, DKIM, DMARC) and an inbound domain (MX) (D7).
- Secrets: the platform's secret store; `APP_ENCRYPTION_KEY` with key id.
- Observability: platform logs shipped with redaction; Sentry-compatible error tracking; uptime checks on the job page and `/healthz`.

## 5. Release process

1. Merge to main with a green pipeline.
2. Tag; images built; staging deploy: migrate (as `ros_migrate`), deploy worker, deploy API, deploy web; smoke test the scenario against staging with the real adapters.
3. Production: same order; migrations are forward-only and compatible with the previous version, so the old API keeps working during the rollout.
4. Post-deploy checks: health, queue drained, one synthetic application through acknowledgment, one calendar probe.
5. Rollback: redeploy the previous image; migrations are not rolled back.

## 6. Monitoring and alerts (production)

Health (API, worker last poll), queue depth and oldest queued job (alert at 5 minutes), failed workflow runs (alert on any), AI error and refusal rate, unverifiable-quote rate, spend per tenant per day (cap), email bounce rate, calendar connection failures, escalation SLA breaches, unmatched inbound emails, 5xx rate, p95 latency on brief, apply, and screen turn.

## 7. Runbooks (written before the pilot)

Failed workflow run (inspect the step ledger, fix, retry); calendar disconnected (contact the interviewer, fallback to declared windows); escalation SLA breach (reassign); data request (verify, fulfil, record); spend cap reached (review runs, raise or hold); email domain issue (Postmark status, DNS); incident (contain, assess, notify); restore drill.

## 8. Pilot rollout

1. Week 0: staging rehearsal with synthetic candidates; counsel answers C1–C7; agreements signed; ITS queue staffed (D14).
2. Week 1: design partner 1 onboarded on the pilot plan; one real role from intake to interview with an ITS recruiter watching the queue daily; every manual correction and failure logged.
3. Week 2–3: partners 2 and 3; weekly review of flags, overrides, failures, and metrics (`01` §8); prompt changes only through the eval gate.
4. Week 4: partners 4 and 5 if the first three show no unresolved severe issues; release-2 planning (scorecards, offers, billing, purge jobs, TOTP).

## 8a. Gates before real candidate data (founder decision I23, 15 Sep 2026)

Cross-tenant isolation tests; recruiter-access tests (including the pre-acceptance preview test, correction 11); OAuth-token security tests (audited reads, deletion on disconnect, no tokens in logs, Sentry, analytics, or audit payloads; failed deletion alerts, correction 10); authentication tests (Supabase Auth with Google and Microsoft sign-in; the Entra sign-in registration carries identity scopes only); MFA tests; the service-role guard (`tests/policy/service-role-guard.test.ts`, correction 9); candidate-link authorization tests; calendar retry tests; integration-revocation tests; audit-completeness tests; business-calendar tests (weekends, observed holidays, daylight-saving changes, requests outside hours, multi-day deadlines, correction 12); accessibility tests; browser-journey tests; a backup and recovery test; error-monitoring verification; production boot checks; the privacy-request runbook tested by tabletop, the pilot agreement signed, and the privacy notice published (correction 7 and 13); counsel clearance for the applicable workflows. The six scenario TODOs (steps 11 to 16 in `tests/scenario/lifecycle.test.ts`) are completed before release 1 or formally classified with a written reason, owner, risk, and target release.

## 9. Exit criteria for release 1

All acceptance criteria in `01` §4 verified in staging with real adapters; live-model eval gate passed and signed; S1–S3 closed; runbooks written; alerts firing in staging; at least one design partner has completed a real interview scheduled by the product.
