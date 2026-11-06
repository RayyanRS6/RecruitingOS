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
| The worker | Railway (`pnpm worker:start`, entry `apps/api/src/worker.ts`, `WORKER_INLINE=false`) | The only process that runs workflows and jobs: the outbox that sends every queued email and text, intake compilation, application processing, résumé scanning, screens, scheduling, reminders, credential revocation, the daily privacy-deadline check and the daily maintenance sweep. Connects as `ros_worker`, the only role that can read a credential in Vault. Writes a heartbeat on every poll and answers `GET /healthz` on `PORT`, which Railway reads only while a deployment goes live; a worker that stops finishing anything exits with code 1 and the restart policy (Always) starts it again (see "Worker health"). |
| Database | Supabase Postgres | Row-level security on every tenant table; roles `ros_app` (the API), `ros_worker` (the worker) and the owner role (migrations only). Point-in-time recovery from the plan. |
| Secrets | Supabase Vault | Integration credentials (calendar tokens). The API role writes references; the worker role reads values. |
| Files | Supabase Storage, private bucket | Résumés, uploaded straight from the browser into quarantine, inspected and scanned by the worker before anything reads them. |
| Sign-in | Supabase Auth | Google and Microsoft with PKCE; ITS staff need Microsoft plus a second factor. |
| Rate limits | Upstash Redis (REST) | Shared counters across every API process; per-process counting if Upstash is unreachable, with an alert. |
| Email, SMS, calendar, analytics, errors | Postmark, Twilio, Google Calendar, PostHog, Sentry | Each behind an adapter with a fake used locally and in CI. Twilio stays off until the campaign is approved. |

`main` deploys to the staging Preview on Vercel and to the staging Railway worker; the `production` branch is the production pointer, for Vercel Production and a Railway worker of its own (set up with `docs/runbooks/production-setup.md`). Runbooks: `docs/runbooks/production-setup.md`, `docs/runbooks/staging-environment-variables.md`, `docs/runbooks/railway-worker.md`, `docs/runbooks/staging-database-setup.md`, `docs/runbooks/release-migrations.md`, `docs/runbooks/resume-storage.md`.

### Worker health

The worker writes a row to `worker_heartbeats` on every poll (when it looked, how many jobs were due and waiting, the oldest one's `run_at`) and serves `GET /healthz` on `PORT` (default 8080) from a plain `node:http` server: `{ ok, workerId, lastPollAt, queueDepth, oldestQueuedAgeSeconds }` (the release version is on the heartbeat row, never in this session-less body), 200 while it polls and 503 once the last successful poll is older than three poll intervals plus thirty seconds (`3 × WORKER_POLL_MS + 30 s`). The worker service's Railway settings name that path as its health check (`docs/runbooks/railway-worker.md`), but Railway reads it only while a deployment goes live and restarts only a process that exits. So the worker watches itself: when no poll, job or workflow step has finished for `WORKER_STALL_EXIT_MS` (15 minutes by default), it logs `[worker] stalled: …` and exits with code 1, and the restart policy, Always, starts it again. The app's `/healthz` reports the newest heartbeat as `worker: { lastSeenAt, queueDepth, healthy }` when `WORKER_INLINE=false` (`healthy` turns false after ten minutes without one) and `worker: "inline"` in development. It needs no session, so each app process checks the database and the worker at most once every five seconds and answers the requests in between from that check, a failed one (503) included; `?strict=1` reads the same check.

Nothing in the queue fails silently: a job that uses up its attempts raises a `job.failed` alert in the console's Failures tab, and both failed jobs and workflow runs that failed for good reach Sentry with their kinds and ids (never a payload or a run's state) and the last error text scrubbed of secrets, email addresses and phone numbers and cut at 300 characters; the console's alert keeps the fuller text. The same checks raise `worker.stale` (no heartbeat for ten minutes while `WORKER_INLINE=false`) and `queue.stale` (a due job waiting more than thirty minutes), at most once an hour and never while one is already open. They run from three places: the app's `/healthz` (at most every five minutes per process, so a stopped worker is still noticed; point the uptime monitor at `/healthz?strict=1`, which answers 503 while the worker is stale), the worker's hourly `ops.health_check` job, and the daily maintenance sweep. Only the first notices a stopped worker: the other two run on it, and the app checks only when its `/healthz` is called, which is why production has an uptime monitor (`docs/runbooks/production-setup.md`, step 9). The two recurring jobs (privacy deadlines, maintenance) arm their next run even when a run fails.

### The app on Vercel

`apps/shell/vercel.json` pins the framework (`nextjs`) and the region (`pdx1`, Portland, the region nearest the Oregon database). The migration files are read from `ROS_MIGRATIONS_DIR`, which `apps/shell/next.config.ts` sets to `packages/db/migrations` because the bundler rewrites the module path the database package would otherwise resolve them from; the boot check that refuses to start while a migration is pending reads them there. `SENTRY_ENVIRONMENT=staging` marks the staging Preview (it runs with `NODE_ENV=production`) and enables `POST /api/v1/admin/observability/test-error`, the platform administrators' deliberate, audited error for the scrubbing proof in `docs/readiness/03` section 6. The route is allow-listed, not deny-listed: it exists in a development process and in a production build whose `SENTRY_ENVIRONMENT` is exactly `staging`; every other production process answers 404, whatever its environment is named. The production deployment refuses to start with `SENTRY_ENVIRONMENT=staging` (see "Production or staging").

**Database connections.** The app reaches Postgres through Supabase's session pooler (port 5432; `docs/readiness/20` blocker 2b says why not the transaction pooler), which lets each role hold 15 client connections at once, idle ones included; `ros_worker` and the owner have 15 of their own. Every Vercel instance of every live deployment keeps its own pool of up to `DATABASE_POOL_MAX` (3) of `ros_app`'s 15. Vercel suspends an instance as soon as its requests finish, and a suspended instance's timers do not run, so a connection still open at that moment stays open on the pooler until Vercel discards the instance minutes later. That is how three redeploys in a row filled the pooler on 12 October 2026: the old deployments' instances were frozen holding their connections, and the new deployment's first query was refused with `(EMAXCONNSESSION) max clients reached in session mode` (the browser showed "Application error" with a digest). So every route handler, and `getMe`, takes the container through `getShellForRequest` (`apps/shell/lib/container.ts`), which uses Next.js `after()` to keep the request alive until the pool's 5-second idle timer has closed its connections; an instance is then suspended holding none. A query that cannot get a connection fails after 10 seconds instead of waiting out the 60-second `maxDuration`. `EMAXCONNSESSION` in the logs still means the 15 are in use; because the app stops waiting after 10 seconds, sooner than the pooler refuses a connection, a full pooler can also show up only as node-postgres's `Connection terminated due to connection timeout` or `timeout exceeded when trying to connect` (which can also mean a slow network): see "Reading a failure" in `docs/runbooks/staging-database-setup.md`. Do not raise the pooler's Pool Size on the Micro database: it applies to each role, and three roles at 20 would take all 60 of the database's connections, which Auth and Storage share. The wait is not a hard cap (more than five busy instances at once can still need more than 15); only the transaction pooler is one (register section Q, 12 October 2026).

### Production or staging

Staging and production both run `NODE_ENV=production`, so `NODE_ENV` cannot tell them apart; `DEPLOY_ENV` does: `production` or `staging`, unset on a person's machine and in tests. On Vercel, its own `VERCEL_ENV` says the same without it (`production` on a Production deployment, `preview` on a Preview deployment, which is staging). The Railway worker has no `VERCEL_ENV`, so the production worker must set `DEPLOY_ENV=production`; set it in Vercel's Production environment too, so nothing depends on Vercel exposing its system variables. A process under `NODE_ENV=production` that neither names refuses to start, so a forgotten `DEPLOY_ENV` never runs the production worker under staging's rules: the staging Railway worker sets `DEPLOY_ENV=staging` (since 29 October 2026), and the staging Preview on Vercel needs nothing (`VERCEL_ENV=preview` names it).

**Strict mode** is the production deployment: `DEPLOY_ENV=production` or `VERCEL_ENV=production`. Each process checks its environment when it starts (a Vercel instance on its first request, the worker at launch; never during `next build`, `apps/api/src/env.ts`) and refuses to start with a message naming the variable and what to do:

1. **Any process:** `DEPLOY_ENV` set to anything but `production` or `staging`; `DEPLOY_ENV=staging` on a Vercel Production deployment; `DEPLOY_ENV=production` on a Vercel Preview deployment; strict mode without `NODE_ENV=production`; `SIGNUP_MODE` set to anything but `open` or `invite`, or a `SIGNUP_ALLOWED_EMAILS` entry that is neither a full address nor `@domain`.
2. **`NODE_ENV=production`, staging and production alike:** neither `DEPLOY_ENV` nor `VERCEL_ENV` naming the deployment; `SESSION_SECRET` unset; `APP_BASE_URL` not an `https` origin without a path, or `JOBS_BASE_URL` set but not one; `ANALYTICS_SALT` unset; `SECRET_STORE` not `vault`; `AI_PROVIDER=fake`; `AUTH_PROVIDER` not `supabase`; `SUPABASE_URL` or `SUPABASE_ANON_KEY` unset; the app without `DATABASE_URL`, the worker without `WORKER_DATABASE_URL`; `WORKER_INLINE` not `false`; `STORAGE_PROVIDER` not `supabase`; the app's `RATE_LIMIT_STORE` not `upstash`, or without `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`; `RATE_LIMIT_STORE=fake` in either process; `COMPANY_CHECK=auto`. Once connected: a database role that is a superuser or bypasses row-level security, or a migration not applied.
3. **Strict mode only, the production deployment:**
   - `EMAIL_PROVIDER` not `postmark`; `POSTMARK_SERVER_TOKEN` unset; the app without a `POSTMARK_WEBHOOK_SECRET` of at least 32 characters (the worker sends email but answers no webhook); a `POSTMARK_INBOUND_SECRET` that is set but shorter than that.
   - `SUPABASE_URL`, `DATABASE_URL`, `WORKER_DATABASE_URL` or `STORAGE_S3_ENDPOINT` naming staging's Supabase project (`vjuaiyjmtrenbrmujvtc`), as a host or in the pooler user: production has a project of its own.
   - The app without `SIGNUP_MODE` (`invite` until trials open: who may open a company is decided on purpose, never left to the default); `MAGIC_LINK_ENABLED=true` on either process (the email link would open sessions outside the identity service's checks).
   - `EMAIL_FROM_ADDRESS`, `EMAIL_REPLY_TO` or `ITS_QUEUE_EMAIL` not set by hand (on a person's machine they fall back to `.localhost` addresses; `EMAIL_REPLY_TO` is printed on job pages), or ending in `localhost`. `EMAIL_INTAKE_DOMAIN` may end in `localhost`: that is how inbound email stays off.
   - Neither `DATABASE_SSL_CA` nor `DATABASE_SSL_CA_FILE` (nor an `sslrootcert` in the process's own connection string): without a certificate the database client connects without TLS.
   - `AI_PROVIDER=anthropic` without `ANTHROPIC_API_KEY`.
   - `SENTRY_ENVIRONMENT=staging` (it opens the staging-only test-error route), `RATE_LIMIT_OVERRIDES` set, or `COOKIE_DOMAIN` set (the session cookie stays host-only).
   - `SESSION_SECRET` or `ANALYTICS_SALT` shorter than 32 characters.
   - The worker only: `SCAN_PROVIDER` not `clamav`, or `CLAMAV_HOST` unset.
   - `BOOTSTRAP_ADMIN_EMAILS` set is not refused (the first administrator needs it once), but every start warns until it is removed.

Staging keeps booting as before, its worker now with `DEPLOY_ENV=staging`: on fake email and the fake scanner it raises the standing `email.fake` and `scanner.fake` alerts instead. A value an adapter cannot use also stops the start, in any environment: an AI model other than the two allowed, an unknown `STORAGE_PROVIDER` or `SCAN_PROVIDER`, `SCAN_PROVIDER=clamav` without `CLAMAV_HOST`, a `DATABASE_SSL_CA` that is not a PEM certificate.

**Search engines.** Only the production deployment's `robots.txt` lets crawlers in (to `/careers/`) and names the sitemap. Everywhere else it is `User-agent: *` and `Disallow: /` with no sitemap, and a hosted deployment that is not production (`VERCEL_ENV=preview` or `DEPLOY_ENV=staging`) also sends `X-Robots-Tag: noindex, nofollow` on every response (`apps/shell/next.config.ts`, read when the build writes its routes). Check on staging: `curl.exe -sI <staging address>/welcome` shows `x-robots-tag: noindex, nofollow`.

## Environment variables

Defaults are the local development values. In the Required column, "prod" means the boot check refuses to start without it under `NODE_ENV=production` (staging and production), and "strict" that the production deployment refuses to start without it (or with another value) while staging still boots; both lists are in "Production or staging" above. Every variable read by `apps/api/src/env.ts` and `packages/integrations/src/registry.ts` is in a table below (checked against both files on 30 September 2026); a few others are read by the Next.js shell (`apps/shell`) and the worker entry, and are listed with their neighbours.

### Addresses and secrets

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `NODE_ENV` | | `development` | `production` turns on the boot checks marked prod (staging and production) |
| `DEPLOY_ENV` | prod, unless `VERCEL_ENV` names the deployment: every Railway worker; Vercel Production too | unset | `production` or `staging`: which hosted deployment this is ("Production or staging"). `production` (or Vercel's `VERCEL_ENV=production`) is strict mode, which turns on the checks marked strict; anything else is refused, and so is a value that contradicts `VERCEL_ENV`, and a `NODE_ENV=production` process that neither names. Anything but production serves a `robots.txt` that keeps search engines out |
| `APP_BASE_URL` | prod (https, no path) | `http://localhost:3000` | The one public address of the deployment: links in email, OAuth redirects, candidate pages, webhooks. Also the origin a browser must post from: a change under `/api` whose `Origin` names another address (other than `JOBS_BASE_URL`) is refused with 403 `cross_site` (docs/spec/09 section 6), so staff open the app at this address, not at a deployment's own Vercel address |
| `JOBS_BASE_URL` | prod, when set: an https origin with no path | `APP_BASE_URL` (trailing slash stripped) | The public job-page host (docs/spec/20 item 1): careers and job pages, apply pages, the sitemap, the feeds, posting packages, tracked application links, and the links in candidate status, screening and email-failure messages are built from it (interview scheduling links stay on `APP_BASE_URL`). Unset, one host serves everything. Set to `https://jobs.identifiedtalent.com` once that domain is attached to the same Vercel deployment and its DNS record exists (founder gate 2.5) |
| `SESSION_SECRET` | prod; strict: 32+ characters | dev value | Seals session, PKCE, second-factor and calendar-consent cookies; keys rate-limit hashes |
| `COOKIE_DOMAIN` | strict: unset | unset | Cookie `Domain` when the app is served under several hostnames of one site. The production deployment refuses it: its session cookie stays host-only |
| `ANALYTICS_SALT` | prod; strict: 32+ characters | `dev-only-analytics-salt` | Salt for the keyed analytics identifiers; different per environment, never reused between staging and production |
| `TRUST_PROXY_HOPS` | | `1` | Proxies in front of the app that append to `X-Forwarded-For` (Vercel: 1); only that entry is trusted as the client address |
| `ROS_REPO_ROOT` | | detected | Where relative data paths resolve; set only when a bundler hides the workspace root |

### Database and migrations

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | prod (app); strict: not staging's project | PGlite when unset | Connection string for `ros_app` (never a superuser or an RLS-bypassing role; the boot check refuses both) |
| `WORKER_DATABASE_URL` | prod (worker); strict: not staging's project | | Connection string for `ros_worker` |
| `MIGRATE_DATABASE_URL` | release step | | The owner role, used only by `pnpm db:migrate`, `pnpm db:seed` and `pnpm db:status` |
| `ROS_DB_ENV`, `ROS_DB_PROJECT_REF` | the database tools | | Which database the tools work on: `staging` or `production`, and for production its Supabase project reference. `pnpm db:status`, the setup and the delivery of the two strings refuse to run without `ROS_DB_ENV`, and with it every tool, `pnpm db:migrate` included, refuses an owner string from another Supabase project, staging's for production (`packages/db/src/cli/environment.ts`). The setup scripts and the `migrate` workflow set them; never on Vercel or Railway |
| `DATABASE_SSL_CA` / `DATABASE_SSL_CA_FILE` | strict | | Supabase's certificate authority, as text (hosted) or a file path (a person's machine); verification is never off. Without one (or an `sslrootcert` in the connection string) the client connects without TLS, so the production deployment refuses to start |
| `DATABASE_POOL_MAX` | | `3` | Connections per process (on Vercel, per instance) on the session pooler; every instance of every live deployment shares `ros_app`'s 15. Idle connections close after 5 s and each request waits for that before Vercel suspends the instance; a query that cannot get a connection fails after 10 s. The Railway worker sets `5` (`ros_worker` has its own 15) |
| `PGLITE_DIR` | | `./.data/pglite` | Local database directory (`memory://` for tests) |
| `RUN_MIGRATIONS_ON_BOOT` | | off | Never in production: the app refuses to start while a migration is pending; migrations are a release step (`pnpm db:migrate` or the `migrate` GitHub workflow; `docs/runbooks/release-migrations.md`) |
| `ROS_MIGRATIONS_DIR` | | set by `next.config.ts` | Where the migration files are read from by the boot check and the migration tools; the shell sets it because the bundler hides the package path |

### Sign-in and staff

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `AUTH_PROVIDER` | prod = `supabase` | `fake` | `supabase` delegates sign-in to Supabase Auth; `fake` is an in-process issuer for development and tests |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | prod; strict: `SUPABASE_URL` not staging's project | | The project and its publishable key (the token endpoint and the factor endpoints) |
| `SUPABASE_JWT_SECRET` | | | Verifies HS256 tokens; otherwise the project's published keys are used |
| `AUTH_SIGNIN_PROVIDERS` | | `azure,google` | Which delegated providers the sign-in page offers, and the only ones a session opens through: a token from any other provider is refused (`provider_not_allowed`) |
| `ITS_STAFF_EMAIL_DOMAINS` | | `identifiedtalent.com` | Users on these domains are ITS staff: Microsoft plus a second factor. A staff account must hold Microsoft only at the identity service: one that also holds another provider is refused (`staff_provider_linked`) until ITS removes that link |
| `BOOTSTRAP_ADMIN_EMAILS` | once | | The first platform administrator, granted on that address's first Microsoft sign-in with a second factor while no administrator exists; remove afterwards. The production deployment warns at every start while it is set |
| `MAGIC_LINK_ENABLED` | strict: not `true` | on outside production | The internal email sign-in link; production defaults to off, and the production deployment refuses it on: its sessions would open outside the identity service's checks |
| `SIGNUP_MODE` | strict (the app): set | `open` | Who may create a company (GATE-V2); the production app refuses to start without it, so leaving it out never opens sign-up. `open`: anyone signed in with Google or Microsoft who has no company yet (founder decision B7). `invite`: only a platform administrator or an address on `SIGNUP_ALLOWED_EMAILS`; anyone else is refused with 403 `signup_invite_only`, the company step shows "Recruiting OS is by invitation for now" and the `EMAIL_REPLY_TO` inbox instead of its form, and the welcome page drops its "Get help with your next hire" link. Signing in and joining a company by invitation work in both. Any other value stops the start. The pilot scope is one design partner (`docs/readiness/20`, section C), so staging and the production deployment set `invite` until the founder opens trials with customer terms |
| `SIGNUP_ALLOWED_EMAILS` | | | With `SIGNUP_MODE=invite`, who may still create a company: full addresses and `@domain` entries (that domain only, not its subdomains), comma-separated, any case. An entry that is neither stops the start; set while `SIGNUP_MODE` is not `invite` it only warns, because anyone may still create a company. Adding a tester: `docs/runbooks/production-setup.md`, "Letting a tester in" |

### AI

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `AI_PROVIDER` | prod = `anthropic` | `fake` | `fake` is deterministic and refused in production |
| `ANTHROPIC_API_KEY` | when anthropic; strict | | The production deployment refuses to start without it |
| `AI_MODEL_JUDGMENT` / `AI_MODEL_STANDARD` / `AI_MODEL_FAST` | | Claude Sonnet 5.5 / Haiku 5.5 / Haiku 5.5 | Model routing overrides: only `claude-haiku-5-5` and `claude-sonnet-5-5` are accepted; any other value stops the app at start |

### Messages

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `EMAIL_PROVIDER` | strict = `postmark` | `fake` | `fake` or `postmark`. Staging may run on `fake` (with a standing `email.fake` alert); the production deployment refuses it |
| `POSTMARK_SERVER_TOKEN` | when postmark; strict | | Sending |
| `POSTMARK_INBOUND_SECRET` | when postmark; strict, when set: 32+ characters | | Inbound webhook (basic auth in the URL or the `x-inbound-secret` header; a query string is refused). With `EMAIL_PROVIDER=postmark` and an `EMAIL_INTAKE_DOMAIN` that does not end in `localhost`, it switches on email-in and candidate replies (`emailInConfigured` in the registry); the domain's MX record must point at Postmark's inbound server |
| `POSTMARK_WEBHOOK_SECRET` | when postmark; strict (the app): 32+ characters | | Bounce, complaint and delivery webhooks; a made-up password (`scripts/new-secret.ps1`), also entered as the webhook's password in Postmark |
| `EMAIL_FROM_DOMAIN` | | `mail.localhost` | Sending domain (SPF, DKIM, DMARC at the provider); builds the default `EMAIL_FROM_ADDRESS`, which the production deployment sets by hand |
| `EMAIL_FROM_ADDRESS` | strict, not `localhost` | `updates@<EMAIL_FROM_DOMAIN>` | The single sending address; display names name the customer's hiring team |
| `EMAIL_REPLY_TO` | strict, not `localhost` | `ITS_QUEUE_EMAIL` | Monitored ITS mailbox for candidate replies while the inbound domain is not configured; a person reads it. Also the help and accommodation contact printed on job, careers and apply pages. With the inbound domain live, every candidate email carries a per-application `reply-<token>@` address and replies come back into the product (docs/runbooks/candidate-replies.md) |
| `EMAIL_INTAKE_DOMAIN` | for email-in and replies | `intake.localhost` | Per-role intake addresses and per-application `reply-<token>@` addresses. While it ends in `localhost` (or `POSTMARK_INBOUND_SECRET` is missing) email-in shows as not connected, board postings rely on their apply links, and replies go to `EMAIL_REPLY_TO`; the production deployment may start that way |
| `ITS_QUEUE_EMAIL` | strict, not `localhost` | `recruiters@its.localhost` | The ITS queue mailbox: recruiter requests, administrator changes, ended access |
| `PRIVACY_EMAIL` | | `privacy@identifiedtalent.com` | The privacy-request address shown to candidates |
| `PRODUCT_NAME` | | `Recruiting OS` | Internal product name in owner- and staff-facing system mail |
| `SMS_PROVIDER` | | `fake` | `fake` or `twilio` |
| `MESSAGE_UNDO_SECONDS` | | `30` (tests `0`) | How long a message a person sends to a candidate (a decision message, a team message) waits with an Undo before it leaves; 0 to 120, 0 sends at once |
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
| `STORAGE_BUCKET`, `STORAGE_S3_ENDPOINT`, `STORAGE_S3_REGION`, `STORAGE_S3_ACCESS_KEY_ID`, `STORAGE_S3_SECRET_ACCESS_KEY` | when supabase; strict: `STORAGE_S3_ENDPOINT` not staging's project | | From the dashboard's S3 Configuration screen; the bucket is private |
| `SCAN_PROVIDER` | strict (the worker) = `clamav` | `fake` | `fake` (development, tests, and the app, which never scans a file) or `clamav` on the worker (a clamd service reached over private networking; `docs/runbooks/resume-storage.md`). A staging worker on `fake` raises a standing `scanner.fake` alert; the production worker refuses to start on it: a real engine is a real-data gate (`docs/readiness/20` blocker 8) |
| `CLAMAV_HOST`, `CLAMAV_PORT`, `CLAMAV_TIMEOUT_MS` | `CLAMAV_HOST` when clamav (boot refuses without it) and on the production worker | none, `3310`, `20000` | The clamd service's private hostname (Railway: `<service>.railway.internal`), its port and the connection, send and reply timeout in milliseconds; a port or timeout that is not a positive number is refused at boot |
| `SECRET_STORE` | prod = `vault` | `memory` | Supabase Vault in production; production refuses `memory` |

### Rate limits, policy, observability, worker

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `RATE_LIMIT_STORE` | prod app = `upstash` | `memory` | `memory` (one process; development), `upstash` (shared between every process; staging and production), `fake` (tests only). The production app refuses to start with anything but `upstash`: on Vercel's many short-lived instances a per-process count is close to no limit. The worker counts no requests, so it is held only to "never `fake`": the production worker uses `memory`, which keeps the Upstash token off Railway, and a worker set to `upstash` needs both values below (`docs/runbooks/railway-worker.md`). If Upstash cannot be reached at run time, each process counts on its own and raises a `rate_limit.shared_unavailable` alert (`docs/readiness/15`) |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | prod app; any process set to upstash | | The database's REST endpoint and its token; the production app refuses to start without either, and so does any process set to `upstash`. The token is a secret entered at the host (`docs/runbooks/staging-environment-variables.md`) |
| `RATE_LIMIT_OVERRIDES` | strict: unset | `{}` | Per-policy limit overrides as JSON, for tests and staging rehearsals; the production deployment refuses to start with it |
| `CSP_MODE` | | `report-only` | Both content-security policies (candidate pages and the application); `enforce` after the staging reports are reviewed. Every browser journey passed under `enforce` locally on 12 October 2026 (`docs/readiness/18`) |
| `COMPANY_CHECK` | | `its` (`auto` under `NODE_ENV=test`) | The one-time ITS check of a company that signs itself up (founder decision B7): with `its` its careers page, job pages, Google listing and first candidate emails wait until an administrator confirms it in the admin console; `auto` confirms every new company at once (tests and local journeys; `.env.example` sets it, so a company created on your own machine is live without a visit to /admin). Production refuses `auto` |
| `ANALYTICS_PROVIDER`, `POSTHOG_PROJECT_API_KEY`, `POSTHOG_HOST` | | `fake` | Server-side funnel events only |
| `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `NEXT_PUBLIC_SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE` | | off | Scrubbed error reporting; empty DSN means off. `SENTRY_DSN` is read by the server processes (the shell and the worker), `NEXT_PUBLIC_SENTRY_DSN` by the staff web app's browser bundle only (candidate pages carry no script), which names its environment from `NEXT_PUBLIC_SENTRY_ENVIRONMENT` (default `development`). `SENTRY_ENVIRONMENT=staging` names the staging Preview and enables the administrators' test-error route; the production deployment refuses to start with it |
| `VERCEL_GIT_COMMIT_SHA`, `RAILWAY_GIT_COMMIT_SHA` | | set by the host | The release identifier on error reports and on the worker's heartbeat; never set by hand |
| `VERCEL_ENV` | | set by Vercel | `production` on a Production deployment (strict mode, as `DEPLOY_ENV=production`), `preview` on a Preview deployment (staging); never set by hand |
| `WORKER_INLINE` | prod = `false` | `true` | Run the queue inside the app process (development only) |
| `WORKER_POLL_MS` | | `500` | The worker's idle poll interval; the worker's health check goes stale after three of them plus thirty seconds |
| `WORKER_STALL_EXIT_MS` | | `900000` (15 minutes) | Read by the worker entry (`apps/api/src/worker.ts`): when no poll, job or workflow step has finished this long, the worker logs `[worker] stalled: …` and exits with code 1, so the restart policy (Always) starts it again. Values under `60000` are raised to `60000` |
| `PORT` | worker | `8080` | The worker's health-check port (`GET /healthz`); Railway sets it |

No longer read: `WEB_BASE_URL` (the app and the API share `APP_BASE_URL`), `RATE_LIMIT_SHARED_PROVIDER` and `RATE_LIMIT_SHARED_URL` (folded into `RATE_LIMIT_STORE`; the old spelling is understood with a warning), `LOG_LEVEL`, `PLATFORM_ADMIN_EMAILS`.

## Release process

1. **CI** on every push and pull request (`.github/workflows/ci.yml`): lockfile install, secret scans, dependency audit, typecheck, Biome lint, migration validation, the tests (row-level security, tenant isolation, the service-role guard, the schema-drift check, unit, integration and scenario), evals with the fake provider, the Next.js production build, browser journeys with accessibility checks.
2. **Migrations are a release step.** Run `pnpm db:migrate` with `MIGRATE_DATABASE_URL` (the owner role) from the founder's machine, or the `migrate` GitHub workflow (Actions, "migrate", pick the environment, `staging` or `production-database`; its secrets hold the owner connection string, and it names the database to the tools with `ROS_DB_ENV`; the status report before the apply step never fails on a pending migration). Production migrates only through the workflow. Migrations are additive within a release and validated for destructive statements. Production never migrates on boot and refuses to start while one is pending. `docs/runbooks/release-migrations.md` is the release-day procedure, including what the boot refusal looks like and why the setup script (which rotates passwords) is never used for a release. The release of 30 September 2026 adds five migrations, all additive, to apply in one run before the deploy: `0020_job_distribution.sql` (the nine posting states and their columns, `application_links`, `applications.source_detail` and `link_id`, the accepting switch and volume threshold on `roles`), `0021_worker_heartbeats.sql` (the worker's health rows), `0022_invitations.sql` (team invitations as rows of their own), `0023_reply_tokens.sql` (`applications.reply_token` for candidate replies) and `0024_session_reauth.sql` (`sessions.reauthenticated_at`). The validator passes on 25 files, 0000 to 0024.
3. **Deploy** the worker (the staging worker follows `main`, the production worker `production`), then the app (Vercel deploys `main` to the staging Preview; production follows the `production` branch). A production release is the `migrate` workflow run from `main` with `production-database`, then a pull request from `main` into `production` merged with a merge commit, which deploys the production worker and the app (`docs/runbooks/production-setup.md`, "Every later release"). Work a newer build queued waits for a worker that knows it, for up to a day (`NEWER_BUILD_PATIENCE_MS` in `packages/workflows/src/engine.ts`), under the console alert "An older worker build is running", which resolves itself once such a worker runs it.
4. **Rollback** is a redeploy of the previous deployment; a migration is never rolled back, which is why every migration is written to be compatible with the previous release.
5. **Retention** is a daily worker job: finished queue jobs after seven days, expired sessions and sign-in links after a day, webhook receipts after thirty days, policy reports after ninety, worker heartbeats not seen for a week, and any message left mid-send is reported for a person. The same job runs the stale-worker and stale-queue checks, and arms its next run even when a sweep fails. Candidate data follows the privacy-request process and the anonymization rules in `docs/09`, never this sweep.
