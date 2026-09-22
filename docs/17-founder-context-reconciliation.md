# 17. Founder context: reconciliation and what changed

The consultant-completed founder intake (`docs/FOUNDER-CONTEXT.md`, 14 September 2026) is now the governing strategic context. Its own instruction: treat each Founder Decision as the working default, identify conflicts explicitly, never remove capability silently, sequence instead. This document does that against the strategy memo (docs/00 to 16) and the code as of Slice 2.

Legend: **Adopted now** (changed in this pass), **Already true** (the build matches), **Sequenced** (adopted, delivered in the slice named), **Diverges** (kept as built, with the reason; the founder can overrule).

## Section by section

| # | Founder decision | Where we were | Action |
|---|---|---|---|
| 01 | Build an AI recruiting department for companies too small to have one; the product owns outcomes | Same thesis (docs/01) | Already true |
| 02 | Automate administration aggressively, augment judgment transparently, human accountability for consequential decisions | Policy engine with four levels and hard human-only set; AI never rejects on judgment | Already true |
| 03 | ITS judgment as product primitives: Role Packet, evidence model, calibration memory, close plan, escalation rules, vertical playbooks | Role Packet, evidence model, escalation, playbooks exist; calibration memory and close plan do not | Sequenced: calibration memory (role-specific preference updates from advance/reject reasons) in Slice 3; close plan with the Offer agent in Slice 4 |
| 04 | Compete on accountable autonomy; benchmark Workable and Gem continuously | docs/00 names Workable closest, Gem the strategic threat | Already true; added Gem and Ashby to the benchmark list in docs/00 §I |
| 05 | ICP: 25 to 250 employees, 10 to 75 hires a year, fragmented recruiting across managers, HR and agencies | 10 to 150 employees, owner-operated | **Adopted now**: docs/01 and the company size bands; the trial and Core plans assume up to 250 employees |
| 06 | Vertical-first go-to-market, horizontal architecture; wedge = consumer/beauty/e-commerce, creative/marketing, selected tech-enabled; avoid regulated clinical hiring first | First vertical was dental (a licensed clinical role) | **Adopted now**: new `consumer` playbook (performance marketing, e-commerce, social and content, customer success, sales, operations) is the default; company setup leads with the wedge verticals; the dental playbook stays as a later vertical and as the licensing-heavy test path |
| 07 | Own the whole state machine including calibration, relationship management, offer risk and post-search learning | 25-state machine, withdrawal, inactivity, talent pool exist; calibration and offer-risk are later slices | Sequenced: Slices 3 and 4 |
| 08 | Five layers; UI is an outcome cockpit; "Today" answers four questions | Same five layers; Home brief answers "what needs you" | **Adopted now**: Home renamed Today; the summary line answers all four questions (needs attention, best people, at risk, done automatically) |
| 09 | One assistant personality, modular capabilities, typed events not free-form agent chat | Same (docs/05); assistant surfaced as "recruiting assistant" | **Adopted now**: the assistant is presented as the recruiting chief of staff |
| 10 | Evidence before score; Strong / Potential / Weak / Insufficient Evidence; confidence in words; no black-box ranking; exclusion view with "review anyway" | Same categories with "unknown" labeled "Not enough to say"; secondary score optional; ineligible holds visible with override | **Adopted now**: label "Insufficient evidence"; evidence items carry optional confidence and context; a "Review anyway" path reopens an application declined on an eligibility rule |
| 11 | Human escalation is a core trust layer; "Bring in a recruiter" at role and candidate level; every action labeled system / policy / human | Ask a recruiter on every surface with a full context snapshot; actors on every event | **Adopted now**: button wording "Bring in a recruiter"; takeover mode is Slice 6 |
| 12 | Candidate experience is a product: mobile portal, disclosure, low friction, proactive status, easy human access, one-click withdrawal and preference controls | Status page, disclosure, HUMAN, no-resume path exist; withdrawal by email only | **Adopted now**: one-click withdrawal and a text-message preference on the status page; self-scheduling arrives in Slice 3 |
| 13 | Calm, capable, personal, transparent, fast; design around attention | Same principles (docs/07) | Already true |
| 14 | Primary navigation Today, Roles, Talent, Interviews, Offers, Insights | Home, Roles, People, Setup | **Adopted now** for the built views (Today, Roles, Talent, Setup); Interviews, Offers and Insights appear with Slices 3, 4 and 9 rather than as empty menu items |
| 15 | Owner cockpit and recruiter-grade depth in one product | Owner views built; Recruiter Mode is a queue only | Sequenced: pipeline table and candidate workspace in Slice 3; interviews, offers, analytics with their slices |
| 16 | Brand the category around recruiting capacity and outcomes; AI is the engine, not the identity | Copy already leads with the work done | Already true; docs/07 voice section updated |
| 17 | Naming sprint later; nothing final | Working name "Recruiting OS", neutral `@ros/` prefix | Already true |
| 18 | One personality: concise for employers, warmer for candidates; banned words list | Copy audited: none of the banned words appear | Already true; the banned list is now in docs/07 |
| 19 | Premium, restrained, human; neutral base, one electric accent, one warm tone; avoid HR teal-only and purple gradients | Deep green accent plus warm secondary | **Adopted now**: accent moved to an electric cobalt in both themes and on candidate pages; warm tone kept for "needs you" |
| 20 | Core $499, Growth $899, Company $1,499+; three modes (I run it, we help, we run it) | Starter $249, Growth $549, Pro $1,099 | **Adopted now** in the plans seed (pricing is data); the three modes were already in docs/01 |
| 21 | Track contribution margin by workflow and customer; never hide labor or data costs | AI cost per run tracked; recruiter time not yet metered | Sequenced: recruiter time and per-workflow cost roll-ups with billing in Slice 4/5 |
| 22 | Provenance, consent, retention, tenant boundaries in the schema | Consent records, RLS, retention classes, provenance on packets and assessments | Already true; deletion workflows are Slice 5 |
| 23 | Learning is staged: tenant memory then evaluated pattern then curated playbook; bad decisions flagged with a taxonomy | Overrides are events; no flag control | **Adopted now**: "Something wrong?" flag on every assessment with the intake's taxonomy, stored against the AI run |
| 24 | TypeScript, Postgres, object storage, vector layer, durable workflow engine (Temporal suggested), model gateway | TypeScript, Postgres with pgvector, own durable engine, Hono API, Vite/React web | Diverges on two tools, not on principles: the own engine (2 tables, leases, waits, retries, escalation) keeps the stack to one runtime and one database at this size; Temporal remains the documented migration path in docs/03 if scale demands it. Vite/React instead of Next.js because the app is a signed-in SPA and the candidate pages are server-rendered by the API |
| 25 | Google and Microsoft email/calendar first; Gusto and Rippling then BambooHR; Indeed and LinkedIn; adapters everywhere | Calendar in Slice 3; BambooHR first because its API key path needs no partner program | Sequenced: calendar in Slice 3; docs/15 reorders HRIS to Gusto and Rippling (partner programs applied for) with BambooHR as the first live path until they approve |
| 26 | Compliance is architecture; autonomy matrix; regional overrides; audit of every AI action | Same (docs/08), notice registry, jurisdiction resolver | Already true; regional policy overrides (a jurisdiction forcing a level) are Slice 3 |
| 27 | MVP = one complete production search; the perfect workflow starts "I need a performance marketing manager" | Slices 1 and 2 deliver intake through screening for a dental hygienist | **Adopted now**: a second end-to-end scenario, a 60-person beauty brand hiring a performance marketing manager, runs on the consumer playbook; Slices 3 and 4 complete the loop |
| 28 | Sourcing arrives immediately after inbound is reliable; playbooks exposed in V2 | Sourcing was a year-2 item (docs/09) | Sequenced earlier: rediscovery from the own pool right after Slice 3, external sourcing behind a provider interface after Slice 5; docs/09 updated |
| 29 | Every capability ships with evals, traces and release gates | Seven eval suites, thresholds, ai_runs traces | Already true; golden cases from the intake list added to the backlog in docs/11 |
| 30 | No silent failures; replayable state; clear escalation | Engine retries, escalation on final failure, admin console | Already true |
| 31 | North star: successful hires with minimal customer effort and trusted candidate experience | docs/02 metrics | Already true; the intake's metric list replaces docs/02 §Success metrics |

## Non-negotiable blueprint

| Blueprint item | Status |
|---|---|
| 1 Outcome model before ranking | Already true (Role Packet must be approved before any applicant is assessed) |
| 2 Evidence model distinguishing absence from negative | Already true (`unknown` vs `no`; unverifiable answers never fail) |
| 3 Policy engine with four levels, role overrides | Already true; jurisdiction overrides in Slice 3 |
| 4 Durable workflows | Already true |
| 5 Auditability of every AI action | Already true (`ai_runs` with prompt version and hash, policy decision, override, outcome) |
| 6 Human takeover without a shadow process | Slice 6 |
| 7 Candidate portal with status, scheduling, preferences, withdrawal, privacy | Status, preferences and withdrawal now; scheduling in Slice 3 |
| 8 No silent failures, no lost communications | Already true |
| 9 Model abstraction | Already true |
| 10 Evaluation gates | Already true |
| 11 Data governance in the schema | Already true |
| 12 Progressive disclosure | Already true |
| 13 Service economics metered | Slice 4/5 |
| 14 Learning safety | Adopted: corrections are tenant events; nothing retrains globally |
| 15 No fake completeness | Already true (adapters report their real status; the fake AI is refused in production) |

## What changed in this pass

- New `consumer` playbook and vertical list; company setup defaults to the wedge.
- Plans: Trial, Core $499, Growth $899, Company $1,499 (annual discounts), with usage entitlements scaled accordingly.
- Navigation and copy: Today, Roles, Talent, Setup; "Bring in a recruiter"; "recruiting chief of staff"; "Insufficient evidence".
- Today's summary answers the four questions; the palette uses an electric accent.
- Evidence items may carry confidence and context; assessments can be flagged with a reason taxonomy.
- Candidates can withdraw and change text-message preferences from the status page; owners can "review anyway" an application declined on an eligibility rule, and overriding an eligibility hold needs a stated reason.
- A second scenario test covers the intake's own "perfect workflow" (performance marketing manager at a beauty brand).
- Roadmap resequenced: rediscovery and sourcing earlier, HRIS order Gusto/Rippling/BambooHR.

## Deliberate divergences to confirm with the founder

1. Own workflow engine and Hono/Vite instead of Temporal and Next.js (section 24). Reason: fewer moving parts for a four-person team; the engine has migration room. Cost of reversing later: moderate; workflow definitions are plain step functions.
2. BambooHR as the first live HRIS path while Gusto and Rippling partner approvals are pending (section 25). Reason: BambooHR works with a customer API key today; the others require partner programs.
3. Dental playbook retained (section 06). Reason: it is built, exercises licensing-based eligibility rules the consumer vertical does not, and remains a later vertical. It is no longer the default.
