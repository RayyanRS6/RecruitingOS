/** Typed-enough fetch wrapper. Same-origin in dev via the Vite proxy; VITE_API_URL in production. */
// Vite injects import.meta.env; inside the Next.js shell (D20) the API is same-origin and the variable is absent.
const BASE = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_API_URL ?? "";
/** For plain links to API routes that answer with a file or a redirect (a résumé download). */
export const API_BASE = BASE;

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(body !== undefined && !(body instanceof FormData) ? { "content-type": "application/json" } : {}), ...((init.headers as Record<string, string>) ?? {}) };
  const res = await fetch(`${BASE}${path}`, { method, credentials: "include", headers, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body), ...init });
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

export type Me = {
  user: { id: string; email: string; name: string | null; platformRole: string };
  memberships: Array<{ companyId: string; companyName: string; companySlug: string; role: string }>;
  activeCompanyId: string | null;
  /** Present when an ITS recruiter is inside a customer under a scoped, time-limited grant. */
  staffAccess?: { grantId: string; kind: string; purpose: string; expiresAt: string; companyName: string | null; scope: { escalationId: string | null; roleId: string | null; applicationId: string | null } } | null;
  ai: { provider: string };
};

export type BriefCard = { kind: string; title: string; body: string; roleId?: string; applicationId?: string; approvalRequestId?: string; actions: Array<{ label: string; method: "GET" | "POST"; path: string; body?: Record<string, unknown> }> };
export type Brief = { generatedAt: string; cards: BriefCard[]; summary: string };

export type RoleSummary = { id: string; title: string; status: string; openedAt: string | null; counts: Record<string, number> & { total: number }; needsYou: number; daysOpen: number | null };
export type Posting = { id: string; channel: string; status: string; externalUrl: string | null; intakeToken: string | null; instructions: string | null; error: string | null };
export type RoleDetail = RoleSummary & { currentPacketVersion: number | null; currentPacket: { version: number; status: string; packet: RolePacket } | null; packetVersions: Array<{ version: number; status: string; source: string; changeSummary: string | null; createdAt: string; createdBy: { kind: string; name?: string } }>; postings: Posting[]; pendingApprovals: Array<{ id: string; actionType: string; rationale: string | null }>; counts: Record<string, number> };
export type RolePacket = {
  identity: { title: string; locations: Array<{ city?: string; region?: string }>; employmentType: string; schedule?: string; remotePolicy: string };
  business: { reason: string; reasonDetail?: string; timeline: { targetStartDate?: string; urgency: string } };
  compensation: { basis: string; min: number; mid?: number; max: number; ceiling: number; discloseRange: boolean; benefitsSummary?: string; sources: Array<{ name: string; detail?: string }>; ownerStated: boolean };
  description: { publicJobDescription: string; internalNotes?: string };
  requirements: { mustHaves: Array<{ key: string; text: string; rationale: string }>; niceToHaves: Array<{ key: string; text: string; rationale: string }>; eligibility: Array<{ key: string; type: string; question: string; rationale: string; knockout: boolean }> };
  competencies: Array<{ key: string; name: string; definition: string; weight: number; evaluatedIn: string }>;
  screening: { questions: Array<{ key: string; question: string; kind: string }>; maxMinutes: number };
  interviews: { plan: Array<{ key: string; title: string; purpose: string; durationMinutes: number; format: string; interviewerRoles: string[]; competencyKeys: string[] }> };
  communication: { disclosureText: string; humanAlternativeText: string; signature: string };
  sourcing: { summary: string; channels: string[]; referralPrompt?: string };
  compliance: { jurisdictions: string[]; notices: string[] };
  provenance: { assumptions: string[]; sources: string[]; playbookId?: string };
};
export type ApplicationSummary = { id: string; stage: string; stageLabel: string; group: string; source: string; createdAt: string; candidate: { id: string; name: string; email: string | null; phone: string | null; locationText: string | null } | null; eligibility: { passed: boolean; failedRules: Array<{ key: string; question: string; reason: string }>; unverifiable: Array<{ key: string; question: string }> } | null; extractionSummary: { positions: string[]; licenses: string[]; years: number | null; anomalies: Array<{ kind: string; detail: string }> } | null; assessment: { overall: string; confidence: string; summary: string; strengths: Array<{ claim: string; evidence: { source: string } }>; concerns: Array<{ claim: string; evidence: { source: string } }> } | null };
export type Finding = { claim: string; evidence: { source: string; quote?: string } };
export type AssessmentResult = {
  summary: string; strengths: Finding[]; concerns: Finding[]; unknowns: Array<{ question: string; whyItMatters: string }>; rationale: string; recommendation: string;
  requirementFindings?: Array<{ requirementKey: string; met: string; evidence?: { source: string; quote?: string } }>;
  competencyFindings?: Array<{ competencyKey: string; finding: string; evidence?: { source: string; quote?: string }; note?: string }>;
  anomalies?: Array<{ kind: string; detail: string }>;
  questionFindings?: Array<{ questionKey: string; answered: boolean; finding: string; evidence?: { source: string; quote?: string }; meetsModelAnswer: string }>;
  compensationExpectation?: { stated?: string; withinRange: string };
  availability?: { stated?: string; matchesSchedule: string; earliestStart?: string };
  eligibilityConfirmations?: Array<{ key: string; confirmed: string; quote?: string }>;
};
export type Screen = { id: string; channel: string; status: string; invitedAt: string | null; startedAt: string | null; completedAt: string | null; remindedAt: string | null; transcript: Array<{ role: string; content: string; at: string; questionKey?: string; channel?: string }>; answers: Record<string, string>; progress: { askedKeys: string[]; currentQuestionKey: string | null }; assessmentId: string | null };
export type Notification = { id: string; kind: string; title: string; body: string; action: { label: string; href: string } | null; readAt: string | null; createdAt: string };
export type ApplicationDetail = ApplicationSummary & { rejectReason: string | null; rejectNote: string | null; interviews: Array<{ id: string; roundKey: string; title: string; status: string; startsAt: string | null; endsAt: string | null; timezone: string | null; meetingUrl: string | null; attempt: number; outcome: string | null; decision: string | null; offeredSlots: OfferedSlot[]; createdAt: string }>; interviewPlan: Array<{ key: string; title: string; durationMinutes: number; format: string; interviewerUserIds: string[]; purpose: string }>; candidate: { firstName: string; lastName: string; email: string | null; phone: string | null; locationText: string | null; consent: Record<string, { granted: boolean; at: string; source: string }> }; documents: Array<{ id: string; kind: string; filename: string; hasText: boolean; sizeBytes: number; status: "quarantined" | "clean" | "rejected" | "deleted" | string; uploadedVia: string; rejectedReason: string | null; validatedAt: string | null }>; assessments: Array<{ id: string; kind: string; overall: string; confidence: string; createdAt: string; result: AssessmentResult }>; screens: Screen[]; pendingApprovals: Array<{ id: string; actionType: string; rationale: string | null; createdAt: string }>; packetLabels: { mustHaves: Array<{ key: string; text: string }>; competencies: Array<{ key: string; name: string }>; questions: Array<{ key: string; question: string }> }; communications: Array<{ id: string; direction: string; channel: string; subject: string | null; bodyText: string; status: string; createdAt: string; templateKey: string | null }>; timeline: Array<{ type: string; occurredAt: string; actor: { kind: string; name?: string; id: string }; payload: Record<string, unknown> }>; extraction: { positions: Array<{ title: string; employer?: string; startDate?: string; endDate?: string; quote?: string }>; licenses: Array<{ name: string; jurisdiction?: string; quote?: string }>; certifications: Array<{ name: string }>; skills: string[]; yearsOfExperienceEstimate?: number; anomalies: Array<{ kind: string; detail: string }> } | null; answers: { eligibility?: Record<string, unknown>; noResume?: Record<string, string> } };
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
export type InterviewDetail = InterviewSummary & { timeline: Array<{ type: string; occurredAt: string; actor: { kind: string; name?: string; id: string }; payload: Record<string, unknown> }>; availabilitySources: Array<{ userId: string; source: "calendar" | "declared" | "none"; calendarStatus: string | null }> };
export type MyCalendar = { connection: { id: string; provider: string; status: string; externalAccountId: string | null; connectedAt: string | null; lastError: string | null; disconnectedAt: string | null; credentialsDeleted: boolean } | null; availability: { timezone: string; windows: Array<{ day: number; start: string; end: string }>; bufferMinutes: number; maxPerDay: number; updatedAt: string } | null; providers: Array<{ key: string; status: string }> };
