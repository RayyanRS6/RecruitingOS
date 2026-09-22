# 07. API specification (release 1)

Base: `/api/v1`, JSON, validated by Zod schemas in `packages/contracts/src/api/index.ts`; errors `{ error: { code, message, details? } }`; session cookie `ros_session` (httpOnly, SameSite=Lax, Secure in production); tenancy from the session's active membership, selectable with `X-Company-Id`; permissions from `02`. Status column: existing / changed / new. Candidate pages are HTML form routes under `/c/*` and `/careers/*`; webhooks under `/webhooks/*`.

Conventions added in release 1: `Idempotency-Key` header honored on every mutating `/api/v1` route (24 h dedupe per user); list routes accept `?limit` (default 50, max 200) and `?cursor`; mutations check the `Origin` header (S8); rate limits per route (`429` with `Retry-After`); `X-Request-Id` echoed; tokens never appear in logs.

## Auth

| Method | Path | Body → Response | Status |
|---|---|---|---|
| GET | /auth/config | → `{mode, providers[{key,label}], magicLink, staffDomains}` | new (D19) |
| GET | /auth/start/:provider | → 302 to the identity service (PKCE; verifier in an httpOnly cookie) | new (D19) |
| GET | /auth/callback?code= | exchanges the code, verifies the token, applies the sign-in policy, opens the session → 302 to the app (or `/login?error=<code>`) | new (D19) |
| POST | /auth/session | `{accessToken}` → `{ok, userId, activeCompanyId, staff, expiresAt}`; 401 for an invalid token, 403 `email_unverified` / `staff_provider_required` / `mfa_required` | new (D19) |
| GET/POST | /auth/fake/authorize | development consent page of the fake issuer; never mounted in production | new (dev only) |
| POST | /auth/magic-link | `MagicLinkRequest` → `{ok}` (dev: `devLink`); 403 for staff domains; 410 when `MAGIC_LINK_ENABLED=false` | changed |
| GET | /auth/consume?token= | → 302 to the app | existing |
| POST | /auth/magic-link/consume | `MagicLinkConsume` → `{ok, userId, activeCompanyId}` | existing |
| POST | /auth/logout | → `{ok}` | existing |
| GET | /auth/me | → `MeResponse` (+ `ai.provider`, `auth {provider, aal, mfaVerifiedAt}`) | changed |
| POST | /auth/switch | `{companyId}` → `{ok}` | existing; ITS staff only for companies with an open escalation (D11) |
| GET | /auth/sessions | → `Session[]` (id, createdAt, lastSeenAt, ip, userAgent, current) | new |
| POST | /auth/sessions/:id/revoke and /auth/sessions/revoke-all | → `{ok}` | new |
| POST | /auth/reauth | `{token}` (fresh magic link) → `{ok, reauthUntil}` (10 min) | new; required before policy changes (D12) |

## Companies and team

| Method | Path | Body → Response | Status |
|---|---|---|---|
| POST | /companies | `CreateCompany` → `Company` | existing |
| GET / PATCH | /companies/current | `UpdateCompany` → `Company` (+ integrations statuses, plan, usage) | changed: plan and usage |
| GET | /companies/current/members | → `Member[]` (+ calendar status per member) | changed |
| POST | /companies/current/invites | `InviteMember` → `{ok}` | existing |
| PATCH | /companies/current/members/:userId | `{role?, status?}` → `Member` (revokes that user's sessions on role change) | changed |
| PUT | /companies/current/notices | `{key, text, jurisdictions}` → `Notice` (human-only, audited, reauth) | new |

## Intake, roles, packets, postings

| Method | Path | Body → Response | Status |
|---|---|---|---|
| POST | /intake/sessions | `StartIntake` → `{session, reply}` | existing |
| GET | /intake/sessions, /intake/sessions/current, /intake/sessions/:id | → sessions | existing |
| POST | /intake/sessions/:id/messages | `IntakeMessageRequest` → `{session, reply}` | existing |
| POST | /intake/sessions/:id/abandon | → session | existing |
| POST | /intake/sessions/:id/compile | → `{roleId, version, packet, workflowRunId}` (402 when the plan limit is reached) | existing |
| POST | /intake/conversation/messages | `ConversationMessage` → `{reply, proposedActions[]}` | existing |
| GET | /roles | `?status` → `RoleSummary[]` | existing |
| GET | /roles/:id | → `RoleDetail` (+ `interviewPlan` with interviewer availability status; `timeline`) | changed |
| GET | /roles/:id/packets | → `RolePacketVersion[]` | existing |
| GET | /roles/:id/packets/:version/diff?against= | → `PacketDiff` (section-level changes) | new |
| POST | /roles/:id/packets | `CreatePacketVersion` → version | existing |
| POST | /roles/:id/approve | `ApproveRole` → `{ok, approvalRequestId}` | existing |
| POST | /roles/:id/pause, /resume, /close | `RoleStatusChange` → role | existing |
| GET | /roles/:id/postings; POST /roles/:id/postings/:channel/retry | | existing; external channels 404 when the flag is off |
| GET | /roles/:id/applications | `OwnerGroupQuery` → `ApplicationSummary[]` | existing |
| GET | /roles/:id/interviews | → `InterviewSummary[]` | new |

## Applications

| Method | Path | Body → Response | Status |
|---|---|---|---|
| GET | /applications/:id | → `ApplicationDetail` (+ `interviews[]`) | changed |
| POST | /applications/:id/actions | `ApplicationAction` with actions `invite_screen`, `advance_to_interview`, `reject`, `hold`, `move_to_talent_pool`, `override_eligibility`, `review_anyway` → `{ok, stage, ...}` | changed: `advance_to_interview` now only moves to `interview_recommended`; scheduling starts through `/interviews` |
| POST | /applications/:id/assessments/:assessmentId/flag | `FlagAssessment` → `{ok}` | existing |
| POST | /applications/:id/interviews | `RequestInterview` = `{roundKey, interviewerUserIds[], linkSource: "calendar" \| "pasted", meetingUrl?, window?: {fromDate, toDate}, note?}` → `InterviewSummary` (creates `proposed`, resolves any pending `interview.request` approval as the human's decision, starts `schedule_interview`) | new; permission `interview.request`; policy `interview.request` |
| POST | /applications/:id/decision | `RecordDecision` = `{decision: "next_round" \| "finalist" \| "hired" \| "not_moving_forward", reason?: RejectReason, note?}` → `{ok, stage}` (human-only; `next_round` returns the next `roundKey` for the interview sheet) | new (D10); permission `interview.decide` |

## Interviews and calendars

| Method | Path | Body → Response | Status |
|---|---|---|---|
| GET | /interviews | `?from&to&status&mine=1` → `InterviewSummary[]` | new |
| GET | /interviews/:id | → `InterviewDetail` (slots offered, participants with availability source, calendar refs without secrets, timeline; compensation omitted for interviewers) | new |
| POST | /interviews/:id/reschedule | `{reason?, window?}` → `InterviewSummary` (cancels events, re-offers) | new; `interview.manage` |
| POST | /interviews/:id/cancel | `{reason}` → `InterviewSummary` | new |
| POST | /interviews/:id/outcome | `{outcome: "happened" \| "no_show_candidate" \| "no_show_interviewer"}` → `InterviewSummary` | new; participants and managers |
| POST | /interviews/:id/book-on-behalf | `{slotId}` → `InterviewSummary` (owner picks for the candidate after a call; audited) | new |
| GET | /me/calendar | → `{connection (public shape, no secrets) \| null, availability \| null, providers[{key,status}]}` | built 18 Sep |
| GET | /integrations/calendar/:provider/connect | → 302 to the provider consent screen (state bound to the session) | new; `calendar.connect` |
| GET | /integrations/calendar/:provider/callback | `?code&state` → 302 to `/setup?calendar=connected` (stores encrypted tokens; emits `integration.connected`) | new |
| POST | /integrations/calendar/:provider/disconnect | → `{ok}` (deletes credentials; audited) | new |
| PUT | /me/availability | `InterviewerAvailabilityInput` → `InterviewerAvailability` (signals `availability.updated` for waiting runs) | new |
| GET | /integrations | → adapter statuses (email, sms, calendar providers, boards, comp, storage) | existing |

## Approvals, escalations, events, notifications, policies

| Method | Path | Body → Response | Status |
|---|---|---|---|
| GET | /approvals?status= ; POST /approvals/:id/decide | `DecideApproval` | existing (deciding `interview.request` from a card calls the same path as `/applications/:id/interviews` with the proposal's interviewers) |
| POST | /escalations ; GET /escalations/mine | `CreateEscalation` (+ optional `urgency`) → `{id, slaDueAt, message}`; the message describes the hours from the calendar in force; `/mine` includes `urgency` and `summary` | changed (correction 11, 12) |
| GET | /escalations | → `EscalationPreview[]`: exactly `id, status, kind, urgency, requiredExpertise, summary, companyName, roleTitle, slaDueAt, slaRemainingMinutes, businessMinutesRemaining, overdue, createdAt, claimedByMe, claimed`. No identifiers that lead to candidate data, no free text. Each view audited as `escalation.preview_viewed` for the customer. | changed (correction 11; `apps/api/src/queue-preview.test.ts`) |
| GET | /escalations/:id | → the same preview plus `accessGranted:false, why` until claimed by the caller; under an active grant adds `companyId, roleId, applicationId, question, contextSnapshot, resolution, grant`; audited | changed (correction 11) |
| POST | /escalations/:id/claim | → `{escalation, grant}`; creates the scoped 14-day grant, sets `firstResponseAt`, notifies the customer | changed |
| POST | /escalations/:id/resolve | `ResolveEscalation` (+ `minutesSpent`) → escalation; shortens the grant to 24 h; notifies the customer | changed |
| POST | /escalations/:id/release | → escalation; ends the grant, returns the request to the queue | new |
| GET | /events | `?subjectType&subjectId&type&since&cursor` → `Event[]` | changed: cursor |
| GET | /notifications?unread=1 ; POST /notifications/read | | existing |
| GET | /integrations | → the company's connections (`publicConnection`: provider, kind, status, externalAccountId, connectedAt, lastHealthAt, lastError, disconnectedAt, disconnectReason, credentialsDeleted, revokedAt, config). Never a credential or its reference. | new (correction 10) |
| POST | /integrations/:id/disconnect | `{reason?}` → the connection plus `deletionQueued`; requires `integration.manage` (owner, admin); disables at once and queues revocation and deletion | new (correction 10) |
| GET / PUT | /policies | `UpsertPolicy` (release-1 action allowlist; locked actions rejected; reauth required) | changed |
| GET | /brief | → `Brief` | existing |

## Data requests

| Method | Path | Body → Response | Status |
|---|---|---|---|
| GET | /data-requests ; POST /data-requests/:id/status | `{status, resolution?}` | new; `data_request.manage` |

## Admin (platform_admin; every request audited with a required reason in production)

| Method | Path | Status |
|---|---|---|
| GET /admin/customers, /admin/runs, /admin/runs/:id, POST /admin/runs/:id/retry, GET /admin/ai-runs, /admin/ai-runs/:id, /admin/failures, /admin/costs, /admin/queue | existing |
| GET /admin/escalations | changed (correction 11): operational columns only (category, urgency, expertise, generic summary, timing, assignee email); never the request text, context snapshot, or resolution text; audited |
| GET /admin/calendar → `{current, version, effectiveFrom, description, upcoming, versions, preview[28 days]}` ; POST /admin/calendar `BusinessCalendarInput` → new immutable version (audited `calendar.changed`) ; POST /admin/calendar/recalculate `RecalculateDeadlines {escalationIds?, reason}` → `{considered, changed, results}` (audited per request as `escalation.sla_recalculated`; tenant event `recruiter.sla_recalculated`) | new (correction 12) |
| POST /admin/customers/:id/plan `{planKey}` | new (D9) |
| GET /admin/alerts ; POST /admin/alerts/:id/acknowledge ; POST /admin/integrations/:id/retry-deletion ; GET /admin/failures now also returns `alerts` and `pendingDeletions` | new (correction 10) |
| GET /admin/data-requests ; POST /admin/data-requests (email intake) ; GET /admin/data-requests/:id ; POST …/assign, /notes, /verify, /escalate, /counsel, /fulfil, /decline ; GET …/export ; GET /admin/data-requests/deadlines/check ; GET /admin/data-requests/lookup/candidate | new (correction 7, built 18 Sep; platform administrators only) |
| GET /admin/email-suppressions ; POST /admin/email-suppressions ; POST /admin/email-suppressions/:id/release `{reason}` | new (item 5, 18 Sep) |
| POST /c/status/:token/privacy `{kind, details?}` (candidate, verified by the link) | new (correction 7) |
| POST /webhooks/postmark/bounces, /spam, /events (basic auth or `x-webhook-secret`; one receipt per event id) | new (item 5) |
| POST /admin/users/:id/platform-role `{platformRole: "none" \| "its_recruiter" \| "platform_admin"}` | new |
| GET /admin/data-requests ; POST /admin/data-requests/:id/fulfil `{resolution}` | new |
| GET /admin/spend ; PUT /admin/customers/:id/spend-cap `{dailyUsd}` | new (D13) |
| POST /admin/calendar-connections/:id/probe | new |
| POST /admin/break-glass `BreakGlass` → `{grantId, expiresAt}` (403 `mfa_required` until MFA exists) | new (F10) |
| GET /admin/staff-access → grant ledger | new |

## Candidate routes (HTML, token-scoped, rate-limited, CSRF token on forms)

| Method | Path | Status |
|---|---|---|
| GET /careers/:slug ; GET /careers/:slug/jobs/:roleId ; GET/POST …/apply | existing (apply: CSRF, CSP nonce, SMS consent only when enabled) |
| GET /c/status/:token ; POST /c/status/:token/withdraw ; POST /c/status/:token/sms ; POST /c/status/:token/rotate | existing; rotate new |
| GET/POST /c/screen/:token ; POST /c/screen/:token/human | existing |
| GET /c/schedule/:token ; POST /c/schedule/:token `{slotId, timezone, accessibilityNote?}` ; POST /c/schedule/:token/none-work ; GET /c/schedule/:token/confirmed ; GET /c/schedule/:token/ics ; GET/POST /c/schedule/:token/reschedule ; POST /c/schedule/:token/cancel | new |
| GET /privacy ; GET/POST /c/privacy-request ; GET /c/privacy-request/verify/:token | changed / new |

## Webhooks

| Method | Path | Verification | Status |
|---|---|---|---|
| POST /webhooks/postmark/inbound | shared secret header (query string disabled in production, S12) | existing |
| POST /webhooks/postmark/bounces | signature/secret; marks `communications.status = bounced`, emits `message.bounced`, flags the candidate | new |
| POST /webhooks/twilio/inbound | Twilio signature | existing |
| POST /webhooks/calendar/google, /webhooks/calendar/microsoft | channel token (Google) / client state (Microsoft); event changes update `interview_participants.response` and detect deleted events | new (optional in release 1; polling on the reminder timers is the fallback) |

## Schema additions (`packages/contracts/src/api/index.ts` and `domain/interview.ts`)

`RequestInterview`, `RecordDecision`, `InterviewOutcome`, `RescheduleInterview`, `CancelInterview`, `BookOnBehalf`, `InterviewerAvailabilityInput` (`{timezone, windows[{day, start, end}], bufferMinutes, maxPerDay}`), `CalendarConnection` (public shape), `OfferedSlot`, `InterviewSummary`, `InterviewDetail`, `SlotSelection` (`{slotId, timezone, accessibilityNote?}`), `DataRequestCreate`, `DataRequestStatus`, `SessionSummary`, `PlatformRoleChange`, `PlanChange`, `SpendCap`, `PacketDiff`, `NoticeUpdate`.

## Error codes (additions)

`interview_not_schedulable` (stage or status disallows), `no_availability`, `slot_taken` (re-offer), `token_expired`, `reschedule_limit`, `calendar_disconnected`, `reauth_required`, `policy_locked`, `channel_disabled`, `spend_cap_reached`, `staff_scope` (ITS recruiter outside the granted role or candidate), `mfa_required` (break-glass without a verified second factor), `not_assigned` (resolve or release by someone other than the assignee), `claimed` (already held by another recruiter).
