# Release day with a pending migration

Status: written 30 September 2026 (audit remediation H4 and H5). Read this before merging a release that adds a file
under `packages/db/migrations`. Nothing here touches candidate data; every step is repeatable.

## The rule

Production and staging never migrate on boot. A process that starts against a database with a migration pending
refuses to start, on purpose, with this line in its log:

```
refusing to start: 1 migration is not applied (0021_worker_heartbeats.sql). Run pnpm db:migrate (or the migrate workflow) before deploying.
```

So the order on a release day is: **migrate first, deploy second.** Every migration is written to work with the
release before it (additive columns, tables with defaults, no drops without an `allow-destructive` reason), so the
old code keeps running on the new schema while Vercel and Railway roll forward. The deploy itself is unchanged:
Railway follows `main` for the worker, Vercel deploys `main` to the staging Preview and `production` to production.

## Two ways to apply it, and one way never to

| Way | When | What it needs |
|---|---|---|
| The `migrate` GitHub workflow (Actions, **migrate**, **Run workflow**, pick the environment) | the normal way; leaves a run log anyone can read | the environment's secrets `MIGRATE_DATABASE_URL` (the owner string) and `DATABASE_SSL_CA` (the Supabase certificate text), entered once by the founder |
| `pnpm db:migrate` on the founder's machine | when Actions is down or the workflow's secrets are not entered yet | `MIGRATE_DATABASE_URL` and `DATABASE_SSL_CA_FILE` in front of the command, from 1Password, never saved in a file |
| `bash scripts/staging-db-setup.sh` | **never for a release**: it is the first-time setup and every run rotates the `ros_app` and `ros_worker` passwords, which breaks the strings entered in Vercel and Railway until they are replaced | |

The owner string is the only credential that may run a migration; the application roles cannot create tables. It
lives in the GitHub environment's secrets and in 1Password, and nowhere else (never Vercel, never Railway).

## Running the workflow

1. GitHub, **Actions**, **migrate**, **Run workflow**, choose the environment (`staging` today), **Run workflow**.
2. The run has five steps. Read them in order:
   - **Migration validation**: the static and structural checks (`pnpm db:validate`). A failure here means the
     migration file itself is wrong; fix it on the branch and run again. Nothing was sent to the database.
   - **What is pending**: the status report before anything is applied. A pending migration is the *expected*
     state here, so this step never fails on it (`--report-only`). It prints, among other lines:
     ```
     status: migrations applied: 21 (last: 0020_job_distribution.sql)
     status: migrations pending: 1 (next: 0021_worker_heartbeats.sql)
     ```
     If it says a file `was interrupted halfway`, that is fine too: the apply step completes it safely.
   - **Apply**: `pnpm db:migrate`. Success prints `applied: 0021_worker_heartbeats.sql`; an already-migrated
     database prints `up to date`. Each file is applied in one transaction together with its ledger row, so a
     failure rolls the whole file back and the log names the statement and the Postgres code:
     `migration 0021_worker_heartbeats.sql failed at statement 2 of 5 (42501): ...`. Paste that line back; it holds
     no secret.
   - **Confirm no migration is pending**: the status report again, now failing only if a migration is still
     pending (`--fail-on-pending-migrations`). Other to-do lines in the report (Vault grants, Data API roles) are
     informational here; they belong to the setup runbook, not to a release.
3. Deploy: merge or push as usual. Watch the worker's deploy log for `[worker] started` and the app's `/healthz`
   for `"ok":true`; neither may say `refusing to start`.

## Running it from the founder's machine instead

From the repository root, in the founder's own Terminal, with the owner string from 1Password:

```bash
MIGRATE_DATABASE_URL='<owner string>' DATABASE_SSL_CA_FILE=~/Downloads/prod-ca-2021.crt pnpm db:status --report-only
MIGRATE_DATABASE_URL='<owner string>' DATABASE_SSL_CA_FILE=~/Downloads/prod-ca-2021.crt pnpm db:migrate
MIGRATE_DATABASE_URL='<owner string>' DATABASE_SSL_CA_FILE=~/Downloads/prod-ca-2021.crt pnpm db:status --fail-on-pending-migrations
```

The single quotes keep the string out of shell history expansion; clear the terminal afterwards. `scripts/staging-db-status.sh`
gives the same report interactively (it asks for the string and never echoes it) and exits 3 while anything is
still to do, which is only a reminder, not a failure.

## Reading the status output

| Line | Meaning |
|---|---|
| `status: tls: trusting Supabase Root 2021 CA (...)` | the certificate was found and TLS is verified; without this line the connection is refused, never downgraded |
| `status: migrations applied: N (last: ...)` | how many files the ledger records |
| `status: migrations pending: N (next: ...)` | what the apply step will do; `0` after a successful release |
| `status: 00XX was interrupted halfway: ...` | an earlier non-transactional run left objects behind; the apply step skips what exists and records the file |
| `status: still to do:` | a list; on a release day only the migrations line matters |

Exit codes: 0 when nothing is to do (or with `--report-only`), 3 while something is to do (only pending migrations
count with `--fail-on-pending-migrations`), 2 when the database could not be reached (wrong string, paused project,
missing certificate).

## Rolling forward, never back

A migration is never rolled back. If a release must be undone, redeploy the previous deployment on Vercel and
Railway: the previous code runs on the new schema because every migration keeps the previous release working. If a
migration itself is wrong, write the next numbered file that corrects it and release again; never edit an applied
file (the ledger records it by name and the validator refuses gaps and renumbering).

## What the founder sees when the order is wrong

If a deploy lands before the migration: the worker restarts up to ten times with `refusing to start: 1 migration is
not applied` and Railway's health check never passes; Vercel's deployment builds but `/healthz` and every request
answer 503 with `database unavailable` in the log line above it. Nothing is damaged. Run the migration (either way
above), then redeploy or wait for the next restart; the processes come up on their own once the ledger is complete.
