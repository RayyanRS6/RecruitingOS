# Release day with a pending migration

Read this before merging a release that adds a file under `packages/db/migrations`. The whole order of a release is in [production-setup.md](production-setup.md), "Every later release".

## The rule

A hosted process never migrates by itself. One that starts against a database with a migration pending refuses to start, on purpose, with this line in its log:

```
refusing to start: 1 migration is not applied (0038_role_posts.sql). Run pnpm db:migrate (or the migrate workflow) before deploying.
```

So the order is: **migrate first, deploy second.** A migration normally works with the build already live (a new column, a new table), so the old code keeps running on the new schema while Vercel and Railway roll forward. When one does not (it drops or changes something the live build reads or writes), its own comment says so, the validator asks for an `-- allow-destructive: <reason>` line on each such statement, and the release stops the old worker and the old app before it runs.

The owner's connection string is the only credential that may run a migration: the app's roles cannot change the schema. It lives in the GitHub environment's secrets and in the password vault, never on Vercel or Railway.

**Never use `scripts\db-setup.ps1` for a release.** It is the first-time setup, and every full run sets new passwords for `ros_app` and `ros_worker`, which breaks the strings entered in Vercel and Railway until they are replaced.

## Running the workflow

1. GitHub, **Actions**, **migrate**, **Run workflow**: **Use workflow from** `main`, environment **production-database**. The tools refuse an owner string from any other Supabase project; the status step's first line names the database.
2. The run has four steps after the install. Read them in order:
   - **Migration validation**: the checks of the files themselves (`pnpm db:validate`). A failure here means a migration file is wrong; fix it on the branch and run again. Nothing was sent to the database.
   - **What is pending**: the status report before anything is applied. A pending migration is the expected state here, so this step never fails on it. It prints, among other lines, `status: migrations applied: N (last: …)` and `status: migrations pending: N (next: …)`. If it says a file `was interrupted halfway`, the apply step completes it.
   - **Apply**: `pnpm db:migrate`. Success prints `applied: …` with each file; a database already up to date prints `up to date`. Each file is applied in one transaction together with its ledger row, so a failure rolls the whole file back, and the log names the statement and the Postgres code: `migration … failed at statement 2 of 5 (42501): …`. Paste that line back; it holds no secret.
   - **Confirm no migration is pending**: the status report again, failing only if a migration is still pending.
3. Deploy. Watch the worker's log for `[worker] started` and the app's `/healthz` for `"ok":true`; neither may say `refusing to start`.

## Reading the status output

| Line | Meaning |
|---|---|
| `status: tls: trusting …` | the certificate was found and TLS is verified; without this line the connection is refused, never downgraded |
| `status: migrations applied: N (last: …)` | how many files the ledger records |
| `status: migrations pending: N (next: …)` | what the apply step will do; `0` after a release |
| `status: … was interrupted halfway: …` | an earlier run left objects behind; the apply step skips what exists and records the file |
| `status: still to do:` | a list; on a release day only the migrations line matters |

Exit codes of `pnpm db:status`: 0 when nothing is to do (or with `--report-only`), 3 while something is to do (only pending migrations count with `--fail-on-pending-migrations`), 2 when the database could not be reached (a wrong string, a paused project, a missing certificate).

## Forward, never back

A migration is never rolled back. If a migration is wrong, write the next numbered file that corrects it and release again; never edit an applied file (the ledger records it by name, and the validator refuses gaps and renumbering). Whether a release can be undone by redeploying the build before it depends on its migrations: [production-setup.md](production-setup.md), "Rollback".

## When the order is wrong

If a deploy lands before the migration: the new worker logs `refusing to start: 1 migration is not applied`, never passes Railway's health check and fails, while the worker before it keeps running; the app's new deployment builds, but `/healthz` and every request answer 500. Nothing is damaged. Run the migration, then **Redeploy** the worker; the app comes up on its next request.
