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
