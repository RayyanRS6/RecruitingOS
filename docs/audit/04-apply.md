<!-- Part of the Recruiting OS product audit (docs/product-audit.md), 14 October 2026. Written by one reader from the code at origin/main dafb730 and checked by a second, skeptical reader who tried to refute every bug and status; corrections are listed under the verification notes. Working files mentioned as 'scratchpad' are not in the repository. -->

# Candidate journey: applying, résumés, screening conversation, candidate pages

Audit of `recruiting-os` on branch `kanvis-reaudit` (= origin/main `dafb730`, 14 Oct 2026). Read-only. Source code, migrations and tests are treated as the truth; docs were used as leads only. Every claim below was traced from the page a candidate sees, through the route and service, to the database write. Paths are repo-relative.

## 1. Summary

The candidate side is the most finished part of the product. Every page a job seeker touches is server-rendered by the API (`apps/api/src/pages/*.tsx`), works without JavaScript, and is reached either from a company's public careers page or from a private link that arrives by email (status, screening, scheduling, confirmation). There is no candidate account and no password: each private link carries a 192-bit random token that is looked up in the database.

A candidate can: browse a company's open jobs (only once ITS has confirmed the company), apply with name, email, optional phone and location, a résumé (PDF, Word .docx or text, up to 8 MB) or four short written answers instead, and yes/no eligibility answers; tick a required acknowledgment that people, not software, decide; and then either land on a "check your email" receipt (the default "form now, conversation later" flow) or, on roles ITS has switched to the pilot "one visit" flow, go straight into a short written conversation with the company's AI assistant. That conversation is fully built: a fixed introduction that says it is an AI, Start / Do this later / "I'd rather talk to a person", one question at a time, tap answers for simple facts, skip, a "check your answers" page, and the founder's 9 October rule that the hiring team sees nothing the candidate typed until they press Send. Repeat applications are deliberately indistinguishable from first ones and change nothing on the existing record. The status page shows four plain steps (Received, Under review, Interview, Decision), hides private decisions until the candidate is told, lists the messages that reached them, and lets them withdraw, stop texts, leave the talent pool and make privacy requests. Interview self-scheduling and the candidate's own cancel (with "send me new times" or "no longer interested") are in place.

Résumés go to a quarantine area of private storage, are checked by their bytes (type, macros, encryption, scripts), scanned for malware, moved to a final private key and turned into text (no OCR: a scanned picture-only PDF yields no text). The malware scan is real only when the ClamAV service is configured; the default engine is a fake that passes everything except the standard test string, and production only raises an alert in that case. AI reads the résumé (Haiku 5.5, `resume.extract`) and writes an evidence reading (`triage.assess`, Haiku 5.5 at high effort); eligibility is checked by code and a "no" only ever holds an application for a person, never declines it.

Everything was built and tested against fake providers (fake AI, fake email, memory storage); STATUS.md says nothing on this path is production-verified on the real model. Test coverage of the candidate path is broad (about 25 API test files plus e2e). The main problems found are: a one-visit privacy leak (applying for a second role with someone else's address greets you with the first name on file), deletion (anonymization) leaving the AI readings and AI run outputs intact, the screening scorecard's "quote check" accepting words the model itself recorded as the candidate's, emailed-in applicants being recorded as having granted consent to notices they never saw, uneven prompt-injection hardening of candidate-written text, an over-broad "protected detail" filter that silently drops ordinary sentences from recorded answers, and orphaned résumé uploads that are never cleaned up.

## 2. Feature inventory

| ID | Feature | Status | Who | Evidence |
|---|---|---|---|---|
| APPLY-01 | Careers page listing a company's open jobs | fully_implemented | candidate (visitor) | `apps/api/src/pages/candidate.tsx:167` (`GET /careers/:slug`), `loadPublicCompany` :126 |
| APPLY-02 | Public job page: facts, pay where shown or legally required, description, "what to expect", notices, JSON-LD, share tags | fully_implemented | candidate | `candidate.tsx:238`; `pages/job-page.tsx` `JobPage` :131; `services/job-preview.ts` `applySteps` :41 |
| APPLY-03 | Public pages exist only after the ITS company check (B7) | fully_implemented | candidate, platform admin | `candidate.tsx:126-129` (`isCompanyVerified`), `pages/links.tsx:70`, `routes/admin.ts:79` |
| APPLY-04 | Apply form: name, email, optional phone and location, résumé or four no-résumé questions, eligibility questions, transparency block, required unticked acknowledgment, SMS consent box only when texting is on | fully_implemented | candidate | `pages/job-page.tsx` `ApplyFields` :307-381, `TransparencyBlock` :286-304; `candidate.tsx:344-476`; `ApplyRequest` `packages/contracts/src/api/index.ts:355` |
| APPLY-05 | Bot defence: honeypot field (fake success, nothing recorded) and rate limits (60/h per internet (IP) address, shared by upload-intent and apply; 600/h per role); no CAPTCHA | fully_implemented | candidate | `candidate.tsx:376`; `middleware/rate-limit.ts:31` |
| APPLY-06 | Résumé direct upload to quarantine with a sealed one-use grant; no-script fallback (file in the form, 4 MB cap) | fully_implemented | candidate | `candidate.tsx:326-342`, `:404-435`; `apps/api/src/uploads.ts` `checkUploadIntent` :22, `UploadGrants` :43; `services/applications.ts` `uploadAlreadyUsed` :194 |
| APPLY-07 | File inspection by bytes (PDF/DOCX/text only; refuses programs, macros, encryption, archives, old .doc, malformed) | fully_implemented | candidate | `packages/contracts/src/security/file-inspection.ts` `inspectResumeFile` :94-133 |
| APPLY-08 | Malware scan of every résumé (ClamAV adapter, fake scanner, production alert) | partial | candidate, platform admin | `packages/integrations/src/scanning/clamav.ts`, `fake.ts`; `registry.ts:143-158` (default `fake`); `apps/api/src/scanner-gate.ts:10-20` (alert only) |
| APPLY-09 | Quarantine → clean move to final private key, text extraction (pdf-parse, mammoth; no OCR) | fully_implemented | system | `packages/workflows/src/documents.ts` `examineQuarantinedDocument` :37-61, `recordQuarantineVerdict` :70-94; `packages/agents/src/documents.ts` :7-29 |
| APPLY-10 | AI résumé extraction (`resume.extract`) | fully_implemented | system, owner (reads result) | `packages/workflows/src/definitions/application-intake.ts` `extract` :94-130; `packages/ai/src/prompts/resume.ts` |
| APPLY-11 | Eligibility check in code; a "no" holds for a person (reminders, escalation), never auto-declines | fully_implemented | candidate, owner | `packages/core/src/eligibility.ts` `evaluateEligibility` :14; `application-intake.ts` `eligibility` :132-168, `ineligible_review` :174-194 |
| APPLY-12 | Repeat application for the same role: same receipt, nothing changed, upload discarded, link re-sent to the address on file at most once a day | fully_implemented | candidate, address owner | `services/applications.ts` :96-100, `settleRepeatSubmission` :173-185; `packages/agents/src/candidate-links.ts` :36-66 |
| APPLY-13 | Candidate de-duplication across roles by email (Gmail dots/plus folded) or phone; an existing person is never updated by a public form | fully_implemented (with a one-visit leak, see bugs) | candidate | `packages/core/src/dedupe.ts:23-29`; `services/applications.ts:76-94` |
| APPLY-14 | Receipt page with masked address in a sealed 30-minute cookie, never the status link | fully_implemented | candidate | `candidate.tsx:48-78`, `Receipt` :483-516 |
| APPLY-15 | "Lost your link?": queued, same answer for known and unknown addresses, links only to the address on file | fully_implemented | candidate | `candidate.tsx:558-575`; `services/applications.ts` `queueLinkRequest` :211, `emailStatusLinks` :220-239 |
| APPLY-16 | Tracked application links `/a/:token` (source cookie, job or apply landing, link-preview bots not counted) | fully_implemented | candidate, owner | `pages/links.tsx:56-83`; migration `0032_application_link_landing.sql` |
| APPLY-17 | Closing date with grace for a form opened before it | fully_implemented | candidate | `services/closing-date.ts:22-29`; `candidate.tsx` `admits` :307-311 |
| APPLY-18 | Apply-flow switch per role / per company ("one visit" vs "form now, conversation later"), ITS only, reason required | fully_implemented | platform admin, ITS recruiter (with grant) | `routes/roles.ts:283-331`; `routes/admin.ts:113-133`; `packages/core/src/apply-flow.ts` `resolveApplyMode` :15; `apps/web/src/components/ApplyMode.tsx`; migration 0033 |
| APPLY-19 | One-visit apply: eligible applicants go straight from the form into the conversation (E1) | fully_implemented (pilot, off by default) | candidate | `services/apply-conversation.ts` `startApplyConversation` :90-126; `candidate.tsx:469-475` |
| APPLY-20 | Fixed AI introduction: says it is software, what it is for, counts, skip/come back; Start, Do this later, talk to a person (E2) | fully_implemented | candidate | `candidate.tsx` `AiLine` :986, `IntroPage` :1177-1212; `packages/agents/src/screening.ts` `screenIntro` :211-224 |
| APPLY-21 | Screening conversation turns on the web: one question at a time in the packet's words, at most two follow-ups, model-call cap | fully_implemented (fake provider only) | candidate | `screening.ts` `beginScreenTurn` :355, `finishScreenTurn` :598, `enforceTurnRules` :804; `packages/ai/src/prompts/screen.ts` |
| APPLY-22 | Tap answers (yes/no, days, start date, pay range) and "Skip this question", handled in code without the model (E11, E12) | fully_implemented | candidate | `packages/core/src/apply-flow.ts` `tapFormatFor` :61, `tapAnswerText` :90; `screening.ts` `answerInCode` :454 |
| APPLY-23 | "Check your answers", change any answer, Send; answers hidden from the team and ITS until Send (E10; 9 Oct decision) | fully_implemented (one-visit flow only) | candidate, owner | `candidate.tsx` `ReviewPage` :1285, `EditPage` :1307; `screening.ts` `editScreenAnswer` :753, `submitScreenAnswers` :783; `packages/core/src/screen-answers.ts` |
| APPLY-24 | "I'd rather talk to a person": send without the conversation, or have an ITS recruiter contact them within four business hours (E3) | fully_implemented | candidate, ITS recruiter | `candidate.tsx` `PersonPage` :1380, routes :1522-1553; `screening.ts` `requestHuman` :686, `declineConversation` :716 |
| APPLY-25 | Whole-message keywords: HUMAN, WITHDRAW (asks to confirm), CONFIRM / NO | fully_implemented | candidate | `screening.ts` `screenCommand` :537, `answerWithdrawPrompt` :560 |
| APPLY-26 | Reminders and closes: not started (48 h reminder, then expired 72 h later), stopped part-way or not sent (24 h reminder, closed unfinished 48 h later) (E4) | fully_implemented | candidate, owner | `packages/workflows/src/definitions/screen.ts` :32-36, `remind` :201, `expire` :231, `idle_remind` :260, `close_unfinished` :283 |
| APPLY-27 | AI outage: pause with answers kept, retry every 30 min, email to finish, hand to a person after a day (E5) | fully_implemented | candidate | `screening.ts` `pauseScreen` :657; `screen.ts` `retry_paused` :303 |
| APPLY-28 | Conversation allowance counted at first answer; when used up the link follows by email; told after 60 days if it never came (E9, Q17, G10) | fully_implemented | candidate, owner, platform admin | `screening.ts` `countConversation` :326; `screen.ts` :121-146 |
| APPLY-29 | Repeat submission's detached conversation, confirmed by the address owner by email; wiped after 7 days | fully_implemented | address owner | `apply-conversation.ts` :132-548; `candidate.tsx:1628-1679`; table `unconfirmed_screens` (migration 0033) |
| APPLY-30 | Later-path screening invitation by email (and "Ask about this in a screen" focus questions) | fully_implemented | candidate, owner | `screen.ts` `invite` :75-178; `packages/agents/src/screen-focus.ts` |
| APPLY-31 | Screening by text message (SMS) | partial (built, switched off by default) | candidate | `apps/api/src/webhooks/twilio.ts`; `env.ts:162` (`SMS_ENABLED` false unless Twilio) |
| APPLY-32 | Screen scorecard with code-checked quotes | fully_implemented (verification gap, see bugs) | owner | `screening.ts` `assessScreen` :880, `verifyScreenQuotes` :903 |
| APPLY-33 | Status page: four candidate steps, private decisions hidden until told (B6), "what happens next", interview card, AI/human line | fully_implemented | candidate | `candidate.tsx:713-830`, `visibleStage` :594, `nextLine` :673; `packages/core/src/stages.ts` `candidateStep` :351 |
| APPLY-34 | Messages thread on the status page (only what reached them, and their replies; no reply box) | fully_implemented | candidate | `pages/thread.tsx` `threadOf` :23-35 |
| APPLY-35 | Withdraw from the status page (also allowed for an untold decision) | fully_implemented | candidate | `candidate.tsx:1727-1759`; `stages.ts` `mayWithdraw` :364 |
| APPLY-36 | Text-message preference on the status page | fully_implemented | candidate | `candidate.tsx:1761-1791` |
| APPLY-37 | "Don't keep me for future roles" and the way back | fully_implemented | candidate | `candidate.tsx:1798-1808`; `services/talent-pool.ts` |
| APPLY-38 | Privacy requests from the status page (copy, correct, delete, human review) | fully_implemented (intake; fulfilment is in the ITS console) | candidate, platform admin | `candidate.tsx:1695-1725`; `packages/core/src/privacy-requests.ts` `createDataRequest` :24 |
| APPLY-39 | Public privacy-request form with an emailed 24-hour confirmation link (D13) | fully_implemented | candidate (no link) | `pages/privacy-request.tsx:73-231` |
| APPLY-40 | Privacy page `/privacy` (who sees data, choices, automated tools) | fully_implemented | candidate | `candidate.tsx:832-871` |
| APPLY-41 | Deletion by anonymization; candidate links go dead (410) | partial | candidate, platform admin | `privacy-requests.ts` `anonymizeCandidate` :233-270; `candidate.tsx` `anonymizedFor` :1682 |
| APPLY-42 | Candidate email replies via per-application reply address (HUMAN, "no thanks", EXPLAIN) | fully_implemented (needs inbound mail domain) | candidate, owner, ITS | `services/replies.ts` :119-260; migration `0023_reply_tokens.sql` |
| APPLY-43 | Emailed-in applications (job boards) and held applicants while a role is paused or switched off (C19) | fully_implemented (consent-record bug) | candidate, owner | `webhooks/postmark.ts:29-106`, `replayHeldEmails` :176 |
| APPLY-44 | Interview self-scheduling, reschedule (twice), candidate cancel with "new times" / "no longer interested" | fully_implemented | candidate | `pages/schedule.tsx:151-458`; migration 0035 |
| APPLY-45 | Status-link rotation ("get a new link") | planned_not_implemented | candidate | promised in `docs/spec/02-roles-and-permissions.md:101`, `docs/spec/04-screens-and-states.md:43`; no route in `candidate.tsx` |
| APPLY-46 | CSRF token on the apply form | planned_not_implemented | candidate | promised in `docs/spec/04-screens-and-states.md:40`; no CSRF code under `apps/api/src` |
| APPLY-47 | Content-security policy on candidate pages | partial (report-only by default) | candidate | `app.ts:66-78`; `env.ts:158` (`CSP_MODE` default `report-only`); `packages/core/src/csp.ts` |
| APPLY-48 | Prompt-injection handling for candidate-written text | partial | candidate, owner | `packages/ai/src/prompts/screen.ts:58`, `registry.ts:26-42`; candidate text not tag-stripped in `resume.ts:19`, `triage.ts:67`, `screen.ts:94-99` |
| APPLY-49 | Help before applying (named contact for help or disability adjustments) | fully_implemented | candidate | `pages/job-page.tsx` `HelpLine` :66 |
| APPLY-50 | Owner or recruiter adds a candidate by hand (manual add / import) | planned_not_implemented | owner, ITS recruiter | promised in `docs/12-api-contracts.md:146` (`POST /applications`, `CreateApplicationManual`) and named in comments (`services/applications.ts:31`, `:52`); no route and no `CreateApplicationManual` contract exist; `createApplication` is called only by the apply page and the Postmark webhook (`candidate.tsx:448`, `webhooks/postmark.ts:72`, `:213`). A referral or walk-in can only come in through the public form or email-in. (Added in verification.) |
| APPLY-51 | Accommodation request when picking an interview time ("anything that would make the interview easier"), and "None of these work? Ask for other times" | fully_implemented | candidate, owner | `pages/schedule.tsx:190-222` (note stored on `interviews.candidateAvailability`, team notified `interview.accessibility`), `:229-250` (`none-work`, signals the scheduling workflow). (Added in verification.) |

## 3. Workflows traced step by step

### W1. A visitor applies on the default path ("form now, conversation later")
1. Visitor opens `/careers/:slug` (`candidate.tsx:167`). `loadPublicCompany` returns nothing unless ITS confirmed the company (`isCompanyVerified`), so an unconfirmed company 404s. Open roles come from `roles` joined to the current `role_packets` row.
2. Job page `/careers/:slug/jobs/:roleId` (`:238`) renders `JobPage` with the AI-use and pay-transparency notices, "what to expect" steps (`applySteps`, ending "A decision, and a real answer either way."), JSON-LD for Google, and the Apply button only if `status = open` and `accepting_applications`.
3. `GET .../apply` (`:313`) renders `ApplyFormPage` with a sealed "form opened at" value (`sealFormOpened`) and fires one anonymous analytics event (`application_started`, random reference, source only).
4. With JavaScript, choosing a file triggers `POST .../upload-intent` (`:326`): name, size and type are checked (`checkUploadIntent`), a quarantine key `quarantine/<company>/<role>/<id>.<ext>` is minted, a 5-minute presigned PUT URL is returned with a 15-minute sealed grant; event `document.upload_authorized`. The browser PUTs straight to storage and puts the grant in the form.
5. `POST .../apply` (`:344`): honeypot → fake receipt; closing-date grace (`admits`); fields validated by `ApplyRequest` (first/last name 1-80, email, phone 7-30, location ≤120, acknowledgment must be true). Notice versions recorded are computed by the server, not taken from the browser (`noticeVersionsFor`).
6. Résumé: a grant must match company and role and must not have been used (`uploadAlreadyUsed` reads `document.upload_used` events); the object is HEADed (size ≤ 8 MB, else deleted). Without a grant, a file posted in the form is inspected (`inspectResumeFile`), ≤ 4 MB. No résumé requires at least one of the four short answers.
7. In one tenant transaction: `markUploadUsed`, then `createApplication` (`services/applications.ts:69`): find the person by `dedupe_key`; create a new `candidates` row with consent (`application_terms`, `ai_notice` with the notice versions, `sms` if ticked) or reuse the existing person untouched; if an application for this role already exists → repeat path (W4); else insert `applications` (stage `applied`, random `status_token`, separate `reply_token`), store the résumé as a `documents` row with status `quarantined`, emit `application.received`, start the `application_intake` workflow.
8. `startApplyConversation` returns `receipt / later_flow` (role not on one-visit, or invite policy "ask me first"/"only a person") → redirect to `.../applied` with the masked address in a sealed cookie (`toReceipt`).
9. Worker, `application_intake` (`application-intake.ts`): `acknowledge` queues the acknowledgment email (status link, AI disclosure, what happens next) and moves to `received`; `validate` scans and moves the file (W3); `extract` runs `resume.extract`; `eligibility` evaluates owner-written rules in code: pass → `eligible`; fail → `ineligible`, a hold gate, a notification to the team, reminders every 24 h and an ITS escalation after 72 h, never a decline; `ready` runs `triage.assess` → `triaged`; `after_triage`: recommendation `screen` + consistent reading + policy auto → starts the `screen` workflow which emails the invitation (W6/W7 then apply).

### W2. One-visit apply and conversation (pilot roles)
1. Same as W1 to step 7. `startApplyConversation` (`apply-conversation.ts:90`): role resolves to `one_visit` (role setting, else company default, else later), invite policy is `auto`/`auto_notify`, the typed eligibility answers pass, allowance available (or design-partner plan).
2. In the same transaction: eligibility recorded, stage `applied → received → eligible → screen_invited`, a web `screens` row (120 h expiry, `invited_via = apply`, `progress.flow = one_visit`) and a `screen` workflow run that sends no invitation.
3. Redirect to `/c/screen/<token>` with a sealed cookie holding the masked address (`toConversation`). The intro page says "Your application is sent", the AI line ("a software program, not a person. People on the hiring team make every decision"), the question count and minutes, the packet's disclosure and human-alternative lines, and three buttons.
4. Start (`POST /c/screen/:token/start` → `startScreenConversation`, `screening.ts:271`): first question in the packet's words, no model call, stage → `screening`.
5. Each answer (`POST /c/screen/:token`): taps and skips are handled in code; commands HUMAN/WITHDRAW are parsed in code; otherwise `runScreenTurn` records the candidate's words (communication with the screen id), counts the allowance on the first answer, calls the model with no transaction open, then `enforceTurnRules` keeps the model to packet question keys, two follow-ups, and the packet's own question wording. Recorded answers pass through `redactProtected`.
6. End of questions (or model-call cap) → "Check your answers" (`phase = review`). The candidate may change answers (`/answers/:key`) and presses "Send my answers" → `completed`, `screen_complete`, the workflow writes the scorecard (`assessScreen`, only for a sent conversation) and a recommendation under policy.
7. Meanwhile the intake workflow still acknowledges once, scans and reads the résumé "beside" the conversation without changing the stage or alerting the team.
8. If the candidate never presses Send: one reminder after 24 h of inactivity (`idle_remind`), closed `unfinished` 48 h later, application → `triaged` "ready for your review", candidate emailed that nothing else is needed; nothing they typed is shown or read. If never started: reminder at 48 h, expired 72 h later, same outcome.
9. Eligibility "no" → neutral receipt (`under_review`), no conversation, held as in W1. Allowance used up → receipt says the link will come by email; the `screen` run waits, rechecking every 6 h for up to 60 days.

### W3. Résumé processing in the worker
1. `validate` phase one (`workflows/src/documents.ts:37`): read quarantined bytes, re-inspect, scan (`integrations.scanner.scan`), write a clean copy at `<company>/<candidate>/<application>/<uuid>.<ext>`, extract text (pdf-parse / mammoth / UTF-8), with a sweep job queued for the copy.
2. Phase two (`recordQuarantineVerdict` :70): in the company transaction, only if the row is still quarantined at that key: rejected (reason recorded, `document.rejected` event and audit, quarantine copy discarded after commit) or clean (row moved to the final key with checksum and text, `document.validated`).
3. Scanner outage → step retries (workflow max 4 attempts). A picture-only PDF → clean but no text → `resume.extraction_failed`; the owner's alert says the résumé could not be read.
4. Staff may later download a clean file through an audited, 2-minute single-object link (`routes/files.ts`; covered in `storage-uploads.test.ts`).

### W4. Someone applies again for the same role (or with someone else's address)
1. `createApplication` finds the existing person and application → `settleRepeatSubmission`: deletes the just-uploaded file (if no document uses it), emits `application.duplicate_detected`, emails the address on file its own status link (once per application per day). The existing person and application are unchanged.
2. Later path: the same receipt as a first application. One-visit path: a detached conversation in `unconfirmed_screens` greeting the typed first name (up to 4 conversations per application per day); when it ends, the address on file gets a "Please confirm" email (max 3 such emails per application per day); `/c/confirm-answers/:token` (hashed token) adds the answers or the person request only if the real application is still before interviews and has no answers; unconfirmed rows are wiped after 7 days.

### W5. Lost link
`POST /c/link-request` queues `candidate.link_request` for any address and redirects to the same page. The worker (`emailStatusLinks`) finds people by dedupe key across companies and emails each company's links to the address on file, at most once an hour per person.

### W6. Status page and self-service (`/c/status/:token`)
1. Lookup by `status_token` on the platform connection; anonymized person → 410 "no longer active".
2. `visibleStage`: a decline or talent-pool move the candidate was not told about is hidden; the page shows the stage before it. `candidateStep` maps internal stages to four steps; offered or booked interview times count as "Interview".
3. Shows next-step line, the line "People on the hiring team... make every decision. An AI assistant reads applications and runs the screening conversation", the screening link if open, the interview card, the messages thread, and forms: withdraw (checkbox), text preference, future roles, privacy request.
4. Withdraw → `transition(withdrawn)`, `exitCleanup` (open screens and interviews closed, interview cancellation notes), team notified; then a platform transaction records a `withdrawal` data request fulfilled at once and emails a completion note.
5. Privacy request → platform transaction, per-application advisory lock, 24 h replay dedupe, `data_requests` row verified by the link, 45-day deadline, acknowledgment email; `human_review` opens a recruiter escalation with a generic sentence.

### W7. "I'd rather talk to a person"
`/c/screen/:token/person` offers two equal choices. "Send without" → screen `declined_by_candidate`, application → `triaged`, team told in neutral words, counted. "Have a person contact me" → screen `human_requested`, recruiter escalation (`candidate_issue`), team notified that what was typed stays private, candidate shown and emailed the four-business-hour expectation. The recruiter later adds call notes (`services/screens.ts`), which never count as the candidate's words.

### W8. Public privacy request without a link
`/c/privacy-request` → for each company holding the exact email address, a sealed 24-hour token is emailed directly (not through the thread); nothing is recorded until the button on `/c/privacy-request/verify/:token` is pressed, which creates a verified request and sends the acknowledgment. An unknown address gets a "we found nothing" email.

### W9. Candidate replies by email
Every candidate email's Reply-To is `reply-<token>@<intake domain>` when inbound mail is configured. `POST /webhooks/postmark/inbound` → `receiveCandidateReply`: unknown token → unmatched; anonymized person → nothing recorded; else recorded on the thread and the team notified; first line HUMAN → recruiter escalation and a reply with the business-hours expectation; "no thanks" after a told decision → talent-pool opt-out; EXPLAIN after a Colorado-line decision → ITS compliance request.

### W10. Emailed-in application and held applicants
`POST /webhooks/postmark/inbound` with an intake token → paused or switched-off role: email held (`inbound_emails.status = held`), résumé parked, team told; reopening replays them (`replayHeldEmails`); closing instead puts them in the talent pool without an acknowledgment. Open role: `createApplication` with source `email_in`, no eligibility answers (all rules "not answered", never a fail), the email body as the no-résumé summary if there is no attachment.

### W11. Candidate cancels an interview
`/c/schedule/:token/confirmed` shows the cancel form only for a booked interview still ahead. `POST .../cancel` requires a choice and the confirm box; in one transaction the interview is cancelled (guarded by status and attempt), the application goes under Cancelled with an `interview_followups` row, automatic new times are armed when allowed, team and interviewers are told, calendar events queued for removal, and the candidate gets a confirmation; Post/Redirect/Get to `.../cancelled`.

### W12. ITS switches the apply flow
`PUT /api/v1/roles/:id/apply-mode` (platform admin always; ITS recruiter only under an active grant covering the role; reason ≥5 chars) or `POST /api/v1/admin/customers/:id/apply-flow`; audited and emitted. New applicants follow it; nobody already applying is moved.

## 4. Routes and screens

| Path | Kind | Audience | Purpose |
|---|---|---|---|
| `GET /careers/:slug` | page | visitor | careers page |
| `GET /careers/:slug/logo/:file` | file | visitor | company logo from private storage |
| `GET /careers/:slug/jobs/:roleId` | page | visitor | job page |
| `GET /careers/:slug/jobs/:roleId/apply` | page | visitor | apply form |
| `POST /careers/:slug/jobs/:roleId/upload-intent` | JSON | visitor (script) | presigned quarantine upload + grant |
| `POST /careers/:slug/jobs/:roleId/apply` | form post | visitor | submit application |
| `GET /careers/:slug/jobs/:roleId/applied` | page | applicant | receipt |
| `GET/POST /c/link-request` | page/form | applicant | re-send status links |
| `GET /c/status/:token` | page | candidate | status page |
| `POST /c/status/:token/{privacy,withdraw,sms,talent-pool}` | form post | candidate | self-service |
| `GET /privacy` | page | anyone | privacy page |
| `GET/POST /c/screen/:token` and `/start`, `/later`, `/person`, `/human`, `/withdraw`, `/review`, `/answers/:key`, `/submit` | pages/forms | candidate | screening conversation |
| `GET/POST /c/confirm-answers/:token` | page/form | address owner | confirm a repeat submission |
| `GET/POST /c/privacy-request`, `GET /c/privacy-request/verify/:token`, `POST /c/privacy-request/verify` | pages/forms | anyone | public privacy request |
| `GET /a/:token` | redirect | visitor | tracked application link |
| `GET/POST /c/schedule/:token` and `/none-work`, `/confirmed`, `/ics`, `/reschedule`, `/cancel`, `/cancelled` | pages/forms | candidate | interview scheduling and cancel |
| `POST /webhooks/postmark/inbound` | webhook | Postmark | emailed applications and candidate replies |
| `POST /webhooks/twilio/inbound` | webhook | Twilio | SMS replies, STOP/START |
| `GET/PUT /api/v1/roles/:id/apply-mode` | API | ITS | role apply flow |
| `POST /api/v1/admin/customers/:id/apply-flow` | API | platform admin | company default apply flow |
| `GET /sitemap.xml`, `/robots.txt`, `/feeds/*` | feeds | search engines/boards | public listings (robots disallows `/c/`, `/a/`) |

Note: the audit brief called `/a/:token` the "candidate status page"; in code `/a/:token` is the tracked application link redirect, and the status page is `/c/status/:token`.

## 5. Data models and dependencies

- `candidates` (`packages/db/src/schema/hiring.ts:212`): one row per person per company; `dedupe_key` (unique per company), `consent` JSON (`application_terms`, `ai_notice`, `sms`), `preferences` (`smsOptOut`, `talentPoolOptOut`), `anonymized_at` (migration 0009).
- `applications` (:274): one per person per role (unique); `stage`, `answers` (eligibility, no-résumé answers and summary, notice versions shown, acknowledgment with IP), `eligibility`, `extraction`, `status_token`, `reply_token` (0023), `told_state` (0026), `source`, `link_id`.
- `documents` (:242): résumé files; `status` quarantined/clean/rejected/deleted, `uploaded_via`, scan fields (0016), `text_extracted`.
- `screens` (:368): the conversation; `token`, `transcript`, `answers`, `progress` (flow, phase, declined, edits, focus questions, countedAt, submittedAt, pausedAt), `invited_via`, `idle_reminded_at` (0033).
- `unconfirmed_screens` (:404, 0033): detached conversations of repeat submissions; hashed confirm token; never deleted, wiped after 7 days.
- `assessments`: AI readings (triage, screen) with quotes; `ai_runs`: every model call with structured output.
- `communications`: every message in and out (thread, outbox); `inbound_emails`: raw inbound mail and held applications.
- `data_requests` (0009): privacy requests; platform-only.
- `application_links` (0032): tracked links with `landing`.
- `interviews`, `interview_followups` (0035): scheduling and the Cancelled column.
- `events` / `audit_records`: facts such as `document.upload_used`, `application.duplicate_detected`, `screen.*`.
- Workflows: `application_intake`, `screen`, `schedule_interview`; jobs `candidate.link_request`, `screen.unconfirmed_discard`, `screen.unconfirmed_retry`, `document.discard_object`.

## 6. Roles and permissions specific to this area

- **Anonymous visitor**: can see public pages of ITS-confirmed companies only, apply, upload, ask for links, use the public privacy form. Rate-limited per address, role, link and email.
- **Candidate (link holder)**: the token is the whole credential. Status token: status page, withdraw, text preference, future roles, privacy request. Screen token: the conversation and its "person" and "withdraw" choices. Schedule token: pick, reschedule (twice), cancel. Status-page and screening writes check anonymization first (`anonymizedFor`, `found.gone`); the scheduling pages do not check it themselves (`pages/schedule.tsx` `loadByToken` :28-41) and rely on the deletion having withdrawn the application and cancelled future interviews (`closeProcessOnDeletion`), which closes them. Cannot see marks, the reading, the score, or an untold decision.
- **Address owner** (repeat submissions): can confirm answers or a person request through the emailed hashed token; cannot see the typed answers on that page (counts only).
- **Owner / admin (customer)**: cannot change the apply flow; indirectly controls it through the `application.invite_screen` policy ("Ask me first" and "Only a person" force the later path). Never sees unsent answers.
- **Hiring team**: receives notifications (held for eligibility, ready for review, asked for a person, withdrew); never sees what a candidate typed before Send.
- **ITS platform administrator**: confirms companies (makes pages public), switches apply flow per company and role, handles privacy requests (anonymization only after recorded counsel approval and explicit confirmation).
- **ITS recruiter**: switches a role's apply flow only under an active grant covering it; picks up "contact me" requests and adds call notes; does not see unsent answers.

## 7. Integrations and AI behaviour

- **AI (Anthropic, allow-list Haiku 5.5 / Sonnet 5.5, `packages/ai/src/routing.ts`)**: `resume.extract` (Haiku, fast tier), `triage.assess` (Haiku, high effort), `screen.turn` (Haiku, medium), `screen.assess` (Haiku, high). The model writes no number; the match score is computed in code from quote-checked findings (`packages/core/src/match-score.ts`). Every call is logged in `ai_runs`.
- **What the candidate is told about AI**: the AI-use notice on the job page and the form ("software that includes artificial intelligence... People make the hiring decisions"); the form's "Before you send" block (software organizes, summarizes and works out a match score; a person always decides); the acknowledgment box; the conversation's AI line and introduction on every conversation page; the acknowledgment and invitation emails' disclosure line; the status page's line; the `/privacy` page's provider list. The schedule pages say "Nothing here is decided by software" without the AI notice; status-link and opt-out emails carry no disclosure.
- **Decisions the candidate sees**: never a mark, hold or reading; a decline or talent-pool move only once told, in the words of the message that told them; an eligibility decline says which kind of answer and invites correction.
- **Candidate text as data vs instructions**: commands, skips and taps are parsed in code and never reach the model; model output is schema-validated and constrained (`enforceTurnRules`: only packet question keys, two follow-ups, packet wording added in code, model-call cap); the scorecard's quotes are checked in code; eligibility is never decided by AI. Prompts tell the model to treat candidate text as data (`FAIRNESS_RULES`, `SCREEN_SYSTEM`). However, unlike owner-supplied text (job ads, company notes, revision requests), candidate text is not wrapped in stripped data tags: the résumé goes between `<resume>` tags without `withoutTag`, the file name is placed unescaped in a tag attribute, screening messages are pasted unbracketed into the user turn, and the candidate's first name sits in the system prompt. No test feeds adversarial candidate text.
- **Storage**: Supabase S3 endpoint in production (enforced at boot, `env.ts:186`), local/memory otherwise; presigned PUT 5 min, GET 2 min.
- **Malware scan**: ClamAV over TCP (`clamav.ts`), or the fake scanner (default). A production worker on the fake raises one standing `scanner.fake` alert but keeps accepting files.
- **Email**: Postmark (outbox), inbound webhook with shared secret; reply-to addresses per application.
- **SMS**: Twilio with signature check; off by default.
- **Analytics**: allow-listed funnel events with HMAC references only; candidate pages load no analytics script.

## 8. Tests present and missing

Present (API, fake providers): `apply-conversation.test.ts` (E1–E13, allowance, outage, unfinished, ITS switch), `apply-visit-pages.test.ts` (intro, questions, taps, review, person, later, repeat pages, no-script), `apply-form-kept.test.ts`, `repeat-application.test.ts`, `repeat-conversation.test.ts`, `unsent-answers.test.ts`, `screen-keywords.test.ts`, `screening-rules.test.ts`, `screen-busy.test.ts`, `storage-uploads.test.ts` (quarantine, EICAR, outage, no-script, grants, download, anonymization of files, PDF/DOCX reading), `scanner-gate.test.ts`, `privacy-requests.test.ts`, `candidate-status-thread.test.ts`, `candidate-cancel.test.ts`, `candidate-look.test.ts`, `job-page.test.ts`, `public-job-surfaces.test.ts`, `held-email-replay.test.ts`, `approval-card-one-visit.test.ts`, `load-apply.test.ts`; packages: `eligibility.test.ts`, `apply-flow.test.ts`, `screen-answers.test.ts`, `file-inspection.test.ts`, `clamav.test.ts`, `documents.test.ts`, `screening.test.ts`; web: `tests/web/apply-flow.test.ts`; e2e: `candidate-phone.spec.ts`, `one-visit-owner.spec.ts`, `journey.spec.ts`. No skipped tests in this area (`docs/readiness/17`).

Missing: adversarial prompt-injection cases in résumés, file names, first names and screening answers; a check that `answerRecorded` is the candidate's own words; false positives of `redactProtected`; one-visit application for a second role with an existing person's address; anonymization of `assessments` and `ai_runs`; request-log redaction of `/c/confirm-answers/` tokens; clean-up of orphaned quarantine uploads; SMS screening messages on the status-page thread; consent recorded for emailed-in applicants; two simultaneous first applications with the same new address; Twilio routing when one phone has open screens at two companies; any run on the real model or real ClamAV.

## 9. Bugs and incomplete features

1. **(Medium) One-visit flow reveals that an address applied before, and the first name on file.** A stranger who types someone's email on a second role's form (one-visit role, eligibility "yes", automatic invitations) gets a real conversation whose introduction says "Hi <first name on file>" (`apply-conversation.ts:655` uses `b.candidate.firstName`; `screening.ts:217`; the existing person is reused unchanged, `applications.ts:81-100`; the typed name is used only for same-role repeats, `apply-conversation.ts:105`). This contradicts the design goal that typing an address reveals nothing, and the stranger's answers become part of the real person's application. Not covered by tests (`repeat-application.test.ts:209` runs on the later path).
2. **(Medium) Deletion leaves AI readings and AI run outputs.** `anonymizeCandidate` (`privacy-requests.ts:233-270`) clears résumés, extraction, screens, messages and notes but never touches `assessments.result` (verbatim résumé and answer quotes, summaries) or `ai_runs.structured_output` (`runner.ts:111`; the full extraction and recorded answers). The retention matrix says assessments are anonymized with the candidate (`docs/readiness/09` row 5). Verified: no code anywhere updates or deletes `assessments` or `ai_runs` for a person (grep), and the owner's pool-board list (`routes/roles.ts:432`: summary, two strengths, one concern) and candidate page (`routes/roles.ts:607-609`) read assessments with no anonymization filter, so the owner can still see the reading of a deleted candidate; no test checks it (`privacy-requests.test.ts` never mentions assessments).
3. **(Medium) The scorecard's quote check accepts the model's own words.** `verifyScreenQuotes` checks quotes against `candidateWordsOf`, which includes the recorded answers (`screening.ts:863-865`), and those are written by the model in `answerRecorded` with no check that they are the candidate's words (`screening.ts:627`). On the later path the candidate never sees the recorded answers; a paraphrase or invention by the model can then be quoted as "verified" to the owner.
4. **(Medium) Emailed-in applicants are recorded as consenting to notices they never saw.** New people get `application_terms.granted: true` and `ai_notice.granted: true` with an empty notice version regardless of channel (`applications.ts:83-87`; `postmark.ts:98-100`).
5. **(Low–medium) Uneven prompt-injection hardening of candidate text** (see section 7): `resume.ts:19` (file name in an attribute, résumé not tag-stripped), `triage.ts:67`, `screen.ts:94-99` (first name in the system prompt, messages unbracketed). Effects are bounded by schema checks and code rules, but the reading's summary and recommendation (which can trigger an automatic screening invitation) can be steered.
6. **(Low–medium) The "protected detail" filter drops ordinary sentences.** `redactProtected` (`screening.ts:165-170`) removes any sentence matching words such as "national", "visa", "citizen", "church", "married", "my kids" from the recorded answer; "I passed the National Board exam" or a typed answer to the work-authorization question can become "(answer recorded; personal details omitted)", which the candidate then sees on "Check your answers". The full transcript, protected words included, still reaches the team after Send, so the filter protects little.
7. **(Low) Orphaned résumé uploads stay forever.** An upload-intent followed by no successful submission leaves the file under `quarantine/` with no database row; nothing sweeps it (`candidate.tsx:326-342`; `maintenance.ts` has no such job; `docs/runbooks/resume-storage.md` names no lifecycle rule). These files cannot be found by a privacy request.
8. **(Low) Production can run on the fake malware scanner**, with an alert only (`registry.ts:148`, `scanner-gate.ts`); STATUS.md says ClamAV is not yet running.
9. **(Low) Repeat-confirmation tokens appear in request logs.** The logger redacts `/c/status|screen|schedule/` and the privacy verify path but not `/c/confirm-answers/` (`packages/contracts/src/security/redact.ts:26-27`; `app.ts:53`), though `maskTokenPath` (`csp.ts:46`) knows it.
10. **(Low) SMS screening messages show on the status-page thread.** `threadOf` excludes only web messages (`thread.tsx:27`), so the assistant's texts and the candidate's texted answers appear, contrary to its own comment. Only when texting is on.
11. **(Low) Twilio picks the first open screen, not the most recent,** when one phone has open screens at two companies: `target` never stores `updatedAt` (`twilio.ts:63`).
12. **(Low) A corrected email address is not re-keyed.** `fulfilCorrectionRequest` changes `email` but not `dedupe_key` (`privacy-requests.ts:129`), so "Lost your link?" from the new address finds nothing and a new application from it creates a second person.
13. **(Low) Two address-matching rules.** The public privacy form matches the exact address (`privacy-request.tsx:109`), "Lost your link?" matches the folded dedupe key (`applications.ts:221-224`). An address typed exactly as on file is found by both; a different spelling of the same Gmail box (for example `janedoe@gmail.com` when the application used `jane.doe+jobs@gmail.com`) is found by "Lost your link?" but not by the privacy form.
14. **(Low) Simultaneous first applications with the same new address** (two roles at once) can collide on the unique `(company, dedupe_key)` index and fail with a server error (`applications.ts:81-91`). Plausible, untested.
15. **(Low) Misleading form error.** A bad optional phone (under 7 characters) or long location is highlighted, but the message says only name, email and the confirmation are required (`candidate.tsx:401`).
16. **(Low) Status-page dates** use the server's locale and time zone (`toLocaleDateString()` without a zone, `candidate.tsx:762-763`), so "Applied" can be a day off.
17. **(Low) Inconsistent withdrawal records.** Withdrawing on the status page records a fulfilled privacy "withdrawal" and emails a confirmation (`candidate.tsx:1747-1755`); withdrawing inside the conversation (`screening.ts:560-584`) does neither.
18. **(Info) "Do this later" emails once per conversation** (`apply-messages.ts:37` idempotency key) but the page always says the link was emailed; a second opt-out from future roles after opting back in sends no confirmation (`candidate-links.ts:132`).
19. **(Risk) No CAPTCHA**: up to 60 applications an hour per internet (IP) address and 600 per role, each triggering two model calls and an acknowledgment to whatever address was typed (`rate-limit.ts:31`).
20. **(Incomplete) Status-link rotation and the apply-form CSRF token** promised in the specs do not exist (APPLY-45, APPLY-46); CSP is report-only by default (APPLY-47); no OCR for scanned résumés; no manual add of a candidate (APPLY-50).
21. **(Info, added in verification) The résumé reading is told about the person's earlier applications at the company and how they ended.** The `ready` step passes every other application of the same person (role title, stage such as `rejected` or `withdrawn`, date) to `triage.assess` (`application-intake.ts:209-218`; `packages/ai/src/prompts/triage.ts:70` `<prior_applications>`). The fairness rules do not mention it, so an earlier "no" can colour the reading (and the screening invitation it may trigger) for a new role. Possibly intended (returning applicants), but it is undocumented in the candidate notices and untested.

## 10. Doc/code drift

- `docs/STATUS.md:212` says "status page by signed token"; `docs/spec/02-roles-and-permissions.md:17` says "signed tokens in links". The tokens are random values looked up in the database (`randomToken`, `docs/readiness/14`).
- `docs/spec/02-roles-and-permissions.md:101` and `docs/spec/04-screens-and-states.md:43` promise status-link rotation ("get a new link"); `docs/spec/00` S4 says status tokens "can be rotated by the candidate". Not implemented.
- `docs/spec/02-roles-and-permissions.md:102` says a screen token lives "until the screen completes, expires (120 h), or is handed off"; the link keeps opening a closed page with the full transcript.
- `docs/spec/02-roles-and-permissions.md:105` says logs redact all candidate tokens; the confirm-answers token is not redacted in request logs.
- `docs/spec/04-screens-and-states.md:40` lists a "CSRF token" on the apply form; there is none.
- `docs/readiness/09-data-retention-matrix.md` row 5 ("assessments anonymized with the candidate; run logs deleted") and runbook step 4 ("locate ... assessments") vs `anonymizeCandidate`, which leaves both.
- `docs/runbooks/privacy-requests.md` "How a candidate makes a request" mentions only email; the status-page form and the public form (D13) now exist.
- `docs/customer/01-what-you-get-and-what-is-not-included.md:44` "Every candidate page and every automated message says that an AI assistant helps": status-link, repeat-notice and opt-out emails (`disclosureIncluded: false`) and the scheduling pages do not.
- `docs/customer/01...md:48` "A resume is checked and scanned before anyone... can open it": true only with ClamAV; the default engine is a fake.
- `docs/STATUS.md:133` "no real résumé may be accepted" until ClamAV: a procedural rule; the code accepts files and raises an alert.
- `docs/STATUS.md:224` (historical walkthrough) "status page shows 'Eligible'": the page now shows only four candidate steps.
- `apps/api/src/pages/thread.tsx:12-13` says the reply's sending address proves who wrote it; `services/replies.ts` trusts the reply token and never checks the From address.
- The audit brief's "/a/:token status page" is the tracked-link redirect; the status page is `/c/status/:token`.
- `docs/12-api-contracts.md:146` lists `POST /applications` (`CreateApplicationManual`, "Recruiter manual add or import"); no such route or contract exists (APPLY-50). Comments in `services/applications.ts:31,52` also speak of "manual adds".
- STATUS.md is dated 9 October and predates the 11–14 October merges; nothing in it contradicts the candidate code beyond the items above.

## 11. Unknowns

- Whether ClamAV is running for staging or production, and what happens to applications whose scan fails more than the workflow's four attempts (likely stuck at "received" with an ITS escalation).
- Whether the inbound mail domain is configured, so that replies, HUMAN and "no thanks" by email reach the product rather than the ITS mailbox.
- How Haiku 5.5 behaves in `screen.turn` and `triage.assess` with real and adversarial candidate text; all tests use the fake provider.
- Whether CSP is switched to enforce in production.
- Whether the storage bucket has a lifecycle rule for `quarantine/`.
- Whether `APP_BASE_URL` and `JOBS_BASE_URL` differ in production (privacy-confirmation and scheduling emails use the app address, other candidate links the job-page address).
- Whether parsing untrusted PDFs and Word files in the worker process (pdf-parse, mammoth) is isolated enough.
- Counsel answers: timing of the AI notice before the same-visit conversation (register item 20), retention periods, whether a deletion must also remove AI readings, and whether an access request must include the AI reading and score.

## 12. Verification notes

A second, skeptical pass (14 Oct 2026) re-read the code behind every bug, every non-"fully implemented" feature and 25 "fully implemented" ones. What changed and why:

- **All 20 original bugs reproduced from code; none refuted.** Key checks: bug 1 (`apply-conversation.ts:93-125` creates a real screen for a second-role application under the existing person; `:655` greets `b.candidate.firstName`; only same-role repeats use the typed name, `:105`); bug 2 (no `assessments`/`ai_runs` write in any anonymization path); bug 3 (`screening.ts:627` stores the model's `answerRecorded` after `redactProtected` only, `candidateWordsOf` :863-865 includes it; later-path screens complete without review, `writeReply` :502); bug 4 (`postmark.ts:98-100` + `applications.ts:83-87`); bug 5 (`withoutTag` used only in owner-text prompts); bug 9 (`redact.ts:26-27` omit `confirm-answers`, `csp.ts:46` includes it); bug 11 (`twilio.ts:63` compares against an `updatedAt` that `target` never stores); bug 12 (`privacy-requests.ts:129` updates `email` only); bug 17 (`screening.ts:560-584` uses `exitCleanup` via `services/screens.ts:21` but records no data request and sends no completion email).
- **Bug 2 strengthened:** the owner's pool board and candidate page still read the AI reading of an anonymized person (`routes/roles.ts:432`, `:607-609`).
- **Bug 13 reworded:** an address typed exactly as on file is found by both forms; only a different spelling of the same Gmail box differs.
- **APPLY-05 / bug 19 clarified:** the 60-per-hour limit is per internet (IP) address, not per email address, and is shared by the upload and the submit.
- **Roles section corrected:** the scheduling pages do not check anonymization themselves; they rely on the deletion closing the application and interviews.
- **Statuses of APPLY-08, -31, -41, -45, -46, -47, -48 confirmed** (no rotation route or token update for `statusToken` exists; no origin/CSRF check on candidate form posts, `sameSiteChanges` covers `/api/*` only; `CSP_MODE` defaults to report-only, `env.ts:158`; `SCAN_PROVIDER` defaults to `fake`, `registry.ts:148`).
- **Fully-implemented features traced UI → route → service → DB and kept:** APPLY-01, 02, 03, 04, 05, 06, 09, 10, 11, 12, 14, 15, 18, 19, 20, 23, 24, 29, 33, 35, 36, 37, 38, 39, 42, 44. No downgrade was needed.
- **Added APPLY-50** (manual add / import of a candidate: promised in `docs/12-api-contracts.md:146`, not built) and **APPLY-51** (interview accommodation note and "none of these times work", built).
- **Added bug 21** (Info): earlier applications and their outcomes are passed to the résumé reading.
- **Added doc drift** for `docs/12-api-contracts.md:146`.
