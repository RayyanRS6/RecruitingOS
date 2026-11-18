import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { ACCESS_REQUEST_STATUSES, FREE_PLAN_KEY, type Actor, type CreateCompany } from "@ros/contracts";
import { emit, entitlements, setCompanyLive } from "@ros/core";
import { companies, events, memberships, users, withPlatform, type Db, type Queryable } from "@ros/db";
import type { Env } from "../env";
import { HttpError } from "../middleware/errors";

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "company";
}

/**
 * A careers address no other company holds: `base`, or, when that is taken, `base` with four characters more. `exceptId`:
 * the company the address is for, which may hold it already.
 *
 * Under a lock on `base` held until the caller's transaction ends, as both callers write the address in the same
 * transaction (`createCompany`, Accept in `decideAccess`): two companies of one name made or accepted at the same moment
 * would otherwise both read it as free, and the second would fail on the unique index. The second waits, then reads the
 * first's address as taken. Neither holds a row the other needs, so the wait cannot turn into a cycle.
 */
export async function freeSlug(q: Queryable, base: string, exceptId?: string): Promise<string> {
  await q.execute(sql`select pg_advisory_xact_lock(hashtext(${`company_slug:${base}`}))`);
  let slug = base;
  for (let i = 0; i < 20; i++) {
    const taken = await q.select({ id: companies.id }).from(companies).where(exceptId ? and(eq(companies.slug, slug), ne(companies.id, exceptId)) : eq(companies.slug, slug)).limit(1);
    if (!taken[0]) break;
    slug = `${base}-${Math.random().toString(36).slice(2, 6)}`;
  }
  return slug;
}

/**
 * The address a request holds until it is accepted: "request-" and the start of its id, never one of its name, so a
 * stranger cannot take a real company's careers address, and a Decline keeps none. Nothing of a request answers in
 * public, so no link to it can exist; Accept gives it the address of its name (`decideAccess`).
 */
export function requestSlug(companyId: string): string {
  return `request-${companyId.slice(0, 8)}`;
}

/** What a person who already has a company reads when they try to open another one themselves. */
const ANOTHER_COMPANY_MESSAGE = "To open another company, contact ITS.";

/**
 * Which door a signed-in person has. `direct`: their company is live the moment it is created, where sign-up is open
 * (SIGNUP_MODE=open: a person's machine and the tests) and for a platform administrator setting a company up. `request`
 * (SIGNUP_MODE=approval): their company starts as a request an administrator accepts or declines
 * (services/access-requests.ts).
 */
export function signupDoor(env: Pick<Env, "SIGNUP_MODE">, user: { platformRole: string }): "direct" | "request" {
  return env.SIGNUP_MODE === "open" || user.platformRole === "platform_admin" ? "direct" : "request";
}

/**
 * Creates the company, its owner's membership and the Free plan's entitlements, with no clock: a new company is on Free
 * until an administrator changes its plan. Runs in platform context because the company does not exist yet.
 *
 * Through the direct door the owner's membership is `active` and the company is live at once. As a `request` the
 * membership is `requested`, so the owner has no company to work in and every `requireTenant` route refuses them, the
 * company is not live, and it holds a neutral address (`requestSlug`) until an administrator accepts it.
 *
 * A second company of one's own goes through ITS: unless `mayOpenAnother` (a platform administrator setting a company
 * up), a person who already belongs to a company, has a request waiting or declined, or already created one (and then
 * left it), is refused with 409 `another_company_needs_its`. Taken under a lock on the person, so two sign-ups sent at
 * the same moment make one company. Someone invited to other companies keeps the company switcher.
 */
export async function createCompany(db: Db, input: CreateCompany, ownerUserId: string, actor: Actor, opts: { now?: Date; mayOpenAnother?: boolean; request?: boolean } = {}) {
  return withPlatform(db, async (tx) => {
    if (!opts.mayOpenAnother) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`company_create:${ownerUserId}`}))`);
      const [member] = await tx.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.userId, ownerUserId), inArray(memberships.status, ["active", ...ACCESS_REQUEST_STATUSES]))).limit(1);
      // "Created one, then left": the company.created event names its creator, whatever their membership is now.
      const [created] = member ? [] : await tx.select({ id: events.id }).from(events).where(and(eq(events.type, "company.created"), sql`${events.actor}->>'id' = ${ownerUserId}`)).limit(1);
      if (member || created) throw new HttpError(409, "another_company_needs_its", ANOTHER_COMPANY_MESSAGE);
    }
    const id = randomUUID();
    const slug = await freeSlug(tx, opts.request ? requestSlug(id) : slugify(input.name));
    const ownerStatus = opts.request ? "requested" : "active";
    const [company] = await tx
      .insert(companies)
      .values({ id, name: input.name, slug, vertical: input.vertical.toLowerCase(), sizeBand: input.sizeBand, timezone: input.timezone, locations: input.locations, settings: { website: input.website }, planKey: FREE_PLAN_KEY })
      .returning();
    await tx.insert(memberships).values({ companyId: company.id, userId: ownerUserId, role: "owner", status: ownerStatus });
    if (input.ownerName) await tx.update(users).set({ name: input.ownerName }).where(eq(users.id, ownerUserId));
    await entitlements.applyPlan(tx, company.id, FREE_PLAN_KEY, "plan");
    if (!opts.request) await setCompanyLive(tx, company.id, true, opts.now ?? new Date());
    await emit(tx, { type: "company.created", companyId: company.id, actor, subject: { type: "company", id: company.id }, payload: { name: company.name, vertical: company.vertical } });
    await emit(tx, { type: "membership.changed", companyId: company.id, actor, subject: { type: "user", id: ownerUserId }, payload: { role: "owner", status: ownerStatus } });
    return company;
  });
}
