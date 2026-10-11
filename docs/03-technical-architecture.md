# 03. Technical architecture

## Principles

1. **Small team, boring infrastructure.** One language (TypeScript), one database (Postgres), one deployable API, one web app, one worker. Managed services for everything that is a commodity.
2. **Durability before intelligence.** The workflow engine and the event log exist before the first agent. Every agent runs inside a workflow step that can fail, retry, wait for a human, and be inspected.
3. **Schemas everywhere.** Zod schemas in `packages/contracts` define the domain objects, the API, the events, and the AI outputs. The same schema validates a request, an AI result, and a database column.
4. **Adapters, not vendors.** Every external capability sits behind an interface with at least two implementations: the real one and a test/fake one. Adapters declare their status (`live`, `pending_credentials`, `fake`) and the product shows it.
5. **Tenant isolation at the database.** Row-level security on every tenant table, enforced by setting the tenant on the connection, tested by trying to cross it.
6. **Observability is a table.** AI runs, workflow runs, and events are rows the admin console can query, not log lines.

## Stack

| Concern | Choice | Reason |
|---|---|---|
| Language and runtime | TypeScript (strict), Node.js 24 LTS | One language across API, worker, web, agents; typed contracts shared end to end |
| Monorepo | pnpm workspaces | Fast, strict dependency boundaries, small |
| API | Hono, mounted inside the Next.js app (`apps/shell`) as route handlers under `/api`, `/c`, `/careers`, `/webhooks`, `/feeds`, `/privacy` and `/healthz` | Tiny, fast, standards-based (Web `Request`/`Response`), Zod integration, JSX server rendering for candidate pages, trivially testable with `app.request()`; one deployment and one origin, so no CORS and no second host |
| Candidate-facing pages | Server-rendered with `hono/jsx`, progressively enhanced, no client framework | Mobile-first, fast on bad phones, indexable by Google Jobs, no build step |
| Web app (owner, recruiter, admin) | Next.js 15 (App Router) + React 19 + TanStack Query, on Vercel; the page components live in `apps/web` and are rendered by the shell's routes | An application behind a login; the marketing site stays where ITS already has it |
| Design system | `packages/ui`: CSS custom properties plus React components | Doc 07 |
| Database | Postgres 16+ with pgvector; **PGlite** (Postgres in WebAssembly) for local development and tests | Same SQL and same migrations locally and in production; no local Postgres install; pgvector works in both |
| ORM and migrations | Drizzle ORM for queries; hand-written SQL migrations in `packages/db/migrations` (validated by `pnpm db:validate`; a test checks the Drizzle schema against the migrated database) | Schema in TypeScript, plain SQL migrations reviewed in PRs, works with `pg` and PGlite drivers |
| Queue and workflows | Own engine in `packages/workflows` on Postgres (`jobs`, `workflow_runs`, `workflow_steps`) using `FOR UPDATE SKIP LOCKED` | Readable, testable, no extra service; upgrade path is Temporal or Inngest behind the same `defineWorkflow` API |
| AI | `packages/ai`: provider interface; Anthropic adapter first; fake adapter for tests; model routing by task tier | Doc 03 § AI layer |
| Email out | Postmark (transactional) with a product-controlled sending domain; SPF, DKIM, DMARC | Deliverability without Google restricted-scope OAuth |
| Email in | Postmark inbound webhook (JSON) to per-role intake addresses; MIME fallback parser | Indeed-hosted applications and candidate replies |
| SMS | Twilio (A2P 10DLC) | Commodity; fake adapter until the campaign is approved |
| Calendar | Google Calendar API and Microsoft Graph via OAuth (sensitive scopes) | Slice 3 |
| Job distribution | Careers page (native); Google Jobs JSON-LD (native); LinkedIn Basic Jobs XML feed (native generation, ingestion pending LinkedIn setup); Indeed Job Sync and Indeed Apply (pending partner approval); ZipRecruiter feed (pending) | Doc 16 |
| HRIS | BambooHR (direct, customer API key); handoff packet (email plus CSV, universal); Gusto Embedded and Rippling (pending partner approval); Finch (pending) | Slice 5 |
| E-signature | Dropbox Sign API (pending account) with a fake adapter | Slice 4 |
| Background checks | Checkr (pending account) | Version 1 |
| Compensation data | BLS OEWS public API (keyless v1 with limits; v2 with a free key) plus vertical playbook ranges | Slice 1 |
| Auth | Supabase Auth (Google and Microsoft, PKCE) verified server-side; the application's own session cookie; a second factor for ITS staff; the email link only outside production; platform roles in a ledger | No passwords to leak; sign-in delegated to a managed identity service (D19) |
| Secrets | Environment variables at the host (Vercel, Railway); integration credentials in Supabase Vault, written by the API role, read only by the worker role | Never application-side cryptography for stored credentials (F1) |
| Logging and errors | Redacted console logs shipped by the host; Sentry (scrubbed, no replay) when a DSN is set | |
| Hosting (staging and production) | Vercel for the Next.js app (app, API, candidate pages, webhooks); Railway for the worker; Supabase for Postgres, Vault, Storage and Auth; Upstash Redis for shared rate limits | Doc 14 |

## Process topology

```
                 ┌────────────────────────────┐
  Browser ─────▶ │ apps/web (static SPA)      │ ──── HTTPS ───┐
                 └────────────────────────────┘                │
                                                               ▼
  Candidates ──▶ ┌────────────────────────────────────────────────────┐
  Webhooks  ───▶ │ apps/api (Hono)                                    │
  (Postmark,     │  /api/v1/*  typed REST (contracts)                 │
   Twilio,       │  /careers/* /apply/* /c/*  candidate pages (SSR)   │
   Stripe...)    │  /webhooks/*                                        │
                 │  /admin/api/* platform admin                        │
                 └───────────────┬────────────────────────────────────┘
                                 │ Drizzle (RLS per tenant)
                                 ▼
                 ┌────────────────────────────┐    ┌──────────────────────────┐
                 │ Postgres (+pgvector)       │◀───│ apps/worker              │
                 │ events, runs, jobs, ...    │    │ workflow poller, timers, │
                 └────────────────────────────┘    │ agents, integrations     │
                                                   └──────────────────────────┘
```

The diagram above is the original release-1 sketch. As deployed (decision D20 and docs/14): the Next.js shell (`apps/shell`, on Vercel) serves the signed-in pages and mounts the Hono application in-process under `/api`, `/c`, `/careers`, `/webhooks`, `/feeds`, `/privacy` and `/healthz`, so there is one origin and no separate API host; the worker (`apps/api/src/worker.ts`, on Railway) is the only process that runs workflows and jobs, including the outbox that sends every queued email and text after the transaction that queued it committed. Steps that call the model do so in a prepare phase with no transaction open.

In development, `WORKER_INLINE=true` runs the worker loop inside the shell process against PGlite. In tests, the engine is driven synchronously (`runUntilIdle()`), so a whole lifecycle can be asserted in one test.

## The AI layer (`packages/ai`)

```ts
interface AiProvider {
  id: string;                                    // "anthropic" | "fake" | ...
  structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;  // JSON-schema-constrained output
  text(req: TextRequest): Promise<TextResult>;   // conversation turns, with tools
  embed(req: EmbedRequest): Promise<EmbedResult>;
}
```

- **Tasks, not models.** Callers ask for a *task* (`intake.turn`, `intake.compile_packet`, `triage.assess`, `resume.extract`, `brief.compose`). A routing table maps task → tier (`judgment` | `standard` | `fast` | `embed`) → provider model id. Defaults: judgment = Claude Opus 5, standard = Claude Sonnet 5, fast = Claude Haiku 4.5, embed = Voyage; all overridable by environment.
- **Prompt registry.** Prompts are versioned modules (`prompts/<task>.v<n>.ts`) exporting the system prompt, the output schema, and eval expectations. The registry hashes the rendered prompt; `ai_runs.prompt_version` and `prompt_hash` make every run reproducible.
- **Structured outputs.** `structured()` passes a JSON Schema derived from the Zod schema; the adapter uses the provider's structured-output mechanism; the result is validated with Zod again before it returns. A validation failure is a retry with the error fed back, then a hard failure logged as `ai_run.status = error`.
- **Run logging.** Every call writes an `ai_runs` row: company, agent, task, provider, model, model version, prompt key and version, input references (never raw PII beyond what is needed; documents are referenced by id and hash), tokens (input, output, cache read), cost (from a price table), latency, tool calls, structured output, confidence, the policy decision it fed, the human override if any, and the final outcome, filled in later by the workflow.
- **Prompt caching.** The role packet and playbook are sent as a cached prefix on every call for a role.
- **Batching.** Overnight rescoring and eval runs use the provider's batch mode where available.
- **Refusals and safety.** The adapter surfaces refusal stop reasons as a typed result; workflows treat them as "needs human."
- **Fake provider.** Deterministic, scriptable by task and by input fingerprint; used in unit tests, scenario tests, and evals. It never runs in production (`NODE_ENV=production` refuses to boot with `AI_PROVIDER=fake`).
- **Provider neutrality.** Only `packages/ai/src/providers/anthropic.ts` imports the Anthropic SDK. A second provider is a new file.

## The integration layer (`packages/integrations`)

Each capability is an interface with a registry:

```ts
type AdapterStatus = 'live' | 'pending_credentials' | 'pending_partner_approval' | 'fake' | 'disabled';
interface EmailAdapter   { status: AdapterStatus; send(msg): Promise<SendResult>; parseInbound(raw): InboundEmail; }
interface SmsAdapter     { status; send(msg); parseInbound(raw); }
interface CalendarAdapter{ status; listBusy(); createEvent(); updateEvent(); deleteEvent(); }
interface JobBoardAdapter{ status; publish(posting, packet); update(); expire(); feed?(): string; }
interface HrisAdapter    { status; createEmployee(); getEmployee(); }
interface EsignAdapter   { status; createEnvelope(); getStatus(); webhook(); }
interface CompAdapter    { status; benchmark(query): Promise<CompBenchmark>; }
```

The product shows adapter status in Setup and in the admin console. A `pending_*` adapter accepts calls, records what it would have sent, and returns a typed "pending" result so workflows can continue (for example, the careers page is live while Indeed is pending). Nothing pretends to have succeeded.

## Security architecture (summary; doc 08 has the full version)

- Transport: HTTPS only; HSTS; secure, httpOnly, sameSite cookies.
- Sessions: random 256-bit tokens stored hashed; 30-day idle expiry; revocation on logout and on role change.
- Magic links: single use, 15-minute expiry, hashed at rest, rate-limited per email and IP.
- Tenancy: every tenant table has `company_id`; RLS policies enforce `company_id = current_setting('app.company_id')`; platform admins use a separate role with explicit bypass and every read of candidate data is audited.
- Permissions: role-based (owner, admin, hiring_manager, interviewer, hr, recruiter) with object-level checks (an interviewer sees only their interviews and never compensation).
- Secrets: environment variables; integration credentials encrypted with AES-256-GCM under `APP_ENCRYPTION_KEY`; key rotation supported by a key id prefix.
- Public endpoints (apply, screen, status): signed tokens, rate limits, honeypot fields, size and MIME limits on uploads, content scanning hook.
- Data minimization: no SSNs, bank details, or government IDs are ever collected; the HRIS owns them.
- Backups: managed Postgres PITR; documents in versioned object storage; weekly restore test in staging.
- Monitoring: health endpoints, queue depth, failed-run alerts, error tracking, cost anomalies.

## Billing and entitlements

`plans` (key, name, prices, limits) and `entitlements` (company, key, limit, used, period) with `usage_events`. Checks are `entitlements.check(companyId, 'active_roles', +1)`; meters are `usage.record(companyId, 'sms_segments', 3, ref)`. Stripe is an integration that syncs subscription state into entitlements. Trials are entitlements with an expiry. Nothing in product code compares plan names.

## Development environment

- `pnpm install`, `pnpm db:migrate`, `pnpm dev` (the Next.js app with the API mounted inside it and the worker inline, on PGlite). No Docker, no Postgres install.
- `AI_PROVIDER=fake` by default; `AI_PROVIDER=anthropic` with `ANTHROPIC_API_KEY` for live runs.
- `pnpm test` runs unit and scenario tests on PGlite; `pnpm eval` runs the evaluation suites; `pnpm typecheck`.
- Production parity: the same migrations are applied to a managed Postgres in CI weekly.

## What we do not build

A video platform, a job board, a calendar engine, a mail server, an LLM gateway, a skills ontology, a resume parser, a data lake, LinkedIn automation, a cross-tenant talent network.
