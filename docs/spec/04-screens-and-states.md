# 04. Screen and state inventory (release 1)

Status column: **built** (exists and stays), **changed** (exists, modified in release 1), **new**. Every screen must implement the standard states: loading (skeletons, never spinners in content), empty (one sentence, one action), error (what happened, what to do, retry), forbidden (plain explanation), and success (toast or inline confirmation). Owner mode and candidate pages are designed at 375 px first; WCAG 2.2 AA applies everywhere.

## 1. Owner mode (`apps/web`)

| Route | Screen | Purpose | Primary actions | Roles | Status |
|---|---|---|---|---|---|
| /login | Sign in | "Continue with Microsoft" and "Continue with Google" (PKCE flow on the API); the email link only where enabled; staff guidance; error messages by code | Continue with provider; send link | public | changed (D19) |
| /login/consume | Signing you in | Consume link (JSON variant for the SPA) | | public | built |
| /setup/company | Create your company | Name, vertical (wedge list first), size band, timezone, locations, website | Create | signed-in user without a company | built |
| / | Today | Four-question summary; decision cards; needs-review cards; screening cards; stuck cards; escalation status; "What the assistant did" feed; the conversation (intake and Q&A); unread notifications | Approve, review, invite, interview, bring in a recruiter, start intake, start over | all tenant roles (interviewers see only interviews today) | changed: interview cards ("How did it go?", "Pick a time for {name}", "Waiting on {name} to choose a time") |
| /roles | Roles | One row per role: title, status, days open, pipeline bar, what needs you | Open role; new hire (goes to Today conversation) | role.read | built |
| /roles/:id | Role | Tabs: Overview, Requirements, How we'll evaluate, Interview plan, Posting, Activity; packet versions with diff; approve; edit; pause/resume/close | Approve packet; edit (new version); pause/resume/close; retry channel; bring in a recruiter | role.read; approve per policy | changed: Interview plan tab shows interviewers per round and their calendar status; Activity tab (role timeline) |
| /roles/:id/packets/:version (sheet) | Packet editor | Section-by-section edit with validation messages from the schema; change summary required | Save as new version | packet.edit | changed: interview plan editor lets the owner assign interviewer users to rounds |
| /roles/:id/talent and /talent | Talent | Groups: waiting on you / in process / not moving forward; rows with category, strengths, concern, confidence, stage label; filters by stage; exclusion view with reason, evidence, policy and "Review anyway" | Open candidate | application.read | built |
| Talent → candidate (sheet) | Application detail | Assessment (must-haves, competencies, strengths, concerns, unknowns, anomalies); resume extraction; screen conversation and scorecard; messages; timeline (actor kinds); pending approvals; actions | Invite to a screen; Interview; Hold; Decline with reason; Talent pool; Override eligibility (reason); Review anyway; Something wrong? (flag); Bring in a recruiter; Record decision (after interview) | application.act / reject / interview.request / interview.decide | changed: Interview button opens the approval sheet; decision card after an interview |
| Candidate → Interview (sheet) | Interview approval | Round (from the plan, next in order), duration, format, interviewers (pre-filled; pick users), link source (calendar-generated or pasted), scheduling window (default next 10 business days), candidate timezone if known; warnings for interviewers without availability | Approve and schedule; Declare availability (inline for self) | interview.request | new |
| /interviews | Interviews | Upcoming and past interviews across roles: candidate, round, time (company timezone), interviewers, status (waiting on candidate, scheduled, completed, cancelled, no-show); per-interviewer load | Open interview; reschedule; cancel; mark did not happen | interview.manage (interviewers see their own) | new |
| /interviews/:id (sheet) | Interview | Status, times, link, participants, candidate summary (assessment and screen highlights; no pay for interviewers), offered slots, reschedule history, timeline | Reschedule (re-offer slots); Cancel (reason); Join link; Record decision | interview.manage / interview.decide | new |
| /setup | Setup | Company profile; team (invite, roles, remove); connected services with status (email: live/pending; calendar per user: connected/disconnected/needs attention; SMS: pending 10DLC; job boards hidden or pending); "What the AI may do on its own" policy editor (release-1 actions only); notices with jurisdictions and versions; plan and usage; sessions (list, revoke) | Invite; change role; connect calendar; declare availability; edit policy (re-auth); revoke sessions | company.read; edits per permission | changed: calendar connection cards; availability editor; sessions; hidden policies |
| /setup/availability (sheet) | My availability | Timezone; weekly windows (e.g. Mon–Fri 9:00–17:00); buffer minutes; max interviews per day; used when no calendar is connected and as constraints when one is | Save | calendar.connect | new |
| /setup/calendar/google, /microsoft | Connect calendar | Explains the scope requested and the data used; starts OAuth; on return shows the connected account and the calendar chosen | Connect; choose calendar; disconnect | calendar.connect | new |
| Bring in a recruiter (sheet, everywhere) | Ask for help | Quick picks (Review these candidates · Help me decide · Take this role over · Something else); text; SLA shown | Send | escalation.create | built |
| Notifications (panel) | What the assistant did | Per-person list of auto_notify actions and recommendations; mark read | Open link | all | built |
| /recruiter/queue, /recruiter/queue/:id | ITS queue | Before acceptance: customer, role title, category, urgency chip, required expertise, remaining business time, generic summary (nothing from the customer's words or the candidate). After acceptance: the request itself and the full snapshot (company, role, packet, candidate, resume text, assessments, screens, communications, timeline); resolve with resolution text | Accept; Release; Resolve | its_recruiter, platform_admin | changed: preview minimization (correction 11) |
| /admin | Admin console | Customers (plan, activity, cost, escalations); workflow runs with step ledger and retry; AI runs with the six questions; failures; costs by task and model with the daily cap; queue health (Failures tab now leads with operator alerts: acknowledge, retry credential deletion; and lists credentials still in the store after a disconnect); data requests; platform roles; **Business calendar** tab (hours per day, time zone, holidays, closures, temporary coverage changes, effective date, note; publish a version; recalculate open deadlines with a reason; 28-day preview; version history) | Open (reason required); retry run; assign plan; assign platform role; fulfil data request; publish calendar version; recalculate deadlines | platform_admin | changed: data requests, plan and role assignment, spend cap |

Accessibility (18 Sep): every screen in the browser journey passes axe WCAG 2.1 A/AA; the design tokens were darkened where text fell below 4.5:1, every page has a `main` landmark, loading states use `role="status"`, action columns have hidden headers; candidate pages remain usable without JavaScript and by keyboard alone.

Global states: signed out → /login; signed in without a company → /setup/company (staff → queue); a fake AI provider shows a caution banner (development only; production refuses to boot); a disconnected calendar or a pending email domain shows a persistent Setup badge; the pilot plan near its limits shows a Today line.

## 2. Candidate pages (server-rendered by the API)

| Route | Screen | Purpose | Actions | States | Status |
|---|---|---|---|---|---|
| /careers/:slug | Careers | Open roles for the company | View and apply | no open roles | built |
| /careers/:slug/jobs/:roleId | Job | Title, chips (location, type, pay when disclosed, schedule), description, what to expect (steps from the packet), notices, apply button; JSON-LD | Apply | paused/closed: no apply button; 404 when unknown | built |
| …/apply | Apply | Form (see `01` step 5) | Send my application | field errors; file errors; honeypot fake success | changed: SMS consent shown only when SMS is enabled; CSRF token; CSP nonce |
| /c/status/:token | Your application | Status label, dates, what happens next, screening link, interview card (time, link, reschedule, cancel), messages sent, text preference, withdraw, get a new link (token rotation), privacy | Continue screening; Pick a time; Reschedule; Withdraw; Toggle texts; New link | withdrawn; rejected; expired screen | changed: interview card; token rotation; copy for interview stages replaced |
| /c/screen/:token | Screening | Disclosure, transcript, one question at a time, progress, Send, Talk to a person | Send; Talk to a person | empty answer; trouble (retry); expired; human requested; completed; withdrawn | built |
| /c/schedule/:token | Pick a time | Interview title, duration, format, interviewers' first names, the candidate's detected timezone (changeable), 6–10 slots grouped by day, accessibility needs note field | Choose; Change timezone; None of these work (asks for new times; notifies the owner) | expired offer; already booked (shows confirmation); cancelled | new |
| /c/schedule/:token/confirmed | Confirmed | Time in both timezones, join link, add to calendar (ICS), what to prepare (from the round's purpose), reschedule and cancel links | Add to calendar; Reschedule; Cancel | | new |
| /c/schedule/:token/reschedule | Reschedule | New slots; limit of two candidate reschedules, then "ask the team" | Choose | limit reached | new |
| /c/schedule/:token/cancel | Cancel | Optional reason; confirm | Confirm | | new |
| /privacy | How we handle your information | Notice text; choices; automated tools; data request instructions (form link) | Request my data (form) | | changed: data request form |
| /c/privacy-request/:token | Data request | Kind (access, correct, delete), details, email verification | Submit | submitted; verify email | new |

## 3. Messages (email and SMS)

| Template key | To | Trigger | Status |
|---|---|---|---|
| magic_link, invite | user | auth, invite | built |
| acknowledgment | candidate | application received | built |
| disposition:eligibility, disposition:human | candidate | window elapsed; human decline | built |
| screen_invite, screen_reminder, screen_* SMS | candidate | screen workflow | built |
| interview_slots, interview_slots_reminder | candidate | slots offered; 48 h | new |
| interview_confirmed (ICS), interview_reminder_24h, interview_reminder_2h, interview_rescheduled, interview_cancelled | candidate and interviewers | scheduling | new |
| interviewer_assigned, interviewer_no_availability | interviewer | interview approval | new |
| intervention (message, offer) | owner | ladder | built |
| escalation, escalation_resolved | ITS queue; owner | escalation | built (resolved notice new) |
| data_request_received, data_request_fulfilled | candidate | data request | new |

## 4. Notification kinds (in-app)

Existing: application.needs_review, application.ready, screen.invited, screen.completed, screen.expired, screen.human_requested, candidate.recommended, candidate.withdrawn, entitlement.text_screens, stuck.*. New: interview.slots_offered, interview.scheduled, interview.rescheduled, interview.cancelled, interview.no_slot_chosen, interview.completed_decide, calendar.needs_attention, escalation.resolved, data_request.received (owner/admin/hr).

## 5. Accessibility and content rules

Keyboard operability for every action; visible focus; labels on every input; error text tied to fields; live region for conversation and chat threads; color never the sole carrier of meaning (category chips carry text); reduced-motion respected; candidate pages work without JavaScript. Copy follows `docs/07`: no banned words; every automated candidate message carries the disclosure; nothing says "done" for an action that needs approval.
