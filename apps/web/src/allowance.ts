/**
 * The plan's monthly screening conversations (founder decision Q17), kept free of React so it can be tested
 * (tests/web/allowance.test.ts): the owner and ITS are warned at 80% of the allowance; when it runs out, applications
 * are still accepted and new applicants get the conversation link by email once more are added, so everyone for a role
 * goes through the same steps. Mirrors ALLOWANCE_WARN_RATIO and the alert kinds in packages/core/src/entitlements.ts.
 */

export const ALLOWANCE_WARN_RATIO = 0.8;
/** The entitlement key of the screening conversations. */
export const TEXT_SCREENS = "text_screens";

export type UsageLine = { used: number; limit: number | null };
export type AllowanceLevel = "warning" | "used_up";
export type AllowanceWarning = { level: AllowanceLevel; used: number; limit: number; title: string; body: string };

/** Where a used count stands against a limit: at 80% or past it, used up, or neither (no limit counts as neither). */
export function allowanceLevel(used: number, limit: number | null | undefined): AllowanceLevel | null {
  if (limit === null || limit === undefined || limit <= 0) return null;
  if (used >= limit) return "used_up";
  return used >= Math.ceil(limit * ALLOWANCE_WARN_RATIO) ? "warning" : null;
}

/**
 * Today's card for an owner or admin (GET /companies/current `usage`), or null while under 80%. A Design Partner pilot
 * keeps offering the conversation past the allowance (founder decision F8), so its card says that instead.
 */
export function screeningAllowanceWarning(usage: Record<string, UsageLine> | null | undefined, planKey?: string | null): AllowanceWarning | null {
  const u = usage?.[TEXT_SCREENS];
  if (!u) return null;
  const level = allowanceLevel(u.used, u.limit);
  if (!level || u.limit === null) return null;
  const counted = `${u.used} of ${u.limit} used.`;
  if (level === "used_up") {
    return {
      level,
      used: u.used,
      limit: u.limit,
      title: "This month's screening chats are used up",
      body: planKey === "design_partner"
        ? `${counted} Your pilot keeps offering the chat to everyone, and anyone part-way through finishes. ITS has been told so the allowance can be reviewed.`
        : `${counted} Applications are still accepted, and anyone part-way through finishes. New applicants get the chat link by email as soon as more are added, so everyone for a role goes through the same steps. ITS has been told.`,
    };
  }
  return {
    level,
    used: u.used,
    limit: u.limit,
    title: `${u.used} of this month's ${u.limit} screening chats used`,
    body: "Nothing has stopped. If they run out, applications are still accepted and new applicants get the chat link by email once more are added. ITS has been told and can add more before then.",
  };
}

/** What Today's card asks ITS, opened in the request form first (never sent in one click). */
export const ALLOWANCE_ASK = { kind: "ask" as const, about: "all" as const, topic: "plan" as const, question: "We are running low on this month's screening chats. Can we add more?" };

/** An ITS alert about a company's allowance (GET /admin/alerts), as the admin console reads it. */
export type AllowanceAlert = { companyId: string; level: AllowanceLevel; used: number | null; limit: number | null; since: string };

const ALERT_LEVEL: Record<string, AllowanceLevel> = { "billing.screens_warning": "warning", "billing.screens_used_up": "used_up" };

/**
 * The open allowance alerts by company, the most serious one for each (used up over 80%), from the console's alert list.
 * Acknowledged alerts still count: the allowance stays where it is until it is topped up or the month turns.
 */
export function allowanceAlerts(alerts: ReadonlyArray<{ kind: string; companyId: string | null; status: string; details?: Record<string, unknown> | null; createdAt: string }>): Map<string, AllowanceAlert> {
  const out = new Map<string, AllowanceAlert>();
  for (const a of alerts) {
    const level = ALERT_LEVEL[a.kind];
    if (!level || !a.companyId || !["open", "acknowledged"].includes(a.status)) continue;
    const num = (v: unknown) => (typeof v === "number" ? v : null);
    const next: AllowanceAlert = { companyId: a.companyId, level, used: num(a.details?.used), limit: num(a.details?.limit), since: a.createdAt };
    const now = out.get(a.companyId);
    if (!now || (now.level === "warning" && level === "used_up") || (now.level === level && Date.parse(a.createdAt) > Date.parse(now.since))) out.set(a.companyId, next);
  }
  return out;
}

/** The chip on a customer's row. */
export function allowanceChip(a: Pick<AllowanceAlert, "level" | "used" | "limit">): string {
  const counted = a.used !== null && a.limit !== null ? ` (${a.used} of ${a.limit})` : "";
  return a.level === "used_up" ? `Screening chats used up${counted}` : `80% of screening chats used${counted}`;
}
