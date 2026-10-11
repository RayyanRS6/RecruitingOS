# 13. Account-creation worksheet (founder-facing)

For Nadine and Paul. One section per service, in creation order. Fill each record card as you go and store it in the `Recruiting OS Accounts` vault. Never paste a secret into Claude, chat, Git, Markdown, screenshots, issue trackers, test fixtures, logs, analytics, or documentation. Claude receives only the environment-variable **names** in appendix A and the project references you record in appendix D.

Conventions: owners = Nadine and Paul (named human accounts); billing = `billing@identifiedtalent.com`; security alerts = `security@identifiedtalent.com`; MFA = authenticator app (TOTP) unless a hardware key is offered; region = United States; environments = `staging` and `production`; projects = `recruiting-os-staging` and `recruiting-os-production`.

## 0. Microsoft 365 (existing; confirm, do not create)

- Where: https://admin.microsoft.com (or the GoDaddy Email & Office dashboard at https://account.godaddy.com/products if the subscription is GoDaddy-provided).
- Who: Paul (current administrator).
- Do: confirm the tenant and licenses; add Nadine as Global Administrator; enable MFA for all administrators (Security defaults, or Conditional Access if the plan includes Entra ID P1); create `platform@` as a licensed mailbox and the shared mailboxes and groups in `12` §4; note the Proofpoint Essentials console owner (GoDaddy "Advanced Email Security").
- Record: tenant name, tenant id (non-secret), administrators, license type, MFA method, recovery contacts, Proofpoint console owner.
- Verify: Nadine signs in as an administrator with MFA; test mail to each new address arrives.
- Revoke or rotate: remove an administrator in Users → Active users; reset a mailbox password from the admin center.

## 1. GoDaddy (existing; secure and document)

- Where: https://account.godaddy.com; delegate access at https://account.godaddy.com/access.
- Who: Paul invites Nadine's own GoDaddy account as a delegate ("Products, Domains and Purchase"); Nadine creates her account with her ITS address if she does not have one.
- Owners: Paul (account holder), Nadine (delegate). Provider limitation: GoDaddy has one account holder; the delegate cannot change the holder's recovery settings, so the holder's recovery contacts must be ITS-controlled and recorded.
- Recovery: account email and phone on the holder account set to ITS-controlled contacts; 2-step verification on both accounts; emergency notes in the `Domain and DNS` and `Recovery and Emergency` vaults.
- Do: export the DNS zone (DNS → Export), store it with the date; record the registrar, name servers, MX, SPF, DKIM, DMARC, website and Microsoft records (see `12` §1 and §6).
- DNS changes: none now; every proposed record is in appendix B for Nadine's review.
- Verify: `dig` shows the same records after export; nothing changed.

## 2. 1Password Business

- Where: https://1password.com/business (Business plan).
- Who: Nadine creates the account with her ITS address; invites Paul as a second Owner.
- Owners: Nadine, Paul. Billing: `billing@`. Recovery: each owner's Emergency Kit printed and sealed in the offline recovery package; account recovery through the other owner.
- MFA: authenticator app for both. Region: US.
- Vaults: `Recruiting OS Accounts`, `Recruiting OS Production`, `Recruiting OS Staging`, `Domain and DNS`, `Recovery and Emergency`; access per `12` §8.
- Verify: both owners can open every vault; a test item shared and revoked.
- Revoke: remove a member; recover a vault through the second owner.

## 3. GitHub

- Where: https://github.com/organizations/plan (Team plan).
- Who: Nadine creates the organization `identified-talent-solutions` from her own GitHub account (ITS address); Paul is added as a second Owner.
- Owners: Nadine, Paul. Billing: `billing@`. Recovery: each owner's GitHub account recovery codes in the vault. MFA: required for all members at the organization level. Region: n/a. Plan: Team. Spend limit: Actions minutes alert at 2,000/month.
- Project: repository `recruiting-os`, private; the local folder is pushed there by Nadine (or by Claude on this Mac using Nadine's session, never a stored token).
- Roles: Owners only for now; Dependabot alerts to `security@`; branch protection on `main` (pull request required, status checks required).
- Environment names for Actions: `staging`, `production` (secrets only when CI deploys; none needed at first).
- Verify: a second Owner can administer the repository; 2FA enforcement shows on the organization.
- Revoke: remove a member; rotate any fine-grained token from Settings → Developer settings.

## 4. Supabase

- Where: https://supabase.com/dashboard/sign-up.
- Who: Nadine signs up with her ITS address (email plus password with MFA, or Microsoft sign-in); creates organization `Identified Talent Solutions`; invites Paul as Owner; invites `platform@` as Owner for provider correspondence.
- Owners: Nadine, Paul (+ `platform@` as the third, non-human owner). Billing: `billing@`. Recovery: each account's MFA recovery codes in the vault. MFA: enforced at the organization (Organization settings → Security). Region: West US (Oregon), `us-west-2` in Supabase's region list (created 22 Sep; the earlier `us-west-1` label was wrong). Plan: Pro on production (point-in-time recovery add-on on production; daily backups). Spend alert: $150/month.
- Projects: `recruiting-os-staging`, `recruiting-os-production`; strong database passwords generated by 1Password, stored in the matching vault.
- After creation, the founder runs `scripts/staging-db-setup.sh` from the repository root in her own Terminal app (added 22 Sep): it asks for the Session pooler connection string exactly as the dashboard shows it, with the `[YOUR-PASSWORD]` placeholder still in it, and separately for the database password without echo (revised 22 Sep at the founder's request: the password is percent-encoded and put in place of the one placeholder inside the script by `packages/db/src/cli/fill-password.ts`, which receives it on standard input, so it is never on a command line, in shell history, on disk or in output; a string with the placeholder missing or repeated is refused before the password is asked for; tests in `packages/db/src/connection-string.test.ts` cover `@ : / ? # % & + =`, spaces, brackets, quotes, accented letters and emoji), applies the migrations, sets generated passwords on `ros_app` and `ros_worker`, applies `packages/db/scripts/vault-grants.sql`, verifies each role (no superuser, no row-level-security bypass, the API role can enter `app_tenant`), and prints the two connection strings once for 1Password, Vercel (`DATABASE_URL`) and Railway (`WORKER_DATABASE_URL`). The owner string never passes through the team or chat. The connection strings use the Session pooler (port 5432; the application keeps per-connection state, see the runbook) with `sslmode=verify-full` and the Supabase CA certificate (`DATABASE_SSL_CA`). Revised again 22 Sep after the first run exited 1 (almost certainly TLS: Supabase's own certificate authority is not trusted by a computer until its certificate is supplied; the scripts now ask for it): every migration applies in one transaction, an interrupted one is completed on rerun, provisioning is idempotent with a `grants` mode for after Supabase Vault is enabled, every error is diagnosed without the string, and `scripts/staging-db-status.sh` reports read-only; see `docs/runbooks/staging-database-setup.md`.
- Roles: no members beyond the owners; the application uses `ros_app` and `ros_worker`.
- Environment variables (names only; values go into Vercel and Railway): `DATABASE_URL` (as `ros_app`, pooler host), `WORKER_DATABASE_URL` (as `ros_worker`), `MIGRATE_DATABASE_URL` (owner; used only from a trusted machine during releases), `SUPABASE_URL`, `SUPABASE_ANON_KEY` (the publishable key; entered by Nadine into Vercel), `SUPABASE_JWT_SECRET` only for a project on the legacy shared secret (staging publishes ES256 keys, so it is not needed), `STORAGE_BUCKET`, `STORAGE_S3_*` (scoped storage credentials). **`SUPABASE_SERVICE_ROLE_KEY` is not provisioned to the application in release 1** (appendix A): it stays inside the Supabase dashboard, and if a narrowly defined server-side administrative operation ever needs it, that use is documented, reviewed, tested, audited, and added to the guard test's allowlist first.
- Sign-in configuration inside the project (added 22 Sep): Authentication → URL Configuration: Site URL = the staging application origin; Redirect URLs must include `https://<staging host>/api/v1/auth/callback`, which the application sends as `redirect_to` (the Entra redirect URI is different: it is Supabase's own callback). Authentication → Multi-Factor: TOTP stays enabled (free on every plan; the staff second factor is Supabase TOTP, enrolled and verified by the application's second-factor page and enforced on every staff session). A person who loses every authenticator is reset by the owner under Authentication → Users → the person → "Remove MFA factors" (`docs/runbooks/staff-second-factor.md`). Authentication → Providers → Azure: enabled, Application (client) ID, the client secret Value, "Azure Tenant URL" left empty so the common endpoint serves customer tenants and personal accounts.
- Non-secret identifiers the team may hold: the Reference ID (Project → Settings → General, also the dashboard URL), the project URL `https://<Reference ID>.supabase.co`, the organization slug, region and compute size. Secrets entered by Nadine at their destination only: the publishable key into Vercel; database passwords and connection strings into Vercel and Railway; the Entra client secret into the Supabase provider screen.
- Verify: `pnpm db:migrate` succeeds; the boot check passes when the API connects as `ros_app` (`refusing to start` never appears); `select current_user` returns `ros_app` from the app and `ros_worker` from the worker; PITR enabled on production.
- Revoke or rotate: reset a database role's password in the SQL editor (`ALTER ROLE ros_app PASSWORD ...`), update the secret in Vercel and Railway, redeploy; regenerate API keys in Project settings → API.

## 4a. Microsoft Entra app registration for sign-in (required for release 1; do at step 9a)

- Where: https://entra.microsoft.com → Identity → Applications → App registrations → New registration, in ITS's existing Microsoft 365 tenant.
- Who: Paul or Nadine (tenant administrator). Owners of the registration: Nadine and Paul.
- Name: `Identified Talent Solutions Hiring – Sign-in`. Supported account types: "Accounts in any organizational directory and personal Microsoft accounts" so customer users on Microsoft can sign in as well as ITS staff (tenant-only would block customers).
- Redirect URI (Web): `https://<project-ref>.supabase.co/auth/v1/callback` for each Supabase project (separate registrations for staging and production are cleaner than shared redirect URIs).
- Permissions: delegated `openid`, `profile`, `email`, `User.Read` only. **No calendar permission.**
- Client secret: created in Certificates & secrets with a 12-month expiry; entered directly in Supabase → Authentication → Providers → Azure, never in an application variable; the expiry date recorded in the vault with a reminder 30 days before.
- Optional claims (Supabase's recommendation): in the registration's Manifest, add `xms_edov` and `email` under `optionalClaims` so Supabase can tell verified from unverified email domains; copy the block from Supabase's "Sign in with Azure (Microsoft)" guide.
- Who registers: at least the Application Developer role in the ITS tenant, or the tenant default "Users can register applications" left on; the person who registers becomes the owner. Nadine is the only owner for the pilot.
- Verify: an ITS staff member signs in through the Supabase-hosted flow in staging; a personal Microsoft account signs in as a test customer; TOTP enrolment is enforced for staff afterwards.
- Revoke or rotate: delete the secret in Entra and update Supabase; revoke a user's sessions in Supabase.

## 5. Vercel

- Where: https://vercel.com/signup.
- Who: Nadine signs up with her ITS address (GitHub sign-in with her ITS GitHub account); creates team `Identified Talent Solutions`; invites Paul as Owner.
- Owners: Nadine, Paul. Billing: `billing@`. Recovery: account MFA recovery codes in the vault. MFA: required. Region: functions `sfo1`. Plan: Pro. Spend alert: $100/month (Usage → Spend Management).
- Project: `recruiting-os` linked to the private repository; environments `Production`, `Preview` (staging), `Development`; deployment protection on previews (Vercel Authentication).
- Roles: Owners only.
- Hostnames (DNS in appendix B): `recruiting.identifiedtalent.com` (approved) and `jobs.identifiedtalent.com`. `app.identifiedtalent.com` is another vendor's record and is not touched.
- Environment variables: appendix A, marked Sensitive for every secret; values entered by Nadine or Paul in Project → Settings → Environment Variables.
- Verify: a preview deployment from a pull request builds; the production hostname serves the health endpoint after DNS.
- Revoke or rotate: remove a member; delete and re-add an environment variable; rotate the Vercel deploy token if one is ever created.

## 6. Trigger.dev (deferred by decision 1 of 22 Sep: Railway hosts the worker, see §6a; this section is kept for a later migration and is not part of release 1)

- Where: https://cloud.trigger.dev.
- Who: Nadine signs up with her ITS address (GitHub or email); creates organization `Identified Talent Solutions`; invites Paul.
- Owners: Nadine, Paul (provider limitation: Trigger.dev has organization admins rather than two equal owners; record Nadine as primary, Paul as admin). Billing: `billing@`. Recovery: account recovery through the sign-in provider; codes in the vault. Region: US cloud. Plan: Hobby to start, Team when the first design partner is live. Spend alert: $50/month.
- Project: `recruiting-os` with environments `staging` and `production`.
- Environment variables: `TRIGGER_SECRET_KEY` (per environment) and `TRIGGER_PROJECT_REF` (non-secret) in Vercel; the worker's own variables (`WORKER_DATABASE_URL`, `ANTHROPIC_API_KEY`, `POSTMARK_SERVER_TOKEN`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `SECRET_STORE`, `EMAIL_*`, `APP_BASE_URL`) in Trigger.dev → Environment variables.
- Verify: a test task runs in staging from the dashboard; the worker connects as `ros_worker`.
- Revoke or rotate: regenerate the environment secret key; remove a member.

## 6a. Railway (worker host, decision 1 of 22 September 2026)

- Where: https://railway.com. Project `recruiting-os-staging` (created 22 September in the founder's default
  workspace; the docs offer no rename, so the workspace name stays and the project name carries the meaning).
- What runs there: `apps/api/src/worker.ts`, the always-on queue poller (workflows, reminders, timers, credential
  revocations, privacy deadlines). It listens on `PORT` (Railway provides it) for its own health check only, `GET
  /healthz`, named in `railway.json`; the probe runs inside Railway, so no public networking or domain is needed.
- Service creation: in the project, `New`, then the GitHub repository `identified-talent-solutions/recruiting-os`
  (the Railway GitHub App must have access to that private repository), branch `main`. Railway reads `railway.json` at
  the repository root: builder Railpack, build command `pnpm worker:check` (a typecheck; the worker runs from source
  with `tsx`, which is a runtime dependency of `@ros/api` for that reason), start command `pnpm worker:start`, restart
  policy On Failure with ten retries. Root directory stays `/` because the pnpm workspace installs from the root; Node
  comes from `.node-version` (24). Watch paths: `apps/api/**`, `packages/**`, `package.json`, `pnpm-lock.yaml`,
  `railway.json`, `.node-version`.
- Region: **US West Metal (California)**, the closest offered to the Oregon database; changeable later without downtime.
- Environment: the project's default `production` environment holds the staging worker (the project is the staging
  one); a production project or environment follows the production database.
- Spend: Workspace Usage page, Set Usage Limits, hard limit $10 (the minimum) with the email alert; Railway stops every
  workload at the limit and restarts them when it is raised.
- Variables (service Variables tab; every secret sealed after entry): `NODE_ENV=production`, `WORKER_DATABASE_URL`
  (the pooler connection string as `ros_worker`; sealed), `SESSION_SECRET` (sealed; the same value as Vercel's),
  `SECRET_STORE=vault`, `AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY` (sealed), `AUTH_PROVIDER=supabase`,
  `SUPABASE_URL`, `SUPABASE_ANON_KEY` (sealed), `APP_BASE_URL` (the staging address, for links in messages;
  `WEB_BASE_URL` is no longer read), `EMAIL_PROVIDER`, `SMS_PROVIDER`, `CALENDAR_PROVIDER`, `ANALYTICS_PROVIDER` = `fake`
  until each is connected, `STORAGE_PROVIDER=supabase` with the `STORAGE_S3_*` values from the runbook
  (`docs/runbooks/resume-storage.md`; adapter built 22 Sep: private bucket `resumes`, direct browser uploads, quarantine,
  worker-side checks), `SCAN_PROVIDER` (`fake` until the ClamAV service runs, then `clamav` with `CLAMAV_HOST`),
  `PRODUCT_NAME`, `ITS_QUEUE_EMAIL`, `EMAIL_REPLY_TO`, `PRIVACY_EMAIL`, `WORKER_POLL_MS=1000` (`LOG_LEVEL` is no longer
  read). `DATABASE_URL` is not needed on the worker: the production guard requires `WORKER_DATABASE_URL` there and
  `DATABASE_URL` on the app, and refuses PGlite in either.
- Verify: the deploy log shows `[worker] started (db: postgres as ros_worker, ai: anthropic)` and no `refusing to
  start`; the queue tab in the console shows jobs being claimed by a worker id.
- Revoke or rotate: reset the `ros_worker` password in Supabase and update the sealed variable; delete the service to
  stop all work.

## 7. Postmark

- Where: https://account.postmarkapp.com/sign_up.
- Who: Nadine signs up with her ITS address; account owner Nadine; Paul added as Admin; `platform@` as the account's notification address.
- Owners: Nadine (owner), Paul (admin). Billing: `billing@`. Recovery: account MFA codes in the vault. MFA: on. Region: US. Plan: pay as you go. Spend alert: $50/month.
- Servers: `recruiting-os-production`, `recruiting-os-staging`; message streams: `outbound` (transactional) and `inbound`.
- Sending domain: `hire.identifiedtalent.com` (add under Sender Signatures → Domains; Postmark supplies the DKIM and Return-Path values for appendix B). Inbound: `apply.identifiedtalent.com` (Postmark supplies the MX target). Do not add the root domain.
- Webhooks: one webhook on the transactional stream to `/webhooks/postmark/events` (Bounce, Spam complaint, Delivery, Subscription change) with HTTP basic auth whose password is `POSTMARK_WEBHOOK_SECRET`; the inbound stream's webhook to `https://inbound:<POSTMARK_INBOUND_SECRET>@<host>/webhooks/postmark/inbound` (basic auth in the URL, as Postmark offers; a header or query string is also accepted but not used). Postmark signs nothing, so the credential is the only proof of origin; the staging host must be reachable without a Vercel login.
- Environment variables: `POSTMARK_SERVER_TOKEN` (per server), `POSTMARK_INBOUND_SECRET`, `POSTMARK_WEBHOOK_SECRET`, `EMAIL_FROM_DOMAIN`, `EMAIL_FROM_ADDRESS`, `EMAIL_REPLY_TO`, `EMAIL_INTAKE_DOMAIN`.
- Verify: the domain shows DKIM and Return-Path verified; a test email from staging arrives with a passing DMARC alignment; a test email to `apply.` reaches the inbound webhook.
- Revoke or rotate: regenerate the server token; the old token stops working immediately.

## 8. Google Cloud (Calendar API only)

- Where: Cloud Identity Free https://workspace.google.com/gcpidentity/signup (choose "Cloud Identity Free"), then https://console.cloud.google.com.
- Who: **Nadine (or Paul) creates the Cloud Identity Free account for `identifiedtalent.com` as its initial administrator using her own ITS address**; verifies the domain with the TXT record in appendix B (Nadine's review first); then creates the second managed account so Nadine and Paul are the two named Organization Administrators. `platform@` is added later only if an operational task needs it, with the minimum role, never as super administrator, never used by a person. If a provider forces a `platform@` bootstrap, it is temporary: transfer administration to Nadine and Paul at once, strip its super-admin role, verify, and only then create production resources. No Gmail or Workspace is enabled.
- Owners: Nadine, Paul (Organization Administrators and project Owners). Billing: a billing account with `billing@` as the contact. Recovery: recovery phone and email on each managed account set to ITS contacts; codes in the vault. MFA: enforced for the organization. Region: `us-west1` where a region is asked. Plan: free; the Calendar API has no charge. Spend alert: $10/month budget.
- Projects: `recruiting-os-staging`, `recruiting-os-production`; Calendar API enabled; OAuth consent screen: External, Testing status, app name "Identified Talent Solutions Hiring", user support email `support@identifiedtalent.com`, developer contact `platform@identifiedtalent.com`, privacy policy URL (counsel item 15), scopes `https://www.googleapis.com/auth/calendar.events` and `https://www.googleapis.com/auth/calendar.freebusy`; add the design partners' interviewers as test users.
- OAuth client (calendar): Web application; redirect URIs `https://recruiting.identifiedtalent.com/api/v1/integrations/calendar/google/callback` (production) and the staging equivalent. A second client for Google sign-in through Supabase Auth uses the Supabase callback `https://<project-ref>.supabase.co/auth/v1/callback`; its client id and secret are entered in Supabase → Authentication → Providers → Google, not in an application variable.
- Environment variables: `GOOGLE_OAUTH_CLIENT_ID` (non-secret), `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URL`.
- Verify: an interviewer on a test account completes OAuth in staging; the token is stored through Supabase Vault; free/busy reads work; disconnect deletes the secret; then the full staging journey passes. Only then is the provider shown as connected.
- Revoke or rotate: reset the client secret in the console and update the environment variables; a user revokes access at https://myaccount.google.com/permissions and the app deletes the stored token.

## 8a. Upstash Redis (shared rate-limit counter, decision 4)

- Where: https://console.upstash.com, created directly (not through the Vercel Marketplace) so the account stays under ITS.
- Created 23 September: database `recruiting-os-staging-rate-limit`, AWS Oregon (us-west-2), Free plan (256 MB, 500,000
  commands a month, one database), TLS always on, REST endpoint `https://complete-narwhal-292092.upstash.io`.
  Eviction: **Off** (to be corrected from On): counters expire on their own; eviction would drop them first.
- Secrets: the REST token (Connect → REST tab → `UPSTASH_REDIS_REST_TOKEN`) is entered by the founder into Vercel
  (Preview, sensitive) and Railway (sealed); never in chat. The read-only token is not used. Rotation: the database's
  **Reset Credentials** in its settings, then update both hosts.
- Production later: a second database on pay-as-you-go with a $10 monthly budget (the budget rate-limits the database
  rather than billing beyond it).
- Verify: staging starts at all (the production app refuses to start without `RATE_LIMIT_STORE=upstash` and both
  values), and a limit tripped from two application instances shows one count (`docs/readiness/03`).

## 9. Sentry

- Where: https://sentry.io/signup/.
- Who: Nadine signs up with her ITS address; organization `identified-talent-solutions`; Paul as Owner.
- Owners: Nadine, Paul. Billing: `billing@`. Recovery: MFA codes in the vault. MFA: required at the organization. Region: US. Plan: Team. Spend alert: $30/month.
- Projects: `api`, `web`; alerts to `dev-alerts@`; data scrubbing on with additional fields `token`, `email`, `phone`, `authorization`.
- Environment variables: `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN` (non-secret), `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE` (default 0). No `SENTRY_AUTH_TOKEN` in release 1: source maps are not uploaded, so no auth token exists to protect, and the SDK's command-line tool is blocked from running install scripts (`pnpm-workspace.yaml`).
- Built 22 Sep (decision 3): `@sentry/nextjs` in the shell (server side through `apps/shell/instrumentation.ts`, Node runtime only; browser side through `apps/shell/instrumentation-client.ts` for the staff application only, no replay, no tracing, no integrations) and `@sentry/node` in the worker and standalone API (`apps/api/src/instrument.ts`, the only API file that imports the SDK). Every process shares `sentryOptions`: `sendDefaultPii` false, no replay, tracing off unless `SENTRY_TRACES_SAMPLE_RATE` says otherwise, and every event, transaction and breadcrumb scrubbed by shape (authorization and cookie headers, cookies, request bodies, link tokens and OAuth codes in URLs, identity beyond an opaque id) and by every registered secret value (`packages/contracts/src/security/observability.ts`). Unhandled API errors reach the tracker through one process-wide hook with the route only (candidate link tokens masked); handled errors are not reported. Version 10.74.0, the newest release older than the workspace's 24-hour minimum release age. Off until `SENTRY_DSN` is set.
- Verify: a test error from staging appears with the URL token scrubbed.
- Revoke or rotate: regenerate the auth token; DSNs can be rotated by creating a new client key.

## 10. PostHog

- Where: https://us.posthog.com/signup (US Cloud).
- Who: Nadine signs up with her ITS address; organization `Identified Talent Solutions`; Paul as Owner.
- Owners: Nadine, Paul. Billing: `billing@`. Recovery: codes in the vault. MFA: on. Region: US Cloud. Plan: free tier. Spend alert: $20/month.
- Project: `recruiting-os`; used only in the owner, recruiter, and admin interfaces, never on candidate pages; autocapture of form contents off; person profiles limited to authenticated staff and customer users.
- Environment variables: `NEXT_PUBLIC_POSTHOG_KEY` (project key, non-secret by design), `NEXT_PUBLIC_POSTHOG_HOST`.
- Verify: a staging page view appears; no event contains candidate data.
- Revoke: rotate the project API key in Project settings.

## 11. Anthropic

- Where: https://console.anthropic.com.
- Who: Nadine signs up with her ITS address; organization `Identified Talent Solutions`; Paul as Admin.
- Owners: Nadine (owner), Paul (admin). Billing: `billing@`. Recovery: MFA codes in the vault. MFA: on. Region: US. Plan: pay as you go with prepaid credits. Spend limits: workspace `staging` $50/month; workspace `production` $200/month, raised only by Nadine.
- Workspaces: `staging`, `production`; one API key each, named `recruiting-os-<env>`.
- Environment variables: `ANTHROPIC_API_KEY` (per environment, in Railway and Vercel), `AI_PROVIDER=anthropic`, `AI_MODEL_JUDGMENT`, `AI_MODEL_STANDARD`, `AI_MODEL_FAST`.
- Verify: the evaluation suites run against the staging key and meet thresholds; cost per case is recorded.
- Revoke or rotate: delete the key in the console and create a new one; update the environment variables.

## 12. Twilio

- Where: https://www.twilio.com/try-twilio.
- Who: Nadine signs up with her ITS address; Paul added as Administrator; a subaccount `recruiting-os-staging` with test credentials.
- Owners: Nadine (owner), Paul (administrator). Billing: `billing@`. Recovery: codes in the vault. MFA: on. Region: US. Plan: pay as you go. Spend alert: $25/month.
- A2P 10DLC: brand registration under ITS's legal name, EIN, address, and website `identifiedtalent.com`; campaign use case "conversational" for hiring communications; sample messages and the opt-in description from counsel item 10; the Messaging Service with STOP and HELP handling.
- Environment variables: `SMS_PROVIDER` (stays `fake` in production until cleared), `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_FROM_NUMBER`, `TWILIO_WEBHOOK_URL`.
- Verify: test credentials send to a test number in staging; the inbound webhook rejects an unsigned request.
- Revoke or rotate: rotate the auth token (secondary token first, then promote); update the variables.

## 13. Microsoft Entra calendar (deferred)

Not created now. When Microsoft Calendar is an approved provider: a **separate** app registration (owners Nadine and Paul), delegated `Calendars.ReadWrite` and `User.Read`, redirect URI `/api/v1/integrations/calendar/microsoft/callback`; variables `MS_OAUTH_CLIENT_ID`, `MS_OAUTH_CLIENT_SECRET`, `MS_OAUTH_TENANT`.

---

## Appendix A. Environment-variable names (no values)

Status: existing = used by the code today; planned = introduced by the Next.js port, Supabase Auth, the worker host, or calendar work; retiring = removed after the authentication migration.

| Name | Where it lives | Secret | Status |
|---|---|---|---|
| NODE_ENV | Vercel, Railway | no | existing |
| DATABASE_URL | Vercel (as `ros_app`) | yes | existing |
| WORKER_DATABASE_URL | Railway (as `ros_worker`) | yes | existing |
| MIGRATE_DATABASE_URL | release machine only | yes | existing |
| RUN_MIGRATIONS_ON_BOOT | Vercel (`false`) | no | existing |
| PGLITE_DIR | local only | no | existing |
| APP_BASE_URL | Vercel, Railway | no | existing |
| WEB_BASE_URL | none | no | retired: no longer read (the app and the API share APP_BASE_URL); remove it where an older setup has it |
| JOBS_BASE_URL | Vercel | no | planned (`https://jobs.identifiedtalent.com`) |
| COOKIE_DOMAIN | Vercel | no | existing; still read by the code (22 Sep); needed only if the API and web app are on different hosts |
| SESSION_SECRET | Vercel, Railway | yes | existing; still required in production (rate-limit subjects); not involved in sign-in verification (22 Sep) |
| SUPABASE_URL | Vercel, Railway | no | planned |
| SUPABASE_ANON_KEY | Vercel (public) | no | planned |
| DATABASE_SSL_CA | Vercel, Railway | no | the Supabase CA certificate text (Project Settings, Database, SSL Configuration); verify-full needs it (22 Sep) |
| DATABASE_POOL_MAX | Vercel, Railway | no | optional; connections per process on the Session pooler (default 5) |
| SUPABASE_SERVICE_ROLE_KEY | **not provisioned to the application in release 1** | yes | The service-role key bypasses row-level security. Ordinary requests use the authenticated Supabase client and the `ros_app` database role; the worker uses `ros_worker`; JWT verification uses `SUPABASE_JWT_SECRET` or the project's JWKS; storage uses S3-compatible credentials. It may be used only for a narrowly defined, documented, reviewed, tested, and audited server-side administrative operation that cannot be done through authenticated RLS; never in the browser, never `NEXT_PUBLIC_*`, never for candidate, company, role, application, or recruiter operations. `tests/policy/service-role-guard.test.ts` fails on any client reference and on any server reference outside the allowlist (two entries, 22 Sep: the secret scanner, which names the pattern, and the database status report, which names the Data API role `service_role` to report that it holds no privilege in `public`; neither touches a key). |
| SUPABASE_JWT_SECRET | Vercel server only, and only for a project on the legacy shared secret | yes | not needed for staging: the project publishes ES256 signing keys and the code verifies through the JWKS (checked 22 Sep) |
| AUTH_PROVIDER, AUTH_SIGNIN_PROVIDERS, ITS_STAFF_EMAIL_DOMAINS, MAGIC_LINK_ENABLED | Vercel, Railway | no | existing (`supabase`; `azure,google`; `identifiedtalent.com`; `false` in production) |
| STORAGE_S3_ENDPOINT, STORAGE_S3_REGION | Vercel, Railway | no | built 22 Sep (Supabase Storage S3 endpoint; `docs/runbooks/resume-storage.md`) |
| STORAGE_S3_ACCESS_KEY_ID, STORAGE_S3_SECRET_ACCESS_KEY | Vercel server, Railway (sealed) | yes | built 22 Sep (the project's S3 access keys: storage only, never the service role; not bucket-scoped at the provider, so one bucket per project) |
| PRIVACY_EMAIL | Vercel | no | existing (`privacy@identifiedtalent.com`) |
| ANALYTICS_PROVIDER, POSTHOG_HOST | Vercel, Railway | no | existing (`fake` until PostHog exists) |
| POSTHOG_PROJECT_API_KEY | Vercel server, Railway (sealed) | yes (server-side capture) | existing |
| ANALYTICS_SALT | Vercel server, Railway (sealed) | yes | existing; different per environment |
| SUPABASE_JWT_ISSUER | none | no | retired 22 Sep: not read by the code; the issuer is derived from `SUPABASE_URL` |
| STORAGE_PROVIDER | Vercel, Railway | no | `supabase` required in production (built 22 Sep) |
| STORAGE_BUCKET | Vercel, Railway | no | built 22 Sep (`resumes`) |
| SCAN_PROVIDER | Railway (the worker scans; Vercel keeps `fake`, the app never opens a file) | no | `fake` until the ClamAV service runs, then `clamav` (adapter built 30 Sep; `docs/runbooks/resume-storage.md`, "Running ClamAV on Railway"); a real engine is a real-data gate |
| CLAMAV_HOST, CLAMAV_PORT, CLAMAV_TIMEOUT_MS | Railway | no | built 30 Sep: the clamd service's private hostname (`clamav.railway.internal`), port 3310, timeout 20000 ms |
| STORAGE_DIR | local only | no | existing |
| SECRET_STORE | Vercel, Railway (`vault`) | no | existing |
| AI_PROVIDER | Vercel, Railway | no | existing |
| ANTHROPIC_API_KEY | Railway, Vercel | yes | existing |
| AI_MODEL_JUDGMENT, AI_MODEL_STANDARD, AI_MODEL_FAST | Vercel, Railway | no | existing |
| AI_DAILY_SPEND_CAP_USD | Vercel, Railway | no | planned |
| EMAIL_PROVIDER | Vercel, Railway | no | existing |
| POSTMARK_SERVER_TOKEN | Vercel, Railway | yes | existing |
| POSTMARK_INBOUND_SECRET | Vercel | yes | existing |
| POSTMARK_WEBHOOK_SECRET | Vercel | yes | planned |
| EMAIL_FROM_DOMAIN | Vercel, Railway | no | existing (`hire.identifiedtalent.com`) |
| EMAIL_FROM_ADDRESS | Vercel, Railway | no | existing (`updates@hire.identifiedtalent.com`) |
| EMAIL_REPLY_TO | Vercel, Railway | no | existing (`recruiting-replies@identifiedtalent.com`) |
| EMAIL_INTAKE_DOMAIN | Vercel | no | existing (`apply.identifiedtalent.com`) |
| ITS_QUEUE_EMAIL | Vercel, Railway | no | the shared mailbox the founder chooses in gate 1.5 of `docs/readiness/16` (`recruiting-replies@` or `support@`), recorded in `docs/spec/00` section M |
| PRODUCT_NAME | Vercel, Railway | no | existing |
| SMS_PROVIDER | Vercel, Railway | no | existing (`fake` until cleared) |
| TWILIO_ACCOUNT_SID | Vercel, Railway | no | existing |
| TWILIO_AUTH_TOKEN | Vercel, Railway | yes | existing |
| TWILIO_MESSAGING_SERVICE_SID, TWILIO_FROM_NUMBER, TWILIO_WEBHOOK_URL | Vercel, Railway | no | existing |
| CALENDAR_PROVIDERS | Vercel, Railway | no | planned (`manual`, then `manual,google`) |
| GOOGLE_OAUTH_CLIENT_ID | Vercel, Railway | no | planned |
| GOOGLE_OAUTH_CLIENT_SECRET | Vercel, Railway | yes | planned |
| GOOGLE_OAUTH_REDIRECT_URL | Vercel | no | planned |
| Microsoft sign-in client id and secret | Supabase → Authentication → Providers (not an application variable) | secret | release 1 (§4a) |
| Google sign-in client id and secret | Supabase → Authentication → Providers (not an application variable) | secret | release 1 |
| MS_OAUTH_CLIENT_ID, MS_OAUTH_CLIENT_SECRET, MS_OAUTH_TENANT | deferred (calendar registration only) | secret (client secret) | deferred |
| TRIGGER_SECRET_KEY | none | yes | deferred (decision 1: Railway hosts the worker) |
| TRIGGER_PROJECT_REF | none | no | deferred (decision 1) |
| SENTRY_DSN, SENTRY_ENVIRONMENT, SENTRY_TRACES_SAMPLE_RATE | Vercel, Railway | no | built 22 Sep; values pending |
| NEXT_PUBLIC_SENTRY_DSN | Vercel | no | built 22 Sep; optional (staff application only) |
| SENTRY_AUTH_TOKEN | none | yes | not used in release 1 (no source-map upload) |
| NEXT_PUBLIC_POSTHOG_KEY, NEXT_PUBLIC_POSTHOG_HOST | Vercel (owner, recruiter, admin interfaces only) | no | planned; never loaded on candidate routes (correction 14) |
| BLS_API_KEY | Vercel, Railway | yes (low value) | existing, optional |
| COMP_BLS_ENABLED | Vercel, Railway | no | existing |
| WORKER_INLINE | local only (`false` in production) | no | existing |
| WORKER_POLL_MS | Railway | no | existing (the worker process polls the queue; its health check goes stale after three polls plus thirty seconds) |
| PORT | Railway (set by the platform, not by hand) | no | built 30 Sep: the worker's health-check port (`GET /healthz`, named in `railway.json`) |
| LOG_LEVEL | none | no | retired: not read by the code; remove it where an older setup has it |
| INDEED_CLIENT_ID, INDEED_CLIENT_SECRET, ZIPRECRUITER_API_KEY | none | — | unused (manual channels); may be removed |

Secrets are entered by Nadine or Paul directly in the Vercel dashboard (Sensitive) and the Railway dashboard (sealed), and in a local `.env` on a trusted machine only when a staging value is needed for verification. Staging and production values are never the same.

## Appendix B. Proposed DNS records (for Nadine's review; none applied)

All records are on new subdomains; nothing at the root changes except the two verification TXT records marked "root, additive". Values marked "provider supplies" are copied from the provider's screen at setup time.

| Purpose | Type | Name | Value | When |
|---|---|---|---|---|
| Postmark DKIM for outbound product email | TXT | `<selector>._domainkey.hire` | provider supplies (Postmark → Domains) | after step 12 |
| Postmark Return-Path (bounce alignment) | CNAME | `pm-bounces.hire` | `pm.mtasv.net` (confirm on the Postmark screen) | after step 12 |
| SPF for the sending subdomain | TXT | `hire` | `v=spf1 include:spf.mtasv.net -all` | after step 12 |
| DMARC for the sending subdomain | TXT | `_dmarc.hire` | `v=DMARC1; p=none; rua=mailto:security@identifiedtalent.com; adkim=s; aspf=s` for the first two weeks, then `p=quarantine` | after step 12 |
| Inbound application email | MX | `apply` | `10 inbound.postmarkapp.com` (confirm on the Postmark screen) | after step 12 |
| Application hostname | CNAME | `recruiting` (approved A8; `app` is preserved untouched) | provider supplies (Vercel → Domains, typically `cname.vercel-dns.com`) | after step 10 |
| Hosted job pages | CNAME | `jobs` | provider supplies (Vercel) | after step 10 |
| Google Cloud Identity domain verification | TXT | root (`@`), additive | `google-site-verification=<provider supplies>` | at step 14 |
| Postmark domain ownership verification, if requested | TXT | `hire` or as instructed, additive | provider supplies | after step 12 |
| Optional, ITS hygiene, not required by the product | TXT | `_dmarc` (root), additive | `v=DMARC1; p=none; rua=mailto:security@identifiedtalent.com` | at Nadine's discretion, after confirming Proofpoint and Microsoft alignment |

Never changed: name servers; root A record and `www`; MX and SPF at the root; `autodiscover`, `lyncdiscover`, `sip`; the `MS=` verification TXT; `_acme-challenge`; the existing `app` CNAME.

## Appendix C. Revised creation order

As in `12` §12: (1) confirm the email provider, (2) confirm administrative roles, (3) add Nadine as administrator, (4) secure GoDaddy, (5) export the zone, (6) mailboxes and groups, (7) 1Password Business and vaults, (8) GitHub, (9) Supabase, (9a) Microsoft Entra sign-in registration and Supabase Auth providers, (10) Vercel, (11) Railway for the worker (decision 1; Trigger.dev deferred), (12) Postmark, (13) Postmark DNS after review, (14) Google Cloud (Cloud Identity with Nadine as initial administrator), (15) Sentry, (16) PostHog, (17) Anthropic, (18) Twilio and 10DLC, (19) Microsoft Entra calendar registration deferred, (20) record identifiers and variable names.

## Appendix D. Non-secret project references to hand to Claude when they exist

Supabase project refs and URLs (staging, production); Vercel team and project names, production and preview hostnames; Railway project and service names; Postmark server names and the verified sending and inbound domains; Google Cloud project ids and the OAuth client id; Sentry organization and project slugs; PostHog project key and host; the GitHub repository URL. None of these is a secret; none grants access.

## Appendix E. Work that continues with mocks while accounts are created

Slice 5 in full with mocked adapters: the calendar-provider interface, the Google adapter against a recorded fake, the manual availability fallback, candidate availability collection, time-zone and daylight-saving handling, conflict detection, booking confirmation, ICS generation, rescheduling, cancellation, reminders, expiration, idempotency, duplicate-event protection, retry behavior, disconnection recovery, audit events, human approval before scheduling, accurate candidate and owner status; the editable business calendar (D26); the Trigger.dev task structure with an in-process test runner; the Supabase Auth JWT verification with a local fake issuer; the Next.js shell with the Hono API mounted (runs locally with PGlite); accessibility and browser-journey automation on the local app. What must wait for accounts: real OAuth, real email, real Vault, the worker on Railway, production boot checks, the staging journey that gates "connected".
