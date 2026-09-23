# 00. Decisions register: contradictions, open decisions, security risks, compliance questions, simulated actions

Prepared 14 September 2026 by the production team for founder review. This register is the gate for the specification set in this folder: the ten documents that follow are written against the defaults marked below, and every item marked **needs founder** must be confirmed (or overruled) before production code for release 1 starts.

Sources reconciled: the founder's release-1 instruction of 14 September 2026 (the governing scope), `docs/FOUNDER-CONTEXT.md` (§01 to §31 and the blueprint), the strategy memo (`Share/AI-Recruiting-Employee-for-SMB-Strategy-2026.md`), the existing design documents (`docs/00` to `docs/17`), and the code as of commit state on 14 September 2026 (Slices 1 and 2, 71 tests).

Legend: **needs founder** = build cannot start on that item without an answer; **default** = we proceed with the stated default unless told otherwise; **counsel** = an attorney must answer.

---

## A. Contradictions found

| # | Where | Contradiction | Resolution in this spec | Status |
|---|---|---|---|---|
| A1 | Founder instruction (14 Sep) vs `FOUNDER-CONTEXT.md` §27 | §27's 90-day MVP includes interview scorecards, a decision inbox, and offer generation/approval. The instruction of 14 Sep ends release 1 at calendar scheduling and excludes offers. | The 14 Sep instruction governs. Scorecards, debrief, offers are release 2. Release 1 ends at a scheduled and completed interview with a human decision recorded. | Confirmed by instruction |
| A2 | Founder instruction ("hosted job page") vs code (`publish_role` posts to careers page, Google Jobs markup, email-in, LinkedIn XML feed, and Indeed/ZipRecruiter adapters that report "pending partner approval") | Release 1 names only a hosted job page. The code already publishes to five channels and shows two more as pending. | Keep the free, native channels that need no third party: hosted careers page, Google for Jobs JSON-LD on that page, and the email-in intake address (used for forwarded Indeed applications). Show LinkedIn, Indeed, ZipRecruiter only behind a feature flag (`CHANNELS_EXTERNAL=off` by default) until the partner programs are approved and the feed is registered, so the product never displays a channel that cannot work. | **needs founder** (D5) |
| A3 | `FOUNDER-CONTEXT.md` §24 ("Temporal", "Next.js") and the 14 Sep instruction ("use managed services and established libraries") vs code (own Postgres-backed workflow engine, Hono API, Vite/React web) | The engine is custom code, not an established library. | Keep the own engine for release 1: it is 17 KB, has retries, timers, event waits, leases, and an escalation on final failure, and is covered by the scenario tests. A Temporal Cloud or Inngest migration is a documented option in `docs/03`; switching now would delay the pilot by weeks and re-test everything. | **needs founder** (D1) |
| A4 | `FOUNDER-CONTEXT.md` §26 roles ("tenant admin, recruiting/People admin, recruiter, hiring manager, interviewer, executive/approver, finance/offer approver, external recruiter, support impersonation") vs code (owner, admin, hiring_manager, hr, interviewer, recruiter; platform roles its_recruiter, platform_admin) | The finance/offer approver and executive approver roles have no counterpart. | They matter for offers (release 2). Release 1 keeps six tenant roles; the offer approver role is added with the offer workflow. Support impersonation stays read-only through the audited admin console; no write impersonation. | default |
| A5 | `docs/12` documents endpoints that do not exist (`/candidates`, `/candidates/:id/merge`, `/candidates/:id/data-request`, `/interviews/*`, `/offers/*`, `/onboardings/*`, `/integrations/:provider/connect`, `/escalations/:id/takeover`) | The route map describes intent, not the build. | `docs/spec/07` marks every endpoint existing / changed / new. Release 1 adds the interview, calendar, session, data-request, and platform-role endpoints; the rest are labeled future. | default |
| A6 | `docs/STATUS.md` says the LinkedIn feed is "live"; the adapter reports `live` in Setup | The feed XML is generated, but LinkedIn has not been asked to ingest it. Showing "live" is fake completeness (blueprint item 15). | Adapter status becomes `pending_partner_approval` until the feed URL is registered with LinkedIn. | default |
| A7 | `docs/08` and `docs/03` describe "session list and revocation in Setup", "data-request intake", "signed time-limited document URLs", "CSP on candidate pages", "content scanning hook" | None of these is implemented. | Each is either built in release 1 (sessions, data requests, CSP, token redaction in logs) or explicitly deferred (document URLs: resumes are not downloadable from the web app in release 1; scanning hook: deferred, see S6). | default |
| A8 | Candidate status page copy for `interview_recommended` reads "Scheduling details are on their way"; the API reply to `advance_to_interview` reads "Scheduling arrives with the next slice" | Promises the product does not yet keep. | Release 1 builds scheduling; both strings are replaced by real behavior. | default |
| A9 | `docs/06` and `docs/07` describe Home/People navigation and five owner views (Home, Roles, People, Calendar, Setup); the founder context names six (Today, Roles, Talent, Interviews, Offers, Insights); the code ships Today, Roles, Talent, Setup | Three different navigation lists. | Release 1: Today, Roles, Talent, Interviews, Setup. Offers and Insights appear with their releases, never as empty menu items (per `docs/17` §14). | default |
| A10 | Pricing tiers exist as seeded plans (Core $499 / Growth $899 / Company $1,499) and the trial plan allows 1 active role and 25 text screens | A design partner running a real search on the trial plan would hit the limits in the first week. | Add a `pilot` plan (limits equal to Growth, price 0) applied to design partners by a platform admin. Billing (Stripe) stays out of release 1. | **needs founder** (D9) |
| A11 | `docs/13` scenario is a dental hygienist; the founder context wedge is consumer/beauty/creative | Both scenarios exist in code (`lifecycle.test.ts` dental, `consumer-lifecycle.test.ts` beauty brand). | Both stay. The consumer scenario is the release-1 acceptance path; dental remains the licensing-rule test path. | default |
| A12 | The founder context §25 wants Google and Microsoft email sending from the customer's mailbox; `docs/03` chose Postmark from a product domain to avoid restricted-scope OAuth | Email sending model. | Release 1 sends from the product domain (Postmark). Mailbox OAuth for sending is deferred (Google restricted scopes require a CASA assessment). Calendar OAuth (sensitive, not restricted scope) is in release 1. | default |

---

## B. Unresolved decisions

| ID | Decision | Options | Recommendation and default | Status |
|---|---|---|---|---|
| D1 | Workflow engine for release 1 | (a) keep the own engine; (b) migrate to Temporal Cloud; (c) migrate to Inngest | (a). Re-evaluate at the release-2 planning point when the offer and onboarding workflows are designed. | **needs founder** |
| D2 | Calendar providers in release 1 | (a) Google Calendar only; (b) Google and Microsoft 365; (c) either plus a "no calendar connected" manual-availability fallback | (c) with both providers, because the founder context §25 names both and design partners are not yet known. The manual fallback (interviewers declare weekly windows) is required regardless so scheduling never blocks on OAuth verification. Google OAuth apps in "testing" status allow up to 100 test users, which covers the pilot while verification is pending. | **needs founder**: which calendar platform each design partner uses |
| D3 | Video-conference links for interviews | (a) Google Meet / Teams links created with the calendar event; (b) Zoom integration; (c) the interviewer's own link pasted into the round | (a) for connected calendars, (c) as the fallback. Zoom is deferred. | default |
| D4 | Who can be an interviewer in release 1 | (a) only users with an account and (ideally) a connected calendar; (b) any name typed into the packet | (a). Interviewers are memberships with role `interviewer` (or any tenant role). The owner picks the interviewers when approving the interview; a round whose interviewer has no connected calendar falls back to declared availability. | default |
| D5 | Job distribution channels shown in release 1 | (a) careers page + Google Jobs markup + email-in only; (b) also show LinkedIn / Indeed / ZipRecruiter as "pending" with instructions | (a) by default; (b) behind a flag once at least one program is approved. Owners who post on Indeed themselves are told to forward applications to the intake address (this already works). | **needs founder** |
| D6 | SMS in release 1 | (a) web-chat screening only; (b) SMS via Twilio once the A2P 10DLC campaign is approved | Build is done for both; ship (a) and enable (b) per environment by configuration when the campaign is approved. The apply form keeps the separate SMS consent box only when SMS is enabled, so consent is never collected for a channel that does not exist. | default; **needs founder** to start 10DLC registration (requires a business EIN, a website, and sample messages) |
| D7 | Sending domain and product name in candidate-facing email | The naming sprint is pending. Emails currently say "Recruiting OS" and send from `mail.localhost`. | Use an ITS-owned subdomain for the pilot (for example `hiring.identifiedtalent.com` for sending, `apply.identifiedtalent.com` for intake) and sign messages as "the hiring team at {company}". The product name appears only in the owner app. Changing it later is a configuration change. | **needs founder**: the domain |
| D8 | Hosting | (a) Render (API + worker) + Neon Postgres + Cloudflare R2; (b) Fly.io + Neon + R2; (c) AWS (ECS, RDS, S3) | (a): fewest moving parts, US region, managed Postgres with point-in-time recovery, S3-compatible storage. Cost at pilot scale is well under $200 a month. | **needs founder** |
| D9 | Plan for design partners | (a) manual `pilot` plan (Growth limits, $0); (b) full Stripe billing in release 1 | (a). Billing is release 2. | **needs founder** |
| D10 | Interview outcome recording in release 1 | After the interview, the owner needs a way to close the loop without the offer workflow. (a) add a human-only "record decision" action: next round, finalist, hired (recorded outside the product), not moving forward; (b) leave the application at `interview_complete` until release 2 | (a). It uses existing stages (`interview_scheduled` → `interview_complete` → `finalist` → `hired`) and existing human-only transitions; "hired" is a record of a decision made outside the product, never a system action. | **needs founder** (touches the state machine) |
| D11 | ITS recruiter access to tenant data | Today `its_recruiter` is granted the `recruiter` role in any company by sending a company id header; only opening an escalation is audited. | Scope it: an ITS recruiter sees a tenant only while holding an open escalation for it (or an active takeover, release 3+), every cross-tenant read is audited, and the customer sees "ITS recruiter {name} viewed this" in the timeline. | **needs founder** (changes what ITS staff can do) |
| D12 | Authentication strength | Magic links only today. The founder context §26 asks for MFA. | Release 1: magic links with 15-minute single-use tokens, session list and revocation, and re-authentication for policy changes. TOTP as an optional second factor in release 2; SSO with Company tier. | **needs founder** |
| D13 | AI models and spend cap | Defaults: Opus 5 for intake and compile, Sonnet 5 for assessment and screening, Haiku 4.5 for extraction. | Keep the defaults; add a per-tenant daily spend cap (default $25) that pauses AI tasks and notifies the platform admin. Estimated cost per role at pilot volume is under $5 (see `08`). | default |
| D14 | Recruiter escalation SLAs | Code promises 4 hours (candidate issue), 8 hours (takeover, negotiation), 24 hours (ask, review, stuck role), 48 hours (search support), and the screening page tells candidates "within a few hours". | Keep the numbers only if ITS commits to a staffed queue on business days with a named backup. Otherwise change the candidate-facing copy to "within one business day". | **needs founder**: staffing commitment |
| D15 | Retention and deletion in release 1 | The schema has retention classes; nothing purges. | Release 1: a data-request intake (access, delete, correct) with a manual fulfilment runbook for the platform admin and a 30-day SLA; automated purge jobs in release 2. | default; **counsel** on the retention default (C4) |
| D16 | Hiring managers creating roles | Today hiring managers can start intake and approve packets. | Keep; owners and admins can restrict it with the `role_packet.approve` policy approver list. | default |
| D17 | Dental playbook | Retained as a non-default vertical. | Keep. | confirmed in `docs/17` |
| D18 | Interview rounds in release 1 | The packet plan can hold up to five rounds. | Release 1 schedules any round from the plan, one at a time, in order; parallel scheduling of several rounds is release 2. | default |

---

## C. Security risks found in the current build

Severity: **High** (fix before any real candidate data), **Medium** (fix in release 1), **Low** (track).

| ID | Risk | Severity | Release-1 action |
|---|---|---|---|
| S1 | ~~Platform-level database access~~ **Closed in slice 1** (see section H). | High | Provision three database roles: `ros_migrate` (owner), `ros_app` (connection role, `NOBYPASSRLS`, member of nothing), `app_tenant` (existing). Verify in the boot check that the connection role is not a superuser. |
| S2 | ~~ITS recruiter cross-tenant access by header~~ **Closed in slices 1 and 2** (see section H). | High | Scope access to open escalations; audit every read. |
| S3 | ~~Integration credentials with application-side encryption~~ **Closed in slice 3**: a managed secret store (Supabase Vault) replaces application-side cryptography; verification on a real project pending D23. | High | Implement AES-256-GCM envelope encryption with key ids before the calendar connection ships; never log tokens; rotate on disconnect. |
| S4 | Candidate tokens in URLs (`/c/status/:token`, `/c/screen/:token`) are written to request logs by the Hono logger and may leak through the `Referer` header to third parties (links on the page). | Medium | Redact path tokens in logs; set `Referrer-Policy: no-referrer` on candidate pages; add `robots: noindex`; give screen and schedule tokens expiries (status tokens stay long-lived by design, and can be rotated by the candidate from the status page). |
| S5 | The in-memory rate limiter does not work across more than one API process and keys on `X-Forwarded-For` without a trusted-proxy check. | Medium | Move limits to Postgres (a `rate_limits` table with a sliding window) or the platform's edge rate limiting; trust the forwarding header only from the platform's proxy. |
| S6 | Resume parsing (PDF and DOCX) runs in the API request path on untrusted files; no malware scanning. | Medium | **Done 22 Sep (decision 2):** files are quarantined and parsed only by the worker after a signature check and a scan (`application_intake` step `validate`); the 8 MB limit stays; the scanner is a fake with status `fake` until a real engine is authorized (real-data blocker 8). |
| S7 | Candidate pages use inline styles and one inline `onsubmit`; `secureHeaders()` sets a default CSP that would block them if tightened. | Medium | Move the inline handler to a small script with a nonce; set a CSP with nonces on candidate pages and the web app. |
| S8 | CSRF: state-changing JSON routes rely on `SameSite=Lax` cookies plus CORS. Candidate form posts are unauthenticated by design (token in path). | Low | Keep; add an `Origin` check on `/api/*` mutations; candidate forms add a per-render CSRF token. |
| S9 | Email-in intake: anyone who learns an intake address can create applications; parsed text goes to the model. | Low | Rate limit per intake address; mark email-in applications with the source; the fairness rules treat content as data; add the injection cases to the eval suite (already partly covered). |
| S10 | Admin reads require only an `x-admin-reason` header that defaults to "admin console". | Low | The console asks for a reason when opening a customer; the API rejects the default in production. |
| S11 | No session management UI; sessions last 30 days sliding. | Medium | Add session list and revoke (all devices) to Setup; revoke on role change. |
| S12 | Webhook secrets: the Postmark inbound secret is accepted from the query string. | Low | Header only in production. |
| S13 | Google OAuth tokens grant calendar read/write for the interviewer's whole calendar. | Medium | Request the narrowest scopes (`calendar.events` plus free/busy), store the calendar id, show the scope on the connection card, and delete tokens on disconnect. |

---

## D. Compliance questions

| ID | Question | Why it matters | Needs |
|---|---|---|---|
| C1 | Is the evidence-based assessment an "automated employment decision tool" under NYC Local Law 144 when every advance or reject is a human decision and the assessment is information only? | Determines whether a bias audit and notice are required for NYC customers. | **counsel** |
| C2 | Is the assessment an "automated-decision system" under the California Civil Rights Council regulations (effective 1 Oct 2025), and does the four-year retention apply to screens and assessments? | Retention defaults and record content. | **counsel** |
| C3 | Illinois HB 3773 notice: is the current `ai_use` text sufficient, and must it be shown before the application is submitted (it is) and again before the screen (it is)? | Notice timing and text. | **counsel** |
| C4 | Retention default of four years for decision data and communications; deletion on request vs retention obligation when a candidate asks for deletion. | The data-request runbook must have a rule. | **counsel** |
| C5 | TCPA / A2P 10DLC consent language on the apply form and the STOP/HELP flows. | Required before SMS is enabled (D6). | **counsel**, carrier registration |
| C6 | Calendar OAuth: Google API Services User Data Policy "Limited Use" requirements and the privacy policy the OAuth consent screen must link to. | The OAuth app cannot be verified without a public privacy policy naming the use. | Privacy policy text, **counsel** review |
| C7 | Design-partner agreements: terms of service, a data processing agreement naming subprocessors (Anthropic, Postmark, Twilio, the hosting provider, Google/Microsoft for calendar), and the vendor liability allocation given Mobley v. Workday. | Required before the first real candidate. | **counsel** |
| C8 | Insurance: technology errors and omissions with an employment practices endorsement. | Vendor liability exposure. | Broker |
| C9 | Accessibility: the candidate pages target WCAG 2.2 AA; the pilot needs an accessibility statement and a contact route. | Public-facing pages. | Internal audit + statement |
| C10 | Voluntary self-identification for selection-rate monitoring is not collected in release 1; bias monitoring is therefore not possible on real data. | The founder context §26 asks for monitoring. | Decide when to add the separate, voluntary self-ID form (recommended release 2, after counsel). |

---

## E. Simulated or placeholder behavior in the current build

Everything below is either development-only (never runs in production by construction), a labeled pending integration, or a placeholder that release 1 replaces. Nothing in this list may ship in the pilot unlabeled.

| ID | What is simulated today | Where | Release-1 disposition |
|---|---|---|---|
| P1 | The deterministic AI provider (`AI_PROVIDER=fake`) with heuristic handlers for every prompt. | `packages/ai/src/providers/fake.ts`, `packages/agents/src/fake-handlers.ts` | Dev and tests only; production boot refuses it. All prompts must pass the eval suites on the real provider before the pilot (see `08`). |
| P2 | Fake email and SMS adapters that record instead of sending; `/dev/outbox` and `/dev/sms-outbox` endpoints. | `packages/integrations/src/email/fake.ts`, `apps/api/src/app.ts` | Dev only; endpoints are not registered in production. Postmark and Twilio adapters exist and report `pending_credentials` until configured. |
| P3 | The LinkedIn XML feed adapter reports `live`. | `packages/integrations/src/jobboards/external.ts` | Change to `pending_partner_approval` (A6); hide behind the channel flag (D5). |
| P4 | Indeed and ZipRecruiter adapters return `pending_partner_approval` with owner instructions. | same | Labeled and honest; hidden behind the channel flag until approved. |
| P5 | `posting.sponsor_spend` policy exists with no spend integration. | `packages/core/src/policy.ts` | Hidden from the policy editor in release 1 (no channel can spend). |
| P6 | `interview.record`, `scorecard.draft`, `debrief.recommend`, `offer.*`, `background_check.*`, `employee.create_in_hris`, `welcome.send`, `checkin.request`, `sourcing.*`, `outreach.send` policies exist for features that do not. | same | Policy editor shows only actions the release can perform; the rows keep their defaults. |
| P7 | Status page copy promises scheduling; `advance_to_interview` reply promises a later slice. | `apps/api/src/pages/candidate.tsx`, `apps/api/src/routes/roles.ts` | Replaced by the scheduling workflow (A8). |
| P8 | Escalation email to `ITS_QUEUE_EMAIL` and intervention emails from "Recruiting OS <hello@…>". | `apps/api/src/routes/approvals-escalations-events.ts`, `packages/agents/src/orchestrator.ts` | Real once Postmark is live; sender name follows D7. |
| P9 | The intake conversation in the fake provider uses regex fact extraction and repeats questions it did not parse. | `fake-handlers.ts` | Dev only. |
| P10 | The `takeovers` policy overlay exists; there is no takeover flow or UI. | `packages/core/src/policy.ts` | Not in release 1; the recruiter queue is claim/resolve only. |
| P11 | Tables for offers, onboardings, hiring outcomes, debriefs, scorecards exist and are unused. | `packages/db/src/schema/hiring.ts` | Kept (empty, RLS-protected); no UI reads them. |
| P12 | `candidates.embedding` (pgvector) is never written. | same | Kept; rediscovery is release 3+. |
| P13 | The clickable HTML walkthrough in `Share/` | `Share/Recruiting-OS-Walkthrough.html` | A demonstration artifact; not a product surface; not maintained further. |
| P14 | `docs/12` endpoints that are not implemented (see A5). | `docs/12-api-contracts.md` | `07` is the release-1 contract; `docs/12` is updated to point at it. |
| P15 | The BLS OEWS benchmark uses a small built-in metro table (about 35 metros) and falls back to the national figure. | `packages/integrations/src/comp/bls.ts` | Real API, limited coverage; the packet cites the source and says "national" when it is. Acceptable for the pilot. |
| P16 | Demo tenant data (Brightline Dental Group) in the local PGlite database. | `.data/pglite` | Local only; production starts empty. |

---

## F. Founder approval checklist

Please answer these; everything else proceeds on the defaults above.

1. D1 workflow engine: keep the own engine for release 1?
2. D2 calendar providers: Google and Microsoft with a manual-availability fallback? Which platform do the first design partners use?
3. D5 channels: hosted page, Google Jobs markup, and email-in only, with the external boards hidden until approved?
4. D6 SMS: start the Twilio A2P 10DLC registration now (needs the EIN, website, and sample messages)?
5. D7 sending domain for the pilot.
6. D8 hosting: Render + Neon + Cloudflare R2 in a US region?
7. D9 a zero-price `pilot` plan for design partners?
8. D10 the human "record decision" action after an interview (next round, finalist, hired, not moving forward)?
9. D11 scope ITS recruiter access to open escalations, audited?
10. D12 magic links plus session controls for release 1, TOTP later?
11. D14 the recruiter SLA numbers ITS will staff.
12. Counsel: who reviews C1 to C7, and by when?

---

## G. Founder decisions recorded 14 September 2026 (evening)

The founder answered the checklist and set additional direction. Each item below is a decision, not a recommendation. Where a decision changes an earlier default, the earlier row's status is superseded by this section.

| # | Decision | Effect on earlier items | Execution slice |
|---|---|---|---|
| F1 | Security fixes are release blockers: no superuser or RLS-bypassing database role; no tenant selection through user-controlled headers; tenant from the authenticated user's verified membership; no default global access for ITS recruiters; OAuth credentials in a managed key-management service (no proprietary encryption); ordinary application database access separated from integration-worker access; automated cross-tenant isolation tests; synthetic data only until these pass. | S1, S2, S3 → in progress, blocking. The earlier AES-GCM plan in `09` §4 is withdrawn in favor of a managed store (D21). | 1, 2, 3 |
| F2 | Workflows move to managed Trigger.dev, one complete workflow at a time, keeping the event and audit model as the system of record; every workflow supports idempotency, safe retry, timeouts, human approval states, cancellation, duplicate-event protection, visible failure status, and audit events. | D1 → decided: Trigger.dev. The own engine remains only until each workflow is migrated (D22). | 5 onward |
| F3 | Google Calendar first; manual availability as a full fallback from day one (hiring manager enters windows, candidate chooses, ICS invitation, confirmations and reminders, authorized reschedule and cancel); Microsoft after a design partner confirms a requirement; a provider interface so Microsoft is additive; OAuth approval must not block the pilot. | D2 → decided. D3 → Meet links when Google is connected; pasted link otherwise. | 5 |
| F4 | Show only verified channel states with five values: Live and verified; Submitted, awaiting verification; Manual action required; Not connected; Failed. Release-1 channels: hosted careers page; Google for Jobs through valid JobPosting data; email-in capture; manual Indeed, LinkedIn, and (if required) ZipRecruiter posting instructions. Never label a board "live" without confirmed ingestion. Remove unsupported claims now. | D5 → decided. A6, P3, P4 → fixed in slice 4. | 4 |
| F5 | Begin Twilio A2P 10DLC registration for ITS now; SMS stays disabled in production until registration, consent language, STOP and HELP handling, quiet hours, opt-out logging, and counsel review are complete; email and web screening remain complete alternatives. | D6 → decided. C5 → counsel register item 9. | 8 |
| F6 | Sending domain `hire.identifiedtalent.com`; initial sender `updates@hire.identifiedtalent.com`; display name = the customer's company and hiring-team name; replies enter the platform's communication inbox with a monitored ITS fallback; SPF, DKIM, DMARC, bounce handling, complaint handling, unsubscribe controls; never impersonate a customer's domain without verified authorization. | D7 → decided. | 4 (sender names), 7 (inbox, bounces, unsubscribe) |
| F7 | Hosting: Vercel for the Next.js application; Supabase for PostgreSQL, authentication, and document storage; Trigger.dev for durable workflows; Sentry for errors; PostHog for product analytics; separate development, staging, and production; never copy production candidate data into development. | D8 → decided. This replaces the Hono-on-Render, Vite/React, PGlite-in-dev-only plan; see D19, D20 for the migration shape. | platform migration (see order below) |
| F8 | A private Design Partner plan at $0: up to three active roles, unlimited team members, reasonable applicant volume, email and web screening, manual scheduling fallback, ITS recruiter support, no credit card, no expiration during an active search; 90-day term extendable for roles in progress; label "Design Partner", never "Free Trial"; billing limits never interrupt an active candidate process; a signed pilot agreement covering data handling, beta limitations, feedback, support, and permitted use. | D9 → decided (plan key `design_partner`). A10 → fixed. | 4 (plan and labels), agreement → counsel register item 12 |
| F9 | After interviews, human-only actions: Advance to next interview; Move to offer review; Request more evidence; Place on hold; Decline (job-related reason required; protected information never in the reason). AI may summarize interview evidence, identify conflicting feedback, highlight missing scorecards, recommend follow-up questions; AI may not decide or send candidate-facing communication until a person confirms. | D10 → decided, superseding the four-option default. In release 1 the AI summary draws on the assessment, screen, and notes; scorecards arrive in release 2, so "missing scorecards" is shown only once scorecards exist. | 6 |
| F10 | ITS recruiter access is explicit, role-scoped, and time-limited: granted only when a customer requests assistance, a candidate requests a human, an approved escalation policy triggers, or a specific recruiter accepts the assignment; limited to the assigned company, role, candidate, or escalation; every access event records recruiter, purpose, timestamp, records viewed, actions taken, and expiration; the tenant-selection header is removed; platform administrators get emergency break-glass only with MFA, a recorded reason, short expiration, and immutable audit logging. | D11 → decided. | 2 |
| F11 | Authentication: Google or Microsoft sign-in for customer users where available; email-based account recovery; MFA for every ITS recruiter and platform administrator; MFA for customer administrators before general release; short administrative sessions; revocation when a member is removed; rate limiting and suspicious-login monitoring; candidate access through expiring, single-purpose links that expose no sequential ids and cannot reach another application; no internal password storage or authentication. | D12 → decided: the internal magic-link and session system is replaced by Supabase Auth (D19). | platform migration, then 2 (MFA gates) |
| F12 | Pilot SLAs in business hours (Monday to Friday, 9:00 to 17:00 Pacific, excluding holidays): candidate requests a human, four business hours; customer requests shortlist or candidate advice, one business day; offer or counteroffer assistance, two business hours; security or privacy request, acknowledge within one business day; platform-blocking issue, acknowledge within two business hours. Outside those hours the product sets an accurate expectation; no 24-hour or weekend promises. Track response time and recruiter minutes per escalation. | D14 → decided. | 2 |
| F13 | Counsel review owned by Nadine; external approval from California employment counsel with hiring-AI experience and privacy/technology counsel (CCPA, state privacy, SMS, employment data) on the fourteen items in `11-counsel-register.md`; unresolved legal questions block only the affected feature. | C1 to C10 → moved to the counsel register. | ongoing |
| F14 | Correct all unsupported product claims now: no scheduling promises until scheduling works; no integrations shown live without verification; no implied saved progress that is not securely persisted; no response-time promises outside the approved SLA; AI recommendations never described as employer decisions. | A8, P7, P8 → fixed in slice 4. | 4 |

Execution order set by the founder: (1) database and tenant-security fixes, (2) recruiter-access controls, (3) secrets and OAuth-token protection, (4) misleading-copy corrections, (5) Google Calendar scheduling with manual fallback, (6) human post-interview decisions, (7) candidate and owner notification workflows, (8) SMS after registration and counsel clearance. After each slice: automated security, permissions, workflow, accessibility, and failure-recovery tests; register update; stop if a founder or counsel decision is still required.

### New decisions arising from F1 to F14

| ID | Decision needed | Default in use now | Status |
|---|---|---|---|
| D19 (approved 15 Sep, I8) | Authentication migration. F11 requires Google/Microsoft sign-in, email recovery, and MFA without internal auth. Default: Supabase Auth (OAuth providers, email OTP for recovery, TOTP MFA with the `aal2` claim gating staff and break-glass); the API verifies Supabase JWTs and maps the Supabase user id to `users.auth_subject`; the internal magic-link and session tables are retired after the migration; candidate links stay token-based (they are not accounts). Local development and tests use a fake JWT issuer with the same claim shape. | Supabase Auth | **needs founder** only if Supabase Auth is not acceptable; otherwise proceeds with the platform migration |
| D20 (approved 15 Sep, I9) | Application shape on Vercel. F7 names "the Next.js application". Default: one Next.js app (App Router) hosts the owner, recruiter, and admin UI (ported from the Vite/React pages) and mounts the existing Hono API and candidate pages under catch-all route handlers (`/api/*`, `/careers/*`, `/c/*`, `/webhooks/*`) through Hono's Vercel adapter, so the API code is retained rather than rewritten; long AI tasks move to Trigger.dev tasks; the queue-polling worker process is retired as workflows migrate. | as stated | **needs founder** confirmation that porting the UI to Next.js is in scope now (it is the larger part of the migration) |
| D21 (approved 15 Sep, I10) | Managed key-management service for OAuth credentials. Default: Supabase Vault (secrets encrypted by Supabase-managed keys, readable only by the worker database role); the application stores only the vault secret id. Alternative: Google Cloud KMS. | Supabase Vault | default; confirm if a different KMS is preferred |
| D22 | Trigger.dev migration order. Default: new workflows start on Trigger.dev (`schedule_interview` first, slice 5); existing workflows migrate one at a time in this order: `screen` (reminders and expiry), `application_intake`, `stuck_role_detector` and the daily brief, `publish_role`, `role_approval`; the own engine is removed when the last one moves. Each migrated workflow keeps its event names and step ledger equivalents so the admin console and audit history do not change. | as stated | default |
| D23 (sequence set 15 Sep, I14; worksheet in `13`) | Accounts and credentials the team needs from ITS to run staging: Supabase organization and two projects (staging, production); Vercel team; Trigger.dev organization; Sentry and PostHog projects; Postmark server with `hire.identifiedtalent.com` verified (DNS: SPF, DKIM, DMARC, return-path, inbound MX); a Google Cloud project with the Calendar API and an OAuth consent screen in testing mode; Twilio account for 10DLC registration; an Anthropic API key with a spend limit. Until these exist, development continues on PGlite with fakes and synthetic data (F1 permits this). | pending | **needs founder** to create or delegate |
| D24 (approved with data minimization 15 Sep, I11) | ITS queue visibility before assignment. F10 grants access only after a recruiter accepts an assignment, but a recruiter must see enough to accept. Default: the queue lists kind, SLA due time, company name, role title, and the first 120 characters of the request; the full context snapshot and any tenant record open only after claim, which creates the time-limited grant (until resolution plus 24 hours, at most 14 days) and is audited. | as stated | default; confirm |
| D25 | Break-glass depends on MFA (F10, F11). Until Supabase Auth with TOTP is live, break-glass is refused with a clear error; there is no interim bypass. | refused until MFA exists; **since 18 Sep the session carries `mfa_verified_at` from the identity service's `amr` claim and break-glass passes with a second factor verified in the last 15 minutes (tested with the fake issuer)** | default |
| D26 (approved 15 Sep, I12; editable calendar required) | Business-hour SLA mapping for existing escalation kinds: `candidate_issue` four business hours; `ask`, `review`, `search_support`, `stuck_role` one business day; `negotiation` two business hours; `takeover` one business day; platform-blocking issues are support tickets, acknowledged within two business hours; security or privacy requests (data requests) acknowledged within one business day. Holidays: US federal holidays list maintained in code. | as stated | default; confirm holiday list |


## H. Execution log

| Date | Slice | What changed | Verification |
|---|---|---|---|
| 14 Sep 2026 | 1. Database and tenant security (F1) | `migrations/0003_platform_roles.sql`: non-privileged `ros_app` and `ros_worker` roles (NOSUPERUSER, NOBYPASSRLS), grants, membership in `app_tenant`, the API role cannot claim jobs; every table with a `company_id` re-policied with a null-safe tenant clause and an explicit platform clause that `app_tenant` can never use. `packages/db/src/client.ts`: connections enter platform mode themselves, `withTenant` switches role and clears platform mode, `inspectConnectionRole` and `problemsWithConnectionRole` back a boot check that refuses a superuser or RLS-bypassing role in production; migrations are a release step (`MIGRATE_DATABASE_URL`), never run on boot in production; the worker connects with `WORKER_DATABASE_URL`; `WORKER_INLINE` is refused in production. The tenant header is gone from the middleware, CORS, and the web client; tenancy comes only from the session's verified active membership; platform staff get no tenant context by default. | `packages/db/src/rls.test.ts` (8 tests: every company_id table protected, 18 tables seeded and isolated, cross-tenant insert/update/delete/move rejected, tenant role cannot use platform mode, app role blind outside platform mode, job-claim privilege split, boot check); `apps/api/src/tenancy.test.ts` (header ignored, cross-tenant 404, switch requires membership, staff denied). S1, S2 (default access) closed. |
| 14 Sep 2026 | 2. Recruiter-access controls (F10, F12, D24, D25, D26) | `migrations/0004_staff_access.sql` and `staff_access_grants`: grants are created only when a recruiter accepts an escalation (scope: the escalation's company, role, candidate; 14 days, shortened to 24 hours after resolution) or by admin break-glass (refused until MFA exists). The queue shows kind, SLA, company, role, and a 120-character preview before acceptance; the full context opens only under a grant; every request inside a customer writes an audit record with route, grant, purpose, and expiry, and the customer's own event log shows `recruiter.access_granted` and `recruiter.access_ended`. Scope guards limit staff to the granted role and candidate. Business-hour SLAs (`packages/core/src/business-hours.ts`) replace wall-clock SLAs; candidate copy states the expectation that is true when written; recruiters record minutes spent and the response time is computed. | `apps/api/src/staff-access.test.ts` (6 tests), `packages/core/src/core.test.ts` business-hours cases, existing suites updated to business-hour SLAs. S2 closed. D11, D14, D24, D25, D26 implemented. |
| 14 Sep 2026 | 3. Secrets and OAuth-token protection (F1, D21) | `packages/integrations/src/secrets/`: a `SecretStore` interface with a Supabase Vault implementation (parameterised `vault.create_secret` / `vault.decrypted_secrets` / `vault.update_secret` / delete; the application keeps only the secret id) and a memory store for development; `SECRET_STORE=vault` is required in production and `APP_ENCRYPTION_KEY` and all application-side cryptography are removed; `packages/db/scripts/vault-grants.sql` lets the worker role read decrypted values and the API role only write; the database handle exposes a parameterised `query` for the store. No OAuth tokens exist yet (calendar arrives in slice 5); the store is in place before them. | `packages/integrations/src/integrations.test.ts` (memory round trip; vault statements never embed values; registry selection). S3 closed as a design; verification against a real Supabase project is pending accounts (D23). |
| 14 Sep 2026 | 4. Misleading-copy corrections and verified channel states (F4, F6, F8, F14) | Job-board and service adapters report only the five states (live and verified; submitted, awaiting verification; manual action required; not connected; failed): the careers page is live and verified, Google for Jobs awaits verification with Search Console instructions, email-in is live only with a configured inbound domain, Indeed, LinkedIn and ZipRecruiter are manual with instructions; the LinkedIn feed no longer claims "live". Sender: `EMAIL_FROM_ADDRESS` (`updates@hire.identifiedtalent.com` in production) with the customer's hiring team as display name and a monitored ITS reply-to until the platform inbox exists (slice 7). Copy: no "within a minute", "within a few days", or "scheduling details are on their way"; the advance-to-interview reply says scheduling is not yet available; candidate hand-off copy states the business-hour expectation. Design Partner plan (`design_partner`, $0, three active roles, unlimited seats, 90-day term with extension, labeled "Design Partner"), assignable by a platform admin (`POST /admin/customers/:id/plan`), shown in Setup with usage; a billing limit never interrupts a design partner's active candidate process (the screen proceeds; the owner and ITS are told). | app, scenario and Slice-2 suites updated for the new states; a new Slice-2 case for the design-partner soft limit; `pnpm eval` unchanged. A6, A8, A10, P3, P4, P7, P8 closed. |

Automated checks run after each slice: `pnpm typecheck` (0 errors), `pnpm test` (94 tests, 6 todo), `pnpm eval` (7 suites on the fake provider). Not yet available: browser accessibility checks (axe) and UI journeys (Playwright); they are part of the Next.js migration (D20) and will run from that point. Nothing in slices 1 to 4 has been exercised against a real Supabase, Vercel, Trigger.dev, Postmark, or Google account (D23).

### Stop point before slice 5

Slice 5 (Google Calendar scheduling with manual fallback) is the first slice that needs decisions and accounts that are still open:

- D19 (Supabase Auth replaces the internal magic links; MFA for staff) and D20 (the Next.js application on Vercel with the existing Hono API mounted inside it) are the platform migration that F7 and F11 imply; they are large and should be confirmed before the scheduling UI is built, so it is built once.
- D22 puts `schedule_interview` on Trigger.dev first; a Trigger.dev organization and API key are needed to run it anywhere but in unit tests.
- D23 accounts: Supabase (two projects), Vercel, Trigger.dev, Sentry, PostHog, Postmark with `hire.identifiedtalent.com` DNS, a Google Cloud project with the Calendar API and an OAuth consent screen, Twilio for 10DLC (F5), an Anthropic key with a spend limit.
- Counsel register items 1, 3, 4, 5, 6, 11, 12, 13 block live candidate flows; none blocks development.

---

## I. Founder decisions recorded 15 September 2026 (consolidated; these replace conflicting defaults)

| # | Decision | Effect on earlier items |
|---|---|---|
| I1 | Current facts: ITS does not use Google Workspace; `identifiedtalent.com` is registered with GoDaddy and ITS controls its DNS; Paul is the current super administrator, Nadine is not yet; the accountable human owners of the infrastructure are Nadine and Paul; Claude is the developer with no account and receives only code context, environment-variable names, test results, and non-secret references; never passwords, codes, API keys, recovery codes, or secret values. The email provider is determined first, not assumed; no email migration and no Google Workspace for this product. | `12` §1 rewritten. Email provider determined from public DNS on 18 Sep 2026: Microsoft 365 through GoDaddy with Proofpoint Essentials filtering; pending Paul's confirmation in the admin console (the one open infrastructure fact). |
| I2 | Two named human owners (Nadine, Paul) on every critical service; `platform@identifiedtalent.com` is a licensed operational mailbox for notifications, provider correspondence, security alerts, calendar-integration administration, and non-human service ownership only; it is never an accountable owner, sole owner, Workspace super administrator, shared human login, sole recovery path, or a way to obscure who acted. | Supersedes the 14 Sep draft's use of `platform@` as second owner. |
| I3 | No developer or contractor mailbox now; if one is hired later: named ITS address, least privilege, staging by default, MFA, dated purpose, removal at end, staging credential rotation; no generic accounts. | `12` §3. |
| I4 | Addresses to create through the existing ITS email provider: `platform@` (licensed), `billing@`, `support@`, `privacy@`, `security@`, `dev-alerts@`, `recruiting-replies@`, with the stated delivery; privacy and security never depend on the support inbox. | `12` §4. |
| I5 | GoDaddy: separate named access for Nadine and Paul, no password sharing, MFA, ITS-controlled recovery, emergency information in the vault, full zone export and documentation, no name-server change, no overwriting of MX, SPF, DKIM, DMARC, every change prepared for Nadine's review; the ITS website and email must not be at risk. | `12` §6; proposed records in `13` appendix B. |
| I6 | Hostnames reserved: `app.` (application), `hire.` (outbound email), `apply.` (inbound), `jobs.` (job pages); no records until the zone is documented and providers supply exact values. | New contradiction A13: `app.identifiedtalent.com` already exists (CNAME to `whitelabel.ludicrous.cloud`); proposed replacement `recruiting.identifiedtalent.com` (decision A8). |
| I7 | 1Password Business with named human accounts for Nadine and Paul; five vaults; access rules; digital backup codes in 1Password; one sealed offline recovery package at ITS. | `12` §8. |
| I8 | D19 approved: Supabase Auth with Google and Microsoft sign-in, email recovery, required TOTP MFA for ITS recruiters and platform administrators, MFA for customer administrators before general release, revocation on removal, rate limiting, suspicious-login monitoring, shorter administrative sessions; Google is not assumed to be ITS's identity provider; candidate access by expiring, signed, single-purpose, non-sequential, revocable, scoped links with access events; break-glass disabled until MFA enforcement, expiration, immutable audit logging, and notification are verified. | D19 → approved with conditions; D25 stands. |
| I9 | D20 approved: one Next.js application on Vercel; the Hono API retained and mounted; Trigger.dev for durable workflows, timers, retries, reminders, scheduled work; Supabase for Postgres, auth, storage, Vault; long-running work never depends on a Vercel request; separate staging and production; production candidate data never copied to development or staging. | D20 → approved. |
| I10 | D21 approved: Supabase Vault for production integration credentials; application users cannot read secrets; the API may write a new OAuth credential after authorization; only the authorized worker role reads or decrypts; secret reads and changes are audited; revoked integrations delete or invalidate credentials; tokens never appear in logs, errors, analytics, audit records, support messages, screenshots, or documentation; development keeps the memory adapter; no credential reuse across environments; documented rotation and revocation. | D21 → approved; slice 3 implementation must add audited reads (worker) and revocation deletion in slice 5. |
| I11 | D24 approved with strict data minimization: before acceptance a recruiter sees only customer name, role title, escalation category, urgency, remaining SLA, required expertise, and a general issue summary; never candidate identity, contact, resume, transcript, compensation, evaluation, interview notes, or other sensitive data; after acceptance the scoped grant as specified; audit preview, acceptance, grant creation, purpose, records viewed, actions, resolution, release, expiration; the customer's event history shows access start and end. | D24 → approved; the slice-2 queue preview (a 120-character request excerpt) must be replaced by a category, urgency, required expertise, and a generic summary that cannot carry candidate details; preview views must be audited. Scheduled as the first task of slice 5. |
| I12 | D26 approved: Monday to Friday, 9:00 to 17:00 Pacific, observed US federal holidays, plus administrator-configurable ITS closure dates, stored in an editable business calendar rather than hard-coded in workflows; SLAs: candidate requests a person 4 business hours; candidate or shortlist advice 1 business day; offer or counteroffer support 2 business hours; production-blocking issue 2 business hours; privacy or data request acknowledged within 1 business day; ordinary support 1 business day; deadlines calculated and displayed; no vague timing; response time and recruiter minutes recorded. | D26 → approved; the slice-2 hard-coded holiday set becomes an editable calendar (slice 5 first task). |
| I13 | Ownership rules for every service (Nadine and Paul; `billing@`; `security@`; MFA; ITS-controlled recovery; US regions; least privilege; spend alerts before the first live deployment; record cards); no personal Gmail, contractor, or Claude-session owners; documented primary owner, secondary administrator, recovery, emergency access, and provider limitation where two equal owners are unsupported. | `12` §5; `13`. |
| I14 | Revised creation sequence (20 steps) beginning with confirming the email provider and administrative roles, securing GoDaddy, exporting DNS, creating mailboxes, the vault, then GitHub, Supabase, Vercel, Trigger.dev, Postmark (DNS only after review), Google Cloud, Sentry, PostHog, Anthropic, Twilio, Entra deferred, then recording identifiers; nothing created by Claude. | `12` §12; `13` appendix C. |
| I15 | No Google Workspace adoption; Google Cloud only for the Calendar API under an ITS-controlled identity model documented before creation; Google Calendar first unless ITS email is Microsoft 365 and the first design partners primarily use Outlook, in which case a short recommendation is presented; a complete manual fallback regardless; OAuth verification never blocks the pilot. | ITS email is Microsoft 365 (condition 1 met); design partners' platform unknown (condition 2 open). Recommendation in `12` §10: Google first for the wedge, Microsoft soon after for recruiter-run searches; ownership model: Cloud Identity Free (`12` §9). |
| I16 | A founder-facing account-creation worksheet before accounts are opened, with signup URL, creator, owners, billing, recovery, MFA, region, plan, spend limit, roles, environment and project names, DNS changes, environment-variable names, where secrets are placed, verification, revocation, rotation; no secrets anywhere but the providers' stores and the vault. | `13`. |
| I17 | Design Partner plan retained at $0 (three active roles, unlimited team members, reasonable applicant volume, email and web screening, manual scheduling fallback, ITS recruiter support, no card, no interruption during an active search, 90-day term with extension); "Design Partner" never "Free Trial"; billing limits never interrupt active candidate communication or a live hiring process; a pilot agreement covering beta status, data handling, permitted use, support, feedback, service limitations, human decision responsibility, security and privacy, term and termination. | F8 confirmed; counsel item 14 expanded. |
| I18 | Post-interview human-only actions (advance to another interview, move to offer review, request more evidence, place on hold, decline with a job-related reason free of protected information); AI may summarize evidence, identify conflicting feedback, highlight missing scorecards and information, recommend follow-up questions, draft candidate communication; AI may not decide, auto-advance, auto-decline, send decision communication before confirmation, set compensation, send or negotiate an offer. | F9 confirmed with "draft candidate communication" added to the permitted list; slice 6. |
| I19 | Counsel register with the specified columns and eighteen review items; Nadine owns founder decisions; California employment counsel and privacy/technology counsel review; delivered immediately; synthetic data only for unreviewed features; no real screening, automated eligibility treatment, SMS, recording, or production candidate data until review is complete. | `11` rewritten and delivered 18 Sep 2026. |
| I20 | The five integration states continue; no "live" from generated code or a configuration screen; no scheduling promises, no saved-progress claims before secure persistence, no boards shown live without confirmation, no response times outside the SLA, no AI recommendation described as a decision, no mocked activity described as production. | Enforced in slice 4; applies to slice 5 ("connected" only after a real staging OAuth, Vault storage, permission verification, revocation test, and a full staging journey). |
| I21 | Slice 5 authorized with mocked provider adapters: calendar-provider interface, Google adapter (unless Microsoft is selected), manual availability fallback, candidate availability collection, time-zone and daylight-saving handling, conflict detection, booking confirmation, ICS, rescheduling, cancellation, reminders, expiration, idempotency, duplicate-event protection, retries, disconnection recovery, audit events, human approval before scheduling, accurate candidate and owner status. | Begins after the 15 Sep materials are delivered (this stop point). |
| I22 | Accessibility and browser-journey automation added during the Next.js port; the first journey covers role approval through scheduling and audit; WCAG 2.2 AA for the private beta with the listed requirements. | `10` §1 amended. |
| I23 | The six scenario TODOs are completed before release 1 or formally classified (reason, owner, risk, target release); before real candidate data: cross-tenant isolation, recruiter-access, OAuth-token security, authentication, MFA, candidate-link authorization, calendar retry, integration-revocation, audit-completeness, accessibility, browser-journey, backup and recovery, error-monitoring verification, production boot checks, counsel clearance. | Release gates in `10` §9 amended. |
| I24 | Required outputs before account creation: updated `12`, updated register, updated index, change summary, the email-provider question named as the one unresolved infrastructure fact, the worksheet, the revised order, every environment-variable name, every proposed DNS record, and the list of work that continues with mocks; then stop. | Delivered 18 Sep 2026. |

### Contradictions and decisions added on 18 September 2026

| ID | Item | Resolution | Status |
|---|---|---|---|
| A13 | `app.identifiedtalent.com` is already a CNAME to `whitelabel.ludicrous.cloud` (an existing vendor), so I6's application hostname cannot be used without confirming what runs there. | Proposed `recruiting.identifiedtalent.com` for the application; `jobs.` for job pages as approved. | **needs founder** (A8) |
| A14 | The root domain has no DMARC record and no visible DKIM; product email is isolated on `hire.` with its own SPF, DKIM, and DMARC, so the product is unaffected. | A root DMARC record is listed as optional ITS hygiene for Nadine's review; not a product change. | informational |
| A15 | The email provider fact (I1) is determined from DNS (Microsoft 365 through GoDaddy with Proofpoint Essentials) but not yet confirmed by an administrator. | Paul confirms in the Microsoft 365 admin center or GoDaddy Email & Office; the only unresolved infrastructure fact. | **needs Paul** |
| A16 | Slice 2 built the queue preview as a 120-character excerpt of the customer's request, which could contain a candidate's name; I11 forbids candidate identity before acceptance. | Replace with category, urgency, required expertise, and a generic summary; audit preview views. | **done 18 Sep (slice 5 step 1)**; was: scheduled first in slice 5 |
| A17 | Slice 2 hard-coded the holiday list; I12 requires an editable business calendar with ITS closures. | Add a `business_calendar` setting with an administrator editor; workflows read it. | **done 18 Sep (slice 5 step 2)**: `business_calendar_versions`, admin editor, recalculation |
| A18 | Slice 3's secret store does not yet audit reads or delete on revocation because no integration exists; I10 requires both. | Implemented with the first calendar connection in slice 5. | scheduled |

### Stop point (18 September 2026)

Delivered: `12` (governing), `13` (worksheet with appendices A to E), `11` (counsel register), this section, the index. Not created: any external account, DNS change, credential, or production connection. Open items before accounts are opened: A8 (application hostname) and A15 (Paul confirms the email provider). Slice 5 with mocked adapters is authorized and starts with A16 and A17.


## J. Corrections and decisions of 18 September 2026 (founder review of `11`, `12`, `13`)

| # | Correction | Applied |
|---|---|---|
| J1 | A8 approved: `recruiting.identifiedtalent.com` for the application; `jobs.`, `hire.`, `apply.` retained; `app.identifiedtalent.com` preserved untouched until ITS identifies the service. | `12` §1, §7; `13` §5, §8, appendix B. No code referenced `app.`; production URLs are environment values. |
| J2 | Email-provider finding recorded as "expected Microsoft 365 through GoDaddy with Proofpoint Essentials; pending Paul's confirmation"; nothing else waits. | `12` §1 (A15 wording). |
| J3 | Google Calendar first with the manual fallback; partner platform recorded at onboarding; Microsoft when a partner requires it, ITS runs its own searches, or Google no longer covers the cohort; not both at once. | `12` §10. |
| J4 | Microsoft Entra split: a sign-in registration (identity scopes only) is required for release 1 and configured in Supabase Auth; the calendar registration (`Calendars.ReadWrite`) is deferred. | `12` §10a, §12 step 9a; `13` §4a, appendix A; `10` gates. |
| J5 | Cloud Identity: Nadine or Paul is the initial administrator; both become the named organization administrators; `platform@` only later with the minimum role, never super administrator; bootstrap exception documented. | `12` §9; `13` §8. |
| J6 | No automatic candidate rejection in release 1: hold, notify, timer, reminders, escalation; only a person declines; decline communication only after the recorded decision. | Code: `application.hold_ineligible` policy, `application.reject_ineligible` hard human-only, the `ineligible_review` step, human decline sends the disposition; state machine forbids system rejection from `ineligible`; `11` item 3; `01`, `03`, `06`; UI copy. |
| J7 | Privacy requests pilot-ready: published address, request method, verification, recording, deadline tracking, access/correction/deletion or anonymization, completion, escalation, restricted visibility; manual runbook acceptable. | `docs/runbooks/privacy-requests.md`; `PRIVACY_EMAIL` on the privacy and status pages; `11` item 6; `09`; `10` gates. |
| J8 | Retention periods are proposed defaults per category pending counsel; no irreversible automatic deletion in production. | `05` §6 (eleven categories); `09`; `11` item 9. |
| J9 | Supabase service-role key restricted: not provisioned to the application in release 1; documented purpose and permitted locations; guard test. | `13` appendix A; `tests/policy/service-role-guard.test.ts`. |
| J10 | Secret remediation before any real OAuth connection: audited reads, deletion on disconnect, no tokens in logs, Sentry, PostHog, or audit payloads, revocation tests, failed-deletion alerts. | Done: slice 5 step 3 (section K). |
| J11 | Queue preview remediation with the exact allowed fields and an automated test. | Done: slice 5 step 1 (section K). |
| J12 | Editable business calendar (hours, time zone, holidays, closures, temporary coverage, effective dates; audited; existing deadlines retained unless explicitly recalculated; tests). | Done: slice 5 step 2 (section K). |
| J13 | Counsel register: administrative tracking fields added; pilot agreement, privacy notice, and privacy runbook are release-1 requirements before real data; terms may follow if the pilot agreement governs and counsel approves. | `11`. |
| J14 | PostHog off candidate pages; privacy-preserving server-side funnel events with keyed identifiers only. | Code: `packages/integrations/src/analytics` (mapping, adapters, event sink); `13` appendix A. |
| J15 | Slice 5 authorized with mocks in the stated order; no external accounts, DNS, real OAuth, credentials, or real candidate data. | Begins now. |

Disagreements or limitations noted: none that change a decision. Two practical notes: (a) "application started" cannot come from a domain event, so the apply page emits it server-side with a per-visit random reference and no cookie; (b) Cloud Identity Free needs a mailbox on the domain for the first administrator, which an ITS Microsoft 365 mailbox satisfies, so no `platform@` bootstrap is needed.


## K. Slice 5 execution log (authorized 18 September 2026; synthetic data and mocks only)

| Step | Scope | Status | Evidence |
|---|---|---|---|
| 1 | Recruiter queue-preview remediation | done 18 Sep | `packages/core/src/escalation-preview.ts` (allowed fields, forbidden keys, category defaults for urgency, expertise, template summaries); list, detail, admin view, queue email and grant purpose carry the preview only; `escalation.preview_viewed` audit per customer per view; customer may set urgency; `apps/api/src/queue-preview.test.ts` (6 tests) and updated assertions in `staff-access.test.ts`, `app.test.ts` |
| 2 | Editable business calendar | done 18 Sep | `business_calendar_versions` (migration 0005; immutable versions with effective dates; tenant role read-only); `packages/core/src/business-hours.ts` rewritten around a calendar source with per-day version resolution, multiple windows per day, closures, coverage changes, any IANA zone; `business-calendar.ts` (load, publish with `calendar.changed` audit, explicit recalculation with `escalation.sla_recalculated` audit and `recruiter.sla_recalculated` tenant event); admin API and "Business calendar" tab; customer and candidate copy generated from the calendar in force; `core.test.ts` (weekends, observed holidays, fall-back and spring-forward, outside hours, multi-day, closures, coverage changes, another zone, effective dates inside one deadline, remaining time) and `apps/api/src/business-calendar.test.ts` (7 tests) |
| 3 | Secret-read auditing and credential-deletion remediation | done 18 Sep | `packages/contracts/src/security/redact.ts` (secret shapes, key patterns, redaction, detection, fingerprint); `packages/core/src/secrets.ts` (audited store/read/rotate/delete with service, purpose, tenant, integration, time; in-process value registry; `guardOutbound` on every event payload and audit record); `connections.ts` (connect, read for a stated purpose, disconnect that disables at once and queues `integration.revoke_and_delete`, worker-side revoke and delete, failed-deletion alert and retry); `alerts.ts` + `admin_alerts` (migration 0006, with `integrations.secret_ref` and lifecycle columns); engine job-handler registry; fake provider revoker; Sentry scrubber and PostHog property scrubbing; redacted error handler and request log; `GET/POST /integrations`, admin alerts and retry routes, Failures tab; tests `apps/api/src/secret-lifecycle.test.ts` (6), `packages/core/src/secrets.test.ts` (5), observability test. Note: provider-side revocation runs in the worker because only the worker role may read the value; the connection is unusable from the moment of disconnect. |
| 4 | Microsoft sign-in architecture correction | done 18 Sep | `packages/integrations/src/identity` (provider interface; dependency-free JWT verification HS256/RS256/ES256 with issuer, audience, expiry and subject checks; `SupabaseIdentityProvider` with PKCE authorize and code exchange, identity scopes only for Microsoft; `FakeIdentityProvider` minting tokens in the same format with a development consent page); `packages/core/src/identity.ts` (sign-in policy: verified email; staff = platform role or `ITS_STAFF_EMAIL_DOMAINS`; staff must use Microsoft and `aal2`; eight-hour staff sessions; `session.opened` and `signin.refused` audits without the token; subject linking); migration 0007 (`users.auth_provider/auth_subject`, `sessions.identity_provider/aal/mfa_verified_at`); routes `/auth/config`, `/auth/start/:provider`, `/auth/callback`, `/auth/session`, fake consent page; magic link refused for staff domains and off by default in production; `/auth/me` reports the assurance level; break-glass (D25) now passes with a fresh second factor; Login page with provider buttons; production refuses `AUTH_PROVIDER=fake`. Tests: `apps/api/src/identity.test.ts` (9). |
| 5 | Next.js shell with Hono retained | done 18 Sep | `apps/shell` (Next.js 15, App Router): catch-all route handlers for `/api`, `/careers`, `/c`, `/webhooks`, `/feeds`, `/dev`, `/privacy`, `/healthz` hand every request to the unchanged Hono application (`lib/hono.ts`; one container per process on `globalThis`, inline worker outside production only); the signed-in interface is the existing React application mounted client-side at the root (`components/SpaApp.tsx`) and is ported route by route from here; workspace packages transpiled, database drivers external; `next build` succeeds and the dev server answers the API, the candidate pages and the fake sign-in page; path resolution made bundler-safe (`ROS_REPO_ROOT`, `ROS_MIGRATIONS_DIR`); `apps/shell/lib/hono.test.ts` (2). The Vite app stays as the fast development server until the port completes. |
| 6 | Calendar-provider interface | done 18 Sep | `packages/integrations/src/calendar/types.ts`: consent URL, code exchange, free/busy, idempotent create/update/cancel by key, probe, revoke; typed errors (`auth_revoked`, `rate_limited`, `transient`, `not_found`, `conflict`, `not_configured`) with a retryable flag; narrow Google scopes (events + free/busy). Registry `integrations.calendars` keyed by provider so Microsoft is added without touching the scheduling domain. |
| 7 | Manual availability and ICS fallback | done 18 Sep | `interviewer_availability` (migration 0008; zone, weekly windows, buffer, daily maximum); `GET /me/calendar`, `PUT /me/availability` (signals waiting runs); `membersWithCalendarStatus` on the members route; Setup "My availability" card; `packages/core/src/ics.ts` (RFC 5545 REQUEST/CANCEL, folding, escaping, UTC); the confirmation email attaches the invitation and the candidate page serves `/c/schedule/:token/ics`. |
| 8 | Google Calendar mocked adapter | done 18 Sep | `FakeGoogleCalendarProvider` (consent page, single-use codes, scripted busy time, idempotent events with conference links, probes, revocation, scripted failures) is the development and test provider; `GoogleCalendarProvider` implements the same interface over the documented REST endpoints and is verified with a fake fetch only (no Google project exists, docs/spec/13 §8); `CALENDAR_PROVIDER`, `GOOGLE_OAUTH_CLIENT_ID/SECRET`. Per-person connections are `integrations` rows of kind `calendar` with `user_id`; the refresh token lives only in the secret store (step 3 lifecycle: audited reads for `calendar_sync`, `calendar_booking`, `revocation`; deletion on disconnect). Connect, callback and disconnect routes under `/integrations/calendar/:provider`. |
| 9 | Scheduling workflow | done 18 Sep | `schedule_interview` (`packages/workflows/src/definitions/schedule-interview.ts`): prepare (asks the team when nobody's availability is known, waits on `availability.updated`), propose_slots (`packages/core/src/scheduling.ts`: declared windows in each person's zone, calendar busy time, buffers, daily maximum, existing bookings, business days, 24-hour lead, spread-out starts), offer_slots (14-day token, disclosed email listing times in the candidate's zone), after_offer/remind/expire_offer (48 h + 48 h), book (re-check, `slot_taken` re-offer, three strikes → owner told + recruiter escalation; one calendar event per connected participant keyed `interview:<id>:<attempt>:<user>`), confirm (invitation attached, both zones, interviewers notified and emailed), on_timer (−24 h, −2 h reminders, close at end + 1 h), close (stage `interview_complete`, outcome and decision prompts). Routes: `POST /applications/:id/interviews` (the human approval; `interview.request` cannot drop below approval), `POST /applications/:id/decision`, `GET /roles/:id/interviews`, `GET /interviews`, `GET /interviews/:id`, reschedule, cancel, outcome, book-on-behalf; candidate pages `/c/schedule/:token` (pick in own zone, accessibility note, none-of-these-work with availability note), confirmed, ics, reschedule (twice, then a person), cancel; status page card. Reschedule and cancel end the old run by attempt number, queue `interview.cancel_events` for the worker, and start a fresh run. Web: Interviews page and sheet, interview approval sheet on the candidate, Setup availability. Tests: `packages/core/src/scheduling.test.ts` (slots across zones and the daylight-saving change, buffers, daily maximum, re-check, grouping, ICS), `packages/integrations` (fake and real providers), `apps/api/src/scheduling.test.ts` (9 end-to-end scenarios: no availability → declared hours; pick, book once, confirm with ICS, remind, close, decide; calendar free/busy, single event with a conference link, cancel removes it; slot taken → re-offer; reschedule twice then a person; none-of-these-work → owner, reminder, expiry, dead link; revoked credential → declared fallback + alert + disconnect deletes; book on behalf, outcome). |
| 10 | Accessibility and browser-journey automation | done 18 Sep | `tests/e2e` (Playwright + axe-core, Chromium) runs against the Next.js shell on an in-memory database with every provider faked. Journeys: sign-in through the fake consent page → company setup form → (role and applicant seeded through the API with the browser's session) → job page and apply form → declare availability in Setup → open the candidate, approve an interview → candidate status page → pick a time in another zone by keyboard with an accommodation note → confirmed page and ICS → Interviews page and sheet (the note is visible) → reschedule → the candidate is offered times again; staff sign-in policy in the browser (Google refused with guidance, Microsoft without a second factor refused, Microsoft with it accepted). Every visited page (13) passes WCAG 2.1 A/AA plus best-practice rules. Fixed on the way: muted text and semantic colours below 4.5:1 (`--ink-3`, `--needs-you`, `--caution`, candidate-page `--ink3`), pages outside the shell lacking a `main` landmark, the loading skeleton's prohibited `aria-label`, empty table headers for action columns, and the Interview action hidden for candidates in process. `pnpm e2e`; report in `tests/e2e/report`. |


## L. Founder instruction of 18 September 2026 (afternoon): continue release 1 locally

Nine work items, executed in order with synthetic data and fakes; no external account, DNS change, credential, real service, real candidate data, SMS activation, recording, Microsoft calendar, sourcing, voice screening, automatic rejection, or production infrastructure.

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Six scenario TODOs | done | steps 11 to 13 built and tested; 12b, 13b, 14, 15, 16 deferred with reason, risk, owner and release (`docs/spec/15`; `tests/scenario/lifecycle.test.ts` records the deferrals and asserts none is a security, privacy, tenant-isolation, authentication, communication, scheduling, accessibility or audit test) |
| 2 | Steps 11 to 16 defined with the sixteen fields | done | `docs/spec/15-scenario-steps-11-16.md`; release-1 parts implemented (interview outcome, human decision after interview) |
| 3 | Next.js route port | done | `apps/shell/app` final routes with server-side session and permission checks, loading, error, not-found, mobile breakpoint; the Vite entry retired; `docs/spec/16-route-inventory.md`; `tests/e2e/specs/routes.spec.ts` on desktop and iPhone; `next build` passes |
| 4 | Candidate privacy-request workflow | done (built with mocks; deletion gated on counsel) | `data_requests` (migration 0009), `packages/core/src/privacy-requests.ts`, candidate status-page form, admin console tab, acknowledgment and completion messages, deadline alerts, `privacy-requests.test.ts` (7) |
| 5 | Email failure handling | done (built with mocks) | webhooks `/webhooks/postmark/bounces|spam|events` with secret and receipt dedupe; `email_suppressions`; guard on every send; retries (4 h, 24 h), suppression after two soft bounces in a week; owner notification and text fallback; administrator alerts; release with reason; `email-failures.test.ts` (6) |
| 6 | Production-readiness documentation | done (all items marked; nothing mocked is labelled production-ready) | `docs/readiness/01` to `12` |
| 7 | Legal drafts for counsel | done (drafts, clearly labelled, not approved) | `docs/legal-drafts/` |
| 8 | Expanded automated testing | done | `security-coverage.test.ts` (tenant isolation, candidate-link authorization, audit completeness, analytics payload privacy, scheduling retries and calendar fallback) plus the suites named in `docs/readiness/10`; full runs recorded in `docs/spec/14` and below |
| 9 | Staging handoff package | done | `docs/spec/17-staging-handoff.md` |

Additions to the register from this work: `PLATFORM_ADMIN_EMAILS` seeded the first administrators on their first Microsoft sign-in with a second factor (audited) — replaced on 21 Sep by the one-time `BOOTSTRAP_ADMIN_EMAILS` and the `platform_role_grants` ledger (section N); the email guard keeps an in-process copy of the suppression list refreshed every minute; the shell holds one application container per process (restart `next dev` after API changes).


## M. Founder decisions recorded 21 September 2026

| # | Decision | Status | Applied |
|---|---|---|---|
| M1 | Privacy-request deadline: 45 calendar days, provisional pending counsel. Reminders and internal escalation before the deadline. The deadline is an operating rule, not legal advice, and is never represented as such. | recorded | `PRIVACY_REQUEST_SLA_DAYS = 45`; alerts at ten days before and when overdue; internal escalation at five days before when unassigned or unresolved (this instruction, item 0); wording in `docs/readiness/09`, the runbook and the privacy notice draft says "provisional, pending counsel" |
| M2 | SMS stays disabled until counsel approves the consent and messaging workflow, A2P 10DLC registration is complete, and a design partner requires texting. All three. | recorded | `SMS_PROVIDER=fake`; the handoff (`17` §9) and the readiness register carry the three conditions |
| M3 | Microsoft Calendar remains deferred until a confirmed design partner requires it. | recorded | no Microsoft calendar adapter; the provider interface stays ready |
| M4 | The real-candidate readiness gates are not founder-approved yet. A plain-language founder version comes first (`docs/readiness/16-founder-readiness-checklist.md`), presented for review; approval is recorded here only when Nadine gives it. | recorded | `docs/readiness/01` §E stays "for review"; the founder checklist is item 8 of the 21 Sep instruction |

## N. Founder instruction of 21 September 2026: ten items, in order

Executed locally with synthetic data and fake adapters; ultracode adversarial review run after implementation. Nothing here creates an account, changes DNS, requests a credential, processes real candidate data, activates SMS or recording, adds Microsoft Calendar, onboarding, automated offers or passive sourcing.

| # | Item | Status | Evidence |
|---|---|---|---|
| N1 | Live-region announcements for intake replies; customer-facing "end this recruiter's access" | done | `apps/web/src/pages/Home.tsx` (polite status region), `Setup.tsx` RecruiterAccess card; `GET/POST /api/v1/companies/current/staff-access*`; `revokeStaffGrant`; permission `staff_access.revoke` (owner, admin); audit `staff.access_revoked`, events `recruiter.access_revoked` + `recruiter.access_ended`; recruiter and queue emailed; escalation reopened; `staff-access.test.ts` (7), e2e journey |
| N2 | Administrator authority through a ledger | done | `platform_role_grants` (migration 0011), `packages/core/src/platform-roles.ts`, one-time `BOOTSTRAP_ADMIN_EMAILS` honoured only while no administrator exists (ignored + audited afterwards; startup warning; console banner), `requirePlatformAdmin` needs `aal2`, self-grant refused, last administrator protected, grant/revoke alerts that the actor cannot acknowledge, emails to every other administrator and the ITS queue; `platform-roles.test.ts` (6); `docs/readiness/13`. No founder email in authorization logic (`.env.example` placeholder only). |
| N3 | Privacy-request creation boundary | done | replays idempotent within 24 h (`data_request.replayed` audit); candidate link tokens redacted from paths and `token=` query strings; withdraw confirmation without inline script; `docs/readiness/14`; `privacy-requests.test.ts` (8) |
| N4 | Human-recorded hiring outcomes | done | `packages/core/src/outcomes.ts`, migration 0012, contracts `RecordApplicationOutcome` (strict: no payroll/tax/identity fields), `POST /applications/:id/outcome`, `POST /roles/:id/outcome` (separate confirmation), `GET /applications/:id/outcomes` with the statement, admin `GET/POST /admin/outcomes*` correction (original kept), permission `outcome.record` (owner, admin, hiring manager, HR), stage rules for `hired`/`declined` by humans, ITS recruiter told by role, analytics `hire_recorded`/`outcome_recorded`/`role_outcome_recorded` (enumerated value only); candidate sheet, role page and console UI; `outcomes.test.ts` (5) |
| N5 | Shared rate limiting | done (provider not selected) | `packages/core/src/rate-limit.ts` (memory, shared-on-counter, fake counter), `apps/api/src/middleware/rate-limit.ts` (17 policies), 429 + Retry-After (JSON / candidate HTML), `security.rate_limited` audit, `security.suspicious_activity` alert, webhook retries safe, hashed keys; `RATE_LIMIT_*` variables; `rate-limit.test.ts` (8); `docs/readiness/15` for the founder |
| N6 | Content-security policy; the founder's words: "Report-only mode initially in staging; a violation review process before enforcement; … no production enforcement until staging reports reviewed" | done (report-only) | candidate policy with per-request nonce (`packages/core/src/csp.ts`, `app.ts`), inline handlers removed from candidate pages, application policy in `apps/shell/middleware.ts` (font hosts only), `POST /api/csp-report`, `csp_reports` table, console review card, `CSP_MODE`; `csp.test.ts` (4), `apps/shell/lib/csp.test.ts` (2), e2e header check; `docs/readiness/18` |
| N7 | CI prepared locally | done (dry run) | `.github/workflows/ci.yml`, `.gitleaks.toml`, `scripts/secret-scan.ts`, `packages/db/src/cli/validate.ts` (`pnpm db:validate`), `scripts/ci-local.sh`; migration 0013 tightens the tenant grant on the job queue (found by the validator); postcss override in `pnpm-workspace.yaml` clears the two high advisories; three moderate dev-tool advisories remain (esbuild via drizzle-kit, vitest 3.x) and are recorded below |
| N8 | Founder readiness checklist | done, not approved | `docs/readiness/16-founder-readiness-checklist.md` (36 gates in five stages, seven fields each) |
| N9 | Skipped-test disposition | done | `docs/readiness/17-skipped-tests.md`: five `it.skip` tests, all deferred features (releases 2 and 3), none hiding release 1 behaviour |
| N10 | Stop conditions | honoured | no account, DNS, credential, real data, SMS, recording, Microsoft Calendar, onboarding, automated offer, passive sourcing, or scope beyond release 1 |

Verification at the end of the work, after the review fixes, as one run of `scripts/ci-local.sh` (the CI workflow by hand): lockfile install; secret scan clean; `pnpm audit --audit-level high` clean (3 moderate remain, all development tooling); typecheck clean; `pnpm db:validate` ok; vitest 27 files, 219 passed, 5 skipped; evals 7/7; `next build` ok; Playwright 11 passed (chromium + phone) with axe on every page, including a browser-driven revocation of recruiter access and a two-reply check of the intake live region.

Additions to the register from this work:

- The tenant role may no longer read, update or delete the job queue (migration 0013); it still enqueues. Found by the migration validator; every suite passes.
- Three moderate advisories remain in development tooling only: `esbuild` reached through `drizzle-kit`'s loader (development server exposure; not used in production), and `vitest` 3.x (`@vitest/mocker` path traversal; fixed in vitest 4). Neither ships to production. Upgrading vitest is a major version and is left for a quiet moment.
- The tab strip in the application wraps on narrow screens, and grid items no longer widen the page (`.stack > * { min-width: 0 }`); found by the phone end-to-end run.
- `PLATFORM_ADMIN_EMAILS` is retired; setting it logs a warning and grants nothing.
- From the adversarial review (ultracode, 21 Sep), fixed the same day: a recruiter the customer removed could re-claim the reopened request (now refused with `revoked_by_customer`); the customer had no way to read the revocation record (new `GET /api/v1/companies/current/audit` and an access-history list in Setup); a failed email to the recruiter was reported as success (now `recruiterNotified` plus an alert); the cached `users.platform_role` column, not the ledger, was what requests trusted (sessions now read the ledger; migration 0014 backfills earlier roles and removes the tenant role's ability to write the column); staff sessions slid to thirty days (now eight hours); the email link could open a session for a role holder on a non-staff domain (refused); the same provider could present a different subject for an existing address (refused as `identity_mismatch`); the sign-in bootstrap ran outside a transaction (now one transaction with a ledger lock; refusal audits re-written after rollback); the person elevated could acknowledge their own elevation alert (refused); recruiter routes accepted sessions without a second factor (refused); audit records could be deleted by application roles (revoked); the live region ignored failed sends (announces them); a revoke reason carried over between recruiters in the form (reset). Privacy boundary: a candidate's human-review words reached the customer through the escalation text (now a generic sentence); the status form accepted kinds it never applied (now the four it offers); the admin email-request route accepted another company's ids (refused); addresses in query strings reached the request log (redacted); a withdrawal skipped the resolution audit and the promised confirmation (fixed); text-message opt-out double-recorded and opt-in stayed offered while texting is off (idempotent; opt-in hidden until `SMS_ENABLED`, decision M2); an anonymized candidate's link still recorded requests (now 410 and inert); replays ignored requests awaiting counsel and concurrent duplicates (fixed with a lock). Outcomes: the old unconfirmed `POST /roles/:id/close` remained (removed); the same outcome could be recorded repeatedly (refused; a talent-pool candidate may still be hired later); HR could decline through the outcome without the decline permission or the candidate's message (permission required; message sent after the decision); corrections accepted any string, no hire date, left the role's close reason stale and never reached the metrics (enums, date, close reason, `outcome_corrected` event); closing a role promised to keep active candidates in the talent pool but did not (it does); impossible dates reached the database (refused); the customer never saw the recorded outcome or the statement (shown on the candidate). Rate limiting: the tenant and provider tiers answered 500 instead of 429 when they tripped (one check function; responses never dropped); keys were unkeyed hashes (now HMAC under the session secret); the client address trusted a client-written header (now the trusted-proxy hop, `TRUST_PROXY_HOPS`); every refused request wrote an audit row (now the first trip and the fifth, with the count in the shared store); junk could spend a provider's webhook budget (only accepted deliveries do); candidate GET pages and feeds had no limit (per-address policy); `code=` reached logs (redacted). Content-security policy: the screening page's second stylesheet had no nonce (fixed; every tag on every page is now checked); structured data was not escaped (an owner's description could close the script element; escaped); meeting links accepted `javascript:` (web addresses only); report fields were unbounded and a recurrence erased the reviewer's note (bounded; note kept); non-id review answered 500 (404). CI: the Playwright report path was wrong so nothing uploaded (fixed, and the report folders are ignored by git); the service-role guard skipped the Next.js app (scanned); the migration validator accepted any policy text and ignored views (policies must scope by the tenant setting; views are refused); the secret scan allowed a whole line on a fixture match (the allowance now applies to the matched value); the gitleaks licence variable for organization repositories is passed through.
- The panel ran five times and the checklist was revised six times (scores of the fifth round, before the last revision: plain language 3 to 4, completeness 4 to 5, grouping 4, honesty 4 to 5 out of 5; the first round scored 3 to 4 across the board). The fifth round's substantive points were applied: the two condition-E provisions are marked as team proposals the founder adopts or strikes at sign-off (section O has rows for them), counsel items 13, 17 and 18 are required before real data, the "who completes it" cells name Paul wherever a secret or a dashboard login is involved, a test-identities gate was added, production stand-up now includes its own administrator bootstrap and recovery option, and Google's reviews are submitted only once production exists. Each round's list was applied, including cross-document fixes it exposed: the counsel-register numbering in `docs/legal-drafts/README.md` now matches `docs/spec/11`; `docs/spec/11` gained item 19 (subprocessor list) and honest "drafted, not reviewed" statuses; the candidate notice text no longer promises automatic deletion; record tables were added to `docs/readiness/04`, `06`, `12` and `18`; `docs/readiness/03` gained the sign-up, application-path, careers, feeds, queue-preview and outcome-correction lines; the register's condition E.1 now carries the two provisions the founder version relies on.
- Readability panel on the founder checklist (three readers: a non-technical founder's view, a lawyer's view, an operations view; scores 3 to 5 out of 5 before revision): the checklist was rewritten the same day to their list: a "Today" status column, a glossary, the register's six statuses explained, approvals tied to numbered counsel-register items, the credential-rotation drill moved before real candidate data, new gates for the outside Google verifications, the AI evaluations on the real model, error-reporting and analytics scrubbing, the worker process, and the founder's confirmation of the outcome wording; the rate-limit choice split from its connection; the terms and pricing gate now says plainly that those documents do not exist; the penetration test labelled as new scope; the sign-off gate restated as the register's condition E with a place to record it (section O below). `docs/readiness/03` gained the staging lines the panel found missing (migrations to 0014, recruiter access and revocation, second-factor refusals, privacy requests end to end, Google verifications, the shared rate-limit store, the browser-protection review, live-model evaluations, outcome wording).
- How the review ran: 28 reviewers (7 items × 4 lenses) produced 160 findings; 3 skeptics judged each. The team fixed the substantive findings while the verification was still running, so most verdicts read "already handled"; the three that survived verification against the fixed code (no browser test of the revoke confirmation, a live-region test that could not tell a stale announcement, and administrator-change emails that could fail silently) were fixed as well. The verification and the readability panel were interrupted once by the account's monthly usage limit and resumed after it reset; the panel's result is recorded below.

## O. Founder sign-off (empty until Nadine signs)

The record gates 4.13 and 5.8 of `docs/readiness/16` ask for. One dated row per decision; nothing here is filled in by the production team.

| Date | Decision | Condition met (register E.1 to E.5) or the provision adopted / struck | Signed by |
|---|---|---|---|
| | The text-screening row counts as verified in staging with texting off (team proposal) | | |
| | Google's reviews may still be pending when the first partner starts (team proposal) | | |
| | Real candidate data may run in production with the browser-protection policy in "report only" until gate 5.1 (team proposal) | | |
| | The first design partner may start with real candidate data | | |
| | Public launch beyond the design partners | | |

## P. Release 1 scope frozen (founder instruction, 21 September 2026, evening)

- The release-1 scope is frozen at the state recorded in sections K to N. No features are added; the five deferred
  scenario steps stay deferred; release 2 does not begin.
- Every external integration stays mocked. No account is created, no DNS is changed, no credential is requested, and no
  real candidate data is processed by the production team.
- The founder handoff is `docs/spec/18-founder-handoff.md` (decisions, accounts in order, what may safely be returned to
  Claude, the staging activation order, every blocker before the first real candidate). The 56 readiness gates grouped by
  who does them are `docs/readiness/19-readiness-by-owner.md`.
- Work the production team may still do without breaking the freeze: fixing defects found by tests or review, keeping
  documents consistent, and, once the accounts exist, the staging verification in `docs/readiness/03`.

## Q. Launch execution (from 22 September 2026)

Founder instruction of 22 September: move from local development into a tightly controlled release-1 pilot, one phase at
a time, with a checkpoint and founder approval between phases. Governing rules restated: scope frozen; no release 2 or 3
features; no provider accounts created by the production team; no secret value in chat (the founder or Paul enters
values on the provider screen the team names); repository private; every DNS record shown with purpose, source and
rollback before it is added; `app.identifiedtalent.com` untouched; `recruiting.identifiedtalent.com` for the
application; synthetic data until every real-data gate has evidence; mocked adapters never called connected; no
automatic rejection; SMS, recording, automated offers, onboarding, passive sourcing and Microsoft Calendar off unless
separately authorized; manual and ICS scheduling fallback preserved.

Founder corrections recorded 22 September:

- 1Password Business is complete: Nadine and Paul are owners, MFA is on, the five planned vaults exist (gate 1.10 done).
- GitHub organization `identified-talent-solutions` with private repository `recruiting-os`; owners Nadine and Paul;
  organization MFA required (founder's statement). Checked by the team on 22 September through the authenticated CLI:
  the API listed one owner (`nmotaweh`) and reported the organization's two-factor requirement as **not** enabled and
  "members can create public repositories" as allowed; reported to the founder for correction in the organization
  settings (Phase 1 checkpoint).

Founder correction, 22 September (later): **Paul will not participate in the Recruiting OS accounts or the GitHub
organization at this time.** Nadine is the sole organization owner for the pilot. Nobody else is invited (not Paul, not
`platform@`, not Claude, not a contractor). Where the readiness documents name Paul for a step (entering secrets, applying
DNS records, running the restore drill, the rotation drill, the tabletop), Nadine acts, or the step is re-assigned in the
Phase 2 account inventory.

**Risk R-OWN-1 (temporary ownership and recovery risk, not a Phase 1 blocker):** a single human owner on the GitHub
organization and on every ITS account means that loss of that account, its MFA device or its recovery codes locks ITS
out of its own code and services. Mitigations in place or required: recovery codes for GitHub and every provider stored
in the 1Password vault (founder attestation recorded below when given); the organization's MFA requirement on; a second
owner added as soon as the founder names one. Review at each phase checkpoint.

Settings the founder reported on 22 September that the authenticated API did **not** confirm at the time of the Phase 1
checkpoint (each with the exact screen given to the founder): the organization's two-factor requirement (reported off),
"members can create public repositories" (reported allowed), and two-factor authentication on the founder's own account
(the organization's "members without 2FA" filter listed it). These are recorded as open until a fresh API read confirms
them; they do not block the code steps of Phase 1.

**Founder attestation, 22 September 2026 (recorded verbatim in substance):** GitHub recovery codes for the `nmotaweh`
account are stored in the "Recovery and Emergency" vault in 1Password Business, outside GitHub. Given in chat by Nadine;
not verifiable by any API. Mitigation for risk R-OWN-1.

**GitHub settings verified through the authenticated API on 22 September (afternoon):** `nmotaweh` is the sole owner
(active); every member has two-factor authentication (the "members without 2FA" filter is empty); the organization's
two-factor requirement is enabled; `recruiting-os` is private; the baseline commits carry the private no-reply address
`332282127+nmotaweh@users.noreply.github.com` as author and committer. "Members can create public repositories" still reads as allowed through the API.

**Provider and plan limitation L-GH-1 (founder record, 22 September 2026; not a failed configuration, not a Phase 1
blocker):** on the organization's current GitHub plan the "Public" repository-creation option is shown checked and
disabled in the interface and cannot be unticked; per the founder's reading of GitHub's documentation, restricting
members to private-only creation needs GitHub Enterprise Cloud, and organization owners can create any repository type
regardless. No Enterprise upgrade is recommended or initiated for the pilot. Compensating controls, decided by the
founder: (1) Nadine is the only organization member and owner; (2) `recruiting-os` is confirmed private; (3) no
additional member is added during the pilot; (4) repository visibility is checked at every release review; (5) any
future member receives access only to the existing private repository; (6) creating additional repositories is outside
the pilot process. The production team re-reads `private: true` on `recruiting-os` at each phase checkpoint.

### Phase 1 checkpoint: secure the source code (22 September 2026)

| Item | Result | Evidence |
|---|---|---|
| Inspection of the working tree | no secret values, no personal address, no candidate document, recording, export or local database outside ignored folders; synthetic names only; no file over 5 MB | this record |
| Secret scan | repository patterns clean; gitleaks 8.30.1 clean over tree and history after allowlisting two literal test fixtures (`email-failures.test.ts:18`, `rate-limit.test.ts:42`), each proven to match only that value | `.gitleaks.toml`; CI step |
| `.gitignore` | environment files (template kept), keys, local databases, exports, recordings, candidate documents, build output, browser-test reports, local tooling | `.gitignore` |
| Repository | `https://github.com/identified-talent-solutions/recruiting-os`, private, default branch `main` | API read |
| Baseline commit | `1456684227ca59cba555dfb46ea4c3f07520ae63`, 378 files, author and committer the private no-reply address | API read |
| Second commit | `0911b24d2af813d7ee93e17d2f39a2eb4826c09b`: required check named `verify`; sole-owner decision and risk R-OWN-1 recorded | API read |
| CI run 1 (baseline) | run 35775158233, success: lockfile install, gitleaks, repository secret scan, dependency audit, typecheck, migration validation, service-role guard + RLS + tenant isolation + unit and integration tests, AI evals on the fake provider, production build, Playwright with axe | Actions |
| CI run 2 (`verify`) | run 35775929825 on `0911b24`: see the checkpoint report | Actions |
| Branch protection on `main` | pull requests required (0 approvals for now; the founder may raise it), required check `verify` (strict), administrators included, force pushes blocked, deletion blocked; proven by a refused direct push ("Changes must be made through a pull request", "Required status check verify is expected") and a refused deletion | API read; push output |
| Dependabot alerts | enabled | API read (204) |
| Tag | `release-1-baseline` on the commit whose `verify` run passed | API read |
| Repository visibility control | plan limitation L-GH-1 recorded with six compensating controls; `recruiting-os` private on every read | this record |
| GitHub Actions policy | repository allows all actions; the workflow uses `actions/checkout`, `pnpm/action-setup`, `actions/setup-node`, `actions/upload-artifact` and a pinned gitleaks release; no permission broadened | API read |

**Phase 1 approved by the founder, 22 September.**

**Phase 2, external account inventory (22 September):** inventory in `docs/spec/19-external-account-inventory.md`,
approved by the founder subject to four decisions recorded there in full: (1) Railway is the worker host (staging
first, hard usage limit, subprocessor); (2) a Supabase Storage adapter with direct-to-storage uploads is authorized as
release-1 infrastructure under fourteen requirements, the service-role key never reaching the application; (3) the
official Sentry SDK is authorized, staging first, with scrubbing proven by a synthetic error; (4) the Upstash adapter is
authorized, staging first, HMAC subjects only, fail-safe documented. Deferrals unchanged; Postmark before real
communications; Supabase production and PITR before real data. First pilot on manual availability and ICS; a Microsoft
365 partner preferred. Railway and Upstash added to `docs/readiness/07` and `docs/legal-drafts/09`.

Decision 3 build record (22 Sep): the official SDK is wired in every process (`docs/spec/13` §9) behind one
process-wide reporting hook, with `sendDefaultPii` off, no replay or session capture, tracing off by default, and
every event scrubbed by shape and by registered secret value; unhandled API errors carry the route only, with candidate
link tokens masked by the same rule the audit log and CSP reports use. Version 10.74.0 rather than the day's release,
because the workspace refuses packages younger than 24 hours. Off until the founder enters `SENTRY_DSN`; the staging
synthetic-error proof (`docs/readiness/03` §5) is still to run.

**Founder decision, 22 September 2026 (evening): skip the synthetic design-partner testing phase and proceed toward a
controlled real-candidate pilot.** Recorded as instructed:

1. Counsel review is deferred.
2. The legal documents stay labelled unreviewed and not attorney-approved (`docs/legal-drafts/README.md`).
3. The absence of counsel approval does not block the first controlled real-candidate pilot.
4. **Risk R-LEGAL-1, founder-accepted, 22 September 2026.** Scope: the initial unpaid design-partner pilot only (one
   partner, one role, US candidates, limited volume, 60 to 90 days, no software charge), run under the drafts in
   `docs/legal-drafts/` as they stand. Compensating controls: the pilot scope and human-decision rules in
   `docs/readiness/20` section C; the minimum candidate transparency and affirmative acknowledgment in section D; data
   minimization in section E; the twenty-two technical blockers in section B, every one proven with evidence before any
   real candidate; the partner's written acceptance of the pilot agreement and data-processing terms labelled
   unreviewed; the incident-response plan with a named lead; the privacy mailbox and the 45-day provisional
   privacy-request deadline (M1); SMS, recording, automated rejection and offers off; daily founder oversight in week one.
5. This decision does not eliminate or reduce any legal or privacy obligation of ITS or the design partner; it records
   that the founder proceeds without counsel's review for this pilot.
6. The risk is surfaced again, as a stop point, before paid customers, additional jurisdictions, SMS, recording,
   automated rejection, a second design partner, or broader release (`docs/readiness/20` section F).

The decision does not authorize skipping technical staging verification. The real-data readiness plan is
`docs/readiness/20-real-data-readiness-plan.md`.

CI note, 22 September: the browser journeys run in CI against the Next.js development server, which reset one
connection mid-test on a documentation-only commit (run 35783580371, `ECONNRESET` on a request the same test had made
successfully seconds earlier). Playwright now retries a failed journey once on CI only; locally a failure still fails.
This is a test-infrastructure setting, not a product change; a production-mode server cannot be used for CI because
the production guards refuse the fake providers.

### Scope amendments of 22 September 2026 (evening)

**Amendment 1, founder-approved: job distribution is release-1 scope.** The founder's instruction is recorded verbatim
in `docs/spec/20-job-distribution.md` appendix A: hosted job pages under `jobs.identifiedtalent.com`, candidate
self-application, mobile-accessible, JobPosting structured data, a sitemap, a documented public feed, board-specific
tracked links (LinkedIn, Indeed, ZipRecruiter, referral, direct, other), source and source detail on every
application, a posting package, manual posting instructions and per-board status, nine posting states, no "live" until
the board URL is verified, stored board URLs, per-posting pause and close, a manual-closure checklist on role close,
volume monitoring and a stop-accepting switch, no automatic rejection of excess applicants, a realistic-volume test,
no tracking parameters in candidate-facing records, the client company named as employer. Operating model: the design
partner owns or authorizes its employer accounts; ITS posts, verifies and closes by hand; one client, one role, the
role's full applicant volume. Partner track (Indeed, ZipRecruiter, LinkedIn) documented, not implemented. Not
authorized: scraping, unapproved board APIs, automated paid sponsorship, passive sourcing, SMS, recording, automated
rejection, automated offers, onboarding. The "before coding" inspection the founder asked for (existing functionality,
missing functionality, infrastructure, tests, launch impact, effect on the Supabase instructions) is `docs/spec/20`
sections 1 to 6; its findings were adversarially verified and two overstatements corrected (a public-URL column
exists but has no route; pausing a role already stops intake without rejecting anyone). Effect on the Supabase
instructions: none. `docs/readiness/20` section C now reads "the role's full applicant volume". **No code has been
written for this amendment**; it starts after the founder approves the sales-ready gap analysis below.

**Amendment 2, founder objective, presented for approval: release 1 is a sales-ready founding-customer product.**
Recorded in substance (the founder's message arrived mid-turn and its verbatim text did not survive the session's
context compaction; the founder is asked to confirm this record or resend the text): positioning "ITS AI Recruiting
Department, Founding Partner Program"; ITS sells a managed recruiting outcome, contracts and invoices by hand with no
payment processor, Nadine onboards each customer, United States only, an honest customer-facing limitation sheet;
nine requirement areas (A customer setup, B role workflow, C job distribution, D candidate experience, E recruiting
intelligence, F hiring workflow, G reporting, H production operations, I commercial readiness) with the capability
list of each recorded as the row headings of `docs/spec/21`; scope still deferred (SMS, recording, automated offers
and rejection, onboarding, passive sourcing, job-board APIs, automated sponsorship, any payment processor); the
founder's rule "do not expand the code immediately", a twelve-item gap analysis first, then stop for approval, while
the authorized Supabase setup continues. The analysis is `docs/spec/21-sales-ready-gap-analysis.md`, produced by eight
independent readers with adversarial verification of every area. **Status: presented, not approved; no code
written.** Its section 6 records that charging a founding customer is the "paid customers" stop point of risk
R-LEGAL-1 (point 6 above), which the founder must decide before the first invoice.

### Supabase checkpoint (22 September 2026, night)

The founder created the accounts herself; the team received only non-secret identifiers and checked what can be
checked without any credential.

| Item | Result | Evidence |
|---|---|---|
| Organization | `Identified Talent Solutions`; slug not yet reported | founder |
| Staging project | `recruiting-os-staging`, West US (Oregon), Micro compute, reference `vjuaiyjmtrenbrmujvtc` | founder; the public discovery document at `https://vjuaiyjmtrenbrmujvtc.supabase.co/auth/v1/.well-known/openid-configuration` answers with issuer `https://vjuaiyjmtrenbrmujvtc.supabase.co/auth/v1` |
| Token signing | asymmetric ES256 key published at `/auth/v1/.well-known/jwks.json` (key id `088b9c33-48cd-4d10-800b-ae96acf30def`); the code verifies through the JWKS, so no JWT secret is entered anywhere | public fetch by the team, 22 Sep |
| Unused default project | `nmotaweh's Project` (East US, Ohio) deleted by the founder; which organization held it not yet reported | founder |
| Database password | stored in the 1Password vault "Recruiting OS Staging"; never shared in chat | founder attestation |
| Plan Pro, spend cap on, account MFA on, organization MFA required | **not yet reported** (the founder's reply carried unfilled placeholders); each is a screen if "no" | pending |
| Production project | not created (before real data, with point-in-time recovery) | plan |

Findings while preparing the sign-in screens (from the code and the providers' official pages, 22 Sep):

1. **Staff second factor is Supabase TOTP, and the product has no enrolment or challenge step.** The code refuses a staff
   session without `aal2` (`packages/core/src/identity.ts`), but nothing enrols a TOTP factor or verifies a challenge,
   and the PKCE exchange returns the token straight after the Microsoft step. On the real service every ITS staff
   sign-in will be refused with "second factor required" until that step is built; customers are unaffected. This is
   release-1 scope already promised ("Microsoft sign-in with TOTP", `docs/readiness/03` section 3), not new scope; it is
   added to `docs/spec/21` as a P0 build item and waits for the founder's approval with the rest of P0.
2. The application sends `redirect_to = <APP_BASE_URL>/api/v1/auth/callback`; Supabase honours it only if it is on the
   project's redirect allow list (Authentication, URL Configuration), which no document mentioned. Added to `docs/spec/13`
   and `docs/readiness/03`; the entry waits for the staging hostname.
3. `SUPABASE_JWT_ISSUER` is not read by the code (the issuer derives from `SUPABASE_URL`); retired in `docs/spec/13`.
   `SUPABASE_JWT_SECRET` is not needed for a project on asymmetric keys. `SESSION_SECRET`, `COOKIE_DOMAIN` and
   `WEB_BASE_URL` are still read by the code although `docs/spec/13` marked them retiring; corrected.
4. Supabase's region list names the project's region "West US (Oregon), us-west-2"; the earlier `us-west-1` label in
   `docs/spec/13` and `docs/readiness/07` was wrong and is corrected.
5. Supabase's Azure guide recommends the optional `xms_edov` claim on the Entra registration so verified and unverified
   email domains can be told apart; added to the Entra screens. The registration stays multi-tenant with personal
   accounts (`docs/spec/13` section 4a), so the provider's "Azure Tenant URL" stays empty (the common endpoint).

Microsoft Entra registration walkthrough started 22 Sep (one screen per message), Nadine as the only owner: screens 1
to 3 done (registration with the Supabase callback as Web redirect URI, delegated openid, profile, email and User.Read
with admin consent in the ITS tenant; optional claims added through Token configuration, not the manifest: `email` and
`xms_edov` on the ID token, `xms_edov` on the access token); client secret and Supabase provider next.

**Founder approval, 22 September (night): build and test staff TOTP enrolment, verification, recovery and
enforcement before real staff sign-in is enabled, through a protected pull request with tests, without weakening or
bypassing the second-factor requirement.** Built the same day (pull request 5): the identity-provider interface and
fake gained factor enrolment, challenge, verification and removal; the sign-in callback seals the level-1 token in an
encrypted ten-minute cookie and sends staff to the authenticator page; enrolment on the first sign-in, a code on every
sign-in, challenge and verification in one request, five attempts, a backup authenticator offered while the level-2
token is at hand, a dashboard reset recorded as `mfa.reset_detected`; the real provider speaks the service's documented
endpoints (checked against the service's source and OpenAPI description on 22 Sep) with the person's token and the
publishable key; migration 0015 adds `users.mfa_enrolled_at`; runbook `docs/runbooks/staff-second-factor.md`. Tests:
`apps/api/src/mfa.test.ts` (14) and `tests/e2e/specs/staff-mfa.spec.ts` (2). Recovery is a backup authenticator plus
the owner-run reset, because the service issues no recovery codes and the application holds no admin key. Enforcement
is unchanged: the JSON session route and every administrator and recruiter route still refuse a staff session without
`aal2`. An adversarial review (four lenses, two refuters per finding) found eighteen items, all fixed the same day: the
attempt counter had lived in the replayable cookie (now counted server-side per transaction id and per person); the
backup step was not bound to the signed-in person; cancel and skip could be triggered cross-site; the service's QR
image lacked a viewBox and would have been clipped; the error mapping put the status fallback before the service's
codes so a disabled setting read as a wrong code; fixed authenticator names could dead-end the backup path; a refresh
of the backup page re-enrolled; a wrong code was answered from the POST so a refresh re-sent it; a failure after the
session cookie was set read as a failed sign-in; the fake was looser than the service (address binding, level-2 rule
for a second factor); the browser journey still expected the old refusal; and the tests lacked negatives for a level-1
token from the service, provider failures, a forged cookie, a stranger's session on the backup step, the address
limit's page and the person-wide cap.

| Phase | Status | Evidence |
|---|---|---|
| 1 Secure the source code | approved 22 Sep | this section |
| 2 External account inventory | inventory approved 22 Sep with decisions 1 to 4; Supabase organization and `recruiting-os-staging` created 22 Sep (checkpoint above, four security facts pending); Microsoft Entra registration in progress | `docs/spec/19`, this section |
| Scope amendment 1: job distribution | approved 22 Sep; inspection delivered; no code yet | `docs/spec/20` |
| Scope amendment 2: sales-ready founding-customer product | gap analysis delivered 22 Sep; awaiting founder approval; no code | `docs/spec/21` |

Founder-run database setup, revised 22 Sep at the founder's request after she found that the Session pooler string carries a
`[YOUR-PASSWORD]` placeholder and that Supabase warns special characters in a password must be percent-encoded:
`scripts/staging-db-setup.sh` now asks for the string with the placeholder in it and for the password separately without
echo, percent-encodes the password and replaces exactly one placeholder inside the script (the password travels to the
encoder on standard input, never as an argument, in history, on disk or in output), refuses a string whose placeholder is
missing or repeated before the password is asked for, and is covered by `packages/db/src/connection-string.test.ts`
(special characters, exact placeholder matching, refusals, no secret in any error message).

Decision 2 build record (22 Sep): the Supabase Storage adapter (`packages/integrations/src/storage/supabase.ts`, S3
protocol, signature version 4 without a cloud SDK, the project's storage-only S3 keys and never the service-role key)
with direct browser uploads under five-minute single-object authorizations, a quarantine key per upload, worker-side
inspection by file signature and structure (`packages/contracts/src/security/file-inspection.ts`), a scanner adapter
(fake until a real engine is authorized), promotion to a random tenant- and candidate-scoped key, audited two-minute
download links for staff, and removal with an audit record on deletion. Runbook `docs/runbooks/resume-storage.md`;
tests `sigv4.test.ts`, `storage.test.ts`, `file-inspection.test.ts`, `storage-uploads.test.ts`. One honest caveat: the
provider's S3 access keys are storage-only but reach every bucket in the project, so the project holds exactly one
bucket for this application. The staging bucket and keys are a founder action (runbook §"The staging bucket").

Staging database setup, second revision (22 Sep): the founder's first run exited 1 (the error text did not reach the
team). Root cause of the fragility, independent of the error: the migration runner applied statements one by one
without a transaction and recorded a file only after its last statement, so a failure mid-file left a half-applied,
unrecorded migration that a rerun could not pass. Now every migration file applies in one transaction with its ledger
row; the first pending migration is completed with "already exists" statements skipped and counted; later migrations
run strictly; provisioning is idempotent (fresh passwords every run, Vault grants skipped with a clear line until
Supabase Vault is enabled, a `grants` mode, verification that reports a plain diagnosis); `scripts/staging-db-status.sh`
reports read-only and without secrets; a CA certificate file can be given for TLS verification without ever switching
it off. Nothing resets or deletes the staging database. Runbook `docs/runbooks/staging-database-setup.md`; tests
`migrate.test.ts`, `provisioning.test.ts`.

Findings from the recovery investigation (22 Sep, three investigators, adversarially checked), recorded for the
register: (1) TLS: Supabase's pooler and database certificates chain to Supabase's own root authority, which no
computer trusts by itself; `sslmode=verify-full` therefore needs the dashboard-downloaded certificate, on a person's
machine (`DATABASE_SSL_CA_FILE`) and in Vercel and Railway (`DATABASE_SSL_CA`). The migration step had been connecting
without TLS at all; now every owner connection verifies. (2) Supabase's project default privileges grant every table
created in `public` to the Data API roles `anon`, `authenticated` and `service_role`; platform tables without row-level
security would be readable with the publishable key. Migration 0017 revokes those privileges and the defaults; the
founder removes `public` from the exposed schemas (readiness blocker 2a). (3) The application relies on per-connection
state (`app.platform`), which transaction pooling does not keep: the application strings use the Session pooler until
every platform read runs inside `withPlatform` (readiness blocker 2b). (4) Vault's function signatures differ from the
ones the grants named; the grants now resolve them at run time. (5) The pooler may refuse a freshly set password for a
few seconds; verification retries for thirty. Nothing in any of this resets or deletes the staging database.

Staging database setup, third revision (22 Sep): the founder's rerun of the read-only status report read the
downloaded certificate but the driver still refused the chain. Cause: node-postgres lets a connection string's
`sslmode` override an explicit `ssl` option, discarding the certificate. The client now removes `sslmode` and
`sslrootcert` from the string whenever it holds a certificate and passes one trust object (certificate, full
verification, host name checked); `sslmode=disable` is refused. Proven through the founder's exact command path
against the staging pooler with a deliberately wrong password (TLS verified, password refused). Tests
`packages/db/src/tls.test.ts` pin the driver behaviour and the fix. A two-lens adversarial review of the fix found
that the driver's own `ssl=` parameter overrode the certificate the same way and that `ssl=0` or `sslmode=no-verify`
would have weakened or removed TLS silently; that a certificate named in the string could silently win over the one
given explicitly; that a one-line pasted certificate (literal `\n`) would be accepted and then ignored by the TLS
layer; and that a malformed connection string could surface the password through the platform's URL error. All four
are fixed and tested: every weakening switch is refused, the explicit certificate wins and a conflict is refused,
pasted certificates are normalised and parsed before use, and URL errors carry a fixed message.

Incident, 22 Sep: the founder shared a screenshot that showed the two application connection strings the setup had
printed. Neither had been entered anywhere; the database holds synthetic data only. Handling: both role passwords are
rotated by running the setup again (fresh passwords, earlier sessions ended, old strings dead), and the setup no longer
prints the strings at all: each goes to the clipboard in turn for 1Password and the clipboard is cleared afterwards
(`--print` remains for a non-Mac). The status report now shows the application roles' active sessions. Recorded so
the pattern is not repeated: a credential shown on a screen is a credential that can be photographed.

**Checkpoint, staging database (22 Sep):** the founder's rerun of `scripts/staging-db-setup.sh` completed: roles
present, passwords set (the rotation after the screenshot exposure; no earlier sessions existed to end), Vault grants
applied (Supabase Vault is present on the project), both application roles verified through the Session pooler, the
two connection strings delivered to 1Password by clipboard and never shown. The incident is closed: the exposed
strings stopped working at the rotation; they had been entered nowhere; the database holds synthetic data only.
Remaining founder actions for the staging URL, one at a time: the private `resumes` bucket and S3 access keys
(`docs/runbooks/resume-storage.md`), the Vercel Preview environment variables, the Supabase Auth redirect allow list,
the Railway worker service; then the Data API exposed-schemas setting (readiness blocker 2a).

**Branch `production` created (22 Sep):** Vercel would not accept `production` as the Production Branch until it
existed, so the team created it as a pointer to the then-current `main` (`8627372`) and protected it exactly like
`main` (pull request required, `verify` required and strict, administrators included, no force push, no deletion).
No code differs from `main`; no production environment variables exist, so any deployment Vercel makes from it
refuses to start and serves nothing. A production release will be a deliberate pull request from `main` into
`production` after the production accounts and gates in `docs/readiness/20` are done; nothing merges there before.

**Staging web application reachable (23 Sep):** the founder created the Vercel project (root `apps/shell`, Next.js,
Corepack for pnpm 12.3.4), set Production tracking to the protected `production` branch, switched Preview
protection off, chose region `pdx1`, entered the Preview variables for `main`, and the health check answered
`{"ok":true,"db":"postgres","ai":"anthropic","worker":"external"}` at
`https://recruiting-os-git-main-identified-talent-solutions.vercel.app`. The founder confirmed decision 1 (Railway;
no Trigger.dev integration, no change to the database-backed worker). Next: the Railway worker service
(`docs/runbooks/railway-worker.md`, one screen at a time), then the Supabase Auth redirect allow list for that
address. Follow-up recorded: Railway's `railway.json` mechanism is deprecated in favour of its Infrastructure as Code
with legacy support ending 1 December 2026; migrate before then.
