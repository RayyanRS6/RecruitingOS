# 20. Job distribution (release-1 scope amendment of 22 September 2026)

Founder decision: job distribution is release 1. A real job is posted to LinkedIn, Indeed and ZipRecruiter by ITS by
hand, each posting carries its own Recruiting OS application link, candidates apply into Recruiting OS, and Recruiting
OS is the system of record. No scraping; no claim of a native integration without approved partner access; no
automated paid sponsorship; no passive sourcing. This document is the "before coding" inspection the founder asked
for.

**Status on 30 September 2026: built on mocks.** Every requirement in section 2 now has code and a test; the "Built"
column says where (commits `3c99f67` and `b098a8b` on `audit-remediation`). What is left needs staging or the founder:
the `jobs.identifiedtalent.com` DNS record and Vercel domain with `JOBS_BASE_URL` (item 1), the load run against
staging (item 18), Google's rich-results check on staging (section 4), and the first real posting on each board.
One deploy check: at commit `ed9147e` the Next.js shell (`apps/shell/app`) had route handlers for `/api`, `/careers`,
`/c`, `/feeds`, `/webhooks`, `/privacy` and `/healthz` but not for `/a/:token`, `/sitemap.xml` or `/robots.txt`, so
those API routes (proven against the API directly) would not be reached on Vercel; handlers for them were being added
in the working tree on 30 September and must be in the deployed build. Section 1 is the record of what existed on
22 September and is kept as written.

## 1. What exists today (verified in the code and tests)

| Capability | Where | State |
|---|---|---|
| Per-company careers page listing open roles | `GET /careers/:slug` (`apps/api/src/pages/candidate.tsx:38`) | built; lists only roles with status `open` |
| Public job page with employer name, title, location, pay range, description, notices | `GET /careers/:slug/jobs/:roleId` | built; the client company is named and linked as the employer |
| Candidate self-application, no JavaScript, mobile-first layout, honeypot, rate limits | `GET/POST …/apply` | built; tested by API tests and the CSP test; never rendered in the phone Playwright project |
| JobPosting structured data on open job pages | `packages/integrations/src/jobboards/native.ts:54` via the escaped Layout script | built, incomplete: no `validThrough`; `employmentType` emits `CONTRACT` and `INTERNSHIP` (not schema.org tokens); no `sameAs` or logo; omitted on paused or closed pages |
| Application source stored | `applications.source`, `candidates.first_source` | built; only two values ever written: `careers_page`, `email_in` |
| Six posting channels through one workflow | `publish_role` (`packages/workflows/src/definitions/publish-role.ts`), adapters in `packages/integrations/src/jobboards/` | built: careers page marked live by construction; Google for Jobs "awaiting verification"; email-in intake address; LinkedIn, Indeed and ZipRecruiter adapters return "manual action required" with a one-sentence instruction and never post anything |
| A LinkedIn-format XML feed | `GET /feeds/linkedin.xml` (`apps/api/src/app.ts:101`) | built, undocumented, cross-tenant, empty publisher URL, salary reduced to text |
| Posting retry | `POST /roles/:id/postings/:channel/retry` | built (failed channels only) |
| Role pause, resume, close with outcome; active candidates moved to the talent pool on close | `apps/api/src/routes/roles.ts`, `packages/core/src/outcomes.ts` | built and tested; pausing stops intake without rejecting anyone but also delists the role from the careers page and feed, drops the structured data and silently drops email-in applications; closing never touches posting rows |
| Public board URL column | `postings.external_url` | exists; written only by the careers-page and Google adapters with the job page's own URL; no route or form records a board's URL |
| Per-role and per-stage application counts | roles list, brief | built |

## 2. What is missing for the founder's release-1 list

| # | Requirement | Gap (22 September) | Built (30 September 2026) |
|---|---|---|---|
| 1 | Hosted public job pages under `jobs.identifiedtalent.com` | every public URL derives from `APP_BASE_URL`; no `JOBS_BASE_URL`, no host-aware routing; the hostname needs a DNS record (gate 2.5) and a Vercel domain | Built: `JOBS_BASE_URL` (`apps/api/src/env.ts`; defaults to `APP_BASE_URL`, https origin without a path in production) and `jobUrls` (`apps/api/src/services/job-urls.ts`) build every careers, job, apply, feed, sitemap, package and tracked-link URL; the same deployment answers on both hosts, so no host routing is needed. Test: `apps/api/src/job-distribution.test.ts` ("JOBS_BASE_URL defaults to APP_BASE_URL ..."). Still the founder's: the DNS record and the Vercel domain, then the variable |
| 2 | Candidate self-application | exists; needs the affirmative acknowledgment and transparency block (`docs/readiness/20` section D) | Built: `TransparencyBlock` on the apply form (`apps/api/src/pages/candidate.tsx`) with a required, unchecked box, recorded as `answers.acknowledgment {at, noticeVersions, ip}`. Test: `apps/api/src/public-job-surfaces.test.ts` |
| 3 | Mobile-accessible application | exists; no phone-project test renders the form | Built: `tests/e2e/specs/candidate-phone.spec.ts` walks the job page, the apply form with its acknowledgment, the screening conversation and the scheduling page in the phone project, with accessibility and sideways-scrolling checks. Runs in CI only (Playwright cannot run on the team's Windows machine) |
| 4 | JobPosting structured data on every job page | add `validThrough`, map employment types to schema.org tokens, add `sameAs` and logo when known, keep the block on paused pages with `validThrough` in the past when closed | Built: `jobPostingJsonLd`, `jobValidThrough` (60 days, renewed while open; the closing day once closed), `schemaEmploymentType`, `hiringOrganization.sameAs` and `logo` from the company card (`packages/integrations/src/jobboards/native.ts`). Tests: `packages/integrations/src/jobboards/jobboards.test.ts`, `public-job-surfaces.test.ts` ("the JobPosting data renews validThrough ..."). Google's rich-results check on staging is still manual (section 4) |
| 5 | Job sitemap | none; add `/sitemap.xml` (job pages, careers pages) and `robots.txt` | Built: `GET /sitemap.xml` and `GET /robots.txt` (`apps/api/src/pages/public-feeds.ts`). Test: `public-job-surfaces.test.ts` ("the sitemap, robots and both feeds ...") |
| 6 | Documented public job feed | add a generic feed (XML in the common job-board schema and JSON) with publisher URL, per-job canonical URL, employer, location, pay, dates; document its fields and cadence | Built: `GET /feeds/jobs.xml`, `GET /feeds/jobs.json` and the corrected `GET /feeds/linkedin.xml` (`jobFeedXml`, `jobFeedJson`, `linkedInFeedXml` in `packages/integrations/src/jobboards/external.ts`); open roles that accept applications only, rebuilt at most every five minutes; fields and cadence in `docs/15-integrations.md`. Test: `public-job-surfaces.test.ts` |
| 7 | Board-specific tracked application links | none; add short random link tokens mapped to (posting, source, source detail); `/a/:token` redirects to the apply page and sets an httpOnly, short-lived cookie; the token never appears in candidate-facing records | Built: `application_links` (migration 0020; `packages/core/src/application-links.ts`, 12-character tokens); `publish_role` creates one per board; `GET /a/:token` (`apps/api/src/pages/links.tsx`) counts the visit and seals the source in the httpOnly `ros_src` cookie (30 days); `GET/POST /roles/:id/links` and `.../disable` for referral, direct and other links ("Other links" on the Posting tab). Tests: `job-distribution.test.ts`, `public-job-surfaces.test.ts`, `apps/api/src/postings-routes.test.ts` ("tracked links: ...") |
| 8 | Source and source detail on every application | add `applications.source_detail`; resolve from the link cookie at submission; values: linkedin, indeed, ziprecruiter, referral, direct, other, email_in, careers_page | Built: `applications.source`, `source_detail`, `link_id` (migration 0020), resolved by `resolveApplicationSource` at submission; the vocabulary is `SOURCES` in `application-links.ts`; the report counts applicants by source. Tests: `public-job-surfaces.test.ts` ("a tracked link counts the visit ..."), `job-distribution.test.ts` |
| 9 | Job-posting package | assemble per board: title, employer, location(s), employment type, pay range and basis, description, screening questions (as text), the board-specific apply link, the intake email address, the job page URL; shown on the role's Posting tab and copyable | Built: `postingPackage` (`packages/core/src/postings.ts`), `GET /roles/:id/postings/:channel/package`, "Copy posting package" on each board card (`apps/web/src/pages/RolePosting.tsx`). Tests: `packages/core/src/postings.test.ts`, `postings-routes.test.ts` ("describes every channel ...") |
| 10 | Manual posting instructions and per-board status tracking | instructions exist as one sentence; add per-board steps and user actions | Built: numbered `steps` per board from the adapters (`external.ts`: sign in, paste the package, use the board's own apply link, billing, record the URL), one plain sentence per state on each card, and the brief's "post it on ... from your own account" card. Tests: `jobboards.test.ts`, `postings-routes.test.ts` |
| 11 | Posting states Draft, Approved, Ready to post, Posted manually, Submitted through integration, Live and verified, Paused, Failed, Closed | replace the five adapter states with this machine; map: careers page and Google for Jobs move through the same states | Built: `POSTING_STATES`, `POSTING_STATE_LABEL`, `POSTING_TRANSITIONS`, `transitionPosting` (`packages/core/src/postings.ts`; a refused move is 409 `posting_transition`); migration 0020 rewrote the five earlier states. Test: `postings.test.ts` (every transition, the refused ones) |
| 12 | Never live until the board URL is verified | add "record public URL" and "verify" (the worker fetches the URL, checks reachability and the job title, then marks Live and verified); the careers page also passes through verification instead of being live by construction | Built: recording a URL queues the worker's `posting.verify` job (`apps/api/src/container.ts`), which fetches the page with `RealUrlVerifier` (`packages/integrations/src/jobboards/verify.ts`; `LINK_VERIFIER`), checks the title, and marks `live_verified` or, after three failed checks, `failed`; the careers page goes through the same check; a person may confirm with a required note ("I checked it myself"); Google for Jobs is marked verified by a person from Search Console. Tests: `job-distribution.test.ts`, `postings-routes.test.ts` |
| 13 | Store each public board URL | `postings.external_url` exists; add the route and form to enter it | Built: `POST /roles/:id/postings/:channel/url` (https only) and "Record the public URL" on each board card. Test: `postings-routes.test.ts` ("recording a board's public address ...") |
| 14 | Authorized users close or pause a posting | add per-posting pause, resume and close (permission `role.manage`), audited | Built: `POST /roles/:id/postings/:channel/pause`, `/resume`, `/close` (`role.manage`; audited `posting.changed`); resume returns a posting to where it was. Test: `postings-routes.test.ts` ("pause keeps the verification and resume restores it ...") |
| 15 | Closing a role names the boards still needing manual closure | on role close, mark each externally posted board "Closed: remove from board" with a checklist the owner ticks as each board is taken down; role page shows what is still up | Built: `recordRoleOutcome` closes every posting and marks each board that was up `closureRequired` (`posting.closure_required`); `boardsStillUp` on `GET /roles/:id`, the "Still up on: ..." alert on the role page, the brief's "Still posted on ..." card, and the "Removed from this board" box (`POST .../closure-confirm`). Tests: `job-distribution.test.ts` ("closing the role closes every posting ..."), `postings-routes.test.ts` ("closing the role names the boards still up ...") |
| 16 | Volume monitoring and stop accepting applications | add per-role and per-source counts by day, a threshold alert, and an "accepting applications" switch distinct from pause (the job page stays up and says applications are closed; no candidate is rejected) | Built: `GET /roles/:id/volume` (14 days by source, in the company's time zone) and the "Applications by source" card; the daily `stuck_role_detector` raises `volume.high` once a day above `roles.volume_alert_per_day` (null means 100) for owners and admins; `POST /roles/:id/applications/accepting` and "Stop accepting applications" on the role page. Tests: `postings-routes.test.ts` (the volume report, the daily check, the switch) |
| 17 | No automatic rejection of excess applicants | unchanged rule; the switch above stops intake without touching anyone | Built: with the switch off the form, the upload and the submission answer 404 and the job page says applications are closed; email-in applications are held and added when the role reopens; nobody who applied is touched. Tests: `postings-routes.test.ts` ("the accepting switch ... touches nobody who applied"), `public-job-surfaces.test.ts` |
| 18 | Realistic-volume test of the application journey | a scripted load run against staging (hundreds of synthetic applications in an hour) with the rate limits' behaviour recorded | Built: `scripts/load-apply.ts` (synthetic applications at a set rate, 429s honoured by their `Retry-After`, counts and latencies printed; a host other than localhost must be named again with `--confirm-host`); proven locally by `apps/api/src/load-apply.test.ts`. The recorded run against staging waits for staging (`docs/readiness/03` section 7a) |
| 19 | Tracking parameters never in candidate-facing records | the redirect-and-cookie design keeps tokens out of URLs the candidate sees, out of emails, and out of the status page | Built: the redirect sets a sealed cookie and sends the person to the plain apply URL; the application stores the source, the detail and the link id, never the token; `application.received` carries `linkId` only. Test: `public-job-surfaces.test.ts` ("... the token appears nowhere, and the cookie is cleared") |
| 20 | Client company identified as the hiring employer | already the case on the job page and in the structured data; keep it in the feed and the packages | Built: the company is `hiringOrganization` in the JobPosting data (with website and logo when set), the employer in both feeds, and `employer` in every posting package. Tests: `public-job-surfaces.test.ts`, `postings.test.ts` |

## 3. Required infrastructure

- `jobs.identifiedtalent.com` on Vercel (a CNAME, shown for review under gate 2.5) and `JOBS_BASE_URL` in the settings; the application host stays `recruiting.identifiedtalent.com`.
- One migration: link tokens table, `applications.source_detail`, posting state and closure fields.
- The worker (Railway) for URL verification and volume alerts.
- Résumé storage (decision 2) for uploads at volume; Postmark before real candidate confirmations.

## 4. Tests required

Unit: link-token generation and lookup; the posting state machine (every transition, refused ones); source resolution;
JSON-LD builder (schema.org token mapping, `validThrough`). API: tracked link redirect sets the cookie and records
source and detail on the application; feed and sitemap contents validate against their schemas; posting package
contents; per-posting pause, close, record-URL and verify routes with permissions; role close marks boards for manual
closure; the accepting-applications switch refuses intake without rejecting anyone; volume counts. Browser: the apply
form on the phone project end to end, including the acknowledgment. Load: a scripted run of a few hundred synthetic
applications against staging, recorded. Structured data: the job page passes Google's rich-results validation on
staging (manual, recorded).

Where they are (30 September 2026): unit in `packages/core/src/postings.test.ts` and
`packages/integrations/src/jobboards/jobboards.test.ts`; API in `apps/api/src/job-distribution.test.ts`,
`apps/api/src/postings-routes.test.ts` and `apps/api/src/public-job-surfaces.test.ts`; browser in
`tests/e2e/specs/candidate-phone.spec.ts` (CI). **Load run: `scripts/load-apply.ts`**, for example
`tsx scripts/load-apply.ts --url https://<staging host>/careers/<slug>/jobs/<roleId>/apply --count 200 --per-minute 5 --confirm-host <staging host>`;
it posts synthetic applications exactly as the form does, honours each 429's `Retry-After`, and prints accepted,
rate-limited and refused counts with latency percentiles; `apps/api/src/load-apply.test.ts` proves it against a local
app. The staging run and the rich-results check are recorded when staging exists (`docs/readiness/03` section 7a).

## 5. Impact on the launch sequence

The build is medium-sized (estimate: three to five working days of the production team, one migration, one pull
request per area) and sits between Phase 3 (staging) and Phase 7 (rehearsal): it needs staging to verify URLs and to
run the load test, and the rehearsal must include a posting-to-application journey per board. Account creation is
unchanged. Two founder actions are added: approve the `jobs.` DNS record (gate 2.5) and, later, the Vercel domain.

## 6. Does this change the current Supabase setup instructions?

No. The Supabase organization and `recruiting-os-staging` project are created exactly as planned; the job-distribution
migration is applied later through the normal owner migration process, like every other migration.

## 7. Partner integration track: summary

Section 8 answers the founder's twelve questions per provider from the providers' official pages, read on 22 September 2026. Partner approval must not delay the manual workflow above, and none of it is implemented.

| Provider | Door open to a new ATS today? | Minimum eligibility stated | Sandbox | What the manual workflow relies on instead |
|---|---|---|---|---|
| Indeed | partnership required for every ATS-side program; case-by-case | at least ten paying clients, a fully launched product, no free tier that posts jobs, product as system of record | none | the customer's own Indeed employer account; ITS posts by hand with the Indeed tracked link |
| ZipRecruiter | partnership required; gated by email or web form with no published criteria | none published | none (testing against production) | the customer's own ZipRecruiter subscription; ITS posts by hand with the ZipRecruiter tracked link |
| LinkedIn | Job Posting API closed to new partners; Apply Connect restricted to approved developers with no promised agreement | not published; the form asks for customer count, five largest customers and daily job volume | test organization after acceptance | the customer's own LinkedIn company page and job posting; ITS posts by hand with the LinkedIn tracked link |

## 8. Partner integration track (documented, not implemented)

Read from official pages on 22 September 2026; page dates are given where the page states one. Quotations are the
providers' words. Nothing below is a commitment by any provider, and nothing has been applied for.

### 8.1 Indeed (Indeed Apply Sync, Disposition Sync, Job Sync API and XML, Sponsored Jobs API)

Sources: docs.indeed.com (ATS integration guide, ATS guidelines dated 9 June 2026, Indeed Apply, Job Sync API and XML,
Disposition Sync guide dated 21 September 2026, Sponsored Jobs API and usage policy, legal terms: developer agreement,
additional API terms, Indeed Apply terms), partners.indeed.com, indeed.com/hire/ats-integration, the employer help
articles on the Indeed Apply policy, the single-source feed policy effective 31 March 2026, and aggregation.

1. **Partnership or approval required.** Yes, for every ATS-side program. The integration guide requires "A signed
   Developer Agreement between your company and Indeed" and submission of "every integration build through the formal
   request channel". The agreement: "Indeed must approve, in writing, any Integration ... in advance of your first
   use" and "may reject any Integration ... for any or no reason". Eligibility for an ATS multisource feed: "Support at
   least ten clients", "Operate as a fully launched product with an established business presence", "Charge clients
   for the product"; prohibited: "Beta or newly launched ATS products", "Free tiers or free trials that allow job
   posting", "Mandatory talent networks".
2. **Application process.** The "Become an Indeed partner" form (company, platform type, integrations of interest,
   estimated annual job volume, number of exclusive clients, two or three example clients using the platform on their
   career site, confirmation that the platform is the system of record). Indeed reviews, vets the build, sends the
   Developer Agreement, enables Partner Console access and a questionnaire, then configures the app. "Partnerships
   are considered on a case-by-case basis"; "Indeed does not guarantee any particular time frame"; past integrations
   "usually take about six weeks to configure, test, review with Indeed, and deploy". No sandbox.
3. **Certification.** No badge called certification; review gates instead: written pre-approval, XML and Indeed Apply
   review with Indeed's test tools, Job Sync documentation review with screenshots (Indeed branding, source tracking,
   an employer switch to disable Indeed Apply), Disposition Sync sandbox validation then production, screener questions
   mandatory for approval, US EEO questions required for US clients. A Silver, Gold and Platinum tier program exists
   for ATS platforms with a quality-signal adoption threshold.
4. **Employer account or contract.** Vendor side: the Developer Agreement (or third-party version), the Additional API
   Terms with a data-protection addendum, insurance and indemnity, an unrestricted test employer account for Indeed.
   Employer side: each client needs an Indeed employer account with a corporate email; sponsorship needs billing set
   up on the client's account. Client exclusivity: "An ATS's clients cannot use a different ATS on their company
   website".
5. **Job posting.** Yes, through the Job Sync API (GraphQL, OAuth) or a complete multisource XML feed crawled four
   times a day; all of all clients' public jobs must be submitted, the ATS must be the source of truth, updates within
   fifteen minutes; test jobs are not allowed outside onboarding.
6. **Native application ingestion.** Yes, Indeed Apply posts JSON to an HTTPS endpoint of the ATS with an HMAC
   signature; applications must be accepted with 2xx, never redirected, retried with backoff, kept by Indeed sixty
   days; résumés arrive base64 in txt, pdf, doc, docx or rtf; applications may not be filtered, altered, pooled or
   shared across clients; Indeed source attribution is required.
7. **Screening questions.** Supported and mandatory: JSON screener questions hosted by the ATS or passed inline, with
   demographic questions in a separate field for US jobs; conversion drops beyond twenty questions.
8. **Sponsored jobs.** Through the Sponsored Jobs API for approved partners with three-legged OAuth by the employer;
   the employer's own account and billing; per-call charges under the usage policy; access limited to customers that
   sponsored in the last three months.
9. **Disposition and hiring signals.** Required: Disposition Sync with at least NEW, HIRED and NOT_SELECTED, sent on
   receipt and at least daily, in batches of twenty-five; the ATS must offer clients an opt-out; adoption rate drives
   tier status.
10. **Implementation dependency.** After acceptance: a Job Sync client or a complete XML feed; the HTTPS Indeed Apply
    endpoint with signature verification; hosted screener questions with EEO; a Disposition Sync client mapping our
    stages; monitoring and logging of deliveries; source attribution and an employer switch in the product; optional
    sponsorship. Indeed's own estimate is about six weeks after approval.
11. **Data and security review.** No questionnaire published; the agreement requires records of data-protection
    practices kept five years and open to Indeed's audit, "adequate and appropriate administrative, physical and
    technical safeguards", immediate breach reporting, confidentiality of the API key, insurance, a data-protection
    addendum covering GDPR, UK GDPR and CCPA service-partner duties, and direct secure transmission of applications to
    the employer's authorized system.
12. **Current blocker.** Eligibility, not engineering: fewer than ten paying clients, a new product, and the founding
    program's unpaid pilot each fail the ATS guidelines; Indeed decides case by case with no timeline. Interim: the
    customer's own employer account and organic aggregation of a public, crawlable job page (Indeed's crawler is
    `IndeedJobBot`; aggregation is not guaranteed and no structured-data ingestion is documented). A single-employer
    feed still needs the Developer Agreement and, from 31 March 2026, single-source feeds from employers whose ATS has
    an Indeed integration are visible only when sponsored.

### 8.2 ZipRecruiter (Partner Jobs API, Questions API, Apply Webhook, Hiring Signals, Features and Embedded Sponsorship APIs, XML feed import)

Sources: ziprecruiter.com/partner/documentation (index, authentication, job API, question API, features API, feed
import, apply webhook, hiring signals, quickstart, sponsorship API, data sharing, changelog), ziprecruiter.com
/ats-partners, /xml-import, the XML feed import PDF v1.9 (October 2025), the Apply Webhook PDF v1.3 (October 2025),
support.ziprecruiter.com partner articles, ziprecruiter.global job rules, security and terms pages.

1. **Partnership or approval required.** Yes for any vendor-level integration: "register as a partner, receive an API
   key" through `atsintegrations@ziprecruiter.com` or the form behind "Integrate Now"; no self-serve key issuance;
   the webhook is set up through a partner contact; the sponsorship widget loads only after ZipRecruiter allow-lists
   the partner's domains. Per-employer routes without a partnership: an XML feed configured by the employer's account
   manager, or a custom apply URL on Pro plans.
2. **Application process.** Email or web form; no published eligibility, timeline, fees or partner agreement text;
   after acceptance separate keys for organic and sponsored jobs.
3. **Certification.** None published; no conformance suite or badge; no sandbox ("all development and testing happens
   against production" with test postings; test sponsorship charges refunded by arrangement); a browser JSON-schema
   validator for hiring signals.
4. **Employer account or contract.** Through a partner key, organic postings identify the employer by
   partner-supplied identifiers with no pre-existing ZipRecruiter account; sponsorship creates the employer's
   ZipRecruiter organization inside the widget (email code or Google sign-in, terms, card) and ZipRecruiter bills the
   employer and pays the partner a revenue share. The terms restrict partner-platform use to employers hiring for
   their own organization and let ZipRecruiter disable use by job boards, staffing agencies, recruiters or agencies
   posting for others; **this must be checked against ITS posting on a client's behalf before any application**.
5. **Job posting.** Yes: one endpoint with create, update (which reactivates a closed job), get and delete; required
   fields include a job id, employer id and name, title, job type, country (US, CA, AU), description and a location;
   or a full XML feed polled four times a day.
6. **Native application ingestion.** Yes: an HTTPS POST of JSON (name, email, phone, base64 PDF résumé, screening
   answers, parsed profile) to one partner endpoint; 2xx counts as delivered; 5xx retried six times over two days;
   optional HMAC-SHA256 signature with a replay window. "Our integrations require that candidates use the
   ZipRecruiter Apply process"; a redirecting apply URL loses ZipRecruiter Apply and in-account tracking.
7. **Screening questions.** Yes, a Questions API per job (text, numeric, date, select, multiselect, upload, groups,
   conditionals, deal-breakers that mark an application disqualified) with answers delivered in the webhook.
8. **Sponsored jobs.** Three mechanisms: a Features API traffic boost, an Embedded Sponsorship widget with a separate
   credential and allow-listed domains where the employer pays by card, and CPC campaigns configured by an account
   manager with files exchanged over SFTP.
9. **Disposition and hiring signals.** Yes: a Hiring Signals API with events received, viewed, contacted, assessment,
   interviewed, offered, prehire, hired, rejected (with a fixed reason list) and unable_to_map; listed as step five of
   the integration flow and a prerequisite for embedded sponsorship.
10. **Implementation dependency.** Acceptance and keys, then Jobs API or feed, then webhook registration and the
    signing secret by one-time link, then hiring signals, then optional questions, features and sponsorship with domain
    allow-listing; every hand-off needs ZipRecruiter staff; jobs go live in about two hours by API.
11. **Data and security review.** No questionnaire or partner data-processing addendum published; HTTPS endpoint with
    a certificate from a well-known certificate authority, secrets kept server-side, optional signature verification,
    origin checks on the widget's messages, respect for rate-limit headers; API keys, dashboards and documentation are
    ZipRecruiter confidential information under the terms; ZipRecruiter itself publishes a SOC 2 Type 2 report period,
    PCI attestation and Data Privacy Framework participation.
12. **Current blocker.** Gated onboarding with no published criteria and no sandbox; nothing can be built or tested
    before acceptance; the terms' own-organization rule needs checking against ITS's operating model; countries US, CA,
    AU only. Interim: the customer's own subscription (account-manager feed, or a custom apply URL on Pro plans, which
    loses ZipRecruiter Apply). ZipRecruiter documents no organic ingestion of public pages or structured data.

### 8.3 LinkedIn Talent Solutions (Job Posting API, Apply Connect, Apply with LinkedIn, Premium Job Posting, Basic Jobs XML feeds)

Sources: learn.microsoft.com/linkedin/talent (job posting API overview updated 3 June 2026, Apply Connect overview,
configuration, schema, receiving applications, status updates, plugins and certification, provisioning API, XML feed
pages and guidelines, Apply with LinkedIn, partner support guide, getting access), business.linkedin.com ATS partner
pages and the partner request form, LinkedIn Help articles on Basic Jobs and Apply Connect prerequisites, and the Job
Posting API terms.

1. **Partnership or approval required.** Yes for every programmatic route, and the main door is closed: "We are
   currently not accepting new partnerships for LinkedIn's Job Posting API. If you would like to gain access ...
   please request access to Apply Connect." Apply Connect is "restricted to approved developers" who "sign the
   required API agreement with data restrictions". Apply with LinkedIn is also closed to new partners. Even the free
   Basic Jobs XML feed "is limited to those developers approved by LinkedIn".
2. **Application process.** The Talent Solutions Partner Request Form (company, website, description, regions,
   customer count, five largest customers with LinkedIn pages, daily active jobs, which integration, why). The form:
   "we cannot promise a formal agreement with all interested parties". If accepted, a business-development contact,
   the API agreement, developer applications, a partner onboarding form, a test organization, then certification.
   XML route: evaluation by email with daily listing counts, markets and sample URLs.
3. **Certification.** Apply Connect: thirty-two test cases demonstrated to the business-development contact
   (authentication, customer configuration, job sync with on-site apply, receiving applications with webhook and
   signature validation, feedback signals, profile plugins, error handling); the production key is issued on success.
   Job Posting API: a recorded video per test case plus a technical sign-off. XML: internal review of the live feed.
4. **Employer account or contract.** Basic jobs need only a LinkedIn company page and are free; Apply Connect needs
   the employer's ATS admin rights; the profile plugins and applicant notifications need a Recruiter licence; paid
   promotion needs a Recruiter contract with job slots and a default job poster. Integrations carry no LinkedIn fee.
   The customer must accept LinkedIn's Jobs Terms and the ATS must record who accepted and when; XML guideline 7
   restricts the integration to "verified, paying users of your system" (no free or trial users, no accounts under
   thirty days old).
5. **Job posting.** Yes, once a partner: a versioned asynchronous simple-job-postings API (create, update, renew,
   close, upgrade, downgrade) with required poster email for trust-and-safety checks; once one of a customer's jobs
   goes by API, all its public jobs must; LinkedIn "reserves the right to require promotion of jobs" for generic names
   and staffing companies.
6. **Native application ingestion.** Yes, Apply Connect posts each application to a per-job HTTPS webhook (contact
   fields, résumé as short-lived media available thirty days, work and education sets, voluntary self-identification,
   custom answers, matched skills where contractually allowed); six redelivery attempts; the endpoint must answer a
   challenge within three seconds and is re-validated every two hours; a failed first delivery converts the job to
   off-site apply; an unpublished free-application limit after which LinkedIn Apply stops unless the job is promoted.
7. **Screening questions.** Yes, a rich on-site apply configuration (contact, résumé, cover letter, work, education,
   self-identification, custom questions with favourable answers and conditionals); questions must match the career
   site's.
8. **Sponsored jobs.** Through the Premium Job Posting extension for partners granted it, using the employer's
   Recruiter contract and an onboarding widget; pricing is LinkedIn's.
9. **Disposition and hiring signals.** Yes, a job-application lifecycle actions API (viewed, résumé downloaded,
   rejected, screened, interviewed, offered, hired, other) sent per action, shown to applicants only where the
   customer consented; job-status and resync notifications flow the other way.
10. **Implementation dependency.** Acceptance, the agreement, two developer applications, the onboarding form and test
    organization, a provisioning API creating one child application per customer (a strict one-to-one), client-
    credential tokens per child, the customer opt-in widget and terms text, job sync with webhook URLs, the webhook
    with challenge and signature handling, media download within thirty days, the lifecycle API, two embedded profile
    plugins, the thirty-two-case certification, and an XML feed maintained in parallel until LinkedIn's parity check
    cuts customers over ("typically around 3 months after general access"). No timeline is published.
11. **Data and security review.** No questionnaire published; the API terms subject the partner to "developer and
    application vetting processes", forbid storing job-posting data beyond what the documentation permits, require
    deletion within ten days in stated cases, require safeguards that "meet or exceed industry standards", restrict
    member data to the customer's own hiring purpose; technical controls include HMAC-SHA256 signatures, endpoint
    blocking after three failed re-validations, secret rotation, verified work emails for developers; EEO voluntary
    self-identification answers arrive in the payload and must be handled as sensitive.
12. **Current blocker.** The Job Posting API is closed to new partners; Apply Connect and the XML route are approval-
    gated with no promised agreement or timeline and scale-oriented criteria; the paying-users rule conflicts with an
    unpaid pilot and any free tier; the full Apply Connect value needs a Recruiter licence many small employers lack;
    the free apply pipe has an unpublished cap. Interim: the customer's own company page and job posting, ITS posting by
    hand with the LinkedIn tracked link; no structured-data or JSON feed ingestion is documented by LinkedIn.

### 8.4 What the partner track means for release 1

- No provider offers a self-serve or organic API path; every native route needs a partnership decided by the
  provider, and two of the three publish criteria that a new product with an unpaid pilot cannot meet today.
- Indeed is the only provider that documents organic aggregation of public job pages; it is not guaranteed and reads
  no structured data. The JobPosting structured data of section 2 item 4 serves Google for Jobs, not the three boards.
- The founding program's paid customers are what make an application credible: Indeed asks for ten paying,
  exclusive clients; LinkedIn's form asks for customer counts and daily job volume; ZipRecruiter publishes no
  threshold and is the first application worth making once ITS has a signed customer and a live product.
- Until then, section 2's manual workflow is the release-1 product: the customer's own employer accounts, ITS posting
  by hand, one tracked link per board, source recorded on every application, URL verified before "live", boards
  closed by hand from the checklist.

## Appendix A. The founder's instruction of 22 September 2026 (verbatim)

> Founder scope decision: job distribution is required for release 1.
>
> The first pilot should support a real job posted to LinkedIn, Indeed and ZipRecruiter, with candidates submitting
> their own applications into Recruiting OS.
>
> Do not scrape any job board and do not claim a native API integration exists without approved partner access.
>
> RELEASE-1 JOB DISTRIBUTION
>
> Build the fastest compliant release-1 workflow:
>
> 1. Hosted public job pages under jobs.identifiedtalent.com.
> 2. Candidate self-application through Recruiting OS.
> 3. Mobile-accessible application experience.
> 4. JobPosting structured data on every job page.
> 5. A job sitemap.
> 6. A documented public job feed suitable for approved job-board ingestion.
> 7. Board-specific tracked application links for: LinkedIn; Indeed; ZipRecruiter; Referral; Direct; Other.
> 8. Source and source-detail stored with every application.
> 9. A job-posting package containing all required posting information.
> 10. Manual posting instructions and status tracking for each board.
> 11. States: Draft; Approved; Ready to post; Posted manually; Submitted through integration; Live and verified;
>     Paused; Failed; Closed.
> 12. Never label a job live until its public board URL is verified.
> 13. Store each public board URL.
> 14. Allow authorized users to close or pause a posting.
> 15. Closing a role must clearly identify which external boards still require manual closure.
> 16. Provide application-volume monitoring and the ability to stop accepting new applications.
> 17. Do not automatically reject excess applicants.
> 18. Test the public application journey at realistic applicant volume before launch.
> 19. Record job-board source without exposing tracking parameters in candidate-facing records.
> 20. Keep client companies properly identified as the hiring employer.
>
> INITIAL PILOT OPERATING MODEL
>
> 1. The design partner owns or authorizes its employer accounts.
> 2. ITS manually posts the approved job to LinkedIn, Indeed and ZipRecruiter.
> 3. Each posting uses its board-specific Recruiting OS application link.
> 4. Candidates submit their own data and résumé through Recruiting OS.
> 5. Recruiting OS becomes the system of record for those applications.
> 6. ITS manually verifies the board URL and marks the posting live.
> 7. ITS manually closes each external posting when the role closes.
> 8. The pilot is one client and one role, but it may accept the role's full applicant volume.
> 9. Human oversight remains required.
> 10. Automatic rejection remains disabled.
>
> PARTNER INTEGRATION TRACK
>
> Prepare, but do not falsely implement, the integration path for: Indeed ATS Sync; ZipRecruiter ATS Partner APIs;
> LinkedIn Talent Solutions Job Posting and Apply Connect.
>
> For each provider document: 1. Partnership or approval required. 2. Application process. 3. Certification
> requirements. 4. Required employer account or contract. 5. Job-posting capability. 6. Native application-ingestion
> capability. 7. Screening-question support. 8. Sponsored-job support. 9. Disposition and hiring-signal reporting.
> 10. Expected implementation dependency. 11. Data and security review requirements. 12. Current blocker.
>
> Do not let partner approval delay the manual release-1 posting workflow.
>
> SCOPE CONTROL
>
> This authorization covers hosted job pages, tracked application links, job feeds, manual distribution support and
> application-source tracking.
>
> It does not authorize: LinkedIn scraping; Unapproved job-board APIs; Automated paid sponsorship; Passive candidate
> sourcing; SMS; Interview recording; Automated rejection; Automated offers; Onboarding.
>
> Before coding, inspect what already exists and provide: 1. Existing job-page and application functionality.
> 2. Missing release-1 job-distribution functionality. 3. Required infrastructure. 4. Tests required. 5. Estimated
> impact on the launch sequence. 6. Whether this changes the current Supabase setup instructions.
>
> Treat this as a founder-approved release-1 scope amendment. Use a protected pull request and update the decision
> register.
