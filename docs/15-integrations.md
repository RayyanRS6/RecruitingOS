# 15. Integrations

Every integration is an adapter behind an interface in `packages/integrations`, registered with a status the product displays. Statuses: `live`, `pending_credentials` (we have the code, the customer or ITS must supply keys), `pending_partner_approval` (an external program must approve us), `fake` (tests only), `disabled`.

| Capability | Provider | Adapter | Status at Slice 1 | What it takes to go live | Notes |
|---|---|---|---|---|---|
| Careers page and job pages | Native | `jobboards/careers` | live | Nothing | Served by the API with Google Jobs JSON-LD |
| Google for Jobs | Native | `jobboards/googlejobs` | live | Public URL indexed | schema.org `JobPosting` |
| Email-in applications | Native + Postmark inbound | `email/inbound` | live with fake; live with Postmark when configured | Postmark inbound domain (`EMAIL_INTAKE_DOMAIN`) MX records | Indeed-hosted jobs forward here |
| Outbound email | Postmark | `email/postmark` | pending_credentials | Postmark server token; sending domain with SPF/DKIM/DMARC | Fake adapter in dev |
| LinkedIn Basic Jobs | LinkedIn XML feed | `jobboards/linkedin_xml` | live (feed generated); ingestion pending LinkedIn onboarding | Register the feed URL with LinkedIn | Free listings only |
| Indeed | Job Sync API + Indeed Apply | `jobboards/indeed` | pending_partner_approval | ATS partner application; OAuth client | Until then: customer posts from their own account and forwards to the intake address; sponsored spend is theirs |
| ZipRecruiter | Partner feed | `jobboards/ziprecruiter` | pending_partner_approval | Partner agreement | |
| SMS | Twilio | `sms/twilio` | pending_credentials (adapter, inbound webhook, signature check written in Slice 2) | Account, messaging service, A2P 10DLC brand and campaign approval | Consent gate in `deliverSms`; quiet hours in the workflow; STOP/START/HELP in the webhook; until live, screens run by web chat from an email link |
| Calendar | Google Calendar, Microsoft Graph | `calendar/google`, `calendar/microsoft` | Slice 3 | OAuth apps; Google verification for sensitive scopes | |
| Meeting recording | Recall.ai (or upload) | `recording/recall` | Slice 3 | API key | Consent-gated |
| Transcription | Deepgram or AssemblyAI | `transcription/*` | Slice 3 | API key | |
| E-signature | Dropbox Sign | `esign/dropboxsign` | Slice 4 | API key | PDF click-to-accept fallback |
| HRIS | Gusto Embedded | `hris/gusto` | Slice 5, pending_partner_approval (first choice per the founder context §25) | Gusto Embedded partner program | |
| HRIS | Rippling | `hris/rippling` | Slice 5, pending_partner_approval (second choice) | Rippling App Shop partner | Employee creation triggers Rippling onboarding automations; test in sandbox |
| HRIS | BambooHR | `hris/bamboohr` | Slice 5, first live path (customer API key, no partner program) | Customer API key and subdomain in Setup | Creates the employee record |
| HRIS | Handoff packet | `hris/handoff_packet` | Slice 5 | Nothing | Email + CSV + checklist to the payroll admin; universal fallback |
| HRIS breadth | Finch | `hris/finch` | Version 1, pending_credentials | Finch account | ADP, Paychex, Paylocity, isolved |
| Background checks | Checkr | `background/checkr` | Version 1, pending_credentials | Checkr account | FCRA flows; adverse action human-only |
| Compensation | BLS OEWS | `comp/bls` | live (v1 keyless, limited) | Optional free key for v2 | SOC code mapping by the model, metro by location |
| Compensation | Playbook ranges | `comp/playbook` | live | ITS authoring | |
| Billing | Stripe | `billing/stripe` | Slice 4 or 5 | Account | Syncs to entitlements |
| Embeddings | Voyage | `ai/embed` | Slice 7 | API key | |
| External sourcing | Licensed provider | `sourcing/*` | Slice 8 | Contract | Behind an abstraction; enrich after shortlist |

Rules: no adapter pretends to succeed; a pending adapter records what it would have sent and returns a typed pending result; the product tells the customer what to do meanwhile; credentials are encrypted at rest and never logged.

## Public job feed and sitemap

The public job surfaces live on the job-page host, `JOBS_BASE_URL` (docs/spec/20 items 5 and 6; `apps/api/src/pages/public-feeds.ts`). They list only roles that are open and accepting applications, name the client company as the hiring employer, carry public job data only (never a candidate, never a tracking token), and are rebuilt at most once every five minutes per API process (`Cache-Control: public, max-age=300`). A role that is paused, closed, or switched to "not accepting applications" leaves every document within five minutes; its job page stays up and says so.

| Address | What it is | Cadence |
|---|---|---|
| `GET /sitemap.xml` | The careers page of every company with at least one listed role, then every listed job page, each with `lastmod` (the role's last change). Standard sitemap schema (`http://www.sitemaps.org/schemas/sitemap/0.9`). | Rebuilt every 5 minutes; crawl daily |
| `GET /robots.txt` | Allows `/careers/`; disallows `/c/`, `/api/`, `/a/`, `/files/`, `/dev/`, `/webhooks/`; names the sitemap. | Static |
| `GET /feeds/jobs.xml` | The common job-board XML: one `<source>` with `<publisher>`, `<publisherurl>` and `<lastBuildDate>`, then one `<job>` per listing. Text is in CDATA. | Rebuilt every 5 minutes; poll every 1 to 4 hours |
| `GET /feeds/jobs.json` | The same listings as JSON: `{ publisher, publisherUrl, lastBuildDate, jobs: [...] }`. | Same |
| `GET /feeds/linkedin.xml` | LinkedIn Basic Jobs XML (`<source>` with `<lastBuildDate>` and `<publisherUrl>`; per job `partnerJobId`, `company`, `title`, `description`, `location`, `applyUrl` pointing at the job's canonical page, and `salaries` when the range is disclosed). Not advertised until LinkedIn confirms ingestion. | Same |

Fields per job in `jobs.xml` (the JSON names are given in brackets where they differ):

| Field | Meaning |
|---|---|
| `title` | The approved job title |
| `date` (`datePosted`) | The day the role opened, `YYYY-MM-DD` |
| `referencenumber` (`referenceNumber`) | The role id; stable for the life of the role |
| `url` | The canonical public job page on the job host |
| `applyurl` (`applyUrl`) | The application form on the job host; the form records the source as the careers page. Boards that were given a tracked link should keep using it, so their applications carry their source |
| `company` (`company`, and `hiringOrganization.name`) | The client company, the hiring employer |
| `city`, `state`, `country`, `postalcode` (`postalCode`) | The first location of the role; `country` defaults to `US` |
| `description` | The public job description, plain text |
| `salary` | Text such as `USD 45-55 per hour` when the range is shown, empty otherwise (JSON: an object with `minValue`, `maxValue`, `currency`, `unitText` `HOUR` or `YEAR`, and `text`, or `null`). The range is shown when the owner chose to show it, and always where a pay transparency law covers the job, the same rule as the job page |
| `jobtype` (`jobType`) | `full-time`, `part-time`, `contract`, `temporary`, `internship`, `per-diem` or `other` (JSON also carries `employmentType` with the schema.org token: `FULL_TIME`, `PART_TIME`, `CONTRACTOR`, `TEMPORARY`, `INTERN`, `PER_DIEM`, `OTHER`) |
| `category` | The company's vertical (for example `dental`) |
| `expirationdate` (`validThrough`) | Only a real date, never an invented one. A listed role is open and taking applications, and no role can have a closing date for applications yet (that setting arrives in a later release), so today the element (JSON: the key) is left out for every listed role |
| `remote` | `yes` or `no` (JSON: `true`/`false`) from the role's remote policy |

Structured data: every job page carries a schema.org `JobPosting` block. Its `validThrough` follows one rule (`jobValidThrough` in `packages/integrations/src/jobboards/native.ts`, `roleValidThrough` in `apps/api/src/pages/job-facts.tsx`): the day the role closed; otherwise, while the role is paused or its "accepting applications" switch is off, the day it stopped taking applications; otherwise none. (`jobValidThrough` also accepts a closing date for applications, but no role can have one until that setting arrives in a later release.) It carries the employer's website as `hiringOrganization.sameAs` and its logo when the company set them in Setup, `employmentType` as the schema.org token, and `baseSalary` by the same pay rule as the page. The block stays on paused and closed pages so search engines drop the listing on their own schedule.

The careers page and Google for Jobs are the job page itself, so they have no pause or close of their own: `POST .../postings/careers_page|google_jobs/pause` and `.../close` answer 409 `follows_the_role` and say to use the accepting switch or pause the role instead. A role pauses only from open and resumes only from paused (409 `not_open` / `not_paused` otherwise), so a resume never reopens a closed role.

## Applications by email while a role is not taking applications

The intake address (`apply-<token>@EMAIL_INTAKE_DOMAIN`) is public, so email keeps arriving while a role is paused or its "accepting applications" switch is off. Such an email is held, never rejected and never dropped (`apps/api/src/webhooks/postmark.ts`): the `inbound_emails` row gets status `held` with the company set, the résumé attachment (up to the resume size limit) is parked in storage under `inbound/<company>/<row>.<ext>` and referenced by `raw_storage_key`, and the team gets one in-app notice per role (`application.email_held`, "An application arrived by email while applications are closed"). A further email for the same role while that notice is unread updates the notice with the count instead of adding another row. The notice never carries the sender's address.

An emailed application from an address that already has an application for the same role is a repeat, handled exactly like a repeat sent through the apply form (`createApplication` in `apps/api/src/services/applications.ts`): nothing on the existing application or person changes (no résumé, phone, location or consent is added or replaced), the team sees `application.duplicate_detected`, and the address on file gets one short email with its own status link at most once a day. An application for a different role from a known address creates the new application but likewise leaves the person's record as it was.

When the role is open and taking applications again (the accepting switch turned back on, or the role resumed), the held emails are replayed in arrival order by `replayHeldEmails`: each becomes an application exactly as a live email would (source `email_in`, the parked résumé attached and then removed from storage), the row moves to `matched` with the application id (or `error` with the reason, for a person to look at), and the team's notice is rewritten to say the applications were added. Nobody has to send anything again, and nobody is rejected. The replay is a no-op while either gate is still shut, so a role that is both paused and switched off replays once both are undone.
