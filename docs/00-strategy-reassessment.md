# 00. Final strategic challenge before build

Written 9 September 2026, after re-reading the strategy memo (`../../AI-Recruiting-Platform-Strategy-2026.md`) with the intent of finding what is wrong with it. Where this document disagrees with the memo, this document wins.

## Changes I recommend before build

### A. Assumptions that remain unsupported

| # | Assumption in the memo | Status | What we do about it |
|---|---|---|---|
| 1 | Segment A owners will pay $549/month for software plus AI without a human attached | **Untested.** WizeHire's $549 includes coaching calls; Classet's $249 is per interview volume; nobody sells "AI recruiting OS for a dental group" at $549 yet | Run two price cohorts in the paid beta ($399 and $549 for Growth) and a per-role option ($199 per active role per month). Decide pricing at month six on conversion and retention, not on the memo |
| 2 | Voice screens complete at 70 to 85% and candidates like them | **Vendor claim only** (Classet) | Text screening first. Voice ships only after our own beta shows completion above 65% and complaint rate under 2% on real dental and trades roles |
| 3 | Owners will read and answer a daily brief | **Behavioral hypothesis.** Owners ignore software; that is the ITS practice's own founding observation | The brief is one surface among three (web, SMS, email), and the product must work when the owner ignores it: stuck-role detection, nudges, and escalation to a recruiter are core, not customer-success extras. Built from Slice 2 |
| 4 | We will get Indeed ATS-partner status quickly | **Unverified.** Indeed's partner program has tiers and review; a brand-new ATS with ten customers may wait months | Slice 1 ships **email-in application ingestion**: the customer posts on Indeed from their own employer account and forwards applications to a per-role intake address; we parse them. Partner integration follows. Without this fallback the product has no applicants on day one |
| 5 | Gusto and Rippling handoffs are direct API integrations | **Both require partner approval** (Gusto Embedded, Rippling App Shop). BambooHR is customer-key based and open | Slice 5 ships BambooHR direct plus a **handoff packet** (structured email plus CSV plus a checklist to the payroll admin) that works for every HRIS on day one. Gusto and Rippling adapters are built behind the same interface and labeled pending approval |
| 6 | Candidate email is sent from the owner's Gmail or Microsoft 365 mailbox via OAuth | **Blocked for MVP.** Gmail send and read are Google "restricted" scopes requiring app verification and an annual third-party security assessment (CASA); that is weeks to months and real money. Microsoft needs app registration and, for many tenants, admin consent | MVP sends from a product-controlled domain with proper SPF, DKIM, and DMARC and a per-role reply-to that routes replies into the product. Calendar scopes are "sensitive" (verification, no CASA) and stay in Slice 3. Mailbox sending moves to Version 1 after verification |
| 7 | Twilio A2P 10DLC campaign approval is routine | **Recruiting campaigns get extra scrutiny** and vetting can take weeks | Register the ISV brand and a "recruiting/job applications" campaign in month one; capture consent language at apply; email is the fallback channel for every SMS |
| 8 | Reference checks can be automated by us | **Legal risk.** A third party that assembles reference or background information for employers can be a consumer reporting agency under the FCRA | References stay a **template the customer runs** until counsel clears an automated version. Background checks stay with Checkr, a licensed CRA |
| 9 | Our per-role AI cost is $20 to $50 | **Estimate.** Real conversations run longer; owners ask more questions | Cost per role and per customer is instrumented from the first agent run (the `ai_runs` table) and shown in the admin console |
| 10 | The 20 to 499 employee segment counts (~640,000 firms) | Approximate from SBA percentages | Pull the SUSB table before using the number externally; it does not change the plan |

### B. Competitive threats the memo underestimated

1. **Indeed Connect and Talent Scout are closer to our screening layer than the memo admits.** "Sourcing while you sleep" with AI summaries pushed into the ATS, available inside Workable and isolved, is a free-with-sponsorship version of triage plus outreach for exactly segment A. Our answer is not to out-screen Indeed; it is to own the process after the applicant arrives (structure, decision, offer, handoff) and to treat Indeed as a supply integration we optimize spend on. If Indeed offers us partner status, we take it; if Indeed builds the back half, we are in trouble, and the memo's "Indeed never sees the hire" argument is our only structural defense. Watch it quarterly.
2. **Vertical SaaS adding hiring modules.** Practice-management and field-service platforms (the dental PMS vendors, ServiceTitan and Jobber for trades, home-care agency software) already own the owner's login and could bundle hiring. Not researched in the memo. Action: research each target vertical's dominant platform for a hiring module before choosing the vertical, and pursue them as partners (marketplace listing, data handoff) before they become competitors.
3. **Gusto.** 500,000 customers, a stated push of "75 new features," and a weak hiring product today. If Gusto ships a real ATS with AI screening, the payroll-bundled path becomes the default for our segment. Action: build the Gusto handoff and marketplace presence early enough to be the hiring layer Gusto recommends rather than the one it replaces.
4. **WizeHire, CareerPlug, Hireology adding AI.** They have the verticals, the channel, and the coaching motion. The memo treats them as pre-AI; assume they ship AI screening within a year. Our edge has to be the conversational owner experience, evidence-based assessment, and the human layer, not "we have AI."
5. **Classet in trades.** Already sells a "self-driving ATS" with AI phone screening at $249 to skilled-trades shops. If we lead with trades, we collide with a focused, cheaper, voice-first competitor. This is one reason to lead with dental.

### C. Features to remove, move earlier, or move later

**Remove from the plan entirely:** LinkedIn anything beyond the free Basic Jobs XML feed; any cross-tenant candidate pool; AI-conducted live interviews; a video platform; a proprietary resume parser (the model reads PDFs); assessments as a first-party feature; a Slack app in the MVP (email and SMS surfaces cover the owner; Slack is Version 1).

**Move earlier:**

- Email-in application ingestion and Indeed-hosted-job support (Slice 1).
- "Ask a recruiter" as a minimal escalation with full context attached (Slice 1, not Slice 6). It is a record, a notification, and a recruiter view. Full takeover mode stays in Slice 6.
- Stuck-role detection and proactive nudges (Slice 2). This is the "department" behavior.
- The vertical playbook object and a seeded dental playbook (Slice 1), so intake is good on day one for the first vertical.
- 30/60/90-day outcome check-ins (Slice 5, with onboarding). The outcome loop is the moat; it cannot be added later without losing the first year of data.
- Cost and run observability (Slice 1). Every AI call is logged with model, prompt version, tokens, cost, latency, and outcome from the first commit.

**Move later:**

- Voice screening (from MVP to Version 1, gated on our own beta data).
- Mailbox OAuth sending (Version 1, after Google and Microsoft verification).
- Finch breadth for ADP, Paychex, Paylocity, isolved (after the handoff packet proves the workflow).
- Compensation intelligence beyond BLS OEWS and the vertical playbook ranges (Version 2).

### D. Pricing and unit-economics assumptions to test

- Growth at $399 versus $549; per-role pricing at $199 per active role; annual discount at 10% versus 2 months free.
- Whether owners value "Ask a recruiter" enough to pay for it separately or expect it bundled (fair-use quota of 2 asks per month in Growth, then $150 per hour).
- Real text-screen completion rate and message volume per role (SMS is the second-largest variable cost after voice).
- Real owner Q&A token volume (the brief and conversation could be the largest LLM cost if owners chat a lot; use cheaper models for Q&A over structured data).
- Support load per customer at this segment (the memo assumes one support person per 200 to 300 accounts; main-street owners call).

### E. Legal and compliance items that require counsel before launch

1. Whether owner-authored eligibility knockouts executed automatically constitute an "automated employment decision tool" (NYC) or "automated-decision system" (California) when the rule is simple and the owner wrote it. Our design assumes yes for record-keeping and no for bias-audit triggering; counsel must confirm.
2. TCPA consent language and flow at application, including the "prior express consent" standard for informational recruiting texts versus marketing texts, and quiet hours.
3. Recording-consent scripts and logic for the thirteen all-party-consent states, and whether our transcription pipeline creates a "voiceprint" under Illinois BIPA (we will not run speaker identification; counsel confirms that is sufficient).
4. Illinois HB 3773 notice text and timing; California ADS record-retention scope (which artifacts are "automated-decision data"); Colorado SB 26-189 adverse-decision explanation and appeal for January 2027.
5. **Whether ITS recruiters operating inside the software for a fee triggers employment-agency licensing** in states that license placement services, and whether Recruiter on Demand takeover fees are "placement fees" under those statutes.
6. FCRA status for any reference-checking automation (see A.8) and the adverse-action flow for Checkr results.
7. Data processing agreements: CCPA service-provider terms with customers, candidate privacy notice, retention defaults, and the deletion-request workflow.
8. Vendor liability allocation in customer terms in light of Mobley v. Workday, and tech E&O insurance with an employment-practices endorsement.
9. Model provider terms: confirm the AI provider's data-use terms permit candidate data processing and that zero-retention or equivalent is configured where required.

None of these are blockers for building; all are blockers for charging money in the affected states. The compliance architecture (doc 08) makes each a configurable policy rather than a code assumption.

### F. Technical assumptions that could create major risk

- **A durable workflow engine is the product.** If we build agents on a request/response web framework, days-long processes (screens, scheduling, offers) will silently die on the first deploy. Decision: a Postgres-backed durable workflow runner with idempotent steps, retries, and human-wait states is built in Slice 1, before any agent. Temporal or Inngest are the upgrade path, not the starting point, because the team must be able to read every line of the thing that runs candidates' lives.
- **Structured outputs everywhere.** Every AI result is a validated schema; the product never parses prose. Enforced at the provider abstraction.
- **One model provider today, an abstraction from day one.** The provider interface is the only place Anthropic's SDK is imported.
- **PDF and DOCX resumes.** The model reads PDFs natively; DOCX is converted to text first. Scanned images go through the model's vision path. No third-party parser.
- **Tenant isolation in the database, not only in the application.** Row-level security policies on every tenant table, with the tenant id set per connection. Tests assert cross-tenant reads fail.
- **Development without Postgres installed.** Local development and tests run on PGlite (Postgres in WebAssembly, with pgvector). Production runs on managed Postgres. The same migrations run on both, and the test suite asserts that.

### G. Third-party dependencies that could threaten the company

| Dependency | Failure mode | Mitigation built in |
|---|---|---|
| Indeed (applicant supply, partner status, pricing) | Denied partnership; organic visibility removed; Talent Scout competes | Email-in ingestion; careers page with Google Jobs markup; ZipRecruiter and LinkedIn Basic Jobs; referral prompts; treat Indeed spend as a managed budget |
| Google OAuth verification | Delayed for months | Calendar only in MVP (sensitive, not restricted); email from our domain |
| Twilio 10DLC | Campaign rejected or delayed | Email fallback for every SMS; register early |
| Anthropic or any model provider | Price change, outage, policy change | Provider abstraction; structured schemas are provider-neutral; run logs allow replay on another provider |
| HRIS partner programs (Gusto, Rippling) | Not approved | Handoff packet; BambooHR direct; Finch |
| Data providers for sourcing | Litigation, bounces, price | Version 2; behind an abstraction; enrich after shortlist |

### H. Where the product could become too complicated

- Recruiter Mode becoming a second product. Rule: Recruiter Mode is Owner Mode plus five advanced views (pipeline table, search, bulk actions, sequences, takeover). Same objects, same API.
- Too many agents. Rule: seven agents plus one orchestrator, as defined; a new agent requires a distinct workflow it owns.
- Vertical playbooks becoming a CMS. Rule: a playbook is one JSON document per vertical with a fixed schema; customers override fields on their role packet, never edit the playbook.
- Billing and entitlements. Rule: entitlements are a table of named limits per plan; the product checks a limit, it never checks a plan name.
- The policy engine. Rule: policies are per action type with four levels, resolved company-then-role; no scripting.

### I. Where we could become indistinguishable from incumbents

> Founder context (14 September 2026): benchmark against Workable and Gem continuously; Ashby is the product-design benchmark for all-in-one operations; a future LinkedIn product is the distribution threat.

Slice 1 as specified (company, users, role, intake, posting, application capture) is, on paper, what every ATS has. What must be visibly different from the first demo:

1. Intake is a conversation that asks recruiter questions and produces a full role packet, not a form.
2. The role packet is the product's central object and the owner approves it as one thing.
3. Applicants get a human-quality acknowledgment within a minute, from the first application.
4. Every assessment is evidence, strengths, concerns, unknowns, and confidence, not a number.
5. "Ask a recruiter" is on every decision.
6. The morning brief tells the owner what to do, and the system does something when they do nothing.

If a screen we build could be mistaken for Workable, we redesign it.

## The ten questions

**1. Is Segment A, main-street SMBs, definitely the best initial customer?** Yes for the company, with one refinement for the product. Segment A is where ITS already sells, where agencies still take $12,000 fees, where AI competition is thinnest, and where the owner experience matters most. The refinement: within segment A, lead with the **hard hires** (licensed clinical staff, service managers, office managers, controllers, marketing and sales leads), which are the roles owners would pay an agency for and where speed and structure change the outcome. Hourly volume roles are handled well by the same system and drive retention, but they are not the sales pitch, because Homebase, Workstream, and Classet already sell there at lower prices.

**2. Which vertical should we dominate first?** Dental and dental-adjacent groups (general and specialty practices and small DSOs with 20 to 150 staff), then veterinary, then residential trades. Scoring on six criteria:

| Criterion | Dental | Trades (HVAC/plumbing/electrical) | Home care | Veterinary |
|---|---|---|---|---|
| ITS has clients and playbooks | Yes | Yes | Yes | Some |
| Licensed roles make eligibility crisp and AI-safe | Strong (RDH, DA, RDA, EFDA by state) | Moderate (EPA 608, state licenses vary) | Weak (certifications vary, high volume) | Strong (RVT/LVT) |
| Continuous hiring with real scarcity and agency use | Strong (hygienist shortage; temp agencies charge premiums) | Strong | Very high volume, thin margins | Strong |
| Dominant vertical SaaS has not bundled hiring | Mostly true (PMS vendors focus on clinical and billing) | **At risk** (field-service platforms are expanding) | Mixed | Mostly true |
| Focused AI competitor already present | No | **Classet** | Workstream, Humanly | No |
| Owner economics support $400 to $600 per month | Yes (revenue per provider is high) | Yes | Marginal | Yes |

Dental wins on eligibility clarity, scarcity, absence of a focused competitor, and economics. The first playbook shipped in Slice 1 is dental. Trades is second because ITS knows it, with Classet as the named competitor to beat on process rather than on phone screens.

**3. Is "recruiting department" stronger positioning than "AI recruiter"?** Yes, for the buyer and for the candidate. "Department" implies accountability, people, and permanence; "AI recruiter" implies a tool and now carries the Alex-glitch and Tezi-shutdown associations. Use "AI recruiter" only as a search term and descriptor in ads.

**4. Should Recruiter on Demand be part of the core product?** Yes, at two levels. "Ask a recruiter" is core and in Slice 1: a button on every decision that creates an escalation with the complete context and reaches an ITS recruiter. "Takeover" is a paid service SKU with its own mode (Slice 6). Guardrail: a fair-use quota so the human layer is a backstop, not free labor; and every recruiter action is logged like an AI action so the outcome data includes what the humans did.

**5. What is the strongest initial wedge?** For a dental office manager: "Describe the hygienist you need. In ten minutes the job is written, priced, posted, and every applicant gets a text within two minutes and a licensed-in-your-state check before you see them." Intake to posted role with eligibility screening and instant candidate response. It is fast to demonstrate, it produces value before any hire, and it does not depend on partner integrations.

**6. What feature creates the strongest "wow" moment?** The intake conversation producing a role packet the owner would not have written themselves: the questions it asks, the compensation guidance with a source, the must-have versus nice-to-have split, and a screening plan. Second: the first morning brief with three candidates and the evidence for each.

**7. What feature creates the strongest retention?** The system running when the owner is not looking: acknowledgments, screens, scheduling, nudges, and the "want me to have a recruiter look at this?" escalation. Plus data gravity: the talent pool, rediscovery, and the HRIS handoff. Owners stay because hiring stopped being a thing they do.

**8. What feature creates the strongest moat?** The outcome loop: role packets, screens, interviews, offers, and 30/60/90-day outcomes tied together per vertical, which nobody with a job board or an ATS alone can assemble, plus a human layer that turns every escalation into labeled data. Requires Slice 5's outcome check-ins and the data governance in doc 08.

**9. What is the biggest risk to the company?** Owner disengagement combined with incumbent bundling: if owners do not operate the product and Indeed, Gusto, or Workable ships a good-enough bundle, we lose on both ends. The mitigation is one and the same: the product must produce hires with minimal owner effort and a visible human safety net, measured as owner hours per hire and stuck-role rate from the first cohort.

**10. What would make you abandon the current thesis?** By month nine of the beta: (a) design partners report fewer than eight owner-hours saved per hire or time-to-fill is not better than their baseline; (b) more than 40% of roles go seven days with no owner action despite nudges; (c) text-screen completion under 50% or candidate complaints above 5%; (d) Indeed denies partner status *and* email-in ingestion cannot reach 80% parse accuracy; (e) Recruiter on Demand attach above 70% (we are an agency with software, so restructure as one) or under 5% with churn above 4% monthly (the human layer is not valued). Any two of these together and the company should pivot to a Recruiter on Demand business with the software as its back office.

## What changes in the architecture as a result

- Slice 1 adds: email-in application ingestion, the vertical playbook object with a dental seed, "Ask a recruiter" escalations, AI run observability, and email from a product-controlled domain.
- Slice 2 adds: stuck-role detection and nudges.
- Slice 3 keeps calendar OAuth (sensitive scope) but does not depend on mailbox OAuth.
- Slice 5 adds: the handoff packet and 30/60/90 check-ins.
- Voice screening, Slack, mailbox sending, and reference automation move to Version 1 and are gated as described.
