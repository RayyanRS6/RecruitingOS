# 14. Deployment and environment

## Local development

Requirements: Node.js 24 and pnpm 12 (`package.json` pins `pnpm@12.3.4`; `corepack enable` or `npm i -g pnpm@12.3.4`). No Postgres and no Docker: PGlite runs Postgres inside the process.

```bash
pnpm install
cp .env.example .env          # defaults use PGlite, the fake providers and the inline worker
pnpm db:migrate               # applies the SQL migrations to the local PGlite database (./.data/pglite)
pnpm db:seed                  # platform defaults, plans, the dental playbook, a demo company
pnpm dev                      # the Next.js app on http://localhost:3000: the app, the API, candidate pages, webhooks, the inline worker
pnpm test                     # unit, integration, policy and scenario tests on an in-memory PGlite
pnpm eval                     # evaluation suites (fake provider unless AI_PROVIDER=anthropic)
pnpm typecheck
pnpm e2e                      # Playwright journeys with accessibility checks against `next dev` (the dev server needs about 12 GB of heap)
pnpm ci:local                 # every CI step, in order, on this machine
```

There is one process in development: the Next.js shell mounts the Hono API under its route handlers, and `WORKER_INLINE=true` runs the queue inside it. `/dev/outbox` and `/dev/sms-outbox` show what the fake email and text adapters would have sent (sign-in links included).

## Topology (staging and production)

| Piece | Where | What it does |
|---|---|---|
| The app | Vercel, project root `apps/shell` (Next.js 15) | One deployment and one origin (`APP_BASE_URL`): the owner, recruiter and administrator app; the API under `/api`; candidate pages under `/careers` and `/c`; webhooks under `/webhooks`; feeds; `/healthz`; and, once the shell has handlers for them, the tracked links under `/a`, `/sitemap.xml` and `/robots.txt` (they were missing at commit `ed9147e`; `docs/STATUS.md`). Only paths with a route handler in `apps/shell/app` reach the API. Route handlers declare `maxDuration = 60`, which every Vercel plan allows. |
| The worker | Railway (`pnpm worker:start`, entry `apps/api/src/worker.ts`, `WORKER_INLINE=false`) | The only process that runs workflows and jobs: the outbox that sends every queued email and text, intake compilation, application processing, résumé scanning, screens, scheduling, reminders, credential revocation, the daily privacy-deadline check and the daily maintenance sweep. Connects as `ros_worker`, the only role that can read a credential in Vault. Writes a heartbeat on every poll and answers `GET /healthz` on `PORT`, which Railway probes and restarts on 503 (see "Worker health"). |
| Database | Supabase Postgres | Row-level security on every tenant table; roles `ros_app` (the API), `ros_worker` (the worker) and the owner role (migrations only). Point-in-time recovery from the plan. |
| Secrets | Supabase Vault | Integration credentials (calendar tokens). The API role writes references; the worker role reads values. |
| Files | Supabase Storage, private bucket | Résumés, uploaded straight from the browser into quarantine, inspected and scanned by the worker before anything reads them. |
| Sign-in | Supabase Auth | Google and Microsoft with PKCE; ITS staff need Microsoft plus a second factor. |
| Rate limits | Upstash Redis (REST) | Shared counters across every API process; per-process counting if Upstash is unreachable, with an alert. |
| Email, SMS, calendar, analytics, errors | Postmark, Twilio, Google Calendar, PostHog, Sentry | Each behind an adapter with a fake used locally and in CI. Twilio stays off until the campaign is approved. |

`main` deploys to the staging Preview on Vercel and to the Railway worker; the `production` branch is the production pointer (no production environment exists yet). Runbooks: `docs/runbooks/staging-environment-variables.md`, `docs/runbooks/railway-worker.md`, `docs/runbooks/staging-database-setup.md`, `docs/runbooks/release-migrations.md`, `docs/runbooks/resume-storage.md`.

### Worker health

The worker writes a row to `worker_heartbeats` on every poll (when it looked, how many jobs were due and waiting, the oldest one's `run_at`) and serves `GET /healthz` on `PORT` (default 8080) from a plain `node:http` server: `{ ok, workerId, lastPollAt, queueDepth, oldestQueuedAgeSeconds }` (the release version is on the heartbeat row, never in this session-less body), 200 while it polls and 503 once the last successful poll is older than three poll intervals plus thirty seconds (`3 × WORKER_POLL_MS + 30 s`). `railway.json` names that path as the service's health check, so Railway restarts a worker that stops polling. The app's `/healthz` reports the newest heartbeat as `worker: { lastSeenAt, queueDepth, healthy }` when `WORKER_INLINE=false` (`healthy` turns false after ten minutes without one) and `worker: "inline"` in development.

Nothing in the queue fails silently: a job that uses up its attempts raises a `job.failed` alert in the console's Failures tab, and both failed jobs and workflow runs that failed for good reach Sentry with their kinds and ids (never a payload or a run's state) and the last error text scrubbed of secrets, email addresses and phone numbers and cut at 300 characters; the console's alert keeps the fuller text. The same checks raise `worker.stale` (no heartbeat for ten minutes while `WORKER_INLINE=false`) and `queue.stale` (a due job waiting more than thirty minutes), at most once an hour and never while one is already open. They run from three places: the app's `/healthz` (at most every five minutes per process, so a stopped worker is still noticed; point the uptime monitor at `/healthz?strict=1`, which answers 503 while the worker is stale), the worker's hourly `ops.health_check` job, and the daily maintenance sweep. The two recurring jobs (privacy deadlines, maintenance) arm their next run even when a run fails.

### The app on Vercel

`apps/shell/vercel.json` pins the framework (`nextjs`) and the region (`pdx1`, Portland, the region nearest the Oregon database). The migration files are read from `ROS_MIGRATIONS_DIR`, which `apps/shell/next.config.ts` sets to `packages/db/migrations` because the bundler rewrites the module path the database package would otherwise resolve them from; the boot check that refuses to start while a migration is pending reads them there. `SENTRY_ENVIRONMENT=staging` marks the staging Preview (it runs with `NODE_ENV=production`) and enables `POST /api/v1/admin/observability/test-error`, the platform administrators' deliberate, audited error for the scrubbing proof in `docs/readiness/03` section 6. The route is allow-listed, not deny-listed: it exists in a development process and in a production build whose `SENTRY_ENVIRONMENT` is exactly `staging`; every other production process answers 404, whatever its environment is named.

## Environment variables

Defaults are the local development values. "prod" in the Required column means the boot check refuses to start without it in `NODE_ENV=production`. Every variable read by `apps/api/src/env.ts` and `packages/integrations/src/registry.ts` is in a table below (checked against both files on 30 September 2026); a few others are read by the Next.js shell (`apps/shell`) and the worker entry, and are listed with their neighbours.

### Addresses and secrets

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `NODE_ENV` | | `development` | `production` turns on every boot check below |
| `APP_BASE_URL` | prod (https, no path) | `http://localhost:3000` | The one public address of the deployment: links in email, OAuth redirects, candidate pages, webhooks |
| `JOBS_BASE_URL` | prod, when set: an https origin with no path | `APP_BASE_URL` (trailing slash stripped) | The public job-page host (docs/spec/20 item 1): careers and job pages, apply pages, the sitemap, the feeds, posting packages, tracked application links, and the links in candidate status, screening and email-failure messages are built from it (interview scheduling links stay on `APP_BASE_URL`). Unset, one host serves everything. Set to `https://jobs.identifiedtalent.com` once that domain is attached to the same Vercel deployment and its DNS record exists (founder gate 2.5) |
| `SESSION_SECRET` | prod | dev value | Seals session, PKCE, second-factor and calendar-consent cookies; keys rate-limit hashes |
| `COOKIE_DOMAIN` | | unset | Cookie `Domain` when the app is served under several hostnames of one site |
| `ANALYTICS_SALT` | prod | `dev-only-analytics-salt` | Salt for the keyed analytics identifiers; different per environment, never reused between staging and production |
| `TRUST_PROXY_HOPS` | | `1` | Proxies in front of the app that append to `X-Forwarded-For` (Vercel: 1); only that entry is trusted as the client address |
| `ROS_REPO_ROOT` | | detected | Where relative data paths resolve; set only when a bundler hides the workspace root |

### Database and migrations

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | prod (app) | PGlite when unset | Connection string for `ros_app` (never a superuser or an RLS-bypassing role; the boot check refuses both) |
| `WORKER_DATABASE_URL` | prod (worker) | | Connection string for `ros_worker` |
| `MIGRATE_DATABASE_URL` | release step | | The owner role, used only by `pnpm db:migrate`, `pnpm db:seed` and `pnpm db:status` |
| `DATABASE_SSL_CA` / `DATABASE_SSL_CA_FILE` | prod | | Supabase's certificate authority, as text (hosted) or a file path (a person's machine); verification is never off |
| `DATABASE_POOL_MAX` | | `5` | Connections per process on the session pooler |
| `PGLITE_DIR` | | `./.data/pglite` | Local database directory (`memory://` for tests) |
| `RUN_MIGRATIONS_ON_BOOT` | | off | Never in production: the app refuses to start while a migration is pending; migrations are a release step (`pnpm db:migrate` or the `migrate` GitHub workflow; `docs/runbooks/release-migrations.md`) |
| `ROS_MIGRATIONS_DIR` | | set by `next.config.ts` | Where the migration files are read from by the boot check and the migration tools; the shell sets it because the bundler hides the package path |

### Sign-in and staff

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `AUTH_PROVIDER` | prod = `supabase` | `fake` | `supabase` delegates sign-in to Supabase Auth; `fake` is an in-process issuer for development and tests |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | prod | | The project and its publishable key (the token endpoint and the factor endpoints) |
| `SUPABASE_JWT_SECRET` | | | Verifies HS256 tokens; otherwise the project's published keys are used |
| `AUTH_SIGNIN_PROVIDERS` | | `azure,google` | Which delegated providers the sign-in page offers |
| `ITS_STAFF_EMAIL_DOMAINS` | | `identifiedtalent.com` | Users on these domains are ITS staff: Microsoft plus a second factor |
| `BOOTSTRAP_ADMIN_EMAILS` | once | | The first platform administrator, granted on that address's first Microsoft sign-in with a second factor while no administrator exists; remove afterwards |
| `MAGIC_LINK_ENABLED` | | on outside production | The internal email sign-in link; production defaults to off |

### AI

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `AI_PROVIDER` | prod = `anthropic` | `fake` | `fake` is deterministic and refused in production |
| `ANTHROPIC_API_KEY` | when anthropic | | |
| `AI_MODEL_JUDGMENT` / `AI_MODEL_STANDARD` / `AI_MODEL_FAST` | | Claude Opus 5 / Sonnet 5 / Haiku 4.5 | Model routing overrides |

### Messages

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `EMAIL_PROVIDER` | | `fake` | `fake` or `postmark` |
| `POSTMARK_SERVER_TOKEN` | when postmark | | Sending |
| `POSTMARK_INBOUND_SECRET` | when postmark | | Inbound webhook (basic auth in the URL or the `x-inbound-secret` header; a query string is refused). With `EMAIL_PROVIDER=postmark` and an `EMAIL_INTAKE_DOMAIN` that does not end in `localhost`, it switches on email-in and candidate replies (`emailInConfigured` in the registry); the domain's MX record must point at Postmark's inbound server |
| `POSTMARK_WEBHOOK_SECRET` | when postmark | | Bounce, complaint and delivery webhooks |
| `EMAIL_FROM_DOMAIN` | prod | `mail.localhost` | Sending domain (SPF, DKIM, DMARC at the provider) |
| `EMAIL_FROM_ADDRESS` | prod | `updates@<EMAIL_FROM_DOMAIN>` | The single sending address; display names name the customer's hiring team |
| `EMAIL_REPLY_TO` | prod | `ITS_QUEUE_EMAIL` | Monitored ITS mailbox for candidate replies while the inbound domain is not configured; a person reads it. With the inbound domain live, every candidate email carries a per-application `reply-<token>@` address and replies come back into the product (docs/runbooks/candidate-replies.md) |
| `EMAIL_INTAKE_DOMAIN` | for email-in and replies | `intake.localhost` | Per-role intake addresses and per-application `reply-<token>@` addresses. While it ends in `localhost` (or `POSTMARK_INBOUND_SECRET` is missing) email-in shows as not connected, board postings rely on their apply links, and replies go to `EMAIL_REPLY_TO` |
| `ITS_QUEUE_EMAIL` | prod | `recruiters@its.localhost` | The ITS queue mailbox: recruiter requests, administrator changes, ended access |
| `PRIVACY_EMAIL` | | `privacy@identifiedtalent.com` | The privacy-request address shown to candidates |
| `PRODUCT_NAME` | | `Recruiting OS` | Internal product name in owner- and staff-facing system mail |
| `SMS_PROVIDER` | | `fake` | `fake` or `twilio` |
| `SMS_ENABLED` | | on only with twilio | Texting candidates; off until counsel, carrier registration and a partner need it. Opting out always works |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID` (or `TWILIO_FROM_NUMBER`) | when twilio | | The auth token also verifies inbound webhook signatures |
| `TWILIO_WEBHOOK_URL` | | `APP_BASE_URL/webhooks/twilio/inbound` | The exact public URL Twilio posts to, when it differs |

### Calendars, job boards, compensation

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `CALENDAR_PROVIDER` | | `fake` | `google` uses the ITS Google Cloud OAuth client and revokes at Google on disconnect; anything else is the fake |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | when google | | |
| (job-board credentials) | none yet | | Indeed, ZipRecruiter and LinkedIn are manual in release 1: the customer posts from their own account and points the board at the apply link. No credential is read until a partner integration is verified |
| `LINK_VERIFIER` | | `fake` outside production | The public-URL check behind "Live and verified" (docs/spec/20 item 12): production always fetches the page; `real` turns the fetch on elsewhere, otherwise a scripted fake answers |
| `BLS_API_KEY` | | | OEWS v2 (higher limits) |
| `COMP_BLS_ENABLED` | | `true` | `false` skips the live wage lookup (tests, offline work) |

### Files, scanning, secrets

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `STORAGE_PROVIDER` | prod = `supabase` | `local` | `memory` (tests), `local` (files under `STORAGE_DIR`), `supabase`; anything else is refused at boot |
| `STORAGE_DIR` | | `./.data/files` | Where `local` storage keeps files, resolved against the repository root |
| `STORAGE_BUCKET`, `STORAGE_S3_ENDPOINT`, `STORAGE_S3_REGION`, `STORAGE_S3_ACCESS_KEY_ID`, `STORAGE_S3_SECRET_ACCESS_KEY` | when supabase | | From the dashboard's S3 Configuration screen; the bucket is private |
| `SCAN_PROVIDER` | | `fake` | `fake` (development, tests, and the app, which never scans a file) or `clamav` on the worker (a clamd service reached over private networking; `docs/runbooks/resume-storage.md`). A production worker on `fake` raises a standing `scanner.fake` alert: a real engine is a real-data gate (`docs/readiness/20` blocker 8) |
| `CLAMAV_HOST`, `CLAMAV_PORT`, `CLAMAV_TIMEOUT_MS` | `CLAMAV_HOST` when clamav (boot refuses without it) | none, `3310`, `20000` | The clamd service's private hostname (Railway: `<service>.railway.internal`), its port and the connection, send and reply timeout in milliseconds; a port or timeout that is not a positive number is refused at boot |
| `SECRET_STORE` | prod = `vault` | `memory` | Supabase Vault in production; production refuses `memory` |

### Rate limits, policy, observability, worker

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `RATE_LIMIT_STORE` | | `memory` | `memory` (one process), `upstash` (shared; staging and production), `fake` (tests only; refused in production). Production without `upstash` starts with a warning and an alert |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | when upstash | | The token is a secret entered at the host |
| `RATE_LIMIT_OVERRIDES` | | `{}` | Per-policy limit overrides as JSON, for rehearsals |
| `CSP_MODE` | | `report-only` | Candidate-page content-security policy; `enforce` after the staging reports are reviewed |
| `COMPANY_CHECK` | | `its` (`auto` under `NODE_ENV=test`) | The one-time ITS check of a company that signs itself up (founder decision B7): with `its` its careers page, job pages, Google listing and first candidate emails wait until an administrator confirms it in the admin console; `auto` confirms every new company at once (tests and local journeys; `.env.example` sets it, so a company created on your own machine is live without a visit to /admin). Production refuses `auto` |
| `ANALYTICS_PROVIDER`, `POSTHOG_PROJECT_API_KEY`, `POSTHOG_HOST` | | `fake` | Server-side funnel events only |
| `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `NEXT_PUBLIC_SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE` | | off | Scrubbed error reporting; empty DSN means off. `SENTRY_DSN` is read by the server processes (the shell and the worker), `NEXT_PUBLIC_SENTRY_DSN` by the staff web app's browser bundle only (candidate pages carry no script), which names its environment from `NEXT_PUBLIC_SENTRY_ENVIRONMENT` (default `development`). `SENTRY_ENVIRONMENT=staging` names the staging Preview and enables the administrators' test-error route |
| `VERCEL_GIT_COMMIT_SHA`, `RAILWAY_GIT_COMMIT_SHA` | | set by the host | The release identifier on error reports and on the worker's heartbeat; never set by hand |
| `WORKER_INLINE` | prod = `false` | `true` | Run the queue inside the app process (development only) |
| `WORKER_POLL_MS` | | `500` | The worker's idle poll interval; the worker's health check goes stale after three of them plus thirty seconds |
| `PORT` | worker | `8080` | The worker's health-check port (`GET /healthz`); Railway sets it |

No longer read: `WEB_BASE_URL` (the app and the API share `APP_BASE_URL`), `RATE_LIMIT_SHARED_PROVIDER` and `RATE_LIMIT_SHARED_URL` (folded into `RATE_LIMIT_STORE`; the old spelling is understood with a warning), `LOG_LEVEL`, `PLATFORM_ADMIN_EMAILS`.

## Release process

1. **CI** on every push and pull request (`.github/workflows/ci.yml`): lockfile install, secret scans, dependency audit, typecheck, Biome lint, migration validation, the tests (row-level security, tenant isolation, the service-role guard, the schema-drift check, unit, integration and scenario), evals with the fake provider, the Next.js production build, browser journeys with accessibility checks.
2. **Migrations are a release step.** Run `pnpm db:migrate` with `MIGRATE_DATABASE_URL` (the owner role) from the founder's machine, or the `migrate` GitHub workflow (Actions, "migrate", pick the environment; its secrets hold the owner connection string; the status report before the apply step never fails on a pending migration). Migrations are additive within a release and validated for destructive statements. Production never migrates on boot and refuses to start while one is pending. `docs/runbooks/release-migrations.md` is the release-day procedure, including what the boot refusal looks like and why the setup script (which rotates passwords) is never used for a release. The release of 30 September 2026 adds five migrations, all additive, to apply in one run before the deploy: `0020_job_distribution.sql` (the nine posting states and their columns, `application_links`, `applications.source_detail` and `link_id`, the accepting switch and volume threshold on `roles`), `0021_worker_heartbeats.sql` (the worker's health rows), `0022_invitations.sql` (team invitations as rows of their own), `0023_reply_tokens.sql` (`applications.reply_token` for candidate replies) and `0024_session_reauth.sql` (`sessions.reauthenticated_at`). The validator passes on 25 files, 0000 to 0024.
3. **Deploy** the worker (Railway follows `main`), then the app (Vercel deploys `main` to the staging Preview; production follows the `production` branch).
4. **Rollback** is a redeploy of the previous deployment; a migration is never rolled back, which is why every migration is written to be compatible with the previous release.
5. **Retention** is a daily worker job: finished queue jobs after seven days, expired sessions and sign-in links after a day, webhook receipts after thirty days, policy reports after ninety, worker heartbeats not seen for a week, and any message left mid-send is reported for a person. The same job runs the stale-worker and stale-queue checks, and arms its next run even when a sweep fails. Candidate data follows the privacy-request process and the anonymization rules in `docs/09`, never this sweep.
