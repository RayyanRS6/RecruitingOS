import { and, asc, eq, inArray, isNull, like } from "drizzle-orm";
import { CANCELLED_REASON_LABEL, MARK_LABEL, OWNER_STAGE_LABEL, type ActorKind, type ApplicationStage, type Actor, type CandidateStep, type MarkKind, type OwnerGroup, type OwnerStage, type ToldState } from "@ros/contracts";
import { applicationMarks, applications, communications, events, type Queryable } from "@ros/db";
import { emit } from "./events";
import { CANCEL_STAGES, followUpInMotion, inCancelled, resolveOpenFollowUp, restoreFollowUpAfterUndo, type FollowUpStrip } from "./interview-followups";

/**
 * The application state machine (docs/06). Each transition names who may perform it.
 * "system" means a workflow step; humans are tenant roles; "candidate" is the candidate.
 */
type Mover = ActorKind | "owner" | "admin" | "hiring_manager" | "hr" | "recruiter" | "interviewer";

const T: Array<{ from: ApplicationStage[]; to: ApplicationStage; by: Mover[] }> = [
  { from: ["applied"], to: "received", by: ["system"] },
  { from: ["received"], to: "eligible", by: ["system"] },
  { from: ["received"], to: "ineligible", by: ["system"] },
  { from: ["ineligible"], to: "rejected", by: ["owner", "admin", "hiring_manager", "recruiter"] }, // never the system (founder decision, correction 6)
  { from: ["ineligible"], to: "eligible", by: ["owner", "admin", "hiring_manager", "recruiter"] },
  { from: ["rejected"], to: "eligible", by: ["owner", "admin", "hiring_manager", "recruiter"] }, // "review anyway" after an eligibility-rule disposition; the route restricts it to that reason
  { from: ["eligible"], to: "triaged", by: ["system"] },
  { from: ["received"], to: "triaged", by: ["system"] }, // extraction failed; manual review path still triages
  { from: ["triaged", "eligible", "received"], to: "screen_invited", by: ["system", "owner", "admin", "hiring_manager", "recruiter"] },
  { from: ["screening"], to: "screen_invited", by: ["system", "owner", "admin", "hiring_manager", "recruiter"] }, // re-invite after a hand-off to a person
  { from: ["screen_invited"], to: "triaged", by: ["owner", "admin", "hiring_manager", "recruiter"] }, // "Stop this screen invitation" before they start (plan A7): back to waiting on the team
  // the candidate sent the application without the conversation, or stopped part-way and it was closed after a reminder (plan E3, E4): their application goes on to the team
  { from: ["screen_invited", "screening"], to: "triaged", by: ["system"] },
  { from: ["screen_invited"], to: "screening", by: ["system"] },
  { from: ["screening", "screen_invited"], to: "screen_complete", by: ["system"] },
  // a person may decide to interview before or during a screen; the screen stays open and is simply superseded
  { from: ["screen_complete", "triaged", "eligible", "screen_invited", "screening"], to: "interview_recommended", by: ["system", "owner", "admin", "hiring_manager", "recruiter"] },
  { from: ["triaged", "screen_complete", "interview_recommended", "screen_invited", "eligible"], to: "interview_scheduled", by: ["system", "owner", "admin", "hiring_manager", "recruiter"] },
  // that an interview ended is a fact, not a hiring judgment: any member who sat on it may record it (the route checks they did)
  { from: ["interview_scheduled"], to: "interview_complete", by: ["system", "owner", "admin", "hiring_manager", "hr", "recruiter", "interviewer"] },
  // a cancelled or expired interview returns the candidate to "recommended" so the team can re-offer or decide
  { from: ["interview_scheduled"], to: "interview_recommended", by: ["system", "owner", "admin", "hiring_manager", "recruiter"] },
  { from: ["interview_complete"], to: "interview_scheduled", by: ["system", "owner", "admin", "hiring_manager", "recruiter"] },
  { from: ["interview_complete"], to: "debrief", by: ["system", "owner", "admin", "hiring_manager", "recruiter"] },
  { from: ["debrief", "interview_complete"], to: "finalist", by: ["owner", "admin", "hiring_manager", "recruiter"] }, // the roles that hold interview.decide
  { from: ["finalist"], to: "reference_check", by: ["owner", "admin", "hr", "recruiter"] },
  // "Offer made" (founder decision Q29; plan H2): a person records an offer made outside the app, by the roles that
  // record outcomes (outcome.record). Record-only: the app never drafts, approves or sends it.
  { from: ["finalist", "reference_check"], to: "offer_sent", by: ["owner", "admin", "hiring_manager", "hr"] },
  { from: ["finalist", "reference_check"], to: "offer_draft", by: ["system", "owner", "admin", "hr", "recruiter"] },
  { from: ["offer_draft"], to: "offer_approval", by: ["system"] },
  { from: ["offer_approval"], to: "offer_sent", by: ["system"] },
  { from: ["offer_sent"], to: "negotiation", by: ["system"] },
  { from: ["negotiation"], to: "offer_sent", by: ["system"] },
  { from: ["offer_sent", "negotiation"], to: "accepted", by: ["candidate", "system", "owner", "admin", "recruiter"] },
  { from: ["offer_sent", "negotiation"], to: "declined", by: ["candidate", "system", "owner", "admin", "recruiter"] },
  { from: ["accepted"], to: "onboarding", by: ["system"] },
  { from: ["onboarding"], to: "hired", by: ["system", "owner", "admin", "hiring_manager", "hr"] },
];

const ACTIVE: ApplicationStage[] = [
  "applied", "received", "ineligible", "eligible", "triaged", "screen_invited", "screening", "screen_complete",
  "interview_recommended", "interview_scheduled", "interview_complete", "debrief", "finalist", "reference_check",
  "offer_draft", "offer_approval", "offer_sent", "negotiation", "accepted", "onboarding",
];

const OUTCOME_RECORDERS: Mover[] = ["owner", "admin", "hiring_manager", "hr"];

/**
 * Decisions a person makes privately and tells the candidate later (founder decision B6): declined, and moved to the
 * talent pool. Entering one starts the told state again at not_told.
 */
export const DECISION_STAGES: readonly ApplicationStage[] = ["rejected", "talent_pool"];
/** Every mark clears when the application leaves the process. */
const LEAVES_PROCESS: readonly ApplicationStage[] = ["hired", "withdrawn", "rejected", "declined", "talent_pool"];

/**
 * Where a decision taken back before the candidate was told puts them (plan G1, "quiet undo"): the step they were at
 * before it, made safe, since the decision already called off their screens and interviews. Someone waiting on a screen
 * or still early goes back to "ready for your review"; someone whose interview was booked, to "recommended for
 * interview"; an offer being prepared, to finalist. Null for a step a decision cannot be taken back to (they had
 * withdrawn, been hired or declined an offer before it).
 */
export function reopenStage(before: ApplicationStage | null): ApplicationStage | null {
  if (before === null) return "triaged";
  switch (before) {
    case "applied":
    case "received":
    case "eligible":
    case "triaged":
    case "screen_invited":
    case "screening":
      return "triaged";
    case "interview_scheduled":
      return "interview_recommended";
    case "offer_draft":
    case "offer_approval":
      return "finalist";
    case "ineligible":
    case "screen_complete":
    case "interview_recommended":
    case "interview_complete":
    case "debrief":
    case "finalist":
    case "reference_check":
    case "offer_sent":
    case "negotiation":
    case "accepted":
    case "onboarding":
      return before;
    default:
      return null;
  }
}

/** Every step `reopenStage` can put someone back at. */
export const REOPEN_TARGETS: readonly ApplicationStage[] = ["triaged", "ineligible", "screen_complete", "interview_recommended", "interview_complete", "debrief", "finalist", "reference_check", "offer_sent", "negotiation", "accepted", "onboarding"];

/**
 * The stage an application was at before its current decision (declined, or moved to the talent pool): the last move
 * into a stage that is not a decision, or where its history starts. Null when nothing is recorded.
 */
export async function stageBeforeDecision(q: Queryable, applicationId: string): Promise<ApplicationStage | null> {
  const moves = await q.select({ payload: events.payload }).from(events).where(and(eq(events.subjectType, "application"), eq(events.subjectId, applicationId), eq(events.type, "application.stage_changed"))).orderBy(asc(events.id));
  let i = moves.length - 1;
  while (i >= 0 && DECISION_STAGES.includes(moves[i].payload.to as ApplicationStage)) i -= 1;
  return i >= 0 ? (moves[i].payload.to as ApplicationStage) : ((moves[0]?.payload.from as ApplicationStage | undefined) ?? null);
}

/**
 * `decisionTold` matters for one move only: someone declined (or moved to the talent pool) who was never told may still
 * withdraw from their status page (plan A1), since for them nothing has been decided yet. `undoDecision`: a person takes
 * back a decision the candidate was never told (plan G1), to a step `reopenStage` allows; nothing else leaves a decision
 * that way, and never once the candidate was told, or a message is on its way.
 */
export function canTransition(from: ApplicationStage, to: ApplicationStage, by: Mover, ctx: { decisionTold?: boolean; undoDecision?: boolean; toldState?: string | null } = {}): boolean {
  if (ctx.undoDecision) return DECISION_STAGES.includes(from) && ctx.toldState === "not_told" && isHuman(by) && REOPEN_TARGETS.includes(to);
  if (to === "withdrawn" && DECISION_STAGES.includes(from)) return by === "candidate" && ctx.decisionTold === false;
  if (to === "withdrawn") return ACTIVE.includes(from) && (by === "candidate" || by === "system" || isHuman(by));
  if (to === "rejected") return ACTIVE.includes(from) && isHuman(by); // never the system, not on judgment and not on an eligibility answer
  if (to === "talent_pool") return ["rejected", "declined", "withdrawn", ...ACTIVE].includes(from) && (by === "system" || isHuman(by));
  // 21 Sep, item 4: a decision-maker records a hire or an offer declined outside the platform; never the system.
  if (to === "hired" && OUTCOME_RECORDERS.includes(by)) return ACTIVE.includes(from) || from === "talent_pool";
  if (to === "declined" && OUTCOME_RECORDERS.includes(by)) return ACTIVE.includes(from);
  return T.some((t) => t.from.includes(from) && t.to === to && t.by.includes(by));
}

function isHuman(by: Mover): boolean {
  return ["owner", "admin", "hiring_manager", "hr", "recruiter", "interviewer", "user"].includes(by);
}

export class TransitionError extends Error {
  constructor(public from: ApplicationStage, public to: ApplicationStage, public by: Mover) {
    super(`transition ${from} → ${to} not allowed for ${by}`);
  }
}

/**
 * Moves an application and records the fact. The only way stage changes. Leaving the process, or a person moving them
 * to another column of the stage strip, clears the private mark (recorded as `application.mark_cleared`); a new
 * decision starts the told state again at not_told. Booking a time, leaving the process or a person's move takes them
 * out of Cancelled; a decision taken back puts someone who was there back (interview-followups.ts). `now`: the caller's
 * clock (a workflow's), when it has one.
 */
export async function transition(
  q: Queryable,
  input: { applicationId: string; companyId: string; to: ApplicationStage; by: Mover; actor: Actor; reason?: string; payload?: Record<string, unknown>; correlationId?: string | null; /** a person taking back a decision the candidate was never told (`canTransition`) */ undoDecision?: boolean; now?: Date },
): Promise<{ from: ApplicationStage; to: ApplicationStage }> {
  const [app] = await q.select().from(applications).where(eq(applications.id, input.applicationId)).limit(1);
  if (!app) throw new Error(`application ${input.applicationId} not found`);
  const from = app.stage;
  if (from === input.to) return { from, to: input.to };
  if (!canTransition(from, input.to, input.by, { decisionTold: decisionTold(app.toldState), undoDecision: input.undoDecision, toldState: app.toldState })) throw new TransitionError(from, input.to, input.by);
  const at = input.now ?? new Date();
  const now = at.toISOString();
  const patch: Partial<typeof applications.$inferInsert> = { stage: input.to, stageChangedAt: now };
  if (input.to === "withdrawn") { patch.withdrawnAt = now; patch.withdrawReason = input.reason ?? null; }
  if (input.to === "rejected") { patch.rejectedAt = now; patch.rejectReason = input.reason ?? null; }
  if (DECISION_STAGES.includes(input.to) && !DECISION_STAGES.includes(from)) { patch.toldState = "not_told"; patch.candidateToldAt = null; }
  // A decision taken back leaves nothing of it on the application: a later decline is a new decision, with its own date.
  if (input.undoDecision) { patch.rejectedAt = null; patch.rejectReason = null; patch.rejectNote = null; patch.candidateToldAt = null; }
  await q.update(applications).set(patch).where(eq(applications.id, input.applicationId));
  await emit(q, {
    type: "application.stage_changed",
    companyId: input.companyId,
    actor: input.actor,
    subject: { type: "application", id: input.applicationId },
    payload: { from, to: input.to, reason: input.reason ?? null, ...(input.payload ?? {}) },
    correlationId: input.correlationId ?? null,
  });
  // Leaving a decision (a candidate withdrawing before they were told, "review anyway", a corrected outcome) withdraws
  // the decision message still waiting in the outbox, so it never reaches someone the decision no longer applies to.
  if (DECISION_STAGES.includes(from) && !DECISION_STAGES.includes(input.to)) await withdrawQueuedDecision(q, { applicationId: input.applicationId, companyId: input.companyId, actor: input.actor, reason: `the decision no longer applies (now ${STAGE_LABEL[input.to].toLowerCase()})` });
  // A person moving someone to another column of the strip (approving an interview for someone on hold, say) ends the
  // mark too; the system's own moves never undo a person's hold. The candidate's own cancel of a booked interview does:
  // they go under Cancelled (founder decision 1A), and no automatic times go to someone a person had paused. The cancel
  // itself ends the mark (`openFollowUp`), not this move.
  const leaves = LEAVES_PROCESS.includes(input.to);
  const movedOn = isHuman(input.by) && baseOwnerStage(from) !== baseOwnerStage(input.to);
  if (leaves || movedOn) await endMarkOnMove(q, { applicationId: input.applicationId, companyId: input.companyId, actor: input.actor, to: input.to, leaves, correlationId: input.correlationId });
  // The Cancelled column (founder decisions 1A-4A): booking a time, leaving the process, or a person's move ends it.
  // The system's own moves (the candidate's cancel, the interview closing) never do. A private decision taken back before
  // the candidate was told leaves nothing of it (above): someone who was under Cancelled goes back there.
  if (input.undoDecision && CANCEL_STAGES.includes(input.to)) await restoreFollowUpAfterUndo(q, { companyId: input.companyId, applicationId: input.applicationId, actor: input.actor, now: at });
  else if (leaves || input.to === "interview_scheduled" || isHuman(input.by)) await resolveOpenFollowUp(q, { companyId: input.companyId, applicationId: input.applicationId, actor: input.actor, how: leaves ? "left_process" : input.to === "interview_scheduled" ? "rebooked" : "moved_by_team", now: at });
  return { from, to: input.to };
}

/**
 * Ends the private mark because the person moved: they left the process, or a person moved them to another column of
 * the strip (recorded as `application.mark_cleared`, reason `left_process` or `moved_on`). Also for a person's move that
 * changes no stage, such as approving an interview for someone already recommended for one.
 */
export async function endMarkOnMove(q: Queryable, input: { applicationId: string; companyId: string; actor: Actor; to: ApplicationStage; leaves?: boolean; correlationId?: string | null }): Promise<number> {
  const clearReason = input.leaves ? `left the process (${STAGE_LABEL[input.to].toLowerCase()})` : `moved on (${OWNER_STAGE_LABEL[baseOwnerStage(input.to)].toLowerCase()})`;
  const cleared = await q.update(applicationMarks).set({ clearedAt: new Date().toISOString(), clearedBy: input.actor, clearReason }).where(and(eq(applicationMarks.applicationId, input.applicationId), isNull(applicationMarks.clearedAt))).returning({ id: applicationMarks.id, mark: applicationMarks.mark });
  for (const m of cleared) await emit(q, { type: "application.mark_cleared", companyId: input.companyId, actor: input.actor, subject: { type: "application", id: input.applicationId }, payload: { markId: m.id, mark: m.mark, reason: input.leaves ? "left_process" : "moved_on", to: input.to }, correlationId: input.correlationId ?? null });
  return cleared.length;
}

/**
 * A decision message still in the outbox (queued, or held for the ITS company check; not yet handed to the provider)
 * is withdrawn, and a told state of "queued" goes back to not told: the decision it carried no longer applies. Recorded
 * as `message.cancelled`. A message already being sent cannot be called back; the outbox leaves the told state alone for
 * an application that left its decision. Returns how many messages were withdrawn.
 */
export async function withdrawQueuedDecision(q: Queryable, input: { applicationId: string; companyId: string; actor: Actor; reason: string }): Promise<number> {
  const rows = await q.update(communications).set({ status: "cancelled", error: input.reason }).where(and(eq(communications.applicationId, input.applicationId), like(communications.templateKey, "disposition:%"), inArray(communications.status, ["queued", "held"]))).returning({ id: communications.id, templateKey: communications.templateKey });
  for (const r of rows) await emit(q, { type: "message.cancelled", companyId: input.companyId, actor: input.actor, subject: { type: "communication", id: r.id }, payload: { template: r.templateKey, applicationId: input.applicationId, reason: input.reason } });
  await q.update(applications).set({ toldState: "not_told" }).where(and(eq(applications.id, input.applicationId), eq(applications.toldState, "queued")));
  return rows.length;
}

/**
 * Owner Mode groups stages into plain language. Someone held on an eligibility answer waits on a person (plan A2): only
 * a person can keep them in or decline them, so they are never counted as already out.
 */
export function ownerGroup(stage: ApplicationStage): OwnerGroup {
  if (["hired"].includes(stage)) return "hired";
  if (["rejected", "withdrawn", "declined", "talent_pool"].includes(stage)) return "not_moving_forward";
  // An offer is out (made outside the app, plan H2): the next move is the candidate's answer.
  if (stage === "offer_sent") return "waiting_on_candidate";
  // interview_complete waits on a person too: the interview is over and nobody has recorded next round, finalist or not moving forward.
  if (["ineligible", "triaged", "screen_complete", "interview_recommended", "interview_complete", "debrief", "finalist", "offer_draft", "offer_approval", "negotiation"].includes(stage)) return "waiting_on_you";
  return "in_process";
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The stage strip (founder decision B3) and the candidate's steps (plan A1): views over the state machine.       */
/* ------------------------------------------------------------------------------------------------------------ */

/** The part of a mark these views read; `remindAt` matters for a hold only. */
export type MarkView = { mark: MarkKind; remindAt?: string | null } | null | undefined;

const NEW_PHASE: readonly ApplicationStage[] = ["applied", "received", "ineligible", "eligible", "triaged", "screen_invited", "screening", "screen_complete"];
// interview_recommended is the decision to interview (a person's, or the assistant's under the company's settings), so it sits with the interviews
const INTERVIEW_PHASE: readonly ApplicationStage[] = ["interview_recommended", "interview_scheduled", "interview_complete", "debrief", "finalist", "reference_check"];
const OFFER_PHASE: readonly ApplicationStage[] = ["offer_draft", "offer_approval", "offer_sent", "negotiation", "accepted", "onboarding"];

/** The owner stage of the internal stage alone, before any mark: new, interviewing, offer, hired or not moving forward. */
export function baseOwnerStage(stage: ApplicationStage): OwnerStage {
  if (stage === "hired") return "hired";
  if (OFFER_PHASE.includes(stage)) return "offer";
  if (INTERVIEW_PHASE.includes(stage)) return "interviewing";
  if (NEW_PHASE.includes(stage)) return "new";
  return "not_moving_forward";
}

/**
 * Where an application sits on the stage strip. Someone with an open follow-up (they cancelled a booked interview or did
 * not come to it) shows as Cancelled while recommended for interview or interview done. Marks overlay the internal stage
 * while the person is still in the process: On hold over any active step, Longlist and Shortlist over New only (someone
 * interviewing shows as Interviewing), Not a fit for now as Not moving forward. Out of the process (hired, declined,
 * withdrawn, talent pool) neither counts; both are cleared there anyway.
 */
export function ownerStage(app: { stage: ApplicationStage }, mark?: MarkView, followUp?: FollowUpStrip | null): OwnerStage {
  const base = baseOwnerStage(app.stage);
  if (base === "hired" || base === "not_moving_forward") return base;
  if (inCancelled(app.stage, followUp)) return "cancelled"; // before marks; the two never coexist (interview-followups.ts)
  if (!mark) return base;
  if (mark.mark === "on_hold") return "on_hold";
  if (mark.mark === "not_a_fit_for_now") return "not_moving_forward";
  return base === "new" ? mark.mark : base;
}

/** A hold whose date has not come: nothing about this person waits on anyone until then. */
export function holdRunning(mark: MarkView, now: Date = new Date()): boolean {
  return mark?.mark === "on_hold" && !!mark.remindAt && Date.parse(mark.remindAt) > now.getTime();
}

/** A hold whose date has come: the person is back in front of the team (Today card, notification). */
export function holdEnded(mark: MarkView, now: Date = new Date()): boolean {
  return mark?.mark === "on_hold" && !!mark.remindAt && Date.parse(mark.remindAt) <= now.getTime();
}

/**
 * The owner group with the mark taken into account (plan A4 `groupFor`), for every count that asks "who waits on you":
 * a running hold waits on nobody, so it is in process; once its date passes the person waits on you again; someone set
 * aside as not a fit for now counts as not moving forward. Someone under Cancelled waits on you only when nothing is in
 * motion for them: a promised automatic set, or new times being prepared or out, wait on nobody at the company.
 */
export function groupFor(app: { stage: ApplicationStage }, mark?: MarkView, now: Date = new Date(), followUp?: FollowUpStrip | null): OwnerGroup {
  const g = ownerGroup(app.stage);
  if (g === "hired" || g === "not_moving_forward") return g;
  if (inCancelled(app.stage, followUp)) return followUpInMotion(followUp) ? "in_process" : "waiting_on_you";
  if (!mark) return g;
  if (mark.mark === "not_a_fit_for_now") return "not_moving_forward";
  if (holdRunning(mark, now)) return "in_process";
  if (holdEnded(mark, now)) return "waiting_on_you";
  return g;
}

/** The small tags a row carries next to its stage: what the person has to do about it. */
export const OWNER_TAG = { checkEligibility: "Check eligibility", holdEnded: "Hold ended" } as const;
export function ownerTags(app: { stage: ApplicationStage }, mark?: MarkView, now: Date = new Date()): string[] {
  const tags: string[] = [];
  if (app.stage === "ineligible") tags.push(OWNER_TAG.checkEligibility);
  if (holdEnded(mark, now) && !LEAVES_PROCESS.includes(app.stage)) tags.push(OWNER_TAG.holdEnded);
  return tags;
}

/**
 * The owner-stage label, with the mark's own words for a mark the strip has no column for, and under Cancelled why they
 * are there ("Asked for new times", "No longer interested", "No-show"), the sub-label on the stage button.
 */
export function ownerStageLabel(stage: OwnerStage, mark?: MarkView, followUp?: FollowUpStrip | null): string {
  if (stage === "cancelled" && followUp) return CANCELLED_REASON_LABEL[followUp.reason];
  return mark?.mark === "not_a_fit_for_now" && stage === "not_moving_forward" ? MARK_LABEL.not_a_fit_for_now : OWNER_STAGE_LABEL[stage];
}

/**
 * Why a mark cannot be set at this step, or null when it can. A person held on an eligibility answer is decided first
 * (kept in or declined); Longlist, Shortlist and Not a fit for now sort the people not yet interviewing; a hold pauses
 * anyone still in the process.
 */
export function markBlockedReason(stage: ApplicationStage, mark: MarkKind): string | null {
  const base = baseOwnerStage(stage);
  if (base === "hired" || base === "not_moving_forward") return `Not available at this step (${STAGE_LABEL[stage]}).`;
  if (stage === "ineligible") return "Check their eligibility answer first: keep them in or decline.";
  if (mark !== "on_hold" && base !== "new") return base === "interviewing" ? "They are interviewing already." : `Not available at this step (${STAGE_LABEL[stage]}).`;
  return null;
}

/**
 * Whether the candidate was told the decision: the message left, someone told them themselves, or the decision was
 * made before decisions became private, when their status page showed it at once.
 */
export function decisionTold(toldState: ToldState | string | null | undefined): boolean {
  return toldState === "sent" || toldState === "told_in_person" || toldState === "before_tracking";
}

/**
 * The step a candidate sees on their status page (plan A1): Received, Under review, Interview or Decision. Steps the
 * team uses internally (recommended for interview, finalist, held on eligibility) read as Under review. A decision the
 * team made privately (declined, talent pool) shows only once the candidate was told; until then they see the step they
 * were at before it (`before`, the stage the decision was made from; Under review when unknown). Marks are never read.
 */
export function candidateStep(stage: ApplicationStage, toldState: ToldState | string | null | undefined, before?: ApplicationStage | null): CandidateStep {
  if (DECISION_STAGES.includes(stage)) {
    if (decisionTold(toldState)) return "decision";
    return before && !DECISION_STAGES.includes(before) ? candidateStep(before, "not_told") : "under_review";
  }
  // the candidate's own acts and an offer they hold are known to them
  if (["hired", "withdrawn", "declined", "offer_sent", "negotiation", "accepted", "onboarding"].includes(stage)) return "decision";
  if (stage === "applied" || stage === "received") return "received";
  if (["interview_scheduled", "interview_complete", "debrief"].includes(stage)) return "interview";
  return "under_review";
}

/** Whether the candidate may still withdraw: anyone in the process, and anyone whose decision they have not been told. */
export function mayWithdraw(stage: ApplicationStage, toldState: ToldState | string | null | undefined): boolean {
  return ACTIVE.includes(stage) || (DECISION_STAGES.includes(stage) && !decisionTold(toldState));
}

export const STAGE_LABEL: Record<ApplicationStage, string> = {
  applied: "Just applied",
  received: "Received",
  ineligible: "Doesn't meet eligibility",
  eligible: "Eligible",
  triaged: "Ready for your review",
  screen_invited: "Invited to a screen",
  screening: "Being screened",
  screen_complete: "Screen complete",
  interview_recommended: "Recommended for interview",
  interview_scheduled: "Interviewing",
  interview_complete: "Interview done: decision needed",
  debrief: "Deciding",
  finalist: "Finalist",
  reference_check: "Checking references",
  offer_draft: "Offer being prepared",
  offer_approval: "Offer needs your approval",
  offer_sent: "Offer out",
  negotiation: "Negotiating",
  accepted: "Accepted",
  declined: "Declined the offer",
  hired: "Hired",
  onboarding: "Starting soon",
  withdrawn: "Withdrew",
  rejected: "Not moving forward",
  talent_pool: "In your talent pool",
};
