# Recruiting OS

A hiring app for small businesses. A company types a job idea and the AI writes the job and its LinkedIn and Indeed posts; candidates apply on our job page with a form and a resume; the AI reads and scores each resume, the company shortlists, and shortlisted people do an AI interview by email. A person makes every hiring decision.

The documents start at [docs/README.md](docs/README.md). What the product is: [docs/PRODUCT.md](docs/PRODUCT.md). The guide for developers and AI agents: [AGENTS.md](AGENTS.md).

## Run it

Requirements: Node.js 24 and pnpm 12 (`package.json` pins `pnpm@12.3.4`). No Postgres and no Docker: PGlite runs Postgres inside the process.

```bash
pnpm install
cp .env.example .env   # the defaults: PGlite, stand-in providers, the worker inside the app
pnpm dev               # http://localhost:3000: the app, the API and the candidate pages on one port
```

Open http://localhost:3000, press **Get started**, then "Continue with Google" or "Continue with Microsoft": on your machine a stand-in consent page takes the place of the identity service. Fill in the company form, then on Home type: "I need a dental hygienist in Irvine. Full time. $45 to $55 an hour. I need someone who can start within 30 days."

The candidate's pages start at `/careers/<company-slug>` (the job's Share tab has the link). `/dev/outbox` lists the emails the stand-in email adapter would have sent.

The AI is a deterministic stand-in unless `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` are set. Every setting is listed in [docs/14-deployment-and-environment.md](docs/14-deployment-and-environment.md).

## Checks

| Command | What it runs |
|---|---|
| `pnpm test` | Every Vitest suite on PGlite with stand-in providers; `pnpm test path/to/file.test.ts` for one file |
| `pnpm typecheck` | `tsc` in every package |
| `pnpm lint` | Biome |
| `pnpm db:validate` | The migration files' own checks |
| `pnpm eval` | The AI evaluation suites on the stand-in AI |
| `pnpm css` | Builds the stylesheet and prints its size |
| `pnpm e2e` | The Playwright journeys |
| `pnpm ci:local` | Every CI step in order (bash) |

Other scripts: `pnpm db:migrate` (apply the migrations), `pnpm db:seed` (write the plans), `pnpm db:status` (what is applied on a hosted database), `pnpm worker:start` (the worker as its own process, as production runs it).
