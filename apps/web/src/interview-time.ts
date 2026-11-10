import type { SetInterviewTime } from "@ros/contracts";
import type { Tone } from "@ros/ui";
import type { CandidateEmailState } from "./api/client";
import type { CompanyCheck } from "./company-check";

/**
 * Setting an interview's date and time (the owner's words, 6 November 2026: "nadine sets date and time from the shortlisted
 * candidates and he/she will get the mail"), the pure parts, so tests/web/interview-time.test.ts can check them: the form's
 * choices and what it sends, the line that says the time back, and the one word every screen uses for where an interview
 * stands. The time is always the company's, said by name, never the browser's: the API reads the date and time on the
 * company's clock (`SetInterviewTime`).
 */

/** How long, on the form. The round's own length is added when it is not one of these, and chosen first. */
export const DURATION_CHOICES: readonly number[] = [15, 30, 45, 60, 90, 120];

/** The lengths offered for a round: the usual ones, with the round's own among them, shortest first. */
export function durationChoices(roundMinutes: number | null | undefined): number[] {
  const own = typeof roundMinutes === "number" && Number.isInteger(roundMinutes) && roundMinutes >= 15 && roundMinutes <= 240 ? roundMinutes : null;
  return [...new Set([...DURATION_CHOICES, ...(own ? [own] : [])])].sort((a, b) => a - b);
}

/** The length chosen when the form opens: the round's own, else 30 minutes. */
export function defaultDuration(roundMinutes: number | null | undefined): number {
  return durationChoices(roundMinutes).includes(roundMinutes ?? -1) ? (roundMinutes as number) : 30;
}

/** "30 minutes", "1 hour", "90 minutes", "2 hours". */
export function durationWords(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`;
  return `${minutes} minutes`;
}

/** Where it takes place: a video link, an address, or by phone. */
export type PlaceKind = "link" | "address" | "phone";
export const PLACE_LABEL: Record<PlaceKind, string> = { link: "Video link", address: "Address", phone: "By phone" };

/** The place a round's format suggests: a video round a link, a phone round by phone, anything in person an address. */
export function placeKindFor(format: string | null | undefined): PlaceKind {
  if (format === "video") return "link";
  if (format === "phone") return "phone";
  return "address";
}

/** How a video link is made: with a live calendar's event, or pasted by the person. */
export type LinkChoice = "calendar" | "pasted";

/**
 * The meeting link (decision D3). The calendar makes the link only when an interviewer has a connected, working calendar:
 * the event it books carries the video link. With none (the development stand-in, or nobody connected), "Create it with
 * the calendar event" would record no link at all, so it is not offered: the box for a link is shown instead, and left
 * empty the invitation names the format and the team gives any details. `picked` is what the person chose in the menu
 * when it is offered; typing a link first counts as choosing to paste one. `ready` is false while a link that is needed
 * is missing; `body` is what the old path ("Or let them pick from your free times") sends.
 */
export function meetingLinkFor(input: { calendarLive: boolean; picked: LinkChoice | null; url: string }): { offerCalendar: boolean; mode: LinkChoice; urlRequired: boolean; ready: boolean; body: { linkSource: LinkChoice; meetingUrl?: string } } {
  const url = input.url.trim();
  if (!input.calendarLive) return { offerCalendar: false, mode: "pasted", urlRequired: false, ready: true, body: url ? { linkSource: "pasted", meetingUrl: url } : { linkSource: "calendar" } };
  const mode = input.picked ?? (url ? "pasted" : "calendar");
  if (mode === "calendar") return { offerCalendar: true, mode, urlRequired: false, ready: true, body: { linkSource: "calendar" } };
  return { offerCalendar: true, mode, urlRequired: true, ready: !!url, body: url ? { linkSource: "pasted", meetingUrl: url } : { linkSource: "pasted" } };
}

/**
 * What the person filled in. `url` is the link typed, `linkPicked` the calendar menu's choice when a live calendar is
 * there to make one (`meetingLinkFor`); `reason` is said to the candidate when a booked time moves.
 */
export type SetTimeForm = { date: string; time: string; durationMinutes: number; place: PlaceKind; url: string; linkPicked?: LinkChoice | null; address: string; reason?: string };

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A date and a time as typed, read as a wall clock (never moved into the browser's zone); null when either is not real. */
function wallClock(date: string, time: string): Date | null {
  const d = DAY.exec(date);
  const t = CLOCK.exec(time);
  if (!d || !t) return null;
  const at = new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2])));
  return at.getUTCFullYear() === Number(d[1]) && at.getUTCMonth() === Number(d[2]) - 1 && at.getUTCDate() === Number(d[3]) ? at : null;
}

/** Newer ICU writes a narrow no-break space before AM and PM; the screens and their tests read a plain one. */
const plain = (s: string) => s.replace(/[  ]/g, " ");

/** The company's calendar day now, as the date field takes it (YYYY-MM-DD). */
export function todayIn(timeZone: string | null | undefined, now: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timeZone ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * The time said back, as the person typed it, with the company's zone by name: "Tuesday, November 10 at 2:00 PM,
 * America/Chicago". The year only when it is not this year's. Null until both a real date and a time are chosen.
 */
export function whenLine(date: string, time: string, timeZone: string | null | undefined, now: Date = new Date()): string | null {
  const at = wallClock(date, time);
  if (!at) return null;
  const sameYear = date.slice(0, 4) === todayIn(timeZone, now).slice(0, 4);
  const day = at.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
  const clock = at.toLocaleTimeString("en-US", { timeZone: "UTC", hour: "numeric", minute: "2-digit" });
  return plain(`${day} at ${clock}${timeZone ? `, ${timeZone}` : ""}`);
}

/** The time field's label: the zone it is read in, by name. */
export function timeLabel(timeZone: string | null | undefined): string {
  return timeZone ? `Time (${timeZone})` : "Time (your company's time zone)";
}

/** A meeting link the API takes: http or https, with a host. */
export function linkLooksRight(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return (u.protocol === "https:" || u.protocol === "http:") && !!u.hostname;
  } catch {
    return false;
  }
}

/** The link the form sends: the one typed, unless a live calendar was chosen to make it. */
function linkOf(form: SetTimeForm, calendarLive: boolean): string {
  return meetingLinkFor({ calendarLive, picked: form.linkPicked ?? null, url: form.url }).mode === "calendar" ? "" : form.url.trim();
}

/** The field a press on a greyed "Book" takes the keyboard to, with the words beside the button. */
export type MissingField = { field: "interviewers" | "date" | "time" | "address" | "url"; text: string };

/**
 * Why "Book" cannot go yet, in the words beside it, or null when it can: the first thing missing, in the order the form
 * reads: who interviews (when the form asks), the day and time, the place. The button is never greyed without them.
 * `teamLoading`: the team is still being read, so nobody can be ticked yet. Said last, after what the person must do, and
 * never "Tick who will interview." (a press in that moment said so, to someone who had nothing to tick: found by the
 * whole-flow walks, 10 November 2026).
 */
export function setTimeMissing(form: SetTimeForm, input: { interviewers?: number; teamLoading?: boolean; timeZone?: string | null; calendarLive?: boolean; now?: Date } = {}): MissingField | null {
  if (input.interviewers === 0) return { field: "interviewers", text: "Tick who will interview." };
  if (!form.date && !form.time) return { field: "date", text: "Choose a date and a time." };
  if (!wallClock(form.date, "00:00")) return { field: "date", text: "Choose a date." };
  if (!CLOCK.test(form.time)) return { field: "time", text: "Choose a time." };
  if (form.date < todayIn(input.timeZone, input.now)) return { field: "date", text: "That day has passed. Choose a later one." };
  if (form.place === "address" && form.address.trim().length < 3) return { field: "address", text: "Type the address." };
  if (form.place === "link") {
    const link = meetingLinkFor({ calendarLive: !!input.calendarLive, picked: form.linkPicked ?? null, url: form.url });
    if (!link.ready) return { field: "url", text: "Paste the meeting link." };
    const url = linkOf(form, !!input.calendarLive);
    if (url && !linkLooksRight(url)) return { field: "url", text: "The link must start with https://" };
  }
  if (input.teamLoading) return { field: "interviewers", text: "Loading who interviews…" };
  return null;
}

/** What the form sends (POST /interviews/:id/set-time, or `setTime` on a new interview). */
export function setTimeBody(form: SetTimeForm, opts: { allowClash?: boolean; calendarLive?: boolean } = {}): SetInterviewTime {
  const url = linkOf(form, !!opts.calendarLive);
  const place: SetInterviewTime["place"] = form.place === "link" ? (url ? { kind: "link", url } : { kind: "link" }) : form.place === "address" ? { kind: "address", text: form.address.trim() } : { kind: "phone" };
  const reason = form.reason?.trim();
  return { date: form.date, time: form.time, durationMinutes: form.durationMinutes, place, ...(reason ? { reason } : {}), ...(opts.allowClash ? { allowClash: true } : {}) };
}

/** A fresh form for a round: nothing chosen for the day and time, the round's length, the place its format suggests. */
export function freshForm(round: { durationMinutes?: number | null; format?: string | null } | null | undefined): SetTimeForm {
  return { date: "", time: "", durationMinutes: defaultDuration(round?.durationMinutes), place: placeKindFor(round?.format), url: "", linkPicked: null, address: "", reason: "" };
}

/** A booked interview's form, for "Move it": its day and time on the company's clock, its length and its place. */
export function formFromBooked(i: { startsAt: string | null; durationMinutes?: number | null; format?: string | null; meetingUrl?: string | null; linkSource?: string | null; selectedSlot?: { address?: string } | null }, timeZone: string | null | undefined): SetTimeForm {
  const form = freshForm(i);
  if (i.selectedSlot?.address) Object.assign(form, { place: "address", address: i.selectedSlot.address });
  else if (i.format === "phone") form.place = "phone";
  else if (i.format === "video") Object.assign(form, { place: "link", url: i.linkSource === "pasted" ? i.meetingUrl ?? "" : "" });
  if (!i.startsAt || Number.isNaN(Date.parse(i.startsAt))) return form;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timeZone ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(i.startsAt));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return { ...form, date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
  } catch {
    return form;
  }
}

/**
 * The one button. "Book and email Maria"; "Book" when no email can go now (ITS has not confirmed the company, or there is
 * no address on file), so it never promises an email. Moving a booked time says "Move".
 */
export function bookLabel(firstName: string, input: { check: CompanyCheck; hasEmail: boolean; moving?: boolean }): string {
  const verb = input.moving ? "Move" : "Book";
  return input.check === "waiting" || !input.hasEmail || !firstName ? verb : `${verb} and email ${firstName}`;
}

/** What became of the email about this interview, in one line for the sheet and the panel; null when nothing needs saying. */
export function candidateEmailLine(state: CandidateEmailState | undefined, firstName: string, check: CompanyCheck = "unknown"): string | null {
  const first = firstName || "the candidate";
  if (state === "no_email") return "There is no email address on file: tell them yourself.";
  if (state === "failed") return `The email to ${first} could not be delivered. Tell them yourself.`;
  if (state === "held" || check === "waiting") return `${first.charAt(0).toUpperCase()}${first.slice(1)} has not been told: the email waits for ITS to confirm your company.`;
  return null;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Where an interview stands, in one word (6 November 2026): worked out from what is true of it, never from its   */
/* status field alone, and the same on the Interviews page, its sheet and the candidate's panel.                   */
/* ------------------------------------------------------------------------------------------------------------ */

/** The facts the word is worked out from: what the list and the panel both carry. */
export type InterviewFacts = { status: string; offeredSlots?: readonly unknown[] | null; startsAt?: string | null; outcome?: string | null; candidateEmail?: CandidateEmailState };

/**
 * `label` and `tone` are the pill; `note` the short line under the time in a list; `needsTime`: nothing has a time and
 * nothing is on its way to the candidate, so a person sets the date and time (the sheet and the panel offer the form).
 */
export type InterviewWord = { label: string; tone: Tone; note: string | null; needsTime: boolean };

const OUTCOME_WORDS: Record<string, string> = { happened: "Took place", no_show_candidate: "Candidate did not come", no_show_interviewer: "Interviewer did not come" };

/** What became of the email, as a list's short line. */
function emailNote(state: CandidateEmailState | undefined, check: CompanyCheck): string | null {
  if (state === "no_email") return "No email address on file";
  if (state === "failed") return "Email not delivered";
  if (state === "held" || check === "waiting") return "Email waits for the ITS check";
  return null;
}

export function interviewWord(i: InterviewFacts, check: CompanyCheck = "unknown"): InterviewWord {
  const offered = i.offeredSlots?.length ?? 0;
  const noTime: InterviewWord = { label: "No time yet", tone: "caution", note: null, needsTime: true };
  switch (i.status) {
    case "proposed":
      return noTime;
    case "scheduling": {
      // Reopened with nothing to offer, or times still being worked out: nothing has gone to the candidate.
      if (!offered) return noTime;
      // Times exist, but the email with them did not reach anyone: the candidate has nothing to pick from.
      if (i.candidateEmail === "failed") return { label: "Email failed", tone: "caution", note: "The times did not reach them", needsTime: true };
      if (i.candidateEmail === "no_email") return { label: "No email address", tone: "caution", note: "The times cannot reach them", needsTime: true };
      if (i.candidateEmail === "held" || check === "waiting") return { label: "Waiting for the ITS check", tone: "neutral", note: `${offered} ${offered === 1 ? "time" : "times"} ready`, needsTime: false };
      return { label: "Waiting on the candidate", tone: "accent", note: `${offered} ${offered === 1 ? "time" : "times"} offered`, needsTime: false };
    }
    case "scheduled":
      return { label: "Scheduled", tone: "good", note: emailNote(i.candidateEmail, check), needsTime: false };
    case "offer_expired":
      return i.candidateEmail === "failed" || i.candidateEmail === "no_email" ? { label: "Times never reached them", tone: "caution", note: null, needsTime: true } : { label: "Times expired", tone: "caution", note: null, needsTime: true };
    case "completed":
      return { label: (i.outcome && OUTCOME_WORDS[i.outcome]) || "Completed", tone: "neutral", note: null, needsTime: false };
    case "no_show":
      return { label: (i.outcome && OUTCOME_WORDS[i.outcome]) || "Did not take place", tone: "caution", note: null, needsTime: false };
    case "cancelled":
      return { label: "Cancelled", tone: "neutral", note: null, needsTime: false };
    default:
      return { label: i.status.replace(/_/g, " "), tone: "neutral", note: null, needsTime: false };
  }
}

/**
 * The decision recorded after an interview, in words. `new_times`: the candidate or our interviewer did not come, and a new
 * interview followed for the same round: times sent to pick from, or a date and time a person set (the note says which).
 */
export const DECISION_WORDS: Record<string, string> = { next_round: "Next round", finalist: "Finalist", not_moving_forward: "Not moving forward", hired: "Hired", new_times: "New interview set up" };

/** "Tue, Nov 10, 2:00 PM": a booked time on the company's clock (the interview's zone), for a list. */
export function shortWhen(iso: string | null | undefined, timeZone: string | null | undefined): string | null {
  if (!iso || Number.isNaN(Date.parse(iso))) return null;
  try {
    return plain(new Date(iso).toLocaleString("en-US", { timeZone: timeZone ?? undefined, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }));
  } catch {
    return plain(new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }));
  }
}

/**
 * One line on the panel's "Where things stand" for an interview, in the Interviews page's own words (rank 11): its word,
 * when it is, what became of its email, and the decision after it.
 */
export function interviewLine(i: InterviewFacts & { timezone?: string | null; decision?: string | null }, check: CompanyCheck = "unknown"): string {
  const w = interviewWord(i, check);
  const when = i.status === "scheduled" || i.status === "completed" || i.status === "no_show" ? shortWhen(i.startsAt, i.timezone) : null;
  return [w.label, when, w.note, i.decision ? `Decision: ${DECISION_WORDS[i.decision] ?? i.decision.replace(/_/g, " ")}` : null].filter(Boolean).join(" · ");
}

/** The open interview a person still has to set a time for: being set up, reopened with nothing out, or offered times that never reached them. */
export function interviewNeedingTime<T extends InterviewFacts>(interviews: readonly T[]): T | null {
  return interviews.find((i) => ["proposed", "scheduling"].includes(i.status) && interviewWord(i).needsTime) ?? null;
}
