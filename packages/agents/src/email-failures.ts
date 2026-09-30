import { and, desc, eq, gte } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { RETRY_DELAYS_MS, SOFT_BOUNCE_LIMIT, SOFT_BOUNCE_WINDOW_MS, emit, nextContactWindow, notify, raiseAlert, suppressAddress } from "@ros/core";
import { applications, candidates, communications, companies, jobs, rolePackets, roles, users, type Queryable } from "@ros/db";
import type { EmailEvent, Integrations } from "@ros/integrations";
import { deliverSms } from "./coordinator";
import { queueCommunication } from "./outbox";

/**
 * What happens when an email fails after we sent it (founder instruction of 18 September 2026, item 5).
 * Hard bounce: the address goes on the do-not-send list, the message is marked, the customer is told, and a text goes to
 * the candidate when they agreed to texts. Soft bounce: one retry after four hours and one after a day; two soft bounces
 * in a week suppress the address. Spam complaint: suppressed for good, no more email of any kind, an administrator is
 * alerted. Every outcome is an event on the communication; nothing is silent.
 */
export type EmailFailureOutcome = { handled: boolean; communicationId: string | null; action: "suppressed" | "retry_scheduled" | "recorded" | "unmatched"; suppressionReason?: string };

export async function handleEmailEvent(q: Queryable, integrations: Integrations, input: { event: EmailEvent; appBaseUrl: string; now: Date }): Promise<EmailFailureOutcome> {
  const { event, now } = input;
  const actor: Actor = { kind: "system", id: "email_webhook" };
  const [comm] = event.messageId ? await q.select().from(communications).where(eq(communications.providerMessageId, event.messageId)).orderBy(desc(communications.createdAt)).limit(1) : [];
  const address = (event.email || comm?.toAddress || "").toLowerCase();
  if (!address) return { handled: false, communicationId: null, action: "unmatched" };
  if (event.recordType === "Delivery") {
    if (comm) await q.update(communications).set({ status: "delivered", deliveredAt: event.at }).where(eq(communications.id, comm.id));
    if (comm) await emit(q, { type: "message.delivered", companyId: comm.companyId, actor, subject: { type: "communication", id: comm.id }, payload: { provider: "postmark" } });
    return { handled: true, communicationId: comm?.id ?? null, action: "recorded" };
  }
  const failureType = event.complaint ? "spam_complaint" : event.hard ? "hard_bounce" : "soft_bounce";
  if (comm) {
    await q.update(communications).set({ status: event.complaint ? "complained" : "bounced", error: `${event.type}: ${event.description}`.slice(0, 500), failureType }).where(eq(communications.id, comm.id));
    await emit(q, { type: event.complaint ? "message.complained" : "message.bounced", companyId: comm.companyId, actor, subject: { type: "communication", id: comm.id }, payload: { type: event.type, failureType, template: comm.templateKey, address } });
  }
  const companyId = comm?.companyId ?? null;
  // Who is behind the address: a candidate, or a person on a customer's team (or ITS)?
  // Every candidate record with this address, in every company: a dead or complaining address is dead everywhere.
  const cands = await q.select().from(candidates).where(companyId ? and(eq(candidates.companyId, companyId), eq(candidates.email, address)) : eq(candidates.email, address));
  const cand = cands[0];
  // A failure for a message we did not record (a retry, a system mail) is still an event on the candidate it concerns.
  if (!comm && cand) await emit(q, { type: event.complaint ? "message.complained" : "message.bounced", companyId: cand.companyId, actor, subject: { type: "candidate", id: cand.id }, payload: { type: event.type, failureType, address, unmatchedMessage: true } });
  const [user] = await q.select().from(users).where(eq(users.email, address)).limit(1);

  if (event.complaint || event.hard) {
    const reason = event.complaint ? "spam_complaint" : "hard_bounce";
    await suppressAddress(q, { address, reason, source: "postmark", providerMessageId: event.messageId, details: { type: event.type, description: event.description }, actor, companyId, now });
    if (comm) await emit(q, { type: "message.suppressed", companyId: comm.companyId, actor, subject: { type: "communication", id: comm.id }, payload: { reason, address } });
    if (event.complaint) for (const each of cands) await q.update(candidates).set({ preferences: { ...each.preferences, emailOptOut: true } }).where(eq(candidates.id, each.id));
    if (cand) {
      const cid = companyId ?? cand.companyId;
      const fallback = event.complaint ? null : await smsFallback(q, integrations, { candidateId: cand.id, companyId: cid, communication: comm ?? null, appBaseUrl: input.appBaseUrl, now });
      await notify(q, { companyId: cid, kind: "candidate.unreachable", title: event.complaint ? `${cand.firstName} ${cand.lastName} marked our email as spam` : `${cand.firstName} ${cand.lastName} cannot be reached by email`, body: event.complaint ? "We will not email them again. If you still want to talk with them, call them; nothing further goes out automatically." : `Their address bounced (${event.description}). ${fallback === "sent" ? "We texted them a link to their status page." : fallback === "scheduled" ? "A text with their status link goes out when contact hours open." : cand.phone ? "They did not agree to texts; please call them." : "There is no phone number on file; please reach them another way."}`, action: { label: "Open the candidate", href: comm?.applicationId ? `/roles/${(await roleOf(q, comm.applicationId)) ?? ""}/talent` : "/talent" } });
    }
    if (user) {
      await raiseAlert(q, { kind: "email.person_unreachable", severity: event.complaint ? "critical" : "high", title: event.complaint ? `A team member's address complained: ${address}` : `A team member's address bounces: ${address}`, body: `${event.description} Sign-in links and notifications to this address will not be delivered until an administrator releases the suppression after confirming the address.`, companyId, details: { userId: user.id, type: event.type } });
    }
    if (event.complaint) await raiseAlert(q, { kind: "email.spam_complaint", severity: "critical", title: `Spam complaint from ${address}`, body: `Message: ${comm?.subject ?? "unknown"} (${comm?.templateKey ?? "unknown template"}). The address is suppressed. Review the message and the sending pattern before anything else goes to similar recipients.`, companyId, target: comm ? { type: "communication", id: comm.id } : null, details: { type: event.type, description: event.description } });
    return { handled: true, communicationId: comm?.id ?? null, action: "suppressed", suppressionReason: reason };
  }

  // Soft bounce: count recent ones for this address; retry, or suppress after the limit.
  const since = new Date(now.getTime() - SOFT_BOUNCE_WINDOW_MS).toISOString();
  const recent = await q.select({ id: communications.id }).from(communications).where(and(eq(communications.toAddress, address), eq(communications.failureType, "soft_bounce"), gte(communications.createdAt, since)));
  if (recent.length >= SOFT_BOUNCE_LIMIT) {
    await suppressAddress(q, { address, reason: "soft_bounce_repeated", source: "postmark", providerMessageId: event.messageId, details: { recentSoftBounces: recent.length }, actor, companyId, now });
    if (comm) await emit(q, { type: "message.suppressed", companyId: comm.companyId, actor, subject: { type: "communication", id: comm.id }, payload: { reason: "soft_bounce_repeated", address } });
    if (cand && companyId) await notify(q, { companyId, kind: "candidate.unreachable", title: `${cand.firstName} ${cand.lastName} cannot be reached by email`, body: "Their mailbox keeps rejecting messages. Please call them or reach them another way.", action: { label: "Open talent", href: "/talent" } });
    return { handled: true, communicationId: comm?.id ?? null, action: "suppressed", suppressionReason: "soft_bounce_repeated" };
  }
  if (comm && comm.retryAttempt < RETRY_DELAYS_MS.length) {
    await q.insert(jobs).values({ kind: "email.retry", payload: { communicationId: comm.id, attempt: comm.retryAttempt + 1 }, runAt: new Date(now.getTime() + RETRY_DELAYS_MS[comm.retryAttempt]).toISOString(), maxAttempts: 3 });
    return { handled: true, communicationId: comm.id, action: "retry_scheduled" };
  }
  return { handled: true, communicationId: comm?.id ?? null, action: "recorded" };
}

async function roleOf(q: Queryable, applicationId: string): Promise<string | null> {
  const [a] = await q.select({ roleId: applications.roleId }).from(applications).where(eq(applications.id, applicationId)).limit(1);
  return a?.roleId ?? null;
}

/** A text with the status link when the candidate agreed to texts; outside contact hours it is queued for the next window. */
async function smsFallback(q: Queryable, integrations: Integrations, input: { candidateId: string; companyId: string; communication: typeof communications.$inferSelect | null; appBaseUrl: string; now: Date }): Promise<"sent" | "scheduled" | "not_possible"> {
  const [cand] = await q.select().from(candidates).where(eq(candidates.id, input.candidateId)).limit(1);
  if (!cand?.phone || !cand.consent.sms?.granted || cand.preferences.smsOptOut) return "not_possible";
  const appId = input.communication?.applicationId ?? null;
  const [app] = appId ? await q.select().from(applications).where(eq(applications.id, appId)).limit(1) : await q.select().from(applications).where(eq(applications.candidateId, cand.id)).orderBy(desc(applications.createdAt)).limit(1);
  if (!app) return "not_possible";
  const [company] = await q.select().from(companies).where(eq(companies.id, input.companyId)).limit(1);
  const allowed = nextContactWindow(input.now, company.timezone, company.settings.businessHours);
  if (allowed.getTime() > input.now.getTime()) {
    await q.insert(jobs).values({ kind: "email.fallback_sms", payload: { applicationId: app.id, communicationId: input.communication?.id ?? null }, runAt: allowed.toISOString(), maxAttempts: 3 });
    return "scheduled";
  }
  await sendFallbackSms(q, integrations, { applicationId: app.id, communicationId: input.communication?.id ?? null, appBaseUrl: input.appBaseUrl });
  return "sent";
}

export async function sendFallbackSms(q: Queryable, integrations: Integrations, input: { applicationId: string; communicationId: string | null; appBaseUrl: string }): Promise<void> {
  const [app] = await q.select().from(applications).where(eq(applications.id, input.applicationId)).limit(1);
  if (!app) return;
  const [cand] = await q.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
  const [role] = await q.select().from(roles).where(eq(roles.id, app.roleId)).limit(1);
  const [company] = await q.select().from(companies).where(eq(companies.id, app.companyId)).limit(1);
  const [pv] = await q.select().from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), eq(rolePackets.version, app.packetVersion))).limit(1);
  if (!cand || !role || !company || !pv) return;
  await deliverSms(q, integrations, { application: app, candidate: cand, role, company, packet: pv.packet, actor: { kind: "system", id: "email_webhook" }, text: `${company.name} hiring team (AI-assisted): we could not reach you by email. Your application status and next steps: ${input.appBaseUrl}/c/status/${app.statusToken} Reply HUMAN for a person, STOP to opt out.`, idempotencyKey: `email_fallback_sms:${input.communicationId ?? app.id}`, templateKey: "email_fallback", disclosureIncluded: true });
}

/**
 * Re-sends a soft-bounced message once or twice as a new outbox row that links to the original; a further failure comes
 * back through the webhook and follows the same rules. A permanent failure of the retry (an address suppressed in the
 * meantime) is reported by the outbox when it sends.
 */
export async function retryCommunication(q: Queryable, integrations: Integrations, input: { communicationId: string; attempt: number; now: Date }): Promise<{ queued: boolean; reason?: string }> {
  const [orig] = await q.select().from(communications).where(eq(communications.id, input.communicationId)).limit(1);
  if (!orig?.toAddress || orig.channel !== "email") return { queued: false, reason: "nothing to retry" };
  const actor: Actor = { kind: "system", id: "email_retry" };
  const queued = await queueCommunication(q, integrations, {
    channel: "email",
    companyId: orig.companyId,
    candidateId: orig.candidateId,
    applicationId: orig.applicationId,
    to: orig.toAddress,
    from: orig.fromAddress ?? `${integrations.env.productName} <${integrations.env.fromAddress}>`,
    replyTo: orig.replyTo ?? integrations.env.replyTo,
    subject: orig.subject ?? "(no subject)",
    text: orig.bodyText,
    html: orig.bodyHtml,
    templateKey: orig.templateKey ?? "retry",
    idempotencyKey: `${orig.id}:retry:${input.attempt}`,
    tags: { template: orig.templateKey ?? "retry", retryOf: orig.id },
    attachments: orig.attachments,
    actor,
    disclosureIncluded: orig.disclosureIncluded,
    retryOf: orig.id,
    retryAttempt: input.attempt,
  }, input.now);
  await q.update(communications).set({ retryAttempt: input.attempt }).where(eq(communications.id, orig.id));
  await emit(q, { type: "message.retried", companyId: orig.companyId, actor, subject: { type: "communication", id: queued.communicationId }, payload: { retryOf: orig.id, attempt: input.attempt, status: queued.status } });
  return { queued: queued.status !== "failed", reason: queued.status === "failed" ? queued.error : undefined };
}
