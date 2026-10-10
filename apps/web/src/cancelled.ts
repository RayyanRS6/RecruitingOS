import { CANCELLED_REASON_LABEL, NEW_TIMES_SETTING_DEFAULT, NEW_TIMES_WORKING_DAYS, type CancelledReason } from "@ros/contracts";
import type { ApplicationSummary, CancelledCounts, CancelledView, NewTimesProgress, SendNewTimesBatchResult } from "./api/client";

/**
 * The Cancelled column as the team's pages say it (founder decisions 1A to 4A, 9 October 2026), kept free of React so it
 * can be tested (tests/web/cancelled.test.ts). Only a candidate's own cancel of a booked interview, with their choice
 * (new times later, or no longer interested), and a candidate who did not come put someone there. Only people who asked
 * for new times get one set automatically, after the working days the company chose in Setup; everyone else waits for
 * the team. The words follow the state the API reports, so nothing is promised that will not happen.
 */

/** The three reasons, in the order the chips above the list show them. */
export const CANCELLED_REASONS: readonly CancelledReason[] = ["asked_new_times", "not_interested", "no_show"];
const COUNT_KEY: Record<CancelledReason, keyof CancelledCounts> = { asked_new_times: "askedNewTimes", not_interested: "notInterested", no_show: "noShow" };

const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;
const peopleWere = (n: number) => `${n} ${n === 1 ? "person was" : "people were"}`;
const workingDays = (n: number) => `${n} working ${n === 1 ? "day" : "days"}`;

/** `?cancelled=` on a link to the Talent page; anything else filters nothing. */
export function cancelledReasonFrom(value: string | null | undefined): CancelledReason | null {
  return value && (CANCELLED_REASONS as readonly string[]).includes(value) ? (value as CancelledReason) : null;
}

/** The chips above the list under Cancelled, each with its count: the API's, or the rows' when an older answer has none. */
export function cancelledChips(counts: CancelledCounts | null | undefined, rows: ReadonlyArray<Pick<ApplicationSummary, "ownerStage" | "cancelled">>): Array<{ id: CancelledReason; label: string; count: number }> {
  return CANCELLED_REASONS.map((id) => ({
    id,
    label: CANCELLED_REASON_LABEL[id],
    count: counts ? counts[COUNT_KEY[id]] : rows.filter((a) => a.ownerStage === "cancelled" && a.cancelled?.reason === id).length,
  }));
}

/** An interview carrying their new times is open (being prepared, held for the ITS check, out, or not delivered): a new send is refused. */
export function newTimesOpen(times: NewTimesProgress): boolean {
  return times !== "none" && times !== "expired";
}

/** "Thursday, October 15": the promised day, from the company's calendar day (YYYY-MM-DD), else from the moment itself. */
export function promisedDay(auto: Pick<CancelledView["auto"], "dueDay" | "dueAt">): string {
  if (auto.dueDay && /^\d{4}-\d{2}-\d{2}$/.test(auto.dueDay)) return new Date(`${auto.dueDay}T12:00:00.000Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });
  return auto.dueAt ? new Date(auto.dueAt).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) : "the day they were told";
}

/** "Oct 15". */
export function shortDay(iso: string | null | undefined): string {
  return iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The candidate panel's card, the Interviews page and the History tab.                                          */
/* ------------------------------------------------------------------------------------------------------------ */

/** The card's title: what the person chose, or that they did not come. */
export function cancelledTitle(firstName: string, reason: CancelledReason): string {
  if (reason === "asked_new_times") return `${firstName} cancelled and asked for new times`;
  if (reason === "not_interested") return `${firstName} cancelled: no longer interested`;
  return `${firstName} did not come to the interview`;
}

/**
 * The card's sentence, first match wins: where new times stand once an interview carries them, then the automatic set
 * waiting for its day or for the ITS check, then what the person chose. `round` is the interview's title.
 */
export function cancelledBody(input: { firstName: string; round: string; c: Pick<CancelledView, "reason" | "auto" | "times" | "lastSentAt"> }): string {
  const { firstName, round, c } = input;
  if (c.times === "preparing") return `Getting new times ready. ${firstName} gets them by email as soon as there are times to offer from the interviewers' calendars.`;
  if (c.times === "held") return "New times are ready. The email waits until ITS confirms your company.";
  if (c.times === "out") return `New times went out${c.lastSentAt ? ` on ${shortDay(c.lastSentAt)}` : ""}. They stay under Cancelled until they pick one.`;
  if (c.times === "not_reached") return "The email with new times did not reach them. Offer the times by phone, or pick one for them from the interview page.";
  if (c.times === "expired") return "The new times passed without a pick. Send new times again, or decide.";
  if (c.auto.state === "waiting") return `New times go to them automatically on ${promisedDay(c.auto)}, as your settings say. Send them now instead, or stop the automatic set.`;
  if (c.auto.state === "waiting_check") return `New times were due on ${promisedDay(c.auto)}. They wait until ITS confirms your company again.`;
  if (c.reason === "not_interested") return "They told us they are no longer interested in this interview. Nothing goes to them automatically. You can still send new times, or decide.";
  if (c.reason === "no_show") return `The ${round} was booked and they did not come. Nothing goes to them automatically. Send new times for the same round, or decide below.`;
  return [c.auto.reasonText, "Send new times when you are ready, or decide."].filter(Boolean).join(" ");
}

/** The inline question before "Send new times" for one person. */
export function sendNewTimesQuestion(firstName: string, round: string): string {
  return `Send new times to ${firstName}? They get an email with times for the ${round}.`;
}

/** The inline question before "Don't send automatically". */
export function stopNewTimesQuestion(firstName: string): string {
  return `Stop the automatic new times for ${firstName}? Nothing goes to them automatically; they stay under Cancelled.`;
}

/** Said on the hold step for someone under Cancelled. */
export const HOLD_ENDS_CANCELLED = "Putting them on hold takes them out of Cancelled; nothing is sent to them automatically.";

/** The Interviews page's "Send new times" card: why they are under Cancelled, and what a send does. */
export function interviewNewTimesText(firstName: string, reason: CancelledReason): string {
  const why = reason === "asked_new_times" ? "cancelled and asked for new times" : reason === "not_interested" ? "cancelled and is no longer interested" : "did not come";
  return `${firstName} ${why}. New times go out for the same round.`;
}

/**
 * Why an automatic set did not go, for the History tab: the sentences the API gives the team (`autoReasonText` in
 * packages/core). Null when nothing needs saying: they did not ask, did not come, left the process, or their details were
 * deleted (the stage line already says it).
 */
const NOT_SENT_TEXT: Record<string, string> = {
  switched_off: "Automatic new times were switched off in Setup.",
  already_used: "They already had their one automatic set of new times.",
  reschedules_used: "They had already moved this interview twice, so a person arranges the next time.",
  takeover: "An ITS recruiter is running this role, so nothing was sent automatically.",
  was_on_hold: "You had put them on hold, so nothing goes automatically.",
  stopped_by_team: "Someone on your team stopped the automatic new times.",
  team_acted: "Your team took it from there.",
  candidate_replied: "They replied to us, so nothing went automatically: read their reply first.",
  company_not_checked: "ITS has not confirmed your company yet, so nothing could be sent automatically.",
  no_interviewers: "Nobody who ran the interview is still on your team.",
  no_email: "We have no email address for them, or the email did not reach them.",
  interview_changed: "The interview changed in the meantime.",
};
export function notSentReasonText(reason: unknown): string | null {
  return typeof reason === "string" ? (NOT_SENT_TEXT[reason] ?? null) : null;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The Talent page: the alert and the sheet that sends new times to several people.                             */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * The alert above the list under Cancelled. Its second sentence follows the company's setting (GET
 * /companies/current/new-times); while that is not known, only the count is said.
 */
export function cancelledAlertText(n: number, auto: boolean | null | undefined): string {
  const head = `${n} ${n === 1 ? "person is" : "people are"} under Cancelled.`;
  if (auto === true) return `${head} Only people who asked for new times get one set automatically; everyone else waits for you.`;
  if (auto === false) return `${head} Automatic new times are off, so everyone here waits for you.`;
  return head;
}

/** Said at the top of the sheet. */
export const NEW_TIMES_SHEET_TEXT = "Each person gets an email with new times for the same interview, from the same interviewers' calendars. People who did not come get a new interview for the same round. Nothing else is sent.";

/** One person in the sheet: ticked or not to start with, whether they can be ticked at all, and why. */
export type NewTimesSheetRow = { id: string; name: string; reason: CancelledReason; ticked: boolean; disabled: boolean; note: string };

/**
 * Everyone under Cancelled, as the sheet lists them (founder question 4): people who asked for new times and people who
 * did not come are ticked; people who said they are no longer interested are listed but not ticked; anyone whose new
 * times are already being prepared or are out cannot be ticked; without an email address nothing can reach them, so
 * they start unticked too.
 */
export function newTimesSheetRows(rows: ReadonlyArray<Pick<ApplicationSummary, "id" | "candidate" | "ownerStage" | "cancelled">>): NewTimesSheetRow[] {
  const out: NewTimesSheetRow[] = [];
  for (const a of rows) {
    const c = a.cancelled;
    if (a.ownerStage !== "cancelled" || !c) continue;
    const open = newTimesOpen(c.times);
    const noEmail = !a.candidate?.email;
    const notes = [open ? " (new times already being prepared or out)" : c.reason === "not_interested" ? " (said they are no longer interested)" : "", noEmail ? " (no email address on file)" : ""];
    out.push({ id: a.id, name: a.candidate?.name ?? "Unknown", reason: c.reason, ticked: !open && !noEmail && c.reason !== "not_interested", disabled: open, note: notes.join("") });
  }
  return out;
}

/** The sheet's button, with the count. */
export function newTimesSendLabel(n: number): string {
  return `Send new times to ${people(n)}`;
}

/** The answers of several requests of at most a hundred people as one: every person's own result, and the counts added up. */
export function mergeNewTimesResults(parts: readonly SendNewTimesBatchResult[]): SendNewTimesBatchResult {
  return { results: parts.flatMap((p) => p.results), sent: parts.reduce((n, p) => n + p.sent, 0), notSent: parts.reduce((n, p) => n + p.notSent, 0) };
}

/** One person's line once the sheet has sent: on its way to being prepared, or the API's own reason it was not. */
export function newTimesResultLine(r: SendNewTimesBatchResult["results"][number]): string {
  return r.ok ? "Getting new times ready" : (r.message ?? "Not sent.");
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Setup: "When a candidate cancels".                                                                            */
/* ------------------------------------------------------------------------------------------------------------ */

/** The company's setting as the card shows it: on after 3 working days when never saved; the days kept within 1 to 10. */
export function newTimesSettingFrom(settings: { newTimesAfterCancel?: { auto?: unknown; workingDays?: unknown } } | null | undefined): { auto: boolean; workingDays: number } {
  const s = settings?.newTimesAfterCancel;
  const auto = typeof s?.auto === "boolean" ? s.auto : NEW_TIMES_SETTING_DEFAULT.auto;
  const n = typeof s?.workingDays === "number" && Number.isFinite(s.workingDays) ? Math.round(s.workingDays) : NEW_TIMES_SETTING_DEFAULT.workingDays;
  return { auto, workingDays: Math.min(NEW_TIMES_WORKING_DAYS.max, Math.max(NEW_TIMES_WORKING_DAYS.min, n)) };
}

/** A typed number of working days, or null when it is not a whole number from 1 to 10. */
export function workingDaysFrom(text: string): number | null {
  const n = Number(text.trim());
  return text.trim() && Number.isInteger(n) && n >= NEW_TIMES_WORKING_DAYS.min && n <= NEW_TIMES_WORKING_DAYS.max ? n : null;
}

/** The card's fixed words. */
export const NEW_TIMES_SETUP = {
  title: "When a candidate cancels",
  intro: "When candidates cancel a booked interview, they choose: send me new times later, or I'm no longer interested. Either way they go under Cancelled on the role's Talent page, so you can see who and why. People who did not come to an interview go there too.",
  checkbox: "Send new times automatically to people who ask for them",
  daysLabel: "Working days to wait",
  daysHint: "1 to 10. Weekends and holidays are not counted. The email goes out in the morning, your company's time.",
  off: "Nobody gets new times automatically. People who ask for them wait under Cancelled until you send times or decide.",
  beforeCheck: "Automatic new times start once ITS confirms your company. Until then, emails to candidates wait.",
  readOnly: "Only owners and admins change this.",
  keep: "Still send them on the day they were told",
  stop: "Stop them too; the team will be in touch",
} as const;

/** What the setting does, under the checkbox. */
export function newTimesSettingText(s: { auto: boolean; workingDays: number }): string {
  if (!s.auto) return NEW_TIMES_SETUP.off;
  return `Each person gets one set of new times by email, ${workingDays(s.workingDays)} after they cancel, for the same interview. If they do not pick a time, they stay under Cancelled for you to decide. People who said they are no longer interested, and people who did not come, never get times automatically.`;
}

/** The setting in one line, for someone who may not change it. */
export function newTimesReadOnlyText(s: { auto: boolean; workingDays: number }): string {
  return s.auto ? `Automatic new times: on, after ${workingDays(s.workingDays)}.` : "Automatic new times: off.";
}

/** Asked before switching automatic times off while some people were already told a day. Nothing is chosen for the owner. */
export function pendingQuestion(n: number): string {
  return `${peopleWere(n)} already told a day for their new times. What should happen to them?`;
}

/** What a save changed about the people already told a day, so the card can say what happens to them. */
export type NewTimesSaved = { kind: "days"; pending: number } | { kind: "off"; choice: "keep" | "stop"; count: number } | { kind: "other" };

/** The notice under the card after a save, or null when there is nothing to say about anyone already told a day. */
export function newTimesSavedNotice(saved: NewTimesSaved): string | null {
  if (saved.kind === "days") return saved.pending > 0 ? `${peopleWere(saved.pending)} already told a day. They still get their times on that day; the new number applies to cancellations from now on.` : null;
  if (saved.kind === "off" && saved.count > 0) {
    return saved.choice === "keep"
      ? `${peopleWere(saved.count)} already told a day and still ${saved.count === 1 ? "gets" : "get"} their times then. To stop it for someone, open them under Cancelled and choose Don't send automatically.`
      : `Stopped the automatic times for ${people(saved.count)}. They were told a day, so someone should be in touch: they are under Cancelled.`;
  }
  return null;
}
