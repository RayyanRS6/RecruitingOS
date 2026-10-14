import type { NotifyCadence } from "@ros/contracts";

/**
 * Email alerts and the history of updates (plan B3): the words Settings' "Email alerts" card and the Updates page use,
 * kept out of the pages so they can be checked without a browser.
 */

/** The four choices for each group, in the order Setup shows them. */
export const CADENCE_OPTIONS: Array<{ value: NotifyCadence; label: string }> = [
  { value: "immediate", label: "As it happens" },
  { value: "daily", label: "Daily summary" },
  { value: "weekly", label: "Weekly summary" },
  { value: "off", label: "Off" },
];

type DigestTime = { hour: number; weekday: string; timezone: string };

/** "8:00 AM" from an hour of the day. */
export function hourText(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  return `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? "AM" : "PM"}`;
}

/** "New York time" from "America/New_York". */
export function zoneText(timezone: string): string {
  const city = timezone.split("/").pop()?.replace(/_/g, " ") ?? timezone;
  return `${city} time`;
}

/** When summaries arrive, in one sentence. */
export function digestTimeText(d: DigestTime): string {
  return `Daily summaries arrive at ${hourText(d.hour)}, ${zoneText(d.timezone)}; weekly ones on ${d.weekday} at the same time. A summary lists only what you have not seen yet, and none is sent when there is nothing new.`;
}

/** What a change of setting did, as a toast. */
export function cadenceToast(label: string, cadence: NotifyCadence, d: DigestTime): { title: string; detail: string } {
  if (cadence === "immediate") return { title: `${label}: emailed as it happens.`, detail: "One short email for each update, with the job and a link." };
  if (cadence === "daily") return { title: `${label}: in your daily summary.`, detail: `It arrives at ${hourText(d.hour)}, ${zoneText(d.timezone)}.` };
  if (cadence === "weekly") return { title: `${label}: in your weekly summary.`, detail: `It arrives on ${d.weekday} at ${hourText(d.hour)}, ${zoneText(d.timezone)}.` };
  return { title: `${label}: no emails.`, detail: "You still see these on Home and in your updates." };
}

/** How many updates one request to mark read may carry (the API's limit). */
export const READ_BATCH = 200;

/**
 * The Updates page marks read exactly the unread updates it has loaded, never one on a page not loaded yet or one that
 * arrived since; while there are unread ones further back, the button says how many it marks.
 */
export function markReadLabel(shownUnread: number, totalUnread: number): string {
  return shownUnread >= totalUnread ? "Mark all read" : `Mark these ${shownUnread} read`;
}

/** When an update came in, short: "Oct 8, 9:14 AM". */
export function updateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
