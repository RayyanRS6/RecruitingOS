# 14. Deployment and environment

## Local development

Requirements: Node.js 24 LTS and pnpm. No Postgres or Docker.

```bash
pnpm install
cp .env.example .env          # defaults use PGlite and the fake AI provider
pnpm db:migrate               # applies SQL migrations to the local PGlite database (./.data/pglite)
pnpm db:seed                  # platform defaults, plans, dental playbook, a demo company
pnpm dev                      # API on :3001 with inline worker; web on :5173
pnpm test                     # unit + integration + scenario on PGlite
pnpm eval                     # evaluation suites (fake provider unless AI_PROVIDER=anthropic)
pnpm typecheck
```

On this Mac the toolchain was installed at `~/.local/its-toolchain/node/bin` (Node 24.21.0, pnpm via corepack). Add it to `PATH` or use `pnpm` from that directory.

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `NODE_ENV` | | `development` | |
| `DATABASE_URL` | prod | (PGlite when unset) | Postgres connection string for the API's non-privileged role `ros_app` (never a superuser or an RLS-bypassing role; the boot check refuses both); when unset, PGlite at `PGLITE_DIR` |
| `WORKER_DATABASE_URL` | prod (worker) | | Connection string for the worker's role `ros_worker`; separate from the API's |
| `MIGRATE_DATABASE_URL` | release step | | Owner role used only by `pnpm db:migrate` and `pnpm db:seed`; production never migrates on boot (`RUN_MIGRATIONS_ON_BOOT` is off) |
| `PGLITE_DIR` | | `./.data/pglite` | Local database directory (`memory://` for tests) |
| `APP_BASE_URL` | yes | `http://localhost:3001` | Public base for candidate links |
| `WEB_BASE_URL` | yes | `http://localhost:5173` | |
| `SESSION_SECRET` | yes | dev value | Signs session cookies |
| `COOKIE_DOMAIN` | prod, when API and app are on different hosts of one site | unset | Cookie `Domain` for the session cookie (e.g. `.example.com`); sign-in links point at the API, which sets the cookie and redirects to the app |
| `SECRET_STORE` | prod | `memory` | `vault` (Supabase Vault; the worker role reads, the API role only writes; see `packages/db/scripts/vault-grants.sql`) or `memory` (development). Production refuses `memory`. |
| `EMAIL_FROM_ADDRESS` | prod | `updates@<EMAIL_FROM_DOMAIN>` | The single sending address (`updates@hire.identifiedtalent.com`); display names name the customer's hiring team |
| `EMAIL_REPLY_TO` | prod | `ITS_QUEUE_EMAIL` | Monitored ITS mailbox for candidate replies until the platform inbox exists |
| `PRODUCT_NAME` | | `Recruiting OS` | Internal product name for owner- and staff-facing system mail |
| `AI_PROVIDER` | | `fake` | `fake` or `anthropic` |
| `ANTHROPIC_API_KEY` | when anthropic | | |
| `AI_MODEL_JUDGMENT` / `AI_MODEL_STANDARD` / `AI_MODEL_FAST` | | Claude Opus 5 / Sonnet 5 / Haiku 4.5 ids | Model routing overrides |
| `EMBED_PROVIDER`, `VOYAGE_API_KEY` | | `fake` | Embeddings |
| `EMAIL_PROVIDER` | | `fake` | `fake` or `postmark` |
| `POSTMARK_SERVER_TOKEN`, `POSTMARK_INBOUND_SECRET` | when postmark | | |
| `EMAIL_FROM_DOMAIN` | yes | `mail.localhost` | Sending domain (SPF/DKIM configured at the provider) |
| `EMAIL_INTAKE_DOMAIN` | yes | `intake.localhost` | Per-role intake addresses |
| `SMS_PROVIDER` | | `fake` | `fake` or `twilio` |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID` (or `TWILIO_FROM_NUMBER`) | when twilio | | Adapter reports `pending_credentials` until all are set; the auth token also verifies inbound webhook signatures |
| `TWILIO_WEBHOOK_URL` | optional | `APP_BASE_URL/webhooks/twilio/inbound` | The exact public URL Twilio posts to (used for signature verification behind proxies) |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | Slice 3 | | Calendar |
| `MS_OAUTH_CLIENT_ID`, `MS_OAUTH_CLIENT_SECRET`, `MS_TENANT` | Slice 3 | | Calendar |
| `INDEED_CLIENT_ID`, `INDEED_CLIENT_SECRET` | pending partner | | Job Sync |
| `ZIPRECRUITER_API_KEY` | pending | | |
| `ESIGN_PROVIDER`, `DROPBOX_SIGN_API_KEY` | Slice 4 | `fake` | |
| `BAMBOOHR_*` per company | via Setup | | Stored encrypted in `integrations` |
| `BLS_API_KEY` | optional | | OEWS v2 (higher limits) |
| `STORAGE_PROVIDER`, `S3_*` | prod | `local` (./.data/files) | Documents |
| `WORKER_INLINE` | | `true` in dev | Run the worker loop in the API process; refused in production |
| `WORKER_POLL_MS` | | `1000` | |
| `RATE_LIMIT_*` | | sane defaults | |
| `SENTRY_DSN` | optional | | Error tracking |
| `LOG_LEVEL` | | `info` | |

## Production topology

- **API**: one container (`apps/api`), horizontally scalable, behind a load balancer with TLS. Serves the REST API, candidate pages, and webhooks.
- **Worker**: one or more containers (`apps/api` with `WORKER_INLINE=false`, entry `worker.ts`). Scales on queue depth.
- **Web**: static build of `apps/web` on a CDN, pointing at the API.
- **Database**: managed Postgres 16 with pgvector, PITR, a read replica when analytics need it.
- **Object storage**: S3-compatible bucket with versioning for documents and raw inbound email.
- **Secrets**: the platform's secret store; never in images.
- **Migrations**: run as a release step (`pnpm db:migrate`) before the new API starts; migrations are backward-compatible for one release.
- **Observability**: structured logs shipped to the platform; error tracking; health checks `/healthz` (API) and `/healthz` (worker: last poll time and queue depth); alerts on failed runs, queue age, error rate, and cost anomalies.

## Release process

1. CI: typecheck, lint, unit and integration tests on PGlite, scenario test, eval suites with the fake provider; nightly evals with the real provider.
2. Staging: same topology with a managed Postgres; migrations applied; smoke test of the scenario with real adapters in sandbox mode.
3. Production: migrate, deploy worker, deploy API, deploy web. Rollback is redeploy of the previous image; migrations are forward-only and additive within a release.
