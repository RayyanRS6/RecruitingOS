import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { can, entitlements } from "@ros/core";
import type { FakeEmailAdapter } from "@ros/integrations";
import { auditRecords, events, recruiterEscalations, staffAccessGrants, users } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { signInAdmin, signInStaff } from "./test-helpers";

/**
 * Founder decision F10: ITS recruiters get explicit, scoped, time-limited access only after accepting an assignment;
 * every request is recorded; break-glass is refused without MFA.
 */
describe("ITS recruiter access is explicit, scoped, time-limited and audited", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  const signIn = async (email: string) => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const { devLink } = (await r1.json()) as { devLink: string };
    const token = new URL(devLink).searchParams.get("token")!;
    const r2 = await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    return r2.headers.get("set-cookie")!.split(";")[0];
  };
  const json = (cookie: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
    app.request(path, { method, headers: { "content-type": "application/json", cookie, ...extra }, body: body ? JSON.stringify(body) : undefined });

  let owner = "";
  let recruiter = "";
  let otherRecruiter = "";
  let admin = "";
  let companyId = "";
  let roleInScope = "";
  let roleOutOfScope = "";
  let escalationId = "";

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    owner = await signIn("owner@glow.test");
    recruiter = await signInStaff(app, container, "sam@its.test", "its_recruiter", "sam");
    otherRecruiter = await signInStaff(app, container, "jo@its.test", "its_recruiter", "jo");
    admin = await signInAdmin(app, container, "admin@its.test", "admin");
    const co = (await (await json(owner, "POST", "/api/v1/companies", { name: "Glow Theory", vertical: "beauty", sizeBand: "50-99", locations: [{ city: "Los Angeles", region: "CA", country: "US" }] })).json()) as { id: string };
    companyId = co.id;
    await entitlements.applyPlan(container.db, companyId, "growth");
    const compile = async (msg: string) => {
      const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: msg })).json()) as { session: { id: string } };
      const r = (await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string };
      return r.roleId;
    };
    roleInScope = await compile("I need a performance marketing manager in Los Angeles, $95,000 to $115,000, hybrid. It's growth. Ceiling $120,000. I decide. Must-haves: paid social experience. Just draft it.");
    roleOutOfScope = await compile("I need an ecommerce manager in Los Angeles, $90,000 to $110,000, hybrid. It's growth. Ceiling $115,000. I decide. Must-haves: Shopify experience. Just draft it.");
  });
  afterAll(async () => {
    await container.close();
  });

  it("the customer asks for help and gets a business-hours response time", async () => {
    const r = await json(owner, "POST", "/api/v1/escalations", { kind: "review", roleId: roleInScope, question: "Is our shortlist for the marketing manager any good?" });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { id: string; slaDueAt: string; message: string };
    escalationId = body.id;
    expect(body.message).toMatch(/business hours are Monday to Friday, 9 to 5/);
    expect(Date.parse(body.slaDueAt)).toBeGreaterThan(Date.now());
  });

  it("before accepting, a recruiter sees only what is needed to accept, and has no tenant access", async () => {
    const list = (await (await json(recruiter, "GET", "/api/v1/escalations")).json()) as Array<{ id: string; companyName: string; roleTitle: string | null; summary: string; urgency: string; requiredExpertise: string; question?: string; questionPreview?: string; companyId?: string; claimedByMe: boolean }>;
    const row = list.find((e) => e.id === escalationId)!;
    expect(row.companyName).toBe("Glow Theory");
    expect(row.roleTitle).toBeTruthy();
    // correction 11: a generic summary, never the customer's words or identifiers that lead to candidate data
    expect(row.summary).toBe("The customer wants a recruiter to review the candidates for this role.");
    expect(row.urgency).toBe("normal");
    expect(row.requiredExpertise).toMatch(/candidate evaluation/);
    expect(row.question).toBeUndefined();
    expect(row.questionPreview).toBeUndefined();
    expect(row.companyId).toBeUndefined();
    const detail = (await (await json(recruiter, "GET", `/api/v1/escalations/${escalationId}`)).json()) as { accessGranted: boolean; contextSnapshot?: unknown };
    expect(detail.accessGranted).toBe(false);
    expect(detail.contextSnapshot).toBeUndefined();
    expect((await json(recruiter, "GET", "/api/v1/roles")).status).toBe(403);
    expect((await json(recruiter, "POST", "/api/v1/auth/switch", { companyId })).status).toBe(403);
  });

  it("accepting the assignment creates a scoped, time-limited grant the customer can see", async () => {
    const r = await json(recruiter, "POST", `/api/v1/escalations/${escalationId}/claim`);
    expect(r.status).toBe(200);
    const { grant, escalation } = (await r.json()) as { grant: { id: string; expiresAt: string; scope: { roleId: string | null } }; escalation: { firstResponseAt: string | null; status: string } };
    expect(escalation.status).toBe("claimed");
    expect(escalation.firstResponseAt).toBeTruthy();
    expect(grant.scope.roleId).toBe(roleInScope);
    const days = (Date.parse(grant.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13);
    expect(days).toBeLessThanOrEqual(14);
    const detail = (await (await json(recruiter, "GET", `/api/v1/escalations/${escalationId}`)).json()) as { accessGranted: boolean; contextSnapshot: { role?: { title: string } }; question: string };
    expect(detail.accessGranted).toBe(true);
    expect(detail.contextSnapshot.role?.title).toBeTruthy();
    expect(detail.question).toMatch(/shortlist/);
    // the customer sees the grant in their own event log
    const seen = (await (await json(owner, "GET", "/api/v1/events?type=recruiter.access_granted")).json()) as Array<{ payload: { recruiter: string; expiresAt: string } }>;
    expect(seen).toHaveLength(1);
    expect(seen[0].payload.recruiter).toBe("sam");
    // another recruiter cannot take it or open it
    expect((await json(otherRecruiter, "POST", `/api/v1/escalations/${escalationId}/claim`)).status).toBe(409);
    const other = (await (await json(otherRecruiter, "GET", `/api/v1/escalations/${escalationId}`)).json()) as { accessGranted: boolean };
    expect(other.accessGranted).toBe(false);
  });

  it("inside the customer, access is limited to the assigned role and every request is recorded", async () => {
    expect((await json(recruiter, "POST", "/api/v1/auth/switch", { companyId })).status).toBe(200);
    const me = (await (await json(recruiter, "GET", "/api/v1/auth/me")).json()) as { activeCompanyId: string; staffAccess: { purpose: string; companyName: string; scope: { roleId: string } } };
    expect(me.activeCompanyId).toBe(companyId);
    expect(me.staffAccess.companyName).toBe("Glow Theory");
    expect(me.staffAccess.scope.roleId).toBe(roleInScope);
    const list = (await (await json(recruiter, "GET", "/api/v1/roles")).json()) as Array<{ id: string }>;
    expect(list.map((r) => r.id)).toEqual([roleInScope]);
    expect((await json(recruiter, "GET", `/api/v1/roles/${roleInScope}`)).status).toBe(200);
    expect((await json(recruiter, "GET", `/api/v1/roles/${roleInScope}/applications`)).status).toBe(200);
    const denied = await json(recruiter, "GET", `/api/v1/roles/${roleOutOfScope}`);
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe("staff_scope");
    expect((await json(recruiter, "GET", `/api/v1/roles/${roleOutOfScope}/applications`)).status).toBe(403);
    // a recruiter under a grant cannot change the customer's rules or team
    expect((await json(recruiter, "PUT", "/api/v1/policies", { actionType: "application.invite_screen", level: "auto", approverRoles: [] })).status).toBe(403);
    const accessLog = await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "staff.tenant_accessed")));
    expect(accessLog.length).toBeGreaterThanOrEqual(4);
    const sample = accessLog.find((a) => (a.details as { path?: string }).path === `/api/v1/roles/${roleInScope}`)!;
    expect(sample.actor.kind).toBe("recruiter");
    expect((sample.details as { expiresAt?: string }).expiresAt).toBeTruthy();
    expect(sample.reason).toMatch(/^review:/);
  });

  it("resolution records effort and shortens access to a day; expiry ends it and the customer is told", async () => {
    const r = await json(recruiter, "POST", `/api/v1/escalations/${escalationId}/resolve`, { resolution: "Two of the five are worth interviewing; notes on the candidate pages.", minutesSpent: 25 });
    expect(r.status).toBe(200);
    const [e] = await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.id, escalationId));
    expect(e.status).toBe("resolved");
    expect(e.minutesSpent).toBe(25);
    expect(Date.parse(e.accessExpiresAt!) - Date.now()).toBeLessThanOrEqual(24 * 3600_000 + 5000);
    const resolved = await container.db.select().from(events).where(and(eq(events.companyId, companyId), eq(events.type, "recruiter.resolved")));
    expect((resolved[0].payload as { responseMinutes: number | null }).responseMinutes).not.toBeNull();
    // still inside the day: access continues; then the clock runs out
    expect((await json(recruiter, "GET", `/api/v1/roles/${roleInScope}`)).status).toBe(200);
    await container.db.update(staffAccessGrants).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(staffAccessGrants.escalationId, escalationId));
    expect((await json(recruiter, "GET", `/api/v1/roles/${roleInScope}`)).status).toBe(403);
    const ended = await container.db.select().from(events).where(and(eq(events.companyId, companyId), eq(events.type, "recruiter.access_ended")));
    expect(ended).toHaveLength(1);
    const detail = (await (await json(recruiter, "GET", `/api/v1/escalations/${escalationId}`)).json()) as { accessGranted: boolean; why: string };
    expect(detail.accessGranted).toBe(false);
    expect(detail.why).toMatch(/ended/);
  });

  it("break-glass needs a second factor verified in the last 15 minutes, and the grant ledger is admin-only", async () => {
    // the administrator's session was opened with Microsoft + TOTP moments ago: allowed, short, audited
    const ok = await json(admin, "POST", "/api/v1/admin/break-glass", { companyId, reason: "Investigating a reported data issue for the customer.", minutes: 30 }, { "x-admin-reason": "test" });
    expect(ok.status).toBe(201);
    const { sessions } = await import("@ros/db");
    const [adminUser] = await container.db.select().from(users).where(eq(users.email, "admin@its.test"));
    // a stale second factor (20 minutes old) is refused even though the session still carries aal2
    await container.db.update(sessions).set({ mfaVerifiedAt: new Date(Date.now() - 20 * 60_000).toISOString() }).where(eq(sessions.userId, adminUser.id));
    const r = await json(admin, "POST", "/api/v1/admin/break-glass", { companyId, reason: "Investigating a reported data issue for the customer.", minutes: 30 }, { "x-admin-reason": "test" });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("mfa_required");
    expect((await json(recruiter, "GET", "/api/v1/admin/staff-access")).status).toBe(403);
    const ledger = (await (await json(admin, "GET", "/api/v1/admin/staff-access", undefined, { "x-admin-reason": "test" })).json()) as Array<{ userEmail: string; kind: string; endedAt: string | null }>;
    expect(ledger.some((g) => g.userEmail === "sam@its.test" && g.kind === "escalation" && g.endedAt)).toBe(true);
  });

  it("the customer can end a recruiter's access at once: confirmed, reasoned, audited, the recruiter told, the request back in the queue", async () => {
    // a fresh request that another recruiter accepts
    const created = (await (await json(owner, "POST", "/api/v1/escalations", { kind: "review", roleId: roleInScope, question: "Second look at the shortlist, please." })).json()) as { id: string };
    expect((await json(otherRecruiter, "POST", `/api/v1/escalations/${created.id}/claim`)).status).toBe(200);
    expect((await json(otherRecruiter, "POST", "/api/v1/auth/switch", { companyId })).status).toBe(200);
    expect((await json(otherRecruiter, "GET", `/api/v1/roles/${roleInScope}`)).status).toBe(200);
    // the customer sees who has access and to what
    const visible = (await (await json(owner, "GET", "/api/v1/companies/current/staff-access")).json()) as Array<{ id: string; active: boolean; recruiterEmail: string; roleTitle: string | null; escalationId: string | null }>;
    const grant = visible.find((g) => g.active && g.recruiterEmail === "jo@its.test")!;
    expect(grant).toBeTruthy();
    expect(grant.escalationId).toBe(created.id);
    expect(grant.roleTitle).toBeTruthy();
    // only owners and admins may end it; the recruiter themselves (role "recruiter" under the grant) cannot, nor can interviewers or hiring managers
    expect(can("owner", "staff_access.revoke")).toBe(true);
    expect(can("admin", "staff_access.revoke")).toBe(true);
    expect(can("hiring_manager", "staff_access.revoke")).toBe(false);
    expect(can("interviewer", "staff_access.revoke")).toBe(false);
    expect(can("recruiter", "staff_access.revoke")).toBe(false);
    expect((await json(otherRecruiter, "POST", `/api/v1/companies/current/staff-access/${grant.id}/revoke`, { reason: "trying to hide", confirm: true })).status).toBe(403);
    // confirmation and a reason are required
    expect(((await (await json(owner, "POST", `/api/v1/companies/current/staff-access/${grant.id}/revoke`, { reason: "We found what we needed." })).json()) as { error: { code: string } }).error.code).toBe("confirmation_required");
    expect(((await (await json(owner, "POST", `/api/v1/companies/current/staff-access/${grant.id}/revoke`, { reason: "no", confirm: true })).json()) as { error: { code: string } }).error.code).toBe("reason_required");
    const priorRows = await container.db.select().from(auditRecords).where(eq(auditRecords.companyId, companyId));
    const priorAudits = priorRows.length;
    const email = container.integrations.email as FakeEmailAdapter;
    email.sent.length = 0;
    const r = await json(owner, "POST", `/api/v1/companies/current/staff-access/${grant.id}/revoke`, { reason: "We found what we needed, thank you.", confirm: true });
    expect(r.status).toBe(200);
    // immediate: the recruiter's very next request under this company is refused
    expect((await json(otherRecruiter, "GET", `/api/v1/roles/${roleInScope}`)).status).toBe(403);
    const [row] = await container.db.select().from(staffAccessGrants).where(eq(staffAccessGrants.id, grant.id));
    expect(row.revokedAt).toBeTruthy();
    expect(row.endedAt).toBeTruthy();
    expect(row.revokeReason).toContain("We found what we needed, thank you.");
    // recorded in the customer's own history with actor, time, reason and scope; earlier records untouched
    const audits = await container.db.select().from(auditRecords).where(eq(auditRecords.companyId, companyId));
    const revoked = audits.filter((a) => a.action === "staff.access_revoked");
    expect(revoked).toHaveLength(1);
    expect(revoked[0].actor.kind).toBe("user");
    const [ownerUser] = await container.db.select().from(users).where(eq(users.email, "owner@glow.test"));
    expect(revoked[0].actor.id).toBe(ownerUser.id);
    expect(revoked[0].reason).toBe("We found what we needed, thank you.");
    expect((revoked[0].details as { revokedAt: string }).revokedAt).toBeTruthy();
    expect((revoked[0].details as { scope: { roleId: string | null }; recruiterUserId: string }).scope.roleId).toBe(roleInScope);
    expect(revoked[0].createdAt).toBeTruthy();
    expect(audits.length).toBeGreaterThan(priorAudits);
    // every earlier record is byte-for-byte unchanged
    const byId = new Map(audits.map((a) => [a.id, JSON.stringify(a)]));
    for (const p of priorRows) expect(byId.get(p.id)).toBe(JSON.stringify(p));
    expect(audits.filter((a) => a.action === "staff.access_granted").length).toBeGreaterThanOrEqual(2);
    const evs = await container.db.select().from(events).where(and(eq(events.companyId, companyId), eq(events.type, "recruiter.access_revoked")));
    expect(evs).toHaveLength(1);
    // the request goes back to the queue unassigned; the recruiter and the queue mailbox are told without candidate data
    const [esc] = await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.id, created.id));
    expect(esc.status).toBe("open");
    expect(esc.assignedToUserId).toBeNull();
    const toRecruiter = email.sent.find((m) => m.to === "jo@its.test")!;
    expect(toRecruiter.subject).toMatch(/ended by the customer/);
    expect(toRecruiter.text).toContain("We found what we needed, thank you.");
    expect(email.sent.some((m) => m.to === container.env.ITS_QUEUE_EMAIL)).toBe(true);
    // ending it twice is not possible; the past grant remains visible to the customer
    expect((await json(owner, "POST", `/api/v1/companies/current/staff-access/${grant.id}/revoke`, { reason: "again, please", confirm: true })).status).toBe(404);
    const after = (await (await json(owner, "GET", "/api/v1/companies/current/staff-access")).json()) as Array<{ id: string; active: boolean; revokeReason: string | null }>;
    expect(after.find((g) => g.id === grant.id)).toMatchObject({ active: false });
    // the removed recruiter cannot take the same request back; another recruiter can
    const again = await json(otherRecruiter, "POST", `/api/v1/escalations/${created.id}/claim`);
    expect(again.status).toBe(403);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe("revoked_by_customer");
    expect((await json(otherRecruiter, "GET", `/api/v1/roles/${roleInScope}`)).status).toBe(403);
    expect((await json(recruiter, "POST", `/api/v1/escalations/${created.id}/claim`)).status).toBe(200);
    // the customer's own history shows the revocation with the person, the time and the reason; staff cannot read it
    const history = (await (await json(owner, "GET", "/api/v1/companies/current/audit")).json()) as Array<{ action: string; actor: { name: string | null }; reason: string | null; at: string }>;
    const entry = history.find((h) => h.action === "staff.access_revoked")!;
    expect(entry).toBeTruthy();
    expect(entry.actor.name).toBeTruthy();
    expect(entry.reason).toBe("We found what we needed, thank you.");
    expect(entry.at).toBeTruthy();
    expect(history.some((h) => h.action === "staff.access_granted")).toBe(true);
    expect((await json(recruiter, "GET", "/api/v1/companies/current/audit")).status).toBe(403);
    // a malformed id is a plain not-found, and another company's owner cannot end this company's grants
    expect((await json(owner, "POST", "/api/v1/companies/current/staff-access/not-a-uuid/revoke", { reason: "We are done, thanks", confirm: true })).status).toBe(404);
    const stranger = await signIn("owner@other.test");
    await json(stranger, "POST", "/api/v1/companies", { name: "Other Co", vertical: "beauty", sizeBand: "20-49", locations: [{ city: "Reno", region: "NV", country: "US" }] });
    const [active] = await container.db.select().from(staffAccessGrants).where(and(eq(staffAccessGrants.escalationId, created.id), eq(staffAccessGrants.userId, (await container.db.select().from(users).where(eq(users.email, "sam@its.test")))[0].id)));
    expect((await json(stranger, "POST", `/api/v1/companies/current/staff-access/${active.id}/revoke`, { reason: "not my grant", confirm: true })).status).toBe(404);
    expect((await container.db.select().from(staffAccessGrants).where(eq(staffAccessGrants.id, active.id)))[0].endedAt).toBeNull();
    // ending access during the day after resolution does not reopen a resolved request
    expect((await json(recruiter, "POST", `/api/v1/escalations/${created.id}/resolve`, { resolution: "Done.", minutesSpent: 5 })).status).toBe(200);
    expect((await json(owner, "POST", `/api/v1/companies/current/staff-access/${active.id}/revoke`, { reason: "Thanks, all done now.", confirm: true })).status).toBe(200);
    const [resolved] = await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.id, created.id));
    expect(resolved.status).toBe("resolved");
    // when the recruiter cannot be emailed, the customer is told the truth and ITS is alerted
    const { adminAlerts } = await import("@ros/db");
    const { suppressAddress } = await import("@ros/core");
    await suppressAddress(container.db, { address: "jo@its.test", reason: "hard_bounce", source: "admin", actor: { kind: "system", id: "test" } });
    const third = (await (await json(owner, "POST", "/api/v1/escalations", { kind: "review", roleId: roleInScope, question: "One more look?" })).json()) as { id: string };
    expect((await json(otherRecruiter, "POST", `/api/v1/escalations/${third.id}/claim`)).status).toBe(200);
    const [joGrant] = await container.db.select().from(staffAccessGrants).where(eq(staffAccessGrants.escalationId, third.id));
    const quiet = (await (await json(owner, "POST", `/api/v1/companies/current/staff-access/${joGrant.id}/revoke`, { reason: "Changing direction on this role.", confirm: true })).json()) as { ok: boolean; recruiterNotified: boolean };
    expect(quiet.ok).toBe(true);
    expect(quiet.recruiterNotified).toBe(false);
    const alerts = await container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, "recruiter.notify_failed"));
    expect(alerts.length).toBe(1);
    expect(JSON.stringify(alerts)).not.toMatch(/candidate|Reyes/);
  });
});
