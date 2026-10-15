# Data-flow map (release 1)

Status: **Built with mocks** (the flows exist in code and tests; the external legs are exercised only against fakes). Read with `docs/spec/05` (schema) and `09` (security).

## Actors and surfaces

- **Candidate** (public pages, token links): job page, application form, status page, screening conversation, scheduling pages, privacy requests.
- **Customer users** (owner, hiring manager, interviewer, HR, admin): the signed-in app.
- **ITS staff** (recruiter, platform admin): queue, console; tenant data only under a grant.
- **Automations**: workflow engine (worker role), AI provider, email, SMS, calendar.

## Flows

| # | From | To | Data | Purpose | Controls |
|---|---|---|---|---|---|
| 1 | Candidate browser | API (`/careers`, `/c`) | name, email, phone, location, resume, eligibility answers, the company's quick-question answers, a work summary, consent flags; chat replies and changes to the written-up answers; edits to facts their record learned | apply, screen, review and send, schedule, read their application record (their score, what they sent), privacy requests | HTTPS; token links 192-bit; rate limits; no third-party scripts on candidate pages; notices shown and recorded (`noticeVersionsShown`) |
| 2 | API | Postgres (tenant transaction) | as above, plus events and audit | store and process | RLS by company; `ros_app` non-privileged; every privileged read audited |
| 3 | browser → Supabase Storage (presigned, 5 minutes); worker reads, checks, scans, moves | Supabase Storage (private bucket, S3 keys, never the service-role key) | resume file | keep the original | quarantine key, then `<company>/<candidate>/<application>/<random>`; staff reads through audited 2-minute links; deleted on anonymization |
| 4 | Worker | Anthropic | role packet text, resume text, screening transcript; the candidate's name and contact details where they appear in text only for résumé extraction and the screening chat's own turns | draft packets, extract facts with quotes, assess, screen | no phone or email fields are sent; the scoring reads (`triage.assess`, `screen.assess`) get the redacted scoring view: name, email, phone, street address, zip code and web links replaced by placeholders (`packages/agents/src/scoring-view.ts`, founder decision D-04 C, Wave S2), and never the person's earlier applications or how they ended; candidate text cannot close the prompt's data blocks; outputs are evidence-bound and validated, and quotes shown to the team are the original words; every run logged in `ai_runs` with cost (the scoring view's version and counts, never the hidden values); the quick start's suggestions (`intake.suggest`, Haiku 5.5, Wave S3) get only the job's own facts typed by the owner (title, employment type, work model, place, minimum years), never candidate data, and every suggestion passes `screenCriterion` before it is shown; Wave S7: the résumé chosen on the form is read at once by `resume.extract` on the worker, only after the scan, and a reading never sent is deleted after a day; the chat (`screen.turn`) gets the form's answers as sentences and the résumé lines, and the company's private "what a good answer shows" only to guide its questions; `screen.writeup` gets the company's written questions and the chat's transcript, never "what a good answer shows"; the fake provider in development |
| 5 | API/worker | Postmark | recipient address, subject, body, attachments (ICS) | candidate and team messages | disclosure on candidate messages; suppression list consulted before every send; idempotency keys; bounce and complaint webhooks back to the API (secret) |
| 6 | Worker | Twilio | phone number, message | screening by text (off until 10DLC) | consent required; STOP honoured; quiet hours; disclosure |
| 7 | Worker | Google Calendar | interviewer calendar id, free/busy query, event with candidate name, time, meeting link | schedule interviews | refresh token only in Vault; read audited with purpose; narrow scopes; one event per interview; deleted on cancel |
| 8 | API | Supabase Auth | sign-in tokens (verified, never stored) | authentication | PKCE; staff Microsoft + TOTP rule; short staff sessions |
| 9 | API/worker | Supabase Vault | calendar refresh tokens | store, read, delete | worker-only decrypt; every read audited; deletion on disconnect with alert on failure |
| 10 | API | PostHog | allow-listed events with keyed references | funnel measurement | no PII; nothing from candidate pages; salt per environment |
| 11 | API/worker | Sentry | scrubbed errors | reliability | scrubber by value and by shape; no cookies or tokens |
| 12 | API | ITS queue mailbox | category, urgency, expertise, generic summary | escalation | never the customer's words or candidate data before acceptance |
| 13 | ITS recruiter | tenant data | the escalation's role and candidate only | help the customer | grant per escalation, 14 days, every request recorded; ended on release |
| 14 | Platform admin | candidate data (privacy requests) | the person's own data | fulfil access, correction, anonymization | admin-only table; export audited; anonymization only after counsel decision; anonymization also scrubs the AI's readings of the person and the AI run log about them, found by application, screen, document and workflow run, keeping only ids, task, model, prompt, tokens, cost, timings and status (`scrubCandidateAiData`, Wave S2), and the workflow engine's copies too: runs still going are cancelled, and run state, step records and the copies of a step's error in the run's events and queued job keep only ids, status, step names, codes and timings (`scrubCandidateWorkflowData`, Wave S3; a step still running when its run is cancelled writes nothing back); the daily maintenance repeats both for runs that finished later; the "your data was deleted" email and the removal of stored files happen after the commit |

| 15 | API | Candidate browser (application record, Wave S7) | their own match score with a bar per requirement named on the job page (others folded into one line), exactly what they sent, the decision once told, their other applications at the same company (no links), facts their record learned from their sent chats | the candidate's own record | behind their private link only; the score behind an ITS switch per company (on by default); nothing from an unsent chat; never the team's notes or private criteria; per company only |

## What never flows

- Candidate phone numbers and email addresses to the AI provider as fields; to the scoring reads, not even inside the text, nor the candidate's name, street address, links or earlier applications (Wave S2); candidate data to PostHog or Sentry; a company's private "what a good answer shows" or its private criteria to candidates; a candidate's record or learned facts from one company to another; credentials to logs, events, audit records, analytics, error tracking, or documentation; production candidate data to development or staging.
