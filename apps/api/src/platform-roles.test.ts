import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { auditRecords, adminAlerts, platformRoleGrants, users } from "@ros/db";
import type { FakeEmailAdapter, FakeIdentityProvider } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { signInWithIdentity } from "./test-helpers";

/**
 * Founder instruction of 21 September 2026, item 2: platform authority comes from a ledger of named people, never from
 * an email address in configuration. The bootstrap list works once, for the first administrator, and then grants nothing.
 */
describe("platform administrators: one-time bootstrap, ledger, MFA, self-grant refusal, two-person visibility", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  const env = { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", AUTH_PROVIDER: "fake", ITS_QUEUE_EMAIL: "queue@identifiedtalent.com", BOOTSTRAP_ADMIN_EMAILS: "first@identifiedtalent.com,second@identifiedtalent.com" };
  const admin = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie, "x-admin-reason": "platform roles test" }, body: body ? JSON.stringify(body) : undefined });
  const email = () => container.integrations.email as FakeEmailAdapter;
  let first = "";
  let second = "";
  let third = "";
  let secondGrantId = "";

  beforeAll(async () => {
    container = await createContainer({ memory: true, env });
    app = createApp(container);
  });
  afterAll(async () => {
    await container.close();
  });

  it("the bootstrap list makes the first administrator only with Microsoft and a second factor, through the ledger", async () => {
    // a listed address without a second factor is refused outright
    const idp = container.integrations.identity as FakeIdentityProvider;
    const noMfa = await app.request("/api/v1/auth/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accessToken: idp.mint({ email: "first@identifiedtalent.com", provider: "azure", aal: "aal1" }) }) });
    expect(noMfa.status).toBe(403);
    expect(((await noMfa.json()) as { error: { code: string } }).error.code).toBe("mfa_required");
    expect(await container.db.select().from(platformRoleGrants)).toHaveLength(0);

    first = await signInWithIdentity(app, container, { email: "first@identifiedtalent.com", name: "First Admin", provider: "azure", aal2: true });
    const [u] = await container.db.select().from(users).where(eq(users.email, "first@identifiedtalent.com"));
    expect(u.platformRole).toBe("platform_admin");
    const ledger = await container.db.select().from(platformRoleGrants);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ userId: u.id, role: "platform_admin", source: "bootstrap", revokedAt: null });
    expect(ledger[0].grantedBy.kind).toBe("system");
    const audits = await container.db.select().from(auditRecords).where(eq(auditRecords.action, "platform_role.changed"));
    expect(audits.some((a) => a.target?.id === u.id && (a.details as { source?: string }).source === "bootstrap")).toBe(true);
  });

  it("an email match alone grants nothing once an administrator exists; the match is audited as ignored", async () => {
    second = await signInWithIdentity(app, container, { email: "second@identifiedtalent.com", name: "Second Person", provider: "azure", aal2: true });
    const [u] = await container.db.select().from(users).where(eq(users.email, "second@identifiedtalent.com"));
    expect(u.platformRole).toBe("none");
    expect((await admin(second, "GET", "/api/v1/admin/runs")).status).toBe(403);
    const ignored = await container.db.select().from(auditRecords).where(eq(auditRecords.action, "bootstrap.ignored"));
    expect(ignored.some((a) => a.target?.id === u.id)).toBe(true);
    // and the same for the first administrator signing in again: no second ledger row appears
    await signInWithIdentity(app, container, { email: "first@identifiedtalent.com", provider: "azure", aal2: true });
    expect(await container.db.select().from(platformRoleGrants)).toHaveLength(1);
    const status = (await (await admin(first, "GET", "/api/v1/admin/platform-roles")).json()) as { activeAdmins: number; bootstrap: { configured: number; ignored: boolean } };
    expect(status).toMatchObject({ activeAdmins: 1, bootstrap: { configured: 2, ignored: true } });
  });

  it("the role is not enough: an administrator session without a second factor is refused", async () => {
    // a magic link cannot open a staff session at all; a delegated sign-in without MFA is refused at sign-in. Simulate a
    // session that somehow lost its second factor by rewriting the session row and checking the guard.
    const { sessions } = await import("@ros/db");
    const [u] = await container.db.select().from(users).where(eq(users.email, "first@identifiedtalent.com"));
    const rows = await container.db.select().from(sessions).where(eq(sessions.userId, u.id));
    await container.db.update(sessions).set({ aal: "aal1" }).where(eq(sessions.id, rows[0].id));
    const r = await admin(first, "GET", "/api/v1/admin/runs");
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("mfa_required");
    await container.db.update(sessions).set({ aal: "aal2" }).where(eq(sessions.id, rows[0].id));
    expect((await admin(first, "GET", "/api/v1/admin/runs")).status).toBe(200);
  });

  it("nobody can grant themselves a role, and grants need a reason, a staff domain and a Microsoft sign-in", async () => {
    const self = await admin(first, "POST", "/api/v1/admin/platform-roles", { email: "first@identifiedtalent.com", role: "platform_admin", reason: "I want more", confirm: true });
    expect(self.status).toBe(403); // the self-grant rule fires before anything else
    const selfRecruiter = await admin(first, "POST", "/api/v1/admin/platform-roles", { email: "first@identifiedtalent.com", role: "its_recruiter", reason: "I want more", confirm: true });
    expect(selfRecruiter.status).toBe(403);
    expect(((await selfRecruiter.json()) as { error: { code: string } }).error.code).toBe("self_grant");
    expect((await admin(first, "POST", "/api/v1/admin/platform-roles", { email: "second@identifiedtalent.com", role: "platform_admin", reason: "", confirm: true })).status).toBe(400);
    expect((await admin(first, "POST", "/api/v1/admin/platform-roles", { email: "second@identifiedtalent.com", role: "platform_admin", reason: "covering on-call", confirm: false })).status).toBe(400);
    expect(((await (await admin(first, "POST", "/api/v1/admin/platform-roles", { email: "someone@customer.test", role: "platform_admin", reason: "covering on-call", confirm: true })).json()) as { error: { code: string } }).error.code).toBe("not_staff_domain");
    expect((await admin(first, "POST", "/api/v1/admin/platform-roles", { email: "never-signed-in@identifiedtalent.com", role: "platform_admin", reason: "covering on-call", confirm: true })).status).toBe(404);
    // an account that exists but was never verified through Microsoft (here: created by a Google sign-in before the domain became a staff domain) cannot be granted a role
    await container.db.insert(users).values({ email: "google-only@identifiedtalent.com", name: "G Only", authProvider: "google", authSubject: "google-subject-1" });
    const notStaff = await admin(first, "POST", "/api/v1/admin/platform-roles", { email: "google-only@identifiedtalent.com", role: "its_recruiter", reason: "covering on-call", confirm: true });
    expect(notStaff.status).toBe(409);
    expect(((await notStaff.json()) as { error: { code: string } }).error.code).toBe("not_staff_provider");
  });

  it("a grant by another administrator is recorded, alerted, emailed to every other administrator, and effective at once", async () => {
    email().sent.length = 0;
    const r = await admin(first, "POST", "/api/v1/admin/platform-roles", { email: "second@identifiedtalent.com", role: "platform_admin", reason: "second administrator per the founder", confirm: true });
    expect(r.status).toBe(201);
    secondGrantId = ((await r.json()) as { grantId: string }).grantId;
    // the existing session of the grantee gains access immediately
    expect((await admin(second, "GET", "/api/v1/admin/runs")).status).toBe(200);
    const ledger = await container.db.select().from(platformRoleGrants).where(eq(platformRoleGrants.id, secondGrantId));
    expect(ledger[0]).toMatchObject({ role: "platform_admin", source: "console", grantReason: "second administrator per the founder" });
    expect(ledger[0].grantedBy).toMatchObject({ kind: "user", name: "First Admin" });
    const alerts = await container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, "platform_role.changed"));
    const alert = alerts.find((a) => (a.details as { grantId?: string }).grantId === secondGrantId)!;
    expect(alert.severity).toBe("high");
    // the queue mailbox always hears about it; other administrators too (none besides the grantee here)
    const to = email().sent.map((m) => m.to);
    expect(to).toContain("queue@identifiedtalent.com");
    expect(email().sent.every((m) => m.text.includes("second administrator per the founder"))).toBe(true);
    // two-person visibility: neither the actor nor the person elevated can close the alert; a third administrator can
    const own = await admin(first, "POST", `/api/v1/admin/alerts/${alert.id}/acknowledge`, {});
    expect(own.status).toBe(403);
    expect(((await own.json()) as { error: { code: string } }).error.code).toBe("second_person_required");
    expect((await admin(second, "POST", `/api/v1/admin/alerts/${alert.id}/acknowledge`, {})).status).toBe(403);
    const fourth = await signInWithIdentity(app, container, { email: "fourth@identifiedtalent.com", name: "Fourth", provider: "azure", aal2: true });
    expect((await admin(second, "POST", "/api/v1/admin/platform-roles", { email: "fourth@identifiedtalent.com", role: "platform_admin", reason: "third administrator for acknowledgements", confirm: true })).status).toBe(201);
    expect((await admin(fourth, "POST", `/api/v1/admin/alerts/${alert.id}/acknowledge`, {})).status).toBe(200);
    // the ledger, not the cached column, is what a request trusts: a column write without a ledger row grants nothing
    const [ghost] = await container.db.insert(users).values({ email: "ghost@identifiedtalent.com", name: "Ghost", authProvider: "azure", authSubject: "ghost-subject", platformRole: "platform_admin" }).returning();
    const ghostCookie = await signInWithIdentity(app, container, { email: "ghost@identifiedtalent.com", provider: "azure", aal2: true, subject: "ghost-subject" });
    expect((await admin(ghostCookie, "GET", "/api/v1/admin/runs")).status).toBe(403);
    expect(ghost.platformRole).toBe("platform_admin"); // the column said admin; the request said no
  });

  it("revocation is immediate, audited, alerted, and the last administrator cannot be removed", async () => {
    third = await signInWithIdentity(app, container, { email: "third@identifiedtalent.com", name: "Third", provider: "azure", aal2: true });
    const grant = (await (await admin(second, "POST", "/api/v1/admin/platform-roles", { email: "third@identifiedtalent.com", role: "its_recruiter", reason: "new recruiter on the queue", confirm: true })).json()) as { grantId: string };
    expect((await app.request("/api/v1/escalations", { headers: { cookie: third } })).status).toBe(200);
    email().sent.length = 0;
    const rv = await admin(first, "POST", `/api/v1/admin/platform-roles/${grant.grantId}/revoke`, { reason: "left the team", confirm: true });
    expect(rv.status).toBe(200);
    expect((await app.request("/api/v1/escalations", { headers: { cookie: third } })).status).toBe(403);
    const [row] = await container.db.select().from(platformRoleGrants).where(eq(platformRoleGrants.id, grant.grantId));
    expect(row.revokedAt).toBeTruthy();
    expect(row.revokeReason).toBe("left the team");
    expect(row.revokedBy).toMatchObject({ kind: "user", name: "First Admin" });
    expect((await container.db.select().from(auditRecords).where(eq(auditRecords.action, "platform_role.revoked"))).length).toBe(1);
    expect(email().sent.map((m) => m.to)).toEqual(expect.arrayContaining(["second@identifiedtalent.com", "queue@identifiedtalent.com"]));
    expect(email().sent.some((m) => m.to === "first@identifiedtalent.com")).toBe(false);
    // an administrator whose address cannot be emailed is never a silent gap: the change is audited and alerted
    const { suppressAddress } = await import("@ros/core");
    await suppressAddress(container.db, { address: "second@identifiedtalent.com", reason: "hard_bounce", source: "admin", actor: { kind: "system", id: "test" } });
    const fifth = await signInWithIdentity(app, container, { email: "fifth@identifiedtalent.com", name: "Fifth", provider: "azure", aal2: true });
    const quiet = (await (await admin(first, "POST", "/api/v1/admin/platform-roles", { email: "fifth@identifiedtalent.com", role: "its_recruiter", reason: "recruiter while an address bounces", confirm: true })).json()) as { ok: boolean; failed: number; notified: number };
    expect(quiet.ok).toBe(true);
    expect(quiet.failed).toBe(1);
    expect(quiet.notified).toBeGreaterThanOrEqual(1);
    expect((await container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, "platform_role.notify_failed"))).length).toBe(1);
    expect(JSON.stringify(await container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, "platform_role.notify_failed")))).not.toContain("second@identifiedtalent.com");
    void fifth;
    // the second and fourth administrators are revoked; then the first is the last one and cannot be revoked
    expect((await admin(first, "POST", `/api/v1/admin/platform-roles/${secondGrantId}/revoke`, { reason: "rotation test", confirm: true })).status).toBe(200);
    expect((await admin(second, "GET", "/api/v1/admin/runs")).status).toBe(403);
    const [fourthUser] = await container.db.select().from(users).where(eq(users.email, "fourth@identifiedtalent.com"));
    const [fourthGrant] = await container.db.select().from(platformRoleGrants).where(and(eq(platformRoleGrants.userId, fourthUser.id), isNull(platformRoleGrants.revokedAt)));
    expect((await admin(first, "POST", `/api/v1/admin/platform-roles/${fourthGrant.id}/revoke`, { reason: "rotation test", confirm: true })).status).toBe(200);
    const [firstGrant] = await container.db.select().from(platformRoleGrants).where(eq(platformRoleGrants.source, "bootstrap"));
    const last = await admin(first, "POST", `/api/v1/admin/platform-roles/${firstGrant.id}/revoke`, { reason: "should be refused", confirm: true });
    expect(last.status).toBe(409);
    expect(((await last.json()) as { error: { code: string } }).error.code).toBe("last_admin");
    // ledger rows are facts: nothing was deleted
    expect((await container.db.select().from(platformRoleGrants)).length).toBeGreaterThanOrEqual(4);
  });

  it("the retired PLATFORM_ADMIN_EMAILS variable grants nothing, and no staff address is written into authorization code", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const legacy = await createContainer({ memory: true, env: { ...env, BOOTSTRAP_ADMIN_EMAILS: "", PLATFORM_ADMIN_EMAILS: "legacy@identifiedtalent.com" } });
    const legacyApp = createApp(legacy);
    const cookie = await signInWithIdentity(legacyApp, legacy, { email: "legacy@identifiedtalent.com", provider: "azure", aal2: true });
    const me = (await (await legacyApp.request("/api/v1/auth/me", { headers: { cookie } })).json()) as { user: { platformRole: string } };
    expect(me.user.platformRole).toBe("none");
    expect((await legacyApp.request("/api/v1/admin/runs", { headers: { cookie, "x-admin-reason": "x" } })).status).toBe(403);
    expect(await legacy.db.select().from(platformRoleGrants)).toHaveLength(0);
    await legacy.close();
    // no personal staff address anywhere in the authorization code paths (a domain default is not an address)
    const { fileURLToPath } = await import("node:url");
    const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
    const roots = ["packages/core/src", "apps/api/src/middleware", "apps/api/src/routes", "apps/api/src/env.ts", "apps/api/src/container.ts"].map((p) => join(repoRoot, p));
    const files: string[] = [];
    const walk = (p: string) => { if (statSync(p).isDirectory()) for (const n of readdirSync(p)) walk(join(p, n)); else if (/\.tsx?$/.test(p) && !p.endsWith(".test.ts")) files.push(p); };
    for (const r of roots) walk(r);
    // role mailboxes (privacy@, recruiters@) are shown to people, never consulted for authority; a personal address would be
    const offenders = files.filter((f) => (readFileSync(f, "utf8").match(/[a-z0-9._-]+@identifiedtalent\.com/gi) ?? []).some((m) => !/^(privacy|recruiters|security|platform|updates|hello|support)@/i.test(m)));
    expect(offenders).toEqual([]);
  });

  it("the email link never opens a staff session, the same provider cannot present a different identity, and staff sessions slide by hours not days", async () => {
    // a platform-role holder on any domain who asks for an email link is refused; a link minted before the role would be refused on use
    const r = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "second@identifiedtalent.com" }) });
    expect(r.status).toBe(403);
    const { createMagicLink, consumeMagicLink } = await import("@ros/core");
    const [u] = await container.db.select().from(users).where(eq(users.email, "first@identifiedtalent.com"));
    const { token } = await createMagicLink(container.db, { email: u.email });
    await expect(consumeMagicLink(container.db, { token })).rejects.toMatchObject({ code: "staff_provider_required" });
    // the same provider with a different subject for the same address is refused and audited
    const mismatch = await app.request("/api/v1/auth/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accessToken: (container.integrations.identity as FakeIdentityProvider).mint({ email: "first@identifiedtalent.com", provider: "azure", aal: "aal2", subject: "someone-else-entirely" }) }) });
    expect(mismatch.status).toBe(403);
    expect(((await mismatch.json()) as { error: { code: string } }).error.code).toBe("identity_mismatch");
    expect((await container.db.select().from(auditRecords).where(eq(auditRecords.reason, "identity_mismatch"))).length).toBeGreaterThanOrEqual(1);
    // sliding expiry keeps an administrator inside the eight-hour window
    const { sessions } = await import("@ros/db");
    const rows = await container.db.select().from(sessions).where(eq(sessions.userId, u.id));
    await container.db.update(sessions).set({ lastSeenAt: new Date(Date.now() - 5 * 60_000).toISOString() }).where(eq(sessions.id, rows[0].id));
    expect((await admin(first, "GET", "/api/v1/auth/me")).status).toBe(200);
    const [after] = await container.db.select().from(sessions).where(eq(sessions.id, rows[0].id));
    expect(Date.parse(after.expiresAt) - Date.now()).toBeLessThanOrEqual(8 * 3600_000 + 5000);
    expect(Date.parse(after.expiresAt) - Date.now()).toBeGreaterThan(7 * 3600_000);
  });
});
