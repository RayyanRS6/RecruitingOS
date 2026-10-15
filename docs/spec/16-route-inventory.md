# 16. Route inventory (release 1, Next.js shell)

Written 18 September 2026 with the port of the signed-in pages into their final Next.js routes (`apps/shell/app`). The Hono API and the candidate pages are mounted unchanged under catch-all route handlers. "Browser test" names the Playwright spec in `tests/e2e/specs`; every listed page is checked with axe (WCAG 2.1 A/AA + best practice) on a desktop and, where marked, on an iPhone 13 viewport with a no-sideways-scroll assertion.

Legend for states: L = loading (`(app)/loading.tsx` skeleton plus each page's own skeleton), E = empty (the page's `EmptyState`), X = error (`(app)/error.tsx` with retry plus each query's `ErrorState`), M = mobile (rail collapses to a top bar under 900px; tables scroll inside `.table-wrap`; sheets take the full width).

## Signed-in interface (`apps/shell/app`)

| Route | Page | Authentication | Permission | L | E | X | M | Accessibility | Browser test |
|---|---|---|---|---|---|---|---|---|---|
| `/login` | Sign in (provider buttons, optional email link) | public; a signed-in person is redirected home, to the queue, or to company setup | none | yes | n/a | shown inline by code | yes | axe | journey, routes |
| `/login/consume` | Email-link consumer | public | none | yes | n/a | inline | yes | axe (journey) | journey |
| `/setup/company` | Create the company | session | none (must have no company) | yes | n/a | inline | yes | axe | journey, routes |
| `/` | Today | session | active company (or recruiter grant) | yes | yes | yes | yes, phone | axe | journey, routes |
| `/roles` | Roles | session | active company; `role.read` in the API | yes | yes | yes | yes, phone | axe | routes |
| `/roles/[id]` | Role | session | active company; staff limited to the granted role | yes | n/a (404 from API → error state) | yes | yes, phone | axe | routes |
| `/roles/[id]/talent` | Talent for a role | session | active company; `application.read` | yes | yes | yes | yes, phone | axe | journey, routes |
| `/roles/[id]/people` | redirect → talent | session | — | — | — | — | — | — | routes |
| `/talent` | Talent (first open role) | session | active company | yes | yes | yes | yes, phone | axe | routes |
| `/people` | redirect → `/talent` | session | — | — | — | — | — | — | routes |
| `/interviews` | Interviews | session | active company; interviewers see only their own | yes | yes | yes | yes, phone | axe | journey, routes |
| `/interviews/[id]` | Interview sheet over the list | session | as above | yes | n/a | yes | yes | axe | journey |
| `/setup` | Setup (company, team, availability, services, policies) | session | active company; `company.read`; edits need `company.update` / `policy.manage` | yes | yes (no members) | yes | yes, phone | axe | journey, routes |
| `/recruiter/queue` | Recruiter queue | session | platform role its_recruiter or platform_admin (others → home) | yes | yes | yes | yes, phone | axe | routes, journey (staff) |
| `/recruiter/queue/[id]` | Queue item | session | as above; full context only under a grant | yes | n/a | yes | yes | axe | (API-tested; queue page axe) |
| `/admin` | Console Overview (Needs attention, Customers card, Costs this month, System line) | session | platform_admin (others → home or queue) | yes | yes | yes | yes, phone | axe | routes |
| `/admin/customers`, `/admin/privacy`, `/admin/problems`, `/admin/system` | Console sections, each with its part tabs (`?view=`) and drawers (`?open=`) | session | as above | yes | yes | yes | yes, phone | axe per part | routes, company-check, one-visit-owner |
| any other path | Not found | session | — | — | — | — | yes | axe | routes |

## Hono-served routes mounted by the shell

| Mount | Purpose | Authentication | Notes |
|---|---|---|---|
| `/api/[[...route]]` | the JSON API (`07`) | session cookie; per-route permissions | rate limits on public endpoints |
| `/careers/[[...route]]` | job pages and the application form | public | server-rendered, no JavaScript, axe-checked in the journey |
| `/c/[[...route]]` | candidate status, screening, scheduling, privacy | token links | server-rendered; keyboard-only path tested |
| `/webhooks/[[...route]]` | Postmark and Twilio | shared secret / signature | idempotent |
| `/feeds/[[...route]]` | job feeds | public | |
| `/privacy`, `/healthz` | privacy notice; health | public | |
| `/dev/[[...route]]` | development outboxes | never in production | |

## Rules every route follows

- Authentication is decided on the server in a layout (`(app)/layout.tsx`) by asking the mounted API for the session; nothing renders before the redirect.
- Permission groups: `(company)` requires an active company; `recruiter` requires ITS staff; `admin` requires a platform administrator. The API enforces the same rules again on every request.
- Loading: `loading.tsx` at the group level plus per-query skeletons (`role="status"`).
- Empty and error: every list has an `EmptyState`; every query an `ErrorState` with retry; unexpected throws reach `error.tsx`.
- Mobile: the 900px breakpoint in `packages/ui/src/tokens.css`; the phone project in Playwright asserts no horizontal overflow.
- Accessibility: axe on every page in `routes.spec.ts` and `journey.spec.ts`; landmarks, labelled controls, visible focus, `prefers-reduced-motion` respected.
