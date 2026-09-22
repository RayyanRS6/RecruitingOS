# 15. Scenario steps 11 to 16: definitions, what is built, what is deferred

Written 18 September 2026 in answer to the founder's instruction to resolve the six remaining scenario placeholders. Steps 11 to 13 fall inside release 1 (the PRD's steps 10 to 13: interview approval, scheduling, audit history, escalation) and are built and tested. Steps 12's recording and scorecard, 13's debrief, and steps 14 to 16 fall outside release 1 by the founder's own scope (`01` §3, decision A1) and are formally deferred here with reason, risk, owner and target release. No security, privacy, tenant-isolation, authentication, communication, scheduling, accessibility or audit test is deferred: every release-1 behaviour those steps touch is covered in `tests/scenario/lifecycle.test.ts` and the suites named below.

Each step is defined with the sixteen fields the founder asked for.

## Step 11. Scheduling (built)

- **User:** the owner or hiring manager (approval); the candidate (picks a time); interviewers (receive it).
- **Trigger:** the owner chooses "Interview" on a candidate at triaged, eligible, screen invited, screening, screen complete, interview recommended or interview complete.
- **Preconditions:** an approved packet with an interview plan; interviewers who are active members; no interview already in motion for the application.
- **Workflow:** `schedule_interview` (`06` §schedule_interview): prepare → propose slots → offer → wait 48 h → remind → wait 48 h → expire, or book → confirm → reminders at −24 h and −2 h → close at end + 1 h.
- **Human approval:** policy `interview.request` at level approval and never lower (`MIN_LEVELS`); the owner's click is the approval and is recorded as `human.override` with the round and interviewers.
- **AI action:** none. Slot computation is deterministic; messages are templates.
- **Data changes:** `interviews` (status, window, offered and selected slots, attempt, times, calendar references without secrets, reminders), `interview_participants`, `interviewer_availability`, `integrations` (calendar connection state), `communications`.
- **Audit events:** `interview.requested`, `human.override`, `interview.slots_offered`, `interview.slots_reminded`, `interview.slot_selected`, `interview.slot_taken`, `interview.booked`, `interview.confirmed`, `interview.reminder_sent`, `interview.completed`, `interview.rescheduled`, `interview.cancelled`, `interview.offer_expired`, `interview.candidate_availability`, `calendar.event_created`, `calendar.event_cancelled`, `calendar.needs_attention`, `availability.updated`; secret reads audited as `secret.read` with purpose `calendar_sync` or `calendar_booking`.
- **Communications:** slots email (disclosed, times in the candidate's zone), reminder, confirmation with the iCalendar invitation, −24 h and −2 h reminders, cancellation; interviewers get in-app notifications and a confirmation email.
- **Failure states:** nobody's availability known (team asked, waits on `availability.updated`); no common time (owner asked, waits on a wider window); candidate unreachable by email (owner told, book-on-behalf offered); chosen time taken (re-offer; three strikes → owner told and a recruiter escalation); calendar credential revoked (declared hours take over, the person is told); calendar event cannot be created or removed (person told to do it by hand); offer unanswered (reminder, then expiry with owner actions).
- **Retry behavior:** transient calendar and email errors fail the step as retryable; the engine retries with backoff up to five attempts, then escalates as `candidate_issue`.
- **Cancellation:** owner or candidate; events removed by the worker (idempotent); candidate told; stage returns to interview recommended; the run ends by attempt number.
- **Security requirements:** the schedule token is 192-bit, single-purpose, expires with the offer; calendar credentials live only in the secret store and are read by the worker for a stated purpose; interviewers never see pay; the candidate page reveals only first names.
- **Accessibility requirements:** the candidate pages work without JavaScript, by keyboard alone (radio group, labelled controls, focus visible), in the candidate's zone; axe WCAG 2.1 AA clean.
- **Tests:** `apps/api/src/scheduling.test.ts` (9 scenarios), `packages/core/src/scheduling.test.ts`, `packages/integrations` calendar tests, `tests/scenario/lifecycle.test.ts` step 11, `tests/e2e/specs/journey.spec.ts`.
- **Release gate:** release 1; verified with the fake calendar; the Google adapter is verified against a real project in staging before a design partner connects a calendar.

## Step 12. Interview (release-1 part built; recording and scorecards deferred)

- **User:** interviewers; the owner.
- **Trigger:** a booked interview approaches and takes place.
- **Preconditions:** step 11 complete.
- **Workflow (release 1):** the confirmation gives each interviewer the round, time, link and candidate name; the −24 h and −2 h reminders reach interviewers; at end + 1 h the interview closes, the interviewer is asked "did it take place?" and the owner "how did it go?"; the outcome (happened, candidate no-show, interviewer no-show) is recorded by a person.
- **Human approval:** outcome and every decision are human; nothing is inferred from silence.
- **AI action (release 1):** none. **Deferred:** consented recording, transcript, and a draft scorecard confirmed by the interviewer (`interview.record` policy, approval level, interviewer approves).
- **Data changes:** `interviews.outcome`, `interviews.status` (completed or no_show); `applications.stage` interview complete.
- **Audit events:** `interview.completed`, `interview.outcome_recorded`.
- **Communications:** interviewer confirmation email and reminders; owner and interviewer notifications at close.
- **Failure states:** no outcome recorded (the stuck-role detector's `decision_pending_after_interview` reminder, `06`).
- **Retry behavior:** notifications are idempotent per interview and attempt.
- **Cancellation:** as step 11.
- **Security requirements:** interviewers see only their interviews and the candidate's application without compensation.
- **Accessibility requirements:** the Interviews page and sheet pass axe; outcome buttons are labelled and reachable by keyboard.
- **Tests:** `tests/scenario/lifecycle.test.ts` step 12 (release-1 part), `apps/api/src/scheduling.test.ts` (outcome), `tests/e2e`.
- **Release gate:** release 1 for the built part. **Deferral record for recording and scorecards:** reason: outside the founder's release-1 scope (`01` §3) and the founder's current restriction "do not activate interview recording"; risk: none to release 1 (the interview happens and is recorded as an outcome; evaluation notes live outside the product until release 2); owner: Nadine (scope), Claude (build); release: 2.

## Step 13. Decision and finalist (release-1 part built; debrief deferred)

- **User:** the owner or hiring manager.
- **Trigger:** an interview is complete.
- **Preconditions:** step 12's outcome recorded or the interview closed.
- **Workflow (release 1):** `POST /applications/:id/decision`: next round (returns the next round key for a new interview approval), finalist (stage finalist), not moving forward (a reason is required; the decline message follows the human decision under `disposition.send`). "Hired" is refused in release 1 because offers are release 2.
- **Human approval:** the decision is only ever a person's (`human.override` recorded); the AI never proposes it.
- **AI action (release 1):** none. **Deferred:** debrief that shows disagreements between scorecards and the calibration memory.
- **Data changes:** `interviews.decision`, `decision_note`; `applications.stage`; `applications.reject_note`.
- **Audit events:** `interview.decision_recorded`, `human.override`, `application.rejected` (with `afterInterview: true`).
- **Communications:** decline message after a human decision only; finalist gets no automated message in release 1 (the owner talks to them).
- **Failure states:** no next round in the plan (409 with guidance); decline without a reason (400).
- **Retry behavior:** not applicable (synchronous human action).
- **Cancellation:** a finalist can still be declined later with a reason.
- **Security requirements:** only owner, admin, hiring manager or recruiter; audited.
- **Accessibility requirements:** the candidate sheet's decision controls are labelled buttons.
- **Tests:** `tests/scenario/lifecycle.test.ts` step 13, `apps/api/src/scheduling.test.ts`, `packages/core/src/core.test.ts` (human-only decisions).
- **Release gate:** release 1 for the built part. **Deferral record for the debrief:** reason: depends on scorecards (release 2); risk: none to release 1; owner: Nadine (scope), Claude (build); release: 2.

## Step 14. Offer (deferred)

- **User:** owner; candidate. **Trigger:** finalist decision. **Preconditions:** approved compensation ceiling in the packet. **Workflow:** draft within the ceiling → owner approval → send → accept, decline or counter (counter is human; `offer.negotiate` hard human-only). **Human approval:** `offer.approve` approval level; five human-only post-interview actions (F9). **AI action:** drafting the letter from the packet's approved terms only. **Data changes:** `offers`. **Audit events:** `offer.*`. **Communications:** offer email with e-signature link. **Failure states:** amount above ceiling refused; expiry. **Retry behavior:** idempotent sends. **Cancellation:** rescind by a person with reason. **Security:** compensation visible only with `compensation.read`; signed documents in object storage under a per-tenant prefix. **Accessibility:** offer pages meet the same bar as candidate pages. **Tests:** to be written with the feature. **Release gate:** release 2.
- **Deferral record:** reason: outside release-1 scope (`01` §3); risk: none to release 1 (offers happen outside the product; the product records the decision); owner: Nadine; release: 2.

## Step 15. Onboarding (deferred)

- Handoff packet or HRIS creation, reminders, 30/60/90 outcomes; `onboarding.*` and `outcome.recorded` events. **Deferral record:** reason: release 3 by scope; risk: none to release 1; owner: Nadine; release: 3.

## Step 16. Recruiter takeover (deferred; scoped access built)

- A recruiter operates the role under a policy overlay and hands it back. Release 1 already has the part that matters for safety: explicit, scoped, time-limited access after accepting an escalation, every request recorded, access ended on release or resolution (`staff-access.test.ts`, `queue-preview.test.ts`). **Deferral record for the overlay and handback:** reason: release 3 by scope; risk: none to release 1 (recruiters act through the same product as the owner, under the same policies); owner: Nadine; release: 3.
