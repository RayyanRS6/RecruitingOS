import { z } from "zod";
import type { Actor } from "./common";

/**
 * The Trial plan's 30 days and its 3 people (founder decision L-02 B, 16 October 2026).
 *
 * A company on the Trial plan (`companies.plan_key` = TRIAL_PLAN_KEY) gets 30 days from the day ITS confirms it, the
 * first day it can go live. A company already on Trial when this shipped got its 30 days from the day the hourly check
 * first ran (`switched_on`), never an instant lock. ITS can extend a trial from the console, with a reason; putting the
 * company on another plan ends the trial with nothing to write, because only the Trial plan reads the dates. When the
 * days are over and no other plan was chosen the company is "paused": new applications, new jobs and new screening chats
 * wait, and everything already started carries on. Candidates are never told about a trial or a plan.
 *
 * The dates live on `companies.settings.trial` (TrialTerm), written only by the ITS check, the hourly check and ITS from
 * the console. Comparing the plan key to the Trial plan goes only through `onTrialPlan`, like the Design Partner rule.
 */
export const TRIAL_PLAN_KEY = "trial";
export const TRIAL_DAYS = 30;
/** The owners see "Your trial ends on <date>" from this many days before the end. */
export const TRIAL_NOTICE_DAYS = 7;
const DAY_MS = 86_400_000;

/** The one line the owners read once the trial has ended (Home, Settings, and every refusal of new work). */
export const TRIAL_ENDED_LINE = "Your trial has ended. New applications are paused until a plan is chosen. Contact ITS to choose a plan.";

/** Why a 4th person cannot be invited on the Trial plan (invitations not yet answered count too). */
export function seatsFullLine(limit: number): string {
  return `Your trial includes ${limit} people. Choose a plan to add more.`;
}

/** One extension ITS made from the console: how many days, why, who, when, and the end date before and after. */
export type TrialExtension = { days: number; reason: string; by: Actor; at: string; from: string; to: string };

/**
 * A company's trial dates (`companies.settings.trial`). `startedBy` says what started the 30 days: the ITS check, the
 * hourly check for a company already on Trial when this shipped, or a change of plan back to Trial. `endNoticeAt` is
 * when ITS and the owners were told the trial ended; an extension clears it so the next end is told again.
 */
export type TrialTerm = { startedAt: string; endsAt: string; startedBy: "its_check" | "switched_on" | "plan_change"; extensions?: TrialExtension[]; endNoticeAt?: string };

/** Whether a plan key is the Trial plan: the one place the plan's name is compared. */
export function onTrialPlan(planKey: string | null | undefined): boolean {
  return planKey === TRIAL_PLAN_KEY;
}

/** The trial dates on a company's settings, or null when there are none (or they cannot be read). */
export function trialTermOf(settings: unknown): TrialTerm | null {
  const t = settings && typeof settings === "object" ? (settings as { trial?: unknown }).trial : undefined;
  if (!t || typeof t !== "object") return null;
  const term = t as Partial<TrialTerm>;
  if (typeof term.startedAt !== "string" || typeof term.endsAt !== "string" || !Number.isFinite(Date.parse(term.endsAt))) return null;
  return term as TrialTerm;
}

/** A fresh 30 days from `now`. */
export function newTrialTerm(now: Date, startedBy: TrialTerm["startedBy"]): TrialTerm {
  return { startedAt: now.toISOString(), endsAt: new Date(now.getTime() + TRIAL_DAYS * DAY_MS).toISOString(), startedBy };
}

/**
 * Where a company stands on its trial. `started` false: on Trial and waiting for the ITS check (nothing ends before it
 * starts). `endingSoon`: not ended and within TRIAL_NOTICE_DAYS of the end. `ended`: the end has come (paused unless a
 * plan is chosen). `extendedDays` adds up every extension.
 */
export type TrialStanding = { started: boolean; startedAt: string | null; endsAt: string | null; daysLeft: number | null; endingSoon: boolean; ended: boolean; extendedDays: number };

/** Null when the company is not on the Trial plan; otherwise where its trial stands at `now`. Pure. */
export function trialStanding(company: { planKey: string | null | undefined; settings: unknown }, now: Date): TrialStanding | null {
  if (!onTrialPlan(company.planKey)) return null;
  const term = trialTermOf(company.settings);
  if (!term) return { started: false, startedAt: null, endsAt: null, daysLeft: null, endingSoon: false, ended: false, extendedDays: 0 };
  const left = Date.parse(term.endsAt) - now.getTime();
  const ended = left <= 0;
  const extendedDays = (term.extensions ?? []).reduce((sum, e) => sum + (Number.isFinite(e.days) ? e.days : 0), 0);
  return { started: true, startedAt: term.startedAt, endsAt: term.endsAt, daysLeft: ended ? 0 : Math.ceil(left / DAY_MS), endingSoon: !ended && left <= TRIAL_NOTICE_DAYS * DAY_MS, ended, extendedDays };
}

/** Whether new applications, new jobs and new screening chats wait: on Trial, and its trial has ended. */
export function trialPaused(company: { planKey: string | null | undefined; settings: unknown }, now: Date): boolean {
  return trialStanding(company, now)?.ended === true;
}

/** POST /api/v1/admin/customers/:id/trial: ITS extends a customer's trial by a number of days, with a reason. */
export const TrialExtensionRequest = z.object({
  days: z.number().int("Extend by a whole number of days.").min(1, "Extend by at least one day.").max(90, "Extend by at most 90 days at a time."),
  reason: z.string().trim().min(5, "Say why the trial is extended (at least five characters).").max(500),
  confirm: z.literal(true, { message: "Confirm the extension." }),
}).strict();
export type TrialExtensionRequest = z.infer<typeof TrialExtensionRequest>;
