import { and, count, eq, gte, inArray, isNotNull, like, lte } from "drizzle-orm";
import { CHOOSABLE_WORDINGS, DECISION_WORDING_LABEL, type Actor, type CandidateNotice, type DecisionWording, type DecisionWordingOption, type ToldState } from "@ros/contracts";
import { CANDIDATE_LOCK_ACTOR, CLOSE_OUT_SENDS_FROM_DAYS, DECISION_STAGES, adverseDecisionLineApplies, emit } from "@ros/core";
import { applications, candidates, communications, companies, rolePackets, roles, type Queryable } from "@ros/db";
import type { Integrations } from "@ros/integrations";
import { CLOSE_OUT_TEMPLATE, dispositionMessage, sendCloseOutNote, sendDisposition } from "./coordinator";
import { HELD_REASON } from "./outbox";

/**
 * Telling candidates a private decision (founder decision B6; plan Wave G). Everything that writes the decision message,
 * wherever the Send comes from: a person on the candidate's page or in bulk, and the message to someone locked
 * (`tellOneLocked`). The wording is always one of the approved wordings (Q28); the assistant never writes a decline.
 * Also the close-out note to someone locked, which is no decision.
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
 * whoever holds it can act as the candidate (withdraw, opt out, ask for their data), so a team member must never be
 * able to copy it from a preview.
 */
export function statusUrlPlaceholder(baseUrl: string): string {
  return `${baseUrl}/c/status/[their status link]`;
}

const isEligibilityDecline = (app: Pick<App, "stage" | "rejectReason">) => app.stage === "rejected" && app.rejectReason === "eligibility";

/**
 * The standard wording for a decision: the eligibility wording after an eligibility decline (fixed), the closing message
 * for someone a closed role moved to the talent pool, the standard wording otherwise. A person's Send starts on the
 * suggested one.
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
export async function suggestedWording(_q: Queryable, app: Pick<App, "id" | "stage" | "rejectReason">, role: Pick<Role, "status">): Promise<DecisionWording> {
  const fallback = defaultWording(app, role);
  if (fallback !== "v1") return fallback;
  if (app.rejectReason === "position_filled") return "position_filled";
  return "v1";
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
export async function decisionMessageDraft(q: Queryable, input: { app: App; wording?: DecisionWording | null; statusBaseUrl: string; now: Date }) {
  const { app } = input;
  if (!DECISION_STAGES.includes(app.stage)) return null;
  const parts = await loadDecisionParts(q, app);
  if (!parts) return null;
  const { wording, options } = await resolveWording(q, app, parts.role, input.wording);
  const adverseDecisionLine = adverseDecisionLineApplies({ jobLocations: parts.packet.identity.locations, candidateLocationText: parts.cand.locationText });
  const message = dispositionMessage({ candidate: parts.cand, company: parts.company, packet: parts.packet, wording, statusUrl: statusUrlPlaceholder(input.statusBaseUrl), adverseDecisionLine });
  return { to: parts.cand.email, subject: message.subject, text: message.text, wording, wordings: options, adverseDecisionLine };
}

/** What became of one decision message: the toast's words, the told state now, the message (for Undo) and the wording used. */
export type QueuedDecision = { notice: CandidateNotice; toldState: ToldState; communicationId: string | null; wording: DecisionWording | null };

/**
 * Queues the decision message and records that it is on its way (the outbox marks it sent once it leaves, or not told
 * again if it cannot be delivered). A Send after a message that could not be delivered is a new attempt with a key of
 * its own; one still on its way or delivered never gets here: the application row is locked and its told state read
 * again first, so two Sends at the same moment write one message, and the second is refused (`already_told`). Nothing
 * is written for someone whose details were deleted at their request. `sendAt` holds a person's Send for the Undo
 * window (plan G9).
 */
export async function queueDecisionMessage(q: Queryable, integrations: Integrations, input: { app: App; actor: Actor; wording?: DecisionWording | null; statusBaseUrl: string; now: Date; sendAt?: Date | null }): Promise<QueuedDecision> {
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
  const res = await sendDisposition(q, integrations, { application: app, candidate: parts.cand, role: parts.role, company: parts.company, packet: parts.packet, actor: input.actor, wording, attempt: Number(failed?.n ?? 0), statusUrl: statusUrlOf(input.statusBaseUrl, app), adverseDecisionLine, sendAt: input.sendAt ?? null });
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

/**
 * The decision message by itself for one person past the plan's candidates per job (the plans of 5 November 2026, Rule 2), in
 * `wording`, with no word about keeping them, whatever the company's settings say, because the team cannot tell them. Nothing
 * goes to the team and nobody is brought in, and the fact on the record means nobody tries again if it could not go. True
 * when it is on its way. The closing message for someone a closed job left in its talent pool (`tellOneLockedOfClose`), or
 * the standard wording of the decision (`defaultWording`) for someone locked whose application carries a decision.
 */
export async function tellOneLocked(q: Queryable, integrations: Integrations, input: { app: App; wording: DecisionWording; statusBaseUrl: string; now: Date }): Promise<boolean> {
  const { app } = input;
  const decisionAt = new Date(app.rejectedAt ?? app.stageChangedAt).toISOString();
  const r = await queueDecisionMessage(q, integrations, { app, actor: CANDIDATE_LOCK_ACTOR, wording: input.wording, statusBaseUrl: input.statusBaseUrl, now: input.now }).catch((e: unknown) => {
    if (e instanceof DecisionMessageError && (e.code === "already_told" || e.code === "not_decided")) return null;
    throw e;
  });
  if (!r) return false;
  const went = r.notice === "queued" || r.notice === "held";
  await emit(q, { type: "application.untold_fallback", companyId: app.companyId, actor: CANDIDATE_LOCK_ACTOR, subject: { type: "application", id: app.id }, payload: { action: went ? "sent" : "not_sent", decisionAt, communicationId: r.communicationId, wording: r.wording, locked: true } });
  return went;
}

/**
 * The closing message for one person past the plan's candidates per job (Rule 2), through `tellOneLocked`: the role_closed
 * wording. Its key is one per application, so nobody gets it twice. Sent by a change of plan about to open them, so they
 * are opened as told (`unlockApplicants`). True when it is on its way.
 */
export async function tellOneLockedOfClose(q: Queryable, integrations: Integrations, input: { app: App; statusBaseUrl: string; now: Date }): Promise<boolean> {
  return tellOneLocked(q, integrations, { ...input, wording: "role_closed" });
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The close-out note (the plans of 5 November 2026, Rule 2)                                                      */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * The one note to someone still locked when the latest date they were promised comes and their job is still open: it has not
 * been reviewed, and we cannot say whether it will be. What makes "a real answer either way" true for someone nobody may read.
 * It declines nobody, moves no stage and tells the team nothing. It is no decision, so no setting holds it back: the team
 * cannot send it for them. Once per application, by its key and by this look; never to someone who has left, been told the job
 * closed, or whose details were deleted, nor to a person with no address. Returns the applications noted.
 */
export async function sendCloseOutNotes(q: Queryable, deps: { integrations: Integrations; statusBaseUrl: string; now: Date; actor: Actor }, companyId: string): Promise<string[]> {
  const open = await q.select({ id: roles.id }).from(roles).where(and(eq(roles.companyId, companyId), inArray(roles.status, ["open", "paused"])));
  if (!open.length) return [];
  const cutoff = new Date(deps.now.getTime() - CLOSE_OUT_SENDS_FROM_DAYS * 86_400_000);
  const due = await q.select().from(applications).where(and(inArray(applications.roleId, open.map((r) => r.id)), isNotNull(applications.lockedAt), inArray(applications.stage, ["applied", "received"]), lte(applications.createdAt, cutoff.toISOString())));
  if (!due.length) return [];
  const already = new Set((await q.select({ applicationId: communications.applicationId }).from(communications).where(and(inArray(communications.applicationId, due.map((a) => a.id)), eq(communications.templateKey, CLOSE_OUT_TEMPLATE)))).map((r) => r.applicationId ?? ""));
  const noted: string[] = [];
  for (const app of due) {
    if (already.has(app.id)) continue;
    const parts = await loadDecisionParts(q, app);
    if (!parts?.cand.email || parts.cand.anonymizedAt) continue;
    await sendCloseOutNote(q, deps.integrations, { application: app, candidate: parts.cand, role: parts.role, company: parts.company, packet: parts.packet, actor: deps.actor, statusUrl: statusUrlOf(deps.statusBaseUrl, app) });
    noted.push(app.id);
  }
  return noted;
}
