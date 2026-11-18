import { bigserial, boolean, index, integer, jsonb, numeric, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { Actor, Subject } from "@ros/contracts";
import { createdAt, id, ts, updatedAt } from "./columns";
import { companies, users } from "./tenancy";

/** A wait ends on a signalled event or a timer. An event wait may also carry `until`: whichever comes first wakes the run. `token` lets a stale timer be ignored. */
export type WaitCondition =
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
    promptKey: text("prompt_key").notNull(),
    promptVersion: integer("prompt_version").notNull(),
    promptHash: text("prompt_hash").notNull(),
    inputRef: jsonb("input_ref").$type<Record<string, unknown>>().notNull().default({}),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    latencyMs: integer("latency_ms").notNull().default(0),
    structuredOutput: jsonb("structured_output").$type<Record<string, unknown> | null>(),
    /** A person's flag on a reading, which earlier builds recorded; nothing writes it now. */
    humanOverride: jsonb("human_override").$type<Record<string, unknown> | null>(),
    finalOutcome: jsonb("final_outcome").$type<Record<string, unknown> | null>(),
    status: text("status").notNull().default("ok"),
    error: text("error"),
    workflowRunId: uuid("workflow_run_id"),
    createdAt: createdAt(),
  },
  (t) => [index("ai_runs_company_idx").on(t.companyId, t.createdAt), index("ai_runs_task_idx").on(t.task, t.createdAt)],
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
    readAt: ts("read_at"),
    createdAt: createdAt(),
    /** When it went out by email (migration 0028). */
    emailedAt: ts("emailed_at"),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.readAt, t.createdAt), index("notifications_person_history_idx").on(t.companyId, t.userId, t.createdAt, t.id)],
);

/**
 * Whether one person hears by email about updates (migration 0028): a row per person and group of updates with its
 * cadence. No row means the default (packages/core/src/notifications.ts). Changed in place, never deleted.
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
 * Platform roles are held through this ledger, never through configuration (founder instruction of 21 September 2026,
 * item 2). A person is a platform administrator while an unrevoked row names them; `users.platform_role` is a cached
 * projection maintained in the same transaction. The one-time bootstrap writes a row with source `bootstrap`; every later
 * change is a console action by a named administrator with a second factor, a reason, and two-person visibility. Rows
 * are never deleted: a grant ends by being marked revoked, and the ledger keeps the grants of roles that no longer exist.
 */
export const platformRoleGrants = pgTable(
  "platform_role_grants",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id),
    role: text("role").notNull(), // platform_admin
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

/** Operator alerts that must be seen by a person. */
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
 * Email addresses we must not send to: hard bounces, spam complaints, repeated soft bounces, or a manual block.
 * Platform-wide by address; the tenant role reads it so every send checks it; only the platform writes it, through
 * audited routes and the webhook processor.
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
  },
  (t) => [uniqueIndex("webhook_receipts_provider_external_idx").on(t.provider, t.externalId)],
);

/**
 * Content-security-policy violation reports. Paths only, origins only, no query strings, no candidate data.
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
