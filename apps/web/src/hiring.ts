import type { ActionResult, ApplicationDetail, ApplicationSummary, HireFollowUp, InterviewDraft } from "./api/client";
import { todayIn } from "./publishing";
import { interviewsOffText, type ToastParts } from "./talent-actions";

/**
 * Interviews to hire (plan Wave H; founder decisions Q24, Q29), the pure parts the candidate panel, the Talent page and
 * Today share, kept free of React so they can be tested (tests/web/hiring.test.ts): the record-only "Offer made", the
 * wait for the candidate's answer, the hire sheet and what to do with the role and the other finalists, and the interview
 * approval filled in from a suggestion. The app never writes, sends or changes an offer.
 */

const pad = (n: number) => String(n).padStart(2, "0");
/** A date in the reader's own calendar as YYYY-MM-DD, the form a date field reads and writes. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "Monday, November 3": a plain day (YYYY-MM-DD) as people say it, read as that day wherever the reader is. */
export function plainDayWords(day: string): string {
  const d = new Date(`${day.slice(0, 10)}T12:00:00`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Offer made (Q29), and waiting on the candidate's answer                                                        */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * The offer's date field: today unless changed, and never a day still to come (the API refuses one). Today is the
 * company's day (the API checks against it), the reader's own until the company's time zone is known.
 */
export function offerDateBounds(timeZone: string | null, now: Date = new Date()): { max: string; initial: string } {
  const today = timeZone ? todayIn(timeZone, now) : dayKey(now);
  return { max: today, initial: today };
}

/** Said on the "Offer made" step, before anything is recorded. */
export function offerStepText(firstName: string): string {
  return `Record that you made ${firstName} an offer, outside the app. The app never writes, sends or changes an offer, and nothing is sent to ${firstName}. They move to Offer, waiting on their answer.`;
}

/** The toast after "Offer made". */
export function offerMadeToast(firstName: string): ToastParts {
  return { title: "Offer recorded.", detail: `Nothing was sent to ${firstName}. When they answer, record it on their page: they accepted, or they declined.` };
}

/** When the offer was made: the day recorded with it (the `offer.created` fact), else the day they moved to Offer. */
export function offerMadeOn(a: Pick<ApplicationDetail, "timeline" | "stageChangedAt">): string {
  const e = [...a.timeline].filter((x) => x.type === "offer.created").sort((x, y) => Date.parse(y.occurredAt) - Date.parse(x.occurredAt))[0];
  const made = typeof e?.payload.madeOn === "string" ? e.payload.madeOn : null;
  return made ?? a.stageChangedAt.slice(0, 10);
}

/** The private note recorded with the offer, if any. */
export function offerNote(a: Pick<ApplicationDetail, "timeline">): string | null {
  const e = [...a.timeline].filter((x) => x.type === "offer.created").sort((x, y) => Date.parse(y.occurredAt) - Date.parse(x.occurredAt))[0];
  return typeof e?.payload.note === "string" && e.payload.note.trim() ? e.payload.note.trim() : null;
}

const DAY = 86_400_000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "today", "yesterday", "3 days ago": how long since a plain day, in the reader's calendar. */
export function daysAgoWords(day: string, now: Date = new Date()): string {
  const then = new Date(`${day.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(then.getTime())) return "";
  const n = Math.round((startOfDay(now) - startOfDay(then)) / DAY);
  return n <= 0 ? "today" : n === 1 ? "yesterday" : `${n} days ago`;
}

/** The card while an offer waits on the candidate's answer (the "waiting on the candidate" group, plan H2). */
export function waitingOnCandidateText(a: Pick<ApplicationDetail, "timeline" | "stageChangedAt" | "candidate">, now: Date = new Date()): string {
  const made = offerMadeOn(a);
  const first = a.candidate.firstName || "the candidate";
  return `You recorded an offer made on ${plainDayWords(made)} (${daysAgoWords(made, now)}). The next move is ${first}'s. When they answer, record it here; nothing is sent to them either way.`;
}

/** The row's line for someone waiting on their answer to an offer: "Offer made: waiting on their answer 3 days". */
export function waitingOnCandidateRow(a: Pick<ApplicationSummary, "group" | "daysInStage">): string | null {
  if (a.group !== "waiting_on_candidate") return null;
  if (a.daysInStage <= 0) return "Offer made today: waiting on their answer";
  return `Offer made: waiting on their answer ${a.daysInStage} ${a.daysInStage === 1 ? "day" : "days"}`;
}

/** The toast after recording that they declined the offer (or withdrew): private, like every outcome. */
export function offerAnswerToast(answer: "declined" | "withdrew", r: Pick<ActionResult, "interviewsCancelled" | "interviewOffNotes">): ToastParts {
  const title = answer === "declined" ? "Recorded: they declined the offer." : "Recorded: they withdrew.";
  return { title, detail: `Recorded with your name. Nothing was sent to them.${interviewsOffText(r.interviewsCancelled, r.interviewOffNotes)}` };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The hire sheet (plan H1)                                                                                       */
/* ------------------------------------------------------------------------------------------------------------ */

/** The question before the hire is recorded. */
export function hireConfirmText(input: { name: string; startDate: string; offerAcceptedAt?: string }): string {
  const accepted = input.offerAcceptedAt ? `, who accepted the offer on ${plainDayWords(input.offerAcceptedAt)}` : "";
  return `Record the hire of ${input.name}${accepted}, starting ${plainDayWords(input.startDate)}? It is recorded with your name and can only be corrected by an administrator. Nothing is sent to anyone.`;
}

/** The toast after the hire is recorded. */
export function hireToast(input: { name: string; startDate: string | null }): ToastParts {
  return { title: `${input.name} is hired.`, detail: input.startDate ? `Starting ${plainDayWords(input.startDate)}. Recorded with your name; nothing was sent to anyone.` : "Recorded with your name; nothing was sent to anyone." };
}

/**
 * A start date before today (a hire recorded after they started): Today's "keep your backups warm" card is kept through
 * the start day itself and gone after it, so nothing would remind anyone. Read in the reader's own calendar.
 */
export function hireStarted(startDate: string | null | undefined, now: Date = new Date()): boolean {
  return !!startDate && startDate.slice(0, 10) < dayKey(now);
}

/**
 * What the hire sheet asks once the hire is recorded: the other people still in the running, and what to do with the
 * role: close it now and tell them (the one closing message, seen before it goes), or keep them warm until the start date.
 * When the start date has already passed (`started`), Today has no reminder to give, so leaving the role open is offered
 * plainly, without promising one.
 */
export function hireFollowUpView(hire: HireFollowUp, name: string, now: Date = new Date()): { startLine: string; backupsLine: string | null; people: HireFollowUp["backups"]["people"]; mayClose: boolean; closeWords: string | null; keepWarmWords: string | null; started: boolean } {
  const start = hire.startDate ? plainDayWords(hire.startDate) : null;
  const started = hireStarted(hire.startDate, now);
  const n = hire.backups.count;
  const backupsLine = n ? `${n === 1 ? "1 other person is" : `${n} other people are`} still in the running:` : null;
  const keepWarmWords = !n ? null
    : started ? `Leave the role open for now. Nobody is told anything. ${name} has already started, so Today will not remind you about ${n === 1 ? "them" : "the others"}; close the role from its page when you are ready.`
    : `Keep the role open and ${n === 1 ? "them" : "them all"} in mind until ${name} starts${start ? ` on ${start}` : ""}. Nobody is told anything; Today reminds you about your backups until then, in case the start falls through.`;
  return {
    startLine: !start ? `${name} is hired.` : started ? `${name} started on ${start}.` : `${name} starts on ${start}.`,
    backupsLine,
    people: hire.backups.people,
    mayClose: !!hire.closeRole,
    closeWords: hire.closeRole?.words ?? null,
    keepWarmWords,
    started,
  };
}

/** The toast after "Keep them warm" (or, once the start date has passed, "Leave it open"). */
export function keepWarmToast(name: string, startDate: string | null, now: Date = new Date()): ToastParts {
  if (hireStarted(startDate, now)) return { title: "The role stays open.", detail: "Nobody was told anything. Close the role from its page when you are ready." };
  return { title: "The role stays open.", detail: `Nobody was told anything. Today reminds you about your backups until ${name} starts${startDate ? ` on ${plainDayWords(startDate)}` : ""}.` };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The interview approval filled in from a suggestion (plan H4)                                                   */
/* ------------------------------------------------------------------------------------------------------------ */

/** The line above the filled-in interview approval: what was filled in, and that the approval is still a person's. */
export function interviewDraftLine(draft: Pick<InterviewDraft, "roundTitle" | "durationMinutes" | "interviewerUserIds" | "window" | "nextRound">): string {
  const who = draft.interviewerUserIds.length ? `${draft.interviewerUserIds.length === 1 ? "1 interviewer" : `${draft.interviewerUserIds.length} interviewers`} from the plan` : "nobody yet (choose who interviews below)";
  const from = draft.window.fromDate ? plainDayWords(draft.window.fromDate) : null;
  const to = draft.window.toDate ? plainDayWords(draft.window.toDate) : null;
  const when = from && to ? ` Times are offered between ${from} and ${to}${draft.window.businessDaysOnly ? ", on working days" : ""}.` : "";
  return `Filled in from your interview plan: the ${draft.nextRound ? "next round, " : ""}${draft.roundTitle} (${draft.durationMinutes} minutes), with ${who}.${when} Check it and approve; nothing goes to the candidate until you do.`;
}

/**
 * Where "Yes, interview" on Today leads (plan H4): the candidate's panel with the interview approval open, the round
 * filled in. Null when the answer carried no filled-in card (the interview cannot be approved now).
 */
export function interviewDraftPath(draft: Pick<InterviewDraft, "roleId" | "applicationId" | "roundKey"> | null | undefined): string | null {
  if (!draft) return null;
  return `/roles/${draft.roleId}/talent?open=${draft.applicationId}&step=interview&round=${encodeURIComponent(draft.roundKey)}`;
}
