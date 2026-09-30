import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { queueCommunication, sweepStaleSending } from "@ros/agents";
import { adminAlerts, communications, events, jobs, notifications, uuidv7, withTenant } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";

/**
 * The outbox: a message written inside a transaction leaves only after that transaction commits, once per key, and a
 * provider failure is retried by the worker, never by re-running the caller. What the tests could not see before (the
 * fake adapter used to hide a repeated send behind the key) is now the behaviour under test.
 */
describe("outbox: messages leave after commit, once, and failures are visible", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let companyId = "";
  const actor = { kind: "system" as const, id: "outbox_test" };
  const fake = () => container.integrations.email as FakeEmailAdapter;
  const BASE = Date.now();
  const setClock = (offsetMs: number) => { (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + offsetMs); };
  const draft = (key: string, extra: Partial<Parameters<typeof queueCommunication>[2]> = {}) => ({ channel: "email" as const, companyId, to: "person@example.com", from: "Test <updates@test.localhost>", subject: `Subject ${key}`, text: "Hello", templateKey: "test", idempotencyKey: key, actor, ...extra });

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    setClock(0);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@outbox.test" }) });
    const { devLink } = (await r1.json()) as { devLink: string };
    const r2 = await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: new URL(devLink).searchParams.get("token") }) });
    const cookie = r2.headers.get("set-cookie")!.split(";")[0];
    const co = (await (await app.request("/api/v1/companies", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ name: "Outbox Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] }) })).json()) as { id: string };
    companyId = co.id;
    await container.drain();
  });
  afterAll(async () => {
    await container.close();
  });

  it("the same key queued twice is one row, one job and one email", async () => {
    const before = fake().sent.length;
    const results = await withTenant(container.db, companyId, async (tx) => [await queueCommunication(tx, container.integrations, draft("twice")), await queueCommunication(tx, container.integrations, draft("twice"))]);
    expect(results[0].status).toBe("pending");
    expect(results[1].communicationId).toBe(results[0].communicationId);
    expect(await container.db.select().from(communications).where(eq(communications.idempotencyKey, "twice"))).toHaveLength(1);
    await container.drain();
    expect(fake().sent.length - before).toBe(1);
    const [row] = await container.db.select().from(communications).where(eq(communications.idempotencyKey, "twice"));
    expect(row.status).toBe("sent");
    expect(row.providerMessageId).toBe(fake().sent.at(-1)!.providerMessageId);
    // asking again after it was sent reports the sent message and sends nothing
    const again = await withTenant(container.db, companyId, (tx) => queueCommunication(tx, container.integrations, draft("twice")));
    expect(again.status).toBe("sent");
    await container.drain();
    expect(fake().sent.length - before).toBe(1);
    expect((await container.db.select().from(events).where(and(eq(events.type, "message.sent"), eq(events.subjectId, row.id)))).length).toBe(1);
  });

  it("a transaction that queues a message and then fails sends nothing and leaves nothing behind", async () => {
    const before = fake().sent.length;
    await expect(withTenant(container.db, companyId, async (tx) => { await queueCommunication(tx, container.integrations, draft("rolled-back")); throw new Error("a later statement failed"); })).rejects.toThrow(/later statement/);
    await container.drain();
    expect(fake().sent.length).toBe(before);
    expect(await container.db.select().from(communications).where(eq(communications.idempotencyKey, "rolled-back"))).toHaveLength(0);
    expect(await container.db.select().from(jobs).where(eq(jobs.kind, "communication.send"))).not.toContainEqual(expect.objectContaining({ status: "queued" }));
  });

  it("a provider outage is retried by the worker with backoff; an outage that outlasts every attempt fails the message visibly", async () => {
    fake().failNext(2);
    const before = fake().sent.length;
    const queued = await withTenant(container.db, companyId, (tx) => queueCommunication(tx, container.integrations, draft("flaky")));
    await container.drain();
    let [row] = await container.db.select().from(communications).where(eq(communications.id, queued.communicationId));
    expect(row.status).toBe("queued");
    expect(row.sendAttempts).toBe(1);
    expect(row.error).toMatch(/outage/);
    // the backoff timer: second attempt fails too, the third succeeds
    setClock(70_000);
    await container.drain();
    setClock(140_000);
    await container.drain();
    [row] = await container.db.select().from(communications).where(eq(communications.id, queued.communicationId));
    expect(row.status).toBe("sent");
    expect(row.sendAttempts).toBe(3);
    expect(fake().sent.length - before).toBe(1);

    // a longer outage: every attempt fails; the message ends failed, an operator is alerted, the candidate's team is told
    fake().failNext(20);
    const candidateId = uuidv7();
    const applicationId = uuidv7();
    const doomed = await withTenant(container.db, companyId, (tx) => queueCommunication(tx, container.integrations, draft("doomed", { candidateId, applicationId })));
    for (let i = 0; i < 8; i++) { setClock(200_000 + i * 70_000); await container.drain(); }
    fake().failNext(0);
    [row] = await container.db.select().from(communications).where(eq(communications.id, doomed.communicationId));
    expect(row.status).toBe("failed");
    expect(row.sendAttempts).toBe(6);
    expect((await container.db.select().from(events).where(and(eq(events.type, "message.failed"), eq(events.subjectId, doomed.communicationId)))).length).toBe(1);
    expect((await container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, "message.delivery_failed"))).some((a) => a.target?.id === doomed.communicationId)).toBe(true);
    expect((await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "candidate.unreachable")))).length).toBeGreaterThanOrEqual(1);
    setClock(0);
  });

  it("a suppressed address fails at once, without retries and without a provider alert", async () => {
    const { suppressAddress } = await import("@ros/core");
    await suppressAddress(container.db, { address: "dead@example.com", reason: "hard_bounce", source: "admin", actor });
    const queued = await withTenant(container.db, companyId, (tx) => queueCommunication(tx, container.integrations, draft("suppressed", { to: "dead@example.com" })));
    await container.drain();
    const [row] = await container.db.select().from(communications).where(eq(communications.id, queued.communicationId));
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/suppressed/);
    expect(row.sendAttempts).toBe(1);
    expect((await container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, "message.delivery_failed"))).some((a) => a.target?.id === queued.communicationId)).toBe(false);
  });

  it("a message interrupted while sending is reported, never re-sent on a guess", async () => {
    const before = fake().sent.length;
    const [stuck] = await withTenant(container.db, companyId, (tx) => tx.insert(communications).values({ companyId, direction: "outbound", channel: "email", fromAddress: "x", toAddress: "y@example.com", subject: "s", bodyText: "t", templateKey: "test", provider: "fake-email", status: "sending", sendingAt: new Date(BASE - 60 * 60_000).toISOString(), sentBy: actor, idempotencyKey: "stuck" }).returning({ id: communications.id }));
    expect(await sweepStaleSending(container.db, new Date(BASE))).toBe(1);
    const [row] = await container.db.select().from(communications).where(eq(communications.id, stuck.id));
    expect(row.status).toBe("unknown");
    expect((await container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, "message.delivery_unknown"))).some((a) => a.target?.id === stuck.id)).toBe(true);
    await container.drain();
    expect(fake().sent.length).toBe(before);
  });
});
