# Incident-response plan (release 1, pilot)

Status: **Not started** as a practised process; written 18 September 2026. Becomes "Verified in staging" after one tabletop exercise with Nadine and Paul.

## Roles

- **Incident lead:** Nadine (backup: Paul). Decides severity, communications, and when the incident is closed.
- **Responder:** the production team (Claude) under the incident lead's direction, using only staging access and the founder-provided non-secret references; never credentials.
- **Counsel:** engaged by the incident lead for any suspected personal-data exposure before any external notification.

## Severity

| Level | Definition | First response |
|---|---|---|
| S1 | Suspected exposure of candidate or customer data; credential compromise; unauthorized access | within 1 hour, any day |
| S2 | Product unavailable or candidates unreachable (email or SMS failing) for more than 30 minutes | within 2 business hours |
| S3 | Degraded feature (scheduling, screening) with a workaround | next business day |

## Detection

- Sentry alerts (scrubbed), Vercel, Railway and Supabase status, the worker's health check on Railway (a worker that stops polling is restarted and the app's `/healthz` shows `worker.healthy: false`), the admin console's Failures tab (operator alerts including `worker.stale`, `queue.stale` and `job.failed`; credential deletions; suppressions), PostHog volume drop, a report from a design partner or candidate to `support@` or `privacy@`.

## Steps

1. **Record** the incident in the `Recruiting OS Accounts` vault's incident log: time, reporter, what was seen.
2. **Contain:** for S1, revoke affected credentials (`06-credential-rotation.md`), suspend the affected connection (disconnect in the product), and if needed pause the worker (Railway: remove the `worker` service's active deployment or set its replicas to zero, `docs/runbooks/railway-worker.md`; Supabase: pause the project). Break-glass access is used only under its own rule (MFA, reason, 60 minutes) and is audited.
3. **Assess:** which tenants, which candidates, which data, which window. Use audit records (`audit_records`), events, and provider logs; export the evidence to the vault.
4. **Notify:** the incident lead tells the affected design partner within one business day for S1 (the pilot agreement will set the contractual window; counsel advises and the incident lead decides on any regulator or candidate notice).
5. **Recover:** restore from backup if data was altered (`05-backup-and-recovery.md`), rotate every credential that could have been exposed, re-run the staging verification for the affected area.
6. **Close:** write the post-incident note (what happened, timeline, root cause, what changes) within five business days; add the change to the readiness register.

## Contacts

Recorded in the vault, not here: Supabase support, Vercel support, Postmark support, Google Cloud support, counsel.

## Tabletop exercise (required before real data)

Walk through: "a design partner reports that a candidate received another candidate's interview confirmation." Expected path: S1 → contain (suspend outbound email for the tenant) → assess (communications table, events) → counsel → notify → fix → post-incident note.

## Tabletop record (gate 3.9 of `docs/readiness/16`)

| Date | Attendees | Scenario | Outcome | Actions agreed |
|---|---|---|---|---|
| | | | | |
