# 16. Admin platform

Route group `/admin` in the web app; API under `/api/v1/admin/*`; permission `platform_admin`. Every read of tenant data through admin routes writes an `audit_records` row with the reason the admin entered when opening a customer.

## Views

| View | Shows | Actions |
|---|---|---|
| Customers | Every company: the ITS check (companies waiting for it listed first, longest waiting at the top, with how many messages to candidates are held), whether ITS can sign in to its job boards, plan, status, roles open, applicants this week, last owner activity, recruiter requests against the plan's allowance ("Recruiter requests: used of limit", with a caution chip "Past its recruiter requests: talk about billing" once over) and escalations in all, cost this month, churn signals (no login 14 days, roles stuck, brief unopened 7 days, downgrade, support tickets) | Open (with reason), impersonate in read-only mode, adjust entitlements, add credits; **Confirm** / **Check** opens the ITS check sheet (below); **Report** |
| Roles | All roles across tenants with pipeline counts and stuck flags | Open |
| Candidates | Search across tenants (audited) for support and dedupe issues | Open |
| Workflows | Active, waiting, failed runs with workflow key, subject, current step, wait reason, age | Inspect, retry step, cancel, escalate |
| Failed workflows | Failures grouped by workflow and error | Retry, bulk retry, mark resolved |
| AI runs | Every run: company, agent, task, model, prompt version, tokens, cost, latency, status | Inspect (input reference, structured output, rationale, policy decision, human override, final outcome) |
| Human escalations | Queue by SLA, assignment, status | Claim, assign, resolve, convert to takeover |
| API failures | Integration errors by provider and tenant; adapter health | Re-run health check, disable adapter |
| Candidate complaints and data requests | Intake queue with SLA | Assign, resolve, log outcome |
| Costs and usage | Tokens, voice minutes, SMS segments, e-sign envelopes, background checks by tenant and by day; gross margin estimate per tenant | Export |
| Customer activity | Logins, brief opens, decisions per week, owner response time | |
| Support issues | Linked tickets (external) | |
| Prompts and evals | Active prompt versions, last eval results, thresholds | Promote or roll back a prompt version (audited) |
| Playbooks | Versions, status | Publish (audited) |

## The ITS check of a company and job-board access

Founder decision B7 (plan B1 and B2). A company that signs itself up can draft and approve roles at once, but nothing of it is public (careers page, job pages and their addresses, the JobPosting data, the feeds and sitemap, tracked links, the apply form) and its messages to candidates wait in the outbox as `held` until an administrator confirms it. The ITS queue mailbox is emailed when such a company signs up. Companies that existed before the check began were confirmed by migration 0027.

- **Confirm the company** (`POST /api/v1/admin/customers/:id/verification`, `verified: true`): after checking the company is real (the kick-off call, its website, a phone number). A reason of five characters or more and a second press are required. Its pages go public, approved roles waiting to be published are published, and every held message goes into the queue, oldest first (texts wait for the company's allowed hours); a held message that must no longer go (the candidate stopped texts, or an invitation to someone who has since left the process) is cancelled with its reason instead. Confirming a company that is already confirmed changes nothing except that any message still held goes out: use it to repair a message held while the confirmation was being made.
- **Take back the confirmation** (`verified: false`): the pages and feeds go offline at once and messages to candidates wait again, including ones already queued. Roles, candidates and decisions are kept. Today tells the company "ITS is checking your company again".
- Both are audited with the reason (the customer sees it in their own history) and the owners, admins and hiring managers are told; that notice is always emailed and cannot be turned off.
- **Job-board access** (`POST /api/v1/admin/customers/:id/job-boards`): record once ITS can sign in to the company's LinkedIn, Indeed and ZipRecruiter accounts (or that it no longer can, with an optional note). It ticks the owner's getting-started step and is audited.

## How people apply, and the screening allowance

Plan Wave E (founder decisions B1/Q15 and Q17).

- **How people apply** (the Customers column, and **Change**): the company's default, "Form now, conversation later" unless set (the one-visit flow runs on pilot roles first, founder decision B1; `POST /api/v1/admin/customers/:id/apply-flow`), and each open or draft role's own setting, or the company's default (`PUT /api/v1/roles/:id/apply-mode`). The same role control is on the role's Posting tab for ITS staff: an administrator can always use it, an ITS recruiter only under an active grant for that company that covers the role. The **Plan** column also shows this month's screening conversations against the allowance. A reason of five characters or more is required and audited. A role whose rule for screening invitations is "Ask me first" or "Only a person" always uses the later path; a change applies to new applicants only. Customers never see or change it.
- **Screening conversations running low**: a card at the top of Customers, and a chip on the company's row, while an alert says a company has used 80% of the month's screening conversations or all of them (`billing.screens_warning`, `billing.screens_used_up`). Nothing is refused: applications are still accepted, anyone part-way through finishes, and once the allowance is used up new applicants get the conversation link by email when more are added. The owners and admins see the same on Today.

## The six questions for any AI action

Inspecting an AI run must answer, on one screen:

1. **What did the AI see?** Input references (application id, document hashes, packet version, prompt key and version, rendered prompt hash) and, for admins with reason, the rendered prompt.
2. **What did it conclude?** The validated structured output.
3. **Why?** The rationale and evidence fields of the output, and the confidence.
4. **What policy applied?** The resolved policy for the proposed action (level, source: role, company, default, takeover).
5. **What did the human do?** The approval decision or override, with actor, time, and note.
6. **What action occurred?** The resulting events, with links.

## Operational alerts

Failed run rate above threshold; queue age above 5 minutes; adapter health failing; AI error or refusal rate spike; cost per tenant per day anomaly; escalation SLA breach; unmatched inbound emails growing.

## The customer report: what each figure means

Built 30 September 2026 (`docs/spec/21` section 7, P1). The customer sees the figures on a role's Report tab and can download the applicant list and the summary as CSV files (every download is audited as `report.exported`). The administrator sees the same figures for a customer across every role through the Report button on the Customers tab (`GET /api/v1/admin/customers/:id/report`, audited like every console read). The two views run the same code (`apps/api/src/services/role-report.ts`), so a number on the customer's page and a number in the console can never disagree. Counts and days only: the report itself ranks nobody and carries no match score (those are on the Talent page and the pool board, `docs/spec/22`), and the JSON never carries a name; only the applicant CSV does. Nadine's weekly summary uses these definitions word for word.

| Figure | Definition |
|---|---|
| Who applied | Every application to the role, counted once per person (a repeat application is a duplicate, not a second applicant). By source: where the person came from, using the same words as the tracked links (Careers page, Email, LinkedIn, Indeed, ZipRecruiter, Referral, Direct, Other) plus the link's detail (a referrer's name, a campaign label). By day: calendar days in the company's own time zone, the last 30 days, cut the same way the daily volume alert cuts them. |
| Where everyone is | How many people are at each step right now, with the step's plain label, and the four owner groups: waiting on you, in process, not moving forward, hired. Identical to the counts on the roles list and the role page. |
| How long each step takes | For each step: how many people are there now and the longest anyone has been there (now minus the moment the step changed); how many people have finished the step and the typical (median) and average number of days they spent in it, from the `application.stage_changed` history. A day is 24 hours. "Waiting on you now" is the same measure for the people in the waiting-on-you group. |
| Interviews | Requested (times not yet picked: proposed or scheduling), on the calendar (scheduled), held (completed), the candidate did not show, cancelled, rescheduled by the candidate (the sum of candidate reschedules), and held but not yet decided (completed or no-show with no decision recorded); the same counts per round. |
| Decisions waiting for you | Everything only a person can decide: candidates in the waiting-on-you group, anyone held on an eligibility answer, and pending approvals that are not already counted through their candidate. With the oldest wait in days and the five oldest items. The roles list's "needs you" is the pending-approval count from the same query. |
| Suggestions and decisions | For each assessed candidate, what the assistant suggested (screen, hold, needs a person's look, interview, interview strongly, decline) and the first thing a person did after the suggestion: invited to a screen, moved to interview, declined, put on hold, or no decision yet. An eligibility override, a flag or a recorded outcome is not a decision about the suggestion and is not counted here. |
| Overruled | Times a person kept someone the eligibility rules would have held, reviewed someone anyway after an eligibility decline, put someone on hold, or flagged an assessment as wrong; from `human.override` events, so each has a name and a reason. |
| How the pool meets the must-haves | One role only (the role's Report tab; not the console's across-roles view): for each must-have, how many of the people read so far show it, partly show it, show in their own words that they do not meet it (a checked quote only), and say nothing either way (someone read before a must-have was added is left out of its count); how many show every must-have; and the gentle note when one must-have is not shown by 60% or more of at least five people ("stricter than the job needs?"), which never turns anyone down. From the same findings as the match score and the pool board (`docs/spec/22`). Counts only, no names. |
| Recruiter help | The customer's requests for an ITS recruiter on this role (by role, or by one of the role's candidates; a "Something wrong?" flag on an assessment is one too, plan F11): total, still open (open, claimed or in progress), resolved, past the promised response time (service-level deadline before now and not resolved), and the typical (median) clock hours from the request to the first recruiter response. The promised time itself counts business hours; the report shows clock hours and says so. |
| Messages | Outbound emails and texts to the role's candidates, by the outbox's own status: sent (sent or delivered), could not be sent (failed or a spam complaint), bounced, delivery unknown (interrupted while sending), waiting to go out (queued or sending); and how many candidates had a message that did not reach them. |
| Outcomes | The current record per candidate (a corrected record is replaced by its correction): hired, withdrew, declined by the employer, declined the offer, closed without a hire; how many are in the talent pool (never counting someone who asked not to be kept for future roles); how many records were corrected; the role's own outcome once it is closed; and the reasons candidates were declined, from the decline reason a person chose. Always shown under the statement that any offer happened outside Recruiting OS. |

The applicant CSV has one row per application: applied on, name, source, source detail, stage, days in stage, recommendation, decision (the latest thing a person did; a decision after an interview reads as "Not moving forward after interview", "Moved to the next round" or "Finalist"), outcome, interviews, interviews completed. It carries no AI rationale, evidence, résumé text or pay. An ITS recruiter working under a grant that names one candidate gets that candidate's row alone, the same limit the role's applications list applies.
