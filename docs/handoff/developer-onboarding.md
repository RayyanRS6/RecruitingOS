# Developer onboarding: Recruiting OS, as of 24 September 2026

For the developer joining Nadine (founder, Identified Talent Solutions). Everything the team has built lives in this
private repository: the code, every decision, every runbook, and the current state. This page is the map; it points
at the documents rather than repeating them. Nothing in the repository is a secret, and nothing secret is ever added
to it.

## 1. What this is

A recruiting department for companies of 10 to 150 people: the software does the repetitive work, the AI analyses and
recommends, the customer decides, and an ITS recruiter is one click away. Read, in order:

1. `README.md`: run it locally in five minutes (Node 24, pnpm; no Postgres, no Docker).
2. `docs/FOUNDER-CONTEXT.md` and `docs/17-founder-context-reconciliation.md`: the governing product context.
3. `docs/README.md`: the product requirements as sixteen documents, from thesis to admin console.
4. `docs/STATUS.md`: implementation status by slice.
5. `docs/spec/README.md` and `docs/spec/00-decisions-and-risks.md`: the release-1 production specification and the
   **decisions register**. Section Q of the register is the diary of everything decided and built since 21 September,
   newest at the bottom. If you read one thing beyond the README, read the register.

## 2. How the team works (these are the founder's rules, not suggestions)

- **Every change goes through a pull request on `main`**, which is protected: the `verify` check must pass (install
  from the lockfile, secret scanning, dependency audit, typecheck, migration validation, unit and integration tests,
  AI evals against a fake provider, production build, browser journeys with accessibility checks), the branch must be
  up to date, no force pushes. `pnpm ci:local` runs the same steps on your machine.
- **Release-1 scope is frozen** (`docs/spec/00` section P). Anything outside it needs the founder's written decision
  first. The register records what was authorised and when.
- **No secret value in chat, in a file, in a commit, or in a log.** Secrets are entered by the founder directly into
  the provider (Vercel, Railway, Supabase) from 1Password. The code registers every runtime secret so logs, error
  responses and error reports scrub it; `pnpm secret-scan` and gitleaks run in CI.
- **Synthetic data only** until every real-data gate in `docs/readiness/20` has evidence. No production project
  exists yet. Nothing is described as "connected" unless a real staging connection was verified.
- **Never** automatic rejection of a candidate; **never** a superuser or row-level-security-bypassing database role
  in the application; **never** the Supabase service-role key in the application (`tests/policy` enforces it).
- Text messaging, recording, automated offers, onboarding, passive sourcing and Microsoft Calendar stay off unless
  separately authorised. Manual availability and ICS scheduling remain the supported path.
- The founder receives **one action at a time** when a provider screen needs her; the team never creates provider
  accounts or changes DNS on its own.

## 3. The shape of the code

- `apps/shell`: the Next.js 15 application deployed to Vercel. It mounts the Hono API from `apps/api` and the
  owner/recruiter/admin app from `apps/web`.
- `apps/api`: the API, the server-rendered candidate pages (`/careers/...`, `/c/...`), webhooks, the container
  (`src/container.ts` wires everything), and the worker entry (`src/worker.ts`).
- `packages/db`: Drizzle schema, hand-written SQL migrations with row-level security, the migration runner (each file
  atomic, resumable), the founder's database tools (`src/cli`).
- `packages/core`: policy engine, application state machine, auth and sessions, permissions, compliance, audit.
- `packages/workflows`: the durable engine (a database-backed queue with leases, retries and timers) and the six
  workflow definitions. The worker polls this queue; nothing else runs background work.
- `packages/ai`, `packages/agents`: provider abstraction (Anthropic; a deterministic fake for tests), prompts, run
  logging, evals; the intake, triage, screening and coordination agents.
- `packages/integrations`: every external adapter (email, SMS, identity, calendar, storage, secrets, rate limiting,
  analytics, observability, scanning), each reporting its real status (`live`, `fake`, `not_connected`, ...).
- `packages/contracts`: zod schemas, the event taxonomy, redaction and file-inspection rules.
- `tests/scenario`, `tests/e2e`, `tests/policy`: the end-to-end hiring scenario on PGlite, Playwright journeys with
  accessibility checks, and policy tests (for example the service-role guard).
- `scripts/`: the founder-run database scripts (`staging-db-setup.sh`, `staging-db-status.sh`,
  `staging-db-check-role.sh`) and the repository secret scanner.

Locally everything runs on PGlite (Postgres in WebAssembly) with fake providers: `pnpm dev`, `pnpm test`.

## 4. Where staging stands today

| Piece | State | Where it is recorded |
|---|---|---|
| GitHub | private organisation repository, `main` and `production` protected; `production` is a pointer, no release yet | register section Q, phase 1 |
| Supabase `recruiting-os-staging` | Postgres (migrations applied, `ros_app` and `ros_worker` provisioned, Vault grants), Auth with Microsoft sign-in, Storage bucket `resumes` (private, S3 keys) | `docs/runbooks/staging-database-setup.md`, `docs/runbooks/resume-storage.md`, `docs/runbooks/staff-second-factor.md` |
| Vercel `recruiting-os` | Preview deployments of `main` at `https://recruiting-os-git-main-identified-talent-solutions.vercel.app`; boots against staging (`/healthz` ok) | `docs/runbooks/staging-environment-variables.md` |
| Railway `recruiting-os-staging` / service `worker` | created, variables entered; the first deployment reported a password refusal for `ros_worker`; being resolved with `scripts/staging-db-check-role.sh` | `docs/runbooks/railway-worker.md` |
| Upstash, Sentry, PostHog, Postmark, Anthropic | accounts exist; Upstash and Anthropic wired; Sentry SDK wired but no DSN yet; Postmark and PostHog not yet | `docs/spec/13`, `docs/readiness/20` |
| Next founder actions | Railway worker verified, Supabase Auth redirect allow list for the Vercel address, first staff sign-in with an authenticator, Data API exposed-schemas setting | register section Q (bottom) |

`docs/readiness/20-real-data-readiness-plan.md` lists the 22 blockers between staging and real candidate data, with
their evidence. `docs/readiness/03-staging-verification-checklist.md` is the staging checklist being ticked.

## 5. Things a newcomer trips over

- The migration runner applies each SQL file in one transaction and can complete a file an older run left half
  applied; never edit an applied migration, add the next number.
- Supabase signs its database certificates with its own authority. Every owner or application connection verifies
  TLS with the dashboard-downloaded certificate (`DATABASE_SSL_CA` in hosted environments, `DATABASE_SSL_CA_FILE` on
  a machine); the client strips a connection string's `sslmode` when it holds the certificate because node-postgres
  would otherwise discard it. `sslmode=disable` and `no-verify` are refused.
- The application strings use the Session pooler (port 5432), not the transaction pooler, because the application
  keeps per-connection state. Recorded as readiness follow-up 2b.
- The dev server used by Playwright runs with an explicit heap limit; Next restarts itself at 80 percent of the heap,
  which would wipe the in-memory database mid-run.
- pnpm 12 refuses packages younger than 24 hours; pin the newest older release instead of adding an exclusion.
- Trigger.dev was deferred by decision 1; Railway hosts the worker. Do not add a task runner.

## 6. Provider research the team relied on

`docs/research/` holds the notes taken from official provider documentation on 22 September (Supabase organisation
and project setup, keys and JWT signing, the Azure provider; the Microsoft Entra registration; Indeed, LinkedIn and
ZipRecruiter partner programmes; what the code needs from each). They are dated snapshots, not living documents.

## 7. Access you may be given, and what you will not be given

- This repository, as an outside collaborator with the Write role: you open pull requests, `verify` gates them, the
  founder or the team merges. Administration of the organisation stays with the founder.
- Staging provider dashboards only when a task needs one, with the narrowest role, on an ITS address with MFA.
- Never the owner database password, the service-role key, or a production credential (there is no production yet).
