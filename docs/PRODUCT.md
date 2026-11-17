# Recruiting OS: the product

What the product is. If code, tests or other docs disagree with this file, this file wins.
Decisions marked OWNER are the owner's own words or answers; the rest are the lead's.

## The flow (OWNER)

1. A company signs in with Google (or Microsoft) and gives its company details.
2. The platform admin accepts or declines the company in her dashboard.
3. An accepted company types a short job idea. The AI finds what is missing (location, on site / hybrid / remote, pay
   range, other essentials) and asks follow-up questions.
4. The AI writes the job description, the structured posting, a LinkedIn post and an Indeed post.
5. The company publishes the job itself. The platform admin does NOT approve jobs; she can see every company and its jobs.
6. The company posts on LinkedIn and Indeed with our job page as the Apply link.
7. A candidate lands on our job page, reads the full description, answers basic screening questions (like LinkedIn Easy
   Apply) and uploads a CV. Nothing about applying is an AI interview or AI-written.
8. The AI reads the CV, scores it against the job, and the list ranks candidates best to worst. The company shortlists.
9. Only shortlisted candidates do the AI interview. It asks about the job description and requirements and is rated.
10. The company reads the interview result and marks the person Hired or Not selected. That is the end.

## Decisions

D1 People. Platform admin. Company team with three roles: owner, admin, and `hiring_manager` shown on screen as "Member".
   Candidates (no account; an emailed status link). Removed: company roles hr, interviewer, recruiter; the platform role
   its_recruiter.

D2 One company gate. Accept / Decline / Take away access in the admin dashboard is the only gate. Accepting makes the
   company live. The separate "ITS check" and everything that waits for it (held emails, publishing that waits) are removed.
   Sign-up modes: `approval` (production) and `open` (local and tests). The `invite` mode and its allow-list are removed.

D3 Jobs. Statuses: draft, open, paused, closed. The company publishes with one button once the legal and fairness checks
   pass. No approval requests, no second approver, no named decision maker, no expiry. Editing an open job saves a new
   version that is live at once.

D4 Job builder. One way in: type an idea or paste an ad. The AI asks follow-up cards for missing essentials: title,
   location, work arrangement (on site / hybrid / remote), pay (a person confirms it), employment type and schedule,
   key requirements. Removed: the QuickStart wizard, change-by-chat, the market-pay benchmark, the questions "why are you
   hiring", "who interviews", "who decides", the human interview plan and scorecard template. Kept: the fairness guard on
   wording, the legal check (benefits line, pay range, closing date where a state asks), the closing date.

D5 What the builder produces. The job description; the structured posting (title, place, arrangement, type, pay,
   requirements, benefits); a LinkedIn post and an Indeed post written by AI (one separate AI stage), both editable, each
   carrying the Apply link (the job page address with `?src=linkedin` or `?src=indeed`). The job's Share tab shows the link
   and the two posts with Copy buttons. Removed: the per-board posting records and their state machine, link checking,
   ITS posting tasks, ZipRecruiter, applications by email, tracked `/a/` links, share places, XML/JSON feeds. Kept: the
   careers page, the job page, its Google structured data, sitemap and robots.

D6 Applying. Job page, then a plain form: name, email, phone (optional), CV (required), the job's screening questions
   (yes/no, choice, number), the notices and the acknowledgment tick, Send. Then a receipt and ONE email "we received your
   application" with the status link. No AI call before Send, no waiting room, no "no resume" path, no saved-details reuse.
   A second application to the same job from the same address creates nothing.

D7 Stages (the only place a person's position is stored): applied, received, triaged, screen_invited, screening,
   screen_complete, hired, rejected, withdrawn. On screen: New (applied, received, triaged), Shortlisted (screen_invited,
   screening; "AI interview sent" or "started"), Interviewed (screen_complete), Hired, Not selected (rejected), Withdrew.
   A "No" to a screening question never holds or declines anyone: it is a flag on the row and evidence for the CV reading.
   Plan-locked applicants work as today.

D8 What a company can do with a candidate: Shortlist (one or many; sends the AI interview), remind or send a new link,
   Hire, Not selected (private), undo Not selected before the candidate was told, Email the decision (one standard
   wording; one or many).

D9 AI interview. Starts only with Shortlist. An email with a link open five days, one reminder after 48 hours, then it
   closes and the company can send a new link. One chat engine. Questions come from the job: its interview questions and
   the must-haves the CV does not show, then one closing question. The interviewer is given the job description. The
   candidate presses "Send my answers"; nothing reaches the company before that. "I'd rather not do the AI interview" is
   recorded and shown to the company. Removed: texting, the AI write-up step, the outage retry run, detached repeat
   interviews, the recruiter hand-over.

D10 One scoring system.
   - CV score, 0-100, from the CV reading only: points earned over all the job's requirements (must-haves weigh 4; skills
     3, 2 or 1 by importance; shown 100%, partly shown 50%, otherwise 0; held at 54 when a must-have is shown not met).
     The candidates list ranks by it.
   - Interview score, 0-100, from the interview scorecard only: how many of the interview's questions were answered to
     the job's standard (yes 100%, partly 50%, otherwise 0), with the per-question table beside it.
   - One band word for both numbers, the same for everyone who sees it. No merged number, no second verdict word, no
     decision that reads the AI's stored "overall" or "recommendation", no "needs a closer look", no confidence chip.
   - Candidates are not shown scores.
   - The evidence rules stay (every quote checked against the candidate's own words; three readings, middle answer).

D11 Removed outright (OWNER for the first two lines): ITS recruiter requests, queue, takeover and access grants; in-person
   interview scheduling, calendar, availability, the Cancelled column, new times, offers and offer tracking. Also: the
   rules engine, approval requests and the rules screen; nudges, the stuck-job detector, the "still reviewing" note, the
   untold safety net; marks (longlist, shortlist-as-mark, on hold, not a fit), the pool board, review-and-apply, ask the
   pool, compare, the talent pool; notes; free-form messages, replies and threads; the job report and CSV; notification
   groups and digests; texting; notice rewording; contact hours.

D12 Settings is one page: Company, Team, Plan, Email updates (one switch per person).

D13 Admin dashboard: Companies (requests to accept or decline; the list; a company's page with its plan and its jobs),
   Privacy requests, System.

D14 Kept as they are (OWNER for plans): plans, limits, AI credit and locked applicants; sign-in, sessions and the staff
   second factor; privacy requests; audit records and events; the workflow engine; the email outbox; file storage and
   scanning; the UI kit; the closing date; the fairness guard; every required candidate notice.

## Never cut (legal)

The AI-use notice, the privacy notice, pay transparency, the accommodation lines, "people make every hiring decision", the
acknowledgment tick (never pre-ticked, enforced on the server), the disclosure line and human alternative on automatic
emails, the Colorado adverse-decision line in decision emails, "your replies go to the company only when you press Send",
the locked-applicant wording, and every block marked DRAFT WORDING PENDING COUNSEL. The texts live in
`packages/core/src/compliance.ts`.

The earlier founder context, specifications and audits are in git history, at commit `199c94f` and before.
