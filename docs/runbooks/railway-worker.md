# Railway: the staging worker service, one screen at a time

Status: written 23 September 2026 from Railway's documentation (docs.railway.com, read that day) for founder decision 1
(Railway hosts the worker; Trigger.dev deferred). The worker is the existing `apps/api/src/worker.ts`; Railway reads
`railway.json` at the repository root (build `pnpm worker:check`, start `pnpm worker:start`, restart on failure up to
ten times). Nothing here is a secret; secret values go from 1Password into Railway's Variables tab and are sealed.

Note for the register: Railway calls the `railway.json` mechanism "Config as Code" and says it is deprecated in favour
of its Infrastructure as Code, with legacy support ending 1 December 2026. It works today; a follow-up before then.

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
- **Watch paths** (optional, reduces rebuilds): `apps/api/**`, `packages/**`, `railway.json`, `package.json`,
  `pnpm-lock.yaml`, `pnpm-workspace.yaml`.
- **Region**: US West Metal (California, `us-west2`), the region nearest the Oregon database.
- **Config as Code**: leave the default path so `railway.json` at the root is read.

## Screen 3: variables

Service, **Variables** tab. Use **RAW Editor** for the block of non-secret values, then **New Variable** for each
secret and seal it (the three-dot menu next to the variable, **Seal**). Values in the block are constants or come from
the same 1Password items as the Vercel setup (`docs/runbooks/staging-environment-variables.md`).

Non-secret block for the RAW Editor (replace nothing but the two mailbox addresses):

```
NODE_ENV=production
APP_BASE_URL=https://recruiting-os-git-main-identified-talent-solutions.vercel.app
WEB_BASE_URL=https://recruiting-os-git-main-identified-talent-solutions.vercel.app
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
RATE_LIMIT_STORE=shared
RATE_LIMIT_SHARED_PROVIDER=upstash
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
LOG_LEVEL=info
```

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
- start: `[worker] started (db: postgres as worker, ai: anthropic)` and no `refusing to start`;
- no repeated restarts.

Then, on your machine, `bash scripts/staging-db-status.sh` shows `sessions of the application roles: … ros_worker 1
idle` (the worker's pooled connection) and no pending migrations. Report the started line and that status line.

## Screen 5: spending controls

Workspace, **Usage**, **Set Usage Limits**: a **Custom email alert** at $5 and a **Hard limit** of $10 (the minimum)
for compute. When the hard limit is reached Railway takes every workload in the workspace offline, which for staging
is the right failure. Railway warns at 75, 90 and 100 percent.

## What the worker does once it runs

It polls the `jobs` table and runs the six workflows (role approval, publish role, application intake including the
résumé quarantine check, screen, stuck-role detection, interview scheduling with reminders) and the five registered
jobs (credential revocation and deletion, interview calendar-event cancellation, the daily privacy-deadline check,
email retry, the SMS fallback). Every step is idempotent and leased; a failed step retries with backoff up to the
workflow's maximum, then the run is marked failed and escalated. Nothing about this changed for Railway.
