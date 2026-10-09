import type { ActiveMark, AutoActionsOnOpen, BoardChoiceView, BoardPlacement, CandidateNotice, ClosingDateView, DecisionMessagePreview, DecisionWording, GettingStarted, Importance, IntakeSessionView, LegalCheck, MatchBand, MatchScore, MeResponse, MustHaveSummary, NextStep, NoteView, OwnerGroup, OwnerStage, PacketFlag, PoolSummary, PostingTaskKind, PostingTaskView, PublishingState, ReadingVersion, ShareTarget, ShareView, StageMove, ToldState } from "@ros/contracts";

export type { ActiveMark, CandidateNotice, OwnerStage, StageMove, ToldState };
// Telling candidates (plan Wave G; founder decisions B6, Q27, Q28, Q30) and interviews to hire (Wave H; Q24, Q29): the
// shapes live in @ros/contracts (api/index.ts and api/hiring.ts), as the API answers them.
export type { ClosingMessagePreview, ClosingMessageResult, DecisionMessagePreview, DecisionWording, DecisionWordingOption, HireFollowUp, InterviewDraft, NoteStarter, NoteView, NotesView, OfferMadeResult, SuggestedLine } from "@ros/contracts";
// The match score, the pool board, Review and apply and the one-click questions (plan Wave F; founder decisions B2, B4,
// B5): the shapes live in @ros/contracts (domain/match.ts, api/board.ts), as the API answers them.
export type { BatchAction, BatchPreview, BatchPreviewItem, BatchResult, BatchResultItem, BoardCard, BoardColumn, BoardPlacement, BoardQuote, BoardView, MatchBand, MatchCriterion, MatchScore, MustHaveSummary, NextStep, PoolAnswer, PoolAnswerPerson, PoolQuestion, PoolQuestionKind, PoolSummary, ReadingVersion, RoleBatchItem, RoleBatchRequest } from "@ros/contracts";
// Approving and publishing (plan Wave D): the shapes live in @ros/contracts (api/publishing.ts).
export type { AutoActionsOnOpen, BoardChoiceView, ClosingDateView, LegalCheck, LegalCheckItem, PostingTaskKind, PostingTaskView, PublishingState, SharePlace, SharePlaceView, ShareTarget, ShareView } from "@ros/contracts";
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
  delete: <T>(path: string) => request<T>("DELETE", path),
};

/** The signed-in person, exactly as the API answers it (the shape lives in @ros/contracts so the two cannot drift). */
export type Me = MeResponse;

/**
 * `gettingStarted`: only on the getting_started card, the ITS company check and the steps this person can do (plan B1, B2).
 * `pool`: only on the pool_ready card, the pool board's summary for the role, the same as above the board (plan F7).
 */
export type BriefCard = { kind: string; title: string; body: string; roleId?: string; applicationId?: string; approvalRequestId?: string; actions: Array<{ label: string; method: "GET" | "POST"; path: string; body?: Record<string, unknown> }>; gettingStarted?: GettingStarted; pool?: PoolSummary };
export type Brief = { generatedAt: string; cards: BriefCard[]; summary: string };

/**
 * `countsHidden`: the list was read by an interviewer, so it holds only the roles they interview for and no applicant counts.
 * `counts` is by owner group (a running hold waits on nobody); `stageCounts` is the stage strip, private marks included.
 */
export type RoleSummary = { id: string; title: string; status: string; openedAt: string | null; createdAt?: string; counts: Record<string, number> & { total: number }; stageCounts?: Record<OwnerStage, number>; countsHidden?: boolean; needsYou: number; daysOpen: number | null };
/** One role on one channel, with the nine-state fields (docs/spec/20). `status` is one of the nine posting states; `stateLabel` on PostingView is the owner's word for it. */
export type Posting = { id: string; channel: string; status: string; externalUrl: string | null; intakeToken: string | null; instructions: string | null; steps: string[]; error: string | null; publishedAt: string | null; publicUrlRecordedAt: string | null; verifiedAt: string | null; verifiedBy: { kind: string; id: string; name?: string } | null; verificationNote: string | null; verificationError: string | null; verificationAttempts: number; pausedAt: string | null; closedAt: string | null; closureRequired: boolean; closureConfirmedAt: string | null; closureConfirmedBy: { kind: string; id: string; name?: string } | null; /** The packet version a board listing shows (plan D4); null until it is posted. */ boardVersion?: number | null };
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
  /** `legalCheck`: what the law of the job's places asks of the ad (plan D5); approving waits while `missing` has anything. */
  pending: { id: string; version: number; rationale: string | null; requestedBy: { kind: string; id: string; name?: string }; requiredRoles: string[]; requiredUserIds: string[]; decisionMaker: DecisionMaker | null; createdAt: string; expiresAt: string | null; editWhileOpen: boolean; flags: PacketFlag[]; legalCheck?: LegalCheck | null; viewer: { mayDecide: boolean; maySendBack: boolean; reason: string | null } } | null;
  latest: { id: string; status: string; version: number; decisionNote: string | null; decidedAt: string | null; decidedBy: { id: string; name: string } | null } | null;
};
/**
 * Wave D adds what starts on its own once the job is live (`autoActionsOnOpen`, D9), the board ticks and who posts them
 * (`boards`, `whoPosts`, D3 and D6), the closing date (`closingDate`, D7) and the boards still showing an earlier version.
 */
export type RoleDetail = RoleSummary & { currentPacketVersion: number | null; currentPacket: ({ version: number; status: string; packet: RolePacket } & PacketPayView) | null; proposedPacket: ({ version: number; status: string; changeSummary: string | null; createdAt: string; createdBy: { kind: string; id: string; name?: string }; packet: RolePacket } & PacketPayView) | null; packetVersions: Array<{ version: number; status: string; source: string; changeSummary: string | null; createdAt: string; createdBy: { kind: string; name?: string } }>; postings: Posting[]; boardsStillUp: string[]; acceptingApplications: boolean; applicationsClosedAt: string | null; applicationsClosedReason: string | null; volumeAlertPerDay: number | null; pendingApprovals: Array<{ id: string; actionType: string; rationale: string | null; proposal?: Record<string, unknown> }>; counts: Record<string, number>; packetApproval: PacketApproval; decisionMaker: DecisionMaker | null; autoActionsOnOpen: AutoActionsOnOpen; boards: BoardChoiceView[]; whoPosts: WhoPosts; closingDate: ClosingDateView; boardsShowingOldVersion: string[] };
/** Who posts the job on the boards: an ITS recruiter from the company's own accounts (the default), or the team itself. */
export type WhoPosts = "its" | "self";
/** Where a requirement is checked; the contract's `evidencedBy` values. */
export type EvidenceSource = "resume" | "application" | "screen" | "interview";
export type Requirement = { key: string; text: string; rationale: string; evidencedBy: EvidenceSource[] };
export type RolePacket = {
  identity: { title: string; locations: Array<{ city?: string; region?: string }>; employmentType: string; schedule?: string; remotePolicy: "onsite" | "hybrid" | "remote" };
  business: { reason: string; reasonDetail?: string; timeline: { targetStartDate?: string; urgency: string } };
  compensation: { basis: string; min: number; mid?: number; max: number; ceiling: number; discloseRange: boolean; benefitsSummary?: string; sources: Array<{ name: string; detail?: string }>; ownerStated: boolean };
  description: { publicJobDescription: string; internalNotes?: string };
  requirements: { mustHaves: Requirement[]; niceToHaves: Requirement[]; eligibility: Array<{ key: string; type: string; question: string; rationale: string; knockout: boolean }> };
  competencies: Array<{ key: string; name: string; definition: string; weight: number; evaluatedIn: string; /** Essential, Important or Helpful (plan F3); older packets leave it out. */ importance?: Importance; indicators?: string[] }>;
  screening: { questions: Array<{ key: string; question: string; kind: string; competencyKey?: string }>; maxMinutes: number };
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
  /** "Still applying" (plan E6): offered the screening conversation with the application and not finished yet; older answers leave it out. */
  stillApplying?: boolean;
  /**
   * The match score (founder decision B2), worked out by code from the checked findings, never by the model: the number
   * (null when nothing could be judged yet), its band, what it rests on and the must-haves shown missing by a quote.
   * `placement` and `nextStep` are where the pool board puts the person and the step it suggests. Older answers leave
   * them all out.
   */
  score?: number | null;
  band?: MatchBand | null;
  bandLabel?: string | null;
  coverage?: { known: number; total: number; words: string } | null;
  missingMustHave?: Array<{ key: string; label: string; quote: string }>;
  mustHaves?: MustHaveSummary | null;
  placement?: BoardPlacement;
  nextStep?: NextStep | null;
  readingVersion?: ReadingVersion | null;
};
/**
 * GET /roles/:id/applications?counts=1: the stage strip's counts cover every applicant the caller may see, whatever the
 * filters. `stillApplying` counts the people still in the visit that sent their application (plan E6).
 */
export type StageStripCounts = { total: number; byOwnerStage: Record<OwnerStage, number>; byGroup: Record<OwnerGroup, number>; notTold: number; holdsEnded: number; stillApplying?: number };
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
/**
 * One line of a screening conversation. `role: "recruiter"` with `source: "recruiter_call"` is a recruiter's notes from a
 * phone call (`by` names them), never the candidate's words; `source` also says when an answer was tapped, skipped or
 * changed on the "check your answers" page (plan E3, E10-E12).
 */
export type ScreenTranscriptLine = { role: string; content: string; at: string; questionKey?: string; channel?: string; source?: string; by?: string };
/**
 * Wave E: `invitedVia` is "apply" when the conversation was offered in the visit that sent the application (older
 * answers leave it out; `progress.flow` says the same). `progress.declined` lists the questions the candidate chose not
 * to answer, `progress.edits` the answers they changed before sending. `answersShared: false` (founder decision of
 * 9 October 2026, "hide them until they send"): the candidate has not sent their answers, or never did, so the API sends
 * none of them: no answer, no transcript line but a recruiter's call notes, and nothing about how far they got. Older
 * answers leave it out (everything was shown).
 */
export type Screen = { id: string; channel: string; status: string; invitedAt: string | null; startedAt: string | null; completedAt: string | null; remindedAt: string | null; invitedVia?: string | null; transcript: ScreenTranscriptLine[]; answers: Record<string, string>; answersShared?: boolean; progress: { askedKeys: string[]; currentQuestionKey: string | null; /** "Ask about this in a screen": the open questions the screen started with, each with its answer once given. */ focusQuestions?: Array<{ key: string; question: string; whyItMatters?: string; answer?: string }>; flow?: string; phase?: string; declined?: string[]; edits?: Record<string, number>; submittedAt?: string; /** "recruiter_call": finished from a recruiter's notes, never sent by the candidate. */ completedBy?: string }; assessmentId: string | null; /** The scorecard's state on the candidate page (apps/api/src/services/screen-scorecards.ts); `recruiterAsked` once ITS has the failed one. */ scorecard?: "ready" | "writing" | "unavailable" | "none"; recruiterAsked?: boolean };
/** GET /roles/:id/screening (plan E13): how the conversation goes for one role, counts only. */
export type { ScreeningFunnel } from "@ros/contracts";
/** GET and PUT /roles/:id/apply-mode (ITS only): the role's own setting (null follows the company), the company's default, and what applies. */
export type RoleApplyModeView = { roleId: string; applyMode: "one_visit" | "form_then_screen" | null; companyDefault: "one_visit" | "form_then_screen"; effective: "one_visit" | "form_then_screen" };
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
export type ActionResult = { ok: true; stage: string; ownerStage?: OwnerStage; mark?: ActiveMark | null; toldState?: ToldState; dispositionSent?: boolean; candidateNotice?: CandidateNotice; approvalRequestId?: string; workflowRunId?: string; next?: string; /** A move to the talent pool for someone who asked not to be kept for future roles: they stay out of it. */ talentPoolOptOut?: boolean; /** Interviews a private decision called off. */ interviewsCancelled?: number; /** How many of them the candidate was told about at once, in a short note with no reason (they had a booked time or times to pick from); the decision itself stays private. */ interviewOffNotes?: number; /** send_decision: the message and until when Undo can take it back (plan G9); null when it went at once. */ communicationId?: string | null; undoUntil?: string | null; /** The approved wording the message used (Q28). */ wording?: DecisionWording | null; /** A decision: the message one Send would now write (plan G4). */ decisionMessage?: DecisionMessagePreview | null };
/** What may be done with the application right now; the API decides, the page only shows (see apps/api/src/services/application-actions.ts). */
export type ApplicationCapability = "invite_screen" | "ask_in_screen" | "interview" | "advance_to_interview" | "hold" | "reject" | "move_to_talent_pool" | "override_eligibility" | "review_anyway" | "record_decision" | "record_outcome" | "record_offer" | "set_mark" | "clear_mark" | "send_decision" | "told_in_person" | "cancel_screen" | "undo_decision";
/**
 * POST /roles/:id/decision-messages: one result per person, so one refusal never hides the others. `communicationId` and
 * `undoUntil` while that person's message waits out its Undo window (plan G9).
 */
export type DecisionMessageResult = { applicationId: string; ok: boolean; candidateNotice?: CandidateNotice; toldState?: ToldState; communicationId?: string | null; undoUntil?: string | null; code?: string; message?: string };
/** POST /applications/:id/messages/:communicationId/undo: taken back; a decision message leaves them not told again. */
export type UndoResult = { ok: true; communicationId: string; toldState: ToldState | null };
/** `held`: saved to go out on their own once ITS confirms the company (founder decision B7). */
export type DecisionMessagesResponse = { results: DecisionMessageResult[]; queued: number; held?: number; waitingApproval: number; notSent: number };
export type TimelineEvent = { type: string; occurredAt: string; actor: { kind: string; name?: string; id: string }; payload: Record<string, unknown> };
export type ApplicationDetail = ApplicationCore & { roleId: string; stageChangedAt: string; candidateToldAt: string | null; /** When the decision not to move forward was made; older answers leave it out. */ rejectedAt?: string | null; /** The day the untold safety net acts (Q27), when the API names it; the page works it out otherwise. */ untoldFallbackOn?: string | null; /** The decision message waits for an approver: their own, or a closed role's closing message naming them; older answers leave it out. */ decisionMessageWaiting?: boolean; /** The file read as their résumé, when there is one. */ resumeDocumentId?: string | null; allowedActions: ApplicationCapability[]; /** Why each choice not in `allowedActions` is unavailable, in plain words; shown on the disabled button. */ blockedReasons: Partial<Record<ApplicationCapability, string>>; /** What a Send of the decision message does under the company's settings: it goes, waits for approval, or is not sent. */ declineMessage: DeclineMessagePolicy; rejectReason: string | null; rejectNote: string | null; interviews: Array<{ id: string; roundKey: string; title: string; status: string; startsAt: string | null; endsAt: string | null; timezone: string | null; meetingUrl: string | null; attempt: number; outcome: string | null; decision: string | null; offeredSlots: OfferedSlot[]; createdAt: string }>; interviewPlan: Array<{ key: string; title: string; durationMinutes: number; format: string; interviewerUserIds: string[]; purpose: string }>; candidate: { firstName: string; lastName: string; email: string | null; phone: string | null; locationText: string | null; consent: Record<string, { granted: boolean; at: string; source: string }>; /** `talentPoolOptOut`: the person asked not to be kept for future roles. */ preferences?: { talentPoolOptOut?: boolean } }; documents: Array<{ id: string; kind: string; filename: string; /** The file's type ("application/pdf"); older answers leave it out. */ mime?: string; hasText: boolean; sizeBytes: number; status: "quarantined" | "clean" | "rejected" | "deleted" | string; uploadedVia: string; rejectedReason: string | null; validatedAt: string | null }>; assessments: Array<{ id: string; kind: string; overall: string; confidence: string; createdAt: string; result: AssessmentResult; /** The version of the role it was read against (plan F4). */ packetVersion?: number }>; screens: Screen[]; /** `proposal` carries a waiting message's text (F11); `requiredRoles` says who may decide it, so the page offers the buttons only to them. */ pendingApprovals: Array<{ id: string; actionType: string; rationale: string | null; createdAt: string; proposal?: Record<string, unknown>; requiredRoles: string[] }>; packetLabels: { mustHaves: Array<{ key: string; text: string }>; competencies: Array<{ key: string; name: string; /** Essential, Important or Helpful (plan F3); older answers leave it out. */ importance?: Importance }>; questions: Array<{ key: string; question: string }> }; communications: Array<{ id: string; direction: string; channel: string; subject: string | null; bodyText: string; status: string; createdAt: string; templateKey: string | null; /** Who sent it: a person (by name), the assistant, the product by itself, an ITS recruiter, or the candidate; older answers leave it out. */ sentBy?: { kind: string; id: string; name?: string } | null; deliveredAt?: string | null }>; timeline: TimelineEvent[]; extraction: { positions: Array<{ title: string; employer?: string; startDate?: string; endDate?: string; quote?: string }>; licenses: Array<{ name: string; jurisdiction?: string; quote?: string }>; certifications: Array<{ name: string }>; skills: string[]; yearsOfExperienceEstimate?: number; anomalies: Array<{ kind: string; detail: string }> } | null; answers: { eligibility?: Record<string, unknown>; noResume?: Record<string, string> }; /** The match score with its breakdown (founder decision B2), the must-have line, where the pool board puts them and the version label, from the same rules as the list and the board; older answers leave them out. */ matchScore?: MatchScore | null; mustHaves?: MustHaveSummary | null; placement?: BoardPlacement; readingVersion?: ReadingVersion | null };
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
/** `landing`: a shared link opens the job page first ("job"), a board's own link the form ("apply"), plan D8. */
export type ApplicationLink = { id: string; url: string; source: string; sourceLabel: string; sourceDetail: string | null; label: string; postingId: string | null; visits: number; lastVisitedAt: string | null; createdAt: string; disabledAt: string | null; landing?: string };
export type PostingPackage = { text: string; fields: Record<string, string> };
/**
 * One channel on the Posting tab and the screen right after approval (plan D2). For a board: `chosen` (still ticked for
 * the role), `postedBy` ("its" when an ITS recruiter posts it from the company's own account), the latest ITS posting
 * `task`, and `showsOldVersion` once an approved edit left the listing behind.
 */
export type PostingView = Posting & { name: string; stateLabel: string; isBoard: boolean; link: ApplicationLink | null; package: PostingPackage | null; stillUp: boolean; chosen: boolean; postedBy: "its" | "you" | null; task: PostingTaskView | null; showsOldVersion: boolean };
/**
 * GET /roles/:id/postings. Besides the channels and links: where publishing stands (`publishing`; ask again while
 * `pollAfterSeconds` is a number), who posts and the board ticks, the closing date, the share block, and whether every
 * interview round has someone on it. `emailIn.shown` is true only while applications by email actually work.
 */
export type PostingsResponse = {
  role: { id: string; title: string; status: string; acceptingApplications: boolean; applicationsClosedAt: string | null; applicationsClosedReason: string | null; volumeAlertPerDay: number; applicationsCloseOn: string | null; openedAt: string | null; currentPacketVersion: number | null };
  urls: { careers: string; job: string; apply: string };
  emailIn: { address: string | null; connected: boolean; shown: boolean; status: string | null; error: string | null };
  postings: PostingView[];
  links: ApplicationLink[];
  boardsStillUp: string[];
  publishing: PublishingState;
  whoPosts: WhoPosts;
  boards: BoardChoiceView[];
  closingDate: ClosingDateView;
  share: ShareView;
  interviewers: { rounds: number; roundsWithoutInterviewers: number };
};
/** POST /roles/:id/share-links: the place's own tracked link (the same one on every tap), the text a share starts with, and each share button's address. */
export type ShareLinkResponse = { created: boolean; link: ApplicationLink; text: string; targets: ShareTarget[] };
/** POST /roles/:id/closing-date. `reopened`: a later date took applications again ("Extend the date"). */
export type ClosingDateResponse = { ok: boolean; reopened: boolean; closingDate: ClosingDateView };
/** Saving a packet version (POST /roles/:id/packets): what became of it, and on a live job why it waits (Q10) or which boards still show the earlier version (D4). */
export type NewVersionResponse = { version: number; outcome?: "approved_current" | "proposed_pending_approval" | "proposed"; guardChanges?: string[]; needsApproval?: { changes: string[]; words: string; youMayConfirm: boolean } | null; boardsShowingOldVersion?: string[] };
/**
 * An ITS posting task as its recruiter sees it once accepted (plan D3): the job ad as the board will show it, the
 * board's own apply link, the numbered steps and where the posting stands. Nothing about applicants.
 */
export type PostingTaskDetail = {
  question: string;
  kind: PostingTaskKind;
  label: string;
  companyName: string;
  role: { id: string; title: string; status: string; currentPacketVersion: number | null };
  board: { channel: string; name: string };
  posting: { id: string; status: string; stateLabel: string; externalUrl: string | null; verifiedAt: string | null; verificationError: string | null; error: string | null; closureRequired: boolean; closureConfirmedAt: string | null; boardVersion: number | null; showsOldVersion: boolean };
  package: PostingPackage | null;
  steps: string[];
  applyUrl: string | null;
  boardAccessConfirmed: boolean;
  whatToDo: string;
};
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
/** `aiFooter`: the footer when the person keeps a line the assistant suggested (Q28); `undoSeconds`: the Undo window after Send (plan G9). */
export type MessagePreview = { to: string | null; candidateFirstName: string; fromName: string; footer: string; aiFooter?: string; repliesComeBack: boolean; policyLevel: string; needsApproval: boolean; undoSeconds?: number };
/** `held`: saved, and it goes out on its own once ITS confirms the company (founder decision B7). `undoUntil`: Undo works until then (plan G9). */
export type SendMessageResult = { ok: true; status: "queued" | "held"; communicationId: string; undoUntil?: string | null } | { ok: true; status: "pending_approval"; approvalRequestId: string };
// The comparison view (F10): GET /roles/:id/compare?ids=a,b,c (apps/api/src/routes/compare.ts). Columns in the order
// chosen; each person's match score (B2) and, when their reading was made against an earlier version of the role, the
// label; and the team's private notes on them (plan H3), for those who read notes.
export type CompareCandidate = { applicationId: string; name: string; stage: string; stageLabel: string; group: string; ownerStage?: OwnerStage; ownerStageLabel?: string; mustHaves: Record<string, { met: string; quote: string | null }>; competencies: Record<string, { finding: string; note: string | null }>; screen: { recommendation: string; summary: string } | null; resume: { overall: string; recommendation: string; summary: string } | null; unknownCount: number; open: string; score?: MatchScore | null; readingVersion?: ReadingVersion | null; notes?: NoteView[] };
export type CompareResponse = { role: { id: string; title: string }; version?: number | null; mustHaves: Array<{ key: string; text: string }>; competencies: Array<{ key: string; name: string; definition: string }>; candidates: CompareCandidate[]; max: number; reminder: string };
export type MyCalendar = { connection: { id: string; provider: string; status: string; externalAccountId: string | null; connectedAt: string | null; lastError: string | null; disconnectedAt: string | null; credentialsDeleted: boolean } | null; availability: { timezone: string; windows: Array<{ day: number; start: string; end: string }>; bufferMinutes: number; maxPerDay: number; updatedAt: string } | null; providers: Array<{ key: string; status: string }> };
