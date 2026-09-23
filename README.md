# Recruiting OS

A recruiting department for companies too small to have one. The software does the repetitive work, the AI analyzes, coordinates, communicates, and recommends, the customer makes the important decisions, and a real recruiter is one click away.

Documentation starts at [docs/README.md](docs/README.md). Implementation status is in [docs/STATUS.md](docs/STATUS.md). The governing strategic context is [docs/FOUNDER-CONTEXT.md](docs/FOUNDER-CONTEXT.md), reconciled in [docs/17](docs/17-founder-context-reconciliation.md).

## Run it

Requirements: Node.js 24 and pnpm. No Postgres, no Docker (PGlite runs Postgres in WebAssembly locally).

```bash
pnpm install
cp .env.example .env
pnpm test            # unit, integration, and the end-to-end hiring scenario on PGlite
pnpm dev             # the Next.js shell on http://localhost:3000 (API, candidate pages and the signed-in interface on one port; inline worker)
```

Open http://localhost:3000 and use "Continue with Google" or "Continue with Microsoft": in development a fake consent page stands in for the identity service (the email link also works; the email adapter is a fake in development). Create a company, then on Home type: "I need a dental hygienist in Irvine. Full time. $45 to $55 an hour. I need someone who can start within 30 days."

Candidate pages are served by the API: `/careers/<company-slug>`.

Set `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` to use real models; the default is a deterministic fake provider that production refuses to run.

## Layout

`apps/api` (Hono API, candidate pages, webhooks, worker), `apps/web` (owner, recruiter, and admin app), `packages/contracts` (schemas), `packages/db` (Drizzle schema, migrations, RLS), `packages/core` (policy engine, state machine, auth, permissions, compliance), `packages/workflows` (durable engine and definitions), `packages/ai` (provider abstraction, prompts, run logging), `packages/agents` (intake, triage, coordinator), `packages/integrations` (email, SMS, job boards, compensation data, storage), `packages/playbooks` (vertical playbooks), `packages/evals` (evaluation suites), `packages/ui` (design system), `tests/scenario` (the end-to-end scenario).

## Scripts

`pnpm test`, `pnpm typecheck`, `pnpm eval` (evaluation suites; `AI_PROVIDER=anthropic pnpm eval` for real models), `pnpm db:migrate`, `pnpm db:seed`, `pnpm --filter @ros/api worker` (production worker entry).

