# Production: setup, release, rollback

For whoever guides the owner one screen at a time. Production exists: read the dashboards before changing anything, and use "Set up once" only to rebuild a piece or to check a setting.

## Before you start

- **Who does what.** The owner makes every change and types or pastes every secret. The guide gives one screen at a time, with the exact menu and button names, then checks the result (a dashboard read, `/healthz`, a log line, the status report) before the next step.
- **Secrets never go in chat**, a file, an email or a screenshot. What may be pasted back: the status report, `/healthz` output, log lines, project references and host names.
- **The repository is public.** Production's identifiers, mailboxes and what a tester or customer is called stay out of it: they are in the owner's private launch to-do document.
- **Placeholders.** `<host>`: production's web address. `<prod-ref>`: the production Supabase project's reference. `<reply mailbox>`, `<queue mailbox>`, `<privacy mailbox>`, `<test mailbox>`: the platform company's own mailboxes, each read by a named person every business day.
- **Windows.** Commands run in Windows PowerShell (`powershell.exe`) from the root of an up-to-date checkout of `main`. Where `pnpm.exe` is blocked, install with `node "$env:APPDATA\npm\node_modules\pnpm\bin\pnpm.mjs" install --frozen-lockfile`.
- **Every variable**, with what production sets on Vercel and on the worker, is in [14-deployment-and-environment.md](../14-deployment-and-environment.md). This runbook does not repeat the list.

## Secrets

Four values are made up here rather than issued by a provider: `SESSION_SECRET`, `ANALYTICS_SALT`, `POSTMARK_WEBHOOK_SECRET` and the database password.

1. **Make it.** `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\new-secret.ps1 -Name SESSION_SECRET` puts 64 random letters and digits on the clipboard, never shown and kept out of clipboard history. A password manager's generator does the same (64 letters and digits; 40 for the database password, with no symbols, so the connection string needs no encoding).
2. **Paste it** into the password vault first, then where the variables list says: Vercel with **Sensitive** on, Railway followed by **Seal**. Then type `done`: the script clears the clipboard.
3. **Check** that Win+V does not list the value.

**Rotating a secret.** Make the new value where it is issued, enter it on every side that holds it (the variables list says which), redeploy the app and the worker, then delete the old value at the provider. Notes:

- `SESSION_SECRET`: the same on both sides. Everyone signs in again.
- `POSTMARK_WEBHOOK_SECRET`: also the webhook's password in Postmark.
- The two database roles: `scripts\db-setup.ps1` (below) sets new passwords for `ros_app` and `ros_worker` on every full run and hands over the two new connection strings. The strings on Vercel and Railway stop working until they are replaced.
- The storage key pairs: [resume-storage.md](resume-storage.md), "Rotate a key".
- The Microsoft client secret expires: keep its date beside it in the vault, with a reminder a month before. An expired secret locks every administrator out.

## Set up once

### Supabase project

One project for production, in the region nearest Vercel's `pdx1` (West US, Oregon). In it:

- **Project Settings, Database, SSL Configuration**: **Enforce SSL on incoming connections** on; **Download certificate** (public, not a secret): it is `DATABASE_SSL_CA`.
- **Project Settings, Data API**: off; the app never uses it.
- **Database, Extensions**: `supabase_vault` enabled. The app stores nothing there, but the database setup below still checks for it.
- **Project Settings, API Keys**: the publishable key is `SUPABASE_ANON_KEY`. The secret and service-role keys stay in Supabase.
- **Authentication, URL Configuration**: Site URL `https://<host>`; Redirect URLs: `https://<host>/api/v1/auth/callback`.
- **Authentication, Sign In / Providers**: Email off, Phone off, **Allow anonymous sign-ins** off, **Allow new users to sign up** on (who may open a company is `SIGNUP_MODE`'s job). Azure and Google on, nothing else.
- **Confirm email** on and **Secure email change** on, wherever the dashboard shows them, even with Email off. The app takes the address on a sign-in as proved, and nothing in the code can read these settings, so a person reads them here at every release.
- **Authentication, Multi-Factor**: TOTP (authenticator app) on.
- **Storage**: [resume-storage.md](resume-storage.md), "The bucket".

### Microsoft and Google sign-in

**Microsoft**: one app registration in the platform company's tenant (Entra admin center, **App registrations**).

- Name: `Recruiting OS`, the product name the sign-in page uses (`PRODUCT` in `apps/web/src/pages/Login.tsx`), since a company's IT sees it on Microsoft's consent screen.
- Supported accounts: **Accounts in any organizational directory**, with **Allow all tenants**. Work and school accounts only: Microsoft's own page refuses a personal Microsoft account, by design, and those people use **Continue with Google**. Redirect URI (Web): `https://<prod-ref>.supabase.co/auth/v1/callback`.
- **API permissions** (delegated): `openid`, `profile`, `email`, `User.Read`. **Token configuration**: the optional ID-token claims `email` and `xms_edov`.
- **Certificates & secrets**, **New client secret**: the **Value** into the vault with its expiry date.
- Supabase, **Azure** provider: the Application (client) ID, the secret's Value, **Azure Tenant URL** `https://login.microsoftonline.com/organizations`, and **Allow users without an email** off. Never `https://login.microsoftonline.com/consumers`.
- After every change in this list, a member of staff signs in with Microsoft and the authenticator before the next change.

**Google**: in the Google Cloud project that holds the sign-in client, add `https://<prod-ref>.supabase.co/auth/v1/callback` to the client's **Authorized redirect URIs**, and publish the app (Google Auth Platform, **Audience**, **Publish app**). Supabase, **Google** provider: the client ID and secret. While the app is still in Testing only listed test users get in.

The decisions behind both are in [DECISIONS.md](../DECISIONS.md), "Sign-in".

### The worker, the scanner, Upstash, Anthropic, Postmark

- **Railway**: the worker service is [railway-worker.md](railway-worker.md); the scanner beside it is [resume-storage.md](resume-storage.md), "Running ClamAV on Railway".
- **Upstash**: one Redis database in the same region, **Eviction** off. Its REST URL and REST token go to Vercel only.
- **Anthropic**: a workspace for production with a monthly spend limit and an alert below it; one key for the app and the worker. At the limit every company's AI work is held, so keep auto-reload on, or a low-balance alert. The fairness button uses a key of its own ([fairness-tests.md](fairness-tests.md)).
- **Postmark**: a server for production, delivery type Live, open and link tracking off. Its Server API token is `POSTMARK_SERVER_TOKEN`. **Default Transactional Stream**, **Webhooks**, **Add webhook**: URL `https://<host>/webhooks/postmark/events`; events **Bounce**, **Spam complaint** and **Subscription change**; basic auth with any user name and the password `POSTMARK_WEBHOOK_SECRET`. **Send test**: the app answers 200.

### DNS

Add only these records, all on new names. Never touch the root records, MX, the root SPF or another service's records.

| Type | Name | Value |
|---|---|---|
| CNAME | the host's label | what Vercel shows after **Settings, Domains, Add Domain**: `<host>`, environment Production |
| TXT | the DKIM selector under the sending domain | Postmark, **Sender Signatures**, the sending domain: the DKIM record |
| CNAME | `pm-bounces` under the sending domain | as the same Postmark screen shows (Return-Path) |

Checks: Vercel shows `<host>` with a valid configuration and a certificate; Postmark shows DKIM and Return-Path **Verified**. In Vercel's **Domains**, make the `.vercel.app` address redirect to `<host>`: everyone opens the app at exactly `<host>`, because a change posted from any other address is refused.

### Database setup

From the root of an up-to-date checkout of `main`, in Windows PowerShell. Paste back only the report lines.

1. Read-only first: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\db-status.ps1 -Environment production -ProjectRef <prod-ref>`. It asks for the **Session pooler** string (Supabase, **Connect**) exactly as shown, with `[YOUR-PASSWORD]` still in it; then the database password, typed and never shown; then the certificate file.
2. The setup, with the same three answers: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\db-setup.ps1 -Environment production -ProjectRef <prod-ref>`. It applies every migration, gives `ros_app` and `ros_worker` fresh passwords and their safety limits, applies the Vault grants and checks both roles. Then it puts `DATABASE_URL` on the clipboard for the vault, and after `pasted`, `WORKER_DATABASE_URL`.
3. If it reports the Vault grants as skipped: enable `supabase_vault` and run the same command with `-Mode grants`.
4. The status command again ends with "everything is in place" (exit 0).

The scripts refuse a string from any other Supabase project before anything connects. Every full run sets new passwords, so **the setup is never used for a release**: releases migrate with the GitHub workflow.

### GitHub

**Settings** of the repository:

1. **Branches**, a classic branch protection rule for `main` and one for `production`: **Require a pull request before merging** on, approvals off (one person releases); **Require status checks to pass before merging** with the check `verify`; branches up to date before merging on for `main` and off for `production` (every release adds a merge commit that `main` never has); no bypassing, no force pushes, no deletions.
2. **General**, Pull Requests: **Allow merge commits** on. A release is merged with a merge commit, never squashed or rebased.
3. **Actions**, General: workflows from fork pull requests need approval for every outside contributor.
4. **Environments**: one named **`production-database`** (not `production`: Vercel already uses that name). Deployment branches: `main` and `production`. Secrets: `MIGRATE_DATABASE_URL` (the Session pooler string with the database password in it) and `DATABASE_SSL_CA` (the whole text of the certificate). Variable: `ROS_DB_PROJECT_REF` = `<prod-ref>`.

### Vercel

- Project root `apps/shell`, framework Next.js, build and install commands left at their defaults. `ENABLE_EXPERIMENTAL_COREPACK=1` for every environment, so Vercel uses the pnpm that `package.json` pins.
- **Settings, Environments, Production, Branch Tracking**: `production`. Check it again after any change to the Git connection: re-linking the repository resets it to `main`, which makes every merge into `main` a production deployment.
- **Settings, Environment Variables**: production's values with environment **Production** only, never Preview and never all environments (a production `DATABASE_URL` on Preview would give every pull-request preview the production database). **Sensitive** on for every secret.
- Spend management: notify only, never pause the project.

### First administrator

Administrator rights come from a ledger of grants, never from a list of addresses ([DECISIONS.md](../DECISIONS.md), N2).

1. `BOOTSTRAP_ADMIN_EMAILS` (Vercel only) holds the first administrator's staff address.
2. That person opens `https://<host>/login`, **Continue with Microsoft**, and the second-factor page enrols an authenticator ([staff-second-factor.md](staff-second-factor.md)). The grant is made on that first sign-in, and only while no administrator exists.
3. The admin dashboard opens at `https://<host>/admin`; **System**, **Administrators** lists the new administrator.
4. Vercel: delete `BOOTSTRAP_ADMIN_EMAILS` from Production, then redeploy the latest Production deployment. Until then every start warns, and the setting grants nothing more: each later match is recorded as ignored.
5. A second administrator first signs in with Microsoft and an authenticator. Then **Administrators**: grant, with a reason. Nobody grants themselves, the last administrator cannot be removed, and the person must be on a staff email domain.
6. Every grant and removal raises an alert that another administrator must acknowledge (never the one who made the change, nor its subject), and emails the other administrators and the queue mailbox.

### Uptime monitor

Nothing else watches production from outside: Railway reads the worker's health only while it deploys, and the app notices a stopped worker only when its `/healthz` is called.

1. An uptime-monitor account in the platform company's name, alerting the owner by email and phone.
2. Monitor `https://<host>/healthz?strict=1` (expects 200) at the shortest interval, alerting after 2 or 3 failed checks in a row.
3. Prove it once, before the first real candidate: Railway, the worker, **Deployments**, the active deployment, the three-dot menu, **Remove**. Within about 20 minutes the monitor alerts and **System**, **Health** shows "The background worker has stopped polling". Then **Redeploy** the removed deployment: `/healthz?strict=1` answers 200 again and the alert resolves itself.

## Every later release

1. The latest commit on `main` has a green `verify`, and nothing else merges into `main` until the release is live.
2. If the release adds a migration, read [release-migrations.md](release-migrations.md). A migration that only adds works with the build already live, so production keeps running while it is applied. When a migration changes what the live build relies on, or the release changes how the worker treats work it already knows (a default, a rule about who is read, moved or told, a data repair), stop the old worker first: otherwise it goes on with its old rules between the migration and the new worker.
3. **Actions**, **migrate**, **Run workflow**: **Use workflow from** `main`, environment **production-database**. The run ends with **Confirm no migration is pending** green.
4. **Pull requests**, **New pull request**: base `production`, compare `main`, title `Release <date>`. Once `verify` is green: **Merge pull request**, **Create a merge commit**.
5. The worker, then the app. Railway builds the merge commit by itself (if not: the command palette, Ctrl+K, **Deploy Latest Commit**); its log shows `[worker] started (…)` and no `refusing to start`. Vercel, **Deployments**: the Production deployment of the merge commit is **Ready**, and `https://<host>/healthz?strict=1` answers 200 with `"ok":true` and `"workerHealthy":true`.
6. The check with made-up people, below.

If a process refuses to start, its log says why (Vercel, **Logs**; Railway, the deployment's log):

| The log says | Fix |
|---|---|
| `refusing to start: … not applied` | run the migrate workflow; the app comes up on its next request, the worker after a **Redeploy** if it has not come up by itself |
| `… must be set …`, `… must be "…"` | the named variable is missing or wrong on that side |
| `SIGNUP_MODE must be "approval" or "open" (it is "…")` | an old value is left on that side: set `approval` on Vercel, and delete it on the worker |
| `DEPLOY_ENV must be "production" or "staging" …` | Railway: add `DEPLOY_ENV=production` |
| `… names staging's Supabase project` | that variable was copied from the Preview's settings: copy it from the production project |
| `database role "…" is a superuser` | the owner string went in instead of the `ros_app` or `ros_worker` one |
| `password authentication failed` (28P01) | the string on the host differs from the vault's: paste it again |
| a certificate error | `DATABASE_SSL_CA` is missing or incomplete |

### The release of the simple product (migrations 0038 to 0041)

Production is at `0037_person_decides_who_to_interview.sql`. This release adds four migrations:

| Migration | What it does |
|---|---|
| `0038_role_posts.sql` | Adds one empty column, `roles.posts`. |
| `0039_one_scoring_system.sql` | Drops five columns that the build now live reads and writes with every resume reading. |
| `0040_states_the_code_knows.sql` | Moves every stored row to a state today's code knows (stages, AI interviews, job statuses, told states, team roles), cancels the waiting emails and work of removed features, restarts the work still going under today's steps, and adds `screens.packet_version`. Data only; nobody is emailed by it. |
| `0041_storage_nothing_uses.sql` | Drops the 24 tables and 43 columns of removed features. No migration can undo it. |

The build now live uses what 0039 to 0041 remove, so for this release both the old worker and the old app stop before the migrations run.

1. **Settings on the hosts, before the new code starts.** `SIGNUP_MODE`: `approval` on Vercel Production and on Vercel Preview; on each Railway worker `approval` or not set. Any other value stops the process at start. Then delete the variables nothing reads any more, on Vercel and on both workers: `SMS_PROVIDER`, `SMS_ENABLED`, the `TWILIO_*` values, `CALENDAR_PROVIDER`, the `GOOGLE_OAUTH_*` values, `SECRET_STORE`, `EMAIL_INTAKE_DOMAIN`, `POSTMARK_INBOUND_SECRET`, `LINK_VERIFIER`, `COMPANY_CHECK`, `SIGNUP_ALLOWED_EMAILS`, `COMP_BLS_ENABLED`, `BLS_API_KEY`. They are harmless if left.
2. The latest commit on `main` has a green `verify`, and nothing else merges into it. Open the release pull request (base `production`, compare `main`) and wait until its `verify` is green, without merging: the steps below then take minutes, not an hour.
3. **Count what the drops leave behind, and note the point in time.** In Supabase, the production project, **SQL Editor**, run these and keep the output with the release's notes:
   - `SELECT count(*) FROM integrations WHERE secret_ref IS NOT NULL OR credentials_ciphertext IS NOT NULL;` The stored credentials of removed integrations: 0 is expected, since none was ever connected on production. If it is not 0, list the Vault rows they name before the migrations (`SELECT s.id, s.name FROM vault.secrets s WHERE s.id::text IN (SELECT secret_ref FROM integrations WHERE secret_ref IS NOT NULL);`) and delete those rows by id afterwards.
   - `SELECT count(*) FROM inbound_emails WHERE raw_storage_key IS NOT NULL;` The files of applications sent by email, which stay in the bucket under `inbound/` after their table is gone.
   - `SELECT workflow_key, workflow_version, status, current_step, count(*) FROM workflow_runs WHERE status NOT IN ('completed','failed','cancelled') GROUP BY 1,2,3,4 ORDER BY 1,4;` The work still going, which 0040 restarts or cancels.

   Then, under **Database**, **Backups**, note the newest backup's time (or the present moment, where point-in-time recovery is on): restoring to it is the only way back once 0041 has run.
4. **Stop the old worker first.** Railway, the production project, the worker, **Deployments**, the **Active** deployment's three-dot menu, **Remove**. While no worker runs, work waits in the database, emails too, and "The background worker has stopped polling" is expected until item 7.
5. **Stop the old app** by merging the release pull request with a merge commit, and wait until Vercel, **Deployments**, shows the Production deployment of the merge commit as **Ready**: until then the old build still answers. The new deployment then has production's address and answers 500 until the migrations are applied, because a hosted build never starts while one is pending (Vercel's log says `refusing to start: … not applied`). From here to item 7 the site is down; keep it short.
6. **Actions**, **migrate**, **Run workflow**: **Use workflow from** `main`, environment **production-database**. The log says `status: migrations applied: 38 (last: 0037_person_decides_who_to_interview.sql)`, lists `0038_role_posts.sql` to `0041_storage_nothing_uses.sql` as pending, applies each in a transaction of its own, and **Confirm no migration is pending** is green.
7. The worker, then the app, as in "Every later release", item 5. The app comes up on its next request; **Redeploy** the worker if it has not come up by itself. In its first minutes the new worker runs the work 0040 restarted: an application that was being read when the old worker stopped, or whose reading is of older must-haves than its job has now, is read again (AI credit is spent), and an AI interview that was open gets its reminder or its closing note when due.
8. The check with made-up people, below, the whole of it.

### The check with made-up people

Rules for test data on production:

- Made-up people and documents only. Never run `scripts/load-apply.ts` against production.
- One test company of the platform's own, with a name that says it is not hiring, on the Design Partner plan (**Change plan**, reason "test company"), and one job in it named so nobody mistakes it for a real one.
- Applicants use a new name at `blackhole.postmarkapp.com` each time: Postmark accepts mail to that domain and throws it away, so no real mailbox is involved. Never a made-up domain: real email bounces, and a bounce puts the address on the do-not-send list.
- The one thing that needs a real mailbox is the AI interview, whose link arrives by email only: use `<test mailbox>` for that applicant, once email is live.
- A plus tag does not make a new person: `name+2@…` is `name@…`, and a second application to the same job from the same address creates nothing.
- Test applicants stay. Deleting one needs a privacy request with counsel's approval, so that path is never used for test data.
- Write the result, without addresses, in the private launch to-do document: the repository is public.

The check:

1. `curl.exe -s https://<host>/robots.txt` shows `Allow: /careers/` and a `Sitemap:` line; `curl.exe -sI https://<host>/welcome` shows no `x-robots-tag`.
2. Sign-in: an administrator with Microsoft and the authenticator lands on the admin dashboard. An account from outside the platform company signs in and sees the company form with **Send my request**.
3. In the test company: **Start a hire**, one sentence, answer the cards, **Write the job**, **Publish job**. The job's **Share** tab shows the Apply link and, a little later, the two posts.
4. In a private window, open the Apply link and apply with a made-up PDF resume. The receipt says the application was received. On the job's **Candidates**, under **New**, the person shows "Reading the resume" and then a resume score with its band word.
5. **Shortlist**: the row says "AI interview sent". With `<test mailbox>`: the email arrives, the interview opens from its link, and after **Send my answers** the person is under **Interviewed** with an interview score.
6. **Not selected** on a second applicant: nobody is emailed. **Email the decision** shows the email first; **Don't send** takes it back.
7. A third made-up applicant with the EICAR test file as the resume: the application is received, and for the team the file reads "This file was refused or removed and cannot be opened." and the score "Resume could not be read". The proof that the real scanner refused it is `Eicar-Test-Signature FOUND` in Railway, the clamav service, **Deploy Logs**. Build the file inside the browser page: saved to disk, Windows Defender removes it.
8. **System**, **Health**: no failed job and no open alert that this check caused.

**The plans check**, with made-up data, after a release that touches plans or limits:

1. An account from outside the platform company sends the company form. **Companies**, **Waiting for approval**, its row, **Accept**, **Yes**. Its **Settings**, **Plan** reads Free, with **Upgrade** beside it.
2. Publish one job. **Start a hire** then says "Your Free plan includes one job. Upgrade to post more."
3. Apply six times, each with a new name at `blackhole.postmarkapp.com`. The job's **Candidates** lists five people and one card that says **Locked**, with no name. The sixth's receipt says the application is on file, with no word about a plan.
4. As the owner, **Upgrade**. **Companies** shows the company under **Asked to upgrade**.
5. The company's drawer, **Change plan** to Basic with a reason: the locked card becomes the person.
6. **Take away access**. Its pages stop being public at once.

## The admin dashboard, day to day

- **Before Accept.** Accept is the only gate: it makes the company live, with no second look. Nothing in the code refuses a real company, a job in a state the lawyer has not cleared, or real applicants ([DECISIONS.md](../DECISIONS.md), "Legal: open before real candidates"): it rests on whoever presses Accept. A stranger typed everything on the row but the email address, which their sign-in proved.
- **Decline** is not final: **Companies**, the **Declined** filter, the company, **Accept**. **Take away access** ends every membership and session of a company and takes its pages offline; **Accept** brings everyone back on the same plan.
- **Change plan** needs a reason of five characters or more, applies at once, and opens locked applicants oldest first up to the new limit. No card is charged: money is settled outside the app. A company still waiting or declined has no plan to change.
- **Every business day**: **Companies** (requests waiting, **Asked to upgrade**), **Privacy requests**, **System** (**Health** for failed work and alerts, **Email** for addresses on the do-not-send list), the queue mailbox and the reply mailbox.

## Rollback

- **The app**: Vercel, **Deployments**, the last good Production deployment, the three-dot menu, **Instant Rollback**. Afterwards Vercel no longer puts new production deployments live by itself: once the fix is merged, open its deployment and **Promote** it.
- **The worker**: Railway, the worker, **Deployments**, the last good deployment, the three-dot menu, **Redeploy**. An older worker leaves work it does not know in the queue ("An older worker build is running") for up to a day; after that the work fails like any other job, so release the fix within the day, or roll the app back too.
- **Never past the release of the simple product.** Once `0039_one_scoring_system.sql` has run, no build from before it can run: it reads and writes columns that are gone, and after `0041_storage_nothing_uses.sql` whole tables. From that release on, fix forward.
- **The database is never rolled back.** A wrong migration is corrected by the next numbered one, in a normal release. The one exception is the release of the simple product itself, while it is still being checked: if its migrations went wrong, restore the database to the point in time noted in its item 3, then roll the app and the worker back.
- **One company**: **Companies**, the company, **Take away access**: its pages and candidate emails stop at once.

## Hotfix

- A fix goes through a pull request and `verify` (about an hour). If production is broken meanwhile, roll back first.
- If `main` holds nothing beyond what is live: fix on a branch from `main`, merge into `main`, release as usual.
- If `main` already holds unreleased work: branch `hotfix/<name>` from `production`, pull request into `production`, merge with a merge commit; Railway and Vercel deploy it. Then a pull request from `production` into `main`, so the next release keeps the fix.
- A hotfix carries no migration. One that needs a migration is released from `main` the usual way.
- Turning branch protection off for an emergency is the owner's recorded decision, undone right after.
