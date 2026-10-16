import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { signInAs, signInStaff, signInWithIdentity, testContainerOptions } from "./test-helpers";

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

/**
 * A second company of one's own goes through ITS (founder decision L-17 A, 16 October 2026; known bug 65): POST
 * /companies refuses a person who already belongs to a company, or already created one, in plain words. A platform admin
 * sets companies up as before, and someone invited to several companies keeps the switcher (team.test.ts).
 */
describe("a second company of one's own", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  const json = (cookie: string, method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const create = (cookie: string, name: string) => json(cookie, "POST", "/api/v1/companies", { name, vertical: "dental", sizeBand: "1-19", locations: [{ city: "Irvine", region: "CA", country: "US" }] });
  const refusal = { error: { code: "another_company_needs_its", message: "To open another company, contact ITS." } };
  const companiesNamed = async (name: string) => (await container.db.select({ id: companies.id }).from(companies).where(eq(companies.name, name))).length;
  let first = "";
  let firstCompany = "";

  beforeAll(async () => {
    container = await createContainer(testContainerOptions({ ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" }));
    app = createApp(container);
    first = await signInWithIdentity(app, container, { email: "fay@second.test", name: "Fay First", provider: "google", aal2: false });
    const made = await create(first, "First Dental");
    expect(made.status).toBe(201);
    firstCompany = ((await made.json()) as { id: string }).id;
  });
  afterAll(async () => {
    await container.close();
  });

  it("refuses a second company from the same person with 409 and one plain line, and makes nothing", async () => {
    const again = await create(first, "Second Dental");
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject(refusal);
    expect(await companiesNamed("Second Dental")).toBe(0);
  });

  it("refuses someone invited into another company: they keep that company, and ITS opens a company of their own", async () => {
    const ian = await signInAs(container, app, { companyId: firstCompany, role: "interviewer", email: "ian@second.test", name: "Ian" });
    const r = await create(ian, "Ian Dental");
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject(refusal);
  });

  it("refuses a person who created a company and then left it", async () => {
    const lia = await signInWithIdentity(app, container, { email: "lia@second.test", name: "Lia Leaver", provider: "google", aal2: false });
    const made = (await (await create(lia, "Lia Dental")).json()) as { id: string };
    await signInAs(container, app, { companyId: made.id, role: "owner", email: "otto@second.test", name: "Otto" });
    expect((await json(lia, "POST", "/api/v1/companies/current/leave", { confirm: true })).status).toBe(200);
    const back = await signInWithIdentity(app, container, { email: "lia@second.test", name: "Lia Leaver", provider: "google", aal2: false });
    const r = await create(back, "Lia Dental Again");
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject(refusal);
  });

  it("lets someone who was removed from another person's company open their own", async () => {
    const rex = await signInAs(container, app, { companyId: firstCompany, role: "interviewer", email: "rex@second.test", name: "Rex" });
    const rexId = ((await (await json(rex, "GET", "/api/v1/auth/me")).json()) as { user: { id: string } }).user.id;
    expect((await json(first, "PATCH", `/api/v1/companies/current/members/${rexId}`, { status: "removed" })).status).toBe(200);
    const again = await signInWithIdentity(app, container, { email: "rex@second.test", name: "Rex", provider: "google", aal2: false });
    expect((await create(again, "Rex Dental")).status).toBe(201);
  });

  it("lets a platform admin set companies up as before", async () => {
    const admin = await signInStaff(app, container, "ada@its.test", "platform_admin", "Ada Admin");
    expect((await create(admin, "Set Up One")).status).toBe(201);
    expect((await create(admin, "Set Up Two")).status).toBe(201);
  });

  it("still answers a bad body with 400 first", async () => {
    const r = await json(first, "POST", "/api/v1/companies", { name: "" });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("invalid_request");
  });
});
