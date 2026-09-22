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
| 1 | Candidate browser | API (`/careers`, `/c`) | name, email, phone, location, resume, eligibility answers, consent flags | apply, screen, schedule, privacy requests | HTTPS; token links 192-bit; rate limits; no third-party scripts on candidate pages; notices shown and recorded (`noticeVersionsShown`) |
| 2 | API | Postgres (tenant transaction) | as above, plus events and audit | store and process | RLS by company; `ros_app` non-privileged; every privileged read audited |
| 3 | API/worker | Supabase Storage | resume file | keep the original | per-tenant prefix; deleted or replaced on anonymization |
| 4 | Worker | Anthropic | role packet text, resume text, screening transcript, candidate name where it appears in text | draft packets, extract facts with quotes, assess, screen | no phone or email fields are sent; outputs are evidence-bound and validated; every run logged in `ai_runs` with cost; the fake provider in development |
| 5 | API/worker | Postmark | recipient address, subject, body, attachments (ICS) | candidate and team messages | disclosure on candidate messages; suppression list consulted before every send; idempotency keys; bounce and complaint webhooks back to the API (secret) |
| 6 | Worker | Twilio | phone number, message | screening by text (off until 10DLC) | consent required; STOP honoured; quiet hours; disclosure |
| 7 | Worker | Google Calendar | interviewer calendar id, free/busy query, event with candidate name, time, meeting link | schedule interviews | refresh token only in Vault; read audited with purpose; narrow scopes; one event per interview; deleted on cancel |
| 8 | API | Supabase Auth | sign-in tokens (verified, never stored) | authentication | PKCE; staff Microsoft + TOTP rule; short staff sessions |
| 9 | API/worker | Supabase Vault | calendar refresh tokens | store, read, delete | worker-only decrypt; every read audited; deletion on disconnect with alert on failure |
| 10 | API | PostHog | allow-listed events with keyed references | funnel measurement | no PII; nothing from candidate pages; salt per environment |
| 11 | API/worker | Sentry | scrubbed errors | reliability | scrubber by value and by shape; no cookies or tokens |
| 12 | API | ITS queue mailbox | category, urgency, expertise, generic summary | escalation | never the customer's words or candidate data before acceptance |
| 13 | ITS recruiter | tenant data | the escalation's role and candidate only | help the customer | grant per escalation, 14 days, every request recorded; ended on release |
| 14 | Platform admin | candidate data (privacy requests) | the person's own data | fulfil access, correction, anonymization | admin-only table; export audited; anonymization only after counsel decision |

## What never flows

- Candidate phone numbers and email addresses to the AI provider; candidate data to PostHog or Sentry; credentials to logs, events, audit records, analytics, error tracking, or documentation; production candidate data to development or staging.
