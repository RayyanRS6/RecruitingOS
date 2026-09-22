# Backup and recovery plan

Status: **Not started** (plan only); becomes "Verified in staging" after one restore drill.

## What holds the data

| Store | Contents | Backup mechanism | Recovery objective |
|---|---|---|---|
| Supabase Postgres (production) | every table in `docs/spec/05` | Supabase daily backups plus point-in-time recovery (Pro plan add-on, `13` §4) | RPO 2 minutes with PITR; RTO 2 hours |
| Supabase Storage (S3-compatible) | resumes and uploaded files under per-tenant prefixes | bucket versioning on; daily backup copy to a second bucket in the same region (to be configured) | RPO 24 hours; RTO 4 hours |
| Supabase Vault | calendar credentials | included in database backups (encrypted); a restore keeps them usable | as the database |
| Postmark, Twilio, PostHog, Sentry | message logs, analytics, errors | provider-retained; not restorable by ITS | informational only |
| 1Password | account credentials and recovery codes | 1Password's own | two named humans hold access |

## Rules

- Production candidate data is never copied into development or staging (founder decision). Restore drills use a scratch project and are deleted afterwards.
- A restore is performed by Nadine or Paul from the Supabase dashboard; the production team assists with verification only.
- After any restore: run the staging verification sections 2 and 7 against the restored project; check that in-flight workflow runs resume (the queue is durable and idempotent) and that no message is sent twice (idempotency keys).

## Restore drill (required before real data)

1. Create a scratch Supabase project; restore the latest staging backup into it.
2. Point a local API at it with `DATABASE_URL` (read-only role) and run `pnpm test -- rls` and the coverage suite.
3. Confirm one tenant's applications, interviews and audit records match the source; confirm a Vault secret can be read by the worker role.
4. Record the drill (date, who, duration) in this file's log below.

## Drill log

| Date | Who | Source | Duration | Outcome |
|---|---|---|---|---|
| | | | | |
