import { AI_HELP_UPGRADE_QUESTION, appPaths, type HomeJob, type HomeNotice } from "@ros/contracts";
import { TRIAL_ASK } from "./trial";

/**
 * Home's pure pieces, kept out of the page so they can be checked without a browser: the greeting, a job's row with
 * its counts and where each leads, and the request a notice's Upgrade sends.
 */

/**
 * Home keeps itself current: it is asked for again when the window comes back into focus, and every minute while the
 * page is open and visible (never in a hidden tab). The app's default is neither, so a half-filled form elsewhere is
 * never reloaded under someone.
 */
export const KEEP_CURRENT = { refetchOnWindowFocus: true, refetchInterval: 60_000, refetchIntervalInBackground: false } as const;

/** "Dana" from "Dana Whitfield", for the greeting; nothing when the name is not known. */
export function firstName(name: string | null | undefined): string | null {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first ? first : null;
}

/** The greeting for an hour of the day (0 to 23), with the person's first name when it is known. */
export function greeting(hour: number, name?: string | null): string {
  const part = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  const first = firstName(name);
  return `Good ${part}${first ? `, ${first}` : ""}`;
}

const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A count on a job's row that leads to the people it counts. */
export type CountLink = { text: string; href: string };

/**
 * One job on Home. The title opens its candidates; `status` is said only for a paused job; a count shows only when
 * there is someone to open, and leads to that tab of the job's candidates.
 */
export type HomeJobRow = { id: string; title: string; href: string; status: string | null; toReview: CountLink | null; interviewed: CountLink | null; applicants: string };

export function homeJobRow(job: HomeJob): HomeJobRow {
  return {
    id: job.id,
    title: job.title,
    href: appPaths.candidates(job.id),
    status: job.status === "paused" ? job.statusLabel : null,
    toReview: job.toReview > 0 ? { text: `${job.toReview} new to review`, href: appPaths.candidates(job.id, "new") } : null,
    interviewed: job.interviewed > 0 ? { text: `${job.interviewed} finished the AI interview`, href: appPaths.candidates(job.id, "interviewed") } : null,
    applicants: job.applicants > 0 ? counted(job.applicants, "applicant", "applicants") : "No applicants yet",
  };
}

/** Why a notice's Upgrade is asked for: sent with the request from the upgrade sheet. */
export function noticeAsk(kind: HomeNotice["kind"]): string {
  return kind === "trial_ending" || kind === "trial_ended" ? TRIAL_ASK : AI_HELP_UPGRADE_QUESTION;
}
