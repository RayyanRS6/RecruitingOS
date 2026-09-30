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
| GET | /auth/sessions | → `SessionSummary[]` (id, createdAt, lastSeenAt, expiresAt, addressHash (a short hash, never the address), userAgent, provider, reauthenticatedAt, current); the person's own open sessions, the current one first | built (A11; routes/auth-sessions.ts) |
| POST | /auth/sessions/:id/revoke | → `{ok, current}`; one of the person's own sessions (404 otherwise); revoking the current one also clears the cookie; audited `session.revoked` | built (A11) |
| POST | /auth/sessions/revoke-all | → `{ok, sessionsEnded}`; "sign out everywhere else": every other session of the person; audited | built (A11) |
| POST | /auth/reauth/start | `{returnTo?, provider?}` (JSON → `{ok, url, provider}`; a posted form → 302 to the provider). Seals a marker (`ros_reauth`, 10 min) and starts the same PKCE flow with a state ending in `-reauth1`; the callback stamps `sessions.reauthenticated_at` on the open session (audited `session.reauthenticated`) and returns to `returnTo?reauth=ok` (`mismatch` for another account, `failed` otherwise); no new session. A policy or notice change needs a session younger than 30 minutes or a confirmation in the last 10 (403 `reauth_required`) | built (A12; replaces the magic-link reauth) |

## Companies and team

| Method | Path | Body → Response | Status |
|---|---|---|---|
| POST | /companies | `CreateCompany` → `Company` | existing |
| GET | /companies/current | → `Company` (+ integrations statuses, plan, usage) | changed: plan and usage |
| PATCH | /companies/current | `UpdateCompany` (strict): `{name?, website?, timezone?, sizeBand?, locations?, settings?: CompanySettingsInput {website, logoUrl, benefitsSummary, careersPage.intro, businessHours {days, start, end} \| null, notices {key: {text} \| null}}}` → `Company` + `changed[]` + `notices[]`. The plan, the pilot term, the allowances, the status and the vertical answer 400 `not_yours_to_change`; unknown keys 400 `invalid_request`. Audited `company.updated` (the changed keys) and `notice.changed` per notice (version = the date); emits `company.updated`. Notice changes need re-authentication (403 `reauth_required`). `company.update`; never staff | changed (A8, J16; routes/company-settings.ts) |
| GET | /companies/current/notices | → every notice with the text in force, `version`, `overridden`, `defaultText`, `defaultVersion` | new (A8) |
| GET | /companies/current/audit | `?actions=a,b&prefix=staff.&exclude=staff.tenant_accessed&from=YYYY-MM-DD&to=&before=<id of the last row>&limit=50` (max 200; the cursor is a row, not a time, so rows written in one transaction are never skipped; 400 for a cursor that is not a row of this list) → `CustomerAuditRow[]` `{id, action, description (plain words), actor {kind, name}, reason, target, at, details}`; only customer-visible actions (recruiter access, team, rules, company, candidate views, outcomes, exports); `events.read`; 403 for staff under a grant | changed (A9; was recruiter access only) |
| GET | /companies/current/audit.csv | same filters, up to 5000 rows, `text/csv`; the download is audited `audit.exported` | new (A9) |
| POST | /companies/current/members/:userId/sign-out | → `{ok, userId, sessionsEnded}`; ends every session of an active member; `members.manage`; 400 `self_sign_out`, 404 for a non-member; audited `session.revoked` | new (A11) |
| GET | /companies/current/members | → `Member[]`: active members only, each with calendar and availability status | changed |
| GET | /companies/current/invitations | → open invitations `{id, email, role, name, expiresAt, invitedBy: {name}}` (never the token) | new (spec 21, area A) |
| POST | /companies/current/members/invite (also /companies/current/invites) | `InviteMember` `{email, role: owner\|admin\|hiring_manager\|interviewer\|hr, name?}` → `{ok, invitation, replaced}`; one email through the outbox with the invitation link; 400 `staff_domain`, 409 `already_member`; an older open invitation for the address is replaced; audited `invitation.sent` | changed |
| POST | /companies/current/invitations/:id/resend, /revoke | → `{ok, invitation}`; `members.manage`; audited `invitation.resent` / `invitation.revoked` | new |
| PATCH | /companies/current/members/:userId | `UpdateMember` `{role?, status?: active\|removed}` → `{userId, role, status, sessionsEnded, calendarDeletionQueued, interviewsFlagged}`; 404 unless an active member, 409 `self_change`, 409 `last_owner`, 403 `owner_only`; either change ends the person's sessions; removal disconnects their calendar (credential deletion queued), flags interviews still ahead and notifies the owners, emits `member.removed` | changed |
| PUT | /companies/current/notices | superseded: notices are reworded through `PATCH /companies/current` `settings.notices` (versioned, audited, re-authentication required) | dropped |

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
| GET | /roles/:id | → `RoleDetail` (+ `proposedPacket`: a version proposed while the role runs, beside `currentPacket`, never in its place; `packetApproval: {pending, latest}` where `pending` carries the version, the rationale, `requiredUserIds`, `decisionMaker`, `expiresAt`, `editWhileOpen` and `viewer: {mayDecide, reason}` (the self-approval and named-decider rules applied to the signed-in person) and `latest` is the most recent decided request with its `decisionNote`, `decidedBy` and status (`rejected`, `expired`, `approved`); `decisionMaker`: the packet's named decision maker matched to an active owner, admin or hiring manager) | changed (30 Sep 2026) |
| GET | /roles/:id/packets | → `RolePacketVersion[]` (pay figures omitted for interviewers) | existing |
| GET | /roles/:id/packets/:version/diff?against= | → `PacketDiff` (section-level changes) | new |
| POST | /roles/:id/packets | `CreatePacketVersion` → 201 version + `outcome`: `approved_current` (an approver's edit to an open role: current at once, any waiting version withdrawn), `proposed_pending_approval` (an edit by a `packet.edit` holder without `role.approve` on an open role, or any edit to a pending role: a new approval request and `role_approval` run; the older request is cancelled and its run marked cancelled first; the open role keeps its current version), `proposed` (a draft, paused or closed role: kept with the role) + `approvalRunId` | changed (30 Sep 2026) |
| POST | /roles/:id/approve | `ApproveRole` → `{ok, approvalRequestId}`; 409 `self_approval` for the person who started the role or wrote the version, unless they are the company's only owner; 403 `named_decider` when the request is reserved for the named decision maker (an owner may still decide); 403 `wrong_role` otherwise; a version proposed while the role was open becomes current without touching the role's status | changed (30 Sep 2026) |
| POST | /roles/:id/request-approval | `RequestRoleApproval` = `{version?}` → 201 `{ok, version, workflowRunId}`: a sent-back or expired draft asks again for its latest version (or the named one); 409 `not_a_draft` | new (30 Sep 2026) |
| GET | /roles/:id/interview-plan | → `{version, status, rounds: [{key, title, purpose, durationMinutes, format, interviewerRoles, interviewers: [{userId, name, email, role, schedulable}]}], team: [...]}` (names and scheduling readiness from the members list) | new (30 Sep 2026) |
| PATCH | /roles/:id/interview-plan | `UpdateInterviewPlan` = `{rounds: [{key, interviewerUserIds[]}]}` → the same view + `outcome`: a new packet version (`human_edit`, "Interviewers assigned") under the rules of `POST /roles/:id/packets`; 400 `unknown_round`, `unknown_member`; permission `packet.edit` | new (30 Sep 2026) |
| GET | /roles/:id/timeline | → the role's events newest first (subject role, subject `role_packet` of the role, or `payload.roleId`; at most 200); permission `events.read` | new (30 Sep 2026) |
| POST | /roles/:id/pause, /resume | `RoleStatusChange` → role; `role.manage`; resume re-runs `publish_role` and adds the email applications held while the role was paused | existing |
| POST | /roles/:id/outcome | `RecordRoleOutcome` `{outcome: filled \| filled_outside_platform \| role_cancelled \| no_hire, confirm: true, reason?}` → `{ok, outcomeId, role, movedToTalentPool, statement}`; `outcome.record`. Closing a role is recording its outcome (the unconfirmed `/close` route was removed on 21 September); every posting closes and a board that was up is marked for removal by hand | changed |
| GET | /roles/:id/applications | `OwnerGroupQuery` → `ApplicationSummary[]`; `application.read`. Each row carries the evidence view (`packages/core/src/evidence.ts`): `needsCloserLook` with its reason, the top strength and top concern with their evidence, the open questions, `assessmentUnavailable`, `resumeUnreadable`, `confidenceReasons` | changed (30 Sep 2026) |
| GET | /roles/:id/report | → `RoleReport`: applicants by source and by day, stage counts, time in stage, interviews, pending decisions, the assistant's suggestions against the person's decisions, overrides, recruiter help, messages, outcomes; `role.read` and `application.read` (interviewers refused); an ITS recruiter with a one-candidate grant sees that candidate only (`apps/api/src/routes/reports.ts`, `apps/api/src/services/role-report.ts`) | new (30 Sep 2026) |
| GET | /roles/:id/report.csv, /roles/:id/report/summary.csv | → `text/csv` (the applicant list; the figures); same permissions; each download audited `report.exported` | new (30 Sep 2026) |
| GET | /roles/:id/compare?ids=a,b | → `{role, mustHaves, competencies, candidates[], max: 5, reminder}`: up to five applications side by side, the screen's finding winning over the résumé's; the columns in the order asked, nothing ranked or scored; each candidate shown audited `candidate.viewed` ("comparison view"); 400 `too_many` above five; `application.read` (`apps/api/src/routes/compare.ts`) | new (30 Sep 2026) |
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
| GET | /applications/:id | → `ApplicationDetail` (+ `interviews[]`, inbound replies among the communications); `application.read`, or an interviewer who is a participant on one of its interviews, who also gets the interviewer brief (pay redacted for roles without `compensation.read`); never the status or reply token | changed (30 Sep 2026) |
| POST | /applications/:id/actions | `ApplicationAction` with actions `invite_screen`, `ask_in_screen`, `advance_to_interview`, `reject`, `hold`, `move_to_talent_pool`, `override_eligibility`, `review_anyway` → `{ok, stage, ...}`; `application.act` (`reject` also `application.reject`). `ask_in_screen` is `invite_screen` with `focus: "unknowns"`: the screen opens with the résumé assessment's open questions before the packet's own (`packages/agents/src/screen-focus.ts`); it waits for a person's click and never starts on its own | changed: `advance_to_interview` now only moves to `interview_recommended`; scheduling starts through `/interviews`; `ask_in_screen` new (30 Sep 2026) |
| GET | /applications/:id/messages/preview | → `{to, candidateFirstName, fromName, footer, repliesComeBack, policyLevel, needsApproval}`; `application.act` (`apps/api/src/routes/messages.ts`) | new (30 Sep 2026) |
| POST | /applications/:id/messages | `SendCandidateMessage` `{subject?, text}` → 201 `{status: "queued", ...}`, or 202 `{status: "pending_approval", ...}` when the policy `message.send_freeform` is at "approval" or "only a person" and the sender holds none of its approver roles (default owner and admin); `application.act`. The person's own words under "<company> hiring team", their name in the footer, no AI disclosure line; through the outbox; audited `message.sent` or `message.approval_requested` (never the text). Approvers decide through `POST /approvals/:id/decide` from the brief or the sheet | new (30 Sep 2026) |
| POST | /applications/:id/assessments/:assessmentId/flag | `FlagAssessment` → `{ok}` | existing |
| POST | /applications/:id/interviews | `RequestInterview` = `{roundKey, interviewerUserIds[], linkSource: "calendar" \| "pasted", meetingUrl?, window?: {fromDate, toDate}, note?}` → `InterviewSummary` (creates `proposed`, resolves any pending `interview.request` approval as the human's decision, starts `schedule_interview`) | new; permission `interview.request`; policy `interview.request` |
| POST | /applications/:id/decision | `RecordDecision` = `{decision: "next_round" \| "finalist" \| "hired" \| "not_moving_forward", reason?: RejectReason, note?}` → `{ok, stage, nextRoundKey, dispositionSent?}` (human-only; recorded on the newest interview that is over and still undecided; `next_round` returns the next `roundKey` and the candidate sheet opens the interview approval with it; `not_moving_forward` sends the respectful message through the `disposition.send` gate and the outbox, `dispositionSent` says whether it went) | new (D10); permission `interview.decide` |

## Interviews and calendars

| Method | Path | Body → Response | Status |
|---|---|---|---|
| GET | /interviews | `?from&to&status&mine=1` → `InterviewSummary[]` | new |
| GET | /interviews/:id | → `InterviewDetail` (slots offered, participants with availability source, calendar refs without secrets, timeline; compensation omitted for interviewers) | new |
| POST | /interviews/:id/reschedule | `{reason?, window?}` → `InterviewSummary` (cancels events, re-offers) | new; `interview.manage` |
| POST | /interviews/:id/cancel | `{reason}` → `InterviewSummary` | new; `interview.manage` |
| POST | /interviews/:id/outcome | `{outcome: "happened" \| "no_show_candidate" \| "no_show_interviewer"}` → `InterviewSummary` (either answer ends the interview: a candidate still at `interview_scheduled` moves to `interview_complete` at once, by the caller's role, which every membership role may do for this step; on that path the route also emits `interview.completed` and sends the "How did it go with <name>?" notification with the `?open=` link, so the closing timer has nothing left to do) | new; `interview.manage`, or a participant of that interview (any role, HR included) |
| POST | /interviews/:id/book-on-behalf | `{slotId}` → `InterviewSummary` (owner picks for the candidate after a call; audited) | new; `interview.manage` |
| GET | /me/calendar | → `{connection (public shape, no secrets) \| null, availability \| null, providers[{key,status}]}` | built 18 Sep |
| GET | /integrations/calendar/:provider/connect | → 302 to the provider consent screen (state bound to the session) | new; `calendar.connect` |
| GET | /integrations/calendar/:provider/callback | `?code&state` → 302 to `/setup?calendar=connected` (stores encrypted tokens; emits `integration.connected`) | new |
| POST | /integrations/calendar/:provider/disconnect | → `{ok}` (deletes credentials; audited) | new |
| PUT | /me/availability | `InterviewerAvailabilityInput` → `InterviewerAvailability` (signals `availability.updated` for waiting runs) | new |
| GET | /integrations | → adapter statuses (email, sms, calendar providers, boards, comp, storage) | existing |

## Approvals, escalations, events, notifications, policies

| Method | Path | Body → Response | Status |
|---|---|---|---|
| GET | /approvals?status= ; POST /approvals/:id/decide | `DecideApproval` | existing (deciding `interview.request` from a card calls the same path as `/applications/:id/interviews` with the proposal's interviewers; a `role_packet.approve` request follows the same rules as `POST /roles/:id/approve`: `role.approve`, 409 `self_approval`, 403 `named_decider`; a request carrying `requiredUserIds` in its proposal may be decided only by those members or an owner; the brief's generic decision cards post `{decision: "approve"}` or `{decision: "reject"}`) |
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
| GET /admin/customers/:id/report → the role report's figures over every role of one customer (the console's Customers tab, "Report") | new (30 Sep 2026; `apps/api/src/routes/admin.ts`) |
| POST /admin/observability/test-error → a deliberate error carrying a token-shaped value and an address, for the Sentry scrubbing proof; audited `admin.bypass` with the reason; exists in a development or test process and in a production build whose `SENTRY_ENVIRONMENT` is exactly `staging`, 404 everywhere else | new (30 Sep 2026; `apps/api/src/routes/observability.ts`) |
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
| GET /careers/:slug ; GET /careers/:slug/jobs/:roleId ; GET/POST …/apply ; POST …/upload-intent | changed (30 Sep 2026): every URL is built from `JOBS_BASE_URL`; the apply form carries the transparency block and a required, unchecked acknowledgment (`ApplyRequest.acknowledged` = `yes`, recorded as `answers.acknowledgment {at, noticeVersions, ip}`); the SMS box renders only while `SMS_ENABLED`; apply, the form and upload-intent answer 404 unless the role is open and accepting applications, while the job page stays up and says so; the careers index lists a role that is not accepting ("Not taking new applications right now") and drops a paused one; JobPosting data carries `validThrough`, schema.org employment types, the employer's website and logo; CSRF and the CSP nonce as before |
| GET /c/status/:token ; POST /c/status/:token/withdraw ; POST /c/status/:token/sms ; POST /c/status/:token/privacy | existing; once an interview is booked the status page says what to prepare, from the round's purpose |
| GET/POST /c/screen/:token ; POST /c/screen/:token/human | existing |
| GET /c/schedule/:token ; POST /c/schedule/:token `{slotId, timezone, accessibilityNote?}` ; POST /c/schedule/:token/none-work ; GET /c/schedule/:token/confirmed ; GET /c/schedule/:token/ics ; POST /c/schedule/:token/reschedule ; POST /c/schedule/:token/cancel `CandidateCancel` `{confirm: "yes", reason?}` (the optional reason is recorded on the interview; `apps/api/src/candidate-cancel.test.ts`) | new |
| GET /privacy (links to the form) ; GET/POST /c/privacy-request (`PrivacyRequestForm` `{email, kind: access\|correct\|delete, details?, company? (slug), website (honeypot)}`; rate-limited per address and per mailbox (the email normalized); records nothing: the request itself travels sealed in a single-use link (24 h) emailed directly, not through the outbox, one per employer holding the address; an unknown address is told only in its own mailbox) ; GET /c/privacy-request/verify/:token (shows the kind, the employer, the reference and one button; changes nothing, so a mail scanner confirms nothing) ; POST /c/privacy-request/verify `{token}` (rate-limited per link and per address; creates the `data_requests` row as `channel: email_form`, `verified_by_link`, `in_progress`, and sends the acknowledgment; a second link for the same request within a day lands on the first record with `data_request.replayed`; a reused, forged or expired link answers 410; the token is masked in logs, error reports and security events like the other candidate links) | built (D13; pages/privacy-request.tsx) |

## Public job surfaces (no session; rate-limited as candidate pages; docs/spec/20 items 5 to 7)

| Method | Path | Status |
|---|---|---|
| GET /a/:token | a tracked application link (`apps/api/src/pages/links.tsx`): looks the token up through the platform role, counts the visit, seals `{linkId, source, sourceDetail, roleId}` in the httpOnly `ros_src` cookie (30 days, host-only) and redirects to the apply page, or to the job page when the role is paused or not accepting; an unknown, malformed or disabled token answers a plain 404 and counts nothing. The apply page resolves the cookie into `source`, `source_detail` and `link_id` and clears it; the token never reaches a candidate-facing record | new (30 Sep 2026) |
| GET /sitemap.xml ; GET /robots.txt ; GET /feeds/jobs.xml ; GET /feeds/jobs.json ; GET /feeds/linkedin.xml | `apps/api/src/pages/public-feeds.ts`: only open roles that accept applications, every URL from `JOBS_BASE_URL`, the client company named as the employer, the publisher and canonical URLs, public job data only; each document rebuilt at most once every five minutes per process; fields and cadence in `docs/15-integrations.md` | new (30 Sep 2026; `linkedin.xml` changed) |
| GET /healthz | the app: `{ok, db, ai, worker}`, where `worker` is `"inline"` in development or `{lastSeenAt, queueDepth, healthy}` from the newest `worker_heartbeats` row (`healthy` false after ten minutes); 503 without the database. The worker serves its own `GET /healthz` on `PORT` (default 8080): 200 while it polls, 503 once the last poll is older than three poll intervals plus thirty seconds; Railway's health check (`railway.json`) | changed (30 Sep 2026) |

## Webhooks

| Method | Path | Verification | Status |
|---|---|---|---|
| POST /webhooks/postmark/inbound | basic auth or the `x-inbound-secret` header (never the query string, S12). A recipient `reply-<token>@<EMAIL_INTAKE_DOMAIN>` is a candidate's reply (migration 0023): recorded on the application as an inbound communication, `message.received`, the team told with a link to the sheet; a first line `HUMAN` pauses an open screen, opens a recruiter request and answers with the response-time sentence; an unknown token is logged `unmatched` and never answered. Any other recipient is an email-in application; while the role is paused or not accepting it is held (`inbound_emails.status = held`, the owner told) and added, oldest first, when the role reopens (`docs/runbooks/candidate-replies.md`) | changed (30 Sep 2026) |
| POST /webhooks/postmark/bounces | signature/secret; marks `communications.status = bounced`, emits `message.bounced`, flags the candidate | new |
| POST /webhooks/postmark/events (the same handler as /bounces and /spam) | basic auth or `x-webhook-secret`; one receipt per event id; a `SubscriptionChange` is a suppression to honour (or a reactivation to acknowledge), never a bounce to retry (`apps/api/src/services/email-subscriptions.ts`) | changed (30 Sep 2026) |
| POST /webhooks/twilio/inbound | Twilio signature | existing |
| POST /webhooks/calendar/google, /webhooks/calendar/microsoft | channel token (Google) / client state (Microsoft); event changes update `interview_participants.response` and detect deleted events | new (optional in release 1; polling on the reminder timers is the fallback) |

## Schema additions (`packages/contracts/src/api/index.ts` and `domain/interview.ts`)

`RequestInterview`, `RecordDecision`, `InterviewOutcome`, `RescheduleInterview`, `CancelInterview`, `BookOnBehalf`, `InterviewerAvailabilityInput` (`{timezone, windows[{day, start, end}], bufferMinutes, maxPerDay}`), `CalendarConnection` (public shape), `OfferedSlot`, `InterviewSummary`, `InterviewDetail`, `SlotSelection` (`{slotId, timezone, accessibilityNote?}`), `DataRequestCreate`, `DataRequestStatus`, `SessionSummary`, `PlatformRoleChange`, `PlanChange`, `SpendCap`, `PacketDiff`, `NoticeUpdate`.

## Error codes (additions)

`interview_not_schedulable` (stage or status disallows), `no_availability`, `slot_taken` (re-offer), `token_expired`, `reschedule_limit`, `calendar_disconnected`, `reauth_required`, `policy_locked`, `channel_disabled`, `spend_cap_reached`, `staff_scope` (ITS recruiter outside the granted role or candidate), `mfa_required` (break-glass without a verified second factor), `not_assigned` (resolve or release by someone other than the assignee), `claimed` (already held by another recruiter).

Added 30 September 2026: `posting_transition` (409; a move the nine-state table refuses, both states named), `url_required`, `not_paused`, `not_required`, `nothing_to_retry`, `already_disabled`, `link_in_use`, `role_closed`, `self_approval` (409), `named_decider` and `wrong_role` (403), `not_a_draft`, `unknown_round`, `unknown_member`, `staff_domain`, `already_member`, `self_change`, `last_owner`, `owner_only`, `not_yours_to_change`, `self_sign_out`, `too_many` (compare), `no_email` and `incomplete` (a message that cannot be sent).
