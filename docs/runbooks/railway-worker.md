# The worker on Railway

The worker is `apps/api/src/worker.ts`: the one process that runs workflows and queued jobs. Its settings live in the worker service's **Settings** in the Railway dashboard, not in a file in the repository. Nothing here is a secret; secret values go from the password vault into Railway's Variables tab and are sealed.

Use screens 1 to 3 to create the service or to check a setting, and screen 4 whenever the worker has stopped.

## Screen 1: the service

Railway, the production project, **New**, **GitHub Repo**, this repository. If it is not listed, choose **Configure GitHub App** and grant access to this one repository. If a deployment starts before the variables exist, let it run: the worker refuses to start, which is harmless.

## Screen 2: settings

Select the service, **Settings**:

- **Service name**: `worker`.
- **Source**: branch **`production`**, never `main`; root directory the repository root; auto-deploy on.
- **Region**: US West, the region nearest the database. **1** replica; serverless (app sleeping) off; no public domain.
- **Build and deploy**: builder Railpack; build command `pnpm worker:check`; start command `pnpm worker:start`; restart policy **Always**. Railway restarts only a process that exits, and Always keeps trying after any number of exits.
- **Health check**: path `/healthz`, timeout `120`. Railway asks it only while a deployment goes live: a deployment that never answers 200 within the timeout fails, and the one before it keeps running. Once a deployment is live, nothing at Railway watches it.

## Screen 3: variables

Service, **Variables**: the values that are not secret in the **RAW Editor**, each secret with **New Variable**, then **Seal** in its three-dot menu. Which variables, and the value of each, is the worker's column in [14-deployment-and-environment.md](../14-deployment-and-environment.md). What trips people up:

- `DEPLOY_ENV=production` and `NODE_ENV=production`: a hosted worker that does not name its deployment refuses to start.
- `WORKER_DATABASE_URL` is the `ros_worker` string, never `DATABASE_URL` and never the owner's.
- The storage key pair is the worker's own, not the app's.
- `SCAN_PROVIDER=clamav` with `CLAMAV_HOST`: the production worker refuses to start on the stand-in scanner ([resume-storage.md](resume-storage.md), "Running ClamAV on Railway").
- `RATE_LIMIT_STORE=memory`: the worker counts no requests, so the Upstash token stays off Railway.
- Do not set `PORT`: Railway provides it.

## Screen 4: deploy and verify

Click **Deploy** on the staged changes, then open the latest deployment's logs. A good start:

- build: `pnpm worker:check` passes (a typecheck);
- start: `[worker] started (db: postgres as worker, ai: anthropic, health: http://0.0.0.0:<PORT>/healthz, id: worker-…, exits when stalled 15 min)` and no `refusing to start`;
- health: the deployment's health check passes within two minutes. `GET /healthz` on the worker answers `{"ok":true,"workerId":"worker-…","lastPollAt":"…","queueDepth":0,"oldestQueuedAgeSeconds":null}`, and 503 with `"ok":false` once the last successful poll is older than three poll intervals plus thirty seconds;
- no repeated restarts.

**How a stopped worker is noticed.** The worker writes a heartbeat row on every poll. The app's `/healthz` reads the newest one: `"worker":{…,"healthy":true}` turns false after ten minutes without a heartbeat. The app then raises the critical alert "The background worker has stopped polling" (emailed to the platform administrators, at most once an hour), and `/healthz?strict=1` answers 503. The app checks only when its `/healthz` is called, which is why production has an uptime monitor on `/healthz?strict=1` ([production-setup.md](production-setup.md), "Uptime monitor"). A due job that has waited more than thirty minutes raises "Queued work is not being picked up".

**The worker watches itself.** When no poll, job or workflow step has finished for `WORKER_STALL_EXIT_MS` (15 minutes), it logs one `[worker] stalled: …` line and exits with code 1, and the restart policy starts it again. A long batch whose jobs keep finishing is not a stall. A lost database connection is not one either: each failed poll is logged as `[worker] tick failed` and tried again two seconds later.

When the worker keeps restarting, its deployment log says why:

| Log line | Meaning | What to do |
|---|---|---|
| `refusing to start: … not applied` | a release came before its migration | run the migrate workflow ([release-migrations.md](release-migrations.md)), then **Redeploy** the worker if it has not come up by itself |
| `refusing to start`, or `… must be set` with a variable's name | that variable is missing or wrong | correct it in **Variables**, then **Deploy** |
| `password authentication failed for user "ros_worker"` (28P01) | the string here differs from the one in the vault | paste it again from the vault before rotating anything |
| `[worker] stalled: …`, now and then | something the worker waited on never answered; the restart cleared it | if it repeats, read the lines before it: the last job or step it started |

**"An older worker build is running".** A worker found queued work that only a newer build knows and put it back for a newer worker instead of failing it. That is expected for a few minutes during a release, and while the worker is rolled back. If it lasts, deploy the current build (Railway's command palette, Ctrl+K, **Deploy Latest Commit**) and wait for `[worker] started`: the alert resolves itself once the new worker runs the work. Work waits like this for up to a day. After that it fails like any other job, under the alert "A background job gave up", so roll a worker forward within the day.

## Screen 5: spending

Workspace, **Usage**, **Set Usage Limits**: an email alert at a figure that covers everything in the workspace, and **no hard limit**. At a hard limit Railway takes every service in the workspace offline, production included.

## What the worker does

It polls the `jobs` table and runs the two workflows (an application: the file checked and scanned, the resume read and scored; an AI interview: the invitation, its reminder, the link's close, the scorecard) and the queued jobs: the outbox that sends every email, a job's two posts, an email for an update, the daily and hourly checks ([14-deployment-and-environment.md](../14-deployment-and-environment.md), "What the worker does by itself"). Every step is leased and safe to run again, so a slow AI step is never picked up by a second worker. A failed step retries with growing waits; a job that uses up its attempts raises "A background job gave up", and reaches Sentry, when it is on, with kinds and ids only. Until a worker runs, no email leaves: the messages wait in the queue.

When something outside is down:

- **The AI provider.** An outage error retries with growing waits for about an hour. Then the run is held, not failed, and one critical alert is raised and emailed to the platform administrators. A check retries the oldest held run every 15 minutes; when it gets through, every held run resumes and the alert resolves. A refused key or an empty balance is held the same way, and the alert says to check the key or the billing.
- **Email.** A queued email is tried 13 times, over about an hour, before it is marked failed with an alert. A send whose reply was cut off is marked unknown and never sent again, with its own alert.
