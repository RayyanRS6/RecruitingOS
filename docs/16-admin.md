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
