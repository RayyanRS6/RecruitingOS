# Founder context and product strategy (consultant-completed intake, September 2026)

> Source: `AI_Recruiting_OS_Founder_Context_Consultant_Completed.docx`, supplied 14 September 2026 and adopted as the governing strategic context for this repository. Reconciliation with what is built and planned: see `docs/17-founder-context-reconciliation.md`. Converted from Word; headings and Founder Decisions preserved, formatting lightly normalized.

**AI RECRUITING OPERATING SYSTEM**

Founder Context and Product Strategy

*Consultant-completed founder intake | Research-informed working source of truth*

Prepared September 2026

**Purpose. **This document answers the founder intake as a strategic recommendation, using current recruiting-market research, product and competitor evidence, candidate-experience research, responsible-AI guidance, and the operating realities of a small business that needs recruiting outcomes without building a full internal talent acquisition team. It is designed to be given directly to Claude as durable context for strategy, product design, architecture, and implementation.

**Important framing. **These are consultant recommendations, not immutable founder facts. Claude should treat each Founder Decision as the working default, but should preserve a clear distinction between research-supported conclusions, strategic assumptions, and decisions that still need real customer validation.

# Executive recommendation

**The company should not be positioned as an ATS with AI features. **The winning category is an AI recruiting department for small and midsize companies that do not have enough recruiting infrastructure to operate like a large company. The software should own the work, not merely organize it. The customer gives the system a hiring goal, constraints, and authority level; the system turns that into a role strategy, runs the recruiting workflow, keeps candidates and managers moving, and escalates judgment-heavy moments to a human recruiter.

- Primary wedge: 25 to 250 employee companies, roughly 10 to 75 hires per year, with no mature internal recruiting team.
- Initial vertical wedge: consumer, beauty, retail/e-commerce, creative/marketing, and tech-enabled SMBs where ITS already has credibility and recruiting pattern recognition.
- Core promise: Tell us who you need. The system runs the search, shows its work, and gets a human involved when judgment matters.
- Product moat: recruiting workflow intelligence + correction data + vertical playbooks + human escalation network + outcome benchmarking.
- Experience principle: calm, personal, transparent, fast. The customer should feel like a great recruiter is already on staff.
- Architecture principle: deterministic workflow and policy controls around probabilistic AI. AI can recommend and act only inside explicit permissions.
- Commercial model: software, software + recruiter, and managed recruiting. This creates a natural expansion ladder and protects the company from being boxed into commodity ATS pricing.
- MVP principle: build one complete hiring journey that can be used by ITS on real searches before expanding breadth.

## What the latest market evidence changes

The recruiting technology market has converged quickly. Gem now presents an AI-first all-in-one stack across sourcing, ATS, scheduling, analytics and offers. Workable has a native agent inside a full ATS that sources passive talent, screens applicants, chats to fill information gaps, and can route candidates. Juicebox is deepening long-running sourcing agents. Eightfold and HireVue continue moving toward agentic talent intelligence and AI interviewing. Therefore, feature completeness is table stakes. The defensible product thesis is accountable autonomy, built for the owner or lean People team, with real recruiter judgment available on demand. [S6][S7][S8][S9][S10]

The operating pain is also clearer. Greenhouse's 2026 benchmark shows far more applications per recruiter and fewer recruiters per organization, while time to fill lengthened. SHRM reports that nearly 70% of HR professionals still face difficulty recruiting full-time talent. This favors products that can absorb volume and execute workflow, but the candidate experience cannot become robotic or opaque. [S1][S2]

AI governance needs to be product architecture, not legal copy added later. New York City requires bias audits and candidate notice for covered automated employment decision tools. California employment regulations explicitly address automated decision systems. Colorado's revised law takes effect January 1, 2027. EU recruiting and selection AI is categorized as high-risk. The product therefore needs regional policy controls, disclosures, audit evidence, human review paths, and configurable autonomy from day one. [S14][S15][S16][S17]

## Claude operating instruction

When using this document, Claude should optimize for the full long-term product vision but implement in controlled vertical slices. Do not solve complexity by deleting important product capabilities. Instead, design the complete architecture and sequence delivery so that each release is coherent, testable, compliant, and production-usable.

# 01. Founder Vision

**Objective: **Define what the company is actually building and why it should exist.

**What is the big vision for this company?**

Build the first recruiting operating system that lets a small or midsize company have the functional equivalent of an excellent internal recruiting department without hiring the department. The system should understand the business, translate a hiring need into a recruiting strategy, execute the workflow across inbound, rediscovery and sourcing, coordinate people, maintain the system of record, and escalate high-judgment moments to a human recruiter. The long-term product is not 'AI for recruiters.' It is an outcome-driven human + AI labor system for recruiting.

**What do you want this product to become in 3 to 5 years?**

A category-defining recruiting platform used by thousands of SMB and lower-middle-market companies, with a strong data and workflow moat. It should become the default place a CEO, People leader or hiring manager goes when they need to add talent. Over time it should add vertical labor-market intelligence, workforce planning, internal mobility, compensation intelligence, quality-of-hire feedback, and a marketplace/network of vetted human recruiting specialists. The company should be capable of moving upmarket without abandoning the simplicity that makes it work for SMBs.

**Why does this need to exist now?**

Three forces are converging: application volume is rising, recruiting teams are leaner, and AI can now perform multi-step work rather than only generate text. Greenhouse found applications per recruiter rose sharply through 2025 while recruiter headcount per organization fell. Deloitte and McKinsey describe the move toward agentic operating models, but adoption remains constrained by fragmented stacks, governance, and workflow redesign. SMBs are especially exposed because they have fewer specialists and lower AI adoption than large firms. [S1][S4][S5][S13]

**What change do you want to create in the recruiting market?**

Make high-quality recruiting capability accessible without requiring companies to assemble an ATS, sourcing tool, scheduler, screening platform, recruiter, coordinator, and consultant. Also improve the candidate side: every applicant should know where they stand, what happens next, and when a human is making the decision.

**What would make this venture genuinely venture-scale?**

A software-led recurring revenue model with strong retention, low incremental labor per customer, expansion from hiring execution into workforce intelligence, proprietary outcome data, and a channel or network effect through recruiting partners. Human services can accelerate trust and implementation, but should feed the software moat rather than become the core cost structure.

**What parts of the original idea are non-negotiable?**

End-to-end ownership, native system of record, sourcing as part of the long-term architecture, scheduling, screening, transparent candidate evaluation, communications automation, interview workflows, offers, onboarding handoff, analytics, and human escalation. The non-negotiable principle is that the product must do the recruiting work, not just display data about it.

FOUNDER DECISION: Build an AI recruiting department for companies too small to have one. The product owns outcomes, not just workflow.

# 02. Your Recruiting Philosophy

**Objective: **Capture the beliefs that should become product behavior.

**What does great recruiting look like to you?**

Great recruiting is a disciplined mix of business diagnosis, market calibration, candidate judgment, speed, persuasion, and trust. It begins before sourcing. A strong recruiter clarifies the business problem, tests whether the profile is realistic, identifies must-haves versus preferences, creates an evidence-based interview plan, continuously calibrates, keeps candidates warm, anticipates offer risk, and closes the loop with everyone.

**What separates an exceptional recruiter from an average recruiter?**

Exceptional recruiters challenge the brief instead of simply accepting it. They recognize transferable experience, understand motivations, read inconsistencies, know when the market is telling the hiring manager something important, manage expectations before they become problems, and communicate in a way that makes candidates feel personally known. They are commercially accountable, not administrative.

**What do you think most recruiting software gets wrong?**

It treats recruiting as recordkeeping. Many products optimize stages, fields, filters and reports while leaving the actual cognitive and interpersonal work to the recruiter. New agentic products are improving this, but the category still tends to optimize recruiter productivity rather than replacing missing recruiting capacity for a small company.

**What do hiring managers usually misunderstand about recruiting?**

They often treat the job description as the search strategy, overstate required experience, understate compensation or speed constraints, add interviewers without clear decision rights, and assume a great candidate will remain available while the company deliberates. The product should actively surface these contradictions.

**What do candidates deserve from the hiring process?**

Clarity, respect for time, honest expectations, reasonable application friction, prompt updates, transparent AI disclosure, access to a human when needed, and an interview process tied to what the job actually requires. Candidate experience must be treated as a product surface, not a messaging afterthought. Glassdoor's 2026 guidance emphasizes frictionless applications, structured interviews and transparent communication as high-impact areas. [S11]

**What recruiting tasks require judgment versus tasks that should simply be automated?**

Automate coordination, reminders, data gathering, repetitive outreach, transcript summarization, scheduling, status updates, evidence extraction, pipeline hygiene, rediscovery, draft content, and routine compliance checks. Use human or explicit approval for final rejection when evidence is ambiguous, major profile recalibration, compensation exceptions, sensitive candidate conversations, executive or highly nuanced assessment, closing strategy, and any consequential decision where the AI has low confidence or conflicting evidence.

FOUNDER DECISION: Automate administration aggressively, augment judgment transparently, and preserve human accountability for consequential decisions.

# 03. ITS Recruiting Playbook

**Objective: **Convert real recruiter expertise into product IP.

**Walk through how you personally run a search from kickoff to accepted offer.**

Start with business context and why the role exists. Convert the intake into a Role Packet with business outcome, must-haves, trainables, disqualifiers, target companies, adjacent backgrounds, compensation, work model, interview plan, selling points, risks and approval rules. Build initial talent hypotheses, test them against the market, calibrate early candidates, adjust the brief, manage every touchpoint, pre-close throughout the process, surface offer risks before the final round, and run a structured close with explicit motivations and objections.

**How do you take a hiring manager intake and turn it into a strong search strategy?**

Separate the stated profile from the actual business problem. Ask what the hire must accomplish in 6 and 12 months, what failure would look like, which experiences are truly predictive, what can be learned, why strong candidates would move, and where the compensation/location requirements create market tension. Then generate a target map and interview rubric.

**How do you source candidates?**

Use layered sourcing: inbound applicants, past applicants, existing CRM, referrals, target-company mapping, LinkedIn and other professional profiles, niche communities, and recruiter network. The system should start with data already owned by the customer because it is cheap, fast and often underused, then expand externally. Glassdoor 2026 data also shows recruiter-sourced candidates have increased since 2023, so external sourcing remains strategically important. [S12]

**How do you screen candidates?**

Evaluate evidence against job outcomes, not keyword similarity. Look for scope, complexity, pace, ownership, results, progression, context, transferability, communication, motivation, compensation, logistics and risks. Distinguish 'not shown' from 'does not have.' The system should ask targeted follow-up questions when evidence is incomplete instead of treating missing resume text as a negative.

**How do you calibrate with hiring managers?**

Use a small set of real candidate examples early. Ask what they like, what concerns them, and whether each criterion is truly required. Record the corrections as role-specific preference updates and separate legitimate job requirements from preference drift.

**How do you handle objections, counteroffers, competing offers, and closing?**

Pre-close continuously. Capture motivations, decision criteria, competing processes, notice period, family/logistics constraints, compensation expectations and emotional concerns. Before offer, create a close plan with likely objections, internal flexibility, candidate champions and a follow-up cadence.

**What are subtle things an experienced recruiter notices that software usually misses?**

Trajectory versus tenure, inflated titles at small companies, scope hidden by generic titles, transferable category experience, patterns of job movement, mismatched motivations, when a candidate is polite but not actually sold, hiring-manager inconsistency, market feedback that invalidates the search, and the difference between a weak candidate and a weakly documented candidate.

**What parts of the ITS process should become software?**

Intake, Role Packet, search strategy, calibration memory, candidate evidence model, communication, scheduling, interview plan, scorecard consolidation, close-risk tracking, offer workflows, analytics, daily brief and customer-facing progress reporting.

**What parts should remain human?**

High-context persuasion, sensitive negotiation, executive judgment, relationship repair, strategic intake challenges that carry organizational politics, and any decision or conversation where trust depends on a person taking responsibility.

FOUNDER DECISION: Turn ITS judgment into explicit product primitives: Role Packet, evidence model, calibration memory, close plan, escalation rules and vertical playbooks.

# 04. Market + Competitive Landscape

**Objective: **Define where the opening exists in a market that is converging quickly.

**Which recruiting tools do you already know and use?**

Treat the market in layers: system of record/ATS, sourcing and data, CRM/outreach, application review, screening/interview, scheduling, analytics, offers/onboarding, and agentic orchestration. Key reference vendors include Gem, Workable, Ashby, Eightfold, LinkedIn, Juicebox, HireVue, Hirevire, Greenhouse, Lever, Breezy and JazzHR.

**Which products impress you? Why?**

Gem impresses because it has aggressively consolidated sourcing, ATS, scheduling, application review, analytics and offers. Workable is now especially important because its Agent sits inside a complete ATS and performs sourcing, evaluation and candidate chat with explicit guardrails. Juicebox is strong in conversational sourcing agents. Ashby is strong in all-in-one recruiting operations and analytics. HireVue has hiring-science depth. [S6][S7][S8][S9][S10]

**Which products frustrate you? Why?**

The category is still fragmented by buyer assumptions. Enterprise platforms can be powerful but heavy. SMB ATS products are easier but often stop at workflow management. Specialist AI tools solve one slice but create more stack complexity. Many scoring products present numerical certainty where the underlying evidence is ambiguous.

**Who do you consider the closest competitors?**

Workable is the closest direct product threat for the SMB thesis. Gem is the strongest strategic threat if it continues moving downmarket. Ashby is a strong product-design and all-in-one benchmark for startups and growth companies. A future LinkedIn product could be a distribution threat because it controls professional identity, job posting and recruiter workflow.

**What do current products do well?**

They increasingly cover the checklist. Gem and Workable cover much of the lifecycle. Juicebox and Gem have very large sourcing graphs. HireVue has assessment depth. Eightfold has talent intelligence and enterprise data. Breezy and JazzHR offer accessible SMB workflows and lower price points. This validates demand but eliminates 'all-in-one' as a sufficient story. [S6][S7][S8][S9][S18][S19]

**Where do existing tools stop short?**

Most still assume an internal recruiter or HR operator is responsible for running the system. The opportunity is to design for a founder or lean People lead who wants to specify outcomes and approval rules, then have the system operate the function with minimal supervision.

**What claims in the market do you think are mostly hype?**

Claims of fully autonomous hiring without meaningful governance, claims that one universal fit score can determine quality, claims that more applications equal better recruiting, and claims that an LLM itself is a defensible moat.

**If a competitor copied every feature, what would they still not have?**

A trained operating model built from real recruiter corrections, ITS-derived playbooks, role and vertical benchmarks, a human recruiter escalation network, customer-specific calibration memory, and outcome data connecting workflow decisions to interviews, offers, acceptance and eventual quality of hire.

FOUNDER DECISION: Compete on accountable autonomy and recruiting outcomes, not feature count. Benchmark against Workable and Gem continuously.

# 05. Ideal Customer Profile

**Objective: **Select the first customer segment that has acute pain and can adopt quickly.

**Who is the first ideal customer?**

A US-based, founder-led or professionally managed company with 25 to 250 employees that is hiring enough to feel pain but is not large enough to justify a full recruiting team. The company has a founder, COO, Head of People, HR generalist or one recruiter who is overloaded.

**Company size?**

Primary launch segment: 25 to 250 employees. Secondary: 250 to 500 once permissions, reporting, integrations and governance mature. Avoid designing the first release around 1,000+ employee enterprise complexity.

**Typical annual hiring volume?**

Approximately 10 to 75 hires per year, with 3 to 20 roles active in a typical quarter. Below that, urgency and software willingness may be too low. Above that, the company may already demand enterprise TA controls.

**Typical roles hired?**

Professional and knowledge-worker roles with repeatable evidence: marketing, creative, e-commerce, operations, customer success, sales, finance/accounting, HR, recruiting, product, engineering and selected leadership roles. Avoid safety-critical and highly regulated clinical decisioning at launch.

**Does the company have HR or recruiting?**

Usually an HR generalist/People lead but no dedicated TA function, one overloaded recruiter, or no recruiter at all. The strongest pain is when hiring is split across managers and agencies.

**What is the trigger that makes them need this product?**

A hiring burst, agency spend, a recruiter departure, a funding event, expansion into a new market, repeated time-to-fill problems, excessive applicant volume, inconsistent managers, or a founder realizing hiring is consuming executive time.

**What would make them pay immediately?**

A credible promise that a role can go live quickly, every applicant will be handled, strong candidates will be surfaced, interviews will get scheduled, managers will get a concise decision brief, and a human expert is available when the system hits ambiguity.

**Who is the buyer?**

Founder/CEO, COO, Head of People, HR leader or finance-conscious operator. In the 100 to 250 employee segment, Head of People becomes the most likely buyer.

**Who is the daily user?**

The hiring manager and People/HR owner. The product should not require a trained recruiter for routine use.

**Who could block the purchase?**

HR concerned about displacement or control, legal/security concerned about AI decisions, IT concerned about integration/security, hiring managers who distrust automation, and finance if pricing looks like another software layer rather than replacement spend.

FOUNDER DECISION: Launch around 25 to 250 employee companies hiring 10 to 75 people per year, especially where recruiting work is fragmented across managers, HR and agencies.

# 06. Vertical Strategy

**Objective: **Use a wedge without trapping the architecture.

**Which industries should we target first?**

Consumer and lifestyle businesses where ITS has credibility: beauty, CPG, retail/e-commerce, marketing/advertising, creative, sports/entertainment business functions, and tech-enabled services. Add SaaS/technology selectively where role taxonomies are familiar and sourcing demand is high.

**Which industries should we avoid first?**

Highly regulated clinical healthcare hiring, government, defense, union-heavy hourly workforce environments, aviation/safety-critical roles, and industries where licensing or collective bargaining creates complex first-order requirements. They can be later verticals.

**Which roles are most repeatable for AI to recruit well?**

Roles with observable work history and structured outcome criteria: performance marketing, e-commerce, sales, customer success, finance/accounting, HR, recruiting, operations, software engineering, product and design. High-volume hourly roles can become a later product line with different UX.

**Where does ITS have the strongest domain expertise or network?**

Beauty, consumer, e-commerce, advertising/creative, technology, fintech, SaaS and professional services. That should be used as a training and validation advantage.

**Would you rather own one vertical deeply or serve many SMBs broadly?**

Vertical-first go-to-market, horizontal product architecture. Start with two or three adjacent verticals that share hiring patterns and buyer profiles. Do not build a generic SMB marketing message on day one.

**What vertical-specific workflows or data could become a moat?**

Role templates, target-company maps, compensation ranges, candidate adjacency maps, interview rubrics, offer-risk patterns, channel performance, time-to-fill benchmarks, stage conversion benchmarks, sourcing response benchmarks and 'what good looks like' evidence libraries.

FOUNDER DECISION: Go to market vertically, build horizontally. Initial wedge: consumer/beauty/e-commerce plus creative/marketing and selected tech-enabled companies.

# 07. End-to-End Recruiting Lifecycle

**Objective: **Own the lifecycle, including the messy parts other software leaves to people.

**List every step from hiring need through onboarding.**

Hiring need -> requisition/intake -> Role Packet -> approval -> job/ad creation -> career site/job board distribution -> internal talent and past-candidate rediscovery -> referral activation -> external sourcing -> outreach -> application capture -> identity/fraud checks where appropriate -> eligibility/knockout checks -> evidence extraction -> AI triage -> targeted follow-up -> recruiter/human review when needed -> screening -> scheduling -> structured interviews -> scorecards -> debrief -> references/background checks -> compensation/offer approval -> offer creation/signature -> close management -> preboarding -> HRIS/onboarding handoff -> first-day confirmation -> outcome feedback.

**What happens before a job is posted?**

The system diagnoses the business need, challenges the brief, creates a Role Packet, checks market feasibility, recommends compensation/location adjustments, builds the interview rubric, chooses sourcing channels, defines autonomy rules, and obtains required approvals.

**What should happen during job creation and approval?**

Create a candidate-readable job description, internal success profile, evaluation rubric, compensation band, interview plan, legal/disclosure copy and sourcing strategy. Keep external marketing content distinct from internal evaluation criteria.

**How should applications, sourcing, screening, scheduling, interviews, references, offers and onboarding work?**

Each should be a stateful workflow backed by the same candidate and role record. No separate tool should be required for routine execution. External providers can be integrated for background checks, e-signature, HRIS and specialized assessments.

**Where should automation be fully autonomous?**

Acknowledgements, status updates, reminders, calendar coordination, data enrichment, evidence extraction, duplicate detection, rediscovery suggestions, draft outreach, SLA monitoring, interview packet preparation, note summarization, offer document generation from approved terms, and onboarding handoff.

**Where should approval be required?**

Final job/comp approval, external campaign launch until trust is established, low-confidence candidate rejection, interview-loop changes, offer changes, compensation exceptions, sensitive communications and regulated decision points.

**What happens when a candidate withdraws, ghosts, fails screening or rejects an offer?**

Trigger a reason-coded recovery flow. Capture reason, attempt respectful re-engagement if appropriate, preserve relationship, update role risk, notify owner only when action is needed, and use the event as learning data. Offer rejection should launch a structured loss analysis.

**What important lifecycle step is missing from typical ATS products?**

Continuous calibration and close-risk management. The system should recognize when the search itself is wrong, when managers are changing criteria, or when candidate motivation is weakening.

FOUNDER DECISION: The platform owns the whole recruiting state machine, including calibration, candidate relationship management, offer risk and post-search learning.

# 08. Product Architecture

**Objective: **Define the product as an operating system with distinct layers.

**What should the system of record contain?**

Company, users/permissions, jobs/requisitions, Role Packets, candidates/people, applications, prospects, source history, communications, consent/disclosure records, evaluations, evidence, interviews, scorecards, tasks, approvals, offers, onboarding handoffs, workflow events, AI actions, overrides, audit logs, model/prompt versions and outcome data.

**What should the AI action layer be able to do?**

Read context, propose plans, execute permitted tools, draft/send communications, move workflow, collect missing facts, schedule, compare evidence to criteria, summarize, alert, create documents, search internal talent, initiate external sourcing and open human escalations.

**What should the main workflow engine control?**

Durable state, retries, timers, dependencies, approvals, SLAs, compensating actions, idempotency and human handoffs. The workflow engine should remain deterministic even when AI recommendations are probabilistic.

**What should the customer see every day?**

A 'Today' page that answers four questions: What needs my attention? Who are the best people to look at? What is at risk? What did the recruiting system accomplish since I last checked?

**What should a hiring manager be able to accomplish in under 5 minutes?**

Approve a Role Packet, review a shortlist, respond to an escalation, submit structured interview feedback, approve an offer, or change a requirement and immediately see the impact.

**What should the product never require a customer to understand?**

Boolean search, prompt engineering, model selection, workflow configuration syntax, ATS administration jargon, data schemas, integration internals or AI credit math.

**What are the most important objects?**

Company, role, Role Packet, candidate/person, application/prospect, evidence item, evaluation, interview, communication thread, workflow, action, approval, offer, outcome and playbook.

FOUNDER DECISION: Five layers: system of record, workflow engine, policy engine, AI action layer, and human service layer. The UI is an outcome cockpit on top.

# 09. AI Agent Architecture

**Objective: **Use specialized capabilities without creating an unmaintainable agent zoo.

**What AI agents should exist?**

Present them to users as one Recruiting Chief of Staff, but implement modular specialist services: Orchestrator, Intake/Role Strategy, Talent Discovery, Triage/Evidence, Candidate Concierge, Scheduling/Coordination, Interview Intelligence, Offer/Close, Compliance/Policy, and Recruiter Escalation.

**What should the Recruiting Operations Orchestrator own?**

Goal decomposition, workflow state awareness, which specialist capability to invoke, escalation decisions, progress summaries and completion checks. It should not invent policy or bypass permissions.

**What should the Intake Agent own?**

Business diagnosis, Role Packet drafting, feasibility checks, must-have/tradeable separation, job copy, interview plan, sourcing hypothesis and risk flags.

**What should the Triage/Screening Agent own?**

Evidence extraction, criteria mapping, missing-evidence detection, targeted follow-ups, structured fit categories and confidence. It should never infer protected traits or hidden personality from weak proxies.

**What should the Coordinator own?**

Calendars, availability, interview plans, reminders, reschedules, time zones, candidate instructions and interviewer preparation.

**What should the Interview Intelligence Agent own?**

Structured interview guides, transcript/notes summaries where consented, evidence mapping, scorecard completion prompts, inconsistency detection and debrief packets.

**What should the Offer Agent own?**

Approval routing, document generation, signature tracking, candidate close plan, risk monitoring, follow-up and decline analysis.

**Should there be a Sourcing Agent?**

Yes. Strategically it must exist. In the earliest release, prioritize internal rediscovery and existing databases because they are lower cost and easier to validate. External sourcing follows quickly because recruiter-sourced interviews are increasing and competitors already set that expectation. [S12]

**What decisions can each agent make without approval?**

Only actions permitted by the policy matrix for that customer, role, region and confidence level.

**How should agents communicate?**

Through typed events and shared domain state, not free-form agent-to-agent chat as the system backbone. Messages should reference source evidence and action IDs.

FOUNDER DECISION: One assistant personality, modular backend capabilities. Use explicit workflows and typed events, not unconstrained multi-agent conversation.

# 10. AI Decision + Candidate Ranking

**Objective: **Make evidence and uncertainty first-class product concepts.

**What makes someone a Strong Match?**

The candidate has direct or highly transferable evidence for nearly all critical outcomes and must-haves, no unresolved disqualifier, acceptable logistics, and sufficient evidence quality. Strong Match is a recommendation to prioritize review, not a hiring verdict.

**What makes someone a Potential Match?**

The candidate has credible evidence for core outcomes but has one or more material unknowns, adjacent experience, or a negotiable gap that deserves targeted follow-up.

**What should count as Insufficient Evidence?**

The available materials do not establish whether a required criterion is met. Missing evidence must not be silently converted into a negative.

**What evidence should AI be required to show?**

For each criterion: source, exact claim or summarized evidence, date/context, confidence, contradiction if any, and whether the evidence came from candidate-provided material, recruiter notes, public professional data or an assessment.

**What should AI never infer?**

Protected characteristics, disability, race/ethnicity, religion, pregnancy, sexual orientation, political beliefs, family status, health, age beyond lawful requirements, socioeconomic background, personality from facial/voice features, or culture fit as a proxy for similarity.

**How should confidence be represented?**

Use High / Medium / Low confidence with an explanation of what drives uncertainty. Do not hide uncertainty behind a precise number.

**When should a human override AI?**

Any time. Overrides should require a reason on consequential decisions so the system can learn and audits remain interpretable.

**Should there be a numerical score?**

Not as the primary UI. Internally, calibrated models may use numeric signals, but customer-facing evaluation should be Strong Match / Potential Match / Weak Match / Insufficient Evidence plus criterion-level evidence, strengths, concerns and unknowns. This is safer, more understandable and less likely to create false precision.

**What should customers see about candidates AI did not advance?**

A searchable exclusion view with the reason, evidence, confidence, policy applied, and a one-click 'review anyway' path. Hidden auto-rejection is unacceptable for the core product.

FOUNDER DECISION: Evidence before score. Confidence before certainty. Human review always available. No black-box candidate ranking.

# 11. Human Escalation Model

**Objective: **Turn human recruiting capacity into a strategic product layer.

**When should AI escalate to a human recruiter?**

Low confidence on a consequential action, conflicting evidence, hiring-manager contradiction, sensitive candidate conversation, compensation/closing risk, repeated failed sourcing, candidate complaint, legal exception, executive-level search, or explicit customer request.

**What should trigger human takeover?**

A policy rule, risk threshold, repeated workflow failure, candidate sentiment signal, offer risk, customer SLA, or user click.

**Should ITS provide the human backstop?**

Yes initially. ITS is a unique launch advantage because it provides real expertise, creates a feedback loop, and differentiates the product from pure software. Over time this can become a certified recruiter network or partner marketplace.

**What does Recruiter on Demand look like?**

A clearly priced service entitlement. The user can press 'Bring in a recruiter' at the role or candidate level. The recruiter receives the full context, can assume control of selected workflow steps, and leaves structured notes/corrections that improve the system.

**What should the human be able to take over instantly?**

Sourcing strategy, candidate communication, screening, manager calibration, closing, negotiation, interview troubleshooting and executive searches.

**How should customers know AI versus human?**

Every interaction and activity log should identify whether it was system-generated, system-sent under policy, or human-created. Candidate-facing interactions should disclose AI where appropriate and legally required.

**What if the customer wants fully managed recruiting?**

Offer a managed tier that uses the same platform, with the software as operating backbone. This is both a revenue line and a training environment, but the product must track recruiter labor to preserve healthy unit economics.

FOUNDER DECISION: Human escalation is not a support feature. It is a core trust, differentiation and learning layer.

# 12. Candidate Experience

**Objective: **Make the candidate surface as polished as the employer surface.

**What should the candidate experience feel like?**

Fast, respectful, mobile-first, transparent and genuinely personal. The candidate should never wonder whether the application was received, what comes next, or how to get help.

**Should candidates know when they are interacting with AI?**

Yes. Use concise disclosure without making the interaction feel clinical. BCG recommends clarity about how AI is used and where humans remain responsible; current laws also increasingly require notice in covered situations. [S10][S14][S15][S17]

**What should the application include?**

Resume/LinkedIn import, only necessary knockout questions, optional profile enrichment, salary/location/work-authorization where lawful, privacy/AI notice, accessibility path, and a visible estimate of time to complete. Never force resume re-entry after upload.

**SMS, email or both?**

Both, with candidate-controlled preference and opt-out. Email for formal details and records, SMS for time-sensitive scheduling/reminders and lightweight follow-up.

**What should screening look like?**

Conversational and role-specific. Ask only questions that close evidence gaps. Support text, audio or scheduled human screen. Avoid mandatory asynchronous video as a universal default because it can create trust and accessibility friction.

**How should scheduling work?**

Self-scheduling with guardrails, instant timezone handling, calendar invites, reschedule without shame, interviewer context, accessibility needs and automatic confirmation.

**How should candidates get status updates?**

At every stage transition and whenever an SLA is missed. A candidate portal should show a simple status timeline and expected next step without revealing sensitive internal deliberation.

**How should withdrawal, privacy and data requests work?**

One-click withdrawal, communication preference controls, delete/access request workflow, consent log, retention explanation and region-aware handling.

**What should offers and onboarding feel like?**

The offer should feel celebratory and human. Pair the formal document with a personalized summary of role, compensation, benefits, start date and contacts. After signature, transition seamlessly into preboarding and HRIS/onboarding.

**What would make candidates say this is the best experience?**

They never had to chase anyone, the process respected their time, interviews felt relevant, communication sounded human, decisions were timely, and even rejection gave them closure. Glassdoor notes that 80 to 90% of talent say candidate experience can change their view of a role or company. [S11]

FOUNDER DECISION: Candidate experience is a first-class product, with a mobile portal, clear AI disclosure, low friction, proactive status communication and easy human access.

# 13. UX Principles

**Objective: **Create a product that feels like a person doing work for you, not software making you work.

**Describe the ideal experience in 5 words.**

Calm. Capable. Personal. Transparent. Fast.

**What should the product feel like?**

Premium but approachable. More like a trusted chief of staff than an enterprise HR console.

**What should a founder see on login?**

Today: 3 decisions needed, 4 strong candidates ready, 1 offer at risk, 17 candidates handled automatically, 2 interviews scheduled, and a concise 'what changed' narrative.

**What should be one-click?**

Approve role, review shortlist, approve outreach campaign, ask for recruiter help, advance/reject with reason, request candidate follow-up, reschedule, approve offer, and share a candidate.

**What should never be buried?**

Open decisions, risk, candidate communications, role health, AI actions, rejection rationale, human escalation, and privacy/compliance settings.

**What should AI explain versus execute?**

Execute routine low-risk work quietly. Explain consequential recommendations, uncertainty, rule conflicts, and anything that changes a candidate's path.

**What would make the product feel magical?**

The system proactively notices problems before the user does: 'Your compensation is suppressing qualified applicants,' 'two finalists are both interviewing elsewhere,' 'your interview loop is causing a 5-day delay,' or 'this candidate looks weak on title but matches the outcome evidence.'

FOUNDER DECISION: Design around attention, not navigation. The UI should surface decisions and outcomes, while routine execution disappears into the background.

# 14. Information Architecture

**Objective: **Keep navigation simple enough for a founder, deep enough for a recruiter.

**Primary navigation?**

Today, Roles, Talent, Interviews, Offers, Insights. Secondary: Automations/Activity, Recruiter Help, Integrations, Settings/Admin.

**What should the home/dashboard show?**

Decision inbox, role health, best candidates, at-risk items, pipeline movement, recruiting work completed by AI, upcoming interviews, offers and a daily brief.

**How should Jobs/Roles be organized?**

By health and priority, not just open/closed. Each role workspace has Overview, Talent, Pipeline, Interviews, Activity, Offer, Insights, and Role Packet.

**How should Candidates be organized?**

A unified person record across prospect/application history, with current role context, evidence, communication, consent, interviews and prior relationships.

**Where should AI activity and tasks live?**

An Activity/Audit stream globally and contextually inside each role/candidate. Users should be able to filter 'AI acted,' 'human acted,' 'approval needed,' and 'failed/retried.'

**Where should interviews, offers, onboarding and analytics live?**

Dedicated aggregate views plus embedded role/candidate context. Never force users to leave the role to understand the whole story.

**What should universal search do?**

Search people, roles, companies, notes, conversations, evidence and actions. Also support natural-language commands such as 'show me strong marketing candidates in Orange County who were previously interviewed.'

FOUNDER DECISION: Six-item primary navigation with a decision-first home. Complexity lives behind context, not in the global menu.

# 15. UI / Screen-by-Screen Requirements

**Objective: **Define the core surfaces in enough detail to guide implementation.

**Describe the ideal dashboard.**

A narrative daily brief at top, followed by decision cards, role-health grid, candidate highlights, offers/risks, upcoming interviews and an 'AI work completed' summary. Avoid a KPI dashboard that makes the user interpret charts before knowing what to do.

**Describe the role workspace.**

Header with status/priority/owner and a role-health indicator. Left/main area for pipeline and candidates. Right-side intelligence panel for Role Packet, market insights, blockers and AI recommendations. A timeline shows all meaningful changes.

**Describe the candidate profile.**

Human-readable identity and story first, then fit. Top area: current title, location, compensation/logistics, stage, relationship status. Next: Strong/Potential/Weak/Insufficient category, strengths, concerns, unknowns and evidence by criterion. Then communications, interview history, documents and audit trail.

**Describe the candidate pipeline.**

Fast kanban and table modes. Each card should show enough signal to act without opening it: fit category, confidence, last touch, next step, risk and source. Bulk operations require preview and policy checks.

**Describe screening/review.**

Evidence matrix tied to the Role Packet, with missing evidence highlighted and one-click follow-up questions. Side-by-side resume, notes and AI extraction. No giant numeric score.

**Describe scheduling.**

Candidate-facing self-scheduling and employer scheduling control with interviewer availability, sequence rules, buffers, locations, virtual links, accessibility notes and automatic recovery from declines.

**Describe interview intelligence.**

Interview plan, competency coverage map, interviewer assignments, generated guide, real-time note space, post-interview scorecard, transcript summary if consented, and a debrief that highlights agreement/disagreement and missing evidence.

**Describe offers.**

Approval status, compensation components, internal range, candidate expectations, competing offers, close-risk, document status, e-signature and follow-up plan.

**Describe onboarding handoff.**

Signed offer -> required fields/documents -> HRIS mapping -> tasks -> candidate preboarding timeline. This is a clean handoff, not a full HRIS in the first product.

**Describe analytics.**

Time to qualified slate, time to interview, time to fill, source effectiveness, stage conversion, candidate drop-off, offer acceptance, hiring-manager responsiveness, AI override rate, human escalation rate, workflow failure rate, recruiter hours saved, and customer effort.

**Describe admin/support views.**

Tenant config, user roles, AI autonomy matrix, integrations, templates, data retention, regional compliance, model/prompt versions, workflow runs, failed actions, human takeover sessions, customer entitlements and billing usage.

FOUNDER DECISION: Build an owner cockpit and recruiter-grade depth in the same product through progressive disclosure.

# 16. Brand Strategy

**Objective: **Own a category that sounds like a business outcome, not another HR tool.

**What should the company stand for?**

Great hiring without recruiting chaos.

**What should it be known for?**

The system that actually runs recruiting for you.

**What should customers say?**

'It feels like we hired a recruiting team, not software.'

**What should it absolutely not feel like?**

Cold, surveillance-heavy, HR-bureaucratic, chatbot gimmicky, or like a black-box scoring engine.

**AI product, recruiting company, HR platform, or something new?**

Something new: a recruiting operating company delivered as software + agents + optional humans. The brand should lead with the job done, not AI.

**What emotional response should it create?**

Relief and control. Hiring is handled, nothing is falling through the cracks, and I can see why the system is doing what it is doing.

FOUNDER DECISION: Brand the category around recruiting capacity and outcomes. AI is the engine, not the identity.

# 17. Brand Name

**Objective: **Set naming criteria while keeping the decision open.

**Do you already have a name?**

No name should be treated as final yet.

**What naming styles do you like?**

Short, ownable, intelligent, warm, easy to say, not overly literal. It should work as both a company name and a product personality.

**What naming styles do you dislike?**

Anything with 'hire', 'recruit', 'talent', 'bot', 'AI', 'HR' or awkwardly compounded SaaS language unless unusually distinctive.

**Should the name describe what it does or create a category?**

Create a brand. The category explanation can be descriptive: 'your AI recruiting department.'

**Any themes?**

Guidance, signal, momentum, clarity, team, craft, navigation, trusted partner.

**Any concepts to avoid?**

Surveillance, scoring, ranking, replacement, robotic labor, or names that sound like an employment agency only.

FOUNDER DECISION: Do a formal naming sprint after the product thesis and first vertical are locked. Optimize for ownability and trust, not keyword SEO.

# 18. Brand Voice + Content

**Objective: **Make every system interaction sound competent and human.

**How should AI speak to founders?**

Short, decisive and business-oriented. 'Three candidates need your review. I recommend advancing two. Here is why.'

**How should it speak to hiring managers?**

Collaborative and evidence-based. It can respectfully challenge: 'Your feedback suggests portfolio depth matters more than the 7-year tenure requirement. Should I update the Role Packet?'

**How should it speak to candidates?**

Warm, clear, respectful and specific. Never pretend to be a human. Avoid robotic legal copy unless necessary.

**What should the tone be?**

Cool, capable, personal, calm. High confidence without fake certainty.

**How formal or casual?**

Professional conversational. More Stripe/Notion than legacy HR software.

**What words should never be used?**

Perfect fit, culture fit without definition, algorithm says, rejected by AI, human capital, resource, rockstar, ninja, or language that reduces people to scores.

**What should onboarding copy feel like?**

Like a great recruiter joining the company and learning how the business works.

FOUNDER DECISION: One personality: smart recruiting chief of staff. Concise for employers, warmer for candidates, transparent everywhere.

# 19. Visual Identity

**Objective: **Create a premium, modern system without looking like generic AI SaaS.

**What brands have visual identities to learn from?**

Use the clarity and restraint of Linear, Stripe and Notion as product references, with a warmer human layer similar to modern consumer fintech. Do not clone them.

**What colors?**

A sophisticated neutral base with one confident electric accent and one warm supporting tone. Avoid the default purple-gradient AI aesthetic.

**What colors should we avoid?**

Generic HR teal-only palettes, heavy corporate navy everywhere, neon gradients, or red/green as the sole meaning for candidate quality.

**Minimal or expressive?**

Minimal product chrome with expressive moments in onboarding, offers, milestones and candidate experience.

**Enterprise or startup?**

Startup clarity with enterprise trust cues.

**Warm or technical?**

Warm technical.

**Symbols, imagery, typography?**

Human-centered editorial photography/illustration sparingly, strong typography, subtle motion tied to work being completed, and a visual language of flow, progress and signal rather than robots or brains.

FOUNDER DECISION: Premium, restrained, human. Avoid generic AI visual tropes and overly clinical HR aesthetics.

# 20. Pricing + Business Model

**Objective: **Price against replaced work and agency spend, not ATS feature parity.

**What should the software cost?**

Launch hypothesis: Core $499/month for very small teams, Growth $899/month for active hiring teams, and Company $1,499+/month for higher volume and governance, with annual discounts. Include meaningful usage but meter unusually expensive external sourcing/data and communications. This intentionally prices above lightweight SMB ATS products and below the cost of recruiter headcount or agency spend.

**Per company, role, hire, employee, usage or hybrid?**

Base platform subscription by company/hiring band plus usage entitlements. Avoid per-user pricing because the product should encourage manager adoption. Avoid pure per-hire pricing for software because it makes revenue volatile and can feel like an agency.

**What should core software include?**

ATS/system of record, Role Packet, inbound application handling, candidate evidence, communications, scheduling, interview workflows, offers, core analytics, AI activity/audit and basic integrations.

**What should software + recruiter include?**

A monthly pool of recruiter hours or defined escalations, role calibration, sourcing intervention, candidate closing and expert review.

**What should fully managed recruiting cost?**

Use a platform retainer plus role/success economics rather than traditional 20 to 30% contingency by default. Example: $2,500 to $5,000 monthly platform/service retainer plus fixed success fees by compensation band. Exact numbers must be validated with pilot customers.

**Free trial or pilot?**

A guided 30-day live-role pilot is stronger than a generic free trial because value depends on integration and workflow. Charge a modest pilot fee that converts to subscription, or offer it free only to tightly selected design partners.

**What model is easiest for an SMB owner?**

Three choices: I run it, we help you run it, we run it for you.

**What services/add-ons could exist?**

External sourcing packs, recruiter hours, executive search, background/reference checks, compensation benchmarking, employer brand/career site, high-volume hiring, custom integrations and compliance support.

FOUNDER DECISION: Price around replacement value with three clear tiers of autonomy/service. Do not compete at $100/month ATS pricing.

# 21. Unit Economics

**Objective: **Build a model that prevents human services and data costs from quietly destroying gross margin.

**Target MRR per customer?**

Blended software-only ARPA should aim for roughly $800 to $1,200 once product-market fit develops. Blended revenue including service tiers can be higher, but software gross margin and service gross margin must be tracked separately.

**Target gross margin?**

Software 80%+ long term. Human-assisted tier 55 to 70% depending on recruiter utilization. Fully managed services can be lower early, but the company should not let services dominate consolidated revenue as it scales.

**How much human recruiter time can one customer consume?**

In the software + recruiter tier, target 1 to 4 hours per active role per month after onboarding. Anything materially higher should trigger repricing, process redesign or a managed-service tier.

**What AI/API costs do you expect?**

Model inference itself is unlikely to be the largest cost. External talent data, enrichment, email/SMS, transcription/voice, background checks, job distribution, integration maintenance and human escalations can dominate. Workable's current AI-credit pricing is a useful reminder that candidate-level actions can become visible unit costs. [S18]

**What costs concern you most?**

Talent-data licensing, sourcing enrichment, human recruiter labor, support during integration, enterprise security/compliance, email deliverability, job board commercial terms and customer acquisition.

**What makes economics unattractive?**

Unlimited expensive sourcing bundled into low subscription prices, custom integration work for every customer, recruiter labor hidden inside software plans, low-volume customers who churn between hiring cycles, and high support requirements.

**What CAC is acceptable?**

For self-serve/inside-sales SMB software, aim for CAC payback under 12 months, ideally under 9 after the product is mature. Higher-touch managed plans can tolerate longer payback if retention and expansion are strong.

**What retention or expansion do you expect?**

Retention will be threatened by hiring cyclicality. Counter this with annual contracts, persistent talent CRM, workforce planning, rediscovery, compliance, analytics and HRIS-connected workflows that retain value when hiring slows.

FOUNDER DECISION: Track contribution margin by workflow and by customer. Never hide human labor or data costs inside a blended gross-margin story.

# 22. Data Strategy

**Objective: **Build a proprietary data asset without abusing candidate information.

**What customer data should the product collect?**

Company profile, org structure, role history, hiring outcomes, interview process, compensation bands, recruiter/hiring-manager actions, approval preferences, communication style, sourcing performance and workflow metrics.

**What candidate data should it retain?**

Only data needed for recruiting and relationship management, with source/provenance, consent status, retention basis, communication preferences, applications, evidence, interview records, offers and outcome history.

**What historical ITS data could help?**

Anonymized/permissioned role taxonomies, search strategies, candidate progression patterns, sourcing channels, interview rubrics, close reasons, offer outcomes, time-to-fill and recruiter corrections. Do not ingest old data without rights and governance review.

**What data should never be used for model training?**

Protected-class information, highly sensitive personal data, private interview content without appropriate consent, customer-confidential data outside tenant boundaries, and candidate data beyond the purposes disclosed.

**Who owns the data?**

Customers own their tenant data; candidates retain their legal rights in personal data. The platform can use de-identified/aggregated telemetry and permitted feedback to improve systems under clear contractual terms.

**How long should data be retained?**

Configurable by jurisdiction and customer policy, with defaults by object type. Candidate records should have retention schedules and deletion workflows rather than indefinite storage.

**What proprietary data could become a moat?**

Role-to-evidence mappings, calibration corrections, stage outcomes, sourcing response, candidate adjacency patterns, reason-coded overrides, market feasibility, offer acceptance drivers, and vertical benchmarks.

FOUNDER DECISION: Build provenance, consent, retention and tenant boundaries into the schema. The moat is outcome-linked workflow intelligence, not indiscriminate candidate-data accumulation.

# 23. Learning + Feedback Loop

**Objective: **Turn human corrections into controlled product improvement.

**How should recruiter corrections improve the product?**

Store corrections as structured events: what was changed, why, role context, evidence and outcome. Use them first for company/role memory, then for offline evaluation and playbook updates. Do not let one correction silently retrain global behavior.

**How should hiring-manager decisions improve the product?**

Capture explicit reasons for advance/reject and identify when preferences drift from the approved Role Packet. Ask whether the manager wants to update the criteria rather than inferring new rules.

**How should outcomes feed back?**

Tie interviews, offers, acceptances, early retention and hiring-manager satisfaction to prior recommendations. This enables calibration analysis: not just 'was AI overridden?' but 'which recommendations produced good downstream outcomes?'

**What should AI learn at company level?**

Tone, common roles, evidence preferences, interview design, decision speed, compensation patterns, approval hierarchy, autonomy comfort and historical talent pools.

**What should it learn at vertical level?**

Role patterns, adjacent companies/backgrounds, market availability, channel performance, compensation ranges and evidence predictive of successful progression.

**How should bad AI decisions be captured?**

One-click flag with taxonomy: wrong evidence, hallucination, policy error, bias concern, poor communication, wrong workflow action, false negative, false positive, or missing context. Route severe issues to review.

**What should become a benchmark?**

Time to qualified slate, stage conversion, application quality, source yield, outreach response, interview-to-offer, offer acceptance, candidate drop-off, manager response time, override rate, escalation rate and quality-of-hire proxies.

FOUNDER DECISION: Learning is staged: tenant memory -> evaluated pattern -> curated playbook -> validated global improvement. Never auto-learn consequential policy from raw behavior.

# 24. Technical Architecture

**Objective: **Prioritize durable execution, observability and model independence.

**What stack preferences?**

TypeScript/Next.js for web, Postgres as authoritative relational store, object storage for documents, a vector/search layer for semantic retrieval, Redis only where needed, and a durable workflow engine such as Temporal. Use event streaming/queueing where scale requires it, but do not overbuild Kafka on day one.

**What integrations are essential at launch?**

Google and Microsoft email/calendar, one e-signature option, job distribution/career site, and a small number of HRIS handoffs. External sourcing/data provider comes early but can be abstracted behind a provider interface.

**What should be event-driven?**

Candidate/role state transitions, communications, interview changes, approvals, offer status, integration webhooks, AI actions, retries, SLA timers and audit events.

**What needs a durable workflow engine?**

Anything multi-step and long-running: hiring workflow, outreach sequences, scheduling, interview loops, offer approvals, data deletion, onboarding handoff, integration recovery and human escalation.

**How should AI models be abstracted?**

Use a model gateway with task-based routing, versioned prompts/skills, structured outputs and evaluation metadata. Never couple domain logic directly to one foundation model vendor.

**What needs real-time behavior?**

Candidate chat, user commands, scheduling responses, alerts, activity updates and some sourcing/search experiences. Most back-office analysis can be asynchronous.

**What needs strong observability?**

Every AI decision/action, workflow run, tool call, integration call, policy decision, retry, failure, human override, latency and cost.

**What should be built versus purchased?**

Build workflow/policy/evidence/domain system, user experience, learning loop and audit model. Buy commodity infrastructure: email/calendar APIs, e-signature, background checks, transcription, identity/fraud tools, talent data where licensing is realistic, and observability primitives.

FOUNDER DECISION: Workflow and policy are the product backbone. Models are replaceable components. Every consequential action must be replayable and auditable.

# 25. Integration Strategy

**Objective: **Integrate deeply where customers already live, but keep the product from becoming an integration consultancy.

**Which email providers?**

Google Workspace/Gmail and Microsoft 365/Outlook first.

**Which calendar providers?**

Google Calendar and Microsoft Outlook/Exchange calendars first.

**Which HRIS/payroll systems?**

Start with Gusto and Rippling for SMB, then BambooHR. Add ADP/UKG/Workday only when target customers justify the complexity.

**Which job boards?**

Indeed and LinkedIn are strategically important, plus broad distribution through an aggregation partner where contractually possible. Career site should be native.

**Which sourcing/data providers?**

Abstract behind a Talent Graph provider layer. Evaluate licensed providers based on coverage, contact accuracy, terms, refresh rates and rights. Do not make scraping a core dependency.

**Which assessment/interview tools?**

Keep native structured interview functionality. Integrate specialized assessment providers only where roles need validated skills tests.

**Which e-signature providers?**

Native lightweight signatures if legally/technically appropriate or integrate Dropbox Sign/DocuSign. Avoid forcing a premium enterprise contract for SMBs.

**Which onboarding systems?**

HRIS handoff first. Full onboarding is not necessary to replace an HRIS.

**Which are must-have for MVP?**

Google/Microsoft identity, email and calendar; native career site/application; job distribution; e-signature; one HRIS handoff path. Everything else should be adapter-ready.

FOUNDER DECISION: Own the recruiting workflow, integrate the adjacent systems. Use adapters and provider interfaces so no vendor becomes architectural lock-in.

# 26. Security + Compliance

**Objective: **Make responsible AI and employment compliance a product feature customers can understand.

**What security standards should we target?**

SOC 2 Type I early, Type II as soon as operational maturity allows; encryption in transit/at rest; MFA; SSO for higher tiers; least privilege; secure SDLC; dependency scanning; secrets management; backups/DR; penetration testing; incident response; vendor risk management; and privacy-by-design.

**What permissions and roles are needed?**

Tenant admin, recruiting/People admin, recruiter, hiring manager, interviewer, executive/approver, finance/offer approver, external recruiter and support impersonation with strict audit controls.

**What audit logs are required?**

Immutable record of who/what viewed or changed role criteria, advanced/rejected candidates, sent communications, changed autonomy, accessed sensitive data, generated offers, overrode AI, exported/deleted data, and which model/prompt/policy produced each AI recommendation.

**How should AI disclosure work?**

Jurisdiction-aware notices plus a universal plain-language disclosure philosophy. Candidate-facing settings should record when notice was shown and consent where required.

**Where must a human be involved?**

Final accountability for hiring. Human review should be required by default for ambiguous rejection, material compensation/offer decisions, policy exceptions and any high-risk flow required by applicable law.

**What should the system never automatically decide?**

Anything based on protected traits/proxies, disability/medical information, inferred emotion or personality from face/voice, or a final hiring decision without a configurable accountable human process.

**How should bias/disparate impact be monitored?**

Outcome monitoring by lawful demographic data where available and permitted, selection-rate analysis, model/evaluation slicing, drift monitoring, structured bias audits where legally required, and a documented process to investigate anomalies.

**What customer controls are needed?**

Autonomy matrix by action: Auto, Auto + Notify, Approval Required, Human Only. Regional rules can override customer preference where required.

**What privacy requirements matter most?**

Data minimization, provenance, access/delete/correction workflows, retention, consent, purpose limitation, subprocessors, cross-border controls, tenant isolation and transparent use of candidate data.

FOUNDER DECISION: Compliance is architecture. Build policy, disclosure, audit, human review and region rules before scaling autonomous candidate decisioning. [S14][S15][S16][S17][S20]

# 27. MVP Scope

**Objective: **Prove the operating thesis with a real production hiring loop.

**If we had 90 days, what absolutely must work?**

Company onboarding; Role Packet intake; job/career application; candidate ingestion; resume parsing/evidence extraction; transparent match categorization; targeted follow-up; communications; scheduling; interview plan/scorecards; decision inbox; activity/audit; offer generation/approval; and human recruiter escalation. Google/Microsoft calendar/email integration is required.

**What should be excluded from MVP?**

Full payroll/HRIS replacement, internal mobility suite, workforce planning, broad marketplace, dozens of integrations, complex enterprise SSO provisioning, highly autonomous external sourcing across many providers, and sophisticated quality-of-hire modeling.

**What single workflow should be perfect?**

A hiring manager says 'I need a performance marketing manager,' completes guided intake, approves the Role Packet, the system launches the role, handles inbound candidates, surfaces a qualified slate, schedules interviews, consolidates evidence, supports the offer and closes the candidate.

**What is the smallest product a real customer could pay for?**

The above workflow with a credible candidate experience and recruiter backstop. It must save executive/HR time immediately, not merely demonstrate AI.

**Which tempting features should wait?**

AI voice interviewer as the default, broad external sourcing marketplace, deep workforce analytics, branded mobile app, full onboarding suite and complex customization.

**What should ITS use in production first?**

A live ITS client search with the ITS recruiter operating in 'recruiter mode' and the client hiring manager in 'owner mode.' Track every manual correction and workflow failure.

FOUNDER DECISION: MVP means one complete production search, not a thin demo. Use ITS as the first demanding customer and training ground.

# 28. Product Roadmap

**Objective: **Sequence breadth without losing the full architecture.

**What should exist in V1?**

Production-grade inbound recruiting OS, Role Packet, candidate evidence, interview coordination, offers, basic analytics, recruiter mode, owner mode, human escalation, audit/policy, email/calendar and initial HRIS handoff.

**What should exist in V2?**

Internal talent rediscovery, referrals, external sourcing agent, multi-channel outreach, richer market intelligence, vertical playbooks, more HRIS/job board integrations, usage/billing and customer admin.

**What should exist in V3?**

Advanced sourcing graph, workforce planning, internal mobility, quality-of-hire feedback, compensation intelligence, partner recruiter network, multi-entity/global support and more autonomous execution where validated.

**When should external sourcing become major?**

Immediately after inbound workflow is reliable, not years later. Market behavior and competitor direction make sourcing strategically necessary. [S8][S12]

**When should workforce intelligence be added?**

After enough customers have persistent role/candidate/outcome history to make the insights differentiated rather than generic dashboards.

**When should vertical playbooks become major?**

Start collecting from day one, expose them in V2 once patterns are validated across multiple customers.

**What capabilities should eventually be fully autonomous?**

Routine sourcing, outreach, screening follow-up, scheduling, reminders, pipeline hygiene, interview prep and offers from pre-approved terms. Final consequential decisions remain governed and auditable.

FOUNDER DECISION: Roadmap expands autonomy and intelligence after workflow reliability. Sourcing arrives early; workforce intelligence arrives after data density.

# 29. AI Evaluation + Quality

**Objective: **Treat evaluations as a core engineering discipline, not QA at the end.

**What golden test cases must pass?**

Role Packet from messy intake; transferable candidate recognized; missing evidence not treated as failure; protected/proxy information ignored; conflicting hiring-manager criteria surfaced; duplicate candidate resolved; candidate opt-out honored; timezone scheduling; reschedule recovery; low-confidence rejection escalated; offer approval rule enforced; hallucinated evidence blocked.

**How should candidate evaluation quality be tested?**

Expert-labeled benchmark roles/candidates with criterion-level precision/recall, ranking quality where relevant, false-negative review, calibration of confidence, subgroup analysis, and adjudication by multiple recruiters.

**How should outreach quality be tested?**

Factuality, personalization grounded in real evidence, tone, spam risk, deliverability, response rate, opt-out handling and hallucination rate.

**How should scheduling/workflow execution be tested?**

Deterministic integration tests, simulated calendars, retries, idempotency, race conditions, daylight saving/timezone cases, external API failures and human interruption.

**What metrics define a good AI recruiter?**

Qualified slate precision, time to qualified slate, manager acceptance, candidate response, candidate satisfaction, interview conversion, offer acceptance, override rate, escalation rate, workflow completion, factual error rate and recruiter hours saved.

**What is an unacceptable error?**

Fabricating candidate evidence, discriminatory/proxy reasoning, sending unauthorized messages/offers, rejecting contrary to policy, exposing one tenant's data to another, failing to honor withdrawal/deletion, or impersonating a human.

**How should prompts/models be regression-tested?**

Version every prompt/skill/model combination, replay golden datasets, shadow new versions, compare outputs and action traces, and block deployment on critical regressions. Anthropic's 2026 eval guidance emphasizes systematic agent evaluation before failures reach production. [S21]

**What should override rate tell us?**

High override may indicate bad AI, poor Role Packets or unstable manager criteria. Low override is not automatically good because users may rubber-stamp. Pair override with downstream outcomes.

FOUNDER DECISION: Every major agent capability ships with evals, traces and release gates. Optimize for consequential error reduction, not demo fluency.

# 30. Failure + Recovery

**Objective: **Assume tools, models and humans will fail, then design graceful recovery.

**What happens when AI makes a bad decision?**

Pause downstream consequential actions, preserve the trace, notify the accountable user when material, allow reversal, record reason, and add the case to evaluation review.

**What happens when an integration fails?**

Retry with backoff when safe, maintain idempotency, switch to a fallback channel where permitted, surface a concise action only if human intervention is required, and never silently drop candidate communication.

**What happens when a candidate does not respond?**

Use channel-appropriate follow-up cadence, then mark dormant without punitive assumptions. Keep them available for future rediscovery when lawful.

**What happens when requirements change mid-search?**

Version the Role Packet, show impact on existing candidates, ask whether to re-evaluate the pipeline, preserve old decisions for audit, and communicate changes to affected workflows.

**What happens when model is uncertain?**

Do not force a confident answer. Label uncertainty, ask a targeted question, seek additional evidence or escalate.

**How should workflows pause/resume?**

Durable checkpoint at each state transition with explicit waiting states for external response, approval or human takeover.

**What should retry versus escalate?**

Retry transient network/provider failures. Escalate repeated failures, policy conflicts, missing credentials, unexpected schema changes and consequential uncertainty.

**How should customers see failures?**

Only meaningful exceptions on Today. A deep operations console should exist for recruiter/admin/support users.

FOUNDER DECISION: No silent failures. Every workflow has recovery semantics, replayable state, and a clear human escalation path.

# 31. North Star + The Dream

**Objective: **Define the durable company thesis.

**If this company could only be famous for one thing, what would it be?**

Making world-class recruiting capability available to companies that could never justify building a world-class recruiting department.

**What is the biggest recruiting problem nobody has truly solved?**

End-to-end accountability. Companies have tools for pieces of recruiting, but someone still has to hold the whole search in their head, chase everyone, interpret the market, manage candidate trust and make judgment calls.

**What would make an owner comfortable handing recruiting to AI?**

Visibility, control, evidence, permission settings, predictable escalation, strong candidate experience, and a real human who can step in.

**What would make a recruiter trust the AI?**

It shows its work, recognizes uncertainty, makes corrections easy, remembers calibration, does not create cleanup, and never pretends to know what it cannot know.

**What would make a candidate trust the AI?**

Clear disclosure, respect, rapid communication, no creepy inference, a reasonable explanation of process, and access to a person.

**What should AI do that existing recruiting software does not?**

Continuously run the function: challenge the intake, execute the plan, recognize workflow risk, collect missing evidence, keep people moving, adapt to feedback, pre-close candidates, and ask for human help before a problem becomes a loss.

**What should AI never do?**

Dehumanize candidates, make discriminatory/proxy judgments, fabricate evidence, hide consequential reasoning, impersonate a human, or optimize speed at the expense of fairness and trust.

**What ITS expertise could become a moat?**

Recruiter judgment encoded into structured playbooks, correction data, market calibration, closing behavior, vertical networks and real-world exception handling.

**If competitors copied every feature, what would they still not have?**

The accumulated operating memory of how expert recruiters and thousands of hiring teams resolve ambiguity, plus the human network that can act on that memory.

**Complete this sentence: We are going to win because **____**.**

We are going to win because we will turn elite recruiting judgment into a trusted operating system that does the work, learns from real outcomes, and gives every growing company access to human expertise exactly when it matters.

FOUNDER DECISION: North star: successful hires with minimal customer effort and a candidate experience people trust. The long-term category is the recruiting department as a software-enabled service.

# Non-negotiable product blueprint

The following should be treated as cross-cutting constraints across every build decision. They are intentionally stricter than a normal MVP checklist because the product is handling consequential employment workflows.

**1. Outcome model: **Every role has success outcomes, evidence criteria, tradeables, disqualifiers, market constraints and an interview plan before candidate ranking begins.

**2. Evidence model: **Every candidate recommendation points to evidence and distinguishes absence of evidence from negative evidence.

**3. Policy engine: **Every action is governed as Auto, Auto + Notify, Approval Required or Human Only, with jurisdiction and role overrides.

**4. Durable workflows: **Long-running work survives restarts, provider failures, human delays and time-zone/calendar changes.

**5. Auditability: **Every AI recommendation and action records model/prompt/skill version, inputs, evidence, policy, tool calls, output, user overrides and final outcome.

**6. Human takeover: **A recruiter can take over a workflow without losing context or creating a parallel shadow process.

**7. Candidate portal: **Candidates have status, scheduling, communication preference, withdrawal and privacy controls in a mobile-first experience.

**8. Failure recovery: **No silent failures and no lost candidate communications.

**9. Model abstraction: **The domain layer never assumes one LLM vendor.

**10. Evaluation system: **Golden cases, regression tests and critical safety gates are required before agent behavior changes.

**11. Data governance: **Provenance, tenant isolation, retention and consent are data-model concerns, not post-launch compliance projects.

**12. Progressive disclosure UX: **Owner mode is simple by default; recruiter/admin complexity is available when needed.

**13. Service economics: **Human interventions are metered internally, reason-coded and visible in contribution-margin analytics.

**14. Learning safety: **Human corrections become tenant memory first. Global learning requires evaluation and curation.

**15. No fake completeness: **If an integration is not real, the product must label it. Do not simulate successful external actions in production.

# North-star and operating metrics

- Primary north star: Successful hires per customer with low customer effort and strong candidate experience.
- Time to qualified slate.
- Time to first interview and time to fill.
- Owner/hiring-manager minutes required per active role per week.
- Recruiter human minutes per active role.
- Qualified slate acceptance rate.
- Candidate application completion and stage drop-off.
- Candidate response rate and cNPS / experience score.
- Offer acceptance rate and offer-loss reasons.
- AI override rate, segmented by decision type and downstream outcome.
- Human escalation rate and escalation resolution time.
- Workflow failure and recovery rate.
- Evidence factual-error and hallucination rate.
- Autonomous action success rate by action type.
- Gross margin and contribution margin by customer/tier/workflow.
- 90-day and 12-month retention/quality-of-hire proxies when customers provide them.

# Research appendix

This strategy prioritizes recent primary or high-authority sources. Vendor sources are used primarily to document current competitive capabilities, not to validate their marketing claims.

ID

Source

Why it matters

URL

S1

Greenhouse, The Hire Standard: Hiring benchmarks 2026  
March 2026

Analyzed 6,000+ companies and 640M+ applications. Reports large growth in applications per recruiter, fewer recruiters per organization, and longer time to fill.

https://www.greenhouse.com/recruiting-benchmarks

S2

SHRM, 2026 Talent Trends  
April 20, 2026

2,000+ HR professionals; nearly 70% report challenges recruiting for full-time positions.

https://www.shrm.org/topics-tools/research/2026-talent-trends

S3

SHRM, Recruiting Executives Priorities and Perspectives 2026  
2026

Highlights critical-talent sourcing, AI/automation and candidate experience as executive priorities.

https://www.shrm.org/topics-tools/research/recruiting-executives-priorities-perspectives-2026

S4

Deloitte, 2025 Talent Acquisition Technology Trends  
May 13, 2025

Defines shift from AI-assisted to AI-augmented and AI-powered agentic recruiting across the end-to-end process.

https://www.deloitte.com/us/en/services/consulting/blogs/human-capital/ai-in-talent-acquisition.html

S5

McKinsey, HR Monitor 2026  
June 8, 2026

Describes emerging agentic HR operating models, fragmented tech, and need for unified data backbone and workflow redesign.

https://www.mckinsey.com/capabilities/people-and-organization/our-insights/hr-monitor

S6

Gem, All-in-One / ATS product pages  
Current 2026

Documents current integrated sourcing, ATS, application review, scheduling, analytics and offers.

https://www.gem.com/solutions/all-in-one

S7

Workable, product and Workable Agent pages  
Current 2026

Documents agentic sourcing, screening, candidate chat and routing embedded in a full ATS.

https://www.workable.com/

S8

Juicebox, AI recruiting and agent pages  
Current 2026

Documents sourcing agents, 800M+ profile search, outreach, continuous search and conversational calibration.

https://juicebox.ai/ai-recruiting

S9

HireVue, AI Interviewer launch  
June 18, 2026

Documents voice-based AI interviewing positioned around validated hiring science and enterprise governance.

https://www.hirevue.com/press-release/hirevue-launches-ai-interviewer

S10

BCG, How AI Is Changing Recruitment  
January 15, 2025

CHRO research and guidance on candidate-first design, human oversight, transparency and regulation.

https://www.bcg.com/publications/2025/ai-changing-recruitment

S11

Glassdoor, Candidate Experience Guide for Employers  
June 25, 2026

Emphasizes frictionless applications, structured interviews, transparent communication and visible AI disclosure.

https://www.glassdoor.com/blog/a-guide-to-the-ultimate-candidate-experience/

S12

Glassdoor, AI Has Not Killed the Online Job Application Yet  
January 12, 2026

Reports online applications still drive most interviews/offers while recruiter-sourced candidates increased materially since 2023.

https://www.glassdoor.com/blog/ai-has-not-killed-online-job-applications/

S13

Indeed Hiring Lab, AI Adoption Is Accelerating but Still Concentrated Among the Largest Firms  
January 16, 2026

Shows uneven AI adoption and comparatively slower diffusion among smaller firms.

https://hiringlab.indeed.com/2026/01/16/ai-adoption-accelerating-still-concentrated-among-largest-firms/

S14

NYC Department of Consumer and Worker Protection, Automated Employment Decision Tools  
Current

Bias audit, public summary and notice requirements for covered AEDT use.

https://www.nyc.gov/site/dca/about/automated-employment-decision-tools.page

S15

California Civil Rights Department, Employment Regulations Regarding Automated-Decision Systems  
Effective October 1, 2025; related modifications effective 2026

Makes clear that discriminatory use of automated decision systems in employment is covered under state civil-rights rules.

https://calcivilrights.ca.gov/civilrightscouncil/rulemaking-actions/

S16

Colorado Attorney General, Automated Decision-Making Technology Rulemaking  
Current 2026

Revised ADMT law signed May 2026, effective January 1, 2027, with developer/deployer obligations for consequential decisions.

https://coag.gov/ai/

S17

European Union, AI Act Regulation (EU) 2024/1689  
Current consolidated text

Recruitment and selection AI is classified as high-risk.

https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32024R1689

S18

Workable Pricing  
Current 2026

Public SMB pricing and usage-based Workable Agent AI credits provide a useful competitive/economic benchmark.

https://www.workable.com/pricing

S19

Ashby Pricing  
Current 2026

Public startup all-in-one plan at $400/month up to 100 employees provides a useful price anchor.

https://www.ashbyhq.com/pricing

S20

NIST, AI Risk Management Framework and Generative AI Profile  
2023-2026

Framework for governance, mapping, measurement and management of AI risk; useful foundation for product controls and evaluation.

https://www.nist.gov/itl/ai-risk-management-framework

S21

Anthropic, Demystifying Evals for AI Agents  
January 9, 2026

Argues for rigorous evaluation of multi-step agents to catch behavioral failures before production.

https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents

S22

Anthropic, Trustworthy Agents in Practice  
April 9, 2026

Highlights human control, transparency, security and privacy as core principles for autonomous agents.

https://www.anthropic.com/research/trustworthy-agents

S23

LinkedIn, Future of Recruiting 2025  
2025

TA research showing growing GenAI adoption, with efficiency benefits alongside privacy, accuracy and legal/compliance concerns.

https://business.linkedin.com/hire/resources/future-of-recruiting

S24

PwC, 2026 Global AI Jobs Barometer  
June 15, 2026

Analyzes 1B+ job ads and finds increasing value of judgment, leadership and other human-intensive skills in AI-exposed work.

https://www.pwc.com/gx/en/1/services/ai/ai-jobs-barometer.html

S25

World Economic Forum, Future of Jobs Report 2025  
January 7, 2025

Survey of 1,000+ employers representing 14M+ workers on changing jobs and skills through 2030.

https://www.weforum.org/publications/the-future-of-jobs-report-2025/

**Research caution: **Vendor performance claims should be treated as directional until independently validated. Legal requirements change quickly and this document is product strategy, not legal advice. Before launch, counsel should map the product's exact use cases against each jurisdiction and customer deployment model.

# Claude handoff prompt

Use this document as the current strategic context for the AI Recruiting Operating System. Preserve the core thesis, product layers, evidence model, policy engine, candidate experience, human escalation model, architecture principles, security/compliance requirements and business model. When making product decisions, explicitly identify any conflict with this context. Do not simplify by silently removing critical capabilities. Sequence them. Build the complete architecture, then implement production-quality vertical slices with tests, observability, auditability, real integrations and evaluation gates.
