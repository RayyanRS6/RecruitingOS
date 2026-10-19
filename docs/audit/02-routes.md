<!-- Part of the Recruiting OS product audit (docs/product-audit.md), 14 October 2026. Written by one reader from the code at origin/main dafb730 and checked by a second, skeptical reader who tried to refute every bug and status; corrections are listed under the verification notes. Working files mentioned as 'scratchpad' are not in the repository. -->

# Routes, pages and navigation

Audit of branch `kanvis-reaudit` (= origin/main dafb730, 14 Oct 2026). Read-only. Source code is the truth; docs were used as leads only.

## 1. Summary

Recruiting OS is one Next.js deployment (`apps/shell`) that does two jobs. It draws the signed-in screens (17 page routes, all React components from `apps/web/src/pages`). It also hands 12 URL prefixes straight to the Hono server in `apps/api` through catch-all route handlers (`apps/shell/lib/hono.ts`): `/api`, `/c`, `/careers`, `/a`, `/files`, `/feeds`, `/webhooks`, `/dev`, `/privacy`, `/healthz`, `/sitemap.xml` and `/robots.txt`. The Hono app (`apps/api/src/app.ts:48-173`) registers about 250 JSON API endpoints under `/api/v1`, plus `/api/csp-report`. It also registers about 43 server-rendered candidate and public pages, 5 machine feeds, 5 webhooks, 2 file stand-in routes, a health check and 2 development outboxes.

Access is checked in two layers. Server layouts decide who may open a screen: `(app)/layout.tsx` requires a session, `(company)/layout.tsx` requires an active company, `recruiter/layout.tsx` requires ITS staff and `admin/layout.tsx` requires a platform admin. The API then checks every request again. It runs a same-site check (`middleware/same-site.ts`), loads the session from the `ros_session` cookie (`middleware/session.ts`), applies rate limits, requires a tenant (`requireTenant`) and checks the permission matrix (`assertCan`, `packages/core/src/permissions.ts`). Scope guards hold ITS staff to the role or candidate their grant names. Admin and recruiter routes also need a second factor (aal2). Candidate pages use unguessable link tokens, not accounts.

Almost every screen traces end to end, from UI to route to service to database. The main findings:

- **Missing screens for admin actions.** Several admin actions exist only as API endpoints with no console screen: putting a customer on the Design Partner plan, break-glass access, the staff-access ledger, signing a person out everywhere, and AI-run detail. A platform admin cannot use them without hand-made requests. The plan one matters most: every new company starts on the Trial plan (`apps/api/src/services/companies.ts:34`), which allows 1 active role, 25 screening conversations and 1 recruiter request (`packages/db/src/seed.ts:17-20`). A design partner therefore stays capped at one live role until someone hand-crafts `POST /api/v1/admin/customers/:id/plan` from a second-factor admin session.
- **Over-broad endpoint.** One endpoint, `GET /api/v1/roles/:id/interviews`, returns every interview on a role to anyone who can read roles. That includes interviewers and ITS recruiters whose access covers only one candidate. Nothing in the app calls it and no test covers it.
- **No way to switch companies.** A person who belongs to more than one company has no company switcher; `POST /auth/switch` is used only by the ITS queue. This case is reachable through ordinary use: accepting a second company's team invitation adds a second membership (`packages/core/src/invitations.ts:164-178`). After that, each sign-in opens whichever membership the database returns first, in no fixed order (`packages/core/src/identity.ts:75-76`).
- **Stale docs.** The route docs are out of date. `docs/spec/16` lists a `/login/consume` page that does not exist. It is missing `/roles/new`, `/updates`, `/a`, `/files`, the sitemap, robots and three admin tabs. `docs/spec/04` lists four routes that do not exist.

## 2. Feature inventory

Updated for Wave S1 (simple, Kanvis-like screens; branch `kanvis-simple`, 14 Oct 2026): the screens' names changed (Today is Home, Roles is Jobs, All roles is All jobs, Talent is Candidates, Setup is Settings), the job pages share one tab strip, and Settings has five tabs. The routes and their deep links did not change. The rows below name the screens as they are now.

| ID | Feature | Status | Who | Evidence |
|---|---|---|---|---|
| ROUTES-01 | Signed-in frame and server-side session gate (every app page asks the in-process API `/api/v1/auth/me` before drawing) | fully_implemented | owner, hiring manager, HR, interviewer, ITS recruiter, platform admin | `apps/shell/app/(app)/layout.tsx`; `apps/shell/lib/session.ts` getMe; `apps/api/src/routes/auth.ts:283` |
| ROUTES-02 | Main navigation rail: company chip with Settings cog, Start a hire (N shortcut), Home, Jobs with up to 8 jobs in progress (a live job opens on its Candidates) and All jobs, Candidates, Interviews, Settings, Queue (staff), Console (admin), Sign out; folds to icons on job pages; Menu button under 900px | fully_implemented | all signed-in people | `apps/shell/components/AppShell.tsx:25-202`; `apps/web/src/rail.ts`; `apps/web/src/nav.tsx`; `apps/web/src/start-hire.ts:11` |
| ROUTES-03 | Company-area guard: owner screens need an active company (a membership, or an ITS grant) | fully_implemented | company members, ITS recruiter under grant | `apps/shell/app/(app)/(company)/layout.tsx` |
| ROUTES-04 | Recruiter-area and admin-area guards (pages), with aal2 enforced by the API | fully_implemented | ITS recruiter, platform admin | `apps/shell/app/(app)/recruiter/layout.tsx`; `apps/shell/app/(app)/admin/layout.tsx`; `apps/api/src/middleware/session.ts:75-90` |
| ROUTES-05 | Sign-in page and Google/Microsoft PKCE sign-in, with error codes back on `/login?error=` | fully_implemented | everyone | `apps/shell/app/(public)/login/page.tsx`; `apps/web/src/pages/Login.tsx`; `apps/api/src/routes/auth.ts:32-86` |
| ROUTES-06 | Email sign-in link page and team invitation page (server-rendered, one button, nothing consumed on open) | fully_implemented (email link is off by default in production, so in production an invited person must sign in with a Google or Microsoft account at exactly the invited address, else `invite_email_mismatch`; `packages/core/src/invitations.ts:159`) | invited team members, owners | `apps/api/src/routes/auth.ts:141-274`; `apps/api/src/pages/signin-link.tsx`; `apps/api/src/pages/invite.tsx`; `apps/api/src/env.ts:136` |
| ROUTES-07 | Staff second-factor pages (enrol, verify, backup, skip, cancel) | fully_implemented | ITS recruiter, platform admin | `apps/api/src/routes/auth-mfa.tsx:104-260`; `apps/api/src/pages/mfa.tsx` |
| ROUTES-08 | Create-your-company page (session, no company yet) | fully_implemented | new owner | `apps/shell/app/(session)/setup/company/page.tsx`; `apps/web/src/pages/CompanySetup.tsx:34`; `apps/api/src/routes/companies.ts:18` |
| ROUTES-09 | Home (`/`): greeting and one line, getting-started card, "Needs you" rows (brief cards and the plan allowance row, five then "Show N more"), "Your jobs", "Who are you hiring?" box, recruiter requests, recent activity (folded) | fully_implemented | owner, hiring manager, HR, interviewer, ITS recruiter under grant | `apps/web/src/pages/Home.tsx`; `apps/api/src/routes/approvals-escalations-events.ts:721` GET /brief; `apps/api/src/services/brief.ts` |
| ROUTES-10 | Jobs list (`/roles`): one row per job (opens Candidates once live, with a Job details link), drafts, team drafts (folded), Hire for this job again | fully_implemented | all members (interviewer sees only their roles) | `apps/web/src/pages/Roles.tsx`; `apps/api/src/routes/roles.ts:40-89`; `apps/api/src/routes/intake.ts:207` |
| ROUTES-11 | Job builder page (`/roles/new`, `?session=`) | fully_implemented | owner, admin, hiring manager, recruiter | `apps/shell/app/(app)/(company)/roles/new/page.tsx`; `apps/web/src/pages/NewRole.tsx`; `apps/api/src/routes/intake.ts` |
| ROUTES-12 | Job page (`/roles/:id`): one header (status, facts line, Bring in a recruiter, More menu) and the job's tab strip shared with Candidates (Candidates, Job, Scoring, Interview plan, Share, Report, Activity); `?tab=` (old names overview, requirements, evaluation, posting and history still land on the tab that holds them), `?close=1`, `?closingMessage=1`, `?edit=` deep links | fully_implemented | owner, admin, hiring manager, HR, recruiter (interviewer gets a reduced view) | `apps/web/src/pages/RoleDetail.tsx:36-296`; `apps/api/src/routes/roles.ts:91-135` |
| ROUTES-13 | Candidates page (`/roles/:id/talent`, `/talent`): the job's header and tab strip, stage strip (stages with nobody in them under "More stages"), list, pool board (`?view=board`), Review and apply (`&review=1`), candidate panel (`?open=&tab=&step=`), compare | fully_implemented | owner, admin, hiring manager, HR, recruiter | `apps/web/src/pages/People.tsx:61-269`; `apps/api/src/routes/roles.ts:367,516,530,540,554`; `apps/api/src/routes/roles.ts:588` |
| ROUTES-14 | Interviews list and interview sheet (`/interviews`, `/interviews/:id`) | fully_implemented | all members (interviewer sees own) | `apps/web/src/pages/Interviews.tsx`; `apps/api/src/routes/interviews.ts:128-273` |
| ROUTES-15 | Settings (`/setup`): five tabs (`?tab=`), 13 cards: Company (company with plan and usage, how candidates see you), Team, Notifications (email alerts, availability, keyboard shortcut), Hiring rules (what the AI may do, when a candidate cancels, job boards), Security (your sessions, recruiter access, connected services, audit history); old `#setup-…` links open the card's tab | fully_implemented | all members (edits by permission) | `apps/web/src/pages/Setup.tsx`; `apps/web/src/setup-sections.ts` |
| ROUTES-16 | Updates page (`/updates`), reached from Home and Settings, not the rail | fully_implemented | all members | `apps/web/src/pages/Updates.tsx`; `apps/api/src/routes/notifications.ts:32-86` |
| ROUTES-17 | ITS recruiter queue (`/recruiter/queue`, `/recruiter/queue/:id`): preview, accept, release, resolve, posting tasks, open the customer's workspace | fully_implemented | ITS recruiter, platform admin | `apps/web/src/pages/RecruiterQueue.tsx`; `apps/api/src/routes/approvals-escalations-events.ts:378-690` |
| ROUTES-18 | Admin console (`/admin`): 10 tabs (Customers, Workflows, AI runs, Failures, Costs, Queue, Business calendar, Privacy requests, Administrators, Outcomes). Customers opens a per-company report sheet (`AdminCustomerReport.tsx`), the company check, job-board confirmation and the apply-flow switch | partial (the 10 tabs trace to working routes; several admin API actions have no console screen, see ROUTES-37/38 and section 9) | platform admin | `apps/web/src/pages/Admin.tsx:17-26`; `apps/api/src/routes/admin.ts` |
| ROUTES-19 | Old-address redirects: `/people` to `/talent`, `/roles/:id/people` to `/roles/:id/talent`, `/?start=1` to `/roles/new` | fully_implemented | bookmarks, old emails | `apps/shell/app/(app)/(company)/people/page.tsx`; `.../roles/[id]/people/page.tsx`; `apps/web/src/pages/Home.tsx:39-47` |
| ROUTES-20 | Not-found page, app error boundary with retry, loading skeleton | fully_implemented | all | `apps/shell/app/not-found.tsx`; `apps/shell/app/(app)/error.tsx`; `apps/shell/app/(app)/loading.tsx` |
| ROUTES-21 | Public careers page, job page (JSON-LD), apply form, direct upload intent, receipt page | fully_implemented (only for companies ITS has confirmed) | candidate, public, search engines | `apps/api/src/pages/candidate.tsx:126-516`; `apps/api/src/pages/job-page.tsx` |
| ROUTES-22 | One-visit and emailed screening conversation pages (`/c/screen/:token/*`) | fully_implemented | candidate | `apps/api/src/pages/candidate.tsx:1459-1621` |
| ROUTES-23 | Candidate status page and self-service (withdraw, privacy request, SMS preference, talent-pool choice), lost-link request, repeat-answers confirmation | fully_implemented | candidate | `apps/api/src/pages/candidate.tsx:558-575,713,1665-1808` |
| ROUTES-24 | Candidate interview scheduling pages (pick a time, none work, confirmed, .ics, reschedule, cancel, cancelled) | fully_implemented | candidate | `apps/api/src/pages/schedule.tsx:151-446` |
| ROUTES-25 | Privacy notice and public privacy-request form with email verification | fully_implemented | candidate, public | `apps/api/src/pages/candidate.tsx:832`; `apps/api/src/pages/privacy-request.tsx:73-192` |
| ROUTES-26 | Tracked application links (`/a/:token`) | fully_implemented | candidate arriving from a board or shared link | `apps/api/src/pages/links.tsx:56-83` |
| ROUTES-27 | Sitemap, robots, job feeds (XML, JSON, LinkedIn) | fully_implemented | search engines, job boards | `apps/api/src/pages/public-feeds.ts:119-160` |
| ROUTES-28 | Webhooks: Postmark inbound email and delivery events, Twilio inbound SMS | fully_implemented (fail closed in production without secrets) | machine (Postmark, Twilio) | `apps/api/src/webhooks/postmark.ts:29,260-286`; `apps/api/src/webhooks/twilio.ts:18-81` |
| ROUTES-29 | Local object-store stand-in (`/files/put/:token`, `/files/get/:token`) | fully_implemented (development/test only by design; 404 with real storage) | machine (browser upload), staff download in dev | `apps/api/src/routes/files.ts` |
| ROUTES-30 | Health check (`/healthz`, `?strict=1`) | fully_implemented | machine (uptime monitor) | `apps/api/src/app.ts:97-113` |
| ROUTES-31 | Content-security report intake (`/api/csp-report`) and admin review | fully_implemented | machine (browsers), platform admin | `apps/api/src/app.ts:88-94`; `apps/api/src/routes/admin.ts:531-533` |
| ROUTES-32 | Development outboxes and fake consent pages | fully_implemented (non-production only) | developers | `apps/api/src/app.ts:163-170`; `apps/api/src/routes/auth.ts:109-139`; `apps/api/src/routes/integrations.ts:117-145` |
| ROUTES-33 | Authenticated job-page preview pages (role version, draft) | fully_implemented | owner, admin, hiring manager, HR, recruiter (not interviewer) | `apps/api/src/pages/preview.tsx:107-166`; `apps/web/src/publishing.ts:19-29` |
| ROUTES-34 | Cross-cutting API protection: same-site refusal, session/tenant, scope guards, rate limits, CSP nonce on server pages, admin read audit | fully_implemented | all | `apps/api/src/app.ts:50-86`; `apps/api/src/middleware/*.ts`; `apps/api/src/routes/admin.ts:24-29` |
| ROUTES-35 | Switching between companies for a person in more than one company | partial (API `POST /auth/switch` exists; only the ITS queue calls it; no switcher in the rail. A second membership comes from an ordinary invitation, and sign-in then opens an arbitrary one) | owner, hiring manager, HR or interviewer invited by two companies | `apps/api/src/routes/auth.ts:304-315`; `apps/web/src/pages/RecruiterQueue.tsx:193`; `apps/shell/components/AppShell.tsx:31` (reads only the active membership); `packages/core/src/invitations.ts:164-178`; `packages/core/src/identity.ts:75-76` |
| ROUTES-36 | Sign one team member out everywhere (customer side) | partial (API only; no Setup button) | owner, admin, HR | `apps/api/src/routes/company-settings.ts:498`; no caller in `apps/web/src` |
| ROUTES-37 | Put a customer on a plan (Design Partner) from the console | partial (API only; and every new company starts on Trial = 1 active role, 25 screening conversations, 1 recruiter request, so this is the only way past those limits) | platform admin; owner of every new customer | `apps/api/src/routes/admin.ts:390-410`; `apps/web/src/pages/Admin.tsx:97` shows plan read-only; `apps/api/src/services/companies.ts:34`; `packages/db/src/seed.ts:17-20` |
| ROUTES-38 | Break-glass emergency access to a customer | partial (API only; code comment stale. Using the grant also needs `POST /auth/switch`, which the console never calls) | platform admin | `apps/api/src/routes/admin.ts:356-374`; `apps/api/src/routes/auth.ts:304-315` |
| ROUTES-39 | Microsoft calendar connection (and the separate `/setup/calendar/*`, `/setup/availability` pages named in docs). Google calendar connection and "Your availability" do exist, as Setup cards | planned_not_implemented (Microsoft only; the Google connect and the availability card work) | interviewers, owners | `packages/integrations/src/registry.ts:82-85` (Google only); `apps/web/src/pages/Setup.tsx:286-341` |
| ROUTES-40 | Packet version diff view (doc 04: "packet versions with diff", `/roles/:id/packets/:version` sheet) | partial (API `GET /roles/:id/packets/diff` exists, nothing calls it; History tab lists versions only; the editor is a sheet with no address. What does exist: a field-by-field diff of an AI-proposed change ("change by asking", `new-role/ProposalCard.tsx:41`) and a toggle between the current and proposed version on the approval card (`RolePlan.tsx:196-199`)) | owner, hiring manager | `apps/api/src/routes/role-packets.ts:340-352`; `apps/web/src/pages/RoleDetail.tsx:280-287` |
| ROUTES-41 | Interviews of one role (`GET /api/v1/roles/:id/interviews`) | partial (API only, and over-broad: see bug 1) | none in the UI | `apps/api/src/routes/interviews.ts:435-450` |
| ROUTES-42 | Compatibility aliases kept for old clients (`/companies/current/invites`, `/intake/sessions/:id/compile`, `/c/screen/:token/human`, `/companies/current/about/approve`, `DELETE /companies/current/about`, `PUT /companies/current/logo`, `/c/screen/:token/review` redirect) | fully_implemented | old links, tests | `apps/api/src/routes/companies.ts:83`; `intake.ts:364`; `pages/candidate.tsx:1549,1573`; `company-settings.ts:303-354` |

## 3. Workflows traced step by step

### W1. Owner signs in and lands on Today
1. The browser opens `/login`. `apps/shell/app/(public)/login/page.tsx` calls getMe. With no session it draws `Login` (`apps/web/src/pages/Login.tsx`), which asks `GET /api/v1/auth/config` for the provider buttons.
2. A click goes to `GET /api/v1/auth/start/:provider` (`routes/auth.ts:42`). This sets the `ros_pkce` cookie (verifier, state, provider) and redirects to Supabase (Google or Microsoft).
3. The provider returns to `GET /api/v1/auth/callback` (`auth.ts:55`). The route checks the PKCE cookie and state, exchanges the code and verifies the token. If the person is ITS staff without a second factor, it seals an `ros_mfa` cookie and redirects to `/api/v1/auth/mfa` (W8). Otherwise `openSession` (`routes/auth-shared.ts:35`) writes the session row (`openSessionFromIdentity`, packages/core), honours any `ros_invite` cookie and sets `ros_session`. It then redirects to `/` if the person has a company, or to `/setup/company` if not.
4. `/` hits `(app)/layout.tsx` (session required), then `(company)/layout.tsx` (an active company is required; staff without one go to `/recruiter/queue`, others to `/setup/company`). `AppShell` draws the rail. `Home` asks `GET /api/v1/brief` (`approvals-escalations-events.ts:721`, `role.read`). `composeBrief` (`services/brief.ts`) reads roles, applications, approvals, escalations and notifications under `withTenant`.

### W2. Owner starts a hire
1. The rail "Start a hire", the N key (`AppShell.tsx:79-89`), Today or Roles go to `/roles/new` (`START_HIRE_HREF`).
2. `NewRole` checks `canStartHire` (`apps/web/src/roles.ts:25`). `StartView` reads `GET /api/v1/intake/sessions?mine=1` and `GET /api/v1/companies/current`.
3. The first message calls `POST /api/v1/intake/sessions` (`intake.ts:166`, `assertMayDraft` = role.create + compensation.read; the plan's room is checked). The page moves to `/roles/new?session=<id>`.
4. `Builder` posts turns: `/messages`, `/answers`, `/draft`, `/flags/keep`, `/request-approval`, `/take-over` and `/abandon` (`intake.ts:243-400`). Refinements use `/intake/sessions/:id/revisions*` and `/requirements-check*` (`role-packets.ts:517-600`). The preview opens `/api/v1/intake/sessions/:id/preview/page` (`pages/preview.tsx:138`).
5. Asking for approval compiles the draft into a role in `pending_approval`. The approver then works on `/roles/:id` (W3).

### W3. Approving and publishing a role
1. `/roles/:id` loads `RoleDetail`, which reads `GET /api/v1/roles/:id` (`roles.ts:91`, `role.read`; pay removed without `compensation.read`).
2. Approve runs `POST /api/v1/roles/:id/approve` (`roles.ts:177`, `role.approve` + `assertMayApprovePacket`) or `POST /api/v1/approvals/:id/decide` (`approvals-escalations-events.ts:36`). This signals the `role_approval` workflow, which opens the role and starts `publish_role`.
3. The page polls until the worker catches up (`RolePlan.waitingOnWorker`). `AfterApproval` reads `GET /roles/:id/postings`. The Posting tab drives `/roles/:id/postings/:channel/*`, `/channels`, `/links`, `/share-links`, `/applications/accepting` and `/closing-date` (`routes/postings.ts`, `roles.ts:241`).
4. Pause and resume call `POST /roles/:id/pause|resume` (`roles.ts:207-232`, `role.manage`). Close calls `POST /roles/:id/outcome` (`roles.ts:914`, `outcome.record`), followed by the closing message (`roles.ts:485-505`).

### W4. Reviewing applicants (Talent, board, panel)
1. `/roles/:id/talent` (or `/talent`, which picks the first open role) loads `People`. It reads `GET /api/v1/roles`, `GET /auth/me` and `GET /roles/:id/applications?counts=1` (`roles.ts:367`, `application.read`, rows limited to the grant's candidate for staff).
2. A stage button on a row posts `POST /api/v1/applications/:id/actions` (`roles.ts:761`). Each action checks its own permission in `services/application-actions.ts:514-660`.
3. A row click sets `?open=<id>&tab=`. `CandidatePanel` reads `GET /applications/:id` (`roles.ts:588`; interviewers get the reduced `interviewerApplicationView`). Its tabs call notes (`routes/notes.ts`), messages (`routes/messages.ts`), interviews (`interviews.ts:276-430`), new times (`routes/new-times.ts`), offer and outcome (`roles.ts:846-912`) and the assessment flag (`roles.ts:796`).
4. "Sort the pool" sets `?view=board` and reads `GET /roles/:id/board` (`roles.ts:516`, `services/pool.ts` loadPool). "Review and apply" (`&review=1`) posts `POST /roles/:id/batch` with `dryRun` and then for real (`roles.ts:530`; permission in `services/review-apply.ts:94,137`). The one-click questions use `GET /roles/:id/questions[/:kind]`.

### W5. Candidate applies (form or one visit)
1. `/careers/:slug` → `candidate.tsx:167`; `loadPublicCompany` returns nothing until ITS has confirmed the company (`candidate.tsx:126-129`), so an unconfirmed company's pages are 404.
2. `/careers/:slug/jobs/:roleId` (job page with JSON-LD) → `/apply` GET (form, `acceptingApplications` or 404; analytics `application_started` with no identity).
3. With JavaScript, `POST .../upload-intent` (rate-limited) returns a signed grant. The browser PUTs the file to object storage, or locally to `/files/put/:token` (`routes/files.ts:19`).
4. `POST .../apply` (rate-limited) → `createApplication` (`services/applications.ts`) + `startApplyConversation` (`services/apply-conversation.ts`) in one tenant transaction.
5. A one-visit role redirects to `/c/screen/:token`, where the candidate sees the intro, the questions, review and submit (`candidate.tsx:1459-1621`). Other roles redirect to `/careers/:slug/jobs/:roleId/applied`, a sealed-cookie receipt that never names a status link. The status link is sent by email: `/c/status/:token`.

### W6. Tracked link from a board
`/a/:token` (`pages/links.tsx:56`) looks up the link, counts the visit (bots are not counted), seals the source into a cookie and redirects to the job page or the apply form. The apply POST reads the cookie (`resolveApplicationSource`) and clears it.

### W7. ITS recruiter works a request
1. `/recruiter/queue` (`recruiter/layout.tsx` requires platform role `its_recruiter` or `platform_admin`) → `GET /api/v1/escalations` (`requireRecruiterOrAdmin`, aal2). The recruiter sees a preview only.
2. `/recruiter/queue/:id` → `GET /escalations/:id`; Accept → `POST /escalations/:id/claim`, which creates a scoped, time-limited `staff_access_grants` row.
3. "Open in workspace" → `POST /api/v1/auth/switch` (`auth.ts:304`, an active grant is required) → `/`. The rail now shows the customer's screens with the banner "You are inside X through an escalation" (`AppShell.tsx:196`). Every `/api/*` request is recorded as `staff.tenant_accessed` (`middleware/session.ts:53-55`). Scope guards (`roleScopeGuard`, `applicationScopeGuard`, `interviewScopeGuard`) refuse other roles and candidates.
4. Resolve or release → `POST /escalations/:id/resolve|release`.

### W8. Staff second factor
`/api/v1/auth/mfa` GET reads the sealed `ros_mfa` cookie and enrols or challenges through Supabase (`auth-mfa.tsx:104`). The POST (rate-limited, own-site check) verifies the code and opens an aal2 session. `/backup`, `/skip` and `/cancel` handle the backup authenticator. Staff routes refuse any session below aal2 (`middleware/session.ts:80,88`).

### W9. Platform admin console
`/admin` (`admin/layout.tsx`, `isAdmin`) → `Admin.tsx` tabs → `/api/v1/admin/*`. Every request passes `requirePlatformAdmin` (aal2) and writes an `admin.bypass` audit row with the `x-admin-reason` header (`routes/admin.ts:24-29`). Privacy requests live under `/api/v1/admin/data-requests` (`routes/privacy-requests.ts`).

### W10. Inbound email and SMS
Postmark posts to `/webhooks/postmark/inbound` (basic-auth secret; 503 in production when unset). The handler records `inbound_emails`. A reply token routes the message to `receiveCandidateReply`. An intake token matches an `email_in` posting, which creates an application, or holds it while the role is paused. Delivery events go to `/bounces|/spam|/events`, are claimed once in `claimWebhookReceipt` and then passed to `handleEmailEvent` or `handleSubscriptionChange`. Twilio posts to `/webhooks/twilio/inbound` (signature check). STOP and START are recorded; any other message drives `runScreenTurn` on the newest open screen.

## 4. Routes and screens (full inventory)

### 4.1 Signed-in pages (`apps/shell/app`, Next.js App Router)

| Path | Kind | Audience | Renders | Guard |
|---|---|---|---|---|
| `/login` | page | public | `Login`: provider buttons, email link where enabled, error messages | none; a signed-in person without `?error` is redirected to `/`, `/recruiter/queue` or `/setup/company` (`(public)/login/page.tsx`) |
| `/setup/company` | page | signed-in person with no company | `CompanySetup`: name, vertical, size, time zone, locations; Sign out | session required; anyone with a company → `/` (`(session)/setup/company/page.tsx`); no rail |
| `/` | page | members, ITS recruiter under grant | `Home` | `(app)` session + `(company)` active company |
| `/roles` | page | members | `Roles` | same |
| `/roles/new` | page | owner, admin, hiring manager, recruiter | `NewRole` → `StartView` or `Builder` | same; page shows "not part of your role" without role.create |
| `/roles/[id]` | page | members (interviewer reduced) | `RoleDetail` (the job page) with the job's tab strip | same; API role.read; staff limited to the granted role |
| `/roles/[id]/talent` | page | owner, admin, HM, HR, recruiter | `People` (list, board, candidate panel, compare) | same; API application.read |
| `/roles/[id]/people` | redirect | old links | → `/roles/[id]/talent` | same |
| `/talent` | page | as above | `People` on the first open role | same |
| `/people` | redirect | old links | → `/talent` | same |
| `/interviews` | page | members | `Interviews` (Coming up, Past) | same; API role.read, interviewer sees own |
| `/interviews/[id]` | page | members | `Interviews` + interview sheet | same; API participant check for interviewers |
| `/setup` | page | members | `Setup` (Settings: five tabs, 13 cards) | same |
| `/updates` | page | members | `Updates` (all notifications, read and unread) | same |
| `/recruiter/queue` | page | ITS recruiter, platform admin | `RecruiterQueue` | `(app)` session + `recruiter/layout.tsx` isStaff; non-staff → `/` or `/setup/company` |
| `/recruiter/queue/[id]` | page | same | `RecruiterQueue` + request detail | same |
| `/admin` | page | platform admin | `Admin` (10 tabs) | `(app)` session + `admin/layout.tsx` isAdmin; others → `/` or `/recruiter/queue`; API needs aal2 |
| any other | page | all | `not-found.tsx` ("That page does not exist", Go to Home) | none |

### 4.2 Mount points (Next.js route handlers passing the request to Hono)

| Mount | Methods | maxDuration | Passes to |
|---|---|---|---|
| `/api/[[...route]]` | GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD | 300 s | JSON API, server-rendered auth and preview pages, `/api/csp-report` |
| `/c/[[...route]]` | all | 300 s | candidate token pages |
| `/careers/[[...route]]` | all | 60 s | careers, job and apply pages |
| `/a/[[...route]]` | all | 60 s | tracked links |
| `/files/[[...route]]` | all | 60 s | local storage stand-in |
| `/feeds/[[...route]]` | all | 60 s | job feeds |
| `/webhooks/[[...route]]` | all | 60 s | Postmark, Twilio |
| `/dev/[[...route]]` | all | 60 s | development outboxes |
| `/privacy` | all | 60 s | privacy notice |
| `/healthz` | all | 60 s | health check |
| `/sitemap.xml` | all | 60 s | sitemap |
| `/robots.txt` | all | 60 s | robots |

The shell middleware (`apps/shell/middleware.ts:24-26`) adds the app's content-security policy and nonce to every path except these mounts and `/fonts/`. The `next.config.ts:15` headers add `X-Frame-Options: DENY` and a referrer policy to app pages only.

### 4.3 JSON API (`apps/api/src/routes/**`, mounted in `apps/api/src/app.ts:115-150`)

Applies to every route below: a change under `/api` is refused if the browser says it came from another site (`sameSiteChanges`, `app.ts:59`). The session is read from `ros_session`. Rate limits apply per user, tenant and address (`apiRateLimit`, `app.ts:62`). "tenant" means `requireTenant` (signed in with an active company or an ITS grant). A permission name means `assertCan` against `packages/core/src/permissions.ts`. "Scope" means a staff-grant scope guard. "UI" names the screen that calls the route; "API only" means nothing in `apps/web/src` calls it.

#### Auth `/api/v1/auth`
| Method + path | Audience | Guard | Purpose / caller |
|---|---|---|---|
| GET /config | public | none | which sign-in buttons to show (Login) |
| GET /start/:provider | public | provider must be offered | start the PKCE sign-in (Login, invitation page) |
| GET /callback | public (identity service return) | PKCE cookie + state | open the session, route staff to the second factor, or finish "Confirm it's you" |
| POST /session | machine, tests | rate limit, verified token | JSON sign-in (API only) |
| GET, POST /fake/authorize | developers | 404 in production or with the real identity service | fake consent page |
| POST /magic-link | public | rate limit; 410 when email links are off (default in production); staff refused | email me a sign-in link (Login) |
| GET /consume | public | none (draws a one-button page) | email-link landing page (server-rendered) |
| POST /consume | public | single-use token | open the session, honour the invitation cookie |
| POST /magic-link/consume | machine, tests | token | JSON variant (API only) |
| GET /invite | invited team member | token lookup; sets sealed invite cookie | invitation page (server-rendered) |
| POST /invite/email | invited team member | rate limit; email links on | send a link to the invited address |
| POST /invite/forget | public | none | drop a carried invitation (Login) |
| POST /logout | signed-in | none | Sign out (rail, CompanySetup) |
| GET /me | signed-in | session | who am I (shell getMe, many pages) |
| POST /switch | signed-in | active membership, or active staff grant | choose the active company (RecruiterQueue only) |
| GET /mfa, POST /mfa, GET /mfa/backup, POST /mfa/skip, POST /mfa/cancel | ITS staff mid sign-in | sealed `ros_mfa` cookie; POST rate-limited + own-site check | second-factor pages (server-rendered) |
| GET /sessions; POST /sessions/revoke-all; POST /sessions/:id/revoke | signed-in | requireUser | Setup "Your sessions" |
| POST /reauth/start | signed-in | requireUser | "Confirm it's you" (Setup) |

#### Companies and settings `/api/v1/companies`
| Method + path | Audience | Guard | Purpose / caller |
|---|---|---|---|
| POST / | signed-in, no company | requireUser | create the company (CompanySetup) |
| GET /current | members | tenant, company.read | company, plan, usage, integrations (Setup, Today, StartView) |
| PATCH /current | owner, admin | company.update; recent sign-in for notices and new-times setting | Setup company, job boards, notices, cancel setting |
| GET /current/members | members | company.read | TeamCard, Builder, interview approval |
| GET /current/invitations | members | company.read | TeamCard |
| POST /current/members/invite (alias POST /current/invites) | owner, admin, HR | members.manage | invite (TeamCard; alias API only) |
| POST /current/invitations/:id/resend; POST /current/invitations/:id/revoke | owner, admin, HR | members.manage | TeamCard |
| PATCH /current/members/:userId | owner, admin, HR | members.manage (+ recent sign-in to make an admin or owner) | change role, remove (TeamCard) |
| POST /current/members/:userId/sign-out | owner, admin, HR | members.manage | sign one member out (API only) |
| GET /current/staff-access | members | company.read | Setup "Recruiter access" |
| POST /current/staff-access/:grantId/revoke | owner, admin | staff_access.revoke | end a recruiter's access (Setup) |
| GET /current/new-times | members | company.read | the cancel setting (Talent, Interviews, panel, Setup) |
| GET /current/notices | members | company.read | Setup notices |
| GET /current/public-profile | members | company.read | Setup "How candidates see you" |
| POST /current/about/draft | owner, admin (not staff) | company.update | AI drafts the "about" text (Setup) |
| POST /current/about (aliases POST /current/about/approve, DELETE /current/about) | owner, admin (not staff) | company.update | approve or remove the "about" text (Setup; aliases API only) |
| POST /current/logo (alias PUT), DELETE /current/logo | owner, admin (not staff) | company.update | logo upload or removal (Setup) |
| GET /current/logo | members | company.read | logo preview (Setup) |
| PUT /current/hiring-contact | owner, admin (not staff) | company.update | contact before applying (Setup) |
| POST /current/getting-started | members (not staff) | company.read; policy.manage for "policies_reviewed" | Today getting-started card buttons |
| GET /current/audit; GET /current/audit.csv | owner, admin, HM, HR, recruiter | events.read | Setup "Audit history" |

#### Intake (job builder) `/api/v1/intake`
| Method + path | Audience | Guard | Purpose / caller |
|---|---|---|---|
| POST /sessions | owner, admin, HM, recruiter | role.create + compensation.read; plan room | start a draft (StartView, Hire again) |
| GET /sessions (`?mine=1`) | same | same; owners and admins see every draft | Roles, StartView |
| GET /room | same | same | plan room (API only; room also comes with /sessions) |
| GET /sessions/current | same | same | resume the caller's draft (API only; e2e uses it) |
| GET /sessions/:id | same | draft owner, owner/admin, or the ITS grant's draft | Builder |
| POST /sessions/:id/messages, /answers, /draft, /flags/keep, /request-approval, /take-over, /abandon | same | same | Builder (AI turns on messages, answers, draft) |
| POST /sessions/:id/compile | same | same | alias of request-approval (API only) |
| POST /conversation/messages | members | role.read; drafters continue or start a draft | old Today conversation wrapper (API only) |
| POST /sessions/:id/revisions; /revisions/:revisionId/apply; /revisions/:revisionId/discard | drafters | packet rules + compensation.read | "change it by asking" on a draft (Builder via refine-api) |
| GET /sessions/:id/requirements-check; POST /sessions/:id/requirements-check/apply | drafters | same | requirements check (Builder) |
| GET /sessions/:id/preview (data or page); GET /sessions/:id/preview/page | drafters | compensation.read + draft access | candidate view of the draft (CandidatePreview) |

#### Roles `/api/v1/roles`
| Method + path | Audience | Guard | Purpose / caller |
|---|---|---|---|
| GET / | members | role.read; interviewer gets only their roles, no counts; staff only the grant's role | Roles, rail, Talent |
| GET /:id | members | role.read + roleScopeGuard; pay removed without compensation.read | Role page |
| GET /:id/packets | members | role.read; pay removed | API only |
| POST /:id/packets | owner, admin, HM, recruiter | packet.edit | save an edited version (RoleEditor) |
| PATCH /:id/packet | same | packet.edit (+ compensation.read for pay) | plain-field edit (API only) |
| POST /:id/approve | owner, admin, HM | role.approve + decision-maker and self-approval rules | Approve (RolePlan) |
| POST /:id/pause; POST /:id/resume | owner, admin, recruiter | role.manage | Role page header |
| POST /:id/closing-date | owner, admin, recruiter | role.manage | ClosingDate, Builder, Today card |
| GET /:id/apply-mode; PUT /:id/apply-mode | ITS recruiter (grant covering the role), platform admin | requireRecruiterOrAdmin (aal2) + grant scope | how applicants meet the conversation (Posting tab, ITS only) |
| GET /:id/applications | owner, admin, HM, HR, recruiter | application.read; staff limited to the grant's candidate | Talent list, ClosingMessage |
| POST /:id/decision-messages | owner, admin, HM, recruiter | application.reject | tell several people (Talent) |
| GET /:id/closing-message; POST /:id/closing-message | same | application.reject; refused for a one-candidate grant | closing message (ClosingMessageCard) |
| GET /:id/board | readers of applications | application.read | pool board |
| POST /:id/batch | readers of applications | application.read (dry run) / application.act (apply), in services/review-apply.ts | Review and apply |
| GET /:id/questions; GET /:id/questions/:kind | same | application.read | Ask about this pool |
| POST /:id/outcome | owner, admin, HM, HR | outcome.record | close the role with its outcome (CloseRoleCard) |
| GET /:id/postings; GET /:id/postings/:channel/package | members | role.read | Posting tab (package: API only for owners; ITS sees it in the queue) |
| POST /:id/postings/:channel/url, /verify, /pause, /resume, /close, /closure-confirm, /updated, /prepare, /ask-its, /retry | owner, admin, recruiter | role.manage | Posting tab |
| POST /:id/channels | same | role.manage | board ticks (BoardTicks) |
| GET /:id/links; POST /:id/links; POST /:id/links/:linkId/disable | read: members; change: role.manage | role.read / role.manage | tracked links (Posting tab) |
| POST /:id/share-links | owner, admin, HM, recruiter | role.approve or role.manage | Share the job (ShareJob) |
| GET /:id/volume | members | role.read | volume (Posting tab) |
| POST /:id/applications/accepting | owner, admin, recruiter | role.manage | accepting switch |
| GET /:id/preview (data or page); GET /:id/preview/page | not interviewer | role.read + compensation.read + staff scope | candidate view of a version (RoleDetail, RoleEditor) |
| GET /:id/interview-plan; PATCH /:id/interview-plan | read: members; edit: packet.edit | role.read / packet.edit | Interview plan tab |
| POST /:id/request-approval | packet editors | packet.edit | ask again (RolePlan) |
| GET /:id/timeline | not interviewer | events.read | Activity tab |
| POST /:id/revisions; /revisions/:revisionId/apply; /revisions/:revisionId/discard | packet editors | packet.edit + compensation.read | "change it by asking" on a role (RoleRefine) |
| GET /:id/packets/diff | members | role.read; pay only with compensation.read | version diff (API only) |
| GET /:id/requirements-check; POST /:id/requirements-check/apply | read: members; apply: packet.edit | role.read / packet.edit | requirements check (RoleRefine) |
| POST /:id/packets/:version/flags/keep | packet editors | packet.edit | keep a flagged phrase (RolePlan) |
| GET /:id/report; GET /:id/report.csv; GET /:id/report/summary.csv | not interviewer | role.read + application.read; CSV audited | Report tab |
| GET /:id/compare | not interviewer | application.read | ComparePanel |
| GET /:id/interviews | members | role.read only (see bug 1) | API only |
| POST /:id/new-times | owner, admin, HM, recruiter | interview.manage | send new times to several people (Talent) |
| GET /:id/screening | not interviewer | application.read | screening funnel (Report tab) |

#### Applications `/api/v1/applications`
| Method + path | Audience | Guard | Purpose / caller |
|---|---|---|---|
| GET /:id | readers; interviewer only for people they interview | application.read or interviewer view + applicationScopeGuard | CandidatePanel |
| GET /:id/decision-message; POST /:id/decision-message/preview | owner, admin, HM, recruiter | application.reject | telling (panel, Talent) |
| GET /:id/documents/:documentId/file; /inline | readers | application.read | résumé open and frame |
| POST /:id/actions | by action | per-action permission (services/application-actions.ts:514) | stage button, panel |
| POST /:id/assessments/:assessmentId/flag | owner, admin, HM, HR, recruiter | application.act | "Something wrong?" |
| GET /:id/outcomes; POST /:id/outcome | read: readers; record: outcome.record (+ application.reject for employer_declined) | as stated | hiring section |
| POST /:id/offer | owner, admin, HM, HR | outcome.record | Offer made |
| GET /:id/messages/preview; POST /:id/messages; POST /:id/messages/suggest; POST /:id/messages/:communicationId/undo | owner, admin, HM, HR, recruiter | application.act (+ application.reject to undo a decision message) | Messages tab, Undo |
| GET /:id/notes; PUT /:id/notes/mine; DELETE /:id/notes/mine | members | tenant; note.read/note.write in services/notes.ts; interviewer only own note | Notes tab, interview sheet |
| POST /:id/interviews | owner, admin, HM, recruiter | interview.request | interview approval |
| GET /:id/interview-draft | same | interview.request | prefilled approval |
| POST /:id/decision | same | interview.decide (+ application.reject or outcome.record by choice) | decision after interview |
| POST /:id/new-times; POST /:id/new-times/stop | same | interview.manage | Cancelled column |
| POST /:id/screen/recruiter-notes | recruiter (company's own or ITS under grant) | escalation.work | call notes |

#### Interviews and me
| Method + path | Audience | Guard | Purpose / caller |
|---|---|---|---|
| GET /api/v1/interviews | members | role.read; interviewer and staff filtered | Interviews |
| GET /api/v1/interviews/:id | members | role.read; interviewer must be a participant; interviewScopeGuard | interview sheet |
| POST /api/v1/interviews/:id/reschedule; /cancel; /book-on-behalf | owner, admin, HM, recruiter | interview.manage | interview sheet |
| POST /api/v1/interviews/:id/outcome | managers or participants | interview.manage or participant | "did it take place" |
| GET /api/v1/me/calendar; PUT /api/v1/me/availability | members | tenant | Setup "Your availability" |

#### Approvals, escalations, events, brief
| Method + path | Audience | Guard | Purpose / caller |
|---|---|---|---|
| GET /api/v1/approvals | readers | application.read; staff filtered by scope | API only (the brief carries them) |
| POST /api/v1/approvals/:id/decide | depends on request | role.approve for packets; otherwise the request's required roles; no staff-scope check (see bug 5) | Today cards, RolePlan, panel |
| POST /api/v1/escalations; GET /estimate; GET /mine; POST /mine/:id/messages; POST /mine/:id/reopen | not interviewer | escalation.create | Bring in a recruiter, recruiter requests on Today |
| GET /api/v1/escalations; GET /:id; POST /:id/claim, /resolve, /messages, /release; POST /:id/posting/url, /verify, /updated, /removed | ITS recruiter, platform admin | requireRecruiterOrAdmin (aal2) | RecruiterQueue |
| GET /api/v1/events | not interviewer | events.read | panel history |
| GET /api/v1/brief | members | role.read | Today |

#### Notifications, policies, integrations
| Method + path | Audience | Guard | Purpose / caller |
|---|---|---|---|
| GET /api/v1/notifications; GET /history; POST /read; POST /unread; POST /read-all; GET /preferences; PUT /preferences | members (own) | tenant | Today, Updates, Setup email alerts (read-all: API only) |
| GET /api/v1/policies; PUT /api/v1/policies | read: members; change: owner, admin | company.read / policy.manage + recent sign-in | Setup "What the AI may do" |
| GET /api/v1/integrations; POST /api/v1/integrations/:id/disconnect | read: members; disconnect: owner, admin | company.read / integration.manage | API only (Setup reads integrations from /companies/current) |
| GET /api/v1/integrations/calendar/:provider/connect | members | tenant | start Google consent (Setup) |
| GET /api/v1/integrations/calendar/:provider/callback | the same browser | sealed cookie, state, and session must match | finish consent → `/setup?calendar=` |
| POST /api/v1/integrations/calendar/:provider/disconnect | members (own) | tenant | Setup |
| GET, POST /api/v1/integrations/calendar/fake/authorize | developers | 404 in production | fake consent |

#### Platform admin `/api/v1/admin` (all: requirePlatformAdmin = platform_admin + aal2; every request audited as `admin.bypass`)
| Method + path | Console caller |
|---|---|
| GET /customers; POST /customers/:id/verification; POST /customers/:id/job-boards; POST /customers/:id/apply-flow; GET /customers/:id/report | Customers tab |
| POST /customers/:id/plan | none (API only) |
| GET /runs; GET /runs/:id; POST /runs/:id/retry | Workflows tab |
| GET /ai-runs | AI runs tab |
| GET /ai-runs/:id | none (API only) |
| GET /failures; GET /alerts; POST /alerts/:id/acknowledge; POST /integrations/:id/retry-deletion; GET /email-suppressions; POST /email-suppressions/:id/release; GET /csp-reports; POST /csp-reports/:id/review | Failures tab |
| POST /email-suppressions `{address, reason}` (reason required since 20 Oct 2026) | Problems › Email, "Stop emails to an address" |
| GET /costs | Costs tab |
| GET /queue | Queue tab |
| GET /calendar; POST /calendar; POST /calendar/recalculate | Business calendar tab |
| GET /escalations | none (API only) |
| POST /break-glass | none (API only) |
| GET /staff-access | none (API only) |
| GET /platform-roles; POST /platform-roles; POST /platform-roles/:grantId/revoke | Administrators tab |
| POST /users/:userId/sessions/revoke | none (API only) |
| POST /sessions/revoke `{email, reason, confirm}` | Administrators, "Sign someone out everywhere" (20 Oct 2026) |
| GET /outcomes; POST /outcomes/:id/correct | Outcomes tab |
| GET /data-requests; POST /data-requests; GET /data-requests/:id; POST /data-requests/:id/assign, /notes, /verify, /escalate, /counsel, /fulfil, /decline; GET /data-requests/:id/export | Privacy requests tab |
| POST /data-requests/deadlines/check; GET /data-requests/lookup/candidate | none (API only) |
| POST /observability/test-error | none (API only; development and staging only, 404 in other production) |

#### Other API-level routes
| Method + path | Audience | Guard | Purpose |
|---|---|---|---|
| POST /api/csp-report | machine (browsers) | rate limit; paths only, no tokens | record content-security reports |

### 4.4 Server-rendered candidate and public pages (Hono)

| Path | Audience | Guard | Purpose |
|---|---|---|---|
| GET /careers/:slug | public | company must be ITS-confirmed; rate limit | careers page |
| GET /careers/:slug/logo/:file | public | confirmed company, current logo file only | logo |
| GET /careers/:slug/jobs/:roleId | public | confirmed company | job page with JSON-LD (stays up when paused or closed) |
| GET /careers/:slug/jobs/:roleId/apply | candidate | role taking applications, else 404 | apply form |
| POST /careers/:slug/jobs/:roleId/upload-intent | candidate (browser) | rate limit; role admits (incl. closing-date grace) | signed upload grant |
| POST /careers/:slug/jobs/:roleId/apply | candidate | rate limit; honeypot; acknowledgment | submit an application; redirect to the conversation or the receipt |
| GET /careers/:slug/jobs/:roleId/applied | candidate | sealed receipt cookie | receipt ("check your email") |
| GET, POST /c/link-request | candidate | POST rate limited; same answer for every address | resend the status link |
| GET /c/status/:token | candidate | status token; 410 after deletion | status page (4 steps, thread) |
| POST /c/status/:token/privacy, /withdraw, /sms, /talent-pool | candidate | token + rate limits | self-service |
| GET /privacy | public | rate limit | privacy notice |
| GET, POST /c/privacy-request; GET /c/privacy-request/verify/:token; POST /c/privacy-request/verify | public | rate limits; email verification | public privacy request |
| GET /c/screen/:token | candidate | conversation token; opening writes nothing | intro, question, review or closed page |
| POST /c/screen/:token, /start, /later, /person, /human (legacy), /withdraw, /answers/:key, /submit | candidate | token + rate limits | answer, start, finish later, ask for a person, withdraw, change an answer, send |
| GET /c/screen/:token/later, /person, /review (redirect), /answers/:key | candidate | token | sub-pages |
| GET, POST /c/confirm-answers/:token | candidate (owner of the email) | token; POST rate limited | confirm a repeat submission's answers |
| GET /c/schedule/:token; POST /c/schedule/:token; POST /none-work; GET /confirmed; GET /ics; POST /reschedule; POST /cancel; GET /cancelled | candidate | schedule token + rate limits | pick, confirm, reschedule, cancel an interview |
| GET /a/:token | candidate | link token; bots not counted | tracked link → job page or form |
| GET /sitemap.xml, /robots.txt, /feeds/jobs.xml, /feeds/jobs.json, /feeds/linkedin.xml | search engines, boards | public; only open, accepting roles of ITS-confirmed companies; 5-minute cache | sitemap, robots, feeds |
| POST /webhooks/postmark/inbound | machine (Postmark) | basic-auth secret; 503 in production when unset | inbound applications and candidate replies |
| POST /webhooks/postmark/bounces, /spam, /events | machine (Postmark) | webhook secret; one claim per event id | delivery events, unsubscribes |
| POST /webhooks/twilio/inbound | machine (Twilio) | X-Twilio-Signature; 503 in production when unset | inbound SMS: STOP/START, screen replies |
| PUT /files/put/:token; GET /files/get/:token | browser (dev/test) | signed single-object grant | local storage stand-in |
| GET /healthz (`?strict=1`) | machine | none | database check, worker heartbeat |
| GET /dev/outbox; GET /dev/sms-outbox | developers | only when not production and fake adapters | last 50 fake emails / texts |

### 4.5 Navigation as a signed-in owner sees it

Rail (`AppShell.tsx`), top to bottom:
- Company chip: company name, the person's role word and a cog that opens `/setup`.
- **Start a hire** button (owner, admin, hiring manager, recruiter; N key unless switched off in Setup).
- **Today** `/`.
- **Roles** `/roles`. Under it, up to 8 roles in progress (open first with applicant counts, then paused, waiting and draft) and "All roles".
- **Talent** `/talent` (hidden for interviewers).
- **Interviews** `/interviews`.
- **Setup** `/setup`.
- **Recruiter → Queue** `/recruiter/queue` (ITS staff only).
- **Admin → Console** `/admin` (platform admin only).
- The signed-in name and **Sign out**.

On a role's pages and in the job builder the rail folds to icons (`rail.ts:10`). Under 900px it becomes a top bar with a Menu button. ITS staff inside a customer see an access banner. A fake AI provider shows a development banner.

Screens reached from inside pages, not the rail:
- `/roles/new` (job builder).
- `/roles/:id` tabs, deep-linked with `?tab=`.
- `/roles/:id/talent` modes: list, `?view=board`, `&review=1`, panel `?open=`, panel tabs Overview / Screen / Résumé / Messages / Notes / History.
- `/interviews/:id`.
- `/updates`.
- Server-rendered previews at `/api/v1/roles/:id/preview/page`.

Notification and brief links built on the server (packages/workflows, packages/agents, services/brief.ts) all point to routes that exist: `/roles/:id?tab=posting`, `/roles/:id/talent?open=…&step=…`, `/interviews/:id`, `/setup#setup-…`, `/?request=…`, `/roles/new?session=…`.

## 5. Data models and dependencies (as touched by routing)

- **sessions / users / memberships**: `ros_session` cookie → `loadSession` (packages/core). The active company comes only from an active membership or an active staff grant (`middleware/session.ts:38-62`).
- **staff_access_grants**: the scope (escalation, role, application) and expiry for ITS staff. `recordStaffAccess` writes an audit row for each `/api/*` request.
- **audit log**: `admin.bypass` (every admin request), `staff.tenant_accessed`, `report.exported`, `signin.refused`, `session.revoked`.
- **csp reports** (`recordCspReport`), **webhook receipts** (`claimWebhookReceipt`), **inbound_emails**, **communications** (SMS inbound).
- **application links** (tracked `/a/` links) and sealed cookies: `ros_pkce`, `ros_mfa`, `ros_invite`, the reauth marker, `ros_cal_pkce`, the source cookie, the receipt and conversation cookies.
- **intake_sessions** (drafts behind `/roles/new?session=`), **roles / role_packets / postings / applications / interviews**: the objects addressed by `/roles/:id`, `/applications/:id` and `/interviews/:id`.
- Dependencies: the shell resolves the session by calling the API in-process (`lib/session.ts:23`). Every mount uses one shared container (`lib/container.ts`, `getShellForRequest`).

## 6. Roles and permissions specific to routing

- **Page layer (decides what the screen shows; the API is the authority).**
  - `(app)`: any session.
  - `(company)`: an active company.
  - `recruiter`: `its_recruiter` or `platform_admin`.
  - `admin`: `platform_admin`.
  - Inside the company area there is no role check at page level. Pages hide controls using `apps/web/src/roles.ts`, which mirrors the matrix.
- **API layer.** The permission matrix (`packages/core/src/permissions.ts:44-74`):
  - owner and admin: everything.
  - hiring manager: no company.update, members.manage, role.manage or policy.manage.
  - HR: reads applications, manages members and offers, records outcomes; cannot create or approve roles.
  - interviewer: company.read, role.read and scorecard.write only.
  - recruiter (also used by ITS under a grant): no role.approve, outcome.record, company.update or policy.manage.
- **ITS staff:**
  - Without a grant they have no tenant at all (`session.ts:49-57`).
  - With a grant they act as "recruiter" and are held to the grant's role or candidate by `roleScopeGuard`, `applicationScopeGuard`, `interviewScopeGuard` and the preview's `tenantFor`.
  - Staff routes require aal2.
  - Staff cannot edit the company profile (`company-settings.ts:219-224`).
- **Re-authentication.** Changes to policies, notices, the new-times setting, and making someone an admin or owner need a recent sign-in (`middleware/reauth.ts`, `policies.ts:78`, `company-settings.ts:86-87`).
- **Candidates have no accounts.** Each candidate surface is opened by its own token (status, screen, schedule, confirm-answers, privacy verify, tracked link).
- **Known gaps:**
  - Interviewers can open any role's page by URL (`GET /roles/:id` is not limited the way the roles list is).
  - `GET /roles/:id/interviews` is not limited for interviewers or for one-candidate grants (bug 1).
  - `POST /approvals/:id/decide` does not check a staff grant's scope (bug 5).

## 7. Integrations and AI behind routes

- **Identity**: Supabase (Microsoft "azure" and Google; `packages/integrations/src/registry.ts:79-81`). Fake identity service in development.
- **Calendar**: Google only (`registry.ts:82-85`). Microsoft is not implemented.
- **Email**: Postmark (webhooks; sending through the outbox).
- **SMS**: Twilio (inbound webhook; texting is off unless `SMS_ENABLED`).
- **Storage**: Supabase object storage, with `/files` as the local stand-in.
- **Rate limits**: Upstash.
- **Error reports**: Sentry, with a deliberate test error on staging.
- **Analytics**: PostHog. Only `application_started` is sent from the apply GET, with no identity.
- **Job feeds** for Indeed-style XML/JSON and LinkedIn.
- **AI behind routes.** Each AI call happens behind one of these routes:
  - intake turns and draft (`/intake/sessions/:id/messages|answers|draft`)
  - change by asking (`/revisions`)
  - company "about" draft (`/companies/current/about/draft`)
  - message suggestions (`/applications/:id/messages/suggest`)
  - the candidate conversation (`POST /c/screen/:token`, and Twilio inbound via `runScreenTurn`)

  `/api` and `/c` allow 300 s per request for these model calls. `/careers` and `/webhooks` allow 60 s, and the Twilio inbound turn is a model call made under `/webhooks`. Model choice is outside this area (see `packages/ai/src/routing.ts`; not re-verified here). The pool board's questions use stored findings only; no new AI call is made (`roles.ts:548-553`).

## 8. Tests present and missing

**Present**
- `tests/e2e/specs/routes.spec.ts`:
  - one CSP header with a nonce on `/login` and `/`, Hono headers kept on `/privacy`
  - signed-out redirects for 9 paths
  - an owner sees 9 company routes, each checked with axe and with no sideways scroll on phone
  - the rail, the N shortcut, `/?start=1`, the old redirects, owner refused `/recruiter/queue` and `/admin`, the 404 page, and the job and status pages on phone
  - an admin reaches the queue and console (5 tabs clicked); an admin without a company is sent from `/setup` to the queue
- `apps/shell/lib/hono.test.ts` (every mount exports every method, CSP middleware exclusions, fonts) and `apps/shell/lib/headers.test.ts` (frame and referrer headers per mount).
- `apps/shell/components/AppShell.test.ts` and `tests/web/shell-rail.test.ts` (rail contents per role), `tests/web/setup-sections.test.ts`, `tests/web/start-hire.test.ts`.
- API guards:
  - `same-site.test.ts`, `tenancy.test.ts`, `staff-access.test.ts` (incl. break-glass and grant ledger), `approvals-access.test.ts`, `roles-list.test.ts`, `posting-access.test.ts`, `permission-hardening.test.ts`
  - `app.test.ts` ("blocks admin routes for non-admins"), `observability-route.test.ts`, `inbound-auth.test.ts`, `rate-limit.test.ts`, `csp.test.ts`, `security-coverage.test.ts`
  - `public-job-surfaces.test.ts` (tracked links, feeds, sitemap), `storage-uploads.test.ts` (`/files` grants), `mfa.test.ts`

**Missing**
- No test lists every `/api/v1` route and asserts it refuses an anonymous caller and a wrong role. Coverage is per feature, so a new route without `assertCan` would not be caught.
- No test calls `GET /api/v1/roles/:id/interviews` (where bug 1 lives), and none checks that an interviewer cannot open `GET /roles/:id` for a role they do not interview for.
- No test checks that a staff member under a one-role grant cannot decide another role's approval request.
- `routes.spec.ts`:
  - The signed-out check skips the dynamic routes (`/roles/[id]`, `/roles/[id]/talent`, `/interviews/[id]`, `/recruiter/queue/[id]`) and `/setup/company`.
  - `/recruiter/queue/[id]` is never opened by any browser test. (`/interviews/[id]` is not in `routes.spec.ts`, but `journey.spec.ts:116-119` opens the interview sheet and runs axe on it, and `decision.spec.ts:61,148` opens it too.)
  - No interviewer, HR, hiring-manager or ITS-recruiter (non-admin) persona walks the routes.
  - Admin tabs Workflows, AI runs, Costs and Privacy requests are never clicked, in `routes.spec.ts` or any other browser test.
- No test for the multi-company case (no switcher).

## 9. Bugs and incomplete features

1. **Medium: `GET /api/v1/roles/:id/interviews` shows every interview on a role to anyone with role.read.** (`apps/api/src/routes/interviews.ts:435-450`)
   - **Who is exposed:** an interviewer, or an ITS recruiter whose grant names one candidate.
   - **What leaks:** a direct request returns every candidate's first and last name and stage, the interview times, meeting links, the interviewers' names and email addresses, the outcome and the hiring decision note (`summary`, `interviews.ts:31-47`).
   - **Why:** `GET /api/v1/interviews` filters interviewers to their own (`interviews.ts:132`) and staff to their scope (`:145-150`); this route does neither. `roleScopeGuard` passes a one-candidate grant for its role (`packages/core/src/staff-access.ts:89`).
   - **Visible effect:** none in the app (nothing calls the route). It is a quiet data exposure for anyone who types the address.
2. **High (the plan change); medium (the rest): several platform-admin actions have no console screen.** These are API only (`apps/api/src/routes/admin.ts`):
   - put a customer on a plan, incl. the Design Partner pilot (`:390`). Every company that signs up starts on Trial (`services/companies.ts:34`): 1 active role, 25 screening conversations, 1 recruiter request (`packages/db/src/seed.ts:17-20`). The Design Partner plan (3 active roles, 300 conversations, 10 recruiter requests) is what the pilot agreement promises (`docs/legal-drafts/01-design-partner-pilot-agreement.md:14`). Today only a developer with a second-factor admin session can apply it, and no script in `scripts/` does it.
   - break-glass access (`:360`)
   - the staff-access ledger (`:377`)
   - the escalations overview (`:289`)
   - sign a person out everywhere after a lost device (`:494`)
   - AI-run detail (`:206`)
   - add an email suppression (`:227`)
   - check privacy deadlines and look up a candidate (`privacy-requests.ts:67,173`)

   A platform admin can only use them by hand-crafting an authenticated request with a second-factor session. `docs/spec/04` says the console can "assign plan".
3. **Medium: no way to switch company in the app.** A person who is a member of two companies cannot move between them; only the ITS queue calls `POST /api/v1/auth/switch` (`apps/web/src/pages/RecruiterQueue.tsx:193`).
   - **How it happens:** in ordinary use. Accepting a team invitation never refuses someone who already belongs to another company; it adds a second active membership (`packages/core/src/invitations.ts:164-178`). An example is an outside HR person or bookkeeper who helps two ITS customers.
   - **What they see:** at sign-in the session opens the company of the invitation just accepted, otherwise whichever membership the database returns first, with no ordering (`packages/core/src/identity.ts:75-76`, `.limit(1)` without `orderBy`). Their next sign-in may land in either company, and nothing in the rail says how to reach the other one.
4. **Low: an interviewer can open any role page by typing its address.** The roles list and rail show only the roles they interview for (`roles.ts:50-54`), but `GET /roles/:id` (`roles.ts:91`), `/packets`, `/interview-plan` and `/requirements-check` only need role.read. No pay is shown. `GET /roles/:id` does return the applicant counts by stage (`roles.ts:101-104,131`), which the roles list deliberately hides from interviewers (`countsHidden`, `roles.ts:53`).
5. **Low (plausible, not tested): `POST /api/v1/approvals/:id/decide` has no staff-scope check.** The list endpoint filters by the grant (`approvals-escalations-events.ts:32-33`), but decide (`:36-99`) does not.
   - **Which requests are open to it:** packet approvals are not, because they need role.approve, which "recruiter" lacks. Two kinds are: interview requests, whose default approvers include recruiter (`packages/core/src/policy.ts:77`), and requests made during an ITS takeover, whose approver is recruiter (`policy.ts:153`).
   - **Effect:** an ITS recruiter under a one-role grant could decide another role's request of those kinds, if they know its id.
6. **Low: an interviewer who opens `/talent` or `/roles/:id/talent` by address sees "Could not load the applicants."** with a Retry button, instead of a plain "not part of your role" message (`apps/web/src/pages/People.tsx:258`). If they interview for no role, they see "No roles yet" instead (`People.tsx:210-211`).
   - **How they get there:** the rail hides the link, so mainly through old bookmarks and shared links. Company-wide notifications go only to owners, admins and hiring managers by default (`packages/core/src/notifications.ts:37`), and those carrying talent links are not sent to interviewers.
7. **Low: "Sign a member out" exists only in the API** (`company-settings.ts:498`). Setup has no button, although `docs/spec/04` lists it as a Setup action.
8. **Low: the break-glass route's comment is out of date.** It says the route "refuses every request" until multi-factor sign-in exists. The code now allows it with a second factor verified in the last 15 minutes (`admin.ts:356-364`), and staff second factor shipped on 22 Sep. The refusal message an admin sees is out of date too: it says "Multi-factor sign-in arrives with the authentication migration" (`admin.ts:364`). `docs/spec/02-roles-and-permissions.md:64` still says break-glass is "refused until MFA exists (D25)".
9. **Low: `/healthz` is anonymous and tells anyone the database kind, the AI provider id and the worker queue depth** (`app.ts:107`).
10. **Low, latent:**
    - The shell middleware matcher excludes any path that *starts with* `privacy` or `healthz` (`apps/shell/middleware.ts:25`), while `next.config.ts:15` excludes only the exact paths. A future app page such as `/privacy-settings` would ship without the app's CSP header and nonce.
    - Outside production, webhooks accept unsigned posts when their secrets are unset (`webhooks/postmark.ts:31-39`, `webhooks/twilio.ts:23-29`). That is safe only while every public deployment runs with `NODE_ENV=production`.
11. **Incomplete, API only, nothing calls them:**
    - `GET /roles/:id/packets/diff`, so no version diff view in the History tab
    - `PATCH /roles/:id/packet`
    - `GET /roles/:id/packets`
    - `GET /roles/:id/postings/:channel/package` for owners
    - `GET /approvals`
    - `GET /intake/room`, `GET /intake/sessions/current`, `POST /intake/conversation/messages`
    - `GET /integrations`, `POST /integrations/:id/disconnect`
    - `POST /notifications/read-all`

## 10. Doc and code drift

- `docs/spec/16-route-inventory.md` (written 18 Sep):
  - It lists a `/login/consume` page that does not exist (the email link lands on the API page `/api/v1/auth/consume`).
  - It is missing the `/roles/new` and `/updates` pages.
  - Its Hono mounts table is missing `/a/[[...route]]`, `/files/[[...route]]`, `/sitemap.xml`, `/robots.txt` and `/api/csp-report`, and the server-rendered pages under `/api` (second factor, sign-in link, invitation, job preview).
  - The admin console is described with 7 tabs; the code has 10 (adds Privacy requests, Administrators, Outcomes).
  - Setup is described as "company, team, availability, services, policies"; the code has 13 sections.
  - `/c` is described as "status, screening, scheduling, privacy"; it also serves link-request, confirm-answers and the privacy-request form.
  - Its rule line says every page is axe-checked "in `routes.spec.ts` and `journey.spec.ts`" (line 48). That holds for `/interviews/[id]` (`journey.spec.ts:116-119`). For `/recruiter/queue/[id]` the doc's own row already says "(API-tested; queue page axe)", so this is a small overstatement in the rule line, not a wrong row.
  - The admin row (line 26) promises "axe per tab", but four of the ten tabs are never opened by a browser test.
- `docs/readiness/02-route-inventory.md` only points to spec/16 (so it inherits the drift above). It says the routes are re-verified on staging, which could not be confirmed from code.
- `docs/spec/04-screens-and-states.md`:
  - It lists routes that do not exist: `/login/consume`, `/roles/:id/packets/:version (sheet)`, `/setup/availability (sheet)` and `/setup/calendar/google, /microsoft`. Availability is a card on `/setup`; calendar connect goes to `/api/v1/integrations/calendar/google/connect`; Microsoft is not implemented.
  - It lists 6 role tabs; the code has 8 (adds History, Report).
  - It says Setup can "sign a member out" and the admin console can "assign plan"; neither has a screen.
- `docs/spec/07-api-specification.md` (spot check):
  - `PUT /companies/current/notices` does not exist (notices change through `PATCH /companies/current` with re-authentication).
  - `GET /roles/:id/packets/:version/diff?against=` is really `GET /roles/:id/packets/diff?from=&to=`.
  - `GET /data-requests ; POST /data-requests/:id/status` is really `/admin/data-requests/*` with assign, notes, verify, escalate, counsel, export, fulfil and decline.
  - Many current routes are not listed (postings prepare/ask-its/updated, channels, share-links, closing-date, apply-mode, decision and closing messages, revisions, requirements check, preview, notes, offer, outcomes, company profile routes, staff access, notification preferences, most admin routes).
- `apps/api/src/routes/admin.ts:356-359`: the break-glass comment says the route refuses every request; the code allows it with a fresh second factor. `docs/spec/02-roles-and-permissions.md:64` repeats the old rule ("refused until MFA exists").
- `docs/spec/00-decisions-and-risks.md:24` (A10) and `docs/spec/01-mvp-prd.md` AC1.3 expect a design partner to be on the pilot plan, "applied by a platform admin", before any role is created. The plan exists (`design_partner`, `packages/db/src/seed.ts:11`), but there is no screen to apply it.
- `tests/e2e/specs/routes.spec.ts:5`: the docstring says "every final Next.js route is visited signed out"; the list leaves out the dynamic routes and `/setup/company`.

## 11. Unknowns

- Whether the staging and production deployments actually serve these routes with these guards. There was no deployment access; `docs/readiness/02` claims staging re-verification.
- Whether any customer has people in more than one company today. How the active company is chosen is now traced: the invitation just accepted, else the first membership row with no ordering (`packages/core/src/identity.ts:75-76`); see bug 3.
- Resolved: when `CALENDAR_PROVIDER` is not `google`, the fake provider reports status `fake` (`packages/integrations/src/calendar/fake-google.ts:15`), so Setup hides the Connect button (`apps/web/src/pages/Setup.tsx:286,321,335`). No broken button is shown. Open question for the integrations area: production does not require `CALENDAR_PROVIDER=google` (`apps/api/src/env.ts:171-194`), so scheduling there would run on the fake calendar.
- Whether Twilio inbound SMS turns finish in time. `/webhooks` allows only 60 s (`apps/shell/app/webhooks/[[...route]]/route.ts:6`), and the Twilio webhook runs the AI screening turn inside the request (`apps/api/src/webhooks/twilio.ts:78`). Texting is off unless `SMS_ENABLED`.
- Whether `GET /roles/:id/requirements-check` or `GET /roles/:id/screening` reveal anything an interviewer or a one-candidate grant should not see. The screening funnel looks aggregate-only; the requirements check was not traced field by field.
- Whether the 60-second limit on `/careers` is enough for the apply POST under load (`createApplication` + `startApplyConversation` run in the request).
- `docs/12-api-contracts.md` was not reconciled route by route.

## 12. Verification notes (skeptical re-check, 14 Oct 2026)

What was re-checked against code: every bug in section 9; every feature marked partial or planned_not_implemented; and the following fully_implemented features, traced from UI to route to service or database:
- ROUTES-05, 06, 08, 09, 11, 12, 13, 15, 16, 17 and 19
- ROUTES-21 to 24, 26, 27, 33 and 42

What was also re-checked: the page count (17 `page.tsx` files), the 12 mount points with their `maxDuration`, and the route counts (about 247 `router.method(...)` registrations under `apps/api/src/routes`, 52 under `apps/api/src/pages`). Every `/api/v1` address that `apps/web/src` calls exists. So do the brief's action paths (`services/brief.ts`) and the deep-link query parameters they use (`?open`, `?ownerStage`, `?told`, `?stage`, `?view`, `?review`, `?close`, `?closingMessage`, `?edit`, `?request`).

Confirmed as written:
- bug 1, `GET /roles/:id/interviews`. It is mounted (`app.ts:146`) and has no caller in `apps/web`. `scopeAllows` lets a one-candidate grant through for its role (`staff-access.ts:89`).
- bugs 4, 5, 7, 8, 9 and 10.
- bug 11: no web caller was found for any of the listed routes.
- ROUTES-36 to 41 statuses.

Changed:
1. **Bug 2 raised to high for the plan change.** New companies start on Trial: 1 active role, 25 screening conversations, 1 recruiter request (`services/companies.ts:34`, `seed.ts:17-20`). The only way to the Design Partner plan the pilot agreement promises is a hand-made admin API call. No script in `scripts/` does it. ROUTES-37 notes updated.
2. **Bug 3 raised from low/low-medium to medium.** The multi-company case is reachable through normal invitations (`invitations.ts:164-178`). Sign-in then opens an arbitrary membership (`identity.ts:75-76`). This also resolved one unknown.
3. **Bug 1:** the leaked fields now include the interviewers' email addresses and meeting links.
4. **Bug 4:** `GET /roles/:id` also gives interviewers the applicant counts by stage that the list hides.
5. **Bug 5:** named which approval kinds a recruiter can decide (interview requests and takeover requests). Packet approvals are refused anyway because "recruiter" lacks role.approve.
6. **Bug 6:** notifications with talent links do not go to interviewers by default (`notifications.ts:37`), so mainly old bookmarks lead there. An interviewer with no roles sees "No roles yet" instead.
7. **Bug 8:** the user-facing refusal text and `docs/spec/02` are stale too.
8. **Corrected a wrong test-gap claim.** `/interviews/[id]` is opened and axe-checked by `journey.spec.ts:116-119` (and opened in `decision.spec.ts`). Only `/recruiter/queue/[id]` is never opened. The matching doc-drift bullet against `docs/spec/16` was rewritten, since that doc names journey.spec for this route.
9. **ROUTES-39 reworded.** Only the Microsoft calendar is missing. Google connect and "Your availability" work as Setup cards.
10. **ROUTES-40:** noted the diffs that do exist (AI-proposed change diff; current versus proposed toggle on the approval card).
11. **ROUTES-38:** using a break-glass grant also needs `POST /auth/switch`, which no admin screen calls.
12. **ROUTES-06:** in production (email links off) an invited person must sign in with Google or Microsoft at exactly the invited address.
13. **Unknowns:** the calendar Connect question is resolved, because the button is hidden when the fake provider is in use. Added the 60 s `/webhooks` limit for Twilio AI turns. Added a pointer that production does not require a real calendar provider.

Refuted: none of the eleven bugs was refuted outright. The only refuted claims are the test-gap and doc-drift statements about `/interviews/[id]` never being opened or axe-checked.
