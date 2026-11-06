import { and, eq, inArray, sql } from "drizzle-orm";
import { ACCESS_REQUEST_STATUSES, FREE_PLAN_KEY, type Actor, type CreateCompany } from "@ros/contracts";
import { audit, emit, entitlements } from "@ros/core";
import { companies, events, memberships, users, withPlatform, type Db } from "@ros/db";
import type { Env } from "../env";
import { HttpError } from "../middleware/errors";
import { AUTO_CHECK_ACTOR, autoVerification } from "./company-trust";

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "company";
}

/** What a person who already has a company reads when they try to open another one themselves (founder decision L-17 A). */
export const ANOTHER_COMPANY_MESSAGE = "To open another company, contact ITS.";

/** What someone who may not open a company reads while sign-up is by invitation (GATE-V2, SIGNUP_MODE=invite). */
export const INVITE_ONLY_MESSAGE = "Recruiting OS is by invitation for now. Ask ITS for an invitation.";

/**
 * Whether this person may create a company (GATE-V2, GAP3-2). While sign-up is open anyone signed in may (founder
 * decision B7). By invitation or by approval, a platform admin may, as ITS always could, and so may an address
 * SIGNUP_ALLOWED_EMAILS names in full or by "@domain" (that domain only, not its subdomains), in any case. The address is
 * the one the identity service verified at sign-in.
 */
export function maySignUp(env: Pick<Env, "SIGNUP_MODE" | "SIGNUP_ALLOWED_EMAILS">, user: { email: string; platformRole: string }): boolean {
  if (env.SIGNUP_MODE === "open" || user.platformRole === "platform_admin") return true;
  const email = user.email.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at < 1) return false;
  return env.SIGNUP_ALLOWED_EMAILS.some((entry) => entry === email || entry === email.slice(at));
}

/**
 * Which door a signed-in person has: `direct` opens a company at once (`maySignUp`), `request` sends one for a platform
 * administrator to accept or decline (SIGNUP_MODE=approval, services/access-requests.ts), and `none` is the refusal of
 * SIGNUP_MODE=invite.
 */
export function signupDoor(env: Pick<Env, "SIGNUP_MODE" | "SIGNUP_ALLOWED_EMAILS">, user: { email: string; platformRole: string }): "direct" | "request" | "none" {
  if (maySignUp(env, user)) return "direct";
  return env.SIGNUP_MODE === "approval" ? "request" : "none";
}

/**
 * Creates the tenant, the owner membership, and the Free plan's entitlements, with no clock: a new company is on Free and
 * active until someone changes its plan (the plans of 5 November 2026). Runs in platform context because the tenant does
 * not exist yet. The company starts unconfirmed: nothing of it is public until ITS confirms it (founder decision B7),
 * unless `autoVerify` (COMPANY_CHECK=auto) confirms it at once, which is recorded like an ITS confirmation.
 *
 * `request` (SIGNUP_MODE=approval): the owner's membership starts as `requested`, not `active`, so they have no tenant and
 * every `requireTenant` route refuses them. A request is never confirmed by `autoVerify`, whatever COMPANY_CHECK says:
 * a request or a declined company is unconfirmed, so every public page and feed answers as if it did not exist.
 *
 * A second company of one's own goes through ITS (founder decision L-17 A, known bug 65): unless `mayOpenAnother` (a
 * platform admin setting a company up, as ITS always could), a person who already belongs to a company, has a request
 * waiting or declined, or already created one (and then left it), is refused with 409 `another_company_needs_its`. Taken
 * under a lock on the person, so two sign-ups sent at the same moment make one company. Someone invited to other companies
 * keeps the company switcher.
 */
export async function createCompany(db: Db, input: CreateCompany, ownerUserId: string, actor: Actor, opts: { autoVerify?: boolean; now?: Date; mayOpenAnother?: boolean; request?: boolean } = {}) {
  return withPlatform(db, async (tx) => {
    if (!opts.mayOpenAnother) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`company_create:${ownerUserId}`}))`);
      const [member] = await tx.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.userId, ownerUserId), inArray(memberships.status, ["active", ...ACCESS_REQUEST_STATUSES]))).limit(1);
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
    const confirmedAtOnce = !!opts.autoVerify && !opts.request;
    const ownerStatus = opts.request ? "requested" : "active";
    const [company] = await tx
      .insert(companies)
      .values({
        name: input.name,
        slug,
        vertical: input.vertical.toLowerCase(),
        sizeBand: input.sizeBand,
        timezone: input.timezone,
        locations: input.locations,
        settings: { website: input.website, careersPage: { enabled: true }, ...(confirmedAtOnce ? autoVerification(now) : {}) },
        planKey: FREE_PLAN_KEY,
        status: "active",
      })
      .returning();
    await tx.insert(memberships).values({ companyId: company.id, userId: ownerUserId, role: "owner", status: ownerStatus });
    if (input.ownerName) await tx.update(users).set({ name: input.ownerName }).where(eq(users.id, ownerUserId));
    await entitlements.applyPlan(tx, company.id, FREE_PLAN_KEY, "plan");
    await emit(tx, { type: "company.created", companyId: company.id, actor, subject: { type: "company", id: company.id }, payload: { name: company.name, vertical: company.vertical } });
    await emit(tx, { type: "membership.changed", companyId: company.id, actor, subject: { type: "user", id: ownerUserId }, payload: { role: "owner", status: ownerStatus } });
    if (confirmedAtOnce) {
      await emit(tx, { type: "company.verified", companyId: company.id, actor: AUTO_CHECK_ACTOR, subject: { type: "company", id: company.id }, payload: { how: "automatic" } });
      await audit(tx, { companyId: company.id, actor: AUTO_CHECK_ACTOR, action: "company.verified", target: { type: "company", id: company.id }, reason: "COMPANY_CHECK=auto: no ITS check in this environment" });
    }
    return company;
  });
}
