# Staging environment variables: the Vercel Preview environment for `main`

Status: written 22 September 2026 for the first staging deployment. Every value here is either a constant, a value the
founder already holds in 1Password, or a public identifier. No secret is written here or in chat.

## Before entering anything

1. **The staging address.** The Vercel project `recruiting-os` deploys `main` as a Preview (the Production Branch is
   `production`). Its stable address is the `main` alias: Vercel, project `recruiting-os`, **Deployments**, open the
   latest deployment from `main`, and under **Domains** copy the address of the form
   `https://recruiting-os-git-main-<team>.vercel.app`. That is `APP_BASE_URL` and `WEB_BASE_URL` below, and later the
   Supabase Auth redirect address.
2. **Two generated secrets.** In your own Terminal app, run the line below once for `SESSION_SECRET` and once for
   `ANALYTICS_SALT`; each puts a fresh random value on the clipboard, never on the screen. Paste each into a new
   1Password item "Recruiting OS staging application" (fields `SESSION_SECRET`, `ANALYTICS_SALT`), then into Vercel.
   Copy something harmless afterwards to clear the clipboard.

   ```bash
   openssl rand -base64 48 | tr -d '\n' | pbcopy
   ```
3. **Scope.** In Vercel, **Settings**, **Environment Variables**: add each variable to the **Preview** environment and,
   where the form offers a branch, choose **`main`** only. Pull-request branches then deploy without these values
   and refuse to start, which is what we want: nothing but `main` reaches the staging database.
4. **Sensitive.** Tick **Sensitive** for every row marked yes below; Vercel then never shows the value again.

## The variables

| Variable | Value | Where the value comes from | Sensitive |
|---|---|---|---|
| `APP_BASE_URL` | the `main` alias, e.g. `https://recruiting-os-git-main-<team>.vercel.app` | step 1 | no |
| `WEB_BASE_URL` | the same address | step 1 | no |
| `SESSION_SECRET` | generated | step 2 | **yes** |
| `ANALYTICS_SALT` | generated | step 2 | **yes** |
| `SECRET_STORE` | `vault` | constant | no |
| `AUTH_PROVIDER` | `supabase` | constant | no |
| `AUTH_SIGNIN_PROVIDERS` | `azure` | constant (Google sign-in is not configured in Supabase yet; add `,google` when it is) | no |
| `SUPABASE_URL` | `https://vjuaiyjmtrenbrmujvtc.supabase.co` | constant (the project reference) | no |
| `SUPABASE_ANON_KEY` | the project's publishable (anon) key | Supabase, Project Settings, API Keys | no (public by design) |
| `ITS_STAFF_EMAIL_DOMAINS` | `identifiedtalent.com` | constant | no |
| `BOOTSTRAP_ADMIN_EMAILS` | your own `@identifiedtalent.com` address | one-time: your first Microsoft sign-in with a second factor makes you the first platform administrator; remove the variable afterwards (`docs/readiness/13`) | no |
| `DATABASE_URL` | the `ros_app` connection string | 1Password, "Recruiting OS staging database", field `DATABASE_URL` | **yes** |
| `DATABASE_SSL_CA` | the full text of `prod-ca-2021.crt` | open the downloaded file in a text editor and paste it whole, including the BEGIN and END lines; the value may span lines | no |
| `AI_PROVIDER` | `anthropic` | constant | no |
| `ANTHROPIC_API_KEY` | the staging runtime key of workspace `recruiting-os-staging` | 1Password | **yes** |
| `STORAGE_PROVIDER` | `supabase` | constant | no |
| `STORAGE_BUCKET` | `resumes` | constant | no |
| `STORAGE_S3_ENDPOINT` | `https://vjuaiyjmtrenbrmujvtc.storage.supabase.co/storage/v1/s3` | the S3 Configuration screen (reported 22 Sep) | no |
| `STORAGE_S3_REGION` | `us-west-2` | the S3 Configuration screen (reported 22 Sep) | no |
| `STORAGE_S3_ACCESS_KEY_ID` | the access key ID | 1Password, "Recruiting OS staging storage" | **yes** |
| `STORAGE_S3_SECRET_ACCESS_KEY` | the secret access key | 1Password, "Recruiting OS staging storage" | **yes** |
| `SCAN_PROVIDER` | `fake` | constant (a real engine is a real-data gate) | no |
| `RATE_LIMIT_STORE` | `shared` | constant | no |
| `RATE_LIMIT_SHARED_PROVIDER` | `upstash` | constant | no |
| `UPSTASH_REDIS_REST_URL` | `https://complete-narwhal-292092.upstash.io` | the Upstash database page (reported 22 Sep) | no |
| `UPSTASH_REDIS_REST_TOKEN` | the REST token | Upstash console, database `recruiting-os-staging-rate-limit`, REST API panel; store it in 1Password ("Recruiting OS staging rate limit") first | **yes** |
| `EMAIL_PROVIDER` | `fake` | constant until Postmark is set up (messages are recorded, not sent; never described as connected) | no |
| `EMAIL_FROM_DOMAIN` | `hire.identifiedtalent.com` | constant | no |
| `EMAIL_FROM_ADDRESS` | `updates@hire.identifiedtalent.com` | constant | no |
| `EMAIL_REPLY_TO` | the ITS queue mailbox you chose in gate 1.5 (`docs/readiness/16`) | your choice | no |
| `ITS_QUEUE_EMAIL` | the same mailbox | your choice | no |
| `EMAIL_INTAKE_DOMAIN` | `apply.identifiedtalent.com` | constant (display only until Postmark inbound exists) | no |
| `PRIVACY_EMAIL` | `privacy@identifiedtalent.com` | constant | no |
| `SMS_PROVIDER` | `fake` | constant | no |
| `SMS_ENABLED` | `false` | constant | no |
| `CALENDAR_PROVIDER` | `fake` | constant (manual availability and ICS remain the path) | no |
| `ANALYTICS_PROVIDER` | `fake` | constant until PostHog is set up | no |
| `WORKER_INLINE` | `false` | constant; production refuses `true`. Until the Railway worker runs, work that needs it (intake compilation, application processing, reminders) waits in the queue | no |
| `CSP_MODE` | `report-only` | constant until the staging reports are reviewed | no |
| `TRUST_PROXY_HOPS` | `1` | constant for Vercel | no |
| `DATABASE_POOL_MAX` | `5` | constant | no |

Not set on purpose: `SENTRY_DSN` (the Sentry projects do not exist yet; reporting stays off), `WORKER_DATABASE_URL`
and `MIGRATE_DATABASE_URL` (never on Vercel), `SUPABASE_SERVICE_ROLE_KEY` (never anywhere), `MAGIC_LINK_ENABLED`
(production defaults to off), `RUN_MIGRATIONS_ON_BOOT` (production never migrates on boot; migrations run from the
founder's machine).

## After entering them

Vercel, **Deployments**, the latest `main` deployment, **Redeploy** (without the build cache is fine). When it shows
Ready, open `<the main alias>/healthz` in a browser: `{"ok":true,"db":"postgres",...,"worker":"external"}` means the
application booted against the staging database as `ros_app` with TLS verified. Report the alias and that line
(it holds no secret). Sign-in comes after the Supabase Auth redirect allow list is set to that alias.

What the boot check refuses, and what it means: "SESSION_SECRET must be set" (step 2 missed); "AUTH_PROVIDER must be
supabase" or "SUPABASE_URL and SUPABASE_ANON_KEY" (the Supabase rows); "STORAGE_PROVIDER must be supabase" (the
storage rows); "refusing to start: database role … is a superuser" would mean the wrong connection string was
entered (the owner's instead of `ros_app`'s); a certificate error means `DATABASE_SSL_CA` is missing or was pasted
incomplete.
