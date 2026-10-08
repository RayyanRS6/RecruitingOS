import type { ActiveMark, CandidateNotice, GettingStarted, IntakeSessionView, MeResponse, OwnerGroup, OwnerStage, PacketFlag, StageMove, ToldState } from "@ros/contracts";

export type { ActiveMark, CandidateNotice, OwnerStage, StageMove, ToldState };

/** Typed-enough fetch wrapper. The API is served by the same deployment as the pages, so every path is relative. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(body !== undefined && !(body instanceof FormData) ? { "content-type": "application/json" } : {}), ...((init.headers as Record<string, string>) ?? {}) };
  const res = await fetch(path, { method, credentials: "include", headers, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body), ...init });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const err = (json as { error?: { code: string; message: string; details?: unknown } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? "error", err?.message ?? `Request failed (${res.status})`, err?.details);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string, init?: RequestInit) => request<T>("GET", path, undefined, init),
  post: <T>(path: string, body?: unknown, init?: RequestInit) => request<T>("POST", path, body ?? {}, init),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
};

/** The signed-in person, exactly as the API answers it (the shape lives in @ros/contracts so the two cannot drift). */
export type Me = MeResponse;

/** `gettingStarted`: only on the getting_started card, the ITS company check and the steps this person can do (plan B1, B2). */
export type BriefCard = { kind: string; title: string; body: string; roleId?: string; applicationId?: string; approvalRequestId?: string; actions: Array<{ label: string; method: "GET" | "POST"; path: string; body?: Record<string, unknown> }>; gettingStarted?: GettingStarted };
export type Brief = { generatedAt: string; cards: BriefCard[]; summary: string };

/**
 * `countsHidden`: the list was read by an interviewer, so it holds only the roles they interview for and no applicant counts.
 * `counts` is by owner group (a running hold waits on nobody); `stageCounts` is the stage strip, private marks included.
 */
export type RoleSummary = { id: string; title: string; status: string; openedAt: string | null; createdAt?: string; counts: Record<string, number> & { total: number }; stageCounts?: Record<OwnerStage, number>; countsHidden?: boolean; needsYou: number; daysOpen: number | null };
/** One role on one channel, with the nine-state fields (docs/spec/20). `status` is one of the nine posting states; `stateLabel` on PostingView is the owner's word for it. */
export type Posting = { id: string; channel: string; status: string; externalUrl: string | null; intakeToken: string | null; instructions: string | null; steps: string[]; error: string | null; publishedAt: string | null; publicUrlRecordedAt: string | null; verifiedAt: string | null; verifiedBy: { kind: string; id: string; name?: string } | null; verificationNote: string | null; verificationError: string | null; verificationAttempts: number; pausedAt: string | null; closedAt: string | null; closureRequired: boolean; closureConfirmedAt: string | null; closureConfirmedBy: { kind: string; id: string; name?: string } | null };
/** A team member as the decision maker of a role packet (matched from the packet's preferences to an active approver). */
export type DecisionMaker = { userId: string; name: string | null; email: string };
/** Whether candidates see a packet's pay range by the public pages' rule, and whether a pay transparency law is why. */
export type PacketPayView = { payShown?: boolean; payRequiredByLaw?: boolean };
/**
 * The packet approval on a role: what waits, what the signed-in person may do about it, and how a sent-back role got
 * there. `flags` are the wording checks on the version waiting (open ones hold approval until changed or kept with a
 * reason); sending back is never held up by them (`maySendBack`).
 */
export type PacketApproval = {
  pending: { id: string; version: number; rationale: string | null; requestedBy: { kind: string; id: string; name?: string }; requiredRoles: string[]; requiredUserIds: string[]; decisionMaker: DecisionMaker | null; createdAt: string; expiresAt: string | null; editWhileOpen: boolean; flags: PacketFlag[]; viewer: { mayDecide: boolean; maySendBack: boolean; reason: string | null } } | null;
  latest: { id: string; status: string; version: number; decisionNote: string | null; decidedAt: string | null; decidedBy: { id: string; name: string } | null } | null;
};
export type RoleDetail = RoleSummary & { currentPacketVersion: number | null; currentPacket: ({ version: number; status: string; packet: RolePacket } & PacketPayView) | null; proposedPacket: ({ version: number; status: string; changeSummary: string | null; createdAt: string; createdBy: { kind: string; id: string; name?: string }; packet: RolePacket } & PacketPayView) | null; packetVersions: Array<{ version: number; status: string; source: string; changeSummary: string | null; createdAt: string; createdBy: { kind: string; name?: string } }>; postings: Posting[]; boardsStillUp: string[]; acceptingApplications: boolean; applicationsClosedAt: string | null; applicationsClosedReason: string | null; volumeAlertPerDay: number | null; pendingApprovals: Array<{ id: string; actionType: string; rationale: string | null; proposal?: Record<string, unknown> }>; counts: Record<string, number>; packetApproval: PacketApproval; decisionMaker: DecisionMaker | null };
/** Where a requirement is checked; the contract's `evidencedBy` values. */
export type EvidenceSource = "resume" | "application" | "screen" | "interview";
export type Requirement = { key: string; text: string; rationale: string; evidencedBy: EvidenceSource[] };
export type RolePacket = {
  identity: { title: string; locations: Array<{ city?: string; region?: string }>; employmentType: string; schedule?: string; remotePolicy: "onsite" | "hybrid" | "remote" };
  business: { reason: string; reasonDetail?: string; timeline: { targetStartDate?: string; urgency: string } };
  compensation: { basis: string; min: number; mid?: number; max: number; ceiling: number; discloseRange: boolean; benefitsSummary?: string; sources: Array<{ name: string; detail?: string }>; ownerStated: boolean };
  description: { publicJobDescription: string; internalNotes?: string };
  requirements: { mustHaves: Requirement[]; niceToHaves: Requirement[]; eligibility: Array<{ key: string; type: string; question: string; rationale: string; knockout: boolean }> };
  competencies: Array<{ key: string; name: string; definition: string; weight: number; evaluatedIn: string }>;
  screening: { questions: Array<{ key: string; question: string; kind: string }>; maxMinutes: number };
  interviews: { plan: Array<{ key: string; title: string; purpose: string; durationMinutes: number; format: string; interviewerUserIds: string[]; interviewerRoles: string[]; competencyKeys: string[] }> };
  communication: { disclosureText: string; humanAlternativeText: string; signature: string };
  sourcing: { summary: string; channels: string[]; referralPrompt?: string };
  compliance: { jurisdictions: string[]; notices: string[] };
  preferences: { decisionMakerUserId?: string; decisionMakerName?: string; dealBreakersInTheirWords: string[]; whatFailureLooksLike?: string; schedulingWindows: string[]; interviewStyle?: string };
  provenance: { assumptions: string[]; sources: string[]; playbookId?: string };
};
/** GET and PATCH /roles/:id/interview-plan: the rounds with their interviewers by name, and the team they can be picked from. */
export type InterviewerView = { userId: string; name: string; email: string; role: string; schedulable: boolean };
export type InterviewPlanView = { version: number; status: string; rounds: Array<{ key: string; title: string; purpose: string; durationMinutes: number; format: string; interviewerRoles: string[]; interviewers: InterviewerView[] }>; team: InterviewerView[]; outcome?: "approved_current" | "proposed_pending_approval" | "proposed" };
/** GET /roles/:id/timeline: one event about the role, newest first. */
export type RoleEvent = { id: number; type: string; occurredAt: string; actor: { kind: string; id: string; name?: string }; subjectType: string; subjectId: string; payload: Record<string, unknown> };
/**
 * What the evidence says at a glance (GET /roles/:id/applications; mirrors `evidenceView` in packages/core): "needs a closer look"
 * is read off the latest assessment, never stored. The candidate page derives the same from the full detail (apps/web/src/evidence.ts).
 */
export type EvidenceView = { needsCloserLook: boolean; reason: string | null; assessmentUnavailable: boolean; resumeUnreadable: boolean; unknowns: string[]; unknownCount: number; topStrength: Finding | null; topConcern: Finding | null; confidenceReasons: string[]; /** The reading was made with low confidence: "Read this one yourself" (plan A8); older answers leave it out. */ lowConfidence?: boolean; /** A must-have the evidence shows, with a checked quote, is not met (plan A3); older answers leave it out. */ hasProvenMiss?: boolean };
export type Eligibility = { passed: boolean; failedRules: Array<{ key: string; question: string; reason: string }>; unverifiable: Array<{ key: string; question: string }> };
/**
 * What the list rows and the candidate panel share. `ownerStage` is where the person sits on the stage strip (founder
 * decision B3), private mark included; `stageMoves` is the stage button, every stage with whether it can be chosen now
 * and why not; `toldState` says, for a decision, whether the candidate was told (B6), and is null while there is none.
 */
type ApplicationCore = { id: string; stage: string; stageLabel: string; group: OwnerGroup | string; source: string; createdAt: string; eligibility: Eligibility | null; ownerStage: OwnerStage; ownerStageLabel: string; mark: ActiveMark | null; tags: string[]; stageMoves: StageMove[]; toldState: ToldState | null };
export type ApplicationSummary = ApplicationCore & {
  candidate: { id: string; name: string; email: string | null; phone: string | null; locationText: string | null } | null;
  extractionSummary: { positions: string[]; licenses: string[]; years: number | null; anomalies: Array<{ kind: string; detail: string }> } | null;
  assessment: { overall: string; confidence: string; summary: string; strengths: Array<{ claim: string; evidence: { source: string } }>; concerns: Array<{ claim: string; evidence: { source: string } }> } | null;
  /** On the list only; the detail derives it on the page. */
  evidence?: EvidenceView;
  /** When they applied and when their step last changed, as full times; `daysInStage` counts whole days since. */
  appliedAt: string;
  stageChangedAt: string;
  daysInStage: number;
  candidateToldAt: string | null;
  /** The decision message waits for someone to approve it. */
  decisionMessageWaiting: boolean;
};
/** GET /roles/:id/applications?counts=1: the stage strip's counts cover every applicant the caller may see, whatever the filters. */
export type StageStripCounts = { total: number; byOwnerStage: Record<OwnerStage, number>; byGroup: Record<OwnerGroup, number>; notTold: number; holdsEnded: number };
export type ApplicationsWithCounts = { applications: ApplicationSummary[]; counts: StageStripCounts };
/** Where a claim came from. `unquoted`: a claim about the candidate with nothing verified quoted from them (packages/agents/src/triage.ts), shown as "no quote". */
export type EvidenceRef = { source: string; quote?: string; unquoted?: boolean };
export type Finding = { claim: string; evidence: EvidenceRef };
export type AssessmentResult = {
  summary: string; strengths: Finding[]; concerns: Finding[]; unknowns: Array<{ question: string; whyItMatters: string }>; rationale: string; recommendation: string;
  /** What drives the confidence level, in plain words (older assessments have none). */
  confidenceReasons?: string[];
  requirementFindings?: Array<{ requirementKey: string; met: string; evidence?: EvidenceRef }>;
  competencyFindings?: Array<{ competencyKey: string; finding: string; evidence?: EvidenceRef; note?: string }>;
  anomalies?: Array<{ kind: string; detail: string }>;
  questionFindings?: Array<{ questionKey: string; answered: boolean; finding: string; evidence?: { source: string; quote?: string }; meetsModelAnswer: string }>;
  compensationExpectation?: { stated?: string; withinRange: string };
  availability?: { stated?: string; matchesSchedule: string; earliestStart?: string };
  eligibilityConfirmations?: Array<{ key: string; confirmed: string; quote?: string }>;
};
export type Screen = { id: string; channel: string; status: string; invitedAt: string | null; startedAt: string | null; completedAt: string | null; remindedAt: string | null; transcript: Array<{ role: string; content: string; at: string; questionKey?: string; channel?: string }>; answers: Record<string, string>; progress: { askedKeys: string[]; currentQuestionKey: string | null; /** "Ask about this in a screen": the open questions the screen started with, each with its answer once given. */ focusQuestions?: Array<{ key: string; question: string; whyItMatters?: string; answer?: string }> }; assessmentId: string | null; /** The scorecard's state on the candidate page (apps/api/src/services/screen-scorecards.ts); `recruiterAsked` once ITS has the failed one. */ scorecard?: "ready" | "writing" | "unavailable" | "none"; recruiterAsked?: boolean };
export type Notification = { id: string; kind: string; title: string; body: string; action: { label: string; href: string } | null; readAt: string | null; createdAt: string };
/** The full history of updates and each person's email alert settings (plan B3); the shapes live in @ros/contracts. */
export type { NotificationHistoryPage, NotificationPreferencesView, NotificationView, NotifyCadence, NotifyGroup } from "@ros/contracts";
/**
 * What a Send of the decision message does under the company's settings (`declineMessagePolicy` in
 * apps/api/src/services/application-actions.ts): it goes, waits for approval, or is not sent. Declining itself sends nothing.
 */
export type DeclineMessagePolicy = "sends" | "needs_approval" | "not_sent";
/**
 * POST /applications/:id/actions. `candidateNotice` says what became of the candidate's message (`not_told` for every
 * decision, hold and mark); `ownerStage` and `mark` are where the person now sits on the stage strip; `next` is the API's
 * own sentence about what follows.
 */
export type ActionResult = { ok: true; stage: string; ownerStage?: OwnerStage; mark?: ActiveMark | null; toldState?: ToldState; dispositionSent?: boolean; candidateNotice?: CandidateNotice; approvalRequestId?: string; workflowRunId?: string; next?: string; /** A move to the talent pool for someone who asked not to be kept for future roles: they stay out of it. */ talentPoolOptOut?: boolean; /** Interviews a private decision called off. */ interviewsCancelled?: number; /** How many of them the candidate was told about at once, in a short note with no reason (they had a booked time or times to pick from); the decision itself stays private. */ interviewOffNotes?: number };
/** What may be done with the application right now; the API decides, the page only shows (see apps/api/src/services/application-actions.ts). */
export type ApplicationCapability = "invite_screen" | "ask_in_screen" | "interview" | "advance_to_interview" | "hold" | "reject" | "move_to_talent_pool" | "override_eligibility" | "review_anyway" | "record_decision" | "record_outcome" | "set_mark" | "clear_mark" | "send_decision" | "told_in_person" | "cancel_screen";
/** GET /applications/:id/decision-message: the exact words a Send would send, to whom, and what the Send does under the company's settings. */
export type DecisionMessagePreview = { to: string | null; subject: string; text: string; wording: "eligibility" | "human"; policy: DeclineMessagePolicy; toldState: ToldState; candidateToldAt: string | null; waitingApproval: boolean };
/** POST /roles/:id/decision-messages: one result per person, so one refusal never hides the others. */
export type DecisionMessageResult = { applicationId: string; ok: boolean; candidateNotice?: CandidateNotice; toldState?: ToldState; code?: string; message?: string };
/** `held`: saved to go out on their own once ITS confirms the company (founder decision B7). */
export type DecisionMessagesResponse = { results: DecisionMessageResult[]; queued: number; held?: number; waitingApproval: number; notSent: number };
export type TimelineEvent = { type: string; occurredAt: string; actor: { kind: string; name?: string; id: string }; payload: Record<string, unknown> };
export type ApplicationDetail = ApplicationCore & { roleId: string; stageChangedAt: string; candidateToldAt: string | null; allowedActions: ApplicationCapability[]; /** Why each choice not in `allowedActions` is unavailable, in plain words; shown on the disabled button. */ blockedReasons: Partial<Record<ApplicationCapability, string>>; /** What a Send of the decision message does under the company's settings: it goes, waits for approval, or is not sent. */ declineMessage: DeclineMessagePolicy; rejectReason: string | null; rejectNote: string | null; interviews: Array<{ id: string; roundKey: string; title: string; status: string; startsAt: string | null; endsAt: string | null; timezone: string | null; meetingUrl: string | null; attempt: number; outcome: string | null; decision: string | null; offeredSlots: OfferedSlot[]; createdAt: string }>; interviewPlan: Array<{ key: string; title: string; durationMinutes: number; format: string; interviewerUserIds: string[]; purpose: string }>; candidate: { firstName: string; lastName: string; email: string | null; phone: string | null; locationText: string | null; consent: Record<string, { granted: boolean; at: string; source: string }>; /** `talentPoolOptOut`: the person asked not to be kept for future roles. */ preferences?: { talentPoolOptOut?: boolean } }; documents: Array<{ id: string; kind: string; filename: string; hasText: boolean; sizeBytes: number; status: "quarantined" | "clean" | "rejected" | "deleted" | string; uploadedVia: string; rejectedReason: string | null; validatedAt: string | null }>; assessments: Array<{ id: string; kind: string; overall: string; confidence: string; createdAt: string; result: AssessmentResult }>; screens: Screen[]; /** `proposal` carries a waiting message's text (F11); `requiredRoles` says who may decide it, so the page offers the buttons only to them. */ pendingApprovals: Array<{ id: string; actionType: string; rationale: string | null; createdAt: string; proposal?: Record<string, unknown>; requiredRoles: string[] }>; packetLabels: { mustHaves: Array<{ key: string; text: string }>; competencies: Array<{ key: string; name: string }>; questions: Array<{ key: string; question: string }> }; communications: Array<{ id: string; direction: string; channel: string; subject: string | null; bodyText: string; status: string; createdAt: string; templateKey: string | null }>; timeline: TimelineEvent[]; extraction: { positions: Array<{ title: string; employer?: string; startDate?: string; endDate?: string; quote?: string }>; licenses: Array<{ name: string; jurisdiction?: string; quote?: string }>; certifications: Array<{ name: string }>; skills: string[]; yearsOfExperienceEstimate?: number; anomalies: Array<{ kind: string; detail: string }> } | null; answers: { eligibility?: Record<string, unknown>; noResume?: Record<string, string> } };
export type IntakeSession = { id: string; status: string; messages: Array<{ role: "owner" | "assistant" | "system"; content: string; at: string }>; facts: Record<string, unknown>; missingFacts: string[]; roleId: string | null };

// The job builder (plan Wave C): apps/api/src/routes/intake.ts. The shapes live in @ros/contracts.
export type { IntakeQuestion, IntakeSessionSummary, IntakeSessionView, PacketFlag, PlanRoom } from "@ros/contracts";
/** A "Bring in a recruiter" the server offers on a failed turn, with the draft attached (C12). */
export type IntakeProposedAction = { kind: string; label: string; method?: string; path: string; body?: Record<string, unknown> };
/** The assistant's turn as the builder reads it, or what went wrong and what to do next. */
export type IntakeTurnReply = { assistantMessage?: string; readyToCompile?: boolean; takenFromAd?: string[]; notARole?: boolean; error?: string; recovery?: string; proposedActions?: IntakeProposedAction[] };
/** POST /intake/sessions: the new draft and its first turn; `session` is null when the message was not about a role. */
export type IntakeStartResponse = { session: IntakeSessionView | null; notARole?: boolean; reply: IntakeTurnReply | null };
/** POST /intake/sessions/:id/messages and /answers: the draft as it now stands, the next turn (none for a quiet edit), and anything refused. */
export type IntakeTurnResponse = { session: IntakeSessionView; reply: IntakeTurnReply | null; refused?: Array<{ field: string; text: string; reason: string; alternative: string | null }>; summary?: string[] };
/** POST /intake/sessions/:id/request-approval: the role it created and the version waiting for approval. */
export type IntakeApprovalResponse = { roleId: string; version: number; workflowRunId: string | null };

export type OfferedSlot = { id: string; startsAt: string; endsAt: string; interviewerUserIds: string[]; source: "calendar" | "declared" };
export type InterviewSummary = {
  id: string; applicationId: string; roleId: string; roleTitle: string | null; roundKey: string; title: string; format: string; durationMinutes: number; status: string;
  startsAt: string | null; endsAt: string | null; timezone: string | null; meetingUrl: string | null; linkSource: string; attempt: number; offeredSlots: OfferedSlot[]; selectedSlot: OfferedSlot | null;
  candidateAvailability: { timezone?: string; note?: string; accessibilityNote?: string; at?: string } | null; schedulingWindow: { fromDate?: string; toDate?: string; businessDaysOnly?: boolean; candidateTimezone?: string };
  rescheduleCountCandidate: number; outcome: string | null; decision: string | null; decisionNote: string | null; reminders: Record<string, string>; cancelReason: string | null; scheduleTokenExpiresAt: string | null; createdAt: string;
  candidate: { firstName: string; lastName: string; timezone: string | null; stage: string; stageLabel: string };
  participants: Array<{ userId: string; name: string | null; email: string; status: string }>;
  calendarRefs: Record<string, { provider: string; eventId: string; htmlLink: string | null; meetingUrl: string | null }>;
};
// Postings (docs/spec/20): what the Posting tab reads and writes (apps/api/src/routes/postings.ts).
export type ApplicationLink = { id: string; url: string; source: string; sourceLabel: string; sourceDetail: string | null; label: string; postingId: string | null; visits: number; lastVisitedAt: string | null; createdAt: string; disabledAt: string | null };
export type PostingPackage = { text: string; fields: Record<string, string> };
export type PostingView = Posting & { name: string; stateLabel: string; isBoard: boolean; link: ApplicationLink | null; package: PostingPackage | null; stillUp: boolean };
export type PostingsResponse = { role: { id: string; title: string; status: string; acceptingApplications: boolean; applicationsClosedAt: string | null; applicationsClosedReason: string | null; volumeAlertPerDay: number }; urls: { careers: string; job: string; apply: string }; emailIn: { address: string | null; connected: boolean; status: string | null; error: string | null }; postings: PostingView[]; links: ApplicationLink[]; boardsStillUp: string[] };
export type VolumeDay = { day: string; total: number; bySource: Record<string, number> };
export type VolumeReport = { from: string; to: string; timeZone: string; days: VolumeDay[]; totals: { total: number; bySource: Record<string, number> }; sources: Array<{ source: string; label: string; total: number }>; threshold: number; yesterday: { day: string; total: number }; today: { day: string; total: number }; acceptingApplications: boolean; applicationsClosedAt: string | null; applicationsClosedReason: string | null };

export type InterviewDetail = InterviewSummary & { timeline: Array<{ type: string; occurredAt: string; actor: { kind: string; name?: string; id: string }; payload: Record<string, unknown> }>; availabilitySources: Array<{ userId: string; source: "calendar" | "declared" | "none"; calendarStatus: string | null }>; brief: InterviewerBrief | null };
/** The interviewer's brief (F7, F8): what the round is for, what it covers, what the evidence says so far. `pay` is present only for roles that may see it (packages/agents/src/interviewer-brief.ts). */
export type InterviewerBrief = {
  candidateFirstName: string;
  round: { key: string; title: string; purpose: string; durationMinutes: number; format: string };
  competencies: Array<{ key: string; name: string; definition: string; indicators: string[]; finding: string | null; note: string | null }>;
  questions: string[];
  mustHaves: Array<{ key: string; text: string; met: string; quote: string | null; source: string | null }>;
  strengths: Array<{ claim: string; quote: string | null; source: string | null }>;
  concerns: Array<{ claim: string; quote: string | null; source: string | null }>;
  screen: { completedAt: string | null; answers: Array<{ question: string; answer: string }> } | null;
  pay: { expectation: string | null; withinRange: string } | null;
  includesPay: boolean;
};
// Writing to a candidate (F11) and hearing back (F12): apps/api/src/routes/messages.ts.
export type MessagePreview = { to: string | null; candidateFirstName: string; fromName: string; footer: string; repliesComeBack: boolean; policyLevel: string; needsApproval: boolean };
/** `held`: saved, and it goes out on its own once ITS confirms the company (founder decision B7). */
export type SendMessageResult = { ok: true; status: "queued" | "held"; communicationId: string } | { ok: true; status: "pending_approval"; approvalRequestId: string };
// The comparison view (F10): GET /roles/:id/compare?ids=a,b,c (apps/api/src/routes/compare.ts). Nothing ranked; columns in the order chosen.
export type CompareCandidate = { applicationId: string; name: string; stage: string; stageLabel: string; group: string; ownerStage?: OwnerStage; ownerStageLabel?: string; mustHaves: Record<string, { met: string; quote: string | null }>; competencies: Record<string, { finding: string; note: string | null }>; screen: { recommendation: string; summary: string } | null; resume: { overall: string; recommendation: string; summary: string } | null; unknownCount: number; open: string };
export type CompareResponse = { role: { id: string; title: string }; mustHaves: Array<{ key: string; text: string }>; competencies: Array<{ key: string; name: string; definition: string }>; candidates: CompareCandidate[]; max: number; reminder: string };
export type MyCalendar = { connection: { id: string; provider: string; status: string; externalAccountId: string | null; connectedAt: string | null; lastError: string | null; disconnectedAt: string | null; credentialsDeleted: boolean } | null; availability: { timezone: string; windows: Array<{ day: number; start: string; end: string }>; bufferMinutes: number; maxPerDay: number; updatedAt: string } | null; providers: Array<{ key: string; status: string }> };
