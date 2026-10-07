import { and, desc, eq, inArray } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { disclosureLine, emit, transition } from "@ros/core";
import { deliver, type ScreenDeps } from "@ros/agents";
import { applications, candidates, companies, rolePackets, roles, screens, type Tx } from "@ros/db";
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
  if (!scr) throw new HttpError(409, "no_screen_invitation", "There is no screening invitation waiting for them; once they start, the conversation cannot be stopped here.");
  await tx.update(screens).set({ status: "cancelled" }).where(eq(screens.id, scr.id));
  await emit(tx, { type: "screen.cancelled", companyId: app.companyId, actor, subject: { type: "screen", id: scr.id }, payload: { applicationId: app.id, reason: "stopped_by_team", note: input.note ?? null } });
  if (scr.workflowRunId) await container.engine.cancel(tx, scr.workflowRunId, actor, "a person stopped the screening invitation");
  if (app.stage === "screen_invited") await transition(tx, { applicationId: app.id, companyId: app.companyId, to: "triaged", by: input.by, actor, reason: input.note ?? "screening invitation stopped" });
  const candidateTold = await sendScreenStopped(tx, container, { app, actor, screenId: scr.id });
  return { screenId: scr.id, candidateTold };
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

You can ignore the screening conversation we sent you for the ${packet.identity.title} position at ${company.name}: the hiring team is reviewing your application themselves instead. Nothing is needed from you right now, and they will be in touch about next steps.

${packet.communication.humanAlternativeText}

${packet.communication.signature || `The hiring team at ${company.name}`}

${packet.communication.disclosureText || disclosureLine(company.name)}`;
  const sent = await deliver(tx, container.integrations, { application: app, candidate, role, company, packet, actor: input.actor, channel: "email", templateKey: "screen_stopped", subject: `No need to complete the screening for ${packet.identity.title}`, text, idempotencyKey: `screen_stopped:${input.screenId}`, eventOnSent: "message.sent", to: candidate.email });
  return sent.status !== "failed";
}
