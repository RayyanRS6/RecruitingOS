import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid, date } from "drizzle-orm/pg-core";
import type {
  Actor,
  ApplicationStage,
  DraftRolePacket,
  EvidenceAssessment,
  IntakeFacts,
  IntakeMessage,
  IntakeServerState,
  ResumeExtraction,
  RolePacket,
  RolePosts,
  ScreenAssessment,
  ScreenProgress,
  ScreenTranscriptEntry,
  ToldState,
} from "@ros/contracts";
import { createdAt, id, ts, updatedAt } from "./columns";
import { companies } from "./tenancy";

export const roles = pgTable(
  "roles",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    title: text("title").notNull(),
    status: text("status").notNull().default("draft"),
    currentPacketVersion: integer("current_packet_version"),
    openedAt: ts("opened_at"),
    pausedAt: ts("paused_at"),
    closedAt: ts("closed_at"),
    /**
     * The "accepting applications" switch, distinct from pausing: the job page stays up and says applications are
     * closed, new submissions are refused, nobody already in the process is touched.
     */
    acceptingApplications: boolean("accepting_applications").notNull().default(true),
    applicationsClosedAt: ts("applications_closed_at"),
    applicationsClosedReason: text("applications_closed_reason"),
    /** The last day new applications are taken, in the company's time zone; null when the job has no closing date. */
    applicationsCloseOn: date("applications_close_on", { mode: "string" }),
    /**
     * The LinkedIn and Indeed posts of the Share tab (migration 0038): the two texts, whether a person edited each, when
     * each was written, and where the writing stands. Null on a job never published.
     */
    posts: jsonb("posts").$type<RolePosts>(),
    createdBy: jsonb("created_by").$type<Actor>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("roles_company_status_idx").on(t.companyId, t.status)],
);

export const rolePackets = pgTable(
  "role_packets",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    roleId: uuid("role_id").notNull().references(() => roles.id),
    version: integer("version").notNull(),
    packet: jsonb("packet").$type<RolePacket>().notNull(),
    status: text("status").notNull().default("proposed"),
    source: text("source").notNull(),
    changeSummary: text("change_summary"),
    createdBy: jsonb("created_by").$type<Actor>().notNull(),
    approvedBy: uuid("approved_by"),
    approvedAt: ts("approved_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("role_packets_role_version_idx").on(t.roleId, t.version), index("role_packets_company_idx").on(t.companyId)],
);

export const intakeSessions = pgTable(
  "intake_sessions",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    roleId: uuid("role_id"),
    status: text("status").notNull().default("active"),
    messages: jsonb("messages").$type<IntakeMessage[]>().notNull().default([]),
    facts: jsonb("facts").$type<IntakeFacts>().notNull().default({ mustHaves: [], niceToHaves: [], formQuestions: [], dealBreakers: [], declinedCriteria: [] }),
    missingFacts: jsonb("missing_facts").$type<string[]>().notNull().default([]),
    /** The draft written beside the conversation; pay only once a person set or confirmed it. */
    draftPacket: jsonb("draft_packet").$type<DraftRolePacket | null>(),
    createdBy: jsonb("created_by").$type<Actor>().notNull(),
    /** Who the draft belongs to, as a user id (migration 0030): drafts are listed, opened and taken over per person. */
    createdByUserId: uuid("created_by_user_id"),
    /** What the server decides about the draft, never the model: confirmed pay, open question cards, progress (IntakeServerState). */
    serverState: jsonb("server_state").$type<Partial<IntakeServerState>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("intake_sessions_company_idx").on(t.companyId, t.status), index("intake_sessions_owner_idx").on(t.companyId, t.createdByUserId, t.status)],
);

export type ConsentRecord = Record<string, { granted: boolean; at: string; source: string; noticeVersion?: string; ip?: string; /** application_terms only: the candidate ticked the acknowledgment box on the form. */ acknowledged?: boolean }>;
/** Who must not be emailed: set when the provider says their address did not want our email, or when they unsubscribe there. */
export type CandidatePreferences = { emailOptOut?: boolean };

export const candidates = pgTable(
  "candidates",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    email: text("email"),
    phone: text("phone"),
    locationText: text("location_text"),
    dedupeKey: text("dedupe_key"),
    consent: jsonb("consent").$type<ConsentRecord>().notNull().default({}),
    preferences: jsonb("preferences").$type<CandidatePreferences>().notNull().default({}),
    /** Set when a deletion request was fulfilled by anonymization (docs/runbooks/privacy-requests.md); identity fields are tokens from then on. */
    anonymizedAt: ts("anonymized_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("candidates_company_dedupe_idx").on(t.companyId, t.dedupeKey),
    index("candidates_company_email_idx").on(t.companyId, t.email),
  ],
);

export const documents = pgTable(
  "documents",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    candidateId: uuid("candidate_id"),
    applicationId: uuid("application_id"),
    kind: text("kind").notNull(),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    storageKey: text("storage_key").notNull(),
    sha256: text("sha256").notNull(),
    textExtracted: text("text_extracted"),
    extractedByAiRunId: uuid("extracted_by_ai_run_id"),
    /** quarantined (uploaded, not yet checked) → clean (checked and scanned, at its final key) | rejected (refused; bytes removed). */
    status: text("status").notNull().default("clean"),
    /** direct (browser to storage) or server (through the application); "email" on a file that came with an emailed application, which older rows hold. */
    uploadedVia: text("uploaded_via").notNull().default("server"),
    validatedAt: ts("validated_at"),
    scanEngine: text("scan_engine"),
    scanVerdict: text("scan_verdict"),
    rejectedReason: text("rejected_reason"),
    createdAt: createdAt(),
  },
  (t) => [index("documents_company_candidate_idx").on(t.companyId, t.candidateId), index("documents_application_idx").on(t.applicationId), index("documents_company_status_idx").on(t.companyId, t.status)],
);

/** The candidate's affirmative acknowledgment on the apply form: when it was ticked, which notice versions the server rendered above it, and the address the trusted proxy reported. */
export type ApplicationAcknowledgment = { at: string; noticeVersions: string[]; ip?: string };
/**
 * What the application form recorded. The form writes `form`, `noticeVersionsShown` and `acknowledgment`. The other keys
 * are held only by applications sent through earlier forms, and are read where a person's own words must still be found
 * (the answers given to the resume reading, a copy of their information, a deletion).
 */
export type ApplicationAnswers = {
  /** The application form's answers by question key: "yes" or "no", the chosen option's words, or the number as typed. An application sent before the form had one list of questions keeps its answers under `eligibility` and `quick`. */
  form?: Record<string, string>;
  eligibility?: Record<string, unknown>;
  screening?: Record<string, unknown>;
  noResume?: Record<string, string>;
  noticeVersionsShown?: string[];
  acknowledgment?: ApplicationAcknowledgment;
  quick?: Record<string, string>;
  fromCv?: string[];
  workSummary?: string;
  learned?: unknown[];
  kept?: unknown[];
};

export const applications = pgTable(
  "applications",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    roleId: uuid("role_id").notNull().references(() => roles.id),
    candidateId: uuid("candidate_id").notNull().references(() => candidates.id),
    packetVersion: integer("packet_version").notNull(),
    /** Where the person came from: the job page's `?src=` (linkedin, indeed), or "direct". */
    source: text("source").notNull(),
    stage: text("stage").$type<ApplicationStage>().notNull().default("applied"),
    stageChangedAt: ts("stage_changed_at").notNull().defaultNow(),
    resumeDocumentId: uuid("resume_document_id"),
    answers: jsonb("answers").$type<ApplicationAnswers>().notNull().default({}),
    extraction: jsonb("extraction").$type<ResumeExtraction | null>(),
    statusToken: text("status_token").notNull(),
    rejectedAt: ts("rejected_at"),
    /**
     * Whether someone marked Not selected was told (migration 0026): not_told until a person presses "Email the
     * decision" (queued while the email waits in the outbox, then sent).
     */
    toldState: text("told_state").$type<ToldState>().notNull().default("not_told"),
    candidateToldAt: ts("candidate_told_at"),
    /** Past the plan's candidates per job when it came in (migration 0036): the team cannot read this person. Null means visible. */
    lockedAt: ts("locked_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("applications_role_candidate_idx").on(t.roleId, t.candidateId),
    index("applications_company_role_stage_idx").on(t.companyId, t.roleId, t.stage),
    index("applications_company_candidate_idx").on(t.companyId, t.candidateId),
    uniqueIndex("applications_status_token_idx").on(t.statusToken),
  ],
);

/**
 * The AI's readings of an application: `kind` "triage" is a resume reading, "screen" the scorecard of an AI interview.
 * `result` is the reading itself, findings and words; both scores are worked out from it in code. A person's resume
 * score comes from their newest "triage" row and the job version it was made against (`packetVersion`, which is not
 * always the version they applied to: they are read again when the job's must-haves or skills change). A scorecard is
 * stored with the version its interview asked about.
 */
export const assessments = pgTable(
  "assessments",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    applicationId: uuid("application_id").notNull().references(() => applications.id),
    kind: text("kind").notNull(),
    packetVersion: integer("packet_version").notNull(),
    aiRunId: uuid("ai_run_id"),
    result: jsonb("result").$type<EvidenceAssessment | ScreenAssessment>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("assessments_application_idx").on(t.applicationId, t.createdAt)],
);

export const screens = pgTable(
  "screens",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    applicationId: uuid("application_id").notNull().references(() => applications.id),
    /**
     * The job version this interview asks about (migration 0040): the job's current version when the interview was
     * made, kept to its end whatever is edited later. Null only on a row written without it, which is read as the
     * version the person applied to.
     */
    packetVersion: integer("packet_version"),
    status: text("status").notNull().default("invited"),
    token: text("token").notNull(),
    invitedAt: ts("invited_at"),
    startedAt: ts("started_at"),
    completedAt: ts("completed_at"),
    transcript: jsonb("transcript").$type<ScreenTranscriptEntry[]>().notNull().default([]),
    answers: jsonb("answers").$type<Record<string, string>>().notNull().default({}),
    progress: jsonb("progress").$type<ScreenProgress>().notNull().default({ askedKeys: [], currentQuestionKey: null, followUps: {}, confusedTurns: 0, failures: 0 }),
    expiresAt: ts("expires_at"),
    remindedAt: ts("reminded_at"),
    assessmentId: uuid("assessment_id"),
    workflowRunId: uuid("workflow_run_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("screens_application_idx").on(t.applicationId), uniqueIndex("screens_token_idx").on(t.token), index("screens_company_status_idx").on(t.companyId, t.status)],
);

export const communications = pgTable(
  "communications",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    candidateId: uuid("candidate_id"),
    applicationId: uuid("application_id"),
    direction: text("direction").notNull(),
    channel: text("channel").notNull(),
    fromAddress: text("from_address"),
    toAddress: text("to_address"),
    subject: text("subject"),
    bodyText: text("body_text").notNull(),
    bodyHtml: text("body_html"),
    templateKey: text("template_key"),
    aiRunId: uuid("ai_run_id"),
    provider: text("provider"),
    providerMessageId: text("provider_message_id"),
    status: text("status").notNull().default("queued"),
    disclosureIncluded: boolean("disclosure_included").notNull().default(false),
    sentBy: jsonb("sent_by").$type<Actor>().notNull(),
    error: text("error"),
    deliveredAt: ts("delivered_at"),
    /** Delivery failure detail from the provider (bounce type, complaint) and the message this one retries, if any. */
    failureType: text("failure_type"),
    retryOf: uuid("retry_of"),
    retryAttempt: integer("retry_attempt").notNull().default(0),
    /**
     * Outbox (migration 0019): a message is written as `queued` inside the transaction that decided to send it; the
     * worker sends it after commit and marks it `sent` or `failed`. The key makes a retried step reuse its row.
     */
    idempotencyKey: text("idempotency_key"),
    sendingAt: ts("sending_at"),
    sendAttempts: integer("send_attempts").notNull().default(0),
    replyTo: text("reply_to"),
    tags: jsonb("tags").$type<Record<string, string>>().notNull().default({}),
    attachments: jsonb("attachments").$type<Array<{ filename: string; contentType: string; contentBase64: string }> | null>(),
    correlationId: text("correlation_id"),
    createdAt: createdAt(),
  },
  (t) => [index("communications_company_candidate_idx").on(t.companyId, t.candidateId, t.createdAt), index("communications_application_idx").on(t.applicationId), index("communications_provider_message_idx").on(t.providerMessageId), uniqueIndex("communications_idempotency_key_idx").on(t.idempotencyKey)],
);

/**
 * A hire, recorded by a person: one row per hire, kept and marked when it is taken back. Rows written by earlier builds
 * also hold other outcomes a person recorded (a job closed with its reason, an offer declined), with their dates and
 * notes, and corrections that point at the row they replace.
 */
export const hiringOutcomes = pgTable(
  "hiring_outcomes",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    /** Null for the outcome of a whole job, which earlier builds recorded. */
    applicationId: uuid("application_id").references(() => applications.id),
    milestone: text("milestone").notNull(), // final | role
    outcome: text("outcome").notNull(),
    notes: text("notes"),
    recordedBy: jsonb("recorded_by").$type<Actor>().notNull(),
    recordedAt: ts("recorded_at").notNull().defaultNow(),
    roleId: uuid("role_id"),
    hireDate: date("hire_date"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    correctionOf: uuid("correction_of"),
    correctedAt: ts("corrected_at"),
    correctedBy: jsonb("corrected_by").$type<Actor | null>(),
    correctionReason: text("correction_reason"),
  },
  (t) => [index("hiring_outcomes_application_idx").on(t.applicationId), index("hiring_outcomes_role_idx").on(t.roleId)],
);

/**
 * Candidate privacy requests (docs/runbooks/privacy-requests.md). Read only by platform administrators; the customer
 * sees only that a request was fulfilled. No deletion is automatic: an anonymization needs a recorded counsel decision
 * while retention rules are under review.
 */
export const dataRequests = pgTable(
  "data_requests",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    candidateId: uuid("candidate_id"),
    applicationId: uuid("application_id"),
    kind: text("kind").notNull(), // access | correct | delete | sms_opt_out | human_review | withdrawal
    details: text("details"),
    requesterEmail: text("requester_email").notNull(),
    channel: text("channel").notNull().default("status_page"), // status_page | email | admin
    verificationStatus: text("verification_status").notNull().default("pending"), // verified_by_link | pending | verified_manual | failed
    verificationNote: text("verification_note"),
    verifiedAt: ts("verified_at"),
    verifiedBy: uuid("verified_by"),
    status: text("status").notNull().default("received"), // received | in_progress | awaiting_counsel | fulfilled | declined
    slaDueAt: ts("sla_due_at").notNull(),
    assignedTo: uuid("assigned_to"),
    notes: jsonb("notes").$type<Array<{ at: string; by: string; text: string }>>().notNull().default([]),
    counselEscalatedAt: ts("counsel_escalated_at"),
    counselDecision: text("counsel_decision"), // pending | approved | declined | null
    counselNote: text("counsel_note"),
    resolution: text("resolution"),
    resolvedAt: ts("resolved_at"),
    resolvedBy: uuid("resolved_by"),
    confirmationSentAt: ts("confirmation_sent_at"),
    deadlineAlerts: jsonb("deadline_alerts").$type<Record<string, string>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("data_requests_company_status_idx").on(t.companyId, t.status, t.slaDueAt), index("data_requests_candidate_idx").on(t.candidateId)],
);
