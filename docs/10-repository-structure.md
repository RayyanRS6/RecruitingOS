# 10. Repository structure

Where each piece runs is in `docs/14-deployment-and-environment.md` ("Topology"): the Next.js app (with the API inside it) on Vercel, the worker on Railway, the data on Supabase.

```
recruiting-os/
├── package.json                 pnpm workspace root: scripts (dev, test, eval, typecheck, lint, db:*, worker:*)
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── biome.json                   lint rules (run in CI)
├── .env.example                 every environment variable, documented
├── .gitleaks.toml               secret scanning, with the fake values the tests use on purpose
├── README.md                    how to run and test
├── docs/                        the documents in this folder (kept in sync with code)
├── .github/workflows/           ci.yml (scans, typecheck, lint, migration checks, tests, evals, build, browser journeys);
│                                migrate.yml (applies migrations to staging, started by a person)
├── apps/
│   ├── shell/                   Next.js 15 app, the one deployment on Vercel
│   │   ├── app/                 (app) the signed-in owner, recruiter and admin pages; (public) and (session) pages;
│   │   │                        route handlers that hand /api, /c, /careers, /webhooks, /files, /feeds, /a, /healthz,
│   │   │                        sitemap.xml and robots.txt to the API
│   │   ├── components/          the app frame and client components
│   │   ├── lib/                 the API container, the Hono handler, session, CSP
│   │   └── public/fonts/        self-hosted fonts (pinned in apps/api/src/pages/fonts.lock.json)
│   ├── api/                     Hono API, mounted inside the shell; also the worker's code
│   │   └── src/
│   │       ├── app.ts           app factory (testable)
│   │       ├── container.ts     wiring of the database, adapters and AI provider
│   │       ├── env.ts           environment parsing and the production boot checks
│   │       ├── worker.ts        worker entry (Railway; `pnpm worker:start`), with worker-health.ts
│   │       ├── maintenance.ts   the daily sweep; recurring-jobs.ts arms the recurring jobs
│   │       ├── middleware/      session, tenancy, permissions, rate limits
│   │       ├── routes/          one file per contract group (auth, companies, roles, role packets, intake, postings,
│   │       │                    interviews, messages, notes, notifications, policies, reports, admin, ...)
│   │       ├── services/        the work behind the routes (apply conversation, pool, publishing, offers, ...)
│   │       ├── pages/           candidate pages rendered on the server (job page and apply, the conversation,
│   │       │                    scheduling, the message thread, privacy requests, job feeds)
│   │       └── webhooks/        Postmark (email in, delivery events) and Twilio
│   └── web/                     React pages and the typed API client that the shell renders
│       └── src/
│           ├── api/             typed client
│           ├── components/      shared feature components
│           └── pages/           one file per page; board/, candidate-panel/, compare/, new-role/ for the larger ones
├── packages/
│   ├── contracts/               Zod schemas: domain objects, API requests and responses, events, AI outputs, policies
│   ├── db/                      Drizzle schema, migrations (plain SQL), client (pg or PGlite), RLS validator, CLI
│   │                            (migrate, seed, validate, provision, status)
│   ├── core/                    domain services: tenancy, auth, permissions, policy engine, events, audit, stages,
│   │                            match score, entitlements, compliance (jurisdictions, notices, consent), escalations
│   ├── workflows/               durable engine (runs, steps, jobs, waits, retries) and definitions/ (one file per workflow)
│   ├── ai/                      provider interface, the Anthropic and fake providers, routing, versioned prompts, run logging
│   ├── agents/                  orchestrator, intake, triage, screening, coordinator, decision messages, outbox
│   ├── integrations/            adapters, each with a fake: email (Postmark), sms (Twilio), calendar (Google), identity
│   │                            (Supabase Auth, a local fake issuer), storage (Supabase Storage, local), scanning (ClamAV),
│   │                            secrets (Supabase Vault), analytics (PostHog), observability (Sentry), comp (BLS),
│   │                            jobboards; registry.ts picks them from the environment
│   ├── playbooks/               vertical playbooks as versioned JSON with a schema
│   ├── evals/                   golden sets, edge cases, bias and injection tests, runner, reports
│   └── ui/                      design tokens (CSS) and React components
├── tests/
│   ├── scenario/                the end-to-end hiring scenario (doc 13) on PGlite with the fake provider
│   ├── web/                     page-level checks of the React pages
│   ├── policy/                  guards (no service-role key, no secret in a public variable)
│   └── e2e/                     Playwright journeys with accessibility checks
└── scripts/                     secret scan, staging database setup and status, CI on a person's machine, font fetch,
                                 apply load test
```

Boundaries: `apps/*` depend on `packages/*`; the shell reaches the API only through `lib/container.ts` and `lib/hono.ts`, and its client components import only `@ros/ui` and `@ros/contracts`; `packages/agents` depends on `ai`, `core`, `contracts`; `packages/workflows` depends on `core`, `db`, `contracts` and receives agents and integrations by injection (so tests can swap them); `packages/integrations` depends only on `contracts`; nothing imports the Anthropic SDK except `packages/ai/src/providers/anthropic.ts`.

Conventions: strict TypeScript; every exported function has a test or is covered by a scenario; every workflow has a definition doc comment matching doc 06; every prompt has a version and an eval; every API route validates with a contract schema and returns typed errors; migrations are plain SQL and reviewed.
