import { Hono, type Context } from "hono";
import { CreateCompany, InviteMember, LeaveCompany, UpdateMember, type CompanyCreated } from "@ros/contracts";
import { assertCan, setActiveCompany } from "@ros/core";
import { POLICIES, checkRateLimits } from "../middleware/rate-limit";
import { actorOf, requireTenant, requireUser, type Vars } from "../middleware/session";
import { sendAccessRequest } from "../services/access-requests";
import { createCompany, signupDoor } from "../services/companies";
import { companyView } from "../services/company-settings-profile";
import { inviteMember, leaveCompany, resendMemberInvitation, revokeMemberInvitation, teamView, updateMember } from "../services/team";
import { HttpError } from "../middleware/errors";

/**
 * The company itself and its team: the company details form, the company as Settings reads it, and the people.
 * routes/company-settings.ts, mounted on the same address, changes the company's details.
 */
export const companyRoutes = new Hono<Vars>();

/**
 * The company details form. By approval (SIGNUP_MODE=approval, production) anyone signed in sends a request
 * (services/access-requests.ts): no company to work in, no workflow and nothing public until a platform administrator
 * accepts it, and the answer carries `accessRequest`. One address sends five requests an hour at most (429
 * `rate_limited`), whichever accounts it signs in with. Where sign-up is open (a person's machine and the tests), and for
 * a platform administrator setting a company up, the company is live the moment it is created.
 *
 * A second company of one's own goes through ITS: a person who already belongs to a company, has a request waiting or
 * declined, or already created one, is refused with 409 `another_company_needs_its`. Someone invited to several
 * companies keeps the company switcher. The body is checked before that rule, so a bad one still answers 400.
 */
companyRoutes.post("/", requireUser, async (c) => {
  const s = c.get("session")!;
  const container = c.get("container");
  const body = CreateCompany.parse(await c.req.json());
  if (signupDoor(container.env, s.user) === "request") {
    // five requests an hour from one address, whoever is signed in: the door's own limit (POLICIES.accessRequest)
    const refused = await checkRateLimits(c, [POLICIES.accessRequest]);
    if (refused) return refused;
    return c.json(await sendAccessRequest(container, { body, user: s.user, actor: actorOf(c) }), 201);
  }
  const company = await createCompany(container.db, body, s.user.id, actorOf(c), { now: container.engine.clock(), mayOpenAnother: s.user.platformRole === "platform_admin" });
  await setActiveCompany(container.db, s.sessionId, company.id);
  const created: CompanyCreated = { id: company.id, name: company.name, accessRequest: null };
  return c.json(created, 201);
});

/** The company as its own people read it in Settings: its details, what candidates see about it, and its plan. */
companyRoutes.get("/current", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "company.read");
  return c.json(await companyView(c.get("container"), t));
});

/** The team: its people, the invitations still open, the plan's people, and what the person looking may do. */
companyRoutes.get("/current/members", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "company.read");
  return c.json(await teamView({ tenant: t, container: c.get("container") }));
});

/** The team's managers (owners and admins), with what the team rules need of the request. */
function managing(c: Context<Vars>) {
  const tenant = c.get("tenant")!;
  assertCan(tenant.role, "members.manage");
  return { tenant, actor: actorOf(c), container: c.get("container"), session: c.get("session") };
}
const inviterNameOf = (c: Context<Vars>) => c.get("session")!.user.name ?? c.get("session")!.user.email;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A path id that is not even a uuid names nothing: a 404 in the route's own words, never a database error. */
function idParam(c: Context<Vars>, name: string, message: string): string {
  const value = c.req.param(name) ?? "";
  if (!UUID.test(value)) throw new HttpError(404, "not_found", message);
  return value;
}

/**
 * Invites someone by email, as an Admin or a Member (an owner may also invite an Owner): one message through the outbox
 * with a link to the invitation page, where they sign in with Google or Microsoft using the invited address. The answer
 * carries the same link, for the person to copy when the email does not arrive.
 */
companyRoutes.post("/current/members/invite", requireTenant, async (c) => {
  const team = managing(c);
  const body = InviteMember.parse(await c.req.json());
  return c.json(await inviteMember(team, { body, inviterName: inviterNameOf(c) }), 201);
});

/** A fresh link and the email again; the old link stops working. */
companyRoutes.post("/current/invitations/:id/resend", requireTenant, async (c) => {
  const team = managing(c);
  return c.json(await resendMemberInvitation(team, { invitationId: idParam(c, "id", "No open invitation with that id."), inviterName: inviterNameOf(c) }));
});

companyRoutes.post("/current/invitations/:id/revoke", requireTenant, async (c) => {
  const team = managing(c);
  return c.json(await revokeMemberInvitation(team, { invitationId: idParam(c, "id", "No open invitation with that id.") }));
});

/** A role change or a removal; the rules live in services/team.ts. Either ends the person's sessions here so it applies at once. */
companyRoutes.patch("/current/members/:userId", requireTenant, async (c) => {
  const team = managing(c);
  const body = UpdateMember.parse(await c.req.json());
  return c.json(await updateMember(team, { userId: idParam(c, "userId", "That person is not an active member of your team."), body }));
});

/**
 * "Leave this company": any member, for themselves, with `{ confirm: true }`; an owner only while another owner remains
 * (409 `last_owner`). This session moves to the person's other company (`movedTo`), or, with none, they are signed out.
 */
companyRoutes.post("/current/leave", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "company.read");
  LeaveCompany.parse(await c.req.json().catch(() => ({})));
  return c.json(await leaveCompany({ tenant: t, actor: actorOf(c), container: c.get("container"), session: c.get("session") }, { sessionId: c.get("session")!.sessionId }));
});
