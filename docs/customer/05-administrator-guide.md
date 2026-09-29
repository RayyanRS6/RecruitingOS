# Administrator guide

**ITS AI Recruiting Department, Founding Partner Program. Release 1.**

Draft of 30 September 2026, for review by ITS before it is given to a customer. This guide is for the account owner: the person who creates the workspace, invites the team, and is responsible for the settings. Admins have the same permissions as the owner and can use this guide too. If you also run hires yourself, read the hiring manager guide as well.

Screen names and button labels in **bold** are the ones you will see in the product.

## 1. Signing in

1. Open the sign-in page your ITS contact gave you.
2. Press **Continue with Google** or **Continue with Microsoft**. Use the work account your company controls.
3. Your Google or Microsoft account handles the sign-in, including any two-step verification you have turned on there. ITS never sees or keeps a password.
4. The first time, you land on **Tell us about your company** (section 2). After that you land on **Today**.

Your session lasts up to thirty days of inactivity. Press **Sign out** at the bottom of the left rail to end it sooner.

If you see "Email me a sign-in link" on the sign-in page, ignore it. It is only offered in some setups, and your workspace uses Google or Microsoft.

## 2. Creating the company

Only one person does this: the owner. Fill in **Tell us about your company**:

- **Company name**
- **Your name**
- **What kind of business**: pick the closest. This chooses the playbook the assistant starts from for roles, screening questions and pay ranges.
- **How many employees**
- **City** and **State** (two letters)
- **Website (optional)**

Press **Create my hiring workspace**. You are now the owner. Everything you invite others into lives inside this workspace.

To change any of these details later, email support@identifiedtalent.com. A screen for this is planned.

## 3. The screens at a glance

The left rail has five entries:

- **Today**: the daily brief and the conversation with the assistant. This is where a new role starts.
- **Roles**: every role, its status and its pipeline.
- **Talent**: the candidates for a role, grouped by what needs you.
- **Interviews**: every interview in motion or done, and each interviewer's load.
- **Setup**: your company, your team, recruiter access, availability, connected services, and what the assistant may do on its own.

**Bring in a recruiter** appears on Today, on every role and on every candidate.

## 4. Inviting your team and choosing roles

In **Setup**, under **Team**, enter a work email under **Invite by email**, choose a **Role**, and press **Invite**. The person gets an email. The link works once and stays valid for seven days; you can send a new one at any time. They open the link and sign in with Google or Microsoft using the same work address.

| Role | Best for | Can | Cannot |
|---|---|---|---|
| **admin** | A second person who runs the account with you | Everything the owner can: company settings, team, roles, candidates, pay, policies, recruiter access, outcomes | |
| **hiring manager** | The person who runs a hire | Start a role in the conversation, edit and approve the packet, see candidates and pay, invite to a screen, hold, interview, decline, record outcomes, bring in a recruiter, see the timeline | Change the team, change what the assistant may do, end a recruiter's access |
| **interviewer** | Anyone who meets candidates but does not decide | See the roles; receive interview bookings, reminders and the meeting link; set their own availability | See candidate records, assessments or pay; act on candidates |
| **hr** | Someone who keeps records and manages the team | See roles, candidates and pay; invite to a screen, hold, interview; record outcomes; bring in a recruiter; manage team members | Approve a role; decline a candidate |
| **recruiter** | A recruiter on your own staff | Create and manage roles, edit packets, act on and decline candidates, see pay | Approve a role, manage the team, change policies |

Notes:

- ITS recruiters do not need an invitation. They get access only through **Bring in a recruiter** (section 9).
- Interviewers never see pay. Hiring managers can approve roles and decide on candidates.
- Every invitation and change of role is recorded.
- There is no screen yet to remove someone or change their role. Email support@identifiedtalent.com the same day someone leaves, and ITS makes the change with you.

## 5. The Setup screen

**Company.** Your name, careers page address, kind of business, size, locations, plan and usage. **Plan** shows your program and, where it has an end date, that date; a role already in progress is never cut off on that date. **Usage** shows what your program includes and what you have used.

**Team.** The people in your workspace, each with their role and an availability chip: "google calendar", "hours declared" or "no availability". Someone with "no availability" cannot be offered as an interviewer until they set it. The invitation form is here.

**ITS recruiter access.** Who from ITS has access right now, to what, and until when. This is empty most of the time. See section 9 for how to end access.

**My availability for interviews.** Each person sets their own. Two ways:

- **Declared hours**: time zone, the days and hours you can interview, **Buffer between interviews (minutes)** and **Most interviews per day**. Press **Save availability**.
- **Calendar**: if ITS has enabled Google Calendar for your workspace you see **Connect Google Calendar**. The product asks only for your events and free or busy times. **Disconnect** deletes the credential and you can see when that is done. If it is not enabled you see "Google Calendar is not configured for this deployment yet"; use declared hours. Microsoft calendars cannot be connected in release 1.

If a person has both, the declared hours limit the calendar.

**Connected services.** A table of the services the product uses for your company, each with a status: **Connected and working**, **Submitted, awaiting verification**, **Manual action required**, **Not connected** or **Disabled**. The last column explains what each one takes. Two rows to understand:

- The job boards (LinkedIn, Indeed, ZipRecruiter) show **Manual action required** or **Not connected**. This is expected. ITS posts to them by hand under your accounts.
- Text messaging shows as off. Screening runs by web chat from an email link.

The line under the table names the AI provider. On your live workspace it reads Anthropic.

**What the AI may do on its own.** A list of actions grouped by stage of hiring. Each has four levels:

- **Do it**: the assistant does it without asking.
- **Do it and tell me**: the assistant does it and you see it under **What the assistant did** on Today.
- **Ask me first**: the assistant proposes it and waits for a person to approve.
- **Only a person**: the assistant never does it.

Some rows are marked **always a person**. They are locked at "Only a person" and nobody can change them: declining a candidate on judgment, declining an applicant held on an eligibility answer, deciding who to hire, negotiating an offer, acting on a background check, changing these rules, changing eligibility rules, changing candidate notices, deleting candidate data, and exporting data. "Advance someone to an interview" can never be set below **Ask me first**.

The defaults are the recommended settings. The ones you are most likely to touch:

- **Invite an applicant to a screen** (default: Do it and tell me). Set it to Ask me first if you want to approve every screening invitation.
- **Recommend who to interview** (default: Do it and tell me).
- **Send confirmations and reminders** (default: Do it).

Only owners and admins can change these settings. Every change is recorded. The list includes rows for actions that are not part of release 1 (offers, background checks, references, payroll, outreach). Those rows are inactive; changing them has no effect on the product today.

## 6. The daily brief

**Today** opens with a greeting and a one-line summary: how many things need you, who is worth a look, what is at risk, and what was handled for you. Below it are cards, most important first. Each card has a label:

- **Needs you**: candidates waiting for a decision, or applicants held on an eligibility answer.
- **Decision**: a role packet to approve, or a screen or interview the assistant proposed under "Ask me first".
- **New applicants**: how many people applied since yesterday and how many are ready for review.
- **One step**: a board that needs a manual posting step.
- **Screening**: who is invited, answering now, or completed since yesterday.
- **Stuck**: a role where nothing has moved for a while, with a suggested action and **Have a recruiter review**.
- **Recruiter**: a request you sent, shown as "A recruiter will pick this up" or "A recruiter is on it".
- **All clear**: nothing needs you.

Under the brief, **What the assistant did** lists what happened since you last looked: an invitation sent, a resume that could not be read, an interview booked, a recruiter's answer. Press **Mark all read** when you have seen them.

Below that is **Your recruiting chief of staff**, the conversation where a new role starts. The hiring manager guide covers it.

## 7. Roles and posting

**Roles** lists every role with a status chip: **Draft**, **Needs your approval**, **Open**, **Paused**, **Filled** or **Closed**. Each card shows days open, the number of applicants, how many are waiting on you, and a pipeline bar. **Open** goes to the role page; **Talent** goes to its candidates. **Open a new role** takes you to Today.

**The role page** has the title, location and pay at the top, then tabs: **Overview**, **Requirements**, **How we'll evaluate**, **Posting**, **History**. **Edit** opens the editor; every save is a new version, and **History** lists them all. Nothing is overwritten.

**Approval.** A role waiting for approval shows a card **Approve this role packet** with any assumptions the assistant made. **Approve and post** opens the role and starts posting. **Edit first** lets you change the packet before you approve. Owners, admins and hiring managers can approve. Where you have two people, have the person who did not run the intake approve.

**The Posting tab.** One card per place the job appears:

- **Your careers page**: served by the product; every open role has a public page and an application form.
- **Google for Jobs**: the job page carries the data Google reads. Google indexes on its own schedule, so this shows **Submitted, awaiting verification** until it is confirmed.
- **Applications by email**: an intake address where forwarded applications can arrive once ITS has switched that on for your workspace. Until then, leave it.
- **LinkedIn basic listing**, **Indeed**, **ZipRecruiter**: ITS posts these by hand under your accounts. Each gets its own application link. ITS records the posting's public address, the product checks it, and the card then shows **Live and verified** with the address. Nothing is called live before that check.

Statuses you may see on a card: **Live and verified**, **Submitted, awaiting verification**, **Manual action required**, **Not connected**, **Failed** (with a **Retry** button).

**Pause and Resume.** **Pause** at the top of the role page stops new applications: the job page says the position is not accepting applications, the role disappears from your careers page, and nobody is declined. **Resume** puts it back. To stop accepting applications while leaving the job listed (the page then says applications are closed), use the accepting-applications control on the role; nobody is declined by that either. Postings on the boards are paused or removed by ITS by hand; tell your ITS contact.

## 8. Bringing in a recruiter

Press **Bring in a recruiter** on Today, on a role, or on a candidate. In the panel:

1. Pick what you want: **Review these candidates**, **Help me decide**, or **Take this role over**.
2. Pick **Normal** or **Urgent**. Urgent moves the request to the top of the queue; it does not change the promised time.
3. Add anything specific under **Anything specific?** (optional).
4. Press **Send to a recruiter**.

You see "A recruiter has it" and the expected response time. The request appears on Today until it is answered. The recruiter's answer appears under **What the assistant did** and on the candidate's timeline.

**What the recruiter can see.** Before accepting, only your company name, the role title, the kind of request, its urgency, the skill it needs and the time remaining. After accepting, the role and the one candidate the request concerns, for at most 14 days, ending 24 hours after they mark it resolved. Every page they open is recorded in your **Access history** under **ITS recruiter access** in Setup.

**Ending access.** In **Setup**, under **ITS recruiter access**, press **End this recruiter's access**, type a short reason under **Why you are ending it (the recruiter sees this)**, and press **End access now**. Access ends immediately, the recruiter is told, the request goes back to the queue, and your activity log records it. Only owners and admins can do this.

The product also brings in a recruiter on its own in three cases: a candidate asked for a person during a screen, a held application waited three days without a decision, or a chosen interview time collided three times. You see these on Today like any other request.

## 9. Recording outcomes

The product never makes or sends an offer. When something happens outside the product, your team records it.

**On a candidate.** Open the candidate in **Talent** and find **Record what happened**. Press **Record an outcome** and choose:

- **Hired (offer accepted outside the platform)**, with the hire date and, optionally, the date the offer was accepted
- **Declined an offer made outside the platform**
- **The candidate withdrew**
- **We declined the candidate (they receive a respectful message)**, with a reason
- **No hire for this candidate**

Press **Continue**, then **Yes, record it**. The record carries your name. Only an ITS administrator can correct it, and the original is kept. After recording a hire, the product asks **Close the role too?**; closing is a separate decision.

**On a role.** See section 10.

## 10. Closing a role

On the role page press **Close**. Under **Close this role** choose the outcome:

- **Filled outside the platform**
- **Filled with a candidate from here (already recorded on the candidate)**
- **Cancelled**
- **Closed without a hire**

Add a reason if you like and press **Confirm and close the role**. Candidates who were still active are kept in your talent pool. The job page comes down. The role then lists the boards where the posting is still up; ITS takes each one down and ticks it off, and you can see on the role what is still up.

## 11. Privacy requests

Candidates can ask for a copy of their information, a correction, deletion, or a review by a person, from their status page or by email to privacy@identifiedtalent.com. A person at ITS handles every request, confirms receipt within one business day, and works to a tracked deadline.

**What you see.** That a request of a given kind exists and that it was completed. You do not see its content. A candidate who withdraws shows as withdrawn on their page and on Today.

**If a candidate writes to you directly** with a privacy request, forward it to privacy@identifiedtalent.com the same day and do not act on it yourself.

**If a candidate you hired asks for deletion**, ITS refers it to counsel, because employment records belong to you as the employer.

## 12. What "Development mode" means

You should never see the words "Development mode" or "fake provider" on your live workspace. They appear only on ITS's own test systems, where the AI is replaced by a stand-in and sign-in links are shown on screen. If you ever see a yellow banner reading "Development mode: the AI provider is a deterministic stand-in", or "Development mode" next to an invitation link, stop and email support@identifiedtalent.com. Do not enter real candidate information there.

## 13. Things that need ITS for now

Email support@identifiedtalent.com for any of these. Each is planned as a self-service screen.

- Removing a team member or changing someone's role.
- Editing your company name, locations or website.
- Changing the notices candidates see.
- Correcting a recorded outcome.
- A report beyond what Roles, Talent and Interviews show. ITS sends a written weekly summary.
