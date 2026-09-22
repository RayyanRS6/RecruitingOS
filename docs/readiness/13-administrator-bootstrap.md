# 13. Platform administrators: the one-time bootstrap and the ledger

Status: implemented locally on 21 September 2026 (founder instruction, item 2). Not yet exercised on a real staging
account. Nothing here is legal advice.

## The rule

Nobody holds platform authority because of an email address, a domain, or a configuration value. A person is a platform
administrator (or an ITS recruiter) only while an unrevoked row in the `platform_role_grants` ledger names them. The row
records who granted it, why, when, and, later, who revoked it and why. No email address is written into application
authorization logic.

Administrator actions (everything under `/api/v1/admin/*`) and recruiter actions also need a session opened with
Microsoft 365 **and** a second factor. A session with the role but without a second factor is refused with
`mfa_required`. Existing roles from before the ledger were given ledger rows by migration 0014 (source
`migration_backfill`) so they are visible in the console and can be revoked; the tenant database role can no longer
write the cached role column at all.

## The one-time bootstrap

There has to be a first administrator. The environment variable `BOOTSTRAP_ADMIN_EMAILS` exists only for that moment.

1. Set `BOOTSTRAP_ADMIN_EMAILS` to one staff address (whoever will be the first administrator) before the first start.
2. That person signs in with Microsoft 365 and a second factor: on the very first sign-in the second-factor page
   enrols an authenticator app (`docs/runbooks/staff-second-factor.md`), and the bootstrap applies only to the level-2
   session that results. Because the list is honoured only while **no
   administrator exists**, the first qualifying sign-in writes one ledger row with source `bootstrap`, sets the role, and
   records an audit entry `platform_role.changed` plus an alert `platform_role.changed` in the console.
3. Remove `BOOTSTRAP_ADMIN_EMAILS` from the environment and restart.
4. From then on the variable grants nothing. If it is still set, the application warns at startup, the console shows a
   banner, and every later match is audited as `bootstrap.ignored`.

The second administrator is not bootstrapped. The first administrator grants them in the console (Administrators tab):
the person must already have signed in with Microsoft 365 and a second factor; the grant needs a reason and a
confirmation; the change raises an alert that **another** administrator must acknowledge, and emails every other
administrator and the ITS queue mailbox.

## Two-person visibility

- Every grant and revocation writes an audit record and raises a high-severity alert.
- The administrator who made the change cannot acknowledge that alert (`second_person_required`).
- Every other administrator and the ITS queue mailbox receive an email with the actor, the person, the role and the reason.
- While only one administrator exists, the ITS queue mailbox is the second pair of eyes; the founder decides who reads it.
- With exactly two administrators, the alert about the second one's grant cannot be acknowledged by either of them (one made the change, one is its subject). It stays open in the console on purpose until a third administrator exists; the email to the queue mailbox is the record in the meantime.

## Rules the code enforces

| Rule | Where | Test |
|---|---|---|
| An email match alone never grants a role once an administrator exists | `applyBootstrapAdmin` in `packages/core/src/platform-roles.ts` | `apps/api/src/platform-roles.test.ts` |
| The ledger is the authority on every request; the cached `users.platform_role` column grants nothing on its own | `loadSession` in `packages/core/src/auth.ts` reads the active grant | same ("ghost" account with the column set and no ledger row is refused) |
| The retired `PLATFORM_ADMIN_EMAILS` grants nothing; no personal staff address appears in authorization code | `apps/api/src/env.ts` warning; guard test | same |
| A platform-role holder never signs in with the email link, whatever the domain | `consumeMagicLink` and the magic-link request route | same |
| The same provider cannot present a different identity for an existing account | `openSessionFromIdentity` (`identity_mismatch`) | same |
| Staff sessions slide by eight hours, never the thirty-day customer window | `loadSession` | same |
| The person elevated cannot acknowledge the alert about their own elevation | `POST /admin/alerts/:id/acknowledge` | same |
| The bootstrap and every grant or revocation run inside one transaction with a ledger lock | `openSession` in `apps/api/src/routes/auth.ts`; `lockLedger` | concurrency reasoning; single connection locally |
| Self-grant is refused | `grantPlatformRole` | same |
| Grantee must be on a staff email domain and have signed in with Microsoft 365 | `POST /api/v1/admin/platform-roles` | same |
| The last administrator cannot be revoked | `revokePlatformRole` | same |
| Revocation takes effect on the person's next request | `loadSession` reads the user row every request | same |
| Administrator routes need a second factor in the session | `requirePlatformAdmin` | same, and `apps/api/src/app.test.ts` |
| Ledger rows are never deleted by any application role; audit records neither | migrations `0011` and `0014` | `pnpm db:validate` checks DELETE for app_tenant, ros_app and ros_worker on the append-only tables |

## What the founder decides

- Who is the first administrator (the one address in `BOOTSTRAP_ADMIN_EMAILS`).
- Who reads the ITS queue mailbox while there is one administrator.
- Whether ITS recruiters are granted by any administrator or only by the founder (today: any administrator; the alert and
  the email make it visible).
