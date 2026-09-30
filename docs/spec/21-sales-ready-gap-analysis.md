# 21. Sales-ready release 1: gap analysis for the Founding Partner Program

Written 22 September 2026 for the founder's objective of the same day: release 1 is a sales-ready founding-customer
product ("ITS AI Recruiting Department, Founding Partner Program"), not a limited demonstration. ITS sells a managed
recruiting outcome, contracts and invoices by hand (no payment processor), Nadine onboards each customer, United States
only, with an honest customer-facing limitation sheet. **Nothing in this document has been built.** It is the
inventory the founder asked for before more coding, and it stops for approval at the end.

How it was produced: eight independent readers examined one requirement area each (A customer setup, B role workflow,
D candidate experience, E recruiting intelligence, F hiring workflow, G reporting, H production operations, I
commercial readiness) against the code, tests and documents on `main` at `6f99b55`, citing file and line for every
claim; a second set of readers then tried to refute each area's findings against the code, and their corrections are
folded in (the invitation defect restated, the packet editor's failing save added, résumé storage moved from
"missing" to "exists", the apply form's missing privacy link, the follow-up test, uncaptured email replies). Every
status survived that check. Area C (job distribution) is `docs/spec/20-job-distribution.md`.

Status words used throughout, exactly as the founder asked:

- **complete on mocks**: built and proven by a test, against fake providers. Nothing in the product is production-verified yet, because no account exists.
- **exists, not production-verified**: built, but either a test is missing, the founder's requirement is only partly met, or it depends on a real provider that has never been connected.
- **missing**: no code or document.
- **manual for release 1**: done by ITS staff by hand under a written procedure.
- **needs third-party approval**: outside ITS's control.
- **deferred**: excluded from release 1 by an earlier founder decision.

## 1. What already exists and is complete (on mocks)

| Area | Capability | Proof |
|---|---|---|
| A | Isolated tenant: row-level security on every company table, tenant set only from a verified membership | `packages/db/src/rls.test.ts`, `apps/api/src/tenancy.test.ts`, `security-coverage.test.ts` |
| A | Customer administrator: the company creator becomes the owner with the full permission set | `apps/api/src/app.test.ts` "creates the company with trial entitlements"; owner-only routes proven over HTTP |
| B | Hiring request and structured role intake in conversation, unlawful criteria declined with an alternative, resume after reload | `tests/scenario/lifecycle.test.ts` steps 1 to 1c, `app.test.ts`, evals `intake.golden`, `intake.illegal_criteria` |
| B | Approved job description as part of the versioned role packet, published only after approval | `app.test.ts` "serves the job page with JobPosting markup and notices", lifecycle step 4 |
| B | Qualifications with rationale; six must-haves at most; declined criteria stripped | `packages/agents/src/agents.test.ts`, lifecycle step 2 |
| B | Interview plan of one to five rounds; the round must exist in the approved plan before an interview is requested | lifecycle step 11, `scheduling.test.ts` |
| B | Role approval by a person with the right role and packet version; edits create a new version | lifecycle steps 2 and 3, `app.test.ts` "approval opens the role and publishes to every channel" |
| D | Confirmation: on-page banner and an acknowledgment email that discloses the AI assistant and the HUMAN option, retried on outage | `app.test.ts` lines 158 to 209 and 300 |
| D | Candidate status page with what happens next, messages, withdrawal, privacy form; dead after anonymization | `app.test.ts`, `slice2.test.ts`, `privacy-requests.test.ts`, browser tests |
| D | Interview availability in the candidate's own zone, "none of these work", reminders and expiry | `scheduling.test.ts`, browser journey |
| D | Withdrawal with confirmation, idempotent, owner told, candidate emailed | `privacy-requests.test.ts` lines 276 to 294 |
| D | Privacy requests: access, correction, deletion (anonymization with confirmation), human review; admin console with deadlines | `privacy-requests.test.ts`, `docs/runbooks/privacy-requests.md` |
| E | Résumé evidence extraction with quotes verified against the source; failure path continues without extraction | `agents.test.ts`, `app.test.ts`, evals `resume.extraction`, `resume.hallucination` |
| E | Comparison against the packet's must-haves and competencies; owner rules checked in code, never by the model | evals `triage.edge_cases`, `triage.hallucination`, `core.test.ts` eligibility |
| E | Explainable recommendations: summary, rationale, grounded strengths; "people decide" | `app.test.ts`, `slice2.test.ts`, lifecycle |
| E | Human review at every consequential point; one-click flag on an assessment | `app.test.ts` hold, remind, escalate, decline tests |
| E | No automatic rejection anywhere: state machine, policy lock, reason required | `core.test.ts`, `app.test.ts` lines 212 to 263 and 343 to 353 |
| F | Candidate pipeline per role grouped by who must act, with a full timeline per candidate | lifecycle steps 5 to 13 |
| F | Human decline with a fixed reason list; the decline message goes out only after the human decision | `app.test.ts`, lifecycle steps 9 and 13, `outcomes.test.ts` |
| F | Recruiter escalation with business-hours response times, scoped time-limited access, queue preview before acceptance | `staff-access.test.ts` (7), `queue-preview.test.ts` (6) |
| F | Customer ends a recruiter's access at once; audited; the recruiter cannot re-claim | `staff-access.test.ts` revocation test, browser test `revoke-access.spec.ts` |
| F | Human-recorded outcomes with confirmation; role close as a separate decision; administrator corrections keep the original | `outcomes.test.ts` (5) |
| G | Interviews list, pending decisions on the brief, escalations on the brief, communication failures surfaced, outcomes per candidate | `scheduling.test.ts`, `app.test.ts`, `email-failures.test.ts`, `outcomes.test.ts` |
| H | Authentication: staff refused without Microsoft and a second factor; tampered, expired and foreign tokens refused (the second-factor enrolment step itself is missing, section 2) | `identity.test.ts`, `platform-roles.test.ts` |
| H | Worker as a separate role that alone may claim jobs; leases and backoff | `rls.test.ts`, every timer test |
| H | Audit records append-only, scrubbed, written for privileged reads and human decisions | `security-coverage.test.ts`, `secret-lifecycle.test.ts`, CI migration validator |
| I | AI-use disclosure on every candidate page and every automated message | `app.test.ts`, `core.test.ts`, lifecycle step 10 |

Last verified locally on 22 September: typecheck clean; 27 test files, 219 passed, 5 skipped by decision; evals 7 of 7
on the fake provider; production build; 11 browser tests with accessibility checks; CI green on `main`.

## 2. What exists but is not production-verified

The whole product shares one condition: every provider is a fake (AI, email, calendar, identity, storage, analytics,
error reporting), so no prompt has run on the real model, no email has left, and no sign-in has gone through Supabase.
The rows below are the specific shortfalls on top of that.

| Area | Capability | Shortfall |
|---|---|---|
| A | Hiring-manager users | No test ever signs in as a hiring manager; the invite path is the only way to become one and it is untested. |
| A | Invitations and removal | No test invites, accepts, changes or removes a member. The invite link is redeemed through an email-link session even where the deployment has turned email links off (the switch covers only the sign-in route, not invitation acceptance), so acceptance opens a single-factor session the staging plan says is not offered; an invitee on the ITS domain is refused outright; and Microsoft or Google sign-in never reads the invite. The member-update body is unvalidated (any string becomes a role and locks the person out), any members-manage holder including HR can promote anyone to owner, there is no last-owner guard, removal does not end sessions or calendar credentials, there is no remove or role-change screen, and removed people still appear under Team. |
| A | Role-based permissions | Only the owner and a recruiter under a grant are exercised over HTTP; hiring manager, HR, interviewer and admin route refusals are unproven. |
| A | Audit history | The customer's audit endpoint returns four staff-access actions only; membership and policy changes are reachable only through the raw events feed, which no page shows; candidate-view and outcome audit records are not shown to the customer; no export. |
| A | Company preferences | No test or screen edits the company; the settings blob is untyped so an owner could write the pilot flag; notices are not editable or audited; no company business hours. |
| B | Qualifications and evidence | The "how each qualification is evidenced" field is filled by the fake compiler with a fixed value and read by nothing. **Adding a must-have in the owner's packet editor fails**: the screen omits the evidence field the contract requires, so the save is refused with a validation error, and the packet-edit route has no test. |
| B | Compensation and location | The BLS benchmark adapter has never been tested (exercised once by hand on 10 September); remote policy is hard-coded "onsite" by the fake compiler; only interviewers have compensation hidden (HR sees it by design) and that route behaviour has no test. |
| B | Decision authority | The named decision maker never becomes an approver; nothing stops the hiring manager who ran the intake from approving their own packet; the wrong-role refusal has no test. |
| B | Packet editor, approval rules, the role page | **Built 30 September 2026** (the three rows above, and the sent-back dead end, the role page's missing sections and the "Start a hire" entry). The owner's editor (`apps/web/src/pages/RoleEditor.tsx`) carries every field a must-have or nice-to-have needs (the text, why it matters, where it is evidenced: résumé, application, screen, interview) and the work model (on site, hybrid, remote); the intake prompt and the fake compiler take the work model and the named decision maker from the conversation; the Requirements tab shows "Evidenced in", and the screening prompt lists the must-haves marked for the screen. Approval rules (`packages/core/src/approval-deciders.ts`, `apps/api/src/services/packet-approval.ts`): no self-approval of a role one started or a version one wrote, unless the sole owner; the named decision maker, matched to an active approver, is stored on the request (`proposal.requiredUserIds`, `proposal.decisionMaker`) and only they or an owner may decide; an edit to an open role by someone without `role.approve` waits for approval while the role keeps its version (Today shows "Approve packet v3 of ..."). A rejection or a 14-day expiry sends the role back to draft with the note on the role page ("Sent back: ...") and "Request approval again" (`POST /roles/:id/request-approval`); an edit while pending cancels the older request and marks its run cancelled before the new run starts. The role page gained "What matters to you" (deal-breakers, what failure looks like, the decision maker), an Interview plan tab (rounds, interviewers by name with scheduling readiness, assignment per round through `PATCH /roles/:id/interview-plan`) and an Activity tab (`GET /roles/:id/timeline`, plain words). Home has an explicit "Start a hire" button. Tests: `apps/api/src/packet.test.ts`. |
| D | Mobile application | The apply form, screening page and scheduling pages are never rendered in the phone browser project; only the job page and status page are. |
| D | Résumé upload | Local disk or memory adapter only (lost on Vercel), with tenant-prefixed keys, size and type checks and deletion on anonymization; the file still travels through the API (decision 2's direct-to-storage design is not implemented); the type check reads the declared type and extension only, no signature check; no scanning code of any kind; PDF and DOCX extraction unproven by any test (every fixture is plain text); the size and type refusals have no test. |
| D | Privacy and AI-use notice | No affirmative acknowledgment checkbox. The form shows a one-sentence privacy notice (what, why, how to request) but no link to the notice, no "who may access", and no privacy address; the SMS checkbox renders while texting is off (`docs/readiness/20` section D, whose row 9 is corrected in this change). |
| D | Follow-up questions | The eval runner drives one follow-up for a "confused" persona, but nothing asserts that a follow-up was asked and the two-follow-up cap is never reached; real-model behaviour unknown. |
| D | Scheduling, rescheduling and cancellation | The candidate's own cancel route is untested; the Google provider is unit-tested against a stubbed network, so only the live API is unverified; no Microsoft 365 calendar provider (the pilot runs on manual availability and ICS, which is the tested path). |
| D | Human assistance | The web "talk to a person" route is untested; "reply HUMAN to any email" has no inbound handler, so it depends on a person reading the reply mailbox. |
| E | Strengths, concerns and unknowns | No test asserts a concern or an unknown is produced or shown; the Talent list omits them. |
| E | Insufficient-evidence handling | Not an explicit state: it is "unknown" plus "review manually" and only notifies; no follow-up question reaches the candidate. One test reaches the review path through an eligibility override; the unreadable-résumé and repeated-invalid-output branches have none. |
| E | Confidence | Stored and shown, never asserted by a test; no "what drives the uncertainty" text. |
| F | Human advancement | **The post-interview decision has no screen**: "finalist" is reachable only through the API; the "how did it go" notice links to a sheet with no decision card. |
| F | Candidate communication | Every message is a lifecycle template through the fake email adapter; no owner-to-candidate free-form message; a candidate's reply to any email (the decline template invites one) is never captured, only text and web-screen replies are recorded. |
| G | Stage counts, AI recommendations, overrides | Computed and rendered per role or per candidate; no test asserts the counts; no rates or summaries. |
| H | Authentication and staff MFA | Found 22 September: the product had no step that enrolled or verified an authenticator, so every real staff sign-in would have been refused. **Built the same day under the founder's approval** (enrolment, verification, backup, reset detection; `apps/api/src/mfa.test.ts`, `tests/e2e/specs/staff-mfa.spec.ts`, `docs/runbooks/staff-second-factor.md`); proof on the staging identity service is Phase 3 work. |
| H | Email and inbound replies | Postmark send and inbound JSON untested; only the intake address is parsed; no account, domain or DNS. |
| H | Shared rate limiting | Only the fake counter exists; production would run per-process limits with a standing alert. |
| H | Monitoring and scrubbing | Scrubber written and tested, Sentry SDK not a dependency, so nothing reports anywhere; no uptime, queue-age or worker-liveness alert. |
| H | Production deployment | Nothing deployed; no deploy configuration in the repository; migrations by hand; the 8 MB upload exceeds Vercel's 4.5 MB body limit until decision 2's direct-to-storage upload is implemented. |
| I | Founding-customer agreement | A design-partner pilot draft with bracketed term, notice, liability, governing law; no fee, invoicing, support or service-limitation sections; no terms for a paid conversion; unreviewed by counsel (R-LEGAL-1). |
| I | Privacy notice, data-processing terms, subprocessor list | Drafts exist, unreviewed; the subprocessor list cannot be true until accounts exist; a malware-scanning vendor would be an addition. |

## 3. What is missing

| Area | Capability | What has to be made |
|---|---|---|
| C | Job distribution | Everything in `docs/spec/20` section 2: hosted job pages on `jobs.identifiedtalent.com`, tracked links, source detail, posting package, the nine posting states, URL verification, per-board pause and close, manual-closure checklist, volume switch, sitemap, documented feed. |
| F | Interviewer brief | A brief per interview carrying the round's purpose, the competencies it covers, the packet's questions, and the evidence so far; the interviewer role cannot see candidate evidence today. |
| F | Candidate comparison | A side-by-side view of candidates against must-haves and competencies (the data exists per application). |
| G | Applicants by source, time in stage | No aggregation anywhere; the only group-by in the code is AI cost. |
| G | A role report | No page or export puts the ten reporting figures together for a customer. |
| G | Report | **Built 30 September 2026.** The Report tab on the role page shows the ten figures (applicants by source and by day, stage counts, time in stage, interviews, pending decisions, the assistant's suggestions against the person's decisions, overrides, recruiter help, messages, outcomes) with a definition of each; "Download the applicant list (CSV)" and "Download the summary (CSV)" on the same tab, every download audited as `report.exported`; the administrator console's Customers tab has a Report button per customer with the same figures over every role. Routes: `GET /api/v1/roles/:id/report`, `/report.csv`, `/report/summary.csv` (interviewers refused), `GET /api/v1/admin/customers/:id/report`. Code: `apps/api/src/services/role-report.ts`, `apps/api/src/routes/reports.ts`, `apps/web/src/pages/RoleReport.tsx`; tests in `apps/api/src/role-report.test.ts`, which also pins the roles-list, role-page and brief numbers to the report (section 11 step 28). Definitions in `docs/16-admin.md`. |
| H | Private object storage for résumés | The Supabase Storage layer of decision 2 (private bucket, scoped paths, direct upload with short-lived authorization, signature check, quarantine and scan, upload and read audit, tenant-isolation tests); today's local and memory adapters are listed in section 2. |
| H | Customer onboarding documentation | No guide of any kind for a customer. |
| I | Feature and limitation sheet | Section 12 below is the first draft; it becomes Exhibit A. |
| I | Security overview | A plain-language annex from `docs/readiness/10`, `docs/spec/09`, `docs/readiness/08`; becomes Exhibit B. |
| I | Support expectations | Hours, channels, response times, what support does not cover; the enforcing code exists. |
| I | Onboarding checklist, customer administrator guide, hiring-manager guide | Not written. |
| I | Customer documents | **Drafted 30 September 2026, awaiting founder review**: `docs/customer/01` (feature and limitation sheet, Exhibit A), `02` (security overview, Exhibit B), `03` (support expectations), `04` (onboarding checklist), `05` (administrator guide), `06` (hiring-manager guide), and `docs/legal-drafts/11` (paid-agreement additions for counsel). Each claim was checked against the screens and code; the sheet corrects section 12 where the product differs. |

## 4. What is manual for release 1

| Task | Who | Procedure |
|---|---|---|
| Posting the approved job to LinkedIn, Indeed and ZipRecruiter, verifying each URL, marking it live, closing it | ITS | `docs/spec/20` section 2 (posting package, states, closure checklist once built) |
| Reading replies: any candidate email reply, "reply HUMAN", the support and privacy mailboxes | ITS | `docs/readiness/12`, `docs/runbooks/privacy-requests.md` |
| Recording privacy requests that arrive by email; irreversible deletion decisions | ITS, counsel item 6 open | `docs/runbooks/privacy-requests.md` |
| Weekly customer report until the role report exists | Nadine | a written summary from the Roles, Talent and Interviews pages (section 7, P1) |
| Contracting and invoicing | ITS | signed agreement in the vault; invoice by hand; no payment processor |
| Backups: enabling point-in-time recovery, running the restore drill | Nadine and the team | `docs/readiness/05` |
| Incident response | Nadine as incident lead | `docs/readiness/04` |
| Candidate support beyond the product's HUMAN hand-off | ITS recruiter | `docs/readiness/12` |
| Migrations and administrator bootstrap on each environment | the team on a trusted machine, founder entering secrets | `docs/readiness/03`, `docs/readiness/13` |

## 5. What requires third-party approval

| Item | Provider | Position on 22 September |
|---|---|---|
| Indeed ATS integration (Indeed Apply, Disposition Sync, Job Sync) | Indeed | requires a partnership; guidelines require at least ten paying clients, a fully launched product, no free tiers that post jobs, and Indeed decides case by case with no timeline. Not eligible today. |
| LinkedIn Job Posting API and Apply Connect | LinkedIn | the Job Posting API is closed to new partners; Apply Connect is restricted to approved developers with no promised agreement or timeline. Not available today. |
| ZipRecruiter ATS partner APIs | ZipRecruiter | see `docs/spec/20` section 8 (research in progress at the time of writing). |
| Sending domain and inbound domain | Postmark | account approval and domain verification (DNS records shown to the founder first). |
| Google sign-in and Google Calendar consent screen | Google | only if the first customer uses Google Workspace; verification of the consent screen can take days to weeks. |
| Microsoft sign-in registration | ITS's own Microsoft tenant | no third-party approval; the founder creates it. |
| Paid customers under unreviewed legal drafts | counsel, or the founder's separate written acceptance | risk R-LEGAL-1 names "paid customers" as a stop point (see section 6, item 1). |

None of the job-board approvals is on the path to the first founding customer: the release-1 workflow posts by hand under
the customer's own employer accounts and tracks each board with its own link.

## 6. Every blocker to charging a founding customer

A charge means a paid customer with real candidates. The list is therefore the union of the commercial blockers and
the real-data blockers, plus what the founder's own scope decisions add.

**Commercial and legal**

1. **Risk R-LEGAL-1 re-surfaces here.** On 22 September the founder accepted running the unpaid pilot on unreviewed
   legal drafts and directed that the risk be raised again "before paid customers" (`docs/spec/00` section Q, point 6).
   Charging a founding customer is that stop point. The options are counsel's review of the agreement, privacy notice
   and data-processing terms before the first invoice, or a second, separate, dated founder acceptance that names the
   added exposure of a paid contract. The team cannot make that choice.
2. A signed Founding Partner agreement with the sections the current draft lacks: fees and invoicing, term and renewal,
   support, service limitations (Exhibit A), security overview (Exhibit B), data-processing terms with the placeholders
   resolved, subprocessor list that matches real accounts.
3. The customer-facing feature and limitation sheet, security overview, support expectations, onboarding checklist and
   the two guides (sections 3 and 12).
4. An invoicing method and payment terms decided by ITS (accounting software or a bank invoice; W-9 on file; whether
   sales tax applies to the service in the customer's state is a question for ITS's accountant, not the team).
5. Mailboxes that exist and are read: support, privacy, and the escalation queue (gates 1.5, 1.8, 2.0).

**Technical, before real candidates (all of `docs/readiness/20` section B, restated by group)**

6. Production accounts and environments: Supabase production with point-in-time recovery, Vercel production, the Railway
   worker, Postmark with a verified domain, the sign-in registration, secrets in Vault, no service-role key in the
   application (blockers 1, 2, 9, 11).
7. Staging verification with evidence: tenant isolation, authentication and staff MFA, audit, privacy workflows,
   scrubbing, rate limiting, email (blockers 3, 4, 10, 13, 14, 15, 16, 17).
8. The three authorized adapters: Supabase Storage with malware scanning, Upstash, Sentry (blockers 6, 7, 8, 15, 16).
9. Candidate transparency: the acknowledgment checkbox and the on-form block; SMS checkbox hidden (blocker 18).
10. Backups enabled and a restore drill passed; incident lead named; the rehearsal passed; independent security review
    done or its deferral accepted in writing (blockers 12, 20, 21, 22).

**Product defects a paying customer would hit in week one**

11. The invitation path proven end to end under production settings (section 2, area A): acceptance through Microsoft or Google sign-in rather than a single-factor email-link session, validated member changes, a last-owner guard, removal that ends sessions.
12. The post-interview decision screen (section 2, area F): without it the customer cannot mark a finalist.
13. Job distribution (`docs/spec/20`): the founder's pilot posts one real job to three boards with tracked links.
14. The packet editor's must-have save (section 2, area B), and a rule about approving a packet one wrote oneself.

**Evidence the product works on the real model**

15. The eval suites run once on the Anthropic provider on staging with thresholds met, and the screening conversation
    rehearsed on the real model, including a follow-up and the HUMAN hand-off (`docs/spec/08`).
16. The staff second-factor enrolment and challenge step (section 2, area H): built 22 September, proven on staging in
    Phase 3 before any real staff sign-in.

## 7. Prioritization

**P0: before the first invoice.** Everything in section 6. In build terms, the team's P0 work is:

| P0 work | Size (team working days, estimate) |
|---|---|
| Job distribution (`docs/spec/20`): pages on the jobs host, tracked links, source detail, posting package, states, verification, closure checklist, volume switch, sitemap, feed | 3 to 5 |
| Supabase Storage adapter with quarantine and a malware scanner (decision 2) | 2 to 3 |
| Upstash adapter (decision 4) and Sentry SDK (decision 3) | 1 to 2 |
| Supabase TOTP enrolment and challenge for staff sign-in (enrol on first sign-in, verify on every sign-in, owner-run reset): **done 22 Sep, pull request 5**; the redirect allow-list entry waits for the staging host | done |
| Invitation accepted through Microsoft and Google sign-in (no single-factor email-link session in production); validated member updates; last-owner guard; removal ends sessions; tests that sign in as each role | 1 to 2 |
| Post-interview decision card (next round, finalist, not moving forward); packet editor must-have save fixed and tested | 1 |
| Acknowledgment checkbox and transparency block; SMS checkbox hidden while texting is off | 1 |
| Apply, screen and schedule pages in the phone browser project; PDF and DOCX fixtures; follow-up cap test; candidate cancel test: **done 30 Sep** (`tests/e2e/specs/candidate-phone.spec.ts`; `packages/agents/src/fixtures` proven by `packages/agents/src/documents.test.ts` and the résumé cases in `apps/api/src/storage-uploads.test.ts`; the cap in `packages/agents/src/screening.test.ts` and `apps/api/src/screening-rules.test.ts`, which also proves "Talk to a person"; `apps/api/src/candidate-cancel.test.ts` with the optional reason field) | done |
| Staging deployment configuration (Vercel, Railway), migration runbook, worker health endpoint | 1 to 2 |
| Customer documents: limitation sheet, security overview, support expectations, onboarding checklist, two guides | 2 to 3 |
| Agreement additions for a paid customer (fees, invoicing, term, support, limitations) as drafts for counsel or the founder | 1 |

Founder P0 actions are in section 10. Counsel or the founder's written acceptance is P0 by the founder's own rule.

**P1: within the first sixty days of the founding customer, before a second customer.**

- A role report for the customer: applicants by source, stage counts, time in stage, interviews, pending decisions,
  recommendations versus decisions, overrides, escalations, failed messages, outcomes; the same figures per customer in
  the administrator console. Manual weekly report until then.
- Interviewer brief; the interviewer role allowed to read the candidate's evidence for their own interview.
- Candidate comparison view.
- Customer-visible audit history beyond recruiter access, with export.
- Company preferences screen: notices (audited), business hours, editable company details with a typed contract.
- Named decision maker becomes an approver; self-approval rule. Built 30 September 2026 (area B in the shortfalls table above).
- Free-form owner-to-candidate message under the existing policy.
- Insufficient evidence as an explicit state that offers a one-click follow-up question. Built 30 September 2026: "Needs a closer look" on the Talent list (label, filter chip, what is missing in plain words) and in the notification, "Ask about this in a screen" (`ask_in_screen`, a screen that starts with the assessment's open questions), `confidenceReasons` on the assessment, and the two failure branches said on the card (`apps/api/src/intelligence.test.ts`).
- Real-model eval thresholds recorded in `packages/evals/results` from staging.

**Deferred (unchanged founder decisions).** Scorecards and debriefs (release 2, decision A1), offers and e-signature,
onboarding, SMS (M2), interview recording, Microsoft Calendar (M3), passive sourcing, job-board API integrations
(partner track), automated sponsorship, any payment processor, any second jurisdiction.

## 8. The fastest sequence from today to a paid launch

Three lanes run at once. The founder's lane and counsel's lane are the critical path; the team's lane is not.

| Step | Lane | Depends on | Estimate |
|---|---|---|---|
| 1 Supabase organization and staging project (in progress), then Microsoft sign-in registration, Anthropic, Vercel, Railway, one screen at a time | founder | nothing | founder's availability; about an hour of screens in total |
| 2 P0 build in protected pull requests on synthetic data (section 7 table) | team | nothing; storage and Upstash adapters can be tested against staging once step 1 exists | 12 to 20 working days in total, several in parallel |
| 3 Staging deployment and `docs/readiness/03` verification; real-model evals; storage, Upstash and Sentry proven on staging | team, founder entering secrets | steps 1 and 2 | 3 to 5 days after the accounts exist |
| 4 Postmark account, DNS records for the sending domain and `jobs.identifiedtalent.com` (each shown first), inbound domain, email verification on staging | founder, team | step 1; GoDaddy access (gate 1.3) | 2 to 4 days including Postmark's own review |
| 5 Commercial documents: paid-agreement additions, Exhibits A and B, support statement, guides; counsel review or the founder's separate written acceptance (R-LEGAL-1) | founder, counsel, team drafts | nothing | team drafts in 3 days; counsel's timing is outside the team's control |
| 6 Gate review (Phase 5) with per-gate evidence | team, founder | steps 3 and 4 | 1 day |
| 7 Production setup: Supabase production with PITR, Railway production worker, Vercel production, bootstrap administrator, restore drill, incident lead confirmed | founder, team | step 6 | 2 days |
| 8 Founding customer selected and signed; invoice issued per the agreement; company created; hiring manager invited; role intake and approval; posting package produced; ITS posts to the three boards under the customer's accounts | founder, customer, ITS | steps 5 and 7 | customer's pace |
| 9 Rehearsal (Phase 7) on staging with synthetic data at realistic volume; rerun after fixes | team | steps 3, 4 | 2 days plus fixes |
| 10 Controlled launch (Phase 8): the real job goes live on the boards; daily oversight in week one; seven stable days before any second customer | founder, ITS | steps 8 and 9 | the pilot itself |

If the founder's accounts and counsel's answer arrive within the team's build window, the first paid customer is
reachable in roughly four to six weeks of working days from today. The estimate is the team's; it excludes counsel's
calendar and the customer's.

## 9. Expected account and infrastructure costs

From `docs/spec/19` section D, with the additions this objective introduces.

| Stage | Items | Monthly (as printed by the providers) |
|---|---|---|
| Already paying | GitHub Team (1 seat), 1Password Business (2 users) | about $20 |
| Synthetic staging | Supabase Pro $25, Vercel Pro $20, Railway Hobby $5, Anthropic prepaid usage $20 to $50 | about $50 plus AI credit |
| Before real candidates | add Supabase production compute and point-in-time recovery about $115, Postmark Pro $16.50; Upstash, Sentry, PostHog at $0 for pilot volume | about $180 plus $40 to $100 AI usage |
| Added by this objective | a malware scanner for résumés (blocker 8): a self-hosted ClamAV service on Railway is roughly $15 to $25 of compute, or a hosted scanning API at its own price; the `jobs.` hostname is free on Vercel; an invoicing tool $0 to $30 if ITS wants one; no job-board cost (the customer's own employer accounts; no sponsorship) | about $15 to $55 |
| One-time | first months of the services above, Anthropic starting credit (suggest $50) | about $100 to $150 |

Founding-customer revenue is set by the founder's commercial model; the team has not seen a figure and assumes none.

## 10. Founder actions required

In order; each will be presented one at a time as the founder asked.

1. Finish the Supabase organization and staging project (in progress) and store the values in the named vaults.
2. Create the Microsoft sign-in registration, the Anthropic organization and workspaces, the Vercel team and project, and the Railway project, one screen per message.
3. Decide, in writing: the R-LEGAL-1 paid-customer stop point (counsel review, or a separate dated acceptance); the fee, invoicing cadence and term for the Founding Partner Program; whether to keep the optional location field; candidate-link expiry; the malware scanner (self-hosted or hosted); the escalation queue mailbox.
4. Create the support, privacy and queue mailboxes; name the privacy handler; confirm Nadine as incident lead.
5. Approve each DNS record when shown: `recruiting.`, `jobs.`, the Postmark sending and inbound domain, and the Google Cloud verification record only if the customer uses Google.
6. Create the Postmark account; later the Upstash database, the Sentry organization and, optionally, PostHog.
7. Review and sign off the customer documents (limitation sheet, security overview, support statement, guides) and the paid-agreement additions; take them to counsel or record the acceptance.
8. Select the founding customer (a Microsoft 365 company is preferred), confirm it owns or authorizes its LinkedIn, Indeed and ZipRecruiter employer accounts, and sign the agreement.
9. Approve point-in-time recovery and the restore drill on the production project.
10. Give the dated real-data sign-off in `docs/spec/00` section O only when every blocker in `docs/readiness/20` carries evidence.

## 11. Proposed release-1 acceptance test

One scripted run on staging with synthetic data, executed twice in a row without a failure after fixes, then the same
script on production with the founding customer's real role up to, but not including, the first real candidate. Every
step has a pass condition and a piece of evidence (screenshot, record id, run id) filed with the rehearsal record.

| # | Step | Passes when |
|---|---|---|
| 1 | ITS administrator signs in with Microsoft and a second factor; an email link is refused for staff | session shows `aal2`; the refusal is audited |
| 2 | Customer owner signs up with Microsoft or Google, creates the company | membership role is owner; company created event |
| 3 | Owner invites a hiring manager who accepts through Microsoft or Google sign-in | the invitee lands in the company with role hiring manager; no email link involved |
| 4 | Hiring manager runs the intake conversation on the real model; unlawful criteria declined | packet compiled with at most six must-haves; declined criteria absent |
| 5 | Owner approves the packet (not its author) | role open; version 1 approved; the author's own approval refused |
| 6 | Job page live on `jobs.identifiedtalent.com` with valid JobPosting data; sitemap and feed validate | Google's rich-results test passes; sitemap lists the page; feed validates against its schema |
| 7 | Posting package produced; three tracked links; ITS records each board URL; the worker verifies each; states move to Live and verified | no board is live before its URL verifies |
| 8 | Two hundred synthetic applications in sixty minutes through the three links, PDF and DOCX résumés, from the phone browser project | no server error; rate limits refuse only abuse; every application carries source and source detail; no tracking token in any candidate-facing record |
| 9 | Acknowledgment checkbox required and unchecked by default; transparency block present; no SMS checkbox | a submission without the acknowledgment is refused |
| 10 | Résumés land in the private bucket under scoped paths with random names; a test virus file is quarantined and never extracted; one tenant cannot read another's file | signed URL only; public read refused; quarantine audit event |
| 11 | Confirmation email delivered to a test inbox through Postmark | DKIM and SPF pass; disclosure present |
| 12 | Extraction with verified quotes; assessment with strengths, a concern and an unknown; confidence shown | quotes found in the résumé text; unknown rendered |
| 13 | Ineligible answer holds, reminds, escalates, never declines | the decline message exists only after a human decision |
| 14 | Owner invites a screen; candidate completes it on the real model with one follow-up and a HUMAN hand-off | follow-up cap respected; escalation opened with the transcript; candidate told the response time |
| 15 | Owner requests an interview; candidate picks a time in their zone; ICS attached; candidate reschedules once and cancels once | calendar events created and removed; team told each time |
| 16 | Interviewer receives the booking notice and reminders | 24-hour and 2-hour reminders sent |
| 17 | Hiring manager records the post-interview decision from the screen: next round, then finalist | stage changes visible in the timeline with a human actor |
| 18 | Owner declines another candidate with a reason | decline email sent after the decision; audit record with the reason |
| 19 | Outcome recorded as hired; role closed; closure checklist names the three boards; ITS ticks each as removed | active candidates in the talent pool; role page shows nothing still up |
| 20 | Candidate asks for access and then deletion from the status page; administrator fulfils with confirmation | export excludes rationale; anonymized; the link answers 410 |
| 21 | Owner brings in a recruiter; recruiter claims from the queue; owner ends access | grant visible, then ended; recruiter's next request refused; queue entry back |
| 22 | Hard bounce and spam complaint through Postmark webhooks | address suppressed; owner told; nothing sent to a suppressed address |
| 23 | A synthetic error reaches Sentry | no candidate data or token in the event |
| 24 | Two application instances share one rate-limit counter | the "not shared" alert absent; a limit trips across instances |
| 25 | Customer reads their audit history; administrator reads the cross-customer view | records present with actor and reason |
| 26 | Restore drill from the production backup into a scratch project; isolation suite passes there | drill log completed with the date |
| 27 | Administrator corrects an outcome | original kept; correction points to it |
| 28 | Manual figures (applicants by source, stage counts) match the pages | counts agree |

Pass: every step green on two consecutive runs; no severity-1 incident; every real-data blocker in
`docs/readiness/20` carries its evidence. Any red step returns to the build lane.

## 12. Truthful customer-facing feature and limitation list (first draft of Exhibit A)

**ITS AI Recruiting Department, Founding Partner Program. What you get.**

- A conversation that turns "I need to hire a dental hygienist" into a complete, approved role packet: must-haves with reasons, pay range and a pay-transparency check for your state, interview plan, screening questions, a public job description.
- A public job page on our hosting, written for phones, with structured data for search engines, and a job feed and sitemap.
- ITS posts your approved job to LinkedIn, Indeed and ZipRecruiter under your employer accounts, with a separate application link per board, and verifies each posting before calling it live. Applications come straight into your account; you see where each one came from.
- Candidates apply on their phone without creating an account, upload a résumé or describe their experience, and get a confirmation and a status page they can return to.
- Every application is read against your must-haves. You see quotes from the résumé, what is strong, what is a concern and what is unknown, with a confidence level. Nothing is scored, ranked or rejected by the software.
- A person on your team makes every decision to hold, invite, interview or decline. Declines require a reason and send a respectful message only after you decide.
- Screening conversations run one question at a time with an AI assistant that says what it is; the candidate can ask for a person at any time and gets a response time that is true.
- Interview scheduling in the candidate's own time zone, with calendar invitations, reminders, rescheduling and cancellation, based on the availability your team declares.
- An ITS recruiter you can bring in on any candidate, with a response time by business hours; their access is scoped, time-limited, visible to you, and you can end it at once.
- Privacy requests from candidates (access, correction, withdrawal, deletion) handled through the product with deadlines; a privacy notice and AI-use disclosure on every candidate page and message.
- Your own isolated account with an owner, hiring managers, interviewers and HR roles; every privileged read and human decision recorded.
- Hiring outcomes recorded by your team, with the candidate returned to your talent pool when a role closes.

**What is not included in release 1.**

- No automatic rejection, ranking or scoring of candidates, by design.
- No text messaging with candidates; no interview recording; no offer letters, e-signature or onboarding; no background checks.
- No job-board API integrations: posting, pausing and closing on LinkedIn, Indeed and ZipRecruiter are done by ITS by hand under your accounts, and paid promotion on any board is yours to buy directly.
- No connected Microsoft 365 calendar yet; scheduling uses the availability your team declares plus calendar invitations. Google Calendar can be connected if you use Google Workspace.
- No reports page yet: ITS sends you a written weekly summary; a role report is planned within the first sixty days.
- No interviewer brief or side-by-side candidate comparison yet; interviewers receive the booking, time and link.
- No structured interview scorecards; interview decisions are recorded with a note.
- United States only; English only; one company, one role at a time to start.

**Honest statements about where the product stands.**

- Release 1 is new. Every capability above was built and tested against simulated services and is being verified on
  live services before your first candidate; you will receive the acceptance record.
- Our legal documents have not yet been reviewed by an attorney unless the copy you sign says otherwise.
- The AI provider is Anthropic; the hosting providers are listed in the subprocessor list you receive; we do not sell,
  pool or share candidate data across customers.
- Support hours, response times and the incident-notification promise are in the support statement attached to the
  agreement.

## 13. Stop point

This analysis is presented for the founder's approval. Nothing in sections 7 and 8 is authorized by this document.
The Supabase setup already authorized continues regardless. The team's recommendation, for the record: approve the P0
list, decide the R-LEGAL-1 paid-customer stop point first, and keep the pilot unpaid until that decision is written
down.
