# 13. Test plan

## Levels

1. **Unit tests** (vitest, per package): schemas, policy resolution, state-machine transitions, eligibility evaluation, dedupe keys, prompt rendering, adapters with fakes.
2. **Integration tests** (vitest, PGlite): API routes through `app.request()` with a real database; RLS cross-tenant tests; workflow engine behavior (retries, waits, crash recovery, idempotency).
3. **Scenario test** (`tests/scenario`): the complete hiring lifecycle below, run with the fake AI provider and fake integrations, asserting what the customer sees, what the AI does, what is stored, which event fired, which policy applied, whether approval was required, and what happens on failure.
4. **Evaluation suites** (doc 11): AI quality; run on prompt or model change and nightly with the real provider when a key is present.
5. **Manual acceptance** with design partners: each slice has a checklist in `docs/acceptance/<slice>.md`.

## The end-to-end scenario

A 100-person company (Brightline Dental Group, three locations, Irvine) hires a full-time Dental Hygienist.

| Step | Customer sees | AI does | Data stored | Event | Policy | Approval? | On failure |
|---|---|---|---|---|---|---|---|
| Intake | Types "I need a dental hygienist in Irvine..." and answers 4 questions | Intake agent extracts facts, asks for missing ones, compiles the packet with the dental playbook and BLS range | `intake_sessions`, `roles` (pending_approval), `role_packets` v1 (proposed), `ai_runs` | `intake.*`, `role.created`, `role_packet.proposed`, `approval.requested` | `role_packet.propose` auto; `role_packet.approve` approval | Yes (owner) | AI failure ×3 → escalation `ask`; owner told a recruiter will finish |
| Approval | One-page summary; edits one must-have; approves | — | `role_packets` v2 (edited, approved), `roles.status = open` | `role_packet.edited`, `role_packet.approved`, `role.opened` | | | |
| Posting | Status per channel; Indeed instructions with intake address | Publish workflow | `postings` × channels | `posting.published`, `posting.pending_credentials` | `role.publish` auto | No | Channel failure → retry; others continue |
| Application (web) | Nothing yet | Coordinator acknowledges within 60 s | `candidates`, `applications` (applied → received), `documents`, `communications` | `application.received`, `application.acknowledged` | `message.send_templated` auto | No | Email bounce → flagged; SMS if consented |
| Application (email-in) | Nothing | Inbound parsed and matched | `inbound_emails`, same as above | same | | | Unmatched → admin queue |
| Eligibility | — | Deterministic rules (RDH license in CA, availability) | `applications.eligibility`, stage eligible/ineligible | `eligibility.evaluated`, `application.ineligible` | `application.reject_ineligible` auto_notify, 24h window | Review window | Rule evaluation error → stage received, manual |
| Triage | Brief: "4 look strong"; candidate cards with evidence | Extraction and evidence-based assessment | `assessments`, `ai_runs`, stage triaged | `application.triaged`, `assessment.created` | `application.triage` auto (information) | No | Extraction failure → manual review flag |
| Screening | Brief: "6 screens completed" | Screening agent by web chat/SMS with disclosure | `screens`, `communications`, `assessments` (screen) | `screen.*` | `application.invite_screen` auto_notify; `screen.conduct` auto | No | HUMAN reply → escalation with 4h SLA |
| Scheduling | "Interview these 4?" → approve → calendar fills | Slots, booking, reminders | `interviews`, `interview_participants` | `interview.requested`, `interview.scheduled` | `interview.request` approval; `interview.schedule` auto | Yes | Conflict → re-offer; provider error → fallback |
| Interview | Brief before; scorecard after | Brief, recording with consent, draft scores | `scorecards` (draft → submitted) | `interview.completed`, `scorecard.submitted` | `scorecard.draft` auto (information) | Interviewer submits | Consent declined → notes only |
| Debrief | Finalists side by side, disagreements, recommendation | Debrief summary | `debriefs`, stage debrief | `debrief.completed` | `debrief.recommend` approval (recommendation) | Yes (decision) | Missing scorecards → nudge ladder |
| Finalist | Chooses Maria | — | stage finalist | `candidate.finalist` | `candidate.hire_decision` human_only | Human | |
| Offer | "Approve the offer: $52/hr..." | Offer agent drafts within ceiling | `offers` v1 (draft → pending_approval → approved → sent) | `offer.*` | `offer.draft` approval; `offer.send` approval | Yes ×2 | E-sign error → PDF fallback |
| Acceptance | "Maria accepted" | — | stage accepted | `offer.accepted` | | | Counter → `offer.negotiate` human_only |
| Onboarding | Checklist; "handed to BambooHR" | Welcome, tasks, HRIS create or handoff packet, reminders | `onboardings`, stage onboarding → hired | `onboarding.started`, `employee.created`, `start.confirmed` | `employee.create_in_hris` auto_notify | No | HRIS error → packet fallback |
| Outcome | 30-day one-tap check-in | — | `hiring_outcomes` | `outcome.recorded` | `checkin.request` auto | No | No response → reminder |

The scenario test in `tests/scenario/lifecycle.test.ts` executes the steps implemented by the current slices and marks the rest `todo`, so the file is the living record of what is done.

## Failure injection

The scenario is also run with: the email adapter failing on the first send; the AI provider returning an invalid schema once; a worker "crash" between steps (the run is re-claimed); a duplicate application from the same candidate; a candidate withdrawal mid-screen; a calendar conflict at booking time (Slice 3). Each must produce the documented behavior and a `workflow.retried`, `workflow.failed`, or `workflow.escalated` event where applicable.

## Definition of done, enforced

A feature is complete only when: UI works; backend works; database works; permissions work; error handling works; audit events work; an AI evaluation exists for any AI output; tests exist; edge cases are handled; the mobile experience works where applicable; loading and failure states exist; human escalation works; documentation exists. The pull-request template lists these as checkboxes and CI checks the ones it can (tests, evals, typecheck, lint).
