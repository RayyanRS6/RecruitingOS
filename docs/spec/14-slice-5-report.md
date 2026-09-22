# 14. Corrections of 18 September 2026 and slice 5: report to the founder

Written 18 September 2026 after the sixteen corrections were applied and slice 5 (mocked scheduling) was built. Section K of `00-decisions-and-risks.md` holds the per-step evidence; this file is the summary the founder asked for.

## 1. Each correction, as applied

| # | Correction | Applied |
|---|---|---|
| 1 | `recruiting.identifiedtalent.com`; keep `jobs.`, `hire.`, `apply.`; never touch `app.` | `12` §1, §7; `13` §5, appendix B/C. No code referenced `app.identifiedtalent.com`. |
| 2 | Email provider "expected Microsoft 365 via GoDaddy with Proofpoint; pending Paul's confirmation" | `12` §1. Nothing waits on it. |
| 3 | Google Calendar first, complete manual and ICS fallback, partner platform recorded at onboarding, Microsoft on demand | `12` §10; built as designed (steps 6 to 8: provider interface, declared availability, ICS, Google adapter). |
| 4 | Entra split: sign-in registration required for release 1, calendar registration deferred | `12` §10a and step 9a; `13` §4a; delegated sign-in built with the identity scopes only (step 4). |
| 5 | Cloud Identity: Nadine or Paul initial administrator; `platform@` never super admin | `12` §9; `13` §8. |
| 6 | No automatic candidate rejection | `application.hold_ineligible` policy, `ineligible_review` step, human decline sends the message; state machine; tests. |
| 7 | Privacy requests pilot-ready | `docs/runbooks/privacy-requests.md`, `privacy@` on candidate pages, release gates in `10`. |
| 8 | Retention periods are proposed pending counsel; no irreversible automatic deletion | `05` §6 (eleven categories), `09`, `11` item 9. |
| 9 | Service-role key not provisioned to the application | `13` appendix A; `tests/policy/service-role-guard.test.ts`. |
| 10 | Secret remediation before real OAuth | Slice 5 step 3: audited reads, deletion on disconnect, alerts, scrubbing of logs, errors, events, audit records, analytics, Sentry. |
| 11 | Queue preview minimization | Slice 5 step 1 with the automated test. |
| 12 | Editable business calendar | Slice 5 step 2. |
| 13 | Counsel register fields; pilot agreement, privacy notice, runbook are release-1 requirements | `11`. |
| 14 | PostHog off candidate pages; server-side funnel events | `packages/integrations/src/analytics`; apply page emits `application_started` server-side with a per-visit random reference. |
| 15 | Slice 5 in the stated order with mocks | Done, steps 1 to 10 (section K). |
| 16 | This report | Here and in the chat response. |

## 2. Disagreements and technical limitations

None of the corrections were disputed. Limitations that the founder should know:

- **Nothing has touched a real service.** Supabase Auth, Supabase Vault, Google Calendar, Postmark, PostHog and Sentry are implemented against their documented interfaces and exercised only with fakes or a fake `fetch`. Each adapter reports `not_connected` until configured, so the product never claims a live connection it does not have.
- **The Next.js shell mounts the existing React pages client-side** instead of porting them route by route. Vercel deployment works from `apps/shell`; the port continues page by page. The shell keeps one application container per process, so in development the API code needs a restart of `next dev` to reload (the React pages hot-reload).
- **Provider-side revocation happens in the worker**, a few seconds after a disconnect, because only the worker role may read a credential. The connection is unusable from the moment of disconnect and the customer can see when the credential is gone.
- **A new staff account gets no platform role from signing in.** The Microsoft-plus-second-factor rule protects the account; the role is granted by an administrator, as the roles document says.
- **The candidate's "none of these work" note is shown to the owner verbatim**, never parsed by a model.
- **Slot computation is deterministic and simple** (30-minute grid, spread-out starts, at most two per day, ten business days). Good enough for the pilot; tune with real usage.

## 3. Files changed (by area)

- Specification and register: `docs/spec/00` (sections J, K), `01`, `03`, `04`, `05`, `06`, `07`, `09`, `10`, `11`, `12`, `13`, `README`, this file; `docs/runbooks/privacy-requests.md`.
- Contracts: `packages/contracts/src/domain/{policy,events,common,interview}.ts`, `api/index.ts`, `security/redact.ts`.
- Core: `packages/core/src/{policy,stages,audit,events,escalations,escalation-preview,business-hours,business-calendar,secrets,alerts,connections,identity,ics,scheduling,calendar-connections,permissions,index}.ts`.
- Database: `packages/db/src/schema/{platform,hiring,tenancy}.ts`, `migrate.ts`, migrations `0005` to `0008`.
- Integrations: `analytics/*`, `secrets/revoke.ts`, `observability/sentry.ts`, `identity/{types,jwt,claims,supabase,fake}.ts`, `calendar/{types,fake-google,google}.ts`, `email/postmark.ts`, `types.ts`, `registry.ts`, `index.ts`.
- Agents and workflows: `packages/agents/src/{coordinator,screening,interview-messages,interview-calendar,index}.ts`; `packages/workflows/src/{engine,index}.ts`, `definitions/{application-intake,schedule-interview}.ts`.
- API: `apps/api/src/{app,container,env}.ts`, `middleware/errors.ts`, `routes/{admin,approvals-escalations-events,auth,companies,integrations,interviews,policies,roles}.ts`, `pages/{candidate,layout,schedule}.tsx`.
- Web: `apps/web/src/api/client.ts`, `app/App.tsx`, `pages/{Admin,Interviews,Login,People,RecruiterQueue,Setup,CompanySetup}.tsx`, `components/AskRecruiter.tsx`; `packages/ui/src/{index.tsx,tokens.css}`.
- Shell: `apps/shell/**` (new).
- Tests: `apps/api/src/{queue-preview,business-calendar,secret-lifecycle,identity,scheduling,app,staff-access}.test.ts`, `apps/shell/lib/hono.test.ts`, `packages/core/src/{core,secrets,scheduling}.test.ts`, `packages/integrations/src/integrations.test.ts`, `tests/policy/service-role-guard.test.ts`, `tests/e2e/**` (new), `vitest.config.ts`, `.env.example`, `package.json`.

## 4. Test results (18 September 2026, final run)

| Suite | Result |
|---|---|
| `pnpm typecheck` | 0 errors across every package including the shell and the browser tests |
| `pnpm test` (vitest) | 19 files, 163 passed, 6 todo (the scenario placeholders for steps 11 to 16), 0 failed |
| `pnpm eval` | 7 suites at threshold on the fake provider |
| `pnpm e2e` (Playwright + axe, Chromium) | 2 journeys passed; 13 pages with zero WCAG 2.1 A/AA violations |
| `next build` (shell) | succeeds; dev server serves the API, candidate pages and the fake sign-in |

## 5. Remaining TODOs

1. Scenario steps 11 to 16 in `tests/scenario/lifecycle.test.ts` stay `todo`; step 11's substance is covered by `apps/api/src/scheduling.test.ts`, steps 12 to 16 are later releases.
2. Real-account verification of every adapter once Nadine or Paul create the accounts (checklist `12`, worksheet `13`).
3. Port the React pages into Next routes one by one (the shell already serves them).
4. Microsoft Calendar adapter when a design partner requires it (decision 3).
5. Postmark bounce webhook; `data_requests` table and screen (the manual runbook is accepted for the pilot).
6. Counsel items in `11` remain open; the pilot agreement, privacy notice and runbook are release-1 requirements before real data.
7. Interview scorecards, debrief and offers are release 2 as planned.

## 6. Synthetic data and mocks

Slice 5 was built and tested entirely with synthetic data: an in-memory database, the fake AI provider, fake email and SMS adapters, a fake identity issuer, a fake Google Calendar, an in-memory secret store and fake analytics. No external account was created, no DNS record applied, no real OAuth connection made, no credential transmitted, and no real candidate data processed.
