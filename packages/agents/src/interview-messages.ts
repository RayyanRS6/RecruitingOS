import type { OfferedSlot, RolePacket } from "@ros/contracts";
import { buildIcs, disclosureLine, formatInZone, groupSlotsByDay } from "@ros/core";
import type { Queryable, interviews } from "@ros/db";
import type { Integrations, SendResult } from "@ros/integrations";
import { deliver, type MessageInput } from "./coordinator";

type InterviewRow = typeof interviews.$inferSelect;

/**
 * Candidate-facing scheduling messages (docs/03 step 12; slice 5 step 9). Templated, disclosed, idempotent per
 * interview and attempt; both time zones are spelled out; every message names the person to reach.
 */
export type InterviewMessageInput = MessageInput & {
  appBaseUrl: string;
  interview: InterviewRow;
  interviewerFirstNames: string[];
  candidateTimezone: string;
  companyTimezone: string;
};

function signature(packet: RolePacket, company: MessageInput["company"]): string {
  return packet.communication.signature || `The hiring team at ${company.name}`;
}
function footer(packet: RolePacket, company: MessageInput["company"]): string {
  return `${packet.communication.humanAlternativeText}\n\n${signature(packet, company)}\n\n${packet.communication.disclosureText || disclosureLine(company.name)}`;
}
export function scheduleUrl(appBaseUrl: string, interview: InterviewRow): string {
  return `${appBaseUrl}/c/schedule/${interview.scheduleToken}`;
}
function slotsText(slots: OfferedSlot[], tz: string): string {
  return groupSlotsByDay(slots, tz).map((g) => `${g.label}\n${g.slots.map((s) => `  - ${s.label}`).join("\n")}`).join("\n");
}

export async function sendSlotsOffered(q: Queryable, integrations: Integrations, input: InterviewMessageInput): Promise<SendResult> {
  const { candidate, company, packet, interview } = input;
  const who = input.interviewerFirstNames.length ? ` with ${input.interviewerFirstNames.join(" and ")}` : "";
  const text = `Hi ${candidate.firstName},

Good news: ${company.name} would like to interview you for the ${packet.identity.title} position. ${interview.title}${who}, ${interview.durationMinutes} minutes, ${interview.format.replace("_", " ")}.

Pick a time that works for you (times shown in ${input.candidateTimezone}; you can change the time zone on the page):
${slotsText(interview.offeredSlots, input.candidateTimezone)}

Choose here: ${scheduleUrl(input.appBaseUrl, interview)}

If none of these work, the same page lets you tell us what does.

${footer(packet, company)}`;
  return deliver(q, integrations, { ...input, channel: "email", templateKey: "interview_slots", subject: `Pick a time for your interview: ${packet.identity.title} at ${company.name}`, text, idempotencyKey: `slots:${interview.id}:${interview.attempt}`, eventOnSent: "message.sent", to: candidate.email });
}

export async function sendSlotsReminder(q: Queryable, integrations: Integrations, input: InterviewMessageInput): Promise<SendResult> {
  const { candidate, company, packet, interview } = input;
  const text = `Hi ${candidate.firstName},

A quick reminder: ${company.name} is holding interview times for you for the ${packet.identity.title} position. They stay open for another two days.

Choose here: ${scheduleUrl(input.appBaseUrl, interview)}

${footer(packet, company)}`;
  return deliver(q, integrations, { ...input, channel: "email", templateKey: "interview_slots_reminder", subject: `Reminder: pick a time for your interview at ${company.name}`, text, idempotencyKey: `slots_reminder:${interview.id}:${interview.attempt}`, eventOnSent: "message.sent", to: candidate.email });
}

export function interviewIcs(input: { interview: InterviewRow; company: MessageInput["company"]; packet: RolePacket; candidate: MessageInput["candidate"]; fromAddress: string; method: "REQUEST" | "CANCEL"; appBaseUrl: string }): string {
  const { interview } = input;
  const start = interview.startsAt ?? new Date().toISOString();
  const end = interview.endsAt ?? start;
  return buildIcs({
    uid: `interview-${interview.id}@identifiedtalent.com`,
    sequence: Math.max(0, interview.attempt - 1) + (input.method === "CANCEL" ? 1 : 0),
    method: input.method,
    start, end,
    summary: `${interview.title}: ${input.packet.identity.title} at ${input.company.name}`,
    description: `${interview.durationMinutes}-minute ${interview.format.replace("_", " ")} interview with ${input.company.name}.${interview.meetingUrl ? ` Join: ${interview.meetingUrl}` : ""} Manage: ${scheduleUrl(input.appBaseUrl, interview)}/confirmed`,
    url: interview.meetingUrl ?? null,
    organizer: { name: `${input.company.name} hiring team`, email: input.fromAddress },
    attendees: input.candidate.email ? [{ name: `${input.candidate.firstName} ${input.candidate.lastName}`, email: input.candidate.email }] : [],
    status: input.method === "CANCEL" ? "CANCELLED" : "CONFIRMED",
  });
}

export async function sendInterviewConfirmation(q: Queryable, integrations: Integrations, input: InterviewMessageInput & { roundPurpose: string }): Promise<SendResult> {
  const { candidate, company, packet, interview } = input;
  const start = interview.startsAt!;
  const both = input.candidateTimezone === input.companyTimezone ? formatInZone(start, input.candidateTimezone) : `${formatInZone(start, input.candidateTimezone)} (${formatInZone(start, input.companyTimezone)} for the team)`;
  const text = `Hi ${candidate.firstName},

You are confirmed: ${interview.title} for the ${packet.identity.title} position at ${company.name}.

When: ${both}
How long: ${interview.durationMinutes} minutes
${interview.meetingUrl ? `Join: ${interview.meetingUrl}` : `Format: ${interview.format.replace("_", " ")}; details from the team follow if anything else is needed.`}
Who: ${input.interviewerFirstNames.join(", ") || "the hiring team"}

What to prepare: ${input.roundPurpose}

A calendar invitation is attached. Need to change it? ${scheduleUrl(input.appBaseUrl, interview)}/confirmed lets you reschedule or cancel.

${footer(packet, company)}`;
  const ics = interviewIcs({ interview, company, packet, candidate, fromAddress: integrations.env.fromAddress, method: "REQUEST", appBaseUrl: input.appBaseUrl });
  return deliver(q, integrations, { ...input, channel: "email", templateKey: "interview_confirmation", subject: `Confirmed: ${interview.title} at ${company.name}, ${formatInZone(start, input.candidateTimezone)}`, text, idempotencyKey: `confirm:${interview.id}:${interview.attempt}`, eventOnSent: "message.sent", to: candidate.email, attachments: [{ filename: "interview.ics", contentType: "text/calendar; method=REQUEST", contentBase64: Buffer.from(ics).toString("base64") }] });
}

export async function sendInterviewReminder(q: Queryable, integrations: Integrations, input: InterviewMessageInput & { which: "before24h" | "before2h" }): Promise<SendResult> {
  const { candidate, company, packet, interview } = input;
  const start = interview.startsAt!;
  const text = `Hi ${candidate.firstName},

${input.which === "before24h" ? "Your interview is tomorrow." : "Your interview starts in about two hours."} ${interview.title} at ${company.name}: ${formatInZone(start, input.candidateTimezone)}.
${interview.meetingUrl ? `Join: ${interview.meetingUrl}` : ""}

Need to change it? ${scheduleUrl(input.appBaseUrl, interview)}/confirmed

${footer(packet, company)}`;
  return deliver(q, integrations, { ...input, channel: "email", templateKey: `interview_reminder_${input.which}`, subject: `${input.which === "before24h" ? "Tomorrow" : "Soon"}: ${interview.title} at ${company.name}`, text, idempotencyKey: `iv_reminder:${interview.id}:${interview.attempt}:${input.which}`, eventOnSent: "message.sent", to: candidate.email });
}

/**
 * The interview is off. Three wordings: the candidate's own cancellation ("As requested"); the team's, with the reason
 * the team gave; and `leftProcess`, an interview called off because the application left the process (plan A9). That
 * last one gives no reason and promises nothing: a decision is private until a person tells the candidate (founder
 * decision B6), but someone holding a time must know not to come.
 */
export async function sendInterviewCancelled(q: Queryable, integrations: Integrations, input: InterviewMessageInput & { byCandidate: boolean; reason?: string | null; leftProcess?: boolean }): Promise<SendResult> {
  const { candidate, company, packet, interview } = input;
  const when = interview.startsAt ? `, ${formatInZone(interview.startsAt, input.candidateTimezone)},` : "";
  const what = input.byCandidate
    ? `As requested, your interview (${interview.title}) at ${company.name} is cancelled.`
    : input.leftProcess
      ? interview.startsAt ? `Your interview (${interview.title}) at ${company.name}${when} is cancelled, so there is no need to attend.` : `The interview times ${company.name} offered you for ${interview.title} are no longer available, so there is no need to pick one.`
      : `${company.name} had to cancel your interview (${interview.title})${input.reason ? `: ${input.reason}` : "."} They will be in touch about next steps.`;
  const text = `Hi ${candidate.firstName},

${what}

${footer(packet, company)}`;
  const ics = interview.startsAt ? interviewIcs({ interview, company, packet, candidate, fromAddress: integrations.env.fromAddress, method: "CANCEL", appBaseUrl: input.appBaseUrl }) : null;
  return deliver(q, integrations, { ...input, channel: "email", templateKey: "interview_cancelled", subject: `Cancelled: ${interview.title} at ${company.name}`, text, idempotencyKey: `iv_cancel:${interview.id}:${interview.attempt}`, eventOnSent: "message.sent", to: candidate.email, attachments: ics ? [{ filename: "cancel.ics", contentType: "text/calendar; method=CANCEL", contentBase64: Buffer.from(ics).toString("base64") }] : undefined });
}
