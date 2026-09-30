import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { withinContactHours } from "@ros/core";
import { aiRuns, applications, candidates, communications, entitlements, jobs, notifications, screens, workflowRuns } from "@ros/db";
import { fakePostmarkEvent, type FakeEmailAdapter, type FakeSmsAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { signInWithIdentity } from "./test-helpers";

/**
 * The company's contact hours reach the automated texts themselves (audit findings A8 and J16), not only the helper that
 * computes the window (company-settings.test.ts): the screening invitation, its reminder and the text that follows a
 * bounced email all wait for the company's next opening. The company texts Monday to Friday, 9:00 to 17:00, in Phoenix,
 * which keeps standard time all year (UTC-7): local noon is 19:00 UTC every day and no clock change falls on the weekend.
 * Saturday and Sunday noon are inside the legal window (8:00 to 21:00), so only the company's hours hold the texts back.
 */
describe("the company's contact hours hold back every automated text", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  const SECRET = "wh-secret-for-contact-hours-1234";
  const TZ = "America/Phoenix";
  const HOUR = 3600_000;
  const DAY = 24 * HOUR;
  // The first Saturday at least a day and a half away, so every moment below comes after the real clock the setup ran on.
  const SATURDAY_NOON = (() => { const d = new Date(Date.now() + 2 * DAY); d.setUTCHours(19, 0, 0, 0); while (d.getUTCDay() !== 6) d.setUTCDate(d.getUTCDate() + 1); return d.getTime(); })();
  const FRIDAY_NOON = SATURDAY_NOON - DAY;
  const SUNDAY_NOON = SATURDAY_NOON + DAY;
  const MONDAY_NINE = SATURDAY_NOON + 2 * DAY - 3 * HOUR;
  /** Moves the engine's clock and runs whatever is due by then. */
  const at = async (t: number) => {
    (container.engine as unknown as { now: () => Date }).now = () => new Date(t);
    await container.drain();
  };

  const json = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie: owner }, body: body ? JSON.stringify(body) : undefined });
  const webhook = (payload: unknown) => app.request("/webhooks/postmark/bounces", { method: "POST", headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`postmark:${SECRET}`).toString("base64")}` }, body: JSON.stringify(payload) });
  const mail = () => container.integrations.email as unknown as FakeEmailAdapter;
  const texts = () => (container.integrations.sms as FakeSmsAdapter).sent;
  const textsTo = (phone: string) => texts().filter((m) => m.to === phone);
  const screenRun = async (applicationId: string) => (await container.db.select().from(workflowRuns).where(eq(workflowRuns.workflowKey, "screen"))).find((r) => (r.state as { applicationId?: string }).applicationId === applicationId)!;
  const screensOf = (applicationId: string) => container.db.select().from(screens).where(eq(screens.applicationId, applicationId));

  let owner = "";
  let companyId = "";
  let slug = "";
  let roleId = "";
  let eligibility: Array<{ key: string }> = [];

  /** An applicant who agreed to texts, through the public form, the way a candidate applies. */
  async function apply(p: { first: string; last: string; email: string; phone: string }) {
    const fd = new FormData();
    fd.set("firstName", p.first); fd.set("lastName", p.last); fd.set("email", p.email); fd.set("phone", p.phone); fd.set("smsConsent", "yes"); fd.set("locationText", "Phoenix, AZ");
    fd.set("resume", new File([`${p.first} ${p.last}\nRegistered Dental Hygienist at Desert Smiles 2019 - present\nRDH license active\nPerio maintenance, Dentrix`], `${p.first.toLowerCase()}.txt`, { type: "text/plain" }));
    for (const rule of eligibility) fd.set(`elig_${rule.key}`, "yes");
    fd.set("noticeVersionsShown", "ai_use@2026-09-01,privacy@2026-09-01");
    fd.set("acknowledged", "yes");
    const res = await app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: fd });
    expect(res.status).toBe(302);
    await container.drain();
    const [cand] = await container.db.select().from(candidates).where(eq(candidates.email, p.email));
    const [a] = await container.db.select().from(applications).where(and(eq(applications.roleId, roleId), eq(applications.candidateId, cand.id)));
    return a;
  }

  beforeAll(async () => {
    // Texting on: this file is about when texts go out (decision M2 keeps texting off by default).
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", AUTH_PROVIDER: "fake", POSTMARK_WEBHOOK_SECRET: SECRET, SMS_ENABLED: "true" } });
    app = createApp(container);
    owner = await signInWithIdentity(app, container, { email: "dana@desertdental.test", name: "Dana Owner", provider: "google", aal2: false });
    const co = (await (await json("POST", "/api/v1/companies", { name: "Desert Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Phoenix", region: "AZ", country: "US" }] })).json()) as { id: string; slug: string };
    companyId = co.id;
    slug = co.slug;
    const started = (await (await json("POST", "/api/v1/intake/sessions", { initialMessage: "I need a dental hygienist in Phoenix, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active RDH license. Just draft it." })).json()) as { session: { id: string } };
    roleId = ((await (await json("POST", `/api/v1/intake/sessions/${started.session.id}/compile`)).json()) as { roleId: string }).roleId;
    expect((await json("POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" })).status).toBe(200);
    const role = (await (await json("GET", `/api/v1/roles/${roleId}`)).json()) as { status: string; currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } };
    expect(role.status).toBe("open");
    eligibility = role.currentPacket.packet.requirements.eligibility;
    // the owner's contact hours, set the way the Setup page sets them
    const hours = await json("PATCH", "/api/v1/companies/current", { timezone: TZ, settings: { businessHours: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" } } });
    expect(hours.status).toBe(200);
    expect(((await hours.json()) as { settings: { businessHours?: unknown } }).settings.businessHours).toEqual({ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" });
  });
  afterAll(async () => {
    await container.close();
  });

  const BEN = { first: "Ben", last: "Okafor", email: "ben.okafor@example.com", phone: "(602) 555-0102" };
  const BEN_PHONE = "+16025550102";
  const ANA = { first: "Ana", last: "Silva", email: "ana.silva@example.com", phone: "(602) 555-0101" };
  const ANA_PHONE = "+16025550101";
  let benId = "";
  let anaId = "";
  let textsBeforeTheWeekend = 0;

  it("the weekend is inside the legal window, so only the company's hours can hold a text back", () => {
    for (const t of [SATURDAY_NOON, SUNDAY_NOON]) {
      expect(withinContactHours(new Date(t), TZ)).toBe(true);
      expect(withinContactHours(new Date(t), TZ, { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" })).toBe(false);
    }
    expect(new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(MONDAY_NINE))).toBe("Mon 09:00");
  });

  it("on Friday at noon a consenting applicant is invited by text at once", async () => {
    await at(FRIDAY_NOON);
    const ben = await apply(BEN);
    benId = ben.id;
    expect(ben.stage).toBe("screen_invited");
    const [scr] = await screensOf(benId);
    expect(scr.channel).toBe("sms");
    expect(textsTo(BEN_PHONE)).toHaveLength(1);
    textsBeforeTheWeekend = texts().length;
  });

  it("on Saturday at noon a bounced email's text waits for Monday 9:00 instead of going out", async () => {
    await at(SATURDAY_NOON);
    const ack = mail().sent.find((m) => m.to === BEN.email && /received your application/.test(m.subject))!;
    expect(ack).toBeTruthy();
    const r = await webhook(fakePostmarkEvent({ providerMessageId: ack.providerMessageId, email: BEN.email, type: "HardBounce", id: 7001 }));
    expect(r.status).toBe(200);
    expect(((await r.json()) as { action: string }).action).toBe("suppressed");
    await container.drain();
    const [note] = await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "candidate.unreachable")));
    expect(note.body).toContain("goes out when contact hours open");
    const fallback = await container.db.select().from(jobs).where(eq(jobs.kind, "email.fallback_sms"));
    expect(fallback).toHaveLength(1);
    expect(fallback[0].status).toBe("queued");
    expect(Date.parse(fallback[0].runAt)).toBe(MONDAY_NINE);
    expect(texts()).toHaveLength(textsBeforeTheWeekend);
  });

  it("on Saturday at noon a consenting applicant's screening invitation waits for Monday 9:00: no text, no screen, no model call", async () => {
    const ana = await apply(ANA);
    anaId = ana.id;
    expect(ana.stage).toBe("triaged");
    const run = await screenRun(anaId);
    expect(run.status).toBe("waiting");
    expect(run.currentStep).toBe("invite");
    expect(run.wait).toMatchObject({ kind: "timer", until: new Date(MONDAY_NINE).toISOString() });
    expect(await screensOf(anaId)).toHaveLength(0);
    expect(await container.db.select().from(aiRuns).where(and(eq(aiRuns.workflowRunId, run.id), eq(aiRuns.task, "screen.turn")))).toHaveLength(0);
    expect(await container.db.select().from(communications).where(and(eq(communications.applicationId, anaId), eq(communications.channel, "sms")))).toHaveLength(0);
    expect(textsTo(ANA_PHONE)).toHaveLength(0);
    expect(mail().sent.filter((m) => m.to === ANA.email && /screening conversation/.test(m.subject))).toHaveLength(0);
    expect(texts()).toHaveLength(textsBeforeTheWeekend);
  });

  it("on Sunday at noon the 48-hour reminder is due, and it waits for Monday 9:00 too", async () => {
    await at(SUNDAY_NOON);
    const run = await screenRun(benId);
    expect(run.status).toBe("waiting");
    expect(run.currentStep).toBe("remind");
    expect(run.wait).toMatchObject({ kind: "timer", until: new Date(MONDAY_NINE).toISOString() });
    const [scr] = await screensOf(benId);
    expect(scr.status).toBe("invited");
    expect(scr.remindedAt).toBeNull();
    // Ana's invitation and Ben's bounce text are still waiting as well
    expect((await screenRun(anaId)).status).toBe("waiting");
    expect((await container.db.select().from(jobs).where(eq(jobs.kind, "email.fallback_sms")))[0].status).toBe("queued");
    expect(texts()).toHaveLength(textsBeforeTheWeekend);
  });

  it("on Monday at 9:00 all three texts go out: the invitation, the reminder and the bounce text", async () => {
    await at(MONDAY_NINE);
    // Ana: invited by text now, with the opening the model wrote now
    const ana = (await container.db.select().from(applications).where(eq(applications.id, anaId)))[0];
    expect(ana.stage).toBe("screen_invited");
    const [anaScreen] = await screensOf(anaId);
    expect(anaScreen.channel).toBe("sms");
    expect(Date.parse(anaScreen.invitedAt!)).toBe(MONDAY_NINE);
    const run = await screenRun(anaId);
    expect(await container.db.select().from(aiRuns).where(and(eq(aiRuns.workflowRunId, run.id), eq(aiRuns.task, "screen.turn")))).toHaveLength(1);
    // the waiting step sends when it wakes: its first pass (the wait) must not count as the invitation having gone out
    expect(textsTo(ANA_PHONE)).toHaveLength(1);
    expect(mail().sent.filter((m) => m.to === ANA.email && /screening conversation/.test(m.subject))).toHaveLength(1);
    const [allowance] = await container.db.select().from(entitlements).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, "text_screens")));
    expect(allowance.used).toBe(2); // Ben's and Ana's screens, each counted once
    // Ben: the reminder and the text that replaces his bounced email
    const [benScreen] = await screensOf(benId);
    expect(benScreen.status).toBe("reminded");
    expect(Date.parse(benScreen.remindedAt!)).toBe(MONDAY_NINE);
    const ben = textsTo(BEN_PHONE).map((m) => m.body);
    expect(ben).toHaveLength(3);
    expect(ben.filter((b) => /your screening for .* is waiting/.test(b))).toHaveLength(1);
    expect(ben.filter((b) => /could not reach you by email/.test(b))).toHaveLength(1);
    expect((await container.db.select().from(jobs).where(eq(jobs.kind, "email.fallback_sms")))[0].status).toBe("done");
    expect(texts()).toHaveLength(textsBeforeTheWeekend + 3);
  });
});
