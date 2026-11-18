import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { PROVIDER_REFUSED_ALERT, SEND_MAX_ATTEMPTS, queueCommunication, sweepStaleSending } from "@ros/agents";
import { setCompanyLive } from "@ros/core";
import { adminAlerts, applications, candidates, communications, events, jobs, notifications, uuidv7, withPlatform, withTenant } from "@ros/db";
import type { FakeEmailAdapter, SendResult } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { plantApplicant, plantJob } from "./test-helpers";

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

    // an outage of most of an hour (Wave S5 C2): still queued, never failed; it goes once the provider answers again
    fake().failNext(100);
    const patient = await withTenant(container.db, companyId, (tx) => queueCommunication(tx, container.integrations, draft("patient")));
    for (let i = 1; i <= 3; i++) { setClock(200_000 + i * 16 * 60_000); await container.drain(); }
    [row] = await container.db.select().from(communications).where(eq(communications.id, patient.communicationId));
    expect(row.status).toBe("queued"); // 48 minutes in
    fake().failNext(0);
    setClock(200_000 + 4 * 16 * 60_000);
    await container.drain();
    [row] = await container.db.select().from(communications).where(eq(communications.id, patient.communicationId));
    expect(row.status).toBe("sent");
    expect((await container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, "message.delivery_failed"))).some((a) => a.target?.id === patient.communicationId)).toBe(false);

    // a longer outage: every attempt for over an hour fails; the message ends failed, an operator is alerted, the candidate's team is told
    fake().failNext(100);
    const candidateId = uuidv7();
    const applicationId = uuidv7();
    const start = 2 * 3600_000;
    setClock(start);
    const doomed = await withTenant(container.db, companyId, (tx) => queueCommunication(tx, container.integrations, draft("doomed", { candidateId, applicationId })));
    await container.drain();
    for (let i = 1; i <= 3; i++) { setClock(start + i * 16 * 60_000); await container.drain(); }
    [row] = await container.db.select().from(communications).where(eq(communications.id, doomed.communicationId));
    expect(row.status).toBe("queued"); // still trying 48 minutes in
    for (let i = 4; i <= 16; i++) { setClock(start + i * 16 * 60_000); await container.drain(); }
    fake().failNext(0);
    [row] = await container.db.select().from(communications).where(eq(communications.id, doomed.communicationId));
    expect(row.status).toBe("failed");
    expect(row.sendAttempts).toBe(SEND_MAX_ATTEMPTS);
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

  it("an email to a candidate of a company that is not live is cancelled at send time, with the reason; the team's mail and the answer to a privacy request still go, and nothing waits for later", async () => {
    const candidateId = await withTenant(container.db, companyId, async (tx) => (await tx.insert(candidates).values({ companyId, firstName: "Cal", lastName: "Waiting", email: "cal.waiting@example.com", firstSource: "direct" }).returning({ id: candidates.id }))[0].id);
    const byKey = async (key: string) => (await container.db.select().from(communications).where(eq(communications.idempotencyKey, key)))[0];
    // the company's access is taken away (the one writer of the fact, as the admin dashboard's route calls it)
    await withPlatform(container.db, (tx) => setCompanyLive(tx, companyId, false, container.engine.clock()));
    const before = fake().sent.length;
    await withTenant(container.db, companyId, async (tx) => {
      await queueCommunication(tx, container.integrations, draft("offline-candidate", { to: "cal.waiting@example.com", candidateId }));
      await queueCommunication(tx, container.integrations, draft("offline-privacy", { to: "cal.waiting@example.com", candidateId, templateKey: "privacy_ack" }));
      await queueCommunication(tx, container.integrations, draft("offline-team", { to: "owner@outbox.test" }));
    });
    await container.drain();
    const stopped = await byKey("offline-candidate");
    expect(stopped).toMatchObject({ status: "cancelled", error: "the company is not live", sendAttempts: 0 });
    expect((await byKey("offline-privacy")).status).toBe("sent");
    expect((await byKey("offline-team")).status).toBe("sent");
    expect(fake().sent.slice(before).map((m) => m.subject).sort()).toEqual(["Subject offline-privacy", "Subject offline-team"]);
    const cancelled = await container.db.select().from(events).where(and(eq(events.type, "message.cancelled"), eq(events.subjectId, stopped.id)));
    expect(cancelled.map((e) => e.payload.reason)).toEqual(["the company is not live"]);
    // accepted again: the stopped email stays stopped (nothing was held to go later), and a new one goes
    await withPlatform(container.db, (tx) => setCompanyLive(tx, companyId, true, container.engine.clock()));
    await container.drain();
    expect((await byKey("offline-candidate")).status).toBe("cancelled");
    await withTenant(container.db, companyId, (tx) => queueCommunication(tx, container.integrations, draft("online-candidate", { to: "cal.waiting@example.com", candidateId })));
    await container.drain();
    expect((await byKey("online-candidate")).status).toBe("sent");
    expect(fake().sent.slice(before).map((m) => m.subject)).not.toContain("Subject offline-candidate");
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

  it("a send the provider may have taken (its reply cut off) is marked unknown and alerted, never failed or re-sent (Wave S5 review)", async () => {
    const adapter = fake();
    let calls = 0;
    adapter.send = async () => {
      calls += 1;
      return { status: "failed", error: "postmark took the message but its reply did not finish within 30 seconds; it may have been delivered", retryable: false, uncertain: true };
    };
    try {
      const queued = await withTenant(container.db, companyId, (tx) => queueCommunication(tx, container.integrations, draft("cut-off", { candidateId: uuidv7(), applicationId: uuidv7() })));
      await container.drain();
      const [row] = await container.db.select().from(communications).where(eq(communications.id, queued.communicationId));
      expect(row.status).toBe("unknown");
      expect(calls).toBe(1);
      expect((await container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, "message.delivery_unknown"))).some((a) => a.target?.id === queued.communicationId)).toBe(true);
      expect((await container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, "message.delivery_failed"))).some((a) => a.target?.id === queued.communicationId)).toBe(false);
      expect(await container.db.select().from(events).where(and(eq(events.type, "message.failed"), eq(events.subjectId, queued.communicationId)))).toHaveLength(0);
    } finally {
      // back to the class's own send (the override is an own property of the adapter)
      Reflect.deleteProperty(adapter, "send");
    }
  });

  describe("an email to a candidate that the provider refuses for good", () => {
    let roleId = "";
    const applicant = async (mark: string, locked = false) => {
      roleId ||= await plantJob(container, { companyId, title: "Dental Hygienist" });
      const applicationId = await plantApplicant(container, { companyId, roleId, mark, locked });
      const [row] = await container.db.select({ candidateId: applications.candidateId }).from(applications).where(eq(applications.id, applicationId));
      return { applicationId, candidateId: row.candidateId, email: `${mark.toLowerCase()}@people.test` };
    };
    /** Queues one email to this applicant, with the provider answering `answer`, and runs the worker. */
    const sendRefused = async (who: { applicationId: string; candidateId: string; email: string }, answer: SendResult) => {
      const adapter = fake();
      const key = `refused:${who.applicationId}`;
      adapter.send = async () => answer;
      try {
        await withTenant(container.db, companyId, (tx) => queueCommunication(tx, container.integrations, draft(key, { candidateId: who.candidateId, applicationId: who.applicationId, to: who.email, subject: "Thank you for applying: Dental Hygienist at Outbox Dental", templateKey: "acknowledgment" })));
        await container.drain();
      } finally {
        Reflect.deleteProperty(adapter, "send");
      }
      return (await container.db.select().from(communications).where(eq(communications.idempotencyKey, key)))[0];
    };
    const refusals = () => container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, PROVIDER_REFUSED_ALERT));
    const noticesAbout = async (applicationId: string) => (await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "candidate.unreachable")))).filter((x) => (x.action?.href ?? "").includes(applicationId));

    it("the team's notice names the person in plain words, never the provider's error, and opens that candidate; nothing is written about someone past the plan's limit", async () => {
      const gil = await applicant("Gil");
      const row = await sendRefused(gil, { status: "failed", error: "postmark 422: The 'From' address you supplied (x) is not a Sender Signature on your account.", retryable: false });
      expect(row.status).toBe("failed");
      const [note] = await noticesAbout(gil.applicationId);
      expect(note.title).toBe("An email to Gil Gil did not arrive");
      expect(note.body).toBe('"Thank you for applying: Dental Hygienist at Outbox Dental" could not be delivered. Phone them, or write to them another way.');
      expect(note.body).not.toMatch(/postmark|422|Sender Signature/);
      expect(note.action).toEqual({ label: "Open Gil Gil", href: `/roles/${roleId}/talent?open=${gil.applicationId}` });
      // someone the team cannot read yet: the email is marked failed, and no notice leads the team to them
      const kept = await applicant("Kit", true);
      expect((await sendRefused(kept, { status: "failed", error: "postmark 422: not a Sender Signature.", retryable: false })).status).toBe("failed");
      expect(await noticesAbout(kept.applicationId)).toEqual([]);
      expect(JSON.stringify(await container.db.select().from(notifications).where(eq(notifications.companyId, companyId)))).not.toContain("Kit");
    });

    it("a refusal that is not about one address alerts ITS once while it lasts; one about the address alerts nobody", async () => {
      await container.db.delete(adminAlerts).where(eq(adminAlerts.kind, PROVIDER_REFUSED_ALERT));
      const hal = await applicant("Hal");
      const ida = await applicant("Ida");
      await sendRefused(hal, { status: "failed", error: "postmark 412: Your account is pending approval.", retryable: false });
      const [alert] = await refusals();
      expect(alert).toMatchObject({ severity: "high", companyId, title: "The email provider is refusing emails", details: { provider: fake().id, template: "acknowledgment" } });
      expect(alert.body).toContain("postmark 412: Your account is pending approval.");
      // the next refused email in the hour adds nothing to the console
      await sendRefused(ida, { status: "failed", error: "postmark 412: Your account is pending approval.", retryable: false });
      expect(await refusals()).toHaveLength(1);
      // a refusal about one address: that person's problem, not the provider's, and no alert
      await container.db.delete(adminAlerts).where(eq(adminAlerts.kind, PROVIDER_REFUSED_ALERT));
      const jo = await applicant("Jo");
      const row = await sendRefused(jo, { status: "failed", error: "postmark 406: You tried to send to recipient(s) that have been marked as inactive.", retryable: false, aboutAddress: true });
      expect(row.status).toBe("failed");
      expect(await refusals()).toEqual([]);
      expect((await container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, "message.delivery_failed"))).some((a) => a.target?.id === row.id)).toBe(false);
    });
  });
});
