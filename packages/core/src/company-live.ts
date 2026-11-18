import { eq, sql, type SQL } from "drizzle-orm";
import { companies, type Queryable } from "@ros/db";

/**
 * The one gate. A company is live from the moment an administrator accepts it (at once where sign-up is open): its
 * people can work, its careers page and job pages are public, and its emails to candidates go. Declining it, or taking
 * its access away, takes all of that back, and accepting it again restores it. The fact is stored once, on the
 * company's own row, as the time it went live (`settings.verifiedAt`). `setCompanyLive` is its only writer; whatever
 * is public, or sends to a candidate, asks `isCompanyLive` (or `companyIsLive` inside a query).
 */
export function isCompanyLive(settings: unknown): boolean {
  const since = settings && typeof settings === "object" ? (settings as { verifiedAt?: unknown }).verifiedAt : undefined;
  return typeof since === "string" && since !== "";
}

/** The same question as a condition on `companies`, for a query that lists what is public. */
export const companyIsLive: SQL = sql`coalesce(${companies.settings}->>'verifiedAt', '') <> ''`;

/**
 * Makes a company live, or takes that back, in one statement on its settings, so a change the company makes to its
 * own settings at the same moment is never lost. A company that is already live keeps the time it went live.
 */
export async function setCompanyLive(q: Queryable, companyId: string, live: boolean, now: Date): Promise<void> {
  const settings = live
    ? sql`coalesce(${companies.settings}, '{}'::jsonb) || jsonb_build_object('verifiedAt', coalesce(nullif(${companies.settings}->>'verifiedAt', ''), ${now.toISOString()}::text))`
    : sql`coalesce(${companies.settings}, '{}'::jsonb) - 'verifiedAt'`;
  await q.update(companies).set({ settings }).where(eq(companies.id, companyId));
}
