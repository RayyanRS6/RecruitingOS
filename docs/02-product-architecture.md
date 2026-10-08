# 02. Product architecture

## The five layers

| Layer | Purpose | Owns | Lives in |
|---|---|---|---|
| **1. Hiring Intelligence** | Judgment: what to hire for, how to evaluate, who fits, what to offer | Intake and calibration, job description, compensation intelligence, hiring plan, competencies, scorecards, candidate assessment, decision support, vertical playbooks | `packages/agents`, `packages/ai`, `packages/playbooks` |
| **2. Recruiting Automation** | Doing: the repetitive work, reliably, with recovery paths | Posting and distribution, applicant capture (web, email-in, integrations), acknowledgment, screening, SMS and email, scheduling, interview coordination, follow-up, offers, preboarding, HRIS handoff | `packages/workflows`, `packages/integrations` |
| **3. System of Record** | Truth: every object, every version, every event | Company, users, roles, role packets (versioned), candidates, applications, interviews, scorecards, communications, offers, onboarding, events, audit records, policies, integrations, entitlements | `packages/db`, `packages/core` |
| **4. Human Recruiting** | Accountability: a person when judgment or intervention is needed | Ask a recruiter, recruiter review, takeover, candidate escalation, negotiation, difficult-search support | `packages/core` (escalations), Recruiter Mode in `apps/web` |
| **5. Workforce Intelligence** | Learning: outcomes, benchmarks, vertical intelligence | Hiring and compensation benchmarks, conversion, time-to-fill, source and interview effectiveness, quality of hire, 30/60/90-day outcomes, vertical intelligence | `packages/analytics` (later), the event log and outcome records from day one |

Layers 1, 2, and 4 act on layer 3 through one policy engine. Layer 5 reads layer 3. Nothing in layers 1, 2, or 4 keeps state that is not in layer 3.

## The Role Packet

The Role Packet is the central object. Every agent and workflow reads it; nothing writes it except the Intake agent (as a proposal) and a human (as an approval or edit). It is **versioned and append-only**: any change creates a new version with an author, a reason, and a diff; prior versions are preserved; applications record which packet version evaluated them.

```
RolePacket (version n of Role r)
  identity:       title, department, location(s), employment type, schedule, remote policy
  business:       reason for hire (new / replacement / growth), urgency, target start, hiring timeline
  compensation:   range (min/mid/max), basis (hourly/salary), bonus, benefits summary, guidance source(s)
  description:    public job description, internal notes
  requirements:   must-haves[], nice-to-haves[], eligibility[] (each with type, text, rationale)
  competencies:   [{name, definition, weight, evaluated_in: screen|interview|both, indicators[]}]
  evaluation:     assessment criteria, scoring rubric, red flags (behavioral, never protected-class proxies)
  screening:      knockout rules[] (eligibility only, owner-authored), screening questions[] with model answers
  interviews:     plan[] ({round, purpose, duration, interviewers[], competencies[], format}), scorecard template
  communication:  tone, company blurb, what candidates may be told about pay and process, disclosure texts
  approvals:      who approves packet, interview advance, offer; approval rules
  compliance:     applicable notices (by state), retention class, recording policy, consent requirements
  sourcing:       strategy, channels[], target sources, budget, referral prompt, rediscovery on/off
  preferences:    hiring manager preferences (scheduling windows, interview style, deal-breakers stated in their words)
  provenance:     playbook id and version used, model runs that proposed each section, human edits
```

The packet has a JSON Schema (`packages/contracts/src/domain/role-packet.ts`) that the AI provider must satisfy and the UI renders section by section. See doc 04 for storage.

## Two modes, one system

**Owner / Hiring Manager Mode.** A conversation and five views (Home, Roles, People, Calendar, Setup). Decisions are cards: approve the role, interview these five, hire this person, send this offer. No pipeline vocabulary; stages are described in plain language ("waiting on you," "being screened," "interviewing," "deciding," "offer out"). Every decision card has "Ask a recruiter."

**Recruiter Mode.** The same objects, plus: pipeline table with stage columns and bulk actions; candidate search across the tenant's pool; full scorecards and rubric editing; sequences and communication controls; workflow controls (pause, retry, override); takeover; multi-client switching for ITS recruiters. Recruiter Mode is a permission set and a set of additional routes, not a second application.

## Recruiter on Demand

**Ask a recruiter** exists on every decision surface (role approval, candidate review, debrief, offer, stuck role, any conversation). Activation creates a `RecruiterEscalation` with a snapshot of the complete context: company, role and packet version, candidate(s), resume, assessment, screen transcript, interview history, compensation, communication history, customer preferences, and the audit history. The recruiter opens one page and never asks "what is this role."

**Takeover** switches a role (or a candidate) to human-operated: AI autonomy pauses for actions at "auto" and "auto + notify" (they become "approval required" with the recruiter as approver), the recruiter becomes the active operator, AI remains available as an assistant (drafts, summaries), and every action is logged with the recruiter as actor. Handback restores the role's prior policies.

## The candidate experience layer

Candidates are users. Their surface is mobile-first and served by the API application (server-rendered, no login required beyond a signed link):

- Careers page and job page with Google Jobs markup; apply with a three-minute form, then a short written conversation with the company's AI assistant: in the same visit on pilot roles ITS switches on, by email afterwards otherwise; resume upload or "no resume, answer four questions."
- AI disclosure at first touch and on every automated message; a human alternative ("reply HUMAN" or a link).
- Consent capture: application terms, SMS opt-in (separate, unchecked by default), recording consent when applicable, state-specific AI notices.
- Preferences: SMS and email opt-out, contact windows.
- Screening by text or web chat with progress and the ability to pause and resume.
- Scheduling by tapping a slot; reschedule and cancel links; interview information and preparation (who they will meet, format, what to bring, the case prompt).
- Status page: where they are, what happens next, a realistic timeline.
- Withdrawal in one tap, with an optional reason.
- Privacy: access, deletion, and correction requests routed to the tenant's compliance queue; retention notice.
- Offer experience: the letter, questions, e-signature, and a countdown to start.
- Onboarding handoff: what the HRIS will ask them for, first-day details.

The AI never pretends to be a person. Messages are signed "the hiring team at {company}, assisted by an AI recruiter" or equivalent, per policy.

## Admin platform

An internal console for ITS operators (route group `/admin`, permission `platform_admin`): customers, roles, candidates, active and failed workflows, AI runs, escalations, API failures, candidate complaints, costs (tokens, voice minutes, SMS), customer activity, churn signals, support issues. Any workflow and any AI run can be inspected to answer: what did the AI see (input reference and prompt version), what did it conclude (structured output), why (rationale and evidence), what policy applied, what did the human do, and what action occurred (the resulting events).

## Vertical playbooks

A playbook is one versioned JSON document per vertical (`packages/playbooks/`): typical roles, licenses and eligibility by state, common qualifications, compensation ranges by role and metro with sources, screening questions, interview plans, red flags, candidate objections and answers, hiring benchmarks, recommended channels. Intake uses the matching playbook as the starting point; the role packet records which playbook and version it used; customers override on the packet, never on the playbook. Playbooks are authored by ITS recruiters and reviewed in the eval suite.

## Billing and entitlements

Pricing is data, not code. `plans` define named limits (active roles, text screens, voice minutes, sourcing credits, recruiter asks, seats) and prices; `entitlements` per company are computed from the plan plus add-ons and credits; the product checks an entitlement (`can(company, 'voice_minutes', 10)`), never a plan name. Usage is metered as events. Stripe (or equivalent) is an integration; trials, upgrades, downgrades, credits, and limits are entitlement operations. Recruiter services are line items attached to escalations and takeovers.

## Learning and data governance

The platform learns from human overrides, recruiter decisions, hiring-manager decisions, candidate responses and withdrawals, interview outcomes, offers and acceptances, and 30/60/90-day outcomes. Governance:

- Customer data is never used to train a foundation model.
- Learning happens through (a) evaluation sets built from anonymized, consented, de-identified records; (b) per-vertical defaults (playbook updates) derived from aggregate statistics with minimum cohort sizes; (c) per-tenant preference learning that stays inside the tenant.
- Every derived dataset records its provenance and the consent basis.
- Candidates can request deletion; derived aggregates are non-reversible and documented as such.

## Success metrics

North star: **time and effort required for the customer to make a successful hire** (owner hours per hire and days from intake to accepted offer, conditioned on 90-day retention).

Tracked from the event log: time from intake to posting; time to first candidate contact; applicant acknowledgment time; screen completion; interview conversion; interview-to-offer; offer acceptance; time to fill; owner hours per hire (from decision events and conversation time); recruiter hours per hire; candidates per hire; candidate drop-off by stage; candidate satisfaction (one-question survey); human escalation rate; AI override rate; workflow failure rate; cost per hire and per role; customer retention and expansion; Recruiter on Demand utilization.

## Customer success mechanisms

Part of the orchestrator, not a separate tool. Detectors run on the event log: role stuck (no owner action for N days with candidates waiting), owner has not reviewed candidates, candidates waiting on a decision, interviews not scored within 24 hours, offer waiting on approval, candidate has not responded to a screen invite, hiring manager has not completed a scorecard. Each detector has an intervention ladder: brief line → direct message with a one-tap action ("Schedule them?") → escalation offer ("Want an ITS recruiter to review this role?") → escalation created. Thresholds are policies.


## North-star and operating metrics (from the founder context, 14 September 2026)

Primary north star: successful hires per customer with low customer effort and a strong candidate experience. Operating metrics: time to qualified slate; time to first interview and time to fill; owner and hiring-manager minutes per active role per week; recruiter minutes per active role; qualified-slate acceptance rate; application completion and stage drop-off; candidate response rate and experience score; offer acceptance and loss reasons; AI override rate by decision type and downstream outcome; escalation rate and resolution time; workflow failure and recovery rate; evidence factual-error and hallucination rate; autonomous action success rate by action type; gross and contribution margin by customer, tier and workflow; 90-day and 12-month retention and quality-of-hire proxies.
