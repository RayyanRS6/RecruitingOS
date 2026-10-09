# 22. The match score, the pool board, Review and apply, and the one-click questions

*9 October 2026. Wave F of the Kanvis comparison plan, as the founder decided it: B2 (a 0-100 match score on every applicant, with the breakdown, and sorting by it), B4 (Review and apply can file a group as "not moving forward" in one go, privately, each with their own reason), B5 (one-click questions now, free-text chat later), B6 (decisions are private; a person tells the candidate later). For engineers building the board and the candidate panel on this API.*

The product rules still hold (docs/01-product-thesis.md): a person decides every move, the AI is disclosed, nothing happens on its own without a way back, and everything is recorded. The score and the board suggest; only a person applies.

## 1. The match score

**Where:** `packages/core/src/match-score.ts` (`matchScore`, `mustHaveSummary`, `readingVersion`, `readingPair`). Pure; imports only `@ros/contracts`. Types and bands: `packages/contracts/src/domain/match.ts`.

**Never written by the model.** The number is worked out by code from the stored, quote-checked findings of the latest readings. The model's `secondaryScore` stays unrequested (plan 0.9).

**Inputs.** The application's newest résumé reading (`kind: "triage"`) and newest screening scorecard (`kind: "screen"`), read against the version of the role they were made against (`assessments.packet_version`). Per requirement, the scorecard's finding wins where it has a known one (the candidate spoke to it directly); otherwise the résumé reading's counts.

**Requirements and weights.** Each must-have counts 4. Each skill (competency) counts by its importance: Essential 3, Important 2, Helpful 1 (`MATCH_WEIGHT`). Importance is what a person picked (`competencies[].importance`, plan F3); a packet without it reads its 1-5 weight as Essential (5), Important (3-4) or Helpful (1-2) (`importanceOf`). When a person picks one, the packet guard sets the weight to match (5, 3, 1), and the edit is a new version like any other (`POST /roles/:id/packets`). Importance also counts in the consistency check before any automatic step (plan A8, `readingConsistency` in packages/core/src/evidence.ts and its mirror in apps/web/src/evidence.ts): a Strong reading whose own findings show, by the candidate's quoted words, that an Essential skill goes against them is held for a person ("Needs a closer look").

**Credit.** Met (must-have "yes", skill "evidenced") 100%; partly met 50%; not met 0%. A must-have counts as not met only on a verified quote from the candidate's own words; a skill counts as going against them ("contradicted") only on a verified quote. Anything else is **not known**: a must-have "unknown" or an unquoted "no", a skill "not evidenced" or an unquoted "contradicted".

**The unknown is set aside, never penalised.** Not-known requirements are left out of the score and listed (`unknown[]`); `coverage` says what the score rests on ("Based on 5 of 7 requirements"). With nothing known, `score` is null ("Nothing to score yet"). An entry carries `unquotedNo: true` when a reading said "not met" (or "goes against it") with nothing quoted: still left out of the score, but the board asks a person to look.

**A missing must-have** (a verified "no") is listed in `missingMustHave[]` with its quote, holds the score at 54 at most (`MISSING_MUST_HAVE_CAP`; `capped: true` when that lowered it) and shows as the red "Missing must-have: <name>" chip. Red is used for nothing else.

**Score.** `100 - Σ points lost`, rounded. Each judged requirement has `weightPct` (its share of 100 among the judged ones) and `pointsLost` (`weightPct × (1 - pctMet)`). The `breakdown[]` lists the judged requirements, costliest first (then must-haves, heavier, by name). `fullMarks` counts those met in full ("N more at full marks").

**Bands** (the same cut-offs and words as `packages/ui` `SCORE_BANDS`): Very high 85+, High 70+, Medium 55+, Low below. Badge colour: green from 70, amber 55-69, plain grey below. The band words never reuse the AI reading's words (Strong match, Potential match, Weak match, Insufficient evidence). Confidence is a separate chip (`confidence`, from the newest reading).

**Version label** (plan F4): `readingVersion` `{readAgainst, current, label, mustHavesChanged?}` when the reading was made against an earlier version of the role ("Read against version 2 of the role; the role is now on version 3."; with " Its must-haves have changed since." when they were added, removed or reworded). The score uses the version it was read against, so keys always line up; Compare shows the current version's rows and labels the mismatch. A change to the role counts for people read from then on; nobody is read again on their own.

**Not stored.** No column caches it: every list, card and panel works it out on read from the same rows, with one query per kind of fact. Sorting by score happens in memory after the load. No migration was needed (0034 is unused by this wave).

**The must-have line** (plan F1, `mustHaveSummary`): `{total, shown, partly, notShown, unknown, gaps[{key, text, quote}], words}`, for example "Must-haves: 3 of 4 shown, 1 not yet known". It never holds or declines anyone.

## 2. The pool board

**Where:** `packages/core/src/board.ts` (`boardPlacement`, `declineReasonFor`), loaded by `apps/api/src/services/pool.ts`.

Columns, in our words: **Shortlist**, **Longlist**, **Not moving forward** (`BoardColumn`).

| Who | Column | Starts ticked in Review and apply | Next step |
|---|---|---|---|
| Score High or Very high, read with confidence, every must-have known | Shortlist | yes | Interview (after the screening conversation, or Very high with high confidence), else Short phone call |
| Score Medium | Longlist | yes | Ask for more detail (a must-have not yet known) or Keep as backup |
| Score Low, or a must-have shown missing by a quote | Not moving forward | yes, with a reason pre-filled from their evidence | Not moving forward |
| Needs a closer look (the reading disagrees with its findings), a résumé reading or a scorecard that says too little (`review_manually`, "unknown", a scorecard's "hold"; at any stage), low confidence, an unreadable résumé (when the score rests on the résumé reading), a must-have said to be missing with nothing quoted, nothing to score, a must-have not yet known on a strong reading, no reading at all | Longlist, with **Needs your eye** and the reason | no | Read it yourself / Ask for more detail |
| Would be Not moving forward, but: the score is low with must-haves not yet known or from under half the requirements (`MIN_COVERAGE_TO_DECLINE`); the screening conversation is still open and the reading is the résumé's; the reading was made against an older version whose must-haves have changed; or the reading itself suggested a step forward (a screen, an interview) | Longlist, Needs your eye | no | Ask for more detail / Read it yourself |
| Would be Shortlist, but the reading itself suggested holding back (the résumé reading's "hold", a scorecard's "decline recommended") | Longlist, Needs your eye | no | Read it yourself |
| Held on an eligibility answer | Longlist, Needs your eye | no, and nothing to apply | Check eligibility |
| Still applying (the conversation after the form is not finished) | apart, never placed | not offered | none |
| Already decided, sorted by a person (a mark), interviewing, offer, hired | where they are now, `state: "done"`, with `doneLabel` | not offered | none |
| Being read (applied, received, eligible, no reading yet) | Longlist, `state: "waiting"` | not offered | none |

`BoardPlacement`: `{column, state: suggested|done|waiting, doneLabel, confident, needsYourEye, reason, nextStep{kind, label, reason}, suggestedAction, declineReason{reason, note}}`. `reason` is one line from the evidence ("Match score 62: Perio charting partly shown.", "Missing must-have: Active CA RDH license.").

**Pre-filled decline reason** (`declineReasonFor`): from the fixed list (`RejectReason`), "Experience not a match" when the requirement is about time on the job, otherwise "Skills not a match"; the note quotes their own words ("Missing must-have: X. Their own words: "..."") or names what cost the most points. The note is for the team; the candidate's decision message never carries it.

## 3. The summary and Today

**Where:** `packages/core/src/pool-summary.ts` (`poolSummary`). Fixed rules over the rows: every name and number comes from the records; nothing is invented, no AI is asked.

`PoolSummary`: the people still to sort per suggested column (`counts`; anyone already sorted, decided, interviewing or hired is counted once in `done`, never as "on the shortlist"), how many to sort, done, still applying, how many show every must-have, the must-have shown least often (`mostMissing`: not met plus not known), who has waited longest, up to three next steps naming people (the shortlist first by score, then those who need a person's eye, then those to ask), per-must-have counts (`mustHaves[]`; each must-have's `total` counts only the people read against a version of the role that had it, so a must-have added later is not "not shown" by everyone read before), and `stricter`: when at least five people were read and 60% or more do not show one must-have, a gentle note that it may be stricter than the job needs, with `editPath` (`/roles/:id?tab=requirements&edit=must-haves`, which opens the editor for a new version). `sentences[]` says it all in order.

**Today:** one `pool_ready` card per open role when two or more people wait to be sorted, for those who can apply (application.act): title "N people to sort for <role>", the sentences and the next steps, actions "Open the board" (`/roles/:id/talent?view=board`) and "Review and apply" (`/roles/:id/talent?view=board&review=1`), and the summary on `card.pool`. Today's "N strong candidates ready" now counts each person's latest reading only (plan F5).

**Role report:** `mustHaves` `{people, showEveryMustHave, byMustHave[], stricter}` (one role only; counts, no names), shown on the role's Report tab as "How the pool meets the must-haves" with the "stricter than needed?" note and a link to the must-haves.

## 4. The API

All under `/api/v1`, all tenant-scoped; an ITS recruiter under a grant for one candidate sees that candidate only. Shapes are in `packages/contracts/src/api/board.ts`.

- `GET /roles/:id/applications`: each row adds `score`, `band`, `bandLabel`, `coverage`, `missingMustHave`, `mustHaves`, `placement`, `nextStep`, `readingVersion`. `order=score` (or `sort=score`): highest first, no score last, newest first among equals.
- `GET /applications/:id`: adds `matchScore` (the full `MatchScore`), `mustHaves`, `placement`, `readingVersion`; `packetLabels.competencies[].importance`.
- `GET /roles/:id/board` → `BoardView`. In each column the people to sort come first, highest score first, then those done.
- `POST /roles/:id/batch` (Review and apply) `{items: [{applicationId, action, reason?, note?}], dryRun}`, 1 to 50 items, each person once. Actions: `shortlist`, `longlist`, `on_hold` (private marks, source "board"), `not_moving_forward` (the private decline: told state `not_told`, nothing emailed; a reason from the fixed list, the pre-filled one when left out, refused when there is none), `invite_screen` (the screening conversation; that one does email the candidate, and the preview says so), `escalate` (one review request to ITS for everyone in the batch who has it, counted once; about one person it covers that candidate, about several it covers the role, and the preview's warning and the result say what the recruiter will see and for how long).
  - `dryRun: true` → `BatchPreview`: per person the name, score, band, column, what the board suggests, whether it may and why not (the same rules as their own page, plus: still applying, an interview in motion for a decline), warnings, and the pre-filled reason; the counts, "N decisions ready: ...", the screening-conversation allowance for invitations, and the privacy line. Nothing changes.
  - Apply → `BatchResult`: each person in a transaction of their own, row locked, through `performApplicationAction` (gates, approvals, marks' rules, the outbox's idempotency all apply); one refusal never blocks the rest; results in the order given. Each decision records `via: "review_and_apply"`, `batchId`, `suggested`, `suggestedBy: "assistant"`, `appliedBy`; the batch emits `pool.batch_applied` with suggested and chosen per person.
- `GET /roles/:id/questions` → the questions offered: "Who is missing a must-have, and why?", "Strongest evidence for "<must-have>"" (one per must-have), "Who might I be overlooking?", "Compare these".
- `GET /roles/:id/questions/:kind` → `PoolAnswer` `{question, answer, people[{applicationId, name, score, band, placement, why, quotes[{criterion, quote, source}], open}], applicationIds (filter the board with these), lookedAt{people, resumeReadings, screenReadings, requirements[], words}}`. `missing_must_have`: verified misses only, and how many say nothing either way. `strongest_evidence?mustHave=<key>`: shown before partly shown, quoted first, then by score, ten at most. `overlooked`: good evidence (High or Very high, or every must-have shown) but not on the Shortlist, or waiting 7 days or more with nothing decided. `compare?ids=a,b` (up to five): the comparison view's answer on `compare`.
- `GET /roles/:id/compare` also carries each person's score and `readingVersion`.
- `POST /escalations` with `kind: "review"`, `scope: "role"`, `roleId` ("Have a recruiter check this", plan F9): the request's context carries the board as it stood (`contextSnapshot.board`). A candidate's deletion reaches it: their row and next step go, "longest waiting" no longer points at them, and the summary's sentences lose their name (`scrubBoardSnapshot`, packages/core/src/privacy-requests.ts).
- `POST /applications/:id/assessments/:assessmentId/flag` ("Something wrong?", plan F11): a team member's flag becomes a review request about that candidate in the ITS queue (one open request per candidate; a later flag adds a note, and the recruiter holding it is emailed that there is a note, never its words), not counted against the plan's recruiter requests. The page asks first, saying what the recruiter will see and for how long; an ITS recruiter's own flag is only recorded. `contextSnapshot.flags[]` records the kind of person who flagged (`by: "user"`), never their name; the audit record and the `human.override` event keep who it was. The answer says which request carries it.

## 5. What the pages should say

Plain words, our own (never Kanvis's). The words the pages use now (`apps/web/src/pages/board/board-model.ts`, `candidate-panel/match-view.ts`):

- The score: the badge "91/100" with its band (Very high, High, Medium, Low); "Based on 5 of 7 requirements" (beside the number on board cards and the panel, the badge's tooltip on a list row); "Missing must-have: <name>" (red, only on a checked quote).
- The panel's card "Against your must-haves": the big score with its band, the confidence chip apart ("Medium confidence"), the coverage and what it rests on, the must-have line, bars with % met and points lost costliest first, "N more at full marks", "N requirements not known yet ... never counted against them", "Suggested next step", the version label, and the promise "A match score worked out from checked evidence, with the breakdown shown. A person always decides." (`MATCH_SCORE_PROMISE`, copied in the web as `MATCH_PROMISE`).
- The strip: "Sort the pool"; "Sorts everyone who has finished applying into Shortlist, Longlist and Not moving forward, and explains every call. Nothing moves until you apply it, and nothing is sent to anyone."
- The columns' lines: "Good evidence on the must-haves", "Some evidence, or more to find out", "A must-have shown missing, or a low score on what is known". The header: "To sort: 2 shortlist · 1 longlist · 1 not moving forward · 3 already sorted or decided".
- A card's chips: "Ready to apply" (plain grey), "Needs your eye", "Missing must-have: <name>", "Done"; the confidence chip apart. Its facts: the must-have line, "From the résumé reading" (or the screening conversation, or both), the version label, "Invited to the screening conversation automatically", "Screening conversation open", "A suggestion is waiting for you".
- Review and apply: "Untick anyone you want to decide yourself, change a reason if needed, then apply. Unticked people stay where they are."; "Needs your eye: read before applying"; for Not moving forward "Filed privately. Nobody is emailed now; you will be reminded to send the decision message from the Talent page. If nobody tells them within 5 working days, the standard message goes by itself (if your settings ask for approval or keep these messages with a person, an ITS recruiter is brought in instead and nothing is sent)." (the Q27 safety net; the board does not know the company's setting, so it names both); the footer "This files people into your pipeline privately. Nobody is emailed."; the toast "Applied N decisions" / "Filed privately. Nobody was emailed."
- Ask about this pool: "Answers come from the checked findings already on file for everyone who finished applying. Pick a question; each answer says what it looked at."; "Looked at: ... Nothing new was asked of the AI."; "Typing your own question is not available yet."
- Editing: `/roles/:id?tab=requirements&edit=must-haves` opens the editor at the must-haves, `?edit=skills` at the skills (with Essential, Important, Helpful); a change counts for people read from then on. The comparison view can order its columns by the highest score.

## 6. Evaluation and counsel

- `packages/evals`: `board.determinism` (rules and order-independence, no model, including the thin-evidence and disagreeing-reading cases), `triage.bias_pairs`, which now compares the score, its band and the missing must-haves of each pair as well as the reading, and `triage.consistency`, which reads the same résumé three times and requires the same reading, must-have findings, score, band and column each time. Track R runs both on the real model before the board reaches customers.
- Counsel: docs/spec/11-counsel-register.md items 21 (NYC Local Law 144 bias audit for a visible score and a list sorted by it) and 22 (batch decline with per-person reasons). Until answered, real candidate data in NYC stays off.
