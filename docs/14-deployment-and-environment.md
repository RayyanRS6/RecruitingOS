# 14. Deployment and environment

Where the app runs, what each process checks when it starts, and every environment variable. How to run it on a laptop is in the [root README](../README.md). How to set up production and release to it is in [runbooks/production-setup.md](runbooks/production-setup.md).

## Where it runs

| Piece | Where | What it does |
|---|---|---|
| The app | Vercel, project root `apps/shell` (Next.js 15), region `pdx1` (`apps/shell/vercel.json`) | One deployment and one origin (`APP_BASE_URL`): the company's app and the admin dashboard; the API under `/api`; the candidate pages under `/careers`, `/c` and `/privacy`; the email webhooks under `/webhooks`; `/healthz`, `/sitemap.xml` and `/robots.txt`. Only a path with a route handler in `apps/shell/app` reaches the API. |
| The worker | Railway (`pnpm worker:start`, entry `apps/api/src/worker.ts`) | The only process that runs workflows and queued jobs: an application (the file is checked and scanned, the resume read and scored), an AI interview with its reminder and its scorecard, a job's two posts, the outbox that sends every queued email, and the daily and hourly checks. It connects as `ros_worker`. Its runbook: [runbooks/railway-worker.md](runbooks/railway-worker.md). |
| Database | Supabase Postgres | Row-level security on every table that holds a company's data. Three roles: `ros_app` (the app), `ros_worker` (the worker) and the owner role (migrations only). |
| Files | Supabase Storage, one private bucket | Resumes and company logos: [runbooks/resume-storage.md](runbooks/resume-storage.md). |
| Sign-in | Supabase Auth | Google and Microsoft. Platform staff need Microsoft and a second factor: [runbooks/staff-second-factor.md](runbooks/staff-second-factor.md). |
| Rate limits | Upstash Redis (REST) | One count shared by every instance of the app ("Rate limits" below). |
| AI | Anthropic | Claude Haiku 5.5 and Claude Sonnet 5.5 only (`packages/ai/src/routing.ts`). |
| Email | Postmark | Sends every email; reports bounces, complaints and unsubscribes to `/webhooks/postmark/*`. |
| Analytics, errors | PostHog, Sentry | Both optional and off unless their variables are set. Analytics are server-side events only; candidate pages load no analytics. |

On a laptop there is one process: the Next.js app mounts the API, PGlite is the database, `WORKER_INLINE=true` runs the queue inside the app, and every outside service is a stand-in.

**Two hosted deployments.** The `production` branch deploys production: Vercel Production and the production worker. Every push to `main` deploys a Vercel Preview, which the code calls staging (`VERCEL_ENV=preview`, or `DEPLOY_ENV=staging` on a worker). Both run `NODE_ENV=production`. Nothing is walked through on the Preview: a release is tested on production with made-up people ([DECISIONS.md](DECISIONS.md), "Hosting and releases").

**Search engines.** Only production's `robots.txt` lets crawlers in (to `/careers/`) and names the sitemap. Any other hosted deployment answers `Disallow: /` and sends `X-Robots-Tag: noindex, nofollow` on every response (`apps/shell/next.config.ts`).

## What a process checks when it starts

Each process reads its environment when it starts (a Vercel instance on its first request, the worker at launch; `apps/api/src/env.ts`) and refuses to start with a message that names the variable. The table below marks each variable; the rules that are not about one variable:

- **Any process.** `DEPLOY_ENV` is unset, `production` or `staging`, and never contradicts Vercel's `VERCEL_ENV`. `SIGNUP_MODE` is unset, `open` or `approval`.
- **Hosted** (`NODE_ENV=production`, both deployments). The deployment is named, by `VERCEL_ENV` or `DEPLOY_ENV`. The database role is neither a superuser nor able to bypass row-level security. No migration is pending: a hosted process never migrates by itself.
- **Production only** (`DEPLOY_ENV=production` or `VERCEL_ENV=production`). No value names the Preview's Supabase project (`STAGING_SUPABASE_REF` in `apps/api/src/env.ts`). The database connection has a certificate, so it is never made without TLS. The worker scans with ClamAV.

A value an adapter cannot use also stops the start anywhere: an AI model other than the two allowed, an unknown `STORAGE_PROVIDER` or `SCAN_PROVIDER`, `SCAN_PROVIDER=clamav` without `CLAMAV_HOST`, a certificate that is not a PEM certificate.

## Environment variables

Every variable the code reads. "Default" is what a laptop gets with nothing set. **must** means the process refuses to start without it (or with another value): "hosted" on both hosted deployments, "production" on production only. The two right-hand columns say what production sets on each side; "no" means never set there, "unset" means left to its default. Secrets are named by where they come from, never written here.

### The deployment and its addresses

| Variable | What it does | Default | The app (Vercel) | The worker (Railway) |
|---|---|---|---|---|
| `NODE_ENV` | `production` turns on the hosted checks | `development` | set by Vercel | **must** `production` |
| `DEPLOY_ENV` | Names the deployment: `production` or `staging`. `production` turns on the production-only checks | unset | `production` (Vercel's `VERCEL_ENV` says the same) | **must** `production`: the worker has no other way to know |
| `VERCEL_ENV` | `production` on a Production deployment, `preview` on a Preview | set by Vercel | never by hand | no |
| `APP_BASE_URL` | The one public address: links in email, sign-in redirects, candidate pages, webhooks. A change under `/api` posted from another origin is refused (403 `cross_site`), so everyone opens the app at exactly this address | `http://localhost:3000` | **must** (hosted): an https origin with no path | the same value |
| `JOBS_BASE_URL` | A separate host for job pages, the form, the sitemap and the links in candidate emails | `APP_BASE_URL` | unset: one host serves everything | the same as the app |
| `TRUST_PROXY_HOPS` | How many proxies add to `X-Forwarded-For`; only that entry is trusted as the client's address | `1` | `1` | unset |
| `SESSION_SECRET` | Seals the session, sign-in and second-factor cookies; keys the rate-limit hashes and the upload grants | a development value | **must** (hosted); 32 characters or more on production | the same value |
| `ANALYTICS_SALT` | Salt for the keyed analytics identifiers | a development value | **must** (hosted); 32 characters or more on production | the same value |
| `COOKIE_DOMAIN` | A cookie `Domain` for an app served under several hostnames | unset | production refuses it: the session cookie stays host-only | no |
| `ROS_REPO_ROOT`, `ROS_MIGRATIONS_DIR` | Where data paths and the migration files resolve | found by the code; `apps/shell/next.config.ts` sets both | never by hand | never by hand |

### Database

| Variable | What it does | Default | The app (Vercel) | The worker (Railway) |
|---|---|---|---|---|
| `DATABASE_URL` | The connection string of `ros_app` | unset: PGlite at `PGLITE_DIR` | **must** (hosted) | no |
| `WORKER_DATABASE_URL` | The connection string of `ros_worker` | unset | no | **must** (hosted) |
| `MIGRATE_DATABASE_URL` | The owner role's string, for `pnpm db:migrate`, `db:seed` and `db:status` | unset | no | no: it lives in the GitHub environment `production-database` only |
| `DATABASE_SSL_CA` / `DATABASE_SSL_CA_FILE` | Supabase's certificate authority, as text or as a file path on a person's machine | unset | **must** (production): the text | the same value |
| `DATABASE_POOL_MAX` | Connections per process (on Vercel, per instance), 1 to 20 | `3` | `3` | `5` |
| `PGLITE_DIR` | The local database folder (`memory://` in tests) | `./.data/pglite` | no | no |
| `RUN_MIGRATIONS_ON_BOOT` | `true` lets a hosted process migrate at start | off | never | never |
| `ROS_DB_ENV`, `ROS_DB_PROJECT_REF` | Which database the tools work on, and production's Supabase project reference. The tools refuse an owner string from any other project (`packages/db/src/cli/environment.ts`) | unset | no | no: the setup scripts and the `migrate` workflow set them |
| `TEST_DATABASE_URL` | Runs the isolation and privacy tests against a real, empty Postgres instead of PGlite | unset | no | no |

The setup scripts pass a few values of their own to the database tools (`ROS_PROVISION_MODE`, `ROS_PROVISION_DELIVERY`, `ROS_APP_PASSWORD`, `ROS_WORKER_PASSWORD`, `ROS_OWNER_URI`, `ROS_DELIVERY_TIMEOUT_MS`); nobody sets them by hand.

**Connections.** The app reaches Postgres through Supabase's session pooler, which gives each role 15 client connections; `ros_worker` and the owner have 15 of their own. Every Vercel instance keeps a pool of up to `DATABASE_POOL_MAX`. Vercel suspends an instance as soon as its requests finish, so each request waits until the pool's 5-second idle timer has closed its connections (`getShellForRequest`, `apps/shell/lib/container.ts`): a suspended instance holds none. A query that cannot get a connection fails after 10 seconds. `(EMAXCONNSESSION) max clients reached in session mode` in the logs, or `timeout exceeded when trying to connect`, means the 15 are in use. Do not raise the pooler's pool size on a small database: it applies to each role.

### Sign-in and sign-up

| Variable | What it does | Default | The app (Vercel) | The worker (Railway) |
|---|---|---|---|---|
| `AUTH_PROVIDER` | `supabase`, or `fake`: a stand-in issuer for a laptop and the tests | `fake` | **must** (hosted) `supabase` | the same |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | The Supabase project and its publishable key | unset | **must** (hosted) | the same values |
| `SUPABASE_JWT_SECRET` | Verifies HS256 tokens; without it the project's published keys are used | unset | unset | unset |
| `AUTH_SIGNIN_PROVIDERS` | The providers the sign-in page offers, and the only ones a session opens through | `azure,google` | `azure,google` | unset |
| `ITS_STAFF_EMAIL_DOMAINS` | People on these domains are platform staff: Microsoft and a second factor | the staff domain in `env.ts` | the staff domain | unset |
| `BOOTSTRAP_ADMIN_EMAILS` | The first platform administrator, once ([production-setup.md](runbooks/production-setup.md), "First administrator") | unset | set once, then removed; production warns at every start while it is set | no |
| `MAGIC_LINK_ENABLED` | The email sign-in link, a development aid | on, off under `NODE_ENV=production` | production refuses `true` | the same |
| `SIGNUP_MODE` | How a company comes in. `approval`: the company form sends a request, and nothing of the company works or is public until a platform administrator accepts it. `open`: a company is live the moment it is created | `open` | **must** (hosted) `approval`, on Production and on Preview | unset or `approval`. The worker reads no sign-up mode, but any other value stops it too |

### AI

| Variable | What it does | Default | The app (Vercel) | The worker (Railway) |
|---|---|---|---|---|
| `AI_PROVIDER` | `anthropic`, or `fake`: a deterministic stand-in | `fake` | **must** (hosted) `anthropic` | the same |
| `ANTHROPIC_API_KEY` | The key | unset | **must** (production) | the same key |
| `AI_MODEL_JUDGMENT` / `AI_MODEL_STANDARD` / `AI_MODEL_FAST` | The model of each tier. Only `claude-haiku-5-5` and `claude-sonnet-5-5` are accepted | Sonnet 5.5 / Haiku 5.5 / Haiku 5.5 | unset | unset |
| `AI_EFFORT_JUDGMENT` / `AI_EFFORT_STANDARD` / `AI_EFFORT_FAST` | How hard a tier thinks: `low`, `medium` or `high`. The fairness run sets one to compare | the app's own (`packages/ai/src/routing.ts`) | unset | unset |

### Email

| Variable | What it does | Default | The app (Vercel) | The worker (Railway) |
|---|---|---|---|---|
| `EMAIL_PROVIDER` | `postmark`, or `fake`: nothing is sent, and a hosted deployment raises a standing `email.fake` alert | `fake` | **must** (production) `postmark` | the same |
| `POSTMARK_SERVER_TOKEN` | Sending | unset | **must** (production) | the same token |
| `POSTMARK_WEBHOOK_SECRET` | The password Postmark's webhook sends; made up with `scripts/new-secret.ps1` | unset | **must** (production), 32 characters or more | unset: only the app answers webhooks |
| `EMAIL_FROM_DOMAIN` | The sending domain | `mail.localhost` | the sending domain | the same |
| `EMAIL_FROM_ADDRESS` | The one sending address; the display name is the hiring company's team | `updates@<EMAIL_FROM_DOMAIN>` | **must** (production): set by hand | the same |
| `EMAIL_REPLY_TO` | The mailbox candidate replies land in; a person reads it. Also the contact printed on job pages for a company that set none of its own | `ITS_QUEUE_EMAIL` | **must** (production): a real mailbox | the same |
| `ITS_QUEUE_EMAIL` | The platform's own mailbox: each request for access and each change of administrators | a `.localhost` address | **must** (production): a real mailbox | the same |
| `PRIVACY_EMAIL` | The privacy mailbox shown to candidates | the address in `env.ts` | the privacy mailbox | unset: the worker does not read it |
| `PRODUCT_NAME` | The product's name in mail to teams and staff, and in authenticator apps | `Recruiting OS` | the name | the same |
| `MESSAGE_UNDO_SECONDS` | How long a decision email waits before it leaves, so a person can take it back; 0 to 120 | `30` (tests `0`) | unset | unset |

### Files and scanning

| Variable | What it does | Default | The app (Vercel) | The worker (Railway) |
|---|---|---|---|---|
| `STORAGE_PROVIDER` | `memory` (tests), `local` (files under `STORAGE_DIR`) or `supabase` | `local` | **must** (hosted) `supabase` | the same |
| `STORAGE_DIR` | Where `local` storage keeps files | `./.data/files` | no | no |
| `STORAGE_BUCKET`, `STORAGE_S3_ENDPOINT`, `STORAGE_S3_REGION` | The private bucket, as Supabase's S3 screen shows it | unset | **must** with `supabase` | the same values |
| `STORAGE_S3_ACCESS_KEY_ID`, `STORAGE_S3_SECRET_ACCESS_KEY` | A storage-only key pair | unset | **must** with `supabase`: the app's pair | the worker's own pair |
| `SCAN_PROVIDER` | `clamav`, or `fake`: checks a file's type only | `fake` | `fake`: the app never scans | **must** (production) `clamav` |
| `CLAMAV_HOST`, `CLAMAV_PORT`, `CLAMAV_TIMEOUT_MS` | The ClamAV service's private hostname, its port and its timeout | none, `3310`, `20000` | no | `CLAMAV_HOST` **must** with `clamav` |

### Rate limits, the browser policy, analytics and errors

| Variable | What it does | Default | The app (Vercel) | The worker (Railway) |
|---|---|---|---|---|
| `RATE_LIMIT_STORE` | `memory` (one process), `upstash` (shared) or `fake` (tests) | `memory` | **must** (hosted) `upstash` | `memory`: the worker counts no requests. Never `fake` |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | The Upstash database's REST endpoint and its token | unset | **must** (hosted) | unset |
| `RATE_LIMIT_OVERRIDES` | Limits per policy as JSON, for tests | `{}` | production refuses it | the same |
| `CSP_MODE` | `report-only` or `enforce` ("The content-security policy" below) | `report-only` | `report-only` | no |
| `ANALYTICS_PROVIDER`, `POSTHOG_PROJECT_API_KEY`, `POSTHOG_HOST` | `posthog` sends server-side events; `fake` sends none | `fake` | `fake` | `fake` |
| `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE` | Scrubbed error reports from the server processes; off without a DSN. Production refuses `SENTRY_ENVIRONMENT=staging` | off | unset | unset |
| `NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_ENVIRONMENT` | The same for the signed-in pages' browser code; candidate pages send none | off | unset | no |
| `VERCEL_GIT_COMMIT_SHA`, `RAILWAY_GIT_COMMIT_SHA` | The build, on error reports and on the worker's heartbeat | set by the host | never by hand | never by hand |

### The worker

| Variable | What it does | Default | The app (Vercel) | The worker (Railway) |
|---|---|---|---|---|
| `WORKER_INLINE` | Runs the queue inside the app (a laptop only) | `true` | **must** (hosted) `false` | the worker's entry sets `false` itself |
| `WORKER_POLL_MS` | The worker's pause when nothing is due | `500` | no | `1000` |
| `WORKER_STALL_EXIT_MS` | The worker exits when nothing has finished for this long, so Railway restarts it; at least `60000` | `900000` (15 minutes) | no | unset |
| `PORT` | The worker's health-check port | `8080` | no | set by Railway |

The browser journeys read their own: `E2E_PORT`, `E2E_BASE_URL`, `E2E_REPORT_DIR`, `E2E_EMAIL_PROVIDER`, `E2E_SHOTS` (`tests/e2e`).

Three older names are still understood, each with a warning at start, and grant or change nothing: `PLATFORM_ADMIN_EMAILS`, `WEB_BASE_URL`, and `RATE_LIMIT_STORE=shared` with `RATE_LIMIT_SHARED_PROVIDER`. Remove them where they are found.

## Rate limits

Limits are counted per policy and subject (`POLICIES` in `apps/api/src/middleware/rate-limit.ts`): sign-in, the application form, each candidate link, the candidate pages, the API per person and per company, webhooks, security reports and requests for access. A refused request gets `429` with `Retry-After`: JSON on the API, a plain page for a candidate.

- **Keys.** A key is an HMAC of the policy and the subject under `SESSION_SECRET`, so the store holds no address, email or token.
- **The client's address** is the entry `TRUST_PROXY_HOPS` from the right of `X-Forwarded-For`, so a client cannot write its own.
- **The shared store** is Upstash Redis (`UpstashSharedCounter` in `packages/core/src/rate-limit.ts`): one request per hit, which counts and sets the key's expiry together. Turn eviction off on the database: every key carries its own expiry.
- **If Upstash cannot be reached**, each process counts the affected keys in its own memory for the rest of the window and raises the alert `rate_limit.shared_unavailable`, at most once an hour. Nothing is refused because the store is down, and nothing passes uncounted.
- **What is recorded.** The first refusal of a key in a window writes a `security.rate_limited` audit record, and the fifth raises a `security.suspicious_activity` alert.
- **Webhooks.** A delivery a provider sends again is recognised by its receipt and never refused; only repeated wrong passwords from one address are.

## The content-security policy

Two policies, each with a nonce made for the request, and neither names an outside origin: the candidate pages' (`packages/core/src/csp.ts`, set in `apps/api/src/app.ts`) and the signed-in app's (`apps/shell/lib/csp.ts`, set in `apps/shell/middleware.ts`). The fonts are served from the deployment's own `/fonts/` folder. Inline style attributes are allowed; a script runs only with the nonce, and inline event handlers never.

`CSP_MODE=report-only` sends `Content-Security-Policy-Report-Only`; `enforce` sends `Content-Security-Policy`. Nothing else differs. Browsers post what the policy blocks, or would block, to `POST /api/csp-report`. The server keeps the page's path with any candidate token removed, the directive, the blocked origin and a shortened browser name: never a query string, a token or candidate data. Identical reports are counted, not repeated. A platform administrator reads them on **System**, **Security reports**, and marks each one reviewed.

The policy stays `report-only` until every report has been reviewed ([DECISIONS.md](DECISIONS.md), N6). Switching is one change: `CSP_MODE=enforce` on Vercel, then a redeploy.

## What the worker does by itself

- **Every hour** (`ops.health_check`): marks an email left mid-send for more than five minutes, so the team is asked to check it; closes an AI call still running an hour later; settles trials; raises `queue.stale` when a due job has waited more than thirty minutes.
- **Every day** (`maintenance.daily`): deletes finished queue jobs after 7 days and failed ones after 30, expired sessions and sign-in links after a day, webhook receipts after 30 days, security reports after 90, and heartbeats of workers not seen for a week; sets aside empty job drafts; removes the words left in AI readings and workflow records of candidates deleted at their request.
- **Every day**: the privacy-request deadlines, and the note to an applicant past a plan's limit whose promised day has come.

Candidate data is never deleted by these sweeps: that follows [runbooks/privacy-requests.md](runbooks/privacy-requests.md).
