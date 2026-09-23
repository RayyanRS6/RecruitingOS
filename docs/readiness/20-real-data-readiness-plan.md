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

No real candidate information enters the system until all twenty-two have passed with evidence.

| # | Blocker | Track | Proven by | Status 22 Sep |
|---|---|---|---|---|
| 1 | Supabase production project is separate from staging | production setup | two project refs; `docs/readiness/03` section 2 run on each | not started |
| 2 | Production database roles are non-superuser and cannot bypass row-level security | production setup | boot check output; `provision-roles.sql` applied; `rls.test.ts` against production-equivalent Postgres | built with mocks; **proven on staging 22 Sep** (`verified:` lines: not superuser, no bypass, `ros_app` enters `app_tenant`) |
| 2a | Supabase's Data API roles (`anon`, `authenticated`, `service_role`) hold no privilege in `public`, and `public` is not an exposed schema | staging verification, repeated on production | migration `0017_supabase_api_roles.sql`; the status report's `data api role` lines; the Data API settings screen | found and fixed in code 22 Sep (the project's default privileges grant every new table to those roles); dashboard step pending |
| 2b | Database connections keep per-connection platform state | staging verification | Session pooler strings (`docs/runbooks/staging-database-setup.md`); the boot check on staging | decided 22 Sep: Session pooler until every platform read runs inside `withPlatform` |
| 3 | Cross-tenant isolation passes against real production-equivalent Postgres | staging verification, repeated on production | `rls`, `tenancy`, `security-coverage` suites against the staging and production databases | built with mocks |
| 4 | Supabase Auth and required staff MFA work | staging verification | `docs/readiness/03` section 3; `identity.test.ts` behaviour reproduced by hand | built with mocks |
| 5 | Candidate links are expiring, scoped, revocable and cannot reach another candidate | staging verification | `privacy-requests.test.ts` boundary test; `security-coverage.test.ts`; **expiry is not implemented today** (links are scoped, revocable by anonymization, single-purpose; there is no calendar expiry), see section E | partly built |
| 6 | Supabase Storage is private and tenant-scoped | staging verification | `storage.test.ts` (adapter), `storage-uploads.test.ts` (tenant-scoped keys, cross-company read refused), the bucket's Private setting on staging | built 22 Sep against the in-memory store; staging proof pending (`docs/runbooks/resume-storage.md`) |
| 7 | Résumé uploads use short-lived authorization and never public URLs | staging verification | `sigv4.test.ts`, `storage.test.ts` (5-minute PUT pinned to a type, 2-minute GET as attachment), `storage-uploads.test.ts` (audited redirect, no key in any response) | built 22 Sep; staging proof pending |
| 8 | File-type, size, signature and malware controls work | staging verification; **malware scanning is a real-data blocker, not a staging blocker** | `file-inspection.test.ts` (signatures, executables, encrypted, macros, malformed, mismatched, oversized), `storage-uploads.test.ts` (quarantine, rejection, EICAR, scanner outage) | type, size and signature checks built 22 Sep; quarantine built; **scanner is a fake** until a real engine is authorized |
| 9 | Production secrets are stored in the approved secret store | production setup | `SECRET_STORE=vault`; Vault rows visible in Supabase | built with mocks; Vault grants applied on staging 22 Sep (the API role stores and rotates, only the worker reads) |
| 10 | Secret reads are audited | staging verification | `secret.read` audit records with purpose | built with mocks |
| 11 | The application never receives the service-role key | staging and production setup | `tests/policy/service-role-guard.test.ts`; environment listings show no such variable | built |
| 12 | Backups are enabled and a restore test has passed | production setup | `docs/readiness/05` drill log | not started |
| 13 | Audit logs capture access, decisions, communications, overrides and deletions | staging verification | `security-coverage.test.ts`, `core.test.ts`, `staff-access.test.ts`; a hand-checked audit read on staging | built with mocks |
| 14 | Privacy-request intake, access, correction, withdrawal and deletion workflows work | staging verification | `privacy-requests.test.ts`; the walk-through log in `docs/readiness/12` | built with mocks |
| 15 | Candidate data is scrubbed from logs, analytics and error reporting | staging verification | `secrets.test.ts`, `integrations.test.ts`; the Sentry synthetic-error proof (decision 3); a log sample | built with mocks; Sentry SDK wired 22 Sep (scrubbing tested in `observability.test.ts`); the staging synthetic-error proof is pending a DSN |
| 16 | Shared rate limiting works | staging verification | `rate-limit.test.ts` on the Upstash adapter (decision 4); the "not shared" alert absent | adapter built 23 Sep (`UpstashSharedCounter`, fail-safe documented in `docs/readiness/15`); staging proof pending |
| 17 | Postmark delivery, inbound replies, bounces, complaints and suppression work | staging verification | `docs/readiness/03` section 4 | built with mocks |
| 18 | The candidate privacy notice and AI-use disclosure are displayed before candidate submission | staging verification | the apply page on staging; see section D for the gaps | partly built |
| 19 | The customer pilot agreement and data-processing terms are accepted, even though not counsel-approved | founder and partner | signed copy in the vault, labelled unreviewed | not started |
| 20 | The incident-response process and responsible person are documented | founder | `docs/readiness/04` with the incident lead named | plan written; lead to be named |
| 21 | The complete real-candidate rehearsal passes in staging | staging verification | the Phase 7 rehearsal record, rerun after fixes | not started |
| 22 | An independent security review is completed, or the founder explicitly accepts its deferral separately | founder | report in the vault, or a dated deferral in `docs/spec/00` section O | not started |

## C. Pilot scope (founder's configuration)

One design partner · one role · US candidates only · one customer administrator · one hiring manager · Nadine as
platform owner and ITS escalation contact · the role's full applicant volume may be accepted (founder amendment of 22 September, `docs/spec/20`; volume monitoring and a stop-accepting switch are release-1 work) · 60 to 90 days · no software charge initially ·
daily oversight by Nadine during the first week · weekly design-partner meeting · human approval before consequential
candidate actions · a human decision for every decline · no automatic rejection · no SMS · no interview recording · no
automated offers · no background-check data · no onboarding · no passive sourcing · no job-board automation · manual
availability and ICS scheduling fallback · no second design partner until seven stable operating days. The pilot runs
on manual availability and ICS unless the partner requires a connected calendar; a Microsoft 365 partner is preferred.

## D. Minimum candidate transparency (before a real candidate submits) and what the apply page shows today

| # | Must show | Today | Work needed |
|---|---|---|---|
| 1 | The company operating the recruiting process | page heading names the company | none |
| 2 | AI assists with organizing and analyzing recruiting information | AI-use notice on the form | none |
| 3 | A human makes advancement and rejection decisions | the same notice: "People make the hiring decisions" | none |
| 4 | What candidate information is collected | on `/privacy`, linked | add a short block on the form |
| 5 | Why it is collected | on `/privacy` | same block |
| 6 | Who may access it | on `/privacy` | same block |
| 7 | How to request access, correction, withdrawal or deletion | on `/privacy` and the status page | same block |
| 8 | The `privacy@identifiedtalent.com` contact | on `/privacy` | same block |
| 9 | A link to the current privacy notice | on the job, status and screening pages; **not on the form** (the form shows the one-sentence notice text with no link; corrected 22 September after verification) | add the link to the form |
| 10 | An affirmative acknowledgment before submission, no pre-checked box | **missing**: the form records which notice versions were shown but has no acknowledgment checkbox | add a required, unchecked checkbox; record it with the notice versions |

The SMS consent checkbox must not appear while texting is off (verify in the rehearsal; today it renders whenever the
notice list includes it). These are release-1 pilot requirements set by the founder on 22 September; they are
implemented in a pull request before the rehearsal (track 2), not now.

## E. Data minimization and known gaps

Collected today by the application form: first and last name, email, phone (optional), location text (optional),
résumé or a no-résumé summary, eligibility answers, notice versions shown. Later: screening answers, interview
scheduling, interviewer feedback, the human-recorded outcome. Never collected: Social Security numbers, dates of birth,
government identification, banking, medical, background-check or tax information (no field exists; the outcome
contract refuses unknown fields).

Open points for the founder: (a) **location text** is collected for commute and eligibility and is not on the
founder's list; keep as optional, or drop; (b) **candidate link expiry** (blocker 5): links are scoped and single
purpose and die on anonymization, but have no calendar expiry; the team proposes an expiry after the application
closes plus the retention period, to be implemented with the storage work.

## F. When risk R-LEGAL-1 is raised again

Before any of: a paid customer; a candidate or role outside the United States; SMS; interview recording; automated
rejection; a second design partner; broader release. Each is a stop point that names the risk again.
