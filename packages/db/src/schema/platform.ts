import { bigserial, boolean, date, index, integer, jsonb, numeric, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { Actor, Subject } from "@ros/contracts";
import { createdAt, id, ts, updatedAt } from "./columns";
import { companies, users } from "./tenancy";

export const policies = pgTable(
  "policies",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    roleId: uuid("role_id"),
    actionType: text("action_type").notNull(),
    level: text("level").notNull(),
    approverRoles: jsonb("approver_roles").$type<string[]>().notNull().default([]),
    params: jsonb("params").$type<Record<string, unknown>>().notNull().default({}),
    createdBy: jsonb("created_by").$type<Actor>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("policies_scope_action_idx").on(t.companyId, t.roleId, t.actionType)],
);

export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    roleId: uuid("role_id"),
    applicationId: uuid("application_id"),
    actionType: text("action_type").notNull(),
    subject: jsonb("subject").$type<Subject>().notNull(),
    proposal: jsonb("proposal").$type<Record<string, unknown>>().notNull().default({}),
    rationale: text("rationale"),
    requestedBy: jsonb("requested_by").$type<Actor>().notNull(),
    requiredRoles: jsonb("required_roles").$type<string[]>().notNull().default([]),
    status: text("status").notNull().default("pending"),
    decidedBy: uuid("decided_by"),
    decidedAt: ts("decided_at"),
    decisionNote: text("decision_note"),
    decisionEdits: jsonb("decision_edits").$type<Record<string, unknown> | null>(),
    workflowRunId: uuid("workflow_run_id"),
    expiresAt: ts("expires_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("approval_requests_company_status_idx").on(t.companyId, t.status), index("approval_requests_run_idx").on(t.workflowRunId)],
);

/** A wait ends on a human decision, a signalled event, or a timer. An event or human wait may also carry `until`: whichever comes first wakes the run. `token` lets a stale timer be ignored. */
export type WaitCondition =
  | { kind: "human"; approvalRequestId?: string; escalationId?: string; until?: string; token?: string }
  | { kind: "event"; eventTypes: string[]; subjectId?: string; until?: string; reason?: string; token?: string }
  | { kind: "timer"; until: string; reason?: string; token?: string };

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: id(),
    companyId: uuid("company_id"),
    workflowKey: text("workflow_key").notNull(),
    workflowVersion: integer("workflow_version").notNull().default(1),
    subject: jsonb("subject").$type<Subject>().notNull(),
    status: text("status").notNull().default("running"),
    currentStep: text("current_step").notNull(),
    state: jsonb("state").$type<Record<string, unknown>>().notNull().default({}),
    wait: jsonb("wait").$type<WaitCondition | null>(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    escalationId: uuid("escalation_id"),
    idempotencyKey: text("idempotency_key"),
    startedAt: ts("started_at").notNull().defaultNow(),
    completedAt: ts("completed_at"),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("workflow_runs_status_idx").on(t.status, t.updatedAt),
    index("workflow_runs_subject_idx").on(t.workflowKey, t.status),
    uniqueIndex("workflow_runs_idempotency_idx").on(t.idempotencyKey),
  ],
);

export const workflowSteps = pgTable(
  "workflow_steps",
  {
    id: id(),
    runId: uuid("run_id").notNull().references(() => workflowRuns.id),
    companyId: uuid("company_id"),
    stepKey: text("step_key").notNull(),
    seq: integer("seq").notNull(),
    status: text("status").notNull(),
    input: jsonb("input").$type<Record<string, unknown>>().notNull().default({}),
    output: jsonb("output").$type<Record<string, unknown>>().notNull().default({}),
    attempts: integer("attempts").notNull().default(1),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
    error: text("error"),
  },
  (t) => [index("workflow_steps_run_idx").on(t.runId, t.seq)],
);

export const jobs = pgTable(
  "jobs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    kind: text("kind").notNull(),
    runAt: ts("run_at").notNull().defaultNow(),
    lockedAt: ts("locked_at"),
    lockedBy: text("locked_by"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("queued"),
    lastError: text("last_error"),
    createdAt: createdAt(),
  },
  (t) => [index("jobs_status_run_at_idx").on(t.status, t.runAt)],
);

export const aiRuns = pgTable(
  "ai_runs",
  {
    id: id(),
    companyId: uuid("company_id"),
    agent: text("agent").notNull(),
    task: text("task").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    modelVersion: text("model_version"),
    promptKey: text("prompt_key").notNull(),
    promptVersion: integer("prompt_version").notNull(),
    promptHash: text("prompt_hash").notNull(),
    inputRef: jsonb("input_ref").$type<Record<string, unknown>>().notNull().default({}),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    latencyMs: integer("latency_ms").notNull().default(0),
    toolCalls: jsonb("tool_calls").$type<Array<Record<string, unknown>>>().notNull().default([]),
    structuredOutput: jsonb("structured_output").$type<Record<string, unknown> | null>(),
    confidence: text("confidence"),
    policyDecision: jsonb("policy_decision").$type<Record<string, unknown> | null>(),
    humanOverride: jsonb("human_override").$type<Record<string, unknown> | null>(),
    finalOutcome: jsonb("final_outcome").$type<Record<string, unknown> | null>(),
    status: text("status").notNull().default("ok"),
    error: text("error"),
    workflowRunId: uuid("workflow_run_id"),
    createdAt: createdAt(),
  },
  (t) => [index("ai_runs_company_idx").on(t.companyId, t.createdAt), index("ai_runs_task_idx").on(t.task, t.createdAt)],
);

export const recruiterEscalations = pgTable(
  "recruiter_escalations",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    roleId: uuid("role_id"),
    applicationId: uuid("application_id"),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("open"),
    requestedBy: jsonb("requested_by").$type<Actor>().notNull(),
    question: text("question").notNull(),
    /** Pre-acceptance preview fields (correction 11): never derived from free text or a candidate record. */
    urgency: text("urgency").notNull().default("normal"),
    requiredExpertise: text("required_expertise").notNull().default(""),
    summary: text("summary").notNull().default(""),
    contextSnapshot: jsonb("context_snapshot").$type<Record<string, unknown>>().notNull().default({}),
    assignedToUserId: uuid("assigned_to_user_id"),
    claimedAt: ts("claimed_at"),
    resolvedAt: ts("resolved_at"),
    resolution: text("resolution"),
    slaDueAt: ts("sla_due_at"),
    /** When a recruiter first acted (claim); response time = firstResponseAt - createdAt (founder decision F12). */
    firstResponseAt: ts("first_response_at"),
    /** Recruiter effort, entered at resolution, for capacity and pricing. */
    minutesSpent: integer("minutes_spent"),
    /** When the recruiter's scoped access to this customer's data ends. */
    accessExpiresAt: ts("access_expires_at"),
    billing: jsonb("billing").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("recruiter_escalations_status_idx").on(t.status, t.createdAt), index("recruiter_escalations_company_idx").on(t.companyId)],
);

export const takeovers = pgTable(
  "takeovers",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    roleId: uuid("role_id").notNull(),
    recruiterUserId: uuid("recruiter_user_id").notNull().references(() => users.id),
    escalationId: uuid("escalation_id"),
    status: text("status").notNull().default("active"),
    policySnapshot: jsonb("policy_snapshot").$type<Record<string, unknown>>().notNull().default({}),
    startedAt: ts("started_at").notNull().defaultNow(),
    endedAt: ts("ended_at"),
  },
  (t) => [index("takeovers_role_idx").on(t.roleId, t.status)],
);

export const interventions = pgTable(
  "interventions",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    roleId: uuid("role_id"),
    detector: text("detector").notNull(),
    ladderLevel: text("ladder_level").notNull(),
    status: text("status").notNull().default("sent"),
    sentAt: ts("sent_at").notNull().defaultNow(),
    respondedAt: ts("responded_at"),
    response: text("response"),
    createdAt: createdAt(),
  },
  (t) => [index("interventions_company_role_idx").on(t.companyId, t.roleId, t.sentAt)],
);

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    action: jsonb("action").$type<{ label: string; href: string } | null>(),
    channel: text("channel").notNull().default("in_app"),
    readAt: ts("read_at"),
    createdAt: createdAt(),
    /** When it went out by email, at once or in a summary (plan B3, migration 0028); a summary takes only rows still null. */
    emailedAt: ts("emailed_at"),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.readAt, t.createdAt), index("notifications_person_history_idx").on(t.companyId, t.userId, t.createdAt, t.id)],
);

/**
 * How often one person hears by email about one group of updates (plan B3, migration 0028): immediate, daily, weekly or
 * off. No row means the group's default (packages/core/src/notify-groups.ts). Changed in place, never deleted.
 */
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    groupKey: text("group_key").notNull(),
    cadence: text("cadence").notNull(),
    setBy: jsonb("set_by").$type<Actor>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("notification_preferences_person_group_idx").on(t.companyId, t.userId, t.groupKey)],
);

export const inboundEmails = pgTable(
  "inbound_emails",
  {
    id: id(),
    companyId: uuid("company_id"),
    toAddress: text("to_address").notNull(),
    fromAddress: text("from_address").notNull(),
    subject: text("subject"),
    rawStorageKey: text("raw_storage_key"),
    parsed: jsonb("parsed").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("received"),
    applicationId: uuid("application_id"),
    communicationId: uuid("communication_id"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("inbound_emails_status_idx").on(t.status, t.createdAt)],
);

export const integrations = pgTable(
  "integrations",
  {
    id: id(),
    companyId: uuid("company_id"),
    /** Set for per-person connections (a calendar belongs to one interviewer); null for company-wide ones (a job board). */
    userId: uuid("user_id"),
    provider: text("provider").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("not_connected"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    /** Unused since correction 10: credentials never live in application tables. Kept for one release, then dropped. */
    credentialsCiphertext: text("credentials_ciphertext"),
    /** Opaque reference into the managed secret store (never the value). Null once deleted. */
    secretRef: text("secret_ref"),
    secretDeletedAt: ts("secret_deleted_at"),
    revokedAt: ts("revoked_at"),
    disconnectedAt: ts("disconnected_at"),
    disconnectReason: text("disconnect_reason"),
    externalAccountId: text("external_account_id"),
    connectedBy: uuid("connected_by"),
    connectedAt: ts("connected_at"),
    lastHealthAt: ts("last_health_at"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // One connection per company, provider, kind and person. The SQL migration (0008) declares it NULLS NOT DISTINCT so a
  // company-wide connection (user_id null) is unique too; Drizzle cannot express that clause, so the SQL is canonical.
  (t) => [uniqueIndex("integrations_company_provider_kind_user_idx").on(t.companyId, t.provider, t.kind, t.userId)],
);

export const auditRecords = pgTable(
  "audit_records",
  {
    id: id(),
    companyId: uuid("company_id"),
    actor: jsonb("actor").$type<Actor>().notNull(),
    action: text("action").notNull(),
    target: jsonb("target").$type<Subject | null>(),
    reason: text("reason"),
    ip: text("ip"),
    /** Structured detail: the route, the records viewed, the grant, the expiry. */
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("audit_records_company_idx").on(t.companyId, t.createdAt), index("audit_records_action_idx").on(t.action, t.createdAt)],
);

export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: uuid("company_id"),
    type: text("type").notNull(),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
    actor: jsonb("actor").$type<Actor>().notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    correlationId: text("correlation_id"),
    causationId: text("causation_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    schemaVersion: integer("schema_version").notNull().default(1),
  },
  (t) => [
    index("events_company_time_idx").on(t.companyId, t.occurredAt),
    index("events_subject_idx").on(t.subjectType, t.subjectId, t.occurredAt),
    index("events_type_idx").on(t.type, t.occurredAt),
    index("events_correlation_idx").on(t.correlationId),
  ],
);

/**
 * Explicit, role-scoped, time-limited access for ITS staff (founder decision F10). A grant exists only when a
 * customer or candidate asked for help and a recruiter accepted the assignment, or when a platform administrator
 * used break-glass with MFA and a reason. Access ends at `expires_at`, on revocation, or shortly after resolution.
 */
export const staffAccessGrants = pgTable(
  "staff_access_grants",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    kind: text("kind").notNull(), // escalation | break_glass
    escalationId: uuid("escalation_id"),
    roleId: uuid("role_id"),
    applicationId: uuid("application_id"),
    purpose: text("purpose").notNull(),
    grantedBy: jsonb("granted_by").$type<Actor>().notNull(),
    mfaVerified: boolean("mfa_verified").notNull().default(false),
    startsAt: ts("starts_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
    revokeReason: text("revoke_reason"),
    endedAt: ts("ended_at"),
    createdAt: createdAt(),
  },
  (t) => [index("staff_access_grants_user_company_idx").on(t.userId, t.companyId, t.expiresAt), index("staff_access_grants_escalation_idx").on(t.escalationId)],
);

/**
 * Platform roles are held through this ledger, never through configuration (founder instruction of 21 September 2026,
 * item 2). A person is a platform administrator while an unrevoked row names them; `users.platform_role` is a cached
 * projection maintained in the same transaction. The one-time bootstrap writes a row with source `bootstrap`; every later
 * change is a console action by a named administrator with a second factor, a reason, and two-person visibility.
 */
export const platformRoleGrants = pgTable(
  "platform_role_grants",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id),
    role: text("role").notNull(), // its_recruiter | platform_admin
    source: text("source").notNull(), // bootstrap | console | test_seed
    grantedBy: jsonb("granted_by").$type<Actor>().notNull(),
    grantReason: text("grant_reason").notNull(),
    grantedAt: ts("granted_at").notNull().defaultNow(),
    revokedAt: ts("revoked_at"),
    revokedBy: jsonb("revoked_by").$type<Actor | null>(),
    revokeReason: text("revoke_reason"),
    createdAt: createdAt(),
  },
  (t) => [index("platform_role_grants_user_idx").on(t.userId, t.revokedAt), index("platform_role_grants_role_idx").on(t.role, t.revokedAt)],
);

/**
 * The ITS business calendar (correction 12 of 18 September 2026): standard hours, time zone, holidays, closures and
 * temporary coverage changes, each change a new immutable version with an effective date. Service-level clocks read
 * the version effective on each day; existing deadlines keep their values unless an administrator recalculates them.
 */
export const businessCalendarVersions = pgTable(
  "business_calendar_versions",
  {
    id: id(),
    calendarKey: text("calendar_key").notNull().default("its"),
    version: integer("version").notNull(),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    timeZone: text("time_zone").notNull(),
    hours: jsonb("hours").$type<Record<string, Array<{ start: string; end: string }>>>().notNull(),
    holidays: jsonb("holidays").$type<Array<{ date: string; name: string }>>().notNull().default([]),
    closures: jsonb("closures").$type<Array<{ from: string; to: string; name: string }>>().notNull().default([]),
    coverageChanges: jsonb("coverage_changes").$type<Array<{ from: string; to: string; reason: string; hours: Array<{ start: string; end: string }> | null }>>().notNull().default([]),
    note: text("note").notNull().default(""),
    createdBy: jsonb("created_by").$type<Actor>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("business_calendar_versions_key_version_idx").on(t.calendarKey, t.version), index("business_calendar_versions_effective_idx").on(t.calendarKey, t.effectiveFrom)],
);

/** Operator alerts that must be seen by a person (correction 10: a failed credential deletion is one). */
export const adminAlerts = pgTable(
  "admin_alerts",
  {
    id: id(),
    kind: text("kind").notNull(),
    severity: text("severity").notNull().default("high"), // info | high | critical
    title: text("title").notNull(),
    body: text("body").notNull(),
    companyId: uuid("company_id"),
    target: jsonb("target").$type<Subject | null>(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("open"), // open | acknowledged | resolved
    acknowledgedBy: uuid("acknowledged_by"),
    acknowledgedAt: ts("acknowledged_at"),
    resolvedAt: ts("resolved_at"),
    createdAt: createdAt(),
  },
  (t) => [index("admin_alerts_status_idx").on(t.status, t.createdAt)],
);

/**
 * Email addresses we must not send to (correction 10 family of controls; item 5 of the founder's 18 Sep instruction):
 * hard bounces, spam complaints, repeated soft bounces, or a manual block. Platform-wide by address; the tenant role reads
 * it so every send checks it; only the platform writes it, through audited routes and the webhook processor.
 */
export const emailSuppressions = pgTable(
  "email_suppressions",
  {
    id: id(),
    address: text("address").notNull(),
    reason: text("reason").notNull(), // hard_bounce | spam_complaint | soft_bounce_repeated | manual
    source: text("source").notNull().default("postmark"), // postmark | admin
    active: boolean("active").notNull().default(true),
    count: integer("count").notNull().default(1),
    firstAt: ts("first_at").notNull().defaultNow(),
    lastAt: ts("last_at").notNull().defaultNow(),
    providerMessageId: text("provider_message_id"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    releasedAt: ts("released_at"),
    releasedBy: uuid("released_by"),
    releaseReason: text("release_reason"),
    createdAt: createdAt(),
  },
  (t) => [index("email_suppressions_address_idx").on(t.address, t.active)],
);

/** Every provider webhook is recorded once by its external id, so a redelivered event is acknowledged without acting twice. */
export const webhookReceipts = pgTable(
  "webhook_receipts",
  {
    id: id(),
    provider: text("provider").notNull(),
    kind: text("kind").notNull(),
    externalId: text("external_id").notNull(),
    receivedAt: ts("received_at").notNull().defaultNow(),
    outcome: text("outcome").notNull().default("processed"),
  },
  (t) => [uniqueIndex("webhook_receipts_provider_external_idx").on(t.provider, t.externalId)],
);

/**
 * Content-security-policy violation reports (21 Sep, item 6). Report-only in staging first; enforcement waits for a
 * review of these rows. Paths only, origins only, no query strings, no candidate data.
 */
export const cspReports = pgTable(
  "csp_reports",
  {
    id: id(),
    mode: text("mode").notNull(), // report_only | enforce
    surface: text("surface").notNull(), // candidate | app
    documentPath: text("document_path").notNull(),
    violatedDirective: text("violated_directive").notNull(),
    effectiveDirective: text("effective_directive"),
    blockedOrigin: text("blocked_origin"),
    sourceFile: text("source_file"),
    lineNumber: integer("line_number"),
    userAgent: text("user_agent"),
    count: integer("count").notNull().default(1),
    firstAt: ts("first_at").notNull().defaultNow(),
    lastAt: ts("last_at").notNull().defaultNow(),
    reviewedAt: ts("reviewed_at"),
    reviewedBy: uuid("reviewed_by"),
    disposition: text("disposition"),
  },
  (t) => [index("csp_reports_dedupe_idx").on(t.surface, t.documentPath, t.violatedDirective, t.blockedOrigin, t.sourceFile)],
);
