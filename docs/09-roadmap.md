# 09. Engineering and product roadmap

Complexity scale: L (days), M (1 to 2 weeks), H (3 to 6 weeks), XH (multi-month). Priority: P0 (this slice cannot ship without it), P1 (this period), P2 (next period). Effort is for the four-person team in doc 00.

> Resequenced on 14 September 2026 per the founder context (§28): sourcing from the customer's own pool (rediscovery, referrals) follows Slice 3; external sourcing behind a provider interface follows Slice 5, not year 2. HRIS order: Gusto and Rippling (partner programs applied for), BambooHR as the first live path.

## 0 to 3 months: Slices 1 and 2

| Feature | Business value | Customer value | Eng | AI | Compliance | Dependencies | Pri | Effort | Release criteria |
|---|---|---|---|---|---|---|---|---|---|
| Monorepo, contracts, DB schema, migrations, RLS, PGlite dev | Foundation | None visible | H | – | M (tenancy) | – | P0 | 2 wk | Migrations run on PGlite and Postgres; cross-tenant test fails correctly |
| Workflow engine (runs, steps, jobs, waits, retries, escalation) | Reliability moat | Nothing dies silently | H | – | L | DB | P0 | 2 wk | Scenario test survives simulated worker crash and API failure |
| Policy engine and approval requests | Human accountability | Control | M | – | H | Workflow | P0 | 1 wk | Defaults table enforced; per-role override; audit on change |
| AI layer (provider interface, Anthropic, fake, run logging, prompt registry) | Provider neutrality, observability | Trust | M | M | M | – | P0 | 1 wk | Every run logged with cost; fake provider deterministic |
| Auth (magic links, sessions), company and user creation, memberships | Foundation | Sign up in a minute | M | – | M | Email adapter | P0 | 1 wk | Signup → company → invite works; sessions revoke |
| Conversational intake → Role Packet (dental playbook seeded) | The wedge | "Better than I would have written" | H | H | M | AI, playbooks, BLS | P0 | 3 wk | Eval suite passes; 10-minute intake in design-partner test |
| Packet approval and versioning | Accountability | Owner approves one thing | M | – | L | Policy | P0 | 3 d | Versions preserved; diff shown |
| Careers page, job page with Google Jobs markup, apply flow (mobile) | Applicant supply | Applicants on day one | M | – | H (notices, consent) | Compliance registry | P0 | 1.5 wk | Lighthouse mobile > 90; notices shown and logged |
| Email-in ingestion (Indeed-hosted flow) and outbound email from product domain | Applicant supply without partner approval | Works with what they have | M | L | M | Postmark | P0 | 1 wk | Forwarded Indeed application parsed to an application with resume |
| LinkedIn Basic Jobs XML feed; Indeed and ZipRecruiter adapters (pending) | Distribution | Free reach | L | – | L | Partner setup | P1 | 3 d | Feed validates; pending adapters labeled |
| Application acknowledgment with disclosure and status page | Candidate experience | Response in a minute | L | L | M | Email | P0 | 3 d | 100% of applications acknowledged within 60 s in tests |
| Triage: extraction, eligibility rules, evidence-based assessment | Core intelligence | Who to look at, and why | H | H | H | AI, evals | P0 | 3 wk | Edge-case suite passes; no protected-class proxies; quotes verified in code |
| "Ask a recruiter" escalation with context snapshot | The human layer | Help in one click | M | – | L | – | P0 | 4 d | Recruiter view answers "what is this role" without asking |
| Admin console v1 (customers, runs, failures, costs) | Operability | – | M | – | L | – | P0 | 1 wk | Any run inspectable: saw, concluded, why, policy, human, action |
| Morning brief (email plus in-app) | Retention | Tells me what to do | M | M | L | Orchestrator | P1 | 1 wk | Brief accuracy eval passes |
| Text screening (web chat and SMS) with ScreenAssessment | Speed and structure | Everyone screened consistently | H | H | H (TCPA, disclosure) | Twilio 10DLC, AI | P0 (Slice 2) | 3 wk | Disclosure and human alternative on every screen; completion tracked |
| Stuck-role detector and intervention ladder | Retention, the "department" | Nothing rots | M | L | L | Orchestrator | P1 | 1 wk | Detector fixtures; cooldowns as policies |
| Design system v1 and Owner Mode (Home, Roles, People, Setup) | Simplicity | Radically simpler | H | – | L | – | P0 | ongoing | Usable on 375px; no ATS jargon in Owner Mode |
| Recruiter Mode v1 (pipeline table, candidate workspace, queue) | ITS runs on it | Professional use | H | – | L | – | P1 | 2 wk | An ITS recruiter runs a real role end to end |

## 3 to 6 months: Slices 3, 4, 5

| Feature | Business value | Customer value | Eng | AI | Compliance | Dependencies | Pri | Effort | Release criteria |
|---|---|---|---|---|---|---|---|---|---|
| Calendar OAuth (Google, Microsoft), slot proposal, booking, reminders | Time saved | Interviews book themselves | H | L | M (OAuth verification) | Verification | P0 | 3 wk | No double bookings across 500 simulated schedules |
| Interview briefs, recording with consent (Recall.ai or upload), transcription | Better interviews | Prepared interviewers | M | M | H (consent) | Recall.ai | P0 | 2 wk | Consent captured from all parties; notes-only fallback |
| Draft scorecards with evidence; independent submission; debrief | Decision quality | Who to pick and why | H | H | M | AI | P0 | 3 wk | Drafts unrated without evidence; scorecards locked before debrief |
| Offer agent, letter, approval, e-signature (Dropbox Sign), acceptance | Closes the loop | Same-week offers | H | M | M | E-sign account | P0 | 3 wk | Ceiling enforced; PDF fallback |
| Negotiation support | Wins hard hires | Advice in the moment | M | M | L | Offer | P1 | 1 wk | Counter analysis eval |
| Onboarding workflow, handoff packet, BambooHR direct | End to end | It hands the person to payroll | M | L | M | BambooHR key | P0 | 2 wk | Handoff packet correct; BambooHR employee created in sandbox |
| Gusto and Rippling adapters (pending partner approval), Finch pilot | Reach | Works with my payroll | M | – | L | Partner approvals | P1 | 2 wk | Adapters labeled pending until approved |
| 30/60/90 check-ins and outcomes | The moat | Did it work | L | L | L | Onboarding | P0 | 3 d | Outcome recorded from a one-tap email |
| Recruiter takeover mode | Full-service SKU | A person runs it | M | – | M | Escalations | P0 (Slice 6) | 2 wk | Policies overlay; handback restores |
| Billing: plans, entitlements, usage metering, Stripe | Revenue | Predictable pricing | M | – | L | Stripe | P0 | 2 wk | No plan-name checks in product code; price cohorts configurable |
| Candidate status page, withdrawal, preferences, privacy requests | Candidate experience, compliance | Respect | M | – | H | – | P0 | 1 wk | Requests routed and logged |
| Eval suite CI gate | Quality | Trust | M | M | H | – | P0 | 1 wk | Prompt changes blocked on regression |

## 6 to 12 months: Version 1

| Feature | Business value | Customer value | Eng | AI | Compliance | Dependencies | Pri | Effort |
|---|---|---|---|---|---|---|---|---|
| Voice screening (Retell or Vapi), gated on beta data | Trades and hourly | Screens that complete | H | H | H (recording, BIPA) | Voice platform, counsel | P1 | 4 wk |
| Mailbox sending via Google and Microsoft OAuth (after verification) | Reply rates | From my own inbox | M | – | H (CASA) | Verification | P2 | 3 wk |
| Rediscovery from own pool (embeddings) and referral prompts | Cheapest sourcing | Candidates you already have | M | M | L | pgvector | P0 (pulled forward: right after Slice 3) | 2 wk |
| Slack app | Owner surface | Where I already am | M | L | L | Slack review | P2 | 2 wk |
| Reference templates and, if cleared, automated reference outreach | Completeness | | L | L | H (FCRA) | Counsel | P2 | 1 wk |
| Checkr integration with FCRA flows | Completeness | | M | – | H | Checkr | P1 | 2 wk |
| Vertical playbooks: veterinary, trades | Expansion | Better defaults | M | M | L | ITS authoring | P1 | 2 wk each |
| SOC 2 readiness | Sales | Trust | M | – | H | Vendor | P1 | ongoing |
| Bias monitoring job and audit export | Compliance | NYC customers | M | – | H | Self-report capture | P1 | 2 wk |

## 12 to 18 months: Version 2

External sourcing behind an abstraction with a licensed provider and Indeed pass-through, credit-metered; outreach sequences; compensation intelligence with Pave and Lightcast; analytics views (funnel, source effectiveness, time to fill, owner hours); multi-location and hiring plan; assessments via a partner; Finch breadth; Agency edition design.

## 18 to 24 months: Version 3

Agency edition (multi-client, submittals, client portal); Recruiter on Demand marketplace beyond ITS staff; NYC bias-audit partner program; EU readiness ahead of December 2027; optional AI-led screening interviews for hourly roles with disclosure and a human alternative if the data supports it; API and MCP surface so other agents can act on the system with permissions.

## Year 3

Outcome-based defaults per vertical (which screens predict 90-day retention); embedded distribution inside payroll and vertical software; benchmark publishing; cross-tenant talent network only with explicit candidate consent and a legal basis.
