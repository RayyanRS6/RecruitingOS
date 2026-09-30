import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { signInStaff, testContainerOptions } from "./test-helpers";

/**
 * Founder decision F1 through the HTTP layer: no request header selects a tenant; tenancy comes from the
 * authenticated user's verified membership; platform staff get no tenant context by default.
 */
describe("tenant selection and isolation at the API", () => {
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

  let cookieA = "";
  let cookieB = "";
  let cookieStaff = "";
  let companyA = "";
  let companyB = "";
  let roleA = "";

  beforeAll(async () => {
    container = await createContainer(testContainerOptions({ ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" }));
    app = createApp(container);
    cookieA = await signIn("owner-a@example.test");
    cookieB = await signIn("owner-b@example.test");
    cookieStaff = await signInStaff(app, container, "recruiter@its.test", "its_recruiter", "recruiter");
    const ca = (await (await json(cookieA, "POST", "/api/v1/companies", { name: "Company A", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string };
    const cb = (await (await json(cookieB, "POST", "/api/v1/companies", { name: "Company B", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Denver", region: "CO", country: "US" }] })).json()) as { id: string };
    companyA = ca.id;
    companyB = cb.id;
    const intake = (await (await json(cookieA, "POST", "/api/v1/intake/conversation/messages", { message: "I need a dental hygienist in Irvine. Full time. $45 to $55 an hour. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license." })).json()) as { intakeSessionId: string };
    const compiled = (await (await json(cookieA, "POST", `/api/v1/intake/sessions/${intake.intakeSessionId}/compile`)).json()) as { roleId: string };
    roleA = compiled.roleId;
  });
  afterAll(async () => {
    await container.close();
  });

  it("a tenant header does not change the active company", async () => {
    const me = (await (await json(cookieB, "GET", "/api/v1/auth/me", undefined, { "x-company-id": companyA })).json()) as { activeCompanyId: string };
    expect(me.activeCompanyId).toBe(companyB);
    const rolesSeen = (await (await json(cookieB, "GET", "/api/v1/roles", undefined, { "x-company-id": companyA })).json()) as Array<{ id: string }>;
    expect(rolesSeen.map((r) => r.id)).not.toContain(roleA);
  });

  it("a member of one company cannot read another company's role, even by id", async () => {
    expect((await json(cookieA, "GET", `/api/v1/roles/${roleA}`)).status).toBe(200);
    expect((await json(cookieB, "GET", `/api/v1/roles/${roleA}`)).status).toBe(404);
    expect((await json(cookieB, "GET", `/api/v1/roles/${roleA}/applications`)).status).toBe(200);
    expect(((await (await json(cookieB, "GET", `/api/v1/roles/${roleA}/applications`)).json()) as unknown[]).length).toBe(0);
  });

  it("switching companies requires a verified membership", async () => {
    expect((await json(cookieB, "POST", "/api/v1/auth/switch", { companyId: companyA })).status).toBe(403);
    expect((await json(cookieA, "POST", "/api/v1/auth/switch", { companyId: companyA })).status).toBe(200);
  });

  it("platform staff get no tenant by default, with or without a header", async () => {
    expect((await json(cookieStaff, "GET", "/api/v1/roles")).status).toBe(403);
    expect((await json(cookieStaff, "GET", "/api/v1/roles", undefined, { "x-company-id": companyA })).status).toBe(403);
    expect((await json(cookieStaff, "POST", "/api/v1/auth/switch", { companyId: companyA })).status).toBe(403);
    const me = (await (await json(cookieStaff, "GET", "/api/v1/auth/me")).json()) as { activeCompanyId: string | null; user: { platformRole: string } };
    expect(me.user.platformRole).toBe("its_recruiter");
    expect(me.activeCompanyId).toBeNull();
  });
});
