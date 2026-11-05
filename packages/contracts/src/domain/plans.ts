/**
 * The plans people can be on (the owner's request of 5 November 2026): Free, Basic, Pro and Ultra. Every number is in one
 * place, the rows in packages/db/src/seed.ts; a company's limits are read by key from its own rows (packages/core/src/
 * entitlements.ts), so nothing here or anywhere else compares a plan's name to decide what it may do.
 */

/** The plan a new company starts on, with no clock (a Trial company already on Trial keeps its own rules, domain/trial.ts). */
export const FREE_PLAN_KEY = "free";

/** The plans a customer may be shown and may ask for, in the order they are shown. Design Partner is private, and is never listed. */
export const PUBLIC_PLAN_KEYS = ["free", "basic", "pro", "ultra"] as const;
export type PublicPlanKey = (typeof PUBLIC_PLAN_KEYS)[number];

export function isPublicPlanKey(key: string | null | undefined): key is PublicPlanKey {
  return (PUBLIC_PLAN_KEYS as readonly string[]).includes(key ?? "");
}

/** Jobs at a time: while a job waits for approval, is sent back, is open or is paused. Closing one gives its place back. */
export const ACTIVE_ROLES = "active_roles";
/** Jobs ever, counted live from the roles: one that ever went live counts for good; one closed before it opened gives its place back. */
export const JOBS_TOTAL = "jobs_total";
/** How many applicants of each job the team may read; the rest are locked. Not a count of anything used. */
export const CANDIDATES_PER_JOB = "candidates_per_job";
/** The AI interviews a month. */
export const TEXT_SCREENS = "text_screens";
/** The AI credit for the life of the company, in cents, summed live from ai_runs. Never resets. */
export const AI_CREDIT_TOTAL_CENTS = "ai_credit_total_cents";
/** The AI credit a month, in cents, summed live from ai_runs from the period's start. */
export const AI_CREDIT_MONTHLY_CENTS = "ai_credit_monthly_cents";
/** The recruiter requests a month: counted, never refused (founder decision Q33). */
export const RECRUITER_ASKS = "recruiter_asks";
/** The people on the team, counting invitations not yet answered. */
export const SEATS = "seats";
/** ITS staff time on posting: 0 means none (the team posts its own job boards); null means ITS does. */
export const ITS_WORK = "its_work";

/**
 * The keys every plan names, null where it has no limit. `applyPlan` writes only the keys a plan lists and never clears
 * another, so a plan that left one out would keep a company on its old limit after a change of plan.
 * packages/db/src/seed.test.ts pins this.
 */
export const PLAN_LIMIT_KEYS = [ACTIVE_ROLES, JOBS_TOTAL, CANDIDATES_PER_JOB, TEXT_SCREENS, AI_CREDIT_TOTAL_CENTS, AI_CREDIT_MONTHLY_CENTS, RECRUITER_ASKS, SEATS, ITS_WORK] as const;
export type PlanLimitKey = (typeof PLAN_LIMIT_KEYS)[number];

/** Whether a limit key is the AI credit: money, which customers read as words or a percentage, never dollars. */
export function isAiCreditKey(key: string): boolean {
  return key === AI_CREDIT_TOTAL_CENTS || key === AI_CREDIT_MONTHLY_CENTS;
}

/** A plan's limits as a customer's browser may receive them: everything but the AI credit. */
export function limitsForCustomers(limits: Record<string, number | null>): Record<string, number | null> {
  return Object.fromEntries(Object.entries(limits).filter(([key]) => !isAiCreditKey(key)));
}

/** AI help on each public plan, in words: what the credit covers, never what it costs. */
export const PLAN_AI_HELP: Readonly<Record<PublicPlanKey, string>> = {
  free: "Included, up to a limit",
  basic: "About 600 candidates a month",
  pro: "About 1,800",
  ultra: "About 6,000",
};

/** One plan as the upgrade sheet shows it (GET /api/v1/plans). A null number means no limit. */
export type PublicPlan = {
  key: PublicPlanKey;
  name: string;
  monthlyUsd: number;
  /** Jobs at a time. */
  activeRoles: number | null;
  /** Jobs ever. */
  jobsTotal: number | null;
  candidatesPerJob: number | null;
  seats: number | null;
  /** In words (PLAN_AI_HELP). */
  aiHelp: string;
  /** The plan the company is on now. */
  current: boolean;
};

/** A plan row as the public view reads it (the plans table's own columns). */
type PlanRowForView = { key: string; name: string; prices: Record<string, number>; limits: Record<string, number | null> };

/** A plan row as customers may read it, or null for a plan they are never shown. No AI credit in money goes through. */
export function publicPlanView(row: PlanRowForView, currentPlanKey: string | null | undefined): PublicPlan | null {
  if (!isPublicPlanKey(row.key)) return null;
  const limit = (key: PlanLimitKey) => row.limits[key] ?? null;
  return {
    key: row.key,
    name: row.name,
    monthlyUsd: row.prices.monthlyUsd ?? 0,
    activeRoles: limit(ACTIVE_ROLES),
    jobsTotal: limit(JOBS_TOTAL),
    candidatesPerJob: limit(CANDIDATES_PER_JOB),
    seats: limit(SEATS),
    aiHelp: PLAN_AI_HELP[row.key],
    current: row.key === currentPlanKey,
  };
}

/** Why another job is refused once the plan's jobs are all used: "Your Free plan includes one job. Upgrade to post more." */
export function jobsTotalLine(planName: string | null | undefined, limit: number): string {
  return `Your ${planName ? `${planName} ` : ""}plan includes ${limit === 1 ? "one job" : `${limit} jobs`}. Upgrade to post more.`;
}

/** What that refusal's Upgrade asks ITS. */
export const MORE_JOBS_UPGRADE_QUESTION = "We would like to upgrade our plan so we can post more jobs.";

/**
 * What the team reads of someone past the plan's candidates per job (Rule 3): a lock, this word, when they applied and the
 * line below. Never a name, initials, a score, a stage or a source.
 */
export const LOCKED_WORD = "Locked";
export const MORE_CANDIDATES_LINE = "Upgrade to view more candidates.";

/** The neutral notice's first half, once per job per day (`MORE_CANDIDATES_LINE` is the second): all the team hears of people applying past the limit. */
export function moreAppliedTitle(roleTitle: string): string {
  return `More people applied to ${roleTitle}.`;
}

/** What an Upgrade asks ITS when it is more candidates the company wants to see. */
export const MORE_CANDIDATES_UPGRADE_QUESTION = "We would like to upgrade our plan so we can view more candidates.";

/** A recruiter request about someone locked, as the team's own list shows it: their words, and ITS's, stay with ITS. */
export const LOCKED_REQUEST_LINE = "An ITS recruiter is helping a candidate you cannot see yet.";

/** One locked person on a job's list: where they came in, and when. Nothing else about them. */
export type LockedCard = { position: number; appliedAt: string };
/** The locked people of one job, beside the people the team can read (GET /roles/:id/applications?counts=1). */
export type LockedApplicants = { count: number; cards: LockedCard[] };

/**
 * The company-level signal that a company's AI work waiting for credit should look again (`waitForCredit` in
 * packages/workflows): Change plan sends it. A monthly credit's new month has no event, so those waits also end at the
 * period's end.
 */
export const AI_CREDIT_AVAILABLE = "ai.credit_available";

/** What an Upgrade asks ITS when the AI help is what ran out. */
export const AI_HELP_UPGRADE_QUESTION = "We would like to upgrade our plan for more AI help.";

const USED_UP = "Your plan's AI help is used up.";
/** A call too big for what is left: the credit is not all gone, so it does not say so. */
const NEARLY_USED_UP = "Your plan's AI help is nearly used up";

/**
 * What the owner reads when the AI help stops something they asked for: words only, never dollars
 * (docs/FOUNDER-CONTEXT.md, "AI credit math"). A candidate never reads any of these.
 */
export const AI_HELP_LINE = {
  /** A chat turn in the job builder: their words stay saved. */
  turn: `${USED_UP} Your draft is saved. Upgrade to keep going.`,
  /** Writing the job's draft, the dearest call: what they confirmed is kept. */
  draft: `${USED_UP} Everything you confirmed is kept. Upgrade to write the draft.`,
  draftTooBig: `${NEARLY_USED_UP}, and writing the draft needs more than is left. Everything you confirmed is kept. Upgrade to write the draft.`,
  /** Changing a job by chat: the editor needs no AI. */
  revise: `${USED_UP} Nothing was changed. You can still make the change in the editor.`,
  /** The text about the company: the person can write it. */
  about: `${USED_UP} You can write this text yourself; it shows the same way.`,
  /** A new job, before anyone types. */
  newJob: `${USED_UP} Upgrade to keep going.`,
  newJobTooBig: `${NEARLY_USED_UP}, and a new job needs more than is left. Upgrade to keep going.`,
} as const;

/** Where the AI credit stands for the owner: at the 80% line, used up, or neither. */
export type AiCreditLevel = "warning" | "used_up";

/** What the owner's notices and the Home row say at each level. `resetsOn`: the day a monthly credit starts again, in words. */
export function aiCreditNoticeWords(level: AiCreditLevel, opts: { resetsOn?: string | null } = {}): { title: string; body: string } {
  if (level === "warning") return { title: "80% of your plan's AI help used", body: "Nothing has stopped. Upgrade before it runs out." };
  return { title: "Your plan's AI help is used up", body: `Applications still come in and candidates can still finish. New applicants are not read by AI until you upgrade${opts.resetsOn ? ` or it starts again on ${opts.resetsOn}` : ""}.` };
}

/**
 * The AI credit as a customer's browser may receive it (GET /companies/current): a level, a percentage and the words for
 * the Home row, never an amount. Null when the plan puts no limit on it.
 */
export type AiCreditView = { level: AiCreditLevel | null; percent: number; resetsAt: string | null; notice: { title: string; body: string } | null };
