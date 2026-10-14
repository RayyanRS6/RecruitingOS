import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { runInterventionLadder, type Detection } from "@ros/agents";
import type { NotificationHistoryPage, NotificationPreferencesView } from "@ros/contracts";
import { nextDigestAt, notify, zonedParts } from "@ros/core";
import { auditRecords, communications, notifications, roles, users, withTenant, workflowRuns } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { ALERT_TEMPLATE, DIGEST_TEMPLATE } from "@ros/workflows";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { signInAs } from "./test-helpers";

/**
 * Email alerts and the full history of updates (plan B3). An update someone wants as it happens becomes a short email
 * through the outbox, with the role's name and a link only; the rest wait for the 8:00 summary in the company's time
 * zone, daily or on Monday; a few kinds always go at once. Each person sets their own groups in Setup, an unsubscribe
 * at Postmark turns them off, and the history pages through every update, read and unread.
 */
describe("email alerts and the history of updates", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let manager = "";
  let interviewer = "";
  let companyId = "";
  let ownerId = "";
  let managerId = "";
  let interviewerId = "";
  let roleA = "";
  let roleB = "";
  const NY = "America/New_York";
  const SECRET = "wh-secret-for-notification-tests-123";
  const COMPANY = "Harbor Dental Group";
  const mail = () => container.integrations.email as unknown as FakeEmailAdapter;
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const setClock = (d: Date) => { (container.engine as unknown as { now: () => Date }).now = () => d; };
  const emailOf = async (id: string) => (await container.db.select({ email: users.email }).from(users).where(eq(users.id, id)))[0].email;
  const alertsTo = async (id: string) => { const to = await emailOf(id); return mail().sent.filter((m) => m.to === to && m.tags?.template === ALERT_TEMPLATE); };
  const summariesTo = async (id: string) => { const to = await emailOf(id); return mail().sent.filter((m) => m.to === to && m.tags?.template === DIGEST_TEMPLATE); };
  const tell = (input: Parameters<typeof notify>[1]) => withTenant(container.db, companyId, (tx) => notify(tx, input));
  // What the in-app updates say about candidates: no email may repeat any of it.
  const LEAKS = ["Maria", "Reyes", "maria.reyes@example.com", "555-0100", "Luis Ortega", "Priya Shah", "Coastal Family Dentistry"];
  const expectNoLeaks = (m: { subject: string; text: string }) => { for (const leak of LEAKS) { expect(m.subject).not.toContain(leak); expect(m.text).not.toContain(leak); } };
  const prefs = async (cookie: string) => (await (await json(cookie, "GET", "/api/v1/notifications/preferences")).json()) as NotificationPreferencesView;
  const history = async (cookie: string, query = "") => (await (await json(cookie, "GET", `/api/v1/notifications/history${query}`)).json()) as NotificationHistoryPage;

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", COMPANY_CHECK: "auto", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", SMS_ENABLED: "false", POSTMARK_WEBHOOK_SECRET: SECRET } });
    app = createApp(container);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "dana@harbor.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    const r = await json(owner, "POST", "/api/v1/companies", { name: COMPANY, vertical: "dental", sizeBand: "20-49", ownerName: "Dana Whitfield", timezone: NY, locations: [{ city: "Brooklyn", region: "NY", country: "US" }] });
    expect(r.status).toBe(201);
    companyId = ((await r.json()) as { id: string }).id;
    ownerId = (await container.db.select({ id: users.id }).from(users).where(eq(users.email, "dana@harbor.test")))[0].id;
    manager = await signInAs(container, app, { companyId, role: "hiring_manager", email: "hank@harbor.test", name: "Hank Moreno" });
    interviewer = await signInAs(container, app, { companyId, role: "interviewer", email: "ivy@harbor.test", name: "Ivy Chen" });
    managerId = (await container.db.select({ id: users.id }).from(users).where(eq(users.email, "hank@harbor.test")))[0].id;
    interviewerId = (await container.db.select({ id: users.id }).from(users).where(eq(users.email, "ivy@harbor.test")))[0].id;
    await withTenant(container.db, companyId, async (tx) => {
      [{ id: roleA }] = await tx.insert(roles).values({ companyId, title: "Dental Hygienist", createdBy: { kind: "user", id: ownerId } }).returning({ id: roles.id });
      [{ id: roleB }] = await tx.insert(roles).values({ companyId, title: "Front Desk Coordinator", createdBy: { kind: "user", id: ownerId } }).returning({ id: roles.id });
    });
  });
  afterAll(async () => {
    await container.close();
  });

  it("starts the company's morning summaries beside its stuck-role check", async () => {
    const runs = await container.db.select().from(workflowRuns).where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.workflowKey, "notification_digest")));
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("waiting");
    expect(runs[0].wait).toMatchObject({ kind: "timer" });
    // the first wake is the next 8:00 in New York
    expect(Date.parse((runs[0].wait as { until: string }).until)).toBe(nextDigestAt(container.engine.clock(), NY).getTime());
  });

  it("shows each person the groups with the defaults, the always-sent updates and when summaries arrive", async () => {
    const view = await prefs(owner);
    expect(view.email).toBe("dana@harbor.test");
    expect(view.digest).toEqual({ timezone: NY, hour: 8, weekday: "Monday" });
    expect(view.groups.map((g) => `${g.group}:${g.cadence}`)).toEqual(["approvals:immediate", "candidates:daily", "interviews:immediate", "stuck:daily", "recruiter:immediate", "messages:daily", "account:immediate"]);
    expect(view.groups.every((g) => g.cadence === g.defaultCadence && g.label && g.description)).toBe(true);
    expect(view.alwaysSent.map((a) => a.label)).toEqual(["An ITS recruiter is given access to your hiring", "ITS confirms your company, or takes the confirmation back", "A candidate asks to talk to a person", "Someone waits for your eligibility decision"]);
  });

  it("emails an update wanted as it happens with the role's name and a link only, once, through the outbox", async () => {
    await tell({ companyId, kind: "approval.requested", title: "Dental Hygienist: the job details need approval", body: "Review the job details, then approve to open the job.", action: { label: "Review", href: `/roles/${roleA}` } });
    await container.drain();
    for (const id of [ownerId, managerId]) {
      const [alert] = await alertsTo(id);
      expect(alert.subject).toBe("A role is waiting for your approval: Dental Hygienist");
      expect(alert.text).toContain(`Company: ${COMPANY}`);
      expect(alert.text).toContain(`Open it: ${container.env.APP_BASE_URL}/roles/${roleA}`);
      expect(alert.text).not.toContain("Review the job details");
    }
    // the interviewer was not told about the role, so is not emailed about it
    expect(await alertsTo(interviewerId)).toHaveLength(0);
    const rows = await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "approval.requested")));
    expect(rows).toHaveLength(2);
    expect(rows.every((n) => n.emailedAt)).toBe(true);
    // team mail: no candidate on the record, never held, and a second run of the job sends nothing more
    const comms = await container.db.select().from(communications).where(and(eq(communications.companyId, companyId), eq(communications.templateKey, ALERT_TEMPLATE)));
    expect(comms).toHaveLength(2);
    expect(comms.every((c) => c.candidateId === null && c.status === "sent")).toBe(true);
    await container.drain();
    expect(await alertsTo(ownerId)).toHaveLength(1);
  });

  it("never puts a candidate's name or details in the email, only in the app", async () => {
    expect((await json(owner, "PUT", "/api/v1/notifications/preferences", { preferences: [{ group: "candidates", cadence: "immediate" }] })).status).toBe(200);
    await tell({ companyId, kind: "candidate.recommended", title: "Maria Reyes is ready to interview", body: "Strong screen. Maria (maria.reyes@example.com, 555-0100) has 6 years at Coastal Family Dentistry.", action: { label: "Review and decide", href: `/roles/${roleA}/talent?open=0192f6b0-1c2d-7e3f-8a9b-0c1d2e3f4a6c` }, userIds: [ownerId] });
    await container.drain();
    const alert = (await alertsTo(ownerId)).at(-1)!;
    expect(alert.subject).toBe("A candidate is ready for your decision: Dental Hygienist");
    expect(alert.text).toContain(`${container.env.APP_BASE_URL}/roles/${roleA}/talent?open=0192f6b0-1c2d-7e3f-8a9b-0c1d2e3f4a6c`);
    expectNoLeaks(alert);
    const [row] = await container.db.select().from(communications).where(and(eq(communications.templateKey, ALERT_TEMPLATE), eq(communications.subject, alert.subject)));
    for (const leak of LEAKS) expect(row.bodyText).not.toContain(leak);
    // the app keeps the whole update
    const page = await history(owner, "?limit=1");
    expect(page.items[0]).toMatchObject({ title: "Maria Reyes is ready to interview", group: "candidates", groupLabel: "Candidates" });
    expect(page.items[0].emailedAt).toBeTruthy();
    expect((await json(owner, "PUT", "/api/v1/notifications/preferences", { preferences: [{ group: "candidates", cadence: "daily" }] })).status).toBe(200);
  });

  it("follows each person's own setting: off means no email, and the change is audited", async () => {
    const before = (await alertsTo(managerId)).length;
    const r = await json(manager, "PUT", "/api/v1/notifications/preferences", { preferences: [{ group: "approvals", cadence: "off" }] });
    expect(r.status).toBe(200);
    expect(((await r.json()) as NotificationPreferencesView).groups.find((g) => g.group === "approvals")?.cadence).toBe("off");
    await tell({ companyId, kind: "approval.requested", title: "Front Desk Coordinator: the job details need approval", body: "Review it.", action: { label: "Review", href: `/roles/${roleB}` } });
    await container.drain();
    expect(await alertsTo(managerId)).toHaveLength(before);
    expect((await alertsTo(ownerId)).at(-1)?.subject).toBe("A role is waiting for your approval: Front Desk Coordinator");
    // the manager still has the update in the app
    expect((await history(manager, "?limit=1")).items[0].title).toBe("Front Desk Coordinator: the job details need approval");
    const audited = await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "notification.preferences_changed")));
    const changes = audited.filter((a) => a.actor.id === managerId).flatMap((a) => (a.details as { changes: unknown[] }).changes);
    expect(changes).toContainEqual({ group: "approvals", from: "immediate", to: "off" });
    // saving the same setting again changes and audits nothing
    const count = audited.length;
    await json(manager, "PUT", "/api/v1/notifications/preferences", { preferences: [{ group: "approvals", cadence: "off" }] });
    expect(await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "notification.preferences_changed")))).toHaveLength(count);
    // nonsense is refused in plain words
    expect((await json(manager, "PUT", "/api/v1/notifications/preferences", { preferences: [{ group: "approvals", cadence: "hourly" }] })).status).toBe(400);
    expect((await json(manager, "PUT", "/api/v1/notifications/preferences", { preferences: [{ group: "gossip", cadence: "off" }] })).status).toBe(400);
    expect((await json(manager, "PUT", "/api/v1/notifications/preferences", { preferences: [] })).status).toBe(400);
  });

  it("always emails the updates nobody can turn off, even with everything off", async () => {
    const everything = ["approvals", "candidates", "interviews", "stuck", "recruiter", "messages", "account"].map((group) => ({ group, cadence: "off" }));
    expect((await json(manager, "PUT", "/api/v1/notifications/preferences", { preferences: everything })).status).toBe(200);
    const before = (await alertsTo(managerId)).length;
    await tell({ companyId, kind: "screen.human_requested", title: "Luis Ortega asked for a person", body: "During the Dental Hygienist screening.", action: { label: "Open the candidate", href: `/roles/${roleA}/talent?open=0192f6b0-1c2d-7e3f-8a9b-0c1d2e3f4a7d` } });
    await tell({ companyId, kind: "recruiter.claimed", title: "Sam (ITS recruiter) picked up your request", body: "They can see this role until Friday.", action: { label: "Recruiter access", href: "/setup" } });
    await tell({ companyId, kind: "candidate.withdrawn", title: "Priya Shah withdrew", body: "From Front Desk Coordinator.", action: { label: "Open", href: `/roles/${roleB}/talent` } });
    await container.drain();
    const mine = (await alertsTo(managerId)).slice(before);
    expect(mine.map((m) => m.subject)).toEqual(["A candidate asked to talk to a person: Dental Hygienist", "An ITS recruiter now has access to your hiring"]);
    for (const m of mine) {
      expect(m.text).toContain("This email is always sent");
      expectNoLeaks(m);
    }
    // put the manager back to the defaults for the summaries below, with candidates weekly
    const defaults = (await prefs(owner)).groups.map((g) => ({ group: g.group, cadence: g.group === "candidates" ? "weekly" : g.defaultCadence }));
    expect((await json(manager, "PUT", "/api/v1/notifications/preferences", { preferences: defaults })).status).toBe(200);
  });

  it("emails only the teammate an update is for: an interviewer hears about their own interview", async () => {
    const interview = "0192f6b0-1c2d-7e3f-8a9b-0c1d2e3f4a8e";
    const others = (await alertsTo(ownerId)).length;
    await tell({ companyId, kind: "interview.assigned", title: "You are interviewing Maria Reyes", body: "Phone screen for Dental Hygienist, 30 minutes.", action: { label: "Open the interview", href: `/interviews/${interview}` }, userIds: [interviewerId] });
    await container.drain();
    const [alert] = await alertsTo(interviewerId);
    expect(alert.subject).toBe("You have a new interview to do");
    expect(alert.text).toContain(`${container.env.APP_BASE_URL}/interviews/${interview}`);
    expectNoLeaks(alert);
    expect(await alertsTo(ownerId)).toHaveLength(others);
  });

  it("sends each person one morning summary of what they have not seen, by group and role, at 8:00 in the company's zone", async () => {
    // a clean slate: everything so far counts as seen
    for (const cookie of [owner, manager]) await json(cookie, "POST", "/api/v1/notifications/read-all", { upTo: new Date(Date.now() + 1000).toISOString() });
    await tell({ companyId, kind: "candidate.recommended", title: "Maria Reyes is ready to interview", body: "maria.reyes@example.com", action: { label: "Review", href: `/roles/${roleA}/talent?open=0192f6b0-1c2d-7e3f-8a9b-0c1d2e3f4a6c` } });
    await tell({ companyId, kind: "application.needs_review", title: "Luis Ortega needs a closer look", body: "555-0100", action: { label: "Review", href: `/roles/${roleA}/talent?open=0192f6b0-1c2d-7e3f-8a9b-0c1d2e3f4a7d` } });
    await tell({ companyId, kind: "application.ready", title: "Priya Shah is ready for a screen", body: "Coastal Family Dentistry", action: { label: "Invite", href: `/roles/${roleB}/talent?open=0192f6b0-1c2d-7e3f-8a9b-0c1d2e3f4a9f` } });
    await tell({ companyId, kind: "stuck.no_applicants", title: "Front Desk Coordinator has had no applicants in 14 days", body: "Posting on Indeed usually helps.", action: { label: "See posting options", href: `/roles/${roleB}` } });
    await tell({ companyId, kind: "candidate.withdrawn", title: "Maria Reyes withdrew", body: "From Dental Hygienist.", action: { label: "Open", href: `/roles/${roleA}/talent` } });
    // the owner already saw the withdrawal in the app, so it is not in their summary
    const [seen] = (await history(owner, "?limit=1")).items;
    expect(seen.title).toBe("Maria Reyes withdrew");
    await json(owner, "POST", "/api/v1/notifications/read", { ids: [seen.id] });
    await container.drain();

    // the next summary that is not a Monday's, a minute after 8:00 New York time
    let morning = nextDigestAt(new Date(), NY);
    if (zonedParts(morning, NY).weekday === 1) morning = nextDigestAt(new Date(morning.getTime() + 60_000), NY);
    setClock(new Date(morning.getTime() + 60_000));
    await container.drain();
    const [ownerSummary, ...extra] = await summariesTo(ownerId);
    expect(extra).toHaveLength(0);
    expect(ownerSummary.subject).toBe(`${COMPANY}: your daily summary (4 new updates)`);
    expect(ownerSummary.text).toContain("Hi Dana,");
    expect(ownerSummary.text).toContain("Candidates: 3");
    expect(ownerSummary.text).toContain(`- Dental Hygienist: 2  ${container.env.APP_BASE_URL}/roles/${roleA}/talent`);
    expect(ownerSummary.text).toContain(`- Front Desk Coordinator: 1  ${container.env.APP_BASE_URL}/roles/${roleB}/talent`);
    expect(ownerSummary.text).toContain("Roles that need attention: 1");
    expectNoLeaks(ownerSummary);
    // the manager gets candidates weekly, so this morning's has only the quiet role
    const [managerSummary] = await summariesTo(managerId);
    expect(managerSummary.subject).toBe(`${COMPANY}: your daily summary (1 new update)`);
    expect(managerSummary.text).not.toContain("Candidates:");
    // the interviewer had nothing waiting, so no email at all
    expect(await summariesTo(interviewerId)).toHaveLength(0);
    // the same morning twice sends nothing more
    await container.drain();
    expect(await summariesTo(ownerId)).toHaveLength(1);
    const ownerRows = await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.userId, ownerId), eq(notifications.kind, "application.ready")));
    expect(ownerRows.every((n) => n.emailedAt)).toBe(true);

    // Monday 8:00 New York: the manager's weekly summary carries the candidates; the owner has nothing new
    let monday = nextDigestAt(new Date(morning.getTime() + 60_000), NY);
    while (zonedParts(monday, NY).weekday !== 1) monday = nextDigestAt(new Date(monday.getTime() + 60_000), NY);
    setClock(new Date(monday.getTime() + 60_000));
    await container.drain();
    const weekly = (await summariesTo(managerId)).at(-1)!;
    expect(weekly.subject).toBe(`${COMPANY}: your weekly summary (4 new updates)`);
    expect(weekly.text).toContain("Candidates: 4");
    expectNoLeaks(weekly);
    expect(await summariesTo(ownerId)).toHaveLength(1);
    setClock(new Date());
  });

  it("pages through every update, newest first, and marks them read and unread", async () => {
    for (let i = 1; i <= 12; i += 1) await tell({ companyId, kind: "message.sent", title: `Update ${i}`, body: "A message went out.", userIds: [interviewerId] });
    const all: string[] = [];
    let before = "";
    for (let pages = 0; pages < 10; pages += 1) {
      const page = await history(interviewer, `?limit=5${before ? `&before=${before}` : ""}`);
      all.push(...page.items.map((n) => n.title));
      if (!page.nextBefore) break;
      before = page.nextBefore;
    }
    const updates = all.filter((t) => t.startsWith("Update "));
    expect(updates).toEqual(Array.from({ length: 12 }, (_, i) => `Update ${12 - i}`));
    expect(new Set(all).size).toBe(all.length);
    let page = await history(interviewer, "?filter=unread&limit=100");
    expect(page.unreadCount).toBe(page.items.length);
    const unreadBefore = page.unreadCount;
    // read one, then put it back
    const first = page.items[0];
    expect((await json(interviewer, "POST", "/api/v1/notifications/read", { ids: [first.id] })).status).toBe(200);
    expect((await history(interviewer)).unreadCount).toBe(unreadBefore - 1);
    expect((await history(interviewer, "?filter=unread&limit=100")).items.some((n) => n.id === first.id)).toBe(false);
    expect((await json(interviewer, "POST", "/api/v1/notifications/unread", { ids: [first.id] })).status).toBe(200);
    expect((await history(interviewer)).unreadCount).toBe(unreadBefore);
    // read all: only what existed when the list was loaded
    page = await history(interviewer);
    await tell({ companyId, kind: "message.sent", title: "Arrived after the list was loaded", body: "A message went out.", userIds: [interviewerId] });
    const done = (await (await json(interviewer, "POST", "/api/v1/notifications/read-all", { upTo: page.asOf })).json()) as { marked: number };
    expect(done.marked).toBe(unreadBefore);
    const after = await history(interviewer, "?filter=unread");
    expect(after.items.map((n) => n.title)).toEqual(["Arrived after the list was loaded"]);
    // another person's updates are neither shown nor touched
    expect((await history(owner, "?limit=100")).items.some((n) => n.title.startsWith("Update "))).toBe(false);
    expect(((await (await json(owner, "POST", "/api/v1/notifications/unread", { ids: [first.id] })).json()) as { marked: number }).marked).toBe(0);
    // a cursor that is not one of this person's updates is refused
    expect((await json(owner, "GET", `/api/v1/notifications/history?before=${first.id}`)).status).toBe(400);
    expect((await json(owner, "GET", "/api/v1/notifications/history?before=not-an-id")).status).toBe(400);
    expect((await json(owner, "GET", "/api/v1/notifications/history?limit=1000")).status).toBe(400);
  });

  it("turns a team member's alerts off when they unsubscribe at Postmark", async () => {
    const r = await app.request("/webhooks/postmark/events", { method: "POST", headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`postmark:${SECRET}`).toString("base64")}` }, body: JSON.stringify({ RecordType: "SubscriptionChange", MessageID: "5c1c0de0-6105-42a2-a16a-77a8eac79483", ServerID: 1, MessageStream: "outbound", ChangedAt: "2026-10-08T12:00:00Z", Recipient: "Ivy@Harbor.test", Origin: "Recipient", SuppressSending: true, SuppressionReason: "ManualSuppression", Tag: ALERT_TEMPLATE, Metadata: {} }) });
    expect(r.status).toBe(200);
    const view = await prefs(interviewer);
    expect(view.groups.every((g) => g.cadence === "off")).toBe(true);
    // everyone else keeps theirs
    expect((await prefs(owner)).groups.find((g) => g.group === "approvals")?.cadence).toBe("immediate");
  });

  it("the stuck-role ladder's own email names the role, never a candidate, and goes only to whoever wants those updates as they happen", async () => {
    // the owner wants roles that need attention as they happen; the manager in the daily summary (the default)
    expect((await json(owner, "PUT", "/api/v1/notifications/preferences", { preferences: [{ group: "stuck", cadence: "immediate" }] })).status).toBe(200);
    expect((await json(manager, "PUT", "/api/v1/notifications/preferences", { preferences: [{ group: "stuck", cadence: "daily" }] })).status).toBe(200);
    const found: Detection[] = [{ detector: "approval_pending", roleId: roleA, roleTitle: "Dental Hygienist", title: "A decision has been waiting 3 days (Dental Hygienist)", body: "Invite Maria Reyes to a screen; decline Luis Ortega", action: { label: "Decide", href: "/" }, days: 3 }];
    const deps = (now: Date) => ({ integrations: container.integrations, appBaseUrl: container.env.APP_BASE_URL, itsQueueEmail: container.env.ITS_QUEUE_EMAIL, now, actor: { kind: "system" as const, id: "stuck_role_detector" } });
    const t = new Date();
    // the first rung is a line in the app; the second, two days on, is an email to the team
    expect(await withTenant(container.db, companyId, (tx) => runInterventionLadder(tx, deps(t), companyId, found))).toEqual([expect.objectContaining({ level: "brief" })]);
    const later = new Date(t.getTime() + 49 * 3_600_000);
    expect(await withTenant(container.db, companyId, (tx) => runInterventionLadder(tx, deps(later), companyId, found))).toEqual([expect.objectContaining({ level: "message" })]);
    setClock(later);
    await container.drain();
    setClock(new Date());
    const nudges = mail().sent.filter((m) => m.tags?.template === "intervention");
    expect(nudges.map((m) => m.to)).toEqual(["dana@harbor.test"]);
    expect(nudges[0].text).toContain("A decision has been waiting 3 days (Dental Hygienist).");
    expectNoLeaks(nudges[0]);
    // the team has the whole update in the app: the owner's copy counts as emailed, so no alert or summary repeats it;
    // the manager's waits for their morning summary
    const copy = async (userId: string) => (await container.db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.kind, "stuck.approval_pending"), eq(notifications.body, found[0].body))))[0];
    expect((await copy(ownerId)).emailedAt).toBeTruthy();
    expect((await copy(managerId)).emailedAt).toBeNull();
  });

  it("says an update was emailed only when it was: those from before email alerts were never emailed", async () => {
    // migration 0028 marked every earlier update as handled by copying its own creation time
    await withTenant(container.db, companyId, async (tx) => {
      const [row] = await tx.insert(notifications).values({ companyId, userId: ownerId, kind: "message.sent", title: "From before email alerts", body: "A message went out." }).returning();
      await tx.update(notifications).set({ emailedAt: row.createdAt }).where(eq(notifications.id, row.id));
    });
    const page = await history(owner, "?limit=100");
    expect(page.items.find((n) => n.title === "From before email alerts")?.emailedAt).toBeNull();
  });

  it("starts the summaries again when the company's run failed for good (an outage at 8:00 used up its attempts)", async () => {
    const digestRuns = () => container.db.select().from(workflowRuns).where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.workflowKey, "notification_digest")));
    const [dead] = await digestRuns();
    await container.db.update(workflowRuns).set({ status: "failed", wait: null, lastError: "the database was unreachable" }).where(eq(workflowRuns.id, dead.id));
    // the next start (anyone saving their settings, or the daily stuck-role check) finds no live run and makes one
    expect((await json(owner, "PUT", "/api/v1/notifications/preferences", { preferences: [{ group: "messages", cadence: "daily" }] })).status).toBe(200);
    await container.drain();
    const runs = await digestRuns();
    expect(runs).toHaveLength(2);
    const fresh = runs.find((r) => r.id !== dead.id)!;
    expect(fresh.idempotencyKey).toBe(`notification_digest:${companyId}`);
    expect(fresh.status).toBe("waiting");
    expect(runs.find((r) => r.id === dead.id)).toMatchObject({ status: "failed", idempotencyKey: `notification_digest:${companyId}:ended:${dead.id}` });
    // a live run is found, not doubled
    expect((await json(owner, "PUT", "/api/v1/notifications/preferences", { preferences: [{ group: "messages", cadence: "weekly" }] })).status).toBe(200);
    expect(await digestRuns()).toHaveLength(2);
  });

  it("the ITS queue's email when the ladder reaches a recruiter names the role and links the queue, never a candidate", async () => {
    // a detection whose body names people (a conversation stuck open, the team never acting)
    const found: Detection[] = [{ detector: "conversations_stuck", roleId: roleB, roleTitle: "Front Desk Coordinator", title: "2 applicants are stuck in the screening chat (Front Desk Coordinator)", body: "Priya Shah, Maria Reyes. Their screening chat should have closed by itself and did not.", action: { label: "See who", href: `/roles/${roleB}/talent` }, days: 6, applicationIds: [] }];
    const deps = (now: Date) => ({ integrations: container.integrations, appBaseUrl: container.env.APP_BASE_URL, itsQueueEmail: container.env.ITS_QUEUE_EMAIL, now, actor: { kind: "system" as const, id: "stuck_role_detector" } });
    const t = new Date();
    const levels: string[] = [];
    for (let i = 0; i < 4; i++) {
      const at = new Date(t.getTime() + i * 49 * 3_600_000);
      const r = await withTenant(container.db, companyId, (tx) => runInterventionLadder(tx, deps(at), companyId, found));
      levels.push(...r.filter((x) => x.detector === "conversations_stuck").map((x) => x.level));
    }
    expect(levels).toEqual(["brief", "message", "offer_recruiter", "escalation"]);
    setClock(new Date(t.getTime() + 3 * 49 * 3_600_000));
    await container.drain();
    setClock(new Date());
    const toQueue = mail().sent.filter((m) => m.to === container.env.ITS_QUEUE_EMAIL && m.tags?.template === "escalation");
    expect(toQueue).toHaveLength(1);
    expect(toQueue[0].text).toContain("2 applicants are stuck in the screening chat (Front Desk Coordinator)");
    expect(toQueue[0].text).toContain("/recruiter/queue/");
    expectNoLeaks(toQueue[0]);
    // nor is the name kept in the stored copy of that email
    const stored = await container.db.select({ bodyText: communications.bodyText }).from(communications).where(and(eq(communications.companyId, companyId), eq(communications.templateKey, "escalation")));
    expect(stored.length).toBeGreaterThan(0);
    for (const s of stored) expect(s.bodyText ?? "").not.toContain("Priya Shah");
  });
});
