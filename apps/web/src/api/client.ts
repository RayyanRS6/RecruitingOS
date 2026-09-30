import type { MeResponse } from "@ros/contracts";

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

export type BriefCard = { kind: string; title: string; body: string; roleId?: string; applicationId?: string; approvalRequestId?: string; actions: Array<{ label: string; method: "GET" | "POST"; path: string; body?: Record<string, unknown> }> };
export type Brief = { generatedAt: string; cards: BriefCard[]; summary: string };

export type RoleSummary = { id: string; title: string; status: string; openedAt: string | null; counts: Record<string, number> & { total: number }; needsYou: number; daysOpen: number | null };
/** One role on one channel, with the nine-state fields (docs/spec/20). `status` is one of the nine posting states; `stateLabel` on PostingView is the owner's word for it. */
export type Posting = { id: string; channel: string; status: string; externalUrl: string | null; intakeToken: string | null; instructions: string | null; steps: string[]; error: string | null; publishedAt: string | null; publicUrlRecordedAt: string | null; verifiedAt: string | null; verifiedBy: { kind: string; id: string; name?: string } | null; verificationNote: string | null; verificationError: string | null; verificationAttempts: number; pausedAt: string | null; closedAt: string | null; closureRequired: boolean; closureConfirmedAt: string | null; closureConfirmedBy: { kind: string; id: string; name?: string } | null };
/** A team member as the decision maker of a role packet (matched from the packet's preferences to an active approver). */
export type DecisionMaker = { userId: string; name: string | null; email: string };
/** The packet approval on a role: what waits, what the signed-in person may do about it, and how a sent-back role got there. */
export type PacketApproval = {
  pending: { id: string; version: number; rationale: string | null; requestedBy: { kind: string; id: string; name?: string }; requiredRoles: string[]; requiredUserIds: string[]; decisionMaker: DecisionMaker | null; createdAt: string; expiresAt: string | null; editWhileOpen: boolean; viewer: { mayDecide: boolean; reason: string | null } } | null;
  latest: { id: string; status: string; version: number; decisionNote: string | null; decidedAt: string | null; decidedBy: { id: string; name: string } | null } | null;
};
export type RoleDetail = RoleSummary & { currentPacketVersion: number | null; currentPacket: { version: number; status: string; packet: RolePacket } | null; proposedPacket: { version: number; status: string; changeSummary: string | null; createdAt: string; createdBy: { kind: string; id: string; name?: string }; packet: RolePacket } | null; packetVersions: Array<{ version: number; status: string; source: string; changeSummary: string | null; createdAt: string; createdBy: { kind: string; name?: string } }>; postings: Posting[]; boardsStillUp: string[]; acceptingApplications: boolean; applicationsClosedAt: string | null; applicationsClosedReason: string | null; volumeAlertPerDay: number | null; pendingApprovals: Array<{ id: string; actionType: string; rationale: string | null; proposal?: Record<string, unknown> }>; counts: Record<string, number>; packetApproval: PacketApproval; decisionMaker: DecisionMaker | null };
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
export type EvidenceView = { needsCloserLook: boolean; reason: string | null; assessmentUnavailable: boolean; resumeUnreadable: boolean; unknowns: string[]; unknownCount: number; topStrength: Finding | null; topConcern: Finding | null; confidenceReasons: string[] };
export type ApplicationSummary = { id: string; stage: string; stageLabel: string; group: string; source: string; createdAt: string; candidate: { id: string; name: string; email: string | null; phone: string | null; locationText: string | null } | null; eligibility: { passed: boolean; failedRules: Array<{ key: string; question: string; reason: string }>; unverifiable: Array<{ key: string; question: string }> } | null; extractionSummary: { positions: string[]; licenses: string[]; years: number | null; anomalies: Array<{ kind: string; detail: string }> } | null; assessment: { overall: string; confidence: string; summary: string; strengths: Array<{ claim: string; evidence: { source: string } }>; concerns: Array<{ claim: string; evidence: { source: string } }> } | null; /** On the list only; the detail derives it on the page. */ evidence?: EvidenceView };
export type Finding = { claim: string; evidence: { source: string; quote?: string } };
export type AssessmentResult = {
  summary: string; strengths: Finding[]; concerns: Finding[]; unknowns: Array<{ question: string; whyItMatters: string }>; rationale: string; recommendation: string;
  /** What drives the confidence level, in plain words (older assessments have none). */
  confidenceReasons?: string[];
  requirementFindings?: Array<{ requirementKey: string; met: string; evidence?: { source: string; quote?: string } }>;
  competencyFindings?: Array<{ competencyKey: string; finding: string; evidence?: { source: string; quote?: string }; note?: string }>;
  anomalies?: Array<{ kind: string; detail: string }>;
  questionFindings?: Array<{ questionKey: string; answered: boolean; finding: string; evidence?: { source: string; quote?: string }; meetsModelAnswer: string }>;
  compensationExpectation?: { stated?: string; withinRange: string };
  availability?: { stated?: string; matchesSchedule: string; earliestStart?: string };
  eligibilityConfirmations?: Array<{ key: string; confirmed: string; quote?: string }>;
};
export type Screen = { id: string; channel: string; status: string; invitedAt: string | null; startedAt: string | null; completedAt: string | null; remindedAt: string | null; transcript: Array<{ role: string; content: string; at: string; questionKey?: string; channel?: string }>; answers: Record<string, string>; progress: { askedKeys: string[]; currentQuestionKey: string | null; /** "Ask about this in a screen": the open questions the screen started with, each with its answer once given. */ focusQuestions?: Array<{ key: string; question: string; whyItMatters?: string; answer?: string }> }; assessmentId: string | null };
export type Notification = { id: string; kind: string; title: string; body: string; action: { label: string; href: string } | null; readAt: string | null; createdAt: string };
/** What may be done with the application right now; the API decides, the page only shows (see apps/api/src/services/application-actions.ts). */
export type ApplicationCapability = "invite_screen" | "ask_in_screen" | "interview" | "advance_to_interview" | "hold" | "reject" | "move_to_talent_pool" | "override_eligibility" | "review_anyway" | "record_decision" | "record_outcome";
export type ApplicationDetail = ApplicationSummary & { allowedActions: ApplicationCapability[]; rejectReason: string | null; rejectNote: string | null; interviews: Array<{ id: string; roundKey: string; title: string; status: string; startsAt: string | null; endsAt: string | null; timezone: string | null; meetingUrl: string | null; attempt: number; outcome: string | null; decision: string | null; offeredSlots: OfferedSlot[]; createdAt: string }>; interviewPlan: Array<{ key: string; title: string; durationMinutes: number; format: string; interviewerUserIds: string[]; purpose: string }>; candidate: { firstName: string; lastName: string; email: string | null; phone: string | null; locationText: string | null; consent: Record<string, { granted: boolean; at: string; source: string }> }; documents: Array<{ id: string; kind: string; filename: string; hasText: boolean; sizeBytes: number; status: "quarantined" | "clean" | "rejected" | "deleted" | string; uploadedVia: string; rejectedReason: string | null; validatedAt: string | null }>; assessments: Array<{ id: string; kind: string; overall: string; confidence: string; createdAt: string; result: AssessmentResult }>; screens: Screen[]; /** `proposal` carries a waiting message's text (F11); `requiredRoles` says who may decide it, so the page offers the buttons only to them. */ pendingApprovals: Array<{ id: string; actionType: string; rationale: string | null; createdAt: string; proposal?: Record<string, unknown>; requiredRoles: string[] }>; packetLabels: { mustHaves: Array<{ key: string; text: string }>; competencies: Array<{ key: string; name: string }>; questions: Array<{ key: string; question: string }> }; communications: Array<{ id: string; direction: string; channel: string; subject: string | null; bodyText: string; status: string; createdAt: string; templateKey: string | null }>; timeline: Array<{ type: string; occurredAt: string; actor: { kind: string; name?: string; id: string }; payload: Record<string, unknown> }>; extraction: { positions: Array<{ title: string; employer?: string; startDate?: string; endDate?: string; quote?: string }>; licenses: Array<{ name: string; jurisdiction?: string; quote?: string }>; certifications: Array<{ name: string }>; skills: string[]; yearsOfExperienceEstimate?: number; anomalies: Array<{ kind: string; detail: string }> } | null; answers: { eligibility?: Record<string, unknown>; noResume?: Record<string, string> } };
export type IntakeSession = { id: string; status: string; messages: Array<{ role: "owner" | "assistant" | "system"; content: string; at: string }>; facts: Record<string, unknown>; missingFacts: string[]; roleId: string | null };

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
export type SendMessageResult = { ok: true; status: "queued"; communicationId: string } | { ok: true; status: "pending_approval"; approvalRequestId: string };
// The comparison view (F10): GET /roles/:id/compare?ids=a,b,c (apps/api/src/routes/compare.ts). Nothing ranked; columns in the order chosen.
export type CompareCandidate = { applicationId: string; name: string; stage: string; stageLabel: string; group: string; mustHaves: Record<string, { met: string; quote: string | null }>; competencies: Record<string, { finding: string; note: string | null }>; screen: { recommendation: string; summary: string } | null; resume: { overall: string; recommendation: string; summary: string } | null; unknownCount: number; open: string };
export type CompareResponse = { role: { id: string; title: string }; mustHaves: Array<{ key: string; text: string }>; competencies: Array<{ key: string; name: string; definition: string }>; candidates: CompareCandidate[]; max: number; reminder: string };
export type MyCalendar = { connection: { id: string; provider: string; status: string; externalAccountId: string | null; connectedAt: string | null; lastError: string | null; disconnectedAt: string | null; credentialsDeleted: boolean } | null; availability: { timezone: string; windows: Array<{ day: number; start: string; end: string }>; bufferMinutes: number; maxPerDay: number; updatedAt: string } | null; providers: Array<{ key: string; status: string }> };
