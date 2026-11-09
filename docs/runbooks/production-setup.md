# Production setup: from new accounts to go-live

Status: written 29 October 2026 for the first production launch, from the code on branch `production-readiness`
(strict production start-up checks, sign-up by invitation, the worker's stall exit, the Windows database tools). It is
written for the assistant who guides the founder on her Windows laptop, one screen at a time. Staging is unchanged
(`docs/runbooks/staging-environment-variables.md`, `docs/runbooks/railway-worker.md`,
`docs/runbooks/staging-database-setup.md`).

**Where production stands (4 November 2026).** It exists, so do not start again from step 1. Read the dashboards before
changing anything: some plans and settings differ from step 1, to stay inside the plans already paid.

- **Has run:** the production database (steps 1 and 3); Vercel Production's settings, and the Railway worker and its
  scanner (steps 1 and 5); the first release (step 6); Microsoft sign-in, the first administrator and the business
  calendar (step 7); and the smoke test (step 8), which passed except for email and the outside Microsoft part of item 2.
  Its test company and role exist.
- **Not live:** email. Postmark's account approval is still pending and the sending domain's DNS records (step 2) are
  not in, so every email fails. The one email check, the proof of the queue mailbox and the Postmark webhook (step 5;
  step 8, item 7) wait for it.
- **Being decided:** the product's new name and its domain. Until then production runs on its `.vercel.app` address, and
  the names in this file (`recruiting.identifiedtalent.com`, `hire.identifiedtalent.com`) are the plan of 29 October.
- **Not run yet:** a Microsoft sign-in from outside ITS (check first that the app registration in use takes outside
  accounts, see step 1), a second administrator (step 7, item 6), branch protection (step 4), the uptime monitor (step 9),
  go-live (step 10) and locking down staging (step 11).
- **Not released yet:** the plans of 5 November 2026, first sign-in asks for approval of 6 November 2026 and the hiring
  fixes of 6 November 2026 ("The plans" below), which go in one release. The plans add migration 0036, the 37th, and the
  hiring fixes add 0037, the 38th, so production is two behind until that release, and this file's counts already say 38.
  Asking for approval adds no migration, and production stays on `SIGNUP_MODE=invite` until the code that knows `approval`
  is live.

## Before you start

- **Who does what.** The founder makes every change and types or pastes every secret. The assistant gives one screen at
  a time, with the exact menu and button names, then checks the result itself (a dashboard read, `/healthz`, a log
  line, the status report) before the next step.
- **Secrets never go in chat**, a file, an email or a screenshot. What may be pasted back: the status report, the
  `provision:` and `verified:` lines, `/healthz` output, log lines, project references and host names. The assistant
  does not read a page while a secret shows on it: Vercel and GitHub show a pasted value until it is saved, and
  Railway's staged-change details show new values in plain text.
- **Placeholders.** `<host>`: the production web address (approved so far: `recruiting.identifiedtalent.com`; never
  `app.identifiedtalent.com`, another vendor's service). `<prod-ref>`: the production Supabase project's reference.
  `<reply mailbox>`, `<queue mailbox>`, `<test mailbox>`: ITS mailboxes (step 2). The repository is public, so
  production identifiers stay out of it.
- **Windows.** Commands run in Windows PowerShell (`powershell.exe`, not `pwsh`) from the root of an up-to-date
  checkout of `main` with its packages installed. Where `pnpm.exe` is blocked, install with
  `node "$env:APPDATA\npm\node_modules\pnpm\bin\pnpm.mjs" install --frozen-lockfile`.
- **Accounts belong to ITS.** Each production account is opened in Identified Talent Solutions' name, with an ITS
  mailbox someone reads for provider and billing mail, and two-step sign-in on: GitHub, Vercel, Supabase, Railway,
  Upstash, Anthropic, Postmark, GoDaddy, Microsoft 365, 1Password.
- **Decided before step 1** (founder): the host and the sending domain (planned: `hire.identifiedtalent.com`); the
  product name (`PRODUCT_NAME`, which authenticator apps show); where the code lives (moving the repository later means
  linking Vercel and Railway again); the monthly limits for Anthropic, Upstash and Railway; whether Google sign-in is
  offered at launch.

## Secrets on Windows

Four values are made up here rather than issued by a provider: `SESSION_SECRET`, `ANALYTICS_SALT`,
`POSTMARK_WEBHOOK_SECRET` and the database password. Each is new for production, never a staging value.

1. **Make it.** From the repository root:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\new-secret.ps1 -Name SESSION_SECRET
   ```
   It puts 64 random letters and digits on the clipboard, never shown, kept out of clipboard history (Win+V) and the
   cloud clipboard. Without the repository, 1Password's password generator does the same: 64 characters, letters and
   digits, symbols off. The database password: the same generator, 40 letters and digits (no symbols, so the owner
   connection string in step 3 needs no encoding).
2. **Paste it** into its 1Password field first, then everywhere the variables table (step 5) says: Vercel with
   **Sensitive** on, Railway followed by **Seal** in the variable's three-dot menu (the database password goes into
   Supabase's new-project form instead, step 1). Then type `done`: the script clears the clipboard.
3. **Check** that Win+V does not list the value. Pause any clipboard manager (Ditto and the like) before starting.

`SESSION_SECRET` and `ANALYTICS_SALT` are identical on Vercel and the worker and different from staging. The start-up
check refuses fewer than 32 characters (for `POSTMARK_WEBHOOK_SECRET` too); it cannot tell a copied staging value.

Everything goes in a 1Password vault of its own, **Recruiting OS Production**:

| Item | Fields |
|---|---|
| Recruiting OS production database owner | the database password; `MIGRATE_DATABASE_URL` (step 3) |
| Recruiting OS production database | `DATABASE_URL`, `WORKER_DATABASE_URL` (the setup script fills them, step 3) |
| Recruiting OS production application | `SESSION_SECRET`, `ANALYTICS_SALT`, `POSTMARK_WEBHOOK_SECRET` |
| Recruiting OS production storage | the app key pair and the worker key pair |
| Recruiting OS production rate limit | the Upstash REST token |
| Recruiting OS production AI | the Anthropic key |
| Recruiting OS production email | the Postmark server token |
| Recruiting OS production sign-in | the Microsoft client secret with its expiry date; the Google client secret |

## 1. Accounts

### Supabase project

Organization Identified Talent Solutions (Pro). Organization settings, **Security**: **Require MFA to access
organization** on.

**New project**: name `recruiting-os-production`; the database password from 1Password; region **West US (Oregon)**,
`us-west-2` (it can never change; Vercel's `pdx1` and Railway's US West are next to it); compute **Small** if
point-in-time recovery will be bought (it needs Small), otherwise Micro. If the form offers to leave the Data API off,
leave it off.

Then, in the project:

- **Project Settings, Database, SSL Configuration**: **Enforce SSL on incoming connections** on; **Download
  certificate** (`prod-ca-2021.crt`; public, not a secret).
- **Project Settings, Data API**: off; the application never uses it. If the screen only offers the schemas, remove
  `public` from the exposed schemas.
- **Database, Extensions**: `supabase_vault` enabled.
- **Project Settings, JWT Keys**: the current key is ECC (P-256), as on staging. If it is still the legacy secret,
  migrate and rotate to ECC before anyone signs in.
- **Project Settings, API Keys**: the publishable key (`sb_publishable_…`) becomes `SUPABASE_ANON_KEY`. The secret and
  service-role keys stay in Supabase.
- **Authentication, URL Configuration**: Site URL `https://<host>`; Redirect URLs: add
  `https://<host>/api/v1/auth/callback` (both as on staging, with the production host).
- **Authentication, Sign In / Providers**: Email off, Phone off, **Allow anonymous sign-ins** off, **Allow new users to
  sign up** on (Microsoft and Google sign-ups need it; who may open a company is `SIGNUP_MODE`'s job). Azure and Google
  on (next section), nothing else.
- **Authentication, Multi-Factor**: TOTP (authenticator app) on.
- **Storage**: steps 1 to 4 of `docs/runbooks/resume-storage.md` in this project, with staging's settings: bucket
  `resumes`, Private, 8 MB, types `application/pdf`,
  `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `text/plain`, `text/markdown`,
  `image/png`, `image/jpeg`, `image/webp` (staging also lists `application/json` since 20 October; nothing needs it
  now); global limit at least 8 MB; S3 protocol on. **Two** access keys: `recruiting-os-production-app` (Vercel) and
  `recruiting-os-production-worker` (Railway), each into 1Password.

Report back: `<prod-ref>`, the region, and the endpoint and region the S3 screen shows.

### Microsoft and Google sign-in

**Microsoft**: a registration of its own for production (Entra admin center, the ITS tenant, **App registrations**,
**New registration**; background in `docs/spec/13` section 4a):

- Name `Identified Talent Solutions Hiring - Sign-in (production)`; supported account types **Accounts in any
  organizational directory and personal Microsoft accounts**; redirect URI (Web)
  `https://<prod-ref>.supabase.co/auth/v1/callback`.
- **API permissions** (delegated): `openid`, `profile`, `email`, `User.Read`. **Token configuration**: optional claims
  `email` and `xms_edov`.
- **Certificates & secrets**, **New client secret**, 12 months: the **Value** into 1Password with its expiry date, and
  a reminder a month before. An expired secret locks every administrator out.
- Supabase, **Azure** provider: the Application (client) ID, the secret's Value, **Azure Tenant URL** empty.

**Google** (the Google Cloud project that holds the staging sign-in client): add
`https://<prod-ref>.supabase.co/auth/v1/callback` to the client's **Authorized redirect URIs**, and publish the app
(Google Auth Platform, **Audience**, **Publish app**: status In production; the basic scopes need no review).
Supabase, **Google** provider: the client ID and secret. While the app is still in Testing only listed test users get
in, so launch with `AUTH_SIGNIN_PROVIDERS=azure` and leave Google off in Supabase until it is published.

### Railway project

Workspace Identified Talent Solutions (Pro), **New Project**, **Empty project**, named `recruiting-os-production` (its
environment is called `production`).

1. **worker**: **New**, **GitHub Repo**, `RayyanRS6/RecruitingOS`, then the service's **Settings**:
   - service name `worker`; source branch **`production`**, never `main`; root directory `/`; auto-deploy on;
   - builder Railpack; build command `pnpm worker:check`; start command `pnpm worker:start`;
   - healthcheck path `/healthz`, timeout `120`;
   - restart policy **Always**. Railway reads `/healthz` only while a deployment goes live and restarts only a process
     that exits. The worker exits with code 1 when nothing has finished for 15 minutes (`WORKER_STALL_EXIT_MS`), and
     Always starts it again after any number of exits;
   - region **US West (California)**, **1** replica; serverless (app sleeping) off;
   - no public domain.

   Railway may build at once from the `production` branch as it stands (until the first release, a September build).
   Without variables it refuses to start, which is harmless.
2. **clamav**: "Running ClamAV on Railway" in `docs/runbooks/resume-storage.md`, in this project: image
   `clamav/clamav:stable`, service name `clamav`, no public domain, private networking on (the worker reaches it as
   `clamav.railway.internal`), variables `CLAMAV_NO_MILTER=true` and `CLAMD_STARTUP_TIMEOUT=1800`. It needs about
   1.5 GB of memory: about $15 to $25 a month.
3. Workspace, **Usage**, **Set Usage Limits**: a **Custom email alert** sized for staging and production together, and
   **no hard limit**. A hard limit takes every service in the workspace offline, production included.

The worker's variables come in step 5.

### Upstash

console.upstash.com, **Create Database**: name `recruiting-os-production-rate-limit`, AWS **us-west-2 (Oregon)**, plan
**Pay as you go** with the founder's monthly budget (an account has one free database, and staging uses it),
**Eviction** off. From the database page: the REST URL (`UPSTASH_REDIS_REST_URL`, not a secret) and the REST token
(into 1Password). Only the app on Vercel uses them.

### Anthropic

The Anthropic Console (platform.claude.com), in the organization that pays for production:

- **Workspaces**: a workspace `production`, and in its **Limits** a monthly spend limit (the founder's figure; the
  account worksheet planned $200) with an email alert below it. At the limit, or with the prepaid credit gone, every
  customer's AI work is held: keep auto-reload on, or a low-balance alert.
- **API keys**, **Create key** in workspace `production`, named `recruiting-os-production`, into 1Password. One key
  serves the app and the worker. Never the staging key; the GitHub `fairness` secret stays a non-production key.

### Postmark

- The account's approval (requested 14 October) must be granted before go-live.
- **Servers**, **Create server**: `recruiting-os-production`, delivery type Live, open and link tracking off.
- The server's **API Tokens**: the Server API token into 1Password (`POSTMARK_SERVER_TOKEN`).
- The sending domain `hire.identifiedtalent.com` is already on the account; its DNS records come next. The webhook comes
  in step 5.

## 2. DNS and email

GoDaddy: the account that holds `identifiedtalent.com` (not every ITS login there does). Before any change: two-step
sign-in on, and a copy of the zone's records saved in 1Password. Then add only these records, all on new names:

| Type | Name | Value |
|---|---|---|
| CNAME | the host's label (`recruiting`) | what Vercel shows after **Settings, Domains, Add Domain**: `<host>`, environment Production |
| TXT | `<selector>._domainkey.hire` | Postmark, **Sender Signatures**, `hire.identifiedtalent.com`: the DKIM record |
| CNAME | `pm-bounces.hire` | `pm.mtasv.net`, as the same Postmark screen shows (Return-Path) |

Never touch the root records, MX, the root SPF, `www`, `app` (another vendor's service) or the Microsoft 365 records.
`hire` needs no DMARC record of its own: the root's covers it.

Checks: `curl.exe -s "https://dns.google/resolve?name=identifiedtalent.com&type=CAA"` returns no `Answer`, or one that
allows `letsencrypt.org`; Vercel shows `<host>` with a valid configuration and a certificate; Postmark shows DKIM and
Return-Path **Verified** after **Verify**. In Vercel's **Domains**, make the production `.vercel.app` address redirect
to `<host>`: staff open the app at exactly `<host>`, because a change posted from any other address is refused.

ITS mailboxes (Microsoft 365), each read by a named person every business day:

- `<reply mailbox>`: candidate replies, and the help and accommodation contact printed on job pages (`EMAIL_REPLY_TO`).
- `<queue mailbox>`: recruiter requests and administrator changes (`ITS_QUEUE_EMAIL`; the reply mailbox may do both).
- `privacy@identifiedtalent.com`: shown to every candidate (`PRIVACY_EMAIL`).
- `<test mailbox>`: the one email check of the smoke test (step 8). A plus tag (`name+1029a@…`) reaches the same
  mailbox, but the app counts it as the same person (step 8).

If Proofpoint holds mail from `hire.identifiedtalent.com`, allow it. Email-in (`apply.`) stays off at launch ("Not at
launch" below).

## 3. Database setup

From the root of an up-to-date checkout of `main`, in Windows PowerShell. Paste back only the report lines.

1. `prod-ca-2021.crt` from step 1 sits in Downloads. Supabase has one root certificate: if staging's copy is already
   there, it is the same file, and the report says whether it matches the one the server presents.
2. Read-only first:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\db-status.ps1 -Environment production -ProjectRef <prod-ref>
   ```
   It asks for the **Session pooler** string (Supabase, **Connect**, Session pooler) exactly as shown, with
   `[YOUR-PASSWORD]` still in it; then the database password, typed and never shown; then the certificate (Return
   accepts the file it offers). On the new project it reports 38 migrations pending and exits with 3.
3. The setup, with the same three answers:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\db-setup.ps1 -Environment production -ProjectRef <prod-ref>
   ```
   It applies the 38 migrations, gives `ros_app` and `ros_worker` fresh passwords and their safety limits, applies the
   Vault grants and checks both roles. Then it puts `DATABASE_URL` on the clipboard: paste it into 1Password, item
   "Recruiting OS production database", field `DATABASE_URL`, and type `pasted`; then the same for
   `WORKER_DATABASE_URL`. Win+V lists neither.
4. If it reports the Vault grants as skipped: enable `supabase_vault` (Database, Extensions) and run the same command
   with `-Mode grants` at the end.
5. The status command again: `migrations applied: 38`, `migrations pending: 0`, both roles able to log in with their
   safety limits in place, the Vault grants in place, table privileges 0 for the three Data API roles, and "everything
   is in place" (exit 0).

The scripts refuse a string from any other Supabase project, staging included, before anything connects. Every full run
sets new passwords, so the setup is never used for a release: the strings already in Vercel and Railway would stop
working. Releases migrate with the GitHub workflow (step 6).

Last, the owner string for GitHub: in the 1Password item "Recruiting OS production database owner", a new password
field `MIGRATE_DATABASE_URL` holding the Session pooler string with `[YOUR-PASSWORD]` replaced by the database password.

## 4. GitHub

Repository `RayyanRS6/RecruitingOS`, **Settings** (all free on a public repository):

1. **Branches**, **Add classic branch protection rule**, once for `main` and once for `production`:
   - **Require a pull request before merging** on; **Require approvals** off (one person releases);
   - **Require status checks to pass before merging** on, with the check `verify`; **Require branches to be up to date
     before merging** on for `main` and **off** for `production` (every release adds a merge commit that `main` never
     has, so each later release would show as out of date);
   - **Do not allow bypassing the above settings** on; **Allow force pushes** and **Allow deletions** off.
2. **General**, Pull Requests: **Allow merge commits** on. A release is merged with a merge commit, never squashed or
   rebased.
3. **Actions**, General: workflows from fork pull requests need approval for every outside contributor.
4. **Environments**, **New environment**, name **`production-database`**. Not `production`: Vercel already uses the
   GitHub environment `Production`, and environment names ignore case.
   - **Deployment branches and tags**: Selected branches and tags, `main` and `production`. The migration runs from
     `main` before the release is merged (step 6), so `main` must be allowed.
   - **Environment secrets**: `MIGRATE_DATABASE_URL` (from 1Password) and `DATABASE_SSL_CA` (the whole text of
     `prod-ca-2021.crt`).
   - **Environment variables**: `ROS_DB_PROJECT_REF` = `<prod-ref>`. The workflow refuses an owner string from any
     other project.
   - No required reviewers while one person releases.

## 5. Vercel Production and the Railway worker

**Vercel**, project `recruiting-os` (the team is on Pro, which business use needs):

- **Settings, Environments, Production, Branch Tracking**: `production`. Check it again after any change to the Git
  connection: re-linking the repository on 16 October reset it to `main`, which makes every merge into `main` a
  production deployment.
- **Settings, Environment Variables**: every row below with environment **Production** only, never Preview and never
  all environments (a production `DATABASE_URL` on Preview would give every pull-request preview the production
  database). **Sensitive** on for every secret. `ENABLE_EXPERIMENTAL_COREPACK=1` is already there for every
  environment; check that it lists Production.
- Spend management: notify only, never pause the project. Git fork protection stays on.
- Do not press **Redeploy** on the current production deployment, a 16 October build of `main`: the first production
  deployment with these values comes from the release (step 6).

**Railway**, project `recruiting-os-production`, service `worker`, **Variables**: the non-secret rows in the **RAW
Editor**, each secret with **New Variable**, then **Seal**. Do not press **Deploy** yet: until the release, branch
`production` still holds the September build.

**Postmark**, server `recruiting-os-production`, **Default Transactional Stream**, **Webhooks**, **Add webhook**: URL
`https://<host>/webhooks/postmark/events`; events **Bounce**, **Spam complaint** and **Subscription change** (Delivery
optional); basic auth with any user name and the password `POSTMARK_WEBHOOK_SECRET`.

### The variables

"Same" means the same value on both sides. No value here is a secret: secrets are named by where they come from.

| Variable | Vercel Production | Railway production worker | Secret |
|---|---|---|---|
| `DEPLOY_ENV` | `production` | same (the worker's only way to know) | no |
| `NODE_ENV` | not set: Vercel sets it | `production` | no |
| `APP_BASE_URL` | `https://<host>`, no trailing slash | same | no |
| `SESSION_SECRET` | new, 64 letters and digits ("Secrets on Windows") | same | yes |
| `ANALYTICS_SALT` | new, 64 letters and digits | same | yes |
| `SECRET_STORE` | `vault` | same | no |
| `AUTH_PROVIDER` | `supabase` | same | no |
| `SUPABASE_URL` | `https://<prod-ref>.supabase.co` | same | no |
| `SUPABASE_ANON_KEY` | the publishable key (step 1) | same | no: public by design |
| `AUTH_SIGNIN_PROVIDERS` | `azure,google`; `azure` while Google is not published | not set | no |
| `ITS_STAFF_EMAIL_DOMAINS` | `identifiedtalent.com` | not set | no |
| `SIGNUP_MODE` | `invite` (the app refuses to start without it); `approval` once the code that knows it is live ("The release", item 6) | not set | no |
| `SIGNUP_ALLOWED_EMAILS` | not set at first; the partner's owner address or `@<partner domain>` at go-live (step 10); anyone else who should go straight in without asking ("Letting a tester in") | not set | no |
| `BOOTSTRAP_ADMIN_EMAILS` | the first administrator's `@identifiedtalent.com` address, removed in step 7 | not set | no |
| `DATABASE_URL` | 1Password "Recruiting OS production database", field `DATABASE_URL` (`ros_app`) | never | yes |
| `WORKER_DATABASE_URL` | never | the same item, field `WORKER_DATABASE_URL` (`ros_worker`) | yes |
| `DATABASE_SSL_CA` | the whole text of `prod-ca-2021.crt` | same | no |
| `DATABASE_POOL_MAX` | `3` | `5` (`ros_worker` has its own 15 connections) | no |
| `WORKER_INLINE` | `false` | same | no |
| `AI_PROVIDER` | `anthropic` | same | no |
| `ANTHROPIC_API_KEY` | the `production` workspace's key | same | yes |
| `STORAGE_PROVIDER` | `supabase` | same | no |
| `STORAGE_BUCKET` | `resumes` | same | no |
| `STORAGE_S3_ENDPOINT` | `https://<prod-ref>.storage.supabase.co/storage/v1/s3`, as the S3 screen shows | same | no |
| `STORAGE_S3_REGION` | `us-west-2` | same | no |
| `STORAGE_S3_ACCESS_KEY_ID`, `STORAGE_S3_SECRET_ACCESS_KEY` | the `recruiting-os-production-app` pair | **different**: the `recruiting-os-production-worker` pair | yes |
| `SCAN_PROVIDER` | `fake` (the app never scans a file) | **different**: `clamav` | no |
| `CLAMAV_HOST` | not set | `clamav.railway.internal` | no |
| `CLAMAV_PORT`, `CLAMAV_TIMEOUT_MS` | not set | `3310`, `20000` | no |
| `RATE_LIMIT_STORE` | `upstash` | **different**: `memory` (the worker counts no requests, and the Upstash token stays off Railway) | no |
| `UPSTASH_REDIS_REST_URL` | the production database's REST URL | not set | no |
| `UPSTASH_REDIS_REST_TOKEN` | its REST token | not set | yes |
| `EMAIL_PROVIDER` | `postmark` | same | no |
| `POSTMARK_SERVER_TOKEN` | the production server's API token | same | yes |
| `POSTMARK_WEBHOOK_SECRET` | new, 64 letters and digits; also the webhook's password in Postmark | not set: only the app answers webhooks | yes |
| `EMAIL_FROM_DOMAIN` | `hire.identifiedtalent.com` | same | no |
| `EMAIL_FROM_ADDRESS` | `updates@hire.identifiedtalent.com` | same | no |
| `EMAIL_REPLY_TO` | `<reply mailbox>` | same | no |
| `ITS_QUEUE_EMAIL` | `<queue mailbox>` | same | no |
| `PRIVACY_EMAIL` | `privacy@identifiedtalent.com` | not set: the worker does not read it | no |
| `PRODUCT_NAME` | `Recruiting OS`, or the final name | same | no |
| `SMS_PROVIDER`, `SMS_ENABLED` | `fake`, `false` | same | no |
| `CALENDAR_PROVIDER` | `fake` (manual times and calendar files) | same | no |
| `ANALYTICS_PROVIDER` | `fake` | same | no |
| `CSP_MODE` | `report-only` | not set | no |
| `TRUST_PROXY_HOPS` | `1` | not set | no |
| `WORKER_POLL_MS` | not set | `1000` | no |
| `WORKER_STALL_EXIT_MS` | not set | not set (15 minutes) | no |
| `ENABLE_EXPERIMENTAL_COREPACK` | `1`, already there | not set | no |

Never set, on either side:

- `MIGRATE_DATABASE_URL` (the GitHub environment only), `SUPABASE_SERVICE_ROLE_KEY` (nowhere), `SUPABASE_JWT_SECRET`
  (the project signs with ECC keys).
- Refused at start-up: `COOKIE_DOMAIN`, `RATE_LIMIT_OVERRIDES`, `SENTRY_ENVIRONMENT=staging`, `COMPANY_CHECK=auto`,
  `MAGIC_LINK_ENABLED=true`, and any value that names staging's Supabase project.
- Off and staying off: `MAGIC_LINK_ENABLED`, `RUN_MIGRATIONS_ON_BOOT`, the Sentry values (`SENTRY_DSN`,
  `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE`, `NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_ENVIRONMENT`), and
  the PostHog, Twilio and Google Calendar values.
- Left to their defaults: `JOBS_BASE_URL` (one host serves everything), `MESSAGE_UNDO_SECONDS` (30), `AI_MODEL_*` and
  `AI_EFFORT_*`, `LINK_VERIFIER`, `BLS_API_KEY`, `COMP_BLS_ENABLED`.
- Email-in, off at launch: `POSTMARK_INBOUND_SECRET`, `EMAIL_INTAKE_DOMAIN`.
- Set by the hosts or the build: `PORT`, `VERCEL_ENV`, `VERCEL_GIT_COMMIT_SHA`, `RAILWAY_GIT_COMMIT_SHA`,
  `ROS_REPO_ROOT`, `ROS_MIGRATIONS_DIR`.
- For a person's machine only: `PGLITE_DIR`, `STORAGE_DIR`, `DATABASE_SSL_CA_FILE`. No longer read: `WEB_BASE_URL`,
  `PLATFORM_ADMIN_EMAILS`, `RATE_LIMIT_SHARED_PROVIDER`, `RATE_LIMIT_SHARED_URL`, `LOG_LEVEL`.

## 6. First release

Order: migrate, then the worker, then the app.

1. The latest commit on `main` has a green `verify`.
2. **Actions**, **migrate**, **Run workflow**: **Use workflow from** `main`, environment **production-database**,
   **Run workflow**. The log names `environment: production (Supabase project <prod-ref>)`; after step 3 it reports
   `migrations pending: 0`, the apply step prints `up to date`, and every step is green.
3. **Pull requests**, **New pull request**: base `production`, compare `main`, title `Release <date>`. Once `verify` is
   green: **Merge pull request**, **Create a merge commit**, **Confirm merge**. Nothing else merges into `main` until
   the release is live.
4. **The worker.** Railway, `recruiting-os-production`: if **Deploy** shows staged changes, press it. The newest
   deployment's log shows `[worker] started (db: postgres as worker, ai: anthropic, health: …, exits when stalled 15
   min)` and no `refusing to start`; its health check passes and it is **Active**.
5. **The app.** Vercel, **Deployments**: the Production deployment of the merge commit is **Ready**.
   `https://<host>/healthz` answers `{"ok":true,"db":"postgres","ai":"anthropic","worker":{…,"healthy":true},"workerHealthy":true}`,
   and `https://<host>/healthz?strict=1` answers the same with status 200.

The merge starts both deployments. If the app is live first, any new kind of work it queues waits for the new worker
(for up to a day): an older worker leaves work it does not know in the queue, and nothing fails. The console alert "An
older worker build is running" resolves itself once the new worker has run that work.

If a process refuses to start, its log says why (Vercel, **Logs**; Railway, the deployment's log):

| The log says | Fix |
|---|---|
| `refusing to start: … not applied` | run the migrate workflow (item 2); the app comes up on its next request, the worker after a **Redeploy** if it has not come up by itself |
| `… must be set on the production deployment`, `… must be "…"` | the named variable is missing or wrong on that side |
| `SIGNUP_MODE must be "open" or "invite" (it is "approval")` | this build is older than first sign-in asks for approval and does not know that mode: set `SIGNUP_MODE=invite` and redeploy, then release the new code before setting `approval` ("The release", item 6) |
| `DEPLOY_ENV must be "production" or "staging" …` | Railway: add `DEPLOY_ENV=production` (the worker's only way to know) |
| `… names staging's Supabase project` | that variable was copied from staging: copy it from the production project |
| `DEPLOY_ENV=production is set on a Vercel Preview deployment` | a production variable also went to Preview: edit it to Production only |
| `NODE_ENV must be "production"` | Railway: add `NODE_ENV=production` |
| `database role "…" is a superuser` | the owner string went in instead of the `ros_app` or `ros_worker` one |
| `password authentication failed` (28P01) | the string on the host differs from 1Password: paste it again from 1Password |
| a certificate error | `DATABASE_SSL_CA` is missing or incomplete |
| `WARNING: BOOTSTRAP_ADMIN_EMAILS is set` | expected until step 7 |

## 7. First administrator

1. `BOOTSTRAP_ADMIN_EMAILS` (Vercel only) holds the first administrator's `@identifiedtalent.com` address since step 5.
2. The first administrator opens `https://<host>/login`, **Continue with Microsoft**, signs in with the ITS account, and
   the second-factor page enrols an authenticator for production (staging's entry does not work here). Add the backup
   authenticator when it is offered, and rename the new entry in the authenticator app: both environments show
   `PRODUCT_NAME`.
3. The console opens at `https://<host>/admin`; **System and settings**, **Administrators** lists the new
   administrator.
4. Vercel: delete `BOOTSTRAP_ADMIN_EMAILS` from Production, then **Deployments**, the latest Production deployment, the
   three-dot menu, **Redeploy**. The start-up warning about it stops.
5. **System and settings**, **Business calendar**: publish the same calendar as staging (Monday to Friday, 9 to 5
   Pacific, US federal holidays and the day after Thanksgiving). Production starts on built-in defaults.
6. A second administrator first signs in with Microsoft and an authenticator; then **Administrators**, grant, with a
   reason.

## 8. Smoke test with made-up data

Test data in production follows these rules:

- Made-up people and documents only; nothing is copied from staging. Never run `scripts/load-apply.ts` against
  production.
- One ITS test company, **ITS Internal Test - not hiring**, opened once by the first administrator at
  `https://<host>/setup/company` (an administrator opens a company directly under `invite` and `approval` alike). Then **Console,
  Customers**, the company, **Change plan**: Design Partner, reason "ITS test company". Since the plans, a new company
  starts on Free, so this is what keeps its one job and its test applicants from running into Free's limits.
- Opening it sends the queue mailbox one notice about the new company. Until email is live that send fails and
  **Console, Problems, Alerts** shows "A new company is waiting for the ITS check" instead: **Resolve** it. The notice
  never goes again for this company, so once email is live something else proves the queue mailbox: the email about an
  administrator grant made after that (step 7, item 6) arrives there, or, with no grant to make, the email about a
  **Bring in a recruiter** request on the test role (answer the request in the **Queue** afterwards).
- One role in it, **TEST - not a real job**, approved; nothing else.
- Between checks the company stays unconfirmed: its pages, feeds and candidate emails are off.
- Applicants use one of two addresses, never `example.com` or a made-up domain: real email bounces, and a bounce puts
  the address on the do-not-send list.
  - **A new name at `blackhole.postmarkapp.com`**, not used before in the test company and with no plus tag
    (`test-1105a@blackhole.postmarkapp.com`): item 4 until email is live and on every later release, and item 6 always.
    Postmark accepts mail to that domain and throws it away, so no real mailbox is involved and nothing arrives
    anywhere. Until email is live, its emails show **Could not be delivered** on the applicant's **Messages** tab.
  - **`<test mailbox>`**: the one email check. Once email is live, run items 3, 4 and 9 again with `<test mailbox>`. It
    works once: the address is then on file, so another email check needs a new Microsoft 365 alias.
- A plus tag does not make a new person: the app ignores it when it matches applicants, so `name+2@…` is `name@…`. A
  second application under the same mailbox name shows nothing new on the team's list, gets "You already have an
  application with us" (at most once a day) instead of the one email, and its interview is held aside until that address
  confirms by email.
- Test applicants stay. Deleting one goes through a privacy request that needs counsel's approval, so that path is never
  used for test data; leave the test company out of totals by hand in reviews.

The check:

1. `curl.exe -s https://<host>/robots.txt` shows `Allow: /careers/` and a `Sitemap:` line; `curl.exe -sI
   https://<host>/welcome` shows no `x-robots-tag`.
2. Sign-in: the first administrator with Microsoft and the authenticator; a Microsoft account from outside ITS (a
   personal one, or another company's) and, if offered, a Google account. Each outside account signs in. Under
   `SIGNUP_MODE=invite` the company step says "Recruiting OS is by invitation for now" with the reply mailbox. Under
   `approval` it shows the form with **Send my request**: leave it unsent, because one account makes one request.
3. **Console, Customers**, the test company: **Confirm the company**, reason "smoke test". From the second check on,
   also the role's **More** menu, **Accept applications again**.
4. In a private window, the role's job page (its **Share** tab has the link): apply as "Test Candidate `<date>`" with
   the check's address (the rules above) and a made-up PDF résumé. The AI interview opens by itself about a minute after
   sending. With `<test mailbox>`, the one email (thank you, and the link to the interview) arrives in the test mailbox
   from `updates@hire.identifiedtalent.com`, and its message details show `dkim=pass` and `dmarc=pass`. With a new name
   at `blackhole.postmarkapp.com` nothing arrives anywhere, so read the email on the applicant's **Messages** tab.
5. As the owner: the résumé opens on the applicant's **Résumé** tab. **Settings**, **Security**, **Audit history** says
   the candidate's record was opened; it lists records, not each file. The file itself is `document.read` in the
   database's `audit_records`, with `document.uploaded` before it.
6. A second made-up applicant, with a new name at `blackhole.postmarkapp.com` and the EICAR test file, at **Read my
   resume**: the page says "We could not use `<file>`" and offers another file or the four short questions. The proof
   that the real scanner refused it is `Eicar-Test-Signature FOUND` in Railway, the clamav service, **Deploy Logs**. The
   application goes on without a file through the four questions. Build the file inside the browser page: saved to disk,
   Windows Defender removes it.
7. Postmark, the webhook, **Send test**: the app answers 200.
8. Optional, with `<test mailbox>`: press **Shortlist**, then **Set a date and time** on the test candidate, and book
   a time; the one email ("Your interview: …") carries a calendar file, and its page says "Your interview is booked".
9. Right afterwards: the role's **More** menu, **Stop accepting applications**; **Console, Customers**, the test
   company, **Take back the confirmation**, reason "smoke test done". Feeds may list the role for up to 5 more minutes.
10. Write the result, without addresses, in the private launch to-do document, not on a pull request: the repository is
    public.

## 9. Uptime monitor

Nothing else watches production from outside: Railway reads the worker's health only while it deploys, and the app
raises "The background worker has stopped polling" only when its `/healthz` is called.

1. A free uptime-monitor account in ITS's name (for example Better Stack; check that the free plan allows business
   use), alerting the founder by email and phone push, and the backup person once named.
2. Monitor `https://<host>/healthz?strict=1` (expects 200) at the shortest free interval, alerting after 2 or 3 failed
   checks in a row: a long batch can trip a single check.
3. Monitor `https://<host>/welcome` the same way.
4. Optional: the same mailbox follows the status pages of Vercel, Supabase, Railway, Anthropic and Postmark.
5. Prove it once, before the first real candidate. Railway, the worker, **Deployments**, the active deployment, the
   three-dot menu, **Remove**. Within about 20 minutes the monitor alerts, **Console, Problems, Alerts** shows "The
   background worker has stopped polling", and its email reaches the platform administrators (look in Proofpoint if it
   does not). Then **Redeploy** the removed deployment: `/healthz?strict=1` answers 200 again and the alert resolves
   itself.

## 10. Go-live

Real people's data enters production only after:

- the founder's dated sign-off in `docs/spec/00` section O (gate 4.13), which settles the legal route for the AI
  interview and the score;
- evidence for every blocker in `docs/readiness/20` section B, among them point-in-time recovery (it needs Small
  compute) with one restore drill, the partner's signed pilot agreement, the vendors' data-processing terms and a named
  incident lead;
- Postmark's approval, and steps 8 and 9 passed on production, the one email check and the queue mailbox included.

Then:

1. Vercel Production: `SIGNUP_ALLOWED_EMAILS` = the partner's owner address, or `@<partner domain>`; redeploy the
   latest Production deployment. The list counts under `SIGNUP_MODE=approval` too, and it is needed there: without it the
   partner sends a request, and Accept confirms the company at once, before item 3 says it may be.
2. Send the partner `https://<host>`. They sign in with Microsoft or Google and open their company. If their Microsoft
   365 asks for an administrator's approval, their IT administrator approves the app once.
3. ITS confirms the company (**Console, Customers**, **Confirm the company**) only once the agreement is signed, then
   **Change plan**: Design Partner.
4. The first real role. Every business day: the console's **Problems**, the queue mailbox and the reply mailbox; daily
   in the first week. No second customer before seven stable days (`docs/readiness/20` section C).
5. Then lock down staging (step 11).

## 11. Lock down staging

Staging's address is public (this repository's history prints it) and it stays a working copy, so close it once
production is live:

1. Vercel, **Environment Variables**, Preview, branch `main`: `SIGNUP_MODE=invite` and `SIGNUP_ALLOWED_EMAILS` = the
   staging test identities (full addresses or `@domain`); redeploy the latest `main` deployment. An account not on the
   list now sees "Recruiting OS is by invitation for now" at the company step.
2. If the partner used staging: in the staging console, **Customers**, their company, **Take back the confirmation**;
   **System and settings**, **Sign someone out everywhere**, for each of their people; then the staging Supabase
   project, **Authentication**, **Users**: delete their users (it cannot be undone). Their production company starts
   fresh; nothing is copied from staging.
3. Take back the confirmation of every other staging company not under test: their pages and feeds go offline at once,
   and confirming again brings them back.
4. A new staging AI key with a low limit, in the Anthropic organization that holds the staging key: workspace staging,
   **Limits**, a low monthly limit ($25 to $50); **Create key**; replace `ANTHROPIC_API_KEY` on Vercel (Preview, `main`)
   and on the staging Railway worker (since 22 October they may hold different keys: replace both); redeploy both;
   `/healthz` shows `"ai":"anthropic"` and one job draft works; then delete the old key.
5. `curl.exe -sI <staging address>/welcome` shows `x-robots-tag: noindex, nofollow`.

Stronger, optional: staging Supabase, **Authentication, Sign In / Providers**, **Allow new users to sign up** off.
Existing test accounts keep working; a new tester is added in the dashboard first.

## The plans

Status: written 6 November 2026 from the code on branch `plans`, not yet run on production. Decisions:
`docs/workflow-decisions.md`, "5 November 2026" and "6 November 2026". A new company starts on Free. Every number is one edit in
`packages/db/src/seed.ts`, written by the first boot after a deploy; a company takes a new number only the next time its
plan is applied. The repository is public, so what a real tester or customer is called goes in the private launch
to-do document, never here.

**Before a real company or a real applicant.** Made-up applicants only until risk R-LEGAL-1 is accepted again in writing,
or the lawyer has answered (`docs/workflow-decisions.md`, PQ-3; `docs/spec/00` section Q), and email is live (PQ-18). Step
10's list still holds for any real data. Under `SIGNUP_MODE=approval` anyone with a Google or Microsoft account can ask, and
nothing in the code holds any of this: it rests on whoever presses Accept.

### The release (migrations 0036 and 0037, and `SIGNUP_MODE=approval` after them)

Migration `0036_application_locked_at.sql` adds one empty column, `applications.locked_at`, with no default and no backfill:
every application that exists stays visible. The older code keeps running on the new schema and ignores it. Migration
`0037_person_decides_who_to_interview.sql` changes no schema: it puts the people the assistant moved to "Interview to set up"
under the old default back in New, so they can be shortlisted, and records each move in their history. It sends nothing. First
sign-in asks for approval goes in the same release and adds no migration: a person waiting is a membership in a status the code
already leaves out. Order, as in "Every later release":

1. GitHub, **Settings**, **Environments**: `production-database` exists with its two secrets, its variable and its branches
   (step 4, item 4). Check this first: production's 36 migrations went on through the setup script, so this may be the first
   run of the workflow against production. Never use `scripts\db-setup.ps1` for this release: a full run sets new passwords,
   and the strings already in Vercel and Railway would stop working.
2. The latest commit on `main` has a green `verify`, and nothing else merges into it until the release is live.
3. **Actions**, **migrate**, **Run workflow**: **Use workflow from** `main`, environment **production-database**. The log says
   `status: migrations applied: 36 (last: 0035_interview_followups.sql)` and
   `status: migrations pending: 2 (next: 0036_application_locked_at.sql)`, then `applied: 0036_application_locked_at.sql` and
   `applied: 0037_person_decides_who_to_interview.sql`, and **Confirm no migration is pending** is green. Until this has run, a new build refuses to start (step 6's table).
4. The release pull request, merged with a merge commit (step 6, item 3). The worker, then the app (step 6, items 4 and 5).
   The first boot of either writes the plans: there is no SQL to run and nothing to press. Trial, Core, Growth and Company
   stop being offered, and their rows stay.
5. **Console, Customers**, the test company, **Plan**: the list reads Free, Basic, Pro, Ultra and Design Partner, each with its
   price and limits. The test company stays on Design Partner. Every existing company keeps what it had until someone changes
   its plan.
6. **Now, and only now, `SIGNUP_MODE=approval`.** The new code must already be live, because a build from before it refuses to
   start on a mode it does not know, with `SIGNUP_MODE must be "open" or "invite"` in its log. Vercel, **Environment Variables**,
   Production, `SIGNUP_MODE`: `approval`. Then **Deployments**, the latest Production deployment, the three-dot menu, **Redeploy**:
   the value is read at start, so nothing changes until then. Railway needs nothing, as the worker has no `SIGNUP_MODE`. Check
   with an account from outside ITS, in a private window: `https://<host>/setup/company` shows the form with **Send my request**
   (leave it unsent: one account makes one request), and `https://<host>/welcome` has no "Get help with your next hire" link.
7. The short smoke test (step 8, items 3, 4 and 9), then the plans check below.

**The plans check**, with made-up data and the rules of step 8:

1. An account from outside ITS signs in and sends the form for a company named **ITS Plans Test - not hiring** ("Letting a
   tester in"). **Console, Overview**, its row, **Accept**, **Yes**. **Settings**, **Company** reads Free, with no word about a
   trial, and **Upgrade** beside it.
2. Accept was the ITS check, so there is no **Confirm the company** to press. Draft and approve one job,
   **TEST - not a real job**. **Start a hire** then says "Your Free plan includes one job. Upgrade to post more."
3. Apply six times from a private window, each with a new name at `blackhole.postmarkapp.com`. The job's **Candidates** lists
   five people and one card that says **Locked**, with no name. The sixth's receipt says the application is on file, with no
   word about a plan.
4. As the owner, **Upgrade**, **Ask ITS to upgrade**. The sheet says "ITS has your request." if pressed again. **Console,
   Customers** shows **Asked to upgrade**.
5. **Change plan** to Basic with a reason. The toast says "1 locked candidate opens now."; the card becomes the person; the
   request closes with "Your company is on the Basic plan now."; and **Settings**, **Audit history** shows the change with
   the reason.
6. **Take back the confirmation**, reason "plans check done". The account keeps its company ("Ending a tester's access", below).

### Letting a tester in

Since 6 November 2026 a tester asks and an administrator accepts (`SIGNUP_MODE=approval`; decisions:
`docs/workflow-decisions.md`, "6 November 2026"). There is no list to change and no redeploy for each person. A new company costs
real AI money up to its credit, and only a person's press lets one in.

1. The tester signs in at `https://<host>/login` with Google or Microsoft. Check first which sign-in works for someone outside
   ITS: `AUTH_SIGNIN_PROVIDERS` and step 1 (a Microsoft sign-in from outside ITS has not been run on production).
2. They fill in **Tell us about your company** and press **Send my request**. Their screen says "Your request has been sent" and
   "Please wait for approval." Nothing else works for them: no job, no AI, nothing public, and every address they open lands on
   this screen. One account makes one request.
3. **Console, Overview**, at the very top of **Needs attention**: "<Company> is asking for access", with the person's name and
   email, the kind of business, the size, the city and state, the website and how long they have waited. A stranger typed all of
   it, so open the website with care. Five rows at most, the longest waiting first, then "N more companies are asking for
   access", which opens **Customers**, **Waiting for the ITS check**. While email is not live this row is the only thing that
   tells you ("While testers are on").
4. Look before you press. Accept is also the one-time ITS check: it opens their public side, and there is no second look. Nothing
   in the code refuses a job in NYC, Illinois, California or Colorado, or a remote one (`docs/workflow-decisions.md`, PQ-16), asks for
   signed terms (PQ-14) or checks that applicants are made up (PQ-3). Ask them from your own mailbox, at the address on the row.
5. **Accept**, then **Yes**. A screen still open goes to Home by itself within 30 seconds, on Free, with no clock, and they can draft
   and approve at once. Their careers page, job pages and candidate emails work from now on, with no **Confirm the company** after it.
6. Or **Decline**, then **Yes**. Their screen says "We can't offer access right now" with the reply mailbox. No reason is typed,
   and they cannot send a second request. It is not final: **Customers**, the **Declined** filter, the company, **Accept**.

**Who goes straight in.** A platform administrator, and an address on `SIGNUP_ALLOWED_EMAILS`. They see **Create my hiring
workspace**, land on Home on Free and can draft and approve at once, and their careers page, job pages and candidate emails wait
for **Console, Customers**, **Confirm the company**, with a reason. Use the list for someone whose agreement must be signed before
anything of theirs goes public (step 10). Full addresses are better than `@domain`, which admits everyone at that domain, each with
a new company and a new credit. Entries are full addresses and `@domain` (that domain only, not its subdomains), comma-separated, any
case; one that is neither stops the app from starting, and the log says which. Someone who already sent a request does not move by
going on the list: accept them.

**Changing the door.** `SIGNUP_MODE` and the list are read at start, so every change is Vercel, **Environment Variables**,
Production, then **Deployments**, the latest Production deployment, the three-dot menu, **Redeploy**. `SIGNUP_MODE=invite` shuts the
door again: a stranger reads "Recruiting OS is by invitation for now" where the form was, and `POST /api/v1/companies` answers 403.
Anyone already waiting keeps their screen, stays on the Overview and can still be accepted or declined. `approval` opens the door
again. Any other value stops the app.

**Ending a tester's access.** **Console, Customers**, the company, **ITS check**, **Take away access** at the foot of the tab, then
**Yes** to "Take away access from {company}?". In one press everyone on the company is declined and signed out of it, its open
invitations are withdrawn, and its confirmation is taken back as **Take back the confirmation** does it: pages, feeds and candidate
emails go offline at once. The owner gets one email with the declined email's words; the toast says "We emailed the owner." only
when it really left, and a failed email changes nothing. From then on it is a declined company: they read "We can't offer access
right now" when they sign in, the row has the **Declined** pill, and every other console action refuses it. Someone who also works
for another company keeps that one. **Accept** is the undo: it brings everyone back on the same plan, confirms the company again
and tells each of them. Their company and its records stay either way. It is offered only on a company that has access; on a
request or a declined company the API answers 409 and changes nothing.

### How ITS changes a plan

A company asks with **Upgrade**, which reaches the **Queue** as "A customer asked about their plan." and shows **Asked to upgrade**
on its row. Accepting it opens what the customer wrote and gives no access to their hiring. Only a platform administrator changes
a plan; the queue says so to anyone else, with a link to the console's Plan tab for an administrator. A company still asking for
access has no **Plan** tab: Accept puts it on Free, and a plan is changed after that.

1. **Console, Customers**, the company, **Plan**. Pick a plan. A retired plan stays shown while a company is on it, and cannot be
   chosen again once left.
2. **Why (required, kept with the change)**: five characters or more. The customer reads it in their activity history, so write
   it for them.
3. **Change plan**, then **Yes, change it**. No card is charged and nothing is invoiced by the app: money is settled outside it.

It applies at once. The new limits hold, what was used this month stays used and the reset date does not move (the one
exception: a monthly AI credit that had no limit starts its first month now, so what was spent on Free's credit is not charged
to it). People locked on its jobs open, oldest first, up to the new limit, and the toast says how many; someone under 60 days old
on an open job gets the interview's link by itself. AI work waiting for credit looks again. ITS's posting tasks follow the plan.
Owners and admins are told, in no dollars, and the open plan request closes with its answer. A move down locks nobody, and a
company moved down to Free gets no second credit.

### While testers are on

Email is not live, so the queue mailbox hears nothing, and a tester's team invitations reach nobody. A failed send raises an alert
instead, with one exception on purpose: no email about a request for access raises one, whether to the person or to ITS, so **the
Overview's row is the only thing that says someone is waiting**. The person's screen claims nothing about email until one really
left: it says "Keep this page open, or sign in again later to check." Once email is live their copy says ITS reviews each company
"usually within one business day", so someone must look that often. Read the console every business day: **Overview**, **Customers**
(filter **Waiting for the ITS check** and **Running low**, the chip **Asked to upgrade**), **Queue** and **Problems**. An AI credit
at 80% or used up is a line in dollars on the company's row, and **Running low** counts it; it is never critical and pages nobody.
The Anthropic workspace's monthly limit (step 1) stays the guard over the whole account.

## Every later release

1. `main` is green; nothing else merges into it until the release is live.
2. The **migrate** workflow from `main` with **production-database** (step 6, item 2). A pending migration is expected;
   the run ends with "Confirm no migration is pending" green. Migrations work with the code already live, so
   production keeps running meanwhile.
3. The release pull request, merged with a merge commit (step 6, item 3).
4. The worker, then the app (step 6, items 4 and 5); Railway now deploys by itself. If the console shows "An older
   worker build is running" for more than a few minutes, see `docs/runbooks/railway-worker.md`.
5. The short smoke test: step 8, items 3, 4 and 9, with a new name at `blackhole.postmarkapp.com`.

## Rollback

- **The app**: Vercel, **Deployments**, the last good Production deployment, the three-dot menu, **Instant Rollback**.
  Afterwards Vercel no longer puts new production deployments live by itself: once the fix is merged, open its
  deployment and **Promote** it.
- **The worker**: Railway, the worker, **Deployments**, the last good deployment, the three-dot menu, **Redeploy**. An
  older worker leaves work it does not know in the queue ("An older worker build is running") for up to a day; after
  that the work fails like any other job, so release the fix within the day, or roll the app back too.
- **The database is never rolled back.** Every migration works with the release before it, so the older code runs on
  the newer schema. A wrong migration is corrected by the next numbered one, in a normal release.
- **One company**: **Console, Customers**, the company, **Take back the confirmation**: its pages, feeds and candidate
  emails stop at once.
- **Back past the plans.** A build from before them does not read `locked_at` and has no AI credit: anyone locked becomes
  readable by their team, a company's AI spend has no limit, and new companies start on Trial again. With testers on, take back
  each one's confirmation first, and release the fix soon. The plan rows stay; the older build rewrites only the five it knows.
- **Back past first sign-in asks for approval.** A build from before it refuses to start on `SIGNUP_MODE=approval` (step 6's
  table). If its log says so, set `SIGNUP_MODE=invite` and redeploy that build. On it someone waiting reads the by-invitation line,
  and their company reads as an ordinary one waiting for the ITS check: do not confirm it there, because that makes it public with
  nobody able to get in. Their request is still there when the new code comes back.

## Hotfix

- A fix goes through a pull request and `verify` (about an hour). If production is broken meanwhile, roll back first.
- If `main` holds nothing beyond what is live: fix on a branch from `main`, merge into `main`, release as usual.
- If `main` already holds unreleased work: branch `hotfix/<name>` from `production`, pull request into `production`,
  merge with a merge commit; Railway and Vercel deploy it. Then a pull request from `production` into `main`, so the
  next release keeps the fix.
- A hotfix carries no migration. One that needs a migration is released from `main` the usual way, migration first.
- Turning branch protection off for an emergency is the founder's recorded decision, undone right after.

## Not at launch

- **Email-in** (`apply.`): MX `apply` to `inbound.postmarkapp.com` (priority 10); the Postmark server's inbound stream
  with domain `apply.identifiedtalent.com` and webhook
  `https://inbound:<POSTMARK_INBOUND_SECRET>@<host>/webhooks/postmark/inbound`; then `POSTMARK_INBOUND_SECRET` and
  `EMAIL_INTAKE_DOMAIN=apply.identifiedtalent.com` on Vercel and the worker, the same on both. It needs a Postmark plan
  with inbound. First, staging's `EMAIL_INTAKE_DOMAIN` (Vercel Preview and the staging worker) becomes
  `intake.localhost`, so only production uses `apply.`.
- **`CSP_MODE=enforce`**, once staging has run enforced for two weeks without new reports (`docs/readiness/18`);
  redeploy after the change.
- A separate jobs host (`JOBS_BASE_URL`, the same on both sides), Sentry, and a Supabase custom domain for the sign-in
  screens.
