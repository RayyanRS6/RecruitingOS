# Runbook: candidate privacy requests (access, correction, deletion or anonymization)

Status: built with synthetic data on 18 September 2026 (admin console → Privacy requests; candidate status page form; `apps/api/src/privacy-requests.test.ts`); the human steps below remain the process, the console records them. Required before production candidate data. Automation may follow later. Counsel register item 6 governs the legal deadlines and item 9 the retention interactions; until counsel answers, the deadlines below are conservative defaults and no irreversible deletion is performed in production.

## Roles

- Request intake and handling: the privacy handler (Nadine, or the person she designates), reading the shared mailbox `privacy@identifiedtalent.com`. Nobody else reads that mailbox.
- Verification and recording: the platform administrator (Nadine or Paul), in the admin console (data-request record) or, until that view exists, in the `Recruiting OS Accounts` vault's "Privacy requests" log.
- Conflicts involving employment-record retention, litigation holds, or a request from a person who was hired: escalated to counsel before any deletion.

## How a candidate makes a request

- The privacy page (`/privacy`) and the status page tell candidates to email `privacy@identifiedtalent.com` from the address they applied with.
- Any message to the hiring reply address that says "privacy request", "delete my data", "access my data", or similar is forwarded to `privacy@` the same business day.

## Steps

1. **Acknowledge** within one business day from `privacy@`: confirm receipt, state the expected completion date, and, if the sending address does not match the application, ask the requester to reply from the applying address or to confirm one detail only they would know (the role applied to and the approximate date). Do not ask for identity documents.
2. **Record** the request: date received, requester address, company (tenant), application(s) found, request kind (access, correct, delete), verification method and date, deadline (45 days from receipt, extendable once by 45 days with notice, pending counsel), handler, status.
3. **Verify** identity by the reply-from-applying-address rule, or by the detail check above. Record how it was verified.
4. **Locate** the records: candidate, applications, documents (resume file and extracted text), assessments, screens (transcript and answers, the answers to a screen's opening questions included), communications, events and audit records naming the person, calendar invitations once scheduling exists.
5. **Act**:
   - Access: export the candidate's own data (application answers, resume, communications sent to them, screening transcript, the stage history). Do not include the assessment's internal rationale or other candidates' data; include the evidence-based reasons recorded with a human decision if one was made. Send it as a password-protected file with the password sent separately.
   - Correction: correct the field the person identifies (name, contact details, an answer they say was entered in error). Record what changed and why. Corrections that would change an eligibility outcome are routed to the hiring team as a "review anyway" decision, never applied silently.
   - Deletion or anonymization: in the pilot, **anonymize rather than delete** where a retention obligation may apply: replace name, email, phone, location, and free-text answers with tokens; delete the resume file and its extracted text from storage; keep the event skeleton (stage changes, dates, decision records) without personal fields. Full deletion only when counsel confirms no retention obligation applies. Never delete audit records; anonymize personal fields in their `details` if present.
6. **Confirm completion** to the requester from `privacy@`, stating what was done and what was retained and why (in plain language).
7. **Close the record** with the completion date, the handler, and a link to the confirmation.

## Someone who asked for access (6 November 2026)

A person who signed in and sent the company form under `SIGNUP_MODE=approval`, waiting or declined, is not a candidate. The public form answers as if their company did not exist, so the privacy mailbox is how they reach us. **Record a request from the privacy mailbox** can record it against their company, but access, correction and deletion all need a candidate, which they are not, so the console cannot carry it out. What we keep about them and for how long is not decided (register item 35; `docs/workflow-decisions.md`, AQ-1). Until it is, delete nothing by hand: tell the founder the same day, treat the 45 days as running, and say from `privacy@` what we hold.

## Someone locked (the plans of 5 November 2026)

An application past a plan's candidates per job is locked: the hiring team cannot read it, and no AI has. Every step above works the same for them, from the same console. Decided defaults, for counsel to confirm (register items 30, 31 and 33; `docs/workflow-decisions.md`, PQ-6, PQ-13, PQ-15):

- **Nothing goes to the team while they are locked.** No notice names them, and their request does not show on the company's pages. Do not write to the company about them.
- **Access.** The export runs on the platform side, so it holds everything they gave. Each application that was ever locked carries `hiringTeamCanSeeThis` (`false`, or `true` with `hiringTeamCanSeeThisSince`), in no plan's words.
- **Correction.** Change the field as usual. The rule above sends a correction that changes an eligibility outcome to the hiring team, which cannot happen while they are locked: keep it as a note on the request. The team sees the corrected answer if a change of plan opens them, and it is read as any other answer then.
- **Deletion.** The same anonymizing. A deletion frees no place, so it never reveals the next person, and the company's locked card for them stays a card with no name. The code refuses every deletion without a recorded counsel decision, and no counsel is engaged, so **a real deletion request cannot be finished today**: escalate it to the founder on the day it comes in, because the 45 days are running.
- **A person's review.** It opens an ITS request whose record holds their name, email, résumé and answers, and a recruiter reads them only under a grant naming that application. ITS cannot unlock one card in this release, so say plainly what the review can and cannot do.
- **What ITS may say.** If they ask why: "The employer did not review your application." Never name the plan, the limit or the money, on any channel. Do not say or hint how many applied or where they came in. Do not tell the employer who asked. If someone keeps asking for the reason, or the candidate is in Colorado, escalate to the founder and counsel before answering (register item 30).
- **An employer's legal need.** If an agency or a lawsuit asks an employer for applicant records, it is never told "upgrade first": ITS produces locked records for a recorded legal reason, and a litigation hold stops deletion as above. Record the reason and who asked in the request's notes, and tell the founder.

## Restrictions

- Only the privacy handler and the platform administrators see privacy requests. Customer users see only that a request was fulfilled on a candidate's record ("data request fulfilled"), never its content.
- Requests are never handled through the general support inbox.
- No deletion is performed on a candidate who is under a litigation hold, who was hired (employment records), or where the customer has told ITS of a dispute; counsel advises and the founder decides.

## Test of this runbook (tabletop, to be repeated before real candidate data)

Walk through one synthetic access request and one synthetic anonymization request end to end in staging: send the email, acknowledge, verify, locate, act, confirm, close, and check that the application, screen, documents, and communications no longer contain the synthetic person's details while the stage history remains. Record the date and the two handlers who performed it in the counsel register's evidence column for item 6.
