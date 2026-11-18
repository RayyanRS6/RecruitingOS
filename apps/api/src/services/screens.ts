import { and, desc, eq, inArray } from "drizzle-orm";
import type { Actor, AiInterviewView, ApplicationStage, ScreeningFunnel } from "@ros/contracts";
import { AI_INTERVIEW_PHASE, AI_INTERVIEW_REMIND_EXTENDS_HOURS, aiInterviewCanRemind, aiInterviewOf, disclosureLine, emit, isOneVisitFlow, notLocked, screeningFunnel, transition, writtenQuestionsOf, type AiInterviewScreen } from "@ros/core";
import { HELD_REASON, deliver, linkEmailWaiting, linkEmailsWaiting, loadScreenBundle, sendConversationIdleReminder, sendConversationNotStartedReminder, sendConversationReviewReminder, sendScreenReminder, type ScreenDeps } from "@ros/agents";
import { interviewsWaitingForMore } from "@ros/workflows";
import { applications, candidates, companies, rolePackets, roles, screens, type Tx } from "@ros/db";
import type { SendResult } from "@ros/integrations";
import { HttpError } from "../middleware/errors";
import type { Container } from "../container";
import { exitCleanup } from "./exit-cleanup";

/**
 * What the screening agent needs from the app: the model, the channels, the public host candidate links use, a way to
 * wake the workflow, and the clean-up when a candidate withdraws inside the conversation (by text or on the web), so an
 * interview they knew about is called off with a note confirming it, like every other way of leaving (plan A9).
 */
export function screenDeps(container: Container): ScreenDeps {
  return {
    ai: container.ai,
    integrations: container.integrations,
    appBaseUrl: container.env.JOBS_BASE_URL,
    signal: (q, input) => container.engine.signal(q, input),
    onWithdrawn: (q, input) => exitCleanup(q as Tx, container, { ...input, reason: "the candidate withdrew", candidateEmail: "send_cancellation" }),
    clock: () => container.engine.clock(),
  };
}

/** A screen the candidate has not started: the invitation can still be taken back. */
export const UNSTARTED_SCREEN_STATUSES: readonly string[] = ["invited", "reminded"];

type App = typeof applications.$inferSelect;

/**
 * "Stop this screen invitation" (plan A7): a person takes back a screening invitation the candidate has not started.
 * The screen is closed (its link then says so, instead of a bare "not found"), the screen's run is cancelled so no
 * reminder follows, the candidate goes back to waiting on the team ("Ready for your review"), and the candidate gets a
 * short, polite note through the outbox saying there is nothing to do with that link. Recorded as an event and a
 * person's override. Once they have started, the conversation is theirs to finish or leave; it cannot be stopped here.
 */
export async function stopScreenInvitation(tx: Tx, container: Container, input: { app: App; actor: Actor; by: Parameters<typeof transition>[1]["by"]; note?: string }): Promise<{ screenId: string; candidateTold: boolean }> {
  const { app, actor } = input;
  const [scr] = await tx.select().from(screens).where(and(eq(screens.applicationId, app.id), inArray(screens.status, [...UNSTARTED_SCREEN_STATUSES]))).orderBy(desc(screens.createdAt)).limit(1);
  if (!scr) throw new HttpError(409, "no_screen_invitation", "There is no AI interview invitation waiting for them; once they start, the AI interview cannot be stopped here.");
  await tx.update(screens).set({ status: "cancelled" }).where(eq(screens.id, scr.id));
  await emit(tx, { type: "screen.cancelled", companyId: app.companyId, actor, subject: { type: "screen", id: scr.id }, payload: { applicationId: app.id, reason: "stopped_by_team", note: input.note ?? null } });
  if (scr.workflowRunId) await container.engine.cancel(tx, scr.workflowRunId, actor, "a person stopped the screening invitation");
  if (app.stage === "screen_invited") await transition(tx, { applicationId: app.id, companyId: app.companyId, to: "triaged", by: input.by, actor, reason: input.note ?? "AI interview invitation stopped" });
  const candidateTold = await sendScreenStopped(tx, container, { app, actor, screenId: scr.id });
  return { screenId: scr.id, candidateTold };
}

/**
 * How the conversation goes for a role (plan E13): offered, started, finished, the median time to finish, how many
 * chose a person, and the questions people skipped in the answers they sent. From the latest screen of each
 * application; counts only, never a name or an answer, and nothing from a conversation nobody sent (`screeningFunnel`), nor
 * anything someone past the plan's candidates per job did (Rule 3).
 */
export async function roleScreeningFunnel(tx: Tx, roleId: string): Promise<ScreeningFunnel> {
  const rows = await tx.select({ applicationId: screens.applicationId, status: screens.status, invitedVia: screens.invitedVia, startedAt: screens.startedAt, completedAt: screens.completedAt, progress: screens.progress, transcript: screens.transcript, createdAt: screens.createdAt }).from(screens).innerJoin(applications, eq(applications.id, screens.applicationId)).where(and(eq(applications.roleId, roleId), notLocked())).orderBy(desc(screens.createdAt));
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!latest.has(r.applicationId)) latest.set(r.applicationId, r);
  const [role] = await tx.select({ version: roles.currentPacketVersion }).from(roles).where(eq(roles.id, roleId)).limit(1);
  const [pv] = role?.version ? await tx.select({ packet: rolePackets.packet }).from(rolePackets).where(and(eq(rolePackets.roleId, roleId), eq(rolePackets.version, role.version))).limit(1) : [];
  // A chat that asked the company's written questions (Wave S7 in the visit; S8 by text or from an emailed link) keeps
  // its skips under their keys: named in the company's words too (`writtenQuestionsOf`, never what it looks for). A
  // must-have's gap question is named by the must-have, the closing one by the closing question (`answerKeyWords`).
  const named = pv ? [...pv.packet.screening.questions, ...writtenQuestionsOf(pv.packet)].map((q) => ({ key: q.key, question: q.question })) : [];
  return screeningFunnel([...latest.values()], named, pv?.packet.requirements.mustHaves ?? []);
}

/** What "No AI interview yet" reads of a screen (`aiInterviewOf`), with its status and how it was offered. */
export type LatestScreen = AiInterviewScreen & { applicationId: string; status: string; invitedVia: string | null };

/**
 * The newest screen of each application of a list, in one read, whatever order the rows come in, with whether the email
 * carrying its link has left yet (`linkEmailHeld`, B7; read only for a link still open).
 */
export async function latestScreensFor(tx: Tx, applicationIds: string[]): Promise<Map<string, LatestScreen>> {
  const out = new Map<string, LatestScreen>();
  if (!applicationIds.length) return out;
  const rows = await tx.select({ id: screens.id, applicationId: screens.applicationId, status: screens.status, invitedVia: screens.invitedVia, invitedAt: screens.invitedAt, expiresAt: screens.expiresAt, remindedAt: screens.remindedAt, idleRemindedAt: screens.idleRemindedAt, startedAt: screens.startedAt, completedAt: screens.completedAt, humanRequestedAt: screens.humanRequestedAt, createdAt: screens.createdAt }).from(screens).where(inArray(screens.applicationId, applicationIds)).orderBy(desc(screens.createdAt), desc(screens.id));
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!latest.has(r.applicationId)) latest.set(r.applicationId, r);
  const held = await linkEmailsWaiting(tx, [...latest.values()].filter((r) => REMINDABLE.includes(r.status)));
  for (const { id, ...r } of latest.values()) out.set(r.applicationId, { ...r, linkEmailHeld: held.has(id) });
  return out;
}

/**
 * Where each application under "No AI interview yet" stands with it (20 Oct 2026, R20-7; `aiInterviewOf`): the list
 * rows', the detail's and the board's `aiInterview`, with whether one still being prepared only waits for more AI
 * interviews this month (Q17, `interviewsWaitingForMore`). Applications outside the column are left out, and so is someone
 * locked: no AI interview is coming, so nothing may say it is being prepared.
 */
export async function aiInterviewsFor(tx: Tx, apps: ReadonlyArray<{ id: string; stage: string; lockedAt?: string | null }>, now: Date): Promise<Map<string, AiInterviewView>> {
  const inColumn = apps.filter((a) => AI_INTERVIEW_PHASE.includes(a.stage as ApplicationStage) && !a.lockedAt);
  const latest = await latestScreensFor(tx, inColumn.map((a) => a.id));
  const waitingForMore = await interviewsWaitingForMore(tx, inColumn.filter((a) => !latest.has(a.id)).map((a) => a.id));
  const out = new Map<string, AiInterviewView>();
  for (const a of inColumn) {
    const view = aiInterviewOf(a.stage, latest.get(a.id) ?? null, now, { waitingForMore: waitingForMore.has(a.id) });
    if (view) out.set(a.id, view);
  }
  return out;
}

/**
 * "Send a reminder" (20 Oct 2026, R20-7; `remind_screen`): a person reminds someone whose AI interview link is open (not
 * started, or started and not sent), at most once a day after the link or the last reminder went
 * (`aiInterviewCanRemind`). The reminder is the one the run would send (not started: "still open"; started: "pick up
 * where you left off", or "ready to send" at Review & send), under a key of its own per screen and day, and it keeps the
 * link open at least 72 hours from now: `expiresAt` moves out (never in), and a started one is kept open as long
 * (`keptOpenUntil`); the run reads both again before closing it. Recorded as `screen.reminded` `{by: "person"}`. Email
 * only (texting is off by default, M2). Never while the email carrying the link has not left (held for the ITS company
 * check, B7): the reminder would only wait behind it, and the link's clock has not started (409 `link_email_held`); the
 * day between reminders counts from when that email left (the run moves `invitedAt` then). A reminder can itself be held
 * if the company's check was taken back since, which the answer says (`held`).
 */
export async function remindScreen(tx: Tx, container: Container, input: { app: App; actor: Actor }): Promise<{ screenId: string; held: boolean; linkOpenUntil: string; started: boolean }> {
  const { app, actor } = input;
  const now = container.engine.clock();
  const [scr] = await tx.select().from(screens).where(eq(screens.applicationId, app.id)).orderBy(desc(screens.createdAt), desc(screens.id)).limit(1);
  if (scr?.status === "paused") throw new HttpError(409, "interview_paused", AI_INTERVIEW_PAUSED_REASON);
  if (!scr || !REMINDABLE.includes(scr.status)) throw new HttpError(409, "no_open_link", "Their AI interview link is not open. Send them a new link instead.");
  if (await linkEmailWaiting(tx, scr)) throw new HttpError(409, "link_email_held", LINK_EMAIL_HELD_REASON);
  if (!aiInterviewCanRemind(scr, now)) throw new HttpError(409, "reminded_recently", REMINDED_RECENTLY_REASON);
  const b = await loadScreenBundle(tx, scr.id);
  if (!b) throw new HttpError(404, "not_found", "Application not found.");
  const at = now.toISOString();
  const until = new Date(Math.max(scr.expiresAt ? Date.parse(scr.expiresAt) : 0, now.getTime() + AI_INTERVIEW_REMIND_EXTENDS_HOURS * 3600_000)).toISOString();
  const started = scr.status === "in_progress";
  const sendKey = `screen_reminder_person:${scr.id}:${at.slice(0, 10)}`;
  const base = { application: b.app, candidate: b.candidate, role: b.role, company: b.company, packet: b.packet, actor, correlationId: scr.workflowRunId, appBaseUrl: container.env.JOBS_BASE_URL, sendKey };
  const link = { ...base, screen: { id: scr.id, token: scr.token }, questions: b.packet.screening.questions.length, minutes: b.packet.screening.maxMinutes };
  let sent: SendResult;
  if (started) sent = scr.progress.phase === "review" ? await sendConversationReviewReminder(tx, container.integrations, { ...link, closesOn: dayWords(new Date(until), b.company.timezone) }) : await sendConversationIdleReminder(tx, container.integrations, link);
  else if (isOneVisitFlow(scr.progress)) sent = await sendConversationNotStartedReminder(tx, container.integrations, link);
  else sent = (await sendScreenReminder(tx, container.integrations, { ...base, screen: { id: scr.id, token: scr.token, channel: "web" } })).email;
  const patch: Partial<typeof screens.$inferInsert> = started ? { idleRemindedAt: at, expiresAt: until, progress: { ...scr.progress, keptOpenUntil: until } } : { status: "reminded", remindedAt: at, expiresAt: until };
  await tx.update(screens).set(patch).where(eq(screens.id, scr.id));
  await emit(tx, { type: "screen.reminded", companyId: app.companyId, actor, subject: { type: "screen", id: scr.id }, payload: { applicationId: app.id, by: "person", started, linkOpenUntil: until } });
  return { screenId: scr.id, held: sent.status === "pending" && sent.reason === HELD_REASON, linkOpenUntil: until, started };
}

/** An open link a person can remind about: not started, or started and not sent (not one paused while the assistant is down). */
const REMINDABLE: readonly string[] = ["invited", "reminded", "in_progress"];

/** Why "Send a reminder" waits, in the team's words (the action's refusal and the disabled button say the same). */
export const REMINDED_RECENTLY_REASON = "Their link or a reminder went less than a day ago. You can send a reminder a day after the last one.";
export const LINK_EMAIL_HELD_REASON = "Their AI interview link has not gone to them yet: the email waits for ITS to check your company. You can send a reminder a day after it goes.";
export const AI_INTERVIEW_PAUSED_REASON = "Their AI interview is paused while the assistant is not working; it carries on by itself, and they are emailed when it does.";

/** A day as the candidate reads it, in the company's time zone: "Saturday, October 10, 2026". */
function dayWords(at: Date, timeZone: string): string {
  return at.toLocaleDateString("en-US", { timeZone, weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

/** The polite note: the link can be ignored, nothing is needed from them, and a person has their application. */
async function sendScreenStopped(tx: Tx, container: Container, input: { app: App; actor: Actor; screenId: string }): Promise<boolean> {
  const { app } = input;
  const [candidate] = await tx.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
  const [role] = await tx.select().from(roles).where(eq(roles.id, app.roleId)).limit(1);
  const [company] = await tx.select().from(companies).where(eq(companies.id, app.companyId)).limit(1);
  const [pv] = await tx.select().from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), eq(rolePackets.version, app.packetVersion))).limit(1);
  if (!candidate || !role || !company || !pv) return false;
  const packet = pv.packet;
  const text = `Hi ${candidate.firstName},

You can ignore the AI interview we sent you for the ${packet.identity.title} position at ${company.name}: the hiring team is reviewing your application themselves instead. Nothing is needed from you right now, and they will be in touch about next steps.

${packet.communication.humanAlternativeText}

${packet.communication.signature || `The hiring team at ${company.name}`}

${packet.communication.disclosureText || disclosureLine(company.name)}`;
  const sent = await deliver(tx, container.integrations, { application: app, candidate, role, company, packet, actor: input.actor, channel: "email", templateKey: "screen_stopped", subject: `No need to do the AI interview for ${packet.identity.title}`, text, idempotencyKey: `screen_stopped:${input.screenId}`, eventOnSent: "message.sent", to: candidate.email });
  return sent.status !== "failed";
}
