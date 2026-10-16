import { and, eq, sql } from "drizzle-orm";
import { newTrialTerm, type Actor, type CreateCompany } from "@ros/contracts";
import { audit, emit, entitlements } from "@ros/core";
import { companies, events, memberships, users, withPlatform, type Db } from "@ros/db";
import { HttpError } from "../middleware/errors";
import { AUTO_CHECK_ACTOR, autoVerification } from "./company-trust";

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "company";
}

/** What a person who already has a company reads when they try to open another one themselves (founder decision L-17 A). */
export const ANOTHER_COMPANY_MESSAGE = "To open another company, contact ITS.";

/**
 * Creates the tenant, the owner membership, and the trial entitlements. Runs in platform context because the tenant does
 * not exist yet. The company starts unconfirmed: nothing of it is public until ITS confirms it (founder decision B7),
 * unless `autoVerify` (COMPANY_CHECK=auto) confirms it at once, which is recorded like an ITS confirmation and starts the
 * Trial plan's 30 days as the ITS check does (founder decision L-02 B).
 *
 * A second company of one's own goes through ITS (founder decision L-17 A, known bug 65): unless `mayOpenAnother` (a
 * platform admin setting a company up, as ITS always could), a person who already belongs to a company, or already
 * created one (and then left it), is refused with 409 `another_company_needs_its`. Taken under a lock on the person, so
 * two sign-ups sent at the same moment make one company. Someone invited to other companies keeps the company switcher.
 */
export async function createCompany(db: Db, input: CreateCompany, ownerUserId: string, actor: Actor, opts: { autoVerify?: boolean; now?: Date; mayOpenAnother?: boolean } = {}) {
  return withPlatform(db, async (tx) => {
    if (!opts.mayOpenAnother) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`company_create:${ownerUserId}`}))`);
      const [member] = await tx.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.userId, ownerUserId), eq(memberships.status, "active"))).limit(1);
      // "Created one, then left": the company.created event names its creator (events_type index), whatever their membership is now.
      const [created] = member ? [] : await tx.select({ id: events.id }).from(events).where(and(eq(events.type, "company.created"), sql`${events.actor}->>'id' = ${ownerUserId}`)).limit(1);
      if (member || created) throw new HttpError(409, "another_company_needs_its", ANOTHER_COMPANY_MESSAGE);
    }
    let slug = slugify(input.name);
    for (let i = 0; i < 20; i++) {
      const taken = await tx.select({ id: companies.id }).from(companies).where(eq(companies.slug, slug)).limit(1);
      if (!taken[0]) break;
      slug = `${slugify(input.name)}-${Math.random().toString(36).slice(2, 6)}`;
    }
    const now = opts.now ?? new Date();
    const [company] = await tx
      .insert(companies)
      .values({
        name: input.name,
        slug,
        vertical: input.vertical.toLowerCase(),
        sizeBand: input.sizeBand,
        timezone: input.timezone,
        locations: input.locations,
        settings: { website: input.website, careersPage: { enabled: true }, ...(opts.autoVerify ? { ...autoVerification(now), trial: newTrialTerm(now, "its_check") } : {}) },
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
      const trial = company.settings.trial;
      if (trial) await emit(tx, { type: "trial.started", companyId: company.id, actor: AUTO_CHECK_ACTOR, subject: { type: "company", id: company.id }, payload: { startedAt: trial.startedAt, endsAt: trial.endsAt, startedBy: trial.startedBy } });
    }
    return company;
  });
}
