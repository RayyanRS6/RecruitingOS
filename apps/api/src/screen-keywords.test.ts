import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { WITHDRAW_CONFIRM_KEY } from "@ros/agents";
import { applications, candidates, events, notifications, recruiterEscalations, screens } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { useOneVisitApplyFlow } from "./test-helpers";

/**
 * The screening conversation's keyword commands (Wave 0 item 0.7), over HTTP and by text. Only a message that is the
 * command itself counts: an answer that starts with "Representative" or "Withdraw" is recorded as an answer. HUMAN hands
 * the conversation to a person at once. WITHDRAW withdraws nothing by itself: the candidate is asked, and confirms with
 * the button on the page (`POST /c/screen/:token/withdraw`) or by replying CONFIRM to a text; NO keeps the application.
 * The conversations here are the ones offered with the application (plan E1): the introduction, then Start.
 */
describe("screening keywords: whole-message commands and a confirmed withdrawal", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let cookie = "";
  let slug = "";
  let roleId = "";
  let elig: Array<{ key: string }> = [];
  let questions: Array<{ key: string; question: string }> = [];
  let n = 0;

  const json = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const form = (path: string, fields: Record<string, string> = {}) => app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
  const screenOf = async (applicationId: string) => (await container.db.select().from(screens).where(eq(screens.applicationId, applicationId)).orderBy(desc(screens.createdAt)))[0];
  const applicationOf = async (id: string) => (await container.db.select().from(applications).where(eq(applications.id, id)))[0];
  const decodeEntities = (html: string) => html.replace(/&#39;/g, "'").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

  async function apply(first: string, phone: string) {
    n += 1;
    const email = `${first.toLowerCase()}.${n}@keywords.test`;
    const fd = new FormData();
    fd.set("firstName", first); fd.set("lastName", "Tester"); fd.set("email", email); fd.set("phone", phone);
    fd.set("resume", new File([`${first} Tester, RDH\n${email}\n\nRegistered Dental Hygienist at Smile Bright Dental 2019 - present\nLicenses: RDH license CA #RDH12345, active\nSkills: Dentrix, periodontal charting, digital radiography`], "resume.txt", { type: "text/plain" }));
    for (const r of elig) fd.set(`elig_${r.key}`, "yes");
    fd.set("noticeVersionsShown", "ai_use@2026-09-01,privacy@2026-09-01");
    fd.set("acknowledged", "yes");
    expect((await app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: fd })).status).toBe(302);
    await container.drain();
    const [cand] = await container.db.select().from(candidates).where(eq(candidates.email, email));
    const [a] = await container.db.select().from(applications).where(and(eq(applications.roleId, roleId), eq(applications.candidateId, cand.id)));
    expect(a.stage).toBe("screen_invited");
    const scr = await screenOf(a.id);
    // Offered with the application (plan E1): the fixed introduction, then Start shows the first question in the packet's words.
    expect((await app.request(`/c/screen/${scr.token}`)).status).toBe(200);
    expect((await form(`/c/screen/${scr.token}/start`)).status).toBe(302);
    return { application: a, candidate: cand, token: scr.token };
  }

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", SMS_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    const { devLink } = (await (await json("POST", "/api/v1/auth/magic-link", { email: "dana@keywords.test" })).json()) as { devLink: string };
    cookie = (await json("POST", "/api/v1/auth/magic-link/consume", { token: new URL(devLink).searchParams.get("token") })).headers.get("set-cookie")!.split(";")[0];
    const co = (await (await json("POST", "/api/v1/companies", { name: "Keyword Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    slug = co.slug;
    // A pilot company: the conversation is offered in the same visit as the form (plan E1).
    await useOneVisitApplyFlow(container, co.id);
    const s = (await (await json("POST", "/api/v1/intake/sessions", { initialMessage: "I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." })).json()) as { session: { id: string } };
    roleId = ((await (await json("POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    await json("POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" });
    await container.drain();
    const role = (await (await json("GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> }; screening: { questions: Array<{ key: string; question: string }> } } } };
    elig = role.currentPacket.packet.requirements.eligibility;
    questions = role.currentPacket.packet.screening.questions;
    expect(questions.length).toBeGreaterThanOrEqual(2);
  });
  afterAll(async () => {
    await container.close();
  });

  it("an answer that starts with a keyword is recorded as an answer, not taken as a command", async () => {
    const { application, token } = await apply("Rita", "(949) 555-0141");
    expect((await form(`/c/screen/${token}`, { message: "Representative at a phone store for two years, then a dental front desk." })).status).toBe(302);
    let scr = await screenOf(application.id);
    expect(scr.status).toBe("in_progress");
    expect(scr.answers[questions[0].key]).toBe("Representative at a phone store for two years, then a dental front desk.");
    expect((await form(`/c/screen/${token}`, { message: "Withdraw cash from the till at closing and balance the drawer every night." })).status).toBe(302);
    scr = await screenOf(application.id);
    expect(scr.status).not.toBe("abandoned");
    expect(Object.values(scr.answers)).toContain("Withdraw cash from the till at closing and balance the drawer every night.");
    expect((await applicationOf(application.id)).stage).not.toBe("withdrawn");
    expect(await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.applicationId, application.id))).toHaveLength(0);
  });

  it("HUMAN on its own hands the conversation to a person", async () => {
    const { application, token } = await apply("Hugo", "(949) 555-0142");
    expect((await form(`/c/screen/${token}`, { message: "HUMAN" })).status).toBe(302);
    expect((await screenOf(application.id)).status).toBe("human_requested");
    expect(await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.applicationId, application.id))).toHaveLength(1);
  });

  it("WITHDRAW on the web asks first; 'No, keep my application' carries on; the confirm button withdraws", async () => {
    const { application, token } = await apply("Wendy", "(949) 555-0143");
    expect((await form(`/c/screen/${token}`, { message: "WITHDRAW" })).status).toBe(302);
    let scr = await screenOf(application.id);
    // nothing is withdrawn yet: the conversation asks, with the marker that makes the next answer decide
    expect(scr.status).toBe("in_progress");
    expect((await applicationOf(application.id)).stage).toBe("screening");
    expect(scr.transcript.at(-1)).toMatchObject({ role: "assistant", questionKey: WITHDRAW_CONFIRM_KEY });
    expect(scr.transcript.at(-1)!.content).toMatch(/^Do you want to withdraw your application for .+\? Press "Yes, withdraw my application" below to confirm\./);
    let page = decodeEntities(await (await app.request(`/c/screen/${token}`)).text());
    expect(page).toContain("Do you want to withdraw your application?");
    expect(page).toContain(`action="/c/screen/${token}/withdraw"`);
    expect(page).toContain("Yes, withdraw my application");
    expect(page).toContain("No, keep my application");
    // keep it: the conversation picks up where it was
    expect((await form(`/c/screen/${token}/withdraw`, { confirm: "no" })).status).toBe(302);
    scr = await screenOf(application.id);
    expect(scr.status).toBe("in_progress");
    expect(scr.transcript.at(-1)!.content).toBe(`No problem, your application stays active. Here is where we were: ${questions[0].question}`);
    page = decodeEntities(await (await app.request(`/c/screen/${token}`)).text());
    expect(page).not.toContain("Do you want to withdraw your application?");
    // ask again, then confirm with the button
    await form(`/c/screen/${token}`, { message: "withdraw" });
    expect((await form(`/c/screen/${token}/withdraw`, { confirm: "yes" })).status).toBe(302);
    scr = await screenOf(application.id);
    expect(scr.status).toBe("abandoned");
    expect((await applicationOf(application.id)).stage).toBe("withdrawn");
    expect((await container.db.select().from(events).where(and(eq(events.type, "application.withdrawn"), eq(events.subjectId, application.id))))[0].payload).toMatchObject({ during: "screen", channel: "web" });
    expect((await container.db.select().from(notifications).where(eq(notifications.kind, "candidate.withdrawn"))).some((x) => x.title === "Wendy Tester withdrew")).toBe(true);
    expect(decodeEntities(await (await app.request(`/c/screen/${token}`)).text())).toContain("This application was withdrawn.");
    // a second press on an ended conversation changes nothing; a forged link is a 404
    expect((await form(`/c/screen/${token}/withdraw`, { confirm: "yes" })).status).toBe(302);
    expect((await container.db.select().from(events).where(and(eq(events.type, "application.withdrawn"), eq(events.subjectId, application.id))))).toHaveLength(1);
    expect((await form(`/c/screen/${"x".repeat(32)}/withdraw`, { confirm: "yes" })).status).toBe(404);
  });

  it("by text, WITHDRAW asks to reply CONFIRM, an ordinary answer lets the question lapse, and CONFIRM withdraws", async () => {
    const { application } = await apply("Sami", "(949) 555-0144");
    const text = (body: string, sid: string) => form("/webhooks/twilio/inbound", { From: "+19495550144", To: "+15550001111", Body: body, MessageSid: sid });
    expect((await text("WITHDRAW", "SM-w1")).status).toBe(200);
    let scr = await screenOf(application.id);
    expect(scr.transcript.at(-1)).toMatchObject({ role: "assistant", channel: "sms", questionKey: WITHDRAW_CONFIRM_KEY });
    expect(scr.transcript.at(-1)!.content).toContain("Reply CONFIRM to withdraw.");
    expect((await applicationOf(application.id)).stage).toBe("screening");
    // an ordinary answer instead: recorded, and the question lapses
    await text("I have six years of hygiene experience in two practices.", "SM-w2");
    scr = await screenOf(application.id);
    expect(scr.answers[questions[0].key]).toBe("I have six years of hygiene experience in two practices.");
    await text("CONFIRM", "SM-w3"); // nothing pending any more: just an answer
    expect((await applicationOf(application.id)).stage).toBe("screening");
    // asked again, and confirmed
    await text("Withdraw", "SM-w4");
    await text("confirm", "SM-w5");
    scr = await screenOf(application.id);
    expect(scr.status).toBe("abandoned");
    expect((await applicationOf(application.id)).stage).toBe("withdrawn");
  });
});
