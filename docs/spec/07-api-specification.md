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
| GET | /auth/invite?token= | the team invitation page: names the company and role, offers Google and Microsoft (and the email link only when `MAGIC_LINK_ENABLED`), parks the token hash in the sealed `ros_invite` cookie (30 min). Every sign-in path (callback, /auth/session, the staff second-factor step, the email-link consume) accepts the invitation for the invited address, opens the session in that company, emits `member.joined`, audits `invitation.accepted`; a different address → `/login?error=invite_email_mismatch` (cookie kept), expired or withdrawn → `invite_expired`. Any sign-in with the invited address accepts its open invitations even without the cookie (never ITS staff) | new (spec 21, area A) |
| POST | /auth/invite/email | form `{token}` → HTML; emails a sign-in link to the invited address only; 410 when email links are off | new |
| POST | /auth/invite/forget | → `{ok}`; drops the carried invitation | new |
| POST | /auth/magic-link/consume | `MagicLinkConsume` → `{ok, userId, activeCompanyId}` | existing |
| POST | /auth/logout | → `{ok}` | existing |
| GET | /auth/me | → `MeResponse` (+ `ai.provider`, `auth {provider, aal, mfaVerifiedAt}`); active memberships only | changed |
| POST | /auth/switch | `{companyId}` → `{ok}` | existing; ITS staff only for companies with an open escalation (D11) |
| GET | /auth/sessions | → `Session[]` (id, createdAt, lastSeenAt, ip, userAgent, current) | new |
| POST | /auth/sessions/:id/revoke and /auth/sessions/revoke-all | → `{ok}` | new |
| POST | /auth/reauth | `{token}` (fresh magic link) → `{ok, reauthUntil}` (10 min) | new; required before policy changes (D12) |

## Companies and team

| Method | Path | Body → Response | Status |
|---|---|---|---|
| POST | /companies | `CreateCompany` → `Company` | existing |
| GET / PATCH | /companies/current | `UpdateCompany` → `Company` (+ integrations statuses, plan, usage) | changed: plan and usage |
| GET | /companies/current/members | → `Member[]`: active members only, each with calendar and availability status | changed |
| GET | /companies/current/invitations | → open invitations `{id, email, role, name, expiresAt, invitedBy: {name}}` (never the token) | new (spec 21, area A) |
| POST | /companies/current/members/invite (also /companies/current/invites) | `InviteMember` `{email, role: owner\|admin\|hiring_manager\|interviewer\|hr, name?}` → `{ok, invitation, replaced}`; one email through the outbox with the invitation link; 400 `staff_domain`, 409 `already_member`; an older open invitation for the address is replaced; audited `invitation.sent` | changed |
| POST | /companies/current/invitations/:id/resend, /revoke | → `{ok, invitation}`; `members.manage`; audited `invitation.resent` / `invitation.revoked` | new |
| PATCH | /companies/current/members/:userId | `UpdateMember` `{role?, status?: active\|removed}` → `{userId, role, status, sessionsEnded, calendarDeletionQueued, interviewsFlagged}`; 404 unless an active member, 409 `self_change`, 409 `last_owner`, 403 `owner_only`; either change ends the person's sessions; removal disconnects their calendar (credential deletion queued), flags interviews still ahead and notifies the owners, emits `member.removed` | changed |
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
| GET | /roles/:id/applications | `OwnerGroupQuery` → `ApplicationSummary[]` | existing |
| GET | /roles/:id/interviews | → `InterviewSummary[]` | new |

### Postings, tracked links, volume (docs/spec/20 section 2; `apps/api/src/routes/postings.ts`)

Reading needs `role.read`; every POST needs `role.manage` (interviewers get 403), is audited (`posting.changed`, `application_link.changed`, `role.applications_toggled`) and moves the posting through the nine-state table in `packages/core/src/postings.ts`; a move the table refuses answers 409 `posting_transition` with both states named. `channel` is one of `careers_page`, `google_jobs`, `email_in`, `linkedin_basic`, `indeed`, `ziprecruiter`. `GET /roles/:id` also carries `boardsStillUp` and the accepting-applications fields.

| Method | Path | Body → Response | Status |
|---|---|---|---|
| GET | /roles/:id/postings | → `{role: {id, title, status, acceptingApplications, applicationsClosedAt, applicationsClosedReason, volumeAlertPerDay}, urls: {careers, job, apply}, emailIn: {address, connected, status, error}, postings: PostingView[], links: ApplicationLink[], boardsStillUp: channel[]}`; a `PostingView` is the row (nine-state fields, `steps`, `closureRequired`, `closureConfirmedAt`) plus `name`, `stateLabel`, `isBoard`, `link` (the board's active tracked link, with `url`), `package` (`{text, fields}`, boards only) and `stillUp` | new |
| GET | /roles/:id/postings/:channel/package | → `{text, fields}` (title, employer, location, employment type, pay, description, screening questions, the board's tracked apply link, the intake address while email-in is connected, the job page URL); 409 for `email_in` | new |
| POST | /roles/:id/postings/:channel/url | `RecordPostingUrl` = `{url}` (https only; boards only) → `PostingView` at `posted_manually`; queues `posting.verify` (the worker fetches the page, checks the title, marks `live_verified` or, after three checks, `failed`); a corrected address while a check is pending keeps the state and restarts the checks; any earlier verification (`verifiedAt/By`, the note) is cleared, since it was of a different address | new |
| POST | /roles/:id/postings/:channel/verify | `VerifyPosting` = `{note}` (required) → `PostingView` at `live_verified`, `verifiedBy` = the person; a `failed` posting passes through `posted_manually` (or `submitted_integration` for Google) first; 409 `url_required` for a board with no recorded address; Google for Jobs is marked verified here ("checked in Search Console"). A check still queued when the person confirms leaves their word alone; only `retry` re-checks a person-verified posting | new |
| POST | /roles/:id/postings/:channel/pause | `PostingReason` = `{reason?}` → `PostingView` at `paused` | new |
| POST | /roles/:id/postings/:channel/resume | `{reason?}` → `PostingView` back where it was: `live_verified` when it had been verified, `posted_manually` with a fresh check when an address was recorded, `submitted_integration` for Google, otherwise `ready_to_post`; 409 `not_paused` | new |
| POST | /roles/:id/postings/:channel/close | `{reason?}` → `PostingView` at `closed`; a board that was up gets `closureRequired` and `posting.closure_required` | new |
| POST | /roles/:id/postings/:channel/closure-confirm | → `PostingView` with `closureConfirmedAt/By`; emits `posting.closure_confirmed`; ticking twice changes nothing; 409 `not_required` when nothing was up | new |
| POST | /roles/:id/postings/:channel/retry | → `{ok, action: "check_again" \| "ready_to_post" \| "republish", posting}`: a board or the careers page with a recorded address is checked again (a requested check, so it also re-checks a posting a person verified by hand; a failed board starts from nothing); a failed board without an address goes back to `ready_to_post`; a failed native channel (email-in, Google) is prepared again by `publish_role` (role must be open); 409 `nothing_to_retry` otherwise | moved from roles.ts; changed |
| GET | /roles/:id/links | → `ApplicationLink[]` (`{id, url, source, sourceLabel, sourceDetail, label, postingId, visits, lastVisitedAt, createdAt, disabledAt}`; `url` is `JOBS_BASE_URL/a/<token>`) | new |
| POST | /roles/:id/links | `CreateApplicationLink` = `{source: referral \| direct \| other, label, sourceDetail?}` → 201 `ApplicationLink`; 409 when the role is closed | new |
| POST | /roles/:id/links/:linkId/disable | → `ApplicationLink` with `disabledAt` (the public redirect refuses it from then on); 409 `already_disabled`; 409 `link_in_use` for a board's own link while that posting is up | new |
| POST | /roles/:id/applications/accepting | `SetAcceptingApplications` = `{accepting, reason?}` → `{ok, changed, role: {id, acceptingApplications, applicationsClosedAt, applicationsClosedReason}}`; emits `role.applications_closed` / `role.applications_reopened`, notifies the team (`applications.closed` / `applications.reopened`); 409 `role_closed`; the job page stays up and says applications are closed, nobody is rejected | new |
| GET | /roles/:id/volume | → `{from, to, timeZone, days: [{day, total, bySource}] (14, oldest first), totals: {total, bySource}, sources: [{source, label, total}], threshold, yesterday: {day, total}, today: {day, total}, acceptingApplications, applicationsClosedAt, applicationsClosedReason}`; days are calendar days in `companies.timezone` (`timeZone` says which) | new |

The daily `stuck_role_detector` run counts yesterday's applications per open role, "yesterday" being a calendar day in the company's time zone (the same cut as `/volume`, through `localDays` in `@ros/workflows`); above `roles.volume_alert_per_day` (null = 100) it notifies owners and admins once for that day (`volume.high`, linking to `/roles/:id?tab=posting`) and emits `role.volume_high` `{day, count, threshold}`. It never touches an application. The brief's "Still posted on ..." card names boards in channel order and says whether the role is closed or only that board's posting was.

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
