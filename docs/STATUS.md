# Implementation status

Updated 14 September 2026. "Done" means the definition of done in docs/13 (UI, backend, database, permissions, error handling, audit events, tests, edge cases, failure states, human escalation, documentation) unless a gap is listed.

## Slices

| Slice | Scope (docs/09) | Status | Verified by |
|---|---|---|---|
| **1** | Company and user creation, conversational intake, Role Packet (versioned), approval, posting to channels, applicant capture (web and email-in), acknowledgment, eligibility, resume extraction, Ask a recruiter, brief, admin console, policy engine, workflow engine, RLS | **Done, with gaps below** | `pnpm test` (71 tests across RLS, core, agents, integrations, API lifecycle, Slice 2 API, the dental scenario steps 1 to 10c, and the consumer scenario in `tests/scenario/consumer-lifecycle.test.ts`), `pnpm eval` (7 suites at threshold), and a browser walkthrough of the whole flow (below) |
| **2** | Evidence-based assessment (Triage agent), text screening (web chat and SMS) with scorecards, recommendations under policy, "do it and tell me" notifications, stuck-role detector with an intervention ladder, Twilio adapter and inbound webhook | **Done, with gaps below** | `apps/api/src/slice2.test.ts` (10 tests), scenario steps 10, 10b, 10c, eval suites `triage.edge_cases`, `triage.hallucination`, `screen.conversation` |
| 3 | Calendar OAuth, scheduling, interview briefs, recording with consent, draft scorecards, debrief | Not started | steps 11 to 13 `todo` |
| 4 | Offer agent, approvals, e-signature, acceptance, negotiation support | Not started | step 14 `todo` |
| 5 | Onboarding, handoff packet, BambooHR, 30/60/90 outcomes | Not started | step 15 `todo` |
| 6 | Recruiter takeover mode | Not started (escalation, claim, resolve exist) | step 16 `todo` |
| 7 to 10 | Rediscovery, external sourcing, analytics, vertical intelligence | Not started | |

## Founder context applied (14 September 2026)

The consultant-completed founder intake (`docs/FOUNDER-CONTEXT.md`) was adopted as the governing context and reconciled decision by decision in `docs/17-founder-context-reconciliation.md`. Applied in code: the consumer/beauty/e-commerce/creative playbook as the default vertical (six roles), company setup leading with the wedge, plans at Core $499 / Growth $899 / Company $1,499, navigation Today / Roles / Talent / Setup, "Bring in a recruiter", "recruiting chief of staff", "Insufficient evidence", Today's four-question summary, an electric accent, evidence items with confidence and context, a one-click assessment flag with the learning-loop taxonomy, "Review anyway" for eligibility declines, a required reason to override an eligibility hold, candidate withdrawal and text-message preference on the status page, and a second end-to-end scenario (a beauty brand hiring a performance marketing manager). Sequenced for later slices: calibration memory and close plans, Interviews/Offers/Insights navigation, rediscovery and sourcing, recruiter time metering, jurisdiction policy overrides, deletion workflows.

## What works today (Slice 1)

- Sign up with a magic link; create a company; invite teammates with roles; sessions with revocation.
- Home: the brief (deterministic, from the system of record) and the conversation. A hiring sentence starts intake; the assistant asks recruiter questions, declines unlawful criteria with a lawful alternative, and compiles a Role Packet with the dental playbook and a compensation benchmark (BLS OEWS live when reachable, playbook ranges otherwise).
- Role page: approve the packet as one thing (policy `role_packet.approve` = approval by owner/admin/hiring manager); edit creates a new version; every version kept; posting status per channel with instructions and the intake address; pause/resume/close.
- Publishing (founder decision F4, only verified states): the careers page is live and verified; Google for Jobs data is submitted and awaits verification in Search Console; email-in capture is live only when the inbound mail domain is configured, otherwise not connected; Indeed, LinkedIn, and ZipRecruiter require manual posting from the customer's account with the apply link or intake address; channel failures retry without blocking the role.
- Candidate experience: mobile-first job page with pay range and notices, three-minute apply with separate SMS consent and the AI-use notice, no-resume path, honeypot and rate limit, status page by signed token, privacy page.
- Application intake workflow: dedupe, resume storage and text extraction (PDF, DOCX, text), acknowledgment with disclosure and human alternative within the workflow, deterministic eligibility on owner-authored rules only, 24-hour review window with owner override before a courteous disposition, AI extraction with quotes verified against the source, retries on provider outages, escalation on hard failure.
- Email-in: Indeed-style forwarded applications become applications with the attached resume.
- People: plain-language groups, evidence chips, decline with a required reason (human-only, audited), override eligibility, hold, talent pool.
- Ask a recruiter from every decision surface with a complete context snapshot; ITS queue with claim and resolve; notification to the ITS queue mailbox.
- Setup: company, team, connected-service statuses, and the policy editor with four levels and locked human-only decisions.
- Admin console: customers with churn signals, workflow runs with step ledger and retry, AI runs with tokens and cost, failures, costs by task and model, queue health. Every read audited with a reason.
- Security: RLS enforced in Postgres (tested on PGlite), non-privileged tenant role, hashed sessions and magic links, rate limits, signed candidate tokens, honeypot, production boot checks.
- Observability: `ai_runs` row for every model call with prompt version, hash, tokens, cost, latency, output, status; events for every action; audit records for privileged reads.

## Verified in the browser (10 September 2026)

On a fresh local database, in the in-app browser: request a sign-in link → open the emailed link (the API sets the cookie and redirects into the app) → create Brightline Dental Group (Denver, CO, 100-199 employees) → describe the hire in one sentence → answer the assistant's questions (live BLS OEWS benchmark for SOC 291292) → reload the page mid-conversation and resume it → draft the Role Packet → review Overview, Requirements, and How we'll evaluate → approve and post → Posting tab shows the careers page, intake address, Google Jobs, LinkedIn feed live and Indeed/ZipRecruiter one step away → public apply page with the no-resume path and four eligibility questions → status page shows "Eligible" with the acknowledgment → People lists the applicant with evidence chips → Home brief shows "1 candidate needs your review" and the one-step posting nudges.

First-run fixes made during that walkthrough: PGlite data directory created on first boot; `hono/jsx` pragma for SSR pages under `tsx`; sign-in moved to a top-level redirect (`GET /api/v1/auth/consume`) so the cookie is set reliably; graceful shutdown on SIGTERM/SIGINT so PGlite is not left locked; the open intake conversation resumes after a reload (`GET /intake/sessions/current`) and "Start over" abandons it on the server; more metro areas in the BLS lookup (Denver, Phoenix, Dallas, Chicago, Atlanta, Miami, New York, Boston and others).

## Verified in the browser, Slice 2 (10 September 2026)

Same local database: a new applicant (Jordan Lee) applied through the public form with a written description instead of a resume → within seconds the status page read "Invited to a screen" with the screening link and the two emails (acknowledgment, invitation with the AI disclosure and HUMAN) → the screening chat opened with the disclosure and the first question, one question per turn, "N of 6 answered" progress, "Talk to a person instead" always visible → after six answers the close message and "Check your status" → Home showed "What the assistant did" (invited to a screen; ready to interview with the scorecard summary) and a "Screening: 1 completed" card → People listed Jordan as "Recommended for interview" with the screening conversation (13 messages), the screen scorecard (answers, pay within range, availability, competencies, strengths with quotes), the resume assessment (must-haves with quotes, one unknown for the screen), every message, and the full timeline in plain language.

## What works today (Slice 2)

- Every eligible application is assessed against the Role Packet: must-have and competency findings with verbatim quotes that code verifies against the resume or application text (unverifiable quotes are discarded and counted), unknowns for the screen to settle, and a recommendation (screen, hold, review manually). Gaps, career changes, missing degrees, and AI-written text never make a candidate "weak" (eval suite `triage.edge_cases`). Assessment is information; the stage moves to "Ready for your review".
- Policy `application.invite_screen` (default "do it and tell me"): a "screen" recommendation starts the screening workflow and the owner is told; "ask me first" creates a decision card on Home; "only a person" leaves an "Invite to a screen" button. An overridden eligibility rule always goes to the owner.
- Screening by web chat (an email link, no JavaScript needed) and by text when the candidate consented, inside 8:00 to 21:00 local time. Disclosure and "reply HUMAN" in the first message, one question at a time in the packet's order, at most two follow-ups per question, pay answered only from the posted range, protected details kept out of recorded answers, progress kept in code so a reload or a channel switch resumes. HUMAN or "Talk to a person" hands the conversation to a recruiter with the full transcript and a 4-hour SLA; WITHDRAW withdraws; STOP opts out of texts and revokes consent. A model outage gives an honest holding message; two in a row hand off to a person.
- Reminder after 48 hours, expiry after 72 more with a note to the owner; a completed screen gets a scorecard (per-question findings, competencies, pay expectation against the range, availability, eligibility confirmations, recommendation) and, under `application.recommend_interview`, moves to "Recommended for interview" or becomes a decision card.
- Owners can invite to a screen, mark for interview, hold, decline with a reason, or ask a recruiter from every candidate; the People page shows the screening conversation, both scorecards, and the assistant's pending suggestions. Home shows "What the assistant did".
- Stuck-role detector (daily per company): candidates waiting on the owner 3+ days, screen invites unanswered 3+ days, decisions pending 2+ days, no applicants in 14 days. Ladder: brief line → email with a one-tap link → offer of a recruiter (`intervention.offer_recruiter`) → recruiter escalation, with the `intervention.nudge` cooldown (48h) between rungs; interventions resolve when the owner acts.
- Plan limits: `text_screens` is checked before every invite and metered; exhaustion tells the owner and never pages a recruiter.
- Insufficient evidence is a state the owner can see (30 September 2026): an assessment that could not say enough (review manually, or "unknown") keeps the candidate in "Waiting on you" as "Needs a closer look", with the open questions in plain words on the Talent card, a filter for those rows, and a notification that names what is missing; "Ask about this in a screen" invites the candidate to a web screen that starts with exactly those questions; assessments say why the confidence is what it is; a résumé file with no text and a missing assessment are both said on the card, not only in the timeline (`apps/api/src/intelligence.test.ts`).

## Known gaps in Slice 2

- The Twilio adapter, inbound webhook, and signature check are written but not exercised against a live account (no credentials; A2P 10DLC campaign not yet registered). Until then every screen runs by web chat from the email link.
- Contact hours use the company's timezone as a stand-in for the candidate's.
- The brief's "stuck" cards are computed from wall-clock time; the detector workflow uses the engine clock (identical in production).
- No Recruiter Mode pipeline table yet; recruiters use the same People page.
- Voice screening is intentionally absent.

## Known gaps in Slice 1

- The morning brief is deterministic; the orchestrator agent's prose and the owner Q&A over records arrive with Slice 2.
- The fake AI provider is a heuristic stand-in for development and tests; quality claims require `AI_PROVIDER=anthropic` and the eval suites with real thresholds.
- The Anthropic adapter has not been exercised against the live API in this environment (no key present); it follows the current SDK shape (`messages.parse` with `zodOutputFormat`) and needs one live smoke test.
- Outbound email uses the fake adapter until Postmark credentials and a sending domain exist; SMS is fake until the A2P 10DLC campaign is approved.
- Integration credentials are not yet stored per company (the `integrations` table and encryption key exist; the Setup flow to enter keys arrives with BambooHR in Slice 5).
- The web app has no automated UI tests yet (the API is covered end to end).
- PGlite is pinned to 0.3.16 because 0.5 moved the pgvector extension; upgrade when the new path is confirmed.
- Reference checking and voice screening are intentionally absent (docs/00 §E and §A.2).
- The fake intake handler extracts facts with patterns; phrasing it does not recognise (for example a decision maker named mid-sentence) shows up as a repeated question. The real provider does not have this limitation; the eval suites gate the real prompts.
- The BLS metro lookup is a small built-in table (about 35 metros); other locations use the national figure and say so.
- The role page does not yet show the owner's deal-breakers and named decision maker from the packet's preferences (they are stored and versioned).

## How to run

See docs/14. In short: `pnpm install`, `pnpm test`, `pnpm dev` (API on 3001 with an inline worker on PGlite, web on 5173), sign in with the dev magic link shown on screen.
