# Credential-rotation plan

Status: **Not started** (plan only). Every credential is created and entered by Nadine or Paul; the production team never sees values (founder decision, `docs/spec/12` §I). Rotation dates are recorded in the vault with a reminder 30 days before expiry.

| Credential | Where it lives | Rotate every | How to rotate | How to verify | How to revoke fast |
|---|---|---|---|---|---|
| Database role passwords (`ros_app`, `ros_worker`, owner) | Supabase; values in Vercel and Railway | 90 days, or at once on suspicion | `ALTER ROLE ... PASSWORD` in the SQL editor; update the variable; redeploy | `/healthz`; worker log "started ... as ros_worker" | same as rotate |
| Supabase anon key, JWT secret | Supabase; Vercel | 180 days | regenerate in Project settings → API; update variables | sign in works; `identity.test.ts` against staging | regenerate |
| Postmark server token, webhook secret, inbound secret | Postmark; Vercel | 180 days | create a new token, switch, delete the old | send a test message; post a test webhook | delete token in Postmark |
| Google OAuth client secret (calendar) | Google Cloud; Vercel | 180 days | add a second secret, switch, remove the first | connect a test calendar | delete the client secret; users reconnect |
| Microsoft Entra sign-in client secret | Entra; Supabase Auth provider settings | 12 months (Entra expiry) | new secret in Certificates & secrets; update Supabase | staff sign-in | delete in Entra |
| Anthropic API key | Anthropic console; Vercel and Railway | 90 days | create, switch, revoke | one intake turn in staging | revoke in the console |
| Twilio auth token | Twilio; Vercel | 90 days | secondary token, promote, delete primary | webhook signature verification test | delete |
| Sentry DSN, PostHog project key | providers; Vercel | 12 months | regenerate | a scrubbed test event arrives | regenerate |
| Calendar refresh tokens (per interviewer) | Supabase Vault only | on disconnect, on revocation, or when a probe fails three times | automatic: the worker revokes at the provider and deletes the secret (`connections.ts`) | audit `credentials.deleted` | disconnect in Setup or the admin retry |
| Session cookies | database `sessions` | 30 days idle (8 hours for staff) | automatic | `/auth/me` | revoke sessions in the admin endpoint |
| `SESSION_SECRET`, `ANALYTICS_SALT` | Vercel | 12 months | generate 32+ random bytes; set; redeploy (sessions survive; analytics references change) | app boots | change |

## Compromise procedure

1. Revoke the credential at the provider (fast column) before anything else.
2. Rotate and redeploy.
3. Search audit records and provider logs for use during the exposure window; record in the incident log (`04-incident-response.md`).
4. If the credential could read candidate data, treat as S1.

## Drill log (required before real candidate data; gate 4.10 of `docs/readiness/16`)

| Date | Credential | Rotated by | Checked by | Result |
|---|---|---|---|---|
| | | | | |

## Attestation (gate 2.3 of `docs/readiness/16`)

One line, dated and signed by Nadine and Paul, kept in the vault next to the credentials: "Every secret value was entered
directly into the vault or the service settings; none was sent by email or chat or pasted into a document." The
repository secret scan covers the code only and says nothing about email or chat.
