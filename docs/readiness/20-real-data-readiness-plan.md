# 20. Real-data readiness plan (controlled real-candidate pilot)

Written 22 September 2026 from the founder's instruction of the same day. This plan governs the first controlled
real-candidate pilot. It replaces the synthetic design-partner testing phase, which the founder decided to skip, and it
sits under founder-accepted risk **R-LEGAL-1** (`docs/spec/00` section Q): counsel has not reviewed the legal drafts,
that review is deferred, and its absence does not block this first unpaid pilot. Nothing in this plan reduces ITS's
legal or privacy obligations; it records how the pilot is run without counsel's sign-off and when the risk is raised
again. Technical staging verification is **not** skipped.

## A. The four separate tracks

1. **Account setup** (founder, one action at a time; `docs/spec/19` section E): Supabase → Microsoft Entra sign-in
   registration → Anthropic → Vercel → Railway; then Postmark; Google Cloud only if the partner needs Google.
2. **Staging verification** (production team with the founder entering secrets; `docs/readiness/03`): every blocker
   below is first proven on staging with synthetic data.
3. **Production setup** (founder and team): the production Supabase project with point-in-time recovery, the production
   worker on Railway, production settings in Vercel, the production sign-in redirect, the administrator bootstrap on
   production, Sentry and Upstash production only after their staging passes.
4. **Real-data approval** (founder): the dated sign-off in `docs/spec/00` section O, given only when every blocker in
   section B carries evidence.

## B. Real-data technical blockers (founder's list, verbatim in substance) with the track that proves each

No real candidate information enters the system until all twenty-two have passed with evidence. The Status column
was written on 22 September; notes dated 30 September record what the completion work on `audit-remediation` changed.
None of it is staging evidence: every row still needs its proof on staging.

| # | Blocker | Track | Proven by | Status 22 Sep |
|---|---|---|---|---|
| 1 | Supabase production project is separate from staging | production setup | two project refs; `docs/readiness/03` section 2 run on each | not started |
| 2 | Production database roles are non-superuser and cannot bypass row-level security | production setup | boot check output; `provision-roles.sql` applied; `rls.test.ts` against production-equivalent Postgres | built with mocks; **proven on staging 22 Sep** (`verified:` lines: not superuser, no bypass, `ros_app` enters `app_tenant`) |
| 2a | Supabase's Data API roles (`anon`, `authenticated`, `service_role`) hold no privilege in `public`, and `public` is not an exposed schema | staging verification, repeated on production | migration `0017_supabase_api_roles.sql`; the status report's `data api role` lines; the Data API settings screen | found and fixed in code 22 Sep (the project's default privileges grant every new table to those roles); dashboard step pending |
| 2b | Database connections keep per-connection platform state | staging verification | Session pooler strings (`docs/runbooks/staging-database-setup.md`); the boot check on staging | decided 22 Sep: Session pooler until every platform read runs inside `withPlatform`; 12 Oct: three redeploys filled the staging pooler (`ros_app`'s 15 connections); each Vercel request now waits until its pool has closed its idle connections and `DATABASE_POOL_MAX` is 3, but only the transaction pooler is a hard cap on connections (`docs/spec/00` section Q) |
| 3 | Cross-tenant isolation passes against real production-equivalent Postgres | staging verification, repeated on production | `rls`, `tenancy`, `security-coverage` suites against the staging and production databases | built with mocks |
| 4 | Supabase Auth and required staff MFA work | staging verification | `docs/readiness/03` section 3; `identity.test.ts` behaviour reproduced by hand | built with mocks |
| 5 | Candidate links are expiring, scoped, revocable and cannot reach another candidate | staging verification | `privacy-requests.test.ts` boundary test; `security-coverage.test.ts`; **expiry is not implemented today** (links are scoped, revocable by anonymization, single-purpose; there is no calendar expiry), see section E | partly built; 30 Sep: still no expiry on the status link (it waits on the retention decision); the new reply address (`reply-<token>@`) is never the status token, so a mail header cannot open the status page; the privacy-request confirmation link expires after 24 hours and works once; tracked apply links never expire and lead only to the public apply page |
| 6 | Supabase Storage is private and tenant-scoped | staging verification | `storage.test.ts` (adapter), `storage-uploads.test.ts` (tenant-scoped keys, cross-company read refused), the bucket's Private setting on staging | built 22 Sep against the in-memory store; staging proof pending (`docs/runbooks/resume-storage.md`) |
| 7 | Résumé uploads use short-lived authorization and never public URLs | staging verification | `sigv4.test.ts`, `storage.test.ts` (5-minute PUT pinned to a type, 2-minute GET as attachment), `storage-uploads.test.ts` (audited redirect, no key in any response) | built 22 Sep; staging proof pending |
| 8 | File-type, size, signature and malware controls work | staging verification; **malware scanning is a real-data blocker, not a staging blocker** | `file-inspection.test.ts` (signatures, executables, encrypted, macros, malformed, mismatched, oversized), `storage-uploads.test.ts` (quarantine, rejection, EICAR, scanner outage) | type, size and signature checks built 22 Sep; quarantine built; ClamAV adapter built 30 Sep (`SCAN_PROVIDER=clamav`, `clamav.test.ts` against a stand-in clamd); **the engine is not running yet**: the founder starts the `clamav/clamav` service on Railway (`docs/runbooks/resume-storage.md`), and a production worker raises a standing `scanner.fake` alert until then |
| 9 | Production secrets are stored in the approved secret store | production setup | `SECRET_STORE=vault`; Vault rows visible in Supabase | built with mocks; Vault grants applied on staging 22 Sep (the API role stores and rotates, only the worker reads) |
| 10 | Secret reads are audited | staging verification | `secret.read` audit records with purpose | built with mocks |
| 11 | The application never receives the service-role key | staging and production setup | `tests/policy/service-role-guard.test.ts`; environment listings show no such variable | built |
| 12 | Backups are enabled and a restore test has passed | production setup | `docs/readiness/05` drill log | not started |
| 13 | Audit logs capture access, decisions, communications, overrides and deletions | staging verification | `security-coverage.test.ts`, `core.test.ts`, `staff-access.test.ts`; a hand-checked audit read on staging | built with mocks; 30 Sep: the customer reads its own history in plain words and downloads it (`GET /companies/current/audit`, `audit.csv`, audited `audit.exported`; Setup's Audit history card; `apps/api/src/company-settings.test.ts`); postings, links, invitations, report downloads, company changes, re-authentication and free-form messages are audited |
| 14 | Privacy-request intake, access, correction, withdrawal and deletion workflows work | staging verification | `privacy-requests.test.ts`; the walk-through log in `docs/readiness/12` | built with mocks; 30 Sep: the public request form for people without a status link (`/c/privacy-request`, linked from `/privacy`; a 24-hour confirmation link, nothing recorded before the button; `apps/api/src/pages/privacy-request.tsx`; tested in `apps/api/src/company-settings.test.ts`, "the public privacy-request form") |
| 15 | Candidate data is scrubbed from logs, analytics and error reporting | staging verification | `secrets.test.ts`, `integrations.test.ts`; the Sentry synthetic-error proof (decision 3); a log sample | built with mocks; Sentry SDK wired 22 Sep (scrubbing tested in `observability.test.ts`); 30 Sep: failed jobs and failed workflow runs reach Sentry with kinds and ids only and the last error scrubbed of email- and phone-shaped text (`apps/api/src/failure-reports.ts`, `job-failures.test.ts`), the test-error route for the proof (`POST /api/v1/admin/observability/test-error`, `observability-route.test.ts`), and the privacy-request token masked like the other candidate links; the staging synthetic-error proof is pending a DSN |
| 16 | Shared rate limiting works | staging verification | `rate-limit.test.ts` on the Upstash adapter (decision 4); the "not shared" alert absent | adapter built 23 Sep (`UpstashSharedCounter`, fail-safe documented in `docs/readiness/15`); staging proof pending |
| 17 | Postmark delivery, inbound replies, bounces, complaints and suppression work | staging verification | `docs/readiness/03` section 4 | built with mocks; 30 Sep: candidate replies come back into the product through per-application `reply-<token>@` addresses once the inbound domain is live (migration 0023; `docs/runbooks/candidate-replies.md`; `apps/api/src/messages.test.ts`), and a Postmark `SubscriptionChange` is honoured as a suppression (`postmark-subscription.test.ts`); needs the Postmark account, the sending domain and the inbound domain |
| 18 | The candidate privacy notice and AI-use disclosure are displayed before candidate submission | staging verification | the apply page on staging; see section D | built 30 Sep (every item of section D; `public-job-surfaces.test.ts`, `tests/e2e/specs/candidate-phone.spec.ts`); staging proof pending |
| 19 | The customer pilot agreement and data-processing terms are accepted, even though not counsel-approved | founder and partner | signed copy in the vault, labelled unreviewed | not started |
| 20 | The incident-response process and responsible person are documented | founder | `docs/readiness/04` with the incident lead named | plan written; lead to be named |
| 21 | The complete real-candidate rehearsal passes in staging | staging verification | the Phase 7 rehearsal record, rerun after fixes | not started |
| 22 | An independent security review is completed, or the founder explicitly accepts its deferral separately | founder | report in the vault, or a dated deferral in `docs/spec/00` section O | not started |

## C. Pilot scope (founder's configuration)

One design partner · one role · US candidates only · one customer administrator · one hiring manager · Nadine as
platform owner and ITS escalation contact · the role's full applicant volume may be accepted (founder amendment of 22 September, `docs/spec/20`; volume monitoring and a stop-accepting switch were built on 30 September: the "Applications by source" card and the daily `volume.high` alert above 100 a day, and "Stop accepting applications" on the role page) · 60 to 90 days · no software charge initially ·
daily oversight by Nadine during the first week · weekly design-partner meeting · human approval before consequential
candidate actions · a human decision for every decline · no automatic rejection · no SMS · no interview recording · no
automated offers · no background-check data · no onboarding · no passive sourcing · no job-board automation · manual
availability and ICS scheduling fallback · no second design partner until seven stable operating days. The pilot runs
on manual availability and ICS unless the partner requires a connected calendar; a Microsoft 365 partner is preferred.

## D. Minimum candidate transparency (before a real candidate submits) and what the apply page shows

The "Today" column is the 22 September reading. Every item was built on 30 September 2026: the apply form's
"Before you send" block (`TransparencyBlock` in `apps/api/src/pages/candidate.tsx`), proven by
`apps/api/src/public-job-surfaces.test.ts` ("the apply form shows the transparency block and the privacy link ..." and
"the acknowledgment is required ...") and, on the phone project in CI, `tests/e2e/specs/candidate-phone.spec.ts`.

| # | Must show | Today (22 Sep) | Done (30 Sep 2026) |
|---|---|---|---|
| 1 | The company operating the recruiting process | page heading names the company | done: the block opens "<company> runs this hiring process and is the employer" |
| 2 | AI assists with organizing and analyzing recruiting information | AI-use notice on the form | done: "software only helps organize and summarize", and the AI-use notice in the block |
| 3 | A human makes advancement and rejection decisions | the same notice: "People make the hiring decisions" | done: "People at <company> make every hiring decision", repeated in the acknowledgment |
| 4 | What candidate information is collected | on `/privacy`, linked | done: "What we collect" in the block |
| 5 | Why it is collected | on `/privacy` | done: "Why" in the block |
| 6 | Who may access it | on `/privacy` | done: "Who can see it" (the hiring team, an ITS recruiter only if brought in, the providers in the notice) |
| 7 | How to request access, correction, withdrawal or deletion | on `/privacy` and the status page | done: "Your choices" in the block; `/privacy` also links the public request form (`/c/privacy-request`) |
| 8 | The `privacy@identifiedtalent.com` contact | on `/privacy` | done: in the block, from `PRIVACY_EMAIL` |
| 9 | A link to the current privacy notice | on the job, status and screening pages; **not on the form** (the form shows the one-sentence notice text with no link; corrected 22 September after verification) | done: "Read how we handle your information" links `/privacy` from the form |
| 10 | An affirmative acknowledgment before submission, no pre-checked box | **missing**: the form records which notice versions were shown but has no acknowledgment checkbox | done: a required, unchecked box ("I have read the notice above and I understand that people, not software, make the hiring decisions"); a submission without it comes back with everything kept; recorded as `answers.acknowledgment {at, noticeVersions, ip}` with the notice versions the server rendered, and in the candidate's consent record |

The SMS consent checkbox no longer appears while texting is off: `SMS_ENABLED` is off by default, the box is not
rendered and a posted consent is ignored (`public-job-surfaces.test.ts`, "with texting on, the SMS checkbox is on the
form ..." proves the other side). The rehearsal still checks all of this on staging.

## E. Data minimization and known gaps

Collected today by the application form: first and last name, email, phone (optional), location text (optional),
résumé or a no-résumé summary, eligibility answers, notice versions shown, and (since 30 September) the
acknowledgment with its time and the address the trusted proxy reported. Recorded about the application, not asked of
the candidate: the source, a source detail a person typed for a referral or campaign link, and the tracked link's id,
never its token. Later: screening answers (including the answers to "Ask about this in a screen" questions), interview
scheduling with an optional cancellation reason, interviewer feedback, the candidate's email replies once the inbound
domain is live, the human-recorded outcome. Never collected: Social Security numbers, dates of birth, government
identification, banking, medical, background-check or tax information (no field exists; the outcome contract refuses
unknown fields).

| Item | State on 30 September 2026 |
|---|---|
| The collected list above, told to the candidate before they submit | done: the "What we collect" line of the apply form's block (section D) matches it |
| Tracking tokens kept out of candidate records | done: `docs/spec/20` item 19 (`public-job-surfaces.test.ts`) |
| The reply address kept apart from the status link | done: a separate random `reply_token` per application (migration 0023), never returned by the API |
| (a) **Location text** is collected for commute and eligibility and is not on the founder's list; keep as optional, or drop | **still open**, the founder's decision; the field stays optional and is named in the block |
| (b) **Candidate link expiry** (blocker 5): links are scoped and single purpose and die on anonymization, but have no calendar expiry; the team proposes an expiry after the application closes plus the retention period | **still open**, waiting on the retention decision (`docs/legal-drafts/10`); nothing expires the status link yet. Tracked apply links never expire; the privacy-request confirmation link expires after 24 hours |

## F. When risk R-LEGAL-1 is raised again

Before any of: a paid customer; a candidate or role outside the United States; SMS; interview recording; automated
rejection; a second design partner; broader release. Each is a stop point that names the risk again.
