<!-- Part of the Recruiting OS product audit (docs/product-audit.md), 14 October 2026. Written by one reader from the code at origin/main dafb730 and checked by a second, skeptical reader who tried to refute every bug and status; corrections are listed under the verification notes. Working files mentioned as 'scratchpad' are not in the repository. -->

# Platform: architecture, sign-in, tenancy, roles and permissions

Audit of `recruiting-os` on branch `kanvis-reaudit` (= origin/main `dafb730`, 14 Oct 2026). Read-only. Source code, migrations and tests were treated as the truth; docs were used as leads. Paths are repo-relative.

## 1. Summary

Recruiting OS is one Next.js deployment on Vercel (`apps/shell`) that serves the signed-in staff pages (React components from `apps/web`) and, in the same process, a Hono application (`apps/api`) for the JSON API, the server-rendered candidate pages, webhooks, feeds and file stand-ins. A separate long-running worker (`apps/api/src/worker.ts`) runs on Railway and is the only process that runs workflows, AI steps and the email/SMS outbox in production. Both talk to Supabase Postgres through two different non-privileged database roles (`ros_app`, `ros_worker`); development and tests use PGlite (Postgres in WebAssembly) with the same SQL migrations.

Sign-in is delegated to Supabase Auth (Google or Microsoft, PKCE); the app then opens its own session (random token, stored hashed). ITS staff must use Microsoft plus an authenticator-app code (TOTP), enforced in code with attempt limits. Customers have no second factor of their own. An email "magic link" exists but is off by default in production. A fake identity provider is available only outside production; production refuses to start with it.

Tenant isolation is enforced by Postgres row-level security: every tenant transaction switches to the `app_tenant` role with the company id set, and cross-company reads return nothing. The important caveat is that every database connection starts in "platform mode" (sees all companies), so isolation depends on each route wrapping its queries in `withTenant`; a ratchet test limits raw queries but its pattern misses some forms. Company roles (owner, admin, hiring manager, HR, interviewer) come from a single permission matrix; ITS recruiters never become members and only reach a customer through a time-limited, scoped "staff access grant" created when they accept a request, with every request they make recorded in the customer's history. Platform roles (ITS recruiter, platform admin) live in an append-only ledger, granted by another administrator with a reason. Team invitations, role changes, removals, session lists, "Confirm it's you" re-authentication and customer revocation of recruiter access are all built end to end with tests.

The most important problems found: (1) an API route, `GET /api/v1/roles/:id/interviews`, lets an interviewer, or an ITS recruiter given only one candidate, list every interview on a role with every candidate's name and the team's interview decisions and notes (no UI uses it, but the API answers); (2) interviewers can open any role's detail by id, including applicant counts, although the roles list hides them; (3) HR can sign an owner or admin out of every session through the API, and such sign-outs reach the person's other companies too; (4) the "staff must use Microsoft" rule reads the Supabase account's first provider, not the one used for this sign-in (needs verification in the Supabase project); (5) ITS staff can sign themselves up as owners of a new company, outside the grant model. Several docs (notably `docs/spec/02-roles-and-permissions.md`) still describe magic-link sign-in, interviewer read rights, customer-side data-request handling and status-link rotation that the code does not have.

## 2. Feature inventory

| ID | Feature | Status | Who | Evidence |
|---|---|---|---|---|
| PLATFORM-01 | One origin: Next.js shell mounts the Hono API, candidate pages, webhooks and feeds in-process (Vercel) | fully_implemented | everyone | `apps/shell/lib/hono.ts:7`; `apps/shell/lib/container.ts:13-61`; `apps/shell/app/api/[[...route]]/route.ts:3-17`; `apps/shell/middleware.ts:24-26`; `apps/api/src/app.ts:115-160` |
| PLATFORM-02 | Separate queue worker on Railway with its own DB role and health endpoint | fully_implemented | platform | `apps/api/src/worker.ts:14-34`; `railway.json`; `apps/api/src/env.ts:182-185`; `apps/api/src/container.ts:58-60` |
| PLATFORM-03 | Production boot guards (no fake sign-in/AI, no PGlite, no superuser or RLS-bypassing DB role, migrations applied, shared rate-limit store, ITS company check) | fully_implemented | platform | `apps/api/src/env.ts:171-194`; `apps/api/src/container.ts:61-75`; `packages/db/src/client.ts:369-376` |
| PLATFORM-04 | Sign-in with Google or Microsoft through Supabase Auth (PKCE, server-side token check, app's own session) | fully_implemented (live Supabase config unknown) | owner, admin, hiring manager, HR, interviewer, ITS staff | `apps/api/src/routes/auth.ts:42-86`; `packages/integrations/src/identity/supabase.ts:21-60`; `packages/core/src/identity.ts:41-87`; `apps/api/src/routes/auth-shared.ts:35-50` |
| PLATFORM-05 | Email sign-in link (development aid; off by default in production; refused for ITS staff) | fully_implemented | customers (dev/staging) | `apps/api/src/routes/auth.ts:141-219`; `packages/core/src/auth.ts:22-81`; `apps/api/src/env.ts:136` |
| PLATFORM-06 | Fake sign-in page for local development | fully_implemented (dev only) | developers | `apps/api/src/routes/auth.ts:109-139`; `apps/api/src/env.ts:178` |
| PLATFORM-07 | ITS staff second factor (authenticator enrolment, code check, backup authenticator, 5 tries per attempt, 12 per person per window, reset detection) | fully_implemented | ITS recruiter, platform admin | `apps/api/src/routes/auth-mfa.tsx:104-261`; `packages/core/src/identity.ts:26-33`; `apps/api/src/routes/auth-shared.ts:88-96`; `apps/api/src/mfa.test.ts`; `tests/e2e/specs/staff-mfa.spec.ts` |
| PLATFORM-08 | Second factor for customer owners/admins | planned_not_implemented | owner, admin | `docs/spec/09-security-and-privacy.md:18` ("before general release"); no code path requires `aal2` for members |
| PLATFORM-09 | Sessions: hashed tokens, 30-day sliding for customers, 8-hour sliding for staff, list own sessions, sign out one / everywhere else | fully_implemented | all signed-in people | `packages/core/src/auth.ts:9-11,111-185`; `apps/api/src/routes/auth-sessions.ts:20-55`; `apps/web/src/pages/Setup.tsx:459-462` |
| PLATFORM-10 | "Confirm it's you" re-authentication for rule changes, candidate notices, new-times setting, and making someone admin/owner | fully_implemented | owner, admin (and HR inviting) | `apps/api/src/middleware/reauth.ts:12-18`; `apps/api/src/routes/auth-sessions.ts:95-138`; `apps/api/src/routes/policies.ts:78`; `apps/api/src/routes/company-settings.ts:86-87`; `apps/api/src/services/team.ts:104-119`; `packages/db/migrations/0024_session_reauth.sql` |
| PLATFORM-11 | Tenant isolation by Postgres row-level security (`app_tenant` + `app.company_id`) | fully_implemented (depends on routes using `withTenant`) | all customers | `packages/db/migrations/0001_rls_and_grants.sql:22-39`; `0003_platform_roles.sql:38-77`; `packages/db/src/client.ts:323-338`; `packages/db/src/rls.test.ts` |
| PLATFORM-12 | Ratchet test against raw (unscoped) database queries | partial | platform | `tests/policy/raw-db-access.test.ts:15-30` (pattern misses aliased `db` variables; allowances above current counts) |
| PLATFORM-13 | Supabase Data API locked out (anon/authenticated/service_role revoked); service-role key never referenced | fully_implemented | platform | `packages/db/migrations/0017_supabase_api_roles.sql`; `packages/db/src/api-roles.test.ts`; `tests/policy/service-role-guard.test.ts` |
| PLATFORM-14 | Company role permission matrix (owner, admin, hiring manager, HR, interviewer; "recruiter" for ITS under a grant) | fully_implemented | all members | `packages/core/src/permissions.ts:44-74`; `assertCan` in every tenant route |
| PLATFORM-15 | Interviewer limited to their own roles and interviews, never pay | partial | interviewer | list filtered: `apps/api/src/routes/roles.ts:50-54`, `apps/api/src/routes/interviews.ts:132,141-144,166`; NOT filtered: `roles.ts:91-135` (role detail with counts), `interviews.ts:434-450` (all interviews of a role) |
| PLATFORM-16 | Team invitations (own table, hashed token, 7 days, accepted only by signing in with the invited address, ITS addresses refused, owner-only for owner invites) | fully_implemented | owner, admin, HR; invitee | `packages/db/migrations/0022_invitations.sql`; `packages/core/src/invitations.ts:22-163`; `apps/api/src/services/team.ts:80-144`; `apps/api/src/routes/auth.ts:239-274`; `apps/web/src/pages/TeamCard.tsx:58-81`; `apps/api/src/team.test.ts` |
| PLATFORM-17 | Change a member's role or remove them (no self-change, last owner kept, owner-only/admin-only rules, sessions ended, calendar disconnected, their interviews handled) | fully_implemented | owner, admin, HR | `apps/api/src/services/team.ts:158-245`; `apps/api/src/routes/companies.ts:98-103`; `apps/web/src/pages/TeamCard.tsx:82-137` |
| PLATFORM-18 | Owner/admin signs a team member out everywhere | partial | owner, admin (code also lets HR) | API only: `apps/api/src/routes/company-settings.ts:498-516`; no button in `apps/web` |
| PLATFORM-19 | Platform roles ledger (ITS recruiter, platform admin): grant/revoke by another admin with reason, no self-grant, last admin kept, alerts and emails to other admins, one-time bootstrap | fully_implemented | platform admin | `packages/core/src/platform-roles.ts:51-103`; `apps/api/src/routes/admin.ts:416-465`; `apps/web/src/pages/Admin.tsx:661-666`; migrations `0011`, `0014`; `apps/api/src/platform-roles.test.ts` |
| PLATFORM-20 | ITS recruiter queue: preview only before accepting, each view audited | fully_implemented | ITS recruiter, platform admin | `apps/api/src/routes/approvals-escalations-events.ts:378-428`; `apps/web/src/pages/RecruiterQueue.tsx` |
| PLATFORM-21 | Scoped, time-limited staff access on accepting a request (14 days, 24 h after resolution, release ends it, every request recorded, role/candidate scope guards) | fully_implemented (gaps in B1, B6) | ITS recruiter; customer sees it | `packages/core/src/staff-access.ts:17-127`; `apps/api/src/middleware/session.ts:46-58,97-117`; `apps/api/src/routes/approvals-escalations-events.ts:431-595`; `apps/api/src/services/staff-scope.ts:17-49`; `apps/api/src/staff-access.test.ts` |
| PLATFORM-22 | Customer sees ITS access and ends it at once (confirmed, reasoned, recruiter told, request back in queue) | fully_implemented | owner, admin | `apps/api/src/routes/companies.ts:106-174`; `apps/web/src/pages/Setup.tsx:372-377`; `tests/e2e/specs/revoke-access.spec.ts` |
| PLATFORM-23 | Break-glass emergency access for platform admins (fresh second factor, reason, max 60 min) | partial | platform admin | API only: `apps/api/src/routes/admin.ts:360-374`; no console control in `apps/web/src/pages/Admin.tsx`; stale refusal text |
| PLATFORM-24 | Admin console guard (platform admin + second factor) with per-request audit (reason header optional: defaults to "admin console", `admin.ts:26`) | fully_implemented | platform admin | `apps/api/src/middleware/session.ts:75-82`; `apps/api/src/routes/admin.ts:24-29`; `apps/shell/app/(app)/admin/layout.tsx:6-10`; console sends a reason (`apps/web/src/pages/Admin.tsx:661`) |
| PLATFORM-25 | Admin signs any person out everywhere (lost device) | partial | platform admin | API only: `apps/api/src/routes/admin.ts:494-507`; not in `Admin.tsx` |
| PLATFORM-26 | One person in several companies, switching the active company | partial | members of 2+ companies | API: `apps/api/src/routes/auth.ts:304-315`, `/auth/me` memberships; no switcher in `apps/shell/components/AppShell.tsx`; only `RecruiterQueue.tsx:193` calls switch |
| PLATFORM-27 | Open sign-up: any signed-in person creates a company and becomes its owner; nothing public until the ITS check | fully_implemented | new owner | `apps/api/src/routes/companies.ts:18-29`; `apps/api/src/services/companies.ts:16-49`; `apps/shell/app/(session)/setup/company/page.tsx` |
| PLATFORM-28 | Candidate access by unguessable link tokens (status, screen, schedule, confirm-answers) | fully_implemented | candidate | `apps/api/src/pages/candidate.tsx:713-716`; `apps/api/src/pages/schedule.tsx:28-41`; `packages/db/src/schema/hiring.ts:295,376,460-461`; `apps/api/src/services/applications.ts:113` |
| PLATFORM-29 | "Lost your link?" re-sends a candidate's status links (same answer whether or not the address is known) | fully_implemented | candidate | `apps/api/src/pages/candidate.tsx:558-575`; `apps/api/src/services/applications.ts:211-239` |
| PLATFORM-30 | Candidate can rotate their status link ("get a new link") | planned_not_implemented | candidate | `docs/spec/02-roles-and-permissions.md` §6; `docs/spec/09-security-and-privacy.md:43`; no code |
| PLATFORM-31 | Tracked application links `/a/:token` (source attribution, not an access credential) | fully_implemented | candidate, owner (reporting) | `apps/api/src/pages/links.tsx:56-83` |
| PLATFORM-32 | Customer audit history and CSV, never readable by ITS staff under a grant | fully_implemented | owner, admin, HM, HR | `apps/api/src/routes/company-settings.ts:457-492` |
| PLATFORM-33 | Cross-site change refusal and SameSite=Lax httpOnly session cookie (brief; ops agent covers headers/CSP/rate limits) | fully_implemented | everyone | `apps/api/src/middleware/same-site.ts:47-54`; `apps/api/src/app.ts:59-64`; `apps/api/src/routes/auth-shared.ts:12-21` |
| PLATFORM-34 | Customer-side handling of candidate data requests (owner/admin/HR) | planned_not_implemented | owner, admin, HR | only ITS: `apps/api/src/app.ts:137`, `apps/api/src/routes/privacy-requests.ts:15`; spec lists `data_request.manage` |
| PLATFORM-35 | Hiring manager limited to their own roles | planned_not_implemented | hiring manager | `docs/spec/02-roles-and-permissions.md` matrix ("release 2"); `roles.ts:40-89` lists all roles to HMs |
| PLATFORM-36 | Webhook authentication (Postmark shared secret on `/inbound` and delivery events, Twilio signature; refused in production when the secret is unset) (brief) | fully_implemented | platform | `apps/api/src/webhooks/postmark.ts:31-38,264,284-286`; `apps/api/src/webhooks/twilio.ts:23-29` |
| PLATFORM-37 | Self-service: a member leaves a company, or an owner closes/deletes the company account | planned_not_implemented (absent; no doc found that schedules it) | owner, any member | no route or UI: no leave/close/delete handler in `apps/api/src/routes/companies.ts` or `company-settings.ts`; only another manager can remove a member (`services/team.ts:158`) |
| PLATFORM-38 | "Bring in a recruiter": a team member asks ITS for help and chooses what the recruiter may see (one candidate, one role, or all hiring); reply-by time, ITS queue email, plan allowance; this is the only door to a staff grant | fully_implemented | owner, admin, hiring manager, HR | `apps/web/src/components/AskRecruiter.tsx:57` -> `POST /api/v1/escalations` (`apps/api/src/routes/approvals-escalations-events.ts:144-177`, `settleScope` `:119-137`); `createEscalation` in `packages/core`; `GET /escalations/mine` `:206` |

## 3. Architecture map

### 3.1 Components

| Component | What it is | Hosting | Key files |
|---|---|---|---|
| `apps/shell` | Next.js 15 App Router app. Server layouts resolve the signed-in person by calling the API in-process (`getMe` -> `/api/v1/auth/me`); catch-all route handlers hand `/api`, `/c`, `/careers`, `/a`, `/files`, `/webhooks`, `/feeds`, `/dev`, `/privacy`, `/healthz`, `/sitemap.xml`, `/robots.txt` to Hono unchanged. Adds a per-request CSP nonce for its own pages only. | Vercel (region `pdx1`, `maxDuration` 300 s) | `lib/hono.ts`, `lib/container.ts`, `lib/session.ts`, `middleware.ts`, `app/**/route.ts`, `vercel.json` |
| `apps/web` | The signed-in pages as React components (Today, Roles, Talent, Interviews, Setup, Recruiter queue, Admin console), using TanStack Query and a relative `fetch` client with cookies. No routing of its own. | rendered by shell | `src/api/client.ts`, `src/pages/*` |
| `apps/api` | Hono app: JSON API `/api/v1/*`, candidate pages (hono/jsx SSR), schedule pages, privacy-request pages, tracked links, public feeds, file stand-in, webhooks, `/healthz`. Middleware order: error handler, context storage, request logger (redacted), Referrer-Policy fix for its own forms, secure headers, cross-site check on `/api/*`, session/tenant resolution, rate limits, candidate CSP. | in-process in shell on Vercel | `src/app.ts`, `src/middleware/*`, `src/routes/*`, `src/pages/*`, `src/services/*` |
| Worker | `apps/api/src/worker.ts`: polls the `jobs` table, runs workflows, agents, the outbox (email/SMS), credential revocation, maintenance and health jobs; serves its own `/healthz` for Railway. | Railway (`pnpm worker:start`, health check `/healthz`, restart on failure) | `src/worker.ts`, `src/worker-health.ts`, `src/container.ts`, `railway.json` |
| `src/container.ts` | Builds everything one process needs: env, DB handle (with boot role check), migrations (dev) or migration-status check (prod), AI runtime, integrations (identity, email, SMS, storage, calendars, secrets, scanner, analytics), rate-limit store, workflow engine and job registrations. | both | `apps/api/src/container.ts:46-200` |
| `packages/core` | Domain rules: auth/sessions, identity policy, permissions, platform roles, staff access, invitations, audit, events, policies, stages, compliance, privacy requests, rate-limit store, CSP builder. | library | `src/auth.ts`, `src/identity.ts`, `src/permissions.ts`, `src/platform-roles.ts`, `src/staff-access.ts`, `src/invitations.ts` |
| `packages/db` | Drizzle schema, SQL migrations `0000`-`0035`, `withTenant`/`withPlatform`, pool settings, provisioning/validate/status CLIs, PGlite for dev/tests. | library | `src/client.ts`, `src/schema/*`, `migrations/*` |
| `packages/contracts` | Zod schemas for API shapes and domain objects (e.g. `MembershipRole`, `TeamRole`, `MeResponse`). | library | `src/api/index.ts:19-115` |
| `packages/integrations` | Adapters with fakes: Supabase identity (+MFA endpoints), fake identity, Postmark, Twilio, Google Calendar, Supabase/local storage, Vault secrets, ClamAV scanner, job boards, BLS pay data, analytics, Sentry. | library | `src/identity/*`, `src/registry.ts` |
| `packages/ai` | Model provider interface, Anthropic + fake providers, prompt registry, routing with the Haiku 5.5 / Sonnet 5.5 allow-list. | library | `src/routing.ts:8-12,72-75` |
| `packages/agents`, `packages/workflows` | AI tasks and message writers; the Postgres-backed workflow engine and definitions (intake, screen, schedule-interview, publish-role, new-times, stuck-role detector...). | library, run by worker | `packages/workflows/src/engine.ts`, `src/definitions/*` |
| `packages/ui`, `packages/evals`, `packages/playbooks` | Design-system components and CSS tokens; AI evaluation runner and results; vertical playbooks (dental, consumer). | library | |
| Supabase | Postgres (+pgvector, Vault for integration credentials, Storage for résumés) and Auth (Google, Microsoft, TOTP). The Data API is not used and is locked out. | managed | migration `0017` |
| Upstash Redis | Shared rate-limit counters (required in production for the app). | managed | `apps/api/src/env.ts:190-192` |

### 3.2 Boundaries and data flow

1. Browser -> Vercel (one origin, `APP_BASE_URL`). Next.js serves pages; every API call from the pages is a same-origin `fetch` with the `ros_session` cookie (`apps/web/src/api/client.ts:22-32`). There is no CORS and no second API host.
2. Next.js server layouts call Hono in-process (`apps/shell/lib/session.ts:18-26`), so page gating and API gating share the same session logic.
3. Hono -> Postgres as `ros_app`. Each connection is put into platform mode (`SET app.platform = 'on'`) before use (`packages/db/src/client.ts:168-183`). Tenant work runs inside `withTenant` (switches to `app_tenant`, platform off, `app.company_id` set; `client.ts:323-330`). Platform paths (sign-in, token lookups for candidate pages, webhooks, admin, recruiter queue) use `withPlatform` or a raw query.
4. Changes that must reach the outside world (emails, texts, calendar events, credential deletion) are written as jobs in the same transaction and executed by the worker as `ros_worker`; only the worker role can claim jobs (`0003_platform_roles.sql:32`, `rls.test.ts:194`).
5. Sign-in: browser -> Hono `/api/v1/auth/start/:provider` -> Supabase Auth -> Google/Microsoft -> back to `/api/v1/auth/callback` -> Hono verifies the Supabase JWT and opens its own session row.
6. Candidates never sign in. Their pages under `/c/*`, `/careers/*` are reached by unguessable tokens in links; the token is looked up first in platform mode, then the company's data is read inside that company's tenant transaction.
7. Development: `WORKER_INLINE=true` runs the worker loop inside the shell (`apps/shell/lib/container.ts:16-29`), PGlite on disk (`.data/pglite`), fake AI/email/identity. Tests use in-memory PGlite and drive the engine synchronously.

### 3.3 Hosting notes
- Vercel instances are kept alive until the pool's idle connections close (`after()` in `apps/shell/lib/container.ts:53-61`) because the Supabase session pooler gives `ros_app` only 15 slots.
- Railway runs `pnpm worker:start` with a typecheck build (`railway.json`); `WORKER_INLINE` must be false in production (`env.ts:185`).
- Security headers, CSP (report-only by default), rate limits and same-site checks are summarized only (ops agent covers them): `apps/api/src/app.ts:55-94`, `apps/shell/middleware.ts`, `apps/api/src/middleware/rate-limit.ts`.

## 4. Workflows traced

### W1. A customer signs in with Google or Microsoft
1. UI: `/login` (`apps/shell/app/(public)/login/page.tsx`) renders `apps/web/src/pages/Login.tsx`, which reads `GET /api/v1/auth/config` (providers, whether the email link is offered) (`routes/auth.ts:32-35`).
2. Button -> `GET /api/v1/auth/start/:provider`: checks the provider is offered, makes a PKCE verifier and random state, stores `verifier.state.provider` in the httpOnly `ros_pkce` cookie for 10 minutes, redirects to Supabase `/auth/v1/authorize` with the state carried inside `redirect_to` (`routes/auth.ts:42-52`; `supabase.ts:24-38`).
3. Supabase/Google/Microsoft -> `GET /api/v1/auth/callback?code&state`: refuses a missing cookie, missing code or a state that is not this browser's (`auth.ts:58-64`); exchanges the code server-side (`supabase.ts:39-47`) and verifies the JWT against issuer and audience (`supabase.ts:57-60`), mapping claims to an identity (`claims.ts:4-27`).
4. If the flow was a re-authentication, it is handed to `completeReauth` (W6). If Microsoft vouched for an ITS staff member without a second factor, the sealed `ros_mfa` cookie is set and the browser goes to the authenticator step (W2) (`auth.ts:69-77`).
5. Otherwise `openSession` runs one platform transaction (`auth-shared.ts:35-50` -> `core/identity.ts:41-87`): finds the user by provider+subject or email; refuses a different subject for the same provider account (audited); applies the sign-in policy (verified email; staff must be Microsoft + `aal2`); creates or links the user; applies the one-time bootstrap admin; accepts open invitations for the verified address (and the one in the `ros_invite` cookie); inserts a `sessions` row with only the SHA-256 of a 32-byte random token, the provider and assurance level; audits `session.opened`.
6. The `ros_session` cookie (httpOnly, SameSite=Lax, Secure in production, 30 days) is set; redirect to `/` (has a company or is staff) or `/setup/company` (`auth.ts:78-81`).
7. DB: `users`, `sessions`, `invitations`, `memberships`, `audit_records`, possibly `platform_role_grants`.

### W2. ITS staff sign in (Microsoft + authenticator)
1. Steps W1.1-W1.4; `needsSecondFactor` decides (`auth-shared.ts:88-96`).
2. `GET /api/v1/auth/mfa` lists the person's factors at Supabase with their own token; enrols a TOTP (QR + secret) the first time, else shows the code page (`auth-mfa.tsx:104-127`).
3. `POST /api/v1/auth/mfa`: refuses cross-site posts; counts attempts per transaction (5) and per person (12 per window) in the shared store before asking Supabase; challenge+verify in one request; on success verifies the re-issued token is `aal2`, then `openSession` (W1.5) (`auth-mfa.tsx:130-206`).
4. First enrolment stamps `users.mfa_enrolled_at` and ends every other session of the person; a later "no factor at the service" is audited as a reset (`auth-mfa.tsx:80-85,210-217`). A backup authenticator is offered while the level-2 token is at hand (`auth-mfa.tsx:221-247`).
5. Staff sessions slide by 8 hours, not 30 days (`core/auth.ts:126-128`; `identity.ts:78`).

### W3. Every signed-in request: who you are and which company you act in
1. `sessionMiddleware` (`middleware/session.ts:38-62`) reads `ros_session`, loads the session by token hash (not revoked, not expired), loads the user, and reads the platform role from the ledger on every request (`core/auth.ts:111-141`, line 122).
2. Tenant: the session's active company must be an active membership -> `tenant = {companyId, role}`. If not, and the person is ITS staff, an active staff grant for that company gives `role: "recruiter"` plus the grant's scope, and every `/api/` request (except `/api/v1/auth/*`) writes a `staff.tenant_accessed` audit row (`session.ts:46-57`). No header can choose a company (`tenancy.test.ts:49`).
3. Route guards: `requireUser`, `requireTenant`, `requirePlatformAdmin` (ledger role + `aal2`), `requireRecruiterOrAdmin` (staff + `aal2`) (`session.ts:64-90`); `roleScopeGuard`, `applicationScopeGuard`, `interviewScopeGuard` limit staff to the grant's role/candidate (`session.ts:97-117`; `interviews.ts:113-122`).
4. Handler: `assertCan(t.role, permission)` from the matrix (`core/permissions.ts:76-91`), then all reads/writes in `withTenant(db, t.companyId, ...)`; Postgres RLS refuses anything outside that company.
5. Pages: `(app)/layout.tsx` requires a session; `(company)/layout.tsx` requires an active company; `recruiter/layout.tsx` requires staff; `admin/layout.tsx` requires platform admin (`apps/shell/app/(app)/*/layout.tsx`).

### W4. Owner invites a teammate; the teammate joins
1. UI: Setup -> Team card -> Invite (`apps/web/src/pages/TeamCard.tsx:67-71`) -> `POST /api/v1/companies/current/members/invite` (`routes/companies.ts:76-83`).
2. Service: `members.manage` required; only an owner may invite an owner, only owner/admin an admin, both need a recent sign-in; ITS staff domains refused; an active member refused (`services/team.ts:80-119`).
3. DB: in the tenant transaction, `createInvitation` stores only the token hash (7 days; replaces an older open one) and the email is queued in the outbox (`team.ts:46-72,87-94`; `core/invitations.ts:61-81`).
4. Worker sends the email. The link `GET /api/v1/auth/invite?token=` shows a page naming company and role and sets a sealed `ros_invite` cookie; it signs nobody in (`routes/auth.ts:239-245`).
5. Invitee signs in with Google/Microsoft (or asks for an email link to the invited address only, `auth.ts:248-268`). `acceptPendingInvitations` honours it only for the invited address; a different address is refused and the cookie kept; an expired one dropped (`core/invitations.ts:148-163`; `auth-shared.ts:35-50`). Membership created with the invited role; staff accounts accept nothing.

### W5. Change a member's role or remove them
1. UI: Team card role select / Remove (`TeamCard.tsx:82-137`) -> `PATCH /api/v1/companies/current/members/:userId` (`companies.ts:98-103`).
2. Rules in order: active member; not yourself; last owner kept; owner-only for anything touching owner; owner/admin-only for anything touching admin (HR cannot); granting admin/owner needs a recent sign-in (`team.ts:158-183`).
3. Role change: membership updated, `membership.changed` event + audit (`team.ts:185-189`).
4. Removal: membership `removed`; calendar disconnected and credential deletion queued; removed from upcoming interviews; interviews they ran alone cancelled through the single cancel path (candidate told if they had a time); owners/admins notified (`team.ts:191-232`).
5. After commit, every session of that person is revoked in a platform transaction (all companies) (`team.ts:234-243`).

### W6. "Confirm it's you" before a sensitive change
1. A rule/notice change or admin/owner grant from a session older than 30 minutes returns 403 `reauth_required` (`middleware/reauth.ts:12-18`; `team.ts:116-119`).
2. UI shows the prompt (`Setup.tsx:48-79,486`) -> `POST /api/v1/auth/reauth/start` sets a sealed `ros_reauth` marker (session id, user id, expected state ending `-reauth1`, return path) and a PKCE cookie, returns the provider URL (`auth-sessions.ts:95-115`).
3. Callback sees the marker and suffix -> `completeReauth`: same session and user, same state, same verified email and (if linked) same subject; stamps `sessions.reauthenticated_at`, audits `session.reauthenticated`, returns with `reauth=ok|mismatch|failed` (`auth-sessions.ts:123-138`). The change is then allowed for 10 minutes.

### W7. Bring in an ITS recruiter, the recruiter works, access ends
1. Customer raises a request (Bring in a recruiter; `escalation.create`). ITS recruiter sees only a preview in the queue, each view audited (`approvals-escalations-events.ts:363-388`).
2. `POST /api/v1/escalations/:id/claim` (staff + `aal2`): refused if closed, held by another, or this recruiter's access to it was ended by the customer; a request naming no role/candidate is accepted only if a team member asked for company-wide help; creates a `staff_access_grants` row scoped to the request's role/candidate for 14 days, emits `recruiter.access_granted`, audits, and tells the customer in plain words (`:431-477`; `core/staff-access.ts:21-52`).
3. UI: Recruiter queue "Open" -> `POST /api/v1/auth/switch` (allowed only with an active grant) (`RecruiterQueue.tsx:193`; `auth.ts:304-315`). The app shows a banner "You are inside X through an escalation" (`AppShell.tsx:196`).
4. Requests inside the customer run as role `recruiter`, limited by scope guards; each is audited (W3). Lists (Today, events, requests) are filtered with `staffScopeOf/inStaffScope` (`services/staff-scope.ts`). Drafting new roles is refused under a scoped grant (`routes/intake.ts:28-35`).
5. End: resolve shortens the grant to 24 hours after resolution (`:523-551`; `staff-access.ts:80-85`); release ends it now (`:581-595`); expiry closes it on the next check (`staff-access.ts:55-69`); the customer can end it at once with confirmation and a reason (`companies.ts:134-174`), after which the same recruiter cannot reclaim that request.

### W8. Platform admin grants or revokes a platform role
1. Admin console (`Admin.tsx:661-666`) -> `POST /api/v1/admin/platform-roles` with email, role, reason, confirm (`admin.ts:423-446`).
2. Checks: platform admin with `aal2`; reason >= 5 chars; email on an ITS staff domain; person has signed in (with Microsoft: `requireStaffProvider: "azure"`); not self; not already held (`platform-roles.ts:51-71`). Ledger row inserted under an advisory lock, cache column updated, audit, high-severity alert for another admin to acknowledge, emails to every other admin and the ITS queue.
3. Revoke: same pattern; the last admin cannot be revoked (`platform-roles.ts:74-86`; `admin.ts:448-465`). Effective on the next request because the ledger is read every time (`core/auth.ts:122`).

### W9. Break-glass (platform admin into a customer)
1. `POST /api/v1/admin/break-glass` with company, reason, minutes (`admin.ts:360-374`).
2. Requires `mfaVerifiedAt` within 15 minutes (set only when the session was opened; re-authentication does not refresh it, `core/auth.ts:144-146`), caps at 60 minutes, creates an unscoped `break_glass` grant, audits `admin.break_glass`.
3. Admin then switches into the company (API) and acts as `recruiter` with company-wide scope; every request audited. No console button exists for steps 1-3.

### W10. A candidate opens their status link
1. Email link `/c/status/:token` (Hono page, rate-limited, nonce CSP) (`pages/candidate.tsx:713`).
2. Raw platform-mode lookup `applications.status_token = :token` (unique index); 404 if unknown; a "link gone" page if the person was anonymized (`:715-718`).
3. Role, company, screen, interview read; stage history and message thread read inside the company's tenant transaction (`:719-736`). Decision stages are hidden until the candidate was told.
4. Actions on the page (withdraw, privacy request, SMS, talent pool) post back to `/c/status/:token/*` and are bound to that one application (`candidate.tsx:1695-1798`). The token never expires and cannot be rotated; "Lost your link?" re-sends the same links (`services/applications.ts:211-239`).

### W11. Someone signs up and creates a company
1. First sign-in with no membership redirects to `/setup/company` (`auth.ts:81`; `apps/shell/app/(session)/setup/company/page.tsx`).
2. `POST /api/v1/companies` (`requireUser`) -> `createCompany` in a platform transaction: unique slug, company row (`trial`), owner membership, trial entitlements, events; the session's active company is set; the stuck-role detector workflow starts; ITS is told about the new company unless `COMPANY_CHECK=auto` (`companies.ts:18-29`; `services/companies.ts:16-49`). Nothing public until ITS confirms it.

## 5. Routes and screens (this area)

### Screens (Next.js shell)
| Path | Audience | Gate |
|---|---|---|
| `/login` | public | signed-in people redirected away (`(public)/login/page.tsx`) |
| `/setup/company` | signed-in, no company | redirected home if a company is active |
| `/`, `/roles`, `/roles/new`, `/roles/[id]`, `/roles/[id]/talent`, `/roles/[id]/people`, `/talent`, `/people`, `/interviews`, `/interviews/[id]`, `/updates`, `/setup` | members; ITS staff under a grant | session + active company (`(company)/layout.tsx`); per-permission checks in the API |
| `/recruiter/queue`, `/recruiter/queue/[id]` | ITS recruiter, platform admin | `isStaff` (`recruiter/layout.tsx`) |
| `/admin` | platform admin | `isAdmin` (`admin/layout.tsx`); API also needs `aal2` |

### API routes (auth, tenancy, team, staff, admin)
| Method and path | Purpose | Audience / guard |
|---|---|---|
| GET `/api/v1/auth/config` | providers offered, magic link on/off | public |
| GET `/api/v1/auth/start/:provider`, GET `/api/v1/auth/callback` | PKCE sign-in, also re-auth return | public |
| POST `/api/v1/auth/session` | open a session from a verified access token (JSON clients/tests) | public, rate-limited |
| GET/POST `/api/v1/auth/fake/authorize` | fake consent page | development only |
| POST `/api/v1/auth/magic-link`, GET/POST `/api/v1/auth/consume`, POST `/api/v1/auth/magic-link/consume` | email sign-in link | public; 410 when disabled; staff refused |
| GET `/api/v1/auth/invite`, POST `/api/v1/auth/invite/email`, POST `/api/v1/auth/invite/forget` | invitation page, email link to the invited address, drop carried invite | public |
| GET/POST `/api/v1/auth/mfa`, GET `/mfa/backup`, POST `/mfa/skip`, POST `/mfa/cancel` | staff second factor | sealed transaction cookie |
| POST `/api/v1/auth/logout`, GET `/api/v1/auth/me`, POST `/api/v1/auth/switch` | sign out, who am I, change active company | session |
| GET `/api/v1/auth/sessions`, POST `/sessions/revoke-all`, POST `/sessions/:id/revoke`, POST `/reauth/start` | own sessions, re-authentication | session |
| POST `/api/v1/companies` | create company (open sign-up) | session |
| GET `/api/v1/companies/current`, `/current/members`, `/current/invitations`, `/current/staff-access` | company, team, open invitations, ITS access | `company.read` (any member) |
| POST `/current/members/invite` (= `/current/invites`), `/current/invitations/:id/resend`, `/current/invitations/:id/revoke`, PATCH `/current/members/:userId` | invite, resend, withdraw, change role or remove | `members.manage` (+ owner/admin rules) |
| POST `/current/members/:userId/sign-out` | sign a member out everywhere | `members.manage`, not staff (API only) |
| POST `/current/staff-access/:grantId/revoke` | end ITS access | `staff_access.revoke` (owner, admin) |
| GET `/current/audit`, `/current/audit.csv` | customer history | `events.read`, never staff |
| PUT `/api/v1/policies` | change AI/automation rules | `policy.manage` + recent sign-in |
| GET `/api/v1/escalations`, GET `/:id`, POST `/:id/claim`, `/:id/resolve`, `/:id/messages`, `/:id/release`, `/:id/posting/*` | ITS queue and work | staff + `aal2` |
| `/api/v1/admin/*` (customers, runs, ai-runs, failures, alerts, suppressions, calendar, queue, break-glass, staff-access, plan, platform-roles, users/:id/sessions/revoke, outcomes, csp-reports), `/api/v1/admin/data-requests/*`, `/api/v1/admin/observability/*` | platform console | platform admin + `aal2`; every request audited with `x-admin-reason` |

### Candidate token routes (access model only)
| Path | Token | Lifetime |
|---|---|---|
| `/c/status/:token` (+ `/privacy`, `/withdraw`, `/sms`, `/talent-pool`) | `applications.status_token`, 24 random bytes, stored as-is | life of the application; no rotation |
| `/c/screen/:token/*` | `screens.token`, 24 bytes | until the screen ends/expires (`screens.expires_at`) |
| `/c/schedule/:token/*` | `interviews.schedule_token`, 24 bytes | `schedule_token_expires_at`; cleared when an offer expires or is rescheduled |
| `/c/confirm-answers/:token` | `unconfirmed_screens.confirm_token_hash` (hashed) | `expires_at` |
| `/c/privacy-request/verify/:token` | emailed verification | per request |
| `/a/:token` | tracked link (`application_links`) | until disabled; sets a sealed source cookie, grants no access |
| `/files/put/:token`, `/files/get/:token` | sealed single-object grant | local/memory storage only |

## 6. Data models and dependencies

| Table | Purpose | Access / relations |
|---|---|---|
| `users` | person: email (unique), name, `platform_role` cache, `auth_provider` + `auth_subject` (unique pair), `mfa_enrolled_at` | RLS: a tenant sees users who have a membership in its company; tenant may not update `platform_role` (`0014`) |
| `sessions` | app session: token hash, active company, expiry, last seen, ip, user agent, provider, `aal`, `mfa_verified_at`, `reauthenticated_at`, `revoked_at` | platform only (revoked from `app_tenant`, `0001:61`) |
| `magic_links` | email sign-in links (hash, 15 min, single use) | platform only |
| `companies` | tenant; `settings` JSON holds verification, notices, pilot, etc. | RLS `tenant_self` |
| `memberships` | user x company, role (`owner/admin/hiring_manager/interviewer/hr`), status (`active/removed`) | RLS by company |
| `invitations` | company, email, role, inviter, token hash, status, expiry; never deleted | RLS by company; tenant can insert/update, nobody deletes (`0022`) |
| `platform_role_grants` | ledger of ITS roles: who, role, source, granted_by, reason, revoked_* | platform only; no deletes (`0011`) |
| `staff_access_grants` | recruiter's time-limited access: company, kind (`escalation/break_glass`), escalation/role/application scope, purpose, expiry, revoke/end | RLS; customers read their own; only the platform writes (`0004`) |
| `recruiter_escalations` | the requests ITS works on; assignment, access expiry | tenant table |
| `audit_records` | immutable audit (no update/delete for any app role, `0014:26`) | RLS by company; platform rows have null company |
| `events` | domain events (feeds activity lists and analytics) | RLS by company |
| `applications.status_token`, `screens.token`, `interviews.schedule_token` | candidate bearer tokens, unique indexes | looked up in platform mode before the company is known |

Dependencies: Supabase Auth (Google, Microsoft/Entra, TOTP), Supabase Postgres + Vault + Storage, Upstash Redis (rate limits, MFA attempt counters), Postmark (invitation, magic-link, staff-access emails), Vercel, Railway.

## 7. Roles and permissions

### 7.1 Company roles (from `packages/core/src/permissions.ts:44-74`)

| Permission | Owner | Admin | Hiring manager | HR | Interviewer | ITS recruiter under a grant ("recruiter") |
|---|---|---|---|---|---|---|
| company.read (see company, team list, open invitations, ITS access list, rules) | yes | yes | yes | yes | yes | yes |
| company.update (company settings, notices*) | yes | yes | no | no | no | no |
| members.manage (invite, resend, withdraw, change role, remove, sign a member out) | yes | yes | no | yes (not admin/owner) | no | no |
| role.create (start a hire / job builder) | yes | yes | yes | no | no | yes, but drafting refused under a scoped grant |
| role.read | yes | yes | yes | yes | yes (see 7.3) | yes |
| role.approve (approve a job packet) | yes | yes | yes (not their own draft unless sole owner) | no | no | no |
| role.manage (pause, resume, close, postings, links) | yes | yes | no | no | no | yes |
| packet.edit | yes | yes | yes | no | no | yes (waits for approval) |
| application.read / application.act | yes | yes | yes | yes | no | yes |
| application.reject (decisions, decision/closing messages) | yes | yes | yes | no | no | yes |
| candidate.search (defined; not used by any route) | yes | yes | no | yes | no | yes |
| compensation.read (pay figures) | yes | yes | yes | yes | no | yes |
| scorecard.write | yes | yes | yes | no | yes | yes |
| offer.manage | yes | yes | no | yes | no | yes |
| policy.manage (AI/automation rules; needs recent sign-in) | yes | yes | no | no | no | no |
| escalation.create (Bring in a recruiter) | yes | yes | yes | yes | no | yes |
| escalation.work, workflow.control | no | no | no | no | no | yes |
| events.read (activity, audit history) | yes | yes | yes | yes | no | yes (audit history refused to staff) |
| billing.manage, integration.manage | yes | yes | no | no | no | no |
| staff_access.revoke (end ITS access) | yes | yes | no | no | no | no |
| outcome.record (record hire/offer made, close role with outcome) | yes | yes | yes | yes | no | no |
| interview.request / interview.manage / interview.decide | yes | yes | yes | no | no (records outcome of own interview only) | yes |
| note.read / note.write | yes | yes | yes | yes | own note only, on people they interviewed | yes |

Object-level rules on top of the matrix:
- Owner role: only an owner invites, grants, changes or removes an owner; the last owner cannot be demoted or removed (`team.ts:104-108,176-180`).
- Admin role: only owner/admin grant, change or remove an admin; HR never (`team.ts:110-113,181`).
- Nobody changes or removes themselves (`team.ts:163`).
- Granting admin or owner, changing AI rules, notices or the new-times setting needs a session younger than 30 minutes or a re-authentication in the last 10 (`core/auth.ts:98-109`).
- Approvals: a person does not approve the role they started or the version they wrote unless sole owner; a request reserved for a named decision maker can be decided only by them or an owner (`core/approval-deciders.ts:30-65`).
- Drafts: visible to the person who started them plus owners/admins; take-over by owner/admin only (`routes/intake.ts:207-211,367-370`).
- Pay is stripped (not zeroed) for roles without `compensation.read` (`roles.ts:105-106,137-145`).

### 7.2 Platform roles
| Role | Can | Cannot |
|---|---|---|
| ITS recruiter (`its_recruiter`) | Sign in only with Microsoft + authenticator; see the queue preview; accept a request (creates a scoped grant); inside the customer act as "recruiter" within the grant's role/candidate; message the team on the request; resolve or release it | Use the email link; be invited to a company; see a customer's audit history; draft new roles under a scoped grant; reach a customer without a grant; reclaim a request whose access the customer ended; use the admin console |
| Platform admin (`platform_admin`) | Everything a recruiter can; the admin console (all requests audited with a reason); verify companies, plans, job-board access, apply flow; grant/revoke platform roles; handle data requests; sign a person out everywhere; break-glass (API) | Grant themselves a role; revoke the last admin; enter a customer without break-glass or an accepted request; act without `aal2` |
| Candidate | Use only the token links of their own application/screen/interview | Sign in; see any other application |

### 7.3 Where the matrix and the code disagree in practice
- Interviewer: the roles list returns only the roles they interview on (`roles.ts:50-54`), and interview detail is refused if they are not a participant (`interviews.ts:166`). But `GET /api/v1/roles/:id` returns any role (with applicant counts by stage) and `GET /api/v1/roles/:id/interviews` returns every interview on the role (`interviews.ts:437-450`). See B1, B2.
- ITS recruiter with a one-candidate grant: guarded on application and interview ids, but the role-level guard lets the grant's role through, so `GET /api/v1/roles/:id/interviews` lists the other candidates' interviews too (B1).
- HR: can sign out an owner/admin everywhere via API (B3), though the comment and docs say owners/admins; and can withdraw an owner's or admin's pending invitation to a new owner/admin (B12).
- Hiring manager and HR (anyone with `escalation.create`) can open all of the company's hiring to an ITS recruiter by choosing "all of your hiring" on a request (`settleScope`, `approvals-escalations-events.ts:119-125`); founder decision Q31 allows this, but owners may not expect a non-owner to be able to share everything.
- ITS staff can still be an owner of a company they created themselves (B5).

## 8. Integrations and AI behaviour (this area)
- Supabase Auth: authorize (PKCE), token exchange with the publishable key, JWT verification (HS256 secret or the project's JWKS), and the MFA factor endpoints with the person's own token (`packages/integrations/src/identity/supabase.ts`). The app never stores the provider's token; it opens its own session. Status, providers and keys depend on project configuration not visible in the repo.
- Fake identity provider and fake calendar consent pages for development (`auth.ts:109-139`; `integrations.ts:117-145`), refused in production.
- Postmark: invitation emails go through the outbox (`team.ts:59-70`); magic-link, staff-access-ended and platform-role-change emails are sent directly (`auth.ts:150-157`; `companies.ts:161-172`; `admin.ts:472-487`), with failures audited and alerted.
- Upstash: MFA attempt counters and request rate limits (`auth-mfa.tsx:146-147`).
- AI: not involved in sign-in or permissions. `/api/v1/auth/me` reports the AI provider id so the UI can show a development banner (`auth.ts:299`; `AppShell.tsx:197`). The model allow-list (Haiku 5.5, Sonnet 5.5) is enforced in `packages/ai/src/routing.ts:8-12,72-75`; AI runs happen in the worker.

## 9. Tests present and missing

Present (not run by this agent):
- Tenancy: `apps/api/src/tenancy.test.ts` (header cannot pick a company; cross-company role read refused; switching needs membership; staff get no tenant by default); `packages/db/src/rls.test.ts` (every company table has RLS and a policy; reads/writes isolated; tenant cannot use platform mode; app role sees nothing outside platform mode; only the worker claims jobs; boot check) - two cases skip when the connection cannot become `ros_app`/`ros_worker`; `apps/api/src/security-coverage.test.ts` (cross-tenant act/read/schedule refused; candidate token scoped; audit completeness).
- Supabase lock-down and secrets: `packages/db/src/api-roles.test.ts`, `tests/policy/service-role-guard.test.ts`, `tests/policy/raw-db-access.test.ts`.
- Sign-in: `apps/api/src/identity.test.ts` (providers; tampered/expired/foreign tokens refused; unverified email; staff Microsoft + second factor; PKCE flow and code replay; email link refused for staff; production refuses fake), `apps/api/src/supabase-signin.test.ts` (state binding), `apps/api/src/mfa.test.ts` (15 cases incl. attempt limits, reset detection, admin sign-out), `tests/e2e/specs/staff-mfa.spec.ts`.
- Platform roles: `apps/api/src/platform-roles.test.ts` (bootstrap once, ignored afterwards, `aal2` required, no self-grant, alerts, last admin, staff session length).
- Staff access: `apps/api/src/staff-access.test.ts` (preview before accept, scoped grant, per-request audit, scoped lists, resolution/expiry, break-glass MFA, customer revocation), `apps/api/src/approvals-access.test.ts` (role-scoped recruiter sees only that role's requests/interviews; interviewer sees no pay or waiting requests), `tests/e2e/specs/revoke-access.spec.ts`.
- Team: `apps/api/src/team.test.ts` (invite, accept via Google/Microsoft, wrong address, ITS address, expiry, resend/revoke, member change rules, owner-only invites, removal effects), `apps/api/src/permission-hardening.test.ts` (HR vs admin, recent sign-in), `apps/api/src/company-settings.test.ts` (reauth flow, mismatch).
- Interviewer limits: `apps/api/src/roles-list.test.ts` (list only), `apps/api/src/interview-loop.test.ts`, `apps/api/src/messages.test.ts` (brief without pay).
- Shell: `apps/shell/lib/hono.test.ts` (every mounted path, methods, CSP leaves Hono paths alone).

Missing:
- `GET /api/v1/roles/:id/interviews` as an interviewer (other candidates) and as a one-candidate recruiter (B1).
- `GET /api/v1/roles/:id` (and `/postings`, `/links`, `/volume`, `/interview-plan`) as an interviewer not on that role (B2).
- Member sign-out by HR of an owner/admin, and its effect on the person's other companies (B3).
- HR withdrawing an owner or admin invitation (B12).
- Staff creating a company through `POST /api/v1/companies` (B5).
- A recruiter holding two grants at the same company (B6).
- Supabase claim mapping when `app_metadata.provider` differs from the provider used (B4); the fake issuer always sets the provider used.
- The raw-query ratchet's own blind spots (a test that `db` aliases are counted) (B7).
- Break-glass end to end (grant then scoped requests and audit); there is no UI to test.
- Multi-company member switching in the UI (none exists).
- RLS on a real Supabase Postgres runs only when `TEST_DATABASE_URL` is set (documented in `docs/readiness/03`).

## 10. Bugs and incomplete features

B1 (medium). Interviewers, and ITS recruiters given only one candidate, can list every interview on a role through the API. `GET /api/v1/roles/:id/interviews` checks only `role.read` (`apps/api/src/routes/interviews.ts:437-450`), with no participant filter (compare the list route `:141-150` and detail `:166`) and no candidate filter for staff; `roleScopeGuard` lets a one-candidate grant through for its role (`packages/core/src/staff-access.ts:89`). Each row carries the candidate's name and stage, interviewers' names and emails, meeting link, offered times, the candidate's availability note, cancel reason, decision and decision note (`interviews.ts:31-47`); it does not include the private team notes. This is the only role-level route that ignores a one-candidate grant: the role's applications list (`roles.ts:373`), the report CSV (`reports.ts:49`), compare (`compare.ts:63`) and the role's new-times batch (`services/new-times.ts:120`) all filter to the granted candidate. Who is affected: candidates and the hiring team (privacy), owner (trust); no screen calls this route, so exposure is to someone using the API directly with their own cookie. Untested.

B2 (low). An interviewer can open any role's detail by id: `GET /api/v1/roles/:id` returns applicant counts by stage, postings and the packet without pay (`roles.ts:91-135`, counts at `:101-104`), although the list hides counts and other roles (`roles.ts:50-54`, `countsHidden`). Related role-level reads (`/postings`, `/links`, `/volume`, `/interview-plan`, `/packets`) also need only `role.read`. Effect: an interviewer can see pipeline numbers for roles they do not work on.

B3 (medium). HR can sign an owner or admin out of every session (`POST /api/v1/companies/current/members/:userId/sign-out` needs only `members.manage`, no rank check, `apps/api/src/routes/company-settings.ts:498-516`), while the code comment, the role-change rules and the docs say owners/admins. Sessions are per person, not per company, so a sign-out (and the session end after a role change or removal, `services/team.ts:237-241`) also signs the person out of any other company they belong to. Effect: an owner can be repeatedly signed out by HR; a person in two companies can be signed out by either. No UI calls this route.

B4 (low, plausible; needs verification in Supabase). The "ITS staff sign in with Microsoft" rule compares `app_metadata.provider` (`packages/integrations/src/identity/claims.ts:9`) with `azure` (`packages/core/src/identity.ts:30`). In Supabase that field is the account's first provider, not necessarily the one used for this sign-in; with identity linking on, a staff account created with Microsoft could sign in with Google (the authenticator code is still required), and one created with Google is refused through Microsoft. Effect on ITS staff: the "Microsoft 365 only" promise in `docs/customer/02-security-overview.md:89` may not hold exactly.

B5 (low). ITS staff can create their own company: `POST /api/v1/companies` needs only a session (`routes/companies.ts:18-29`) and `createCompany` makes them owner (`services/companies.ts:38`); `/setup/company` does not stop them. Inside that company they act as an owner, outside the grant model, with no staff-access audit (`middleware/session.ts:47-48`). Effect: breaks the stated rule that recruiters are never members (`docs/customer/05-administrator-guide.md:73`); a mistaken or test company could carry real data.

B6 (low). Only one ITS grant per company is used at a time: `activeStaffGrant` returns the newest (`staff-access.ts:62-68`), and claiming a second request at the same company creates a second grant (`approvals-escalations-events.ts:456-461`). The recruiter then loses the first request's role/candidate until the second grant ends. Effect: an ITS recruiter working two requests for the same customer is blocked on one of them.

B7 (low). The raw-query ratchet undercounts. Its pattern only matches `container.db.`, `c.get("container").db.` and `handle.db.` (`tests/policy/raw-db-access.test.ts:15`); queries through a local `db` variable are invisible (e.g. `apps/api/src/pages/schedule.tsx:30-36`, `pages/candidate.tsx:716`, `routes/admin.ts` (about 23 lines such as `:351-352`), `routes/privacy-requests.ts:32`, `services/apply-conversation.ts:462,559,561`), and so are queries written across two lines (`container.db` then `.select(` on the next line, e.g. `routes/auth.ts:288-292` for `/auth/me`, `routes/admin.ts:379-385`), and allowances exceed current counts (`auth.ts` 3 vs 2, `companies.ts` 2 vs 1, `test-helpers.ts` 5 vs 3). Because every connection starts in platform mode (`packages/db/src/client.ts:168-170`), a future route that forgets `withTenant` would see every company and the ratchet might not notice. Today's raw queries reviewed here are token lookups or platform paths.

B8 (low). Break-glass is API-only and hard to use: no console control; it needs a second factor verified within 15 minutes, which only a fresh sign-in sets (re-authentication does not update `mfa_verified_at`, `core/auth.ts:144-146`); its refusal text still says multi-factor "arrives with the authentication migration" (`admin.ts:357-364`). Effect: in an emergency the platform admin must sign out and in again and call the API by hand.

B9 (low). A person who belongs to more than one company has no way in the app to switch between them; only the API (`/api/v1/auth/switch`) supports it, and the UI uses it only for recruiters (`RecruiterQueue.tsx:193`; no switcher in `AppShell.tsx`). Effect: an owner with two businesses works in whichever company the session opened with.

B10 (low, design). Candidate link tokens (status, screen, schedule) are stored as-is (`packages/db/src/schema/hiring.ts:295,376,460`), and the status token never expires and cannot be replaced (`services/applications.ts:113`; no rotation code). Staff credentials (sessions, magic links, invitations) are hashed. Effect: anyone who could read the database (backup, support export) would hold working candidate links; a candidate who forwarded their link cannot revoke it. Documented as intended in `docs/readiness/14-candidate-link-trust-boundary.md`, but the spec promises rotation.

B11 (low). Any member, including an interviewer, sees pending invitations (emails, intended roles, who invited, expiry). The route needs only `company.read` (`routes/companies.ts:55-60`, whose comment says this is intended), and the Team card is rendered for every role in Setup (`apps/web/src/pages/Setup.tsx:88`) and lists them for everyone (`TeamCard.tsx:146-158`), although its own comment says only managers may list them (`TeamCard.tsx:144`). Effect: an interviewer sees who is about to join and as what. This is visible in the normal UI, not only through the API.

B12 (low; found in verification). HR can withdraw an invitation that an owner or admin sent to make someone an owner or admin. Resending such an invitation checks rank (`services/team.ts:129`), but withdrawing does not (`revokeMemberInvitation`, `services/team.ts:138-144`; the route needs only `members.manage`, `routes/companies.ts:91-95`). Effect: HR can quietly cancel an owner's plan to add a co-owner or admin; the withdrawal is audited (`packages/core/src/invitations.ts:111`).

Incomplete features: customer second factor (PLATFORM-08), customer-side data requests (PLATFORM-34), hiring-manager per-role scoping (PLATFORM-35), status-link rotation (PLATFORM-30), member/admin sign-out buttons (PLATFORM-18, -25), break-glass UI (PLATFORM-23), company switcher (PLATFORM-26), leaving a company or closing a company account (PLATFORM-37).

## 11. Doc/code drift

1. `docs/spec/02-roles-and-permissions.md` §1 says owners and members authenticate with "magic link + session cookie"; code uses Google/Microsoft via Supabase and the email link is off by default in production (`apps/api/src/env.ts:136`).
2. Same doc: "Recruiter (tenant) ... an ITS recruiter added as a member, or the customer's own"; code forbids inviting or assigning `recruiter` (`packages/contracts/src/api/index.ts:106-107`) and refuses ITS addresses (`services/team.ts:85`).
3. Same doc matrix gives interviewers `application.read*` and `events.read*`; code gives them neither (`packages/core/src/permissions.ts:66`).
4. Same doc lists new permissions `calendar.connect`, `sessions.manage`, `data_request.manage`; none exist in `permissions.ts`. Data requests are handled only by ITS admins (`apps/api/src/app.ts:137`, `routes/privacy-requests.ts:15`), not by owner/admin/HR.
5. Same doc §3: platform roles assigned with `POST /api/v1/admin/users/:id/platform-role` and the first admin created by a seed command; code uses `POST /api/v1/admin/platform-roles` by email (`admin.ts:423`) and the one-time `BOOTSTRAP_ADMIN_EMAILS` on first Microsoft + authenticator sign-in (`core/platform-roles.ts:92-103`).
6. Same doc §3 and `admin.ts:357-364`: break-glass "refused until MFA exists (D25)"; staff MFA has been built (`routes/auth-mfa.tsx`).
7. Same doc §6 and `docs/spec/09-security-and-privacy.md:43`: status tokens rotate on request; no rotation exists (only "Lost your link?" re-sending).
8. Same doc §8: a removed member's interviews are "flagged for reassignment"; code removes them and cancels interviews they ran alone (`services/team.ts:194-227`).
9. Same doc and `company-settings.ts:495` comment: owners/admins may sign members out; code allows anyone with `members.manage`, which includes HR (`company-settings.ts:500`).
10. `docs/spec/09-security-and-privacy.md:40`: "CSRF token on forms (S8)"; there are no CSRF tokens; protection is SameSite=Lax plus the Origin/Sec-Fetch-Site check (`middleware/same-site.ts`), which the same doc describes at line 53.
11. `docs/STATUS.md:219`: "signed candidate tokens"; tokens are random and not signed (`docs/readiness/14-candidate-link-trust-boundary.md:8` says so correctly).
12. `docs/STATUS.md:257`: "Integration credentials are not yet stored per company"; calendar credentials are stored per person in Supabase Vault (`routes/integrations.ts:98`, `container.ts:142-153`).
13. `docs/03-technical-architecture.md:18,63` lists the Hono mounts as `/api`, `/c`, `/careers`, `/webhooks`, `/feeds`, `/privacy`, `/healthz`; the shell also mounts `/a`, `/files`, `/dev`, `/sitemap.xml`, `/robots.txt` (`apps/shell/app/*/route.ts`).
14. `docs/spec/02` role.read note and `docs/customer/05-administrator-guide.md:63`: interviewers see only the roles they interview for; only the list route enforces this (B1, B2).
15. `apps/web/src/pages/TeamCard.tsx:144` says only team managers may list invitations; the API allows every member (`routes/companies.ts:55`).
16. `tests/policy/raw-db-access.test.ts` header says every new query on `container.db` is held to the allow-list; aliases and two-line queries escape it (B7).
17. `docs/spec/02-roles-and-permissions.md:64`: `admin.bypass` "with a required reason (S10)"; the API accepts any admin request without the `x-admin-reason` header and records "admin console" instead (`apps/api/src/routes/admin.ts:26`). The console itself does send a reason.

## 12. Unknowns

- Supabase project settings: which providers are enabled, whether identity linking is automatic (affects B4), whether TOTP MFA is enabled, JWT signing method and whether `SUPABASE_JWT_SECRET` is set.
- Whether production `ros_app` and `ros_worker` login roles are provisioned exactly as migrations expect (the boot check refuses a superuser or RLS-bypassing role, but this audit cannot see the live database).
- `COOKIE_DOMAIN` in production: if set to a parent domain, sibling hosts receive the session cookie (the same-site check limits changes, not reads).
- Whether Vercel preview deployments ever run with `NODE_ENV` other than `production` (the fake sign-in page depends on it; Next.js normally forces production).
- Whether any real customer belongs to two companies (impact of B9 and B3).
- Whether the founders still intend hiring-manager per-role scoping and customer MFA for release 1.
- Whether the e2e suites (`tests/e2e`) run in CI; this agent did not run tests.

## 13. Verification notes

A second agent re-checked this section against the code (read-only, no tests run). What changed and why:

- All eleven bugs were reproduced from code. None was refuted.
  - B1: `scopeAllows` (`packages/core/src/staff-access.ts:89`) lets a one-candidate grant through for its own role, because `settleScope` always stores the candidate's role on the request (`approvals-escalations-events.ts:128-132`). `GET /roles/:id/interviews` (`interviews.ts:437-450`) then has no candidate filter and no interviewer filter. No test or screen calls it. Added that this is the only role-level route that skips the candidate filter, and that private team notes are not included (only the decision note).
  - B4 is still "plausible": the callback never compares the provider in the `ros_pkce` cookie with `identity.provider` (`routes/auth.ts:61-78`), so everything depends on what Supabase puts in `app_metadata.provider`.
- B7 evidence was corrected. `services/email-subscriptions.ts` and `services/publishing-backfill.ts` query through a passed-in `q`, which can be a transaction. They are not clear raw queries and were removed from the examples. Added real misses: `routes/privacy-requests.ts:32`, `services/apply-conversation.ts:462,559,561` and two-line `container.db` / `.select(` queries (`routes/auth.ts:288`, `routes/admin.ts:379`). The allowance overcounts were confirmed (auth.ts 2 vs 3, companies.ts 1 vs 2, test-helpers.ts 3 vs 5).
- B11 was raised from info to low. The invitation list is not just an API detail: Setup shows the Team card to every role (`Setup.tsx:88`), so interviewers see pending invitations in the normal UI.
- New bug B12: HR can withdraw owner/admin invitations (`services/team.ts:138-144` has no rank check, unlike resend at `:129`).
- PLATFORM-24 note: the admin reason header is optional (`admin.ts:26` defaults to "admin console"). Added drift item 17 against `docs/spec/02:64`. The status stays fully_implemented because the console sends a reason.
- Added PLATFORM-37 (no way to leave a company or close/delete a company account; absent from code, and no doc schedules it) and PLATFORM-38 ("Bring in a recruiter" request with a chosen scope, the entry point to every staff grant; traced from UI `AskRecruiter.tsx:57` to API `approvals-escalations-events.ts:144-177` to DB `recruiter_escalations`). Also added a 7.3 note that a hiring manager or HR can open all hiring to ITS.
- The non-full statuses were re-checked and confirmed. PLATFORM-08: no member route requires `aal2`. PLATFORM-12. PLATFORM-15. PLATFORM-18 and -25: no `apps/web` caller for `/members/:userId/sign-out` or `/admin/users/:userId/sessions/revoke`. PLATFORM-23: no `break-glass` caller in `apps/web`. PLATFORM-26: the only `/auth/switch` caller is `RecruiterQueue.tsx:193`. PLATFORM-30: `statusToken` is written only at creation (`services/applications.ts:113`). PLATFORM-34: `privacy-requests.ts:15` is admin-only. PLATFORM-35: `roles.ts:40-89` lists all roles for hiring managers.
- Fully_implemented features traced UI -> API -> service -> DB and kept: 04 (callback, Supabase exchange/verify, `openSessionFromIdentity`), 05, 07 (attempt counters `auth-mfa.tsx:146-151`, aal2 re-check `:196`), 09 (`Setup.tsx:457-481` -> `auth-sessions.ts:20-55` -> `sessions`), 10 (`assertRecentAuth` at `policies.ts:78`, `company-settings.ts:86-87`, `team.ts:107,183`; `ReauthPrompt` -> `/reauth/start` -> `completeReauth`), 11, 14, 16 (`TeamCard.tsx:67` -> `companies.ts:76-83` -> `team.ts:80-97` -> `invitations`; acceptance `invitations.ts:148-172`), 17, 19 (`Admin.tsx:661-666` -> `admin.ts:423-465` -> ledger), 20, 21, 22 (`Setup.tsx:370-410` -> `companies.ts:134-174` -> `revokeStaffGrant`), 27, 29 (form -> queued job -> worker `container.ts:190-192` -> `emailStatusLinks`), 32 (`Setup.tsx:170,435-452` -> `company-settings.ts:457-492`), 33, 36. None was downgraded.
