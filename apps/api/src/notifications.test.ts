import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { ALWAYS_EMAILED_LINE, type NotificationHistoryPage, type NotificationPreferences } from "@ros/contracts";
import { notify } from "@ros/core";
import { auditRecords, communications, notifications, roles, users, withTenant } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { ALERT_TEMPLATE } from "@ros/workflows";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { signInAs } from "./test-helpers";

/**
 * Updates and their emails. Every update is a row on the person's Updates page. Each person has one switch, "Email me
 * updates", on until they turn it off: with it on, an update becomes a short email through the outbox, with the job's
 * name and a link only; notices about the account, the plan and the team are emailed whatever the switch says. An
 * unsubscribe at Postmark turns the switch off, and the history pages through every update, read and unread.
 */
describe("updates and the one email switch", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let manager = "";
  let member = "";
  let companyId = "";
  let ownerId = "";
  let managerId = "";
  let memberId = "";
  let roleA = "";
  let roleB = "";
  const SECRET = "wh-secret-for-notification-tests-123";
  const COMPANY = "Harbor Dental Group";
  const mail = () => container.integrations.email as unknown as FakeEmailAdapter;
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const emailOf = async (id: string) => (await container.db.select({ email: users.email }).from(users).where(eq(users.id, id)))[0].email;
  const alertsTo = async (id: string) => { const to = await emailOf(id); return mail().sent.filter((m) => m.to === to && m.tags?.template === ALERT_TEMPLATE); };
  const tell = (input: Parameters<typeof notify>[1]) => withTenant(container.db, companyId, (tx) => notify(tx, input));
  // What the in-app updates say about candidates: no email may repeat any of it.
  const LEAKS = ["Maria", "Reyes", "maria.reyes@example.com", "555-0100", "Priya Shah", "Coastal Family Dentistry"];
  const expectNoLeaks = (m: { subject: string; text: string }) => { for (const leak of LEAKS) { expect(m.subject).not.toContain(leak); expect(m.text).not.toContain(leak); } };
  const prefs = async (cookie: string) => (await (await json(cookie, "GET", "/api/v1/notifications/preferences")).json()) as NotificationPreferences;
  const setSwitch = (cookie: string, emailUpdates: boolean) => json(cookie, "PUT", "/api/v1/notifications/preferences", { emailUpdates });
  const history = async (cookie: string, query = "") => (await (await json(cookie, "GET", `/api/v1/notifications/history${query}`)).json()) as NotificationHistoryPage;
  const changesOf = async (userId: string) => (await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "notification.preferences_changed")))).filter((a) => a.actor.id === userId);

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", POSTMARK_WEBHOOK_SECRET: SECRET } });
    app = createApp(container);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "dana@harbor.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    const r = await json(owner, "POST", "/api/v1/companies", { name: COMPANY, vertical: "dental", sizeBand: "20-49", ownerName: "Dana Whitfield", locations: [{ city: "Brooklyn", region: "NY", country: "US" }] });
    expect(r.status).toBe(201);
    companyId = ((await r.json()) as { id: string }).id;
    ownerId = (await container.db.select({ id: users.id }).from(users).where(eq(users.email, "dana@harbor.test")))[0].id;
    manager = await signInAs(container, app, { companyId, role: "hiring_manager", email: "hank@harbor.test", name: "Hank Moreno" });
    member = await signInAs(container, app, { companyId, role: "hiring_manager", email: "ivy@harbor.test", name: "Ivy Chen" });
    managerId = (await container.db.select({ id: users.id }).from(users).where(eq(users.email, "hank@harbor.test")))[0].id;
    memberId = (await container.db.select({ id: users.id }).from(users).where(eq(users.email, "ivy@harbor.test")))[0].id;
    await withTenant(container.db, companyId, async (tx) => {
      [{ id: roleA }] = await tx.insert(roles).values({ companyId, title: "Dental Hygienist", createdBy: { kind: "user", id: ownerId } }).returning({ id: roles.id });
      [{ id: roleB }] = await tx.insert(roles).values({ companyId, title: "Front Desk Coordinator", createdBy: { kind: "user", id: ownerId } }).returning({ id: roles.id });
    });
  });
  afterAll(async () => {
    await container.close();
  });

  it("shows each person their one switch, on until they change it, with the address and the line about what is always emailed", async () => {
    expect(await prefs(owner)).toEqual({ emailUpdates: true, email: "dana@harbor.test", alwaysEmailedLine: ALWAYS_EMAILED_LINE });
    expect(await prefs(manager)).toEqual({ emailUpdates: true, email: "hank@harbor.test", alwaysEmailedLine: ALWAYS_EMAILED_LINE });
  });

  it("emails an update with the job's name and a link only, once, through the outbox, to the people it is for", async () => {
    await tell({ companyId, kind: "applications.closed", title: "Dental Hygienist stopped taking new applications", body: "Its closing date has passed.", action: { label: "Extend or close", href: `/roles/${roleA}` }, userIds: [ownerId, managerId] });
    await container.drain();
    for (const id of [ownerId, managerId]) {
      const [alert] = await alertsTo(id);
      expect(alert.subject).toBe("A job stopped taking new applications: Dental Hygienist");
      expect(alert.text).toContain(`Company: ${COMPANY}`);
      expect(alert.text).toContain("Job: Dental Hygienist");
      expect(alert.text).toContain(`Open it: ${container.env.APP_BASE_URL}/roles/${roleA}`);
      expect(alert.text).toContain(`You get this email because "Email me updates" is on. Turn it off in Settings: ${container.env.APP_BASE_URL}/setup`);
      expect(alert.text).not.toContain("Its closing date has passed");
    }
    // the third person was not told about the job, so is not emailed about it
    expect(await alertsTo(memberId)).toHaveLength(0);
    const rows = await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "applications.closed")));
    expect(rows).toHaveLength(2);
    expect(rows.every((n) => n.emailedAt)).toBe(true);
    // team mail: no candidate on the record, and a second run of the job sends nothing more
    const comms = await container.db.select().from(communications).where(and(eq(communications.companyId, companyId), eq(communications.templateKey, ALERT_TEMPLATE)));
    expect(comms).toHaveLength(2);
    expect(comms.every((c) => c.candidateId === null && c.status === "sent")).toBe(true);
    await container.drain();
    expect(await alertsTo(ownerId)).toHaveLength(1);
  });

  it("never puts a candidate's name or details in the email, only in the app", async () => {
    const open = `/roles/${roleA}/talent?open=0192f6b0-1c2d-7e3f-8a9b-0c1d2e3f4a6c`;
    await tell({ companyId, kind: "screen.completed", title: "Maria Reyes finished the AI interview", body: "Maria (maria.reyes@example.com, 555-0100) has 6 years at Coastal Family Dentistry.", action: { label: "Open Maria Reyes", href: open }, userIds: [ownerId] });
    await container.drain();
    const alert = (await alertsTo(ownerId)).at(-1)!;
    expect(alert.subject).toBe("A candidate finished the AI interview: Dental Hygienist");
    expect(alert.text).toContain(`${container.env.APP_BASE_URL}${open}`);
    expect(alert.text).toContain("Candidate names and details are never put in emails; you will see them once you sign in.");
    expectNoLeaks(alert);
    const [row] = await container.db.select().from(communications).where(and(eq(communications.templateKey, ALERT_TEMPLATE), eq(communications.subject, alert.subject)));
    for (const leak of LEAKS) expect(row.bodyText).not.toContain(leak);
    // the app keeps the whole update, with its link
    const page = await history(owner, "?limit=1");
    expect(page.items[0]).toMatchObject({ kind: "screen.completed", title: "Maria Reyes finished the AI interview", action: { label: "Open Maria Reyes", href: open } });
    expect(page.items[0].emailedAt).toBeTruthy();
    expect(page.items[0]).not.toHaveProperty("group");
  });

  it("follows each person's own switch: off means no email and the update still in the app, and a real change is audited", async () => {
    const before = (await alertsTo(managerId)).length;
    const r = await setSwitch(manager, false);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ emailUpdates: false, email: "hank@harbor.test", alwaysEmailedLine: ALWAYS_EMAILED_LINE });
    await tell({ companyId, kind: "applications.reopened", title: "Front Desk Coordinator is taking applications again", body: "The closing date moved.", action: { label: "Open the job", href: `/roles/${roleB}` }, userIds: [ownerId, managerId] });
    await container.drain();
    expect(await alertsTo(managerId)).toHaveLength(before);
    expect((await alertsTo(ownerId)).at(-1)?.subject).toBe("A job is taking applications again: Front Desk Coordinator");
    expect((await history(manager, "?limit=1")).items[0]).toMatchObject({ title: "Front Desk Coordinator is taking applications again", emailedAt: null });
    const changes = await changesOf(managerId);
    expect(changes.map((a) => a.details)).toEqual([{ emailUpdates: { from: true, to: false } }]);
    // saving the same choice again changes and audits nothing; nobody else's switch moved
    expect((await setSwitch(manager, false)).status).toBe(200);
    expect(await changesOf(managerId)).toHaveLength(1);
    expect((await prefs(owner)).emailUpdates).toBe(true);
    // anything but the one choice is refused
    expect((await json(manager, "PUT", "/api/v1/notifications/preferences", { preferences: [{ group: "approvals", cadence: "off" }] })).status).toBe(400);
    expect((await json(manager, "PUT", "/api/v1/notifications/preferences", { emailUpdates: "no" })).status).toBe(400);
    expect((await json(manager, "PUT", "/api/v1/notifications/preferences", { emailUpdates: true, userId: ownerId })).status).toBe(400);
  });

  it("always emails the notices about the account, the plan and the team, even with the switch off", async () => {
    expect((await prefs(manager)).emailUpdates).toBe(false);
    const before = (await alertsTo(managerId)).length;
    await tell({ companyId, kind: "company.plan_changed", title: "Your plan is now Pro", body: "ITS changed your plan.", action: { label: "See plan", href: "/setup" }, userIds: [managerId] });
    await tell({ companyId, kind: "member.left", title: "Sam left the team", body: "They no longer have access.", action: { label: "Open the team", href: "/setup" }, userIds: [managerId] });
    await tell({ companyId, kind: "candidate.withdrawn", title: "Priya Shah withdrew", body: "From Front Desk Coordinator.", action: { label: "Open", href: `/roles/${roleB}/talent` }, userIds: [managerId] });
    await container.drain();
    const mine = (await alertsTo(managerId)).slice(before);
    // both of them, and only them (the worker sends what one drain holds in no promised order)
    expect(mine.map((m) => m.subject).sort()).toEqual(["ITS changed your plan", "Someone left your team"]);
    for (const m of mine) {
      expect(m.text).toContain(ALWAYS_EMAILED_LINE);
      expect(m.text).not.toContain("Turn it off in Settings");
      expectNoLeaks(m);
    }
    // back on: the next update is emailed again
    expect((await setSwitch(manager, true)).status).toBe(200);
    await tell({ companyId, kind: "candidate.withdrawn", title: "Priya Shah withdrew again", body: "From Front Desk Coordinator.", action: { label: "Open", href: `/roles/${roleB}/talent` }, userIds: [managerId] });
    await container.drain();
    expect((await alertsTo(managerId)).at(-1)?.subject).toBe("A candidate withdrew: Front Desk Coordinator");
    expect((await changesOf(managerId)).map((a) => a.details)).toEqual([{ emailUpdates: { from: true, to: false } }, { emailUpdates: { from: false, to: true } }]);
  });

  it("pages through every update, newest first, and marks them read and unread", async () => {
    for (let i = 1; i <= 12; i += 1) await tell({ companyId, kind: "candidate.withdrawn", title: `Update ${i}`, body: "Someone withdrew.", userIds: [memberId] });
    const all: string[] = [];
    let before = "";
    for (let pages = 0; pages < 10; pages += 1) {
      const page = await history(member, `?limit=5${before ? `&before=${before}` : ""}`);
      all.push(...page.items.map((n) => n.title));
      if (!page.nextBefore) break;
      before = page.nextBefore;
    }
    const updates = all.filter((t) => t.startsWith("Update "));
    expect(updates).toEqual(Array.from({ length: 12 }, (_, i) => `Update ${12 - i}`));
    expect(new Set(all).size).toBe(all.length);
    let page = await history(member, "?filter=unread&limit=100");
    expect(page.unreadCount).toBe(page.items.length);
    const unreadBefore = page.unreadCount;
    // every time is ISO, and an update with no link carries none
    expect(page.items[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(page.items[0].action).toBeNull();
    // read one, then put it back
    const first = page.items[0];
    expect((await json(member, "POST", "/api/v1/notifications/read", { ids: [first.id] })).status).toBe(200);
    expect((await history(member)).unreadCount).toBe(unreadBefore - 1);
    expect((await history(member, "?filter=unread&limit=100")).items.some((n) => n.id === first.id)).toBe(false);
    expect((await json(member, "POST", "/api/v1/notifications/unread", { ids: [first.id] })).status).toBe(200);
    expect((await history(member)).unreadCount).toBe(unreadBefore);
    // read all: only what existed when the list was loaded
    page = await history(member);
    await tell({ companyId, kind: "candidate.withdrawn", title: "Arrived after the list was loaded", body: "Someone withdrew.", userIds: [memberId] });
    const done = (await (await json(member, "POST", "/api/v1/notifications/read-all", { upTo: page.asOf })).json()) as { marked: number };
    expect(done.marked).toBe(unreadBefore);
    const after = await history(member, "?filter=unread");
    expect(after.items.map((n) => n.title)).toEqual(["Arrived after the list was loaded"]);
    // another person's updates are neither shown nor touched
    expect((await history(owner, "?limit=100")).items.some((n) => n.title.startsWith("Update "))).toBe(false);
    expect(((await (await json(owner, "POST", "/api/v1/notifications/unread", { ids: [first.id] })).json()) as { marked: number }).marked).toBe(0);
    // a cursor that is not one of this person's updates is refused
    expect((await json(owner, "GET", `/api/v1/notifications/history?before=${first.id}`)).status).toBe(400);
    expect((await json(owner, "GET", "/api/v1/notifications/history?before=not-an-id")).status).toBe(400);
    expect((await json(owner, "GET", "/api/v1/notifications/history?limit=1000")).status).toBe(400);
  });

  it("keeps the words of an update stored earlier, and sends its link only when its page still exists", async () => {
    await withTenant(container.db, companyId, (tx) => tx.insert(notifications).values([
      { companyId, userId: ownerId, kind: "interview.assigned", title: "An update about a page that is gone", body: "Its words stay.", action: { label: "Open the interview", href: "/interviews/0192f6b0-1c2d-7e3f-8a9b-0c1d2e3f4a8e" } },
      { companyId, userId: ownerId, kind: "approval.requested", title: "An update about a job", body: "Its words stay too.", action: { label: "Review", href: `/roles/${roleA}?tab=activity` } },
    ]));
    const items = (await history(owner, "?limit=100")).items;
    expect(items.find((n) => n.title === "An update about a page that is gone")).toMatchObject({ kind: "interview.assigned", body: "Its words stay.", action: null });
    expect(items.find((n) => n.title === "An update about a job")).toMatchObject({ action: { label: "Review", href: `/roles/${roleA}?tab=activity` } });
  });

  it("turns a team member's switch off when they unsubscribe at Postmark, and nobody else's", async () => {
    expect((await prefs(member)).emailUpdates).toBe(true);
    const r = await app.request("/webhooks/postmark/events", { method: "POST", headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`postmark:${SECRET}`).toString("base64")}` }, body: JSON.stringify({ RecordType: "SubscriptionChange", MessageID: "5c1c0de0-6105-42a2-a16a-77a8eac79483", ServerID: 1, MessageStream: "outbound", ChangedAt: "2026-10-08T12:00:00Z", Recipient: "Ivy@Harbor.test", Origin: "Recipient", SuppressSending: true, SuppressionReason: "ManualSuppression", Tag: ALERT_TEMPLATE, Metadata: {} }) });
    expect(r.status).toBe(200);
    expect((await prefs(member)).emailUpdates).toBe(false);
    expect((await prefs(owner)).emailUpdates).toBe(true);
  });

  it("says an update was emailed only when it was: one carrying its own creation time there never was", async () => {
    // migration 0028 marked every earlier update as handled by copying its own creation time
    await withTenant(container.db, companyId, async (tx) => {
      const [row] = await tx.insert(notifications).values({ companyId, userId: ownerId, kind: "candidate.withdrawn", title: "From before email alerts", body: "Someone withdrew." }).returning();
      await tx.update(notifications).set({ emailedAt: row.createdAt }).where(eq(notifications.id, row.id));
    });
    const page = await history(owner, "?limit=100");
    expect(page.items.find((n) => n.title === "From before email alerts")?.emailedAt).toBeNull();
  });
});
