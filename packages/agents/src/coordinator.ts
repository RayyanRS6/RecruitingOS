import type { Actor, DecisionWording, RolePacket } from "@ros/contracts";
import { ADVERSE_DECISION_LINE, emit, disclosureLine } from "@ros/core";
import { communications, type Queryable, type applications, type candidates, type companies, type roles } from "@ros/db";
import { replyAddress, type Integrations, type SendResult } from "@ros/integrations";
import { queueCommunication, type QueueResult } from "./outbox";

type App = typeof applications.$inferSelect;
type Cand = typeof candidates.$inferSelect;
type Role = typeof roles.$inferSelect;
type Company = typeof companies.$inferSelect;

export type MessageInput = { application: App; candidate: Cand; role: Role; company: Company; packet: RolePacket; actor: Actor; correlationId?: string | null };

/** Founder decision F6: a dedicated ITS sending address with the customer's hiring team as the display name; never the customer's domain. */
export function fromAddress(company: Company, integrations: Integrations): string {
  return `${company.name} hiring team <${integrations.env.fromAddress}>`;
}

/**
 * Where a candidate's reply lands (F12). With the inbound mail domain configured, every candidate email carries a
 * per-application address, reply-<token>@<intake domain>, and the reply comes back into the product: the Postmark
 * inbound webhook records it on the application and tells the team. Without it, replies go to the monitored ITS
 * mailbox, where a person reads them (docs/runbooks/candidate-replies.md).
 */
export function replyToFor(application: Pick<App, "replyToken">, integrations: Integrations): string {
  if (integrations.env.emailInConfigured && application.replyToken) return replyAddress(application.replyToken, integrations.env.intakeDomain);
  return integrations.env.replyTo;
}

function signature(packet: RolePacket, company: Company): string {
  return packet.communication.signature || `The hiring team at ${company.name}`;
}

/**
 * What follows a message a person wrote (F11): who sent it and how to reach a person. No disclosure line when no AI
 * wrote any of it; when the person kept a line the assistant suggested (`aiHelped`, Q28), the footer says the assistant
 * helped. The sheet shows this footer under the text box so the sender sees exactly what the candidate will.
 */
export function freeformFooter(input: { senderName: string; company: Company; aiHelped?: boolean }): string {
  const who = input.aiHelped
    ? `This message was written by ${input.senderName} with help from an AI assistant, which suggested some of the wording.`
    : `This message was written by ${input.senderName}.`;
  return `${input.senderName}\n${input.company.name} hiring team\n\n${who} Reply to this email to reach a person on the team.`;
}

/**
 * A message a team member wrote to the candidate, sent as themselves under the company's sending name. Goes through
 * the outbox like every candidate email; the caller has already passed the policy gate and audits the send. `sendAt`
 * holds it for the Undo window (plan G9); `aiRunId` names the assistant's suggestion it used, if any.
 */
export async function sendFreeformMessage(q: Queryable, integrations: Integrations, input: MessageInput & { subject: string | null; text: string; senderName: string; idempotencyKey: string; aiHelped?: boolean; aiRunId?: string | null; sendAt?: Date | null }): Promise<QueueResult | SendResult> {
  const { application, candidate, company, packet } = input;
  if (!candidate.email) return { status: "failed", error: "candidate has no email address", retryable: false };
  const subject = input.subject?.trim() || `A message from ${company.name} about ${packet.identity.title}`;
  const text = `${input.text.trim()}\n\n${freeformFooter({ senderName: input.senderName, company, aiHelped: input.aiHelped })}`;
  return queueCommunication(q, integrations, {
    channel: "email",
    companyId: company.id,
    candidateId: candidate.id,
    applicationId: application.id,
    to: candidate.email,
    from: fromAddress(company, integrations),
    replyTo: replyToFor(application, integrations),
    subject,
    text,
    templateKey: "freeform",
    idempotencyKey: input.idempotencyKey,
    tags: { template: "freeform", applicationId: application.id, ...(input.aiHelped ? { aiHelped: "yes" } : {}) },
    actor: input.actor,
    correlationId: input.correlationId ?? null,
    disclosureIncluded: !!input.aiHelped,
    aiRunId: input.aiRunId ?? null,
    sendAt: input.sendAt ?? null,
  });
}

/**
 * The AI interview the one email offers (20 Oct 2026, R20-5, R20-10, R20-11):
 * - `link`: its link, with the job's own length (`minutes`, the job's screening length);
 * - `follows`: the month's AI interviews are used up (Q17): the link follows by email once more are added;
 * - `none`: the neutral thank-you, for someone held on a must-have answer or who left the process before it went.
 */
export type AcknowledgedInterview = { kind: "link"; url: string; minutes: number } | { kind: "follows"; minutes: number } | { kind: "none" };

/** The address already belonged to someone on the company's records (known-bugs row 17): the email says it was sent using it. */
const KNOWN_ADDRESS_LINE = "This application was sent using your email address. If you did not send it, reply to this email and a person will look into it.";

/**
 * The one email every applicant gets (20 Oct 2026, R20-5): thank you, and the AI interview as their next step, sent the
 * moment the interview is ready (the résumé read, at the latest ten minutes after applying). Templated, disclosed,
 * idempotent; the template key and the `ack:` key are the acknowledgment's, which the AI-notice wait, the outbox signal
 * and the provider's tags rely on. It says "next step", never "to qualify" (R20-6): not doing it never stops the
 * application. Never in SCREEN_LINK_TEMPLATES (outbox.ts): it carries the status link and the AI notice, so it goes even
 * when the interview closed before it left.
 */
export async function sendAcknowledgment(q: Queryable, integrations: Integrations, input: MessageInput & {
  appBaseUrl: string;
  interview: AcknowledgedInterview;
  knownAddress?: boolean;
}): Promise<SendResult> {
  const { application, candidate, company, packet } = input;
  const statusUrl = `${input.appBaseUrl}/c/status/${application.statusToken}`;
  const disclosure = packet.communication.disclosureText || disclosureLine(company.name);
  const iv = input.interview;
  const title = packet.identity.title;
  const known = input.knownAddress ? `\n\n${KNOWN_ADDRESS_LINE}` : "";
  const footer = `${packet.communication.humanAlternativeText}

${signature(packet, company)}

${disclosure}`;
  const body = iv.kind === "link"
    ? `Thank you for applying for the ${title} position at ${company.name}. We have your application.

Your next step is a short interview with ${company.name}'s AI assistant. Everyone who applies gets the same interview, so every application is looked at the same way. It is a written chat of about ${iv.minutes} minutes; find a quiet moment when you can give it your attention.

Start your AI interview: ${iv.url}

How it works:
- The assistant asks one question at a time about your experience and this job, and you answer in your own words.
- You can skip any question.
- If you stop part-way, your answers are saved: use the same link to carry on.
- At the end you check your answers and press Send. Nothing goes to the hiring team before you do.
- The link stays open for 5 days, and we send you one reminder.

Prefer a person? Choose "I'd rather talk to a person" on the interview page, or reply to this email.
If you need an adjustment, such as more time or another format, reply and tell us.
Not doing the interview never stops your application: it still goes to the hiring team. People on the hiring team read every application and make every decision.

Check where things stand at any time: ${statusUrl}${known}`
    : iv.kind === "follows"
      ? `Thank you for applying for the ${title} position at ${company.name}. We have your application.

Your next step is a short interview with ${company.name}'s AI assistant, a written chat of about ${iv.minutes} minutes. Everyone who applies gets the same interview. We will email you its link as soon as it is ready.

You can skip any question, and you can choose to talk to a person instead. If you need an adjustment, such as more time or another format, reply and tell us. Not doing the interview never stops your application. People on the hiring team read every application and make every decision.

Check where things stand at any time: ${statusUrl}${known}`
      : `Thank you for applying for the ${title} position at ${company.name}. We received your application. People on the hiring team review it and make every decision.${known}

What happens next:
1. The hiring team at ${company.name} reviews your application.
${packet.interviews.plan.map((r, i) => `${i + 2}. ${r.title} (${r.durationMinutes} min)`).join("\n")}

You can check where things stand any time: ${statusUrl}`;
  return deliver(q, integrations, {
    ...input,
    channel: "email",
    templateKey: "acknowledgment",
    subject: iv.kind === "none" ? `Thank you for applying: ${title} at ${company.name}` : `Thank you for applying: your next step for ${title} at ${company.name}`,
    text: `Hi ${candidate.firstName},\n\n${body}\n\n${footer}`,
    idempotencyKey: `ack:${application.id}`,
    eventOnSent: "message.sent",
    to: candidate.email,
  });
}

/**
 * What a candidate email says about future roles (Wave 0 item 0.11). Someone who already asked not to be kept is never
 * offered it again: their choice is acknowledged instead.
 */
export function futureRolesLine(candidate: { preferences: { talentPoolOptOut?: boolean } }): string {
  return candidate.preferences.talentPoolOptOut
    ? "As you asked, we will not keep your details for future roles."
    : "We would like to keep your information for future openings unless you prefer we do not; reply \"no thanks\" and we will remove you from consideration for future roles.";
}

/** The screen reminder's last word to someone no longer interested; it promises nothing about future roles to a person who opted out. */
export function reminderClosingLine(candidate: { preferences: { talentPoolOptOut?: boolean } }): string {
  return candidate.preferences.talentPoolOptOut
    ? "If you are no longer interested, no reply is needed; we will close the application in a few days."
    : "If you are no longer interested, no reply is needed; we will close the application in a few days and keep you in mind for future openings.";
}

/**
 * An interview the candidate knew about that the decision called off and nobody has told them is off yet (the decision
 * message goes in the same transaction as the cancellation); the decision message says so, so the candidate gets one
 * message, not two. A booked one has its time; one whose times were only offered has none (`startsAt` null).
 */
export type CancelledInterview = { title: string; startsAt: string | null; timezone: string | null };

/**
 * The sentence that tells the decision, in each approved wording (founder decision Q28, plan G6). Ours, never the AI's.
 * DRAFT WORDING PENDING COUNSEL (docs/spec/11-counsel-register.md item 23), except `v1` and `eligibility`, the wordings
 * the product has always sent. None of them gives a reason beyond the eligibility answer, which the candidate can correct.
 * The status page restates each wording in `decisionLine` (apps/api/src/pages/candidate.tsx), also under item 23;
 * change both together.
 */
const DECISION_SENTENCE: Record<DecisionWording, (company: string) => string> = {
  v1: () => "After reviewing your background against what this role needs, the team has decided not to move forward at this time.",
  v2: (company) => `We appreciate the time you took to apply and to tell us about yourself. After careful thought, the team at ${company} has decided not to move forward with your application for this role.`,
  v3: () => "The team has decided not to move forward with your application for this role.",
  after_interview: (company) => `Thank you for taking the time to meet the team at ${company}. After the interviews, the team has decided not to move forward with your application for this role.`,
  position_filled: () => "The position has now been filled, so the team will not be moving forward with your application for this role.",
  role_closed: (company) => `${company} has closed this position, so your application for this role will not go any further.`,
  eligibility: () => "Based on your answers to the eligibility questions, this particular role requires something you indicated you do not currently have (for example a license, certification, or schedule availability). If that has changed or you answered in error, reply to this email and a person will take a look.",
};

/** The template key each wording is recorded under; the standard wording keeps the key it always had. */
export function decisionTemplateKey(wording: DecisionWording): string {
  return wording === "v1" ? "disposition:human" : wording === "v2" || wording === "v3" ? `disposition:human:${wording}` : `disposition:${wording}`;
}

/** A personal line a person added, with their name: it is said to be theirs. */
export type PersonalLine = { text: string; senderName: string };

/**
 * The decision message: respectful, after a human decision or an owner-authored eligibility rule, in one of the
 * approved wordings. A decision is private until a person sends this (founder decision B6). It also carries the
 * cancellation of an interview the decision called off when the candidate was not already told it is off, and an
 * optional personal line the person wrote (checked before it gets here, `checkPersonalLine`). Below the signature comes
 * the locked footer nobody can edit (Q28): what we keep for future roles and how to say no to it, how to reach a person,
 * Colorado's line about asking for the reasons (plan G5, when `adverseDecisionLine`), and the AI disclosure. Pure, so the
 * page can preview exactly what will go.
 */
export function dispositionMessage(input: Pick<MessageInput, "candidate" | "company" | "packet"> & { wording: DecisionWording; cancelledInterviews?: CancelledInterview[]; personalLine?: PersonalLine | null; statusUrl?: string | null; adverseDecisionLine?: boolean }): { subject: string; text: string; templateKey: string; wording: DecisionWording } {
  const { candidate, company, packet } = input;
  const when = (startsAt: string, timezone: string | null) => new Date(startsAt).toLocaleString("en-US", { timeZone: timezone ?? "UTC", weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  const cancelled = (input.cancelledInterviews ?? []).map((iv) => (iv.startsAt ? `The ${iv.title} on ${when(iv.startsAt, iv.timezone)} is cancelled, so there is no need to attend.` : `The times we offered you for the ${iv.title} are no longer available, so there is no need to pick one.`)).join(" ");
  const personal = input.personalLine?.text.trim() ? `A note from ${input.personalLine.senderName}: ${input.personalLine.text.trim()}` : "";
  // The status page has the one-click "Don't keep me for future roles" (Wave 0 item 0.11), and the link lands on it;
  // someone who already said so is not offered it again.
  const futureRoles = input.statusUrl && !candidate.preferences.talentPoolOptOut ? `${futureRolesLine(candidate)} You can also choose this on your status page: ${input.statusUrl}#future-roles` : futureRolesLine(candidate);
  const footer = [futureRoles, packet.communication.humanAlternativeText, input.adverseDecisionLine ? ADVERSE_DECISION_LINE.text : null, packet.communication.disclosureText || disclosureLine(company.name)].filter((x): x is string => !!x);
  const text = `Hi ${candidate.firstName},

Thank you for your interest in the ${packet.identity.title} position at ${company.name}.

${DECISION_SENTENCE[input.wording](company.name)}${cancelled ? `\n\n${cancelled}` : ""}${personal ? `\n\n${personal}` : ""}

${signature(packet, company)}

${footer.join("\n\n")}`;
  return { subject: `Your application to ${company.name}`, text, templateKey: decisionTemplateKey(input.wording), wording: input.wording };
}

/**
 * Queues the decision message. One per decision: the key carries when the decision was made, so a second Send for the
 * same decision finds the first message, while a later decision (after "review anyway") gets a message of its own.
 * `attempt` counts earlier messages for this decision that did not reach them (could not be delivered, or were taken
 * back with Undo): sending again is a new message. The closing message of a closed role has one key per application
 * (`role_closed:<id>`, Q30), so nobody gets it twice; a new key only follows one that did not reach them.
 * `sendAt` holds a person's Send for the Undo window (plan G9).
 */
export async function sendDisposition(q: Queryable, integrations: Integrations, input: MessageInput & { wording: DecisionWording; cancelledInterviews?: CancelledInterview[]; attempt?: number; personalLine?: PersonalLine | null; statusUrl?: string | null; adverseDecisionLine?: boolean; sendAt?: Date | null }): Promise<SendResult> {
  const { application, candidate } = input;
  const message = dispositionMessage(input);
  const again = input.attempt ? `:${input.attempt}` : "";
  const idempotencyKey = input.wording === "role_closed" ? `role_closed:${application.id}${again}` : `disposition:${application.id}:${application.rejectedAt ?? application.stageChangedAt}${again}`;
  return deliver(q, integrations, {
    ...input,
    channel: "email",
    templateKey: message.templateKey,
    subject: message.subject,
    text: message.text,
    idempotencyKey,
    eventOnSent: "message.sent",
    to: candidate.email,
    // Colorado's line is recorded on the message, so a reply asking for the reasons reaches the compliance queue (plan G5).
    tags: { ...(input.adverseDecisionLine ? { adverseDecisionLine: ADVERSE_DECISION_LINE.version } : {}), ...(input.personalLine ? { personalLine: "yes" } : {}) },
    sendAt: input.sendAt ?? null,
  });
}

/**
 * Every candidate email goes through the outbox: recorded as queued inside the caller's transaction, sent by the worker
 * after commit, once per idempotency key. The result is therefore `pending` at this point; `message.sent` follows.
 */
export async function deliver(
  q: Queryable,
  integrations: Integrations,
  input: MessageInput & { channel: "email"; templateKey: string; subject: string; text: string; idempotencyKey: string; eventOnSent: "message.sent"; to: string | null; attachments?: Array<{ filename: string; contentType: string; contentBase64: string }>; tags?: Record<string, string>; sendAt?: Date | null },
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
    replyTo: replyToFor(application, integrations),
    subject: input.subject,
    text: input.text,
    templateKey: input.templateKey,
    idempotencyKey: input.idempotencyKey,
    tags: { ...(input.tags ?? {}), template: input.templateKey, applicationId: application.id },
    attachments: input.attachments ?? null,
    actor: sentBy,
    correlationId: input.correlationId ?? null,
    disclosureIncluded: true,
    sendAt: input.sendAt ?? null,
  });
}

/** Everything the screening messages need beyond MessageInput. */
/** `sendKey`: a reminder of its own (a person's "Send a reminder", R20-7, once a day), in place of the one automatic reminder's key. */
export type ScreenMessageInput = MessageInput & { appBaseUrl: string; screen: { id: string; token: string; channel: "web" | "sms" }; opening?: string | null; sendKey?: string };

function screenUrl(input: ScreenMessageInput): string {
  return `${input.appBaseUrl}/c/screen/${input.screen.token}`;
}

/**
 * The AI interview's link in an email of its own: a person's "Send a new link", or the link that follows the one email
 * (someone kept in after a must-have answer, or the month's interviews topped up; 20 Oct 2026). Always by email with the
 * web link; by SMS as well when a person chose texts and the candidate consented. Disclosed on both. It gives minutes, not
 * a number of questions: the chat fixes its plan when it starts.
 */
export async function sendScreenInvite(q: Queryable, integrations: Integrations, input: ScreenMessageInput): Promise<{ email: SendResult; sms: SendResult | null }> {
  const { candidate, company, packet } = input;
  const url = screenUrl(input);
  const disclosure = packet.communication.disclosureText || disclosureLine(company.name);
  const text = `Hi ${candidate.firstName},

Thanks again for applying for the ${packet.identity.title} position at ${company.name}. Your next step is a short interview with ${company.name}'s AI assistant: a written chat of about ${packet.screening.maxMinutes} minutes, at whatever time suits you.

Start your AI interview: ${url}
${input.screen.channel === "sms" && candidate.phone ? "\nYou can also answer by text; we sent the first question to your phone.\n" : ""}
You can skip any question, and if you stop part-way your answers are saved. Prefer a person? Choose "I'd rather talk to a person" on the interview page, or reply to this email. Not doing the interview never stops your application.

${packet.communication.humanAlternativeText}

${signature(packet, company)}

${disclosure}`;
  const email = await deliver(q, integrations, {
    ...input,
    channel: "email",
    templateKey: "screen_invite",
    subject: `Your next step: a short AI interview for ${packet.identity.title}`,
    text,
    idempotencyKey: `screen_invite:${input.screen.id}`,
    eventOnSent: "message.sent",
    to: candidate.email,
  });
  let sms: SendResult | null = null;
  if (input.screen.channel === "sms") {
    const body = `${input.opening ?? `${company.name} hiring team (AI-assisted): a short AI interview for ${packet.identity.title}. Reply HUMAN for a person, STOP to opt out.`}${input.opening ? "" : `\nOr answer online: ${url}`}`;
    sms = await deliverSms(q, integrations, { ...input, text: body, idempotencyKey: `screen_invite_sms:${input.screen.id}`, templateKey: "screen_invite", disclosureIncluded: true });
  }
  return { email, sms };
}

export async function sendScreenReminder(q: Queryable, integrations: Integrations, input: ScreenMessageInput): Promise<{ email: SendResult; sms: SendResult | null }> {
  const { candidate, company, packet } = input;
  const url = screenUrl(input);
  const text = `Hi ${candidate.firstName},

A quick reminder: your short AI interview for the ${packet.identity.title} position at ${company.name} is waiting for you whenever you have ${packet.screening.maxMinutes} minutes: ${url}

${reminderClosingLine(candidate)}

${packet.communication.humanAlternativeText}

${signature(packet, company)}

${packet.communication.disclosureText || disclosureLine(company.name)}`;
  const email = await deliver(q, integrations, { ...input, channel: "email", templateKey: "screen_reminder", subject: `Reminder: your AI interview for ${packet.identity.title}`, text, idempotencyKey: input.sendKey ?? `screen_reminder:${input.screen.id}`, eventOnSent: "message.sent", to: candidate.email });
  let sms: SendResult | null = null;
  if (input.screen.channel === "sms") {
    sms = await deliverSms(q, integrations, { ...input, text: `${company.name} hiring team (AI-assisted): your AI interview for ${packet.identity.title} is waiting: ${url} Reply HUMAN for a person, STOP to opt out.`, idempotencyKey: input.sendKey ? `${input.sendKey}:sms` : `screen_reminder_sms:${input.screen.id}`, templateKey: "screen_reminder", disclosureIncluded: true });
  }
  return { email, sms };
}

/**
 * The AI interview link lapsed without the candidate starting it (plan G10): no silent expiry. The application is still
 * with the team, and a reply brings a new link from a person. One per screen.
 */
export async function sendScreenExpiredNote(q: Queryable, integrations: Integrations, input: MessageInput & { screen: { id: string } }): Promise<SendResult> {
  const { candidate, company, packet } = input;
  const text = `Hi ${candidate.firstName},

The link to your short AI interview for the ${packet.identity.title} position at ${company.name} has now closed, because it was not started. Your application is still with the hiring team, and people on the team make every decision.

If you would still like to answer the questions, reply to this email and someone on the team can send you a new link.

${packet.communication.humanAlternativeText}

${signature(packet, company)}

${packet.communication.disclosureText || disclosureLine(company.name)}`;
  return deliver(q, integrations, { ...input, channel: "email", templateKey: "screen_expired", subject: `Your AI interview link for ${packet.identity.title} has closed`, text, idempotencyKey: `screen_expired:${input.screen.id}`, eventOnSent: "message.sent", to: candidate.email });
}

/**
 * The courtesy note to someone who has waited a long time for a decision (plan G10, policy `message.still_reviewing`):
 * no decision yet, a person makes it, they will hear either way. Says nothing about how they are doing. Once per
 * application. Carries the AI disclosure like every automatic email.
 */
export async function sendStillReviewingNote(q: Queryable, integrations: Integrations, input: MessageInput & { statusUrl: string }): Promise<SendResult> {
  const { application, candidate, company, packet } = input;
  const text = `Hi ${candidate.firstName},

Thank you for your patience. Your application for the ${packet.identity.title} position at ${company.name} is still being reviewed, and no decision has been made yet. People on the hiring team make every decision, and you will hear from them either way.

You can check where things stand any time: ${input.statusUrl}

${packet.communication.humanAlternativeText}

${signature(packet, company)}

${packet.communication.disclosureText || disclosureLine(company.name)}`;
  return deliver(q, integrations, { ...input, channel: "email", templateKey: "still_reviewing", subject: `Still reviewing your application: ${packet.identity.title} at ${company.name}`, text, idempotencyKey: `still_reviewing:${application.id}`, eventOnSent: "message.sent", to: candidate.email });
}

/**
 * The candidate asked for a person (plan G8): an email that says when to expect them, from the business hours, so the
 * promise is in writing wherever they asked. `expectation` is "within four business hours (...)" or "on the next business
 * day (...)". One per request (`key`).
 */
export async function sendPersonRequestedNote(q: Queryable, integrations: Integrations, input: MessageInput & { expectation: string; key: string }): Promise<SendResult> {
  const { candidate, company, packet } = input;
  const text = `Hi ${candidate.firstName},

You asked to talk to a person about your application for the ${packet.identity.title} position at ${company.name}. A person working with the hiring team will contact you ${input.expectation}. Nothing else is needed from you; you can also reply to this email.

${signature(packet, company)}

${packet.communication.disclosureText || disclosureLine(company.name)}`;
  return deliver(q, integrations, { ...input, channel: "email", templateKey: "person_requested", subject: `A person will contact you about ${packet.identity.title}`, text, idempotencyKey: `person_requested:${input.key}`, eventOnSent: "message.sent", to: candidate.email });
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

/**
 * Records a message the candidate sent us (SMS reply, web chat turn) so the thread is complete. `screenId`: it was
 * typed or texted in that screening conversation, so the team sees it only once the conversation's answers are sent
 * (`withoutUnsentConversation` in @ros/core).
 */
export async function recordInbound(q: Queryable, input: { companyId: string; candidateId: string; applicationId: string; channel: "sms" | "web" | "email"; text: string; from?: string | null; provider?: string | null; providerMessageId?: string | null; actor: Actor; correlationId?: string | null; screenId?: string | null }): Promise<string> {
  const [row] = await q.insert(communications).values({ companyId: input.companyId, candidateId: input.candidateId, applicationId: input.applicationId, direction: "inbound", channel: input.channel, fromAddress: input.from ?? null, toAddress: null, subject: null, bodyText: input.text, provider: input.provider ?? null, providerMessageId: input.providerMessageId ?? null, status: "received", disclosureIncluded: false, sentBy: input.actor, ...(input.screenId ? { tags: { screenId: input.screenId } } : {}) }).returning({ id: communications.id });
  await emit(q, { type: "message.received", companyId: input.companyId, actor: input.actor, subject: { type: "communication", id: row.id }, payload: { channel: input.channel, applicationId: input.applicationId }, correlationId: input.correlationId ?? null });
  return row.id;
}
