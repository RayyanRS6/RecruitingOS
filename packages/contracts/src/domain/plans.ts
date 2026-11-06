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

/** GET /api/v1/plans: the public plans in their order, and whether ITS already has an open request about the plan from this company. */
export type PublicPlans = { plans: PublicPlan[]; requested: boolean };

/** The private pilot: never listed for a customer, and ITS gives it, so it is never offered an upgrade. */
const PRIVATE_PLAN_KEY = "design_partner";

/**
 * Whether a company on this plan is offered an Upgrade where nothing has run out (Settings): every plan but the last public
 * one, which has nothing above it, and the private pilot. Read from the list, so no screen compares a plan's name.
 */
export function mayOfferUpgrade(planKey: string | null | undefined): boolean {
  return !!planKey && planKey !== PRIVATE_PLAN_KEY && planKey !== PUBLIC_PLAN_KEYS[PUBLIC_PLAN_KEYS.length - 1];
}

/** What the queue shows of a plan request before anyone accepts it: template words, never the customer's. */
export const PLAN_REQUEST_SUMMARY = "A customer asked about their plan.";
/** What it needs from whoever picks it up. */
export const PLAN_REQUEST_EXPERTISE = "plan and billing";
/** Said when ITS already has an open request about the plan: a second one is not raised. */
export const PLAN_REQUEST_OPEN_LINE = "ITS has your request.";
/** The upgrade sheet's one plain line: there is no payment system. */
export const UPGRADE_SHEET_LINE = "No card is charged. ITS will contact you, and nothing changes until then.";

/** The question a plan request carries: the plan by name, then why, then the person's own note. Null: no plan to name, because nothing is above theirs. */
export function planRequestQuestion(planName: string | null, opts: { reason?: string | null; note?: string | null } = {}): string {
  return [planName ? `We would like to move to the ${planName} plan.` : "We would like to talk about our plan.", opts.reason?.trim(), opts.note?.trim()].filter(Boolean).join(" ");
}

/** What the team is told when ITS changes the plan, and the answer it puts on the open plan request. `opened`: how many locked people the new plan opened. */
export function planChangedWords(planName: string, opened = 0): { title: string; body: string; answer: string } {
  const people = opened ? ` ${opened === 1 ? "1 candidate who was locked is open now" : `${opened} candidates who were locked are open now`}.` : "";
  const answer = `Your company is on the ${planName} plan now.`;
  return { title: `Your plan is now ${planName}`, body: `${answer} The new limits apply at once.${people}`, answer };
}

/** Why another job is refused once the plan's jobs are all used: "Your Free plan includes one job. Upgrade to post more." */
export function jobsTotalLine(planName: string | null | undefined, limit: number): string {
  return `Your ${planName ? `${planName} ` : ""}plan includes ${limit === 1 ? "one job" : `${limit} jobs`}. Upgrade to post more.`;
}

/** Why that refusal's Upgrade is asked for, after the plan's name in the question. */
export const MORE_JOBS_UPGRADE_QUESTION = "We would like to post more jobs.";

/** Said when a company on a plan with no ITS staff time asks ITS to post its jobs. */
export const ITS_POSTING_UPGRADE_LINE = "On your plan your team posts the jobs on the boards. Upgrade to have ITS post them.";
/** Why that Upgrade is asked for. */
export const ITS_POSTING_UPGRADE_QUESTION = "We would like ITS to post our jobs on the boards.";
/** Why an Upgrade is asked for when every place for a person on the team is in use. */
export const MORE_PEOPLE_UPGRADE_QUESTION = "We would like to add more people.";

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

/** Why an Upgrade is asked for when it is more candidates the company wants to see. */
export const MORE_CANDIDATES_UPGRADE_QUESTION = "We would like to view more candidates.";

/** A recruiter request about someone locked, as the team's own list shows it: their words, and ITS's, stay with ITS. */
export const LOCKED_REQUEST_LINE = "An ITS recruiter is helping a candidate you cannot see yet.";

/**
 * Why nothing starts for someone locked: on the button, and in the route's refusal. Only ITS staff who may read them see it
 * (a grant naming them, or break glass); the team is refused at the door and never reads it.
 */
export const NO_WORK_WHILE_LOCKED = "Locked on the company's plan: no AI help, no AI interview and no interview until an upgrade opens them.";

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

/** Why an Upgrade is asked for when the AI help is what ran out. */
export const AI_HELP_UPGRADE_QUESTION = "We would like more AI help.";

const USED_UP = "Your plan's AI help is used up.";
/** A call too big for what is left: the credit is not all gone, so it does not say so. */
const NEARLY_USED_UP = "Your plan's AI help is nearly used up";
/** A call refused only for money held by work still running: nothing is used up, and it comes back within minutes. */
const BUSY = "Your plan's AI help is finishing other work.";

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

/** The same calls refused only for money held by work still running: here, and only here, what is true is to try again. */
export const AI_HELP_BUSY_LINE = {
  turn: `${BUSY} Your draft is saved. Try again in a few minutes.`,
  draft: `${BUSY} Everything you confirmed is kept. Try again in a few minutes.`,
  revise: `${BUSY} Nothing was changed. Try again in a few minutes, or make the change in the editor.`,
  about: `${BUSY} Try again in a few minutes, or write this text yourself; it shows the same way.`,
} as const;

/** Where the AI credit stands for the owner: at the 80% line, used up, or neither. */
export type AiCreditLevel = "warning" | "used_up";

/**
 * What the owner's notices and the Home row say at each level. `resetsOn`: the day a monthly credit starts again, in words.
 * `newJobsStopped`: past the 80% line a draft may no longer fit (`aiCreditRoomForJob`), and then something has stopped.
 */
export function aiCreditNoticeWords(level: AiCreditLevel, opts: { resetsOn?: string | null; newJobsStopped?: boolean } = {}): { title: string; body: string } {
  if (level === "warning") return { title: "80% of your plan's AI help used", body: opts.newJobsStopped ? "New jobs have stopped: writing one needs more than is left. Upgrade before the rest runs out." : "Nothing has stopped. Upgrade before it runs out." };
  return { title: "Your plan's AI help is used up", body: `Applications still come in and candidates can still finish. New applicants are not read by AI until you upgrade${opts.resetsOn ? ` or it starts again on ${opts.resetsOn}` : ""}.` };
}

/**
 * The AI credit as a customer's browser may receive it (GET /companies/current): a level, a percentage and the words for
 * the Home row, never an amount. Null when the plan puts no limit on it.
 */
export type AiCreditView = { level: AiCreditLevel | null; percent: number; resetsAt: string | null; notice: { title: string; body: string } | null };
