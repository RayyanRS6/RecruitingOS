import { SCREEN_LINK_OPEN_DAYS, type Actor, type RolePacket } from "@ros/contracts";
import { ADVERSE_DECISION_LINE, DECISION_TEMPLATE, REACH_A_PERSON_LINE, closeOutNoteLine, disclosureLine, emit, hiringTeamSignature, onFileReceiptLine } from "@ros/core";
import { communications, type Queryable, type applications, type candidates, type companies, type roles } from "@ros/db";
import { mailbox, type Integrations, type SendResult } from "@ros/integrations";
import { queueCommunication } from "./outbox";

/**
 * The emails a candidate gets about their application, each templated here and never written by a model: application
 * received, the AI interview's invitation, its reminder and the note that its link closed, the decision message, and the
 * close-out note to someone past the plan's candidates per job. Every one goes through the outbox (`deliver`) and
 * carries the AI disclosure, the line about reaching a person and the signature, each in the code's own words
 * (packages/core/src/compliance.ts) and never in the words a job record stores for them, which a model wrote. No email
 * shows a score, and none says a word about a plan.
 */

type App = typeof applications.$inferSelect;
type Cand = typeof candidates.$inferSelect;
type Role = typeof roles.$inferSelect;
type Company = typeof companies.$inferSelect;

export type MessageInput = { application: App; candidate: Cand; role: Role; company: Company; packet: RolePacket; actor: Actor; correlationId?: string | null };

/** The sending address: a dedicated ITS address with the customer's hiring team as the display name; never the customer's domain. */
export function fromAddress(company: Company, integrations: Integrations): string {
  return mailbox(`${company.name} hiring team`, integrations.env.fromAddress);
}

/**
 * Where a candidate's reply lands: the address the company gives candidates when it set one (the one its job page
 * prints), otherwise the reply mailbox ITS reads (EMAIL_REPLY_TO).
 */
export function replyToFor(integrations: Integrations, company: Pick<Company, "settings">): string {
  return company.settings.hiringContact?.email ?? integrations.env.replyTo;
}

/**
 * A sentence that asks for a reply (or a text) with the keyword HUMAN. Nothing reads a reply for a keyword. No email
 * written here carries one; the AI interview's pages take one out of an assistant's message in a stored chat
 * (apps/api/src/pages/web-wording.ts), and the job builder's evaluation checks a written job for one.
 */
export const HUMAN_KEYWORD = /\b(?:[Rr]epl(?:y|ying)|[Tt]ext(?:ing)?|[Ss]end(?:ing)?)\b.*\bHUMAN\b/;

/**
 * `text` without the sentences one of `patterns` matches. `instead` takes the place of the first one (once), so a line
 * that told the candidate how to reach a person still does. Line breaks are kept.
 */
export function replaceSentences(text: string, patterns: readonly RegExp[], instead: string | null): string {
  let used = false;
  const lines = text.split("\n").map((line) =>
    line
      .split(/(?<=[.!?])\s+/)
      .flatMap((sentence) => {
        if (!patterns.some((re) => re.test(sentence.trim()))) return [sentence];
        if (instead && !used) {
          used = true;
          return [instead];
        }
        return [];
      })
      .join(" ")
      .trimEnd(),
  );
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * The lines under every email: how to reach a person, who it is from, and the AI disclosure. All three are the code's
 * own (`REACH_A_PERSON_LINE`, `hiringTeamSignature`, `disclosureLine`), the same for every job and every company. A job
 * record's own `communication` lines are never sent: a model wrote them when it wrote the job, and nobody was shown
 * them first. A reply lands with a person either way (`replyToFor`).
 */
function footer(company: Company): string {
  return `${REACH_A_PERSON_LINE}\n\n${hiringTeamSignature(company.name)}\n\n${disclosureLine(company.name)}`;
}

/** The address already belonged to someone on the company's records: the email says it was sent using it. */
const KNOWN_ADDRESS_LINE = "This application was sent using your email address. If you did not send it, reply to this email and a person will look into it.";

/**
 * What happens after applying, in the same words on the job page, the receipt and the "application received" email: the
 * team reviews, an AI interview comes by email only to someone the team shortlists, and people decide.
 */
export function afterApplyingSteps(companyName: string): string[] {
  return [
    `The hiring team at ${companyName} reviews your application.`,
    "If you are shortlisted, we email you a link to a short AI interview: a written chat you do at a time that suits you.",
    "The team decides. People on the hiring team make every decision.",
  ];
}

/**
 * Application received: the one email every applicant gets on applying, with their status link and what happens next
 * (`afterApplyingSteps`). `onFileByDay`: the applicant is past the plan's candidates per job, and reads the on-file
 * wording with the day they hear by at the latest (DRAFT WORDING PENDING COUNSEL, packages/core/src/candidate-lock.ts);
 * never a word about a plan. It never carries an AI interview link.
 */
export async function sendAcknowledgment(q: Queryable, integrations: Integrations, input: MessageInput & { appBaseUrl: string; onFileByDay?: string | null; knownAddress?: boolean }): Promise<SendResult> {
  const { application, candidate, company, packet } = input;
  const statusUrl = `${input.appBaseUrl}/c/status/${application.statusToken}`;
  const title = packet.identity.title;
  const known = input.knownAddress ? `\n\n${KNOWN_ADDRESS_LINE}` : "";
  const body = input.onFileByDay
    ? `Thank you for applying for the ${title} position at ${company.name}. We received your application.${known}

${onFileReceiptLine(company.name, input.onFileByDay)} People make every decision.

You can check where things stand any time, withdraw, or ask about your information: ${statusUrl}`
    : `Thank you for applying for the ${title} position at ${company.name}. We have your application.${known}

What happens next:
${afterApplyingSteps(company.name).map((step, i) => `${i + 1}. ${step}`).join("\n")}

You can check where things stand at any time: ${statusUrl}`;
  return deliver(q, integrations, {
    ...input,
    templateKey: "acknowledgment",
    subject: `Thank you for applying: ${title} at ${company.name}`,
    text: `Hi ${candidate.firstName},\n\n${body}\n\n${footer(company)}`,
    idempotencyKey: `ack:${application.id}`,
    to: candidate.email,
  });
}

/**
 * The decision message for someone marked Not selected: one standard wording, ours and never the AI's, with no reason
 * given. A decision is private until a person sends this. Below the signature: how to reach a person, Colorado's line
 * about asking for the reasons when it applies (`adverseDecisionLine`), and the AI disclosure. The signature and the two
 * lines are the code's own, as under every email (`footer`); of the job record only its title is read. Pure, so the
 * preview shows exactly what will go.
 */
export function decisionMessage(input: Pick<MessageInput, "candidate" | "company" | "packet"> & { adverseDecisionLine: boolean }): { subject: string; text: string } {
  const { candidate, company, packet } = input;
  const below = [REACH_A_PERSON_LINE, input.adverseDecisionLine ? ADVERSE_DECISION_LINE.text : null, disclosureLine(company.name)].filter((x): x is string => !!x);
  const text = `Hi ${candidate.firstName},

Thank you for your interest in the ${packet.identity.title} position at ${company.name}.

After reviewing your background against what this role needs, the team has decided not to move forward at this time.

${hiringTeamSignature(company.name)}

${below.join("\n\n")}`;
  return { subject: `Your application to ${company.name}`, text };
}

/**
 * Queues the decision message. One per decision: the key carries when the decision was made, so a second Send for the
 * same decision finds the first message, while a later decision (after an Undo) gets a message of its own. `attempt`
 * counts earlier messages for this decision that did not reach them (could not be delivered, or were taken back):
 * sending again is a new message. `sendAt` holds the Send for the short time "Don't send" can take it back.
 */
export async function sendDecisionMessage(q: Queryable, integrations: Integrations, input: MessageInput & { attempt: number; adverseDecisionLine: boolean; sendAt: Date | null }): Promise<SendResult> {
  const { application, candidate } = input;
  const message = decisionMessage(input);
  return deliver(q, integrations, {
    ...input,
    templateKey: DECISION_TEMPLATE,
    subject: message.subject,
    text: message.text,
    idempotencyKey: `${DECISION_TEMPLATE}:${application.id}:${application.rejectedAt ?? application.stageChangedAt}${input.attempt ? `:${input.attempt}` : ""}`,
    to: candidate.email,
    // Colorado's line is recorded on the message, so a reply asking for the reasons can be traced to it.
    tags: input.adverseDecisionLine ? { adverseDecisionLine: ADVERSE_DECISION_LINE.version } : {},
    sendAt: input.sendAt,
  });
}

/**
 * Every candidate email goes through the outbox: recorded as queued inside the caller's transaction, sent by the worker
 * after commit, once per idempotency key. The result is therefore `pending` at this point; `message.sent` follows.
 */
export async function deliver(q: Queryable, integrations: Integrations, input: MessageInput & { templateKey: string; subject: string; text: string; idempotencyKey: string; to: string | null; tags?: Record<string, string>; sendAt?: Date | null }): Promise<SendResult> {
  const { application, candidate, company } = input;
  if (!input.to) {
    const [row] = await q.insert(communications).values({ companyId: company.id, candidateId: candidate.id, applicationId: application.id, direction: "outbound", channel: "email", fromAddress: fromAddress(company, integrations), toAddress: null, subject: input.subject, bodyText: input.text, templateKey: input.templateKey, provider: integrations.email.id, status: "failed", disclosureIncluded: true, sentBy: input.actor, error: "candidate has no email address" }).returning({ id: communications.id });
    await emit(q, { type: "message.failed", companyId: company.id, actor: input.actor, subject: { type: "communication", id: row.id }, payload: { template: input.templateKey, error: "no email" }, correlationId: input.correlationId ?? null });
    return { status: "failed", error: "candidate has no email address", retryable: false };
  }
  return queueCommunication(q, integrations, {
    channel: "email",
    companyId: company.id,
    candidateId: candidate.id,
    applicationId: application.id,
    to: input.to,
    from: fromAddress(company, integrations),
    replyTo: replyToFor(integrations, company),
    subject: input.subject,
    text: input.text,
    templateKey: input.templateKey,
    idempotencyKey: input.idempotencyKey,
    tags: { ...(input.tags ?? {}), template: input.templateKey, applicationId: application.id },
    actor: input.actor,
    correlationId: input.correlationId ?? null,
    disclosureIncluded: true,
    sendAt: input.sendAt ?? null,
  });
}

/** What the AI interview's emails need beyond MessageInput: the interview they are about. */
export type ScreenMessageInput = MessageInput & { appBaseUrl: string; screen: { id: string; token: string } };

function screenUrl(input: ScreenMessageInput): string {
  return `${input.appBaseUrl}/c/screen/${input.screen.token}`;
}

/**
 * The AI interview's invitation, sent when a person on the team shortlists someone, and again with a new link by "Send a
 * new link". It gives minutes, not a number of questions: the chat fixes its plan when it starts. One per interview.
 */
export async function sendScreenInvite(q: Queryable, integrations: Integrations, input: ScreenMessageInput): Promise<SendResult> {
  const { candidate, company, packet } = input;
  const text = `Hi ${candidate.firstName},

The hiring team at ${company.name} has reviewed your application for the ${packet.identity.title} position and would like you to take the next step: a short interview with ${company.name}'s AI assistant. It is a written chat of about ${packet.screening.maxMinutes} minutes, at whatever time suits you.

Start your AI interview: ${screenUrl(input)}

How it works:
- The assistant asks one question at a time about your experience and this job, and you answer in your own words.
- You can skip any question.
- If you stop part-way, your answers are saved: use the same link to carry on.
- At the end you check your answers and press "Send my answers". Nothing goes to the hiring team before you do.
- The link stays open for ${SCREEN_LINK_OPEN_DAYS} days, and we send you one reminder.

Prefer a person? Choose "I'd rather talk to a person" on the interview page, or reply to this email.
If you need an adjustment, such as more time or another format, reply and tell us.
People on the hiring team make every decision.

${footer(company)}`;
  return deliver(q, integrations, { ...input, templateKey: "screen_invite", subject: `Your next step: a short AI interview for ${packet.identity.title}`, text, idempotencyKey: `screen_invite:${input.screen.id}`, to: candidate.email });
}

/**
 * The reminder about an AI interview whose link is still open: the one that goes by itself after 48 hours, and a person's
 * "Send a reminder" (`sendKey`: a key of its own, so it is a message of its own).
 */
export async function sendScreenReminder(q: Queryable, integrations: Integrations, input: ScreenMessageInput & { sendKey?: string }): Promise<SendResult> {
  const { candidate, company, packet } = input;
  const text = `Hi ${candidate.firstName},

A quick reminder: your short AI interview for the ${packet.identity.title} position at ${company.name} is waiting for you whenever you have ${packet.screening.maxMinutes} minutes: ${screenUrl(input)}

If you started it, your answers are saved, and nothing goes to the hiring team until you press "Send my answers". Prefer a person? Choose "I'd rather talk to a person" on the interview page, or reply to this email.

${footer(company)}`;
  return deliver(q, integrations, { ...input, templateKey: "screen_reminder", subject: `Reminder: your AI interview for ${packet.identity.title}`, text, idempotencyKey: input.sendKey ?? `screen_reminder:${input.screen.id}`, to: candidate.email });
}

/** The AI interview's link closed after its five days, started or not: one short note, so it never closes in silence. One per interview. */
export async function sendScreenExpiredNote(q: Queryable, integrations: Integrations, input: MessageInput & { screen: { id: string } }): Promise<SendResult> {
  const { candidate, company, packet } = input;
  const text = `Hi ${candidate.firstName},

The link to your short AI interview for the ${packet.identity.title} position at ${company.name} has now closed. Anything you had not sent was not shared with the hiring team. Your application is still with the team, and people on the team make every decision.

If you would still like to do the interview, reply to this email and someone on the team can send you a new link.

${footer(company)}`;
  return deliver(q, integrations, { ...input, templateKey: "screen_expired", subject: `Your AI interview link for ${packet.identity.title} has closed`, text, idempotencyKey: `screen_expired:${input.screen.id}`, to: candidate.email });
}

/**
 * The close-out note: what someone past the plan's candidates per job hears when the job is still open at the latest
 * date they were promised. It is no decline and moves no stage, and it says nothing about a plan. Its wording is DRAFT
 * WORDING PENDING COUNSEL (packages/core/src/candidate-lock.ts). Once per application.
 */
export const CLOSE_OUT_TEMPLATE = "close_out";

export async function sendCloseOutNote(q: Queryable, integrations: Integrations, input: MessageInput & { statusUrl: string }): Promise<SendResult> {
  const { application, candidate, company, packet } = input;
  const text = `Hi ${candidate.firstName},

${closeOutNoteLine({ roleTitle: packet.identity.title, companyName: company.name, statusUrl: input.statusUrl })}

${footer(company)}`;
  return deliver(q, integrations, { ...input, templateKey: CLOSE_OUT_TEMPLATE, subject: `Your application: ${packet.identity.title} at ${company.name}`, text, idempotencyKey: `close_out:${application.id}`, to: candidate.email });
}
