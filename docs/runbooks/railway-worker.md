# Railway: the staging worker service, one screen at a time

Status: written 23 September 2026 from Railway's documentation (docs.railway.com, read that day) for founder decision 1
(Railway hosts the worker; Trigger.dev deferred). The worker is the existing `apps/api/src/worker.ts`. Its settings
live in the worker service's **Settings** in the Railway dashboard: builder **Railpack**, build command
`pnpm worker:check`, start command `pnpm worker:start`, health check path `/healthz` with a 120-second timeout,
restart policy **On Failure** with **10** retries. Nothing here is a secret; secret values go from 1Password into
Railway's Variables tab and are sealed.

Note for the register: until 15 October 2026 these settings came from a `railway.json` file at the repository root.
Railway calls that mechanism "Config as Code", deprecated with legacy support ending 1 December 2026 (a hard cutoff).
Its replacement (`.railway/railway.ts`) is not read during deploys either; it is applied from Railway's command line,
and its documented options do not cover the restart policy (checked 9 October 2026,
docs.railway.com/infrastructure-as-code). So the dashboard holds them: the founder entered the values on 13 October
2026, they were checked against the file on 15 October 2026 (identical, and no custom config-file path set), and the
file was removed that day. **When production is created, enter the same values on the production worker's Settings.**

## Screen 1: create the service from the repository

1. Railway, workspace Identified Talent Solutions (your default workspace), project `recruiting-os-staging`.
2. On the project canvas, click **New** (top right), then **GitHub Repo**.
3. Choose `identified-talent-solutions/recruiting-os`. If it is not listed, Railway's GitHub app has no access to
   the repository yet: choose **Configure GitHub App**, grant access to that one repository only, and return.
4. Railway adds a service for the repository and connects its default branch, `main`. If the canvas shows staged
   changes with a **Deploy** button, do not click it yet: the variables come first (screen 3). If a deployment starts
   on its own, let it run; without variables the worker refuses to start and Railway stops retrying after ten
   attempts. That is harmless and expected.

Report back: the service's name as Railway shows it on the canvas, whether a deployment started, and the region shown
in the service's Settings.

## Screen 2: service settings

Select the service, **Settings** tab:

- **Service name**: `worker`.
- **Source**: repository `identified-talent-solutions/recruiting-os`, branch `main`, root directory left as the
  repository root (the worker runs from the root through `pnpm worker:start`).
- **Watch paths** (optional, reduces rebuilds): `apps/api/**`, `packages/**`, `package.json`, `pnpm-lock.yaml`,
  `pnpm-workspace.yaml`.
- **Region**: US West Metal (California, `us-west2`), the region nearest the Oregon database.
- **Build and deploy**: builder Railpack; build command `pnpm worker:check`; start command `pnpm worker:start`;
  restart policy On Failure, 10 retries. Leave **Config as Code** without a file path.
- **Health check**: path `/healthz`, timeout `120`. The worker listens on `PORT`, which Railway provides; the probe
  runs inside Railway, so no public domain or networking is needed.

## Screen 3: variables

Service, **Variables** tab. Use **RAW Editor** for the block of non-secret values, then **New Variable** for each
secret and seal it (the three-dot menu next to the variable, **Seal**). Values in the block are constants or come from
the same 1Password items as the Vercel setup (`docs/runbooks/staging-environment-variables.md`).

Non-secret block for the RAW Editor (replace nothing but the two mailbox addresses):

```
NODE_ENV=production
APP_BASE_URL=https://recruiting-os-git-main-identified-talent-solutions.vercel.app
SECRET_STORE=vault
AUTH_PROVIDER=supabase
AUTH_SIGNIN_PROVIDERS=azure
SUPABASE_URL=https://vjuaiyjmtrenbrmujvtc.supabase.co
ITS_STAFF_EMAIL_DOMAINS=identifiedtalent.com
AI_PROVIDER=anthropic
STORAGE_PROVIDER=supabase
STORAGE_BUCKET=resumes
STORAGE_S3_ENDPOINT=https://vjuaiyjmtrenbrmujvtc.storage.supabase.co/storage/v1/s3
STORAGE_S3_REGION=us-west-2
SCAN_PROVIDER=fake
RATE_LIMIT_STORE=upstash
UPSTASH_REDIS_REST_URL=https://complete-narwhal-292092.upstash.io
EMAIL_PROVIDER=fake
EMAIL_FROM_DOMAIN=hire.identifiedtalent.com
EMAIL_FROM_ADDRESS=updates@hire.identifiedtalent.com
EMAIL_REPLY_TO=<the ITS queue mailbox from gate 1.5>
ITS_QUEUE_EMAIL=<the same mailbox>
EMAIL_INTAKE_DOMAIN=apply.identifiedtalent.com
PRIVACY_EMAIL=privacy@identifiedtalent.com
SMS_PROVIDER=fake
SMS_ENABLED=false
CALENDAR_PROVIDER=fake
ANALYTICS_PROVIDER=fake
WORKER_INLINE=false
WORKER_POLL_MS=1000
CSP_MODE=report-only
DATABASE_POOL_MAX=5
```

(`WEB_BASE_URL`, `RATE_LIMIT_SHARED_PROVIDER` and `LOG_LEVEL` are no longer read; remove them if an older setup has them.
`SCAN_PROVIDER` stays `fake` until the ClamAV service exists, and the worker says so with a standing `scanner.fake`
alert in the console; then `SCAN_PROVIDER=clamav` and `CLAMAV_HOST=<the ClamAV service's private hostname>`, see
"Running ClamAV on Railway" in `docs/runbooks/resume-storage.md`. Do not set `PORT`: Railway provides it, and the
worker's health check listens on it. `DATABASE_POOL_MAX` stays `5` here although the app on Vercel uses `3`: the
worker connects as `ros_worker`, which has its own 15 Session pooler connections, and runs one job at a time, so even
two overlapping deployments hold at most 10.)

Secrets, one **New Variable** each, then **Seal**:

| Variable | Source |
|---|---|
| `WORKER_DATABASE_URL` | 1Password "Recruiting OS staging database", field `WORKER_DATABASE_URL` (the `ros_worker` string; never `DATABASE_URL`) |
| `DATABASE_SSL_CA` | the whole text of `prod-ca-2021.crt` (multi-line: Cmd+Enter for new lines, or paste in the RAW Editor); not a secret but sealed does no harm |
| `SESSION_SECRET` | 1Password "Recruiting OS staging application" (the same value as Vercel) |
| `ANALYTICS_SALT` | the same item (the same value as Vercel) |
| `SUPABASE_ANON_KEY` | Supabase, Project Settings, API Keys (public by design; the boot check requires it) |
| `ANTHROPIC_API_KEY` | 1Password, the staging runtime key |
| `STORAGE_S3_ACCESS_KEY_ID`, `STORAGE_S3_SECRET_ACCESS_KEY` | 1Password "Recruiting OS staging storage" |
| `UPSTASH_REDIS_REST_TOKEN` | 1Password "Recruiting OS staging rate limit" |

Not set on purpose: `DATABASE_URL` (the worker uses `WORKER_DATABASE_URL` and refuses to start without it),
`MIGRATE_DATABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SENTRY_DSN` (no project yet), `BOOTSTRAP_ADMIN_EMAILS` (the
worker never signs anyone in).

## Screen 4: deploy and verify

Click **Deploy** on the staged changes. In the service's **Deployments** tab open the latest deployment and its logs.
Success looks like:

- build: `pnpm worker:check` passes (a typecheck);
- start: `[worker] started (db: postgres as worker, ai: anthropic, health: http://0.0.0.0:<PORT>/healthz, id: worker-…)`
  and no `refusing to start`;
- health: the deployment shows its health check as passing within two minutes of the start line. The check is
  `GET /healthz` on the worker itself, answering `{"ok":true,"workerId":"worker-…","lastPollAt":"…","queueDepth":0,"oldestQueuedAgeSeconds":null}`
  (the deployed commit is on the heartbeat row and in the console's alert details, never in this body: the endpoint
  needs no session).
  It answers 503 with `"ok":false` once the last successful poll is older than three poll intervals plus thirty
  seconds (about 33 seconds at `WORKER_POLL_MS=1000`), and Railway then restarts the worker on its own. A worker that
  cannot reach the database fails its poll, so a lost database connection also ends in a restart rather than a
  process that looks alive and does nothing;
- no repeated restarts.

The app's `/healthz` on Vercel shows the same heartbeat from the other side: `"worker":{"lastSeenAt":"…","queueDepth":0,"healthy":true}`;
`healthy` turns false after ten minutes without a heartbeat, and the daily maintenance check raises a `worker.stale`
alert in the console (at most once an hour). A due job waiting more than thirty minutes raises `queue.stale`.

If the logs show `password authentication failed for user "ros_worker"` (28P01), see "When a host refuses an
application string" in `docs/runbooks/staging-database-setup.md`: test the 1Password value with
`bash scripts/staging-db-check-role.sh` before rotating anything.

Then, on your machine, `bash scripts/staging-db-status.sh` shows `sessions of the application roles: … ros_worker 1
idle` (the worker's pooled connection) and no pending migrations. Report the started line and that status line.

## Screen 5: spending controls

Workspace, **Usage**, **Set Usage Limits**: a **Custom email alert** at $5 and a **Hard limit** of $10 (the minimum)
for compute. When the hard limit is reached Railway takes every workload in the workspace offline, which for staging
is the right failure. Railway warns at 75, 90 and 100 percent.

## What the worker does once it runs

It polls the `jobs` table and runs the six workflows (role approval, publish role, application intake including the
résumé quarantine check, screen, stuck-role detection, interview scheduling with reminders) and the registered jobs:
the outbox (every email and text the product queues inside a transaction is sent here, after that transaction
committed, once), credential revocation and deletion, interview calendar-event cancellation, the daily privacy-deadline
check, the daily maintenance sweep (expired sessions and sign-in links, finished jobs, old webhook receipts and policy
reports, old heartbeats, interrupted sends, then the stale-worker and stale-queue checks), email retry and the SMS
fallback. Every step is idempotent and leased; a running job renews its lease, so a slow AI step is never picked up by
a second worker. A failed step retries with backoff up to the workflow's maximum, then the run is marked failed and
escalated, and a job that uses up its attempts raises a `job.failed` alert; both reach Sentry with kinds and ids only.
Every poll also writes the worker's heartbeat.

Outages (Wave S5, 15 October 2026):

- **AI provider.** An outage error (5xx, 408, 409, 429, a timeout or a refused connection) retries with growing waits
  for over an hour, then the run is held (`waiting` on `ai.provider_available`), not failed, and one critical
  `ai.provider_outage` alert is raised (emailed to the platform administrators); no recruiter request is opened per
  application. A `workflow.ai_hold_check` job retries the oldest held run every 15 minutes; when it gets through,
  every held run resumes and the alert resolves. A 401, 403 or credit-balance answer counts as an account problem:
  work is held the same way and the alert says to check the key or the billing.
- **Email and SMS.** A queued message retries for about an hour (13 tries) before it is marked failed. Postmark and
  Twilio calls time out after 30 seconds; a Postmark send whose reply was cut off is marked "unknown" and never sent
  again, with a delivery-unknown alert.
- **The hourly check** (`ops.health_check`) also marks sends left in `sending` for more than five minutes as unknown,
  and raises one `escalation.overdue` alert for each recruiter request still unclaimed after its reply-by time
  (critical when the request is critical, otherwise high; the request's words never go in the alert).
- **The ITS queue mailbox** (`ITS_QUEUE_EMAIL`) now also gets the recruiter requests the product raises itself
  (a candidate asking for a person, a screening hand-off, a stopped workflow, an eligibility hold, a privacy review,
  a scheduling problem, a decision nobody sent), once each, through the outbox. Every direct email to ITS is recorded
  in `communications`, retried, and raises `message.delivery_failed` if it never goes. Until the worker runs, no email or text
leaves staging: the messages wait in the queue as `queued` rows in `communications`.
