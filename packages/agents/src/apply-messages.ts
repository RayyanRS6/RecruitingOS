import { disclosureLine } from "@ros/core";
import type { Integrations, SendResult } from "@ros/integrations";
import type { Queryable } from "@ros/db";
import { deliver, reminderClosingLine, type MessageInput } from "./coordinator";

/**
 * The emails of the conversation offered with the application (plan Wave E). Templated, never written by the model,
 * sent to the address the company has on file, and queued through the outbox like every candidate email (so they wait
 * for the ITS company check like the rest, founder decision B7). One per screen and purpose, by idempotency key.
 */

export type ConversationLinkInput = MessageInput & { appBaseUrl: string; screen: { id: string; token: string }; questions: number; minutes: number };

function conversationUrl(input: { appBaseUrl: string; screen: { token: string } }): string {
  return `${input.appBaseUrl}/c/screen/${input.screen.token}`;
}

function signOff(input: MessageInput): string {
  const { packet, company } = input;
  return `${packet.communication.humanAlternativeText}

${packet.communication.signature || `The hiring team at ${company.name}`}

${packet.communication.disclosureText || disclosureLine(company.name)}`;
}

/** "Do this later": the link to come back to, whenever suits them. Their place is kept. */
export async function sendConversationForLater(q: Queryable, integrations: Integrations, input: ConversationLinkInput): Promise<SendResult> {
  const { candidate, company, packet } = input;
  const text = `Hi ${candidate.firstName},

Here is the link to the short screening conversation for the ${packet.identity.title} position at ${company.name}: ${input.questions} questions, about ${input.minutes} minutes. Answer whenever it suits you; the page keeps your place if you stop part-way.

${conversationUrl(input)}

${signOff(input)}`;
  return deliver(q, integrations, { ...input, channel: "email", templateKey: "screen_later", subject: `Your screening conversation for ${packet.identity.title}, for when you are ready`, text, idempotencyKey: `screen_later:${input.screen.id}`, eventOnSent: "message.sent", to: candidate.email });
}

/** Started and stopped part-way (E4): one reminder, with their answers kept. */
export async function sendConversationIdleReminder(q: Queryable, integrations: Integrations, input: ConversationLinkInput): Promise<SendResult> {
  const { candidate, company, packet } = input;
  const text = `Hi ${candidate.firstName},

You started the screening conversation for the ${packet.identity.title} position at ${company.name} and stopped part-way. Your answers so far are saved. You can pick up where you left off:

${conversationUrl(input)}

If you would rather not finish it, you do not need to do anything: in a couple of days we will pass on what you have told us so far, and your application carries on.

${signOff(input)}`;
  return deliver(q, integrations, { ...input, channel: "email", templateKey: "screen_idle_reminder", subject: `Pick up your screening conversation for ${packet.identity.title}`, text, idempotencyKey: `screen_idle_reminder:${input.screen.id}`, eventOnSent: "message.sent", to: candidate.email });
}

/** Closed part-way after the reminder (E4): a short note that nothing else is needed. */
export async function sendConversationUnfinishedNote(q: Queryable, integrations: Integrations, input: MessageInput & { screen: { id: string } }): Promise<SendResult> {
  const { candidate, company, packet } = input;
  const text = `Hi ${candidate.firstName},

We have passed what you told us in the screening conversation for the ${packet.identity.title} position to the hiring team at ${company.name}, and closed the conversation. Nothing else is needed from you. People on the team review your application and decide on next steps; you will hear from them either way.

If you would like to add something, reply to this email.

${signOff(input)}`;
  return deliver(q, integrations, { ...input, channel: "email", templateKey: "screen_unfinished", subject: `Your application for ${packet.identity.title}`, text, idempotencyKey: `screen_unfinished:${input.screen.id}`, eventOnSent: "message.sent", to: candidate.email });
}

/**
 * Every question answered, but "Send" not pressed (E10, E4): one reminder to check the answers and send them, and the
 * day they go to the team as they are if nothing happens (`sendOn`, in the company's time zone).
 */
export async function sendConversationReviewReminder(q: Queryable, integrations: Integrations, input: ConversationLinkInput & { sendOn: string }): Promise<SendResult> {
  const { candidate, company, packet } = input;
  const text = `Hi ${candidate.firstName},

You answered every question in the screening conversation for the ${packet.identity.title} position at ${company.name}, but you have not pressed Send yet. You can check them, change any of them, and press Send here:

${conversationUrl(input)}

If you do nothing, we will send your answers to the hiring team as they are on ${input.sendOn}, so your application is not held up.

${signOff(input)}`;
  return deliver(q, integrations, { ...input, channel: "email", templateKey: "screen_review_reminder", subject: `Your answers for ${packet.identity.title} are ready to send`, text, idempotencyKey: `screen_review_reminder:${input.screen.id}`, eventOnSent: "message.sent", to: candidate.email });
}

/**
 * The conversation that goes with the application, not started two days on (E4): one reminder. Nothing is lost by
 * leaving it: the application goes to the team without it a few days later.
 */
export async function sendConversationNotStartedReminder(q: Queryable, integrations: Integrations, input: ConversationLinkInput): Promise<SendResult> {
  const { candidate, company, packet } = input;
  const text = `Hi ${candidate.firstName},

Thanks for applying for the ${packet.identity.title} position at ${company.name}. The short written conversation that goes with your application is still waiting for you: ${input.questions} questions, about ${input.minutes} minutes, whenever it suits you:

${conversationUrl(input)}

If you would rather not do it, you do not need to do anything: in a few days your application goes to the hiring team without it. From that page you can also send it now without the conversation, or ask for a person instead.

${signOff(input)}`;
  return deliver(q, integrations, { ...input, channel: "email", templateKey: "screen_not_started_reminder", subject: `Your application for ${packet.identity.title}: the short conversation is still open`, text, idempotencyKey: `screen_not_started_reminder:${input.screen.id}`, eventOnSent: "message.sent", to: candidate.email });
}

/** Never started, and the link has lapsed (E4): the application has gone to the team without it, and that is fine. */
export async function sendConversationNotStartedNote(q: Queryable, integrations: Integrations, input: MessageInput & { screen: { id: string } }): Promise<SendResult> {
  const { candidate, company, packet } = input;
  const text = `Hi ${candidate.firstName},

Your application for the ${packet.identity.title} position at ${company.name} has gone to the hiring team without the short written conversation. That is fine, and nothing else is needed from you. People on the team review your application and decide on next steps; you will hear from them either way.

If you would like to add something, reply to this email.

${signOff(input)}`;
  return deliver(q, integrations, { ...input, channel: "email", templateKey: "screen_not_started", subject: `Your application for ${packet.identity.title}`, text, idempotencyKey: `screen_not_started:${input.screen.id}`, eventOnSent: "message.sent", to: candidate.email });
}

/**
 * The link we said we would email once the plan's screening conversations were topped up (Q17) never went: they stayed
 * used up for the whole wait. The candidate is told the conversation is not going ahead, that it costs them nothing,
 * and that their application is with the team as it is (no silent lapse, plan G10). No screen exists, so one per
 * application.
 */
export async function sendConversationNotOfferedNote(q: Queryable, integrations: Integrations, input: MessageInput): Promise<SendResult> {
  const { candidate, company, packet, application } = input;
  const text = `Hi ${candidate.firstName},

We said we would email you a link to a short written conversation for the ${packet.identity.title} position at ${company.name}. That conversation is not going ahead, and you do not need to do anything about it. Your application is with the hiring team as it is, and nothing else is needed from you. People on the team review it and decide on next steps; you will hear from them either way.

If you would like to add something, reply to this email.

${signOff(input)}`;
  return deliver(q, integrations, { ...input, channel: "email", templateKey: "screen_not_offered", subject: `Your application for ${packet.identity.title}`, text, idempotencyKey: `screen_not_offered:${application.id}`, eventOnSent: "message.sent", to: candidate.email });
}

/**
 * After an outage (E5) a person took the conversation over: the assistant was still not working after a day, or its
 * first answer once it worked again was to hand over. `expectation` says when ("within four business hours (...)").
 */
export async function sendConversationHandedOver(q: Queryable, integrations: Integrations, input: MessageInput & { screen: { id: string }; expectation: string }): Promise<SendResult> {
  const { candidate, company, packet } = input;
  const text = `Hi ${candidate.firstName},

Sorry about the trouble with the screening conversation for the ${packet.identity.title} position at ${company.name}. We have passed your application and your answers so far to a person working with the hiring team, who will contact you ${input.expectation}. Nothing else is needed from you.

${packet.communication.signature || `The hiring team at ${company.name}`}

${packet.communication.disclosureText || disclosureLine(company.name)}`;
  return deliver(q, integrations, { ...input, channel: "email", templateKey: "screen_handed_over", subject: `A person will contact you about ${packet.identity.title}`, text, idempotencyKey: `screen_handed_over:${input.screen.id}`, eventOnSent: "message.sent", to: candidate.email });
}

/** The assistant is working again after an outage (E5): pick up where they stopped. One per pause. */
export async function sendConversationResume(q: Queryable, integrations: Integrations, input: ConversationLinkInput & { pausedAt: string }): Promise<SendResult> {
  const { candidate, company, packet } = input;
  const text = `Hi ${candidate.firstName},

Sorry about the trouble earlier with the screening conversation for the ${packet.identity.title} position at ${company.name}. It is working again, and your answers so far are saved. You can finish whenever it suits you:

${conversationUrl(input)}

${reminderClosingLine(candidate)}

${signOff(input)}`;
  return deliver(q, integrations, { ...input, channel: "email", templateKey: "screen_resume", subject: `You can finish your screening conversation for ${packet.identity.title} now`, text, idempotencyKey: `screen_resume:${input.screen.id}:${input.pausedAt}`, eventOnSent: "message.sent", to: candidate.email });
}

/** What the emails about a repeat submission's conversation say at the end: nothing is added without the address owner. */
function repeatFooter(input: MessageInput): string {
  const { company, packet } = input;
  return `Nothing is added to your application unless you confirm it at the end. If it was not you, you do not need to do anything: nothing is added, and anything typed is deleted after seven days.

${packet.communication.signature || `The hiring team at ${company.name}`}

${packet.communication.disclosureText || disclosureLine(company.name)}`;
}

/**
 * "Do this later" in a repeat submission's conversation (Q14 x Q15): the link goes to the address on file, worded for
 * what it is, someone using that address applied again, never as if the owner of the address had asked for it.
 */
export async function sendRepeatConversationLater(q: Queryable, integrations: Integrations, input: ConversationLinkInput & { unconfirmedId: string; on: string }): Promise<SendResult> {
  const { candidate, company, packet } = input;
  const text = `Hi ${candidate.firstName},

You already have an application for the ${packet.identity.title} position at ${company.name}. On ${input.on}, someone using this email address applied again and chose to answer the screening questions later. Nothing has been changed.

If that was you, here is the link to the questions:
${conversationUrl(input)}

${repeatFooter(input)}`;
  return deliver(q, integrations, { ...input, channel: "email", templateKey: "screen_repeat_later", subject: `Please check: an application for ${packet.identity.title}`, text, idempotencyKey: `screen_repeat_later:${input.unconfirmedId}`, eventOnSent: "message.sent", to: candidate.email });
}

/** A repeat submission's conversation works again after an outage (E5), worded like `sendRepeatConversationLater`. */
export async function sendRepeatConversationResume(q: Queryable, integrations: Integrations, input: ConversationLinkInput & { unconfirmedId: string; on: string; pausedAt: string }): Promise<SendResult> {
  const { candidate, company, packet } = input;
  const text = `Hi ${candidate.firstName},

You already have an application for the ${packet.identity.title} position at ${company.name}. On ${input.on}, someone using this email address applied again and started the screening questions, but our assistant stopped working part-way. It is working again. Nothing has been changed.

If that was you, you can finish here:
${conversationUrl(input)}

${repeatFooter(input)}`;
  return deliver(q, integrations, { ...input, channel: "email", templateKey: "screen_repeat_resume", subject: `Please check: an application for ${packet.identity.title}`, text, idempotencyKey: `screen_repeat_resume:${input.unconfirmedId}:${input.pausedAt}`, eventOnSent: "message.sent", to: candidate.email });
}

/**
 * A repeat submission's conversation ended (Q14 x Q15). The address on file is asked to confirm before anything is
 * added to their application: their answers, or a request for a person (`link` opens a page with one button; opening
 * the link alone changes nothing). `outage`: the assistant stopped working for a day part-way, so a person is offered
 * instead; nobody asked for one. A withdrawal is never confirmed from here: `link` is then their own status page, where
 * withdrawing is one click. Ignored, what was typed is wiped after seven days.
 */
export async function sendRepeatConfirmation(q: Queryable, integrations: Integrations, input: MessageInput & { unconfirmedId: string; link: string; intent: "answers" | "person" | "withdraw" | "outage"; on: string }): Promise<SendResult> {
  const { candidate, company, packet } = input;
  const what = input.intent === "withdraw"
    ? "someone using this email address asked to withdraw your application while answering the screening questions"
    : input.intent === "person"
      ? "someone using this email address asked for a person from the hiring team to contact them about your application"
      : input.intent === "outage"
        ? "someone using this email address started the screening questions for it, but our assistant stopped working before they finished"
        : "someone using this email address answered the screening questions for it";
  const confirm = input.intent === "withdraw" ? "If that was you and you want to withdraw, you can do it in one click on your status page:" : input.intent === "person" ? "If that was you, confirm here and a person will be in touch:" : input.intent === "outage" ? "If that was you, confirm here and a person from the hiring team will contact you to finish it:" : "If that was you, confirm here to add those answers to your application:";
  const text = `Hi ${candidate.firstName},

You already have an application for the ${packet.identity.title} position at ${company.name}. On ${input.on}, ${what}. Nothing has been changed.

${confirm}
${input.link}

If it was not you, you do not need to do anything: nothing is added, and what was typed is deleted after seven days.

${packet.communication.signature || `The hiring team at ${company.name}`}

${packet.communication.disclosureText || disclosureLine(company.name)}`;
  return deliver(q, integrations, { ...input, channel: "email", templateKey: "screen_repeat_confirm", subject: `Please confirm: your application for ${packet.identity.title}`, text, idempotencyKey: `screen_repeat_confirm:${input.unconfirmedId}`, eventOnSent: "message.sent", to: candidate.email });
}
