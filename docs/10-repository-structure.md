# 10. Repository structure

```
recruiting-os/
├── package.json                 pnpm workspace root: scripts (dev, build, test, eval, typecheck, db:*)
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .env.example                 every environment variable, documented
├── README.md                    how to run, test, deploy
├── docs/                        the documents in this folder (kept in sync with code)
├── apps/
│   ├── api/                     Hono server: REST API, candidate pages (SSR), webhooks, admin API, inline worker in dev
│   │   └── src/
│   │       ├── index.ts         boot
│   │       ├── app.ts           app factory (testable)
│   │       ├── worker.ts        worker entry (production)
│   │       ├── middleware/      session, tenancy (sets app.company_id), permissions, rate limit, audit
│   │       ├── routes/          one file per contract group (auth, companies, users, roles, packets, intake, postings,
│   │       │                    applications, candidates, screens, interviews, offers, onboarding, policies, events,
│   │       │                    escalations, integrations, admin)
│   │       ├── pages/           candidate experience (careers, job, apply, status, screen, schedule, offer, privacy)
│   │       └── webhooks/        postmark inbound, twilio, esign, stripe
│   └── web/                     Vite + React SPA: Owner Mode, Recruiter Mode, Admin
│       └── src/
│           ├── app/             router, providers, layout
│           ├── modes/owner/     Home (brief + conversation), Roles, People, Calendar, Setup
│           ├── modes/recruiter/ Pipeline, Search, Candidate workspace, Queue, Workflow controls
│           ├── modes/admin/     Customers, Runs, Failures, Costs, Escalations
│           ├── api/             typed client generated from contracts
│           └── features/        shared feature components (candidate card, approval card, ...)
├── packages/
│   ├── contracts/               Zod schemas: domain objects, API requests/responses, events, AI outputs, policies
│   ├── db/                      Drizzle schema, migrations (SQL), client factory (pg | pglite), RLS helpers, seeds
│   ├── core/                    domain services: tenancy, auth, permissions, policy engine, events, audit,
│   │                            stages (state machine), entitlements, compliance (jurisdictions, notices, consent), escalations
│   ├── workflows/               durable engine (runs, steps, jobs, waits, retries) + definitions/ (one file per workflow)
│   ├── ai/                      provider interface, providers/anthropic, providers/fake, routing, prompts/ (versioned), run logging
│   ├── agents/                  orchestrator, intake, triage, screening, coordinator, interview_intelligence, offer, sourcing (later)
│   ├── integrations/            email (postmark, fake), sms (twilio, fake), calendar (google, microsoft, fake), jobboards
│   │                            (careers, googlejobs, linkedin_xml, indeed, ziprecruiter), hris (bamboohr, handoff_packet, gusto, rippling, finch),
│   │                            esign (dropboxsign, fake), background (checkr), comp (bls, playbook), registry (status)
│   ├── playbooks/               vertical playbooks as versioned JSON with a schema; dental first
│   ├── evals/                   golden sets, edge cases, bias and injection tests, runner, reports
│   └── ui/                      design tokens (CSS) and React components
├── tests/
│   └── scenario/                the end-to-end hiring scenario (doc 13) run against PGlite with the fake provider
└── scripts/                     db migrate/seed, eval runner, admin utilities
```

Boundaries: `apps/*` depend on `packages/*`; `packages/agents` depends on `ai`, `core`, `contracts`; `packages/workflows` depends on `core`, `db`, `contracts` and receives agents and integrations by injection (so tests can swap them); `packages/integrations` depends only on `contracts`; nothing imports the Anthropic SDK except `packages/ai/src/providers/anthropic.ts`.

Conventions: strict TypeScript; every exported function has a test or is covered by a scenario; every workflow has a definition doc comment matching doc 06; every prompt has a version and an eval; every API route validates with a contract schema and returns typed errors; migrations are plain SQL and reviewed.
