import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import { CreateCompany, InviteMember, UpdateMember, limitsForCustomers, trialStanding } from "@ros/contracts";
import { aiCreditView, assertCan, entitlements, setActiveCompany } from "@ros/core";
import { companies, plans, withTenant } from "@ros/db";
import { POLICIES, checkRateLimits } from "../middleware/rate-limit";
import { actorOf, requireTenant, requireUser, type Vars } from "../middleware/session";
import { sendAccessRequest } from "../services/access-requests";
import { INVITE_ONLY_MESSAGE, createCompany, signupDoor } from "../services/companies";
import { candidateEmailHealth } from "../services/email-health";
import { tellItsAboutNewCompany } from "../services/company-trust";
import { inviteMember, leaveCompany, listInvitations, listTeam, resendMemberInvitation, revokeMemberInvitation, updateMember } from "../services/team";
import { HttpError } from "../middleware/errors";

export const companyRoutes = new Hono<Vars>();

/**
 * Open sign-up (founder decision B7): anyone signed in who has no company yet may create one and draft and approve roles
 * at once. Its public side waits for the one-time ITS check, so the ITS queue is told here (COMPANY_CHECK=auto confirms
 * it instead). A second company of one's own goes through ITS (founder decision L-17 A, known bug 65): a person who
 * already belongs to a company, or already created one, is refused with 409 `another_company_needs_its` ("To open
 * another company, contact ITS."). A platform admin sets companies up as before; someone invited to several companies
 * keeps the company switcher. The body is checked before that rule, so a bad one still answers 400.
 *
 * By invitation (GATE-V2, SIGNUP_MODE=invite) only a platform admin or an address on SIGNUP_ALLOWED_EMAILS may create a
 * company: anyone else is refused with 403 `signup_invite_only` before the body is read. Signing in and joining a
 * company by invitation are untouched.
 *
 * By approval (SIGNUP_MODE=approval) those two still go in directly; anyone else signed in sends a request
 * (services/access-requests.ts): no active company, no workflow and no public side until a platform administrator
 * accepts. The answer is the company with `accessRequest`, and a body that is bad, or a second request, answers as above.
 * One address sends five requests an hour at most (429 `rate_limited`), whichever accounts it signs in with.
 */
companyRoutes.post("/", requireUser, async (c) => {
  const s = c.get("session")!;
  const container = c.get("container");
  const door = signupDoor(container.env, s.user);
  if (door === "none") throw new HttpError(403, "signup_invite_only", INVITE_ONLY_MESSAGE);
  const body = CreateCompany.parse(await c.req.json());
  if (door === "request") {
    // five requests an hour from one address, whoever is signed in: the door's own limit (POLICIES.accessRequest)
    const refused = await checkRateLimits(c, [POLICIES.accessRequest]);
    if (refused) return refused;
    return c.json(await sendAccessRequest(container, { body, user: s.user, actor: actorOf(c) }), 201);
  }
  const autoVerify = container.env.COMPANY_CHECK === "auto";
  const company = await createCompany(container.db, body, s.user.id, actorOf(c), { autoVerify, now: container.engine.clock(), mayOpenAnother: s.user.platformRole === "platform_admin" });
  await setActiveCompany(container.db, s.sessionId, company.id);
  await withTenant(container.db, company.id, (tx) => container.engine.start(tx, { workflowKey: "stuck_role_detector", companyId: company.id, subject: { type: "company", id: company.id }, state: { companyId: company.id }, idempotencyKey: `stuck_role_detector:${company.id}`, actor: actorOf(c) }));
  if (!autoVerify) await tellItsAboutNewCompany(container, { company: { id: company.id, name: company.name, vertical: company.vertical, sizeBand: company.sizeBand, website: body.website ?? null }, owner: { name: body.ownerName ?? s.user.name ?? null, email: s.user.email } });
  await container.kick();
  return c.json(company, 201);
});

companyRoutes.get("/current", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "company.read");
  const container = c.get("container");
  const now = container.engine.clock();
  const row = await withTenant(container.db, t.companyId, async (tx) => {
    const [co] = await tx.select().from(companies).where(eq(companies.id, t.companyId)).limit(1);
    const [plan] = await tx.select().from(plans).where(eq(plans.key, co.planKey)).limit(1);
    // Roles are counted from the roles using a place now, so closing one shows its place free again (polish list); people
    // from the members and the invitations not yet answered (known bug 128). The AI credit is money: a percentage in the
    // usage and nothing in the limits, because customers never read it in dollars.
    const usage = await entitlements.usageOf(tx, t.companyId, { now });
    // Home's row about the AI credit: its level, its percentage and its words; null when the plan puts no limit on it.
    const aiCredit = await aiCreditView(tx, t.companyId, { now, timeZone: co.timezone, planKey: co.planKey });
    // Whether email to candidates is really arriving, from the last week's sends (6 November 2026): what Settings says beside
    // the email service, instead of "connected" because a key exists. Counts only, never anyone the team may not read.
    const candidateEmail = await candidateEmailHealth(tx, { companyId: t.companyId, now });
    // Where the Trial plan's 30 days stand (founder decision L-02 B); null on any other plan.
    return { ...co, plan: plan ? { key: plan.key, name: plan.name, limits: limitsForCustomers(plan.limits) } : null, usage, aiCredit, trial: trialStanding(co, now), candidateEmail };
  });
  // `production`: NODE_ENV is production (staging too), where a service running without a provider ("fake") is a
  // deliberate default rather than a development stand-in, and Settings says what it does instead (audit MAIL-18).
  return c.json({ ...row, integrations: container.integrations.statuses(), ai: { provider: container.ai.provider.id }, production: container.env.NODE_ENV === "production" });
});

// PATCH /current (the typed company preferences), GET /current/audit and /current/audit.csv (the customer's own history)
// and POST /current/members/:userId/sign-out live in routes/company-settings.ts, mounted after this router.

/** The team (docs/spec/21, area A): active members with their scheduling readiness; never a credential or its reference. */
companyRoutes.get("/current/members", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "company.read");
  return c.json(await listTeam({ tenant: t, container: c.get("container") }));
});

/**
 * Open invitations: who was asked, as what, by whom, and until when. Only those who manage the team (members.manage:
 * owners and admins) see them (audit 01-platform B11): a member has no use for invitees'
 * addresses and intended roles, and gets the same 403 as for any other team change.
 */
companyRoutes.get("/current/invitations", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "members.manage");
  return c.json(await listInvitations({ tenant: t, container: c.get("container") }));
});

const teamOf = (c: Context<Vars>) => ({ tenant: c.get("tenant")!, actor: actorOf(c), container: c.get("container"), session: c.get("session") });
const inviterNameOf = (c: Context<Vars>) => c.get("session")!.user.name ?? c.get("session")!.user.email;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A path id that is not even a uuid names nothing: a 404 in the route's own words, never a database error. */
function idParam(c: Context<Vars>, name: string, message: string): string {
  const value = c.req.param(name) ?? "";
  if (!UUID.test(value)) throw new HttpError(404, "not_found", message);
  return value;
}

/**
 * Invites someone by email: one message through the outbox with a link to the invitation page, where they sign in with
 * Google or Microsoft using the invited address. Mounted on both spellings of the path.
 */
async function invite(c: Context<Vars>) {
  const t = c.get("tenant")!;
  assertCan(t.role, "members.manage");
  const body = InviteMember.parse(await c.req.json());
  return c.json(await inviteMember(teamOf(c), { body, inviterName: inviterNameOf(c) }), 201);
}
companyRoutes.post("/current/members/invite", requireTenant, invite);
companyRoutes.post("/current/invites", requireTenant, invite);

/**
 * A fresh link and the email again; with `{ email: false }` the fresh link alone (6 November 2026), answered for the person
 * to copy and send themselves, because the email did not arrive. Either way the old link stops working.
 */
companyRoutes.post("/current/invitations/:id/resend", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "members.manage");
  const body = (await c.req.json().catch(() => ({}))) as { email?: unknown };
  return c.json(await resendMemberInvitation(teamOf(c), { invitationId: idParam(c, "id", "No open invitation with that id."), inviterName: inviterNameOf(c), email: body.email !== false }));
});

companyRoutes.post("/current/invitations/:id/revoke", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "members.manage");
  return c.json(await revokeMemberInvitation(teamOf(c), { invitationId: idParam(c, "id", "No open invitation with that id.") }));
});

/** A role change or a removal; the rules live in services/team.ts. Either ends the person's sessions so it applies at once. */
companyRoutes.patch("/current/members/:userId", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "members.manage");
  const body = UpdateMember.parse(await c.req.json());
  return c.json(await updateMember(teamOf(c), { userId: idParam(c, "userId", "That person is not an active member of your team."), body }));
});

/**
 * "Leave this company" (founder decision L-10): any member, for themselves, with `{ confirm: true }`; an owner only while
 * another owner remains (409 `last_owner`). Answers `{ ok, left, movedTo, signedOut, ... }`: this session moves to the
 * person's other company (`movedTo`), or, with none, they are signed out. The rules live in services/team.ts.
 */
companyRoutes.post("/current/leave", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "company.read");
  const body = (await c.req.json().catch(() => ({}))) as { confirm?: unknown };
  if (body.confirm !== true) throw new HttpError(400, "confirmation_required", "Confirm that you want to leave this company.");
  return c.json(await leaveCompany(teamOf(c), { sessionId: c.get("session")!.sessionId }));
});
