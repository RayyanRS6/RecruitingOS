/**
 * The alerts about a company's monthly AI interviews as the admin console reads them (80% of the plan's allowance, and
 * used up), kept free of React so they can be tested (tests/web/allowance.test.ts).
 */

export type AllowanceLevel = "warning" | "used_up";

/** An alert about a company's allowance, as the admin console reads it. */
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

/** The chip on a company's row. */
export function allowanceChip(a: Pick<AllowanceAlert, "level" | "used" | "limit">): string {
  const counted = a.used !== null && a.limit !== null ? ` (${a.used} of ${a.limit})` : "";
  return a.level === "used_up" ? `AI interviews used up${counted}` : `80% of AI interviews used${counted}`;
}
