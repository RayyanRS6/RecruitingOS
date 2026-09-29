import type { Actor, RolePacket } from "@ros/contracts";
import { emit, disclosureLine } from "@ros/core";
import { communications, type Queryable, type applications, type candidates, type companies, type roles } from "@ros/db";
import type { Integrations, SendResult } from "@ros/integrations";
import { queueCommunication } from "./outbox";

type App = typeof applications.$inferSelect;
type Cand = typeof candidates.$inferSelect;
type Role = typeof roles.$inferSelect;
type Company = typeof companies.$inferSelect;

export type MessageInput = { application: App; candidate: Cand; role: Role; company: Company; packet: RolePacket; actor: Actor; correlationId?: string | null };

/** Founder decision F6: a dedicated ITS sending address with the customer's hiring team as the display name; never the customer's domain. */
function fromAddress(company: Company, integrations: Integrations): string {
  return `${company.name} hiring team <${integrations.env.fromAddress}>`;
}

function signature(packet: RolePacket, company: Company): string {
  return packet.communication.signature || `The hiring team at ${company.name}`;
}

/** The acknowledgment every applicant gets within a minute. Templated, disclosed, idempotent. */
export async function sendAcknowledgment(q: Queryable, integrations: Integrations, input: MessageInput & { appBaseUrl: string; /** Texting is off by default (decision M2); the email then promises an online conversation only. */ smsEnabled?: boolean }): Promise<SendResult> {
  const { application, candidate, company, packet } = input;
  const statusUrl = `${input.appBaseUrl}/c/status/${application.statusToken}`;
  const disclosure = packet.communication.disclosureText || disclosureLine(company.name);
  const steps = packet.interviews.plan.map((r, i) => `${i + 2}. ${r.title} (${r.durationMinutes} min)`).join("\n");
  const screenHow = input.smsEnabled ? "by text or online" : "online";
  const text = `Hi ${candidate.firstName},

Thank you for applying for the ${packet.identity.title} position at ${company.name}. We received your application and it is being reviewed.

What happens next:
1. A short screening conversation (${screenHow}, about ${packet.screening.maxMinutes} minutes) if your background looks like a fit.
${steps}

You can check where things stand any time: ${statusUrl}

${packet.communication.humanAlternativeText}

${signature(packet, company)}

${disclosure}`;
  return deliver(q, integrations, {
    ...input,
    channel: "email",
    templateKey: "acknowledgment",
    subject: `We received your application: ${packet.identity.title} at ${company.name}`,
    text,
    idempotencyKey: `ack:${application.id}`,
    eventOnSent: "message.sent",
    to: candidate.email,
  });
}

/** A respectful, specific disposition after a human decision or an owner-authored eligibility rule. */
export async function sendDisposition(q: Queryable, integrations: Integrations, input: MessageInput & { reason: string }): Promise<SendResult> {
  const { application, candidate, company, packet } = input;
  const why =
    input.reason === "eligibility"
      ? "Based on your answers to the eligibility questions, this particular role requires something you indicated you do not currently have (for example a license, certification, or schedule availability). If that has changed or you answered in error, reply to this email and a person will take a look."
      : "After reviewing your background against what this role needs, the team has decided not to move forward at this time.";
  const text = `Hi ${candidate.firstName},

Thank you for your interest in the ${packet.identity.title} position at ${company.name}.

${why}

We would like to keep your information for future openings unless you prefer we do not; reply "no thanks" and we will remove you from consideration for future roles.

${signature(packet, company)}

${packet.communication.disclosureText || disclosureLine(company.name)}`;
  return deliver(q, integrations, {
    ...input,
    channel: "email",
    templateKey: `disposition:${input.reason}`,
    subject: `Your application to ${company.name}`,
    text,
    idempotencyKey: `disposition:${application.id}`,
    eventOnSent: "message.sent",
    to: candidate.email,
  });
}

/**
 * Every candidate email goes through the outbox: recorded as queued inside the caller's transaction, sent by the worker
 * after commit, once per idempotency key. The result is therefore `pending` at this point; `message.sent` follows.
 */
export async function deliver(
  q: Queryable,
  integrations: Integrations,
  input: MessageInput & { channel: "email"; templateKey: string; subject: string; text: string; idempotencyKey: string; eventOnSent: "message.sent"; to: string | null; attachments?: Array<{ filename: string; contentType: string; contentBase64: string }> },
): Promise<SendResult> {
  const { application, candidate, company } = input;
  const sentBy = input.actor;
  if (!input.to) {
    const [row] = await q.insert(communications).values({ companyId: company.id, candidateId: candidate.id, applicationId: application.id, direction: "outbound", channel: input.channel, fromAddress: fromAddress(company, integrations), toAddress: null, subject: input.subject, bodyText: input.text, templateKey: input.templateKey, provider: integrations.email.id, status: "failed", disclosureIncluded: true, sentBy, error: "candidate has no email address" }).returning({ id: communications.id });
    await emit(q, { type: "message.failed", companyId: company.id, actor: sentBy, subject: { type: "communication", id: row.id }, payload: { template: input.templateKey, error: "no email" }, correlationId: input.correlationId ?? null });
    return { status: "failed", error: "candidate has no email address", retryable: false };
  }
  return queueCommunication(q, integrations, {
    channel: "email",
    companyId: company.id,
    candidateId: candidate.id,
    applicationId: application.id,
    to: input.to,
    from: fromAddress(company, integrations),
    replyTo: integrations.env.replyTo,
    subject: input.subject,
    text: input.text,
    templateKey: input.templateKey,
    idempotencyKey: input.idempotencyKey,
    tags: { template: input.templateKey, applicationId: application.id },
    attachments: input.attachments ?? null,
    actor: sentBy,
    correlationId: input.correlationId ?? null,
    disclosureIncluded: true,
  });
}

/** Everything the screening messages need beyond MessageInput. */
export type ScreenMessageInput = MessageInput & { appBaseUrl: string; screen: { id: string; token: string; channel: "web" | "sms" }; opening?: string | null };

function screenUrl(input: ScreenMessageInput): string {
  return `${input.appBaseUrl}/c/screen/${input.screen.token}`;
}

/** The screen invitation: always by email with the web link; by SMS as well when the candidate consented. Disclosed on both. */
export async function sendScreenInvite(q: Queryable, integrations: Integrations, input: ScreenMessageInput): Promise<{ email: SendResult; sms: SendResult | null }> {
  const { candidate, company, packet } = input;
  const url = screenUrl(input);
  const disclosure = packet.communication.disclosureText || disclosureLine(company.name);
  const text = `Hi ${candidate.firstName},

Thanks again for applying for the ${packet.identity.title} position at ${company.name}. The next step is a short screening conversation: ${packet.screening.questions.length} questions, about ${packet.screening.maxMinutes} minutes, at whatever time suits you.

Start here: ${url}
${input.screen.channel === "sms" && candidate.phone ? "\nYou can also answer by text; we sent the first question to your phone.\n" : ""}
${packet.communication.humanAlternativeText}

${signature(packet, company)}

${disclosure}`;
  const email = await deliver(q, integrations, {
    ...input,
    channel: "email",
    templateKey: "screen_invite",
    subject: `Next step: a short screening conversation for ${packet.identity.title}`,
    text,
    idempotencyKey: `screen_invite:${input.screen.id}`,
    eventOnSent: "message.sent",
    to: candidate.email,
  });
  let sms: SendResult | null = null;
  if (input.screen.channel === "sms") {
    const body = `${input.opening ?? `${company.name} hiring team (AI-assisted): a short screening for ${packet.identity.title}. Reply HUMAN for a person, STOP to opt out.`}${input.opening ? "" : `\nOr answer online: ${url}`}`;
    sms = await deliverSms(q, integrations, { ...input, text: body, idempotencyKey: `screen_invite_sms:${input.screen.id}`, templateKey: "screen_invite", disclosureIncluded: true });
  }
  return { email, sms };
}

export async function sendScreenReminder(q: Queryable, integrations: Integrations, input: ScreenMessageInput): Promise<{ email: SendResult; sms: SendResult | null }> {
  const { candidate, company, packet } = input;
  const url = screenUrl(input);
  const text = `Hi ${candidate.firstName},

A quick reminder: the short screening conversation for the ${packet.identity.title} position at ${company.name} is waiting for you whenever you have ${packet.screening.maxMinutes} minutes: ${url}

If you are no longer interested, no reply is needed; we will close the application in a few days and keep you in mind for future openings.

${packet.communication.humanAlternativeText}

${signature(packet, company)}

${packet.communication.disclosureText || disclosureLine(company.name)}`;
  const email = await deliver(q, integrations, { ...input, channel: "email", templateKey: "screen_reminder", subject: `Reminder: your screening conversation for ${packet.identity.title}`, text, idempotencyKey: `screen_reminder:${input.screen.id}`, eventOnSent: "message.sent", to: candidate.email });
  let sms: SendResult | null = null;
  if (input.screen.channel === "sms") {
    sms = await deliverSms(q, integrations, { ...input, text: `${company.name} hiring team (AI-assisted): your screening for ${packet.identity.title} is waiting: ${url} Reply HUMAN for a person, STOP to opt out.`, idempotencyKey: `screen_reminder_sms:${input.screen.id}`, templateKey: "screen_reminder", disclosureIncluded: true });
  }
  return { email, sms };
}

/**
 * Queues a text. Refuses without recorded consent or after an opt-out (TCPA, docs/08); the caller handles quiet hours.
 * Every attempt is a communications row, so the owner and the recruiter see what was said. The text itself leaves
 * through the outbox after the caller's transaction commits.
 */
export async function deliverSms(
  q: Queryable,
  integrations: Integrations,
  input: MessageInput & { text: string; idempotencyKey: string; templateKey: string; disclosureIncluded: boolean; aiRunId?: string | null },
): Promise<SendResult> {
  const { application, candidate, company } = input;
  const base = { companyId: company.id, candidateId: candidate.id, applicationId: application.id, direction: "outbound" as const, channel: "sms" as const, fromAddress: integrations.sms.id, toAddress: candidate.phone, subject: null, bodyText: input.text, templateKey: input.templateKey, provider: integrations.sms.id, disclosureIncluded: input.disclosureIncluded, sentBy: input.actor, aiRunId: input.aiRunId ?? null };
  const refuse = async (error: string): Promise<SendResult> => {
    const [row] = await q.insert(communications).values({ ...base, status: "failed", error }).returning({ id: communications.id });
    await emit(q, { type: "message.failed", companyId: company.id, actor: input.actor, subject: { type: "communication", id: row.id }, payload: { template: input.templateKey, channel: "sms", error }, correlationId: input.correlationId ?? null });
    return { status: "failed", error, retryable: false };
  };
  if (!candidate.phone) return refuse("candidate has no phone number");
  if (!candidate.consent.sms?.granted) return refuse("no SMS consent on record");
  if (candidate.preferences.smsOptOut) return refuse("candidate opted out of texts");
  return queueCommunication(q, integrations, {
    channel: "sms",
    companyId: company.id,
    candidateId: candidate.id,
    applicationId: application.id,
    to: candidate.phone,
    from: integrations.sms.id,
    text: input.text,
    templateKey: input.templateKey,
    idempotencyKey: input.idempotencyKey,
    actor: input.actor,
    correlationId: input.correlationId ?? null,
    disclosureIncluded: input.disclosureIncluded,
    aiRunId: input.aiRunId ?? null,
  });
}

/** Records a message the candidate sent us (SMS reply, web chat turn) so the thread is complete. */
export async function recordInbound(q: Queryable, input: { companyId: string; candidateId: string; applicationId: string; channel: "sms" | "web" | "email"; text: string; from?: string | null; provider?: string | null; providerMessageId?: string | null; actor: Actor; correlationId?: string | null }): Promise<string> {
  const [row] = await q.insert(communications).values({ companyId: input.companyId, candidateId: input.candidateId, applicationId: input.applicationId, direction: "inbound", channel: input.channel, fromAddress: input.from ?? null, toAddress: null, subject: null, bodyText: input.text, provider: input.provider ?? null, providerMessageId: input.providerMessageId ?? null, status: "received", disclosureIncluded: false, sentBy: input.actor }).returning({ id: communications.id });
  await emit(q, { type: "message.received", companyId: input.companyId, actor: input.actor, subject: { type: "communication", id: row.id }, payload: { channel: input.channel, applicationId: input.applicationId }, correlationId: input.correlationId ?? null });
  return row.id;
}
