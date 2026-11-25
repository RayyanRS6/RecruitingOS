# Recruiting OS: the product

What the product is, as built. The owner asked for it on 17 and 18 November 2026: "clean, simple, user-friendly", "keep only the features and settings that are actually required", "one clear and consistent system for CV analysis, candidate scoring, and ranking". Decisions marked OWNER are the owner's own words or answers; the rest are the team's. The decisions that sit around the product (sign-in, plans, AI models, hosting, legal) are in [DECISIONS.md](DECISIONS.md).

## The flow (OWNER)

1. A company signs in with Google or Microsoft and gives its company details.
2. The platform administrator accepts or declines the company in the admin dashboard.
3. An accepted company types a short job idea, or pastes an ad. The AI finds what is missing (the place, on site / hybrid / remote, the pay, the other essentials) and asks follow-up cards.
4. The AI writes the job: the description, the structured posting, the questions, and a LinkedIn post and an Indeed post.
5. The company publishes the job itself. Nobody approves a job. The platform administrator can see every company and its jobs, as counts.
6. The company posts on LinkedIn and Indeed with our job page as the Apply link.
7. A candidate opens our job page, reads the whole description, fills in a short form with the job's screening questions and uploads a resume. Nothing about applying is an AI interview or written by AI.
8. The AI reads the resume once and scores it against the job. The list ranks candidates best first. The company shortlists.
9. Only shortlisted candidates do the AI interview, by email. It asks about the job's requirements and is scored.
10. The company reads the result and marks the person Hired or Not selected. That is the end.

## Decisions

**D1 People.** A platform administrator. A company's team with three roles: Owner, Admin and Member (`hiring_manager` in code). Candidates, who have no account: an emailed status link is their key.

| | Owner | Admin | Member | Platform administrator |
|---|---|---|---|---|
| See jobs, candidates, pay, Home, updates | yes | yes | yes | no |
| Start, write, edit and publish a job; edit its posts | yes | yes | yes (their own drafts) | no |
| Every action on a candidate, one person or many | yes | yes | yes | no |
| Pause, resume or close a job; set its closing date; take over a draft | yes | yes | no | no |
| Change company details; invite, change and remove people | yes | yes | no | no |
| Make someone an owner | yes | no | no | no |
| Ask for a bigger plan; set their own email switch; leave | yes | yes | yes | no |
| The admin dashboard | no | no | no | yes |

Nobody changes their own membership, and the last owner stays. The platform administrator never sees a candidate's name, resume, answers or score: a company's jobs show as counts only.

**D2 One company gate.** Accept, Decline and Take away access in the admin dashboard are the only gate. Accepting makes the company live: its people can work, its careers page and job pages are public, and its emails to candidates go. While a company waits or is declined, nothing of it works or is public. On a hosted deployment a new company always starts as a request (`SIGNUP_MODE=approval`); on a developer's machine and in tests it is live at once (`open`).

**D3 Jobs.** A job is a draft, open, paused or closed. The company publishes with one button once every essential is there, no wording flag is open and the legal check passes. Editing an open or paused job saves a new version that is live at once. Paused takes no new applications. Closed is final and tells nobody anything.

**D4 Job builder.** One way in: type an idea or paste an ad. The AI reads facts only from what the person typed, and asks cards for the essentials it lacks: the title, the place with its state (asked again for a city alone, never guessed), the work arrangement (asked, never assumed), the pay (a person confirms it), full or part time, the schedule, and one must-have. "Write the job" needs every essential. Three checks stay on the written job: the fairness guard on wording (a flagged phrase is reworded, or kept with a reason), the legal check (the benefits line, the pay range and a closing date where a state asks for one), and the closing date.

**D5 What the builder produces.** The job description. The structured posting: title, place, arrangement, type, pay, must-haves, skills with their importance, benefits. The application form's screening questions and the AI interview's questions. A LinkedIn post and an Indeed post, written by AI in a step of their own after the job is published, both editable, each carrying its Apply link (the job page's address with `?src=linkedin` or `?src=indeed`). The job's Share tab shows the link and the two posts with Copy buttons. A post a person edited is never replaced, except by that post's own "Write again". The public side is the careers page, the job page with its data for Google, the sitemap and `robots.txt`.

**D6 Applying.** The job page, then a plain form: first name, last name, email, phone (optional), resume (required), the job's screening questions (yes or no, a choice, a number), the notices and the acknowledgment tick, Send. Then a receipt and one email, "we received your application", with the status link. No AI runs before Send. A second application to the same job from the same address creates nothing and sends the status link again.

**D7 Stages.** The stage is the only place a person's position is stored: `applied`, `received`, `triaged`, `screen_invited`, `screening`, `screen_complete`, `hired`, `rejected`, `withdrawn`. A job's Candidates list has five tabs: New (`applied`, `received`, `triaged`), Shortlisted (`screen_invited`, `screening`), Interviewed (`screen_complete`), Hired, and Not selected (`rejected`, and `withdrawn`, shown as "Withdrew"). A "No" to a screening question never holds or declines anyone: it is a flag on the row and evidence for the resume reading. An applicant past the plan's limit is locked: the team sees a card with no name ([DECISIONS.md](DECISIONS.md), "Plans and locked applicants").

**D8 What a company can do with a candidate.** Shortlist, one person or many, which sends the AI interview. Send a reminder, send a new link, or cancel the AI interview. Hire. Not selected, which is private and emails nobody. Undo Hired, or Not selected before the candidate was told. Email the decision, one standard wording, to one person or many, with a short time to take it back. The software never declines, never hires and never emails a decision by itself.

**D9 AI interview.** It starts only with Shortlist: an email with a link open five days, one reminder after 48 hours, then the link closes and the company can send a new one. The questions come from the job as it is when the interview is made (at Shortlist, or at a new link), and stay the same to its end whatever is edited later: its interview questions and the must-haves the resume does not show, then one closing question. The candidate presses "Send my answers"; nothing reaches the company before that, not even how far they got. An interview the candidate sent is always scored. Closing a job closes its interview links that are still open, and emails nobody. "I'd rather not do the AI interview" is recorded and shown to the company.

**D10 One scoring system.** Two numbers, never merged, both worked out in code. The AI writes findings and quotes only.
- **Resume score**, 0 to 100, from the resume reading alone: points earned over all the job's requirements. A must-have weighs 4; a skill 3, 2 or 1 (Essential, Important, Helpful). Shown earns all, Partly shown half, anything else nothing. A must-have the candidate's own words show is not met holds the number at 54. The list ranks by it.
- **Interview score**, 0 to 100, from the AI interview's scorecard alone: each question the interview asked counts once, answered to the job's standard 100, partly 50, otherwise 0. The table of questions sits beside it.
- One band word for both numbers: Very high from 85, High from 70, Medium from 55, Low below. One set of finding words: Shown, Partly shown, Not met, Not shown yet. What nothing shows earns no points and is never read as a no.
- A finding is Shown only on a quote the code found in the candidate's own words. Each resume and each interview is read three times and the middle answer kept.
- When a job's must-haves or skills change, everyone still in the process is read again; until then their score says "Scored against an earlier version of the job".
- Candidates are never shown a score, a band or a finding.

**D11 The order of every list is the server's.** Candidates: the resume score, highest first, people with no score last, then who applied first. Interviewed: the interview score first. Jobs and companies: newest first.

**D12 Settings** is one page: Company, Team, Plan, Email updates (one switch for each person).

**D13 Admin dashboard.** Companies (requests to accept or decline; the list; one company with its plan and its jobs), Privacy requests, and System (Health, Costs, Email, Security reports, Administrators).

**D14 Under the product** (OWNER for plans): plans, limits, AI credit and locked applicants; sign-in, sessions and the staff second factor; privacy requests; audit records and events; the workflow engine; the email outbox; file storage and scanning; the UI kit; every required candidate notice.

**D15 Candidates write to the company** (the team, 19 November 2026). A company runs its own hiring, so candidates write to the company, not to the platform. The company details form asks for the "Email candidates can write to"; it starts from the person's sign-in address. The company's job pages and candidate emails name it, and a candidate's reply to any email lands there. Settings, Company, "Candidates write to" changes it. The platform's own inbox answers only for a company that has no contact of its own.

## Never cut (legal)

The AI-use notice, the privacy notice, pay transparency, the accommodation lines, "people make every hiring decision", the acknowledgment tick (never pre-ticked, enforced on the server), the disclosure line and the way to reach a person on automatic emails, the Colorado line in decision emails, "your replies go to the company only when you press Send", the wording a locked applicant reads, and every block marked DRAFT WORDING PENDING COUNSEL. The texts are in `packages/core/src/compliance.ts` and `packages/core/src/candidate-lock.ts`.
