# 01. Product thesis (locked)

> Governing context since 14 September 2026: `docs/FOUNDER-CONTEXT.md` (the consultant-completed founder intake). Where this document and the intake differ, the intake wins; `docs/17-founder-context-reconciliation.md` lists every difference and what was done about it.

## The thesis

We are building **a recruiting department for companies too small to have one.**

- The customer should feel like they hired a recruiting team.
- The software performs the repetitive work.
- The AI performs analysis, coordination, communication, and recommendations.
- The customer makes the important hiring decisions.
- A real recruiter is one click away.
- The product is not primarily an ATS. The ATS is the system of record underneath the AI recruiting operating system.

## What the customer experiences

Tell us who you need. We run the process.

The founder says: "I need a performance marketing manager in Los Angeles. $95,000 to $115,000. Hybrid, three days in the office." The system asks what it needs to know, produces a Role Packet, the founder approves it, and from that moment the system posts, distributes, acknowledges, assesses, screens, schedules, prepares interviewers, captures scores, runs the debrief, drafts the offer, and hands the hire into payroll, pausing for the founder only at the decisions that are theirs: the role, who to interview, who to hire, what to pay, and what to send.

When the owner needs a person: one click, and an ITS recruiter has every piece of context.

## The two sentences the product must earn

"I don't need a recruiter. I have this."

"I can get a real recruiter immediately."

## Non-negotiables

1. **Evidence, not scores.** Every candidate assessment shows strengths, concerns, unknowns, confidence, and the source of each claim. A number may exist as a secondary tool. No black box ever determines an outcome.
2. **Humans decide.** Rejection on AI judgment, hiring, compensation, offer terms, and negotiation are human decisions. The policy engine enforces it; the audit log proves it.
3. **The AI never pretends to be a person.** Every candidate touch is disclosed. A human alternative is always offered.
4. **Nothing autonomous without a recovery path.** Every workflow has a failure state, retry logic, escalation, and human takeover.
5. **Simple for the owner.** A conversation plus five views. No recruiting vocabulary required.
6. **Powerful for the recruiter.** The same system, with the advanced views a professional needs, so ITS runs its own business on it from day one.
7. **Compliance and security by design.** Disclosure, consent, retention, explainability, tenant isolation, and audit are architecture, not documents.
8. **Own the outcome loop.** Every hire's 30/60/90-day outcome flows back into the system. That data, the vertical playbooks, and the human layer are the moat.

## The three business modes on one platform

| Mode | Who operates | What ITS provides | How it is priced |
|---|---|---|---|
| Software | The customer | The platform and "Ask a recruiter" within a fair-use quota | Subscription plus usage |
| Software + Recruiter | The customer, with a named recruiter reviewing and intervening | Recruiter review, escalation handling, negotiation support | Subscription plus retainer or hourly |
| Full service | An ITS recruiter, in Recruiter Mode | The whole workflow, run on the same software | Per role or per hire, on top of the subscription |

ITS is the first customer and the first services operator. Every feature is built to be used professionally by ITS recruiters and simply by owners, on the same objects and the same API.

## Ideal customer and first verticals

US companies with 25 to 250 employees hiring 10 to 75 people a year, where recruiting is split across managers, HR and agencies (docs/FOUNDER-CONTEXT.md §05). Go to market vertically, build horizontally (§06): the launch wedge is consumer and beauty brands, retail and e-commerce, creative and marketing agencies, and selected tech-enabled services, where ITS has credibility. The `consumer` playbook ships as the default. Highly regulated clinical hiring is a later vertical; the dental playbook built in Slice 1 stays as a later vertical and as the licensing-heavy test path.

## Pricing (data, not code)

Three tiers of autonomy and service (§20): Core $499/month, Growth $899/month, Company $1,499/month, annual discounts, usage entitlements for text screens, voice minutes, sourcing contacts and recruiter asks; plus Software + Recruiter and Managed Recruiting tiers priced as retainers. Plans live in `packages/db/src/seed.ts`; the product checks entitlements, never plan names.

## Working name

The repository is `recruiting-os`. The product name is a marketing decision not made here; the code uses the neutral prefix `@ros/`.
