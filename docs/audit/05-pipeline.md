<!-- Part of the Recruiting OS product audit (docs/product-audit.md), 14 October 2026. Written by one reader from the code at origin/main dafb730 and checked by a second, skeptical reader who tried to refute every bug and status; corrections are listed under the verification notes. Working files mentioned as 'scratchpad' are not in the repository. -->

# Pipeline, match score, pool board, evidence, decisions and telling candidates

Audit of the reviewing side of Recruiting OS (branch kanvis-reaudit = origin/main dafb730, 14 Oct 2026). Read-only. Source code, migrations and tests were treated as the truth; docs were used as leads. No tests were run and no browser was used. All behaviour described here is verified against code paths that run on fake providers in tests; nothing in this area is proven on the real model or on production data (docs/STATUS.md says the same).

## 1. Summary

The owner's review side is complete and consistently wired from screen to database. An application is read by the AI three times. Code keeps the middle answer of the three, checks every quote against the résumé, and turns any "not met" that has no checked quote into "not known". The 0-100 match score is then worked out by code, never by the AI. It uses fixed weights: a must-have counts 4, an Essential skill 3, an Important skill 2, a Helpful skill 1. Anything not known is left out of the score. A must-have that the candidate's own words show is missing caps the score at 54. The score is recomputed every time it is shown and is never stored.

The Talent page shows a stage strip with counts, private marks, a list that can be sorted by score, a pool board ("Sort the pool") that suggests Shortlist, Longlist or Not moving forward with a reason for each person, "Review and apply" for up to 50 people, rule-based "Ask about this pool" questions, and Compare for up to five people. Decisions are private: declining or moving someone to the talent pool sets a "told state" of not told. A person then sends one of the approved wordings (with a 30-second Undo), records "I told them myself", or takes the decision back quietly.

**What the AI decides on its own.** No software path ever declines a candidate: a decline needs a person (packages/core/src/stages.ts:133 and the hard "only a person" list in policy.ts:40-51). Under the default settings the AI does move people forward without a click:
- it invites a candidate to the screening conversation after a "screen" reading (policy.ts:74, application-intake.ts:306-314);
- it marks someone "recommended for interview" after a strong scorecard (policy.ts:76, workflows/definitions/screen.ts:424-429).

Interviews always need a person's approval (policy.ts:14-20).

**What is sent without a click.** The only message about a decision that goes out without anyone pressing Send is the "untold safety net". If nobody tells a declined (or talent-pooled) candidate within 5 working days, and the company's decision-message setting is the default "Do it", the standard decline email goes by itself (decision-messages.ts:251-314). Under the other settings, or during an ITS takeover, an ITS recruiter is brought in instead. Several screens and notifications still say that nothing is sent until a person sends it, which is not true under the default (see section 9).

**Main gaps found:**
- The "Not a fit for now" mark exists in the API and the data but no screen can set it.
- The batch API's extra actions (On hold, invite to screen, ask a recruiter) are not offered in the Review and apply window.
- The screening scorecard is read once, not three times, and skips the expired-licence rule. Yet its findings override the résumé reading's in the score.
- Compare's per-requirement cells follow the score, but its "Still unknown" count and the quotes in the board's "Compare these" answer use a different rule and can disagree with the cells (low).
- A skill marked to be judged only in the interviews (by the owner in the role editor, or by the requirements check's "Ask about it in the interview instead" fix) is still read from résumés and still moves the score.
- Several stages (references, offer drafting and approval, negotiation, onboarding) are defined but nothing ever reaches them.

## 2. Feature inventory

| id | feature | status | who | evidence |
|---|---|---|---|---|
| PIPELINE-01 | Application state machine (25 internal stages, who may move whom) | fully_implemented | system, all team roles, candidate | packages/core/src/stages.ts:13-52 `T`, `canTransition` :129-139, `transition` :158-200 |
| PIPELINE-02 | Stage strip with counts (New, Longlist, Shortlist, Interviewing, Cancelled, On hold, Offer, Hired, Not moving forward) plus "Still applying", "Waiting on you" and "Not told yet" | fully_implemented | owner, hiring manager, HR, ITS recruiter | GET /api/v1/roles/:id/applications?counts=1 (apps/api/src/routes/roles.ts:367-459); `ownerStage`/`groupFor` stages.ts:269-304; apps/web/src/talent-list.ts `stripItems`; apps/web/src/pages/People.tsx:218-236 |
| PIPELINE-03 | Stage button on each row and in the candidate panel (every stage listed, with the reason when it can't be chosen) | fully_implemented | owner, hiring manager, HR, recruiter | application-actions.ts `stageMoves` :209-254; apps/web/src/talent-actions.ts `stageIntent` :331-352; People.tsx `TalentRow` :302-339 |
| PIPELINE-04 | Private marks: Longlist, Shortlist, On hold (ends on a date, 14 days by default, 56 at most; the person returns to Today when it ends) | fully_implemented | owner, hiring manager, HR, recruiter | packages/core/src/marks.ts `setMark`/`holdUntil`; migration 0026 `application_marks`; POST /applications/:id/actions set_mark/hold/clear_mark (application-actions.ts:575-591); orchestrator.ts hold_ended detector |
| PIPELINE-05 | "Not a fit for now" mark (shows as Not moving forward without being a decline) | partial | owner (in principle) | Accepted by the API (contracts MarkKind; marks.ts) and counted in the role report (role-report.ts:327). Not offered by the stage button (`stageMoves` lists only longlist/shortlist/on_hold) or by Review and apply (board-model.ts `ReviewAction = BoardColumn`). No web code sets it (only display labels in candidate-panel/helpers.ts:209) |
| PIPELINE-06 | Talent list: filter by reading, waiting on you, told state, still applying, cancelled reason; search; sort by score, newest, waiting longest or name | fully_implemented | owner, hiring manager, HR, recruiter | apps/web/src/talent-list.ts `applyView`/`orderRows`/`readingOf`; roles.ts:367-459 (`order=score`) |
| PIPELINE-07 | Résumé reading (triage): three readings, the middle answer kept, written finding definitions (FINDING_RULES), fairness rules, no number from the AI | fully_implemented | system/AI; read by the team | packages/agents/src/triage.ts `TRIAGE_READINGS` :48, `assessApplication` :64-75, `combineReadings` :134-151; packages/ai/src/prompts/registry.ts `FINDING_RULES` :50-57, `FAIRNESS_RULES` :37-42; prompts/triage.ts v3; routing.ts:94 (effort high) |
| PIPELINE-08 | Evidence rules: quotes checked against the source; an unchecked claim dropped; "no" without a checked quote becomes "unknown"; expired-credential rule; confidence steps down | fully_implemented | system | triage.ts `applyEvidenceRules` :218-268, `verifyAssessmentQuotes` :158-167, `shownNotHeld` :181-188 |
| PIPELINE-09 | "Needs a closer look", "Read this one yourself" (low confidence) and the reading consistency check before any automatic step | fully_implemented (minor drift between the web copy of the rule and core, bug B6) | owner; system gate | packages/core/src/evidence.ts `evidenceView`, `readingConsistency` :92-111; application-intake.ts `after_triage` :272-316; web mirror apps/web/src/evidence.ts `closerLook` |
| PIPELINE-10 | AI-started forward moves: automatic screening invitation; automatic "recommended for interview" | fully_implemented (policy-controlled) | system/AI; owner notified | policy.ts:74,76 (auto_notify); application-intake.ts:306-314; workflows/definitions/screen.ts:403-438 |
| PIPELINE-11 | 0-100 match score with bands, coverage, points-lost breakdown, cap at 54 for a proven missing must-have | fully_implemented | owner, hiring manager, HR, recruiter | packages/core/src/match-score.ts `matchScore` :108-146; contracts/domain/match.ts:34-43,99-104; candidate-panel/match.tsx + match-view.ts |
| PIPELINE-12 | Must-have line ("Must-haves: 3 of 4 shown, 1 not yet known") and red "Missing must-have" chip | fully_implemented | team | match-score.ts `mustHaveSummary` :159-174; board-model.ts `cardChip`; match-view.ts `missingMustHaves` |
| PIPELINE-13 | Label when a candidate was read against an older version of the role ("read against version N") | fully_implemented | team | match-score.ts `readingVersion` :180-186; pool.ts `scorePerson` :78-91 |
| PIPELINE-14 | Pool board ("Sort the pool"): Shortlist / Longlist / Not moving forward, the reason, the next step, "Needs your eye" | fully_implemented | owner, hiring manager, HR, recruiter | packages/core/src/board.ts `boardPlacement` :102-185; GET /api/v1/roles/:id/board (roles.ts:516-522); apps/web/src/pages/board/PoolBoard.tsx |
| PIPELINE-15 | Pool summary sentences, "stricter than needed?" note, Today pool card | fully_implemented | owner | packages/core/src/pool-summary.ts `poolSummary` :43-94; pool.ts `boardView`; brief.ts (Today) |
| PIPELINE-16 | Review and apply (Shortlist, Longlist, Not moving forward, up to 50; preview first, then one transaction per person) | fully_implemented | owner, hiring manager, recruiter (HR without Not moving forward) | POST /api/v1/roles/:id/batch (roles.ts:530-537); apps/api/src/services/review-apply.ts `previewBatch`/`applyBatch`; apps/web/src/pages/board/ReviewApply.tsx |
| PIPELINE-17 | Batch extras: On hold, invite to screen, ask an ITS recruiter, through Review and apply | partial | owner | Supported by the API (contracts/api/board.ts:94 BatchAction; review-apply.ts:26-27, 155-212); the UI only sends the three column actions (board-model.ts:178, `previewItems`, `batchItems`) |
| PIPELINE-18 | "Ask about this pool" one-click questions (missing must-have, strongest evidence per must-have, who might be overlooked, compare) | fully_implemented | owner, hiring manager, HR, recruiter | pool-summary.ts `poolQuestions`/`answerPoolQuestion` :113-180; GET /roles/:id/questions[/:kind] (roles.ts:540-581); board/AskPool.tsx |
| PIPELINE-19 | Free-text questions about the pool | planned_not_implemented | owner | board-model.ts `ASK_SOON` "Typing your own question is not available yet"; AskPool.tsx:74 |
| PIPELINE-20 | Compare up to 5 candidates side by side (findings, score, notes) | fully_implemented (cells follow the score via compare-view.ts `criterionCell`; the "Still unknown" row can disagree, bug B2) | owner, hiring manager, HR, recruiter | apps/api/src/routes/compare.ts `compareCandidates`; GET /roles/:id/compare; pages/compare/ComparePanel.tsx, compare-view.ts |
| PIPELINE-21 | Private decisions: decline with a fixed reason, move to talent pool; told state | fully_implemented | owner, hiring manager, recruiter (decline); HR (talent pool only) | application-actions.ts reject :531-544, move_to_talent_pool :563-574; stages.ts `DECISION_STAGES`, told state patch :172; migration 0026 |
| PIPELINE-22 | Send the decision message: approved wordings, checked personal line, preview, 30-second Undo, approval policy | fully_implemented | owner, hiring manager, recruiter | application-actions.ts `sendDecisionMessage` :369-382; packages/agents/src/decision-messages.ts `queueDecisionMessage`/`decisionMessageDraft`; coordinator.ts `DECISION_SENTENCE` :163-171; candidate-panel/telling.tsx |
| PIPELINE-23 | Bulk "Review and send" to everyone not told on a role | fully_implemented | owner, hiring manager, recruiter | POST /roles/:id/decision-messages (roles.ts:467-476); `sendDecisionMessages` application-actions.ts:658-676; People.tsx `TellSheet` |
| PIPELINE-24 | "I told them myself" (withdraws any queued message or waiting approval) | fully_implemented | owner, hiring manager, recruiter | application-actions.ts told_in_person :597-607 |
| PIPELINE-25 | Quiet undo of a decision nobody told | fully_implemented | owner, hiring manager, recruiter | stages.ts `reopenStage` :77-107, `canTransition` undoDecision; application-actions.ts undo_decision :626-641, `undoFacts` |
| PIPELINE-26 | Untold safety net: reminder after 2 working days; after 5 the standard message goes by itself under "Do it", otherwise an ITS recruiter is brought in | fully_implemented | system; owner told | orchestrator.ts:28-30, `untoldDecisions` :87-95; decision-messages.ts `runUntoldSafetyNet` :251-314; stuck-role-detector.ts:34; telling.ts `safetyNetLine` |
| PIPELINE-27 | One closing message for everyone a closed role left in the talent pool | fully_implemented | owner, hiring manager, recruiter | GET/POST /roles/:id/closing-message (roles.ts:485-505); decision-messages.ts `closingAudience`/`queueClosingMessages`; components/ClosingMessage.tsx |
| PIPELINE-28 | Held on an eligibility answer: hold, daily reminder, ITS escalation at 72h, "Keep them in" (reason required), decline with the eligibility wording, "Review anyway" | fully_implemented | owner; system reminders; ITS recruiter | application-intake.ts `eligibility`/`ineligible_review` :132-194; application-actions.ts override_eligibility :545-553, review_anyway :554-562; needs-you.tsx:535-560 |
| PIPELINE-29 | "Ask about this in a screen" (screen opened with the reading's open questions) and "Stop this screen invitation" | fully_implemented | owner | application-actions.ts invite_screen/ask_in_screen :608-616, cancel_screen :617-625; intelligence.test.ts |
| PIPELINE-30 | "Something wrong?" flag on an AI reading, sent to the ITS review queue | fully_implemented | owner/team → ITS recruiter | POST /applications/:id/assessments/:assessmentId/flag (roles.ts:796-835); candidate-panel/assessment.tsx:55 |
| PIPELINE-31 | Private team notes (one per person per candidate, earlier versions kept, never shown to candidates or the AI) | fully_implemented | owner, admin, hiring manager, HR, ITS recruiter; interviewer (own note only) | migration 0034; apps/api/src/services/notes.ts; routes/notes.ts; candidate-panel/notes.tsx |
| PIPELINE-32 | Decision after an interview: next round, finalist, not moving forward, hired | fully_implemented | owner, admin, hiring manager, recruiter (interview.decide) | POST /applications/:id/decision (routes/interviews.ts:363-432) |
| PIPELINE-33 | "Offer made", recorded only (the app never writes or sends an offer) | fully_implemented | owner, admin, hiring manager, HR (outcome.record) | POST /applications/:id/offer (roles.ts:898-912); services/offers.ts `recordOfferMade`; candidate-panel/hiring.tsx:47 |
| PIPELINE-34 | Hire sheet: start date, backups to keep warm, close the role; Today "keep your backups warm" card | fully_implemented | owner, admin, hiring manager, HR | services/hire-sheet.ts `hireFollowUp`/`backupsWarmCards`; core/outcomes.ts `recordApplicationOutcome`, `recordRoleOutcome` |
| PIPELINE-35 | Outcome records and administrator corrections (the original row is kept) | fully_implemented | owner etc.; platform admin corrects | core/outcomes.ts `correctOutcome`; POST /api/v1/admin/outcomes/:id/correct (admin.ts:516); Admin.tsx:711-745 |
| PIPELINE-36 | Role report: figures, AI suggestions vs human decisions, marks, told counts, how the pool meets the must-haves; CSV downloads | fully_implemented | owner, hiring manager, HR, recruiter | services/role-report.ts; routes/reports.ts; pages/RoleReport.tsx |
| PIPELINE-37 | Requirements check before approval (rule-based suggestions with one-tap fixes) | fully_implemented (fix side effect, bug B3) | owner, hiring manager | packages/agents/src/requirements-check.ts; GET/POST /roles/:id/requirements-check[/apply] (role-packets.ts:379-425) and the same on job-builder drafts (/intake/sessions/:id/requirements-check, apps/web/src/pages/new-role/refine-api.ts:30-32) |
| PIPELINE-38 | In-app reference checks, offer drafting and approval, negotiation, onboarding stages | planned_not_implemented | — | Defined in stages.ts:37-51 and labelled in `STAGE_LABEL`; no route or workflow ever moves anyone to debrief, reference_check, offer_draft, offer_approval, negotiation, accepted or onboarding |
| PIPELINE-39 | "Still reviewing" courtesy note at 30 days (off by default) | fully_implemented | system | decision-messages.ts `sendStillReviewingNotes` :336-363; policy.ts:68 |
| PIPELINE-40 | Candidate status page keeps private data private (four steps; marks, scores and notes never shown; a decision shown only once told) | fully_implemented | candidate | stages.ts `candidateStep` :351-361, `mayWithdraw`; apps/api/src/pages/candidate.tsx:595,747 |
| PIPELINE-41 | "The system learns from it" (learning from overrides and flags) | planned_not_implemented | owner | The copy promises it (needs-you.tsx:535; application-actions.ts:547). The code only records events and counts them in the role report. roles.ts:791 says a flag "never retrains anything by itself" |
| PIPELINE-42 | AI suggestions waiting for a person's Yes / Not now ("Invite to a screen?", "Interview?") when a company sets "Ask me first"; they lapse after a week; acting on the candidate directly settles them | fully_implemented | owner, hiring manager (approvers); system | application-intake.ts:311 `waitForSuggestion`; screen.ts:430-431; approvals-escalations-events.ts:75-93 (approve starts the screen / moves to interview_recommended); application-actions.ts `settleSuggestions` :449-461; needs-you.tsx:39, 328-333 |
| PIPELINE-43 | "Record what happened" from the panel: "We declined the candidate" (a second, private decline path) and "No hire" (talent pool), with the interview-off note | fully_implemented | owner, admin, hiring manager (decline); HR (no hire, withdrawals) | POST /applications/:id/outcome (roles.ts:853-890; employer_declined also needs application.reject :857; exitCleanup "private_decision" :869); needs-you.tsx:275 |

## 3. Workflows traced step by step

**W1. From application to "Ready for your review"** (system/AI; packages/workflows/src/definitions/application-intake.ts)

1. acknowledge → validate the résumé (malware scan) → extract it (Haiku, quotes checked) → eligibility rules.
2. If an eligibility answer fails, the person is held. `gate(application.hold_ineligible)` sets reminders, and a notification says nothing will be sent. There is never an automatic decline (:132-194).
3. `ready`: `assessApplication` runs `triageAssessPrompt` three times in parallel, each at "high" effort (routing.ts:94).
4. Each reading goes through `applyEvidenceRules`, then `combineReadings` keeps the middle answer per finding (triage.ts:64-151).
5. One `assessments` row is written (kind "triage", `secondaryScore` null, `aiRunId` = the first reading's run) and the application moves to "triaged" (:250-260).
6. `after_triage`: "hold" means notify. "review_manually"/"unknown" means notify "needs a closer look" with the open questions. A "screen" recommendation goes through `readingConsistency`; if the reading is inconsistent it is held and audited. Otherwise `gate(application.invite_screen)` (default auto_notify) starts the screening workflow by itself and notifies the owner (:272-316).

**W2. Reviewing the list and sorting privately** (owner, hiring manager, HR, recruiter)

1. People.tsx loads GET /roles/:id/applications?counts=1.
2. Per row, the server builds `scorePerson` (match score, evidence view, board placement), `stageMoves`, the told state and the counts (roles.ts:367-459). Nothing is cached; it is all computed on each read.
3. The stage strip and filters are applied on the client (talent-list.ts).
4. A row's stage button calls `stageIntent`. Longlist or Shortlist goes straight to POST /applications/:id/actions {set_mark}. On hold opens a date step. Interviewing, Offer, Hired and Not moving forward open a step in the panel (talent-actions.ts:331-352).
5. Server: the row is locked with `FOR UPDATE`, then `performApplicationAction`, then `assertCan`. It checks `allowedApplicationActions`, settles any of the assistant's waiting suggestions, and calls `setMark` (one active mark, the old one cleared, `application.marked` event) (application-actions.ts:509-591).
6. The toast says "Private: the candidate was not told."

**W3. Pool board and Review and apply** (owner, hiring manager, recruiter; HR without declines)

1. "Sort the pool" → GET /roles/:id/board → `loadPool` (one query per kind of fact) → `boardPlacement` per person → `poolSummary` (pool.ts:122-234).
2. "Review and apply" builds rows from the suggested placements. Confident people start ticked. "Needs your eye" rows start unticked. A held eligibility row is locked. At most 50 (board-model.ts:209-234).
3. A preview POST /roles/:id/batch {dryRun:true} runs the same per-person rules as the candidate's own page and returns warnings and the pre-filled decline reason (review-apply.ts:92-128).
4. Apply POST /roles/:id/batch: each person gets their own transaction and row lock, then `performApplicationAction` with `via: review_and_apply`. Not moving forward = `reject` with the reason from the fixed list (pre-filled from their evidence, editable). Shortlist/Longlist = `set_mark` (source "board"). A `pool.batch_applied` event records what the board suggested and what the person chose (review-apply.ts:135-227).
5. Nobody is emailed at apply time. The 5-working-day safety net then applies to anyone declined.

**W4. Declining and telling** (owner, hiring manager, recruiter)

1. Not moving forward (panel step `decline`) → `{action:"reject", reason}` → `transition(to:"rejected")` (people only) → told state "not_told" → `exitCleanup`. The cleanup cancels screens, interviews and the assistant's suggestions. A candidate with a booked or offered interview gets a short "interview is off" note with no reason (exit-cleanup.ts). The answer includes a preview of the message.
2. The "Not told yet" card and chip appear. After 2 working days the owner gets a reminder on Today (orchestrator.ts:87-95).
3. Send: GET/POST decision-message preview → `{action:"send_decision", wording, personalLine}`. The personal line is checked (`checkPersonalLine`). `gate(disposition.send)` then either queues the message with `sendAt` = now + MESSAGE_UNDO_SECONDS (told state "queued", later "sent"), creates an approval request ("needs_approval"), or does nothing ("only a person") (application-actions.ts:369-382; decision-messages.ts:137-160).
4. Undo → POST /applications/:id/messages/:communicationId/undo.
5. Other ways out: "I told them myself" (told_in_person), "Take back this decision" (undo_decision, back to the step it was made from), "Review and send" in bulk (roles.ts:467).
6. Safety net: the daily stuck-role run calls `runUntoldSafetyNet`. At 5 working days under "auto" the standard wording is queued with no Undo window and the owner is notified who got it. Otherwise an escalation goes to ITS ("candidate_issue") (decision-messages.ts:251-314).

**W5. Eligibility hold** (owner; ITS recruiter as backstop)

1. Today/notification link → panel "Held on an eligibility answer".
2. "Keep them in" requires a reason: `override_eligibility` → stage "eligible" and the held run is signalled, so the reading starts at once (application-actions.ts:545-553).
3. "Decline now" → "Confirm decline" files `reject` with reason "eligibility". The message later always uses the fixed eligibility wording.
4. "Review anyway" reopens an eligibility decline and restarts the intake run (:554-562).
5. If nobody acts: a reminder every 24h, and after 72h an ITS escalation says "only they can decline".

**W6. Interview to hire** (owner, admin, hiring manager, recruiter; HR records outcomes)

1. "How did the interview go?" → POST /applications/:id/decision {next_round | finalist | not_moving_forward(reason) | hired(hireDate)} (interviews.ts:363-432). Not moving forward is a private decline as in W4.
2. Finalist → "Offer made" POST /applications/:id/offer → stage "offer_sent", an `offers` row with no terms, nothing sent (offers.ts).
3. "They accepted" → hire sheet → POST /applications/:id/outcome {hired_externally, hireDate} → `recordApplicationOutcome` (`hiring_outcomes` row, audit) → `hireFollowUp` lists the backups and offers "close the role as filled" (hire-sheet.ts).
4. Closing the role (POST /roles/:id/outcome) moves everyone still active to the talent pool privately. The closing message is then offered, and the safety net applies after 5 working days.

**W7. Notes, Compare and pool questions** (team)

- Notes: GET/PUT/DELETE /applications/:id/notes(/mine). Autosave groups changes made within a few minutes into one save; later edits keep earlier versions; the `note.added`/`note.updated` events never carry the words.
- Compare: GET /roles/:id/compare?ids= (up to 5). Every view is audited as "candidate.viewed" and the team's notes are included for those who may read notes.
- Ask about this pool: GET /roles/:id/questions/:kind answers from stored findings only ("Nothing new was asked of the AI").

**W8. Flag a reading** (team → ITS)

POST /applications/:id/assessments/:assessmentId/flag stores the flag on `ai_runs.humanOverride`, emits a `human.override` event, writes an audit record and opens (or adds a note to) an ITS "review" escalation. ITS reviews it; nothing retrains.

## 4. Routes and screens

API, all under /api/v1, tenant-scoped, with `roleScopeGuard`/`applicationScopeGuard` limiting an ITS recruiter's grant:
- GET /roles/:id/applications (group, stage, ownerStage, told, order|sort=score, counts=1)
- GET /roles/:id/board; POST /roles/:id/batch (dryRun); GET /roles/:id/questions; GET /roles/:id/questions/:kind (missing_must_have, strongest_evidence?mustHave=, overlooked, compare?ids=)
- GET /roles/:id/compare?ids=
- POST /roles/:id/decision-messages; GET/POST /roles/:id/closing-message
- POST /roles/:id/outcome (close a role with its outcome)
- GET /roles/:id/report, /report.csv, /report/summary.csv (CSV downloads audited)
- GET /roles/:id/requirements-check, POST /roles/:id/requirements-check/apply
- GET /applications/:id (detail with matchScore, placement, allowedActions, blockedReasons, stageMoves, untoldFallbackOn)
- POST /applications/:id/actions (invite_screen, ask_in_screen, advance_to_interview, reject, hold, move_to_talent_pool, override_eligibility, review_anyway, set_mark, clear_mark, send_decision, told_in_person, cancel_screen, undo_decision)
- GET /applications/:id/decision-message; POST /applications/:id/decision-message/preview; POST /applications/:id/messages/:communicationId/undo
- POST /applications/:id/assessments/:assessmentId/flag
- GET/PUT/DELETE /applications/:id/notes, /notes/mine
- POST /applications/:id/decision (after an interview); POST /applications/:id/offer; POST /applications/:id/outcome; GET /applications/:id/outcomes
- GET /admin/outcomes; POST /admin/outcomes/:id/correct (platform admin)

Screens (Next.js shell → apps/web pages):
- /roles/:id/talent and /talent → People.tsx: the list; `?view=board` the pool board; `&review=1` Review and apply; `?open=<id>` the candidate panel (Overview with "Against your must-haves", Screen, Résumé, Messages, Notes, History); `?told=not_told`, `?ownerStage=` link filters.
- Role page Report tab → RoleReport.tsx.
- Today (Home.tsx): pool card, "not told yet" card, hold-ended, backups-warm cards.
- Admin.tsx: outcomes and corrections.
- Candidate side: /c/status/:token (apps/api/src/pages/candidate.tsx), four steps only.

## 5. Data models and dependencies

- **applications**: `stage`, `stageChangedAt`, `latestAssessmentId`, `packetVersion`, `rejectedAt`/`rejectReason` (fixed list)/`rejectNote` (team only), `toldState` (not_told | queued | sent | told_in_person | before_tracking), `candidateToldAt` (migration 0026).
- **assessments**: kind "triage" (résumé reading) or "screen" (scorecard), `result` jsonb (findings, quotes, unknowns, recommendation), `overall`, `confidence`, `packetVersion`, `aiRunId`; `secondaryScore` always null (the AI never writes a number).
- **application_marks** (0026): one active per application (unique partial index), cleared never deleted, `remind_at` required for on_hold, `source` manual|board|assistant, row-level security on.
- **application_notes** (0034): one live note per author per application, `previous_versions`, soft removal, emptied on privacy deletion, row-level security on.
- **offers** (0034 adds `made_outside`, `made_on`; terms empty); **hiring_outcomes** (corrections keep the original).
- **communications** (template keys `disposition:*`, `role_closed:*`, status queued/held/sent/cancelled); **approval_requests** (`disposition.send`, `application.invite_screen`, `application.recommend_interview`); **events** (application.stage_changed, application.marked, mark_cleared, application.told, application.untold_fallback, pool.batch_applied, human.override); **recruiter_escalations** (review requests, flags, safety-net escalations); **ai_runs** (`humanOverride` flag); **role_packets** (versions, used for "read against version N"); **policies** (levels per action); **interview_followups** (0035, the Cancelled column).
- **Code dependencies**: contracts (types, weights, bands) → core (stages, marks, match-score, board, pool-summary, evidence, outcomes, policy) → agents (triage, screening, decision-messages, orchestrator, requirements-check) → workflows (application_intake, screen, stuck_role_detector) → api services/routes → web pages. The score, board and summary are pure functions so the list, board, panel, Compare, Today and the evals all agree.

## 6. Roles and permissions in this area

Permission matrix: packages/core/src/permissions.ts:44-74. Capability map: application-actions.ts:47-72.

- **Owner / admin**: everything here — read, sort, decline, send messages, decide after interviews, record offers, hires and outcomes, close roles, notes, reports, policies.
- **Hiring manager**: the same for the pipeline (application.act, application.reject, interview.decide, outcome.record, notes), but no policy or billing.
- **HR**: can read, mark, hold, move to the talent pool, invite to screen, record offers, hires and role closings, and write notes. Cannot decline (application.reject) — so cannot send decision messages or file "Not moving forward" in Review and apply (NO_DECLINE_HERE). Cannot decide after interviews or approve interviews. HR can therefore make a talent-pool decision but cannot tell the candidate; the safety net or a colleague does.
- **ITS recruiter** (staff under a grant, recruiter role): can read, act, decline, send decision messages, decide after interviews, read and write notes. Cannot record outcomes or offers (no outcome.record). Limited to the grant's role or single candidate (`t.staff.scope`). Cannot use batch "escalate" (refused for staff).
- **Interviewer**: no list, board, Compare or report (no application.read). Sees an interview brief with pay and internal rationale left out. Writes and reads only their own note on candidates they interviewed.
- **Candidate**: sees four steps (Received, Under review, Interview, Decision). Never sees marks, scores, readings, notes or reasons. A private decision is shown only once told. May withdraw until told. Their data export includes stage and rejectReason even before they are told, but no AI readings or notes (privacy-requests.ts:80-115).
- **Platform admin**: corrects recorded outcomes (admin.ts:516).

## 7. Integrations and AI behaviour

- **Models**: Haiku 5.5 for triage.assess, screen.assess and resume.extract, run at "high" effort (routing.ts:21-42, 94). The allow-list is enforced at start-up (routing.ts:8-13). An `AI_EFFORT_STANDARD` environment value would override the triage/screen "high" effort (runner.ts:73).
- **What the AI produces**: findings per must-have (yes/partially/no/unknown) and per skill (evidenced/partially/not_evidenced/contradicted), quotes, strengths and concerns, unknowns (open questions), an overall reading (strong/potential/weak/unknown), a recommendation (screen/hold/review_manually; for screens strong_interview/interview/hold/decline_recommended) and a confidence level with reasons. It writes no number. Prompts include FINDING_RULES and FAIRNESS_RULES (never consider protected traits or their proxies; gaps, career changes and missing degrees are not concerns by themselves; call the person "the candidate").
- **Inputs to the résumé reading**: the role packet (including the pay range), up to 40,000 characters of résumé text, the extraction, eligibility answers and result, and prior applications to the same company with their stage (application-intake.ts:209-218; prompts/triage.ts:67-70).
- **Determinism and reproducibility**: three résumé readings combined by the middle value on a fixed order; ties go the candidate's way; independent of the order they come back in. The words come from the reading closest to the result. If fewer than three readings come back, the first one is used and its confidence reasons say so. The screening scorecard is a single reading (screening.ts:880-892). The score itself is pure arithmetic over the stored findings and always gives the same result for the same rows.
- **Score maths** (match-score.ts:108-146):
  - Requirements = must-haves (weight 4) + skills (Essential 3, Important 2, Helpful 1; importance from the person's pick or the 1-5 weight).
  - Only judged requirements count. Each gets a share of 100 by weight and loses points for partial (50%) or no (0%) evidence.
  - Score = round(100 − points lost), held at ≤ 54 when a must-have is proven missing.
  - Bands: 85+ Very high, 70+ High, 55+ Medium, below Low.
  - Per requirement, the screen's known finding beats the résumé's.
  - Confidence is shown apart and never changes the number.
- **Explanations shown**: the score badge with band, "Based on N of M requirements", a bar per requirement with % met, points lost and the quote one click away, a "not known yet" list ("never counted against them"), the confidence chip, the version label, the board's reason line and next step, "Needs your eye" reasons, and "Looked at …" lines on pool answers.
- **Email**: every candidate email goes through the outbox. It is held until ITS confirms the company (founder decision B7) and has an Undo window for a person's Send.
- **Fairness tooling**: packages/evals suites board.determinism, triage.bias_pairs and triage.consistency. A real-model run lives in a separate GitHub workflow (.github/workflows/fairness.yml; docs/runbooks/fairness-tests.md).

## 8. Tests present and missing

**Present** (counts of it/test blocks):
- core: match-score.test.ts 13, board.test.ts 13, evidence.test.ts 9, pool-summary.test.ts 11, hire-notes.test.ts 5, core.test.ts 40.
- agents: triage-readings.test.ts 7 (middle answer, order independence, fewer readings, credential rule), evidence-rules.test.ts 13, telling.test.ts 9, requirements-check.test.ts 5.
- API integration: pool-board.test.ts 20 (score on list and detail, sort, board, questions, batch preview and apply, 50 cap, refusals, recruiter request, flags, scoping), pipeline-marks.test.ts 31 (marks, holds, safety net), telling-candidates.test.ts 31, hire-and-notes.test.ts 19 (including that nothing in packages/ai or agents reads notes), role-report.test.ts 25, talent-actions.test.ts 14, intelligence.test.ts 9, outcomes.test.ts 5, recruiter-loop.test.ts 11.
- web unit: tests/web board 32, match-panel 18, talent-list 22, talent-actions 27, telling 16, hiring 12, notes 7, compare-view 7.
- shell UI: pool-board 8, stage-button 7, telling-hiring-ui 20, talent-page 19.
- e2e: pool-board, stage-strip, decision, match-panel, talent-actions specs; .last-run.json "passed" on 12 Oct 2026.
- evals: board.determinism, triage.bias_pairs, triage.consistency.

**Missing or weak:**
- No test that Compare's "Still unknown" count and the "Compare these" quotes agree with the score's per-requirement source (bug B2).
- No test that a skill checked "in the interviews" (role editor or requirements-check fix) stays out of the résumé reading and the score (bug B3).
- The screening scorecard has no three-reading consistency test and no expired-credential rule test.
- No UI path or test for setting "Not a fit for now".
- No test that the single-candidate decline confirmation and the eligibility notifications disclose the 5-day safety net.
- No test that apps/web/src/evidence.ts `closerLook` matches core `evidenceView` when a scorecard came before the résumé reading (one-visit flow).
- No test of the role report JSON for an ITS recruiter scoped to one candidate.
- No bias-pair eval varying prior applications or rejections, which are sent to the model.
- No performance test of computing every score and placement on read for large pools.
- All tests run on fake AI; real-model behaviour is covered only by the separate fairness workflow, whose results are not in the repo.

## 9. Bugs and incomplete features

- **B1 (medium) Copy and notifications say nothing is sent after a decline, but under the default setting the standard decline goes by itself after 5 working days.**
  - Evidence: talent-actions.ts:213-229 `declineConfirmText` ("It is private: nothing is sent to the candidate now… When you are ready, send the decision message"), used for every single decline (needs-you.tsx:128, 304, 507, 544). application-intake.ts:162 and :186 notifications ("Nothing is sent to them, even if you decline, until someone sends the decision message"). board-model.ts:329 REVIEW_FOOT and :351 `appliedToast` ("Nobody was emailed"). Versus policy.ts:97 (`disposition.send` default "auto") and decision-messages.ts:266-282.
  - Also silent on it (verified): the server's Review and apply privacy line (review-apply.ts:25 "Send decision messages later, from the Talent page, when you are ready"), and the hire sheet's close-role sentence (hire-sheet.ts:54-56 "nobody is told at once, and you see the closing message before it goes"). talent-actions.ts imports `safetyNetPromise` (line 3) but `declineConfirmText` never calls it.
  - What does disclose it: the Review and apply group line (board-model.ts:322), the "not told yet" card (telling.ts:171-194), the 2-working-day reminder (orchestrator.ts:94), the role-close toast (talent-actions.ts:292-294), the closing-message card (ClosingMessage.tsx:155) and customer docs 01 lines 63 and 153.
  - Effect: an owner who declines from the panel may expect the decision to stay private indefinitely. The candidate receives the standard decline email automatically on day 5 (no Undo window, decision-messages.ts:271 passes no `sendAt`) unless someone acts.
- **B2 (low) Compare's "Still unknown" row and the board's "Compare these" quotes use a different rule from the score.**
  - Evidence: compare.ts:91 and :96 take the screen's finding whenever one exists (including "unknown" or "not_evidenced"); match-score.ts `resolve` :60-67 uses the screen's finding only when it is known, otherwise the résumé's. The table cells do NOT use those raw fields first: compare-view.ts `criterionCell` :49-56 shows the score's own breakdown (or "Not known yet, left out of the score") and falls back to the raw finding only when the score has no row for that key. The raw rule is still visible in two places: the "Still unknown" count (compare.ts:99, ComparePanel.tsx:115) and the quotes in the board's "Compare these" answer (roles.ts:568).
  - Effect: for a screened candidate, the "Still unknown" count can include a must-have the cell above shows as met from the résumé, and "Compare these" can omit the résumé quote. Minor confusion for the hiring manager; the per-requirement cells and the score agree.
- **B3 (medium) A skill set to be judged "in the interviews" still counts in the résumé reading and the score.**
  - Evidence: `evaluatedIn` is offered to owners in the role editor ("Checked in: The interviews", skills-form.ts:24-28, RoleEditor.tsx:122) and set by the requirements check's "Ask about it in the interview instead" fix (requirements-check.ts:262, weight 3 → "Important", and a must-have moved this way is removed from the must-haves, :270). Neither the résumé prompt (prompts/triage.ts:43 lists every competency) nor `matchScore` (match-score.ts:80-90 maps every `packet.competencies`) reads `evaluatedIn`; a repo-wide search finds no reader outside the web form and display.
  - Effect: a trait such as "team player" that the owner was told would be judged in the interview is still read from résumés and moves the 0-100 score and board placement, favouring candidates who describe themselves in those words. Upgraded from PLAUSIBLE: the code path is certain.
- **B4 (medium) The screening scorecard is read once and without the expired-credential rule, yet it overrides the résumé reading per requirement.**
  - Evidence: screening.ts:886 (single `runPromptDetached`) and :923 (`applyEvidenceRules` without `credentials`), versus triage.ts:48, 68 (three readings) and :257 (credential rule). match-score.ts:66 (the screen wins when known).
  - Effect: after a screen, the score and board placement are exposed to the run-to-run variance the 14 Oct fairness run measured (5 to 11 points on the résumé reading). An expired licence the candidate mentions in the conversation stays "not known".
- **B5 (low) "Not a fit for now" cannot be set from the product.**
  - Evidence: no web call sends `mark: "not_a_fit_for_now"`; `stageMoves` and Review and apply omit it (application-actions.ts:231-235; board-model.ts:178). Yet STATUS.md line 17 lists it, contracts/domain/stages.ts:84-87 says it is "set from the pool board", and the role report counts it.
- **B6 (low, PLAUSIBLE) The candidate panel's "Needs a closer look" and "Low confidence" can disagree with the list and board.**
  - Evidence: apps/web/src/evidence.ts:72-76 uses `assessments[0]` (newest by time) and the latest résumé reading. Core (pool.ts `scorePerson` :80, `evidenceView` core/evidence.ts:114-143) uses `latestAssessmentId`, which the screen workflow always points at the scorecard (screen.ts:390) and which intake keeps on the scorecard when the résumé reading lands later (application-intake.ts:255-256; the reading runs "beside" the conversation at screen_complete, :376). The web copy also judges "insufficient" from the résumé reading only (evidence.ts:74), while core judges the latest reading, scorecard included (core/evidence.ts:49-55). Mechanism verified in code; not reproduced at runtime.
  - Effect: in the one-visit flow the panel may miss a scorecard flagged as inconsistent at "Screen complete" that the list and board show.
- **B7 (low) "Keep them in" promises learning that does not exist.**
  - Evidence: needs-you.tsx:535 ("it is recorded and the system learns from it"); application-actions.ts:547 ("so the system can learn"). Nothing reads these reasons except the audit/events and the role report's override counts.
- **B8 (low) The stored reading links to only one of its three model runs.**
  - Evidence: triage.ts:97 returns `{ ...ok[0], output: combined }`, so `assessments.aiRunId` (application-intake.ts:252) is reading 1's run, while the shown result is the combined middle. A "Something wrong?" flag lands on reading 1's run only (roles.ts:809). The audit trail from what the owner saw to the model output is incomplete.
- **B9 (low, PLAUSIBLE) The role report ignores a narrow ITS grant.**
  - Evidence: GET /roles/:id/report (reports.ts:29-38) does not pass the staff scope; the JSON aggregates the whole role and `pendingDecisions.list` carries other applicants' application IDs (role-report.ts:408). No names. The CSV is correctly limited (reports.ts:49).
- **B10 (low, reframed) The hire sheet's "close the role" sentence promises the owner will see the closing message before it goes.**
  - Evidence: hire-sheet.ts:54-56 "nobody is told at once, and you see the closing message before it goes". Under the default "Do it", anyone the close moves to the talent pool gets the closing message by itself after 5 working days if nobody sends it (decision-messages.ts:251-282, `defaultWording` for a closed role). The toast after closing does say so (talent-actions.ts:289-296). The original claim that the "hold off telling them" advice (hire-sheet.ts:94) conflicts with the safety net was wrong: that advice belongs to the "keep them warm" choice, where the role stays open, backups are not decided and the safety net does not apply (hiring.ts:114-137).
- **B11 (low) Unreachable stages.**
  - Evidence: debrief, reference_check, offer_draft, offer_approval, negotiation, accepted and onboarding are defined, labelled ("Checking references", "Offer being prepared"…) and counted in reports, but no route or workflow enters them (stages.ts:37-51; grep shows no `to:` for them outside stages.ts). This is incomplete scope (PIPELINE-38) more than a defect.
- **B12 (low, PLAUSIBLE fairness risk) Prior applications are sent to the reading model.**
  - Evidence: the candidate's other applications to the same company, with their stage (for example "rejected"), are given to the résumé reading model (application-intake.ts:209-218; prompts/triage.ts:70). No eval checks whether a prior rejection moves the reading.

## 10. Doc/code drift

- docs/STATUS.md line 17 lists "Not a fit for now" among the private marks the team uses; no screen sets it. contracts/domain/stages.ts:84-87 says it is "set from the pool board"; the board never sets it.
- docs/customer/01-what-you-get-and-what-is-not-included.md line 53 and docs/customer/06-hiring-manager-guide.md lines 159, 252 and 301 say nothing is sent after a decline "until someone sends the decision message". The same documents (01 lines 63 and 153, 06 line 280) and the code (decision-messages.ts:251) describe the automatic 5-working-day send.
- The role editor offers "Checked in: The interviews" for a skill (skills-form.ts:24-28), implying it is not judged from the résumé; nothing in the reading or the score honours it (bug B3).
- docs/spec/22 §4 lists Review and apply actions on_hold, invite_screen and escalate. The API supports them, but the Review and apply window only offers Shortlist, Longlist and Not moving forward (board-model.ts:178-274).
- The comments in triage.ts and routing.ts describe three readings to stabilise scores; spec 22 says the scorecard's finding wins per requirement. Nothing says the scorecard is a single reading without the credential rule (screening.ts:880-926).
- The in-app copy "the system learns from it" (needs-you.tsx:535, application-actions.ts:547) has no implementation behind it.
- docs/spec/22 §1 says "No migration was needed (0034 is unused by this wave)". 0034 is now application_notes and offers (Wave H). Accurate for Wave F but easy to misread.

## 11. Unknowns

- How the real model (Haiku 5.5) behaves on real résumés: all tests use fake AI, and the fairness workflow's results are not in the repo.
- Which `disposition.send` level live customers will run. The default "auto" means automatic decline emails after 5 working days.
- Counsel register items 21 (NYC Local Law 144 bias audit for a visible score and a list sorted by it), 22 (batch decline), 23 (decision wordings and the immediate interview-off note) and 25 (notes in data requests) are open. STATUS.md says real NYC candidate data stays off until answered.
- Whether candidates must get their AI readings or match score in a data-access request (currently excluded, privacy-requests.ts:80-115).
- Performance of computing every score, placement and stage move on each read for roles with hundreds of applicants.
- Whether the untold safety net and the auto screen invitation have been exercised on staging (STATUS.md says nothing is production-verified).
- Whether HR being able to file a talent-pool decision (a decision the safety net may later announce) without being able to tell the candidate is intended.

## 12. Verification notes (skeptical re-check, 14 Oct 2026)

A second agent re-read the code behind every bug, every non-"fully_implemented" status and about 25 "fully_implemented" features (traced UI → API → service → database: stage strip and stage button, marks and holds, the hold-ended detector, the match score and bands, the pool board, Review and apply with its 50 cap, Compare, the decline action, Send with Undo, bulk send, "I told them myself", quiet undo, the safety net and its daily scheduling (stuck-role-detector.ts:34, started per company in routes/companies.ts:25), the closing message, the eligibility hold, "Ask about this in a screen" and "Stop this screen invitation", the "Something wrong?" flag, notes, Offer made, the candidate status page, the automatic screen invitation and "recommended for interview"). No fully_implemented feature had to be downgraded. Changes made:

- **B2 downgraded from medium to low and rewritten.** The Compare table's cells do not show the raw screen-first chips: compare-view.ts `criterionCell` shows the score's own breakdown first, so cells and score agree. Only the "Still unknown" count and the "Compare these" quotes use the raw rule. PIPELINE-20 note updated.
- **B3 confirmed (no longer PLAUSIBLE) and widened.** Owners can set any skill to "Checked in: The interviews" in the role editor, not only via the requirements check; nothing reads `evaluatedIn` in the reading or the score. Doc-drift line added.
- **B10 reframed.** The "hold off telling them" advice belongs to the keep-warm choice, where nobody is decided and the safety net does not apply, so that conflict was refuted. What remains is the close-role sentence "you see the closing message before it goes", which omits the automatic send.
- **B1 confirmed and extended** with two more silent places (review-apply.ts:25, hire-sheet.ts:54-56), the no-Undo detail and more doc lines (06 lines 252 and 301).
- **B6 kept as PLAUSIBLE** with fuller evidence (screen.ts:390; the web copy's "insufficient" rule differs too).
- **B4, B5, B7, B8, B9, B11 and B12 confirmed** as written. All statuses marked partial (PIPELINE-05, -17) and planned_not_implemented (-19, -38, -41) confirmed: no web code sets `not_a_fit_for_now`, no web or shell code sends the batch extras, free-text questions show "not available yet", no transition anywhere enters debrief/reference_check/offer_draft/offer_approval/negotiation/accepted/onboarding, and nothing reads override reasons for learning.
- **Added PIPELINE-42** (AI suggestions waiting for a person's Yes / Not now, lapsing after a week) and **PIPELINE-43** ("Record what happened": the second, private decline path through POST /applications/:id/outcome, and "No hire"). PIPELINE-37 evidence now includes the job-builder draft route.
