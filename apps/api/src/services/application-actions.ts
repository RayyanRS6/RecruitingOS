import { and, count, desc, eq, gte, inArray, like } from "drizzle-orm";
import { OWNER_STAGE_LABEL, OwnerStage, type ActiveMark, type Actor, type ApplicationAction, type ApplicationStage, type CandidateNotice, type MarkKind, type MembershipRole, type StageMove, type StageMoveVia, type ToldState } from "@ros/contracts";
import { DECISION_STAGES, MarkError, STAGE_LABEL, activeMarksFor, assertCan, baseOwnerStage, can, clearMark, emit, gate, markBlockedReason, ownerStage, resolvePolicy, setMark, transition, withdrawQueuedDecision, type Permission } from "@ros/core";
import { applications, approvalRequests, assessments, candidates, communications, companies, interviews, rolePackets, roles, screens, type Tx } from "@ros/db";
import { dispositionMessage, sendDisposition, type CancelledInterview } from "@ros/agents";
import { HttpError } from "../middleware/errors";
import type { Container } from "../container";
import type { Tenant } from "../middleware/session";
import { exitCleanup } from "./exit-cleanup";
import { cancellationAlreadyTold } from "./interview-cancel";
import { UNSTARTED_SCREEN_STATUSES, stopScreenInvitation } from "./screens";
import { leftOutOfTalentPool } from "./talent-pool";

/**
 * What may be done with an application in its current state, decided in one place. The API answers with the list
 * (`allowedActions` on the application detail) so the pages show only real choices, and the action route refuses
 * anything not on it, so the two can never disagree.
 */
export const TERMINAL_STAGES: readonly string[] = ["hired", "withdrawn", "rejected", "declined"];
export const SCREEN_OPEN_STATUSES: readonly string[] = ["invited", "reminded", "in_progress"];
export const INTERVIEW_ACTIVE_STATUSES: readonly string[] = ["proposed", "scheduling", "scheduled"];
export const INTERVIEW_DONE_STATUSES: readonly string[] = ["completed", "no_show"];
/** The assistant's suggestions that wait on a person (plan A6): a person acting on the candidate directly settles them. */
const SUGGESTIONS = ["application.invite_screen", "application.recommend_interview"];

export type ApplicationCapability = "invite_screen" | "ask_in_screen" | "interview" | "advance_to_interview" | "hold" | "reject" | "move_to_talent_pool" | "override_eligibility" | "review_anyway" | "record_decision" | "record_outcome" | "set_mark" | "clear_mark" | "send_decision" | "told_in_person" | "cancel_screen";

/**
 * `role` is the viewer's tenant role when known: every capability is then limited to roles that hold its permission, so a person never sees a button the route would refuse.
 * `openUnknowns` is how many questions the latest résumé assessment left open: "Ask about this in a screen" needs at least one.
 * `mark` and `markRemindAt` are the active private mark; `toldState` and `decisionMessagePending` say whether a decision was told or its message waits for approval.
 * `hasUnstartedScreen`: a screening invitation the candidate has not started, which "Stop this screen invitation" can take back (plan A7).
 */
export type ApplicationFacts = { stage: string; rejectReason: string | null; hasOpenScreen: boolean; hasActiveInterview: boolean; hasUndecidedInterview: boolean; role?: MembershipRole | null; openUnknowns?: number; mark?: MarkKind | null; markRemindAt?: string | null; toldState?: ToldState | null; decisionMessagePending?: boolean; hasUnstartedScreen?: boolean };

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
  set_mark: { permission: "application.act", what: "sort candidates into stages" },
  clear_mark: { permission: "application.act", what: "sort candidates into stages" },
  send_decision: { permission: "application.reject", what: "tell candidates about a decision" },
  told_in_person: { permission: "application.reject", what: "tell candidates about a decision" },
  // The candidate is sent a note, so it sits with those who tell candidates decisions: owner, admin, hiring manager, recruiter.
  cancel_screen: { permission: "application.reject", what: "stop a screening invitation" },
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
  if (sortable) out.push("set_mark");
  if (f.mark && !terminal && f.stage !== "talent_pool") out.push("clear_mark");
  if (decided(f) && untold(f) && !f.decisionMessagePending) out.push("send_decision");
  // "I told them myself" also while the message is still on its way: a person's word ends the wait either way.
  if (decided(f) && (untold(f) || f.toldState === "queued")) out.push("told_in_person");
  if (!terminal && f.stage !== "talent_pool" && f.hasUnstartedScreen) out.push("cancel_screen");
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
    case "send_decision":
    case "told_in_person":
      return tellingReason(f);
    case "cancel_screen":
      return TERMINAL_STAGES.includes(f.stage) || f.stage === "talent_pool" ? step : f.hasOpenScreen ? "They have started the screening conversation, so it can't be stopped now." : "No screening invitation is waiting for them.";
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
 * mark takes the mark off; Interviewing opens the interview approval; Hired opens the hire sheet; Not moving forward
 * opens the private decline. Built from `applicationActionState`, so it never offers what the action route refuses.
 */
export function stageMoves(f: ApplicationFacts): StageMove[] {
  const { allowed, blockedReasons } = applicationActionState(f);
  const stage = f.stage as ApplicationStage;
  const mark = f.mark ? { mark: f.mark, remindAt: f.markRemindAt ?? null } : null;
  const current = ownerStage({ stage }, mark);
  const base = baseOwnerStage(stage);
  const past = `Not available at this step (${STAGE_LABEL[stage] ?? stage}).`;
  const move = (to: OwnerStage, via: StageMoveVia, cap: ApplicationCapability | null, extra: { mark?: MarkKind; current?: boolean; reason?: string | null } = {}): StageMove => {
    const ok = !extra.reason && !!cap && allowed.includes(cap);
    const blockedReason = ok ? undefined : (extra.reason ?? (cap ? blockedReasons[cap] : undefined) ?? past);
    return { to, label: OWNER_STAGE_LABEL[to], via, ...(extra.mark ? { mark: extra.mark } : {}), allowed: ok, current: !!extra.current, ...(blockedReason ? { blockedReason } : {}) };
  };
  return OwnerStage.options.map((to) => {
    // Someone set aside as not a fit for now shows as Not moving forward; a decline is still a separate, explicit choice.
    if (to === current && to === "not_moving_forward" && mark?.mark === "not_a_fit_for_now") return move(to, "decline", "reject", { current: true });
    if (to === current) return move(to, "none", null, { current: true, reason: "They are here now." });
    if (to === base && mark) return move(to, "clear_mark", "clear_mark");
    switch (to) {
      case "longlist":
      case "shortlist":
      case "on_hold":
        return move(to, "set_mark", "set_mark", { mark: to, reason: allowed.includes("set_mark") ? markBlockedReason(stage, to) : null });
      case "new":
        return move(to, "none", null, { reason: base === "new" ? null : "They are past this step." });
      case "interviewing":
        return base === "new" ? move(to, "interview", "interview") : move(to, "none", null, { reason: base === "interviewing" ? null : past });
      case "offer":
        return move(to, "offer", null, { reason: base === "hired" || base === "not_moving_forward" ? past : "Offers are made outside the app for now; when they accept, choose Hired." });
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
  extra: { mark?: Pick<ActiveMark, "mark" | "remindAt"> | null; decisionMessagePending?: boolean } = {},
): ApplicationFacts {
  return {
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

/** Decision messages waiting for an approver, for these applications (one query). */
export async function pendingDecisionMessages(tx: Tx, applicationIds: string[]): Promise<Set<string>> {
  if (!applicationIds.length) return new Set();
  const rows = await tx.select({ applicationId: approvalRequests.applicationId }).from(approvalRequests).where(and(inArray(approvalRequests.applicationId, applicationIds), eq(approvalRequests.actionType, "disposition.send"), eq(approvalRequests.status, "pending")));
  return new Set(rows.map((r) => r.applicationId).filter((x): x is string => !!x));
}

export async function applicationFacts(tx: Tx, app: Pick<typeof applications.$inferSelect, "id" | "stage" | "rejectReason" | "toldState">, role?: MembershipRole | null): Promise<ApplicationFacts> {
  const scr = await tx.select({ status: screens.status }).from(screens).where(eq(screens.applicationId, app.id));
  const ivs = await tx.select({ status: interviews.status, decision: interviews.decision }).from(interviews).where(eq(interviews.applicationId, app.id));
  const [triage] = await tx.select({ result: assessments.result }).from(assessments).where(and(eq(assessments.applicationId, app.id), eq(assessments.kind, "triage"))).orderBy(desc(assessments.createdAt)).limit(1);
  const mark = (await activeMarksFor(tx, [app.id])).get(app.id) ?? null;
  const pending = await pendingDecisionMessages(tx, [app.id]);
  return applicationFactsFrom(app, scr.map((s) => s.status), ivs, role, triage ?? null, { mark, decisionMessagePending: pending.has(app.id) });
}

/** Whether the message is out or on its way: what `dispositionSent` has always meant. */
export const declineSent = (n: CandidateNotice): boolean => n === "queued";

type App = typeof applications.$inferSelect;
/** What a "Send" did: the toast's words, the told state now, and the approval request when it waits for one. */
export type DecisionMessageResult = { notice: CandidateNotice; toldState: ToldState; approvalRequestId?: string };

/** The eligibility wording after an eligibility decline; the standard wording after any other decision. */
function decisionKind(app: Pick<App, "stage" | "rejectReason">): "eligibility" | "human" {
  return app.stage === "rejected" && app.rejectReason === "eligibility" ? "eligibility" : "human";
}

/**
 * Interviews the decision called off that the candidate knew about: a booked time still to come, or times they were
 * offered and had not picked. A private decision cancels them without a word (plan-adjustments §4), so the decision
 * message says they are off, unless the candidate already had a cancellation note for one of them.
 */
async function interviewsCalledOff(tx: Tx, app: App, now: Date): Promise<CancelledInterview[]> {
  const since = app.rejectedAt ?? app.stageChangedAt;
  const rows = await tx.select({ id: interviews.id, title: interviews.title, startsAt: interviews.startsAt, timezone: interviews.timezone, offeredSlots: interviews.offeredSlots }).from(interviews).where(and(eq(interviews.applicationId, app.id), eq(interviews.status, "cancelled"), gte(interviews.updatedAt, since)));
  const told = await cancellationAlreadyTold(tx, rows.map((r) => r.id));
  const known = (r: (typeof rows)[number]) => (r.startsAt ? Date.parse(r.startsAt) > now.getTime() : r.offeredSlots.length > 0);
  return rows.filter((r) => known(r) && !told.has(r.id)).map(({ title, startsAt, timezone }) => ({ title, startsAt, timezone }));
}

async function messageParts(tx: Tx, app: App) {
  const [cand] = await tx.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
  const [role] = await tx.select().from(roles).where(eq(roles.id, app.roleId)).limit(1);
  const [company] = await tx.select().from(companies).where(eq(companies.id, app.companyId)).limit(1);
  const [pv] = await tx.select().from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), eq(rolePackets.version, app.packetVersion))).limit(1);
  return cand && role && company && pv ? { cand, role, company, packet: pv.packet } : null;
}

/** Queues the standard decision message and records that it is on its way (the outbox marks it sent once it leaves). */
async function deliverDecision(tx: Tx, container: Container, input: { app: App; actor: Actor }): Promise<DecisionMessageResult> {
  const { app, actor } = input;
  const parts = await messageParts(tx, app);
  if (!parts) return { notice: "not_sent", toldState: app.toldState };
  const now = container.engine.clock();
  // A Send after a message that could not be delivered is a new attempt with a key of its own; one still on its way or
  // delivered never gets here (the told state stops it).
  const [failed] = await tx.select({ n: count() }).from(communications).where(and(eq(communications.applicationId, app.id), like(communications.templateKey, "disposition:%"), eq(communications.status, "failed"), gte(communications.createdAt, app.rejectedAt ?? app.stageChangedAt)));
  const res = await sendDisposition(tx, container.integrations, { application: app, candidate: parts.cand, role: parts.role, company: parts.company, packet: parts.packet, actor, reason: decisionKind(app), cancelledInterviews: await interviewsCalledOff(tx, app, now), attempt: Number(failed?.n ?? 0) });
  // The outbox answers "sent" only for this decision's own message, already delivered under the same key.
  if (res.status === "sent" || res.status === "pending") {
    const toldState: ToldState = res.status === "sent" ? "sent" : "queued";
    await tx.update(applications).set({ toldState, ...(toldState === "sent" ? { candidateToldAt: now.toISOString() } : {}) }).where(and(eq(applications.id, app.id), eq(applications.toldState, "not_told")));
    return { notice: "queued", toldState };
  }
  return { notice: parts.cand.email ? "not_sent" : "not_sent_no_email", toldState: app.toldState };
}

/**
 * "Send the decision message" (founder decision B6): a person tells the candidate a decision that was filed privately,
 * in the standard approved wording (the eligibility wording after an eligibility decline). The company's settings for
 * the role decide what the Send does: it goes (the default), it waits for an approver ("ask me first", and during a
 * recruiter takeover, the recruiter), or nothing is sent ("only a person": the team tells candidates themselves).
 */
export async function sendDecisionMessage(tx: Tx, container: Container, input: { app: App; actor: Actor }): Promise<DecisionMessageResult> {
  const { app, actor } = input;
  if (!DECISION_STAGES.includes(app.stage)) throw new HttpError(409, "not_decided", "There is no decision to tell them about yet.");
  if (app.toldState !== "not_told") throw new HttpError(409, "already_told", tellingReason({ stage: app.stage, rejectReason: app.rejectReason, hasOpenScreen: false, hasActiveInterview: false, hasUndecidedInterview: false, toldState: app.toldState }));
  if ((await pendingDecisionMessages(tx, [app.id])).has(app.id)) throw new HttpError(409, "waiting_approval", "The decision message is already waiting for approval.");
  const d = await gate(tx, { companyId: app.companyId, roleId: app.roleId, applicationId: app.id, actionType: "disposition.send", subject: { type: "application", id: app.id }, proposal: { reason: decisionKind(app), decision: app.stage }, requestedBy: actor });
  if (d.outcome === "wait_for_approval") return { notice: "waiting_approval", toldState: app.toldState, approvalRequestId: d.approvalRequestId };
  if (d.outcome === "human_only") return { notice: "not_sent_settings", toldState: app.toldState };
  return deliverDecision(tx, container, { app, actor });
}

/**
 * The approved half of a `disposition.send` approval request: the decision message goes out exactly as a Send would
 * have sent it. Nothing is sent when the decision was reversed in the meantime (for instance after "review anyway") or
 * the candidate was told another way. Null when nothing was sent.
 */
export async function sendApprovedDecline(tx: Tx, container: Container, input: { applicationId: string; actor: Actor }): Promise<DecisionMessageResult | null> {
  const [app] = await tx.select().from(applications).where(eq(applications.id, input.applicationId)).limit(1);
  if (!app || !DECISION_STAGES.includes(app.stage) || app.toldState !== "not_told") return null;
  return deliverDecision(tx, container, { app, actor: input.actor });
}

/**
 * What the decision message will say, for the preview before Send: the same words `sendDisposition` sends, who it goes
 * to, and what the Send does under the company's settings. Null when there is no decision to tell.
 */
export async function decisionMessagePreview(tx: Tx, container: Container, app: App) {
  if (!DECISION_STAGES.includes(app.stage)) return null;
  const parts = await messageParts(tx, app);
  if (!parts) return null;
  const message = dispositionMessage({ candidate: parts.cand, company: parts.company, packet: parts.packet, reason: decisionKind(app), cancelledInterviews: await interviewsCalledOff(tx, app, container.engine.clock()) });
  const pending = await pendingDecisionMessages(tx, [app.id]);
  return { to: parts.cand.email, subject: message.subject, text: message.text, wording: decisionKind(app), policy: await declineMessagePolicy(tx, { companyId: app.companyId, roleId: app.roleId }), toldState: app.toldState, candidateToldAt: app.candidateToldAt ? new Date(app.candidateToldAt).toISOString() : null, waitingApproval: pending.has(app.id) };
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
 * interviews a decision called off, without a word to the candidate; the decision message says they are off.
 */
export type ActionResult = { ok: true; stage: string; ownerStage?: OwnerStage; mark?: ActiveMark | null; toldState?: ToldState; dispositionSent?: boolean; candidateNotice?: CandidateNotice; approvalRequestId?: string; workflowRunId?: string; next?: string; talentPoolOptOut?: boolean; interviewsCancelled?: number };

function markHttpError(e: unknown): never {
  if (e instanceof MarkError) throw new HttpError(e.code === "bad_date" ? 400 : 409, e.code, e.message);
  throw e;
}

/** One person's decision about one application, inside the caller's tenant transaction. */
export async function performApplicationAction(tx: Tx, container: Container, input: { app: App; body: ActionBody; tenant: Tenant; actor: Actor }): Promise<ActionResult> {
  const { app, body, tenant: t, actor } = input;
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
    throw new HttpError(409, "invalid", `Cannot ${body.action.replace(/_/g, " ")} someone who is ${STAGE_LABEL[app.stage].toLowerCase()}.`);
  }
  if (settlesSuggestions(body)) await settleSuggestions(tx, container, { app, tenant: t, actor, action: body.action, note: body.note });
  const now = container.engine.clock();
  switch (body.action) {
    case "reject": {
      assertCan(t.role, "application.reject");
      if (!body.reason) throw new HttpError(400, "reason_required", "A reason is required to decline a candidate.");
      await transition(tx, { applicationId: app.id, companyId: t.companyId, to: "rejected", by, actor, reason: body.reason, payload: { note: body.note ?? null } });
      await tx.update(applications).set({ rejectNote: body.note ?? null }).where(eq(applications.id, app.id));
      await emit(tx, { type: "application.rejected", companyId: t.companyId, actor, subject: { type: "application", id: app.id }, payload: { reason: body.reason, byHuman: true, candidateTold: false } });
      await emit(tx, { type: "human.override", companyId: t.companyId, actor, subject: { type: "application", id: app.id }, payload: { action: "reject", reason: body.reason } });
      // Decisions are private (founder decision B6): nothing is sent. An interview still to come is called off without a
      // word; the decision message says so when someone sends it (plan-adjustments §4).
      const cleaned = await exitCleanup(tx, container, { companyId: t.companyId, applicationId: app.id, reason: `declined: ${body.reason}`, actor, candidateEmail: "private_decision" });
      return { ok: true, stage: "rejected", ownerStage: "not_moving_forward", mark: null, toldState: "not_told", dispositionSent: false, candidateNotice: "not_told", interviewsCancelled: cleaned.interviewsCancelled, next: PRIVATE_DECISION };
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
      const [cand] = await tx.select({ preferences: candidates.preferences }).from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
      const optedOut = !!cand && leftOutOfTalentPool(cand);
      if (!optedOut) await tx.update(candidates).set({ inTalentPool: true }).where(eq(candidates.id, app.candidateId));
      await emit(tx, { type: "application.moved_to_talent_pool", companyId: t.companyId, actor, subject: { type: "application", id: app.id }, payload: optedOut ? { talentPoolOptOut: true } : {} });
      const cleaned = await exitCleanup(tx, container, { companyId: t.companyId, applicationId: app.id, reason: "moved to the talent pool", actor, candidateEmail: "private_decision" });
      return { ok: true, stage: "talent_pool", ownerStage: "not_moving_forward", mark: null, toldState: "not_told", candidateNotice: "not_told", interviewsCancelled: cleaned.interviewsCancelled, ...(optedOut ? { talentPoolOptOut: true } : {}) };
    }
    case "hold":
    case "set_mark": {
      // "Hold" is the On hold mark: private, with the date it ends (14 days unless a date is chosen).
      assertCan(t.role, "application.act");
      const mark: MarkKind | undefined = body.action === "hold" ? "on_hold" : body.mark;
      if (!mark) throw new HttpError(400, "mark_required", "Choose Longlist, Shortlist, On hold or Not a fit for now.");
      const set = await setMark(tx, { companyId: t.companyId, app, mark, note: body.note, remindAt: body.remindAt, actor, source: "manual", now }).catch(markHttpError);
      await emit(tx, { type: "human.override", companyId: t.companyId, actor, subject: { type: "application", id: app.id }, payload: { action: "set_mark", mark, note: body.note ?? null, remindAt: set.mark.remindAt } });
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
      const r = await sendDecisionMessage(tx, container, { app, actor });
      return { ok: true, stage: app.stage, ownerStage: ownerStage(app, null), toldState: r.toldState, candidateNotice: r.notice, dispositionSent: declineSent(r.notice), ...(r.approvalRequestId ? { approvalRequestId: r.approvalRequestId } : {}) };
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
      await emit(tx, { type: "human.override", companyId: t.companyId, actor, subject: { type: "application", id: app.id }, payload: { action: body.action, channel: body.channel ?? "auto", focus: focus ?? null, note: body.note ?? null, workflowRunId: runId } });
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
    case "advance_to_interview": {
      assertCan(t.role, "application.act");
      await transition(tx, { applicationId: app.id, companyId: t.companyId, to: "interview_recommended", by, actor, reason: body.note ?? "owner decision" });
      await emit(tx, { type: "candidate.recommended", companyId: t.companyId, actor, subject: { type: "application", id: app.id }, payload: { by: "human" } });
      await emit(tx, { type: "human.override", companyId: t.companyId, actor, subject: { type: "application", id: app.id }, payload: { action: "advance_to_interview", note: body.note ?? null } });
      return { ok: true, stage: "interview_recommended", ownerStage: "interviewing", candidateNotice: "not_told", next: "Marked as recommended for interview. Open the candidate and choose \"Interview\" to pick the round and interviewers; times go out to the candidate from there." };
    }
  }
}

/**
 * "Send the decision message" for several people at once (the Talent page and the Today card): each person gets the
 * same Send as on their own page, with their own result, so one refusal never blocks the rest.
 */
export async function sendDecisionMessages(tx: Tx, container: Container, input: { roleId: string; applicationIds: string[]; tenant: Tenant; actor: Actor }): Promise<Array<{ applicationId: string; ok: boolean; candidateNotice?: CandidateNotice; toldState?: ToldState; code?: string; message?: string }>> {
  assertCan(input.tenant.role, "application.reject");
  const ids = [...new Set(input.applicationIds)];
  const rows = await tx.select().from(applications).where(and(eq(applications.roleId, input.roleId), inArray(applications.id, ids)));
  const out: Array<{ applicationId: string; ok: boolean; candidateNotice?: CandidateNotice; toldState?: ToldState; code?: string; message?: string }> = [];
  for (const id of ids) {
    const app = rows.find((r) => r.id === id);
    if (!app || (input.tenant.staff?.scope.applicationId && input.tenant.staff.scope.applicationId !== id)) { out.push({ applicationId: id, ok: false, code: "not_found", message: "Not a candidate of this role." }); continue; }
    try {
      const r = await sendDecisionMessage(tx, container, { app, actor: input.actor });
      out.push({ applicationId: id, ok: true, candidateNotice: r.notice, toldState: r.toldState });
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      out.push({ applicationId: id, ok: false, code: e.code, message: e.message });
    }
  }
  return out;
}
