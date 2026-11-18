import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { DEFAULT_BUSINESS_CALENDAR, dayKeyIn, type BusinessCalendar } from "@ros/core";
import { auditRecords, businessCalendarVersions, users, withTenant } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { signInAdmin } from "./test-helpers";

/**
 * Correction 12 (18 September 2026): administrators manage the ITS business calendar; changes are versioned, effective
 * dated and audited.
 */
describe("editable ITS business calendar", () => {
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
    app.request(path, { method, headers: { "content-type": "application/json", cookie, "x-admin-reason": "test", ...extra }, body: body ? JSON.stringify(body) : undefined });

  let owner = "";
  let admin = "";
  let companyId = "";
  const today = () => dayKeyIn(new Date(), "America/Los_Angeles");
  const halfDays: BusinessCalendar = { ...DEFAULT_BUSINESS_CALENDAR, hours: { ...DEFAULT_BUSINESS_CALENDAR.hours, mon: [{ start: "09:00", end: "12:00" }], tue: [{ start: "09:00", end: "12:00" }], wed: [{ start: "09:00", end: "12:00" }], thu: [{ start: "09:00", end: "12:00" }], fri: [{ start: "09:00", end: "12:00" }] } };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    owner = await signIn("owner@northstar.test");
    admin = await signInAdmin(app, container, "admin@its.test", "admin");
    await container.db.update(users).set({ platformRole: "platform_admin", name: "admin" }).where(eq(users.email, "admin@its.test"));
    const co = (await (await json(owner, "POST", "/api/v1/companies", { name: "Northstar Plumbing", vertical: "trades", sizeBand: "20-49", locations: [{ city: "Reno", region: "NV", country: "US" }] })).json()) as { id: string };
    companyId = co.id;
  });
  afterAll(async () => {
    await container.close();
  });

  it("starts from the built-in default and describes it in plain words", async () => {
    const r = await json(admin, "GET", "/api/v1/admin/calendar");
    expect(r.status).toBe(200);
    const cal = (await r.json()) as { version: number | null; description: string; preview: Array<{ date: string; weekday: string; open: unknown[]; reason: string | null }>; current: { timeZone: string } };
    expect(cal.version).toBeNull();
    expect(cal.description).toBe("Monday to Friday, 9 to 5 Pacific");
    expect(cal.current.timeZone).toBe("America/Los_Angeles");
    expect(cal.preview).toHaveLength(28);
    for (const d of cal.preview) if (d.weekday === "sat" || d.weekday === "sun") expect(d.open).toHaveLength(0);
  });

  it("a published version is in force from its date, described in plain words, and audited", async () => {
    const publish = await json(admin, "POST", "/api/v1/admin/calendar", { effectiveFrom: today(), timeZone: "America/Los_Angeles", hours: halfDays.hours, holidays: halfDays.holidays, closures: [], coverageChanges: [], note: "Pilot period: mornings only" });
    expect(publish.status).toBe(201);
    const v = (await publish.json()) as { version: number; inForceNow: boolean; description: string };
    expect(v.version).toBe(1);
    expect(v.inForceNow).toBe(true);
    expect(v.description).toBe("Monday to Friday, 9 to 12 Pacific");
    const changes = await container.db.select().from(auditRecords).where(eq(auditRecords.action, "calendar.changed"));
    expect(changes).toHaveLength(1);
    expect((changes[0].details as { version: number; effectiveFrom: string }).effectiveFrom).toBe(today());
  });

  it("a version with a future effective date is listed as upcoming and does not apply yet", async () => {
    const future = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
    const publish = await json(admin, "POST", "/api/v1/admin/calendar", { effectiveFrom: future, timeZone: "America/New_York", hours: DEFAULT_BUSINESS_CALENDAR.hours, holidays: [], closures: [{ from: future, to: future, name: "Move day" }], coverageChanges: [], note: "Moving east" });
    expect(publish.status).toBe(201);
    expect(((await publish.json()) as { inForceNow: boolean }).inForceNow).toBe(false);
    const cal = (await (await json(admin, "GET", "/api/v1/admin/calendar")).json()) as { version: number; description: string; upcoming: Array<{ version: number; effectiveFrom: string }> };
    expect(cal.version).toBe(1);
    expect(cal.description).toBe("Monday to Friday, 9 to 12 Pacific");
    expect(cal.upcoming).toEqual([expect.objectContaining({ version: 2, effectiveFrom: future })]);
  });

  it("rejects malformed versions", async () => {
    const bad = await json(admin, "POST", "/api/v1/admin/calendar", { effectiveFrom: today(), timeZone: "America/Los_Angeles", hours: { ...halfDays.hours, mon: [{ start: "17:00", end: "09:00" }] }, holidays: [], closures: [], coverageChanges: [] });
    expect(bad.status).toBe(400);
    const zone = await json(admin, "POST", "/api/v1/admin/calendar", { effectiveFrom: today(), timeZone: "Mars/Olympus", hours: halfDays.hours, holidays: [], closures: [], coverageChanges: [] });
    expect(zone.status).toBe(400);
    expect((await json(owner, "POST", "/api/v1/admin/calendar", { effectiveFrom: today(), timeZone: "America/Los_Angeles", hours: halfDays.hours })).status).toBe(403);
  });

  it("the tenant role can read the calendar but never write it", async () => {
    const rows = await withTenant(container.db, companyId, (tx) => tx.select().from(businessCalendarVersions));
    expect(rows.length).toBe(2);
    await expect(withTenant(container.db, companyId, (tx) => tx.insert(businessCalendarVersions).values({ calendarKey: "its", version: 99, effectiveFrom: today(), timeZone: "UTC", hours: halfDays.hours, createdBy: { kind: "system", id: "test" } }))).rejects.toThrow();
  });
});
