import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { PLAN_LIMIT_KEYS, PUBLIC_PLAN_KEYS } from "@ros/contracts";
import { createDb, type DbHandle } from "./client";
import { migrate } from "./migrate";
import { plans } from "./schema";
import { PLAN_ROWS, seedPlatform } from "./seed";

const byKey = (key: string) => PLAN_ROWS.find((p) => p.key === key)!;

/**
 * The plans of 5 November 2026. `applyPlan` writes only the keys a plan lists and never clears another, so a plan that
 * left a key out would keep an upgraded company on its old limit: a paying customer stuck at one job, or stuck locked.
 */
describe("the plan rows", () => {
  it("every plan names every limit key, retired ones too", () => {
    for (const p of PLAN_ROWS) expect(Object.keys(p.limits).filter((k) => (PLAN_LIMIT_KEYS as readonly string[]).includes(k)).sort(), p.key).toEqual([...PLAN_LIMIT_KEYS].sort());
  });

  it("names no other key, except the two the older plans carry and nothing has built", () => {
    for (const p of PLAN_ROWS) {
      const others = Object.keys(p.limits).filter((k) => !(PLAN_LIMIT_KEYS as readonly string[]).includes(k)).sort();
      expect(others, p.key).toEqual((PUBLIC_PLAN_KEYS as readonly string[]).includes(p.key) ? [] : ["sourcing_contacts", "voice_minutes"]);
    }
  });

  it("holds the four public plans at the numbers decided", () => {
    expect(byKey("free")).toEqual({ key: "free", name: "Free", prices: { monthlyUsd: 0 }, active: true, limits: { active_roles: 1, jobs_total: 1, candidates_per_job: 5, text_screens: null, ai_credit_total_cents: 1000, ai_credit_monthly_cents: null, recruiter_asks: 1, seats: 2, its_work: 0 } });
    expect(byKey("basic")).toEqual({ key: "basic", name: "Basic", prices: { monthlyUsd: 49 }, active: true, limits: { active_roles: 3, jobs_total: null, candidates_per_job: 25, text_screens: null, ai_credit_total_cents: null, ai_credit_monthly_cents: 2000, recruiter_asks: 1, seats: 3, its_work: 0 } });
    expect(byKey("pro")).toEqual({ key: "pro", name: "Pro", prices: { monthlyUsd: 149 }, active: true, limits: { active_roles: 10, jobs_total: null, candidates_per_job: 100, text_screens: null, ai_credit_total_cents: null, ai_credit_monthly_cents: 6000, recruiter_asks: 3, seats: 10, its_work: null } });
    expect(byKey("ultra")).toEqual({ key: "ultra", name: "Ultra", prices: { monthlyUsd: 399 }, active: true, limits: { active_roles: 30, jobs_total: null, candidates_per_job: null, text_screens: null, ai_credit_total_cents: null, ai_credit_monthly_cents: 20000, recruiter_asks: 6, seats: null, its_work: null } });
  });

  it("the older plans keep their numbers and have no new limit", () => {
    const old = { design_partner: [3, 300, 10, null], trial: [1, 25, 1, 3], core: [2, 150, 1, null], growth: [5, 500, 3, null], company: [12, 1500, 6, null] };
    for (const [key, [roles, screens, asks, seats]] of Object.entries(old)) {
      expect(byKey(key).limits, key).toMatchObject({ active_roles: roles, text_screens: screens, recruiter_asks: asks, seats, jobs_total: null, candidates_per_job: null, ai_credit_total_cents: null, ai_credit_monthly_cents: null, its_work: null });
    }
  });

  it("retires Trial, Core, Growth and Company; Design Partner stays active and is never public", () => {
    expect(PLAN_ROWS.filter((p) => !p.active).map((p) => p.key).sort()).toEqual(["company", "core", "growth", "trial"]);
    expect(byKey("design_partner").active).toBe(true);
    expect(PUBLIC_PLAN_KEYS).not.toContain("design_partner");
    expect(PLAN_ROWS).toHaveLength(9);
  });
});

describe("seedPlatform", () => {
  let handle: DbHandle;

  beforeAll(async () => {
    handle = await createDb({ pgliteDir: "memory://" });
    await migrate(handle);
  });
  afterAll(async () => {
    await handle.close();
  });

  const row = async (key: string) => (await handle.db.select().from(plans).where(eq(plans.key, key)))[0];

  it("writes the nine rows with their active flags", async () => {
    await seedPlatform(handle.db);
    const all = await handle.db.select().from(plans);
    expect(all.map((p) => p.key).sort()).toEqual(PLAN_ROWS.map((p) => p.key).sort());
    for (const p of PLAN_ROWS) expect(await row(p.key), p.key).toMatchObject({ name: p.name, prices: p.prices, limits: p.limits, active: p.active });
  });

  it("runs again over rows that drifted, putting back the numbers and the flag, and keeps each row's id", async () => {
    const before = await row("growth");
    await handle.db.update(plans).set({ active: true, limits: { active_roles: 99 }, name: "Old name" }).where(eq(plans.key, "growth"));
    await handle.db.update(plans).set({ active: false }).where(eq(plans.key, "free"));
    await seedPlatform(handle.db);
    expect(await row("growth")).toMatchObject({ id: before.id, name: "Growth", active: false, limits: byKey("growth").limits });
    expect((await row("free")).active).toBe(true);
    expect(await handle.db.select().from(plans)).toHaveLength(PLAN_ROWS.length);
  });

  it("two boots at the same moment both succeed: the second updates what the first inserted", async () => {
    await handle.db.delete(plans);
    await Promise.all([seedPlatform(handle.db), seedPlatform(handle.db)]);
    expect(await handle.db.select().from(plans)).toHaveLength(PLAN_ROWS.length);
  });
});
