import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { participantsOf } from "@ros/agents";
import { connectCalendar } from "@ros/core";
import { applications, auditRecords, candidates, entitlements, events, integrations, interviewParticipants, interviews, invitations, jobs, memberships, notifications, randomToken, users, withPlatform, withTenant } from "@ros/db";
import type { FakeEmailAdapter, FakeIdentityProvider } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { signInAs, signInWithIdentity } from "./test-helpers";

/**
 * Team invitations, members and per-role permissions (docs/spec/21, area A, and section 7 P0): an invitation is a row
 * accepted by a Google or Microsoft sign-in with the invited address (never by an email-link session on its own);
 * member updates are validated with a last-owner guard; removal ends sessions and queues the calendar credential's
 * deletion; and every role is exercised over HTTP.
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
  type InviteResponse = { ok: boolean; invitation: { id: string; email: string; role: string; status: string; expiresAt: string }; replaced: number; devLink: string };

  let owner = "";
  let ownerId = "";
  let companyId = "";
  let roleId = "";
  let hankLink = "";
  let annLink = "";
  let hr = "";

  /** A candidate with an application on a role, straight into the tables (the apply flow is covered elsewhere). */
  const seedApplication = (email: string, forRoleId = roleId) =>
    withTenant(container.db, companyId, async (tx) => {
      const [cand] = await tx.insert(candidates).values({ companyId, firstName: "Pat", lastName: "Lee", email, firstSource: "direct" }).returning();
      const [application] = await tx.insert(applications).values({ companyId, roleId: forRoleId, candidateId: cand.id, packetVersion: 1, source: "direct", stage: "interview_recommended", statusToken: randomToken(16) }).returning();
      return application.id;
    });
  /** A drafted role with its pending approval, the way the owner makes one: an intake conversation compiled into a packet. */
  const compileRole = async () => {
    const started = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." })).json()) as { session: { id: string } };
    return ((await (await json(owner, "POST", `/api/v1/intake/sessions/${started.session.id}/compile`)).json()) as { roleId: string }).roleId;
  };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", AUTH_PROVIDER: "fake" } });
    app = createApp(container);
    owner = await signInWithIdentity(app, container, { email: "dana@teamtest.test", name: "Dana Owner", provider: "google", aal2: false });
    const co = (await (await json(owner, "POST", "/api/v1/companies", { name: "Teamtest Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string };
    companyId = co.id;
    ownerId = (await me(owner)).user.id;
    roleId = await compileRole();
  });
  afterAll(async () => {
    await container.close();
  });

  it("invites a hiring manager: a row, and one email through the outbox that says who, the company, the role and seven days", async () => {
    const r = await invite(owner, { email: "Hank.Manager@teamtest.test", role: "hiring_manager", name: "Hank" });
    expect(r.status).toBe(201);
    const body = (await r.json()) as InviteResponse;
    expect(body.invitation).toMatchObject({ email: "hank.manager@teamtest.test", role: "hiring_manager", status: "pending" });
    expect(Date.parse(body.invitation.expiresAt) - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect(body.devLink).toMatch(/\/api\/v1\/auth\/invite\?token=/);
    hankLink = body.devLink;
    const sent = mail().sent.filter((m) => m.to === "hank.manager@teamtest.test");
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("Dana Owner invited you to Teamtest Dental on Recruiting OS");
    expect(sent[0].text).toContain("Hi Hank,");
    expect(sent[0].text).toContain("Dana Owner invited you to Teamtest Dental's hiring workspace");
    expect(sent[0].text).toContain("as a hiring manager");
    expect(sent[0].text).toContain("seven days");
    expect(sent[0].text).toContain("Google or Microsoft");
    expect(sent[0].text).toContain(hankLink);
    // never the hash, and the token only inside the link
    const [row] = await container.db.select().from(invitations).where(eq(invitations.email, "hank.manager@teamtest.test"));
    expect(sent[0].text).not.toContain(row.tokenHash);
    expect(JSON.stringify(body)).not.toContain(row.tokenHash);
    const pending = (await (await json(owner, "GET", "/api/v1/companies/current/invitations")).json()) as Array<{ email: string; role: string; invitedBy: { name: string } }>;
    expect(pending).toEqual([expect.objectContaining({ email: "hank.manager@teamtest.test", role: "hiring_manager", invitedBy: { name: "Dana Owner" } })]);
    const audited = await container.db.select().from(auditRecords).where(eq(auditRecords.action, "invitation.sent"));
    expect(audited).toHaveLength(1);
  });

  it("the invitee accepts through Google in the browser: the page signs nobody in, the callback lands them in the company as hiring manager", async () => {
    const page = await app.request(pathOf(hankLink));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Join Teamtest Dental");
    expect(html).toContain("as a hiring manager");
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
    const members = (await (await json(owner, "GET", "/api/v1/companies/current/members")).json()) as Array<{ email: string; role: string }>;
    expect(members).toEqual(expect.arrayContaining([expect.objectContaining({ email: "hank.manager@teamtest.test", role: "hiring_manager" })]));
    expect((await (await json(owner, "GET", "/api/v1/companies/current/invitations")).json()) as unknown[]).toEqual([]);
    // the used link says so and parks nothing
    const again = await app.request(pathOf(hankLink));
    expect(await again.text()).toContain("already used");
    expect(cookieNamed(again, "ros_invite")).toBeNull();
    // and as a hiring manager they see roles but cannot invite
    expect((await json(hank, "GET", "/api/v1/roles")).status).toBe(200);
    expect((await invite(hank, { email: "someone@teamtest.test", role: "interviewer" })).status).toBe(403);
  });

  it("a lost link still works: signing in with the invited address (Microsoft this time) accepts the invitation without the cookie", async () => {
    expect((await invite(owner, { email: "ivy.interviewer@teamtest.test", role: "interviewer" })).status).toBe(201);
    const r = await session(idp().mint({ email: "Ivy.Interviewer@teamtest.test", name: "Ivy", provider: "azure" }));
    expect(r.status).toBe(200);
    expect(((await r.json()) as { activeCompanyId: string }).activeCompanyId).toBe(companyId);
    const who = await me(cookieNamed(r, "ros_session")!);
    expect(who.memberships).toEqual([expect.objectContaining({ companyId, role: "interviewer" })]);
    expect((await container.db.select().from(invitations).where(eq(invitations.email, "ivy.interviewer@teamtest.test")))[0].status).toBe("accepted");
  });

  it("refuses the invitation for a different address and keeps it for the right one", async () => {
    const created = (await (await invite(owner, { email: "holly.hr@teamtest.test", role: "hr" })).json()) as InviteResponse;
    const page = await app.request(pathOf(created.devLink));
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
    hr = cookieNamed(right, "ros_session")!;
    expect((await me(hr)).memberships).toEqual([expect.objectContaining({ companyId, role: "hr" })]);
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
    expect((await invite(owner, { email: "x@teamtest.test", role: "recruiter" })).status).toBe(400);
    expect((await invite(owner, { email: "not-an-email", role: "admin" })).status).toBe(400);
    const first = (await (await invite(owner, { email: "ann.admin@teamtest.test", role: "admin" })).json()) as InviteResponse;
    const second = (await (await invite(owner, { email: "ann.admin@teamtest.test", role: "admin" })).json()) as InviteResponse;
    expect(second.replaced).toBe(1);
    expect(second.devLink).not.toBe(first.devLink);
    const pending = (await (await json(owner, "GET", "/api/v1/companies/current/invitations")).json()) as Array<{ email: string }>;
    expect(pending.filter((p) => p.email === "ann.admin@teamtest.test")).toHaveLength(1);
    const old = await app.request(pathOf(first.devLink));
    expect(await old.text()).toContain("withdrawn");
    expect(cookieNamed(old, "ros_invite")).toBeNull();
    expect(await (await app.request(pathOf(second.devLink))).text()).toContain("Join Teamtest Dental");
    annLink = second.devLink;
  });

  it("an expired invitation is refused on the page and at sign-in, and the cookie is dropped; sending it again revives it", async () => {
    const created = (await (await invite(owner, { email: "eve.late@teamtest.test", role: "interviewer" })).json()) as InviteResponse;
    const page = await app.request(pathOf(created.devLink));
    const inviteCookie = cookieNamed(page, "ros_invite")!;
    await withPlatform(container.db, (tx) => tx.update(invitations).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(invitations.id, created.invitation.id)));
    const expired = await app.request(pathOf(created.devLink));
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
    expect((await (await json(owner, "GET", "/api/v1/companies/current/invitations")).json() as Array<{ email: string }>).some((p) => p.email === "eve.late@teamtest.test")).toBe(false);
    // sent again: seven more days and a new link
    const resent = await json(owner, "POST", `/api/v1/companies/current/invitations/${created.invitation.id}/resend`);
    expect(resent.status).toBe(200);
    const body = (await resent.json()) as InviteResponse;
    expect(Date.parse(body.invitation.expiresAt)).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect(body.devLink).not.toBe(created.devLink);
    expect(await (await app.request(pathOf(body.devLink))).text()).toContain("Join Teamtest Dental");
  });

  it("resend issues a new link (the old one stops working) and revoke ends it", async () => {
    const [ann] = await container.db.select().from(invitations).where(and(eq(invitations.email, "ann.admin@teamtest.test"), eq(invitations.status, "pending")));
    const resent = await json(owner, "POST", `/api/v1/companies/current/invitations/${ann.id}/resend`);
    expect(resent.status).toBe(200);
    const body = (await resent.json()) as InviteResponse;
    expect(body.devLink).not.toBe(annLink);
    expect(await (await app.request(pathOf(annLink))).text()).toContain("not valid");
    expect(await (await app.request(pathOf(body.devLink))).text()).toContain("Join Teamtest Dental");
    const sent = mail().sent.filter((m) => m.to === "ann.admin@teamtest.test");
    expect(sent).toHaveLength(3); // the first invitation, its replacement, and the reminder
    expect(sent[2].subject).toMatch(/^Reminder: /);
    expect(sent[2].text).toContain(body.devLink);
    expect(await container.db.select().from(auditRecords).where(eq(auditRecords.action, "invitation.resent"))).toHaveLength(2);
    // HR can withdraw it (members.manage); an interviewer cannot
    const ivy = await session(idp().mint({ email: "ivy.interviewer@teamtest.test", provider: "azure" }));
    expect((await json(cookieNamed(ivy, "ros_session")!, "POST", `/api/v1/companies/current/invitations/${ann.id}/revoke`)).status).toBe(403);
    const revoked = await json(hr, "POST", `/api/v1/companies/current/invitations/${ann.id}/revoke`);
    expect(revoked.status).toBe(200);
    expect(((await revoked.json()) as InviteResponse).invitation.status).toBe("revoked");
    expect(await (await app.request(pathOf(body.devLink))).text()).toContain("withdrawn");
    expect((await (await json(owner, "GET", "/api/v1/companies/current/invitations")).json() as Array<{ email: string }>).some((p) => p.email === "ann.admin@teamtest.test")).toBe(false);
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
    const members = (await (await json(owner, "GET", "/api/v1/companies/current/members")).json()) as Array<{ userId: string; email: string }>;
    const hankId = members.find((m) => m.email === "hank.manager@teamtest.test")!.userId;
    const patch = (cookie: string, userId: string, body: unknown) => json(cookie, "PATCH", `/api/v1/companies/current/members/${userId}`, body);
    expect((await patch(owner, hankId, { role: "recruiter" })).status).toBe(400);
    expect((await patch(owner, hankId, { role: "boss" })).status).toBe(400);
    expect((await patch(owner, hankId, { status: "invited" })).status).toBe(400);
    expect((await patch(owner, hankId, {})).status).toBe(400);
    expect((await patch(owner, "00000000-0000-0000-0000-000000000000", { role: "admin" })).status).toBe(404);
    expect((await patch(owner, "not-a-uuid", { role: "admin" })).status).toBe(404); // not even an id: a 404 in the route's words, never a database error
    const self = await patch(owner, ownerId, { role: "admin" });
    expect(self.status).toBe(409);
    expect(await errorCode(self)).toBe("self_change");
    expect(await errorCode(await patch(owner, ownerId, { status: "removed" }))).toBe("self_change");
    const promote = await patch(hr, hankId, { role: "owner" });
    expect(promote.status).toBe(403);
    expect(await errorCode(promote)).toBe("owner_only");
    const removeOwner = await patch(hr, ownerId, { status: "removed" });
    expect(removeOwner.status).toBe(409);
    expect(await errorCode(removeOwner)).toBe("last_owner");
    expect(await errorCode(await patch(hr, ownerId, { role: "admin" }))).toBe("last_owner");
    // a second owner joins; the first owner demotes them (two owners, so allowed), which ends their sessions
    const olive = await signInAs(container, app, { companyId, role: "owner", email: "olive.owner@teamtest.test", name: "Olive" });
    const oliveId = (await me(olive)).user.id;
    // with two owners the last-owner guard no longer answers first; an admin or HR still cannot demote or remove either of them
    const admin = await signInAs(container, app, { companyId, role: "admin", email: "adam.admin@teamtest.test", name: "Adam" });
    for (const [who, cookie] of [["admin", admin], ["hr", hr]] as const) {
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
    const demoted = (await demote.json()) as { role: string; status: string; sessionsEnded: number };
    expect(demoted).toMatchObject({ role: "admin", status: "active" });
    expect(demoted.sessionsEnded).toBeGreaterThanOrEqual(1);
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
    expect(await container.db.select().from(auditRecords).where(and(eq(auditRecords.action, "session.revoked"), eq(auditRecords.reason, "role changed")))).toHaveLength(1);
  });

  it("only an owner invites an owner: HR and an admin are refused (403 owner_only) on the invitation and on sending it again; the owner's goes out", async () => {
    const abby = await signInAs(container, app, { companyId, role: "admin", email: "abby.admin@teamtest.test", name: "Abby Admin" });
    for (const cookie of [hr, abby]) {
      const r = await invite(cookie, { email: "second.owner@teamtest.test", role: "owner" });
      expect(r.status).toBe(403);
      expect(await errorCode(r)).toBe("owner_only");
    }
    expect(await container.db.select().from(invitations).where(eq(invitations.email, "second.owner@teamtest.test"))).toHaveLength(0);
    expect(mail().sent.filter((m) => m.to === "second.owner@teamtest.test")).toHaveLength(0);
    // the owner may, and only the owner may send it again: a refused resend rolls back, so the first link still works
    const created = (await (await invite(owner, { email: "second.owner@teamtest.test", role: "owner" })).json()) as InviteResponse;
    expect(created.invitation).toMatchObject({ role: "owner", status: "pending" });
    for (const cookie of [hr, abby]) {
      const r = await json(cookie, "POST", `/api/v1/companies/current/invitations/${created.invitation.id}/resend`);
      expect(r.status).toBe(403);
      expect(await errorCode(r)).toBe("owner_only");
    }
    expect(await (await app.request(pathOf(created.devLink))).text()).toContain("Join Teamtest Dental");
    expect(mail().sent.filter((m) => m.to === "second.owner@teamtest.test")).toHaveLength(1);
    expect((await json(owner, "POST", `/api/v1/companies/current/invitations/${created.invitation.id}/revoke`)).status).toBe(200);
  });

  it("removal ends sessions, queues the calendar credential's deletion, cancels the interview nobody else was on, keeps the one others run, and hides the person", async () => {
    const wes = await signInAs(container, app, { companyId, role: "interviewer", email: "wes.leaving@teamtest.test", name: "Wes Leaving" });
    const wesId = (await me(wes)).user.id;
    await withTenant(container.db, companyId, (tx) => connectCalendar(tx, container.integrations.secrets, { companyId, userId: wesId, provider: "google", refreshToken: "wes-refresh-token-value", account: { email: "wes@calendar.test", calendarId: "wes@calendar.test", timeZone: "America/Los_Angeles" }, scopes: ["calendar.events"], actor: { kind: "user", id: wesId, name: "Wes Leaving" } }));
    const applicationId = await seedApplication("pat.lee@candidate.test");
    const sharedApplicationId = await seedApplication("sam.shared@candidate.test");
    const startsAt = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const endsAt = new Date(Date.now() + 3 * 86_400_000 + 45 * 60_000).toISOString();
    // Wes alone on a booked interview; Wes and the owner together on another
    const { interviewId, sharedInterviewId } = await withTenant(container.db, companyId, async (tx) => {
      await tx.update(applications).set({ stage: "interview_scheduled" }).where(eq(applications.id, applicationId));
      const [iv] = await tx.insert(interviews).values({ companyId, applicationId, roundKey: "r1", title: "Working interview", format: "onsite", durationMinutes: 45, status: "scheduled", startsAt, endsAt, timezone: "America/Los_Angeles", createdBy: { kind: "user", id: ownerId }, calendarRefs: { [wesId]: { provider: "google", eventId: "evt-wes", htmlLink: null, meetingUrl: null } } }).returning();
      await tx.insert(interviewParticipants).values({ companyId, interviewId: iv.id, userId: wesId, role: "interviewer", status: "invited" });
      const [shared] = await tx.insert(interviews).values({ companyId, applicationId: sharedApplicationId, roundKey: "r1", title: "Chairside interview", format: "onsite", durationMinutes: 45, status: "scheduling", timezone: "America/Los_Angeles", createdBy: { kind: "user", id: ownerId } }).returning();
      await tx.insert(interviewParticipants).values([{ companyId, interviewId: shared.id, userId: wesId, role: "interviewer", status: "invited" }, { companyId, interviewId: shared.id, userId: ownerId, role: "interviewer", status: "invited" }]);
      return { interviewId: iv.id, sharedInterviewId: shared.id };
    });
    const before = (await (await json(owner, "GET", "/api/v1/companies/current/members")).json()) as Array<{ userId: string; calendar: { status: string } | null }>;
    expect(before.find((m) => m.userId === wesId)?.calendar?.status).toBe("live");

    const r = await json(owner, "PATCH", `/api/v1/companies/current/members/${wesId}`, { status: "removed" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { status: string; sessionsEnded: number; calendarDeletionQueued: boolean; interviewsFlagged: number; interviewsCancelled: number };
    expect(body).toMatchObject({ status: "removed", calendarDeletionQueued: true, interviewsFlagged: 2, interviewsCancelled: 1 });
    expect(body.sessionsEnded).toBeGreaterThanOrEqual(1);
    // the removed person's next request is refused outright
    expect((await json(wes, "GET", "/api/v1/auth/me")).status).toBe(401);
    // gone from the team; a fresh sign-in has no company and no tenant
    const after = (await (await json(owner, "GET", "/api/v1/companies/current/members")).json()) as Array<{ userId: string }>;
    expect(after.some((m) => m.userId === wesId)).toBe(false);
    const fresh = await session(idp().mint({ email: "wes.leaving@teamtest.test", provider: "google" }));
    expect(fresh.status).toBe(200);
    expect(((await fresh.json()) as { activeCompanyId: string | null }).activeCompanyId).toBeNull();
    const freshCookie = cookieNamed(fresh, "ros_session")!;
    expect((await me(freshCookie)).memberships).toEqual([]);
    expect((await json(freshCookie, "GET", "/api/v1/roles")).status).toBe(403);
    expect((await json(freshCookie, "POST", "/api/v1/auth/switch", { companyId })).status).toBe(403);
    // the credential's deletion was queued exactly as a disconnect does, and the inline worker has run it
    const queued = await container.db.select().from(jobs).where(eq(jobs.kind, "integration.revoke_and_delete"));
    const [conn] = await container.db.select().from(integrations).where(and(eq(integrations.userId, wesId), eq(integrations.kind, "calendar")));
    expect(queued.some((j) => (j.payload as { integrationId?: string }).integrationId === conn.id)).toBe(true);
    expect(conn.status).toBe("not_connected");
    expect(conn.disconnectReason).toBe("removed from the team");
    expect(conn.secretRef).toBeNull();
    // off the interviews for real (the scheduling path reads participants without looking at any status), the booking in their disconnected calendar no longer referenced
    expect(await container.db.select().from(interviewParticipants).where(and(eq(interviewParticipants.interviewId, interviewId), eq(interviewParticipants.userId, wesId)))).toHaveLength(0);
    expect(await withTenant(container.db, companyId, (tx) => participantsOf(tx, interviewId))).toEqual([]);
    const [gone] = await container.db.select().from(interviews).where(eq(interviews.id, interviewId));
    expect(gone.calendarRefs).toEqual({});
    // the interview nobody else was on cannot take place: cancelled (its run ends on the new attempt), the candidate back at
    // "Interview approved" for a new approval, and told through the outbox that the booked time is off
    expect(gone).toMatchObject({ status: "cancelled", attempt: 2 });
    expect(gone.cancelReason).toContain("only interviewer");
    expect((await container.db.select().from(applications).where(eq(applications.id, applicationId)))[0].stage).toBe("interview_recommended");
    expect(mail().sent.some((m) => m.to === "pat.lee@candidate.test")).toBe(true);
    expect((await container.db.select().from(events).where(and(eq(events.type, "interview.cancelled"), eq(events.subjectId, interviewId))))[0].payload).toMatchObject({ cause: "interviewer_removed" });
    // the interview the owner also runs goes ahead with the owner alone
    const [shared] = await container.db.select().from(interviews).where(eq(interviews.id, sharedInterviewId));
    expect(shared.status).toBe("scheduling");
    expect((await withTenant(container.db, companyId, (tx) => participantsOf(tx, sharedInterviewId))).map((p) => p.userId)).toEqual([ownerId]);
    // and the owners are told what happened to each, with no promise of a control that does not exist
    const told = await container.db.select().from(notifications).where(and(eq(notifications.kind, "member.removed_interviews"), eq(notifications.userId, ownerId)));
    expect(told).toHaveLength(1);
    expect(told[0].title).toBe("Wes Leaving was removed; an interview was cancelled");
    expect(told[0].body).toContain("Working interview: Wes Leaving was the only interviewer, so that interview was cancelled.");
    expect(told[0].body).toContain("The candidate who had a booked time was told");
    expect(told[0].body).toContain("approve a new interview with another interviewer");
    expect(told[0].body).toContain("Chairside interview: goes ahead with the other interviewers.");
    expect(told[0].body).not.toContain("add an interviewer");
    expect(await container.db.select().from(events).where(and(eq(events.type, "member.removed"), eq(events.subjectId, wesId)))).toHaveLength(1);
    // removing them again is a 404: not an active member
    expect((await json(owner, "PATCH", `/api/v1/companies/current/members/${wesId}`, { status: "removed" })).status).toBe(404);
    // re-invited, the old membership row comes back active with the new role
    expect((await invite(owner, { email: "wes.leaving@teamtest.test", role: "hr" })).status).toBe(201);
    const back = await session(idp().mint({ email: "wes.leaving@teamtest.test", provider: "google" }));
    expect(((await back.json()) as { activeCompanyId: string | null }).activeCompanyId).toBe(companyId);
    expect((await me(cookieNamed(back, "ros_session")!)).memberships).toEqual([expect.objectContaining({ companyId, role: "hr" })]);
  });

  it("the email-link sign-in refuses a carried invitation for another address, records it, and spends nothing", async () => {
    const created = (await (await invite(owner, { email: "mira.mail@teamtest.test", role: "interviewer" })).json()) as InviteResponse;
    const inviteCookie = cookieNamed(await app.request(pathOf(created.devLink)), "ros_invite")!;
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
    const created = (await (await invite(owner, { email: "lena.link@teamtest.test", role: "interviewer" })).json()) as InviteResponse;
    const token = new URL(created.devLink).searchParams.get("token")!;
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
    type Role = "hiring_manager" | "interviewer" | "hr" | "admin";
    const ROLES: Role[] = ["interviewer", "hr", "hiring_manager", "admin"];
    /** true: succeeds (a 2xx answer); false: refused with 403. */
    const TABLE: Record<string, Record<Role, boolean>> = {
      "GET /roles": { hiring_manager: true, interviewer: true, hr: true, admin: true },
      "POST /roles/:id/approve": { hiring_manager: true, interviewer: false, hr: false, admin: true },
      "POST /companies/current/members/invite": { hiring_manager: false, interviewer: false, hr: true, admin: true },
      "PUT /policies": { hiring_manager: false, interviewer: false, hr: false, admin: true },
      "GET /roles/:id/packets": { hiring_manager: true, interviewer: true, hr: true, admin: true },
      "POST /applications/:id/actions reject": { hiring_manager: true, interviewer: false, hr: false, admin: true },
      "GET /companies/current/audit": { hiring_manager: true, interviewer: false, hr: true, admin: true },
    };
    const cookies: Partial<Record<Role, string>> = {};
    /** Approving and declining change state, so a role that may do either gets its own drafted role, and every role its own application. */
    const roleFor: Partial<Record<Role, string>> = {};
    const applicationFor: Partial<Record<Role, string>> = {};
    beforeAll(async () => {
      // the trial plan allows one active role; the extra drafts need room
      await withTenant(container.db, companyId, (tx) => tx.update(entitlements).set({ limit: 5 }).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, "active_roles"))));
      for (const role of ROLES) {
        cookies[role] = await signInAs(container, app, { companyId, role });
        roleFor[role] = TABLE["POST /roles/:id/approve"][role] ? await compileRole() : roleId;
        applicationFor[role] = await seedApplication(`pat.${role.replace(/_/g, "-")}@candidate.test`, roleFor[role]);
      }
    });

    it.each(ROLES)("%s: the expected routes succeed and the rest are refused with 403", async (role) => {
      const cookie = cookies[role]!;
      const rid = roleFor[role]!;
      const calls: Record<string, () => Response | Promise<Response>> = {
        "GET /roles": () => json(cookie, "GET", "/api/v1/roles"),
        "POST /roles/:id/approve": () => json(cookie, "POST", `/api/v1/roles/${rid}/approve`, { version: 1 }),
        "POST /companies/current/members/invite": () => invite(cookie, { email: `${role.replace(/_/g, "-")}-invitee@teamtest.test`, role: "interviewer" }),
        "PUT /policies": () => json(cookie, "PUT", "/api/v1/policies", { actionType: "message.send_templated", level: "auto_notify", approverRoles: [] }),
        "GET /roles/:id/packets": () => json(cookie, "GET", `/api/v1/roles/${rid}/packets`),
        "POST /applications/:id/actions reject": () => json(cookie, "POST", `/api/v1/applications/${applicationFor[role]}/actions`, { action: "reject", reason: "not_a_match_experience", note: "role coverage" }),
        "GET /companies/current/audit": () => json(cookie, "GET", "/api/v1/companies/current/audit"),
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

    it("an interviewer reads packets without pay figures; a hiring manager sees them", async () => {
      const asInterviewer = (await (await json(cookies.interviewer!, "GET", `/api/v1/roles/${roleId}/packets`)).json()) as Array<{ packet: { compensation: Record<string, unknown> } }>;
      expect(asInterviewer.length).toBeGreaterThan(0);
      for (const p of asInterviewer) {
        expect(p.packet.compensation).not.toHaveProperty("min");
        expect(p.packet.compensation).not.toHaveProperty("max");
        expect(p.packet.compensation).not.toHaveProperty("mid");
        expect(p.packet.compensation).not.toHaveProperty("ceiling");
        expect(p.packet.compensation).toHaveProperty("basis");
      }
      const asManager = (await (await json(cookies.hiring_manager!, "GET", `/api/v1/roles/${roleId}/packets`)).json()) as Array<{ packet: { compensation: { min: number; max: number } } }>;
      expect(typeof asManager[0].packet.compensation.min).toBe("number");
      expect(asManager[0].packet.compensation.max).toBeGreaterThan(0);
      // GET /roles/:id keeps its own redaction for the interviewer
      const detail = (await (await json(cookies.interviewer!, "GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { compensation: { min: number; max: number } } } | null };
      expect(detail.currentPacket?.packet.compensation.max).toBe(0);
    });
  });
});
