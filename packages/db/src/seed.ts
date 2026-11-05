import { eq, and } from "drizzle-orm";
import { ALL_PLAYBOOKS } from "@ros/playbooks";
import type { Db } from "./client";
import { plans, playbooks } from "./schema";

export type PlanRow = { key: string; name: string; prices: Record<string, number>; limits: Record<string, number | null>; active: boolean };

/**
 * Every plan, and every number in them (the plans of 5 November 2026). A number is one edit here; the next deploy's first
 * boot writes it, and a company takes it the next time its plan is applied. A null limit means none.
 *
 * Every plan names every key of PLAN_LIMIT_KEYS, retired ones too (seed.test.ts pins it), because `applyPlan` writes only
 * the keys a plan lists and never clears another: a plan that left one out would keep an upgraded company on its old
 * limit. `voice_minutes` and `sourcing_contacts` are not built, so only the older plans carry them.
 *
 * Trial, Core, Growth and Company are retired, never deleted: companies and tests point at them, and `applyPlan` refuses a
 * plan that does not exist. `active: false` takes them off the console's list and refuses them on Change plan.
 */
export const PLAN_ROWS: readonly PlanRow[] = [
  {
    key: "free",
    name: "Free",
    prices: { monthlyUsd: 0 },
    limits: { active_roles: 1, jobs_total: 1, candidates_per_job: 5, text_screens: null, ai_credit_total_cents: 1000, ai_credit_monthly_cents: null, recruiter_asks: 1, seats: 2, its_work: 0 },
    active: true,
  },
  {
    key: "basic",
    name: "Basic",
    prices: { monthlyUsd: 49 },
    limits: { active_roles: 3, jobs_total: null, candidates_per_job: 25, text_screens: null, ai_credit_total_cents: null, ai_credit_monthly_cents: 2000, recruiter_asks: 1, seats: 3, its_work: 0 },
    active: true,
  },
  {
    key: "pro",
    name: "Pro",
    prices: { monthlyUsd: 149 },
    limits: { active_roles: 10, jobs_total: null, candidates_per_job: 100, text_screens: null, ai_credit_total_cents: null, ai_credit_monthly_cents: 6000, recruiter_asks: 3, seats: 10, its_work: null },
    active: true,
  },
  {
    key: "ultra",
    name: "Ultra",
    prices: { monthlyUsd: 399 },
    limits: { active_roles: 30, jobs_total: null, candidates_per_job: null, text_screens: null, ai_credit_total_cents: null, ai_credit_monthly_cents: 20000, recruiter_asks: 6, seats: null, its_work: null },
    active: true,
  },
  {
    // Founder decision F8: private, $0, three active roles, unlimited seats; never labeled a free trial; applied by a platform admin.
    key: "design_partner",
    name: "Design Partner",
    prices: { monthlyUsd: 0 },
    limits: { active_roles: 3, jobs_total: null, candidates_per_job: null, text_screens: 300, ai_credit_total_cents: null, ai_credit_monthly_cents: null, voice_minutes: 0, sourcing_contacts: 0, recruiter_asks: 10, seats: null, its_work: null },
    active: true,
  },
  {
    key: "trial",
    name: "Trial",
    prices: { monthlyUsd: 0 },
    limits: { active_roles: 1, jobs_total: null, candidates_per_job: null, text_screens: 25, ai_credit_total_cents: null, ai_credit_monthly_cents: null, voice_minutes: 0, sourcing_contacts: 0, recruiter_asks: 1, seats: 3, its_work: null },
    active: false,
  },
  {
    key: "core",
    name: "Core",
    prices: { monthlyUsd: 499, annualMonthlyUsd: 449 },
    limits: { active_roles: 2, jobs_total: null, candidates_per_job: null, text_screens: 150, ai_credit_total_cents: null, ai_credit_monthly_cents: null, voice_minutes: 0, sourcing_contacts: 0, recruiter_asks: 1, seats: null, its_work: null },
    active: false,
  },
  {
    key: "growth",
    name: "Growth",
    prices: { monthlyUsd: 899, annualMonthlyUsd: 799 },
    limits: { active_roles: 5, jobs_total: null, candidates_per_job: null, text_screens: 500, ai_credit_total_cents: null, ai_credit_monthly_cents: null, voice_minutes: 300, sourcing_contacts: 50, recruiter_asks: 3, seats: null, its_work: null },
    active: false,
  },
  {
    key: "company",
    name: "Company",
    prices: { monthlyUsd: 1499, annualMonthlyUsd: 1349 },
    limits: { active_roles: 12, jobs_total: null, candidates_per_job: null, text_screens: 1500, ai_credit_total_cents: null, ai_credit_monthly_cents: null, voice_minutes: 1000, sourcing_contacts: 200, recruiter_asks: 6, seats: null, its_work: null },
    active: false,
  },
];

/** Platform-level seed: plans and playbooks. Idempotent, and safe when two processes first boot together. Company-level defaults are created by core at signup. */
export async function seedPlatform(db: Db): Promise<void> {
  for (const p of PLAN_ROWS) {
    await db.insert(plans).values(p).onConflictDoUpdate({ target: plans.key, set: { name: p.name, prices: p.prices, limits: p.limits, active: p.active } });
  }

  for (const pb of ALL_PLAYBOOKS) {
    const existing = await db
      .select()
      .from(playbooks)
      .where(and(eq(playbooks.vertical, pb.vertical), eq(playbooks.version, pb.version)))
      .limit(1);
    if (existing.length === 0) await db.insert(playbooks).values({ vertical: pb.vertical, version: pb.version, content: pb, status: "published" });
    else await db.update(playbooks).set({ content: pb }).where(eq(playbooks.id, existing[0].id));
  }
}
