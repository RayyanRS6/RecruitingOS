import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import type { InviteAnswer, MemberChanged, TeamView } from "@ros/contracts";
import { applications, auditRecords, candidates, communications, events, invitations, memberships, notifications, randomToken, users, withPlatform, withTenant } from "@ros/db";
import type { FakeEmailAdapter, FakeIdentityProvider } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { plantJob, signInAs, signInWithIdentity, usePlan, useTrial } from "./test-helpers";

/**
 * Team invitations, members and per-role permissions (docs/spec/21, area A, and section 7 P0): an invitation is a row
 * accepted by a Google or Microsoft sign-in with the invited address (never by an email-link session on its own);
 * member updates are validated with a last-owner guard; removal ends sessions; the team is read as one answer that
 * says what the person looking may do; and every role is exercised over HTTP.
 */
describe("team invitations, members and roles", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  const idp = () => container.integrations.identity as FakeIdentityProvider;
  const mail = () => container.integrations.email as unknown as FakeEmailAdapter;
  const json = (cookie: string, method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  /** The JSON sign-in route, optionally carrying cookies (the sealed invitation, for instance). */
  const session = (accessToken: string, cookie?: string) =>
    app.request("/api/v1/auth/session", { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ accessToken }) });
  const setCookies = (r: Response) => r.headers.getSetCookie();
  const cookieNamed = (r: Response, name: string) => setCookies(r).find((c) => c.startsWith(`${name}=`))?.split(";")[0] ?? null;
  const cleared = (r: Response, name: string) => setCookies(r).some((c) => c.startsWith(`${name}=`) && /max-age=0/i.test(c));
  const pathOf = (link: string) => link.replace(container.env.APP_BASE_URL, "");
  const me = async (cookie: string) => (await (await json(cookie, "GET", "/api/v1/auth/me")).json()) as { user: { id: string; email: string }; activeCompanyId: string | null; memberships: Array<{ companyId: string; role: string }> };
  const invite = (cookie: string, body: unknown) => json(cookie, "POST", "/api/v1/companies/current/members/invite", body);
  const errorCode = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;
  const team = async (cookie: string) => (await (await json(cookie, "GET", "/api/v1/companies/current/members")).json()) as TeamView;

  let owner = "";
  let ownerId = "";
  let companyId = "";
  let roleId = "";
  let hankLink = "";
  let annLink = "";

  /** A candidate with an application on a role, straight into the tables (the apply flow is covered elsewhere). */
  const seedApplication = (email: string, forRoleId = roleId) =>
    withTenant(container.db, companyId, async (tx) => {
      const [cand] = await tx.insert(candidates).values({ companyId, firstName: "Pat", lastName: "Lee", email }).returning();
      const [application] = await tx.insert(applications).values({ companyId, roleId: forRoleId, candidateId: cand.id, packetVersion: 1, source: "direct", stage: "triaged", statusToken: randomToken(16) }).returning();
      return application.id;
    });

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", AUTH_PROVIDER: "fake" } });
    app = createApp(container);
    owner = await signInWithIdentity(app, container, { email: "dana@teamtest.test", name: "Dana Owner", provider: "google", aal2: false });
    const co = (await (await json(owner, "POST", "/api/v1/companies", { name: "Teamtest Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string };
    companyId = co.id;
    // This suite invites more people than the Free plan's 2; the plan's people have their own suite below.
    await usePlan(container, companyId);
    ownerId = (await me(owner)).user.id;
    roleId = await plantJob(container, { companyId, title: "Dental Hygienist" });
  });
  afterAll(async () => {
    await container.close();
  });

  it("invites a member: a row, and one email through the outbox that says who, the company, the role and seven days", async () => {
    const r = await invite(owner, { email: "Hank.Manager@teamtest.test", role: "hiring_manager", name: "Hank" });
    expect(r.status).toBe(201);
    const body = (await r.json()) as InviteAnswer;
    expect(body).toMatchObject({ ok: true, emailed: true, invitation: { email: "hank.manager@teamtest.test", name: "Hank", role: "hiring_manager", roleLabel: "Member", invitedBy: "Dana Owner", emailState: "on_its_way" } });
    expect(Date.parse(body.invitation.expiresAt) - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect(body.link).toMatch(/\/api\/v1\/auth\/invite\?token=/);
    hankLink = body.link;
    const sent = mail().sent.filter((m) => m.to === "hank.manager@teamtest.test");
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("Dana Owner invited you to Teamtest Dental on Recruiting OS");
    expect(sent[0].text).toContain("Hi Hank,");
    expect(sent[0].text).toContain("Dana Owner invited you to Teamtest Dental's hiring workspace");
    expect(sent[0].text).toContain("as a member");
    expect(sent[0].text).toContain("seven days");
    expect(sent[0].text).toContain("Google or Microsoft");
    expect(sent[0].text).toContain(hankLink);
    // never the hash, and the token only inside the link
    const [row] = await container.db.select().from(invitations).where(eq(invitations.email, "hank.manager@teamtest.test"));
    expect(sent[0].text).not.toContain(row.tokenHash);
    expect(JSON.stringify(body)).not.toContain(row.tokenHash);
    // the open invitation is on the team's one answer, with what became of its email
    expect((await team(owner)).invitations).toEqual([expect.objectContaining({ id: body.invitation.id, email: "hank.manager@teamtest.test", role: "hiring_manager", invitedBy: "Dana Owner", emailState: "sent" })]);
    const audited = await container.db.select().from(auditRecords).where(eq(auditRecords.action, "invitation.sent"));
    expect(audited).toHaveLength(1);
  });

  it("the invitee accepts through Google in the browser: the page signs nobody in, the callback lands them in the company as a member", async () => {
    const page = await app.request(pathOf(hankLink));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Join Teamtest Dental");
    expect(html).toContain("as a member");
    expect(html).toContain("hank.manager@teamtest.test");
    expect(html).toContain("Continue with Google");
    expect(html).toContain("Continue with Microsoft");
    expect(html).toContain("Email me a sign-in link"); // MAGIC_LINK_ENABLED defaults to true outside production
    const inviteCookie = cookieNamed(page, "ros_invite");
    expect(inviteCookie).toMatch(/^ros_invite=v1\./);
    expect(cookieNamed(page, "ros_session")).toBeNull();
    expect((await container.db.select().from(invitations).where(eq(invitations.email, "hank.manager@teamtest.test")))[0].status).toBe("pending");

    // the PKCE flow through the fake issuer, with the invitation cookie riding along
    const start = await app.request("/api/v1/auth/start/google");
    const pkce = start.headers.get("set-cookie")!.split(";")[0];
    const authorize = new URL(start.headers.get("location")!);
    const form = new URLSearchParams({ provider: "google", redirect_to: `${container.env.APP_BASE_URL}/api/v1/auth/callback`, code_challenge: authorize.searchParams.get("code_challenge")!, state: authorize.searchParams.get("state")!, email: "Hank.Manager@teamtest.test", name: "Hank Manager", email_verified: "1" });
    const consent = await app.request("/api/v1/auth/fake/authorize", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
    const cb = new URL(consent.headers.get("location")!);
    const done = await app.request(`${cb.pathname}?${cb.searchParams.toString()}`, { headers: { cookie: `${pkce}; ${inviteCookie}` } });
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe(`${container.env.APP_BASE_URL}/`);
    const hank = cookieNamed(done, "ros_session")!;
    expect(hank).toBeTruthy();
    expect(cleared(done, "ros_invite")).toBe(true);

    const who = await me(hank);
    expect(who.activeCompanyId).toBe(companyId);
    expect(who.memberships).toEqual([expect.objectContaining({ companyId, role: "hiring_manager" })]);
    const [row] = await container.db.select().from(invitations).where(eq(invitations.email, "hank.manager@teamtest.test"));
    expect(row.status).toBe("accepted");
    expect(row.acceptedUserId).toBe(who.user.id);
    expect(await container.db.select().from(events).where(and(eq(events.type, "member.joined"), eq(events.companyId, companyId)))).toHaveLength(1);
    expect(await container.db.select().from(auditRecords).where(eq(auditRecords.action, "invitation.accepted"))).toHaveLength(1);
    // in the team, out of the pending list
    const after = await team(owner);
    expect(after.members).toEqual(expect.arrayContaining([expect.objectContaining({ userId: who.user.id, email: "hank.manager@teamtest.test", role: "hiring_manager", roleLabel: "Member", you: false, mayChange: true, changeBlockedReason: null })]));
    expect(after.invitations).toEqual([]);
    // the used link says so and parks nothing
    const again = await app.request(pathOf(hankLink));
    expect(await again.text()).toContain("already used");
    expect(cookieNamed(again, "ros_invite")).toBeNull();
    // and as a member they see the jobs but cannot invite
    expect((await json(hank, "GET", "/api/v1/roles")).status).toBe(200);
    expect((await invite(hank, { email: "someone@teamtest.test", role: "hiring_manager" })).status).toBe(403);
  });

  it("a lost link still works: signing in with the invited address (Microsoft this time) accepts the invitation without the cookie", async () => {
    expect((await invite(owner, { email: "ivy.interviewer@teamtest.test", role: "hiring_manager" })).status).toBe(201);
    const r = await session(idp().mint({ email: "Ivy.Interviewer@teamtest.test", name: "Ivy", provider: "azure" }));
    expect(r.status).toBe(200);
    expect(((await r.json()) as { activeCompanyId: string }).activeCompanyId).toBe(companyId);
    const who = await me(cookieNamed(r, "ros_session")!);
    expect(who.memberships).toEqual([expect.objectContaining({ companyId, role: "hiring_manager" })]);
    expect((await container.db.select().from(invitations).where(eq(invitations.email, "ivy.interviewer@teamtest.test")))[0].status).toBe("accepted");
  });

  it("refuses the invitation for a different address and keeps it for the right one", async () => {
    const created = (await (await invite(owner, { email: "holly.hr@teamtest.test", role: "hiring_manager" })).json()) as InviteAnswer;
    const page = await app.request(pathOf(created.link));
    const inviteCookie = cookieNamed(page, "ros_invite")!;
    const wrong = await session(idp().mint({ email: "stranger@elsewhere.test", name: "Someone Else", provider: "google" }), inviteCookie);
    expect(wrong.status).toBe(403);
    expect(await errorCode(wrong)).toBe("invite_email_mismatch");
    expect(cookieNamed(wrong, "ros_session")).toBeNull();
    expect(cleared(wrong, "ros_invite")).toBe(false);
    expect((await container.db.select().from(invitations).where(eq(invitations.email, "holly.hr@teamtest.test")))[0].status).toBe("pending");
    expect(await container.db.select().from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(eq(users.email, "stranger@elsewhere.test"))).toHaveLength(0);
    expect(await container.db.select().from(auditRecords).where(and(eq(auditRecords.action, "signin.refused"), eq(auditRecords.reason, "invite_email_mismatch")))).toHaveLength(1);
    // the same cookie with the invited address: accepted, cookie dropped
    const right = await session(idp().mint({ email: "Holly.HR@teamtest.test", name: "Holly", provider: "google" }), inviteCookie);
    expect(right.status).toBe(200);
    expect(((await right.json()) as { activeCompanyId: string }).activeCompanyId).toBe(companyId);
    expect(cleared(right, "ros_invite")).toBe(true);
    expect((await me(cookieNamed(right, "ros_session")!)).memberships).toEqual([expect.objectContaining({ companyId, role: "hiring_manager" })]);
    // the browser can drop a carried invitation on request
    const forget = await app.request("/api/v1/auth/invite/forget", { method: "POST", headers: { cookie: inviteCookie } });
    expect(forget.status).toBe(200);
    expect(cleared(forget, "ros_invite")).toBe(true);
  });

  it("refuses an ITS address, someone already on the team and a staff role; a newer invitation replaces the older one", async () => {
    const staff = await invite(owner, { email: "nadine@identifiedtalent.com", role: "admin" });
    expect(staff.status).toBe(400);
    expect(await errorCode(staff)).toBe("staff_domain");
    const dup = await invite(owner, { email: "HANK.manager@teamtest.test", role: "admin" });
    expect(dup.status).toBe(409);
    expect(await errorCode(dup)).toBe("already_member");
    expect((await invite(owner, { email: "x@teamtest.test", role: "boss" })).status).toBe(400);
    expect((await invite(owner, { email: "not-an-email", role: "admin" })).status).toBe(400);
    const first = (await (await invite(owner, { email: "ann.admin@teamtest.test", role: "admin" })).json()) as InviteAnswer;
    const second = (await (await invite(owner, { email: "ann.admin@teamtest.test", role: "admin" })).json()) as InviteAnswer;
    // one link per address: the older invitation is withdrawn
    expect((await container.db.select({ status: invitations.status }).from(invitations).where(eq(invitations.email, "ann.admin@teamtest.test"))).map((i) => i.status).sort()).toEqual(["pending", "revoked"]);
    expect(second.link).not.toBe(first.link);
    expect((await team(owner)).invitations.filter((p) => p.email === "ann.admin@teamtest.test")).toEqual([expect.objectContaining({ id: second.invitation.id, role: "admin", roleLabel: "Admin" })]);
    const old = await app.request(pathOf(first.link));
    expect(await old.text()).toContain("withdrawn");
    expect(cookieNamed(old, "ros_invite")).toBeNull();
    expect(await (await app.request(pathOf(second.link))).text()).toContain("Join Teamtest Dental");
    annLink = second.link;
  });

  it("an expired invitation is refused on the page and at sign-in, and the cookie is dropped; sending it again revives it", async () => {
    const created = (await (await invite(owner, { email: "eve.late@teamtest.test", role: "hiring_manager" })).json()) as InviteAnswer;
    const page = await app.request(pathOf(created.link));
    const inviteCookie = cookieNamed(page, "ros_invite")!;
    await withPlatform(container.db, (tx) => tx.update(invitations).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(invitations.id, created.invitation.id)));
    const expired = await app.request(pathOf(created.link));
    expect(await expired.text()).toContain("This invitation has expired");
    expect(cookieNamed(expired, "ros_invite")).toBeNull();
    const r = await session(idp().mint({ email: "eve.late@teamtest.test", provider: "google" }), inviteCookie);
    expect(r.status).toBe(403);
    expect(await errorCode(r)).toBe("invite_expired");
    expect(cookieNamed(r, "ros_session")).toBeNull();
    expect(cleared(r, "ros_invite")).toBe(true);
    // a plain sign-in opens a session with no membership: the lapsed invitation is not accepted
    const plain = await session(idp().mint({ email: "eve.late@teamtest.test", provider: "google" }));
    expect(plain.status).toBe(200);
    expect(((await plain.json()) as { activeCompanyId: string | null }).activeCompanyId).toBeNull();
    expect((await team(owner)).invitations.some((p) => p.email === "eve.late@teamtest.test")).toBe(false);
    // sent again: seven more days and a new link
    const resent = await json(owner, "POST", `/api/v1/companies/current/invitations/${created.invitation.id}/resend`);
    expect(resent.status).toBe(200);
    const body = (await resent.json()) as InviteAnswer;
    expect(Date.parse(body.invitation.expiresAt)).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect(body.link).not.toBe(created.link);
    expect(await (await app.request(pathOf(body.link))).text()).toContain("Join Teamtest Dental");
  });

  it("resend issues a new link (the old one stops working) and revoke ends it", async () => {
    const [ann] = await container.db.select().from(invitations).where(and(eq(invitations.email, "ann.admin@teamtest.test"), eq(invitations.status, "pending")));
    const resent = await json(owner, "POST", `/api/v1/companies/current/invitations/${ann.id}/resend`);
    expect(resent.status).toBe(200);
    const body = (await resent.json()) as InviteAnswer;
    expect(body.link).not.toBe(annLink);
    expect(await (await app.request(pathOf(annLink))).text()).toContain("not valid");
    expect(await (await app.request(pathOf(body.link))).text()).toContain("Join Teamtest Dental");
    const sent = mail().sent.filter((m) => m.to === "ann.admin@teamtest.test");
    expect(sent).toHaveLength(3); // the first invitation, its replacement, and the reminder
    expect(sent[2].subject).toMatch(/^Reminder: /);
    expect(sent[2].text).toContain(body.link);
    expect(await container.db.select().from(auditRecords).where(eq(auditRecords.action, "invitation.resent"))).toHaveLength(2);
    // a member can neither withdraw it nor see the pending list, nor replace it by inviting the same address: refused, the
    // invitation stays open and no email goes out; the owner withdraws it
    const ivy = cookieNamed(await session(idp().mint({ email: "ivy.interviewer@teamtest.test", provider: "azure" })), "ros_session")!;
    expect((await json(ivy, "POST", `/api/v1/companies/current/invitations/${ann.id}/revoke`)).status).toBe(403);
    expect(await team(ivy)).toMatchObject({ invitations: [], viewer: { role: "hiring_manager", mayManage: false, grantableRoles: [] } });
    expect((await invite(ivy, { email: "ann.admin@teamtest.test", role: "hiring_manager" })).status).toBe(403);
    expect((await container.db.select().from(invitations).where(eq(invitations.id, ann.id)))[0].status).toBe("pending");
    expect((await container.db.select().from(invitations).where(eq(invitations.email, "ann.admin@teamtest.test"))).filter((i) => i.status === "pending")).toHaveLength(1);
    expect(mail().sent.filter((m) => m.to === "ann.admin@teamtest.test")).toHaveLength(3);
    expect(await (await app.request(pathOf(body.link))).text()).toContain("Join Teamtest Dental");
    const revoked = await json(owner, "POST", `/api/v1/companies/current/invitations/${ann.id}/revoke`);
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ ok: true });
    expect((await container.db.select().from(invitations).where(eq(invitations.id, ann.id)))[0].status).toBe("revoked");
    expect(await (await app.request(pathOf(body.link))).text()).toContain("withdrawn");
    expect((await team(owner)).invitations.some((p) => p.email === "ann.admin@teamtest.test")).toBe(false);
    expect((await json(owner, "POST", `/api/v1/companies/current/invitations/${ann.id}/revoke`)).status).toBe(404);
    expect((await json(owner, "POST", `/api/v1/companies/current/invitations/${ann.id}/resend`)).status).toBe(404);
    expect((await json(owner, "POST", "/api/v1/companies/current/invitations/nope/resend")).status).toBe(404);
    expect((await json(owner, "POST", "/api/v1/companies/current/invitations/nope/revoke")).status).toBe(404);
    expect(await container.db.select().from(auditRecords).where(eq(auditRecords.action, "invitation.revoked"))).toHaveLength(1);
    // signing in as Ann now joins nothing
    const ann2 = await session(idp().mint({ email: "ann.admin@teamtest.test", provider: "google" }));
    expect(((await ann2.json()) as { activeCompanyId: string | null }).activeCompanyId).toBeNull();
  });

  it("validates member changes: bad role, self-change, only an owner grants or takes the owner role, the last owner stays, a role change ends sessions", async () => {
    const hankId = (await team(owner)).members.find((m) => m.email === "hank.manager@teamtest.test")!.userId;
    const patch = (cookie: string, userId: string, body: unknown) => json(cookie, "PATCH", `/api/v1/companies/current/members/${userId}`, body);
    expect((await patch(owner, hankId, { role: "boss" })).status).toBe(400);
    expect((await patch(owner, hankId, { status: "invited" })).status).toBe(400);
    expect((await patch(owner, hankId, {})).status).toBe(400);
    expect((await patch(owner, "00000000-0000-0000-0000-000000000000", { role: "admin" })).status).toBe(404);
    expect((await patch(owner, "not-a-uuid", { role: "admin" })).status).toBe(404); // not even an id: a 404 in the route's words, never a database error
    const self = await patch(owner, ownerId, { role: "admin" });
    expect(self.status).toBe(409);
    expect(await errorCode(self)).toBe("self_change");
    expect(await errorCode(await patch(owner, ownerId, { status: "removed" }))).toBe("self_change");
    const admin = await signInAs(container, app, { companyId, role: "admin", email: "adam.admin@teamtest.test", name: "Adam" });
    const promote = await patch(admin, hankId, { role: "owner" });
    expect(promote.status).toBe(403);
    expect(await errorCode(promote)).toBe("owner_only");
    const removeOwner = await patch(admin, ownerId, { status: "removed" });
    expect(removeOwner.status).toBe(409);
    expect(await errorCode(removeOwner)).toBe("last_owner");
    expect(await errorCode(await patch(admin, ownerId, { role: "admin" }))).toBe("last_owner");
    // a second owner joins; the first owner demotes them (two owners, so allowed), which ends their sessions
    const olive = await signInAs(container, app, { companyId, role: "owner", email: "olive.owner@teamtest.test", name: "Olive" });
    const oliveId = (await me(olive)).user.id;
    // with two owners the last-owner guard no longer answers first; an admin still cannot demote or remove either of them
    for (const [who, cookie] of [["admin", admin]] as const) {
      for (const target of [oliveId, ownerId]) {
        for (const body of [{ role: "admin" }, { status: "removed" }]) {
          const r = await patch(cookie, target, body);
          expect(r.status, `${who} ${JSON.stringify(body)} on an owner`).toBe(403);
          expect(await errorCode(r)).toBe("owner_only");
        }
      }
    }
    // both membership rows untouched: still owners, still active
    const owners = await container.db.select({ userId: memberships.userId, status: memberships.status }).from(memberships).where(and(eq(memberships.companyId, companyId), eq(memberships.role, "owner")));
    const byId = (a: { userId: string }, b: { userId: string }) => a.userId.localeCompare(b.userId);
    expect(owners.sort(byId)).toEqual([{ userId: oliveId, status: "active" }, { userId: ownerId, status: "active" }].sort(byId));
    expect((await json(olive, "GET", "/api/v1/auth/me")).status).toBe(200); // a refused change ends nobody's sessions
    const demote = await patch(owner, oliveId, { role: "admin" });
    expect(demote.status).toBe(200);
    expect((await demote.json()) as MemberChanged).toEqual({ ok: true, userId: oliveId, role: "admin", status: "active" });
    expect((await json(olive, "GET", "/api/v1/auth/me")).status).toBe(401);
    // signed in again, the new role applies; and the original owner is now the last one
    const oliveAgain = await signInAs(container, app, { companyId, role: "admin", email: "olive.owner@teamtest.test" });
    expect((await me(oliveAgain)).memberships).toEqual([expect.objectContaining({ companyId, role: "admin" })]);
    expect(await errorCode(await patch(oliveAgain, ownerId, { role: "admin" }))).toBe("last_owner");
    expect(await errorCode(await patch(oliveAgain, ownerId, { status: "removed" }))).toBe("last_owner");
    // an admin may change other roles, but not grant owner
    expect(await errorCode(await patch(oliveAgain, hankId, { role: "owner" }))).toBe("owner_only");
    expect((await patch(oliveAgain, hankId, { role: "hiring_manager" })).status).toBe(200); // no change, nothing ends
    const changed = await container.db.select().from(auditRecords).where(and(eq(auditRecords.action, "membership.changed"), eq(auditRecords.companyId, companyId)));
    expect(changed.some((a) => a.reason === "role changed from owner to admin")).toBe(true);
    const ended = await container.db.select().from(auditRecords).where(and(eq(auditRecords.action, "session.revoked"), eq(auditRecords.reason, "role changed")));
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ target: { type: "user", id: oliveId }, details: { scope: "company" } });
    expect((ended[0].details as { sessionsEnded: number }).sessionsEnded).toBeGreaterThanOrEqual(1);
  });

  it("the team is one answer that says what the person looking may do: an owner grants all three roles, an admin Admin and Member and changes no owner, a member nothing", async () => {
    const asOwner = await team(owner);
    expect(asOwner.viewer).toEqual({ userId: ownerId, role: "owner", mayManage: true, grantableRoles: ["owner", "admin", "hiring_manager"], mayLeave: false, leaveBlockedReason: "You are the only owner. Make someone else an owner first, then leave. To close the whole company, ask ITS." });
    expect(asOwner.members.filter((m) => m.you)).toEqual([expect.objectContaining({ userId: ownerId, email: "dana@teamtest.test", name: "Dana Owner", role: "owner", roleLabel: "Owner", mayChange: false, changeBlockedReason: "You cannot change your own role or remove yourself. Ask another owner or admin to do it." })]);
    expect(asOwner.members.filter((m) => !m.you).every((m) => m.mayChange && m.changeBlockedReason === null)).toBe(true);
    // the plan's people: everyone active and every invitation still open; this plan sets no limit
    expect(asOwner.seats).toEqual({ used: asOwner.members.length + asOwner.invitations.length, limit: null, full: false, line: null });
    expect(asOwner.invitations.length).toBeGreaterThan(0);
    const admin = await signInAs(container, app, { companyId, role: "admin", email: "adam.admin@teamtest.test" });
    const asAdmin = await team(admin);
    expect(asAdmin.viewer).toMatchObject({ role: "admin", mayManage: true, grantableRoles: ["admin", "hiring_manager"], mayLeave: true, leaveBlockedReason: null });
    expect(asAdmin.members.find((m) => m.userId === ownerId)).toMatchObject({ mayChange: false, changeBlockedReason: "Only an owner can make someone an owner, or change an owner's role." });
    expect(asAdmin.members.find((m) => m.email === "hank.manager@teamtest.test")).toMatchObject({ mayChange: true, changeBlockedReason: null });
    expect(asAdmin.invitations).toEqual(asOwner.invitations);
    // a member sees who is on the team, and nothing to press: no invitee's address, no change to anyone
    const member = await signInAs(container, app, { companyId, role: "hiring_manager" });
    const asMember = await team(member);
    expect(asMember.viewer).toMatchObject({ role: "hiring_manager", mayManage: false, grantableRoles: [], mayLeave: true, leaveBlockedReason: null });
    expect(asMember.invitations).toEqual([]);
    expect(asMember.members.every((m) => !m.mayChange && m.changeBlockedReason === null)).toBe(true);
    expect(asMember.members.map((m) => m.userId)).toEqual(expect.arrayContaining(asOwner.members.map((m) => m.userId)));
    // and nothing of how anyone signs in, or of an invitation's link
    expect(JSON.stringify([asOwner, asAdmin, asMember])).not.toMatch(/tokenHash|token_hash|authSubject|token=/);
  });

  it("an invitation whose email did not arrive says so on its row, and the one who invited still has its link to copy", async () => {
    const sent = (await (await invite(owner, { email: "kim.unreached@teamtest.test", role: "hiring_manager" })).json()) as InviteAnswer;
    expect(sent.link).toMatch(/\/api\/v1\/auth\/invite\?token=/);
    const row = async () => (await team(owner)).invitations.find((i) => i.id === sent.invitation.id);
    expect(await row()).toMatchObject({ email: "kim.unreached@teamtest.test", emailState: "sent" });
    // its email failed for good: the row says so, and the link answered at the invitation still opens it
    await container.db.update(communications).set({ status: "failed", error: "postmark 422: refused" }).where(and(eq(communications.companyId, companyId), eq(communications.templateKey, "invite"), eq(communications.toAddress, "kim.unreached@teamtest.test")));
    expect((await row())?.emailState).toBe("failed");
    expect(await (await app.request(pathOf(sent.link))).text()).toContain("Join Teamtest Dental");
    // sent again: a fresh link, a new email, and the row reads the email of the link that works now
    const again = (await (await json(owner, "POST", `/api/v1/companies/current/invitations/${sent.invitation.id}/resend`)).json()) as InviteAnswer;
    expect(again).toMatchObject({ ok: true, emailed: true });
    expect(again.link).not.toBe(sent.link);
    expect((await row())?.emailState).toBe("sent");
    expect((await json(owner, "POST", `/api/v1/companies/current/invitations/${sent.invitation.id}/revoke`)).status).toBe(200);
  });

  it("only an owner invites an owner: an admin is refused (403 owner_only) on the invitation and on sending it again; the owner's goes out", async () => {
    const abby = await signInAs(container, app, { companyId, role: "admin", email: "abby.admin@teamtest.test", name: "Abby Admin" });
    for (const cookie of [abby]) {
      const r = await invite(cookie, { email: "second.owner@teamtest.test", role: "owner" });
      expect(r.status).toBe(403);
      expect(await errorCode(r)).toBe("owner_only");
    }
    expect(await container.db.select().from(invitations).where(eq(invitations.email, "second.owner@teamtest.test"))).toHaveLength(0);
    expect(mail().sent.filter((m) => m.to === "second.owner@teamtest.test")).toHaveLength(0);
    // the owner may, and only the owner may send it again: a refused resend rolls back, so the first link still works
    const created = (await (await invite(owner, { email: "second.owner@teamtest.test", role: "owner" })).json()) as InviteAnswer;
    expect(created.invitation).toMatchObject({ role: "owner", roleLabel: "Owner" });
    for (const cookie of [abby]) {
      const r = await json(cookie, "POST", `/api/v1/companies/current/invitations/${created.invitation.id}/resend`);
      expect(r.status).toBe(403);
      expect(await errorCode(r)).toBe("owner_only");
    }
    expect(await (await app.request(pathOf(created.link))).text()).toContain("Join Teamtest Dental");
    expect(mail().sent.filter((m) => m.to === "second.owner@teamtest.test")).toHaveLength(1);
    // nor withdraw it: an owner's invitation to a new owner is an owner's to withdraw (audit 01-platform B12)
    for (const cookie of [abby]) {
      const r = await json(cookie, "POST", `/api/v1/companies/current/invitations/${created.invitation.id}/revoke`);
      expect(r.status).toBe(403);
      expect(await errorCode(r)).toBe("owner_only");
    }
    expect((await container.db.select().from(invitations).where(eq(invitations.id, created.invitation.id)))[0].status).toBe("pending");
    // nor replace it with an invitation of a lower rank to the same address, which would withdraw it
    for (const cookie of [abby]) {
      const r = await invite(cookie, { email: "second.owner@teamtest.test", role: "hiring_manager" });
      expect(r.status).toBe(403);
      expect(await errorCode(r)).toBe("owner_only");
    }
    expect((await container.db.select().from(invitations).where(eq(invitations.id, created.invitation.id)))[0].status).toBe("pending");
    expect(mail().sent.filter((m) => m.to === "second.owner@teamtest.test")).toHaveLength(1);
    expect((await json(owner, "POST", `/api/v1/companies/current/invitations/${created.invitation.id}/revoke`)).status).toBe(200);
  });

  it("removal ends the person's sessions and hides them from the team", async () => {
    const wes = await signInAs(container, app, { companyId, role: "hiring_manager", email: "wes.leaving@teamtest.test", name: "Wes Leaving" });
    const wesId = (await me(wes)).user.id;
    const r = await json(owner, "PATCH", `/api/v1/companies/current/members/${wesId}`, { status: "removed" });
    expect(r.status).toBe(200);
    expect((await r.json()) as MemberChanged).toEqual({ ok: true, userId: wesId, role: "hiring_manager", status: "removed" });
    const [ended] = await container.db.select().from(auditRecords).where(and(eq(auditRecords.action, "session.revoked"), eq(auditRecords.reason, "removed from the team")));
    expect(ended).toMatchObject({ target: { type: "user", id: wesId }, details: { sessionsEnded: 1, scope: "company" } });
    // the removed person's next request is refused outright
    expect((await json(wes, "GET", "/api/v1/auth/me")).status).toBe(401);
    // gone from the team; a fresh sign-in has no company and no tenant
    expect((await team(owner)).members.some((m) => m.userId === wesId)).toBe(false);
    const fresh = await session(idp().mint({ email: "wes.leaving@teamtest.test", provider: "google" }));
    expect(fresh.status).toBe(200);
    expect(((await fresh.json()) as { activeCompanyId: string | null }).activeCompanyId).toBeNull();
    const freshCookie = cookieNamed(fresh, "ros_session")!;
    expect((await me(freshCookie)).memberships).toEqual([]);
    expect((await json(freshCookie, "GET", "/api/v1/roles")).status).toBe(403);
    expect((await json(freshCookie, "POST", "/api/v1/auth/switch", { companyId })).status).toBe(403);
    expect(await container.db.select().from(events).where(and(eq(events.type, "member.removed"), eq(events.subjectId, wesId)))).toHaveLength(1);
    // removing them again is a 404: not an active member
    expect((await json(owner, "PATCH", `/api/v1/companies/current/members/${wesId}`, { status: "removed" })).status).toBe(404);
    // re-invited, the old membership row comes back active with the new role
    expect((await invite(owner, { email: "wes.leaving@teamtest.test", role: "admin" })).status).toBe(201);
    const back = await session(idp().mint({ email: "wes.leaving@teamtest.test", provider: "google" }));
    expect(((await back.json()) as { activeCompanyId: string | null }).activeCompanyId).toBe(companyId);
    expect((await me(cookieNamed(back, "ros_session")!)).memberships).toEqual([expect.objectContaining({ companyId, role: "admin" })]);
  });

  it("the email-link sign-in refuses a carried invitation for another address, records it, and spends nothing", async () => {
    const created = (await (await invite(owner, { email: "mira.mail@teamtest.test", role: "hiring_manager" })).json()) as InviteAnswer;
    const inviteCookie = cookieNamed(await app.request(pathOf(created.link)), "ros_invite")!;
    const asked = (await (await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "other.person@elsewhere.test" }) })).json()) as { devLink: string };
    const linkToken = new URL(asked.devLink).searchParams.get("token")!;
    const consume = (cookie?: string) => app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ token: linkToken }) });
    const wrong = await consume(inviteCookie);
    expect(wrong.status).toBe(403);
    expect(await errorCode(wrong)).toBe("invite_email_mismatch");
    expect(cookieNamed(wrong, "ros_session")).toBeNull();
    expect(cleared(wrong, "ros_invite")).toBe(false);
    // recorded like the delegated sign-in's refusal, with the path it came in on
    const refused = await container.db.select().from(auditRecords).where(and(eq(auditRecords.action, "signin.refused"), eq(auditRecords.reason, "invite_email_mismatch")));
    expect(refused.some((a) => { const d = a.details as { provider?: string; email?: string }; return d.provider === "magic_link" && d.email === "other.person@elsewhere.test"; })).toBe(true);
    // the refusal rolled everything back, so the link is still whole: without the invitation it signs the person in, joining nothing
    const plain = await consume();
    expect(plain.status).toBe(200);
    expect((await plain.json()) as { activeCompanyId: string | null; invitationsAccepted: number }).toMatchObject({ activeCompanyId: null, invitationsAccepted: 0 });
    expect((await container.db.select().from(invitations).where(eq(invitations.email, "mira.mail@teamtest.test")))[0].status).toBe("pending");
  });

  it("the invitation page's own sign-in link is limited per invitation, whoever holds the link", async () => {
    const created = (await (await invite(owner, { email: "lena.link@teamtest.test", role: "hiring_manager" })).json()) as InviteAnswer;
    const token = new URL(created.link).searchParams.get("token")!;
    const ask = () => app.request("/api/v1/auth/invite/email", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }).toString() });
    for (let i = 0; i < 3; i++) {
      const r = await ask();
      expect(r.status).toBe(200);
      expect(await r.text()).toContain("Check your email");
    }
    const fourth = await ask();
    expect(fourth.status).toBe(429);
    expect(mail().sent.filter((m) => m.to === "lena.link@teamtest.test" && m.subject.startsWith("Your sign-in link"))).toHaveLength(3);
  });

  describe("every role over HTTP (J5)", () => {
    type Role = "hiring_manager" | "admin";
    const ROLES: Role[] = ["hiring_manager", "admin"];
    /** true: succeeds (a 2xx answer); false: refused with 403. */
    const TABLE: Record<string, Record<Role, boolean>> = {
      "GET /roles": { hiring_manager: true, admin: true },
      "GET /companies/current": { hiring_manager: true, admin: true },
      "GET /companies/current/members": { hiring_manager: true, admin: true },
      "PATCH /companies/current": { hiring_manager: false, admin: true },
      "PUT /companies/current/hiring-contact": { hiring_manager: false, admin: true },
      "POST /companies/current/members/invite": { hiring_manager: false, admin: true },
      "POST /applications/:id/actions reject": { hiring_manager: true, admin: true },
      "GET /plans": { hiring_manager: true, admin: true },
      "GET /notifications/preferences": { hiring_manager: true, admin: true },
    };
    const cookies: Partial<Record<Role, string>> = {};
    /** Declining changes state, so every role gets its own application. */
    const applicationFor: Partial<Record<Role, string>> = {};
    beforeAll(async () => {
      for (const role of ROLES) {
        cookies[role] = await signInAs(container, app, { companyId, role });
        applicationFor[role] = await seedApplication(`pat.${role.replace(/_/g, "-")}@candidate.test`);
      }
    });

    it.each(ROLES)("%s: the expected routes succeed and the rest are refused with 403", async (role) => {
      const cookie = cookies[role]!;
      const calls: Record<string, () => Response | Promise<Response>> = {
        "GET /roles": () => json(cookie, "GET", "/api/v1/roles"),
        "GET /companies/current": () => json(cookie, "GET", "/api/v1/companies/current"),
        "GET /companies/current/members": () => json(cookie, "GET", "/api/v1/companies/current/members"),
        "PATCH /companies/current": () => json(cookie, "PATCH", "/api/v1/companies/current", { benefitsSummary: `Health and dental (${role}).` }),
        "PUT /companies/current/hiring-contact": () => json(cookie, "PUT", "/api/v1/companies/current/hiring-contact", { email: `jobs.${role.replace(/_/g, "-")}@teamtest.test` }),
        "POST /companies/current/members/invite": () => invite(cookie, { email: `${role.replace(/_/g, "-")}-invitee@teamtest.test`, role: "hiring_manager" }),
        "POST /applications/:id/actions reject": () => json(cookie, "POST", `/api/v1/applications/${applicationFor[role]}/actions`, { action: "reject" }),
        "GET /plans": () => json(cookie, "GET", "/api/v1/plans"),
        "GET /notifications/preferences": () => json(cookie, "GET", "/api/v1/notifications/preferences"),
      };
      for (const [name, allowed] of Object.entries(TABLE).map(([k, v]) => [k, v[role]] as const)) {
        const r = await calls[name]!();
        const what = `${role} ${name} (got ${r.status}: ${await r.clone().text()})`;
        if (allowed) {
          // a genuine success, not merely "not refused": a 401, 404 or 409 would prove nothing about the role
          expect(r.status, `${what} should succeed`).toBeGreaterThanOrEqual(200);
          expect(r.status, `${what} should succeed`).toBeLessThan(300);
        } else expect(r.status, `${what} should be refused`).toBe(403);
      }
    });
  });
});

/**
 * "Leave this company" (founder decision L-10) and moving between companies (rows 9 and 49): anyone may leave, an owner
 * only while another owner remains; the session moves to the person's other company, or they are signed out; POST
 * /auth/switch takes only a company id the person may enter.
 */
describe("leaving a company, and switching between companies", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  const json = (cookie: string, method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const me = async (cookie: string) => (await (await json(cookie, "GET", "/api/v1/auth/me")).json()) as { activeCompanyId: string | null; memberships: Array<{ companyId: string; role: string }> };
  const errorOf = async (r: Response) => ((await r.json()) as { error: { code: string; message: string } }).error;
  let owner = "";
  let companyA = "";
  let companyB = "";

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", AUTH_PROVIDER: "fake" } });
    app = createApp(container);
    owner = await signInWithIdentity(app, container, { email: "dana@leave.test", name: "Dana Owner", provider: "google", aal2: false });
    companyA = ((await (await json(owner, "POST", "/api/v1/companies", { name: "Alpha Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string }).id;
    const bea = await signInWithIdentity(app, container, { email: "bea@leave.test", name: "Bea Owner", provider: "google", aal2: false });
    companyB = ((await (await json(bea, "POST", "/api/v1/companies", { name: "Beta Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string }).id;
  });
  afterAll(async () => {
    await container.close();
  });

  it("switch takes only a company id the person may enter, and moves the session there and back", async () => {
    await signInAs(container, app, { companyId: companyB, role: "hiring_manager", email: "hank@leave.test", name: "Hank Two" });
    const hank = await signInAs(container, app, { companyId: companyA, role: "hiring_manager", email: "hank@leave.test", name: "Hank Two" });
    expect((await me(hank)).memberships.map((m) => m.companyId).sort()).toEqual([companyA, companyB].sort());
    const bad = await json(hank, "POST", "/api/v1/auth/switch", { companyId: "not-a-company" });
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).code).toBe("invalid_request");
    expect((await json(hank, "POST", "/api/v1/auth/switch", {})).status).toBe(400);
    const moved = await json(hank, "POST", "/api/v1/auth/switch", { companyId: companyB });
    expect(await moved.json()).toEqual({ ok: true, companyId: companyB });
    expect((await me(hank)).activeCompanyId).toBe(companyB);
    expect((await json(hank, "POST", "/api/v1/auth/switch", { companyId: companyA })).status).toBe(200);
    expect((await me(hank)).activeCompanyId).toBe(companyA);
    // a company they are not in is refused as before
    expect((await json(owner, "POST", "/api/v1/auth/switch", { companyId: companyB })).status).toBe(403);
  });

  it("anyone may leave: the session moves to their other company; the owners are told; the last owner may not leave", async () => {
    const hank = await signInAs(container, app, { companyId: companyA, role: "hiring_manager", email: "hank@leave.test", name: "Hank Two" });
    expect((await json(hank, "POST", "/api/v1/companies/current/leave", {})).status).toBe(400);
    const r = await json(hank, "POST", "/api/v1/companies/current/leave", { confirm: true });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, left: "Alpha Dental", movedTo: { companyId: companyB, companyName: "Beta Dental" }, signedOut: false });
    const after = await me(hank);
    expect(after.activeCompanyId).toBe(companyB);
    expect(after.memberships.map((m) => m.companyId)).toEqual([companyB]);
    expect((await json(hank, "POST", "/api/v1/auth/switch", { companyId: companyA })).status).toBe(403);
    const ownerId = ((await (await json(owner, "GET", "/api/v1/auth/me")).json()) as { user: { id: string } }).user.id;
    const told = await container.db.select().from(notifications).where(and(eq(notifications.kind, "member.left"), eq(notifications.userId, ownerId)));
    expect(told.at(-1)?.title).toBe("Hank Two left the team");
    const recorded = await container.db.select().from(events).where(and(eq(events.type, "member.removed"), eq(events.companyId, companyA)));
    expect(recorded.at(-1)?.payload).toMatchObject({ left: true, role: "hiring_manager" });
    // the last owner may not leave; a second owner may
    const refused = await json(owner, "POST", "/api/v1/companies/current/leave", { confirm: true });
    expect(refused.status).toBe(409);
    expect(await errorOf(refused)).toMatchObject({ code: "last_owner", message: expect.stringMatching(/only owner/) });
    const olive = await signInAs(container, app, { companyId: companyA, role: "owner", email: "olive@leave.test", name: "Olive Owner" });
    expect(await (await json(olive, "POST", "/api/v1/companies/current/leave", { confirm: true })).json()).toMatchObject({ ok: true, movedTo: null, signedOut: true });
  });

  it("someone in no other company is signed out when they leave", async () => {
    const ivy = await signInAs(container, app, { companyId: companyA, role: "hiring_manager", email: "ivy@leave.test", name: "Ivy Interviewer" });
    expect(await (await json(ivy, "POST", "/api/v1/companies/current/leave", { confirm: true })).json()).toMatchObject({ ok: true, movedTo: null, signedOut: true });
    expect((await json(ivy, "GET", "/api/v1/auth/me")).status).toBe(401);
    const [row] = await container.db.select({ status: memberships.status }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(and(eq(users.email, "ivy@leave.test"), eq(memberships.companyId, companyA)));
    expect(row.status).toBe("removed");
  });

  it("removing someone ends only their sessions working here: their work in another company goes on, and they cannot switch back", async () => {
    // Pat is a member here and in another company, signed in twice: once working here, once there
    const here = await signInAs(container, app, { companyId: companyA, role: "hiring_manager", email: "pat@leave.test", name: "Pat Two" });
    const there = await signInAs(container, app, { companyId: companyB, role: "hiring_manager", email: "pat@leave.test", name: "Pat Two" });
    const patId = ((await (await json(here, "GET", "/api/v1/auth/me")).json()) as { user: { id: string } }).user.id;
    const r = await json(owner, "PATCH", `/api/v1/companies/current/members/${patId}`, { status: "removed" });
    expect(r.status).toBe(200);
    // the same answer as for someone who works only here: nothing about the other company
    expect(await r.json()).toEqual({ ok: true, userId: patId, role: "hiring_manager", status: "removed" });
    // the session here is over; the one in the other company still works, in that company, and cannot come back
    expect((await json(here, "GET", "/api/v1/auth/me")).status).toBe(401);
    expect((await me(there)).activeCompanyId).toBe(companyB);
    expect((await json(there, "GET", "/api/v1/companies/current")).status).toBe(200);
    expect((await json(there, "POST", "/api/v1/auth/switch", { companyId: companyA })).status).toBe(403);
    // recorded in this company's history, with nothing about the other company
    const [audited] = await container.db.select().from(auditRecords).where(and(eq(auditRecords.action, "session.revoked"), eq(auditRecords.companyId, companyA))).orderBy(desc(auditRecords.createdAt)).limit(1);
    expect(audited).toMatchObject({ reason: "removed from the team", target: { type: "user", id: patId }, details: { sessionsEnded: 1, scope: "company" } });
  });
});

/**
 * The Trial plan's people (founder decision L-02 B, 16 October 2026): at most 3 in the company, members of any role, and
 * invitations not yet answered count; ITS (a platform-staff account) never does. A 4th invitation,
 * and an invitation accepted when the trial is full, are refused in plain words; nobody already in is ever removed.
 */
describe("people on the Trial plan", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  const idp = () => container.integrations.identity as FakeIdentityProvider;
  const json = (cookie: string, method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  // each sign-in from an address of its own: the sign-in route's per-address limit is shared by every suite in this file
  let ip = 0;
  const nextAddress = () => {
    ip += 1;
    return `203.0.113.${ip}`;
  };
  const session = (accessToken: string, cookie?: string) =>
    app.request("/api/v1/auth/session", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": nextAddress(), ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ accessToken }) });
  const cookieNamed = (r: Response, name: string) => r.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.split(";")[0] ?? null;
  const cleared = (r: Response, name: string) => r.headers.getSetCookie().some((c) => c.startsWith(`${name}=`) && /max-age=0/i.test(c));
  const pathOf = (link: string) => link.replace(container.env.APP_BASE_URL, "");
  const invite = (cookie: string, body: unknown) => json(cookie, "POST", "/api/v1/companies/current/members/invite", body);
  const team = async () => (await (await json(owner, "GET", "/api/v1/companies/current/members")).json()) as TeamView;
  const seats = async () => {
    const { used, limit } = (await team()).seats;
    return { used, limit };
  };
  const statusOf = async (email: string) => (await container.db.select({ status: invitations.status }).from(invitations).where(and(eq(invitations.companyId, companyId), eq(invitations.email, email))).orderBy(invitations.createdAt)).at(-1)?.status;
  const FULL = "Your trial includes 3 people. Choose a plan to add more.";
  let owner = "";
  let companyId = "";

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", AUTH_PROVIDER: "fake" } });
    app = createApp(container);
    owner = await signInWithIdentity(app, container, { email: "olga@seats.test", name: "Olga Owner", provider: "google", aal2: false });
    companyId = ((await (await json(owner, "POST", "/api/v1/companies", { name: "Seat Dental", vertical: "dental", sizeBand: "1-19", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string }).id;
    await useTrial(container, companyId);
  });
  afterAll(async () => {
    await container.close();
  });

  it("the owner and two invitations fill the trial; a 4th invitation is refused in plain words and sends nothing", async () => {
    expect((await team()).seats).toEqual({ used: 1, limit: 3, full: false, line: null });
    expect((await invite(owner, { email: "hana@seats.test", role: "hiring_manager" })).status).toBe(201);
    expect((await invite(owner, { email: "ian@seats.test", role: "hiring_manager" })).status).toBe(201);
    expect(await seats()).toEqual({ used: 3, limit: 3 });
    // Settings says so before anyone presses Invite
    expect((await team()).seats).toEqual({ used: 3, limit: 3, full: true, line: FULL });
    const fourth = await invite(owner, { email: "jo@seats.test", role: "hiring_manager" });
    expect(fourth.status).toBe(409);
    expect(await fourth.json()).toMatchObject({ error: { code: "seats_full", message: FULL } });
    expect(await statusOf("jo@seats.test")).toBeUndefined();
    expect((container.integrations.email as unknown as FakeEmailAdapter).sent.filter((m) => m.to === "jo@seats.test")).toHaveLength(0);
  });

  it("inviting the same address again replaces its invitation without counting it twice", async () => {
    const again = await invite(owner, { email: "ian@seats.test", role: "admin" });
    expect(again.status).toBe(201);
    expect((await container.db.select({ status: invitations.status }).from(invitations).where(and(eq(invitations.companyId, companyId), eq(invitations.email, "ian@seats.test")))).map((i) => i.status).sort()).toEqual(["pending", "revoked"]);
    expect(await seats()).toEqual({ used: 3, limit: 3 });
  });

  it("withdrawing an invitation frees its place", async () => {
    const [ian] = await container.db.select({ id: invitations.id }).from(invitations).where(and(eq(invitations.email, "ian@seats.test"), eq(invitations.status, "pending")));
    expect((await json(owner, "POST", `/api/v1/companies/current/invitations/${ian.id}/revoke`)).status).toBe(200);
    expect(await seats()).toEqual({ used: 2, limit: 3 });
    expect((await invite(owner, { email: "jo@seats.test", role: "hiring_manager" })).status).toBe(201);
    expect(await seats()).toEqual({ used: 3, limit: 3 });
  });

  it("an invitation that lapsed gives its place back, and sending it again when the trial is full is refused", async () => {
    const [hana] = await container.db.select({ id: invitations.id }).from(invitations).where(and(eq(invitations.email, "hana@seats.test"), eq(invitations.status, "pending")));
    await withPlatform(container.db, (tx) => tx.update(invitations).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(invitations.id, hana.id)));
    expect(await seats()).toEqual({ used: 2, limit: 3 });
    expect((await invite(owner, { email: "kai@seats.test", role: "hiring_manager" })).status).toBe(201);
    const resent = await json(owner, "POST", `/api/v1/companies/current/invitations/${hana.id}/resend`);
    expect(resent.status).toBe(409);
    expect(await resent.json()).toMatchObject({ error: { code: "seats_full", message: FULL } });
    // a pending invitation already holds its place: sending it again is fine
    const [jo] = await container.db.select({ id: invitations.id }).from(invitations).where(and(eq(invitations.email, "jo@seats.test"), eq(invitations.status, "pending")));
    expect((await json(owner, "POST", `/api/v1/companies/current/invitations/${jo.id}/resend`)).status).toBe(200);
  });

  it("an invitation carried at sign-in into a full trial is refused (invite_seats_full); it and the others stay pending", async () => {
    // someone joins outside an invitation (as ITS sets a company up): the owner, Lee, Jo's and Kai's invitations make 4
    await signInAs(container, app, { companyId, role: "hiring_manager", email: "lee@seats.test", name: "Lee" });
    const [jo] = await container.db.select({ id: invitations.id }).from(invitations).where(and(eq(invitations.email, "jo@seats.test"), eq(invitations.status, "pending")));
    const resent = (await (await json(owner, "POST", `/api/v1/companies/current/invitations/${jo.id}/resend`)).json()) as InviteAnswer;
    const page = await app.request(pathOf(resent.link));
    const inviteCookie = cookieNamed(page, "ros_invite")!;
    const r = await session(idp().mint({ email: "jo@seats.test", name: "Jo", provider: "google" }), inviteCookie);
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: { code: "invite_seats_full", message: "This company's trial includes 3 people. Ask the person who invited you to choose a plan to add more." } });
    expect(cookieNamed(r, "ros_session")).toBeNull();
    expect(cleared(r, "ros_invite")).toBe(true);
    expect(await container.db.select().from(auditRecords).where(and(eq(auditRecords.action, "signin.refused"), eq(auditRecords.reason, "invite_seats_full")))).toHaveLength(1);
    expect(await statusOf("jo@seats.test")).toBe("pending");
    expect(await statusOf("kai@seats.test")).toBe("pending");
    // a plain sign-in opens a session in no company: the invitation waits for a place instead of joining
    const plain = await session(idp().mint({ email: "jo@seats.test", name: "Jo", provider: "google" }));
    expect(plain.status).toBe(200);
    expect(((await plain.json()) as { activeCompanyId: string | null }).activeCompanyId).toBeNull();
    expect(await statusOf("jo@seats.test")).toBe("pending");
  });

  it("never counts ITS: a platform-staff account in the company takes no place", async () => {
    const before = await seats();
    await withPlatform(container.db, async (tx) => {
      const [sam] = await tx.insert(users).values({ email: "sam@identifiedtalent.com", name: "Sam Staff", platformRole: "platform_admin" }).returning();
      await tx.insert(memberships).values({ companyId, userId: sam.id, role: "hiring_manager", status: "active" });
    });
    expect(await seats()).toEqual(before);
  });

  it("a company already past 3 keeps everyone; only new invitations are refused", async () => {
    expect((await seats()).used).toBeGreaterThan(3);
    const { members, seats: places } = await team();
    expect(places).toMatchObject({ limit: 3, full: true, line: FULL });
    expect(members.map((m) => m.email)).toEqual(expect.arrayContaining(["olga@seats.test", "lee@seats.test"]));
    const refused = await invite(owner, { email: "max@seats.test", role: "hiring_manager" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "seats_full", message: FULL } });
    // the owner's own request is never touched by it
    expect((await json(owner, "GET", "/api/v1/companies/current/members")).status).toBe(200);
  });

  it("another plan has no limit of people: invitations go out again", async () => {
    await usePlan(container, companyId, "growth");
    expect((await seats()).limit).toBeNull();
    expect((await invite(owner, { email: "max@seats.test", role: "hiring_manager" })).status).toBe(201);
    // and Jo, still invited, joins at the next sign-in
    const r = await session(idp().mint({ email: "jo@seats.test", name: "Jo", provider: "google" }));
    expect({ status: r.status, body: await r.json() }).toMatchObject({ status: 200, body: { activeCompanyId: companyId } });
    expect(await statusOf("jo@seats.test")).toBe("accepted");
  });
});