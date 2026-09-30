import { and, desc, eq, inArray } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { createEscalation, humanResponseExpectation, loadBusinessCalendar, notify } from "@ros/core";
import { fromAddress, queueCommunication, recordInbound, replyToFor, requestHuman } from "@ros/agents";
import { applications, candidates, communications, companies, inboundEmails, rolePackets, roles, screens, withPlatform, withTenant, type Tx } from "@ros/db";
import type { InboundEmail } from "@ros/integrations";
import type { Container } from "../container";
import { screenDeps } from "./screens";

/**
 * A candidate's reply to one of our emails (docs/spec/21 F12, D9, H12). With the inbound mail domain configured, every
 * candidate email carries a per-application Reply-To address; the Postmark inbound webhook hands a message to that
 * address here. The reply is recorded on the application as an inbound communication, the team is told with a link
 * straight to the candidate, and a reply whose first line is HUMAN hands the conversation to a person exactly as the
 * HUMAN keyword does in a screening text. Nothing here ever creates an application or changes a stage.
 */
type App = typeof applications.$inferSelect;
type InboundRow = typeof inboundEmails.$inferSelect;

const EMAIL_REPLY_ACTOR: Actor = { kind: "system", id: "email_reply" };
const SCREEN_ACTIVE_STATUSES = ["invited", "reminded", "in_progress"];

/** The first line of the message alone, trimmed. */
function firstLine(text: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
}

/** HUMAN on the first line (any case, a full stop or an exclamation mark allowed) asks for a person; anything else is a message for the team. */
export function humanRequested(text: string): boolean {
  return /^human[.!]?$/i.test(firstLine(text));
}

export async function handleCandidateReply(tx: Tx, container: Container, input: { app: App; mail: InboundEmail }): Promise<{ communicationId: string; humanRequested: boolean; duplicate?: boolean }> {
  const { app, mail } = input;
  // Postmark redelivers a message it thinks was not taken (a timeout after this transaction committed, for instance):
  // the same MessageID on this application is the same reply, recorded once, acted on once.
  if (mail.messageId) {
    const [seen] = await tx.select({ id: communications.id }).from(communications).where(and(eq(communications.applicationId, app.id), eq(communications.direction, "inbound"), eq(communications.providerMessageId, mail.messageId))).limit(1);
    if (seen) return { communicationId: seen.id, humanRequested: false, duplicate: true };
  }
  const [candidate] = await tx.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
  const [role] = await tx.select().from(roles).where(eq(roles.id, app.roleId)).limit(1);
  const [company] = await tx.select().from(companies).where(eq(companies.id, app.companyId)).limit(1);
  const [pv] = await tx.select().from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), eq(rolePackets.version, app.packetVersion))).limit(1);
  if (!candidate || !role || !company) throw new Error("the application's candidate, role or company is missing");
  const text = (mail.text ?? "").trim().slice(0, 20000) || "(an empty message)";
  const candidateActor: Actor = { kind: "candidate", id: candidate.id };
  const communicationId = await recordInbound(tx, { companyId: app.companyId, candidateId: candidate.id, applicationId: app.id, channel: "email", text, from: mail.from, provider: "postmark", providerMessageId: mail.messageId ?? null, actor: candidateActor });
  const name = `${candidate.firstName} ${candidate.lastName}`.trim() || "A candidate";
  const open = `/roles/${app.roleId}/talent?open=${app.id}`;
  const wantsHuman = humanRequested(text);
  await notify(tx, {
    companyId: app.companyId,
    kind: "message.received",
    title: `${name} wrote back`,
    body: wantsHuman ? `They asked for a person about ${role.title}. A recruiter has been asked to follow up; you can also reply yourself.` : `About ${role.title}: "${firstLine(text).slice(0, 140)}"`,
    action: { label: "Read it", href: open },
  });
  if (!wantsHuman) return { communicationId, humanRequested: false };

  const now = container.engine.clock();
  const calendar = await loadBusinessCalendar(tx, now);
  const signature = pv?.packet.communication.signature || `The hiring team at ${company.name}`;
  const reply = `Hi ${candidate.firstName},\n\nUnderstood. A person from ${company.name} will follow up with you ${humanResponseExpectation(now, calendar)}. Thank you for your patience.\n\n${signature}`;
  const [screen] = await tx.select({ id: screens.id }).from(screens).where(and(eq(screens.applicationId, app.id), inArray(screens.status, SCREEN_ACTIVE_STATUSES))).orderBy(desc(screens.updatedAt)).limit(1);
  if (screen) {
    // The same hand-off as HUMAN in a screening text: the conversation stops, a recruiter gets the whole context, the team is told.
    await requestHuman(tx, screenDeps(container), { screenId: screen.id, reason: "candidate asked for a person by email", actor: EMAIL_REPLY_ACTOR, reply, replyChannel: "web" });
  } else {
    await createEscalation(tx, { companyId: app.companyId, roleId: app.roleId, applicationId: app.id, kind: "candidate_issue", summaryOrigin: "candidate", question: `${name} replied HUMAN to an email about the ${role.title} role and needs a person. Please reach out by email${candidate.phone ? " or phone" : ""} and pick up the conversation.`, requestedBy: EMAIL_REPLY_ACTOR, now });
    await notify(tx, { companyId: app.companyId, kind: "screen.human_requested", title: `${name} asked for a person`, body: `They replied HUMAN to an email about ${role.title}. A recruiter has the request; you can also reply directly.`, action: { label: "Open the candidate", href: open } });
  }
  if (candidate.email) {
    // The response-time sentence goes back the same way every candidate email does: through the outbox, after this transaction commits.
    const subject = mail.subject?.trim() ? (/^re:/i.test(mail.subject.trim()) ? mail.subject.trim() : `Re: ${mail.subject.trim()}`) : `A person will follow up: ${role.title} at ${company.name}`;
    await queueCommunication(tx, container.integrations, { channel: "email", companyId: app.companyId, candidateId: candidate.id, applicationId: app.id, to: candidate.email, from: fromAddress(company, container.integrations), replyTo: replyToFor(app, container.integrations), subject, text: reply, templateKey: "human_requested_reply", idempotencyKey: mail.messageId ? `human_reply:${app.id}:${mail.messageId}` : `human_reply:${communicationId}`, tags: { template: "human_requested_reply", applicationId: app.id }, actor: EMAIL_REPLY_ACTOR, disclosureIncluded: false });
  }
  return { communicationId, humanRequested: true };
}

/**
 * The webhook's side: the reply token names the application (a platform read, since no tenant is known yet); the
 * reply is handled in the company's transaction; the inbound row records what became of it. An unknown token is
 * recorded as unmatched and nothing else happens: no application, no message, no error to the sender.
 */
export async function receiveCandidateReply(container: Container, input: { inbound: InboundRow; mail: InboundEmail; replyToken: string }): Promise<{ status: number; body: Record<string, unknown> }> {
  const found = await withPlatform(container.db, async (tx) => {
    const [app] = await tx.select().from(applications).where(eq(applications.replyToken, input.replyToken)).limit(1);
    if (!app) return null;
    const [cand] = await tx.select({ anonymizedAt: candidates.anonymizedAt }).from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
    return { app, anonymized: !!cand?.anonymizedAt };
  });
  if (!found) {
    await withPlatform(container.db, (tx) => tx.update(inboundEmails).set({ status: "unmatched", error: "unknown reply token" }).where(eq(inboundEmails.id, input.inbound.id)));
    return { status: 200, body: { ok: true, matched: false } };
  }
  const { app } = found;
  if (found.anonymized) {
    // A deletion request was fulfilled for this person: a reply to an old email must not write their address or words
    // back. The inbound row keeps nothing personal, nothing is recorded on the application, and nobody is notified.
    await withPlatform(container.db, (tx) => tx.update(inboundEmails).set({ status: "unmatched", error: "reply to a record removed at the person's request", fromAddress: "(removed)", subject: null, parsed: {} }).where(eq(inboundEmails.id, input.inbound.id)));
    return { status: 200, body: { ok: true, matched: false } };
  }
  try {
    const r = await withTenant(container.db, app.companyId, (tx) => handleCandidateReply(tx, container, { app, mail: input.mail }));
    await withPlatform(container.db, (tx) => tx.update(inboundEmails).set({ status: r.duplicate ? "duplicate" : "matched", companyId: app.companyId, applicationId: app.id }).where(eq(inboundEmails.id, input.inbound.id)));
    if (r.duplicate) return { status: 200, body: { ok: true, matched: true, reply: true, duplicate: true, applicationId: app.id } };
    await container.kick();
    return { status: 200, body: { ok: true, matched: true, reply: true, applicationId: app.id, humanRequested: r.humanRequested } };
  } catch (err) {
    await withPlatform(container.db, (tx) => tx.update(inboundEmails).set({ status: "error", companyId: app.companyId, error: err instanceof Error ? err.message : String(err) }).where(eq(inboundEmails.id, input.inbound.id)));
    return { status: 202, body: { ok: false, matched: true, reply: true, error: "could not record the reply; queued for review" } };
  }
}
