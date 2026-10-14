import { titleMidSentence, type OfferedSlot, type RolePacket } from "@ros/contracts";
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

/**
 * A personal line on the invitation (founder decision Q28): written by the person who approved the interview, or
 * suggested by the assistant and kept by them, in which case the email says the assistant helped. Checked before it
 * gets here (`checkPersonalLine`).
 */
export type InvitationNote = { text: string; aiHelped: boolean; senderName: string };

/** The note's paragraph in the invitation, empty when there is none. */
export function invitationNoteText(note: InvitationNote | null | undefined): string {
  if (!note?.text.trim()) return "";
  const help = note.aiHelped ? ` (${note.senderName} wrote this note with help from an AI assistant.)` : "";
  return `\n\nA note from ${note.senderName}: ${note.text.trim()}${help}`;
}

/**
 * Which times email this is: the first offer for an interview, or new times for someone under Cancelled (founder
 * decisions 2A and 4A): the ones they asked for when they cancelled, or the ones the team sends (after a no-show, or to
 * someone who said they were no longer interested). The new-times openings never say why and never hint at a decision
 * (founder decision B6). Two more openings for times worked out again: `rescheduled` after the team moved the interview
 * (offered times, or a booked time they were told is off), and `other_times` after the candidate said none of the
 * offered times work. And `missed_by_us`: the first offer of the same round again after our interviewer missed the
 * last one (founder decision L-12, 15 Oct 2026), which opens with an apology.
 */
export type SlotsVariant = "first" | "new_times_asked" | "new_times_team" | "rescheduled" | "other_times" | "missed_by_us";

/**
 * The times email, written but not sent: one template and one key per interview and attempt whatever the variant, so it
 * waits for the ITS check and is withdrawn when the offer ends, as every times email is (outbox.ts).
 */
export function slotsOfferedMessage(input: InterviewMessageInput & { note?: InvitationNote | null; variant?: SlotsVariant }): { templateKey: "interview_slots"; idempotencyKey: string; subject: string; text: string } {
  const { candidate, company, packet, interview } = input;
  const who = input.interviewerFirstNames.length ? ` with ${input.interviewerFirstNames.join(" and ")}` : "";
  const format = interview.format.replace("_", " ");
  const position = packet.identity.title;
  const variant = input.variant ?? "first";
  const opening = variant === "new_times_asked"
    ? `As you asked when you cancelled, here are new times for your ${titleMidSentence(interview.title)} for the ${position} position at ${company.name}. ${interview.durationMinutes} minutes, ${format}${who}.`
    : variant === "new_times_team"
      ? `${company.name} would like to find a new time for your ${titleMidSentence(interview.title)} for the ${position} position. ${interview.durationMinutes} minutes, ${format}${who}.`
      : variant === "rescheduled"
        ? `${company.name} has new times for your ${titleMidSentence(interview.title)} for the ${position} position. ${interview.durationMinutes} minutes, ${format}${who}.`
        : variant === "other_times"
          ? `As you asked, here are other times for your ${titleMidSentence(interview.title)} for the ${position} position at ${company.name}. ${interview.durationMinutes} minutes, ${format}${who}.`
          : variant === "missed_by_us"
            ? `We are sorry: the interviewer from ${company.name} could not join your last interview for the ${position} position. Please pick a new time for your ${titleMidSentence(interview.title)}. ${interview.durationMinutes} minutes, ${format}${who}.`
            : `Good news: ${company.name} would like to interview you for the ${position} position. ${interview.title}${who}, ${interview.durationMinutes} minutes, ${format}.`;
  const subject = variant === "new_times_asked" || variant === "rescheduled" || variant === "missed_by_us" ? `New times for your interview: ${position} at ${company.name}` : variant === "new_times_team" ? `New interview times: ${position} at ${company.name}` : variant === "other_times" ? `Other times for your interview: ${position} at ${company.name}` : `Pick a time for your interview: ${position} at ${company.name}`;
  const text = `Hi ${candidate.firstName},

${opening}${invitationNoteText(input.note)}

Pick a time that works for you (times shown in ${input.candidateTimezone}; you can change the time zone on the page):
${slotsText(interview.offeredSlots, input.candidateTimezone)}

Choose here: ${scheduleUrl(input.appBaseUrl, interview)}

If none of these work, the same page lets you tell us what does.

${footer(packet, company)}`;
  return { templateKey: "interview_slots", idempotencyKey: `slots:${interview.id}:${interview.attempt}`, subject, text };
}

export async function sendSlotsOffered(q: Queryable, integrations: Integrations, input: InterviewMessageInput & { note?: InvitationNote | null; variant?: SlotsVariant }): Promise<SendResult> {
  const message = slotsOfferedMessage(input);
  return deliver(q, integrations, { ...input, channel: "email", templateKey: message.templateKey, subject: message.subject, text: message.text, idempotencyKey: message.idempotencyKey, eventOnSent: "message.sent", to: input.candidate.email });
}

export async function sendSlotsReminder(q: Queryable, integrations: Integrations, input: InterviewMessageInput): Promise<SendResult> {
  const { candidate, company, packet, interview } = input;
  const text = `Hi ${candidate.firstName},

A quick reminder: ${company.name} is holding interview times for you for the ${packet.identity.title} position. They stay open for another two days.

Choose here: ${scheduleUrl(input.appBaseUrl, interview)}

${footer(packet, company)}`;
  return deliver(q, integrations, { ...input, channel: "email", templateKey: "interview_slots_reminder", subject: `Reminder: pick a time for your interview at ${company.name}`, text, idempotencyKey: `slots_reminder:${interview.id}:${interview.attempt}`, eventOnSent: "message.sent", to: candidate.email });
}

/**
 * The interview's calendar file. One UID per interview; the sequence always grows: a booking at attempt n is 2(n-1), its
 * cancellation 2(n-1)+1, and the next booking (a later attempt) is higher again, so a calendar app takes a time moved after
 * a cancellation file as the newer one.
 */
export function interviewIcs(input: { interview: InterviewRow; company: MessageInput["company"]; packet: RolePacket; candidate: MessageInput["candidate"]; fromAddress: string; method: "REQUEST" | "CANCEL"; appBaseUrl: string }): string {
  const { interview } = input;
  const start = interview.startsAt ?? new Date().toISOString();
  const end = interview.endsAt ?? start;
  return buildIcs({
    uid: `interview-${interview.id}@identifiedtalent.com`,
    sequence: 2 * Math.max(0, interview.attempt - 1) + (input.method === "CANCEL" ? 1 : 0),
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
 * What the candidate chose when they cancelled from their schedule page (founder decision 2A), and the day their one
 * automatic set of new times comes ("Thursday, October 15"), or null when none is armed for them.
 */
export type CandidateCancelChoice = { next: "new_times" | "not_interested"; newTimesOn: string | null };
type CancelledInput = InterviewMessageInput & { byCandidate: boolean; reason?: string | null; leftProcess?: boolean; candidateChoice?: CandidateCancelChoice };

/** The one sentence the candidate's own cancellation adds about what comes next; a day is named only when one is armed. */
function choiceSentence(choice: CandidateCancelChoice): string {
  if (choice.next === "not_interested") return "We let the team know you are no longer interested. If you change your mind, reply to this email.";
  return choice.newTimesOn ? `We will email you new times on ${choice.newTimesOn}, unless the team gets in touch first.` : "You asked for new times, so someone from the team will be in touch about them.";
}

/**
 * The interview is off. Three wordings: the candidate's own cancellation ("As requested"), with one sentence on what
 * they chose next when they cancelled from their schedule page; the team's, with the reason the team gave; and
 * `leftProcess`, an interview called off because the application left the process (plan A9). That last one gives no
 * reason and promises nothing: a decision is private until a person tells the candidate (founder decision B6), but
 * someone holding a time must know not to come.
 */
export function interviewCancelledMessage(input: CancelledInput): { subject: string; text: string } {
  const { candidate, company, packet, interview } = input;
  const when = interview.startsAt ? `, ${formatInZone(interview.startsAt, input.candidateTimezone)},` : "";
  const own = `As requested, your interview (${interview.title}) at ${company.name} is cancelled.`;
  const what = input.byCandidate
    ? input.candidateChoice ? `${own} ${choiceSentence(input.candidateChoice)}` : own
    : input.leftProcess
      ? interview.startsAt ? `Your interview (${interview.title}) at ${company.name}${when} is cancelled, so there is no need to attend.` : `The interview times ${company.name} offered you for ${interview.title} are no longer available, so there is no need to pick one.`
      : `${company.name} had to cancel your interview (${interview.title})${input.reason ? `: ${input.reason}` : "."} They will be in touch about next steps.`;
  const text = `Hi ${candidate.firstName},

${what}

${footer(packet, company)}`;
  return { subject: `Cancelled: ${interview.title} at ${company.name}`, text };
}

export async function sendInterviewCancelled(q: Queryable, integrations: Integrations, input: CancelledInput): Promise<SendResult> {
  const { candidate, company, packet, interview } = input;
  const message = interviewCancelledMessage(input);
  const ics = interview.startsAt ? interviewIcs({ interview, company, packet, candidate, fromAddress: integrations.env.fromAddress, method: "CANCEL", appBaseUrl: input.appBaseUrl }) : null;
  return deliver(q, integrations, { ...input, channel: "email", templateKey: "interview_cancelled", subject: message.subject, text: message.text, idempotencyKey: `iv_cancel:${interview.id}:${interview.attempt}`, eventOnSent: "message.sent", to: candidate.email, attachments: ics ? [{ filename: "cancel.ics", contentType: "text/calendar; method=CANCEL", contentBase64: Buffer.from(ics).toString("base64") }] : undefined });
}

/**
 * The team moved a booked interview ("Offer new times" on it): the candidate is told at once, in one message, that the
 * booked time is off (with the team's reason when they gave one), with a calendar file that takes it out of their
 * calendar, and that new times follow by email. `interview` is the booked row as it was (its time and attempt).
 */
export function interviewMovedMessage(input: InterviewMessageInput & { reason?: string | null }): { subject: string; text: string } {
  const { candidate, company, packet, interview } = input;
  const when = interview.startsAt ? ` on ${formatInZone(interview.startsAt, input.candidateTimezone)}` : "";
  const why = input.reason?.trim() ? ` ${company.name} said: "${input.reason.trim()}"` : "";
  const text = `Hi ${candidate.firstName},

${company.name} needs to move your interview (${interview.title}). The booked time${when} is off, so there is no need to attend then. The attached calendar file removes it from your calendar.${why}

We will email you new times to pick from shortly.

${footer(packet, company)}`;
  return { subject: `Your interview time has changed: ${interview.title} at ${company.name}`, text };
}

export async function sendInterviewMoved(q: Queryable, integrations: Integrations, input: InterviewMessageInput & { reason?: string | null }): Promise<SendResult> {
  const { candidate, company, packet, interview } = input;
  const message = interviewMovedMessage(input);
  const ics = interview.startsAt ? interviewIcs({ interview, company, packet, candidate, fromAddress: integrations.env.fromAddress, method: "CANCEL", appBaseUrl: input.appBaseUrl }) : null;
  return deliver(q, integrations, { ...input, channel: "email", templateKey: "interview_moved", subject: message.subject, text: message.text, idempotencyKey: `iv_moved:${interview.id}:${interview.attempt}`, eventOnSent: "message.sent", to: candidate.email, attachments: ics ? [{ filename: "cancel.ics", contentType: "text/calendar; method=CANCEL", contentBase64: Buffer.from(ics).toString("base64") }] : undefined });
}
