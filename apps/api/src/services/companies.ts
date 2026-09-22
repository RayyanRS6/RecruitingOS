import { eq } from "drizzle-orm";
import type { Actor, CreateCompany } from "@ros/contracts";
import { emit, entitlements } from "@ros/core";
import { companies, memberships, users, withPlatform, type Db } from "@ros/db";

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "company";
}

/** Creates the tenant, the owner membership, and the trial entitlements. Runs in platform context because the tenant does not exist yet. */
export async function createCompany(db: Db, input: CreateCompany, ownerUserId: string, actor: Actor) {
  return withPlatform(db, async (tx) => {
    let slug = slugify(input.name);
    for (let i = 0; i < 20; i++) {
      const taken = await tx.select({ id: companies.id }).from(companies).where(eq(companies.slug, slug)).limit(1);
      if (!taken[0]) break;
      slug = `${slugify(input.name)}-${Math.random().toString(36).slice(2, 6)}`;
    }
    const [company] = await tx
      .insert(companies)
      .values({
        name: input.name,
        slug,
        vertical: input.vertical.toLowerCase(),
        sizeBand: input.sizeBand,
        timezone: input.timezone,
        locations: input.locations,
        settings: { website: input.website, careersPage: { enabled: true } },
        planKey: "trial",
        status: "trial",
      })
      .returning();
    await tx.insert(memberships).values({ companyId: company.id, userId: ownerUserId, role: "owner", status: "active" });
    if (input.ownerName) await tx.update(users).set({ name: input.ownerName }).where(eq(users.id, ownerUserId));
    await entitlements.applyPlan(tx, company.id, "trial", "trial");
    await emit(tx, { type: "company.created", companyId: company.id, actor, subject: { type: "company", id: company.id }, payload: { name: company.name, vertical: company.vertical } });
    await emit(tx, { type: "membership.changed", companyId: company.id, actor, subject: { type: "user", id: ownerUserId }, payload: { role: "owner", status: "active" } });
    return company;
  });
}
