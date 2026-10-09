# 06. Workflows, the policy engine, and the candidate state machine

## The loop every workflow follows

```
Event → Workflow step → AI recommendation (optional) → Policy check → Human approval if required → Action → Event → Audit record
```

The workflow engine (`packages/workflows`) provides `defineWorkflow({key, version, steps})`. A run is a row in `workflow_runs`; each step execution is a row in `workflow_steps`; the poller claims due `jobs` with `FOR UPDATE SKIP LOCKED`. Steps are functions `(ctx, state) => StepResult` where the result is one of `next(stepKey, state)`, `wait({kind: 'human'|'event'|'timer', ...})`, `complete(state)`, or `fail(error)`. Steps are idempotent: they check the ledger before acting and use idempotency keys on every external call. Retries use exponential backoff with jitter; after `max_attempts` the run fails, emits `workflow.failed`, and creates an escalation (`kind: stuck_role` or the workflow's declared escalation kind). A paused run (takeover) keeps its state and resumes on handback.

Every workflow definition declares: trigger, preconditions, steps (actions), success state, failure state, retry policy, escalation, human takeover behavior, and the events it emits. Below are the definitions for the lifecycle; the code is in `packages/workflows/src/definitions/`.

## Workflow catalog

### `intake_to_packet` (Slice 1)
- **Trigger:** `intake.started` (owner opens a conversation or sends a first message by any surface).
- **Preconditions:** company exists; user has role owner, admin, hiring_manager, or recruiter; `active_roles` entitlement available (checked at compile, not at start).
- **Steps:** `turn` (Intake agent responds; loops on `wait(event: intake.message)`) → `compile` (packet proposed; `role` created in `pending_approval`; `role_packets` v1 `proposed`) → `request_approval` (policy `role_packet.approve`; `wait(human)`) → `on_approved` (packet `approved`, role `open`, emit `role.approved`, dispatch `publish_role`) | `on_rejected` (packet stays proposed; owner edits create v2 via `role_packet.edit`).
- **Success:** role open with an approved packet. **Failure:** AI failure after 3 retries → escalation `ask` with the transcript, owner notified "a recruiter will finish this with you."
- **Takeover:** a recruiter can continue the conversation as the operator; the agent becomes an assistant.
- **Events:** `intake.*`, `role.created`, `role_packet.proposed`, `approval.requested`, `role_packet.approved`, `role.opened`.

### `publish_role` (Slice 1)
- **Trigger:** `role.opened` or `role.resumed`.
- **Preconditions:** approved packet; company careers page enabled.
- **Steps:** `careers_page` (native, always live) → `google_jobs` (native JSON-LD) → `email_in` (allocate intake address token) → `linkedin_basic` (feed entry) → `indeed` and `ziprecruiter` (adapters; `pending_partner_approval` records a posting with that status and instructs the owner how to post from their own account with the intake address) → `record`.
- **Success:** at least the careers page live; every channel has a posting row with a status. **Failure:** a channel error does not fail the run; it marks the posting `failed` with the error and schedules a retry (3 tries over 24 hours), then notifies.
- **Retry:** per channel. **Escalation:** none unless all channels fail.
- **Events:** `posting.*`.

### `application_intake` (Slice 1)
- **Trigger:** `application.received` from the careers page, `inbound_emails` matched to an intake address, or an integration webhook.
- **Preconditions:** role open or paused (paused accepts and holds).
- **Steps:** `dedupe` (candidate by normalized email/phone; merge or create; `application.duplicate_detected` if the same candidate applied to the same role) → `store_documents` (resume, sha256) → `acknowledge` (Coordinator sends the acknowledgment with disclosure and the status link; policy `message.send_templated` = auto) → `extract` (Triage: resume extraction) → `eligibility` (deterministic rule evaluation) → branch: ineligible → `hold_ineligible` (stage `ineligible`; `application.reject_ineligible` policy default auto_notify with a review window of 24 hours; after the window with no owner action, disposition message sent, stage `rejected`, reason `eligibility`) | eligible → `assess` (Triage assessment; stage `triaged`) → `recommend` (if recommendation = screen and policy `application.invite_screen` allows, dispatch `screen`; else stage stays `triaged` and appears in the brief as "needs review").
- **Success:** application triaged with an assessment. **Failure:** extraction failure → `resume.extraction_failed`, stage `received`, flagged "needs manual review" in the brief; AI failure → retry ×3 → escalation `review`.
- **Takeover:** recruiter can perform any step manually; the run records `human.override`.
- **Events:** `candidate.created|merged`, `application.received`, `application.acknowledged`, `resume.ingested`, `eligibility.evaluated`, `application.ineligible`, `application.triaged`, `assessment.created`, `application.stage_changed`.

### `screen` (Slice 2)
- **Trigger:** `screen.invited` (from triage, an owner action, or a recruiter).
- **Preconditions:** candidate has a reachable channel; SMS requires consent, else web chat via email link; `text_screens` entitlement.
- **Steps:** `invite` (message with disclosure and the human alternative; stage `screen_invited`) → `wait(event: screen.started | timer 48h)` → on timer: `remind` once, then after 72h more `expire` (stage `screen_invited` with `screens.status = expired`, brief shows "no response") → `conduct` (Screening agent loop; each candidate message is `wait(event: message.received)`; stage `screening`) → `assess` (ScreenAssessment; stage `screen_complete`) → `recommend` (if strong_interview or interview and policy `application.recommend_interview` = auto_notify: stage `interview_recommended`, brief; decline_recommended never changes the stage).
- **Failure:** channel failure → switch channel; candidate replies HUMAN → `screen.human_requested`, stage stays, escalation `candidate_issue` with a 4-hour SLA; AI failure → retry, then human.
- **One visit (plan Wave E):** on a role whose apply mode is `one_visit` (pilot roles first, founder decision B1: a role or company without a setting takes `form_then_screen`; ITS switches `roles.apply_mode` or the company's `settings.applyFlowDefault` either way), the apply page creates the screen itself (`screens.invited_via = 'apply'`, web only) for everyone who passes the eligibility questions when `application.invite_screen` is automatic, and starts this run with no invitation message (apps/api `services/apply-conversation.ts`). The intake reads the résumé beside it without moving the stage and never invites twice. Started and idle: one reminder after 24h, then closed as `unfinished` 48h later; nothing the candidate never sent is shown to the team or assessed (founder decision of 9 October 2026, "hide them until they send"); no more 72h waits repeated for ever. Every question answered but Send not pressed: one reminder that says the team sees the answers only once the candidate sends them and the day the conversation closes, then closed as `unfinished` the same way: nothing sends the answers on the candidate's behalf (before 9 October 2026 they were sent as they were, `screen.completed` with `via: review_timeout`). Never started: one reminder at 48h, then at 72h more the screen expires, the application moves to `triaged` and the candidate is told nothing else is needed (no silent expiry). A conversation still open a day past any of these points is named to the team by the `conversations_stuck` detector. Two model failures pause the conversation (`paused`); the run retries every 30 minutes and emails the candidate once it answers; when the retried answer hands over, or after a day without the assistant, a person takes it and the candidate is told by email. On the web every conversation, offered with the application or invited later, opens on the fixed introduction; the model writes the opening only for texts. "Send without the conversation" closes it as `declined_by_candidate` and the application goes to the team as `triaged`. The allowance (`text_screens`) is counted at the first answer, not at the invitation; when it is used up the run waits for a top-up and then sends the link. A repeat submission gets a detached conversation (`unconfirmed_screens`) that reaches the application only once the address owner confirms by email; its emails to the address on file are worded as someone applying again, and capped at three a day per application.
- **Checks and expiry (plan A6, A7, A8):** before `gate()`, the triage step and `recommend` run `readingConsistency` (packages/core/src/evidence.ts): a Strong or Potential reading with a must-have shown not met by a verified quote, or a step suggested for a Weak or Insufficient reading, holds the step for a person (notification `application.needs_review`, audit `assessment.flagged`, "Needs a closer look" with the reason). Low confidence alone holds nothing. A suggestion waiting for approval expires after 7 days (`approval.expired`, nothing sent). Until the candidate starts, a person may stop the invitation (`cancel_screen`): `screens.status = cancelled`, the run cancelled, stage back to `triaged`, a short note to the candidate.
- **Events:** `screen.*`, `assessment.created`, `application.stage_changed`, `candidate.recommended`.

### `schedule_interview` (Slice 3)
- **Trigger:** `interview.requested` (owner approves "interview these five," or a recruiter).
- **Preconditions:** interviewers have connected calendars or declared availability windows; packet interview plan.
- **Steps:** `propose_slots` (Coordinator computes 6 to 10 slots across interviewers within the plan's constraints) → `offer_slots` (message to candidate with a booking link) → `wait(event: interview.slot_selected | timer 48h)` → `book` (calendar events, idempotent; stage `interview_scheduled`) → `confirm` (confirmation to all) → `remind` (timers at 24h and 2h) → `wait(event: interview.completed | timer end+1h)` → `close` (stage `interview_complete`; dispatch `interview_cycle`).
- **Failure:** no slot selected → remind once → escalation offer in brief; calendar conflict at booking → recompute and re-offer; provider error → retry ×5 over 2 hours → fall back to "the team will email you times" and notify the owner.
- **Events:** `interview.*`, `application.stage_changed`.

### `interview_cycle` (Slice 3)
- **Steps:** `brief` (Interview Intelligence sends each interviewer a brief 24h before) → `capture` (recording with consent, or notes upload) → `draft_scorecards` (per interviewer, unrated where no evidence) → `wait(event: scorecard.submitted × all | timer 48h)` → `nudge_scorecards` → `debrief` (when the last scheduled round of the plan completes and all scorecards are in: DebriefSummary; stage `debrief`; approval request "choose finalist(s)") → `wait(human)` → `finalist` (stage `finalist`; dispatch `offer` or `reference`).
- **Failure:** missing scorecards after 72h → intervention ladder; recording consent declined → notes-only path.

### `offer` (Slice 4)
- **Steps:** `draft` (Offer agent; `offer.draft` policy = approval) → `wait(human)` → `approve` (offer `approved`; stage `offer_approval` → `offer_sent` after send) → `send` (`offer.send` = approval; e-sign envelope or PDF plus acceptance link) → `wait(event: offer.viewed | offer.accepted | offer.declined | offer.counter_received | timer expiry)` → on counter: `analyze_counter` (advice to the owner; `offer.negotiate` = human_only) → `wait(human)` → `revise` (new offer version, back to approve) | on accepted: stage `accepted`, dispatch `onboarding` | on declined: stage `declined`, reason captured | on expiry: notify, `wait(human)`.
- **Failure:** e-sign provider error → retry, then PDF fallback with click-to-accept and a note in the audit trail.

### `onboarding` (Slice 5)
- **Steps:** `welcome` (message plus what to expect) → `tasks` (equipment, first-week plan, policy acknowledgments the HRIS does not cover) → `hris_handoff` (adapter `createEmployee` or handoff packet; `employee.create_in_hris` = auto_notify; stage `onboarding`) → `reminders` (T-3, T-1 to the hire and the manager) → `wait(timer: start_date)` → `start_check` (manager confirms; stage `hired`; `start.no_show` path re-opens the role's finalists) → `checkins` (timers at 30/60/90 days; one-question outcome capture from the manager; `outcome.recorded`).
- **Failure:** HRIS API error → retry ×3 → handoff packet fallback with a flag; no start confirmation → nudge → escalation.

### `stuck_role_detector` (Slice 2)
- **Trigger:** daily timer per company (and after any brief).
- **Detectors:** no owner action ≥ N days with candidates waiting; candidates in `triaged` or `interview_recommended` ≥ 3 days; interviews unscored ≥ 24h; offer pending approval ≥ 2 days; screen invites unanswered ≥ 3 days; scorecards incomplete ≥ 48h.
- **Ladder:** brief line → direct message with a one-tap action → offer recruiter → escalation `stuck_role`. Cooldowns and thresholds are policies (`intervention.*`).
- **Emails:** the message and offer rungs email the title (role, counts, days) and the link, never the body, which can name candidates (plan B3).

### `notification_digest` (plan B3, 8 Oct 2026)
- **Trigger:** one run per company, started by the stuck-role check (so companies that existed before it get one on their next daily check) and when someone saves their email alert settings; idempotent by company.
- **Steps:** `send` wakes at 8:00 in the company's time zone. Each active member gets one summary of their updates that are neither read nor emailed, in the groups they get daily (and on Monday, weekly), from the previous summary up to 8:00 (never later), reaching back a week further for anything a missed summary never sent; counts by group and role, with links. Then it sleeps until the next 8:00. A new run only sets its clock; a wake for a time already summarized sends nothing.
- **As it happens:** `notify` queues a `notification.email` job for the people who want that group at once (and for everyone, for the kinds that are always emailed: a recruiter given access, a candidate asking for a person, an eligibility hold); the job reads each setting again and writes one short email per update through the outbox.
- **Content:** what happened, the company, the role's name and a link. Never a candidate's name or details, a recruiter's answer, or a ranking (`packages/core/src/notify-email.ts`).

### `escalation` (Slice 1 minimal, Slice 6 full)
- **Trigger:** `recruiter.requested` from any surface, or from a workflow failure.
- **Steps:** `snapshot` (EscalationContext: company, role, packet version, candidate(s), resume text, assessments, screen transcript, interviews and scorecards, compensation, communication history, preferences, audit history summary) → `notify` (ITS queue) → `wait(event: recruiter.claimed)` → `wait(event: recruiter.resolved | takeover)` → `close`.
- **Takeover (Slice 6):** `takeovers` row; the role's `auto` and `auto_notify` policies become `approval` with `approver_role = recruiter` for the duration (read after the floors and ceilings, so an action that already needs a person, role approval among them, keeps its own approvers); the recruiter operates; handback restores the policy snapshot; every action logged with the recruiter as actor.

## Resilience matrix

| Condition | Behavior |
|---|---|
| External API failure | Step retries with backoff (3 to 5 attempts); non-critical channels degrade (posting to other boards continues); critical steps escalate; the owner is told what is pending. A step that reports a failure trying again cannot fix (`retryable: false`: a missing record, a role approval that resolved to no person, a scorecard the model could not produce twice) fails at once and escalates without retries |
| Calendar conflict | Re-check busy immediately before booking; on conflict, recompute slots and re-offer; never double-book |
| Email bounce | Mark communication `bounced`; try SMS if consented; flag the candidate record; ask the candidate for another address via any working channel |
| Candidate response (any time) | Inbound message matched to the candidate and application; if a workflow is waiting on `message.received` it resumes; otherwise the Coordinator classifies (question, reschedule, withdraw, opt-out, complaint) and routes |
| Candidate withdrawal | Stage `withdrawn`, reason captured, all waiting runs for that application cancelled, interviews cancelled and calendars cleaned, owner notified, candidate thanked |
| Leaving the process (plan A9) | Every exit (decline, talent pool, withdrawal, an outcome, closing the role) runs `exitCleanup` (apps/api/src/services/exit-cleanup.ts): interviews still to come and open screens are cancelled and the assistant's waiting suggestions withdrawn. A deletion does the same in its own code (packages/core/src/privacy-requests.ts) and writes nothing to the candidate. After a private decision (a decline, a move to the talent pool, a declined or no-hire outcome, closing the role) the decision is not sent, but a candidate who held a booked time or was offered times is told at once, in a short note that gives no reason, that the interview is off, so nobody turns up to an interview that no longer exists. The decision message, when a person sends it later, leaves out an interview whose cancellation was already told; when it goes in the same transaction as the cancellation, the candidate gets one message that says both. The candidate's own exits (a withdrawal on the status page or inside the screening conversation, an offer they declined) are confirmed with a short note. Old links show a friendly page; the scheduling run stops at its next step. Leaving a decision before they were told (a withdrawal, review anyway, a corrected outcome) withdraws a decision message still queued. A person can take back a decision nobody told (`undo_decision`, plan G1; not while a message is on its way or waiting for approval, not on a closed role): the application goes back to the step the decision was made from, made safe (a screen or interview the decision called off is not reopened, so `triaged` or `interview_recommended`), nothing is sent, and the untold safety net no longer counts it; a later decline is a new decision |
| Untold decisions (founder decision B6, Q27) | A decision nobody has told the candidate about for two working days or more (open or closed role, no message waiting for approval) raises the `decisions_untold` reminder: one in-app notification to owners, admins and hiring managers, never an email or a recruiter, and the role's "not told yet" card on Today until they are told. At five working days (company time zone, its contact days, ITS holidays) the daily safety net (`runUntoldSafetyNet`, plan G3) acts once per decision: under `disposition.send` = auto or auto_notify the standard message goes through the same gate and the team is told (`message.untold_sent`); under approval or human_only, during a recruiter takeover, or with no email address on file, nothing is sent and one `candidate_issue` recruiter request per role is raised (`recruiter.untold_brought_in`). Each is recorded as `application.untold_fallback`. Someone whose details were deleted at their request is left out of the reminder, the safety net and the closing message. A decision message whose send was interrupted (`unknown`) or that bounced for good puts the decision back to not told, so it shows again |
| Duplicate candidates | Dedupe on normalized email and phone at intake; fuzzy matches flagged for recruiter merge; the same person applying to the same role updates the application rather than creating a second |
| Missing information | Steps declare required facts; missing facts produce a targeted request to the candidate or owner and a `wait`, never an invented value |
| AI uncertainty | Confidence low or unknowns critical → the workflow routes to "needs review" instead of acting; refusals are treated as "needs human" |
| Human override | Any human action on a waiting run is recorded as `human.override` with the actor and the prior proposal; the run continues from the human's state |
| Integration failure | Adapter status flips to `error`; health check job retries; affected steps wait with a visible reason; Setup shows the integration as needing attention |
| Worker crash | Jobs are leased with `locked_at`; leases expire and jobs are re-claimed; steps are idempotent, so re-execution is safe |

## The policy engine

`packages/core/src/policy.ts`. Levels: `auto` (execute and log), `auto_notify` (execute, log, notify, easy undo where possible), `approval` (create an approval request; wait), `human_only` (never executed by the system; the UI presents information and the human acts).

Resolution order: role policy → company policy → platform default. Takeover overlays a temporary policy layer. Policies are rows; the UI edits them ("What may the AI do on its own?") per company and per role. Changing a policy is `human_only` (owner or admin) and audited.

**Platform defaults**

| Action type | Default | Approver |
|---|---|---|
| `role_packet.propose` | auto | |
| `role_packet.approve` | approval, always (a floor and a ceiling: never auto, never human_only) | owner, admin, hiring_manager |
| `role.publish` | auto | |
| `posting.sponsor_spend` | auto within budget; approval above | owner, admin |
| `message.send_templated` (acknowledgment, reminders, confirmations) | auto | |
| `message.send_freeform` (answers to candidate questions) | auto_notify | |
| `application.triage` | auto (information) | |
| `application.reject_ineligible` (owner-authored eligibility rules) | auto_notify with 24h review window | |
| `application.reject_on_assessment` | human_only | |
| `application.invite_screen` | auto_notify | |
| `screen.conduct` | auto (with consent) | |
| `application.recommend_interview` | auto_notify (recommendation only) | |
| `interview.request` (advance to interview) | approval | owner, hiring_manager, recruiter |
| `interview.schedule` / `interview.reschedule` | auto / auto_notify | |
| `interview.record` | approval (consent of all parties) | interviewer + candidate |
| `scorecard.draft` | auto (information) | |
| `debrief.recommend` | approval (recommendation) | owner, hiring_manager |
| `candidate.hire_decision` | human_only | |
| `offer.draft` | approval (never lower) | owner, admin |
| `offer.send` | approval (never lower) | owner, admin |
| `offer.negotiate` | human_only | |
| `offer.revise` | approval (never lower) | owner, admin |
| `disposition.send` (the decision message a person sends after a private decision; founder decision B6) | auto | Declining never sends anything by itself. Auto: the message goes when a person presses Send (after a 30-second Undo window); approval: it waits for a second person; human_only: the product sends none and the team tells candidates themselves. Also governs the untold safety net (Q27: under auto, the standard message goes by itself five working days after the decision; otherwise, or during a takeover, a recruiter is brought in and nothing is sent) and the closing message of a closed role (Q30: one gate, one approval for the group) |
| `message.still_reviewing` (plan G10) | human_only (off; founder decision of 9 October 2026: nothing is sent unless a company switches it on, and a saved company or role row keeps its level), `afterDays` 30 | Under auto or auto_notify: one "still reviewing" note, with the AI disclosure, to someone still waiting for a decision that many days after applying, sent within a week of reaching it (missed daily runs are made up for that long; an older wait is never noted, so turning it on never writes to a backlog); any other level sends none |
| `reference.request` | auto_notify | |
| `background_check.order` | approval | owner, admin, hr |
| `background_check.adverse_action` | human_only | |
| `employee.create_in_hris` | auto_notify | |
| `welcome.send`, `checkin.request` | auto | |
| `policy.change`, `knockout_rule.change`, `notice_text.change` | human_only | owner, admin |
| `data.delete`, `data.export` | human_only | owner, admin, hr |
| `intervention.nudge` | auto | |
| `intervention.offer_recruiter` | auto_notify | |
| `sourcing.search_internal` | auto | |
| `sourcing.enrich_external` | auto within credits | |
| `outreach.send` | auto_notify | |

## The candidate (application) state machine

States: `applied`, `received`, `ineligible`, `eligible`, `triaged`, `screen_invited`, `screening`, `screen_complete`, `interview_recommended`, `interview_scheduled`, `interview_complete`, `debrief`, `finalist`, `reference_check`, `offer_draft`, `offer_approval`, `offer_sent`, `negotiation`, `accepted`, `declined`, `hired`, `onboarding`, `withdrawn`, `rejected`, `talent_pool`.

| From → To | Moved by | Requires | Emits |
|---|---|---|---|
| (new) → `applied` | system on any intake | | `application.received` |
| `applied` → `received` | system after acknowledgment | | `application.acknowledged` |
| `received` → `eligible` / `ineligible` | system (deterministic rules) | packet eligibility rules | `eligibility.evaluated` |
| `ineligible` → `rejected` | system after review window (policy `application.reject_ineligible`) or owner/recruiter | window elapsed with no override | `application.rejected` (reason `eligibility`) |
| `ineligible` → `eligible` | owner, recruiter (override) | | `human.override` |
| `eligible` → `triaged` | system (assessment created) | | `application.triaged` |
| `triaged` → `screen_invited` | system (policy `application.invite_screen`) or owner/hiring_manager/recruiter | channel and consent | `screen.invited` |
| `screen_invited` → `screening` | system on first candidate reply | | `screen.started` |
| `screen_invited` → `triaged` | owner, admin, hiring_manager, recruiter ("Stop this screen invitation", plan A7) | the candidate has not started; they get a short, polite note | `screen.cancelled` |
| `screening` → `screen_complete` | system | | `screen.completed`, `screen.assessed` |
| `screen_complete` → `interview_recommended` | system (recommendation) or human | | `candidate.recommended` |
| `triaged`/`screen_complete`/`interview_recommended` → `interview_scheduled` | owner, hiring_manager, recruiter approve `interview.request`; system books | approval | `interview.requested`, `interview.scheduled` |
| `interview_scheduled` → `interview_complete` | system after the interview ends | | `interview.completed` |
| `interview_complete` → `interview_scheduled` | system (next round in the plan) | | |
| `interview_complete` → `debrief` | system when the plan's last round completes and scorecards are in | | `debrief.completed` |
| `debrief` → `finalist` | owner, hiring_manager (decision) | human | `candidate.finalist` |
| `finalist` → `reference_check` | owner, hr, recruiter | | `reference.requested` |
| `finalist`/`reference_check` → `offer_sent` | "Offer made", record-only (Q29, plan H2): owner, admin, hiring_manager, hr (`outcome.record`); the offer was made outside the app, which writes, approves and sends nothing | human | `offer.created` (`madeOutside`), `application.stage_changed` |
| `offer_sent` → `hired` / `declined` | the answer recorded by a person as an outcome: accepted with the start date (the hire sheet, plan H1), or turned down (`offer_declined_externally`) | human | `outcome.recorded`, `offer.accepted` / `offer.declined` |
| `finalist`/`reference_check` → `offer_draft` | system (Offer agent) or human | | `offer.created` |
| `offer_draft` → `offer_approval` | system | | `offer.approval_requested` |
| `offer_approval` → `offer_sent` | owner/admin approves `offer.send`; system sends | approval | `offer.approved`, `offer.sent` |
| `offer_sent` → `negotiation` | system on counter | | `offer.counter_received` |
| `negotiation` → `offer_sent` | human revises; approval | approval | `offer.revised`, `offer.sent` |
| `offer_sent`/`negotiation` → `accepted` | candidate (signature or click-to-accept) | | `offer.accepted` |
| `offer_sent`/`negotiation` → `declined` | candidate, or owner on expiry | | `offer.declined` |
| `accepted` → `onboarding` | system (onboarding started) | | `onboarding.started` |
| `onboarding` → `hired` | manager confirms start | human confirmation (or auto after start date + 2 days with no no-show report, policy) | `start.confirmed` |
| any active → `withdrawn` | candidate, or human on the candidate's behalf | | `application.withdrawn` |
| `rejected`/`talent_pool` → `withdrawn` | candidate only (status page) | the decision was never told to them (plan A1) | `application.withdrawn` |
| any active → `rejected` | owner, hiring_manager, recruiter (human decision) | human (except the eligibility path) | `application.rejected` with reason code |
| `rejected`/`declined`/`withdrawn`/(role closed) → `talent_pool` | system per packet policy, or human | candidate not opted out | `application.moved_to_talent_pool` |

**Inactivity.** Any stage waiting on the candidate for more than the packet's `inactivity_days` (default 10) sets `inactive_at`, sends one re-engagement message, and after another 7 days moves to `talent_pool` with reason `unresponsive`, notifying the owner. The candidate can reactivate by replying.

**Withdrawal.** Cancels all waiting runs and interviews for the application, sends a courteous confirmation, records the reason if given, keeps the record for retention purposes, and offers the talent pool.

**Role closed or filled.** Active applications move to `talent_pool` (kept unless opted out), privately: their interviews and screens end and nobody is told the decision until a person sends the decision message (founder decision B6; policy `disposition.send`). Someone who held a booked time or was offered times is told at once, in a short note that gives no reason, that the interview is off. The close answers with a count and a preview of one courteous closing message for everyone left untold (Q30, template `disposition:role_closed`, key `role_closed:<application>`), sent with one Send or one approval for the whole group; nobody is told twice.

## Implementation notes (kept in sync with code)

- Intake conversation turns run synchronously in the API request (`POST /api/v1/intake/...`) so the owner gets the reply immediately; the durable workflow `role_approval` (`packages/workflows/src/definitions/role-approval.ts`) owns everything after compile: the approval wait, opening the role, and starting `publish_role`. The catalog entry `intake_to_packet` above describes the combined behavior.
- `publish_role` and `application_intake` are implemented as described. Slice 2 added the triage steps to `application_intake` (`ready` assesses; `after_triage` applies `application.invite_screen`), the `screen` workflow (`definitions/screen.ts`: invite → after_invite → remind → after_remind → expire, and completed → assess → recommend under `application.recommend_interview`), and `stuck_role_detector` (`definitions/stuck-role-detector.ts`, one run per company started at signup, detects daily and applies the ladder in `packages/agents/src/orchestrator.ts`). `schedule_interview`, `interview_cycle`, `offer`, `onboarding`, and the full `escalation` workflow (with takeover) arrive with their slices; the minimal escalation (create, notify, claim, resolve) is a service in `packages/core`.
- Screening turns run synchronously when the candidate writes (`runScreenTurn` in `packages/agents/src/screening.ts`, called by the web chat page and the SMS webhook) and signal the `screen` run (`screen:<id>:started|completed|human`). HUMAN and WITHDRAW are handled in code before any model call; `enforceTurnRules` caps follow-ups at two per question and bounds the conversation; `redactProtected` keeps volunteered protected details out of recorded answers (the transcript stays the record).
- A plan limit (`text_screens`) never fails the `screen` run and never pages a recruiter: the owner is told once, ITS gets an alert (and one at 80%), and the run waits for the allowance to be topped up before it sends the link (founder decision Q17). A conversation counts at its first answer.
- Engine mechanics (`packages/workflows/src/engine.ts`): Postgres-backed queue with `FOR UPDATE SKIP LOCKED` leases, per-step ledger, human/event/timer waits keyed for `signal()`, exponential backoff, and an escalation on final failure. An event wait may carry `until`, so a step can wait for "the candidate replies, or 48 hours pass"; every wait carries a token and a stale timer from an earlier wait is ignored.
