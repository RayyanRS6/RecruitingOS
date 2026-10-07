# Security overview

**ITS AI Recruiting Department, Founding Partner Program. Release 1.**

Draft of 30 September 2026 (checked again against the product the same day), for review by ITS before it is given to a customer. This overview becomes Exhibit B of your agreement. It explains, in plain language, where your data and your candidates' data live, who can see it, and what we do to protect it. It is not legal advice.

## 1. Where the data lives

Everything runs in the United States.

| What | Who runs it | What they hold |
|---|---|---|
| The database, sign-in service, resume storage and the vault for calendar credentials | Supabase (Oregon) | All product data: your company, your team, roles, applications, resumes, messages, records of who did what |
| The web application | Vercel | Data passing through while you use the product; nothing stored |
| The background service that sends messages, runs reminders and checks postings, and the malware scanner that checks every resume | Railway | Data in memory while a job runs or a file is scanned; nothing stored |
| The AI model | Anthropic | Role text, resume text and screening answers while the assistant works on them. No phone numbers or email addresses are sent. Anthropic does not train models on this data under its commercial terms |
| Candidate and team email | Postmark | Email addresses, message text, calendar attachments |
| Interview calendars, if an interviewer connects one | Google | That interviewer's free and busy times and the interview events |
| Error reporting | Sentry | Technical error reports with candidate identifiers, tokens and cookies removed |
| Usage measurement | PostHog | Counts of steps in the product with no candidate information and nothing from candidate pages |
| Request-rate counters | Upstash | Anonymous counters that protect the public pages from abuse |

The full list, with each provider's role, is in the subprocessor list you receive with your agreement. We tell you before we add a provider that will handle candidate data.

## 2. Who can see what

**Your team.** What each person sees depends on the role you give them.

- The owner and admins see everything in your company's workspace.
- Hiring managers see roles, candidates, pay and the activity timeline, and can decide on candidates.
- HR sees roles, candidates and pay, can act on candidates but cannot decline them, and can manage the team.
- Interviewers see the roles and their own interviews. For each candidate they interview they get a short brief: what the round is for, how the candidate stands on your must-haves, strengths and what is worth exploring. They can open only those candidates, never others, and never see pay.

**ITS recruiters.** Only when you ask for one, only for that request, and only for the time it takes (section 4).

**ITS administrators.** A small number of named ITS staff run the service. Every time one of them opens a customer's data they must give a reason, and the read is recorded. Emergency access needs a fresh second factor, a written reason, lasts at most sixty minutes, and is recorded.

**Providers.** The providers in section 1 hold or carry data to do their one job. None of them may use it for anything else.

**Other customers.** Never. Each company's data is separated at the database level. The product cannot read one customer's records while acting for another, and we test this.

**Candidates.** Each candidate sees only their own application through a private link.

## 3. How your team signs in

- You sign in with your Google or Microsoft work account. ITS never sees or stores a password.
- A team invitation works only for the address it was sent to, for seven days. Opening the link does not sign anyone in: the person still signs in with Google or Microsoft using that address.
- A signed-in session lasts up to thirty days of inactivity. Signing out ends it at once.
- **Your sessions** in **Setup** lists every place you are signed in. You can end any of them, or all the others at once.
- When someone's role changes, or they are removed from the team, they are signed out everywhere at once.
- Sensitive changes need a recent sign-in. Changing what the assistant may do, or the notices candidates see, is accepted only within 30 minutes of signing in, or within 10 minutes of confirming it's you with Google or Microsoft again.
- Changes to who is on your team are recorded.

## 4. How ITS recruiters get access and how you end it

- Access exists only after someone on your team presses **Bring in a recruiter**, or after the product itself brings a recruiter in because a candidate asked for a person or a held application waited three days.
- Before a recruiter accepts the request, they see only your company name, the role title, the kind of request, its urgency, the skill it needs, the time remaining and a generic one-line summary. They do not see your words or any candidate information.
- When they accept, their access covers what the request names: one candidate (and the role they applied for), or one role and its candidates. Other roles and candidates are refused, including on Today and in the activity list. A request covers all of your hiring only when someone on your team chose "All of your hiring" when asking. A request the product raises on its own always names the candidate or role involved; a failed step with nothing attached goes to ITS administrators instead of a recruiter.
- You are told as soon as a recruiter starts, with what they can see and until when.
- When a candidate's data is deleted, it is also removed from the recruiter's copy of the request and from requests and notices that name them.
- The access lasts at most 14 days. It shrinks to 24 hours after the recruiter marks the request resolved. It ends at once if the recruiter releases it.
- Every page the recruiter opens is recorded, with the time and the request it belongs to. You can see this under **ITS recruiter access** in **Setup**.
- An owner or admin can end the access at any moment from the same place. You give a short reason, the access ends immediately, the recruiter is told, and the request goes back to the queue.

## 5. How candidates' information is protected

**What we collect.** First and last name, email, phone (optional), where they are based (optional), a resume or a short written summary, answers to your eligibility questions, a record of which notices they were shown and when they ticked the box, and which board or link they came from. Later, their screening answers, their interview time choices, any accommodation request, any email they send back, and the outcome your team records.

**What we never collect.** Social Security numbers, dates of birth, government identification, bank details, health information, background-check results or tax information. There is no field for any of these, and the product refuses unexpected fields.

**Resumes.** A resume goes into private storage under a name nobody can guess. Before anyone can open it, it is checked for its true file type, size and content and scanned for malware. A refused file is removed and the candidate can send another. Your team opens a resume through a link that works for two minutes, and every opening is recorded.

**Candidate links.** The links in candidate emails are long random codes that cannot be guessed. Each works for one purpose only. Scheduling links expire. After a candidate's data is deleted at their request, their links stop working and say so. The address a candidate replies to is a separate code that opens nothing. The confirmation link sent by the privacy-request form works once and expires after 24 hours.

**Application links on job boards.** Each board's application link only leads to your public application form. The code in it is never written into the candidate's application, emails or status page.

**Before a candidate applies.** The form says who runs the hiring process, what is collected and why, who can see it and how to ask for a copy, a correction or deletion. The candidate must tick a box to say they have read it; the box is never ticked for them, and the product records when it was ticked and which notice wording was shown.

**Candidate pages.** No third-party scripts run on any candidate page. Nothing about the candidate is sent to any analytics service.

**The AI model.** The assistant receives role text, resume text and screening answers. It does not receive phone numbers or email addresses. Its output is checked against the source: a quoted fact must appear in the resume, or it is not shown. Every model call is logged with what it was asked to do and what it cost.

**Email.** Messages go out through a dedicated ITS sending domain. If an address bounces or a person marks a message as spam, we stop sending to that address and tell you.

**Access limits.** Public pages are rate-limited. Sign-in links, when enabled, expire in fifteen minutes and work once.

## 6. How ITS staff sign in

- ITS staff sign in with their Microsoft 365 account and a second factor. Without both, they are refused, and the refusal is recorded.
- Staff sessions last eight hours.
- ITS staff get a platform role only by a named administrator's decision, with a reason, and every other administrator is told. Nobody can grant a role to themselves.

## 7. What is recorded

The product keeps a record, which cannot be edited, of:

- every time ITS staff open your data, with the page, the time and the reason;
- every human decision about a candidate: hold, invite, interview, decline, the post-interview decision, and the recorded outcome, with the person's name and reason;
- every change to your team, to what the assistant may do, to your company details or to candidate notices, and every "confirm it's you";
- every invitation sent, sent again, withdrawn or accepted;
- every change to a job posting or an application link, and every time applications were stopped or started again;
- every read, use and deletion of a calendar credential;
- every privacy request and what was done with it;
- every message sent to a candidate and whether it arrived, including messages your team writes (who wrote it and who approved it, never the text in the record);
- every download of a report or of this record.

**Audit history** in **Setup** shows these records in plain words, newest first, and you can download them as a spreadsheet. You also see the full timeline of each candidate on their page. Records are kept for the period in the retention schedule (proposed seven years for these records; counsel confirms the period).

## 8. How deletion and other privacy requests work

- A candidate can ask, from their status page, from the request form on the privacy page, or by email to privacy@identifiedtalent.com, for a copy of their information, a correction, deletion, or a review by a person, and can withdraw their application at any time.
- A request from the status page is verified by the link itself. A request from the form is verified by a confirmation link emailed to the address given; nothing is recorded until the person presses its button. A request by email is verified by a reply from the address they applied with, or by a detail only they would know.
- A person at ITS records the request, confirms receipt within one business day with a reference and an expected completion date, and tracks a deadline. The proposed deadline is 45 days; counsel confirms it. ITS is alerted ten days before the deadline and again if it passes.
- A copy of their information contains only their own data. It never contains other candidates' data or your team's internal notes and reasons.
- Deletion is done by removing the person's identity and contact details from the records, and deleting their resume and messages, while keeping the counts and decision records employment law may require. It runs only after a recorded decision by counsel and an administrator's confirmation. It is never automatic.
- Withdrawal and "stop text messages" take effect immediately.
- You see that a request of a given kind exists and that it was completed. You never see its content. If a candidate you hired asks for deletion, ITS refers the request to counsel because employment records belong to you.
- Retention: the proposed schedule keeps candidate records for four years after the last activity, or sooner on request, and audit records for seven years. These periods are proposed defaults and are confirmed by counsel. No automatic deletion runs until then.

## 9. Backups and incidents

- The database is backed up daily, with point-in-time recovery switched on for the live service. Resume storage keeps versions. We run a restore drill before your first candidate and record the result.
- Production data is never copied into development or test systems.
- ITS has a named incident lead. If we suspect that your data or a candidate's data was exposed, the first response starts within one hour on any day, and we tell you within one business day of confirming it. Counsel is engaged before any notice goes to a candidate or a regulator.
- The background service is watched. It reports that it is alive each time it looks for work, and its health check tells the hosting service to restart it when it stops. ITS's console raises an alert when a task fails after all its retries, when the background service has stopped reporting, or when a task has waited more than thirty minutes. A failed task reaches our error service with its name and reference only; email addresses, phone numbers and secrets are removed from the error text.
- If the product is unavailable or candidates cannot be reached for more than thirty minutes, we respond within two business hours and keep you informed by email until it is fixed.
- After a serious incident you receive a written note within five business days: what happened, when, why, and what we changed.

## 10. What you must do on your side

- **Use work accounts.** Sign in with the Google Workspace or Microsoft 365 account your company controls, not a personal address.
- **Turn on two-step verification** on those Google or Microsoft accounts for everyone who signs in. The product relies on your provider's sign-in; a second factor there protects your workspace.
- **Give people the smallest role that does their job.** Interviewers rarely need more than the interviewer role.
- **Remove people the day they leave.** An owner, admin or HR removes them in **Setup**, under **Team**; they are signed out everywhere at once. Email support if you need help.
- **Do not share sign-ins or forward candidate emails** to people outside the hiring team.
- **Keep your job-board accounts safe.** ITS posts under your LinkedIn, Indeed and ZipRecruiter accounts. Add ITS as a user on each account rather than sharing a password, and remove that access when the program ends.
- **Keep devices updated and locked.** The product is a website; a lost, unlocked laptop with a signed-in session is the most likely way for a workspace to be exposed.
- **Report anything odd** to support@identifiedtalent.com: an email you did not expect, a candidate who says they received someone else's message, a sign-in you do not recognize. **Your sessions** in **Setup** shows where you are signed in; sign out anything you do not recognize first, then tell us.

## 11. What is still being verified

- Every control above exists in the product and has been tested against simulated services. Each is being verified on the live services before your first candidate, and you will receive the acceptance record. That includes the malware scanner, which ITS starts on its hosting before any real resume arrives; until then no real candidate data is accepted.
- Candidate replies come back into the product only once ITS has connected the incoming mail for your workspace. Until then they reach an ITS mailbox that a person reads.
- An independent security review has not yet been done. It is planned before general release.
- The retention periods, the privacy-request deadline and the incident-notification period are proposed and are confirmed by counsel.
