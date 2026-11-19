# Staff second factor: enrolment, sign-in, backup, reset

A staff session without a second factor is refused everywhere ([DECISIONS.md](../DECISIONS.md), "Staff second factor").

## How it works

1. A member of platform staff (an address on a staff domain, someone who holds a platform role, or the one-time first administrator) signs in with Microsoft. The identity service returns a token at assurance level 1.
2. The app does not open a session on that token. It seals the token in an encrypted, ten-minute cookie scoped to the sign-in routes (`packages/core/src/mfa-transaction.ts`) and sends the person to `/api/v1/auth/mfa`.
3. First sign-in: the page enrols an authenticator app with the identity service (a QR code and a setup key; the secret never touches the app's database or logs) and asks for the first code.
4. Every sign-in: the page asks for the current six-digit code. The app verifies it through the identity service with the person's own token.
5. Only the token the service issues again at assurance level 2 opens the session (eight hours for staff). Attempts are counted on the server: five per sign-in (the fourth wrong code warns, the fifth ends the attempt) and twelve per person in fifteen minutes across sign-ins, so a fresh Microsoft sign-in buys no extra guesses.
6. Right after the first enrolment, and at any later sign-in while only one authenticator exists, the page offers a backup authenticator on a second device. The identity service issues no recovery codes, so the backup is the person's own way back in.
7. The QR code is shown once. A refreshed page shows the same setup key as text.

Audit records, none of which carries a secret or a token: `mfa.enrolled`, `mfa.verified`, `mfa.failed`, `mfa.backup_enrolled`, `mfa.reset_detected`, and `session.opened`.

## What a member of staff does

- First sign-in: install an authenticator app, sign in with Microsoft, scan the QR code or type the setup key, enter the code, then add the backup authenticator when offered. Best: the primary in a password manager, the backup in a phone app.
- Every sign-in: Microsoft, then the code. Codes change every 30 seconds.
- Lost the primary device: sign in with the backup authenticator's code, then ask for a reset (below) and enrol the replacement.
- Lost every authenticator: ask for a reset; nobody can remove their own factors without a code.

## Reset (the only way back without a working authenticator)

The app holds no admin key of the identity service, so it cannot remove a factor. The owner of the Supabase organization does it in the dashboard:

1. Confirm the request by a channel that is not the request itself (a call, or in person). Never act on an email alone.
2. Supabase, the production project, **Authentication**, **Users**, open the person, **Remove MFA factors**, confirm. This removes every authenticator the person holds; it does not sign them out of Microsoft.
3. Tell the person to sign in again. The app sees someone who had enrolled before and now has no factor, records `mfa.reset_detected`, and runs the enrolment page again.
4. Note the reset in the queue mailbox with the date, the person and who confirmed the request. The audit record and this note are the two-person trail.

## Settings that must stay as they are

- Supabase, Authentication, Multi-Factor: **TOTP (App Authenticator)** = Enabled. "Verify Enabled" would block new enrolments; "Disabled" would block every staff sign-in.
- All staff share the app's outbound address at the identity service, so a burst of failed sign-ins can produce "not available right now"; wait a minute.

## Messages a person may see

| Message | Meaning | What to do |
|---|---|---|
| The second-factor step timed out. Sign in again. | the ten-minute window closed, or the cookie was lost | sign in again |
| The code was wrong too many times. Sign in again. | five wrong codes | check the app's clock and account, sign in again |
| The second-factor service is not available right now. Try again in a few minutes. | the identity service refused or limited the call | wait; if it lasts, check Supabase's status page and the provider settings |
| That code is not right. Check the app and try again. | a wrong code, or the app's clock is off | enter the code showing now |
| Please try again in N minutes | more than forty code posts from one address in fifteen minutes | wait; if this is not you, tell the owner |
