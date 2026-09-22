# Staff second factor: enrolment, sign-in, backup, reset

Status: built and tested locally on 22 September 2026 under the founder's approval of the same day ("build and test
staff TOTP enrollment, verification, recovery, and enforcement before real staff sign-in is enabled"). Not yet
exercised on the staging identity service. Nothing here weakens the rule: an ITS staff session without a second factor
is refused everywhere (`docs/readiness/13`).

## How it works

1. An ITS staff member (an `identifiedtalent.com` address, a platform-role holder, or the one-time bootstrap address)
   signs in with Microsoft. Microsoft vouches for the person; the identity service returns a token at assurance level 1.
2. The application does not open a session on that token. It seals the token in an encrypted, ten-minute cookie scoped
   to the sign-in routes (`packages/core/src/mfa-transaction.ts`) and sends the person to `/api/v1/auth/mfa`.
3. First sign-in: the page enrols an authenticator app with the identity service (a QR code and a setup key shown once;
   the secret never touches the application's database or logs) and asks for the first code.
4. Every sign-in: the page asks for the current six-digit code from the app. The application creates a challenge and
   verifies the code in one request, through the identity service, with the person's own token.
5. Only the token the service re-issues at assurance level 2 opens the application session (eight hours for staff).
   Five wrong codes end the attempt; the person starts again at sign-in.
6. Right after the first enrolment, and at any later sign-in while only one authenticator exists, the page offers a
   backup authenticator on a second device. The identity service issues no recovery codes, so the backup is the
   person's own way back in.

Audit records, none of which carries a secret or a token: `mfa.enrolled`, `mfa.verified`, `mfa.failed` (with the
attempt count), `mfa.backup_enrolled`, `mfa.reset_detected`, plus `session.opened` with `aal2`.

## What a staff member does

- First sign-in: install an authenticator app (1Password, Microsoft Authenticator, or any app that supports time-based
  codes), sign in with Microsoft, scan the QR code or type the setup key, enter the code, then add the backup
  authenticator when offered. Recommended: the primary in 1Password, the backup in a phone app.
- Every sign-in: Microsoft, then the code. Codes change every 30 seconds; the current one and its neighbours are
  accepted.
- Lost the primary device: sign in with the backup authenticator's code. Then ask the platform owner for a reset (below)
  and enrol the replacement device.
- Lost every authenticator: ask the platform owner for a reset; you cannot remove your own factors without a code.

## Reset by the platform owner (the only recovery without a working authenticator)

The application deliberately holds no identity-service admin key, so it cannot remove a factor. The Supabase
organization owner (Nadine) does it in the dashboard:

1. Confirm the request by a channel that is not the request itself (a call, or in person). Never act on an email alone.
2. Supabase dashboard, project `recruiting-os-staging` or `recruiting-os-production`, **Authentication**, **Users**, open
   the person, select **Remove MFA factors**, confirm **Remove factors**. This removes every authenticator the person
   holds and drops their sessions to level 1; it does not sign them out of Microsoft.
3. Tell the person to sign in again. The application sees a person who had enrolled before and now has no factor,
   records `mfa.reset_detected`, and runs the enrolment page again.
4. Note the reset in the ITS queue mailbox with the date, the person and who confirmed the request. The audit record
   and this note are the two-person trail.

## Settings that must stay as they are

- Supabase, Authentication, Multi-Factor: **TOTP (App Authenticator)** = Enabled. "Verify Enabled" would block new
  enrolments; "Disabled" would block every staff sign-in.
- The identity service allows fifteen challenge-or-verify requests per minute per address, with bursts to thirty. All
  staff share the application's outbound address, so a burst of failed sign-ins can produce "not available right now";
  wait a minute.
- Supabase's "Limit duration of AAL1 sessions" may be switched on: the application never relies on a level-1 staff
  session.

## Messages a person may see and what they mean

| Message | Meaning | What to do |
|---|---|---|
| The second-factor step timed out. Sign in again. | the ten-minute window closed, or the cookie was lost | sign in again |
| The code was wrong too many times. Sign in again. | five wrong codes | check the app's clock and account, sign in again |
| The second-factor service is not available right now. | the identity service refused or rate-limited the call | wait a minute; if it persists, check the Supabase status page and the provider settings |
| That code is not right. | wrong code, or the app's clock is off | enter the code showing now |

## Staging verification (Phase 3, `docs/readiness/03` section 3)

Enrol Nadine's account on staging, add the backup, sign out and in with each authenticator, fail five times and recover,
run one dashboard reset and re-enrol, and confirm `/api/v1/auth/me` shows `aal2` with `mfaVerifiedAt` after each
sign-in and that no audit record carries a secret or a token.
