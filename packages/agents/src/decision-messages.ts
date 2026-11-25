import { and, count, eq, gte, inArray, isNotNull, like } from "drizzle-orm";
import type { Actor, ToldState } from "@ros/contracts";
import { CLOSE_OUT_SENDS_FROM_DAYS, DECISION_TEMPLATE, adverseDecisionLineApplies } from "@ros/core";
import { applications, candidates, communications, companies, rolePackets, roles, type Queryable } from "@ros/db";
import type { Integrations } from "@ros/integrations";
import { CLOSE_OUT_TEMPLATE, decisionMessage, sendCloseOutNote, sendDecisionMessage } from "./coordinator";

/**
 * Telling a candidate a private decision. Someone marked Not selected hears nothing until a person presses "Email the
 * decision"; then they get the one standard wording (`decisionMessage`). The software never sends one by itself. Also
 * the close-out note to someone past the plan's candidates per job, which is no decision.
 */
type App = typeof applications.$inferSelect;

/** Why a decision email could not be queued: someone else got there first, or the decision is gone. */
export class DecisionMessageError extends Error {
  constructor(public readonly code: "not_decided" | "already_told", message: string) {
    super(message);
  }
}

/** Everything a candidate email is written from. Null when the application's candidate, job, company or job version is missing. */
export async function loadDecisionParts(q: Queryable, app: Pick<App, "candidateId" | "roleId" | "companyId" | "packetVersion">) {
  const [cand] = await q.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
  const [role] = await q.select().from(roles).where(eq(roles.id, app.roleId)).limit(1);
  const [company] = await q.select().from(companies).where(eq(companies.id, app.companyId)).limit(1);
  const [pv] = await q.select().from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), eq(rolePackets.version, app.packetVersion))).limit(1);
  return cand && role && company && pv ? { cand, role, company, packet: pv.packet } : null;
}

/** The candidate's own status page. Only ever in what is sent to the candidate: whoever holds the link can act as them. */
export function statusUrlOf(baseUrl: string, app: Pick<App, "statusToken">): string {
  return `${baseUrl}/c/status/${app.statusToken}`;
}

/**
 * Whether the decision message carries Colorado's line: the job is in Colorado, or the candidate is. Where the candidate
 * is: what is on file for them, else where their own resume says they are (the form does not ask).
 */
function coloradoLineApplies(parts: NonNullable<Awaited<ReturnType<typeof loadDecisionParts>>>, app: Pick<App, "extraction">): boolean {
  return adverseDecisionLineApplies({ jobLocations: parts.packet.identity.locations, candidateLocationText: parts.cand.locationText ?? app.extraction?.locationText ?? null });
}

/**
 * The decision email exactly as "Email the decision" would send it now: who it goes to, the subject and the text.
 * Null when the person is not marked Not selected, or there is nothing to write it from.
 */
export async function decisionMessageDraft(q: Queryable, app: App): Promise<{ to: string | null; subject: string; text: string; adverseDecisionLine: boolean } | null> {
  if (app.stage !== "rejected") return null;
  const parts = await loadDecisionParts(q, app);
  if (!parts) return null;
  const adverseDecisionLine = coloradoLineApplies(parts, app);
  return { to: parts.cand.email, ...decisionMessage({ candidate: parts.cand, company: parts.company, packet: parts.packet, adverseDecisionLine }), adverseDecisionLine };
}

/**
 * Queues the decision email and records that it is on its way (`toldState` "queued"; the outbox marks it sent once it
 * leaves, or not told again if it cannot be delivered). The application's row is locked and read again first, so two
 * Sends at the same moment write one message and the second is refused (`already_told`). A Send after a message that did
 * not reach them is a new message with a key of its own. Nothing is written for someone whose details were deleted at
 * their request. `sendAt`: when the email leaves; until then "Don't send" takes it back. Returns whether it is on its way.
 */
export async function queueDecisionMessage(q: Queryable, integrations: Integrations, input: { app: App; actor: Actor; now: Date; sendAt: Date | null }): Promise<{ queued: boolean; toldState: ToldState }> {
  const [locked] = await q.select({ toldState: applications.toldState, stage: applications.stage }).from(applications).where(eq(applications.id, input.app.id)).limit(1).for("update");
  if (locked?.stage !== "rejected") throw new DecisionMessageError("not_decided", "There is no decision to tell them about any more.");
  if (locked.toldState !== "not_told") throw new DecisionMessageError("already_told", "They were already told, or their decision email is already on its way.");
  const app = { ...input.app, toldState: locked.toldState, stage: locked.stage };
  const parts = await loadDecisionParts(q, app);
  if (!parts || parts.cand.anonymizedAt) return { queued: false, toldState: "not_told" };
  const [missed] = await q.select({ n: count() }).from(communications).where(and(eq(communications.applicationId, app.id), like(communications.templateKey, `${DECISION_TEMPLATE}%`), inArray(communications.status, ["failed", "cancelled", "unknown", "bounced"]), gte(communications.createdAt, app.rejectedAt ?? app.stageChangedAt)));
  const adverseDecisionLine = coloradoLineApplies(parts, app);
  const res = await sendDecisionMessage(q, integrations, { application: app, candidate: parts.cand, role: parts.role, company: parts.company, packet: parts.packet, actor: input.actor, attempt: Number(missed?.n ?? 0), adverseDecisionLine, sendAt: input.sendAt });
  if (res.status === "failed") return { queued: false, toldState: "not_told" };
  await q.update(applications).set({ toldState: "queued" }).where(and(eq(applications.id, app.id), eq(applications.toldState, "not_told")));
  return { queued: true, toldState: "queued" };
}

/**
 * The one note to someone still locked when their job has closed, or when the latest date they were promised comes: their
 * application has not been reviewed, and we cannot say whether it will be. It is what the on-file words promise ("we
 * email you to say so when the job closes, or at the latest on" their date), for someone nobody may read. It declines
 * nobody, moves no stage and tells the team nothing. Once per application, by its key and by this look; never to someone
 * who has left or whose details were deleted, nor to a person with no address. Returns the applications noted.
 */
export async function sendCloseOutNotes(q: Queryable, deps: { integrations: Integrations; statusBaseUrl: string; now: Date; actor: Actor }, companyId: string): Promise<string[]> {
  const jobs = await q.select({ id: roles.id, status: roles.status }).from(roles).where(and(eq(roles.companyId, companyId), inArray(roles.status, ["open", "paused", "closed"])));
  if (!jobs.length) return [];
  const closed = new Set(jobs.filter((r) => r.status === "closed").map((r) => r.id));
  const cutoff = deps.now.getTime() - CLOSE_OUT_SENDS_FROM_DAYS * 86_400_000;
  const unread = await q.select().from(applications).where(and(inArray(applications.roleId, jobs.map((r) => r.id)), isNotNull(applications.lockedAt), inArray(applications.stage, ["applied", "received"])));
  const due = unread.filter((a) => closed.has(a.roleId) || Date.parse(a.createdAt) <= cutoff);
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
