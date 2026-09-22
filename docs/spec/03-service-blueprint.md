# 03. End-to-end service blueprint (release 1)

One row per stage of the workflow. "Frontstage" is what the person sees; "backstage" is what the system does; "AI" is the model task; "policy" is the action level; "data" lists the rows written; "events" the facts emitted; "failure" the designed recovery; "human" the escalation path. Metrics are what release 1 measures for that stage.

## The flow

```mermaid
sequenceDiagram
  autonumber
  participant O as Owner / hiring manager
  participant S as Recruiting OS (API, worker, policy)
  participant AI as AI tasks
  participant C as Candidate
  participant I as Interviewers' calendars
  participant R as ITS recruiter
  O->>S: Sign up, create company, invite team
  O->>S: "I need a performance marketing manager…"
  S->>AI: intake.turn (playbook, benchmark)
  AI-->>O: questions, then a Role Packet
  O->>S: Approve packet (policy: approval)
  S-->>C: Job page live (careers, Google Jobs, email-in)
  C->>S: Apply (resume or answers, eligibility, consent)
  S-->>C: Acknowledgment within 60 s (disclosure, status link)
  S->>AI: resume.extract, triage.assess (quotes verified)
  S-->>O: Today: "3 ready for your review"
  S->>C: Screen invitation (policy: auto_notify)
  C->>S: Web chat / SMS, one question at a time
  S->>AI: screen.turn ×n, screen.assess
  S-->>O: Scorecard + recommendation (information)
  O->>S: Interview: approve round and interviewers (policy: approval)
  S->>I: free/busy or declared windows
  S-->>C: Pick a time (6–10 slots)
  C->>S: Selects slot
  S->>I: Book events with video link
  S-->>C: Confirmation + ICS; reminders 24 h, 2 h
  S-->>O: Interview done → record decision
  O->>R: "Bring in a recruiter" (any step)
  R-->>O: Claims, resolves with full context
```

## Blueprint

| Stage | Frontstage | Backstage | AI | Policy | Data | Events | Failure and recovery | Human path | Metrics |
|---|---|---|---|---|---|---|---|---|---|
| 1 Signup | Email → link → company form → invite team | Magic link (hashed, 15 min), session, company + owner membership, pilot plan entitlements, detector run | none | none | users, magic_links, sessions, companies, memberships, entitlements, workflow_runs | company.created, membership.changed, user.invited | Link expired → "request a new one"; email bounce → shown in Setup | Support via platform admin | Time to first company; invite acceptance |
| 2 Intake | Today conversation; questions ≤3 per turn; resume after reload; start over | Session row updated per turn; facts merged; benchmark fetched (BLS or playbook) | intake.turn (Opus 5) | role_packet.propose auto | intake_sessions, ai_runs | intake.started, intake.turn_completed, ai.run_failed | Model error → honest message + recruiter action; benchmark API down → playbook range, cited | Bring in a recruiter (kind ask) | Turns to compile; owner minutes; declined criteria count |
| 3 Compile and approve | Packet sections; edit → v2; approve | Role pending_approval; packet v1 proposed; role_approval run; approval request; on approve: approved, open, publish_role | intake.compile (Opus 5), finalizePacket guarantees (jurisdictions, notices, ceiling, disclosure) | role_packet.approve approval | roles, role_packets, approval_requests, workflow_runs | intake.compiled, role.created, role_packet.proposed, approval.requested, approval.granted, role_packet.approved, role.opened | Compile invalid twice → 502 with recruiter offer; approval expires 14 d → notify | Recruiter can finish the packet | Time intake → approved; edits before approval |
| 4 Post | Posting tab: careers page, Google Jobs, intake address (copy); external boards hidden (D5) | publish_role: careers_page, google_jobs, email_in (token); channel retries ×3 over 24 h | none | role.publish auto | postings | posting.published, posting.failed | Channel error never fails the run; retry; owner told | none needed | Time approved → live |
| 5 Apply | Mobile form; resume or four answers; eligibility questions; notices; status page | Honeypot, rate limit, dedupe, consent with notice versions, document stored (sha256), application applied, application_intake started; email-in parse for forwards | none | none | candidates, documents, applications, inbound_emails | candidate.created, consent.granted, application.received, application.duplicate_detected | Bad file → inline error; duplicate → updates existing; unmatched inbound → admin queue | Privacy page: reply HUMAN | Completion rate; time on form; duplicates |
| 6 Acknowledge | Email within a minute with disclosure and status link | Coordinator template; communications row; stage applied → received | none | message.send_templated auto | communications | application.acknowledged, message.sent/failed | Send failed retryable → step retries; no email → recorded failure, SMS if consented | none | Ack latency p95 |
| 7 Extract and assess | Talent row: Strong / Potential / Weak / Insufficient evidence, two strengths, one concern, confidence | Worker: extraction (quotes verified), deterministic eligibility, assessment (quotes verified), stage eligible → triaged; ineligible → held for a person, reminded daily, escalated after 72 h; never declined by the system | resume.extract (Haiku 4.5), triage.assess (Sonnet 5) | application.triage auto; application.hold_ineligible auto_notify (24 h timer, reminders, 72 h escalation); application.reject_ineligible human only | applications.extraction/eligibility, assessments, ai_runs | resume.ingested / extraction_failed, eligibility.evaluated, application.ineligible, assessment.created, application.triaged, human.override | Unreadable file → proceeds without extraction; invalid output twice → "review manually"; provider outage → step retry ×4 then escalation review | Override eligibility with reason; review anyway | Assessed within 10 min; unverifiable-quote rate; override rate |
| 8 Review | Today card; Talent groups; detail sheet; actions; flag | Actions transition stages by human; audit candidate.viewed | none | reject: human only; disposition.send auto_notify | applications, audit_records, ai_runs.human_override | application.stage_changed, application.rejected, human.override | Invalid transition → 409 with plain message | Bring in a recruiter (review) | Owner minutes per role; decision latency |
| 9 Invite to screen | "Invited {name} to a screen" notification or a decision card | after_triage gate; screen run; entitlement check; invitation email (+ SMS opening when enabled, quiet hours) | screen.turn for the SMS opening | application.invite_screen auto_notify | screens, communications, entitlements/usage_events | screen.invited, entitlement.exceeded | Limit reached → owner notified, no recruiter; email fails → retry; no channel → run fails non-retryably with an escalation | Invite manually; recruiter call | Invite → start time |
| 10 Screen | Web chat: disclosure, one question at a time, progress, Talk to a person; SMS when enabled | runScreenTurn: keyword commands first, model turn, enforceTurnRules, redactProtected, progress persisted; reminder 48 h; expiry 72 h more; scorecard; recommendation gate | screen.turn, screen.assess (Sonnet 5) | screen.conduct auto; application.recommend_interview auto_notify | screens (transcript, answers, progress), communications, assessments, recruiter_escalations (HUMAN) | screen.started/completed/expired/human_requested/assessed, candidate.recommended | Model failure → holding message; twice → hand-off; expiry → owner told | HUMAN → candidate_issue escalation, 4 h SLA | Completion rate; hand-off rate; time to complete |
| 11 Interview approval | "Interview" → sheet: round, interviewers (pick), link source, window → confirm | interviews row proposed; participants; approval request auto-resolved by the human click; schedule_interview run | none | interview.request approval (locked ≥ approval) | interviews, interview_participants, approval_requests | interview.requested, approval.granted | Interviewer without calendar or windows → warning + declare windows inline | none | Approval latency |
| 12 Schedule | Interviewer: Setup → connect calendar or declare windows. Candidate: pick a time page (their timezone). Team: Interviews view | propose_slots (free/busy + windows + buffers), offer_slots (email/SMS, token), wait 48 h → remind → 48 h → expire; book (re-check, create events with Meet/Teams link), confirm (ICS), reminders 24 h and 2 h, close at end + 1 h, ask "did it happen?" | none | interview.schedule auto; interview.reschedule auto_notify | calendar_connections, interviewer_availability, interviews (offered_slots, selected_slot, calendar_refs), communications | interview.scheduling_started, slots_offered, scheduled, rescheduled, cancelled, no_show, completed, integration.failed | Conflict at booking → recompute and re-offer; provider error → retry ×5 over 2 h → declared windows fallback + owner told; no selection → reminder → expiry → owner told, detector counts; token expired → status page shows "ask for new times" | Bring in a recruiter; owner can pick a slot on the candidate's behalf after a phone call | Time recommended → scheduled; reschedule rate; no-show rate |
| 13 Decide (D10) | Card: "How did it go?" → next round / finalist / hired (outside) / not moving forward (reason) | Human-only transitions; next round restarts stage 11 | none | candidate.hire_decision human_only | applications, events | application.stage_changed, human.override | none | Bring in a recruiter | Time interview → decision |
| 14 Audit | Application and role timelines; Setup policy log; admin AI-run six questions | events append-only; audit_records for reads; ai_runs | none | none | events, audit_records, ai_runs | all | none | none | none |
| 15 Escalation | "Bring in a recruiter" everywhere; SLA shown; "A recruiter is on it" | Snapshot; queue email; claim; resolve; resolution notification; workflow failures auto-escalate | none | none | recruiter_escalations, notifications, audit_records | recruiter.requested/claimed/resolved, workflow.escalated | Queue email fails → retried; SLA breach → platform alert | This is the human path | Escalation rate; time to claim; time to resolve |
| 16 Nothing rots | Today cards; email nudges; recruiter offer; escalation | stuck_role_detector daily: candidates waiting ≥3 d, screens unanswered ≥3 d, decisions pending ≥2 d, no applicants 14 d, plus new: slots offered unanswered ≥3 d, interview complete with no decision ≥2 d | none | intervention.nudge auto (48 h cooldown); intervention.offer_recruiter auto_notify | interventions, notifications | intervention.sent/responded | Cooldown respected; resolved when condition clears | Ladder ends in a stuck_role escalation | Roles stuck > 7 d |

## Backstage services and their boundaries

- API (`apps/api`): request handling, candidate pages, webhooks, OAuth callbacks; every tenant request runs inside `withTenant`.
- Worker (`apps/api/src/worker.ts`): claims jobs, runs workflow steps (including AI tasks and calendar calls), leases and retries.
- Policy engine (`packages/core/src/policy.ts`): the single gate for automated actions.
- Integrations (`packages/integrations`): email (Postmark), SMS (Twilio), calendar (Google, Microsoft, declared), job pages (native), compensation (BLS), storage (S3-compatible). Every adapter reports its status; nothing pretends.
- AI (`packages/ai`, `packages/agents`): task routing, prompts, structured outputs, run logging, code-level guards.

## Communications inventory (every message is a `communications` row with the disclosure)

Owner-facing: magic link; invitation; stuck-role message; recruiter offer; escalation resolution. Candidate-facing: acknowledgment; screen invitation; screen reminder; disposition (eligibility; after a human decision); interview slots; slot reminder; interview confirmation with ICS; 24 h and 2 h reminders; reschedule confirmation; cancellation; withdrawal confirmation. ITS-facing: escalation notice; SLA breach alert. All candidate-facing templates carry the packet's disclosure text and the human alternative.
