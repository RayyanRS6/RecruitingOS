# Pilot support runbook

Status: **Built with mocks** (the product surfaces exist); the human process starts with the first design partner. Support hours follow the ITS business calendar published in the admin console (default Monday to Friday, 9 to 5 Pacific).

## Channels

| Who | How they reach us | Where it lands | Response |
|---|---|---|---|
| Design partner owner or team | "Bring in a recruiter" in the product; `support@identifiedtalent.com` | ITS recruiter queue (with the generic preview); the shared support mailbox | per the escalation SLA by category (candidate issue 4 business hours; negotiation and platform blocking 2; others 8) |
| Candidate | reply to any message with HUMAN; the status page form; `privacy@` for privacy requests | recruiter queue (candidate issue); privacy requests console (admins only) | 4 business hours for a person; privacy requests within the deadline |
| ITS staff | Slack/Teams (internal) | | |
| ITS staff who lost every authenticator | a call or in person, never email alone | same day | the platform owner runs the dashboard reset in `docs/runbooks/staff-second-factor.md` and notes it in the queue mailbox |

## Daily (business days)

1. Open the admin console: Failures tab (operator alerts: credential deletions, suppressions, spam complaints), Queue health, Privacy requests (due dates).
2. Recruiter queue: accept what is due; every acceptance opens scoped access that ends on resolution.
3. Check the ITS queue mailbox for escalations that arrived by email.

## Weekly

- Review the business calendar for upcoming closures; publish changes with an effective date; recalculate open deadlines only when a closure was added after requests opened.
- Review suppressed addresses; release only after confirming an address by another channel (never a spam complaint).
- Review AI cost by customer (Costs tab) against the pilot's included limits.

## Common situations

| Situation | What the product did | What a person does |
|---|---|---|
| Candidate cannot be reached (hard bounce) | address suppressed; owner notified; text sent if consented | call the candidate; correct the address through a privacy correction request if they ask |
| Interview times never answered | reminder after two days; expiry after four with owner actions | the owner re-offers, decides, or brings in a recruiter |
| Chosen time was taken | re-offered; after three, recruiter escalation | recruiter arranges a time directly |
| Candidate cancelled a booked interview | recorded their choice (new times later, or no longer interested) and put them under Cancelled; for "new times", one automatic set after the company's working days (3 by default; never during a takeover, after two reschedules, for someone on hold, or before ITS confirms the company); the team told which | nothing, unless the team asks; during a takeover the recruiter sends new times from the candidate's page or decides; a candidate who replies HUMAN gets a person and their pending set is stopped |
| Candidate did not show | under Cancelled as a no-show; nothing sent automatically; the team told | the team sends new times for the same round or decides; a no-show recorded by mistake cannot be undone, so the team sends times or decides |
| "New times" did not go | the set ended not sent with the reason (no email, interviewer left the team, takeover, the ITS check not done in time) and the team was told | the owner sends new times from the candidate's page, approves a new interview with other interviewers, or calls the candidate |
| Calendar credential revoked | declared hours used; the person told | the person reconnects in Setup |
| Credential deletion failed | alert, connection disabled, retries | retry from the console; if it keeps failing, delete in the Supabase Vault UI and note it |
| Privacy request | recorded, acknowledged, deadline tracked | follow `docs/runbooks/privacy-requests.md`; deletion only after counsel |
| Suspected data exposure | | `04-incident-response.md` (S1) |
| Design partner asks for a feature outside release 1 | | log it in the register (`docs/spec/00`) for Nadine's decision; do not build it in the pilot |

## Reporting to the founder

Weekly: escalations by category and response time, interviews scheduled and completed, candidates unreachable, open privacy requests with due dates, open alerts, AI cost per customer.

## Partner acknowledgements (gate 4.8 of `docs/readiness/16`)

| Partner | Pilot agreement signed (date, filed in the vault) | Recruiter-access summary acknowledged (date) | Demonstrated by |
|---|---|---|---|
| | | | |

## Privacy-request walk-through log (gate 4.7 of `docs/readiness/16`; counsel register item 6)

| Date | Handled by | Request kind | Entered, acknowledged, fulfilled, confirmed (dates) | Notes |
|---|---|---|---|---|
| | | | | |
