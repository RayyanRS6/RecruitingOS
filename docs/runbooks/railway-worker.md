# Railway: the staging worker service, one screen at a time

Status: written 23 September 2026 from Railway's documentation (docs.railway.com, read that day) for founder decision 1
(Railway hosts the worker; Trigger.dev deferred); revised 29 October 2026 (restart policy Always, the worker's own stall
exit, no hard spend limit). The worker is the existing `apps/api/src/worker.ts`. Its settings live in the worker
service's **Settings** in the Railway dashboard: builder **Railpack**, build command `pnpm worker:check`, start command
`pnpm worker:start`, health check path `/healthz` with a 120-second timeout, restart policy **Always**. Nothing here is
a secret; secret values go from 1Password into Railway's Variables tab and are sealed.

Note for the register: until 15 October 2026 these settings came from a `railway.json` file at the repository root.
Railway calls that mechanism "Config as Code", deprecated with legacy support ending 1 December 2026 (a hard cutoff).
Its replacement (`.railway/railway.ts`) is not read during deploys either; it is applied from Railway's command line,
and its documented options do not cover the restart policy (checked 9 October 2026,
docs.railway.com/infrastructure-as-code). So the dashboard holds them: the founder entered the values on 13 October
2026, they were checked against the file on 15 October 2026 (identical, and no custom config-file path set), and the
file was removed that day. **The production worker is a project of its own with the same settings, except that it
follows the `production` branch**: `docs/runbooks/production-setup.md` covers it and its variables.

## Screen 1: create the service from the repository

1. Railway, workspace Identified Talent Solutions (your default workspace), project `recruiting-os-staging`.
2. On the project canvas, click **New** (top right), then **GitHub Repo**.
3. Choose `RayyanRS6/RecruitingOS` (the repository since 16 October 2026). If it is not listed, Railway's GitHub app has no access to
   the repository yet: choose **Configure GitHub App**, grant access to that one repository only, and return.
4. Railway adds a service for the repository and connects its default branch, `main`. If the canvas shows staged
   changes with a **Deploy** button, do not click it yet: the variables come first (screen 3). If a deployment starts
   on its own, let it run; without variables the worker refuses to start and the deployment fails its health check.
   That is harmless and expected.

Report back: the service's name as Railway shows it on the canvas, whether a deployment started, and the region shown
in the service's Settings.

## Screen 2: service settings

Select the service, **Settings** tab:

- **Service name**: `worker`.
- **Source**: repository `RayyanRS6/RecruitingOS`, branch `main`, auto-deploy on, root directory left as the
  repository root (the worker runs from the root through `pnpm worker:start`).
- **Watch paths** (optional, reduces rebuilds): `apps/api/**`, `packages/**`, `package.json`, `pnpm-lock.yaml`,
  `pnpm-workspace.yaml`.
- **Region**: US West Metal (California, `us-west2`), the region nearest the Oregon database.
- **Build and deploy**: builder Railpack; build command `pnpm worker:check`; start command `pnpm worker:start`;
  restart policy **Always**. Leave **Config as Code** without a file path. Until 29 October 2026 this said On Failure
  with 10 retries; change it on the staging worker too. Railway restarts only a process that exits, and On Failure
  gives up after ten failed starts (a worker restarted during a database outage fails every start until the database
  is back); Always keeps trying, and brings the worker back each time it exits on purpose (screen 4).
- **Health check**: path `/healthz`, timeout `120`. Railway asks it only while a deployment goes live: a deployment that
  never answers 200 within the timeout fails, and the one before it keeps running. Once a deployment is live, nothing
  watches it (screen 4). The worker listens on `PORT`, which Railway provides; the probe runs inside Railway, so no
  public domain or networking is needed.

## Screen 3: variables

Service, **Variables** tab. Use **RAW Editor** for the block of non-secret values, then **New Variable** for each
secret and seal it (the three-dot menu next to the variable, **Seal**). Values in the block are constants or come from
the same 1Password items as the Vercel setup (`docs/runbooks/staging-environment-variables.md`).

Non-secret block for the RAW Editor (replace nothing but the two mailbox addresses):

```
NODE_ENV=production
DEPLOY_ENV=staging
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

(`DEPLOY_ENV=staging` names this deployment: the worker has no `VERCEL_ENV`, and since 29 October 2026 a worker under
`NODE_ENV=production` that names neither refuses to start, so a forgotten `DEPLOY_ENV` can never run the production
worker under staging's rules. Add it to an existing staging worker before it deploys a build from that date; the
production worker sets `production`. `WEB_BASE_URL`, `RATE_LIMIT_SHARED_PROVIDER` and `LOG_LEVEL` are no longer read;
remove them if an older setup has them.
`SCAN_PROVIDER` stays `fake` until the ClamAV service exists, and the worker says so with a standing `scanner.fake`
alert in the console; then `SCAN_PROVIDER=clamav` and `CLAMAV_HOST=<the ClamAV service's private hostname>`, see
"Running ClamAV on Railway" in `docs/runbooks/resume-storage.md`. Do not set `PORT`: Railway provides it, and the
worker's health check listens on it. `DATABASE_POOL_MAX` stays `5` here although the app on Vercel uses `3`: the
worker connects as `ros_worker`, which has its own 15 Session pooler connections, and runs one job at a time, so even
two overlapping deployments hold at most 10.)

Values that also exist on Vercel take the same value here: `APP_BASE_URL`, `SESSION_SECRET`, `ANALYTICS_SALT`, the
`EMAIL_*` values and `ITS_QUEUE_EMAIL`, and, whenever Vercel sets them, `PRODUCT_NAME`, `JOBS_BASE_URL` and
`POSTMARK_INBOUND_SECRET`: the worker writes the links and sends the mail. `RATE_LIMIT_STORE` may be `memory` here
instead: the worker counts no requests, so the Upstash token can stay off Railway (the production worker does this);
with `memory`, remove both `UPSTASH_*` variables. `WORKER_STALL_EXIT_MS` stays unset: 15 minutes (screen 4).

Secrets, one **New Variable** each, then **Seal**:

| Variable | Source |
|---|---|
| `WORKER_DATABASE_URL` | 1Password "Recruiting OS staging database", field `WORKER_DATABASE_URL` (the `ros_worker` string; never `DATABASE_URL`) |
| `DATABASE_SSL_CA` | the whole text of `prod-ca-2021.crt`, pasted whole (it spans several lines; the start-up check refuses a value that is not a certificate); not a secret but sealed does no harm |
| `SESSION_SECRET` | 1Password "Recruiting OS staging application" (the same value as Vercel) |
| `ANALYTICS_SALT` | the same item (the same value as Vercel) |
| `SUPABASE_ANON_KEY` | Supabase, Project Settings, API Keys (public by design; the boot check requires it) |
| `ANTHROPIC_API_KEY` | 1Password, the staging runtime key |
| `STORAGE_S3_ACCESS_KEY_ID`, `STORAGE_S3_SECRET_ACCESS_KEY` | the worker's own key pair (Supabase S3 access key `recruiting-os-staging-worker-2` since 22 October 2026), never the app's pair on Vercel |
| `UPSTASH_REDIS_REST_TOKEN` | 1Password "Recruiting OS staging rate limit" (not needed with `RATE_LIMIT_STORE=memory`) |

Not set on purpose: `DATABASE_URL` (the worker uses `WORKER_DATABASE_URL` and refuses to start without it),
`MIGRATE_DATABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SENTRY_DSN` (no project yet), `BOOTSTRAP_ADMIN_EMAILS` (the
worker never signs anyone in), `SIGNUP_MODE` and `SIGNUP_ALLOWED_EMAILS` (the worker never opens a company, though a
`SIGNUP_MODE` other than `open` or `invite` would stop it), and `COOKIE_DOMAIN`.

## Screen 4: deploy and verify

Click **Deploy** on the staged changes. In the service's **Deployments** tab open the latest deployment and its logs.
Success looks like:

- build: `pnpm worker:check` passes (a typecheck);
- start: `[worker] started (db: postgres as worker, ai: anthropic, health: http://0.0.0.0:<PORT>/healthz, id: worker-…, exits when stalled 15 min)`
  and no `refusing to start`;
- health: the deployment shows its health check as passing within two minutes of the start line. The check is
  `GET /healthz` on the worker itself, answering `{"ok":true,"workerId":"worker-…","lastPollAt":"…","queueDepth":0,"oldestQueuedAgeSeconds":null}`
  (the deployed commit is on the heartbeat row and in the console's alert details, never in this body: the endpoint
  needs no session).
  It answers 503 with `"ok":false` once the last successful poll is older than three poll intervals plus thirty
  seconds (about 33 seconds at `WORKER_POLL_MS=1000`). Railway reads it only while the deployment goes live: it does
  not watch it afterwards, and does not restart a worker that answers 503;
- no repeated restarts.

The worker watches itself instead (29 October 2026): when no poll, job or workflow step has finished for
`WORKER_STALL_EXIT_MS` (15 minutes by default, longer than any one step; values under a minute are raised to one
minute), it logs one `[worker] stalled: …` line and exits with code 1, and the restart policy starts it again. A long
batch whose jobs keep finishing is not a stall. A lost database connection does not trip it either: each failed poll
is logged as `[worker] tick failed` (without the values the query carried) and tried again two seconds later.

The app's `/healthz` on Vercel shows the same heartbeat from the other side: `"worker":{"lastSeenAt":"…","queueDepth":0,"healthy":true}`;
`healthy` turns false after ten minutes without a heartbeat. The app then raises the critical alert "The background
worker has stopped polling" (`worker.stale`, emailed to the platform administrators, at most once an hour), and
`/healthz?strict=1` answers 503. The app checks only when its `/healthz` is called, which is why production has an
uptime monitor on `/healthz?strict=1` (`docs/runbooks/production-setup.md`, step 9): the worker's own hourly and daily
checks cannot notice that the worker itself has stopped. A due job waiting more than thirty minutes raises `queue.stale`.

When the worker keeps restarting, its deployment log says why:

| Log line | Meaning | What to do |
|---|---|---|
| `refusing to start: … not applied` | a release came before its migration | run the migrate workflow (`docs/runbooks/release-migrations.md`), then **Redeploy** the worker if it has not come up by itself |
| `refusing to start`, or `… must be set` with a variable's name | that variable is missing or wrong | correct it in **Variables**, then **Deploy** |
| `password authentication failed for user "ros_worker"` (28P01) | the string here differs from the one that works | the paragraph after this table |
| `[worker] stalled: …`, now and then | something the worker waited on never answered; the restart cleared it | if it repeats, read the lines before it: the last job or step it started |

When the console says "An older worker build is running" (`worker.outdated`): a worker found queued work that only a
newer build knows and put it back for a newer worker instead of failing it. That is expected for a few minutes during
a release, and while the worker is rolled back. If it lasts, deploy the current build to the worker (Railway's command
palette, Ctrl+K, **Deploy Latest Commit**) and wait for `[worker] started`: the alert resolves itself once the new
worker runs the work. Work waits like this for up to a day from the first time it was put back. After that no build is
taken to know it (a step renamed or removed in a later release) and it fails like any other job, under the alert "A
background job gave up", whose text names the step; so roll a worker forward within the day.

If the logs show `password authentication failed for user "ros_worker"` (28P01), see "When a host refuses an
application string" in `docs/runbooks/staging-database-setup.md`: test the 1Password value with
`bash scripts/staging-db-check-role.sh` (a Mac) before rotating anything.

Then, on your machine, the status report shows `sessions of the application roles: … ros_worker 1 idle` (the worker's
pooled connection) and no pending migrations: `bash scripts/staging-db-status.sh` on a Mac, or on Windows
`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\db-status.ps1 -Environment staging -ProjectRef vjuaiyjmtrenbrmujvtc`.
Report the started line and that status line.

## Screen 5: spending controls

Workspace, **Usage**, **Set Usage Limits**: a **Custom email alert** at a figure that covers everything in the
workspace, and **no hard limit**. When a hard limit is reached Railway takes every workload in the workspace offline,
and the production project lives in this workspace too: a staging overrun would stop production. (Until 29 October
2026 this screen advised a $10 hard limit; ClamAV alone costs about $15 to $25 a month in each project.)

## What the worker does once it runs

It polls the `jobs` table and runs the six workflows (role approval, publish role, application intake including the
résumé quarantine check, screen, stuck-role detection, interview scheduling with reminders) and the registered jobs:
the outbox (every email and text the product queues inside a transaction is sent here, after that transaction
committed, once), credential revocation and deletion, interview calendar-event cancellation, the daily privacy-deadline
check, the daily maintenance sweep (expired sessions and sign-in links, finished jobs, old webhook receipts and policy
reports, old heartbeats, interrupted sends, then the stale-worker and stale-queue checks), email retry and the SMS
fallback. Every step is idempotent and leased; a running job renews its lease, so a slow AI step is never picked up by
a second worker. A failed step retries with backoff up to the workflow's maximum, then the run is marked failed and
escalated, and a job that uses up its attempts raises a `job.failed` alert; when Sentry is on, both reach it with kinds
and ids only, and the stored error text never carries the values a failed query held. A worker claims only the kinds
of work its build knows, so work a newer build queued waits for a newer worker, for up to a day past its time; then it
fails like any other job. Every poll also writes the worker's heartbeat.

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
