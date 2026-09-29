# 17. Staging handoff package

A founder-facing guide for the day the accounts exist. Written 18 September 2026. Nadine or Paul creates every account and enters every secret value (`docs/spec/12` §I); Claude receives only the non-secret references listed here, in a message or in `docs/spec/13` appendix D. **Never paste a secret into chat, a file, a screenshot, or an issue.** A service is called "connected" only when its evidence line is satisfied and recorded in the readiness register (`docs/readiness/01`).

Variable names are exactly those in `.env.example`. "Where entered" is always Vercel → Project → Settings → Environment Variables (server scope) and, for the worker, the Railway `worker` service's Variables tab (`docs/runbooks/railway-worker.md`; Trigger.dev is deferred by decision 1 of 22 September), unless stated.

## Order

1 Supabase → 2 Vercel → 3 Microsoft Entra sign-in and Supabase Auth providers → 4 Postmark → 5 Google Cloud (Calendar) → 6 Anthropic → 7 Sentry → 8 PostHog → 9 Twilio (registration only; SMS stays off) → 10 GitHub and CI.

## 1. Supabase (database, auth, storage, vault)

- **Nadine or Paul provides:** the organization and two projects (`recruiting-os-staging`, `recruiting-os-production`); runs `packages/db/migrations` with `MIGRATE_DATABASE_URL`, then `packages/db/scripts/provision-roles.sql` and `vault-grants.sql`; enables PITR on production.
- **Non-secret reference for Claude:** the project ref (`https://<ref>.supabase.co`) and region; the names of the database roles created.
- **Variables:** `DATABASE_URL` (as `ros_app`), `WORKER_DATABASE_URL` (as `ros_worker`), `MIGRATE_DATABASE_URL` (owner; trusted machine only, never Vercel), `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET` (optional), `STORAGE_BUCKET`, `STORAGE_S3_*`, `SECRET_STORE=vault`, `AUTH_PROVIDER=supabase`. **Not provisioned:** `SUPABASE_SERVICE_ROLE_KEY`.
- **Where entered:** Vercel and the worker environment; `MIGRATE_DATABASE_URL` only on the machine that runs releases.
- **Verify:** `/healthz` returns `db: postgres`; `select current_user` from the API is `ros_app`; the boot log never says "refusing to start"; `pnpm test -- rls` against the staging test database passes.
- **Disconnect:** rotate the role passwords and remove the variables; pause the project in the dashboard.
- **Evidence for "connected":** screenshot of `_migrations` showing 0000 to 0010; the health check output; the RLS suite output on staging.

## 2. Vercel (application hosting)

- **Provides:** a Vercel team owned by `platform@` with Nadine and Paul as members; a project linked to the private GitHub repository, root `apps/shell`; a staging environment (preview) and production; domain `recruiting.identifiedtalent.com` (CNAME per Vercel; do not touch `app.`).
- **Non-secret reference:** the project name, the preview URL, the production domain.
- **Variables:** everything in `.env.example` except the dev-only defaults; `APP_BASE_URL` `https://recruiting.identifiedtalent.com` (staging: the preview URL; `WEB_BASE_URL` is no longer read); `WORKER_INLINE=false`; `BOOTSTRAP_ADMIN_EMAILS` for the first administrator's first sign-in only, then removed (one-time bootstrap; see `docs/readiness/13-administrator-bootstrap.md`); `CSP_MODE=report-only` until the reports are reviewed (`docs/readiness/18`); `RATE_LIMIT_STORE=upstash` with `UPSTASH_REDIS_REST_URL` and the sealed token (`docs/readiness/15`; `RATE_LIMIT_SHARED_PROVIDER` is no longer read); `SENTRY_ENVIRONMENT=staging`.
- **Verify:** the deployment builds; `/healthz` on the URL; `/login` shows the provider buttons.
- **Disconnect:** disable the deployment; remove the domain.
- **Evidence:** the deployment URL and a passing `/healthz`.

## 3. Microsoft Entra sign-in registration and Supabase Auth providers

- **Provides:** the Entra registration (`13` §4a) with identity scopes only; its client id and secret entered in Supabase → Authentication → Providers → Azure; the Google sign-in client (from step 5's project) entered in Providers → Google.
- **Non-secret reference:** the registration's display name and application (client) id; the redirect URI configured.
- **Variables:** none in the application (the identity service holds them). `AUTH_SIGNIN_PROVIDERS=azure,google`, `ITS_STAFF_EMAIL_DOMAINS=identifiedtalent.com`, `MAGIC_LINK_ENABLED=false`.
- **Verify:** Nadine signs in with Microsoft and TOTP; a Google test account signs in as a customer; a staff attempt without a second factor is refused with the message; `/api/v1/auth/me` shows `aal2` for staff.
- **Disconnect:** delete the client secret in Entra; remove the provider in Supabase.
- **Evidence:** the `session.opened` audit record for Nadine with `provider: azure, aal: aal2`.

## 4. Postmark (email)

- **Provides:** the account owned by `platform@`; a server for production and one for staging; sender signature and domain `hire.identifiedtalent.com` with the DNS records from `13` appendix B (after Nadine's review); inbound processing to the API's `/webhooks/postmark/inbound` with the inbound secret; bounce and spam-complaint webhooks to `/webhooks/postmark/bounces` and `/spam` with basic auth `postmark:<POSTMARK_WEBHOOK_SECRET>`.
- **Non-secret reference:** the server names; the sending domain; the webhook URLs configured.
- **Variables:** `EMAIL_PROVIDER=postmark`, `POSTMARK_SERVER_TOKEN`, `POSTMARK_INBOUND_SECRET`, `POSTMARK_WEBHOOK_SECRET`, `EMAIL_FROM_DOMAIN=hire.identifiedtalent.com`, `EMAIL_FROM_ADDRESS=updates@hire.identifiedtalent.com`, `EMAIL_REPLY_TO` (the monitored ITS mailbox), `EMAIL_INTAKE_DOMAIN`.
- **Verify:** a test application's acknowledgment arrives with SPF, DKIM and DMARC passing (mail headers); a forwarded application becomes an application; a hard bounce to a Postmark test address appears in the admin console's suppression list.
- **Disconnect:** delete the server token; remove DNS records.
- **Evidence:** the received email's headers; the webhook receipt row; the suppression row.

## 5. Google Cloud (Calendar API)

- **Provides:** Cloud Identity Free on `identifiedtalent.com` with Nadine as the initial administrator (`12` §9); a project `recruiting-os`; Calendar API enabled; OAuth consent screen (testing) with ITS test accounts; a web OAuth client with redirect `https://recruiting.identifiedtalent.com/api/v1/integrations/calendar/google/callback` (and the staging URL); a second client for Google sign-in with the Supabase callback.
- **Non-secret reference:** project id; the OAuth client id (public); the configured redirect URIs; the scopes shown on the consent screen.
- **Variables:** `CALENDAR_PROVIDER=google`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`.
- **Verify:** a test interviewer connects; free/busy shows a real busy block; a booked interview creates one event with a Meet link; cancel removes it; disconnect deletes the credential (audit `credentials.deleted`, Vault empty).
- **Disconnect:** delete the OAuth client; users' tokens become invalid; the product marks connections as needing attention.
- **Evidence:** the event in the test calendar; the audit records `secret.read` (purpose `calendar_booking`) and `credentials.deleted`.

## 6. Anthropic (AI)

- **Provides:** an organization account owned by `platform@`; an API key per environment; a monthly spend limit.
- **Non-secret reference:** the organization name; the model ids in use.
- **Variables:** `AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, `AI_MODEL_JUDGMENT`, `AI_MODEL_STANDARD`, `AI_MODEL_FAST`.
- **Verify:** one intake turn in staging; `pnpm eval` with `AI_PROVIDER=anthropic` on the evaluation set at or above thresholds; `ai_runs` shows cost.
- **Disconnect:** revoke the key.
- **Evidence:** the eval report file in `packages/evals/results`.

## 7. Sentry (errors)

- **Provides:** organization and two projects (API/shell staging, production).
- **Non-secret reference:** the project slugs.
- **Variables:** `SENTRY_DSN` (per environment).
- **Verify:** a forced error in staging arrives scrubbed (no cookie, no token, user is an opaque id) — the scrubber is `packages/integrations/src/observability/sentry.ts`.
- **Disconnect:** remove the DSN.
- **Evidence:** the scrubbed event's JSON.

## 8. PostHog (product analytics)

- **Provides:** a project per environment.
- **Non-secret reference:** the host (`https://us.i.posthog.com`); the project name.
- **Variables:** `ANALYTICS_PROVIDER=posthog`, `POSTHOG_PROJECT_API_KEY`, `POSTHOG_HOST`, `ANALYTICS_SALT` (random, per environment).
- **Verify:** `application_started` and `application_completed` appear with keyed ids; no event carries an email; the candidate pages load no PostHog script.
- **Disconnect:** rotate the project key; remove the variables.
- **Evidence:** the PostHog event list screenshot showing only allow-listed names.

## 9. Twilio (SMS; registration only, texting stays off)

- **Provides:** account, A2P 10DLC brand and campaign registration; a messaging service; webhook `/webhooks/twilio/inbound`.
- **Non-secret reference:** the messaging service SID (public identifier), campaign status.
- **Variables:** `SMS_PROVIDER` stays `fake` until the founder turns texting on; then `twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_WEBHOOK_URL`.
- **Verify (when enabled):** an inbound STOP is honoured; signature verification rejects an unsigned request.
- **Evidence:** campaign approval; the webhook test.

## 10. GitHub and CI

- **Provides:** the private repository under the ITS organization; branch protection; the CI workflow (typecheck, tests, evals on the fake provider, Playwright, `pnpm audit`, `next build`).
- **Non-secret reference:** repository name.
- **Variables:** none in the application; CI secrets only for the staging test database if used.
- **Verify:** a pull request runs the full check set green.
- **Evidence:** the first green run.

## What Claude does with the references

Updates `docs/spec/13` appendix D, records each service's status in `docs/readiness/01`, and runs the staging verification checklist (`docs/readiness/03`) with Nadine or Paul entering anything that needs a secret.
