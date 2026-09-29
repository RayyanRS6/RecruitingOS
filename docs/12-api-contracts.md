# 12. API contracts

All routes are under `/api/v1`, JSON in and out, validated with the Zod schemas in `packages/contracts/src/api/*`. Errors are `{error: {code, message, details?}}` with HTTP status. Authentication is a session cookie; platform-admin routes additionally require `platform_role`. Tenancy is derived from the session's active membership (`X-Company-Id` selects among memberships). Every mutating route emits the events listed in doc 04. Candidate-facing routes are token-scoped and live under `/c/*` (pages) and `/api/c/*` (JSON).

The schemas are the source of truth; this document is the map.

## Auth
| Method | Path | Body → Response | Notes |
|---|---|---|---|
| POST | `/auth/magic-link` | `{email}` → `{ok}` | Rate-limited; always 200 |
| POST | `/auth/magic-link/consume` | `{token}` → `{user, memberships}` | Sets session cookie |
| GET | `/auth/consume?token=` | → 302 to the web app | The link in the email. Sets the cookie on a top-level navigation, then redirects to `/` or `/setup/company`; an invalid or used token redirects to `/login?error=expired` |
| GET | `/auth/invite?token=` | → HTML | The team invitation link. Signs nobody in: names the company and role, offers "Continue with Google" / "Continue with Microsoft" (and an emailed link only when `MAGIC_LINK_ENABLED`), and parks the invitation's token hash in the sealed `ros_invite` cookie (30 minutes). Every sign-in path then accepts the invitation when the verified address is the invited one (membership with the invited role, session opened in that company, `member.joined`, audit `invitation.accepted`); a different address is refused with `/login?error=invite_email_mismatch` and the cookie kept; an expired or withdrawn invitation with `invite_expired`. Without the cookie, any sign-in with the invited address accepts its open invitations too (never for ITS staff accounts) |
| POST | `/auth/invite/email` | form `{token}` → HTML | "Email me a sign-in link" from the invitation page; the link goes to the invited address only; 410 when email links are off |
| POST | `/auth/invite/forget` | → `{ok}` | Drops the carried invitation so the person can sign in as themselves |
| POST | `/auth/logout` | → `{ok}` | |
| GET | `/auth/me` | → `{user, memberships, activeCompanyId}` | Active memberships only |

## Companies and users
| POST | `/companies` | `CreateCompany` → `Company` | Creates the owner membership; seeds default policies and entitlements (trial) |
| GET/PATCH | `/companies/current` | → `Company` | Settings include locations, notices, retention |
| GET | `/companies/current/members` | → `Member[]` | Active members only, each with calendar and availability status |
| GET | `/companies/current/invitations` | → `Invitation[]` | Open invitations: `{id, email, role, name, expiresAt, invitedBy: {name}}`; never the token |
| POST | `/companies/current/members/invite` (also `/companies/current/invites`) | `InviteMember` `{email, role, name?}` → `{ok, invitation, replaced}` (dev: `devLink`) | `members.manage`. Creates an `invitations` row and queues one email through the outbox with `/api/v1/auth/invite?token=`; 400 `staff_domain` for an ITS address; 409 `already_member`; an older open invitation for the address is replaced; audited `invitation.sent` |
| POST | `/companies/current/invitations/:id/resend` | → `{ok, invitation}` (dev: `devLink`) | New link, seven more days, email again; the old link stops working; audited `invitation.resent` |
| POST | `/companies/current/invitations/:id/revoke` | → `{ok, invitation}` | The link stops working; audited `invitation.revoked` |
| PATCH | `/companies/current/members/:userId` | `UpdateMember` `{role?, status?: 'active'|'removed'}` → `{userId, role, status, sessionsEnded, calendarDeletionQueued, interviewsFlagged}` | `members.manage`. 404 unless the target is an active member; 409 `self_change`; 409 `last_owner`; 403 `owner_only` (only an owner grants or takes the owner role, including by removal). Either change ends the person's sessions. Removal also disconnects their calendar (credential deletion queued as `/integrations/calendar/:provider/disconnect` does), flags the interviews still ahead that counted on them and tells the owners; emits `member.removed`; audited |

## Intake and roles
| POST | `/intake/sessions` | `{initialMessage?}` → `IntakeSession` | Starts `intake_to_packet` |
| POST | `/intake/sessions/:id/messages` | `{message}` → `IntakeSession` (with assistant reply) | Resumes the workflow |
| POST | `/intake/sessions/:id/compile` | → `{role, packet, approvalRequest}` | Forces compile with listed assumptions |
| GET | `/intake/sessions/current` | → `{session: IntakeSession \| null}` | The open conversation, so a reload resumes it |
| POST | `/intake/sessions/:id/abandon` | → `IntakeSession` | "Start over"; the record is kept, the session no longer resumes; emits `intake.abandoned` |
| GET | `/roles` | `?status` → `RoleSummary[]` | Pipeline counts by stage |
| GET | `/roles/:id` | → `RoleDetail` | Current packet, postings, counts, what needs you |
| GET | `/roles/:id/packets` | → `RolePacketVersion[]` | All versions |
| GET | `/roles/:id/packets/:version` | → `RolePacketVersion` | |
| POST | `/roles/:id/packets` | `{packet, changeSummary}` → `RolePacketVersion` | Creates a new version (human edit) |
| POST | `/roles/:id/approve` | `{version, note?}` → `RoleDetail` | Resolves the approval; opens the role |
| POST | `/roles/:id/pause` / `resume` / `close` | `{reason?}` → `RoleDetail` | |

## Postings
| GET | `/roles/:id/postings` | → `Posting[]` | Status per channel with instructions for pending channels |
| POST | `/roles/:id/postings/:channel/retry` | → `Posting` | |
| GET | `/feeds/linkedin.xml` (public, signed) | → XML | Basic Jobs feed |

## Candidates and applications
| GET | `/roles/:id/applications` | `?stage&group` → `ApplicationSummary[]` | Owner grouping: waiting_on_you, in_process, not_moving_forward |
| GET | `/applications/:id` | → `ApplicationDetail` | Candidate, resume link, assessments, screens, interviews, communications, timeline |
| POST | `/applications/:id/actions` | `{action: 'invite_screen'|'advance_to_interview'|'reject'|'hold'|'move_to_talent_pool'|'override_eligibility', reason?, note?}` → `ApplicationDetail` | Policy-checked; rejections require a reason code; audited |
| POST | `/applications` | `CreateApplicationManual` → `ApplicationDetail` | Recruiter manual add or import |
| GET | `/candidates` | `?q` → `CandidateSummary[]` | Recruiter search |
| GET | `/candidates/:id` | → `CandidateDetail` | |
| POST | `/candidates/:id/merge` | `{intoCandidateId}` → `CandidateDetail` | Audited |
| POST | `/candidates/:id/data-request` | `{kind: 'access'|'delete'|'correct'}` | Compliance queue |

## Screening (Slice 2)
| Method | Path | Body → Response | Notes |
|---|---|---|---|
| POST | `/applications/:id/actions` | `{action: 'invite_screen', channel?: 'web'\|'sms', note?}` → `{ok, workflowRunId}` | Starts the `screen` workflow; 409 when a screen is already open or the stage does not allow it; approves a pending `application.invite_screen` request if one exists |
| POST | `/applications/:id/actions` | `{action: 'advance_to_interview', note?}` → `{ok, stage}` | Human decision: stage `interview_recommended`; scheduling arrives with Slice 3 |
| GET | `/applications/:id` | → `ApplicationDetail` now includes `screens[]` (channel, status, transcript, answers, progress) and `pendingApprovals[]` | |
| GET | `/c/screen/:token` (candidate, HTML) | | The web chat: transcript, one question at a time, progress, "Talk to a person"; generates the opening message on first open |
| POST | `/c/screen/:token` (candidate, form) | `message` → 302 back to the page | One turn; `?error=trouble` when the assistant failed and the candidate should resend |
| POST | `/c/screen/:token/human` (candidate, form) | → 302 | Hand-off to a person: `screen.human_requested`, escalation `candidate_issue` (4h SLA) |
| POST | `/webhooks/twilio/inbound` (Twilio, form) | `From, To, Body, MessageSid` → TwiML | Signature-verified when `TWILIO_AUTH_TOKEN` is set; STOP/START/HELP honored; otherwise routed to the candidate's open screen |

## Notifications (Slice 2)
| Method | Path | Body → Response | Notes |
|---|---|---|---|
| GET | `/notifications?unread=1` | → `Notification[]` | "Do it and tell me": what auto_notify actions and recommendations did, per person |
| POST | `/notifications/read` | `{ids[]}` → `{ok, marked}` | |

## Interviews and scheduling
| POST | `/applications/:id/interviews` | `{roundKeys[]}` → `Interview[]` | Starts scheduling |
| GET | `/interviews?from&to` | → `Interview[]` | Calendar view |
| GET | `/interviews/:id` | → `InterviewDetail` | Brief, participants, recording state |
| POST | `/interviews/:id/reschedule` / `cancel` | | |
| GET/PUT | `/interviews/:id/scorecards/mine` | `ScorecardInput` → `Scorecard` | Draft then submit |
| GET | `/roles/:id/debrief` | → `DebriefSummary` | When ready |
| POST | `/roles/:id/debrief/decision` | `{finalistApplicationIds[], note}` | Human decision |
| POST | `/api/c/interviews/:token/select-slot` (candidate) | `{slotId}` | |

## Offers
| POST | `/applications/:id/offers` | `OfferTermsInput` → `Offer` | Draft (agent-assisted) |
| POST | `/offers/:id/approve` / `send` / `revise` / `rescind` | | Policy-gated |
| GET | `/offers/:id` | → `OfferDetail` | Negotiation log, e-sign state |
| POST | `/api/c/offers/:token/respond` (candidate) | `{action: 'accept'|'decline'|'counter', terms?, reason?}` | |

## Onboarding
| GET | `/applications/:id/onboarding` | → `Onboarding` | |
| POST | `/onboardings/:id/tasks/:key/complete` | | |
| POST | `/onboardings/:id/handoff` | `{provider}` | Triggers HRIS creation or packet |
| POST | `/onboardings/:id/start-confirmed` | `{confirmed: boolean, reason?}` | |
| POST | `/onboardings/:id/checkin` | `{milestone, outcome, rating?, notes?}` | |

## Policies, approvals, escalations
| GET/PUT | `/policies` | `?roleId` → `Policy[]` | Company defaults and role overrides |
| GET | `/approvals` | `?status` → `ApprovalRequest[]` | Decisions needed |
| POST | `/approvals/:id/decide` | `{decision: 'approve'|'reject', note?, edits?}` | Resumes the workflow |
| POST | `/escalations` | `{kind, roleId?, applicationId?, question}` → `RecruiterEscalation` | Ask a recruiter |
| GET | `/escalations` | (recruiter queue) → `RecruiterEscalation[]` | |
| POST | `/escalations/:id/claim` / `resolve` / `takeover` / `handback` | | Recruiter |

## Conversation and brief
| GET | `/brief` | `?date` → `Brief` | |
| POST | `/conversation/messages` | `{message}` → `{reply, proposedActions[]}` | Owner conversation with the orchestrator |

## Events, AI, admin
| GET | `/events` | `?subjectType&subjectId&type&since` → `Event[]` | Tenant-scoped |
| GET | `/ai-runs/:id` | → `AiRun` | Tenant-scoped, redacted |
| GET | `/admin/customers`, `/admin/runs`, `/admin/ai-runs`, `/admin/failures`, `/admin/escalations`, `/admin/costs`, `/admin/activity` | | platform_admin; every read audited |
| POST | `/admin/runs/:id/retry` / `cancel` | | |

## Integrations
| GET | `/integrations` | → `Integration[]` with status | |
| POST | `/integrations/:provider/connect` | provider-specific → `Integration` | OAuth start or key entry |
| POST | `/integrations/:provider/disconnect` | | |
| POST | `/webhooks/postmark/inbound`, `/webhooks/twilio/sms`, `/webhooks/esign`, `/webhooks/stripe` | | Signature-verified |
