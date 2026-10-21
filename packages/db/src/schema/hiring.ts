import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, numeric, pgTable, text, uniqueIndex, uuid, vector, date } from "drizzle-orm/pg-core";
import type {
  Actor,
  ApplicationStage,
  ApplyMode,
  DraftRolePacket,
  EligibilityResult,
  EvidenceAssessment,
  IntakeFacts,
  IntakeMessage,
  IntakeServerState,
  KeptFact,
  LearnedFact,
  Location,
  MarkKind,
  MarkSource,
  Playbook,
  ResumeExtraction,
  RolePacket,
  ScreenAssessment,
  ScreenInvitedVia,
  ScreenProgress,
  ScreenStatus,
  ScreenTranscriptEntry,
  ToldState,
  UnconfirmedConfirmation,
  UnconfirmedIntent,
} from "@ros/contracts";
import { createdAt, id, ts, updatedAt } from "./columns";
import { companies, users } from "./tenancy";

export const playbooks = pgTable(
  "playbooks",
  {
    id: id(),
    vertical: text("vertical").notNull(),
    version: integer("version").notNull(),
    content: jsonb("content").$type<Playbook>().notNull(),
    status: text("status").notNull().default("published"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("playbooks_vertical_version_idx").on(t.vertical, t.version)],
);

export const roles = pgTable(
  "roles",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    title: text("title").notNull(),
    status: text("status").notNull().default("draft"),
    currentPacketVersion: integer("current_packet_version"),
    hiringManagerUserId: uuid("hiring_manager_user_id"),
    playbookId: uuid("playbook_id"),
    playbookVersion: integer("playbook_version"),
    playbookRoleKey: text("playbook_role_key"),
    openedAt: ts("opened_at"),
    pausedAt: ts("paused_at"),
    closedAt: ts("closed_at"),
    closeReason: text("close_reason"),
    /**
     * The "accepting applications" switch (docs/spec/20 item 16), distinct from pausing: the job page stays up and says
     * applications are closed, new submissions are refused, nobody already in the process is touched.
     */
    acceptingApplications: boolean("accepting_applications").notNull().default(true),
    applicationsClosedAt: ts("applications_closed_at"),
    applicationsClosedReason: text("applications_closed_reason"),
    /** Applications per day above which the owner is told once a day; null means the default of 100. */
    volumeAlertPerDay: integer("volume_alert_per_day"),
    /**
     * The job boards a person ticked (Q11, migration 0031); null until someone chooses, and then the role plan's boards
     * are used (packages/core/src/postings.ts, `publishChannelsFor`). The careers page, Google and email are never listed.
     */
    publishChannels: text("publish_channels").array(),
    /** The last day new applications are taken, in the company's time zone (Q12); null when the role has no closing date. */
    applicationsCloseOn: date("applications_close_on", { mode: "string" }),
    /**
     * How applicants meet the screening conversation (migration 0033, plan E1): "one_visit" straight after the form,
     * "form_then_screen" by email later; null follows the company's default (`companies.settings.applyFlowDefault`).
     * Only ITS changes it (packages/core/src/apply-flow.ts, `resolveApplyMode`).
     */
    applyMode: text("apply_mode").$type<ApplyMode>(),
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
    facts: jsonb("facts").$type<IntakeFacts>().notNull().default({ mustHaves: [], niceToHaves: [], eligibilityNotes: [], interviewers: [], dealBreakers: [], declinedCriteria: [] }),
    missingFacts: jsonb("missing_facts").$type<string[]>().notNull().default([]),
    /** The draft written beside the conversation (C7); pay only once a person set or confirmed it. */
    draftPacket: jsonb("draft_packet").$type<DraftRolePacket | null>(),
    workflowRunId: uuid("workflow_run_id"),
    createdBy: jsonb("created_by").$type<Actor>().notNull(),
    /** Who the draft belongs to, as a user id (migration 0030): drafts are listed, opened and taken over per person (C3, Q6). */
    createdByUserId: uuid("created_by_user_id"),
    /** What the server decides about the draft, never the model: confirmed pay, open question cards, progress (IntakeServerState). */
    serverState: jsonb("server_state").$type<Partial<IntakeServerState>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("intake_sessions_company_idx").on(t.companyId, t.status), index("intake_sessions_owner_idx").on(t.companyId, t.createdByUserId, t.status)],
);

/**
 * One row per role and channel (docs/spec/20). `status` holds the nine posting states of packages/core/src/postings.ts;
 * `external_url` is the board's public URL; a posting is `live_verified` only after that URL was fetched and matched
 * (or a person recorded that they checked it, with a note).
 */
export const postings = pgTable(
  "postings",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    roleId: uuid("role_id").notNull().references(() => roles.id),
    channel: text("channel").notNull(),
    status: text("status").notNull().default("draft"),
    externalId: text("external_id"),
    externalUrl: text("external_url"),
    intakeToken: text("intake_token"),
    instructions: text("instructions"),
    /** The numbered manual steps for a board, as plain sentences. */
    steps: jsonb("steps").$type<string[]>().notNull().default([]),
    budget: jsonb("budget").$type<{ dailyUsd?: number; totalUsd?: number }>().notNull().default({}),
    publishedAt: ts("published_at"),
    expiresAt: ts("expires_at"),
    lastSyncedAt: ts("last_synced_at"),
    error: text("error"),
    /** When a person (or, for the careers page, the system) recorded the public URL. */
    publicUrlRecordedAt: ts("public_url_recorded_at"),
    verifiedAt: ts("verified_at"),
    /** The system after a successful fetch, or the person who said they checked it themselves. */
    verifiedBy: jsonb("verified_by").$type<Actor | null>(),
    verificationNote: text("verification_note"),
    verificationError: text("verification_error"),
    verificationAttempts: integer("verification_attempts").notNull().default(0),
    pausedAt: ts("paused_at"),
    closedAt: ts("closed_at"),
    /** True for a board that was up when the role closed: a person must take it down and confirm. */
    closureRequired: boolean("closure_required").notNull().default(false),
    closureConfirmedAt: ts("closure_confirmed_at"),
    closureConfirmedBy: jsonb("closure_confirmed_by").$type<Actor | null>(),
    /** The packet version a board listing was posted (or last updated) with; null when not known (migration 0031). */
    boardVersion: integer("board_version"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("postings_role_channel_idx").on(t.roleId, t.channel), index("postings_intake_token_idx").on(t.intakeToken), index("postings_company_status_idx").on(t.companyId, t.status)],
);

/**
 * Tracked application links (docs/spec/20 items 7 and 19): a short random token per board, referral, direct or other
 * link. The public redirect resolves it through the platform role, counts the visit and sets a sealed cookie; the
 * token is never written to an application, a candidate, a message or the status page. Disabled, never deleted.
 */
export const applicationLinks = pgTable(
  "application_links",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    roleId: uuid("role_id").notNull().references(() => roles.id),
    /** Null for referral, direct and other links. */
    postingId: uuid("posting_id"),
    token: text("token").notNull(),
    /** careers_page | email_in | linkedin | indeed | ziprecruiter | referral | direct | other */
    source: text("source").notNull(),
    sourceDetail: text("source_detail"),
    /** What the owner sees: "LinkedIn", "Referral: Dr. Patel". */
    label: text("label").notNull(),
    visits: integer("visits").notNull().default(0),
    lastVisitedAt: ts("last_visited_at"),
    /** "job": a shared link opens the job page first; "apply": a board's link goes straight to the form (migration 0032). */
    landing: text("landing").notNull().default("job"),
    createdBy: jsonb("created_by").$type<Actor>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    disabledAt: ts("disabled_at"),
  },
  (t) => [uniqueIndex("application_links_token_idx").on(t.token), index("application_links_company_role_idx").on(t.companyId, t.roleId), index("application_links_posting_idx").on(t.postingId)],
);

export type ConsentRecord = Record<string, { granted: boolean; at: string; source: string; noticeVersion?: string; ip?: string; /** application_terms only: the candidate ticked the acknowledgment box on the form. */ acknowledged?: boolean }>;
export type CandidatePreferences = { smsOptOut?: boolean; emailOptOut?: boolean; contactWindow?: string; talentPoolOptOut?: boolean };

export const candidates = pgTable(
  "candidates",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    email: text("email"),
    phone: text("phone"),
    location: jsonb("location").$type<Location | null>(),
    locationText: text("location_text"),
    dedupeKey: text("dedupe_key"),
    firstSource: text("first_source").notNull(),
    consent: jsonb("consent").$type<ConsentRecord>().notNull().default({}),
    preferences: jsonb("preferences").$type<CandidatePreferences>().notNull().default({}),
    inTalentPool: boolean("in_talent_pool").notNull().default(false),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    embedding: vector("embedding", { dimensions: 1024 }),
    mergedIntoCandidateId: uuid("merged_into_candidate_id"),
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
    /** direct (browser to storage), server (through the application), email (inbound attachment). */
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
 * Wave S7 (no migration: keys inside the existing JSON column, erased by an anonymization with the rest of `answers` and
 * part of an access export with them): `quick`, the company's quick questions answered on the form, by key (a choice's
 * words, or a number as typed); `fromCv`, the form fields (`firstName`, `locationText`, `q_<key>`, `elig_<key>`, ...)
 * whose value the CV filled and the candidate kept as it was ("From your CV — check it"); `workSummary`, the short
 * summary of their work the CV reading wrote and they checked; `learned`, what the profile learned from this
 * application's sent chat (`LearnedFact`). Wave S8: `kept`, the facts from their earlier chats at the company they kept
 * on this application's form, opened from the emailed reuse link (`KeptFact`); never part of the résumé reading's input.
 */
export type ApplicationAnswers = {
  eligibility?: Record<string, unknown>;
  screening?: Record<string, unknown>;
  noResume?: Record<string, string>;
  noticeVersionsShown?: string[];
  acknowledgment?: ApplicationAcknowledgment;
  quick?: Record<string, string>;
  fromCv?: string[];
  workSummary?: string;
  learned?: LearnedFact[];
  kept?: KeptFact[];
};

export const applications = pgTable(
  "applications",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    roleId: uuid("role_id").notNull().references(() => roles.id),
    candidateId: uuid("candidate_id").notNull().references(() => candidates.id),
    packetVersion: integer("packet_version").notNull(),
    /** The source vocabulary of application_links.source; `candidates.first_source` uses the same words. */
    source: text("source").notNull(),
    /** A referrer's name, a campaign label; never a tracking token. */
    sourceDetail: text("source_detail"),
    /** The tracked link the candidate came through, when there was one. */
    linkId: uuid("link_id"),
    stage: text("stage").$type<ApplicationStage>().notNull().default("applied"),
    stageChangedAt: ts("stage_changed_at").notNull().defaultNow(),
    resumeDocumentId: uuid("resume_document_id"),
    answers: jsonb("answers").$type<ApplicationAnswers>().notNull().default({}),
    eligibility: jsonb("eligibility").$type<EligibilityResult | null>(),
    extraction: jsonb("extraction").$type<ResumeExtraction | null>(),
    latestAssessmentId: uuid("latest_assessment_id"),
    statusToken: text("status_token").notNull(),
    /** The per-application reply address's token (migration 0023): lowercase, random, never the status token. The code sets it at creation; the database default covers direct inserts. */
    replyToken: text("reply_token").notNull().default(sql`substr(replace(gen_random_uuid()::text, '-', ''), 1, 16)`),
    inactiveAt: ts("inactive_at"),
    withdrawnAt: ts("withdrawn_at"),
    withdrawReason: text("withdraw_reason"),
    rejectedAt: ts("rejected_at"),
    rejectReason: text("reject_reason"),
    rejectNote: text("reject_note"),
    /**
     * Whether the candidate was told a decision (migration 0026; founder decision B6): not_told until a person sends
     * the message (queued, then sent once the outbox delivers it) or records that they told them (told_in_person).
     */
    toldState: text("told_state").$type<ToldState>().notNull().default("not_told"),
    candidateToldAt: ts("candidate_told_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("applications_role_candidate_idx").on(t.roleId, t.candidateId),
    index("applications_company_role_stage_idx").on(t.companyId, t.roleId, t.stage),
    index("applications_company_candidate_idx").on(t.companyId, t.candidateId),
    uniqueIndex("applications_status_token_idx").on(t.statusToken),
    uniqueIndex("applications_reply_token_idx").on(t.replyToken),
  ],
);

/**
 * A person's private mark on an application (migration 0026; founder decision B3): longlist, shortlist, on_hold or
 * not_a_fit_for_now. At most one is active (cleared_at null); a hold carries the date it ends. Cleared, never deleted.
 */
export const applicationMarks = pgTable(
  "application_marks",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    applicationId: uuid("application_id").notNull().references(() => applications.id),
    mark: text("mark").$type<MarkKind>().notNull(),
    remindAt: ts("remind_at"),
    note: text("note"),
    setBy: jsonb("set_by").$type<Actor>().notNull(),
    source: text("source").$type<MarkSource>().notNull().default("manual"),
    createdAt: createdAt(),
    clearedAt: ts("cleared_at"),
    clearedBy: jsonb("cleared_by").$type<Actor | null>(),
    clearReason: text("clear_reason"),
  },
  (t) => [
    uniqueIndex("application_marks_active_idx").on(t.companyId, t.applicationId).where(sql`${t.clearedAt} is null`),
    index("application_marks_hold_due_idx").on(t.companyId, t.remindAt).where(sql`${t.clearedAt} is null and ${t.mark} = 'on_hold'`),
    index("application_marks_application_idx").on(t.applicationId, t.createdAt),
  ],
);

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
    overall: text("overall").notNull(),
    confidence: text("confidence").notNull(),
    secondaryScore: numeric("secondary_score", { precision: 5, scale: 2 }),
    supersededBy: uuid("superseded_by"),
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
    channel: text("channel").notNull(),
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
    humanRequestedAt: ts("human_requested_at"),
    lastCandidateMessageAt: ts("last_candidate_message_at"),
    assessmentId: uuid("assessment_id"),
    workflowRunId: uuid("workflow_run_id"),
    /** "apply" (offered in the visit that sent the application), "confirmed_repeat", "with_application" (every applicant's AI interview, 20 Oct 2026), or null for an emailed invitation (migration 0033). */
    invitedVia: text("invited_via").$type<ScreenInvitedVia>(),
    /** The one reminder to someone who started and stopped part-way (plan E4). */
    idleRemindedAt: ts("idle_reminded_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("screens_application_idx").on(t.applicationId), uniqueIndex("screens_token_idx").on(t.token), index("screens_company_status_idx").on(t.companyId, t.status), index("screens_company_via_status_idx").on(t.companyId, t.invitedVia, t.status)],
);

/**
 * The conversation of a repeat submission (migration 0033; Q14 x Q15): it looks exactly like a first application's, and
 * nothing in it reaches the real application until the owner of the address on file confirms by email. Unconfirmed,
 * its words are wiped after seven days. Never deleted.
 */
export const unconfirmedScreens = pgTable(
  "unconfirmed_screens",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    roleId: uuid("role_id").notNull().references(() => roles.id),
    applicationId: uuid("application_id").notNull().references(() => applications.id),
    packetVersion: integer("packet_version").notNull(),
    /** The first name typed into the form, never the one on file. */
    firstName: text("first_name").notNull(),
    token: text("token").notNull(),
    status: text("status").$type<ScreenStatus>().notNull().default("invited"),
    intent: text("intent").$type<UnconfirmedIntent | null>(),
    confirmation: text("confirmation").$type<UnconfirmedConfirmation | null>(),
    confirmTokenHash: text("confirm_token_hash"),
    transcript: jsonb("transcript").$type<ScreenTranscriptEntry[]>().notNull().default([]),
    answers: jsonb("answers").$type<Record<string, string>>().notNull().default({}),
    progress: jsonb("progress").$type<ScreenProgress>().notNull().default({ askedKeys: [], currentQuestionKey: null, followUps: {}, confusedTurns: 0, failures: 0 }),
    startedAt: ts("started_at"),
    lastCandidateMessageAt: ts("last_candidate_message_at"),
    finishedAt: ts("finished_at"),
    confirmSentAt: ts("confirm_sent_at"),
    confirmedAt: ts("confirmed_at"),
    mergedScreenId: uuid("merged_screen_id"),
    discardedAt: ts("discarded_at"),
    expiresAt: ts("expires_at").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("unconfirmed_screens_token_idx").on(t.token),
    uniqueIndex("unconfirmed_screens_confirm_idx").on(t.confirmTokenHash).where(sql`${t.confirmTokenHash} is not null`),
    index("unconfirmed_screens_application_idx").on(t.applicationId, t.createdAt),
    index("unconfirmed_screens_expiry_idx").on(t.companyId, t.expiresAt).where(sql`${t.discardedAt} is null`),
  ],
);

export const interviews = pgTable(
  "interviews",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    applicationId: uuid("application_id").notNull().references(() => applications.id),
    roundKey: text("round_key").notNull(),
    title: text("title").notNull(),
    format: text("format").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    startsAt: ts("starts_at"),
    endsAt: ts("ends_at"),
    timezone: text("timezone"),
    status: text("status").notNull().default("proposed"),
    calendarRefs: jsonb("calendar_refs").$type<Record<string, unknown>>().notNull().default({}),
    meetingUrl: text("meeting_url"),
    recording: jsonb("recording").$type<Record<string, unknown>>().notNull().default({}),
    transcriptDocumentId: uuid("transcript_document_id"),
    /** Scheduling (docs/05 §2; slice 5 step 9). */
    scheduleToken: text("schedule_token"),
    scheduleTokenExpiresAt: ts("schedule_token_expires_at"),
    schedulingWindow: jsonb("scheduling_window").$type<{ fromDate?: string; toDate?: string; businessDaysOnly?: boolean; candidateTimezone?: string }>().notNull().default({}),
    offeredSlots: jsonb("offered_slots").$type<Array<{ id: string; startsAt: string; endsAt: string; interviewerUserIds: string[]; source: "calendar" | "declared" }>>().notNull().default([]),
    selectedSlot: jsonb("selected_slot").$type<{ id: string; startsAt: string; endsAt: string; interviewerUserIds: string[]; source: "calendar" | "declared" } | null>(),
    candidateAvailability: jsonb("candidate_availability").$type<{ timezone?: string; note?: string; preferred?: Array<{ day: number; part: string }>; at?: string } | null>(),
    linkSource: text("link_source").notNull().default("calendar"),
    rescheduleCountCandidate: integer("reschedule_count_candidate").notNull().default(0),
    attempt: integer("attempt").notNull().default(1),
    cancelReason: text("cancel_reason"),
    outcome: text("outcome"),
    decision: text("decision"),
    decisionNote: text("decision_note"),
    reminders: jsonb("reminders").$type<Record<string, string>>().notNull().default({}),
    workflowRunId: uuid("workflow_run_id"),
    createdBy: jsonb("created_by").$type<Actor | null>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("interviews_application_idx").on(t.applicationId), index("interviews_company_time_idx").on(t.companyId, t.startsAt), uniqueIndex("interviews_schedule_token_idx").on(t.scheduleToken)],
);

export const interviewParticipants = pgTable(
  "interview_participants",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    interviewId: uuid("interview_id").notNull().references(() => interviews.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    role: text("role").notNull().default("interviewer"),
    status: text("status").notNull().default("invited"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("interview_participants_idx").on(t.interviewId, t.userId)],
);

export const scorecards = pgTable(
  "scorecards",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    interviewId: uuid("interview_id").notNull().references(() => interviews.id),
    applicationId: uuid("application_id").notNull().references(() => applications.id),
    interviewerUserId: uuid("interviewer_user_id").notNull().references(() => users.id),
    status: text("status").notNull().default("pending"),
    entries: jsonb("entries").$type<Array<{ competencyKey: string; rating: number | null; evidence?: string; notes?: string }>>().notNull().default([]),
    recommendation: text("recommendation"),
    submittedAt: ts("submitted_at"),
    aiDraftAssessmentId: uuid("ai_draft_assessment_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("scorecards_interview_interviewer_idx").on(t.interviewId, t.interviewerUserId)],
);

export const debriefs = pgTable(
  "debriefs",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    roleId: uuid("role_id").notNull().references(() => roles.id),
    applicationIds: jsonb("application_ids").$type<string[]>().notNull().default([]),
    summary: jsonb("summary").$type<Record<string, unknown>>().notNull().default({}),
    decision: jsonb("decision").$type<Record<string, unknown> | null>(),
    aiRunId: uuid("ai_run_id"),
    createdBy: jsonb("created_by").$type<Actor>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("debriefs_role_idx").on(t.roleId)],
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

export const offers = pgTable(
  "offers",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    applicationId: uuid("application_id").notNull().references(() => applications.id),
    version: integer("version").notNull().default(1),
    status: text("status").notNull().default("draft"),
    terms: jsonb("terms").$type<Record<string, unknown>>().notNull().default({}),
    letterDocumentId: uuid("letter_document_id"),
    approval: jsonb("approval").$type<Record<string, unknown>>().notNull().default({}),
    esign: jsonb("esign").$type<Record<string, unknown>>().notNull().default({}),
    acceptToken: text("accept_token"),
    sentAt: ts("sent_at"),
    respondedAt: ts("responded_at"),
    declineReason: text("decline_reason"),
    negotiationLog: jsonb("negotiation_log").$type<Array<Record<string, unknown>>>().notNull().default([]),
    /** "Offer made" (migration 0034; founder decision Q29): a person recorded an offer made outside the app, on `madeOn`. Terms stay empty. */
    madeOutside: boolean("made_outside").notNull().default(false),
    madeOn: date("made_on"),
    createdBy: jsonb("created_by").$type<Actor>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("offers_application_idx").on(t.applicationId, t.version)],
);

export const onboardings = pgTable(
  "onboardings",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    applicationId: uuid("application_id").notNull().references(() => applications.id),
    status: text("status").notNull().default("pending"),
    startDate: text("start_date"),
    hris: jsonb("hris").$type<Record<string, unknown>>().notNull().default({}),
    tasks: jsonb("tasks").$type<Array<{ key: string; title: string; owner: string; due?: string; status: string }>>().notNull().default([]),
    checkins: jsonb("checkins").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("onboardings_application_idx").on(t.applicationId)],
);

export const hiringOutcomes = pgTable(
  "hiring_outcomes",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    /** Null for role-level outcomes (a role cancelled or filled outside the platform). */
    applicationId: uuid("application_id").references(() => applications.id),
    milestone: text("milestone").notNull(), // final | role | 30_day | 60_day | 90_day
    outcome: text("outcome").notNull(),
    rating: integer("rating"),
    notes: text("notes"),
    recordedBy: jsonb("recorded_by").$type<Actor>().notNull(),
    recordedAt: ts("recorded_at").notNull().defaultNow(),
    /** 21 Sep, item 4: human-recorded outcomes, often about decisions made outside the platform. */
    roleId: uuid("role_id"),
    hireDate: date("hire_date"),
    offerAcceptedAt: date("offer_accepted_at"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    correctionOf: uuid("correction_of"),
    correctedAt: ts("corrected_at"),
    correctedBy: jsonb("corrected_by").$type<Actor | null>(),
    correctionReason: text("correction_reason"),
  },
  (t) => [index("hiring_outcomes_application_idx").on(t.applicationId), index("hiring_outcomes_role_idx").on(t.roleId)],
);

/** Declared availability (docs/05 §3): used alone when no calendar is connected, and as constraints (hours, buffers, daily maximum) when one is. */
export const interviewerAvailability = pgTable(
  "interviewer_availability",
  {
    id: id(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    timezone: text("timezone").notNull(),
    windows: jsonb("windows").$type<Array<{ day: number; start: string; end: string }>>().notNull().default([]),
    bufferMinutes: integer("buffer_minutes").notNull().default(15),
    maxPerDay: integer("max_per_day").notNull().default(3),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("interviewer_availability_user_idx").on(t.companyId, t.userId)],
);

/**
 * Candidate privacy requests (docs/05 §3, docs/runbooks/privacy-requests.md; built 18 Sep with synthetic data). Read only
 * by platform administrators; the customer sees only that a request was fulfilled. No deletion is automatic: an
 * anonymization needs a recorded counsel decision while retention rules are under review.
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
    escalationId: uuid("escalation_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("data_requests_company_status_idx").on(t.companyId, t.status, t.slaDueAt), index("data_requests_candidate_idx").on(t.candidateId)],
);
