import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import type { FakeHandler, StructuredRequest } from "@ros/ai";
import { FOCUS_KEY_PREFIX, FOCUS_QUESTION_WORDS, type LearnedFact, type ScreenTurn, type WrittenQuestion } from "@ros/contracts";
import { CHAT_WRAP_QUESTION, composeInterviewerBrief } from "@ros/agents";
import { CHAT_WRAP_KEY, entitlements } from "@ros/core";
import { aiRuns, applications, candidates, rolePackets, roles, screens, withTenant } from "@ros/db";
import type { FakeEmailAdapter, FakeSmsAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { roleScreeningFunnel } from "./services/screens";
import { useLaterApplyFlow } from "./test-helpers";

/**
 * Wave S8, slice A (spec-s8-followups.md section A): the chats without a plan, by text and on the web from an emailed
 * link (one a person sent before 21 Oct 2026; since then a new web link has a plan), ask what the web chat asks: the company's written questions, each as written, never their private note. A chat
 * created before keeps the list it began with. Such a chat is sent at its end, with no Review & send and no write-up,
 * and the candidate's record then learns from their own words.
 */
describe("the company's written questions in chats by text and from an emailed link", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let cookie = "";
  let companyId = "";
  let slug = "";
  let roleId = "";
  let elig: Array<{ key: string }> = [];
  // the chats sent by text and from an emailed link, for what the team reads of them afterwards
  let sentByText = "";
  let sentOnWeb = "";
  let screening: Array<{ key: string; question: string }> = [];
  // noon Pacific: inside texting hours
  const BASE = (() => { const d = new Date(); d.setUTCHours(19, 0, 0, 0); return d.getTime(); })();
  const NOTE = "names one calming technique such as tell show do and checks in with the patient";
  const NOTED = /calming technique|checks in with the patient/;
  const written: WrittenQuestion[] = [
    { key: "wq_calm", question: "Tell us about a time you calmed a nervous patient. What did you do?", required: true, lookFor: NOTE },
    { key: "wq_late", question: "How do you keep the schedule moving when the dentist runs late?", required: true },
  ];
  const CALM = "In 2024 a nervous patient froze in the chair, so I used tell-show-do with a hand mirror and we finished the cleaning.";
  const LATE = "On 3 busy Mondays I seated the next patient, took the X-rays and updated the chart so the dentist could step straight in.";

  const json = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const form = (path: string, fields: Record<string, string> = {}) => app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
  const screenOf = async (applicationId: string) => (await container.db.select().from(screens).where(eq(screens.applicationId, applicationId)).orderBy(desc(screens.createdAt)))[0];
  const learnedOn = async (applicationId: string): Promise<LearnedFact[]> => ((await container.db.select({ answers: applications.answers }).from(applications).where(eq(applications.id, applicationId)))[0]?.answers.learned ?? []) as LearnedFact[];
  const emailOutbox = () => (container.integrations.email as FakeEmailAdapter).sent;
  const textsTo = (phone: string) => (container.integrations.sms as FakeSmsAdapter).sent.filter((m) => m.to === phone).map((m) => m.body);
  const text = (from: string, body: string, sid: string) => form("/webhooks/twilio/inbound", { From: from, To: "+15550001111", Body: body, MessageSid: sid });
  const pageOf = async (token: string) => (await (await app.request(`/c/screen/${token}`)).text()).replace(/&#39;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
  const askedKeys = (s: { transcript: Array<{ role: string; questionKey?: string }> }) => s.transcript.filter((t) => t.role === "assistant" && t.questionKey).map((t) => t.questionKey);

  async function apply(p: { first: string; phone?: string }) {
    const email = `${p.first.toLowerCase()}@written.test`;
    const fd = new FormData();
    fd.set("firstName", p.first); fd.set("lastName", "Tester"); fd.set("email", email);
    if (p.phone) { fd.set("phone", p.phone); fd.set("smsConsent", "yes"); }
    fd.set("resume", new File([`${p.first} Tester\nRegistered Dental Hygienist at Harbor Dental 2020 - present\nRDH license CA active\nPerio maintenance, Dentrix`], "resume.txt", { type: "text/plain" }));
    for (const r of elig) fd.set(`elig_${r.key}`, "yes");
    fd.set("noticeVersionsShown", "ai_use@2026-09-01,privacy@2026-09-01");
    fd.set("acknowledged", "yes");
    expect((await app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: fd })).status).toBe(302);
    await container.drain();
    const [cand] = await container.db.select().from(candidates).where(eq(candidates.email, email));
    const [a] = await container.db.select().from(applications).where(and(eq(applications.roleId, roleId), eq(applications.candidateId, cand.id)));
    expect(a.stage).toBe("screen_invited");
    // Every applicant's AI interview has its plan (R20-4); a chat without one is a person's "Send a new link": the team
    // takes the first back and sends a new link, by text when the candidate gave a phone, else by email.
    expect((await json("POST", `/api/v1/applications/${a.id}/actions`, { action: "cancel_screen" })).status).toBe(200);
    expect((await json("POST", `/api/v1/applications/${a.id}/actions`, { action: "invite_screen", channel: p.phone ? "sms" : "web" })).status).toBe(200);
    await container.drain();
    // Since 21 Oct 2026 a person's new link on the web is the same AI interview, with a plan; the chat without one it was
    // before is kept for the links sent earlier, and is made here as those were (before Start, which fixes the plan).
    if (!p.phone) {
      const scr = await screenOf(a.id);
      expect(scr.progress.flow).toBe("one_visit");
      const { flow: _flow, ...before } = scr.progress;
      await container.db.update(screens).set({ progress: before }).where(eq(screens.id, scr.id));
    }
    return { application: a, email };
  }

  beforeAll(async () => {
    // Texting on: this file covers the chat by text.
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE);
    const { devLink } = (await (await json("POST", "/api/v1/auth/magic-link", { email: "dana@written.test" })).json()) as { devLink: string };
    cookie = (await json("POST", "/api/v1/auth/magic-link/consume", { token: new URL(devLink).searchParams.get("token") })).headers.get("set-cookie")!.split(";")[0];
    const co = (await (await json("POST", "/api/v1/companies", { name: "Written Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    slug = co.slug;
    companyId = co.id;
    await entitlements.applyPlan(container.db, co.id, "growth");
    // The ITS switch is ignored since 20 Oct 2026 (R20-12); the chats here are a person's new links (see `apply`).
    await useLaterApplyFlow(container, co.id);
    const s = (await (await json("POST", "/api/v1/intake/sessions", { initialMessage: "I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." })).json()) as { session: { id: string } };
    roleId = ((await (await json("POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    expect((await json("POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" })).status).toBe(200);
    await container.drain();
    // The company's own written questions, one with a private note of what a good answer shows.
    const [role] = await container.db.select().from(roles).where(eq(roles.id, roleId));
    const [pv] = await container.db.select().from(rolePackets).where(and(eq(rolePackets.roleId, roleId), eq(rolePackets.version, role.currentPacketVersion!)));
    await container.db.update(rolePackets).set({ packet: { ...pv.packet, companyQuestions: { quick: [], written } } }).where(eq(rolePackets.id, pv.id));
    elig = pv.packet.requirements.eligibility;
    screening = pv.packet.screening.questions;
    expect(screening.length).toBeGreaterThanOrEqual(2);
  });
  afterAll(async () => {
    await container.close();
  });

  it("a web chat whose link was emailed asks the written questions, and is sent at its end, with the record learning from it", async () => {
    const { application } = await apply({ first: "Wren" });
    let scr = await screenOf(application.id);
    expect(scr.channel).toBe("web");
    expect(scr.progress.asks).toBe("written");
    expect(await pageOf(scr.token)).toContain(`${written.length} short questions`);
    expect((await form(`/c/screen/${scr.token}/start`)).status).toBe(302);
    const page = await pageOf(scr.token);
    expect(page).toContain(written[0].question);
    expect(page).toMatch(/Question 1 of 2/);
    expect(page).not.toMatch(NOTED);
    expect((await form(`/c/screen/${scr.token}`, { message: CALM })).status).toBe(302);
    expect(await pageOf(scr.token)).toContain(written[1].question);
    expect((await form(`/c/screen/${scr.token}`, { message: LATE })).status).toBe(302);
    scr = await screenOf(application.id);
    expect(scr.status).toBe("completed");
    expect(scr.answers).toEqual({ wq_calm: CALM, wq_late: LATE });
    expect(scr.progress.writeup).toBeUndefined();
    expect(scr.transcript.some((t) => NOTED.test(t.content))).toBe(false);
    expect((await learnedOn(application.id)).map((f) => f.text)).toEqual([CALM, LATE]);
    sentOnWeb = application.id;
  });

  it("a chat created before keeps the list it began with: the job's screening questions", async () => {
    const { application } = await apply({ first: "Olga" });
    let scr = await screenOf(application.id);
    // as a screen created before Wave S8 has it: no `asks`
    const { asks: _asks, ...before } = scr.progress;
    await container.db.update(screens).set({ progress: before }).where(eq(screens.id, scr.id));
    expect(await pageOf(scr.token)).toContain(`${screening.length} short questions`);
    expect((await form(`/c/screen/${scr.token}/start`)).status).toBe(302);
    expect(await pageOf(scr.token)).toContain(screening[0].question);
    for (let i = 0; i < screening.length + 4; i++) {
      scr = await screenOf(application.id);
      if (scr.status === "completed") break;
      expect((await form(`/c/screen/${scr.token}`, { message: "Yes, for 6 years at 2 practices, and that works well for me." })).status).toBe(302);
    }
    scr = await screenOf(application.id);
    expect(scr.status).toBe("completed");
    expect(askedKeys(scr)).toEqual(screening.map((q) => q.key));
    expect(Object.keys(scr.answers).some((k) => k.startsWith("wq_"))).toBe(false);
  });

  it("the panel's view of such a chat before it is sent: none of their words, but which list it asks, and those questions by name", async () => {
    const { application } = await apply({ first: "Quinn" });
    expect((await screenOf(application.id)).progress.asks).toBe("written");
    const detail = (await (await json("GET", `/api/v1/applications/${application.id}`)).json()) as { screens: Array<{ answersShared: boolean; progress: { asks?: string } }>; packetLabels: { written: Array<{ key: string }> } };
    expect(detail.screens[0]).toMatchObject({ answersShared: false, progress: { asks: "written" } });
    expect(detail.packetLabels.written.map((w) => w.key)).toEqual(written.map((w) => w.key));
  });
});
