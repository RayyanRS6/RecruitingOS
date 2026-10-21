/**
 * The ITS console's plain words, in one place (redesign spec 3.3): what each status, severity, plan and workflow is
 * called on screen, and how money and dates read. The sections only import from here; a section that needs a word this
 * file lacks keeps it in its own file. Codes the maps do not know read as their words (underscores as spaces), never as
 * a raw code.
 */
import type { TrialStanding } from "@ros/contracts";
import { trialDate } from "../../trial";

/** "screen_invited" -> "screen invited": an unknown code, readable. */
export function plainCode(code: string): string {
  return code.replace(/_/g, " ").trim();
}

/** "screen invited" -> "Screen invited". */
export function firstUpper(words: string): string {
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : words;
}

/** The word a map gives a code, or the code itself in readable words (first letter capital). */
export function wordFor(map: Readonly<Record<string, string>>, code: string | null | undefined): string {
  if (!code) return "";
  return Object.hasOwn(map, code) ? map[code] : firstUpper(plainCode(code));
}

/** A workflow run's status (GET /admin/runs). */
export const RUN_STATUS_WORDS: Readonly<Record<string, string>> = { running: "Running", waiting: "Waiting", failed: "Failed", completed: "Done" };
export const runStatusWords = (code: string) => wordFor(RUN_STATUS_WORDS, code);

/** An alert's severity (GET /admin/alerts, /admin/failures). */
export const ALERT_SEVERITY_WORDS: Readonly<Record<string, string>> = { critical: "Urgent", warning: "Check soon", info: "For your information" };
export const severityWords = (code: string) => wordFor(ALERT_SEVERITY_WORDS, code);

/** A privacy request's status (GET /admin/data-requests). */
export const PRIVACY_STATUS_WORDS: Readonly<Record<string, string>> = { received: "New", in_progress: "In progress", awaiting_counsel: "Waiting for counsel", fulfilled: "Done", declined: "Declined" };
export const privacyStatusWords = (code: string) => wordFor(PRIVACY_STATUS_WORDS, code);

/**
 * Whether the person behind a privacy request was verified. Two codes mean verified: through their own status link or
 * an emailed link (`verified_by_link`), or by an administrator (`verified_manual`).
 */
export const VERIFICATION_WORDS: Readonly<Record<string, string>> = { pending: "Not checked yet", verified_by_link: "Verified", verified_manual: "Verified", failed: "Could not verify" };
export const verificationWords = (code: string) => wordFor(VERIFICATION_WORDS, code);

/** A customer's plan, by its key (the plans table). */
export const PLAN_WORDS: Readonly<Record<string, string>> = { trial: "Trial", core: "Core", growth: "Growth", company: "Company", design_partner: "Design Partner" };
export const planWords = (key: string) => wordFor(PLAN_WORDS, key);

/**
 * Where a Trial customer's 30 days stand (founder decision L-02 B; GET /admin/customers `trial`), for the plan cell:
 * "ends Oct 30", "ended Oct 30, paused", or "starts at the ITS check"; empty on another plan. The date is on the
 * company's calendar when its time zone is known.
 */
export function trialWords(trial: TrialStanding | null | undefined, timeZone?: string | null): string {
  if (!trial) return "";
  if (!trial.started || !trial.endsAt) return "starts at the ITS check";
  const day = trialDate(trial.endsAt, timeZone, { short: true });
  return trial.ended ? `ended ${day}, paused` : `ends ${day}`;
}

/** Where a customer stands with its plan (`companies.status`). Design Partner is a pilot, never called a free trial. */
export const PLAN_STATUS_WORDS: Readonly<Record<string, string>> = { trial: "Trial", active: "Active", design_partner: "Design Partner pilot" };
export const planStatusWords = (code: string) => wordFor(PLAN_STATUS_WORDS, code);

/** What each workflow does, by its key (packages/workflows/src/definitions). */
export const WORKFLOW_WORDS: Readonly<Record<string, string>> = {
  application_intake: "Reading a new application",
  screen: "AI interview",
  role_approval: "Job approval",
  publish_role: "Publishing a job",
  schedule_interview: "Scheduling an interview",
  interview_new_times: "New interview times",
  role_closing_date: "Closing date",
  notification_digest: "Email summary",
  stuck_role_detector: "Check for stuck jobs",
};
export const workflowWords = (key: string) => wordFor(WORKFLOW_WORDS, key);

/** An AI run's status (packages/ai/src/runner.ts), the same on System › AI runs and Problems › Failed work. */
export const AI_STATUS_WORDS: Readonly<Record<string, string>> = { ok: "OK", refused: "Refused", error: "Provider error", invalid_output: "Answer not usable" };
export const aiStatusWords = (code: string) => wordFor(AI_STATUS_WORDS, code);

/** A workflow step's status (packages/workflows/src/engine.ts), as it reads inside a sentence. */
export const STEP_STATUS_WORDS: Readonly<Record<string, string>> = { ok: "done", error: "failed" };

/** "$4.10"; an amount under a cent that is not nothing reads "less than $0.01". The exact figure is for drawers. */
export function money(usd: number): string {
  if (!Number.isFinite(usd)) return "";
  if (usd > 0 && usd < 0.005) return "less than $0.01";
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The exact amount, as the console showed it before (4 decimals for a customer's total, 5 for one run). */
export function exactMoney(usd: number, decimals: 4 | 5 = 4): string {
  return `$${usd.toFixed(decimals)}`;
}

const DAY = 86_400_000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "today", "yesterday", "3 days ago", then "Oct 3" (with the year when it is not this year). Calendar days, reader's zone. */
export function whenWords(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  const sameYear = at.getFullYear() === now.getFullYear();
  return at.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

/** The exact time, for a tooltip (`title`) and in drawers: "Oct 14, 2026, 3:10 PM". */
export function exactWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  // newer ICU puts a narrow no-break space before AM/PM; a plain space reads the same and matches everywhere
  return at.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).replace(/ /g, " ");
}

/** The console's churn rule (unchanged): quiet after 7 days without activity, no activity after 14. */
export const QUIET_AFTER_DAYS = 7;
export const NO_ACTIVITY_AFTER_DAYS = 14;

/** How a customer's last activity reads, with the tone of its chip; never active counts as no activity. */
export function activityWords(lastActivityAt: string | null, now: number = Date.now()): { state: "active" | "quiet" | "none"; label: string; tone: "good" | "caution" | "critical" } {
  if (!lastActivityAt) return { state: "none", label: "never active", tone: "critical" };
  const idle = (now - Date.parse(lastActivityAt)) / DAY;
  if (idle > NO_ACTIVITY_AFTER_DAYS) return { state: "none", label: `no activity ${Math.round(idle)}d`, tone: "critical" };
  if (idle > QUIET_AFTER_DAYS) return { state: "quiet", label: `quiet ${Math.round(idle)}d`, tone: "caution" };
  return { state: "active", label: "active", tone: "good" };
}
