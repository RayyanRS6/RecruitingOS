import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { ALERT_EMAIL_JOB_KIND, acknowledgeAlert, emailCriticalAlert, entitlements as allowance, raiseAlert, raiseAlertOnce, resolveAlertsOfKind, setAlertEmails } from "@ros/core";
import { adminAlerts, auditRecords, entitlements, jobs, plans, users, withPlatform, withTenant } from "@ros/db";
import { checkOperationalHealth } from "./maintenance";
import type { FakeEmailAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { signInAdmin } from "./test-helpers";

/**
 * Allowances, plans and alerts (Wave S2 F1, founder-visible blockers): a monthly allowance starts again from zero when
 * its period ends, with nobody at ITS doing anything; a platform admin changes a customer's plan from the console with a
 * reason; an acknowledged alert no longer silences the next one, a person can resolve one, and a critical one is emailed
 * to the platform administrators.
 */
describe("allowances, plans and alerts", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let admin = "";
  let companyId = "";
  const DAY = 86_400_000;
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie, "x-admin-reason": "test" }, body: body ? JSON.stringify(body) : undefined });
  const rowOf = async (key: string) => (await container.db.select().from(entitlements).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, key))))[0];
  const mail = () => (container.integrations.email as FakeEmailAdapter).sent;

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", RATE_LIMIT_STORE: "fake" } });
    app = createApp(container);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@allowance.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    // a company that signed itself up starts on Trial: 25 screening conversations, 1 recruiter request
    companyId = ((await (await json(owner, "POST", "/api/v1/companies", { name: "Reset Dental", vertical: "dental", sizeBand: "1-19", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string }).id;
    admin = await signInAdmin(app, container, "ada.admin@identifiedtalent.com", "Ada Admin");
  });
  afterAll(async () => {
    setAlertEmails(null);
    await container.close();
  });

  it("Setup's usage says when the monthly allowances start again; roles never reset", async () => {
    const co = (await (await json(owner, "GET", "/api/v1/companies/current")).json()) as { usage: Record<string, { used: number; limit: number | null; resetsAt?: string | null }> };
    expect(co.usage.text_screens).toMatchObject({ used: 0, limit: 25 });
    const resets = Date.parse(co.usage.text_screens.resetsAt ?? "");
    expect(resets - Date.now()).toBeGreaterThan(29 * DAY);
    expect(resets - Date.now()).toBeLessThanOrEqual(30 * DAY);
    expect(co.usage.active_roles).toEqual({ used: 0, limit: 1 });
  });

  it("a trial company that used its 25 conversations last period has room again in the new one, counted from zero, reset once", async () => {
    const ent = await rowOf(allowance.TEXT_SCREENS);
    // last period: all 25 used, and it ended yesterday
    const ended = new Date(Date.now() - DAY);
    await container.db.update(entitlements).set({ used: 25, periodStart: new Date(ended.getTime() - 30 * DAY).toISOString(), periodEnd: ended.toISOString() }).where(eq(entitlements.id, ent.id));
    // the check every waiting run and every new applicant makes sees the new period
    const checked = await withTenant(container.db, companyId, (tx) => allowance.check(tx, companyId, allowance.TEXT_SCREENS, 1));
    expect(checked).toEqual({ ok: true, limit: 25, used: 0 });
    // the first conversation of the new period is number 1, and the row moves to the new period
    const first = await withTenant(container.db, companyId, (tx) => allowance.recordScreenStart(tx, companyId, { test: 1 }));
    expect(first).toEqual({ crossed: null, used: 1, limit: 25 });
    const rolled = await rowOf(allowance.TEXT_SCREENS);
    expect(rolled.used).toBe(1);
    expect(Date.parse(rolled.periodStart!)).toBe(ended.getTime());
    expect(Date.parse(rolled.periodEnd!)).toBe(ended.getTime() + 30 * DAY);
    // the next one adds to it: no second reset
    expect((await withTenant(container.db, companyId, (tx) => allowance.recordScreenStart(tx, companyId, { test: 2 }))).used).toBe(2);
    const co = (await (await json(owner, "GET", "/api/v1/companies/current")).json()) as { usage: Record<string, { used: number; resetsAt?: string | null }> };
    expect(co.usage.text_screens.used).toBe(2);
    expect(Date.parse(co.usage.text_screens.resetsAt!)).toBe(ended.getTime() + 30 * DAY);
  });

  it("recruiter requests start again too, and the billing alert about last month resolves itself", async () => {
    const ent = await rowOf(allowance.RECRUITER_ASKS);
    await container.db.update(entitlements).set({ used: 3 }).where(eq(entitlements.id, ent.id));
    const standing = await withTenant(container.db, companyId, (tx) => allowance.recruiterAskStanding(tx, companyId));
    expect(standing).toEqual({ used: 3, limit: 1, over: true });
    const flagged = await withPlatform(container.db, (tx) => allowance.flagRecruiterAsksOver(tx, { companyId, companyName: "Reset Dental", standing, escalationId: "e1" }));
    expect(flagged.created).toBe(true);
    // the period ends
    await container.db.update(entitlements).set({ periodEnd: new Date(Date.now() - 1000).toISOString() }).where(eq(entitlements.id, ent.id));
    expect(await withTenant(container.db, companyId, (tx) => allowance.recruiterAskStanding(tx, companyId))).toEqual({ used: 0, limit: 1, over: false });
    // the console resolves what no longer stands before it lists alerts
    const listed = (await (await json(admin, "GET", "/api/v1/admin/alerts")).json()) as Array<{ id: string }>;
    expect(listed.some((a) => a.id === flagged.id)).toBe(false);
    expect((await container.db.select().from(adminAlerts).where(eq(adminAlerts.id, flagged.id)))[0].status).toBe("resolved");
    const customers = (await (await json(admin, "GET", "/api/v1/admin/customers")).json()) as Array<{ id: string; recruiterAsks: { used: number; over: boolean }; screeningConversations: { used: number; limit: number | null; resetsAt: string | null } }>;
    const me = customers.find((c) => c.id === companyId)!;
    expect(me.recruiterAsks).toEqual({ used: 0, limit: 1, over: false });
    expect(me.screeningConversations).toMatchObject({ used: 2, limit: 25 });
    expect(me.screeningConversations.resetsAt).toBeTruthy();
  });

  it("a platform admin changes the plan from the console with a reason: new limits at once, this month's usage kept, audited", async () => {
    const plans = (await (await json(admin, "GET", "/api/v1/admin/plans")).json()) as Array<{ key: string; name: string; limits: Record<string, number | null> }>;
    expect(plans.map((p) => p.key)).toEqual(expect.arrayContaining(["design_partner", "trial", "core", "growth", "company"]));
    expect(plans.find((p) => p.key === "design_partner")).toMatchObject({ name: "Design Partner", limits: { text_screens: 300 } });
    // the owner cannot see or use it
    expect((await json(owner, "GET", "/api/v1/admin/plans")).status).toBe(403);
    expect((await json(owner, "POST", `/api/v1/admin/customers/${companyId}/plan`, { planKey: "design_partner", reason: "pilot agreement" })).status).toBe(403);
    expect((await json(admin, "POST", `/api/v1/admin/customers/${companyId}/plan`, { planKey: "platinum", reason: "pilot agreement" })).status).toBe(400);
    expect((await json(admin, "POST", "/api/v1/admin/customers/not-a-company/plan", { planKey: "design_partner", reason: "pilot agreement" })).status).toBe(404);
    // used up on Trial: ITS was told
    const ent = await rowOf(allowance.TEXT_SCREENS);
    await container.db.update(entitlements).set({ used: 25 }).where(eq(entitlements.id, ent.id));
    const usedUp = await withPlatform(container.db, (tx) => allowance.flagScreenAllowance(tx, { companyId, companyName: "Reset Dental", crossing: { crossed: "used_up", used: 25, limit: 25 } }));
    expect(usedUp?.created).toBe(true);
    const r = await json(admin, "POST", `/api/v1/admin/customers/${companyId}/plan`, { planKey: "design_partner", reason: "Signed the pilot agreement on the kick-off call." });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { planKey: string; status: string })).toMatchObject({ planKey: "design_partner", status: "design_partner" });
    const after = await rowOf(allowance.TEXT_SCREENS);
    expect(after).toMatchObject({ limit: 300, used: 25 });
    expect(after.periodEnd).toBe(ent.periodEnd); // the reset date does not move
    // the alert the new limit cleared is resolved
    expect((await container.db.select().from(adminAlerts).where(eq(adminAlerts.id, usedUp!.id)))[0].status).toBe("resolved");
    const audited = (await container.db.select().from(auditRecords).where(eq(auditRecords.action, "plan.changed"))).filter((a) => a.companyId === companyId);
    expect(audited).toHaveLength(1);
    expect(audited[0].reason).toBe("Signed the pilot agreement on the kick-off call.");
    const co = (await (await json(owner, "GET", "/api/v1/companies/current")).json()) as { planKey: string; usage: Record<string, { used: number; limit: number | null }> };
    expect(co.planKey).toBe("design_partner");
    expect(co.usage.text_screens).toMatchObject({ used: 25, limit: 300 });
  });

  it("acknowledging means seen: a condition still going on raises nothing new; its end (or a day) makes the next one new; a person resolves an alert and it stays on record", async () => {
    const input = { kind: "test.worker_like", severity: "high" as const, title: "Something stopped", body: "Check it." };
    const first = await raiseAlertOnce(container.db, input);
    expect(first.created).toBe(true);
    // still open: one alert, not one per check
    expect((await raiseAlertOnce(container.db, input)).created).toBe(false);
    expect(await acknowledgeAlert(container.db, { id: first.id, actor: { kind: "user", id: "00000000-0000-0000-0000-000000000001", name: "Ada" } })).toBe(true);
    // seen by a person, and still going on: no second alert at the next check, nor the one after
    expect(await raiseAlertOnce(container.db, input)).toEqual({ id: first.id, created: false });
    expect((await raiseAlertOnce(container.db, input, { now: new Date(Date.now() + 6 * 3600_000) })).created).toBe(false);
    // a day after the acknowledgement it is raised again, as a safety net
    const second = await raiseAlertOnce(container.db, input, { now: new Date(Date.now() + 25 * 3600_000) });
    expect(second.created).toBe(true);
    expect(second.id).not.toBe(first.id);
    // Resolve from the console: it leaves the list, stays in the table, is audited
    expect((await json(admin, "POST", `/api/v1/admin/alerts/${second.id}/resolve`, { note: "Restarted the service." })).status).toBe(200);
    expect((await json(admin, "POST", `/api/v1/admin/alerts/${second.id}/resolve`, {})).status).toBe(409);
    expect((await json(admin, "POST", "/api/v1/admin/alerts/00000000-0000-0000-0000-000000000000/resolve", {})).status).toBe(404);
    expect((await json(admin, "POST", "/api/v1/admin/alerts/nonsense/resolve", {})).status).toBe(404);
    // an acknowledged one can be resolved too
    expect((await json(admin, "POST", `/api/v1/admin/alerts/${first.id}/resolve`, {})).status).toBe(200);
    const listed = (await (await json(admin, "GET", "/api/v1/admin/failures")).json()) as { alerts: Array<{ id: string }> };
    expect(listed.alerts.some((a) => a.id === first.id || a.id === second.id)).toBe(false);
    const [kept] = await container.db.select().from(adminAlerts).where(eq(adminAlerts.id, second.id));
    expect(kept).toMatchObject({ status: "resolved" });
    expect(kept.resolvedAt).toBeTruthy();
    // recorded as a resolution, apart from an acknowledgement
    const record = (await container.db.select().from(auditRecords).where(eq(auditRecords.action, "alert.resolved"))).find((a) => (a.reason ?? "").includes("Restarted the service."));
    expect(record?.reason).toBe("resolved in the admin console: Restarted the service.");
    // and after resolving, the next occurrence is a new alert again
    const third = await raiseAlertOnce(container.db, input);
    expect(third.created).toBe(true);
    // the condition ending resolves it by itself, on the record, so the next outage is new too
    expect(await withPlatform(container.db, (tx) => resolveAlertsOfKind(tx, input.kind, { reason: "it recovered" }))).toBe(1);
    expect((await container.db.select().from(adminAlerts).where(eq(adminAlerts.id, third.id)))[0].status).toBe("resolved");
    expect((await container.db.select().from(auditRecords).where(eq(auditRecords.action, "alert.resolved"))).some((a) => a.reason === "it recovered")).toBe(true);
    expect((await raiseAlertOnce(container.db, input)).created).toBe(true);
    // the owner cannot resolve anything
    expect((await json(owner, "POST", `/api/v1/admin/alerts/${first.id}/resolve`, {})).status).toBe(403);
  });

  it("a stale worker's critical alert is emailed straight from the health check, once, without waiting for the queue; a resolved alert is not emailed", async () => {
    const before = mail().length;
    const subject = "Critical alert: The background worker has stopped polling";
    const now = new Date();
    // no heartbeat: the app's watch raises the alert and emails it after the commit, with nothing run from the queue
    const r = await checkOperationalHealth(container.db, now, { workerInline: false, emailCritical: (id) => container.emailCritical(id) });
    expect(r).toMatchObject({ workerStale: true, raised: 1 });
    expect(mail().slice(before).filter((m) => m.subject === subject).map((m) => m.to)).toEqual(["ada.admin@identifiedtalent.com"]);
    // the worker is still down an hour later and someone acknowledged it: no second alert, no second email
    const [stale] = await container.db.select().from(adminAlerts).where(and(eq(adminAlerts.kind, "worker.stale"), eq(adminAlerts.status, "open")));
    await acknowledgeAlert(container.db, { id: stale.id, actor: { kind: "user", id: "00000000-0000-0000-0000-000000000001", name: "Ada" } });
    expect((await checkOperationalHealth(container.db, new Date(now.getTime() + 61 * 60_000), { workerInline: false, emailCritical: (id) => container.emailCritical(id) })).raised).toBe(0);
    expect(mail().slice(before).filter((m) => m.subject === subject)).toHaveLength(1);
    // a resolved alert is never emailed
    const gone = await withPlatform(container.db, (tx) => raiseAlert(tx, { kind: "test.critical_gone", severity: "critical", title: "Over already", body: "x" }));
    await container.db.update(adminAlerts).set({ status: "resolved" }).where(eq(adminAlerts.id, gone.id));
    expect(await withPlatform(container.db, (tx) => emailCriticalAlert(tx, { send: (m) => container.integrations.email.send(m), from: "x <x@example.test>" }, { alertId: gone.id }))).toMatchObject({ skipped: true });
    await container.db.update(adminAlerts).set({ status: "resolved" }).where(eq(adminAlerts.kind, "worker.stale"));
  });

  it("a critical alert to two administrators, one failing once: each gets exactly one email after the retry", async () => {
    await withPlatform(container.db, (tx) => tx.insert(users).values({ email: "bo.admin@identifiedtalent.com", name: "Bo Admin", platformRole: "platform_admin" }).onConflictDoNothing());
    const alert = await withPlatform(container.db, (tx) => raiseAlert(tx, { kind: "test.critical_two", severity: "critical", title: "Two admins", body: "x" }));
    const got: string[] = [];
    let failedOnce = false;
    const send = async (m: { to: string }) => {
      if (m.to === "bo.admin@identifiedtalent.com" && !failedOnce) { failedOnce = true; return { status: "failed" as const, error: "provider hiccup", retryable: true }; }
      got.push(m.to);
      return { status: "sent" as const };
    };
    const first = await withPlatform(container.db, (tx) => emailCriticalAlert(tx, { send, from: "x <x@example.test>" }, { alertId: alert.id }));
    expect(first.retry).toBeTruthy();
    const again = await withPlatform(container.db, (tx) => emailCriticalAlert(tx, { send, from: "x <x@example.test>" }, { alertId: alert.id }));
    expect(again.retry).toBeUndefined();
    expect(got.sort()).toEqual(["ada.admin@identifiedtalent.com", "bo.admin@identifiedtalent.com"]);
    expect((await container.db.select().from(adminAlerts).where(eq(adminAlerts.id, alert.id)))[0].details.emailedAt).toBeTruthy();
    // Bo leaves the administrators again, so the next test sees one
    await container.db.update(users).set({ platformRole: "none" }).where(eq(users.email, "bo.admin@identifiedtalent.com"));
  });

  it("a plan change needs a person's reason through the API too, and never a retired plan", async () => {
    expect((await json(admin, "POST", `/api/v1/admin/customers/${companyId}/plan`, { planKey: "core" })).status).toBe(400);
    expect((await json(admin, "POST", `/api/v1/admin/customers/${companyId}/plan`, { planKey: "core", reason: " ok " })).status).toBe(400);
    await container.db.update(plans).set({ active: false }).where(eq(plans.key, "company"));
    try {
      const r = await json(admin, "POST", `/api/v1/admin/customers/${companyId}/plan`, { planKey: "company", reason: "Testing a retired plan." });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe("inactive_plan");
    } finally {
      await container.db.update(plans).set({ active: true }).where(eq(plans.key, "company"));
    }
  });

  it("a critical alert is emailed to the platform administrators once, through the queue; other alerts are not", async () => {
    // what the process wires up (apps/api/src/container.ts): the clock and the job that sends
    setAlertEmails(() => container.engine.clock());
    container.engine.registerJob(ALERT_EMAIL_JOB_KIND, async (payload) => {
      await emailCriticalAlert(container.db, { send: (m) => container.integrations.email.send(m), from: "Recruiting OS <alerts@example.test>", consoleUrl: "https://app.example.test/admin" }, { alertId: String(payload.alertId ?? "") });
    });
    const before = mail().length;
    const quiet = await raiseAlert(container.db, { kind: "test.high", severity: "high", title: "Not critical", body: "Console only." });
    const loud = await withPlatform(container.db, (tx) => raiseAlert(tx, { kind: "test.critical", severity: "critical", title: "The background worker has stopped polling", body: "Nothing queued runs." }));
    const queued = (await container.db.select().from(jobs).where(eq(jobs.kind, ALERT_EMAIL_JOB_KIND))).map((j) => (j.payload as { alertId: string }).alertId);
    expect(queued).toEqual([loud.id]);
    expect(queued).not.toContain(quiet.id);
    await container.kick();
    await container.drain();
    const sent = mail().slice(before).filter((m) => m.subject === "Critical alert: The background worker has stopped polling");
    expect(sent.map((m) => m.to)).toEqual(["ada.admin@identifiedtalent.com"]);
    expect(sent[0].text).toContain("Nothing queued runs.");
    expect(sent[0].text).toContain("https://app.example.test/admin");
    const [row] = await container.db.select().from(adminAlerts).where(eq(adminAlerts.id, loud.id));
    expect(row.details.emailedAt).toBeTruthy();
    // a second run of the job sends nothing more
    expect(await emailCriticalAlert(container.db, { send: (m) => container.integrations.email.send(m), from: "x <x@example.test>" }, { alertId: loud.id })).toMatchObject({ skipped: true });
    expect(mail().slice(before).filter((m) => m.subject.startsWith("Critical alert"))).toHaveLength(1);
    setAlertEmails(null);
  });
});
