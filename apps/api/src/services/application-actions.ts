import { and, desc, eq, inArray } from "drizzle-orm";
import { OWNER_STAGE_LABEL, OwnerStage, type ActiveMark, type Actor, type ApplicationAction, type ApplicationStage, type CandidateNotice, type DecisionMessagePreview, type DecisionWording, type MarkKind, type MembershipRole, type StageMove, type StageMoveVia, type ToldState } from "@ros/contracts";
import { CANCEL_STAGES, DECISION_STAGES, MarkError, STAGE_LABEL, activeFollowUpsFor, activeMarksFor, assertCan, baseOwnerStage, can, clearMark, emit, followUpParked, gate, markBlockedReason, openFollowUpOf, ownerStage, reopenStage, resolvePolicy, setMark, stageBeforeDecision, transition, withdrawQueuedDecision, type FollowUpRow, type FollowUpStrip, type Permission } from "@ros/core";
import { applications, approvalRequests, assessments, candidates, companies, interviewFollowups, interviews, roles, screens, type Tx } from "@ros/db";
import { DecisionMessageError, checkPersonalLine, decisionMessageDraft, decisionsWaitingApproval, newTimesDayWords, queueDecisionMessage, type PersonalLine } from "@ros/agents";
import { HttpError } from "../middleware/errors";
import type { Container } from "../container";
import type { Tenant } from "../middleware/session";
import { exitCleanup } from "./exit-cleanup";
import { OFFER_FROM, offerBlockedReason } from "./offers";
import { UNSTARTED_SCREEN_STATUSES, stopScreenInvitation } from "./screens";
import { keepInTalentPool } from "./talent-pool";

/**
 * What may be done with an application in its current state, decided in one place. The API answers with the list
 * (`allowedActions` on the application detail) so the pages show only real choices, and the action route refuses
 * anything not on it, so the two can never disagree.
 */
export const TERMINAL_STAGES: readonly string[] = ["hired", "withdrawn", "rejected", "declined"];
// A conversation paused while the assistant was down (plan E5) is still open: nobody is invited to a second one.
export const SCREEN_OPEN_STATUSES: readonly string[] = ["invited", "reminded", "in_progress", "paused"];
export const INTERVIEW_ACTIVE_STATUSES: readonly string[] = ["proposed", "scheduling", "scheduled"];
export const INTERVIEW_DONE_STATUSES: readonly string[] = ["completed", "no_show"];
/** The assistant's suggestions that wait on a person (plan A6): a person acting on the candidate directly settles them. */
const SUGGESTIONS = ["application.invite_screen", "application.recommend_interview"];

export type ApplicationCapability = "invite_screen" | "ask_in_screen" | "interview" | "advance_to_interview" | "hold" | "reject" | "move_to_talent_pool" | "override_eligibility" | "review_anyway" | "record_decision" | "record_outcome" | "record_offer" | "set_mark" | "clear_mark" | "send_decision" | "told_in_person" | "cancel_screen" | "undo_decision" | "send_new_times" | "stop_new_times";

/**
 * `role` is the viewer's tenant role when known: every capability is then limited to roles that hold its permission, so a person never sees a button the route would refuse.
 * `openUnknowns` is how many questions the latest résumé assessment left open: "Ask about this in a screen" needs at least one.
 * `mark` and `markRemindAt` are the active private mark; `toldState` and `decisionMessagePending` say whether a decision was told or its message waits for approval.
 * `hasUnstartedScreen`: a screening invitation the candidate has not started, which "Stop this screen invitation" can take back (plan A7).
 * `decidedFrom`: for a decision, the stage it was made from (null: no history), read only where taking it back is offered
 * (left out, "Take back this decision" is not offered); `roleClosed`: the role has closed (its talent-pool moves stay).
 * `followUp`: their open follow-up (the Cancelled column, founder decisions 1A to 4A; `activeFollowUpsFor`), or null.
 * `undoToCancelled`: taking the decision back puts them back under Cancelled (they were declined from there), so the
 * stage button offers it on that row.
 */
export type ApplicationFacts = { stage: string; rejectReason: string | null; hasOpenScreen: boolean; hasActiveInterview: boolean; hasUndecidedInterview: boolean; role?: MembershipRole | null; openUnknowns?: number; mark?: MarkKind | null; markRemindAt?: string | null; toldState?: ToldState | null; decisionMessagePending?: boolean; hasUnstartedScreen?: boolean; decidedFrom?: ApplicationStage | null; roleClosed?: boolean; followUp?: FollowUpStrip | null; undoToCancelled?: boolean };

/** Why a choice is not available right now, in the reader's words; the page puts it on the disabled button. */
export type BlockedReasons = Partial<Record<ApplicationCapability, string>>;

/** The permission each choice needs, and how the refusal names it. */
const CAPABILITY: Record<ApplicationCapability, { permission: Permission; what: string }> = {
  invite_screen: { permission: "application.act", what: "invite candidates to a screen" },
  ask_in_screen: { permission: "application.act", what: "invite candidates to a screen" },
  interview: { permission: "interview.request", what: "approve interviews" },
  advance_to_interview: { permission: "application.act", what: "move candidates forward" },
  hold: { permission: "application.act", what: "hold candidates" },
  move_to_talent_pool: { permission: "application.act", what: "move candidates to the talent pool" },
  reject: { permission: "application.reject", what: "decline candidates" },
  override_eligibility: { permission: "application.act", what: "keep in someone held on an eligibility answer" },
  review_anyway: { permission: "application.act", what: "reopen a declined application" },
  record_decision: { permission: "interview.decide", what: "record the decision after an interview" },
  record_outcome: { permission: "outcome.record", what: "record hiring outcomes" },
  // "Offer made" is record-only (Q29, plan H2): it sits with those who record outcomes, not with offer.manage.
  record_offer: { permission: "outcome.record", what: "record that an offer was made" },
  set_mark: { permission: "application.act", what: "sort candidates into stages" },
  clear_mark: { permission: "application.act", what: "sort candidates into stages" },
  send_decision: { permission: "application.reject", what: "tell candidates about a decision" },
  told_in_person: { permission: "application.reject", what: "tell candidates about a decision" },
  // The candidate is sent a note, so it sits with those who tell candidates decisions: owner, admin, hiring manager, recruiter.
  cancel_screen: { permission: "application.reject", what: "stop a screening invitation" },
  // Taking back a decision sits with those who make it.
  undo_decision: { permission: "application.reject", what: "take back a decision" },
  // New times for someone under Cancelled reopen an interview a person already approved, so they sit with those who manage interviews.
  send_new_times: { permission: "interview.manage", what: "send new interview times" },
  stop_new_times: { permission: "interview.manage", what: "stop automatic new interview times" },
};
const CAPABILITIES = Object.keys(CAPABILITY) as ApplicationCapability[];

const TEAM_ROLES: MembershipRole[] = ["owner", "admin", "hiring_manager", "hr", "recruiter", "interviewer"];
const ROLE_WORDS: Record<MembershipRole, string> = { owner: "an owner", admin: "an admin", hiring_manager: "a hiring manager", hr: "HR", recruiter: "a recruiter", interviewer: "an interviewer" };
const CHECK_ELIGIBILITY_FIRST = "Check their eligibility answer first: keep them in or decline.";

/** "an owner, an admin or a hiring manager": who holds a permission, read off the matrix so the words never drift from it. */
function whoMay(permission: Permission): string {
  const words = TEAM_ROLES.filter((r) => can(r, permission)).map((r) => ROLE_WORDS[r]);
  return words.length > 1 ? `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}` : (words[0] ?? "nobody on the team");
}

const decided = (f: ApplicationFacts) => DECISION_STAGES.includes(f.stage as ApplicationStage);
const untold = (f: ApplicationFacts) => (f.toldState ?? "not_told") === "not_told";
/** A decline on an eligibility answer is taken back with "Review anyway", which reads the application again. */
const eligibilityDecline = (f: ApplicationFacts) => f.stage === "rejected" && f.rejectReason === "eligibility";
/** Where taking back this decision puts them, or null when it cannot be taken back to anywhere (or that is not known here). */
const reopensAt = (f: ApplicationFacts): ApplicationStage | null => (f.decidedFrom === undefined ? null : reopenStage(f.decidedFrom));

/** What the application's state allows, whoever is asking. */
function allowedByState(f: ApplicationFacts): ApplicationCapability[] {
  const out: ApplicationCapability[] = [];
  const terminal = TERMINAL_STAGES.includes(f.stage);
  const sortable = !terminal && f.stage !== "talent_pool" && f.stage !== "ineligible";
  if (["triaged", "eligible", "received", "screen_invited", "screening"].includes(f.stage) && !f.hasOpenScreen) out.push("invite_screen");
  // The one-click follow-up on an assessment with open questions: the same invitation, opened with those questions.
  if (out.includes("invite_screen") && (f.openUnknowns ?? 0) > 0) out.push("ask_in_screen");
  if (["triaged", "screen_complete", "interview_recommended", "interview_complete", "eligible", "screen_invited", "screening"].includes(f.stage) && !f.hasActiveInterview) out.push("interview");
  if (["screen_complete", "triaged", "eligible", "screen_invited", "screening"].includes(f.stage)) out.push("advance_to_interview");
  // A hold is not offered to someone held on an eligibility answer (plan A4): a person decides that first.
  if (sortable) out.push("hold");
  if (!terminal && f.stage !== "talent_pool") out.push("move_to_talent_pool");
  if (!terminal) out.push("reject");
  if (f.stage === "ineligible") out.push("override_eligibility");
  if (f.stage === "rejected" && f.rejectReason === "eligibility") out.push("review_anyway");
  if (!terminal && f.hasUndecidedInterview) out.push("record_decision");
  if (!terminal) out.push("record_outcome");
  if (OFFER_FROM.includes(f.stage as ApplicationStage)) out.push("record_offer");
  if (sortable) out.push("set_mark");
  if (f.mark && !terminal && f.stage !== "talent_pool") out.push("clear_mark");
  if (decided(f) && untold(f) && !f.decisionMessagePending) out.push("send_decision");
  // "I told them myself" also while the message is still on its way: a person's word ends the wait either way.
  if (decided(f) && (untold(f) || f.toldState === "queued")) out.push("told_in_person");
  if (!terminal && f.stage !== "talent_pool" && f.hasUnstartedScreen) out.push("cancel_screen");
  // Quiet undo (plan G1): a decision nobody has told the candidate, with no message waiting for approval, on a role still
  // open, goes back to the step it was made from. Nothing was or will be sent.
  if (decided(f) && untold(f) && !f.decisionMessagePending && !f.roleClosed && !eligibilityDecline(f) && reopensAt(f)) out.push("undo_decision");
  // Under Cancelled (founder decisions 1A to 4A): new times while nothing is being prepared or out to them, and stopping
  // an automatic set still waiting for its day. Whether ITS has confirmed the company is checked by the send itself.
  if (f.followUp && !terminal && CANCEL_STAGES.includes(f.stage as ApplicationStage) && !f.followUp.interviewOpen) out.push("send_new_times");
  if (f.followUp && followUpParked(f.followUp)) out.push("stop_new_times");
  return out;
}

/** Why the decision message cannot be sent or recorded now. */
function tellingReason(f: ApplicationFacts): string {
  if (!decided(f)) return "Only after a decision not to move forward.";
  if (f.toldState === "queued") return "The decision message is on its way.";
  if (f.toldState === "sent") return "They have been sent the decision message.";
  if (f.toldState === "told_in_person") return "Someone recorded telling them in person.";
  if (f.toldState === "before_tracking") return "This decision was made before decisions became private; their status page already showed it.";
  return "The decision message is waiting for approval.";
}

function stateReason(cap: ApplicationCapability, f: ApplicationFacts): string {
  const step = `Not available at this step (${(STAGE_LABEL as Record<string, string>)[f.stage] ?? f.stage.replace(/_/g, " ")}).`;
  switch (cap) {
    case "invite_screen":
      return f.hasOpenScreen ? "A screening invitation is already open." : step;
    case "ask_in_screen":
      return f.hasOpenScreen ? "A screening invitation is already open." : !(f.openUnknowns ?? 0) ? "The assessment left no open questions to ask about." : step;
    case "interview":
      return f.hasActiveInterview ? "An interview is already in motion." : step;
    case "hold":
    case "move_to_talent_pool":
    case "set_mark":
      return f.stage === "talent_pool" ? "They are already in your talent pool." : f.stage === "ineligible" ? CHECK_ELIGIBILITY_FIRST : step;
    case "clear_mark":
      return TERMINAL_STAGES.includes(f.stage) || f.stage === "talent_pool" ? step : "There is no mark to take off.";
    case "override_eligibility":
      return "Only for someone held on an eligibility answer.";
    case "review_anyway":
      return "Only for someone declined on an eligibility answer.";
    case "record_decision":
      return TERMINAL_STAGES.includes(f.stage) ? step : "No finished interview is waiting for a decision.";
    case "record_offer":
      return TERMINAL_STAGES.includes(f.stage) || f.stage === "talent_pool" ? step : (offerBlockedReason(f.stage as ApplicationStage) ?? step);
    case "send_decision":
    case "told_in_person":
      return tellingReason(f);
    case "cancel_screen":
      return TERMINAL_STAGES.includes(f.stage) || f.stage === "talent_pool" ? step : f.hasOpenScreen ? "They have started the screening conversation, so it can't be stopped now." : "No screening invitation is waiting for them.";
    case "undo_decision":
      return !decided(f) ? "Only for a decision not to move forward."
        : !untold(f) ? "They have been told, or the message is on its way, so the decision can't be taken back here."
        : f.decisionMessagePending ? "The decision message is waiting for approval; turn it down first."
        : f.roleClosed ? "The role is closed."
        : eligibilityDecline(f) ? "Use Review anyway: it reads their application again."
        : "This decision can't be taken back here.";
    case "send_new_times":
      return f.followUp?.interviewOpen && CANCEL_STAGES.includes(f.stage as ApplicationStage) ? "New times are already being prepared or are out to them." : "Only for someone under Cancelled.";
    case "stop_new_times":
      return "Nothing is due to go to them automatically.";
    default:
      return step;
  }
}

/**
 * Everything the page needs to show the choices honestly: what may be done now, and for every other choice why not.
 * A missing permission is named first (it holds whatever the state); otherwise the reason is the application's state.
 * Without a known role (a system caller) only the state counts.
 */
export function applicationActionState(f: ApplicationFacts): { allowed: ApplicationCapability[]; blockedReasons: BlockedReasons } {
  const mayDo = (cap: ApplicationCapability) => !f.role || can(f.role, CAPABILITY[cap].permission);
  const allowed = allowedByState(f).filter(mayDo);
  const blockedReasons: BlockedReasons = {};
  for (const cap of CAPABILITIES) {
    if (allowed.includes(cap)) continue;
    blockedReasons[cap] = mayDo(cap) ? stateReason(cap, f) : `Your role can't ${CAPABILITY[cap].what}; ask ${whoMay(CAPABILITY[cap].permission)}.`;
  }
  return { allowed, blockedReasons };
}

export function allowedApplicationActions(f: ApplicationFacts): ApplicationCapability[] {
  return applicationActionState(f).allowed;
}

/**
 * The stage button (founder decision B3): every owner stage, in strip order, with how a choice is carried out and, when
 * it cannot be chosen, why. Longlist, Shortlist and On hold set a private mark in one click; choosing the step under a
 * mark takes the mark off; Interviewing opens the interview approval; Offer opens the record-only "Offer made" for a
 * finalist (plan H2); Hired opens the hire sheet; Not moving forward opens the private decline. Nobody is moved into
 * Cancelled (only the candidate's own cancel or a missed interview puts them there), and from Cancelled they go back to
 * Interviewing by booking a time. Built from `applicationActionState`, so it never offers what the action route refuses.
 */
export function stageMoves(f: ApplicationFacts): StageMove[] {
  const { allowed, blockedReasons } = applicationActionState(f);
  const stage = f.stage as ApplicationStage;
  const mark = f.mark ? { mark: f.mark, remindAt: f.markRemindAt ?? null } : null;
  const current = ownerStage({ stage }, mark, f.followUp);
  const base = baseOwnerStage(stage);
  const past = `Not available at this step (${STAGE_LABEL[stage] ?? stage}).`;
  const move = (to: OwnerStage, via: StageMoveVia, cap: ApplicationCapability | null, extra: { mark?: MarkKind; current?: boolean; reason?: string | null } = {}): StageMove => {
    const ok = !extra.reason && !!cap && allowed.includes(cap);
    const blockedReason = ok ? undefined : (extra.reason ?? (cap ? blockedReasons[cap] : undefined) ?? past);
    return { to, label: OWNER_STAGE_LABEL[to], via, ...(extra.mark ? { mark: extra.mark } : {}), allowed: ok, current: !!extra.current, ...(blockedReason ? { blockedReason } : {}) };
  };
  // A decision the candidate was never told can be taken back to the step it was made from (plan G1): that step is the
  // one choice offered; the others stay blocked with their reasons. Someone declined from Cancelled goes back there.
  const reopen = allowed.includes("undo_decision") ? reopensAt(f) : null;
  const back: OwnerStage | null = reopen ? (f.undoToCancelled ? "cancelled" : baseOwnerStage(reopen)) : null;
  return OwnerStage.options.map((to) => {
    // Someone set aside as not a fit for now shows as Not moving forward; a decline is still a separate, explicit choice.
    if (to === current && to === "not_moving_forward" && mark?.mark === "not_a_fit_for_now") return move(to, "decline", "reject", { current: true });
    if (to === current) return move(to, "none", null, { current: true, reason: "They are here now." });
    if (back && to === back) return move(to, "undo_decision", "undo_decision");
    if (to === base && mark) return move(to, "clear_mark", "clear_mark");
    switch (to) {
      case "longlist":
      case "shortlist":
      case "on_hold":
        return move(to, "set_mark", "set_mark", { mark: to, reason: allowed.includes("set_mark") ? markBlockedReason(stage, to) : null });
      case "new":
        return move(to, "none", null, { reason: base === "new" ? null : "They are past this step." });
      // Without this case the default branch below would open the decline.
      case "cancelled":
        return move(to, "none", null, { reason: "Only the candidate's own cancellation, or an interview they missed, puts someone here." });
      case "interviewing":
        if (current === "cancelled") return move(to, "none", null, { reason: "They move back to Interviewing when they book a time. Send them new times from their page." });
        return base === "new" ? move(to, "interview", "interview") : move(to, "none", null, { reason: base === "interviewing" ? null : past });
      case "offer":
        return base === "hired" || base === "not_moving_forward" ? move(to, "offer", null, { reason: past }) : move(to, "offer", "record_offer");
      case "hired":
        return move(to, "record_hire", "record_outcome");
      default:
        // Someone held on an eligibility answer is declined from that answer's own card (plan A2), so the one reason
        // recorded is the eligibility answer; the stage button points there instead of opening the general decline.
        return move(to, "decline", "reject", { reason: stage === "ineligible" ? CHECK_ELIGIBILITY_FIRST : null });
    }
  });
}

/** The facts the list depends on, from rows the caller may already hold. `triage` is the latest résumé assessment when the caller has it; without it "ask in a screen" is not offered. */
export function applicationFactsFrom(
  app: Pick<typeof applications.$inferSelect, "stage" | "rejectReason"> & { toldState?: ToldState | null },
  screenStatuses: string[],
  interviewRows: Array<{ status: string; decision: string | null }>,
  role?: MembershipRole | null,
  triage?: { result: { unknowns: unknown[] } } | null,
  extra: { mark?: Pick<ActiveMark, "mark" | "remindAt"> | null; decisionMessagePending?: boolean; decidedFrom?: ApplicationStage | null; roleClosed?: boolean; followUp?: FollowUpStrip | null; undoToCancelled?: boolean } = {},
): ApplicationFacts {
  return {
    ...(extra.decidedFrom !== undefined ? { decidedFrom: extra.decidedFrom } : {}),
    ...(extra.undoToCancelled ? { undoToCancelled: true } : {}),
    roleClosed: !!extra.roleClosed,
    followUp: extra.followUp ?? null,
    stage: app.stage,
    rejectReason: app.rejectReason,
    hasOpenScreen: screenStatuses.some((s) => SCREEN_OPEN_STATUSES.includes(s)),
    hasUnstartedScreen: screenStatuses.some((s) => UNSTARTED_SCREEN_STATUSES.includes(s)),
    hasActiveInterview: interviewRows.some((i) => INTERVIEW_ACTIVE_STATUSES.includes(i.status)),
    hasUndecidedInterview: interviewRows.some((i) => INTERVIEW_DONE_STATUSES.includes(i.status) && !i.decision),
    role: role ?? null,
    openUnknowns: triage?.result.unknowns.length ?? 0,
    mark: extra.mark?.mark ?? null,
    markRemindAt: extra.mark?.remindAt ?? null,
    toldState: app.toldState ?? "not_told",
    decisionMessagePending: !!extra.decisionMessagePending,
  };
}

/** Decision messages waiting for an approver, for these applications: their own, or a closed role's one closing message (Q30). */
export async function pendingDecisionMessages(tx: Tx, applicationIds: string[]): Promise<Set<string>> {
  return decisionsWaitingApproval(tx, applicationIds);
}

/**
 * What taking back a decision needs to know (plan G1): the stage it was made from, whether the role has closed, and
 * whether it puts them back under Cancelled (their newest follow-up ended when the decision took them out of the
 * process, and the step it goes back to is one where Cancelled shows: `restoreFollowUpAfterUndo`). Only for a decision
 * nobody told, of someone whose details were not deleted; otherwise nothing (not offered).
 */
export async function undoFacts(tx: Tx, app: Pick<typeof applications.$inferSelect, "id" | "stage" | "toldState" | "roleId" | "candidateId">): Promise<{ decidedFrom?: ApplicationStage | null; roleClosed?: boolean; undoToCancelled?: boolean }> {
  if (!DECISION_STAGES.includes(app.stage) || app.toldState !== "not_told") return {};
  const [cand] = await tx.select({ anonymizedAt: candidates.anonymizedAt }).from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
  if (!cand || cand.anonymizedAt) return {};
  const [role] = await tx.select({ status: roles.status }).from(roles).where(eq(roles.id, app.roleId)).limit(1);
  const decidedFrom = await stageBeforeDecision(tx, app.id);
  const back = reopenStage(decidedFrom);
  const [newest] = back && CANCEL_STAGES.includes(back) ? await tx.select({ resolvedHow: interviewFollowups.resolvedHow }).from(interviewFollowups).where(eq(interviewFollowups.applicationId, app.id)).orderBy(desc(interviewFollowups.createdAt), desc(interviewFollowups.id)).limit(1) : [];
  return { decidedFrom, roleClosed: role?.status === "closed", ...(newest?.resolvedHow === "left_process" ? { undoToCancelled: true } : {}) };
}

export async function applicationFacts(tx: Tx, app: Pick<typeof applications.$inferSelect, "id" | "stage" | "rejectReason" | "toldState" | "roleId" | "candidateId">, role?: MembershipRole | null): Promise<ApplicationFacts> {
  const scr = await tx.select({ status: screens.status }).from(screens).where(eq(screens.applicationId, app.id));
  const ivs = await tx.select({ status: interviews.status, decision: interviews.decision }).from(interviews).where(eq(interviews.applicationId, app.id));
  const [triage] = await tx.select({ result: assessments.result }).from(assessments).where(and(eq(assessments.applicationId, app.id), eq(assessments.kind, "triage"))).orderBy(desc(assessments.createdAt)).limit(1);
  const mark = (await activeMarksFor(tx, [app.id])).get(app.id) ?? null;
  const pending = await pendingDecisionMessages(tx, [app.id]);
  const followUp = (await activeFollowUpsFor(tx, [app.id])).get(app.id) ?? null;
  return applicationFactsFrom(app, scr.map((s) => s.status), ivs, role, triage ?? null, { mark, decisionMessagePending: pending.has(app.id), followUp, ...(await undoFacts(tx, app)) });
}

/** Whether the message is out or on its way (held for the ITS check counts: it goes on its own): what `dispositionSent` has always meant. */
export const declineSent = (n: CandidateNotice): boolean => n === "queued" || n === "held";

type App = typeof applications.$inferSelect;
/**
 * What a "Send" did: the toast's words, the told state now, the approval request when it waits for one, and, for a
 * message on its way, the message and when its Undo ends (plan G9; null when the company sends at once).
 */
export type DecisionMessageResult = { notice: CandidateNotice; toldState: ToldState; approvalRequestId?: string; communicationId?: string | null; undoUntil?: string | null; wording?: DecisionWording | null };

/** When a message a person sends now leaves, if the Undo window holds it (plan G9); null when it goes at once. */
export function undoUntil(container: Container): Date | null {
  const seconds = container.env.MESSAGE_UNDO_SECONDS;
  return seconds > 0 ? new Date(container.engine.clock().getTime() + seconds * 1000) : null;
}

/**
 * A person's personal line (Q28), checked before anything is written: refused with what to take out when it carries a
 * score, an assessment, the recorded reason or a personal characteristic. Null when there is none.
 */
export function personalLineOf(text: string | null | undefined, senderName: string): PersonalLine | null {
  if (!text?.trim()) return null;
  const checked = checkPersonalLine(text);
  if (!checked.ok) throw new HttpError(400, "personal_line_refused", checked.message, { problems: checked.problems });
  return { text: checked.text, senderName };
}

/** The decision message's own refusals, in the person's words. */
function decisionHttpError(e: unknown): never {
  if (e instanceof DecisionMessageError) throw new HttpError(e.code === "wording_not_allowed" ? 400 : 409, e.code, e.message);
  throw e;
}

/** What a waiting decision message carries to its approver: the wording and the personal line it will go with. */
type DecisionProposal = { reason?: string; decision?: string; wording?: DecisionWording | null; personalLine?: PersonalLine | null };

/** Queues the decision message (packages/agents decision-messages.ts) and says what happened, with the Undo window when a person sent it. */
async function deliverDecision(tx: Tx, container: Container, input: { app: App; actor: Actor; wording?: DecisionWording | null; personalLine?: PersonalLine | null; holdForUndo: boolean }): Promise<DecisionMessageResult> {
  const sendAt = input.holdForUndo ? undoUntil(container) : null;
  const r = await queueDecisionMessage(tx, container.integrations, { app: input.app, actor: input.actor, wording: input.wording ?? null, personalLine: input.personalLine ?? null, statusBaseUrl: container.env.JOBS_BASE_URL, now: container.engine.clock(), sendAt }).catch(decisionHttpError);
  // A message held for the ITS company check waits anyway; Undo is offered for one queued to leave.
  return { notice: r.notice, toldState: r.toldState, communicationId: r.communicationId, undoUntil: sendAt && r.notice === "queued" ? sendAt.toISOString() : null, wording: r.wording };
}

/**
 * "Send the decision message" (founder decision B6): a person tells the candidate a decision that was filed privately,
 * in one of the approved wordings (Q28: the default one unless they chose another; the eligibility wording after an
 * eligibility decline, always), with an optional personal line they wrote, checked first. The company's settings for
 * the role decide what the Send does: it goes (the default) after the Undo window, it waits for an approver ("ask me
 * first", and during a recruiter takeover, the recruiter) with the wording and line kept for them, or nothing is sent
 * ("only a person": the team tells candidates themselves).
 */
export async function sendDecisionMessage(tx: Tx, container: Container, input: { app: App; actor: Actor; wording?: DecisionWording | null; personalLine?: string | null }): Promise<DecisionMessageResult> {
  const { app, actor } = input;
  if (!DECISION_STAGES.includes(app.stage)) throw new HttpError(409, "not_decided", "There is no decision to tell them about yet.");
  if (app.toldState !== "not_told") throw new HttpError(409, "already_told", tellingReason({ stage: app.stage, rejectReason: app.rejectReason, hasOpenScreen: false, hasActiveInterview: false, hasUndecidedInterview: false, toldState: app.toldState }));
  if ((await pendingDecisionMessages(tx, [app.id])).has(app.id)) throw new HttpError(409, "waiting_approval", "The decision message is already waiting for approval.");
  const personalLine = personalLineOf(input.personalLine, actor.name ?? "A member of the hiring team");
  // The wording is checked before the gate, so a request for approval never carries a wording that could not be sent.
  const draft = await decisionMessageDraft(tx, { app, wording: input.wording ?? null, personalLine, statusBaseUrl: container.env.JOBS_BASE_URL, now: container.engine.clock() }).catch(decisionHttpError);
  const proposal: DecisionProposal = { reason: draft?.wording === "eligibility" ? "eligibility" : "human", decision: app.stage, wording: draft?.wording ?? null, personalLine };
  const d = await gate(tx, { companyId: app.companyId, roleId: app.roleId, applicationId: app.id, actionType: "disposition.send", subject: { type: "application", id: app.id }, proposal, requestedBy: actor });
  if (d.outcome === "wait_for_approval") return { notice: "waiting_approval", toldState: app.toldState, approvalRequestId: d.approvalRequestId };
  if (d.outcome === "human_only") return { notice: "not_sent_settings", toldState: app.toldState };
  return deliverDecision(tx, container, { app, actor, wording: draft?.wording ?? null, personalLine, holdForUndo: true });
}

/**
 * The approved half of a `disposition.send` approval request: the decision message goes out exactly as the Send would
 * have sent it, in the wording and with the personal line the request carries. Nothing is sent when the decision was
 * reversed in the meantime (for instance after "review anyway") or the candidate was told another way. Null when
 * nothing was sent. The approver's click is the second look, so it goes at once.
 */
export async function sendApprovedDecline(tx: Tx, container: Container, input: { applicationId: string; actor: Actor; proposal?: unknown }): Promise<DecisionMessageResult | null> {
  const [app] = await tx.select().from(applications).where(eq(applications.id, input.applicationId)).limit(1);
  if (!app || !DECISION_STAGES.includes(app.stage) || app.toldState !== "not_told") return null;
  const p = (input.proposal ?? {}) as DecisionProposal;
  const personalLine = p.personalLine?.text ? { text: p.personalLine.text, senderName: p.personalLine.senderName ?? "A member of the hiring team" } : null;
  // A wording that no longer fits (the decision changed under it) falls back to the suggested one rather than failing the approval.
  const wording = await decisionMessageDraft(tx, { app, wording: p.wording ?? null, statusBaseUrl: container.env.JOBS_BASE_URL, now: container.engine.clock() }).then((d) => d?.wording ?? null, (e: unknown) => { if (e instanceof DecisionMessageError) return null; throw e; });
  return deliverDecision(tx, container, { app, actor: input.actor, wording, personalLine, holdForUndo: false });
}

/**
 * What the decision message will say, for the preview before Send (`DecisionMessagePreview`): the same words the Send
 * writes, in the chosen wording with the personal line (checked), who it goes to, the wordings on offer, whether
 * Colorado's line is in it, what the Send does under the company's settings and how long the Undo lasts. Null when there
 * is no decision to tell.
 */
export async function decisionMessagePreview(tx: Tx, container: Container, app: App, input: { wording?: DecisionWording | null; personalLine?: string | null; senderName?: string } = {}): Promise<DecisionMessagePreview | null> {
  const personalLine = personalLineOf(input.personalLine, input.senderName ?? "A member of the hiring team");
  const draft = await decisionMessageDraft(tx, { app, wording: input.wording ?? null, personalLine, statusBaseUrl: container.env.JOBS_BASE_URL, now: container.engine.clock() }).catch(decisionHttpError);
  if (!draft) return null;
  const pending = await pendingDecisionMessages(tx, [app.id]);
  return { to: draft.to, subject: draft.subject, text: draft.text, wording: draft.wording, wordings: draft.wordings, personalLine: draft.personalLine, adverseDecisionLine: draft.adverseDecisionLine, policy: await declineMessagePolicy(tx, { companyId: app.companyId, roleId: app.roleId }), toldState: app.toldState, candidateToldAt: app.candidateToldAt ? new Date(app.candidateToldAt).toISOString() : null, waitingApproval: pending.has(app.id), undoSeconds: container.env.MESSAGE_UNDO_SECONDS };
}

/**
 * What a Send does under the company's settings for this role (takeovers included), so the page can say it before the
 * click: the message goes at once, waits for an approver, or is not sent at all. Declining itself never sends anything.
 */
export async function declineMessagePolicy(tx: Tx, input: { companyId: string; roleId: string }): Promise<"sends" | "needs_approval" | "not_sent"> {
  const d = await resolvePolicy(tx, input.companyId, input.roleId, "disposition.send");
  return d.level === "human_only" ? "not_sent" : d.level === "approval" ? "needs_approval" : "sends";
}

/**
 * The choices that answer the assistant's waiting suggestions (plan A6): a decline or a move to the talent pool, a hold
 * (On hold, Not a fit for now), and a person's own invitation or move to interview. Sorting onto the Longlist or the
 * Shortlist, taking a mark off, and telling a decision leave a suggestion waiting for its own Yes or Not now.
 */
export function settlesSuggestions(body: Pick<ApplicationAction, "action" | "mark">): boolean {
  switch (body.action) {
    case "reject":
    case "move_to_talent_pool":
    case "hold":
    case "invite_screen":
    case "ask_in_screen":
    case "advance_to_interview":
      return true;
    case "set_mark":
      return body.mark === "on_hold" || body.mark === "not_a_fit_for_now";
    default:
      return false;
  }
}

/**
 * Settles the assistant's waiting suggestions about this candidate when a person acts on them directly (plan A6): the
 * suggestion the action carries out is approved (inviting to a screen approves "Invite to a screen?"; moving to
 * interview approves "Interview?"), every other one is cancelled, and the waiting workflow is woken either way.
 */
async function settleSuggestions(tx: Tx, container: Container, input: { app: App; tenant: Tenant; actor: Actor; action: ApplicationAction["action"]; note?: string }): Promise<void> {
  const { app, tenant: t, actor } = input;
  const approves = input.action === "invite_screen" || input.action === "ask_in_screen" ? "application.invite_screen" : input.action === "advance_to_interview" ? "application.recommend_interview" : null;
  const pend = await tx.select().from(approvalRequests).where(and(eq(approvalRequests.applicationId, app.id), inArray(approvalRequests.actionType, SUGGESTIONS), eq(approvalRequests.status, "pending")));
  const decidedAt = container.engine.clock().toISOString();
  for (const p of pend) {
    const approved = p.actionType === approves;
    const decisionNote = input.note ?? (approved ? "done from the candidate page" : `a person acted on the candidate directly (${input.action.replace(/_/g, " ")})`);
    await tx.update(approvalRequests).set({ status: approved ? "approved" : "cancelled", decidedBy: t.userId, decidedAt, decisionNote }).where(eq(approvalRequests.id, p.id));
    await emit(tx, { type: approved ? "approval.granted" : "approval.cancelled", companyId: t.companyId, actor, subject: { type: "approval_request", id: p.id }, payload: { actionType: p.actionType, applicationId: app.id, by: input.action }, correlationId: p.workflowRunId });
    await container.engine.signal(tx, { companyId: t.companyId, key: `approval:${p.id}`, payload: { decision: approved ? "approved" : "cancelled" } });
  }
}

/** The private-decision sentence every decline and mark answers with (founder decision B6). */
const PRIVATE_DECISION = "Private: the candidate has not been told. Send the decision message from their page when you are ready.";

type ActionBody = ApplicationAction;
/**
 * `candidateNotice` says what became of the candidate's message (`not_told` for every decision, hold and mark);
 * `toldState` is the told state after the action; `ownerStage` and `mark` are where the person now sits on the strip.
 * `talentPoolOptOut`: a move to the talent pool for someone who asked not to be kept for future roles; they stay out of
 * the pool. `dispositionSent` is kept for older pages: true only when a message is on its way. `interviewsCancelled`:
 * interviews a decision called off; `interviewOffNotes`: how many of them the candidate was told about at once, in a
 * short note with no reason (they had a booked time or times to pick from). The decision itself stays private.
 * send_decision: `communicationId` and `undoUntil` while the message waits out its Undo window (plan G9; POST
 * /applications/:id/messages/:communicationId/undo), and the `wording` used. A decision (decline, talent pool) answers
 * with `decisionMessage`: the message one Send would now write, for the confirmation to show it (plan G4).
 */
export type ActionResult = { ok: true; stage: string; ownerStage?: OwnerStage; mark?: ActiveMark | null; toldState?: ToldState; dispositionSent?: boolean; candidateNotice?: CandidateNotice; approvalRequestId?: string; workflowRunId?: string; next?: string; talentPoolOptOut?: boolean; interviewsCancelled?: number; interviewOffNotes?: number; communicationId?: string | null; undoUntil?: string | null; wording?: DecisionWording | null; decisionMessage?: DecisionMessagePreview | null };

/** The decision message a Send would write now, for the answer to a decision (a count of one and its preview, plan G4). */
async function previewAfterDecision(tx: Tx, container: Container, applicationId: string): Promise<DecisionMessagePreview | null> {
  const [fresh] = await tx.select().from(applications).where(eq(applications.id, applicationId)).limit(1);
  return fresh ? decisionMessagePreview(tx, container, fresh) : null;
}

/**
 * What taking back a decision says about someone it put back under Cancelled: their promised set still goes on its day
 * (it was waiting, and its day is still ahead), or nothing goes until the team acts.
 */
async function restoredSetWords(tx: Tx, row: Pick<FollowUpRow, "companyId" | "autoState" | "autoDueAt">): Promise<string> {
  if (row.autoState !== "waiting" || !row.autoDueAt) return " Nothing will be sent until you act.";
  const [company] = await tx.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, row.companyId)).limit(1);
  return ` Their new times still go to them automatically on ${newTimesDayWords(row.autoDueAt, company?.timezone ?? "UTC")}, as they asked.`;
}

function markHttpError(e: unknown): never {
  if (e instanceof MarkError) throw new HttpError(e.code === "bad_date" ? 400 : 409, e.code, e.message);
  throw e;
}

/**
 * Where a decision came from when it was not a click on the candidate: Review and apply on the pool board (plan F8),
 * with what the board suggested for this person. Recorded on the mark (source "board") and on the decision's events as
 * "suggested by the assistant, applied by" the person acting.
 */
export type ActionVia = { via: "review_and_apply"; batchId: string; suggested: string | null };

/** One person's decision about one application, inside the caller's tenant transaction. */
export async function performApplicationAction(tx: Tx, container: Container, input: { app: App; body: ActionBody; tenant: Tenant; actor: Actor; via?: ActionVia }): Promise<ActionResult> {
  const { app, body, tenant: t, actor } = input;
  const provenance = input.via ? { via: input.via.via, batchId: input.via.batchId, suggested: input.via.suggested, suggestedBy: "assistant", appliedBy: actor.name ?? actor.id } : {};
  const by = t.role;
  // Who may comes first: a role without the permission is refused (403) whatever the application's state.
  assertCan(t.role, CAPABILITY[body.action].permission);
  const facts = await applicationFacts(tx, app, t.role);
  if (!allowedApplicationActions(facts).includes(body.action)) {
    if ((body.action === "invite_screen" || body.action === "ask_in_screen") && facts.hasOpenScreen) throw new HttpError(409, "already_invited", "They already have an open screening invitation.");
    if (body.action === "ask_in_screen" && !(facts.openUnknowns ?? 0)) throw new HttpError(409, "nothing_to_ask", "The assessment left no open questions to ask about; invite them to the usual screen instead.");
    if (body.action === "override_eligibility") throw new HttpError(409, "invalid", "Only ineligible applications can be overridden.");
    if (body.action === "review_anyway") throw new HttpError(409, "invalid", "Only applications declined on an eligibility answer can be reopened here.");
    if (body.action === "clear_mark" && !facts.mark && !TERMINAL_STAGES.includes(app.stage)) throw new HttpError(409, "no_mark", "There is no mark to take off.");
    if ((body.action === "set_mark" || body.action === "hold") && app.stage === "ineligible") throw new HttpError(409, "not_allowed", CHECK_ELIGIBILITY_FIRST);
    if (body.action === "send_decision" || body.action === "told_in_person") throw new HttpError(409, !decided(facts) ? "not_decided" : untold(facts) && facts.decisionMessagePending ? "waiting_approval" : "already_told", tellingReason(facts));
    if (body.action === "cancel_screen") throw new HttpError(409, facts.hasOpenScreen ? "screen_started" : "no_screen_invitation", stateReason("cancel_screen", facts));
    if (body.action === "undo_decision") throw new HttpError(409, !decided(facts) ? "not_decided" : !untold(facts) ? "already_told" : facts.decisionMessagePending ? "waiting_approval" : "not_allowed", stateReason("undo_decision", facts));
    throw new HttpError(409, "invalid", `Cannot ${body.action.replace(/_/g, " ")} someone who is ${STAGE_LABEL[app.stage].toLowerCase()}.`);
  }
  if (settlesSuggestions(body)) await settleSuggestions(tx, container, { app, tenant: t, actor, action: body.action, note: body.note });
  const now = container.engine.clock();
  switch (body.action) {
    case "reject": {
      assertCan(t.role, "application.reject");
      if (!body.reason) throw new HttpError(400, "reason_required", "A reason is required to decline a candidate.");
      await transition(tx, { applicationId: app.id, companyId: t.companyId, to: "rejected", by, actor, reason: body.reason, payload: { note: body.note ?? null, ...provenance } });
      await tx.update(applications).set({ rejectNote: body.note ?? null }).where(eq(applications.id, app.id));
      await emit(tx, { type: "application.rejected", companyId: t.companyId, actor, subject: { type: "application", id: app.id }, payload: { reason: body.reason, byHuman: true, candidateTold: false, ...provenance } });
      await emit(tx, { type: "human.override", companyId: t.companyId, actor, subject: { type: "application", id: app.id }, payload: { action: "reject", reason: body.reason, ...provenance } });
      // Decisions are private (founder decision B6): the decision is not sent. An interview still to come is called off,
      // and a candidate who held a booked time or was offered times is told at once, with no reason, that it is off, so
      // nobody turns up for it; the decision message sent later leaves it out.
      const cleaned = await exitCleanup(tx, container, { companyId: t.companyId, applicationId: app.id, reason: `declined: ${body.reason}`, actor, candidateEmail: "private_decision" });
      const decisionMessage = input.via ? null : await previewAfterDecision(tx, container, app.id);
      return { ok: true, stage: "rejected", ownerStage: "not_moving_forward", mark: null, toldState: "not_told", dispositionSent: false, candidateNotice: "not_told", interviewsCancelled: cleaned.interviewsCancelled, interviewOffNotes: cleaned.candidateNotes, next: PRIVATE_DECISION, ...(decisionMessage ? { decisionMessage } : {}) };
    }
    case "override_eligibility": {
      assertCan(t.role, "application.act");
      if (!body.note?.trim()) throw new HttpError(400, "reason_required", "Say why you are keeping them in; it is recorded so the system can learn.");
      await transition(tx, { applicationId: app.id, companyId: t.companyId, to: "eligible", by, actor, reason: body.note });
      await emit(tx, { type: "human.override", companyId: t.companyId, actor, subject: { type: "application", id: app.id }, payload: { action: "override_eligibility", note: body.note } });
      return { ok: true, stage: "eligible", ownerStage: "new" };
    }
    case "review_anyway": {
      // The exclusion view's "review anyway" (docs/FOUNDER-CONTEXT.md §10): reopen an application that an owner-authored eligibility rule declined.
      assertCan(t.role, "application.act");
      await transition(tx, { applicationId: app.id, companyId: t.companyId, to: "eligible", by, actor, reason: body.note ?? "review anyway" });
      await tx.update(applications).set({ rejectedAt: null, rejectReason: null, rejectNote: null }).where(eq(applications.id, app.id));
      await emit(tx, { type: "human.override", companyId: t.companyId, actor, subject: { type: "application", id: app.id }, payload: { action: "review_anyway", note: body.note ?? null } });
      const { runId } = await container.engine.start(tx, { workflowKey: "application_intake", companyId: t.companyId, subject: { type: "application", id: app.id }, state: { applicationId: app.id, roleId: app.roleId }, idempotencyKey: `application_intake:${app.id}:reopen:${Date.now()}`, actor });
      return { ok: true, stage: "eligible", ownerStage: "new", workflowRunId: runId };
    }
    case "move_to_talent_pool": {
      assertCan(t.role, "application.act");
      await transition(tx, { applicationId: app.id, companyId: t.companyId, to: "talent_pool", by, actor, reason: body.note });
      // Someone who asked not to be kept for future roles (Wave 0 item 0.11) leaves this role's active list but is never
      // marked as kept: the team's click does not undo the person's own choice, and the answer says so.
      const optedOut = (await keepInTalentPool(tx, [app.candidateId])).optedOut.length > 0;
      await emit(tx, { type: "application.moved_to_talent_pool", companyId: t.companyId, actor, subject: { type: "application", id: app.id }, payload: optedOut ? { talentPoolOptOut: true } : {} });
      const cleaned = await exitCleanup(tx, container, { companyId: t.companyId, applicationId: app.id, reason: "moved to the talent pool", actor, candidateEmail: "private_decision" });
      // Private like every decision (B6); the answer carries the message a Send would write, a count of one (plan G4).
      const decisionMessage = input.via ? null : await previewAfterDecision(tx, container, app.id);
      return { ok: true, stage: "talent_pool", ownerStage: "not_moving_forward", mark: null, toldState: "not_told", candidateNotice: "not_told", interviewsCancelled: cleaned.interviewsCancelled, interviewOffNotes: cleaned.candidateNotes, ...(optedOut ? { talentPoolOptOut: true } : {}), ...(decisionMessage ? { decisionMessage } : {}) };
    }
    case "hold":
    case "set_mark": {
      // "Hold" is the On hold mark: private, with the date it ends (14 days unless a date is chosen).
      assertCan(t.role, "application.act");
      const mark: MarkKind | undefined = body.action === "hold" ? "on_hold" : body.mark;
      if (!mark) throw new HttpError(400, "mark_required", "Choose Longlist, Shortlist, On hold or Not a fit for now.");
      const set = await setMark(tx, { companyId: t.companyId, app, mark, note: body.note, remindAt: body.remindAt, actor, source: input.via ? "board" : "manual", now }).catch(markHttpError);
      await emit(tx, { type: "human.override", companyId: t.companyId, actor, subject: { type: "application", id: app.id }, payload: { action: "set_mark", mark, note: body.note ?? null, remindAt: set.mark.remindAt, ...provenance } });
      const until = set.mark.remindAt ? new Date(set.mark.remindAt).toLocaleDateString("en-US", { month: "long", day: "numeric" }) : null;
      return { ok: true, stage: app.stage, ownerStage: ownerStage(app, set.mark), mark: set.mark, toldState: app.toldState, candidateNotice: "not_told", next: until ? `On hold until ${until}; they come back to Today then. The candidate was not told.` : "Private: the candidate was not told." };
    }
    case "clear_mark": {
      assertCan(t.role, "application.act");
      const cleared = await clearMark(tx, { companyId: t.companyId, applicationId: app.id, actor, note: body.note, now }).catch(markHttpError);
      await emit(tx, { type: "human.override", companyId: t.companyId, actor, subject: { type: "application", id: app.id }, payload: { action: "clear_mark", mark: cleared, note: body.note ?? null } });
      return { ok: true, stage: app.stage, ownerStage: ownerStage(app, null), mark: null, toldState: app.toldState, candidateNotice: "not_told" };
    }
    case "send_decision": {
      assertCan(t.role, "application.reject");
      const r = await sendDecisionMessage(tx, container, { app, actor, wording: body.wording ?? null, personalLine: body.personalLine ?? null });
      return { ok: true, stage: app.stage, ownerStage: ownerStage(app, null), toldState: r.toldState, candidateNotice: r.notice, dispositionSent: declineSent(r.notice), ...(r.approvalRequestId ? { approvalRequestId: r.approvalRequestId } : {}), ...(r.communicationId !== undefined ? { communicationId: r.communicationId, undoUntil: r.undoUntil ?? null, wording: r.wording ?? null } : {}) };
    }
    case "told_in_person": {
      // "I told them myself": the decision is told, nothing more is sent, and a decision message waiting for approval, or
      // still waiting in the outbox, is withdrawn.
      assertCan(t.role, "application.reject");
      await withdrawQueuedDecision(tx, { applicationId: app.id, companyId: t.companyId, actor, reason: "the candidate was told in person" });
      await tx.update(applications).set({ toldState: "told_in_person", candidateToldAt: now.toISOString() }).where(and(eq(applications.id, app.id), inArray(applications.toldState, ["not_told", "queued"])));
      const waiting = await tx.update(approvalRequests).set({ status: "cancelled", decidedBy: t.userId, decidedAt: now.toISOString(), decisionNote: "the candidate was told in person" }).where(and(eq(approvalRequests.applicationId, app.id), eq(approvalRequests.actionType, "disposition.send"), eq(approvalRequests.status, "pending"))).returning({ id: approvalRequests.id });
      for (const w of waiting) await emit(tx, { type: "approval.cancelled", companyId: t.companyId, actor, subject: { type: "approval_request", id: w.id }, payload: { actionType: "disposition.send", applicationId: app.id, by: "told_in_person" } });
      await emit(tx, { type: "application.told", companyId: t.companyId, actor, subject: { type: "application", id: app.id }, payload: { how: "in_person", note: body.note ?? null } });
      return { ok: true, stage: app.stage, ownerStage: ownerStage(app, null), toldState: "told_in_person", candidateNotice: "not_told", next: "Recorded that you told them yourself. Nothing more will be sent." };
    }
    case "invite_screen":
    case "ask_in_screen": {
      assertCan(t.role, "application.act");
      // "Ask about this in a screen": the same invitation, opened with the assessment's open questions (docs/spec/21, P1).
      const focus = body.action === "ask_in_screen" || body.focus === "unknowns" ? ("unknowns" as const) : undefined;
      const { runId } = await container.engine.start(tx, { workflowKey: "screen", companyId: t.companyId, subject: { type: "application", id: app.id }, state: { applicationId: app.id, roleId: app.roleId, channel: body.channel, invitedBy: t.userId, ...(focus ? { focus } : {}) }, idempotencyKey: `screen:${app.id}:${Date.now()}`, actor });
      await emit(tx, { type: "human.override", companyId: t.companyId, actor, subject: { type: "application", id: app.id }, payload: { action: body.action, channel: body.channel ?? "auto", focus: focus ?? null, note: body.note ?? null, workflowRunId: runId, ...provenance } });
      return { ok: true, stage: app.stage, workflowRunId: runId, next: focus ? "Invitation on its way. The screen starts with the open questions from the assessment; the answers land on the candidate's page." : undefined };
    }
    case "cancel_screen": {
      // "Stop this screen invitation" (plan A7): before they start, the invitation is taken back with a short, polite note.
      assertCan(t.role, "application.reject");
      const stopped = await stopScreenInvitation(tx, container, { app, actor, by, note: body.note });
      await emit(tx, { type: "human.override", companyId: t.companyId, actor, subject: { type: "application", id: app.id }, payload: { action: "cancel_screen", screenId: stopped.screenId, note: body.note ?? null } });
      const [after] = await tx.select({ stage: applications.stage }).from(applications).where(eq(applications.id, app.id)).limit(1);
      const stage = after?.stage ?? app.stage;
      return { ok: true, stage, ownerStage: ownerStage({ stage }, facts.mark ? { mark: facts.mark, remindAt: facts.markRemindAt } : null), next: stopped.candidateTold ? "Screening invitation stopped. The candidate was sent a short note saying there is nothing to do with that link; they are back with you to review." : "Screening invitation stopped. We had no email address to tell the candidate; they are back with you to review." };
    }
    case "undo_decision": {
      // Quiet undo (plan G1): a decision the candidate was never told goes, and they are back at the step it was made
      // from. Nothing was sent and nothing will be: they leave the decisions the untold safety net looks at, and a later
      // decline is a new decision with its own date (and its own message). Recorded as a person's override.
      assertCan(t.role, "application.reject");
      const to = reopensAt(facts);
      if (!to) throw new HttpError(409, "not_allowed", stateReason("undo_decision", facts));
      // On the engine's clock: it decides whether a promised set's day is still ahead (`restoreFollowUpAfterUndo`).
      await transition(tx, { applicationId: app.id, companyId: t.companyId, to, by, actor, reason: "decision taken back before the candidate was told", undoDecision: true, payload: { undo: true, note: body.note ?? null }, now });
      await emit(tx, { type: "human.override", companyId: t.companyId, actor, subject: { type: "application", id: app.id }, payload: { action: "undo_decision", from: app.stage, to, note: body.note ?? null } });
      // Someone declined from Cancelled goes back there with their choice; their promised set too while its day is ahead.
      const restored = await openFollowUpOf(tx, app.id);
      if (restored) return { ok: true, stage: to, ownerStage: "cancelled", mark: null, toldState: "not_told", candidateNotice: "not_told", next: `Decision taken back: they are back under Cancelled. They were never told.${await restoredSetWords(tx, restored)}` };
      const owner = baseOwnerStage(to);
      return { ok: true, stage: to, ownerStage: owner, mark: null, toldState: "not_told", candidateNotice: "not_told", next: `Decision taken back: they are back in ${OWNER_STAGE_LABEL[owner]}. They were never told, and nothing will be sent.` };
    }
    case "advance_to_interview": {
      assertCan(t.role, "application.act");
      await transition(tx, { applicationId: app.id, companyId: t.companyId, to: "interview_recommended", by, actor, reason: body.note ?? "owner decision" });
      await emit(tx, { type: "candidate.recommended", companyId: t.companyId, actor, subject: { type: "application", id: app.id }, payload: { by: "human" } });
      await emit(tx, { type: "human.override", companyId: t.companyId, actor, subject: { type: "application", id: app.id }, payload: { action: "advance_to_interview", note: body.note ?? null } });
      return { ok: true, stage: "interview_recommended", ownerStage: "interviewing", candidateNotice: "not_told", next: "Marked as recommended for interview. Open the candidate and choose \"Approve an interview\" to pick the round and interviewers; times go out to the candidate from there." };
    }
  }
}

/**
 * "Send the decision message" for several people at once (the Talent page and the Today card): each person gets the
 * same Send as on their own page, with their own result, so one refusal never blocks the rest. `wording` is one approved
 * wording for all of them; someone it does not fit (an eligibility decline, say) gets their own suggested wording.
 * Each message waits out the Undo window; `communicationId` and `undoUntil` let the page offer Undo per person.
 */
export async function sendDecisionMessages(tx: Tx, container: Container, input: { roleId: string; applicationIds: string[]; tenant: Tenant; actor: Actor; wording?: DecisionWording | null }): Promise<Array<{ applicationId: string; ok: boolean; candidateNotice?: CandidateNotice; toldState?: ToldState; communicationId?: string | null; undoUntil?: string | null; code?: string; message?: string }>> {
  assertCan(input.tenant.role, "application.reject");
  const ids = [...new Set(input.applicationIds)];
  const rows = await tx.select().from(applications).where(and(eq(applications.roleId, input.roleId), inArray(applications.id, ids)));
  const out: Array<{ applicationId: string; ok: boolean; candidateNotice?: CandidateNotice; toldState?: ToldState; communicationId?: string | null; undoUntil?: string | null; code?: string; message?: string }> = [];
  const send = (app: App, wording: DecisionWording | null) => sendDecisionMessage(tx, container, { app, actor: input.actor, wording });
  for (const id of ids) {
    const app = rows.find((r) => r.id === id);
    if (!app || (input.tenant.staff?.scope.applicationId && input.tenant.staff.scope.applicationId !== id)) { out.push({ applicationId: id, ok: false, code: "not_found", message: "Not a candidate of this role." }); continue; }
    try {
      const r = await send(app, input.wording ?? null).catch((e: unknown) => (e instanceof HttpError && e.code === "wording_not_allowed" ? send(app, null) : Promise.reject(e)));
      out.push({ applicationId: id, ok: true, candidateNotice: r.notice, toldState: r.toldState, ...(r.communicationId !== undefined ? { communicationId: r.communicationId, undoUntil: r.undoUntil ?? null } : {}) });
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      out.push({ applicationId: id, ok: false, code: e.code, message: e.message });
    }
  }
  return out;
}
