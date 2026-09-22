# 02. User roles and permissions (release 1)

Source of truth in code: `packages/core/src/permissions.ts` (role matrix), `packages/core/src/policy.ts` (action policies), `apps/api/src/middleware/session.ts` (tenancy), `packages/db/migrations/0001_rls_and_grants.sql` (row-level security). This document specifies the release-1 state, including changes.

## 1. Actors

| Actor | Kind | How they authenticate | Scope |
|---|---|---|---|
| Owner | tenant membership role `owner` | magic link + session cookie | One company (may belong to several) |
| Admin | `admin` | same | Same permissions as owner except they are not the accountable signer of the design-partner agreement |
| Hiring manager | `hiring_manager` | same | Roles they create or are assigned to; all applications in the company (release 1; per-role scoping is release 2) |
| HR / People | `hr` | same | Team, applications, compensation, data requests |
| Interviewer | `interviewer` | same | Only their interviews and the applications attached to them; never compensation |
| Recruiter (tenant) | `recruiter` | same | Operates roles for the tenant (an ITS recruiter added as a member, or the customer's own) |
| ITS recruiter | `users.platform_role = its_recruiter` | same | The ITS queue; tenant data only while holding an open escalation for that tenant (D11) |
| Platform admin | `platform_role = platform_admin` | same | Admin console; every read audited with a reason |
| Candidate | none; signed tokens in links | status token (long-lived), screen token (expires with the screen), schedule token (expires with the offer) | Their own application only |
| System | workflow steps | n/a | Acts under policy; actor `{kind:"system", id:"workflow:<key>"}` |
| Agent | AI tasks | n/a | Proposes; acts only where policy is `auto` or `auto_notify`; actor `{kind:"agent", id, runId}` |

## 2. Permission matrix

Permissions are capabilities checked by `assertCan(role, permission)` in every route. Existing permissions keep their names; new ones are marked.

| Permission | owner | admin | hiring_manager | hr | interviewer | recruiter | Notes |
|---|---|---|---|---|---|---|---|
| company.read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| company.update | ✓ | ✓ | | | | | Notices are human-only and audited |
| members.manage | ✓ | ✓ | | ✓ | | | Cannot remove self |
| role.create | ✓ | ✓ | ✓ | | | ✓ | Starts intake |
| role.read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Interviewers: only roles with an interview assigned to them (new predicate) |
| role.approve | ✓ | ✓ | ✓ | | | | Subject to the approval request's required roles |
| role.manage | ✓ | ✓ | | | | ✓ | Pause, resume, close, retry postings |
| packet.edit | ✓ | ✓ | ✓ | | | ✓ | Creates a new version |
| application.read | ✓ | ✓ | ✓ | ✓ | ✓* | ✓ | *Interviewer: only applications with an interview they participate in; compensation redacted |
| application.act | ✓ | ✓ | ✓ | ✓ | | ✓ | Invite, hold, talent pool, override eligibility, review anyway, flag |
| application.reject | ✓ | ✓ | ✓ | | | ✓ | Reason required |
| interview.request (new) | ✓ | ✓ | ✓ | | | ✓ | The human interview approval (also gated by the `interview.request` policy) |
| interview.manage (new) | ✓ | ✓ | ✓ | ✓ | ✓* | ✓ | Reschedule or cancel; *interviewer only their own |
| interview.decide (new) | ✓ | ✓ | ✓ | | | ✓ | Record the decision after an interview (D10) |
| calendar.connect (new) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Each user connects their own calendar or declares availability |
| candidate.search | ✓ | ✓ | | ✓ | | ✓ | Talent across roles |
| compensation.read | ✓ | ✓ | ✓ | ✓ | | ✓ | Interviewers never see pay |
| scorecard.write | ✓ | ✓ | ✓ | | ✓ | ✓ | Release 2; kept in the matrix |
| offer.manage | ✓ | ✓ | | ✓ | | ✓ | Release 2 |
| policy.manage | ✓ | ✓ | | | | | Human-only, audited, re-authentication required (D12) |
| escalation.create | ✓ | ✓ | ✓ | ✓ | | ✓ | "Bring in a recruiter" |
| escalation.work | | | | | | ✓ | Tenant recruiters; ITS recruiters via platform role |
| workflow.control | | | | | | ✓ | Retry a run for the tenant (release 3 UI) |
| events.read | ✓ | ✓ | ✓ | ✓ | ✓* | ✓ | *Interviewer: events of their interviews only |
| sessions.manage (new) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Own sessions; owner/admin may revoke any member's sessions |
| data_request.manage (new) | ✓ | ✓ | | ✓ | | | Candidate access, correction, deletion requests |
| billing.manage | ✓ | ✓ | | | | | Release 2 |

Object-level predicates (implemented in code, not only in the matrix): interviewers see only applications joined to an `interview_participants` row with their user id; `compensation.read` gates the packet's compensation block and the assessment's compensation expectation; a candidate token grants access only to its own application, screen, or interview.

## 3. Platform roles

| Platform role | Grants | Audit |
|---|---|---|
| `its_recruiter` | The recruiter queue. Before acceptance only the preview (customer name, role title, category, urgency, required expertise, remaining service-level time, generic summary; correction 11), each view audited as `escalation.preview_viewed`. Tenant access (as role `recruiter`, limited to the escalation's role and candidate) only under an active `staff_access_grants` row created by accepting the assignment; 14 days at most, shortened to 24 hours after resolution; released on demand (F10). | `staff.access_granted`, `staff.tenant_accessed` (every request: route, grant, purpose, expiry), `escalation.context_viewed`, `staff.access_ended`; the customer's event log shows `recruiter.access_granted` and `recruiter.access_ended` |
| `platform_admin` | The admin console; plan assignment; platform-role assignment; data-request fulfilment; run retry; the grant ledger. Tenant data only through break-glass: MFA verified in the last 15 minutes, a recorded reason, at most 60 minutes, immutable audit; refused until MFA exists (D25). | `admin.bypass` with a required reason (S10); `admin.break_glass` |

Assigning a platform role is `POST /api/v1/admin/users/:id/platform-role` by a platform admin, audited, and never through the tenant UI. The first platform admin is created by a seed command from the deployment shell.

## 4. Policy engine: action levels in release 1

Levels: `auto`, `auto_notify`, `approval`, `human_only`. Resolution: role policy → company policy → platform default; hard human-only actions cannot be lowered. Only the actions below are shown in the Setup policy editor in release 1; the rest keep their defaults hidden (P5, P6).

| Action | Default | Approvers (approval level) | Can the company change it? |
|---|---|---|---|
| role_packet.approve | approval | owner, admin, hiring_manager | approver list only; cannot become auto |
| role.publish | auto | | yes |
| message.send_templated | auto | | no (acknowledgments and confirmations are the product) |
| message.send_freeform | auto_notify | | yes (release 1 has no freeform sends; shown for transparency) |
| application.triage | auto (information) | | no |
| application.reject_ineligible | auto_notify, 24 h review window | | yes: window hours, or human_only |
| application.reject_on_assessment | human_only | | locked |
| application.invite_screen | auto_notify | | yes |
| screen.conduct | auto | | yes (human_only disables AI screening) |
| application.recommend_interview | auto_notify (information) | | yes |
| interview.request | approval | owner, hiring_manager, recruiter | approver list only; cannot become auto (new lock, AC10.1) |
| interview.schedule | auto | | yes |
| interview.reschedule | auto_notify | | yes |
| disposition.send | auto_notify | | yes |
| intervention.nudge | auto (48 h cooldown) | | yes |
| intervention.offer_recruiter | auto_notify | | yes |
| candidate.hire_decision | human_only | | locked |
| policy.change, knockout_rule.change, notice_text.change, data.delete, data.export | human_only | owner, admin (hr for data) | locked |

## 5. Approval routing

An approval request records `requiredRoles`; a user decides only if their tenant role is in that list. Deciding from the surface that proposes the action (approving the role, clicking Invite, clicking Interview) resolves the pending request and signals the workflow. Requests expire (packet approval 14 days, screen and interview recommendations 7 days); expiry notifies the requester's role and the stuck-role detector sees it.

## 6. Candidate tokens

| Token | Where | Lifetime | Rotation |
|---|---|---|---|
| `applications.status_token` | `/c/status/:token` | Life of the application | Candidate can rotate from the status page ("get a new link"); rotation emails the new link |
| `screens.token` | `/c/screen/:token` | Until the screen completes, expires (120 h), or is handed off | New screen, new token |
| `interviews.schedule_token` (new) | `/c/schedule/:token` | Until booked plus 48 h for reschedule links, max 14 days | New offer, new token |

All tokens are 192-bit random, stored as-is with unique indexes (they are the credential); logs redact them (S4).

## 7. Tenant isolation

Every tenant table carries `company_id` with the `tenant_isolation` policy; tenant work runs as `app_tenant` with `app.company_id` set in the transaction. New tables in release 1 (`calendar_connections`, `interviewer_availability`, `data_requests`, `rate_limits` is platform-level) follow the same policy. Production database roles: `ros_migrate` (owner), `ros_app` (connection, `NOBYPASSRLS`), `app_tenant` (S1).

## 8. Invitations and offboarding

Invite: owner/admin/hr sends a magic link bound to the company and role; acceptance creates or activates the membership. Role change: audited; sessions of that user are revoked so the new role applies immediately. Removal: status `removed`, sessions revoked, calendar connection tokens deleted, interviews they were on flagged for reassignment. Leaving ITS: platform admin clears the platform role; open escalations are reassigned.
