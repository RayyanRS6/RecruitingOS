# 01. MVP product requirements document (release 1)

Status: draft for founder approval, 14 September 2026. Governing inputs: the founder's release-1 instruction (14 Sep 2026), `docs/FOUNDER-CONTEXT.md`, `docs/01-product-thesis.md`. Open items are tracked in `00-decisions-and-risks.md` and referenced as D-numbers, S-numbers, C-numbers.

## 1. Goal

Run one complete hiring workflow in production for three to five design partners in the consumer, beauty, e-commerce, creative and marketing wedge, with ITS recruiters as the human backstop: a hiring manager describes a role, approves a Role Packet, the role goes live on a hosted job page, applicants are acknowledged, assessed with evidence, screened by text, reviewed by a person, approved for interview by a person, scheduled against real calendars, and the whole history is auditable. An ITS recruiter is one click away at every step.

Release 1 is judged a success when each design partner has taken at least one real role from intake to a completed interview inside the product, with no lost candidate communication, no unlabeled simulated action, and every AI action traceable to its evidence, prompt version, and policy.

## 2. Scope

### In scope (the thirteen steps named by the founder)

1. Company signup and team setup
2. Role intake (conversation) producing a Role Packet
3. Role Packet approval (human)
4. Hosted job page (careers page, job page, Google for Jobs markup) and the email-in intake address
5. Secure candidate application (web form; forwarded email)
6. Evidence-based AI assessment (extraction, eligibility, assessment)
7. Human review (Talent view, application detail, actions, flags, exclusion view with "review anyway")
8. Screening invitation (policy-gated, "do it and tell me")
9. Candidate screening (web chat; SMS when enabled, D6) with a scorecard
10. Human interview approval (owner or hiring manager approves the round and the interviewers)
11. Calendar scheduling (interviewer availability from Google or Microsoft calendars or declared windows, candidate self-scheduling, confirmations, reminders, reschedule, cancel, completion)
12. Audit history (timeline per application and per role; audit records for privileged reads; AI run records)
13. ITS recruiter escalation ("Bring in a recruiter" everywhere; the ITS queue; claim and resolve; full context snapshot)

Plus the platform capabilities the thirteen steps depend on and that already exist: the policy engine, the durable workflow engine, notifications and the Today brief, the stuck-role detector, the admin console, entitlements (pilot plan), and the evaluation harness.

### Out of scope for release 1 (sequenced, not dropped)

Interview scorecards, debrief, calibration memory (release 2); offers, e-signature, negotiation support (release 2); onboarding handoff, HRIS, 30/60/90 outcomes (release 3); recruiter takeover mode and pipeline table (release 3); rediscovery and sourcing (release 3+); billing with Stripe (release 2); external job boards until partner approval (D5); voice screening (not planned); mailbox OAuth for sending (deferred); SSO and TOTP (D12); analytics views beyond the Today summary and the admin console.

## 3. Users

| Persona | Mode | What they need in release 1 |
|---|---|---|
| Owner / founder / COO (tenant role `owner` or `admin`) | Owner mode | Describe a hire in plain language; approve one thing; see who is worth their time; approve interviews; connect a calendar; get a recruiter in one click |
| Hiring manager (`hiring_manager`) | Owner mode | Same as the owner for their roles; approve packets and interviews; interview |
| People lead / HR (`hr`) | Owner mode | Team setup, applications, compensation visibility, data requests |
| Interviewer (`interviewer`) | Owner mode, restricted | Connect a calendar or declare availability; see their upcoming interviews and the candidate's application; nothing about pay |
| Candidate | Public pages, token links | Apply on a phone: a short form, then the same short AI interview with the company's AI assistant as every applicant (since 20 October 2026), opened on the page once it is ready or from the email that carries its link (about fifteen minutes in all; or do it later, or ask for a person); know the status; screen by text on the later path; pick an interview time; withdraw; control texts; reach a person |
| ITS recruiter (`platform_role = its_recruiter`) | Recruiter queue | See escalations by SLA with the full context; claim; resolve; (D11) scoped tenant access |
| Platform admin (`platform_admin`) | Admin console | Customers, workflow runs, AI runs, failures, costs, queue health; apply the pilot plan; assign platform roles; fulfil data requests |

## 4. The workflow, step by step, with acceptance criteria

Each step lists what the user sees, what the system does, and the acceptance criteria (AC) the release must meet. Policy levels are the platform defaults unless the company changed them (see `02`).

### Step 1. Company signup and team

- User: requests a sign-in link, opens it, creates the company (name, vertical from the wedge list, size band, timezone, locations), invites teammates with roles.
- System: magic link (single use, 15 minutes); session cookie; company row with trial entitlements; `stuck_role_detector` run started; invitation links.
- AC1.1 A new user reaches a created company in under three minutes without a password.
- AC1.2 An invited teammate lands in the right company with the assigned role; the inviter cannot remove themselves; every membership change is audited.
- AC1.3 A design partner is on the `pilot` plan (D9) before any role is created; the Setup page shows plan limits and usage.
- AC1.4 Sessions are listed in Setup and can be revoked (S11).

### Step 2. Role intake

- User: types "I need a performance marketing manager in Los Angeles, $95,000 to $115,000, hybrid" on Today; answers at most three questions per turn; can reload and resume; can start over.
- System: Intake agent turn (Haiku 5.5) with the consumer playbook, the matched playbook role, and a compensation benchmark (BLS OEWS or playbook range) in context; facts merged; unlawful criteria declined with a lawful alternative recorded.
- AC2.1 The assistant never asks for a fact already given; asks about reason for hire, ceiling and basis, must-haves vs nice-to-haves, eligibility, location and schedule, interviewers and decision maker, timeline, what failure looks like, deal-breakers.
- AC2.2 "Under 30", "no gaps", "native English", "recent grads", "local zip only", family or health criteria are declined, explained in one sentence, and never appear in the packet (eval `intake.illegal_criteria` at 100%).
- AC2.3 A model failure shows an honest message and the "Bring in a recruiter" action; the session is preserved.
- AC2.4 Compile creates the role (`pending_approval`) and packet v1 (`proposed`) with provenance (playbook id and version, benchmark source, assumptions, AI run ids); the `active_roles` entitlement is checked first.

### Step 3. Role Packet approval

- User: reads the packet in sections (Overview, Requirements, How we'll evaluate, Interview plan, Posting); edits create v2; approves as one action.
- System: `role_approval` workflow; policy `role_packet.approve` (approval; owner, admin, hiring_manager); on approval the packet is `approved`, the role `open`, `publish_role` starts.
- AC3.1 Only a user whose role is in the approval's required roles can approve; a mismatched version is rejected with a clear error.
- AC3.2 Every version is kept; the diff between versions is visible; applications record the version that evaluated them.
- AC3.3 Interview rounds in the approved packet name interviewers as users of the company or as roles to be picked at interview approval (D4).

### Step 4. Hosted job page and intake address

- User: sees posting status per channel; copies the job link and the intake address.
- System: careers page at `/careers/{slug}`, job page with JSON-LD `JobPosting`, apply page, per-role email-in address; external boards hidden unless the channel flag is on (D5).
- AC4.1 The job page renders in under 1 second on a mid-range phone, scores 90+ on Lighthouse mobile, and validates in Google's Rich Results test.
- AC4.2 The page shows the pay range where the packet or the jurisdiction requires it, the AI-use notice, and the privacy link.
- AC4.3 Pausing or closing the role removes the apply button and returns 404 from the apply route within one request.

### Step 5. Secure candidate application

- Candidate: name, email, optional phone with a separate unchecked SMS consent (only when SMS is enabled), location, resume (PDF, DOCX, text, 8 MB) or a few lines about recent work instead, eligibility questions in plain language, notices with versions, submit. After Send (every role since 20 October 2026, R20-12; the ITS switch of founder decision B1 is ignored), the page becomes a short waiting room ("We're preparing your AI interview…") that opens the AI interview's introduction (step 9) by itself once the résumé is read and the interview exists, and says the link has also gone by email; without JavaScript, a "Start my interview" button does the same. A trial pause, an allowance used up, a "No" to a must-have question or a closed role shows what happens next instead, with no loader. A repeat submission sees exactly the same pages and changes nothing on the existing record: its conversation is kept apart and added only if the owner of the address on file confirms by email ("Lost your link?" emails the status link again).
- System: honeypot, rate limit, dedupe by normalized email or phone, consent records with notice versions, resume stored with SHA-256, `application_intake` started, which starts the `screen` workflow for every applicant (20 Oct 2026, R20-4): once the résumé is read, or at the latest ten minutes after applying, it creates the AI interview on the web and sends the one email with its link (an emailed-in applicant's interview and email are made in the intake's first step, before any AI reads their application); email-in path parses forwarded applications.
- AC5.1 The form alone under three minutes on a phone; with the conversation about fifteen minutes (five or six questions, `screening.maxMinutes` 10 by default), and the job page, the apply card and the form say so; keyboard and screen-reader operable; errors name the field.
- AC5.2 A duplicate application by the same person to the same role (the same address, from the form or by email) changes nothing: the existing application and person keep their consent, phone, location and résumé, no second application or acknowledgment is created, and an uploaded file is discarded. It emits `application.duplicate_detected`, the submitter sees the same receipt as anyone else, and the address on file (never the one typed) gets one short email with that application's status link at most once a day. A direct-upload grant attaches its file to one submission only; reused, it is refused like an expired one.
- AC5.3 (changed 20 Oct 2026, R20-5) One email with the disclosure, the human alternative, the status link and, unless the application is held on a must-have answer or left the process, the AI interview link ("link follows" when the month's interviews are used up). It goes once the résumé is read, usually within about a minute, and at the latest ten minutes after applying (measured by `application.acknowledged` minus `application.received`); the former 60-second target for an acknowledgment without the link ends. After Send the page waits for the interview and opens it (R20-12); a repeat or an address the company knows gets the same waiting room, which opens a detached interview whose answers join only when the address owner confirms them by email (Q14 kept in full, 21 Oct): every waiting room waits 40 to 90 seconds first, and both interviews are planned from the same facts of the visit, so they open alike.
- AC5.4 Resume text extraction runs in the worker, not the request (S6); a file that cannot be read produces `resume.extraction_failed` and the application still proceeds.

### Step 6. Evidence-based AI assessment

- System: deterministic eligibility on owner-authored rules only (unanswered = unverifiable, never a fail); resume extraction (Haiku 5.5) with quotes verified in code; assessment (Haiku 5.5) with must-have findings, competency findings, strengths, concerns, unknowns, confidence, recommendation; quotes verified against the resume or the application text; unverifiable quotes discarded and counted.
- AC6.1 No application is ever rejected by the assessment; `application.reject_on_assessment` is hard human-only.
- AC6.2 Gaps, career changes, missing degrees, "overqualified", and AI-written text never produce `weak` (eval `triage.edge_cases` at 100%).
- AC6.3 Every quote shown to the owner is a verbatim substring of the source (eval `triage.hallucination` at 100%; runtime verification).
- AC6.4 A failed eligibility answer places the application on hold (policy `application.hold_ineligible`): the hiring team is notified, a review timer starts, the team is reminded, and an overdue review is escalated to an ITS recruiter. The system never declines; only a person declines with a job-related reason, and the candidate-facing decline message is sent only after that decision is recorded. Override with a stated reason and "review anyway" remain.
- AC6.5 An invalid or refused model output is retried once, then the application is marked "review manually" with nothing hidden.

### Step 7. Human review

- User: Talent view grouped as waiting on you / in process / not moving forward; application detail with the assessment, evidence chips, extraction, messages, screens, timeline; actions: invite to a screen, mark for interview, hold, decline with a reason, move to talent pool, override eligibility with a reason, review anyway; one-click "Something wrong?" flag with the taxonomy.
- AC7.1 Declining requires a reason code; the event carries the human actor; the candidate receives a disposition under `disposition.send` (auto_notify).
- AC7.2 Viewing an application writes a `candidate.viewed` audit record with the actor.
- AC7.3 Compensation is redacted for roles that lack `compensation.read` (interviewers).
- AC7.4 A flag stores the taxonomy kind and note against the AI run and emits `human.override`; nothing retrains.
- AC7.5 (20 Oct 2026, R20-9) The match score counts the résumé and the AI interview once the interview's scorecard is in. Until then, wherever the score shows (list, board card, candidate panel, Compare, the weights preview, the candidate's own page) it says so: "Résumé only: AI interview not done yet", "Résumé only for now: AI interview done, being scored" or "Résumé only: no AI interview" (one wording however the link closed); after, "From the résumé and the AI interview". "Sort: Score" lists interviewed people first, then résumé-only people. The pool board keeps everyone offered the AI interview (every application since 20 October 2026, including a link that lapsed or was stopped, one left part-way, and an interview that never came because the month's AI interviews stayed used up for 60 days, Q17) in its "No AI interview yet" lane until the interview is scored, and Review and apply never reaches them. The one exception is an application from before 20 October 2026, never offered one: its score reads "Résumé only: no AI interview" and the board places it by the earlier rules. The label never changes the number and adds no model call (docs/spec/22).

### Step 8. AI interview invitation (every applicant, 20 Oct 2026)

- System: nobody approves the invitation, and there is no "likely fit" gate, recommendation or consistency check before it (R20-4). Every applicant's `screen` run waits for the résumé reading (the intake signals `reading.settled`), or ten minutes at most, then creates the AI interview on the web and sends the one email with its link (R20-5); the application moves to `screen_invited` and shows under "No AI interview yet", with no per-person alert to the team until the interview is scored (R20-7, R20-8). Someone who answers "No" on the form to a must-have question gets the neutral thank-you without the link and is held; "Keep them in" sends the link by itself, with nothing more to approve (R20-10). A gap seen only in the résumé reading never holds the link: the AI interview asks about it. When the month's AI interviews are used up, the email says the link follows, and it goes the moment more are added (Q17, R20-11). `application.invite_screen` is fixed at "Do it": no approval, no decision card, no "Ask me first" or "Only a person", and saved settings are ignored. There is no ITS switch either: the old one-visit switch (`roles.apply_mode`) is ignored, and everyone gets the same waiting room after Send, which opens the interview once it is ready while the same email goes (R20-12); a repeat or an address the company knows gets a detached interview there whose answers join only when the address owner confirms by email (Q14). An emailed-in applicant's interview and email are made in the intake's first step. A person can still send a new link ("Send a new AI interview link"), refused during a trial pause.
- AC8.1 The `text_screens` entitlement counts a conversation at its first answer, never at the invitation; at 80% the owner and ITS are warned; used up, applications are still accepted and new applicants get the conversation link by email once more are added (Q17); a recruiter is never paged.
- AC8.2 The invitation email carries the disclosure, the human alternative, the question count and the time estimate; the SMS opening (when enabled) discloses AI and STOP/HUMAN.

### Step 9. Candidate screening

- Candidate: web chat straight after the form, or from the email link (no JavaScript required, keyboard only): a fixed introduction (the company's AI assistant, a software program, not a person; a conversation, not a test; about how many questions and minutes; skip, stop and come back) with Start, "Do this later" (the link by email) and "I'd rather talk to a person"; then one question at a time in large type, in the packet's own words, with "Question 2 of 5" and a thin progress bar, tap answers for factual questions (yes or no, days, a start date, a pay range), "Skip this question", follow-ups that quote the candidate's words, and the AI line on every page; then "Check your answers" with Change on each, and Send. "I'd rather talk to a person" offers two equal choices: send the application without the conversation, or have an ITS recruiter make contact within four business hours. By SMS when enabled inside 8:00 to 21:00 local time (later path only).
- System: turn rules enforced in code (one question, two follow-ups max, bounded conversation, protected details kept out of recorded answers, every packet question asked in the packet's words); HUMAN and WITHDRAW, a skip and a tapped answer handled before any model call; an invitation not started: reminder after 48 h, expiry after 72 h more; a conversation stopped part-way: one reminder, then closed as unfinished; the team sees no answer until the candidate sends them, and an unfinished conversation is never shown or read (founder decision of 9 October 2026), so its reading and match score stay the résumé's; scorecard with verified quotes, written only for a sent conversation; recommendation under `application.recommend_interview`.
- AC9.1 Every web page of the conversation says it is the company's AI assistant, and the introduction is fixed text; the first SMS message discloses AI (eval `screen.conversation` at 100%).
- AC9.2 HUMAN, or "Have a person contact me", creates a `candidate_issue` escalation with the transcript and a 4-hour SLA (D14) and stops questions; the request is counted and never uses the company's recruiter requests.
- AC9.3 Two consecutive model failures hand an emailed (later-path) conversation to a person; a conversation offered with the application pauses instead, keeps the answers, and emails the candidate once the assistant works again, with a person one click away throughout; the candidate never sees a stack trace.
- AC9.4 STOP revokes SMS consent and no adapter texts that number again.

### Step 10. Human interview approval

- User: on a candidate at `screen_complete`, `interview_recommended`, or `triaged`, chooses "Interview"; the approval sheet shows the next round from the packet plan (title, duration, format), the interviewers (pre-filled from the packet; pickable), the video link source, and the scheduling window; confirms.
- System: policy `interview.request` (approval; owner, hiring_manager, recruiter): the human's click is the approval; `interviews` row `proposed`; `schedule_interview` starts; stage stays `interview_recommended` until a slot is booked.
- AC10.1 The AI never starts scheduling on its own; `interview.request` cannot be set below `approval`.
- AC10.2 The sheet warns when an interviewer has neither a connected calendar nor declared availability and offers to declare windows on the spot.

### Step 11. Calendar scheduling

- Interviewer: connects Google Calendar or Microsoft 365 from Setup (OAuth, narrow scopes) or declares weekly availability windows and a timezone.
- System: proposes 6 to 10 slots over the next 10 business days from the interviewers' free/busy and windows (buffers, working hours, existing interviews); offers them to the candidate by email (and SMS when enabled) with a token link; the candidate picks one (their timezone detected and confirmable); the system re-checks busy, books calendar events with a Meet/Teams link (D3), sends confirmations with an ICS file, reminds at 24 h and 2 h, marks the interview complete one hour after its end unless it was cancelled, and asks the interviewer whether it took place (no-show path).
- AC11.1 No double booking: booking re-checks free/busy inside the same second and retries with a fresh slot set on conflict.
- AC11.2 Time zones: a candidate in Denver interviewing a manager in Los Angeles sees both times; daylight-saving boundaries are tested.
- AC11.3 Reschedule (up to two by the candidate, unlimited by the team) and cancel clean up every calendar event and notify everyone.
- AC11.4 If no slot is chosen in 48 hours: one reminder; after 48 more hours the offer expires, the owner is told, and the stuck-role detector counts it.
- AC11.5 Calendar provider failure: retry with backoff (5 attempts over 2 hours), then fall back to declared windows and tell the owner; a disconnected calendar shows as needing attention in Setup.
- AC11.6 After the interview the owner records the decision (D10): next round (schedules again), finalist, hired (outside the product), or not moving forward with a reason.

### Step 12. Audit history

- User: every application shows a plain-language timeline (events with actor kind: system, AI with run id, person by name, candidate); the role shows its timeline; Setup shows policy changes; the admin console shows AI runs with the six questions (what it saw, concluded, why, which policy, what the human did, what happened).
- AC12.1 Every state change is an event with actor, subject, correlation id; events are never updated or deleted.
- AC12.2 Every AI action records prompt key and version, prompt hash, model, tokens, cost, structured output, policy decision, human override, final outcome.
- AC12.3 Privileged reads (candidate viewed, escalation context viewed, admin bypass, ITS cross-tenant read) are audit records with a reason.

### Step 13. ITS recruiter escalation

- User: "Bring in a recruiter" on Today, on a role, on a candidate, in the screen hand-off, and from the stuck-role ladder; picks a quick reason or types one; sees the SLA.
- System: escalation row with a context snapshot (company, role, packet, candidate, resume text, assessments, screens, communications, timeline); email to the ITS queue; recruiter claims and resolves; resolution notifies the customer; workflow failures create escalations automatically.
- AC13.1 The recruiter answers "what is this role and what happened with this candidate" from the escalation page without asking the customer.
- AC13.2 SLA due times are visible in the queue and breaches alert the platform admin.
- AC13.3 (D11) An ITS recruiter's reads of tenant data are scoped and audited.

## 5. What AI may and may not do (enforced, not aspirational)

| AI may | Enforced by |
|---|---|
| Organize information (packet compile, extraction, timeline summaries) | Structured outputs validated by Zod; human approval on the packet |
| Extract evidence with verbatim quotes | Quote verification in code; unverifiable quotes discarded |
| Ask approved questions (intake, screening questions from the packet) | Turn rules in code; question keys must exist in the packet |
| Draft recommendations (screen, hold, review manually; interview, hold) | Recommendations are information; stages move only under policy or by a human |
| Send approved operational communications (acknowledgment, invitations, reminders, confirmations, dispositions after a human decision) | Templated messages with the disclosure; policy levels; consent gates in the adapter |

| AI may not | Enforced by |
|---|---|
| Make a final hiring decision | `candidate.hire_decision` hard human-only; no code path sets `hired` from an agent |
| Automatically reject a candidate | `application.reject_on_assessment` and `application.reject_ineligible` hard human-only; a failed eligibility answer only holds, reminds, and escalates; no disposition is ever sent without a recorded human decision |
| Change eligibility criteria | `knockout_rule.change` hard human-only; packets change only by human edit |
| Set compensation | Packet compensation comes from the owner; the model may cite a benchmark; the ceiling is owner-stated |
| Send offers | No offer workflow in release 1; `offer.*` policies remain approval or human-only |
| Initiate adverse action | No background checks in release 1; `background_check.adverse_action` hard human-only |
| Start an interview on its own | `interview.request` is approval; the gate refuses lower levels |

## 6. Functional requirements by area

Numbered so tests and pull requests can cite them.

- FR-1 Auth and tenancy: FR-1.1 magic links; FR-1.2 sessions with list and revoke; FR-1.3 company switch; FR-1.4 platform roles assignable only by a platform admin through an audited endpoint.
- FR-2 Company: FR-2.1 create and update; FR-2.2 invitations with roles; FR-2.3 pilot plan and entitlements shown; FR-2.4 notices editable by owner/admin (human-only, audited).
- FR-3 Intake and packet: FR-3.1 conversation with resume; FR-3.2 compile; FR-3.3 versions and diff; FR-3.4 approval; FR-3.5 pause/resume/close.
- FR-4 Posting: FR-4.1 careers and job pages; FR-4.2 JSON-LD; FR-4.3 email-in address; FR-4.4 channel flag.
- FR-5 Application: FR-5.1 web form; FR-5.2 email-in; FR-5.3 dedupe; FR-5.4 consent and notice versions; FR-5.5 status page; FR-5.6 withdraw; FR-5.7 text preference; FR-5.8 data request intake.
- FR-6 Assessment: FR-6.1 eligibility; FR-6.2 extraction; FR-6.3 assessment; FR-6.4 review window; FR-6.5 review anyway.
- FR-7 Review: FR-7.1 Talent groups; FR-7.2 detail; FR-7.3 actions; FR-7.4 flags; FR-7.5 audit of views.
- FR-8 Screening: FR-8.1 invite under policy; FR-8.2 web chat; FR-8.3 SMS when enabled; FR-8.4 reminders and expiry; FR-8.5 scorecard; FR-8.6 recommendation under policy; FR-8.7 HUMAN, WITHDRAW, STOP.
- FR-9 Interview approval: FR-9.1 approval sheet; FR-9.2 interviewer selection; FR-9.3 policy gate.
- FR-10 Scheduling: FR-10.1 calendar connections (Google, Microsoft); FR-10.2 declared availability; FR-10.3 slot proposal; FR-10.4 candidate self-scheduling page; FR-10.5 booking with links; FR-10.6 confirmations and reminders; FR-10.7 reschedule and cancel; FR-10.8 completion and no-show; FR-10.9 decision recording (D10); FR-10.10 Interviews view.
- FR-11 Audit: FR-11.1 application timeline; FR-11.2 role timeline; FR-11.3 admin AI run view; FR-11.4 audit records.
- FR-12 Escalation: FR-12.1 create from every surface; FR-12.2 queue with SLA; FR-12.3 claim and resolve; FR-12.4 scoped access (D11).
- FR-13 Today and notifications: FR-13.1 four-question summary; FR-13.2 decision cards; FR-13.3 "what the assistant did" feed; FR-13.4 stuck-role ladder with interview detectors.
- FR-14 Admin: FR-14.1 customers; FR-14.2 runs; FR-14.3 AI runs; FR-14.4 failures; FR-14.5 costs and spend cap; FR-14.6 queue; FR-14.7 data requests; FR-14.8 plan assignment.

## 7. Non-functional requirements

| Area | Requirement |
|---|---|
| Performance | Today brief under 2 s at p95 for a tenant with 10 open roles and 2,000 applications; job page TTFB under 300 ms; acknowledgment within 60 s; intake turn under 15 s p95; screen turn under 8 s p95 |
| Availability | API and worker on a managed platform with health checks; target 99.5% monthly for the pilot; the queue drains within 5 minutes after a restart |
| Durability | Managed Postgres with point-in-time recovery (RPO 15 min, RTO 4 h); object storage with versioning; weekly restore test in staging |
| Accessibility | WCAG 2.2 AA on candidate pages and owner mode: keyboard operability, labels, focus, contrast, live regions for the conversation, no color-only meaning |
| Mobile | Candidate pages and owner mode designed at 375 px first |
| Security | See `09`; S1 to S3 fixed before the first real candidate |
| Observability | Structured logs with token redaction; error tracking; queue depth, failed runs, AI error rate, cost per tenant per day, escalation SLA breaches alerting |
| Cost | AI spend under $5 per role at pilot volume; a per-tenant daily cap (D13) |
| Data | US region; retention defaults per `09`; no SSN, bank, government ID, health or biometric data collected |

## 8. Success metrics for the beta (from the founder context's operating metrics)

Time to posted role (target under 30 minutes of owner time); acknowledgment time; application completion rate; screen completion rate (target 60%+); time to first interview; owner minutes per active role per week (target under 45); escalation rate and resolution time; AI override and flag rate by decision type; workflow failure and recovery rate; evidence factual-error rate (from flags); candidate experience one-question survey after the screen and after the interview.

## 9. Release criteria

1. All acceptance criteria above pass in the scenario tests on PGlite and in a staging run against real adapters (Postmark, one calendar provider, the Anthropic API).
2. Eval suites meet thresholds on the real provider; results signed by a reviewer.
3. S1, S2, S3 closed; S4 to S7 closed or accepted in writing.
4. Counsel has answered C1 to C7 or the founder has accepted the interim texts in writing.
5. Design-partner agreements signed; the ITS queue is staffed per D14.
6. Runbooks exist for: failed workflow, calendar disconnect, data request, incident.

## 10. Dependencies outside the codebase

Anthropic API key; Postmark account with a verified sending domain and an inbound domain (D7); Google Cloud project with the Calendar API and an OAuth consent screen (testing status); Microsoft Entra app registration; hosting accounts (D8); optional Twilio account and 10DLC campaign (D6); a public privacy policy and terms; insurance (C8).
