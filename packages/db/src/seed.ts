import { eq, and } from "drizzle-orm";
import { ALL_PLAYBOOKS } from "@ros/playbooks";
import type { Db } from "./client";
import { plans, playbooks } from "./schema";

/** Platform-level seed: plans and playbooks. Idempotent. Company-level defaults are created by core at signup. */
export async function seedPlatform(db: Db): Promise<void> {
  const planRows: Array<{ key: string; name: string; prices: Record<string, number>; limits: Record<string, number | null> }> = [
    {
      // Founder decision F8: private, $0, three active roles, unlimited seats; never labeled a free trial; applied by a platform admin.
      key: "design_partner",
      name: "Design Partner",
      prices: { monthlyUsd: 0 },
      limits: { active_roles: 3, text_screens: 300, voice_minutes: 0, sourcing_contacts: 0, recruiter_asks: 10, seats: null },
    },
    {
      key: "trial",
      name: "Trial",
      prices: { monthlyUsd: 0 },
      limits: { active_roles: 1, text_screens: 25, voice_minutes: 0, sourcing_contacts: 0, recruiter_asks: 1, seats: 3 },
    },
    {
      key: "core",
      name: "Core",
      prices: { monthlyUsd: 499, annualMonthlyUsd: 449 },
      limits: { active_roles: 2, text_screens: 150, voice_minutes: 0, sourcing_contacts: 0, recruiter_asks: 1, seats: null },
    },
    {
      key: "growth",
      name: "Growth",
      prices: { monthlyUsd: 899, annualMonthlyUsd: 799 },
      limits: { active_roles: 5, text_screens: 500, voice_minutes: 300, sourcing_contacts: 50, recruiter_asks: 3, seats: null },
    },
    {
      key: "company",
      name: "Company",
      prices: { monthlyUsd: 1499, annualMonthlyUsd: 1349 },
      limits: { active_roles: 12, text_screens: 1500, voice_minutes: 1000, sourcing_contacts: 200, recruiter_asks: 6, seats: null },
    },
  ];
  for (const p of planRows) {
    const existing = await db.select().from(plans).where(eq(plans.key, p.key)).limit(1);
    if (existing.length === 0) await db.insert(plans).values(p);
    else await db.update(plans).set({ name: p.name, prices: p.prices, limits: p.limits }).where(eq(plans.key, p.key));
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
