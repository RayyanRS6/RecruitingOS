# 16. Admin platform

Route group `/admin` in the web app; API under `/api/v1/admin/*`; permission `platform_admin`. Every read of tenant data through admin routes writes an `audit_records` row with the reason the admin entered when opening a customer.

## Views

| View | Shows | Actions |
|---|---|---|
| Customers | Every company: plan, status, roles open, applicants this week, last owner activity, escalations open, cost this month, churn signals (no login 14 days, roles stuck, brief unopened 7 days, downgrade, support tickets) | Open (with reason), impersonate in read-only mode, adjust entitlements, add credits |
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

Built 30 September 2026 (`docs/spec/21` section 7, P1). The customer sees the figures on a role's Report tab and can download the applicant list and the summary as CSV files (every download is audited as `report.exported`). The administrator sees the same figures for a customer across every role through the Report button on the Customers tab (`GET /api/v1/admin/customers/:id/report`, audited like every console read). The two views run the same code (`apps/api/src/services/role-report.ts`), so a number on the customer's page and a number in the console can never disagree. Counts and days only: nothing ranks or scores a candidate, and the JSON never carries a name; only the applicant CSV does. Nadine's weekly summary uses these definitions word for word.

| Figure | Definition |
|---|---|
| Who applied | Every application to the role, counted once per person (a repeat application is a duplicate, not a second applicant). By source: where the person came from, using the same words as the tracked links (Careers page, Email, LinkedIn, Indeed, ZipRecruiter, Referral, Direct, Other) plus the link's detail (a referrer's name, a campaign label). By day: calendar days in the company's own time zone, the last 30 days, cut the same way the daily volume alert cuts them. |
| Where everyone is | How many people are at each step right now, with the step's plain label, and the four owner groups: waiting on you, in process, not moving forward, hired. Identical to the counts on the roles list and the role page. |
| How long each step takes | For each step: how many people are there now and the longest anyone has been there (now minus the moment the step changed); how many people have finished the step and the typical (median) and average number of days they spent in it, from the `application.stage_changed` history. A day is 24 hours. "Waiting on you now" is the same measure for the people in the waiting-on-you group. |
| Interviews | Requested (times not yet picked: proposed or scheduling), on the calendar (scheduled), held (completed), the candidate did not show, cancelled, rescheduled by the candidate (the sum of candidate reschedules), and held but not yet decided (completed or no-show with no decision recorded); the same counts per round. |
| Decisions waiting for you | Everything only a person can decide: candidates in the waiting-on-you group, anyone held on an eligibility answer, and pending approvals that are not already counted through their candidate. With the oldest wait in days and the five oldest items. The roles list's "needs you" is the pending-approval count from the same query. |
| Suggestions and decisions | For each assessed candidate, what the assistant suggested (screen, hold, needs a person's look, interview, interview strongly, decline) and the first thing a person did after the suggestion: invited to a screen, moved to interview, declined, put on hold, or no decision yet. An eligibility override, a flag or a recorded outcome is not a decision about the suggestion and is not counted here. |
| Overruled | Times a person kept someone the eligibility rules would have held, reviewed someone anyway after an eligibility decline, put someone on hold, or flagged an assessment as wrong; from `human.override` events, so each has a name and a reason. |
| Recruiter help | The customer's requests for an ITS recruiter on this role (by role, or by one of the role's candidates): total, still open (open, claimed or in progress), resolved, past the promised response time (service-level deadline before now and not resolved), and the typical (median) clock hours from the request to the first recruiter response. The promised time itself counts business hours; the report shows clock hours and says so. |
| Messages | Outbound emails and texts to the role's candidates, by the outbox's own status: sent (sent or delivered), could not be sent (failed or a spam complaint), bounced, delivery unknown (interrupted while sending), waiting to go out (queued or sending); and how many candidates had a message that did not reach them. |
| Outcomes | The current record per candidate (a corrected record is replaced by its correction): hired, withdrew, declined by the employer, declined the offer, closed without a hire; how many are in the talent pool (never counting someone who asked not to be kept for future roles); how many records were corrected; the role's own outcome once it is closed; and the reasons candidates were declined, from the decline reason a person chose. Always shown under the statement that any offer happened outside Recruiting OS. |

The applicant CSV has one row per application: applied on, name, source, source detail, stage, days in stage, recommendation, decision (the latest thing a person did; a decision after an interview reads as "Not moving forward after interview", "Moved to the next round" or "Finalist"), outcome, interviews, interviews completed. It carries no AI rationale, evidence, résumé text or pay. An ITS recruiter working under a grant that names one candidate gets that candidate's row alone, the same limit the role's applications list applies.
