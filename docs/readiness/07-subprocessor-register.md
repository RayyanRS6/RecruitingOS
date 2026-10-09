# Subprocessor register (release 1)

Status: **Draft for counsel** (`docs/legal-drafts/09` is the customer-facing list). Every provider below is **not yet contracted**; accounts are opened by Nadine or Paul (`docs/spec/13`). "Data" names the categories that reach the provider once live.

| Provider | Purpose | Data | Region | Contract basis | Status |
|---|---|---|---|---|---|
| Vercel | hosting the application and API | request data in transit; no candidate data at rest | US | Vercel terms + DPA | account not created |
| Supabase | database, authentication, file storage, secret store | all product data: customers, candidates, applications, resumes, messages, audit; credentials in Vault | US, West US (Oregon), us-west-2 | Supabase terms + DPA | organization and staging project created 22 Sep (reference `vjuaiyjmtrenbrmujvtc`); production project not created; DPA not yet accepted (gate 2.7) |
| Trigger.dev | not used | none | n/a | none | not used: the Railway worker runs the product's own job engine (decision 1, 22 Sep); a move would need its own founder decision. Kept here so the earlier plan is not mistaken for a gap |
| Anthropic | AI model calls | role text, resume text, screening answers, candidate names as they appear in text (no phone or email is sent; see `08`) | US | Anthropic commercial terms; no training on API data | account not created |
| Postmark (ActiveCampaign) | transactional email out and inbound applications | recipient address, message content, attachments (resumes for email-in) | US | terms + DPA | account not created |
| Twilio | SMS screening (off until 10DLC approved) | phone numbers, message content | US | terms + DPA; 10DLC registration | account not created |
| Google (Cloud, Calendar API) | interviewer calendars | interviewer account email, free/busy, event details (candidate name, interview time, meeting link) | US | Google Cloud terms + DPA | project not created |
| Microsoft (Entra) | staff sign-in | staff identity claims only | US | Microsoft 365 existing tenant | registration not created |
| Sentry | error tracking | scrubbed error events (no cookies, tokens, or candidate identifiers; opaque user id) | US | terms + DPA | account not created |
| PostHog | product analytics | allow-listed funnel events with keyed identifiers; no candidate PII; nothing from candidate pages | US | terms + DPA | account not created |
| Railway | hosting the background worker process (jobs, reminders, timers) | the worker loads what its jobs need: candidate fields, messages, interview times, in memory during a job; nothing at rest on Railway | US | Railway terms + DPA | account not created (founder decision 1, 22 Sep) |
| Upstash (Redis) | shared request-rate counters | HMAC-derived keys and counts only; no address, email, phone or token | US | Upstash terms + DPA | account not created (founder decision 4, 22 Sep) |
| GoDaddy | registrar, DNS, existing website | none (DNS records) | US | existing | in place |
| 1Password | credential storage for ITS | ITS credentials only | US | to be created | account not created |

Rules: a new subprocessor is added here and to the customer list before it receives any data; design partners are told of additions with notice as the pilot agreement will require (counsel).
