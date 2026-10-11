import { eq } from "drizzle-orm";
import type { Actor, CreateCompany } from "@ros/contracts";
import { audit, emit, entitlements } from "@ros/core";
import { companies, memberships, users, withPlatform, type Db } from "@ros/db";
import { AUTO_CHECK_ACTOR, autoVerification } from "./company-trust";

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "company";
}

/**
 * Creates the tenant, the owner membership, and the trial entitlements. Runs in platform context because the tenant does
 * not exist yet. The company starts unconfirmed: nothing of it is public until ITS confirms it (founder decision B7),
 * unless `autoVerify` (COMPANY_CHECK=auto) confirms it at once, which is recorded like an ITS confirmation.
 */
export async function createCompany(db: Db, input: CreateCompany, ownerUserId: string, actor: Actor, opts: { autoVerify?: boolean; now?: Date } = {}) {
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
        settings: { website: input.website, careersPage: { enabled: true }, ...(opts.autoVerify ? autoVerification(opts.now ?? new Date()) : {}) },
        planKey: "trial",
        status: "trial",
      })
      .returning();
    await tx.insert(memberships).values({ companyId: company.id, userId: ownerUserId, role: "owner", status: "active" });
    if (input.ownerName) await tx.update(users).set({ name: input.ownerName }).where(eq(users.id, ownerUserId));
    await entitlements.applyPlan(tx, company.id, "trial", "trial");
    await emit(tx, { type: "company.created", companyId: company.id, actor, subject: { type: "company", id: company.id }, payload: { name: company.name, vertical: company.vertical } });
    await emit(tx, { type: "membership.changed", companyId: company.id, actor, subject: { type: "user", id: ownerUserId }, payload: { role: "owner", status: "active" } });
    if (opts.autoVerify) {
      await emit(tx, { type: "company.verified", companyId: company.id, actor: AUTO_CHECK_ACTOR, subject: { type: "company", id: company.id }, payload: { how: "automatic" } });
      await audit(tx, { companyId: company.id, actor: AUTO_CHECK_ACTOR, action: "company.verified", target: { type: "company", id: company.id }, reason: "COMPANY_CHECK=auto: no ITS check in this environment" });
    }
    return company;
  });
}
