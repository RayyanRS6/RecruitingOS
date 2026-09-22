import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { connectIntegration, entitlements, readConnectionSecret } from "@ros/core";
import { adminAlerts, auditRecords, integrations, users, withTenant } from "@ros/db";
import type { FakeCredentialRevoker, MemorySecretStore } from "@ros/integrations";
import { fingerprint } from "@ros/contracts";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { signInAdmin } from "./test-helpers";

/**
 * Correction 10 (18 September 2026): every secret read is audited (service, purpose, tenant, integration, time);
 * disconnecting deletes the credential; a failed deletion is a visible operator alert with a retry; no surface leaks a token.
 */
describe("credential lifecycle: audited reads, deletion on disconnect, visible failures", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  const TOKEN = "1//0gFakeRefreshTokenForTests_ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const signIn = async (email: string) => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const { devLink } = (await r1.json()) as { devLink: string };
    const token = new URL(devLink).searchParams.get("token")!;
    const r2 = await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    return r2.headers.get("set-cookie")!.split(";")[0];
  };
  const json = (cookie: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
    app.request(path, { method, headers: { "content-type": "application/json", cookie, "x-admin-reason": "test", ...extra }, body: body ? JSON.stringify(body) : undefined });

  let owner = "";
  let admin = "";
  let companyId = "";
  let integrationId = "";
  let actor = { kind: "user" as const, id: "", name: "owner" };
  const store = () => container.integrations.secrets as MemorySecretStore;

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    owner = await signIn("owner@harbor.test");
    admin = await signInAdmin(app, container, "admin@its.test", "admin");
    await container.db.update(users).set({ platformRole: "platform_admin", name: "admin" }).where(eq(users.email, "admin@its.test"));
    const co = (await (await json(owner, "POST", "/api/v1/companies", { name: "Harbor Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Newport Beach", region: "CA", country: "US" }] })).json()) as { id: string };
    companyId = co.id;
    await entitlements.applyPlan(container.db, companyId, "growth");
    const [u] = await container.db.select({ id: users.id }).from(users).where(eq(users.email, "owner@harbor.test"));
    actor = { kind: "user", id: u.id, name: "owner" };
  });
  afterAll(async () => {
    await container.close();
  });

  it("connecting stores the credential in the managed store, keeps a reference, and audits it", async () => {
    const row = await withTenant(container.db, companyId, (tx) => connectIntegration(tx, store(), { companyId, provider: "google", kind: "calendar", secretValue: TOKEN, secretName: "google-calendar-refresh", externalAccountId: "owner@harbor.test", actor }));
    integrationId = row.id;
    expect(row.secretRef).toBeTruthy();
    expect(row.secretRef).not.toContain(TOKEN);
    expect(store().size).toBe(1);
    const list = (await (await json(owner, "GET", "/api/v1/integrations")).json()) as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(TOKEN);
    expect(list[0]).not.toHaveProperty("secretRef");
    expect(list[0].credentialsDeleted).toBe(false);
    const stored = await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "secret.stored")));
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(TOKEN);
    expect(stored[0].details).toMatchObject({ service: "google", purpose: "token_refresh", integrationId, store: "memory" });
  });

  it("every read is recorded with service, purpose, tenant, integration and time; the record never holds the value", async () => {
    const [row] = await container.db.select().from(integrations).where(eq(integrations.id, integrationId));
    const value = await withTenant(container.db, companyId, (tx) => readConnectionSecret(tx, store(), row, { purpose: "calendar_sync", actor: { kind: "system", id: "scheduler" } }));
    expect(value).toBe(TOKEN);
    const reads = await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "secret.read")));
    expect(reads).toHaveLength(1);
    expect(reads[0].details).toMatchObject({ service: "google", purpose: "calendar_sync", integrationId });
    expect((reads[0].details as { ref: string }).ref).toMatch(/^fp_/);
    expect(JSON.stringify(reads)).not.toContain(TOKEN);
    expect(reads[0].createdAt).toBeTruthy();
  });

  it("a token that reaches an error is scrubbed from the response and the log", async () => {
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => { errors.push(JSON.stringify(args)); };
    try {
      const boom = createApp(container);
      boom.get("/__boom", () => { throw new Error(`upstream said: ${TOKEN}`); });
      const r = await boom.request("/__boom");
      expect(r.status).toBe(500);
      const body = await r.text();
      expect(body).not.toContain(TOKEN);
      expect(body).toContain("[redacted]");
      expect(errors.join("\n")).not.toContain(TOKEN);
    } finally {
      console.error = orig;
    }
  });

  it("disconnecting disables the connection at once, revokes at the provider, deletes the secret, and tells the customer", async () => {
    const r = await json(owner, "POST", `/api/v1/integrations/${integrationId}/disconnect`, { reason: "switching calendars" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { status: string; credentialsDeleted: boolean; deletionQueued: boolean; revokedAt: string | null };
    expect(body.status).toBe("not_connected");
    expect(body.deletionQueued).toBe(true);
    await container.drain();
    const [row] = await container.db.select().from(integrations).where(eq(integrations.id, integrationId));
    expect(row.secretRef).toBeNull();
    expect(row.secretDeletedAt).toBeTruthy();
    expect(row.revokedAt).toBeTruthy();
    expect(store().size).toBe(0);
    const revoker = container.integrations.revokers.google as FakeCredentialRevoker;
    expect(revoker.calls).toEqual([expect.objectContaining({ fingerprint: fingerprint(TOKEN) })]);
    const actions = (await container.db.select().from(auditRecords).where(eq(auditRecords.companyId, companyId))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["secret.read", "secret.deleted", "credentials.deleted"]));
    const revocationRead = (await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "secret.read")))).find((a) => (a.details as { purpose: string }).purpose === "revocation");
    expect(revocationRead).toBeTruthy();
    const seen = (await (await json(owner, "GET", "/api/v1/events?type=integration.credentials_deleted")).json()) as Array<{ payload: { revoked: boolean } }>;
    expect(seen).toHaveLength(1);
    expect(seen[0].payload.revoked).toBe(true);
    const list = (await (await json(owner, "GET", "/api/v1/integrations")).json()) as Array<{ credentialsDeleted: boolean; status: string }>;
    expect(list[0]).toMatchObject({ credentialsDeleted: true, status: "not_connected" });
  });

  it("a failed deletion raises a visible alert, disables the connection, and a retry clears it", async () => {
    const row = await withTenant(container.db, companyId, (tx) => connectIntegration(tx, store(), { companyId, provider: "google", kind: "calendar", secretValue: `${TOKEN}-second`, secretName: "google-calendar-refresh", actor }));
    expect(store().size).toBe(1);
    const real = store();
    let failures = 0;
    container.integrations.secrets = new Proxy(real, { get(target, prop, receiver) { if (prop === "delete") return async () => { failures += 1; throw new Error("vault unavailable (simulated)"); }; return Reflect.get(target, prop, receiver); } }) as unknown as typeof real;
    const r = await json(owner, "POST", `/api/v1/integrations/${row.id}/disconnect`, { reason: "testing failure" });
    expect(r.status).toBe(200);
    await container.drain();
    expect(failures).toBeGreaterThanOrEqual(1);
    const [after] = await container.db.select().from(integrations).where(eq(integrations.id, row.id));
    expect(after.status).toBe("manual_action_required");
    expect(after.secretRef).toBeTruthy();
    const alerts = (await (await json(admin, "GET", "/api/v1/admin/alerts")).json()) as Array<{ id: string; kind: string; severity: string; status: string; target: { id: string } }>;
    const alert = alerts.find((a) => a.kind === "secret.delete_failed" && a.target.id === row.id)!;
    expect(alert).toBeTruthy();
    expect(alert.severity).toBe("high");
    const failed = await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "secret.delete_failed")));
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(failed)).not.toContain(TOKEN);
    // the store recovers; a person retries from the console
    container.integrations.secrets = real;
    expect((await json(admin, "POST", `/api/v1/admin/alerts/${alert.id}/acknowledge`)).status).toBe(200);
    const retry = await json(admin, "POST", `/api/v1/admin/integrations/${row.id}/retry-deletion`);
    expect(retry.status).toBe(200);
    const [fixed] = await container.db.select().from(integrations).where(eq(integrations.id, row.id));
    expect(fixed.secretRef).toBeNull();
    expect(fixed.status).toBe("not_connected");
    expect(store().size).toBe(0);
    const [resolved] = await container.db.select().from(adminAlerts).where(eq(adminAlerts.id, alert.id));
    expect(resolved.status).toBe("resolved");
    const open = (await (await json(admin, "GET", "/api/v1/admin/alerts")).json()) as Array<{ id: string }>;
    expect(open.find((a) => a.id === alert.id)).toBeUndefined();
  });

  it("only roles with integration.manage may disconnect, and other tenants cannot see the connection", async () => {
    const other = await signIn("owner@other.test");
    const co = (await (await json(other, "POST", "/api/v1/companies", { name: "Other Co", vertical: "trades", sizeBand: "20-49", locations: [{ city: "Reno", region: "NV", country: "US" }] })).json()) as { id: string };
    expect(co.id).toBeTruthy();
    expect((await json(other, "POST", `/api/v1/integrations/${integrationId}/disconnect`, { reason: "x" })).status).toBe(404);
    expect(((await (await json(other, "GET", "/api/v1/integrations")).json()) as unknown[]).length).toBe(0);
  });
});
