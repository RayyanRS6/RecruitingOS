import { and, count, eq, gt, gte, inArray, isNull, like, lte, sql } from "drizzle-orm";
import { CHOOSABLE_WORDINGS, DECISION_WORDING_LABEL, type Actor, type ApplicationStage, type CandidateNotice, type DecisionWording, type DecisionWordingOption, type ToldState } from "@ros/contracts";
import { DECISION_STAGES, activeFollowUpsFor, activeMarksFor, adverseDecisionLineApplies, createEscalation, emit, gate, inCancelled, notify, resolvePolicy } from "@ros/core";
import { applications, approvalRequests, candidates, communications, companies, events, interviews, rolePackets, roles, type Queryable } from "@ros/db";
import type { Integrations } from "@ros/integrations";
import { dispositionMessage, sendDisposition, sendStillReviewingNote, type CancelledInterview, type PersonalLine } from "./coordinator";
import { HELD_REASON } from "./outbox";
import { UNTOLD_SEND_WORKING_DAYS, decisionsWaitingApproval, workingDayRulesFor, workingDaysSince } from "./orchestrator";

/**
 * Telling candidates a private decision (founder decision B6; plan Wave G). Everything that writes the decision message,
 * wherever the Send comes from: a person on the candidate's page or in bulk, an approver, the closing message of a closed
 * role (Q30), and the untold safety net (Q27). The wording is always one of the approved wordings (Q28); the assistant
 * never writes a decline.
 */
type App = typeof applications.$inferSelect;
type Role = typeof roles.$inferSelect;

export class DecisionMessageError extends Error {
  constructor(public readonly code: "wording_not_allowed" | "not_decided" | "role_not_closed" | "nothing_to_send" | "waiting_approval" | "already_told", message: string) {
    super(message);
  }
}

/** Said when a Send finds the decision already told or its message already on its way (two Sends at the same moment). */
const ALREADY_TOLD = "They were already told, or their decision message is already on its way.";

/** Everything a decision message is written from. Null when the application's candidate, role, company or packet is missing. */
export async function loadDecisionParts(q: Queryable, app: Pick<App, "candidateId" | "roleId" | "companyId" | "packetVersion">) {
  const [cand] = await q.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
  const [role] = await q.select().from(roles).where(eq(roles.id, app.roleId)).limit(1);
  const [company] = await q.select().from(companies).where(eq(companies.id, app.companyId)).limit(1);
  const [pv] = await q.select().from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), eq(rolePackets.version, app.packetVersion))).limit(1);
  return cand && role && company && pv ? { cand, role, company, packet: pv.packet } : null;
}

/** The candidate's status page, where "Don't keep me for future roles" is one click. Only in what is sent to the candidate. */
export function statusUrlOf(baseUrl: string, app: Pick<App, "statusToken">): string {
  return `${baseUrl}/c/status/${app.statusToken}`;
}

/**
 * The status link as the team sees it in a preview. The real link never leaves the server: it never expires, and
 * whoever holds it can act as the candidate (withdraw, opt out, ask for their data), so a team member, or an ITS
 * recruiter whose access later ends, must never be able to copy it from a preview.
 */
export function statusUrlPlaceholder(baseUrl: string): string {
  return `${baseUrl}/c/status/[their status link]`;
}

/**
 * Interviews the decision called off that the candidate knew about (a booked time still to come, or times they were
 * offered and had not picked) and has not yet been told are off. A private decision tells the candidate at once, in a
 * short note with no reason, that such an interview is off, so the decision message leaves those out. It names one only
 * when nobody told them yet (the `interview.cancelled` event records whether they were).
 */
export async function interviewsCalledOff(q: Queryable, app: Pick<App, "id" | "rejectedAt" | "stageChangedAt">, now: Date): Promise<CancelledInterview[]> {
  const since = app.rejectedAt ?? app.stageChangedAt;
  const rows = await q.select({ id: interviews.id, title: interviews.title, startsAt: interviews.startsAt, timezone: interviews.timezone, offeredSlots: interviews.offeredSlots }).from(interviews).where(and(eq(interviews.applicationId, app.id), eq(interviews.status, "cancelled"), gte(interviews.updatedAt, since)));
  if (!rows.length) return [];
  const told = new Set((await q.select({ id: events.subjectId }).from(events).where(and(eq(events.type, "interview.cancelled"), inArray(events.subjectId, rows.map((r) => r.id)), sql`${events.payload}->>'candidateTold' = 'true'`))).map((r) => r.id));
  const known = (r: (typeof rows)[number]) => (r.startsAt ? Date.parse(r.startsAt) > now.getTime() : r.offeredSlots.length > 0);
  return rows.filter((r) => known(r) && !told.has(r.id)).map(({ title, startsAt, timezone }) => ({ title, startsAt, timezone }));
}

const isEligibilityDecline = (app: Pick<App, "stage" | "rejectReason">) => app.stage === "rejected" && app.rejectReason === "eligibility";

/**
 * The standard wording for a decision: the eligibility wording after an eligibility decline (fixed), the closing message
 * for someone a closed role moved to the talent pool, the standard wording otherwise. The untold safety net sends this
 * one (Q27: "the standard courteous message"); a person's Send starts on the suggested one.
 */
export function defaultWording(app: Pick<App, "stage" | "rejectReason">, role: Pick<Role, "status">): DecisionWording {
  if (isEligibilityDecline(app)) return "eligibility";
  if (role.status === "closed" && app.stage === "talent_pool") return "role_closed";
  return "v1";
}

/**
 * The wording the Send screen suggests (and starts on): "position filled" when that was the reason, "after an
 * interview" for someone who met the team, the default wording otherwise. The person may choose any approved wording.
 */
export async function suggestedWording(q: Queryable, app: Pick<App, "id" | "stage" | "rejectReason">, role: Pick<Role, "status">): Promise<DecisionWording> {
  const fallback = defaultWording(app, role);
  if (fallback !== "v1") return fallback;
  if (app.rejectReason === "position_filled") return "position_filled";
  const [met] = await q.select({ id: interviews.id }).from(interviews).where(and(eq(interviews.applicationId, app.id), eq(interviews.status, "completed"))).limit(1);
  return met ? "after_interview" : "v1";
}

/** The wordings a person may choose for this decision, with the suggested one marked. */
export function wordingOptions(app: Pick<App, "stage" | "rejectReason">, role: Pick<Role, "status">, suggested: DecisionWording): DecisionWordingOption[] {
  const ids: DecisionWording[] = isEligibilityDecline(app) ? ["eligibility"] : [...CHOOSABLE_WORDINGS, ...(role.status === "closed" ? (["role_closed"] as const) : [])];
  return ids.map((id) => ({ id, label: DECISION_WORDING_LABEL[id], suggested: id === suggested }));
}

/**
 * The wording to use: the one asked for when it is on offer for this decision, the suggested one when none was asked
 * for (G6, Q28: the Send screen starts on it, and a bulk Send gives each person theirs). The options mark it.
 */
async function resolveWording(q: Queryable, app: App, role: Role, wanted: DecisionWording | null | undefined): Promise<{ wording: DecisionWording; suggested: DecisionWording; options: DecisionWordingOption[] }> {
  const suggested = await suggestedWording(q, app, role);
  const options = wordingOptions(app, role, suggested);
  if (wanted && !options.some((o) => o.id === wanted)) {
    throw new DecisionMessageError("wording_not_allowed", isEligibilityDecline(app) ? "A decline on an eligibility answer always uses the eligibility wording, which tells them how to correct an answer given in error." : wanted === "role_closed" ? "The closing message is only for a role that has closed." : "That wording is not one of the approved wordings for this decision.");
  }
  return { wording: wanted ?? suggested, suggested, options };
}

/**
 * What the decision message will say, exactly as a Send would write it now, except that the status link is the
 * placeholder (`statusUrlPlaceholder`): this text is only ever shown to the team, and a Send writes its own with the
 * real link (`queueDecisionMessage`). Null when there is no decision or nothing to write it from.
 */
export async function decisionMessageDraft(q: Queryable, input: { app: App; wording?: DecisionWording | null; personalLine?: PersonalLine | null; statusBaseUrl: string; now: Date }) {
  const { app } = input;
  if (!DECISION_STAGES.includes(app.stage)) return null;
  const parts = await loadDecisionParts(q, app);
  if (!parts) return null;
  const { wording, options } = await resolveWording(q, app, parts.role, input.wording);
  const adverseDecisionLine = adverseDecisionLineApplies({ jobLocations: parts.packet.identity.locations, candidateLocationText: parts.cand.locationText });
  const message = dispositionMessage({ candidate: parts.cand, company: parts.company, packet: parts.packet, wording, cancelledInterviews: await interviewsCalledOff(q, app, input.now), personalLine: input.personalLine ?? null, statusUrl: statusUrlPlaceholder(input.statusBaseUrl), adverseDecisionLine });
  return { to: parts.cand.email, subject: message.subject, text: message.text, wording, wordings: options, personalLine: input.personalLine?.text ?? null, adverseDecisionLine };
}

/** What became of one decision message: the toast's words, the told state now, the message (for Undo) and the wording used. */
export type QueuedDecision = { notice: CandidateNotice; toldState: ToldState; communicationId: string | null; wording: DecisionWording | null };

/**
 * Queues the decision message and records that it is on its way (the outbox marks it sent once it leaves, or not told
 * again if it cannot be delivered). The caller has passed the policy gate. A Send after a message that could not be
 * delivered is a new attempt with a key of its own; one still on its way or delivered never gets here: the application
 * row is locked and its told state read again first, so two Sends at the same moment (a person's, the closing message's,
 * the safety net's) write one message, and the second is refused (`already_told`). Nothing is written for someone whose
 * details were deleted at their request. `sendAt` holds a person's Send for the Undo window (plan G9).
 */
export async function queueDecisionMessage(q: Queryable, integrations: Integrations, input: { app: App; actor: Actor; wording?: DecisionWording | null; personalLine?: PersonalLine | null; statusBaseUrl: string; now: Date; sendAt?: Date | null }): Promise<QueuedDecision> {
  const [locked] = await q.select({ toldState: applications.toldState, stage: applications.stage }).from(applications).where(eq(applications.id, input.app.id)).limit(1).for("update");
  if (!locked) return { notice: "not_sent", toldState: input.app.toldState, communicationId: null, wording: null };
  if (locked.toldState !== "not_told") throw new DecisionMessageError("already_told", ALREADY_TOLD);
  if (!DECISION_STAGES.includes(locked.stage)) throw new DecisionMessageError("not_decided", "There is no decision to tell them about any more.");
  const app = { ...input.app, toldState: locked.toldState, stage: locked.stage };
  const parts = await loadDecisionParts(q, app);
  if (!parts || parts.cand.anonymizedAt) return { notice: "not_sent", toldState: app.toldState, communicationId: null, wording: null };
  const { wording } = await resolveWording(q, app, parts.role, input.wording);
  // Earlier messages for this decision that did not reach them (failed, taken back with Undo, interrupted, bounced): a
  // new Send is a new message with a key of its own.
  const [failed] = await q.select({ n: count() }).from(communications).where(and(eq(communications.applicationId, app.id), like(communications.templateKey, "disposition:%"), inArray(communications.status, ["failed", "cancelled", "unknown", "bounced"]), gte(communications.createdAt, app.rejectedAt ?? app.stageChangedAt)));
  const adverseDecisionLine = adverseDecisionLineApplies({ jobLocations: parts.packet.identity.locations, candidateLocationText: parts.cand.locationText });
  const res = await sendDisposition(q, integrations, { application: app, candidate: parts.cand, role: parts.role, company: parts.company, packet: parts.packet, actor: input.actor, wording, cancelledInterviews: await interviewsCalledOff(q, app, input.now), attempt: Number(failed?.n ?? 0), personalLine: input.personalLine ?? null, statusUrl: statusUrlOf(input.statusBaseUrl, app), adverseDecisionLine, sendAt: input.sendAt ?? null });
  const communicationId = "communicationId" in res && typeof res.communicationId === "string" ? res.communicationId : null;
  // The outbox answers "sent" only for this decision's own message, already delivered under the same key. A message held
  // for the ITS company check is in the outbox too ("queued" told state), and the team is told it waits for the check.
  if (res.status === "sent" || res.status === "pending") {
    const toldState: ToldState = res.status === "sent" ? "sent" : "queued";
    await q.update(applications).set({ toldState, ...(toldState === "sent" ? { candidateToldAt: input.now.toISOString() } : {}) }).where(and(eq(applications.id, app.id), eq(applications.toldState, "not_told")));
    return { notice: res.status === "pending" && res.reason === HELD_REASON ? "held" : "queued", toldState, communicationId, wording };
  }
  return { notice: parts.cand.email ? "not_sent" : "not_sent_no_email", toldState: app.toldState, communicationId, wording };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The closing message of a closed role (founder decision Q30)                                                   */
/* ------------------------------------------------------------------------------------------------------------ */

/** The proposal of the one approval request that covers a closed role's closing message. */
export type ClosingProposal = { kind: "role_closed"; applicationIds: string[]; count: number };
export function isClosingProposal(p: unknown): p is ClosingProposal {
  return !!p && typeof p === "object" && (p as { kind?: unknown }).kind === "role_closed" && Array.isArray((p as { applicationIds?: unknown }).applicationIds);
}

/**
 * Who a closed role's closing message is for: everyone the role left in the talent pool who has not been told (the
 * people still in process when it closed, and emailed applications added to the pool at the close). Those already told,
 * or whose own message waits for an approver, are counted and left out, so nobody is told twice; so is anyone whose
 * details were deleted at their request, who is never written to. `batch` is the one approval request already waiting
 * for this role's closing message, if any.
 */
export async function closingAudience(q: Queryable, roleId: string) {
  const [role] = await q.select().from(roles).where(eq(roles.id, roleId)).limit(1);
  if (!role) return null;
  const pool = await q.select().from(applications).where(and(eq(applications.roleId, roleId), eq(applications.stage, "talent_pool")));
  const untold = pool.filter((a) => a.toldState === "not_told");
  const [batch] = (await q.select({ id: approvalRequests.id, proposal: approvalRequests.proposal }).from(approvalRequests).where(and(eq(approvalRequests.roleId, roleId), isNull(approvalRequests.applicationId), eq(approvalRequests.actionType, "disposition.send"), eq(approvalRequests.status, "pending")))).filter((r) => isClosingProposal(r.proposal));
  const own = new Set((untold.length ? await q.select({ applicationId: approvalRequests.applicationId }).from(approvalRequests).where(and(inArray(approvalRequests.applicationId, untold.map((a) => a.id)), eq(approvalRequests.actionType, "disposition.send"), eq(approvalRequests.status, "pending"))) : []).map((r) => r.applicationId ?? ""));
  const waiting = untold.filter((a) => !own.has(a.id));
  const found = waiting.length ? await q.select({ id: candidates.id, firstName: candidates.firstName, lastName: candidates.lastName, email: candidates.email, preferences: candidates.preferences, anonymizedAt: candidates.anonymizedAt }).from(candidates).where(inArray(candidates.id, waiting.map((a) => a.candidateId))) : [];
  const removed = new Set(found.filter((c) => c.anonymizedAt).map((c) => c.id));
  const apps = waiting.filter((a) => !removed.has(a.candidateId));
  const people = found.filter((c) => !removed.has(c.id)).map((c) => ({ id: c.id, firstName: c.firstName, lastName: c.lastName, email: c.email, preferences: c.preferences }));
  return { role, apps, people, alreadyTold: pool.length - untold.length, waitingApproval: own.size, batch: batch ?? null };
}

/**
 * The closing message as one of its readers will get it, with "[first name]" in place of the name: what the person
 * approves once for everyone. Built from the first person's application (their packet version and status link shape).
 */
export async function closingMessageText(q: Queryable, input: { app: App; statusBaseUrl: string }): Promise<{ subject: string; text: string } | null> {
  const parts = await loadDecisionParts(q, input.app);
  if (!parts) return null;
  const sample = { ...parts.cand, firstName: "[first name]", preferences: { ...parts.cand.preferences, talentPoolOptOut: false } };
  const message = dispositionMessage({ candidate: sample, company: parts.company, packet: parts.packet, wording: "role_closed", statusUrl: statusUrlPlaceholder(input.statusBaseUrl), adverseDecisionLine: false });
  return { subject: message.subject, text: message.text };
}

/** One person's closing message: what became of it, and the message and its Undo while it waits out the window (plan G9). */
export type ClosingResult = { applicationId: string; ok: boolean; candidateNotice?: CandidateNotice; communicationId?: string | null; undoUntil?: string | null; code?: string; message?: string };

/**
 * Sends the closing message to each of these people still untold on the closed role, each with their own result. Every
 * message has the key `role_closed:<application>`, so nobody gets it twice, whatever is pressed again; a Send of their
 * own at the same moment is refused by the told state (`queueDecisionMessage`). A message queued to wait out a person's
 * Undo window carries its `communicationId` and `undoUntil`.
 */
export async function queueClosingMessages(q: Queryable, integrations: Integrations, input: { roleId: string; applicationIds: string[]; actor: Actor; statusBaseUrl: string; now: Date; sendAt?: Date | null }): Promise<ClosingResult[]> {
  const rows = input.applicationIds.length ? await q.select().from(applications).where(and(eq(applications.roleId, input.roleId), inArray(applications.id, input.applicationIds))) : [];
  const out: ClosingResult[] = [];
  const undoUntil = input.sendAt && input.sendAt.getTime() > input.now.getTime() ? input.sendAt.toISOString() : null;
  for (const id of input.applicationIds) {
    const app = rows.find((r) => r.id === id);
    if (!app) { out.push({ applicationId: id, ok: false, code: "not_found", message: "Not a candidate of this role." }); continue; }
    if (app.stage !== "talent_pool") { out.push({ applicationId: id, ok: false, code: "not_decided", message: "They are no longer in the talent pool from this role." }); continue; }
    if (app.toldState !== "not_told") { out.push({ applicationId: id, ok: false, code: "already_told", message: "They were already told." }); continue; }
    try {
      const r = await queueDecisionMessage(q, integrations, { app, actor: input.actor, wording: "role_closed", statusBaseUrl: input.statusBaseUrl, now: input.now, sendAt: input.sendAt ?? null });
      out.push({ applicationId: id, ok: true, candidateNotice: r.notice, communicationId: r.communicationId, undoUntil: r.notice === "queued" && r.communicationId ? undoUntil : null });
    } catch (e) {
      if (!(e instanceof DecisionMessageError)) throw e;
      out.push({ applicationId: id, ok: false, code: e.code, message: e.message });
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The untold safety net (founder decision Q27)                                                                  */
/* ------------------------------------------------------------------------------------------------------------ */

export type SafetyNetDeps = { integrations: Integrations; statusBaseUrl: string; now: Date; actor: Actor };
export type SafetyNetResult = { applicationId: string; action: "sent" | "recruiter" };

/**
 * Q27: a decision nobody has told the candidate about five working days after it was made (Monday to Friday in the
 * company's time zone, holidays left out). Under "Do it" for `disposition.send` the standard message goes out by
 * itself through the same gate and wording as a person's Send, and the team is told who got it. When the settings ask
 * for approval, keep decisions with a person, or an ITS recruiter is running the role, nothing is sent: a recruiter is
 * brought in, one request per role, to make sure they are told. Someone with no email address on file brings in a
 * recruiter too. Once per decision (recorded as `application.untold_fallback` with when the decision was made). Someone
 * whose details were deleted at their request is never written to, and nobody is asked to reach them.
 */
export async function runUntoldSafetyNet(q: Queryable, deps: SafetyNetDeps, companyId: string): Promise<SafetyNetResult[]> {
  const untold = (await q.select({ app: applications }).from(applications).innerJoin(candidates, eq(candidates.id, applications.candidateId)).where(and(eq(applications.companyId, companyId), inArray(applications.stage, [...DECISION_STAGES]), eq(applications.toldState, "not_told"), isNull(candidates.anonymizedAt)))).map((r) => r.app);
  if (!untold.length) return [];
  const rules = await workingDayRulesFor(q, companyId, deps.now);
  const decidedAt = (a: App) => new Date(a.rejectedAt ?? a.stageChangedAt).toISOString();
  const due = untold.filter((a) => workingDaysSince(new Date(decidedAt(a)), deps.now, 60, rules) >= UNTOLD_SEND_WORKING_DAYS);
  if (!due.length) return [];
  const waiting = await decisionsWaitingApproval(q, due.map((a) => a.id));
  const handled = new Set((await q.select({ subjectId: events.subjectId, at: sql<string>`${events.payload}->>'decisionAt'` }).from(events).where(and(eq(events.type, "application.untold_fallback"), inArray(events.subjectId, due.map((a) => a.id))))).map((e) => `${e.subjectId}|${e.at}`));
  const todo = due.filter((a) => !waiting.has(a.id) && !handled.has(`${a.id}|${decidedAt(a)}`));
  const results: SafetyNetResult[] = [];
  const byRole = new Map<string, { sent: App[]; recruiter: Array<{ app: App; why: string }> }>();
  const slot = (roleId: string) => { let s = byRole.get(roleId); if (!s) { s = { sent: [], recruiter: [] }; byRole.set(roleId, s); } return s; };
  for (const app of todo) {
    const policy = await resolvePolicy(q, companyId, app.roleId, "disposition.send");
    if (policy.level === "auto" || policy.level === "auto_notify") {
      const g = await gate(q, { companyId, roleId: app.roleId, applicationId: app.id, actionType: "disposition.send", subject: { type: "application", id: app.id }, proposal: { reason: "untold_safety_net", decision: app.stage }, requestedBy: deps.actor });
      if (g.outcome === "execute") {
        // the standard wording (Q27), never one a person would choose
        const [role] = await q.select({ status: roles.status }).from(roles).where(eq(roles.id, app.roleId)).limit(1);
        const r = await queueDecisionMessage(q, deps.integrations, { app, actor: deps.actor, wording: defaultWording(app, role ?? { status: "open" }), statusBaseUrl: deps.statusBaseUrl, now: deps.now }).catch((e: unknown) => {
          // someone told them at this very moment: nothing more to do
          if (e instanceof DecisionMessageError && (e.code === "already_told" || e.code === "not_decided")) return null;
          throw e;
        });
        if (!r) continue;
        if (r.notice === "queued" || r.notice === "held") {
          await emit(q, { type: "application.untold_fallback", companyId, actor: deps.actor, subject: { type: "application", id: app.id }, payload: { action: "sent", decisionAt: decidedAt(app), communicationId: r.communicationId, wording: r.wording } });
          slot(app.roleId).sent.push(app);
          results.push({ applicationId: app.id, action: "sent" });
          continue;
        }
        slot(app.roleId).recruiter.push({ app, why: "there is no email address on file for them, so the message could not be sent" });
        continue;
      }
    }
    const why = policy.source === "takeover" ? "an ITS recruiter is running this role" : policy.level === "human_only" ? "the settings keep decision messages with a person" : "the settings ask for approval before a decision message goes";
    slot(app.roleId).recruiter.push({ app, why });
  }
  for (const [roleId, s] of byRole) {
    const [role] = await q.select({ title: roles.title }).from(roles).where(eq(roles.id, roleId)).limit(1);
    const title = role?.title ?? "a role";
    const all = [...s.sent, ...s.recruiter.map((x) => x.app)];
    const names = new Map((await q.select({ id: candidates.id, firstName: candidates.firstName, lastName: candidates.lastName }).from(candidates).where(inArray(candidates.id, all.map((a) => a.candidateId)))).map((c) => [c.id, `${c.firstName} ${c.lastName}`.trim() || "A candidate"]));
    const list = (apps: App[]) => `${apps.slice(0, 5).map((a) => names.get(a.candidateId) ?? "A candidate").join(", ")}${apps.length > 5 ? ` and ${apps.length - 5} more` : ""}`;
    const open = `/roles/${roleId}/talent?ownerStage=not_moving_forward`;
    if (s.sent.length) {
      const one = s.sent.length === 1;
      await notify(q, { companyId, kind: "message.untold_sent", title: `${one ? "1 person was" : `${s.sent.length} people were`} sent your decision message (${title})`, body: `${list(s.sent)}. Nobody had told them your decision for ${UNTOLD_SEND_WORKING_DAYS} working days, so the standard message went out, as your settings allow. ${one ? "It is on their page." : "Each message is on that person's page."}`, action: { label: "See who", href: open } });
    }
    if (s.recruiter.length) {
      const apps = s.recruiter.map((x) => x.app);
      const reasons = [...new Set(s.recruiter.map((x) => x.why))].join("; ");
      const esc = await createEscalation(q, { companyId, roleId, kind: "candidate_issue", summaryOrigin: "system", question: `${apps.length === 1 ? "One person has" : `${apps.length} people have`} not been told the team's decision on the ${title} role for ${UNTOLD_SEND_WORKING_DAYS} working days: ${list(apps)}. Nothing was sent, because ${reasons}. Please make sure each of them is told: the team can send the decision message from their page, or record that they told them in person.`, requestedBy: deps.actor, now: deps.now });
      for (const { app, why } of s.recruiter) {
        await emit(q, { type: "application.untold_fallback", companyId, actor: deps.actor, subject: { type: "application", id: app.id }, payload: { action: "recruiter", decisionAt: decidedAt(app), escalationId: esc.id, why } });
        results.push({ applicationId: app.id, action: "recruiter" });
      }
      const one = apps.length === 1;
      await notify(q, { companyId, kind: "recruiter.untold_brought_in", title: `A recruiter is helping tell ${one ? "1 person" : `${apps.length} people`} your decision (${title})`, body: `${list(apps)} ${one ? "has" : "have"} not been told for ${UNTOLD_SEND_WORKING_DAYS} working days. Nothing was sent, because ${reasons}, so an ITS recruiter was brought in. You can still send the message or record telling them yourself.`, action: { label: "See who", href: `${open}&told=not_told` } });
    }
  }
  return results;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The "still reviewing" note (plan G10)                                                                         */
/* ------------------------------------------------------------------------------------------------------------ */

/** Steps where an applicant waits on the team with nothing of their own to do (a screen or an interview in motion is contact enough). */
const WAITING_STAGES: ApplicationStage[] = ["received", "eligible", "ineligible", "triaged", "screen_complete", "interview_recommended", "interview_complete", "debrief", "finalist"];

/**
 * Daily runs missed (an outage, a retry) are made up for this many days; an older wait is never noted, so turning the
 * note on, or the release that added it, never writes to a backlog of people who applied months ago.
 */
export const STILL_REVIEWING_CATCH_UP_DAYS = 7;

/**
 * The courtesy note to everyone still waiting for a decision `afterDays` after they applied (policy
 * `message.still_reviewing`, 30 days unless the company chose otherwise): one per application, only under "Do it", never
 * to someone set aside as not a fit for now, nor without an address. Only within a week of the wait reaching `afterDays`
 * (`STILL_REVIEWING_CATCH_UP_DAYS`): someone who crossed it longer ago is never noted, months after the fact. Returns the
 * applications noted.
 */
export async function sendStillReviewingNotes(q: Queryable, deps: { integrations: Integrations; statusBaseUrl: string; now: Date; actor: Actor }, companyId: string): Promise<string[]> {
  const open = await q.select().from(roles).where(and(eq(roles.companyId, companyId), inArray(roles.status, ["open", "paused"])));
  const noted: string[] = [];
  for (const role of open) {
    const policy = await resolvePolicy(q, companyId, role.id, "message.still_reviewing");
    if (policy.level !== "auto" && policy.level !== "auto_notify") continue;
    const afterDays = Math.max(7, Number(policy.params.afterDays ?? 30) || 30);
    const cutoff = new Date(deps.now.getTime() - afterDays * 86_400_000);
    const windowStart = new Date(cutoff.getTime() - STILL_REVIEWING_CATCH_UP_DAYS * 86_400_000);
    const waiting = await q.select().from(applications).where(and(eq(applications.roleId, role.id), inArray(applications.stage, WAITING_STAGES), gt(applications.createdAt, windowStart.toISOString()), lte(applications.createdAt, cutoff.toISOString())));
    if (!waiting.length) continue;
    const already = new Set((await q.select({ applicationId: communications.applicationId }).from(communications).where(and(inArray(communications.applicationId, waiting.map((a) => a.id)), eq(communications.templateKey, "still_reviewing")))).map((r) => r.applicationId ?? ""));
    const marks = await activeMarksFor(q, waiting.map((a) => a.id));
    // Not to someone under Cancelled: they cancelled an interview and chose what comes next, or did not come to it, and
    // the team takes it from the Cancelled column; "still reviewing" would read wrong to them.
    const followUps = await activeFollowUpsFor(q, waiting.map((a) => a.id));
    for (const app of waiting) {
      if (already.has(app.id) || marks.get(app.id)?.mark === "not_a_fit_for_now" || inCancelled(app.stage, followUps.get(app.id))) continue;
      const parts = await loadDecisionParts(q, app);
      if (!parts?.cand.email) continue;
      const g = await gate(q, { companyId, roleId: role.id, applicationId: app.id, actionType: "message.still_reviewing", subject: { type: "application", id: app.id }, proposal: { afterDays }, requestedBy: deps.actor });
      if (g.outcome !== "execute") continue;
      await sendStillReviewingNote(q, deps.integrations, { application: app, candidate: parts.cand, role: parts.role, company: parts.company, packet: parts.packet, actor: deps.actor, statusUrl: statusUrlOf(deps.statusBaseUrl, app) });
      noted.push(app.id);
    }
  }
  return noted;
}
