import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { ChatItem, LearnedFact, RolePacket, ScreenProgress, ScreenTranscriptEntry } from "@ros/contracts";
import { entitlements } from "@ros/core";
import { applications, candidates, screens, unconfirmedScreens, withTenant } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { LearnedFactsSection } from "./pages/profile-pages";
import { hashToken } from "./services/apply-conversation";
import { clipWords, factsFromSentChat, learnFromConfirmedRepeat, learnFromSentChat, learnedFactsFor, reuseToken, reusedDetailsFor, type SentChat } from "./services/profile-facts";
import { useLaterApplyFlow } from "./test-helpers";

/**
 * Wave S7, slice S7-F (spec steps 3 and 10): what a candidate's record at one company learns from the chats they send,
 * shown and changed on their application record, filled in on their next application to the same company, and reused
 * through a link that only ever goes to the address on file.
 */

const at = "2026-10-15T10:00:00.000Z";
const said = (content: string): ScreenTranscriptEntry => ({ role: "candidate", content, at, channel: "web" });
const asked = (content: string, questionKey?: string): ScreenTranscriptEntry => ({ role: "assistant", content, at, channel: "web", ...(questionKey ? { questionKey } : {}) });
const item = (key: string, kind: ChatItem["kind"], state: ChatItem["state"]): ChatItem => ({ key, kind, required: kind === "written", state, step: "direct", pushes: 0 });
const progress = (extra: Partial<ScreenProgress> = {}): ScreenProgress => ({ askedKeys: [], currentQuestionKey: null, followUps: {}, confusedTurns: 0, failures: 0, flow: "one_visit", submittedAt: at, ...extra });
const packetOf = (questions: Array<{ key: string; kind: string; question: string }>, written: Array<{ key: string; question: string }> = []) =>
  ({ screening: { questions }, companyQuestions: written.length ? { quick: [], written: written.map((w) => ({ ...w, required: true })) } : undefined }) as unknown as RolePacket;
let ids = 0;
const learn = (chat: SentChat, packet: RolePacket) => factsFromSentChat({ chat, packet, applicationId: "app-1", roleTitle: "Robotics Trainer", at, newId: () => { ids += 1; return `lf_test_${ids}`; } });

describe("what a sent chat teaches the record (in code, never by a model)", () => {
  const packet = packetOf(
    [
      { key: "proud", kind: "behavioral", question: "Tell me about a project you are proud of." },
      { key: "pay", kind: "compensation", question: "What pay are you looking for?" },
      { key: "start", kind: "availability", question: "When could you start?" },
      { key: "commute", kind: "logistics", question: "How would you get to the site?" },
    ],
  );

  it("keeps the candidate's own words for what the chat settled, and nothing it did not", () => {
    const chat: SentChat = {
      id: "scr-1",
      status: "completed",
      transcript: [
        asked("Have you worked with Arduino or similar boards?"),
        said("I built a small IoT robot with an Arduino at CUST last year."),
        asked("Have you trained other people?"),
        said("No, I haven't."),
        asked("Tell me about a project you are proud of.", "proud"),
        said("I led a crop monitoring app with three classmates. We shipped it to twenty farmers."),
        asked("What pay are you looking for?", "pay"),
        said("I am hoping for about twenty five dollars an hour."),
        asked("When could you start?", "start"),
        said("In two weeks from now."),
        asked("How would you get to the site?", "commute"),
        said("I have my own car and a licence."),
      ],
      answers: { arduino: "I built a small IoT robot with an Arduino at CUST last year.", training: "No, I haven't.", proud: "I led a crop monitoring app with three classmates. We shipped it to twenty farmers.", pay: "I am hoping for about twenty five dollars an hour.", start: "In two weeks from now.", commute: "I have my own car and a licence." },
      progress: progress({ chat: { v: 1, section: "wrapping_up", current: null, builtAt: at, items: [item("arduino", "gap", "covered"), item("training", "gap", "unknown"), item("proud", "written", "covered"), item("pay", "written", "covered"), item("start", "written", "covered"), item("commute", "written", "covered")] } }),
    };
    const facts = learn(chat, packet);
    expect(facts.map((f) => [f.kind, f.text])).toEqual([
      ["skill", "I built a small IoT robot with an Arduino at CUST last year."],
      ["experience", "I led a crop monitoring app with three classmates. We shipped it to twenty farmers."],
      ["logistics", "I have my own car and a licence."],
    ]);
    // "No, I haven't" is settled as not known: never a fact. Pay and a start date belong to one job.
    expect(JSON.stringify(facts)).not.toMatch(/haven't|dollars|two weeks/);
    for (const f of facts) {
      expect(f.quote).toBe(f.text);
      expect(f.from).toEqual({ applicationId: "app-1", screenId: "scr-1", roleTitle: "Robotics Trainer", at });
    }
  });

  it("never keeps words the candidate did not send, a skipped or not-given answer, a bare yes, or a sentence about a protected characteristic", () => {
    const chat: SentChat = {
      id: "scr-2",
      status: "completed",
      transcript: [said("Yes."), said("I fixed tractors on my uncle's farm for two summers."), said("I am 52 and I fixed robots for years.")],
      // the recorded answer is the assistant's rewording; the write-up's quote is the candidate's own message
      answers: { proud: "Candidate has extensive mechanical repair experience.", commute: "Yes.", arduino: "I am 52 and I fixed robots for years." },
      progress: progress({
        declined: ["start"],
        chat: { v: 1, section: "wrapping_up", current: null, builtAt: at, items: [item("arduino", "gap", "covered"), item("proud", "written", "covered"), item("commute", "written", "covered")] },
        writeup: { v: 1, writtenAt: at, aiRunId: null, promptVersion: 1, answers: [
          { questionKey: "proud", answer: "I have extensive repair experience on farms.", status: "answered", quotes: ["Made up words nobody typed.", "I fixed tractors on my uncle's farm for two summers."], note: null, by: "writeup" },
          { questionKey: "commute", answer: "", status: "not_given", quotes: [], note: "No way of getting there was given.", by: "writeup" },
        ] },
      }),
    };
    const facts = learn(chat, packet);
    expect(facts.map((f) => f.text)).toEqual(["I fixed tractors on my uncle's farm for two summers."]);
    expect(JSON.stringify(facts)).not.toMatch(/extensive|Made up|No way|52/);
  });

  it("takes a written-up answer the candidate changed themselves exactly as they typed it, and reads a company's own questions by their words", () => {
    const written = packetOf([], [{ key: "wq_transport", question: "Do you have your own transport to reach the site?" }, { key: "wq_project", question: "Describe a project you built." }, { key: "wq_pay", question: "What salary would you expect?" }]);
    const chat: SentChat = {
      id: "scr-3",
      status: "completed",
      transcript: [said("I ride a motorbike every day, about 20 minutes."), { ...said("I built a weather station with a Raspberry Pi and solar power."), source: "edit" }, said("Around forty thousand a year please.")],
      answers: { wq_transport: "I ride a motorbike every day, about 20 minutes.", wq_project: "A weather station.", wq_pay: "Around forty thousand a year please." },
      progress: progress({ writeup: { v: 1, writtenAt: at, aiRunId: null, promptVersion: 1, answers: [{ questionKey: "wq_project", answer: "I built a weather station with a Raspberry Pi and solar power.", status: "answered", quotes: [], note: null, by: "candidate", editedAt: at }] } }),
    };
    expect(learn(chat, written).map((f) => [f.kind, f.text])).toEqual([
      ["logistics", "I ride a motorbike every day, about 20 minutes."],
      ["project", "I built a weather station with a Raspberry Pi and solar power."],
    ]);
  });

  it("learns nothing from a chat that was not sent by the candidate", () => {
    const base: SentChat = { id: "scr-4", status: "in_progress", transcript: [said("I led a crop monitoring app with three classmates.")], answers: { proud: "I led a crop monitoring app with three classmates." }, progress: progress() };
    expect(learn(base, packet)).toEqual([]);
    expect(learn({ ...base, status: "completed", progress: progress({ completedBy: "recruiter_call" }) }, packet)).toEqual([]);
    expect(learn({ ...base, status: "completed" }, packet)).toHaveLength(1);
  });

  it("cuts long words at a sentence or a word, never past the limit", () => {
    const long = `${"I worked on many robots. ".repeat(12)}And more.`;
    const text = clipWords(long, 200, true);
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text.endsWith("robots.")).toBe(true);
    const oneSentence = "word ".repeat(80).trim();
    expect(clipWords(oneSentence, 200, true)).toMatch(/word…$/);
    expect(clipWords(oneSentence, 200, true).length).toBeLessThanOrEqual(200);
    expect(clipWords(oneSentence, 200, false).endsWith("word")).toBe(true);
    expect(clipWords("short", 200, true)).toBe("short");
  });
});

describe("the record learns per company, the candidate changes it, and the details are reused at the same company only", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let companyId = "";
  let slug = "";
  let roleId = "";
  let otherRoleId = "";
  let applicationId = "";
  let candidateId = "";
  let statusToken = "";
  let packet: RolePacket;
  const env = { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", SMS_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", JOBS_BASE_URL: "https://jobs.example.test" };
  const outbox = () => (container.integrations.email as FakeEmailAdapter).sent;
  const json = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie: owner }, body: body ? JSON.stringify(body) : undefined });
  const form = (path: string, fields: Record<string, string>) => app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
  const signIn = async (email: string) => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const { devLink } = (await r1.json()) as { devLink: string };
    const r2 = await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: new URL(devLink).searchParams.get("token") }) });
    return r2.headers.get("set-cookie")!.split(";")[0];
  };
  const openRole = async (message: string) => {
    const s = (await (await json("POST", "/api/v1/intake/sessions", { initialMessage: message })).json()) as { session: { id: string } };
    const id = ((await (await json("POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    expect((await json("POST", `/api/v1/roles/${id}/approve`, { version: 1, note: "ok" })).status).toBe(200);
    await container.drain();
    const role = (await (await json("GET", `/api/v1/roles/${id}`)).json()) as { currentPacket: { packet: RolePacket } };
    return { id, packet: role.currentPacket.packet };
  };
  const factsNow = () => withTenant(container.db, companyId, (tx) => learnedFactsFor(tx, { companyId, candidateId }));
  const storedOn = async (id: string): Promise<LearnedFact[]> => ((await container.db.select({ answers: applications.answers }).from(applications).where(eq(applications.id, id)))[0]?.answers.learned ?? []);
  const sentScreen = async (input: { transcript: ScreenTranscriptEntry[]; answers: Record<string, string>; progress: ScreenProgress; status?: string }) => {
    const [row] = await container.db.insert(screens).values({ companyId, applicationId, channel: "web", status: input.status ?? "completed", token: randomBytes(12).toString("hex"), transcript: input.transcript, answers: input.answers, progress: input.progress, completedAt: at }).returning();
    return row;
  };
  const html = async (node: unknown) => String(await Promise.resolve((node as { toString(): string | Promise<string> }).toString()));

  beforeAll(async () => {
    container = await createContainer({ memory: true, env });
    app = createApp(container);
    owner = await signIn("owner@profile.test");
    const co = (await (await json("POST", "/api/v1/companies", { name: "Profile Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    companyId = co.id;
    slug = co.slug;
    await entitlements.applyPlan(container.db, companyId, "growth");
    await useLaterApplyFlow(container, companyId);
    const first = await openRole("I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it.");
    roleId = first.id;
    packet = first.packet;
    otherRoleId = (await openRole("I need a front desk coordinator in Irvine, $22 to $26 an hour, full time. It's growth. Ceiling $27. I decide. Must-haves: Dentrix scheduling. Just draft it.")).id;
    const fd = new FormData();
    for (const [k, v] of Object.entries({ firstName: "Maria", lastName: "Reyes", email: "maria.reyes@example.com", phone: "(949) 555-0100", locationText: "Tustin, CA", noResume: "Registered Dental Hygienist at Coastal Family Dentistry since 2019; active CA RDH license.", noticeVersionsShown: "ai_use@2026-09-01,privacy@2026-09-01", acknowledged: "yes" })) fd.set(k, v);
    for (const r of packet.requirements.eligibility) fd.set(`elig_${r.key}`, "yes");
    expect((await app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: fd })).status).toBe(302);
    await container.drain();
    const [a] = await container.db.select().from(applications).where(eq(applications.roleId, roleId));
    applicationId = a.id;
    candidateId = a.candidateId;
    statusToken = a.statusToken;
  });
  afterAll(async () => {
    await container.close();
  });

  it("learns once from a sent chat (a second Send adds nothing), never from an unsent one, and lists the facts newest first", async () => {
    const must = packet.requirements.mustHaves[0].key;
    const unsent = await sentScreen({ status: "in_progress", transcript: [said("I polished teeth for the whole county fair.")], answers: { [must]: "I polished teeth for the whole county fair." }, progress: progress({ chat: { v: 1, section: "required", current: null, builtAt: at, items: [item(must, "gap", "covered")] } }) });
    expect(await learnFromSentChat(container, { kind: "screen", id: unsent.id, companyId, applicationId, token: unsent.token })).toBe(0);
    await container.db.update(screens).set({ status: "cancelled" }).where(eq(screens.id, unsent.id));
    const sent = await sentScreen({
      transcript: [asked("Tell me about the licence."), said("I renewed my CA RDH license in March and it runs to 2028.")],
      answers: { [must]: "I renewed my CA RDH license in March and it runs to 2028." },
      progress: progress({ chat: { v: 1, section: "wrapping_up", current: null, builtAt: at, items: [item(must, "gap", "covered")] } }),
    });
    const ref = { kind: "screen" as const, id: sent.id, companyId, applicationId, token: sent.token };
    expect(await learnFromSentChat(container, ref)).toBe(1);
    expect(await learnFromSentChat(container, ref)).toBe(0);
    // a detached conversation is not the candidate's until the address owner confirms it
    expect(await learnFromSentChat(container, { ...ref, kind: "detached" })).toBe(0);
    const stored = await storedOn(applicationId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: "skill", text: "I renewed my CA RDH license in March and it runs to 2028.", from: { applicationId, screenId: sent.id, roleTitle: packet.identity.title } });
    expect((await factsNow()).map((f) => f.text)).toEqual(["I renewed my CA RDH license in March and it runs to 2028."]);
  });

  it("learns from a repeat submission's answers once the address owner confirmed them", async () => {
    const must = packet.requirements.mustHaves[0].key;
    const merged = await sentScreen({ transcript: [said("I also teach flossing classes at the community center.")], answers: { [must]: "I also teach flossing classes at the community center." }, progress: progress({ chat: { v: 1, section: "wrapping_up", current: null, builtAt: at, items: [item(must, "gap", "covered")] } }) });
    const raw = randomBytes(12).toString("hex");
    await container.db.insert(unconfirmedScreens).values({ companyId, roleId, applicationId, packetVersion: 1, firstName: "", token: randomBytes(12).toString("hex"), status: "completed", intent: "answers", confirmation: "sent", confirmTokenHash: hashToken(raw), expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    // not confirmed yet: nothing
    expect(await learnFromConfirmedRepeat(container, raw)).toBe(0);
    await container.db.update(unconfirmedScreens).set({ confirmation: "confirmed", mergedScreenId: merged.id }).where(eq(unconfirmedScreens.confirmTokenHash, hashToken(raw)));
    expect(await learnFromConfirmedRepeat(container, raw)).toBe(1);
    expect(await learnFromConfirmedRepeat(container, "not-a-link")).toBe(0);
    expect((await factsNow()).map((f) => f.text)).toContain("I also teach flossing classes at the community center.");
  });

  it("shows each fact on the record with where it came from, and the candidate changes or removes it there", async () => {
    const facts = await factsNow();
    const target = facts.find((f) => f.text.startsWith("I renewed"))!;
    const page = await html(LearnedFactsSection({ facts, statusToken, companyName: "Profile Dental", timeZone: "America/Los_Angeles" }));
    expect(page).toContain("What your chats added");
    expect(page).toContain("I renewed my CA RDH license in March and it runs to 2028.");
    const day = new Date(target.from.at).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric" });
    expect(page).toContain(`From your chat on ${packet.identity.title}, ${day}`);
    expect(page).toContain(`action="/c/status/${statusToken}/facts/${target.id}"`);
    expect(page).toContain(`href="/c/status/${statusToken}/apply-another"`);
    expect(page).not.toMatch(/<script/);
    const empty = await html(LearnedFactsSection({ facts: [], statusToken, companyName: "Profile Dental", timeZone: "America/Los_Angeles", saved: "removed" }));
    expect(empty).toContain("Nothing yet.");
    expect(empty).toContain("Removed. It is no longer kept with your applications here.");
    // the page promises only what is done: the facts are kept for the candidate to check, never said to be filled in
    expect(page).not.toMatch(/fills them in|filled in when/);

    const changed = await form(`/c/status/${statusToken}/facts/${target.id}`, { action: "change", text: "Active CA RDH license, renewed March 2026." });
    expect(changed.status).toBe(303);
    expect(changed.headers.get("location")).toBe(`/c/status/${statusToken}?facts=changed#learned`);
    expect((await factsNow()).find((f) => f.id === target.id)).toMatchObject({ text: "Active CA RDH license, renewed March 2026.", editedAt: expect.any(String) });
    // their own words only; a sentence about a protected characteristic is never kept
    expect((await form(`/c/status/${statusToken}/facts/${target.id}`, { action: "change", text: "I am 45 years old." })).headers.get("location")).toContain("facts=personal");
    expect((await form(`/c/status/${statusToken}/facts/${target.id}`, { action: "change", text: "  " })).headers.get("location")).toContain("facts=empty");
    // removing takes the words out at once; the chat it came from never teaches it again
    expect((await form(`/c/status/${statusToken}/facts/${target.id}`, { action: "remove" })).headers.get("location")).toContain("facts=removed");
    const tomb = (await storedOn(applicationId)).find((f) => f.id === target.id)!;
    expect(tomb).toMatchObject({ text: "Removed", quote: "", removedAt: expect.any(String) });
    expect(JSON.stringify(tomb)).not.toContain("RDH");
    expect((await factsNow()).some((f) => f.id === target.id)).toBe(false);
    expect(await learnFromSentChat(container, { kind: "screen", id: tomb.from.screenId!, companyId, applicationId, token: "" })).toBe(0);
    expect((await form(`/c/status/${statusToken}/facts/${target.id}`, { action: "change", text: "Back again" })).headers.get("location")).toContain("facts=missing");
    // a forged link writes nothing
    expect((await form("/c/status/not-a-real-token/facts/x", { action: "remove" })).status).toBe(404);
  });

  it("emails a details link only to the address on file, answers the same for an unknown address, and the link fills the form for that job at that company only", async () => {
    const reusePath = `/careers/${slug}/jobs/${otherRoleId}/apply/reuse`;
    const page = await app.request(reusePath);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Use the details you gave Profile Dental before");
    const before = outbox().length;
    const stranger = await form(reusePath, { email: "nobody@example.com" });
    const known = await form(reusePath, { email: "Maria.Reyes@Example.com" });
    expect(stranger.status).toBe(303);
    expect(known.status).toBe(303);
    expect(stranger.headers.get("location")).toBe(known.headers.get("location"));
    await container.drain();
    const sent = outbox().slice(before);
    expect(sent.map((m) => m.to)).toEqual(["maria.reyes@example.com"]);
    const link = sent[0].text.match(/https:\/\/jobs\.example\.test(\/careers\/\S+\/apply\?reuse=\S+)/)![1];
    expect(link.startsWith(`/careers/${slug}/jobs/${otherRoleId}/apply?reuse=`)).toBe(true);
    const token = decodeURIComponent(new URL(link, "https://x.test").searchParams.get("reuse")!);
    const details = await reusedDetailsFor(container, { companyId, roleId: otherRoleId, token });
    expect(details).toMatchObject({ firstName: "Maria", lastName: "Reyes", email: "maria.reyes@example.com", locationText: "Tustin, CA" });
    expect(details!.facts.map((f) => f.text)).toEqual(["I also teach flossing classes at the community center."]);
    // another job, another company, a changed token, an expired one: nothing
    expect(await reusedDetailsFor(container, { companyId, roleId, token })).toBeNull();
    expect(await reusedDetailsFor(container, { companyId: "00000000-0000-0000-0000-000000000000", roleId: otherRoleId, token })).toBeNull();
    expect(await reusedDetailsFor(container, { companyId, roleId: otherRoleId, token: `${token.slice(0, -3)}abc` })).toBeNull();
    expect(await reusedDetailsFor(container, { companyId, roleId: otherRoleId, token: reuseToken(container.env.SESSION_SECRET, { companyId, candidateId, roleId: otherRoleId }, new Date(Date.now() - 4 * 86_400_000), 72) })).toBeNull();
    // the job they already applied for: their own link instead of a form
    const again = outbox().length;
    await form(`/careers/${slug}/jobs/${roleId}/apply/reuse`, { email: "maria.reyes@example.com" });
    await container.drain();
    const already = outbox().slice(again);
    expect(already).toHaveLength(1);
    expect(already[0].text).toContain(`https://jobs.example.test/c/status/${statusToken}`);
    expect(already[0].text).not.toContain("reuse=");
    // a bad address is asked again; an unknown job answers as the form does
    expect((await form(reusePath, { email: "not an address" })).status).toBe(400);
    expect((await app.request(`/careers/${slug}/jobs/00000000-0000-0000-0000-000000000000/apply/reuse`)).status).toBe(404);
  });

  it("offers the company's other open roles from the record, and emails the link to the address on file only, never to the page", async () => {
    const page = await app.request(`/c/status/${statusToken}/apply-another`);
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain("Apply for another role at Profile Dental");
    // a forwarded status link must not open a form filled with the person's details: no reuse link on the page
    expect(body).not.toContain("reuse=");
    expect(body).toContain(`<form method="post" action="/c/status/${statusToken}/apply-another/${otherRoleId}">`);
    // the request is the same queued job as "Applied here before?", for the address on file (watched on the engine)
    const queued: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
    const enqueue = container.engine.enqueue.bind(container.engine);
    container.engine.enqueue = ((q, job) => {
      queued.push({ kind: job.kind, payload: job.payload });
      return enqueue(q, job);
    }) as typeof container.engine.enqueue;
    try {
      const asked = await form(`/c/status/${statusToken}/apply-another/${otherRoleId}`, {});
      expect(asked.status).toBe(303);
      expect(asked.headers.get("location")).toBe(`/c/status/${statusToken}/apply-another?sent=1`);
      await container.drain();
      expect(queued.filter((j) => j.kind === "candidate.reuse_link").map((j) => j.payload)).toEqual([{ companyId, roleId: otherRoleId, email: "maria.reyes@example.com" }]);
      // a role the record does not offer (one already applied for) queues nothing, and the page answers the same
      queued.length = 0;
      expect((await form(`/c/status/${statusToken}/apply-another/${roleId}`, {})).headers.get("location")).toBe(`/c/status/${statusToken}/apply-another?sent=1`);
      expect(queued.filter((j) => j.kind === "candidate.reuse_link")).toEqual([]);
    } finally {
      container.engine.enqueue = enqueue;
    }
    // every details link for that job went to the address on file (one an hour per person and job)
    const reuseMails = outbox().filter((m) => m.text.includes(`/jobs/${otherRoleId}/apply?reuse=`));
    expect(reuseMails.length).toBeGreaterThanOrEqual(1);
    expect(reuseMails.every((m) => m.to === "maria.reyes@example.com")).toBe(true);
    expect((await app.request(`/c/status/${statusToken}/apply-another?sent=1`)).status).toBe(200);
    expect((await form(`/c/status/${statusToken}/new-link`, {})).status).toBe(200);
    const [fresh] = await container.db.select().from(applications).where(eq(applications.id, applicationId));
    statusToken = fresh.statusToken;
    expect((await app.request("/c/status/not-a-real-token/apply-another")).status).toBe(404);
    expect((await form(`/c/status/not-a-real-token/apply-another/${otherRoleId}`, {})).status).toBe(404);
  });

  it("after a deletion the details are never reused and the record's forms are dead", async () => {
    const token = reuseToken(container.env.SESSION_SECRET, { companyId, candidateId, roleId: otherRoleId }, new Date(), 72);
    expect(await reusedDetailsFor(container, { companyId, roleId: otherRoleId, token })).not.toBeNull();
    await container.db.update(candidates).set({ anonymizedAt: new Date().toISOString() }).where(and(eq(candidates.id, candidateId), eq(candidates.companyId, companyId)));
    expect(await reusedDetailsFor(container, { companyId, roleId: otherRoleId, token })).toBeNull();
    expect((await form(`/c/status/${statusToken}/facts/anything`, { action: "remove" })).status).toBe(410);
    expect((await app.request(`/c/status/${statusToken}/apply-another`)).status).toBe(410);
    const before = outbox().length;
    await form(`/careers/${slug}/jobs/${otherRoleId}/apply/reuse`, { email: "maria.reyes@example.com" });
    await container.drain();
    expect(outbox().length).toBe(before);
  });
});
